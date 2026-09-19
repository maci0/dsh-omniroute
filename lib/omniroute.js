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
import { numberOf, record, stringOf } from "./util.js";
/**
 * Parse a `GET /api/models` body.
 * @param payload - the decoded body.
 * @returns one entry per model the body carried.
 */
export function parseModels(payload) {
    const entries = record(payload)?.['models'];
    if (!Array.isArray(entries))
        return [];
    const models = [];
    for (const entry of entries) {
        const model = record(entry);
        if (model === undefined)
            continue;
        const id = stringOf(model['fullModel']) ?? stringOf(model['model']);
        if (id === undefined)
            continue;
        models.push({
            id,
            provider: stringOf(model['provider']) ?? 'omniroute',
            name: stringOf(model['name']),
            alias: stringOf(model['alias']),
            available: model['available'] === true,
            vision: model['supportsVision'] === true,
        });
    }
    return models;
}
/**
 * Parse a `GET /api/providers` body.
 * @param payload - the decoded body.
 * @returns one entry per connection the body carried.
 */
export function parseConnections(payload) {
    const entries = record(payload)?.['connections'];
    if (!Array.isArray(entries))
        return [];
    const connections = [];
    for (const entry of entries) {
        const connection = record(entry);
        if (connection === undefined)
            continue;
        const id = stringOf(connection['id']);
        if (id === undefined)
            continue;
        connections.push({
            id,
            provider: stringOf(connection['provider']) ?? 'omniroute',
            name: stringOf(connection['name']),
            active: connection['isActive'] !== false,
            quotaVisible: connection['quotaVisible'] !== false,
        });
    }
    return connections;
}
/**
 * Parse one `GET /api/usage/<connectionId>` body.
 * @param payload - the decoded body.
 * @param connection - the connection it was asked about.
 * @returns one entry per window the body carried.
 */
export function parseUsage(payload, connection) {
    const usage = record(payload);
    if (usage === undefined)
        return [];
    const quotas = record(usage['quotas']);
    if (quotas === undefined)
        return [];
    const plan = stringOf(usage['plan']) ?? connection.name ?? connection.provider;
    const limitReached = usage['limitReached'] === true;
    const windows = [];
    for (const [window, raw] of Object.entries(quotas)) {
        const meter = record(raw);
        if (meter === undefined)
            continue;
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
        });
    }
    return windows;
}
/** Origin of a configured base URL, which is what carries OmniRoute's own API. */
export function originOf(baseURL, fallback) {
    if (baseURL === undefined || baseURL === '')
        return fallback;
    try {
        return new URL(baseURL).origin;
    }
    catch {
        return fallback;
    }
}
/**
 * Build the client for one deployment.
 * @param options - origin, credential, deadline, and transport.
 * @returns the three reads, each failing loud on a refused request.
 */
export function createOmniRouteApi(options) {
    const transport = options.fetchImpl ?? globalThis.fetch;
    const headers = { authorization: `Bearer ${options.key}`, accept: 'application/json' };
    const get = async (path) => {
        const response = await transport(`${options.origin}${path}`, {
            headers,
            signal: AbortSignal.timeout(options.timeoutMs),
        });
        if (!response.ok) {
            throw new Error(`OmniRoute answered HTTP ${String(response.status)} for ${path}`);
        }
        return await response.json();
    };
    const connections = async () => parseConnections(await get('/api/providers'));
    return {
        models: async () => parseModels(await get('/api/models')),
        connections,
        quota: async (listed) => {
            const all = listed ?? await connections();
            // A connection that is off, or hides its quota, is not asked at all; one
            // that fails to answer contributes no window rather than failing the read.
            const asked = all.filter(connection => connection.active && connection.quotaVisible);
            const answers = await Promise.all(asked.map(async (connection) => {
                try {
                    return parseUsage(await get(`/api/usage/${encodeURIComponent(connection.id)}`), connection);
                }
                catch {
                    return [];
                }
            }));
            return answers.flat();
        },
    };
}
