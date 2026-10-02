// lib/trusted-import/git-promoter.mjs
//
// Hard G Git Object Promotion (§7.3, §10.1).
// Assembles Git tree and commit objects strictly in repository object database
// without touching host working tree or index, and performs atomic CAS update-ref (TI-13).

import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AfrError, CANONICAL_REF, ZERO_OID } from './common.mjs';

/**
 * Write a complete Git tree object from a list of target entries using an isolated temporary index.
 *
 * @param {object} options
 * @param {string} options.repoDir - Path to Git repository
 * @param {Array<object>} options.targetEntries - Array of { path, mode, oid }
 * @returns {string} Git tree OID
 */
export function writeGitTree({ repoDir, targetEntries = [] }) {
  if (!repoDir) {
    throw new AfrError('repoDir is required to write git tree', 'INVALID_ARGUMENT');
  }

  const tmpIndexFile = join(repoDir, '.git', `afr_tmp_index_${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndexFile };

  try {
    // Format: <mode> <object> <stage>\t<path>\n
    let indexInput = '';
    for (const entry of targetEntries) {
      const mode = entry.mode || '100644';
      indexInput += `${mode} ${entry.oid} 0\t${entry.path}\n`;
    }

    if (indexInput.length > 0) {
      execFileSync('git', ['update-index', '--index-info'], {
        cwd: repoDir,
        env,
        input: Buffer.from(indexInput, 'utf8'),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    const treeOid = execFileSync('git', ['write-tree'], {
      cwd: repoDir,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return treeOid;
  } catch (err) {
    throw new AfrError(`Failed to write git tree: ${err.stderr || err.message}`, 'GIT_TREE_WRITE_FAILED');
  } finally {
    if (existsSync(tmpIndexFile)) {
      try {
        unlinkSync(tmpIndexFile);
      } catch {
        // ignore cleanup error
      }
    }
  }
}

/**
 * Create a Git commit object directly pointing to a tree object.
 *
 * @param {object} options
 * @param {string} options.repoDir - Path to Git repository
 * @param {string} options.treeOid - Tree OID
 * @param {string|null} [options.parentOid=null] - Parent commit OID
 * @param {string} [options.message='AFR Trusted Promotion']
 * @returns {string} Git commit OID
 */
export function createGitCommit({
  repoDir,
  treeOid,
  parentOid = null,
  message = 'AFR Trusted Promotion',
}) {
  if (!repoDir || !treeOid) {
    throw new AfrError('repoDir and treeOid are required to create commit', 'INVALID_ARGUMENT');
  }

  const args = ['commit-tree', treeOid];
  if (parentOid && parentOid !== ZERO_OID) {
    args.push('-p', parentOid);
  }
  args.push('-m', message);

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'AFR Trusted Importer',
    GIT_AUTHOR_EMAIL: 'importer@afr.local',
    GIT_COMMITTER_NAME: 'AFR Control Plane',
    GIT_COMMITTER_EMAIL: 'control-plane@afr.local',
  };

  try {
    const commitOid = execFileSync('git', args, {
      cwd: repoDir,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return commitOid;
  } catch (err) {
    throw new AfrError(`Failed to create git commit: ${err.stderr || err.message}`, 'GIT_COMMIT_CREATE_FAILED');
  }
}

/**
 * Atomically update refs/afr/canonical using CAS semantics (TI-13).
 *
 * @param {object} options
 * @param {string} options.repoDir - Path to Git repository
 * @param {string} options.newCommitOid - New canonical commit OID
 * @param {string} options.expectedOldOid - Expected current commit OID (CAS anchor)
 * @returns {object}
 */
export function promoteCanonicalRef({
  repoDir,
  newCommitOid,
  expectedOldOid,
}) {
  if (!repoDir || !newCommitOid || !expectedOldOid) {
    throw new AfrError('repoDir, newCommitOid, and expectedOldOid are required for CAS update-ref', 'INVALID_ARGUMENT');
  }

  try {
    execFileSync('git', ['update-ref', CANONICAL_REF, newCommitOid, expectedOldOid], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return Object.freeze({
      status: 'PROMOTED',
      canonical_ref: CANONICAL_REF,
      canonical_oid: newCommitOid,
      previous_oid: expectedOldOid,
      promoted_at: new Date().toISOString(),
    });
  } catch (err) {
    throw new AfrError(
      `CAS update-ref failed: expected old OID "${expectedOldOid}" did not match current canonical state: ${err.stderr || err.message}`,
      'CAS_UPDATE_REF_FAILED',
      { newCommitOid, expectedOldOid }
    );
  }
}
