// lib/trusted-import/materializer.mjs
//
// Trusted Worktree Materializer (§10.2).
// Safely materializes host working tree cache strictly from canonical Git objects:
// - Allocates fresh inodes for every file (TI-12)
// - Sanitizes mode (0644 / 0755), strips uid/gid/ACL/xattr/capabilities
// - Bypasses .gitattributes / smudge filters (raw byte fidelity)
// - Executes post-materialize cryptographic hash check (TI-14)

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AfrError, sha256, validateRawPath } from './common.mjs';

function materializeVerifyError(message, details = {}) {
  return new AfrError(message, 'MATERIALIZE_VERIFY_FAILED', details);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Reject symlinked or non-directory parent components before a path is read or
 * written. lstat() on the leaf is not sufficient: a symlink in `dir/` would
 * make `dir/file` resolve outside the materialization root.
 */
function assertSafeParentChain(root, relativePath) {
  let current = root;
  const parentParts = relativePath.split('/').slice(0, -1);
  for (const part of parentParts) {
    current = join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw materializeVerifyError(`Symlinked materialization directory is forbidden: "${relative(root, current)}"`, {
        path: relative(root, current).replace(/\\/g, '/'),
      });
    }
    if (!stat.isDirectory()) {
      throw materializeVerifyError(`Materialization parent is not a directory: "${relative(root, current)}"`, {
        path: relative(root, current).replace(/\\/g, '/'),
      });
    }
  }
}

