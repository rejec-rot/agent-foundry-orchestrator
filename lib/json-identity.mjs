import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted at every depth, so key order cannot change identity. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Stable digest of a capsule, so idempotency can tell "same submission" from "same key, new spec". */
export function capsuleDigest(capsule) {
  return createHash('sha256').update(stableStringify(capsule)).digest('hex');
}
