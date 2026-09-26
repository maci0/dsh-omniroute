/**
 * Settings contract: the loader-facing schema, the plain row resolver, and the
 * promise that an edit from the Plugins card reaches the next request.
 *
 * @module dsh-omniroute/tests/settings
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as OmniRoute from '../src/index.ts'
import { mount, request } from './harness.ts'
import { ROUTE_MODELS } from '../src/index.ts'

/** One live reference, exactly the `.get()` seam the loader supplies. */
function ref<T>(read: () => T): { get(): T } {
  return { get: read }
}

/** A catalog payload the transport stub answers with. */
function catalog(): unknown {
  return { data: [{ id: 'model-a', name: 'Model A', available: true, provider: 'acme' }] }
}

/** Replace global fetch for one case; returns the URLs it saw and a restore. */
function stubFetch(payload: unknown, seen: string[]): () => void {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string | URL) => {
    seen.push(String(url))
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    })
  }) as typeof globalThis.fetch
  return () => { globalThis.fetch = original }
}

const SERVICES = { credentials: { resolve: async () => ({ value: 'omniroute-key' }) } }

test('every field is volatile, and the plain resolver agrees with the schema', () => {
  const parsed = OmniRoute.Config({}) as unknown as Record<string, { get(): unknown }>
  for (const key of ['baseURL', 'apiKeyEnv', 'timeoutMs', 'cacheSeconds', 'syncNamespace', 'syncProvider'] as const) {
    assert.equal(typeof parsed[key]?.get, 'function', `${key} must be volatile`)
    assert.deepEqual(parsed[key]?.get(), OmniRoute.resolveRow({})[key], `${key} default must match the resolver`)
  }
})

test('resolveRow reads references, so a caller can pass a live row', () => {
  const state = { cacheSeconds: 10, baseURL: 'http://localhost:20128' }
  const row = {
    baseURL: ref(() => state.baseURL),
    apiKeyEnv: ref(() => 'OMNIROUTE_API_KEY'),
    timeoutMs: ref(() => 5000),
    cacheSeconds: ref(() => state.cacheSeconds),
    syncNamespace: ref(() => 'llm-pi-ai'),
    syncProvider: ref(() => 'omniroute'),
  }
  assert.equal(OmniRoute.resolveRow(row).cacheSeconds, 10)
  state.cacheSeconds = 0
  assert.equal(OmniRoute.resolveRow(row).cacheSeconds, 0)
})

test('a live cache window edit takes effect on the next request', async () => {
  const state = { cacheSeconds: 3600 }
  const routes = mount(SERVICES, {
    baseURL: ref(() => 'http://localhost:20128'),
    apiKeyEnv: ref(() => 'OMNIROUTE_API_KEY'),
    timeoutMs: ref(() => 10_000),
    cacheSeconds: ref(() => state.cacheSeconds),
    syncNamespace: ref(() => 'llm-pi-ai'),
    syncProvider: ref(() => 'omniroute'),
  })
  const seen: string[] = []
  const restore = stubFetch(catalog(), seen)
  try {
    const route = routes.get(ROUTE_MODELS)
    assert.ok(route)
    const first = await request(route, ROUTE_MODELS)
    assert.equal(first.status, 200)
    assert.equal(seen.length, 1)

    // The hour-long window is still open: the second read is served from cache.
    await request(route, ROUTE_MODELS)
    assert.equal(seen.length, 1)

    // A save moves the reference in place and the loader emits this event.
    state.cacheSeconds = 0
    routes.emitVolatile()

    await request(route, ROUTE_MODELS)
    assert.equal(seen.length, 2, 'the edit must drop the served reading')
  } finally {
    restore()
  }
})

test('a live origin edit is used by the next request', async () => {
  const state = { baseURL: 'http://localhost:20128' }
  const routes = mount(SERVICES, {
    baseURL: ref(() => state.baseURL),
    apiKeyEnv: ref(() => 'OMNIROUTE_API_KEY'),
    timeoutMs: ref(() => 10_000),
    cacheSeconds: ref(() => 0),
    syncNamespace: ref(() => 'llm-pi-ai'),
    syncProvider: ref(() => 'omniroute'),
  })
  const seen: string[] = []
  const restore = stubFetch(catalog(), seen)
  try {
    const route = routes.get(ROUTE_MODELS)
    assert.ok(route)
    await request(route, ROUTE_MODELS)
    assert.match(seen[0] ?? '', /localhost:20128/u)

    state.baseURL = 'http://127.0.0.1:20129/v1'
    routes.emitVolatile()
    await request(route, ROUTE_MODELS)
    assert.match(seen[1] ?? '', /127\.0\.0\.1:20129/u)
  } finally {
    restore()
  }
})

test('a row outside the schema bounds still fails at the boundary', () => {
  assert.throws(() => OmniRoute.Config({ timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => OmniRoute.resolveRow({ cacheSeconds: -1 }), /cacheSeconds/)
})
