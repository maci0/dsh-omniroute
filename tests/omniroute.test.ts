/**
 * The OmniRoute client: parsers against payloads copied from a running
 * `v3.8.50` server, and the one listing rule that decides which connections
 * are asked for quota. No network: the transport is stubbed per case.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createOmniRouteApi,
  originOf,
  parseConnections,
  parseModels,
  parseUsage,
} from '../src/omniroute.ts'

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

test('the model catalog keeps the served id, name, availability and vision', () => {
  const models = parseModels({
    models: [
      {
        provider: 'glm',
        model: 'glm-5.3',
        name: 'GLM 5.3',
        fullModel: 'glm/glm-5.3',
        alias: 'glm-5.3',
        available: true,
        supportsVision: false,
      },
      { provider: 'cc', model: 'claude-opus-5', fullModel: 'cc/claude-opus-5', available: false, supportsVision: true },
      { provider: 'broken' },
      'not-an-object',
    ],
  })
  assert.deepEqual(models, [
    {
      id: 'glm/glm-5.3',
      provider: 'glm',
      name: 'GLM 5.3',
      alias: 'glm-5.3',
      available: true,
      vision: false,
    },
    { id: 'cc/claude-opus-5', provider: 'cc', name: undefined, alias: undefined, available: false, vision: true },
  ])
  assert.deepEqual(parseModels({ error: 'nope' }), [])
  assert.deepEqual(parseModels(undefined), [])
})

test('a connection listing defaults to visible and active, and honours a flag that says otherwise', () => {
  assert.deepEqual(parseConnections({
    connections: [
      { id: 'a', provider: 'deepseek', name: 'main', isActive: true, quotaVisible: true },
      { id: 'b', provider: 'codex', isActive: false },
      { id: 'c', provider: 'glm', quotaVisible: false },
      { provider: 'no-id' },
    ],
  }), [
    { id: 'a', provider: 'deepseek', name: 'main', active: true, quotaVisible: true },
    { id: 'b', provider: 'codex', name: undefined, active: false, quotaVisible: true },
    { id: 'c', provider: 'glm', name: undefined, active: true, quotaVisible: false },
  ])
})

test('one usage body becomes one entry per window, carrying its plan', () => {
  const connection = { id: 'ef7b', provider: 'codex', name: 'maci', active: true, quotaVisible: true }
  assert.deepEqual(parseUsage({
    plan: 'plus',
    quotas: {
      session: { used: 0, total: 100, remaining: 100, remainingPercentage: 100, resetAt: null, unlimited: false },
      'weekly (7d)': { used: 32, total: 100, remaining: 68, remainingPercentage: 68, resetAt: '2026-09-24T06:46:49.000Z' },
    },
    limitReached: true,
  }, connection), [
    {
      connection: 'ef7b',
      provider: 'codex',
      plan: 'plus',
      window: 'session',
      used: 0,
      total: 100,
      remaining: 100,
      remainingPercent: 100,
      unlimited: false,
      resetAt: undefined,
      currency: undefined,
      limitReached: true,
    },
    {
      connection: 'ef7b',
      provider: 'codex',
      plan: 'plus',
      window: 'weekly (7d)',
      used: 32,
      total: 100,
      remaining: 68,
      remainingPercent: 68,
      unlimited: false,
      resetAt: '2026-09-24T06:46:49.000Z',
      currency: undefined,
      limitReached: true,
    },
  ])
  // A plan-less body falls back to the connection's own label.
  assert.equal(parseUsage({ quotas: {} }, connection).length, 0)
  assert.equal(parseUsage({ plan: null, quotas: { weekly: { used: 1 } } }, connection)[0]?.plan, 'maci')
})

test('the client asks only the visible, live connections for their quota', async () => {
  const calls: string[] = []
  const stub = stubFetch({
    '/api/providers': {
      connections: [
        { id: 'a', provider: 'deepseek', name: 'main', isActive: true, quotaVisible: true },
        { id: 'b', provider: 'codex', isActive: false, quotaVisible: true },
        { id: 'c', provider: 'glm', isActive: true, quotaVisible: false },
      ],
    },
    '/api/usage/a': {
      plan: 'DeepSeek',
      quotas: { credits_usd: { used: 0, total: 0, remaining: 91.43, unlimited: true, currency: 'USD' } },
      limitReached: false,
    },
  }, calls)
  try {
    const api = createOmniRouteApi({ origin: 'http://box:20128', key: 'sk-test', timeoutMs: 1_000 })
    const windows = await api.quota()
    assert.deepEqual(calls, ['http://box:20128/api/providers', 'http://box:20128/api/usage/a'])
    assert.equal(windows.length, 1)
    assert.equal(windows[0]?.plan, 'DeepSeek')
    assert.equal(windows[0]?.remaining, 91.43)
  } finally {
    stub.restore()
  }
})

test('a refused connection drops out of the quota read instead of failing it', async () => {
  const stub = stubFetch({
    '/api/providers': {
      connections: [
        { id: 'bad', provider: 'opencode', isActive: true, quotaVisible: true },
        { id: 'good', provider: 'cursor', isActive: true, quotaVisible: true },
      ],
    },
    '/api/usage/good': { plan: 'Cursor Pro', quotas: { Total: { used: 400, total: 400, remaining: 0 } } },
  })
  try {
    const api = createOmniRouteApi({ origin: 'http://box:20128', key: 'sk-test', timeoutMs: 1_000 })
    const windows = await api.quota()
    assert.deepEqual(windows.map(window => window.connection), ['good'])
  } finally {
    stub.restore()
  }
})

test('a refused read reports the status and never the router body', async () => {
  const stub = stubFetch({})
  try {
    const api = createOmniRouteApi({ origin: 'http://box:20128', key: 'sk-test', timeoutMs: 1_000 })
    await assert.rejects(async () => await api.models(), /OmniRoute answered HTTP 404 for \/api\/models/)
  } finally {
    stub.restore()
  }
})

test('a configured base URL contributes its origin, not its /v1 path', () => {
  assert.equal(originOf('http://192.168.0.100:20128/v1', 'http://localhost:20128'), 'http://192.168.0.100:20128')
  assert.equal(originOf('not a url', 'http://localhost:20128'), 'http://localhost:20128')
  assert.equal(originOf(undefined, 'http://localhost:20128'), 'http://localhost:20128')
})
