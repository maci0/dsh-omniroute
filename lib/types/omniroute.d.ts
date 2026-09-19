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
/** One model OmniRoute advertises. */
export interface OmniRouteModel {
    /** Id a request names: the `fullModel` when the listing has one. */
    readonly id: string;
    /** Upstream provider key, e.g. `glm` or `cc`. */
    readonly provider: string;
    /** Display name, when the listing carries one. */
    readonly name?: string;
    /** Short alias, when the listing carries one. */
    readonly alias?: string;
    /** Whether the router can serve it right now. */
    readonly available: boolean;
    /** Whether it accepts images. */
    readonly vision: boolean;
}
/** One upstream connection OmniRoute holds. */
export interface OmniRouteConnection {
    /** Connection id, which the usage route addresses. */
    readonly id: string;
    /** Upstream provider key, e.g. `deepseek`. */
    readonly provider: string;
    /** Human label for the connection, e.g. an account address. */
    readonly name?: string;
    /** Whether the connection is switched on. */
    readonly active: boolean;
    /** Whether the connection publishes its quota. */
    readonly quotaVisible: boolean;
}
/** One quota window of one connection. */
export interface OmniRouteQuota {
    /** Connection the window belongs to. */
    readonly connection: string;
    /** Upstream provider key of that connection. */
    readonly provider: string;
    /** Resolved plan name the connection reported, e.g. `plus` or `DeepSeek`. */
    readonly plan?: string;
    /** Window name as OmniRoute spells it, e.g. `session (5h)` or `credits_usd`. */
    readonly window: string;
    /** Consumed amount, in the window's own unit. */
    readonly used?: number;
    /** Window ceiling, when it has one. */
    readonly total?: number;
    /** Amount left, when the connection reports one. */
    readonly remaining?: number;
    /** Percentage left as the connection reports it. */
    readonly remainingPercent?: number;
    /** Whether the connection reports no ceiling at all. */
    readonly unlimited: boolean;
    /** ISO instant the window resets, when it reports one. */
    readonly resetAt?: string;
    /** Currency of a money window, when it reports one. */
    readonly currency?: string;
    /** Whether the connection says the limit is reached. */
    readonly limitReached: boolean;
}
/** Everything the client needs to talk to one OmniRoute deployment. */
export interface OmniRouteApiOptions {
    /** Deployment origin, without the `/v1` path, e.g. `http://box:20128`. */
    readonly origin: string;
    /** OmniRoute API key, sent as a bearer token. */
    readonly key: string;
    /** Per-request deadline in milliseconds. */
    readonly timeoutMs: number;
    /** Transport override, for tests. @default globalThis.fetch */
    readonly fetchImpl?: typeof fetch;
}
/** The three reads this plugin offers. */
export interface OmniRouteApi {
    /**
     * List every advertised model.
     * @returns the catalog in listing order.
     */
    models(): Promise<readonly OmniRouteModel[]>;
    /**
     * List every upstream connection.
     * @returns the connections in listing order.
     */
    connections(): Promise<readonly OmniRouteConnection[]>;
    /**
     * Read the quota of every connection that publishes one.
     * @returns one entry per window, connections in listing order.
     */
    quota(): Promise<readonly OmniRouteQuota[]>;
}
/**
 * Parse a `GET /api/models` body.
 * @param payload - the decoded body.
 * @returns one entry per model the body carried.
 */
export declare function parseModels(payload: unknown): readonly OmniRouteModel[];
/**
 * Parse a `GET /api/providers` body.
 * @param payload - the decoded body.
 * @returns one entry per connection the body carried.
 */
export declare function parseConnections(payload: unknown): readonly OmniRouteConnection[];
/**
 * Parse one `GET /api/usage/<connectionId>` body.
 * @param payload - the decoded body.
 * @param connection - the connection it was asked about.
 * @returns one entry per window the body carried.
 */
export declare function parseUsage(payload: unknown, connection: OmniRouteConnection): readonly OmniRouteQuota[];
/** Origin of a configured base URL, which is what carries OmniRoute's own API. */
export declare function originOf(baseURL: string | undefined, fallback: string): string;
/**
 * Build the client for one deployment.
 * @param options - origin, credential, deadline, and transport.
 * @returns the three reads, each failing loud on a refused request.
 */
export declare function createOmniRouteApi(options: OmniRouteApiOptions): OmniRouteApi;
