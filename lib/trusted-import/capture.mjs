// lib/trusted-import/capture.mjs
//
// Bounded FS Capture (§6, §7.2).
// Inspects untrusted candidate filesystem using strict lstat walk, enforces
// DoS limits and Canonical Filesystem/Path Contracts (A5, A6, B(i)), and
// ingests raw bytes directly into Trusted CAS.

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  DEFAULT_LIMITS,
  HardDenyError,
  normalizeMode,
  validateRawPath,
  checkNormalizationCollisions,
} from './common.mjs';
import { assertQuiesced } from './quiesce.mjs';

/**
 * Perform a bounded, secure filesystem capture of a candidate tree.
 *
 * @param {object} options
 * @param {string} options.candidateDir - Root of candidate workspace
 * @param {string} [options.scratchDir] - Scratch directory to physically ignore
 * @param {object} [options.limits] - Custom DoS bounds
 * @param {import('./cas.mjs').TrustedCAS} options.cas - Trusted CAS store
 * @param {object} options.quiesceEvidence - Proof of writer termination
 * @returns {{ entries: Array<object>, totalEntries: number, totalBytes: number, quiesceEvidence: object }}
 */
export function captureCandidateFS({
  candidateDir,
  scratchDir = null,
  limits = {},
  cas,
  quiesceEvidence,
}) {
  // 1. Quiesce proof mandatory before scan commences (TI-3)
  assertQuiesced(quiesceEvidence);

  if (!candidateDir) {
    throw new HardDenyError('candidateDir is required', { code: 'INVALID_ARGUMENT' });
  }
  if (!cas) {
    throw new HardDenyError('cas instance is required', { code: 'INVALID_ARGUMENT' });
  }

  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  const rootResolved = resolve(candidateDir);
  const scratchResolved = scratchDir ? resolve(scratchDir) : null;

  const entries = [];
  let totalBytes = 0;
  let totalEntries = 0;

  /**
   * Recursive directory walk enforcing bounds and A5/A6 contracts.
   */
  function walk(currentDir, depth) {
    if (depth > effectiveLimits.maxDepth) {
      throw new HardDenyError(
        `Directory traversal depth limit exceeded (depth: ${depth}, max: ${effectiveLimits.maxDepth})`,
        { code: 'MAX_DEPTH_EXCEEDED', depth, maxDepth: effectiveLimits.maxDepth }
      );
    }

    const items = readdirSync(currentDir, { withFileTypes: false });

    // Deterministic sorting of directory entries
    items.sort();

    for (const item of items) {
      const fullPath = join(currentDir, item);
      const relPath = relative(rootResolved, fullPath).replace(/\\/g, '/');

      // Physical isolation: if scratch directory is inside candidate tree, skip entirely (TI-30)
      if (scratchResolved && (fullPath === scratchResolved || fullPath.startsWith(scratchResolved + '/'))) {
        continue;
      }

      // Ignore internal .git if accidentally present (though candidate projection never mounts it)
      if (item === '.git' || relPath.startsWith('.git/')) {
        throw new HardDenyError('Found .git directory in candidate source namespace', {
          code: 'GIT_NAMESPACE_FORBIDDEN',
          path: relPath,
        });
      }

      totalEntries += 1;
      if (totalEntries > effectiveLimits.maxEntries) {
        throw new HardDenyError(
          `Candidate entry count limit exceeded (count: ${totalEntries}, max: ${effectiveLimits.maxEntries})`,
          { code: 'MAX_ENTRIES_EXCEEDED', totalEntries, maxEntries: effectiveLimits.maxEntries }
        );
      }

      // Inspect inode directly without following symlinks
      const stat = lstatSync(fullPath);

      // B(i) / A5 Inode type enforcement
      if (stat.isSymbolicLink()) {
        throw new HardDenyError(
          `Symbolic link rejected under B(i) / Canonical Filesystem Contract: ${relPath}`,
          { code: 'SYMLINK_FORBIDDEN', path: relPath }
        );
      }

      if (stat.isSocket() || stat.isFIFO() || stat.isBlockDevice() || stat.isCharacterDevice()) {
        throw new HardDenyError(
          `Special inode type (socket/fifo/device) rejected under B(i): ${relPath}`,
          { code: 'SPECIAL_INODE_FORBIDDEN', path: relPath }
        );
      }

      if (stat.isDirectory()) {
        // Continue recursive walk
        walk(fullPath, depth + 1);
        continue;
      }

      if (stat.isFile()) {
        // Check for hard link alias (A5 / B(i))
        if (stat.nlink > 1) {
          throw new HardDenyError(
            `Hard link alias rejected under B(i) (nlink=${stat.nlink}): ${relPath}`,
            { code: 'HARDLINK_FORBIDDEN', path: relPath, nlink: stat.nlink }
          );
        }

        // Validate A6 path contract
        validateRawPath(relPath);

        // Pre-ingest DoS file size check
        if (stat.size > effectiveLimits.maxFileBytes) {
          throw new HardDenyError(
            `Single file size limit exceeded: ${relPath} (${stat.size} bytes > max ${effectiveLimits.maxFileBytes})`,
            { code: 'FILE_SIZE_EXCEEDED', path: relPath, size: stat.size, maxFileBytes: effectiveLimits.maxFileBytes }
          );
        }

        totalBytes += stat.size;
        if (totalBytes > effectiveLimits.maxTotalBytes) {
          throw new HardDenyError(
            `Total logic bytes limit exceeded (${totalBytes} bytes > max ${effectiveLimits.maxTotalBytes})`,
            { code: 'TOTAL_SIZE_EXCEEDED', totalBytes, maxTotalBytes: effectiveLimits.maxTotalBytes }
          );
        }

        // Ingest raw bytes into CAS
        const buffer = readFileSync(fullPath);
        const { digest } = cas.put(buffer);

        // A5 Canonical filesystem mode normalization (0644 or 0755)
        const normalizedMode = normalizeMode(stat.mode);

        entries.push({
          path: relPath,
          type: 'blob',
          mode: normalizedMode,
          blob_digest: digest,
          size: stat.size,
        });
      } else {
        throw new HardDenyError(`Unsupported filesystem object type: ${relPath}`, {
          code: 'UNSUPPORTED_INODE_TYPE',
          path: relPath,
        });
      }
    }
  }

  walk(rootResolved, 1);

  // A6 Normalization Collision Check across all captured paths (TI-29)
  checkNormalizationCollisions(entries.map((e) => e.path));

  return {
    entries,
    totalEntries,
    totalBytes,
    quiesceEvidence,
  };
}
