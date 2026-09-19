// lib/trusted-import/acceptance-engine.mjs
//
// Acceptance Execution Engine & Baseline Regression Closure (§9.4, §9.5).
// Enforces:
// - Pre-acceptance closure: unresolved DENY blocks acceptance (TI-23)
// - Acceptance never touches canonical .git (TI-18)
// - Tier B Baseline Regression Closure: RO baseline tests neutralize helper tampering (TI-27)
// - Minting 7-tuple Evidence Records (TI-26)

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AfrError, sha256, validateRawPath } from './common.mjs';
import { createEvidenceRecord } from './evidence-record.mjs';
import { acceptanceBinding, normalizeAcceptanceCmd, runAcceptance } from '../acceptance.mjs';

// A raw callback supplied by a caller is not an acceptance trust boundary.
// Only a runner created from the repository's allowlisted acceptance path can
// mint evidence here.
const TRUSTED_ACCEPTANCE_RUNNERS = new WeakSet();
const ACCEPTANCE_RUNNER_BINDINGS = new WeakMap();

function commandBinding(spec) {
  return JSON.stringify({ command: spec.command, args: spec.args });
}

/**
 * Create the only runner accepted by runAcceptancePipeline.
 *
 * The command is normalized and checked against the control-plane allowlist
 * before the closure is branded. A caller cannot replace it with a callback
 * that reports a synthetic exit code.
 */
export function createTrustedAcceptanceRunner({ task = {}, acceptanceCmd = task.acceptance_cmd } = {}) {
  const spec = normalizeAcceptanceCmd(acceptanceCmd, {
    allowLegacy: task.allow_legacy_shell_acceptance === true,
  });
  if (!spec) {
    throw new AfrError('A non-empty allowlisted acceptance command is required', 'ACCEPTANCE_COMMAND_REQUIRED');
  }
  const normalizedTask = {
    ...task,
    acceptance_cmd: { command: spec.command, args: [...spec.args] },
    acceptance_binding: acceptanceBinding({
      ...task,
      acceptance_cmd: { command: spec.command, args: [...spec.args] },
    }),
  };
  const runner = async (stagingDir) => runAcceptance({
    ...normalizedTask,
    fixture_dir: stagingDir,
  });
  TRUSTED_ACCEPTANCE_RUNNERS.add(runner);
  ACCEPTANCE_RUNNER_BINDINGS.set(runner, commandBinding(spec));
  return runner;
}

