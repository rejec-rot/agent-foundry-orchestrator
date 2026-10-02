// lib/trusted-import/rebase.mjs
//
// Stale Baseline Rebase Engine (§10.3, TI-21).
// When concurrent tasks advance `refs/afr/canonical`, does NOT discard Candidate Delta.
// Replays non-conflicting candidate changes onto the updated canonical baseline,
// and detects true semantic collisions fail-closed with REBASE_CONFLICT.

import { execFileSync } from 'node:child_process';
import { AfrError, sha256 } from './common.mjs';
import { sealSnapshot } from './snapshot.mjs';

function readTreeEntries(repoDir, commitOid) {
  const output = execFileSync('git', ['ls-tree', '-r', '-z', commitOid], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const entries = new Map();
  const raw = output ? output.split('\0').filter(Boolean) : [];
  for (const line of raw) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = line.slice(0, tabIdx);
    const path = line.slice(tabIdx + 1);
    const [modeStr, type, oid] = meta.split(' ');
    if (type === 'blob') {
      entries.set(path, { path, mode: modeStr, oid });
    }
  }
  return entries;
}

/**
 * Rebase a candidate manifest delta from a stale baseline onto the new canonical baseline (TI-21).
 *
 * @param {object} options
 * @param {string} options.repoDir - Path to Git repository
 * @param {string} options.staleBaselineOid - The baseline commit OID the candidate branched from
 * @param {string} options.currentCanonicalOid - The newly advanced canonical commit OID
 * @param {object} options.candidateManifest - The candidate manifest changes
 * @param {import('./cas.mjs').TrustedCAS} options.cas - CAS containing candidate blobs
 * @returns {object} Rebase outcome
 */
export function rebaseCandidateDelta({
  repoDir,
  staleBaselineOid,
  currentCanonicalOid,
  candidateManifest,
  cas,
}) {
  if (!repoDir || !staleBaselineOid || !currentCanonicalOid || !candidateManifest || !cas) {
    throw new AfrError('Missing required parameters for rebase', 'INVALID_ARGUMENT');
  }

  // 1. If baseline hasn't changed, rebase is a trivial no-op
  if (staleBaselineOid === currentCanonicalOid) {
    return {
      status: 'NO_OP',
      rebased: false,
      newBaselineOid: currentCanonicalOid,
    };
  }

  // 2. Read entries from stale baseline and current canonical
  const staleTree = readTreeEntries(repoDir, staleBaselineOid);
  const currentTree = readTreeEntries(repoDir, currentCanonicalOid);

  // 3. Detect concurrent modifications between staleBaseline and currentCanonical
  const concurrentModifiedPaths = new Set();
  for (const [path, curEntry] of currentTree.entries()) {
    const staleEntry = staleTree.get(path);
    if (!staleEntry || staleEntry.oid !== curEntry.oid) {
      concurrentModifiedPaths.add(path);
    }
  }
  for (const path of staleTree.keys()) {
    if (!currentTree.has(path)) {
      concurrentModifiedPaths.add(path); // deleted concurrently
    }
  }

  // 4. Check three-way collision against candidate changes
  const candidateChangedPaths = new Set(candidateManifest.changes.map((c) => c.path));

  for (const path of candidateChangedPaths) {
    if (concurrentModifiedPaths.has(path)) {
      throw new AfrError(
        `Rebase conflict: path "${path}" was concurrently modified in new canonical baseline`,
        'REBASE_CONFLICT',
        { path, staleBaselineOid, currentCanonicalOid }
      );
    }
  }

  // 5. Apply clean candidate delta onto currentTree
  const rebasedTarget = new Map(currentTree);
  const rebasedSnapshotEntries = [];

  for (const change of candidateManifest.changes) {
    if (change.action === 'DELETE') {
      rebasedTarget.delete(change.path);
    } else if (change.action === 'ADD' || change.action === 'MODIFY') {
      const digest = change.new_digest;
      const normalizedMode = change.new_mode || '0644';
      rebasedTarget.set(change.path, {
        path: change.path,
        mode: normalizedMode === '0755' ? '100755' : '100644',
        blob_digest: digest,
      });
    } else if (change.action === 'MODE') {
      const cur = rebasedTarget.get(change.path);
      if (cur) {
        rebasedTarget.set(change.path, {
          ...cur,
          mode: change.new_mode === '0755' ? '100755' : '100644',
        });
      }
    }
  }

  // Convert to Candidate Revision Snapshot entries
  for (const [path, entry] of rebasedTarget.entries()) {
    let digest = entry.blob_digest;
    if (!digest && entry.oid) {
      // Calculate blob digest from git
      const rawBytes = execFileSync('git', ['cat-file', 'blob', entry.oid], {
        cwd: repoDir,
        encoding: null,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      digest = sha256(rawBytes);
      cas.put(rawBytes);
    }

    const isExec = (parseInt(entry.mode, 8) & 0o111) !== 0;
    rebasedSnapshotEntries.push({
      path,
      type: 'blob',
      mode: isExec ? '0755' : '0644',
      blob_digest: digest,
    });
  }

  const rebasedSnapshot = sealSnapshot({
    entries: rebasedSnapshotEntries,
    metadata: {
      rebased_from: staleBaselineOid,
      rebased_onto: currentCanonicalOid,
    },
  });

  return Object.freeze({
    status: 'REBASED',
    rebased: true,
    previous_baseline_oid: staleBaselineOid,
    new_baseline_oid: currentCanonicalOid,
    rebased_snapshot: rebasedSnapshot,
    rebased_entries_count: rebasedSnapshotEntries.length,
    rebased_at: new Date().toISOString(),
  });
}