function assertNoSymlinkAncestors(path) {
  const resolvedPath = resolve(path);
  let current = resolvedPath;
  while (true) {
    const stat = lstatOrNull(current);
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw materializeVerifyError(`Symlink in materialization path is forbidden: "${current}"`, {
          path: current,
        });
      }
      if (!stat.isDirectory()) {
        throw materializeVerifyError(`Materialization path component is not a directory: "${current}"`, {
          path: current,
        });
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function ensureSafeDestination(destination) {
  assertNoSymlinkAncestors(destination);
  const existing = lstatOrNull(destination);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw materializeVerifyError('Materialization destination cannot be a symlink', {
        path: destination,
      });
    }
    if (!existing.isDirectory()) {
      throw materializeVerifyError('Materialization destination must be a directory', {
        path: destination,
      });
    }
    return;
  }

  // Walk to the nearest existing ancestor before mkdir -p so an existing
  // symlink cannot redirect creation outside the requested destination.
  let ancestor = destination;
  while (!lstatOrNull(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const ancestorStat = lstatOrNull(ancestor);
  if (ancestorStat?.isSymbolicLink() || (ancestorStat && !ancestorStat.isDirectory())) {
    throw materializeVerifyError('Materialization destination has an unsafe parent', {
      path: ancestor,
    });
  }
  mkdirSync(destination, { recursive: true });
  const created = lstatOrNull(destination);
  if (!created || created.isSymbolicLink() || !created.isDirectory()) {
    throw materializeVerifyError('Materialization destination could not be safely created', {
      path: destination,
    });
  }
}

/**
 * Verify an already materialized directory without rewriting it.
 * This is the post-promotion integrity check that callers can repeat later.
 */
export function verifyMaterializedWorktree({
  repoDir,
  canonicalOid,
  destinationDir,
  allowExtra = false,
}) {
  if (!repoDir || !canonicalOid || !destinationDir) {
    throw new AfrError('repoDir, canonicalOid, and destinationDir are required', 'INVALID_ARGUMENT');
  }

  const destination = resolve(destinationDir);
  ensureSafeDestination(destination);
  const lsTreeOutput = execFileSync('git', ['ls-tree', '-r', '-z', canonicalOid], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const expected = new Map();

  for (const line of (lsTreeOutput || '').split('\0').filter(Boolean)) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const [mode, type, oid] = line.slice(0, tabIdx).split(' ');
    const path = line.slice(tabIdx + 1);
    if (type !== 'blob') continue;
    validateRawPath(path);
    assertSafeParentChain(destination, path);
    const rawBytes = execFileSync('git', ['cat-file', 'blob', oid], {
      cwd: repoDir,
      encoding: null,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expected.set(path, {
      digest: sha256(rawBytes),
      executable: (parseInt(mode, 8) & 0o111) !== 0,
    });
  }

  for (const [path, expectedEntry] of expected) {
    const filePath = join(destination, path);
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch {
      throw materializeVerifyError(`Materialized file is missing: "${path}"`, { path });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw materializeVerifyError(`Materialized path is not a regular file: "${path}"`, { path });
    }
    const actualDigest = sha256(readFileSync(filePath));
    if (actualDigest !== expectedEntry.digest) {
      throw materializeVerifyError(`Materialized file hash mismatch: "${path}"`, {
        path,
        expectedDigest: expectedEntry.digest,
        actualDigest,
      });
    }
    const expectedMode = expectedEntry.executable ? 0o755 : 0o644;
    if ((stat.mode & 0o777) !== expectedMode) {
      throw materializeVerifyError(`Materialized file mode mismatch: "${path}"`, {
        path,
        expectedMode,
        actualMode: stat.mode & 0o777,
      });
    }
  }

  if (!allowExtra && existsSync(destination)) {
    const scan = (dir) => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.name === '.git' && dir === destination) continue;
        const fullPath = join(dir, item.name);
        const relativePath = relative(destination, fullPath).replace(/\\/g, '/');
        const itemStat = lstatSync(fullPath);
        if (itemStat.isSymbolicLink()) {
          throw materializeVerifyError(`Symlink in materialized worktree is forbidden: "${relativePath}"`, {
            path: relativePath,
          });
        }
        if (itemStat.isDirectory()) {
          scan(fullPath);
        } else if (itemStat.isFile() && !expected.has(relativePath)) {
          throw materializeVerifyError(`Unexpected materialized path: "${relativePath}"`, {
            path: relativePath,
          });
        } else if (!itemStat.isFile()) {
          throw materializeVerifyError(`Unsupported materialized inode: "${relativePath}"`, {
            path: relativePath,
          });
        }
      }
    };
    scan(destination);
  }

  return Object.freeze({
    verified: true,
    canonical_oid: canonicalOid,
    destination,
    verified_count: expected.size,
    verified_at: new Date().toISOString(),
  });
}

/**
 * Materialize working tree cache from canonical Git tree and verify hash integrity.
 *
 * @param {object} options
 * @param {string} options.repoDir - Path to repository
 * @param {string} options.canonicalOid - Accepted canonical Commit OID
 * @param {string} options.destinationDir - Host workspace directory to update
 * @param {boolean} [options.cleanExisting=true] - Remove untracked / obsolete files
 * @param {boolean} [options.verifyHash=true] - Execute post-materialize hash verification (TI-14)
 * @returns {object} Materialization summary
 */
export function materializeWorktree({
  repoDir,
  canonicalOid,
  destinationDir,
  cleanExisting = true,
  verifyHash = true,
}) {
  if (!repoDir || !canonicalOid || !destinationDir) {
    throw new AfrError('repoDir, canonicalOid, and destinationDir are required', 'INVALID_ARGUMENT');
  }

  const destResolved = resolve(destinationDir);
  ensureSafeDestination(destResolved);

  // 1. Read all entries from canonical tree
  const lsTreeOutput = execFileSync('git', ['ls-tree', '-r', '-z', canonicalOid], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rawEntries = lsTreeOutput ? lsTreeOutput.split('\0').filter(Boolean) : [];
  const expectedPaths = new Set();
  const materializedBlobs = [];

  for (const line of rawEntries) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;

    const meta = line.slice(0, tabIdx);
    const path = line.slice(tabIdx + 1);
    const [modeStr, type, oid] = meta.split(' ');

    if (type !== 'blob') continue;
    validateRawPath(path);

    expectedPaths.add(path);

    // Read raw blob bytes directly from git object store (no filters / smudge)
    const rawBytes = execFileSync('git', ['cat-file', 'blob', oid], {
      cwd: repoDir,
      encoding: null, // returns raw Buffer
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const expectedDigest = sha256(rawBytes);
    const filePath = join(destResolved, path);
    assertSafeParentChain(destResolved, path);
    mkdirSync(dirname(filePath), { recursive: true });
    assertSafeParentChain(destResolved, path);

    // Write file with new inode (TI-12: fresh inode, clean permissions)
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
      } catch {
        // overwrite if unlink fails
      }
    }
    writeFileSync(filePath, rawBytes);

    const isExec = (parseInt(modeStr, 8) & 0o111) !== 0;
    chmodSync(filePath, isExec ? 0o755 : 0o644);

    materializedBlobs.push({
      path,
      expectedDigest,
      filePath,
    });
  }

  // 2. Remove obsolete files if cleanExisting is true
  if (cleanExisting && existsSync(destResolved)) {
    function cleanDir(dir) {
      const items = readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const full = join(dir, item.name);
        const rel = relative(destResolved, full).replace(/\\/g, '/');

        if (item.name === '.git') continue;

        const itemStat = lstatSync(full);
        if (itemStat.isSymbolicLink()) {
          throw materializeVerifyError(`Symlink in materialized worktree is forbidden: "${rel}"`, {
            path: rel,
          });
        }

        if (itemStat.isDirectory()) {
          cleanDir(full);
          // Remove empty directory
          try {
            if (readdirSync(full).length === 0) {
              rmSync(full, { recursive: true, force: true });
            }
          } catch {
            // ignore
          }
        } else if (itemStat.isFile()) {
          if (!expectedPaths.has(rel)) {
            unlinkSync(full);
          }
        } else {
          throw materializeVerifyError(`Unsupported materialized inode: "${rel}"`, { path: rel });
        }
      }
    }
    cleanDir(destResolved);
  }

  // 3. Post-commit / materialize cryptographic verification (TI-14)
  if (verifyHash) {
    for (const item of materializedBlobs) {
      if (!existsSync(item.filePath)) {
        throw new AfrError(`Post-materialize verification failed: missing file "${item.path}"`, 'MATERIALIZE_VERIFY_FAILED', {
          path: item.path,
        });
      }
      const diskBytes = readFileSync(item.filePath);
      const diskDigest = sha256(diskBytes);
      if (diskDigest !== item.expectedDigest) {
        throw new AfrError(
          `Post-materialize hash check failed for "${item.path}" (expected ${item.expectedDigest}, got ${diskDigest})`,
          'MATERIALIZE_VERIFY_FAILED',
          { path: item.path, expectedDigest: item.expectedDigest, diskDigest }
        );
      }
    }

    verifyMaterializedWorktree({
      repoDir,
      canonicalOid,
      destinationDir: destResolved,
      allowExtra: !cleanExisting,
    });
  }

  return Object.freeze({
    materialized_count: materializedBlobs.length,
    canonical_oid: canonicalOid,
    destination: destResolved,
    verified: verifyHash,
    materialized_at: new Date().toISOString(),
  });
}
