/**
 * OmniRoute management-API client: the live model catalog, the provider
 * connections, and the quota each connection reports.
 *
 * The endpoints are OmniRoute's own, read from a running `v3.8.50` server's
 * `/api/openapi/spec` and `/api/agent-skills` directory:
 *
 * - `GET /api/models` — every model across the configured providers, each with
 *   an `available` flag and a `supportsVision` flag. This is the management
 *   listing, not the OpenAI-shaped `GET /v1/models`: it is the one that says
 *   which models the router can actually serve *now*.
 * - `GET /api/providers` — the upstream connections. Each carries the `id` that
 *   the per-connection usage route addresses, plus `quotaVisible` and
 *   `isActive`.
 * - `GET /api/usage/<connectionId>` — that connection's plan, its windows
 *   (`session`, `weekly`, `credits_usd`, …), and whether the limit is reached.
 *
 * OmniRoute routes to accounts it holds, so it publishes no figure for the
 * router itself; quota is read per connection and flattened into one list.
 * `/api/quota/plans` resolves plans but carries no consumption, and
 * `/api/quota/pools` is empty unless the deployment defines pools, so neither
 * is used here.
 *
 * Everything below the `createOmniRouteApi` line is pure parsing; the tests
 * drive it with payloads copied from a live server.
 *
 * @module dsh-omniroute/omniroute
 */

import { numberOf, record, stringOf } from './util.ts'

/** One model OmniRoute advertises. */
export interface OmniRouteModel {
  /** Id a request names: the `fullModel` when the listing has one. */
  readonly id: string
  /** Upstream provider key, e.g. `glm` or `cc`. */
  readonly provider: string
  /** Display name, when the listing carries one. */
  readonly name?: string
  /** Short alias, when the listing carries one. */
  readonly alias?: string
  /** Whether the router can serve it right now. */
  readonly available: boolean
  /** Whether it accepts images. */
  readonly vision: boolean
}

/** One upstream connection OmniRoute holds. */
export interface OmniRouteConnection {
  /** Connection id, which the usage route addresses. */
  readonly id: string
  /** Upstream provider key, e.g. `deepseek`. */
  readonly provider: string
  /** Human label for the connection, e.g. an account address. */
  readonly name?: string
  /** Whether the connection is switched on. */
  readonly active: boolean
  /** Whether the connection publishes its quota. */
  readonly quotaVisible: boolean
}

/** One quota window of one connection. */
export interface OmniRouteQuota {
  /** Connection the window belongs to. */
  readonly connection: string
  /** Upstream provider key of that connection. */
  readonly provider: string
  /** Resolved plan name the connection reported, e.g. `plus` or `DeepSeek`. */
  readonly plan?: string
  /** Window name as OmniRoute spells it, e.g. `session (5h)` or `credits_usd`. */
  readonly window: string
  /** Consumed amount, in the window's own unit. */
  readonly used?: number
  /** Window ceiling, when it has one. */
  readonly total?: number
  /** Amount left, when the connection reports one. */
  readonly remaining?: number
  /** Percentage left as the connection reports it. */
  readonly remainingPercent?: number
  /** Whether the connection reports no ceiling at all. */
  readonly unlimited: boolean
  /** ISO instant the window resets, when it reports one. */
  readonly resetAt?: string
  /** Currency of a money window, when it reports one. */
  readonly currency?: string
  /** Whether the connection says the limit is reached. */
  readonly limitReached: boolean
}

/** Everything the client needs to talk to one OmniRoute deployment. */
export interface OmniRouteApiOptions {
  /** Deployment origin, without the `/v1` path, e.g. `http://box:20128`. */
  readonly origin: string
  /** OmniRoute API key, sent as a bearer token. */
  readonly key: string
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Transport override, for tests. @default globalThis.fetch */
  readonly fetchImpl?: typeof fetch
}

/** The three reads this plugin offers. */
export interface OmniRouteApi {
  /**
   * List every advertised model.
   * @returns the catalog in listing order.
   */
  models(): Promise<readonly OmniRouteModel[]>
  /**
   * List every upstream connection.
   * @returns the connections in listing order.
   */
  connections(): Promise<readonly OmniRouteConnection[]>
  /**
   * Read the quota of every connection that publishes one.
   * @param listed - connections already read, so the caller does not make this
   * client ask `/api/providers` a second time for the same reading.
   * @returns one entry per window, connections in listing order.
   */
  quota(listed?: readonly OmniRouteConnection[]): Promise<readonly OmniRouteQuota[]>
}

