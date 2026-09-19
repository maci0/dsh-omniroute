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
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read one field as a non-empty string, or `undefined`. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read one field as a finite number, or `undefined`. */
export function numberOf(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}
