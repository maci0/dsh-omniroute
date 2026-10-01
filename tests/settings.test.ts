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
  return { models: [{ id: 'model-a', name: 'Model A', available: true, provider: 'acme' }] }
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

test('a settings write during credential lookup cannot mix origins, keys or cached readings', async () => {
  const state = { baseURL: 'http://old.example:20128', apiKeyEnv: 'OLD_KEY' }
  let release: ((key: { value: string }) => void) | undefined
  const refs: string[] = []
  const routes = mount({ credentials: { resolve: async (ref) => {
    refs.push(ref)
    if (ref === 'OLD_KEY') return new Promise((resolve) => { release = resolve })
    return { value: 'new-key' }
  } } }, {
    baseURL: ref(() => state.baseURL), apiKeyEnv: ref(() => state.apiKeyEnv),
    cacheSeconds: ref(() => 3600), timeoutMs: ref(() => 10_000),
    syncNamespace: ref(() => 'llm-pi-ai'), syncProvider: ref(() => 'omniroute'),
  })
  const seen: { url: string; key: string | null }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url, init) => {
    seen.push({ url: String(url), key: new Headers(init?.headers).get('authorization') })
    return Response.json({ models: [{ id: String(url), available: true }] })
  }) as typeof fetch
  try {
    const route = routes.get(ROUTE_MODELS)
    assert.ok(route)
    const older = request(route, ROUTE_MODELS)
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(release)
    state.baseURL = 'http://new.example:20129'
    state.apiKeyEnv = 'NEW_KEY'
    routes.emitVolatile()
    const fresh = await request(route, ROUTE_MODELS)
    release({ value: 'old-key' })
    const old = await older
    assert.equal(old.status, 200)
    assert.deepEqual(seen, [
      { url: 'http://new.example:20129/api/models', key: 'Bearer new-key' },
      { url: 'http://old.example:20128/api/models', key: 'Bearer old-key' },
    ])
    assert.deepEqual(old.body && (old.body as { origin: string }).origin, 'http://old.example:20128')
    assert.deepEqual((await request(route, ROUTE_MODELS)).body, fresh.body)
    assert.equal(seen.length, 2, 'the fresh reading remains cached')
    assert.deepEqual(refs, ['OLD_KEY', 'NEW_KEY'])
  } finally {
    release?.({ value: 'old-key' })
    globalThis.fetch = original
  }
})

test('a read in flight during a settings write must not re-fill the cache', async () => {
  const state = { baseURL: 'http://localhost:20128' }
  const routes = mount(SERVICES, {
    baseURL: ref(() => state.baseURL),
    apiKeyEnv: ref(() => 'OMNIROUTE_API_KEY'),
    timeoutMs: ref(() => 10_000),
    cacheSeconds: ref(() => 3600),
    syncNamespace: ref(() => 'llm-pi-ai'),
    syncProvider: ref(() => 'omniroute'),
  })
  const seen: string[] = []
  const original = globalThis.fetch
  let release: (() => void) | undefined
  let held = false
  globalThis.fetch = ((url: string | URL) => {
    seen.push(String(url))
    const answer = () => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(catalog()),
      text: () => Promise.resolve(JSON.stringify(catalog())),
    } as Response)
    // The first read answers only once the case releases it, so a settings
    // write lands while that read is still in flight.
    if (!held) {
      held = true
      return new Promise<Response>((resolve) => { release = () => { void answer().then(resolve) } })
    }
    return answer()
  }) as typeof globalThis.fetch
  try {
    const route = routes.get(ROUTE_MODELS)
    assert.ok(route)
    const first = request(route, ROUTE_MODELS)
    await new Promise((resolve) => { setImmediate(resolve) })
    assert.equal(seen.length, 1, 'the first read is in flight')

    state.baseURL = 'http://127.0.0.1:20129/v1'
    routes.emitVolatile()
    release?.()
    assert.equal((await first).status, 200)

    await request(route, ROUTE_MODELS)
    assert.match(seen[1] ?? '', /127\.0\.0\.1:20129/u, 'the edit must reach the next poll, not be re-filled by the read that raced it')
  } finally {
    globalThis.fetch = original
  }
})

