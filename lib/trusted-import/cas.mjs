// lib/trusted-import/cas.mjs
//
// Trusted Content-Addressed Storage (CAS) for AFR v5.2.1.
// Holds immutable raw byte blobs indexed strictly by SHA-256 digest.
// Model-facing components NEVER receive arbitrary access to this store (§0.2).

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sha256, AfrError } from './common.mjs';
import { runGit } from '../worktree.mjs';

export class TrustedCAS {
  /**
   * @param {object} options
   * @param {string} options.casDir - Root directory for the local CAS object store
   */
  constructor({ casDir }) {
    if (!casDir) {
      throw new AfrError('casDir is required for TrustedCAS', 'CONFIG_ERROR');
    }
    this.casDir = casDir;
    this.objectsDir = join(casDir, 'objects');
    this.tmpDir = join(casDir, 'tmp');
    this._ensureDirs();
  }

  _ensureDirs() {
    mkdirSync(this.objectsDir, { recursive: true });
    mkdirSync(this.tmpDir, { recursive: true });
  }

  /**
   * Compute relative shard path: "ab/cdef..."
   * @param {string} digest
   * @returns {string}
   */
  _shardPath(digest) {
    return join(digest.slice(0, 2), digest.slice(2));
  }

  /**
   * Validate the digest before using it as a filesystem path.
   * CAS object names are canonical lowercase SHA-256 digests. Rejecting
   * everything else prevents path traversal through getFilePath(), has(),
   * and get().
   * @param {string} digest
   */
  _assertDigest(digest) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new AfrError(
        `Invalid CAS digest: ${String(digest)}`,
        'INVALID_DIGEST',
        { digest }
      );
    }
  }

  /**
   * Get full filesystem path to a CAS object.
   * @param {string} digest
   * @returns {string}
   */
  getFilePath(digest) {
    this._assertDigest(digest);
    return join(this.objectsDir, this._shardPath(digest));
  }

  /**
   * Check if an object exists in CAS.
   * @param {string} digest
   * @returns {boolean}
   */
  has(digest) {
    return existsSync(this.getFilePath(digest));
  }

  /**
   * Store a raw byte buffer into CAS atomically.
   * @param {Buffer|Uint8Array} buffer
   * @returns {{ digest: string, size: number }}
   */
  put(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      buffer = Buffer.from(buffer);
    }
    const digest = sha256(buffer);
    const targetFile = this.getFilePath(digest);

    if (existsSync(targetFile)) {
      return { digest, size: buffer.length };
    }

    mkdirSync(dirname(targetFile), { recursive: true });
    const tmpFile = join(this.tmpDir, `${digest}.${randomUUID()}`);
    writeFileSync(tmpFile, buffer);
    renameSync(tmpFile, targetFile);

    return { digest, size: buffer.length };
  }

  /**
   * Ingest a file directly from filesystem into CAS.
   * @param {string} filePath
   * @returns {{ digest: string, size: number }}
   */
  putFile(filePath) {
    const buffer = readFileSync(filePath);
    return this.put(buffer);
  }

  /**
   * Retrieve an object's raw bytes from CAS.
   * @param {string} digest
   * @returns {Buffer}
   */
  get(digest) {
    const targetFile = this.getFilePath(digest);
    if (!existsSync(targetFile)) {
      throw new AfrError(`Object not found in CAS: ${digest}`, 'OBJECT_NOT_FOUND', { digest });
    }
    const buffer = readFileSync(targetFile);
    const actualDigest = sha256(buffer);
    if (actualDigest !== digest) {
      throw new AfrError(`CAS object corruption detected for ${digest}`, 'CORRUPTION_DETECTED', {
        expected: digest,
        actual: actualDigest,
      });
    }
    return buffer;
  }

  /**
   * Ingest raw bytes into Git Object Store (using --no-filters to preserve exact raw bytes).
   * @param {Buffer} buffer
   * @param {string} gitDir - path to repository working tree or git dir
   * @returns {string} git blob SHA-1/SHA-256 OID
   */
  putGitBlob(buffer, gitDir) {
    if (!Buffer.isBuffer(buffer)) {
      buffer = Buffer.from(buffer);
    }
    const stdout = execFileSync('git', ['hash-object', '-w', '--no-filters', '--stdin'], {
      cwd: gitDir,
      input: buffer,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return stdout.trim();
  }
}
