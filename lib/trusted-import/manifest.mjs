// lib/trusted-import/manifest.mjs
//
// Candidate Manifest (Executor Delta) Computation (§3, §7.2).
// Measures exact physical change between Projected Baseline Snapshot and
// Candidate Revision Snapshot.
// FS observation is truth source (TI-17: .gitignore is bypassed).
// Unprojected excluded files do NOT generate DELETE (P0, §7.5.2).

import { sha256, AfrError } from './common.mjs';

function comparePaths(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return Buffer.compare(bufA, bufB);
}

/**
 * Compute the stable identity of a change set.
 *
 * The digest binds every field consumed by the target tree builder: action,
 * path, source/target blob identity, and source/target mode. Keeping this in
 * one exported helper lets the authorization closure and the promotion
 * boundary prove that they refer to the same patch.
 *
 * @param {Array<object>} changes
 * @returns {string}
 */
export function computeManifestDigest(changes) {
  if (!Array.isArray(changes)) {
    throw new AfrError('changes must be an array', 'INVALID_ARGUMENT');
  }

  const canonicalString = [...changes]
    .sort((a, b) => comparePaths(String(a.path), String(b.path)) || String(a.action).localeCompare(String(b.action)))
    .map((c) => `${c.action}:${c.path}:${c.old_digest || ''}:${c.new_digest || c.digest || ''}:${c.old_mode || ''}:${c.new_mode || ''}`)
    .join('\n');

  return sha256(canonicalString);
}

/**
 * Compute the deterministic Candidate Manifest (Executor Delta).
 *
 * @param {object} options
 * @param {object|null} options.projectedBaselineSnapshot - Baseline snapshot
 * @param {object} options.candidateSnapshot - Candidate revision snapshot
 * @returns {object} Candidate Manifest (frozen)
 */
export function computeManifest({
  projectedBaselineSnapshot = null,
  candidateSnapshot,
}) {
  if (!candidateSnapshot || !Array.isArray(candidateSnapshot.entries)) {
    throw new AfrError('Valid candidateSnapshot is required to compute manifest', 'INVALID_ARGUMENT');
  }

  const baseEntries = projectedBaselineSnapshot?.entries || [];
  const candEntries = candidateSnapshot.entries;

  const baseMap = new Map();
  for (const e of baseEntries) {
    baseMap.set(e.path, e);
  }

  const candMap = new Map();
  for (const e of candEntries) {
    candMap.set(e.path, e);
  }

  const changes = [];

  // Check additions, modifications and mode changes
  for (const [path, cand] of candMap.entries()) {
    if (!baseMap.has(path)) {
      changes.push({
        action: 'ADD',
        path,
        type: cand.type,
        new_digest: cand.blob_digest,
        new_mode: cand.mode,
        size: cand.size,
      });
    } else {
      const base = baseMap.get(path);
      if (cand.blob_digest !== base.blob_digest) {
        changes.push({
          action: 'MODIFY',
          path,
          type: cand.type,
          old_digest: base.blob_digest,
          new_digest: cand.blob_digest,
          old_mode: base.mode,
          new_mode: cand.mode,
          size: cand.size,
        });
      } else if (cand.mode !== base.mode) {
        changes.push({
          action: 'MODE',
          path,
          type: cand.type,
          digest: cand.blob_digest,
          old_mode: base.mode,
          new_mode: cand.mode,
          size: cand.size,
        });
      }
    }
  }

  // Check deletions (only for paths that WERE projected in baseline)
  for (const [path, base] of baseMap.entries()) {
    if (!candMap.has(path)) {
      changes.push({
        action: 'DELETE',
        path,
        type: base.type,
        old_digest: base.blob_digest,
        old_mode: base.mode,
        size: base.size,
      });
    }
  }

  // Deterministic byte-wise sorting of changes by path
  changes.sort((a, b) => comparePaths(a.path, b.path));

  // Compute canonical digest of manifest
  const manifestDigest = computeManifestDigest(changes);

  let adds = 0;
  let modifies = 0;
  let deletes = 0;
  let modes = 0;
  for (const c of changes) {
    if (c.action === 'ADD') adds += 1;
    else if (c.action === 'MODIFY') modifies += 1;
    else if (c.action === 'DELETE') deletes += 1;
    else if (c.action === 'MODE') modes += 1;
  }

  return Object.freeze({
    baseline_snapshot_digest: projectedBaselineSnapshot?.snapshot_digest ?? null,
    candidate_snapshot_digest: candidateSnapshot.snapshot_digest,
    manifest_digest: manifestDigest,
    changes: Object.freeze(changes.map((c) => Object.freeze({ ...c }))),
    summary: Object.freeze({
      totalChanges: changes.length,
      add: adds,
      modify: modifies,
      delete: deletes,
      mode: modes,
    }),
    generated_at: new Date().toISOString(),
  });
}