/**
 * Parse a `GET /api/models` body.
 * @param payload - the decoded body.
 * @returns one entry per model the body carried.
 */
export function parseModels(payload: unknown): readonly OmniRouteModel[] {
  const entries = record(payload)?.['models']
  if (!Array.isArray(entries)) return []
  const models: OmniRouteModel[] = []
  for (const entry of entries) {
    const model = record(entry)
    if (model === undefined) continue
    const id = stringOf(model['fullModel']) ?? stringOf(model['model'])
    if (id === undefined) continue
    models.push({
      id,
      provider: stringOf(model['provider']) ?? 'omniroute',
      name: stringOf(model['name']),
      alias: stringOf(model['alias']),
      available: model['available'] === true,
      vision: model['supportsVision'] === true,
    })
  }
  return models
}

/**
 * Parse a `GET /api/providers` body.
 * @param payload - the decoded body.
 * @returns one entry per connection the body carried.
 */
export function parseConnections(payload: unknown): readonly OmniRouteConnection[] {
  const entries = record(payload)?.['connections']
  if (!Array.isArray(entries)) return []
  const connections: OmniRouteConnection[] = []
  for (const entry of entries) {
    const connection = record(entry)
    if (connection === undefined) continue
    const id = stringOf(connection['id'])
    if (id === undefined) continue
    connections.push({
      id,
      provider: stringOf(connection['provider']) ?? 'omniroute',
      name: stringOf(connection['name']),
      active: connection['isActive'] !== false,
      quotaVisible: connection['quotaVisible'] !== false,
    })
  }
  return connections
}

/**
 * Parse one `GET /api/usage/<connectionId>` body.
 * @param payload - the decoded body.
 * @param connection - the connection it was asked about.
 * @returns one entry per window the body carried.
 */
export function parseUsage(payload: unknown, connection: OmniRouteConnection): readonly OmniRouteQuota[] {
  const usage = record(payload)
  if (usage === undefined) return []
  const quotas = record(usage['quotas'])
  if (quotas === undefined) return []
  const plan = stringOf(usage['plan']) ?? connection.name ?? connection.provider
  const limitReached = usage['limitReached'] === true
  const windows: OmniRouteQuota[] = []
  for (const [window, raw] of Object.entries(quotas)) {
    const meter = record(raw)
    if (meter === undefined) continue
    windows.push({
      connection: connection.id,
      provider: connection.provider,
      plan,
      window,
      used: numberOf(meter['used']),
      total: numberOf(meter['total']),
      remaining: numberOf(meter['remaining']),
      remainingPercent: numberOf(meter['remainingPercentage']),
      unlimited: meter['unlimited'] === true,
      resetAt: stringOf(meter['resetAt']),
      currency: stringOf(meter['currency']),
      limitReached,
    })
  }
  return windows
}

/** Origin of a configured base URL, which is what carries OmniRoute's own API. */
export function originOf(baseURL: string | undefined, fallback: string): string {
  if (baseURL === undefined || baseURL === '') return fallback
  try {
    return new URL(baseURL).origin
  } catch {
    return fallback
  }
}

/**
 * Build the client for one deployment.
 * @param options - origin, credential, deadline, and transport.
 * @returns the three reads, each failing loud on a refused request.
 */
export function createOmniRouteApi(options: OmniRouteApiOptions): OmniRouteApi {
  const transport = options.fetchImpl ?? globalThis.fetch
  const headers = { authorization: `Bearer ${options.key}`, accept: 'application/json' }

  const get = async (path: string): Promise<unknown> => {
    const response = await transport(`${options.origin}${path}`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`OmniRoute answered HTTP ${String(response.status)} for ${path}`)
    }
    return await response.json()
  }

  const connections = async (): Promise<readonly OmniRouteConnection[]> =>
    parseConnections(await get('/api/providers'))

  return {
    models: async () => parseModels(await get('/api/models')),
    connections,
    quota: async (listed) => {
      const all = listed ?? await connections()
      // A connection that is off, or hides its quota, is not asked at all; one
      // that fails to answer contributes no window rather than failing the read.
      const asked = all.filter(connection => connection.active && connection.quotaVisible)
      const answers = await Promise.all(asked.map(async (connection) => {
        try {
          return parseUsage(await get(`/api/usage/${encodeURIComponent(connection.id)}`), connection)
        } catch {
          return []
        }
      }))
      return answers.flat()
    },
  }
}
