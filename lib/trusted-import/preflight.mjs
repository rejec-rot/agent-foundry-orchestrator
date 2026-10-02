// lib/trusted-import/preflight.mjs
//
// Target Namespace Preflight (§5.3, §10.1, 1.6).
// Mechanically validates synthesized Target Canonical Namespace
// (Baseline Canonical Namespace + Candidate Structural Patch) prior to Scope Verifier.
// Fail-closed as Gate B(i) on file/directory prefix collisions, hidden subtree conflicts,
// and cross-set Unicode normalization ambiguity (TI-29, E5).

import { HardDenyError, checkNormalizationCollisions, validateRawPath } from './common.mjs';

/**
 * Execute Target Namespace Preflight.
 *
 * @param {object} options
 * @param {Array<object>} options.baselineCanonicalEntries - Full baseline canonical tree (including hidden/excluded files)
 * @param {Array<object>} options.candidateChanges - Candidate manifest changes (ADD, MODIFY, DELETE, MODE)
 * @returns {{ passed: boolean, targetPaths: string[] }}
 */
export function targetNamespacePreflight({
  baselineCanonicalEntries = [],
  candidateChanges = [],
}) {
  const targetMap = new Map();

  // 1. Ingest all baseline canonical entries (visible and hidden)
  for (const entry of baselineCanonicalEntries) {
    if (entry.path) {
      validateRawPath(entry.path);
      targetMap.set(entry.path, entry);
    }
  }

  // 2. Apply Candidate Structural Patch
  for (const change of candidateChanges) {
    validateRawPath(change.path);
    if (change.action === 'DELETE') {
      targetMap.delete(change.path);
    } else if (change.action === 'ADD' || change.action === 'MODIFY' || change.action === 'MODE') {
      targetMap.set(change.path, change);
    }
  }

  const targetPaths = Array.from(targetMap.keys());

  // 3. File / Directory Prefix Collision Check (E5 & Hidden Subtree Collision)
  // For each file path 'a/b/c.txt', none of its parent prefixes ('a', 'a/b') may exist as a file in targetMap
  for (const filePath of targetPaths) {
    const parts = filePath.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      if (targetMap.has(prefix)) {
        throw new HardDenyError(
          `Target Namespace Preflight collision: directory prefix "${prefix}" collides with an existing file (parent of "${filePath}")`,
          {
            code: 'TARGET_NAMESPACE_PREFIX_CONFLICT',
            file: prefix,
            collidingSubpath: filePath,
          }
        );
      }
    }
  }

  // 4. A6 Cross-set Unicode Normalization Collision Check (TI-29)
  // Ensures no Baseline hidden NFD path collides with Candidate NFC path (or vice versa)
  checkNormalizationCollisions(targetPaths);

  return {
    passed: true,
    targetPaths: targetPaths.sort(),
  };
}
