// lib/trusted-import/dependency-fixture.mjs
//
// Trusted Dependency Fixture Manager (§9.4, 1.3, 1.5).
// Generates universal, ecosystem-agnostic dependency fixture IDs:
// H(dependency_input_digest + runtime_image + arch + installer_policy)
// Guarantees third-party dependencies are hash-locked and built under trusted harness (TI-28).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AfrError, sha256 } from './common.mjs';

/**
 * Compute the dependency input digest for a given workspace and ecosystem.
 *
 * @param {object} options
 * @param {string} options.workspaceDir
 * @param {'node'|'rust'|'python'|'generic'} [options.ecosystem='node']
 * @returns {string} SHA-256 digest of dependency manifests/lockfiles
 */
export function computeDependencyInputDigest({ workspaceDir, ecosystem = 'node' }) {
  if (!workspaceDir) {
    throw new AfrError('workspaceDir is required', 'INVALID_ARGUMENT');
  }

  let inputs = '';

  if (ecosystem === 'node') {
    // Node ecosystem: package-lock.json / yarn.lock / pnpm-lock.yaml + package.json
    const candidates = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'package.json'];
    for (const name of candidates) {
      const p = join(workspaceDir, name);
      if (existsSync(p)) {
        const bytes = readFileSync(p);
        inputs += `${name}:${sha256(bytes)}\n`;
      }
    }
  } else if (ecosystem === 'rust') {
    const candidates = ['Cargo.lock', 'Cargo.toml'];
    for (const name of candidates) {
      const p = join(workspaceDir, name);
      if (existsSync(p)) {
        const bytes = readFileSync(p);
        inputs += `${name}:${sha256(bytes)}\n`;
      }
    }
  } else if (ecosystem === 'python') {
    const candidates = ['poetry.lock', 'Pipfile.lock', 'requirements.txt', 'pyproject.toml'];
    for (const name of candidates) {
      const p = join(workspaceDir, name);
      if (existsSync(p)) {
        const bytes = readFileSync(p);
        inputs += `${name}:${sha256(bytes)}\n`;
      }
    }
  } else {
    // Generic
    const p = join(workspaceDir, 'dependencies.lock');
    if (existsSync(p)) {
      inputs += `dependencies.lock:${sha256(readFileSync(p))}\n`;
    }
  }

  if (!inputs) {
    inputs = 'no-dependency-manifests\n';
  }

  return sha256(inputs);
}

/**
 * Compute the universal Dependency Fixture ID (TI-28).
 *
 * @param {object} options
 * @param {string} options.dependencyInputDigest
 * @param {string} [options.runtimeImage='node:20-bookworm-slim']
 * @param {string} [options.platformArch=process.arch]
 * @param {string} [options.installerPolicy='npm ci --ignore-scripts']
 * @returns {string} 64-char hex SHA-256 fixture ID
 */
export function computeDependencyFixtureId({
  dependencyInputDigest,
  runtimeImage = 'node:20-bookworm-slim',
  platformArch = process.arch,
  installerPolicy = 'npm ci --ignore-scripts',
}) {
  if (!dependencyInputDigest) {
    throw new AfrError('dependencyInputDigest is required', 'INVALID_ARGUMENT');
  }

  const runtimeImageDigest = sha256(runtimeImage);
  const installerPolicyDigest = sha256(installerPolicy);

  const payload = [
    dependencyInputDigest,
    runtimeImageDigest,
    platformArch,
    installerPolicyDigest,
  ].join(':');

  return sha256(payload);
}

/**
 * Fixture Cache Registry to simulate building or reusing a locked fixture.
 */
export class DependencyFixtureRegistry {
  /**
   * @param {object} options
   * @param {string} options.cacheDir
   */
  constructor({ cacheDir }) {
    if (!cacheDir) {
      throw new AfrError('cacheDir is required for DependencyFixtureRegistry', 'INVALID_ARGUMENT');
    }
    this.cacheDir = cacheDir;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  getFixturePath(fixtureId) {
    if (typeof fixtureId !== 'string' || !/^[0-9a-f]{64}$/.test(fixtureId)) {
      throw new AfrError(`Invalid dependency fixture ID: ${String(fixtureId)}`, 'INVALID_FIXTURE_ID', {
        fixtureId,
      });
    }
    return join(this.cacheDir, fixtureId);
  }

  has(fixtureId) {
    return existsSync(this.getFixturePath(fixtureId));
  }

  /**
   * Resolve or build a fixture. If fixture exists, reuse it; otherwise trigger build.
   *
   * @param {object} options
   * @param {string} options.fixtureId
   * @param {Function} [options.builderFn] - (destPath) => void
   * @returns {{ fixtureId: string, fixturePath: string, reused: boolean }}
   */
  resolveFixture({ fixtureId, builderFn = null }) {
    const fixturePath = this.getFixturePath(fixtureId);
    if (this.has(fixtureId)) {
      return { fixtureId, fixturePath, reused: true };
    }

    if (typeof builderFn !== 'function') {
      throw new AfrError(
        'A trusted dependency fixture builder is required; metadata alone is not a built fixture',
        'DEPENDENCY_FIXTURE_BUILDER_REQUIRED',
        { fixtureId }
      );
    }

    // Build into an unaddressed temporary directory. A failed builder must
    // never leave a directory that `has()` would later mistake for a complete
    // fixture and silently reuse.
    const tempPath = join(this.cacheDir, `.building-${fixtureId}-${randomUUID()}`);
    mkdirSync(tempPath);
    try {
      builderFn(tempPath);
      writeFileSync(
        join(tempPath, '.fixture-meta.json'),
        JSON.stringify({ fixtureId, builtAt: new Date().toISOString() })
      );
      renameSync(tempPath, fixturePath);
    } catch (err) {
      rmSync(tempPath, { recursive: true, force: true });
      throw new AfrError(`Dependency fixture build failed: ${err.message}`, 'DEPENDENCY_FIXTURE_BUILD_FAILED', {
        fixtureId,
      });
    }

    return { fixtureId, fixturePath, reused: false };
  }
}
