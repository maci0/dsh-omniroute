/**
 * The real-composition entry test: the plugin is mounted into a real Cordis
 * `Context` beside the real HTTP carrier
 * (`@deepseek-ai/dsh-host-webserver`) on an OS-assigned port, and the routes
 * are driven over real HTTP rather than through a captured handler object.
 * Only OmniRoute itself is stubbed — that is the expensive, nondeterministic
 * boundary — so routing, JSON encoding, credential resolution, the settings
 * write, and teardown run against the shipping implementation.
 *
 * The spec owns its port: the carrier is mounted on port 0 and disposed in the
 * test body, so nothing is left listening and no fixed port can collide with a
 * concurrently running spec.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as OmniRoute from '../src/index.ts'

/** One HTTP GET against the composition's carrier. */
async function get(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url)
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

/** The catalog one composition serves. */
const CATALOG = {
  models: [
    { provider: 'glm', model: 'glm-5.3', name: 'GLM 5.3', fullModel: 'glm/glm-5.3', available: true, supportsVision: false },
  ],
}

test('the plugin mounts, answers over real HTTP, and withdraws its routes on dispose', async () => {
  const ctx = new Context()
  const carrier = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const calls: string[] = []
  const writes: { ns: string; patch: object }[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('http://127.0.0.1')) return original(input as string, init)
    calls.push(url)
    return Promise.resolve(new Response(JSON.stringify(CATALOG), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof globalThis.fetch
  try {
    const server = ctx.get('webServer') as unknown as { port: number }
    assert.ok(server.port > 0, 'the carrier listens on an OS-assigned port')
    ctx.provide('credentials', { resolve: async () => ({ value: 'sk-test' }) })
    ctx.provide('settings', { update: async (ns: string, patch: object) => { writes.push({ ns, patch }) } })

    const plugin = await ctx.plugin(OmniRoute as unknown as Parameters<typeof ctx.plugin>[0], {
      baseURL: 'http://192.168.0.100:20128/v1',
      cacheSeconds: 0,
    })
    const origin = `http://127.0.0.1:${String(server.port)}`
    const reply = await get(`${origin}${OmniRoute.ROUTE_MODELS}?sync=1`)
    assert.equal(reply.status, 200)
    assert.deepEqual((reply.body as { counts: unknown }).counts, { total: 1, available: 1, shown: 1 })
    assert.deepEqual(calls, ['http://192.168.0.100:20128/api/models'])
    assert.deepEqual(writes, [
      { ns: 'llm-pi-ai', patch: { providers: { omniroute: { models: [{ id: 'glm/glm-5.3', name: 'GLM 5.3' }] } } } },
    ])

    // HMR safety: the registrations are `ctx.effect`s, so unloading the fiber
    // removes every route from the real carrier.
    await plugin.dispose()
    assert.equal((await get(`${origin}${OmniRoute.ROUTE_MODELS}`)).status, 404)
  } finally {
    globalThis.fetch = original
    await carrier.dispose()
  }
})

test('the exported Config carries every default and rejects a row outside its bounds', () => {
  // The Loader validates a bundle row against this schema, so the defaults and
  // the bounds are the configuration contract, not a comment about one.
  const parsed = OmniRoute.Config({}) as unknown as Record<string, { get(): unknown }>
  assert.deepEqual(
    Object.fromEntries(Object.keys(parsed).map(key => [key, parsed[key]?.get()])),
    {
      baseURL: OmniRoute.DEFAULT_BASE_URL,
      apiKeyEnv: OmniRoute.DEFAULT_API_KEY_ENV,
      timeoutMs: OmniRoute.DEFAULT_TIMEOUT_MS,
      cacheSeconds: OmniRoute.DEFAULT_CACHE_SECONDS,
      syncNamespace: OmniRoute.DEFAULT_SYNC_NAMESPACE,
      syncProvider: OmniRoute.DEFAULT_SYNC_PROVIDER,
    },
  )
  // The plain schema the route reads through agrees with the loader-facing one.
  assert.deepEqual({ ...OmniRoute.resolveRow({}) }, {
    baseURL: OmniRoute.DEFAULT_BASE_URL,
    apiKeyEnv: OmniRoute.DEFAULT_API_KEY_ENV,
    timeoutMs: OmniRoute.DEFAULT_TIMEOUT_MS,
    cacheSeconds: OmniRoute.DEFAULT_CACHE_SECONDS,
    syncNamespace: OmniRoute.DEFAULT_SYNC_NAMESPACE,
    syncProvider: OmniRoute.DEFAULT_SYNC_PROVIDER,
  })
  assert.throws(() => OmniRoute.Config({ cacheSeconds: -1 }), /cacheSeconds/)
  assert.throws(() => OmniRoute.Config({ timeoutMs: 0 }), /timeoutMs/)
})