test('a poll that starts after a settings write does not inherit an older read', async () => {
  const state = { baseURL: 'http://a.example:20128' }
  const routes = mount(SERVICES, {
    baseURL: ref(() => state.baseURL),
    apiKeyEnv: ref(() => 'OMNIROUTE_API_KEY'),
    timeoutMs: ref(() => 10_000),
    cacheSeconds: ref(() => 3600),
    syncNamespace: ref(() => 'llm-pi-ai'),
    syncProvider: ref(() => 'omniroute'),
  })
  const seen: string[] = []
  const original = globalThis.fetch
  let release: (() => void) | undefined
  let held = false
  globalThis.fetch = ((url: string | URL) => {
    seen.push(String(url))
    const answer = () => Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(catalog()),
      text: () => Promise.resolve(JSON.stringify(catalog())),
    } as Response)
    // The first read hangs until released, so a settings write and a fresh poll
    // both land while it is still in flight.
    if (!held) {
      held = true
      return new Promise<Response>((resolve) => { release = () => { void answer().then(resolve) } })
    }
    return answer()
  }) as typeof globalThis.fetch
  try {
    const route = routes.get(ROUTE_MODELS)
    assert.ok(route)
    const first = request(route, ROUTE_MODELS)
    await new Promise((resolve) => { setImmediate(resolve) })
    assert.equal(seen.length, 1, 'the first read is in flight')

    state.baseURL = 'http://b.example:20129'
    routes.emitVolatile()

    // This poll starts after the write, so it must ask the new origin rather
    // than wait on the read the old row started. It is raced against a few
    // turns so the pre-fix deadlock reports instead of hanging the suite.
    const second = request(route, ROUTE_MODELS)
    const settled = await Promise.race([
      second.then(reply => reply.body as { origin: string }),
      new Promise<undefined>((resolve) => {
        setImmediate(() => { setImmediate(() => { setImmediate(() => { resolve(undefined) }) }) })
      }),
    ])
    assert.equal(settled?.origin, 'http://b.example:20129', 'a post-write poll starts its own read')
    assert.match(seen[1] ?? '', /b\.example:20129/u)

    release?.()
    assert.equal((await first).status, 200)
    assert.equal((await second).status, 200)
  } finally {
    globalThis.fetch = original
  }
})

test('the read a settings write orphans must not evict the read that replaced it', async () => {
  const state = { baseURL: 'http://a.example:20128' }
  const routes = mount(SERVICES, {
    baseURL: ref(() => state.baseURL),
    apiKeyEnv: ref(() => 'OMNIROUTE_API_KEY'),
    timeoutMs: ref(() => 10_000),
    cacheSeconds: ref(() => 3600),
    syncNamespace: ref(() => 'llm-pi-ai'),
    syncProvider: ref(() => 'omniroute'),
  })
  const seen: string[] = []
  const original = globalThis.fetch
  // Every answer waits for its own release, so two reads can be in flight at
  // once and a third poll has something to coalesce onto.
  const held: (() => void)[] = []
  globalThis.fetch = ((url: string | URL) => {
    seen.push(String(url))
    return new Promise<Response>((resolve) => {
      held.push(() => {
        resolve(new Response(JSON.stringify(catalog()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
      })
    })
  }) as typeof globalThis.fetch
  try {
    const route = routes.get(ROUTE_MODELS)
    assert.ok(route)
    const first = request(route, ROUTE_MODELS)
    await new Promise((resolve) => { setImmediate(resolve) })
    assert.equal(seen.length, 1, 'the first read is in flight')

    state.baseURL = 'http://b.example:20129'
    routes.emitVolatile()

    // A poll that starts after the write is not handed the orphaned read, so it
    // starts its own.
    const second = request(route, ROUTE_MODELS)
    await new Promise((resolve) => { setImmediate(resolve) })
    assert.equal(seen.length, 2, 'the post-write poll started its own read')

    // The orphaned read settles now. Its cleanup must only retract its own
    // entry: deleting whatever the map holds evicts the live read, and the next
    // poll then asks upstream a third time for the same reading.
    held[0]?.()
    await new Promise((resolve) => { setImmediate(resolve) })

    const third = request(route, ROUTE_MODELS)
    await new Promise((resolve) => { setImmediate(resolve) })
    assert.equal(seen.length, 2, 'a poll between reads joins the live read instead of starting another')

    held[1]?.()
    assert.equal((await third).status, 200)
    assert.equal((await second).status, 200)
    assert.equal((await first).status, 200)
  } finally {
    globalThis.fetch = original
  }
})

test('a row outside the schema bounds still fails at the boundary', () => {
  assert.throws(() => OmniRoute.Config({ timeoutMs: 0 }), /timeoutMs/)
  assert.throws(() => OmniRoute.resolveRow({ cacheSeconds: -1 }), /cacheSeconds/)
})

test('a base URL without an http(s) scheme fails at load, never falling back', () => {
  // `box:20128` parses as a URL whose origin is "null"; a silent fallback to
  // the default origin would send the key to a host nobody configured.
  for (const baseURL of ['192.168.0.100:20128', 'box:20128', 'not a url', 'ftp://box:20128']) {
    assert.throws(() => OmniRoute.Config({ baseURL }), /baseURL/, baseURL)
    assert.throws(() => mount(SERVICES, { baseURL }), /baseURL/, baseURL)
  }
})

test('a live base URL that turns malformed is a configuration error, and nothing is asked', async () => {
  const state = { baseURL: 'http://a.example:20128' }
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
    state.baseURL = 'box:20128'
    routes.emitVolatile()
    const route = routes.get(ROUTE_MODELS)
    assert.ok(route)
    const reply = await request(route, ROUTE_MODELS)
    assert.equal(reply.status, 502)
    assert.match(String((reply.body as { message: string }).message), /baseURL is not an absolute http\(s\) URL/)
    assert.deepEqual(seen, [], 'no request, so the key went nowhere')
  } finally {
    restore()
  }
})
