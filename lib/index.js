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
import { createOmniRouteApi, originOf, } from "./omniroute.js";
/** Plugin name as it appears in the loader. */
export const name = 'omniroute';
/** The route carrier is the one service this plugin cannot work without. */
export const inject = ['webServer'];
/** The live model catalog. */
export const ROUTE_MODELS = '/omniroute/models';
/** The upstream connections. */
export const ROUTE_CONNECTIONS = '/omniroute/connections';
/** The quota every connection publishes. */
export const ROUTE_QUOTA = '/omniroute/quota';
/** Where an OmniRoute deployment listens unless configuration says otherwise. */
export const DEFAULT_BASE_URL = 'http://localhost:20128';
/** Credential reference tried when the plugin row names none. */
export const DEFAULT_API_KEY_ENV = 'OMNIROUTE_API_KEY';
/** Per-request deadline for one OmniRoute call, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Seconds one reading is served without asking OmniRoute again. */
export const DEFAULT_CACHE_SECONDS = 30;
/** Settings namespace of the provider route a model sync writes into. */
export const DEFAULT_SYNC_NAMESPACE = 'llm-pi-ai';
/** Provider route a model sync writes into. */
export const DEFAULT_SYNC_PROVIDER = 'omniroute';
/**
 * Row schema: what Cordis validates this plugin's `config` against, and where
 * each default lives.
 */
export const Config = Schema.object({
    baseURL: Schema.string().default(DEFAULT_BASE_URL),
    apiKeyEnv: Schema.string().default(DEFAULT_API_KEY_ENV),
    timeoutMs: Schema.number().min(1).max(60_000).default(DEFAULT_TIMEOUT_MS),
    cacheSeconds: Schema.number().min(0).max(3_600).default(DEFAULT_CACHE_SECONDS),
    syncNamespace: Schema.string().default(DEFAULT_SYNC_NAMESPACE),
    syncProvider: Schema.string().default(DEFAULT_SYNC_PROVIDER),
});
/** Write a JSON reply; readings are live facts and are never browser-cached. */
function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
}
/** The composition's trust fence, when this composition mounts one. */
function connectionOf(ctx) {
    return ctx.get('connection');
}
/**
 * Resolve the OmniRoute API key: the configured reference first, then the
 * launcher's own environment for that name.
 * @param ctx - host context.
 * @param envName - the reference to resolve.
 * @returns the key, or `undefined` when neither source has one.
 */
async function apiKeyOf(ctx, envName) {
    const credentials = ctx.get('credentials');
    const resolved = await credentials?.resolve(envName);
    const stored = resolved?.value;
    if (stored !== undefined && stored.length > 0)
        return stored;
    const ambient = process.env[envName];
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined;
}
/**
 * Copy the live catalog into a provider route's settings.
 * @param ctx - host context.
 * @param namespace - settings namespace to merge into.
 * @param provider - provider route to write models for.
 * @param models - the catalog to write, already filtered to what is servable.
 * @returns the count written.
 */
async function syncModels(ctx, namespace, provider, models) {
    const settings = ctx.get('settings');
    if (settings === undefined)
        throw new Error('the settings service is not mounted, so nothing can be written');
    const entries = models.map(model => {
        const entry = { id: model.id };
        if (model.name !== undefined)
            entry['name'] = model.name;
        return entry;
    });
    await settings.update(namespace, { providers: { [provider]: { models: entries } } });
    return entries.length;
}
/**
 * Mount the host half.
 * @param ctx - host context carrying the route carrier.
 * @param config - this plugin's row configuration.
 */
