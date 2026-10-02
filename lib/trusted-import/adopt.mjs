// lib/trusted-import/adopt.mjs
//
// Canonical Bootstrap & Admission Scan (§7.5.6, A4).
// Resolves commit-ish to an immutable Commit OID, validates canonical filesystem
// and path contracts (A5, A6), and atomically initializes `refs/afr/canonical`.

import {
  CANONICAL_REF,
  ZERO_OID,
  AdmissionError,
  validateRawPath,
  checkNormalizationCollisions,
} from './common.mjs';
import { runGit, isGitRepo } from '../worktree.mjs';

/**
 * Check whether the canonical ref already exists in the repository.
 * @param {string} repoDir
 * @returns {string|null} existing commit OID or null
 */
export function getCanonicalOid(repoDir) {
  try {
    const oid = runGit(['rev-parse', '--verify', CANONICAL_REF], repoDir);
    return oid.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Adopt an existing Git repository into AFR canonical control (§7.5.6).
 *
 * @param {object} options
 * @param {string} options.repoDir - Path to Git repository
 * @param {string} [options.fromCommitIsh='HEAD'] - Branch or commit to adopt
 * @param {boolean} [options.force=false] - If true, bypass ADOPTION_ALREADY_EXISTS
 * @returns {object} Adoption result record
 */
export function adoptRepository({
  repoDir,
  fromCommitIsh = 'HEAD',
  force = false,
}) {
  if (!repoDir) {
    throw new AdmissionError('repoDir is required', 'CONFIG_ERROR');
  }

  // 1. Non-git workspaces are rejected fail-closed at admission (§10.1)
  if (!isGitRepo(repoDir)) {
    throw new AdmissionError(
      `Directory is not a valid git repository: ${repoDir}`,
      'TASK_ADMISSION_FAIL'
    );
  }

  // 2. Resolve commit-ish to full 40-character SHA-1/SHA-256 Commit OID
  let commitOid;
  try {
    commitOid = runGit(['rev-parse', '--verify', `${fromCommitIsh}^{commit}`], repoDir);
  } catch (err) {
    throw new AdmissionError(
      `Failed to resolve commit-ish "${fromCommitIsh}": ${err.stderr || err.message}`,
      'INVALID_COMMIT_ISH',
      { fromCommitIsh }
    );
  }

  // 3. Canonical Admission Scan: verify entire tree against A5/A6
  const lsTreeOutput = runGit(['ls-tree', '-r', '-z', commitOid], repoDir);
  const rawEntries = lsTreeOutput ? lsTreeOutput.split('\0').filter(Boolean) : [];

  const paths = [];
  for (const line of rawEntries) {
    // Format: <mode> <type> <object>\t<file>
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;

    const meta = line.slice(0, tabIdx);
    const path = line.slice(tabIdx + 1);
    const [mode, type, oid] = meta.split(' ');

    // Only regular blobs are allowed (A5 / Unsupported entries rejected)
    if (type !== 'blob') {
      throw new AdmissionError(
        `Canonical Admission Scan rejected non-blob object (${type}) at "${path}"`,
        'ADMISSION_FORBIDDEN_ENTRY',
        { path, type, oid }
      );
    }

    // Reject symlinks (120000) or submodules (160000)
    if (mode === '120000' || mode === '160000') {
      throw new AdmissionError(
        `Canonical Admission Scan rejected unsupported mode (${mode}) at "${path}"`,
        'ADMISSION_FORBIDDEN_ENTRY',
        { path, mode, oid }
      );
    }

    // A6 Raw Path Contract check
    try {
      validateRawPath(path);
    } catch (err) {
      throw new AdmissionError(
        `Canonical Admission Scan rejected invalid path "${path}": ${err.message}`,
        'ADMISSION_FORBIDDEN_PATH',
        { path, error: err.message }
      );
    }

    paths.push(path);
  }

  // A6 Normalization Collision Check across all tree paths
  try {
    checkNormalizationCollisions(paths);
  } catch (err) {
    throw new AdmissionError(
      `Canonical Admission Scan rejected tree due to normalization collision: ${err.message}`,
      'ADMISSION_COLLISION_DETECTED',
      { details: err.details }
    );
  }

  // 4. Check if ref already exists
  const existingOid = getCanonicalOid(repoDir);
  if (existingOid && !force) {
    throw new AdmissionError(
      `Canonical ref already exists: ${CANONICAL_REF} points to ${existingOid}`,
      'ADOPTION_ALREADY_EXISTS',
      { canonicalRef: CANONICAL_REF, existingOid }
    );
  }

  // 5. CAS Atomic update-ref with zero-OID constraint (or overwrite if forced)
  const oldOid = force && existingOid ? existingOid : ZERO_OID;
  try {
    runGit(['update-ref', CANONICAL_REF, commitOid, oldOid], repoDir);
  } catch (err) {
    throw new AdmissionError(
      `Failed to update canonical ref ${CANONICAL_REF}: ${err.stderr || err.message}`,
      'UPDATE_REF_FAILED',
      { commitOid, oldOid }
    );
  }

  return Object.freeze({
    status: 'ADOPTED',
    canonical_ref: CANONICAL_REF,
    canonical_oid: commitOid,
    total_entries: paths.length,
    adopted_at: new Date().toISOString(),
  });
}
