/**
 * Narrowing helpers for the OmniRoute client: every payload field is an
 * `unknown` until one of these reads it.
 *
 * This package's own copy. The two plugins ship independently and share no
 * package, so each keeps the handful of lines it narrows with.
 *
 * @module dsh-omniroute/util
 */
/** Narrow an unknown to an indexable object. */
export declare function record(value: unknown): Record<string, unknown> | undefined;
/** Read one field as a non-empty string, or `undefined`. */
export declare function stringOf(value: unknown): string | undefined;
/** Read one field as a finite number, or `undefined`. */
export declare function numberOf(value: unknown): number | undefined;
