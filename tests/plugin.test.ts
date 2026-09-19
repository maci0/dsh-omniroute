/**
 * Host half: the three routes, driven through the same public `apply` a
 * composition calls. The fake context carries only the services this plugin
 * reads structurally, so these cases fail if the plugin starts needing a
 * service a bare composition does not mount.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, ROUTE_CONNECTIONS, ROUTE_MODELS, ROUTE_QUOTA } from '../src/index.ts'
import type { Disposable, HostContext, WebRouteLike } from '../src/host.ts'

/** One captured response. */
interface Captured {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** Services a case may mount; absent keys read as "not mounted". */
interface Services {
  settings?: { update(ns: string, patch: object): Promise<void> }
  credentials?: { resolve(ref: string): Promise<{ value: string } | undefined> }
  connection?: { requestRejection(request: { headers: object | undefined }): 401 | 403 | undefined }
}

/** Mount the plugin over a fake context and return its routes by path. */
function mount(services: Services, config?: Record<string, unknown>): Map<string, WebRouteLike> {
  const routes = new Map<string, WebRouteLike>()
  const ctx = {
    effect: (callback: () => Disposable | void): void => { callback() },
    get: (name: string): unknown => (services as Record<string, unknown>)[name],
    logger: { warn: (): void => {}, error: (): void => {} },
    webServer: {
      register: (route: WebRouteLike): Disposable => {
        routes.set(route.path, route)
        return () => {}
      },
    },
  } as unknown as HostContext
  apply(ctx, config ?? {})
  assert.deepEqual([...routes.keys()].sort(), [ROUTE_CONNECTIONS, ROUTE_MODELS, ROUTE_QUOTA].sort())
  return routes
}

/** Run one request through a route. */
async function request(route: WebRouteLike, url: string, method = 'GET', headers: object = {}): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: undefined }
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string): void { captured.headers[name] = value },
    end(body?: string): void {
      captured.status = res.statusCode
      captured.body = body === undefined ? undefined : JSON.parse(body)
    },
  }
  await route.handler({ method, url, headers }, res)
  return captured
}

