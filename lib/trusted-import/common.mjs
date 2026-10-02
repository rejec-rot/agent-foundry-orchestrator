// lib/trusted-import/common.mjs
//
// Common definitions, contracts, invariants and error classes for Trusted Import.
// Conforms to AFR v5.2.1 Implementation Spec (§0, §5.3, §7.5.7, §7.5.8).

import { createHash } from 'node:crypto';

export const CANONICAL_REF = 'refs/afr/canonical';
export const ZERO_OID = '0000000000000000000000000000000000000000';
export const SNAPSHOT_SCHEMA_V1 = 'afr-snapshot-v1';

export const MODE_NORMAL = '0644';
export const MODE_EXEC = '0755';

export const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxEntries: 100_000,
  maxFileBytes: 50 * 1024 * 1024, // 50MB
  maxTotalBytes: 500 * 1024 * 1024, // 500MB
});

/**
 * Base class for all Trusted Import errors.
 */
export class AfrError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

/**
 * Hard rejection under Gate B(i) (§5.3). Never calls verifier.
 */
export class HardDenyError extends AfrError {
  constructor(message, details = {}) {
    super(message, details.code || 'HARD_DENY', details);
  }
}

/**
 * Task admission failure (e.g. non-git workspace or invalid bootstrap).
 */
export class AdmissionError extends AfrError {
  constructor(message, code = 'TASK_ADMISSION_FAIL', details = {}) {
    super(message, code, details);
  }
}

/**
 * Quiesce verification failure (untrusted writers active or unconfirmed).
 */
export class QuiesceError extends AfrError {
  constructor(message, details = {}) {
    super(message, 'QUIESCE_VERIFICATION_FAILED', details);
  }
}

/**
 * Calculate SHA-256 hash of a buffer or string.
 * @param {Buffer|string} data
 * @returns {string} hex digest
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Normalize POSIX mode to canonical filesystem contract (§7.5.7).
 * Regular file: 0755 if any executable bit is set, otherwise 0644.
 * @param {number} mode
 * @returns {'0644'|'0755'}
 */
export function normalizeMode(mode) {
  return (mode & 0o111) !== 0 ? MODE_EXEC : MODE_NORMAL;
}

/**
 * A6 Canonical Path Contract (§7.5.8): Validate raw path identity.
 * - Must be relative path (no leading '/')
 * - Single '/' separators (no '//')
 * - No '.' or '..' segments
 * - No NUL byte '\0'
 * - Valid UTF-8 string
 * - Cannot point to or inside '.git'
 *
 * @param {string} rawPath
 * @throws {HardDenyError} if invalid
 */
export function validateRawPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new HardDenyError('Path must be a non-empty string', { code: 'INVALID_PATH', path: rawPath });
  }

  if (rawPath.startsWith('/') || /^[a-zA-Z]:/.test(rawPath)) {
    throw new HardDenyError('Absolute paths are forbidden', { code: 'ABSOLUTE_PATH_FORBIDDEN', path: rawPath });
  }

  if (rawPath.includes('\\')) {
    throw new HardDenyError('Backslash separators are forbidden', { code: 'BACKSLASH_FORBIDDEN', path: rawPath });
  }

  if (rawPath.includes('\0')) {
    throw new HardDenyError('NUL byte in path is forbidden', { code: 'NUL_BYTE_FORBIDDEN', path: rawPath });
  }

  if (rawPath.includes('//')) {
    throw new HardDenyError('Empty path segments (//) are forbidden', { code: 'EMPTY_SEGMENT_FORBIDDEN', path: rawPath });
  }

  const segments = rawPath.split('/');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new HardDenyError('Directory traversal segment (. or ..) is forbidden', { code: 'TRAVERSAL_SEGMENT_FORBIDDEN', path: rawPath });
    }
    if (seg.length === 0) {
      throw new HardDenyError('Empty path segment is forbidden', { code: 'EMPTY_SEGMENT_FORBIDDEN', path: rawPath });
    }
  }

  if (segments[0] === '.git') {
    throw new HardDenyError('Access to .git namespace is forbidden', { code: 'GIT_NAMESPACE_FORBIDDEN', path: rawPath });
  }

  // Check valid UTF-8 encoding
  try {
    const buf = Buffer.from(rawPath, 'utf8');
    const decoded = buf.toString('utf8');
    if (decoded !== rawPath) {
      throw new Error('UTF-8 round-trip mismatch');
    }
  } catch (err) {
    throw new HardDenyError('Path contains invalid UTF-8 byte sequence', { code: 'INVALID_UTF8_PATH', path: rawPath, error: err.message });
  }
}

/**
 * A6 Canonical Path Contract (§7.5.8): Compute Policy Match Key (Unicode NFC).
 * @param {string} rawPath
 * @returns {string}
 */
export function toPolicyMatchKey(rawPath) {
  return rawPath.normalize('NFC');
}

/**
 * A6 Normalization Collision Check (§7.5.8):
 * If raw_path_A != raw_path_B but NFC(A) == NFC(B), throw PATH_POLICY_AMBIGUITY.
 *
 * @param {string[]} paths - array of raw paths
 * @throws {HardDenyError} if ambiguous normalization found
 */
export function checkNormalizationCollisions(paths) {
  const nfcMap = new Map();
  for (const p of paths) {
    const key = toPolicyMatchKey(p);
    if (nfcMap.has(key)) {
      const existing = nfcMap.get(key);
      if (existing !== p) {
        throw new HardDenyError(
          `Unicode normalization collision detected between "${p}" and "${existing}" (both normalize to "${key}")`,
          {
            code: 'PATH_POLICY_AMBIGUITY',
            pathA: existing,
            pathB: p,
            policyMatchKey: key,
          }
        );
      }
    } else {
      nfcMap.set(key, p);
    }
  }
}
