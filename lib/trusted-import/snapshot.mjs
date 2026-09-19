// lib/trusted-import/snapshot.mjs
//
// Candidate Revision Snapshot Sealer (§3, §7.2).
// Produces an immutable, content-addressed snapshot record representing the
// captured truth of a candidate workspace.

import { SNAPSHOT_SCHEMA_V1, sha256, AfrError } from './common.mjs';

/**
 * Compare two UTF-8 paths byte-by-byte for deterministic canonical ordering.
 */
function comparePaths(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return Buffer.compare(bufA, bufB);
}

/**
 * Seal a set of captured filesystem entries into an immutable Candidate Revision Snapshot.
 *
 * Identity formula (§3):
 * snapshot_digest = H(schema_version + sorted(path, type, normalized_mode, blob_digest))
 *
 * @param {object} options
 * @param {Array<object>} options.entries - Raw entries from FS capture
 * @param {string} [options.schemaVersion='afr-snapshot-v1']
 * @param {object} [options.metadata={}] - Optional metadata (e.g. baseline_oid, task_id)
 * @returns {object} Sealed Candidate Revision Snapshot (frozen)
 */
export function sealSnapshot({
  entries,
  schemaVersion = SNAPSHOT_SCHEMA_V1,
  metadata = {},
}) {
  if (!Array.isArray(entries)) {
    throw new AfrError('entries must be an array', 'INVALID_ARGUMENT');
  }

  // Create deterministic copy sorted by raw path byte identity (A6)
  const sorted = [...entries].sort((a, b) => comparePaths(a.path, b.path));

  // Build canonical payload
  let payload = `${schemaVersion}\n`;
  for (const entry of sorted) {
    if (!entry.path || !entry.type || !entry.mode || !entry.blob_digest) {
      throw new AfrError('Entry missing required fields (path, type, mode, blob_digest)', 'CORRUPT_ENTRY', {
        entry,
      });
    }
    payload += `${entry.path}\0${entry.type}\0${entry.mode}\0${entry.blob_digest}\n`;
  }

  const snapshotDigest = sha256(payload);

  return Object.freeze({
    schema_version: schemaVersion,
    snapshot_digest: snapshotDigest,
    entries: Object.freeze(sorted.map((e) => Object.freeze({ ...e }))),
    metadata: Object.freeze({ ...metadata }),
    sealed_at: new Date().toISOString(),
  });
}

/**
 * Verify integrity of a sealed snapshot against its digest and optional CAS store.
 *
 * @param {object} snapshot
 * @param {import('./cas.mjs').TrustedCAS} [cas]
 * @returns {boolean} true if valid
 */
export function verifySnapshotIntegrity(snapshot, cas = null) {
  if (!snapshot || !snapshot.snapshot_digest || !Array.isArray(snapshot.entries)) {
    return false;
  }

  const sorted = [...snapshot.entries].sort((a, b) => comparePaths(a.path, b.path));
  let payload = `${snapshot.schema_version}\n`;
  for (const entry of sorted) {
    payload += `${entry.path}\0${entry.type}\0${entry.mode}\0${entry.blob_digest}\n`;
  }

  const computedDigest = sha256(payload);
  if (computedDigest !== snapshot.snapshot_digest) {
    return false;
  }

  if (cas) {
    for (const entry of snapshot.entries) {
      if (!cas.has(entry.blob_digest)) {
        return false;
      }
    }
  }

  return true;
}