/** One stubbed answer per pathname; a path this map lacks answers 404. */
function stubFetch(bodies: Record<string, unknown>, calls: string[] = []): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL) => {
    const target = String(url)
    calls.push(target)
    const body = bodies[new URL(target).pathname]
    return Promise.resolve({
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      json: () => Promise.resolve(body ?? {}),
    })
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** The catalog one case serves, shaped like the real `/api/models` body. */
const CATALOG = {
  models: [
    { provider: 'glm', model: 'glm-5.3', name: 'GLM 5.3', fullModel: 'glm/glm-5.3', available: true, supportsVision: true },
    { provider: 'cc', model: 'claude-opus-5', name: 'Claude Opus 5', fullModel: 'cc/claude-opus-5', available: false, supportsVision: true },
  ],
}

/** The services every catalog case needs. */
const KEYED: Services = { credentials: { resolve: async () => ({ value: 'sk-test' }) } }

test('the model route serves the live catalog and narrows it by query', async () => {
  const routes = mount(KEYED, { baseURL: 'http://192.168.0.100:20128/v1', cacheSeconds: 0 })
  const stub = stubFetch({ '/api/models': CATALOG })
  try {
    const all = await request(routes.get(ROUTE_MODELS) as WebRouteLike, ROUTE_MODELS)
    assert.equal(all.status, 200)
    assert.deepEqual(stub.calls, ['http://192.168.0.100:20128/api/models'])
    assert.deepEqual((all.body as { counts: unknown }).counts, { total: 2, available: 1, shown: 2 })

    const served = await request(routes.get(ROUTE_MODELS) as WebRouteLike, `${ROUTE_MODELS}?available=1&q=glm`)
    assert.deepEqual((served.body as { models: unknown[] }).models, [
      {
        id: 'glm/glm-5.3',
        provider: 'glm',
        name: 'GLM 5.3',
        available: true,
        vision: true,
      },
    ])

    const byProvider = await request(routes.get(ROUTE_MODELS) as WebRouteLike, `${ROUTE_MODELS}?provider=cc&available=1`)
    assert.equal((byProvider.body as { models: unknown[] }).models.length, 0)
  } finally {
    stub.restore()
  }
})

test('sync writes the available models into the configured provider route', async () => {
  const writes: { ns: string; patch: object }[] = []
  const routes = mount({ ...KEYED, settings: { update: async (ns, patch) => { writes.push({ ns, patch }) } } }, {
    cacheSeconds: 0,
    syncNamespace: 'llm-pi-ai',
    syncProvider: 'omniroute',
  })
  const stub = stubFetch({ '/api/models': CATALOG })
  try {
    const reply = await request(routes.get(ROUTE_MODELS) as WebRouteLike, `${ROUTE_MODELS}?sync=1`)
    assert.deepEqual((reply.body as { synced: unknown }).synced, {
      namespace: 'llm-pi-ai',
      path: 'providers.omniroute.models',
      count: 1,
    })
    assert.deepEqual(writes, [
      { ns: 'llm-pi-ai', patch: { providers: { omniroute: { models: [{ id: 'glm/glm-5.3', name: 'GLM 5.3' }] } } } },
    ])
  } finally {
    stub.restore()
  }
})

test('a sync without a settings service is reported, not thrown away', async () => {
  const routes = mount(KEYED, { cacheSeconds: 0 })
  const stub = stubFetch({ '/api/models': CATALOG })
  try {
    const reply = await request(routes.get(ROUTE_MODELS) as WebRouteLike, `${ROUTE_MODELS}?sync=1`)
    assert.equal(reply.status, 502)
    assert.match(String((reply.body as { message: string }).message), /settings service is not mounted/)
  } finally {
    stub.restore()
  }
})

test('the quota route serves every window and the reached limits', async () => {
  const routes = mount(KEYED, { cacheSeconds: 0 })
  const stub = stubFetch({
    '/api/providers': {
      connections: [{ id: 'acbe', provider: 'deepseek', name: 'main', isActive: true, quotaVisible: true }],
    },
    '/api/usage/acbe': {
      plan: 'DeepSeek',
      quotas: { credits_usd: { used: 0, total: 0, remaining: 91.43, unlimited: true, currency: 'USD', resetAt: null } },
      limitReached: true,
    },
  })
  try {
    const reply = await request(routes.get(ROUTE_QUOTA) as WebRouteLike, ROUTE_QUOTA)
    assert.equal(reply.status, 200)
    assert.equal((reply.body as { windows: unknown[] }).windows.length, 1)
    assert.deepEqual((reply.body as { limitReached: unknown }).limitReached, ['DeepSeek'])
  } finally {
    stub.restore()
  }
})

test('a reading is cached, and refresh=1 asks again', async () => {
  const routes = mount(KEYED, { cacheSeconds: 60 })
  const stub = stubFetch({ '/api/providers': { connections: [] } })
  try {
    await request(routes.get(ROUTE_CONNECTIONS) as WebRouteLike, ROUTE_CONNECTIONS)
    await request(routes.get(ROUTE_CONNECTIONS) as WebRouteLike, ROUTE_CONNECTIONS)
    assert.equal(stub.calls.length, 1)
    await request(routes.get(ROUTE_CONNECTIONS) as WebRouteLike, `${ROUTE_CONNECTIONS}?refresh=1`)
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
  }
})

test('no credential is an error that names the reference and asks nobody', async () => {
  const routes = mount({ credentials: { resolve: async () => undefined } }, { apiKeyEnv: 'MISSING_KEY' })
  const stub = stubFetch({})
  try {
    const reply = await request(routes.get(ROUTE_MODELS) as WebRouteLike, ROUTE_MODELS)
    assert.equal(reply.status, 502)
    assert.match(String((reply.body as { message: string }).message), /MISSING_KEY/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('the trust fence, the method, and a failed read are all answered in JSON', async () => {
  const routes = mount({
    ...KEYED,
    connection: { requestRejection: () => 401 as const },
  })
  const fenced = await request(routes.get(ROUTE_MODELS) as WebRouteLike, ROUTE_MODELS)
  assert.equal(fenced.status, 401)
  assert.equal(fenced.body, undefined)

  const open = mount(KEYED)
  const wrongMethod = await request(open.get(ROUTE_MODELS) as WebRouteLike, ROUTE_MODELS, 'POST')
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers['allow'], 'GET')

  const stub = stubFetch({})
  try {
    const refused = await request(open.get(ROUTE_MODELS) as WebRouteLike, ROUTE_MODELS)
    assert.equal(refused.status, 502)
    assert.match(String((refused.body as { message: string }).message), /HTTP 404/)
  } finally {
    stub.restore()
  }
})
