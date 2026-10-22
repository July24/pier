/** Shared structural guards used by the *-core validators. */

/** Plain JSON object: not null, not an array. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
