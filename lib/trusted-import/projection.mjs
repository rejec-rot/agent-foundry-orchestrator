// lib/trusted-import/projection.mjs
//
// Candidate Projection & Materialization (§7.5).
// Materializes a candidate workspace strictly from `refs/afr/canonical^{tree}` (C7).
// Enforces Secret Boundary by excluding sensitive paths (C2, C6),
// sets up isolated Source and Scratch namespaces (1.1),
// and computes the authoritative Projected Baseline Snapshot.

import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AfrError,
  normalizeMode,
  sha256,
  CANONICAL_REF,
  validateRawPath,
} from './common.mjs';
import { sealSnapshot } from './snapshot.mjs';
import { runGit } from '../worktree.mjs';

/**
 * Match a relative path against a glob pattern.
 * Supports exact match, `*` (segment wildcard), `**` (recursive wildcard).
 *
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
export function matchPathPattern(pattern, path) {
  if (pattern === path) return true;

  // `dir/**` includes the directory itself and every descendant. `**/name`
  // also includes a root-level `name`, not only names below a slash.
  const trailingRecursive = pattern.endsWith('/**');
  const body = trailingRecursive ? pattern.slice(0, -3) : pattern;
  let regex = '^';

  for (let i = 0; i < body.length;) {
    const ch = body[i];
    if (ch === '*') {
      if (body[i + 1] === '*') {
        if (body[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        regex += '[^/]*';
        i += 1;
      }
      continue;
    }

    regex += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    i += 1;
  }

  if (trailingRecursive) regex += '(?:/.*)?';
  return new RegExp(regex + '$').test(path);
}

/**
 * Check if a path is excluded by projection policy (§7.5.2).
 * @param {string} path
 * @param {string[]} [excludePatterns]
 * @returns {boolean}
 */
export function isPathExcluded(path, excludePatterns = []) {
  if (!Array.isArray(excludePatterns)) return false;
  return excludePatterns.some((pattern) => matchPathPattern(pattern, path));
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function projectionPathError(message, details = {}) {
  return new AfrError(message, 'PROJECTION_PATH_UNSAFE', details);
}

function assertNoSymlinkAncestors(path) {
  let current = resolve(path);
  while (true) {
    const stat = lstatOrNull(current);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw projectionPathError(`Unsafe projection path component: "${current}"`, { path: current });
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function writeProjectedFile(root, path, content, mode) {
  validateRawPath(path);
  const filePath = join(root, path);
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true });
  assertNoSymlinkAncestors(root);
  assertNoSymlinkAncestors(parentDir);

  const existing = lstatOrNull(filePath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw projectionPathError(`Unsafe projection target: "${path}"`, { path });
  }

  const tempFile = join(parentDir, `.afr-projection-${randomUUID()}`);
  try {
    writeFileSync(tempFile, content, { flag: 'wx', mode: 0o600 });
    chmodSync(tempFile, mode);
    renameSync(tempFile, filePath);
  } catch (err) {
    try {
      rmSync(tempFile, { force: true });
    } catch {
      // Preserve the original failure.
    }
    throw new AfrError(`Failed to materialize projected file "${path}": ${err.message}`, 'PROJECTION_WRITE_FAILED', {
      path,
    });
  }
}

function ensureSyntheticDirectory(root, path) {
  validateRawPath(path);
  const directory = join(root, path);
  mkdirSync(directory, { recursive: true });
  assertNoSymlinkAncestors(root);
  const stat = lstatOrNull(directory);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw projectionPathError(`Unsafe synthetic projection directory: "${path}"`, { path });
  }
  chmodSync(directory, 0o755);
}

/**
 * Materialize candidate workspace and compute Projected Baseline Snapshot.
 *
 * @param {object} options
 * @param {string} options.repoDir - Path to Git repository
 * @param {string} [options.canonicalOid] - Target canonical commit OID
 * @param {string} options.targetDir - Destination candidate directory (untrusted writer root)
 * @param {string} [options.scratchDir] - Optional dedicated runtime scratch directory
 * @param {object} [options.policy] - Projection policy { exclude: [], synthetic_dirs: [] }
 * @param {import('./cas.mjs').TrustedCAS} [options.cas] - CAS to ingest baseline blobs
 * @returns {object} { targetDir, scratchDir, canonicalOid, projectedBaselineSnapshot }
 */
export function projectCandidate({
  repoDir,
  canonicalOid = null,
  targetDir,
  scratchDir = null,
  policy = {},
  cas = null,
}) {
  if (!repoDir || !targetDir) {
    throw new AfrError('repoDir and targetDir are required', 'CONFIG_ERROR');
  }

  // 1. Resolve canonical OID from refs/afr/canonical if not explicitly provided
  let commitOid = canonicalOid;
  if (!commitOid) {
    try {
      commitOid = runGit(['rev-parse', '--verify', `${CANONICAL_REF}^{commit}`], repoDir);
    } catch {
      throw new AfrError(`Cannot find canonical ref: ${CANONICAL_REF}`, 'CANONICAL_REF_NOT_FOUND');
    }
  }

  const resolvedTarget = resolve(targetDir);
  mkdirSync(resolvedTarget, { recursive: true });
  assertNoSymlinkAncestors(resolvedTarget);

  const resolvedScratch = scratchDir ? resolve(scratchDir) : null;
  if (resolvedScratch) {
    mkdirSync(resolvedScratch, { recursive: true });
  }

  const excludePatterns = policy?.exclude || [];
  const syntheticDirs = policy?.synthetic_dirs || [];

  // 2. Read canonical tree entries directly from Git object store
  const lsTreeOutput = runGit(['ls-tree', '-r', '-z', commitOid], repoDir);
  const rawEntries = lsTreeOutput ? lsTreeOutput.split('\0').filter(Boolean) : [];

  const baselineEntries = [];

  for (const line of rawEntries) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;

    const meta = line.slice(0, tabIdx);
    const path = line.slice(tabIdx + 1);
    const [modeStr, type, oid] = meta.split(' ');

    if (type !== 'blob') continue;

    // Check exclusion (Secret Boundary - C2, C6)
    if (isPathExcluded(path, excludePatterns)) {
      continue;
    }

    // Extract exact raw byte blob from Git
    const content = execFileSync('git', ['cat-file', 'blob', oid], {
      cwd: repoDir,
      encoding: null, // returns raw Buffer
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const fileDigest = sha256(content);
    if (cas) {
      cas.put(content);
    }

    // Write to candidate target directory
    // Normalize and apply mode
    const isExec = (parseInt(modeStr, 8) & 0o111) !== 0;
    const normalizedMode = isExec ? '0755' : '0644';
    writeProjectedFile(resolvedTarget, path, content, isExec ? 0o755 : 0o644);

    baselineEntries.push({
      path,
      type: 'blob',
      mode: normalizedMode,
      blob_digest: fileDigest,
      size: content.length,
    });
  }

  // 3. Create synthetic empty directories (§7.5.5, A3)
  for (const synDir of syntheticDirs) {
    ensureSyntheticDirectory(resolvedTarget, synDir);
  }

  // 4. Ensure no .git exists in candidate (TI-15: candidate never shares canonical .git)
  if (existsSync(join(resolvedTarget, '.git'))) {
    throw new AfrError('Invariant violation: .git detected in candidate workspace', 'LEAKED_GIT_DIR');
  }

  // 5. Seal the Projected Baseline Snapshot
  const projectedBaselineSnapshot = sealSnapshot({
    entries: baselineEntries,
    metadata: {
      canonical_oid: commitOid,
      policy_exclude: excludePatterns,
    },
  });

  return Object.freeze({
    targetDir: resolvedTarget,
    scratchDir: resolvedScratch,
    canonicalOid: commitOid,
    projectedBaselineSnapshot,
  });
}
