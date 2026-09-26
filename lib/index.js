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
import { createOmniRouteApi, originOf, } from './omniroute.js';
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
/** Profile entry id of the provider route a model sync writes into. */
export const DEFAULT_SYNC_NAMESPACE = 'llm-pi-ai';
/** Provider route a model sync writes into. */
export const DEFAULT_SYNC_PROVIDER = 'omniroute';
/**
 * Field defaults and bounds with no volatility wrapper. {@link resolveRow}
 * parses a plain row through this schema, so its output is plain values; the
 * loader-facing {@link Config} below is the same shape with every field made
 * `volatile()`. The pair is asserted equal in the suite.
 */
const ValueSchema = Schema.object({
    baseURL: Schema.string().default(DEFAULT_BASE_URL),
    apiKeyEnv: Schema.string().default(DEFAULT_API_KEY_ENV),
    timeoutMs: Schema.number().min(1).max(60_000).default(DEFAULT_TIMEOUT_MS),
    cacheSeconds: Schema.number().min(0).max(3_600).default(DEFAULT_CACHE_SECONDS),
    syncNamespace: Schema.string().default(DEFAULT_SYNC_NAMESPACE),
    syncProvider: Schema.string().default(DEFAULT_SYNC_PROVIDER),
});
/**
 * Row schema as Cordis resolves it: what this plugin's `config` is validated
 * against, and where each default lives. Every field is editable from the
 * Plugins page, so every one is volatile.
 */
export const Config = Schema.object({
    baseURL: Schema.string().default(DEFAULT_BASE_URL).volatile(),
    apiKeyEnv: Schema.string().default(DEFAULT_API_KEY_ENV).volatile(),
    timeoutMs: Schema.number().min(1).max(60_000).default(DEFAULT_TIMEOUT_MS).volatile(),
    cacheSeconds: Schema.number().min(0).max(3_600).default(DEFAULT_CACHE_SECONDS).volatile(),
    syncNamespace: Schema.string().default(DEFAULT_SYNC_NAMESPACE).volatile(),
    syncProvider: Schema.string().default(DEFAULT_SYNC_PROVIDER).volatile(),
});
/**
 * Read one configured field as a plain value.
 *
 * The loader hands a `volatile()` field a live reference; a direct caller (a
 * test, another plugin composing this one) hands the value itself. Both are
 * accepted, so one read path serves both.
 * @param value - the configured value, live or plain.
 * @returns the current plain value, or `undefined` when a reference holds none.
 */
function readLive(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        // A scalar snapshot is the value; the generic cannot narrow that itself.
        return value.get();
    }
    return value;
}
/**
 * Turn a row — live references or plain values — into validated plain options.
 * @param row - the configured row.
 * @returns the resolved options, defaults filled by the schema.
 */
export function resolveRow(row = {}) {
    return ValueSchema({
        baseURL: readLive(row.baseURL),
        apiKeyEnv: readLive(row.apiKeyEnv),
        timeoutMs: readLive(row.timeoutMs),
        cacheSeconds: readLive(row.cacheSeconds),
        syncNamespace: readLive(row.syncNamespace),
        syncProvider: readLive(row.syncProvider),
    });
}
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
 * Query parameters of a request target.
 *
 * Only the query matters here, so only the query is parsed: building a `URL`
 * for every poll pays for an origin the routes never read.
 * @param url - request target, path and query.
 * @returns the decoded parameters.
 */
