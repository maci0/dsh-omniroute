/**
 * dsh-omniroute — OmniRoute's own API surface, inside DeepSeek Harness.
 *
 * Three read-only routes, all behind the composition's trust fence and all
 * serving JSON:
 *
 * - `GET /omniroute/models` — the live model catalog from OmniRoute's
 *   `GET /api/models`: which models exist, which ones the router can serve
 *   right now, and which take images. `?available=1`, `?q=<text>` and
 *   `?provider=<key>` narrow it. `?sync=1` also writes the available models
 *   into a configured provider route, which is how the model picker learns
 *   them.
 * - `GET /omniroute/connections` — the upstream connections from
 *   `GET /api/providers`.
 * - `GET /omniroute/quota` — the plan and windows of every connection that
 *   publishes one, from `GET /api/usage/<connectionId>`.
 *
 * The API key stays in this process: the browser or the model only ever reads
 * the JSON these routes return. Readings are cached for a few seconds per
 * route, so a refresh loop cannot multiply requests to the router.
 *
 * @module dsh-omniroute
 */
import Schema from '@deepseek-ai/schemastery';
import type { HostContext } from './host.ts';
/** Plugin name as it appears in the loader. */
export declare const name = "omniroute";
/** The route carrier is the one service this plugin cannot work without. */
export declare const inject: string[];
/** The live model catalog. */
export declare const ROUTE_MODELS = "/omniroute/models";
/** The upstream connections. */
export declare const ROUTE_CONNECTIONS = "/omniroute/connections";
/** The quota every connection publishes. */
export declare const ROUTE_QUOTA = "/omniroute/quota";
/** Where an OmniRoute deployment listens unless configuration says otherwise. */
export declare const DEFAULT_BASE_URL = "http://localhost:20128";
/** Credential reference tried when the plugin row names none. */
export declare const DEFAULT_API_KEY_ENV = "OMNIROUTE_API_KEY";
/** Per-request deadline for one OmniRoute call, in milliseconds. */
export declare const DEFAULT_TIMEOUT_MS = 10000;
/** Seconds one reading is served without asking OmniRoute again. */
export declare const DEFAULT_CACHE_SECONDS = 30;
/** Profile entry id of the provider route a model sync writes into. */
export declare const DEFAULT_SYNC_NAMESPACE = "llm-pi-ai";
/** Provider route a model sync writes into. */
export declare const DEFAULT_SYNC_PROVIDER = "omniroute";
/** Configuration accepted from this plugin's row in a profile patch. */
export interface Config {
    /** OmniRoute origin, with or without its `/v1` path. @default http://localhost:20128 */
    readonly baseURL?: string;
    /** Credential reference holding the OmniRoute API key. @default OMNIROUTE_API_KEY */
    readonly apiKeyEnv?: string;
    /** Per-request deadline in milliseconds. @default 10000 */
    readonly timeoutMs?: number;
    /** Seconds a reading stays cached. `0` re-asks on every request. @default 30 */
    readonly cacheSeconds?: number;
    /** Profile entry id `?sync=1` writes the model catalog into. @default llm-pi-ai */
    readonly syncNamespace?: string;
    /** Provider route `?sync=1` writes the model catalog into. @default omniroute */
    readonly syncProvider?: string;
}
/**
 * Row schema: what Cordis validates this plugin's `config` against, and where
 * each default lives.
 */
export declare const Config: Schema<Config>;
/**
 * Mount the host half.
 * @param ctx - host context carrying the route carrier.
 * @param config - this plugin's row configuration.
 */
export declare function apply(ctx: HostContext, config?: Config): void;
