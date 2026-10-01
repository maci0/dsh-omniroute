/**
 * Host half: the three routes, driven through the same public `apply` a
 * composition calls. The fake context carries the injected services plus only
 * the optional ones a case mounts, so these cases fail if the plugin starts
 * needing a service it does not inject.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROUTE_CONNECTIONS, ROUTE_MODELS, ROUTE_QUOTA } from '../src/index.ts'
import type { WebRouteLike } from '../src/host.ts'
import { mount, request, stubFetch, type Services } from './harness.ts'

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

test('a quota reply never lists a connection its windows were not read for', async () => {
  const routes = mount(KEYED, { cacheSeconds: 600 })
  const stub = stubFetch({
    '/api/providers': {
      connections: [{ id: 'x', provider: 'deepseek', name: 'main', isActive: true, quotaVisible: true }],
    },
    '/api/usage/x': { plan: 'DeepSeek', quotas: { credits_usd: { used: 1, remaining: 90 } } },
    '/api/usage/y': { plan: 'GLM', quotas: { weekly: { used: 2, remaining: 8 } } },
  })
  try {
    const first = await request(routes.get(ROUTE_QUOTA) as WebRouteLike, ROUTE_QUOTA)
    assert.deepEqual((first.body as { windows: { connection: string }[] }).windows.map(w => w.connection), ['x'])

    // A connection is added upstream and the listing route refreshes alone.
    stub.bodies['/api/providers'] = {
      connections: [
        { id: 'x', provider: 'deepseek', name: 'main', isActive: true, quotaVisible: true },
        { id: 'y', provider: 'glm', name: 'new', isActive: true, quotaVisible: true },
      ],
    }
    await request(routes.get(ROUTE_CONNECTIONS) as WebRouteLike, `${ROUTE_CONNECTIONS}?refresh=1`)

    const next = await request(routes.get(ROUTE_QUOTA) as WebRouteLike, ROUTE_QUOTA)
    const body = next.body as { connections: { id: string }[]; windows: { connection: string }[] }
    assert.deepEqual(body.connections.map(c => c.id), ['x', 'y'])
    assert.deepEqual(body.windows.map(w => w.connection), ['x', 'y'],
      'windows belong to the connections listed beside them')
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

test('a non-JSON router body is reported without quoting it back', async () => {
  const routes = mount(KEYED, { cacheSeconds: 0 })
  const original = globalThis.fetch
  // A router that answers 200 with something other than JSON (a login page,
  // a proxy error) makes `response.json()` fail with a syntax error whose
  // message quotes the first bytes of that body.
  globalThis.fetch = (() => Promise.resolve(new Response('UPSTREAM-SECRET-value', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))) as unknown as typeof fetch
  try {
    const reply = await request(routes.get(ROUTE_MODELS) as WebRouteLike, ROUTE_MODELS)
    assert.equal(reply.status, 502)
    const message = String((reply.body as { message: string }).message)
    assert.doesNotMatch(message, /UPSTREAM-SECRET/, 'the refusal must not quote the router body')
    assert.match(message, /non-JSON/)
  } finally {
    globalThis.fetch = original
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

test('a failure outside this plugin is answered without its raw text', async () => {
  // A credential store or settings service may phrase a failure with host
  // paths or internals; the browser gets this plugin's own sentence.
  const locked = mount({ credentials: { resolve: async () => { throw new Error('keyring /home/u/.vault locked') } } })
  const stub = stubFetch({ '/api/models': CATALOG })
  try {
    const reply = await request(locked.get(ROUTE_MODELS) as WebRouteLike, ROUTE_MODELS)
    assert.equal(reply.status, 502)
    assert.doesNotMatch(String((reply.body as { message: string }).message), /keyring|vault/)

    const refused = mount({
      ...KEYED,
      settings: { update: async () => { throw new Error('No configurable plugin entry at /srv/profile/cordis.yml:12') } },
    }, { cacheSeconds: 0, syncNamespace: 'llm-elsewhere' })
    const sync = await request(refused.get(ROUTE_MODELS) as WebRouteLike, `${ROUTE_MODELS}?sync=1`)
    assert.equal(sync.status, 502)
    const message = String((sync.body as { message: string }).message)
    assert.doesNotMatch(message, /cordis\.yml/)
    assert.match(message, /llm-elsewhere/)
  } finally {
    stub.restore()
  }
})

test('a router that does not answer in time is reported as that', async () => {
  const routes = mount(KEYED, { cacheSeconds: 0, timeoutMs: 20 })
  const original = globalThis.fetch
  // `AbortSignal.timeout` does not hold the event loop open, and the stubbed
  // fetch never settles, so on Node 22 the runner saw an empty loop and
  // cancelled the test before the deadline fired. A server keeps the loop
  // alive in production; this interval stands in for it.
  const keepAlive = setInterval(() => {}, 1_000)
  globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason) })
  })) as unknown as typeof fetch
  try {
    const reply = await request(routes.get(ROUTE_MODELS) as WebRouteLike, ROUTE_MODELS)
    assert.equal(reply.status, 502)
    assert.match(String((reply.body as { message: string }).message), /did not answer \/api\/models within 20ms/)
  } finally {
    clearInterval(keepAlive)
    globalThis.fetch = original
  }
})

test('a cached reading reports when OmniRoute was asked, not when it was served', async () => {
  const routes = mount(KEYED, { cacheSeconds: 60 })
  const stub = stubFetch({ '/api/models': CATALOG, '/api/providers': { connections: [] } })
  try {
    for (const path of [ROUTE_MODELS, ROUTE_CONNECTIONS, ROUTE_QUOTA]) {
      const first = await request(routes.get(path) as WebRouteLike, path)
      await new Promise((resolve) => { setTimeout(resolve, 5) })
      const cached = await request(routes.get(path) as WebRouteLike, path)
      assert.equal((cached.body as { fetchedAt: number }).fetchedAt, (first.body as { fetchedAt: number }).fetchedAt, path)
    }
    assert.equal(stub.calls.length, 2, 'one catalog read and one shared connection read')
  } finally {
    stub.restore()
  }
})
