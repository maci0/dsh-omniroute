/**
 * Deterministic work counters for the webserver route path.
 *
 * Wall clock is not asserted: it moves with turbo, neighbours, and the
 * container's CPU quota. These cases count work instead — provider requests
 * and per-request parsing — which is what the route path is allowed to spend:
 *
 * - a cold `/omniroute/quota` read asks `/api/providers` once, not once for the
 *   route's own connection list and again inside the quota read;
 * - reading the model catalog does not look a query parameter up once per
 *   model;
 * - serving a request does not build a full `URL`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROUTE_MODELS, ROUTE_QUOTA } from '../src/index.ts'
import type { WebRouteLike } from '../src/host.ts'
import { mount, request, routeOf, stubFetch, type Services } from './harness.ts'

/** One model entry as OmniRoute's `/api/models` lists it. */
function modelAt(index: number): Record<string, unknown> {
  const provider = index % 2 === 0 ? 'glm' : 'cc'
  return {
    provider,
    model: `model-${String(index)}`,
    name: `Model Number ${String(index)}`,
    alias: `alias-${String(index)}`,
    fullModel: `${provider}/model-${String(index)}`,
    available: index % 3 !== 0,
    supportsVision: false,
  }
}

/** One connection as `/api/providers` lists it. */
function connectionAt(index: number): Record<string, unknown> {
  return { id: `conn-${String(index)}`, provider: 'glm', isActive: true, quotaVisible: true }
}

/** The services every case mounts. */
const KEYED: Services = { credentials: { resolve: async () => ({ value: 'sk-perf' }) } }

/** The stub fetch, and the URLs it answered in call order. */
interface Stub {
  /** Request URLs, in call order. */
  readonly calls: string[]
  /** Put the real fetch back. */
  restore(): void
}

/**
 * Mount the plugin over the shared fake context with a stubbed fetch. A usage
 * path the stub does not know answers 404, which the quota read drops; these
 * cases count requests, not windows.
 * @param models - catalog `/api/models` answers with.
 * @param connections - connections `/api/providers` answers with.
 * @param cacheSeconds - reading cache lifetime for this mount.
 * @returns its routes by path and the stub.
 */
function mountWith(models: readonly Record<string, unknown>[], connections: readonly Record<string, unknown>[], cacheSeconds: number): { routes: Map<string, WebRouteLike>; stub: Stub } {
  const routes = mount(KEYED, { baseURL: 'http://127.0.0.1:20128', cacheSeconds })
  const stub = stubFetch({ '/api/models': { models }, '/api/providers': { connections } })
  return { routes, stub }
}

/** Count `URLSearchParams.prototype.get` calls while a case runs. */
function countParamLookups(): { count: () => number; restore: () => void } {
  const native = URLSearchParams.prototype.get
  let calls = 0
  URLSearchParams.prototype.get = function (this: URLSearchParams, name: string): string | null {
    calls += 1
    return native.call(this, name)
  }
  return { count: () => calls, restore: () => { URLSearchParams.prototype.get = native } }
}

/** Count full-`URL` constructions while a case runs. */
function countUrlConstructions(): { count: () => number; restore: () => void } {
  const native = globalThis.URL
  let built = 0
  globalThis.URL = class extends native {
    constructor(url: string | URL, base?: string | URL) {
      super(url, base)
      built += 1
    }
  } as unknown as typeof URL
  return { count: () => built, restore: () => { globalThis.URL = native } }
}

test('a cold quota read asks /api/providers once per request, not twice', async () => {
  const connections = Array.from({ length: 24 }, (_, index) => connectionAt(index))
  const { routes, stub } = mountWith([], connections, 0)
  try {
    const requests = 3
    for (let index = 0; index < requests; index += 1) await request(routeOf(routes, ROUTE_QUOTA), ROUTE_QUOTA)
    const providers = stub.calls.filter(call => call.endsWith('/api/providers')).length
    const usage = stub.calls.filter(call => call.includes('/api/usage/')).length
    assert.equal(providers, requests, 'the connection list is read once per request')
    assert.equal(usage, requests * connections.length, 'every visible connection is asked once')
  } finally {
    stub.restore()
  }
})

/** Query lookups one unfiltered catalog read costs, averaged over 200 reads. */
async function lookupsPerRequest(models: number): Promise<number> {
  const { routes, stub } = mountWith(Array.from({ length: models }, (_, index) => modelAt(index)), [], 60)
  try {
    const route = routeOf(routes, ROUTE_MODELS)
    await request(route, ROUTE_MODELS)
    const lookups = countParamLookups()
    try {
      const requests = 200
      for (let index = 0; index < requests; index += 1) await request(route, ROUTE_MODELS)
      return lookups.count() / requests
    } finally {
      lookups.restore()
    }
  } finally {
    stub.restore()
  }
}

test('reading the catalog does not look a query parameter up once per model', async () => {
  const small = await lookupsPerRequest(4)
  const large = await lookupsPerRequest(400)
  assert.equal(large, small, 'query lookups must not scale with the catalog size')
  assert.ok(large <= 5, `one catalog read cost ${String(large)} query lookups`)
})

test('serving a catalog read builds no URL, and still reads an encoded query', async () => {
  const models = Array.from({ length: 40 }, (_, index) => modelAt(index))
  const { routes, stub } = mountWith(models, [], 60)
  try {
    const route = routeOf(routes, ROUTE_MODELS)
    await request(route, ROUTE_MODELS)
    const urls = countUrlConstructions()
    try {
      const requests = 200
      for (let index = 0; index < requests; index += 1) await request(route, ROUTE_MODELS)
      assert.ok(urls.count() <= 2, `${String(requests)} catalog reads built ${String(urls.count())} URLs`)
    } finally {
      urls.restore()
    }

    // The query is still read the way `URLSearchParams` reads it, encoding
    // included: `Model Number 3` matches one name and every `Model Number 3x`.
    const encoded = await request(route, `${ROUTE_MODELS}?q=Model%20Number%203`)
    const expected = models.filter(model => String(model['name']).toLowerCase().includes('model number 3')).length
    assert.equal((encoded.body as { counts: { shown: number } }).counts.shown, expected)
  } finally {
    stub.restore()
  }
})