function stagingPathError(message, details = {}) {
  return new AfrError(message, 'ACCEPTANCE_STAGING_PATH_UNSAFE', details);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function assertNoSymlinkAncestors(path) {
  let current = resolve(path);
  while (true) {
    const stat = lstatOrNull(current);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw stagingPathError(`Unsafe acceptance staging path component: "${current}"`, { path: current });
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/**
 * Replace a baseline asset atomically after checking every parent component.
 * Candidate-created symlink directories must never redirect baseline closure
 * files outside the disposable staging root.
 */
function writeBaselineAsset(stagingDir, path, rawBytes) {
  validateRawPath(path);
  const root = resolve(stagingDir);
  mkdirSync(root, { recursive: true });
  assertNoSymlinkAncestors(root);

  const targetFile = join(root, path);
  const parentDir = dirname(targetFile);
  mkdirSync(parentDir, { recursive: true });
  assertNoSymlinkAncestors(parentDir);

  const existing = lstatOrNull(targetFile);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw stagingPathError(`Unsafe acceptance staging target: "${path}"`, { path });
  }

  const tempFile = join(parentDir, `.afr-baseline-${randomUUID()}`);
  try {
    writeFileSync(tempFile, rawBytes, { flag: 'wx', mode: 0o600 });
    chmodSync(tempFile, 0o644);
    renameSync(tempFile, targetFile);
    // Baseline regression assets are read-only inputs to acceptance. A test
    // helper must not be able to rewrite the very bytes restored from the
    // canonical baseline during the same run.
    chmodSync(targetFile, 0o444);
  } catch (err) {
    try {
      rmSync(tempFile, { force: true });
    } catch {
      // Preserve the original failure.
    }
    if (err?.code === 'ACCEPTANCE_STAGING_PATH_UNSAFE') throw err;
    throw new AfrError(`Failed to inject baseline asset "${path}": ${err.message}`, 'ACCEPTANCE_STAGING_WRITE_FAILED', {
      path,
    });
  }
}

/**
 * Verify pre-acceptance closure: no unresolved DENY items allowed (TI-23).
 *
 * @param {object} gateOutcome - Result from evaluateMechanicalGate
 * @throws {AfrError} if blocking obligations exist
 */
export function assertPreAcceptanceClosure(gateOutcome) {
  if (!gateOutcome) {
    throw new AfrError('gateOutcome is required for pre-acceptance closure', 'INVALID_ARGUMENT');
  }

  if (gateOutcome.blockingObligations && gateOutcome.blockingObligations.length > 0) {
    throw new AfrError(
      `Pre-acceptance closure failed: ${gateOutcome.blockingObligations.length} unresolved DENY obligations present`,
      'PRE_ACCEPTANCE_CLOSURE_FAILED',
      { blockingObligations: gateOutcome.blockingObligations }
    );
  }

  if (gateOutcome.needsHuman && gateOutcome.needsHuman.length > 0) {
    throw new AfrError(
      `Pre-acceptance closure failed: ${gateOutcome.needsHuman.length} unresolved Human Gate items present`,
      'PRE_ACCEPTANCE_CLOSURE_FAILED',
      { needsHuman: gateOutcome.needsHuman }
    );
  }
}

/**
 * Inject Baseline Regression Closure (Tier B) into staging workspace (TI-27).
 * Extracts tests and test runner configurations from canonical baseline and
 * overlays them onto staging to prevent candidate tampering with test helpers.
 *
 * @param {object} options
 * @param {string} options.repoDir - Canonical Git repository path
 * @param {string} options.baselineOid - Baseline commit OID
 * @param {string} options.stagingDir - Destination acceptance staging directory
 * @param {string[]} [options.testPathPatterns=['tests/**', 'test/**', 'jest.config.*', 'vitest.config.*']]
 * @returns {string[]} List of restored test files
 */
export function injectBaselineRegressionClosure({
  repoDir,
  baselineOid,
  stagingDir,
  testPathPatterns = ['tests/**', 'test/**'],
}) {
  if (!repoDir || !baselineOid || !stagingDir) {
    throw new AfrError('repoDir, baselineOid, and stagingDir are required for baseline closure', 'INVALID_ARGUMENT');
  }

  const lsTreeOutput = execFileSync('git', ['ls-tree', '-r', '-z', baselineOid], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rawEntries = lsTreeOutput ? lsTreeOutput.split('\0').filter(Boolean) : [];
  const injected = [];

  for (const line of rawEntries) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;

    const meta = line.slice(0, tabIdx);
    const path = line.slice(tabIdx + 1);
    const [modeStr, type, oid] = meta.split(' ');

    if (type !== 'blob') continue;

    // Check if path matches baseline test closure patterns
    const isTestAsset = testPathPatterns.some((pat) => {
      if (pat.endsWith('/**')) {
        const prefix = pat.slice(0, -3);
        return path === prefix || path.startsWith(prefix + '/');
      }
      return path === pat;
    });

    if (!isTestAsset) continue;

    // Extract exact baseline blob from Git and write into staging
    const rawBytes = execFileSync('git', ['cat-file', 'blob', oid], {
      cwd: repoDir,
      encoding: null,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    writeBaselineAsset(stagingDir, path, rawBytes);

    injected.push(path);
  }

  return injected;
}

/**
 * Initialize a sanitized, disposable Git repository if test runner strictly requires one (TI-18).
 * Guarantees NO canonical remotes, hooks, config, refs, or credentials.
 *
 * @param {string} stagingDir
 */
export function initSanitizedDisposableGit(stagingDir) {
  const gitDir = join(stagingDir, '.git');
  if (existsSync(gitDir)) {
    rmSync(gitDir, { recursive: true, force: true });
  }

  execFileSync('git', ['init', '-b', 'main'], { cwd: stagingDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'AFR Disposable Acceptance'], { cwd: stagingDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'acceptance@disposable.local'], { cwd: stagingDir, stdio: 'pipe' });
}

/**
 * Execute Acceptance Pipeline and mint Evidence Record.
 *
 * @param {object} options
 * @param {'TierA'|'TierB'|'TierC'} options.tier
 * @param {string} options.stagingDir
 * @param {string} options.baselineOid
 * @param {string} options.candidateSnapshotDigest
 * @param {string} options.dependencyFixtureId
 * @param {Function} options.trustedRunner - Runner returned by createTrustedAcceptanceRunner
 * @param {string} options.acceptanceProfileDigest - Identity of the trusted acceptance profile
 * @param {string} options.acceptanceAssetsDigest - Identity of the exact acceptance assets
 * @param {object} options.policySectionDigests
 * @param {object|null} [options.tierCData=null]
 * @returns {object} Evidence Record
 */
export async function runAcceptancePipeline({
  tier,
  stagingDir,
  baselineOid,
  candidateSnapshotDigest,
  dependencyFixtureId,
  trustedRunner,
  // Kept in the signature so an old caller fails with a precise trust error
  // instead of accidentally being treated as a trusted runner.
  command = null,
  commandRunner = null,
  acceptanceProfileDigest,
  acceptanceAssetsDigest,
  policySectionDigests,
  tierCData = null,
}) {
  if (
    !stagingDir ||
    !baselineOid ||
    !candidateSnapshotDigest ||
    !dependencyFixtureId ||
    typeof trustedRunner !== 'function' ||
    typeof acceptanceProfileDigest !== 'string' ||
    acceptanceProfileDigest.length === 0 ||
    typeof acceptanceAssetsDigest !== 'string' ||
    acceptanceAssetsDigest.length === 0 ||
    !policySectionDigests ||
    typeof policySectionDigests !== 'object' ||
    Array.isArray(policySectionDigests)
  ) {
    throw new AfrError('Invalid arguments for runAcceptancePipeline', 'INVALID_ARGUMENT');
  }

  if (command || commandRunner || !TRUSTED_ACCEPTANCE_RUNNERS.has(trustedRunner)) {
    throw new AfrError(
      'runAcceptancePipeline accepts only a branded allowlisted acceptance runner',
      'ACCEPTANCE_RUNNER_UNTRUSTED'
    );
  }

  // Execute acceptance command in staging directory
  const runResult = await trustedRunner(stagingDir);
  if (!runResult || typeof runResult.ok !== 'boolean') {
    throw new AfrError('Trusted acceptance runner returned no valid result', 'ACCEPTANCE_RUNNER_INVALID');
  }
  const status = runResult.ok ? 'PASS' : 'FAIL';
  const boundCommand = ACCEPTANCE_RUNNER_BINDINGS.get(trustedRunner);

  // Mint cryptographically bound Evidence Record (TI-26)
  const evidence = createEvidenceRecord({
    status,
    tier,
    candidateSnapshotDigest,
    baselineOid,
    acceptanceProfileDigest,
    acceptanceAssetsDigest,
    dependencyFixtureId,
    commandBinding: boundCommand,
    policySectionDigests,
    tierCData,
    details: {
      exitCode: runResult.record?.exit_code ?? (runResult.ok ? 0 : 1),
      stdout: runResult.record?.stdout_summary || runResult.output || '',
      stderr: runResult.record?.stderr_summary || '',
    },
  });

  return evidence;
}
