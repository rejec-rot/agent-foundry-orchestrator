// lib/trusted-import/target-tree.mjs
//
// Target Canonical Tree Construction (§10.1, P0 补丁, 1.6).
// Enforces the Target Canonical Tree formula:
// TARGET_CANONICAL_TREE = BASELINE_CANONICAL_TREE + AUTHORIZED CUMULATIVE PATCH
//
// Guarantees:
// - Candidate-visible modified/added entries are ingested into Git and applied.
// - Deleted entries are removed.
// - Excluded / unexposed entries (e.g. .env, secrets/**) are preserved verbatim (TI-25).
// - Unaffected baseline entries are preserved verbatim.

import { AfrError, validateRawPath } from './common.mjs';

function comparePaths(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return Buffer.compare(bufA, bufB);
}

/**
 * Construct the Target Canonical Tree entries according to the canonical formula (§10.1).
 *
 * @param {object} options
 * @param {Array<object>} options.baselineCanonicalEntries - Full entries of baseline canonical commit
 * @param {Array<object>} options.authorizedChanges - Changes approved by Mechanical Gate / Ledger
 * @param {import('./cas.mjs').TrustedCAS} options.cas - CAS store containing candidate raw blobs
 * @param {string} options.repoDir - Path to Git repository
 * @returns {{ targetEntries: Array<object> }}
 */
export function buildTargetCanonicalTree({
  baselineCanonicalEntries = [],
  authorizedChanges = [],
  cas,
  repoDir,
}) {
  if (!cas || !repoDir) {
    throw new AfrError('cas and repoDir are required to build target tree', 'INVALID_ARGUMENT');
  }

  // 1. Ingest baseline canonical entries into working map
  const targetMap = new Map();
  for (const entry of baselineCanonicalEntries) {
    if (entry.path) {
      validateRawPath(entry.path);
      targetMap.set(entry.path, {
        path: entry.path,
        mode: entry.mode || '100644',
        type: 'blob',
        oid: entry.oid,
        blob_digest: entry.blob_digest || null,
      });
    }
  }

  // 2. Apply authorized cumulative patch
  for (const change of authorizedChanges) {
    const path = change.path;
    validateRawPath(path);

    if (!['ADD', 'MODIFY', 'DELETE', 'MODE'].includes(change.action)) {
      throw new AfrError(`Unsupported patch action for "${path}": ${change.action}`, 'CORRUPT_PATCH');
    }

    if (change.action === 'DELETE') {
      targetMap.delete(path);
      continue;
    }

    if (change.action === 'ADD' || change.action === 'MODIFY') {
      const digest = change.new_digest;
      if (!digest) {
        throw new AfrError(`Missing new_digest for change on "${path}"`, 'CORRUPT_PATCH');
      }
      if (change.new_mode !== '0644' && change.new_mode !== '0755') {
        throw new AfrError(`Invalid new_mode for change on "${path}"`, 'CORRUPT_PATCH');
      }

      // Fetch raw bytes from CAS
      const rawBytes = cas.get(digest);

      // Ingest raw bytes into Git Object Store (bypass attributes/filters)
      const gitBlobOid = cas.putGitBlob(rawBytes, repoDir);

      const mode = change.new_mode === '0755' ? '100755' : '100644';
      targetMap.set(path, {
        path,
        mode,
        type: 'blob',
        oid: gitBlobOid,
        blob_digest: digest,
      });
      continue;
    }

    if (change.action === 'MODE') {
      const existing = targetMap.get(path);
      if (!existing) {
        throw new AfrError(`Cannot apply MODE change to non-existent path "${path}"`, 'CORRUPT_PATCH');
      }
      if (change.new_mode !== '0644' && change.new_mode !== '0755') {
        throw new AfrError(`Invalid new_mode for change on "${path}"`, 'CORRUPT_PATCH');
      }
      const mode = change.new_mode === '0755' ? '100755' : '100644';
      targetMap.set(path, {
        ...existing,
        mode,
      });
      continue;
    }
  }

  // 3. Sort target tree entries deterministically by raw path byte order (A6)
  const sortedEntries = Array.from(targetMap.values()).sort((a, b) => comparePaths(a.path, b.path));

  return Object.freeze({
    targetEntries: Object.freeze(sortedEntries.map((e) => Object.freeze({ ...e }))),
  });
}