function searchParamsOf(url) {
    // The fragment is not part of the request target a `URL` would parse either,
    // and a target whose `#` precedes its `?` must not have the fragment read as
    // query text.
    const hash = url.indexOf('#');
    const target = hash < 0 ? url : url.slice(0, hash);
    const start = target.indexOf('?');
    if (start < 0)
        return new URLSearchParams();
    return new URLSearchParams(target.slice(start + 1));
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
 * @param namespace - profile entry id to merge into.
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
export function apply(ctx, row = {}) {
    // Read the row at every use: each field is volatile, so a save from the
    // Plugins card has to reach the next request, not a mount-time copy.
    const live = () => resolveRow(row);
    live();
    /**
     * The origin the live `baseURL` names, derived once per distinct value.
     *
     * Deriving it per request is what makes an edit take effect; doing it more
     * than once per distinct value is what the served-read cost guard forbids,
     * because parsing an origin is not free and a settled row never changes.
     */
    let originKey;
    let originValue = '';
    const liveOrigin = () => {
        const { baseURL } = live();
        if (baseURL !== originKey) {
            originKey = baseURL;
            originValue = originOf(baseURL, DEFAULT_BASE_URL);
        }
        return originValue;
    };
    const cache = new Map();
    const inflight = new Map();
    /** The client for one request, built after its credential resolved. */
    const apiFor = async () => {
        const { apiKeyEnv, timeoutMs } = live();
        const key = await apiKeyOf(ctx, apiKeyEnv);
        return key === undefined
            ? undefined
            : createOmniRouteApi({ origin: liveOrigin(), key, timeoutMs });
    };
    /** Serve one cached read, keyed by route name. */
    const read = async (key, refresh, load) => {
        const hit = cache.get(key);
        if (!refresh && hit !== undefined && Date.now() - hit.at < live().cacheSeconds * 1_000)
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
        const onlyAvailable = params.get('available') === '1';
        // Nothing narrows the read: hand back the cached catalog rather than
        // walking it once per request to build an identical copy.
        if (query === '' && (provider === null || provider === '') && !onlyAvailable)
            return models;
        return models.filter((model) => {
            if (onlyAvailable && !model.available)
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
        const { apiKeyEnv, syncNamespace, syncProvider } = live();
        const origin = liveOrigin();
        const api = await apiFor();
        if (api === undefined)
            throw new Error(`no OmniRoute API key is configured (${apiKeyEnv})`);
        // The available count is a property of the reading, not of the request, so
        // it is counted once per fetch and cached beside the catalog.
        const catalog = await read('models', refresh, async () => {
            const models = await api.models();
            let available = 0;
            for (const model of models)
                if (model.available)
                    available += 1;
            return { models, available };
        });
        const shown = filtered(catalog.models, params);
        const reply = {
            status: 'ok',
            provider: syncProvider,
            origin,
            fetchedAt: Date.now(),
            counts: {
                total: catalog.models.length,
                available: catalog.available,
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
        const { apiKeyEnv } = live();
        const origin = liveOrigin();
        const api = await apiFor();
        if (api === undefined)
            throw new Error(`no OmniRoute API key is configured (${apiKeyEnv})`);
        const connections = await read('connections', refresh, () => api.connections());
        return { status: 'ok', origin, fetchedAt: Date.now(), total: connections.length, connections };
    };
    const quotaRoute = async (refresh) => {
        const { apiKeyEnv } = live();
        const origin = liveOrigin();
        const api = await apiFor();
        if (api === undefined)
            throw new Error(`no OmniRoute API key is configured (${apiKeyEnv})`);
        // The connections are read once and handed to the quota read: asking the
        // client for them again would repeat `/api/providers` on every miss.
        const connections = await read('connections', refresh, () => api.connections());
        const windows = await read('quota', refresh, () => api.quota(connections));
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
        const params = searchParamsOf(String(req.url));
        try {
            sendJson(res, 200, await run(params, params.get('refresh') === '1'));
        }
        catch (error) {
            // A refusal never carries the key or the router's own body: the
            // message is this plugin's own, and the cause is shortened to one line.
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 502, { status: 'error', message, origin: liveOrigin() });
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
    // A settings write moves the live references in place. Dropping the served
    // readings makes the next poll answer from the edited row instead of a
    // cached body fetched from the previous origin, and the log line records it.
    ctx.on('loader/volatile-update', () => {
        cache.clear();
        const { apiKeyEnv, timeoutMs, cacheSeconds, syncNamespace, syncProvider } = live();
        ctx.logger.warn(`omniroute: configuration updated — ${liveOrigin()} as ${apiKeyEnv},`
            + ` ${timeoutMs}ms deadline, ${cacheSeconds}s cache, sync into ${syncNamespace}.providers.${syncProvider}`);
    });
}
