/**
 * The slice of the DeepSeek Harness host surface this plugin uses, declared
 * structurally.
 *
 * The plugin installs from outside the harness checkout and has no runtime
 * dependency on harness packages: the services it reaches are typed here, and
 * a composition that mounts none of them simply omits that capability. The
 * same shape also lets the unit tests drive `apply` with a plain fake context.
 *
 * @module dsh-omniroute/host
 */
/** Disposer returned by every host registration. */
export type Disposable = () => void;
/** The slice of the credentials service this plugin reads. */
export interface CredentialsLike {
    /**
     * Resolve one credential reference to its value.
     * @param ref - environment-variable-style reference name.
     * @returns the resolved value, or `undefined` when nothing is stored.
     */
    resolve(ref: string): Promise<{
        readonly value: string;
    } | undefined>;
}
/** The slice of the settings service this plugin writes through. */
export interface SettingsLike {
    /**
     * Merge a patch into one profile entry.
     * @param ns - profile entry id (v0.1.7), not a settings namespace.
     * @param patch - plain-object patch over that entry.
     * @returns when the write is persisted.
     */
    update(ns: string, patch: object): Promise<void>;
}
/** Request subset the trust fence reads. */
export interface RequestLike {
    /** Request method. */
    readonly method?: string | undefined;
    /** Request target, including the query string. */
    readonly url?: string | undefined;
    /** Request headers, read by the composition's trust fence. */
    readonly headers: object | undefined;
}
/** Response subset this plugin writes. */
export interface ResponseLike {
    /** HTTP status code. */
    statusCode: number;
    /** Set one response header. */
    setHeader(name: string, value: string): void;
    /** End the response, optionally with a body. */
    end(body?: string): void;
}
/** One exact-path route registration. */
export interface WebRouteLike {
    /** Match kind; this plugin registers only exact paths. */
    readonly kind: 'exact';
    /** Absolute pathname, no trailing slash. */
    readonly path: string;
    /** Owns the full response lifecycle. */
    handler: (req: RequestLike, res: ResponseLike) => void | Promise<void>;
}
/** The slice of the HTTP carrier this plugin registers on. */
export interface WebServerLike {
    /**
     * Register one route.
     * @param route - path, match kind, and handler.
     * @returns the disposer that withdraws it.
     */
    register(route: WebRouteLike): Disposable;
}
/** The composition's trust fence, when one is mounted. */
export interface ConnectionLike {
    /**
     * Reject an untrusted or unauthenticated request.
     * @param request - headers of the incoming request.
     * @returns the rejection status, or `undefined` when the request may proceed.
     */
    requestRejection(request: {
        readonly headers: object | undefined;
    }): 401 | 403 | undefined;
}
/**
 * Structural view of the Cordis context this plugin uses.
 *
 * `inject` guarantees `webServer`; the credentials and settings services are
 * read through `get`, so a composition without them degrades to "no
 * credential to read with" and omits the model sync instead of failing to
 * mount.
 */
export interface HostContext {
    /** Bind a registration's lifetime to this plugin's fiber. */
    effect(callback: () => Disposable | void, label?: string): unknown;
    /** Read one optional service. */
    get(name: string): unknown;
    /** Structured log surface. */
    readonly logger: {
        warn(message: string): void;
        error(message: string): void;
    };
    /** HTTP route carrier (guaranteed by `inject`). */
    readonly webServer: WebServerLike;
}