export function apply(ctx, config = {}) {
    // The row schema fills every default (even for an omitted row), so the
    // reads below are plain: the schema is the single source of each default.
    const validated = Config(config);
    const origin = originOf(validated.baseURL, DEFAULT_BASE_URL);
    const envName = validated.apiKeyEnv;
    const timeoutMs = validated.timeoutMs;
    const cacheSeconds = validated.cacheSeconds;
    const syncNamespace = validated.syncNamespace;
    const syncProvider = validated.syncProvider;
    const cache = new Map();
    const inflight = new Map();
    /** The client for one request, built after its credential resolved. */
    const apiFor = async () => {
        const key = await apiKeyOf(ctx, envName);
        return key === undefined ? undefined : createOmniRouteApi({ origin, key, timeoutMs });
    };
    /** Serve one cached read, keyed by route name. */
    const read = async (key, refresh, load) => {
        const hit = cache.get(key);
        if (!refresh && hit !== undefined && Date.now() - hit.at < cacheSeconds * 1_000)
            return hit.value;
        const running = inflight.get(key);
        if (running !== undefined)
            return running;
        const pending = load().then((value) => {
            cache.set(key, { at: Date.now(), value });
            return value;
        }).finally(() => {
            inflight.delete(key);
        });
        inflight.set(key, pending);
        return pending;
    };
    /** The catalog, filtered the way the query string asked for. */
    const filtered = (models, params) => {
        const query = (params.get('q') ?? '').toLowerCase();
        const provider = params.get('provider');
        return models.filter((model) => {
            if (params.get('available') === '1' && !model.available)
                return false;
            if (provider !== null && provider !== '' && model.provider !== provider)
                return false;
            if (query === '')
                return true;
            return model.id.toLowerCase().includes(query)
                || (model.name ?? '').toLowerCase().includes(query)
                || (model.alias ?? '').toLowerCase().includes(query);
        });
    };
    const modelsRoute = async (params, refresh) => {
        const api = await apiFor();
        if (api === undefined)
            throw new Error(`no OmniRoute API key is configured (${envName})`);
        const models = await read('models', refresh, () => api.models());
        const shown = filtered(models, params);
        const reply = {
            status: 'ok',
            provider: syncProvider,
            origin,
            fetchedAt: Date.now(),
            counts: {
                total: models.length,
                available: models.filter(model => model.available).length,
                shown: shown.length,
            },
            models: shown,
        };
        if (params.get('sync') === '1') {
            const written = await syncModels(ctx, syncNamespace, syncProvider, shown.filter(model => model.available));
            reply['synced'] = {
                namespace: syncNamespace,
                path: `providers.${syncProvider}.models`,
                count: written,
            };
            ctx.logger.warn(`omniroute: wrote ${String(written)} models into ${syncNamespace}.providers.${syncProvider}.models`);
        }
        return reply;
    };
    const connectionsRoute = async (refresh) => {
        const api = await apiFor();
        if (api === undefined)
            throw new Error(`no OmniRoute API key is configured (${envName})`);
        const connections = await read('connections', refresh, () => api.connections());
        return { status: 'ok', origin, fetchedAt: Date.now(), total: connections.length, connections };
    };
    const quotaRoute = async (refresh) => {
        const api = await apiFor();
        if (api === undefined)
            throw new Error(`no OmniRoute API key is configured (${envName})`);
        const [connections, windows] = await Promise.all([
            read('connections', refresh, () => api.connections()),
            read('quota', refresh, () => api.quota()),
        ]);
        return {
            status: 'ok',
            origin,
            fetchedAt: Date.now(),
            connections,
            windows,
            limitReached: windows.filter(window => window.limitReached).map(window => window.plan ?? window.connection),
        };
    };
    /** One shared GET wrapper around every route handler. */
    const handlerFor = (run) => async (req, res) => {
        const rejection = connectionOf(ctx)?.requestRejection(req);
        if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
            res.setHeader('allow', 'GET');
            sendJson(res, 405, { status: 'error', message: 'this route answers GET only' });
            return;
        }
        const target = new URL(String(req.url), 'http://localhost');
        try {
            sendJson(res, 200, await run(target.searchParams, target.searchParams.get('refresh') === '1'));
        }
        catch (error) {
            // A refusal never carries the key or the router's own body: the
            // message is this plugin's own, and the cause is shortened to one line.
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 502, { status: 'error', message, origin });
        }
    };
    const routes = [
        [ROUTE_MODELS, modelsRoute],
        [ROUTE_CONNECTIONS, (_params, refresh) => connectionsRoute(refresh)],
        [ROUTE_QUOTA, (_params, refresh) => quotaRoute(refresh)],
    ];
    for (const [path, run] of routes) {
        ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler: handlerFor(run) }), `omniroute: GET ${path}`);
    }
}
