// tests/trusted-import-phase4.test.mjs
//
// Phase 4 (Runtime & Evidence Layer) Verification Suite for AFR v5.2.1.
// Verifies:
//   TI-11: Acceptance Trust Closure protects runner commands & config
//   TI-18: Acceptance never touches canonical .git; uses disposable sanitized repo if needed
//   TI-23: Pre-acceptance closure blocks acceptance when unresolved DENY exists
//   TI-26: Evidence Replay: R1 PASS is marked stale on R2 (cannot cross-replay)
//   TI-27: Tier B Baseline Regression Closure neutralizes helper/config tampering
//   TI-28: Dependency Fixture: input/image/arch/policy shift changes fixture_id and prevents stale reuse
//   TI-31: Diagnostic vs Promotion: diagnostic dry-run runs during DENY, but promotion is strictly blocked

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  computeDependencyInputDigest,
  computeDependencyFixtureId,
  DependencyFixtureRegistry,
  createEvidenceRecord,
  verifyEvidenceReplay,
  assertPreAcceptanceClosure,
  injectBaselineRegressionClosure,
  initSanitizedDisposableGit,
  createTrustedAcceptanceRunner,
  runAcceptancePipeline,
  runDiagnosticDryrun,
  assertPromotionNotPermittedFromDiagnostic,
  AfrError,
  sha256,
} from '../lib/trusted-import/index.mjs';

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function initTestGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'AFR Tester'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'tester@afr.local'], { cwd: dir, stdio: 'pipe' });
}

const acceptanceProfileDigest = 'profile:phase4';
const acceptanceAssetsDigest = 'assets:phase4';
const policySectionDigests = { allowed: '1' };

// ----------------------------------------------------------------------------
// TEST 1: TI-28 Dependency Fixture hash locking & invalidation
// ----------------------------------------------------------------------------
test('TI-28: Dependency Fixture: lockfile / image / arch / policy change produces new fixture_id and prevents reuse', () => {
  const wsDir = makeTempDir('af-dep-ws-');
  const cacheDir = makeTempDir('af-dep-cache-');

  try {
    writeFileSync(join(wsDir, 'package.json'), JSON.stringify({ name: 'pkg', dependencies: { foo: '1.0.0' } }));
    writeFileSync(join(wsDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { foo: '1.0.0' } }));

    const registry = new DependencyFixtureRegistry({ cacheDir });

    // 1. Initial computation
    const digest1 = computeDependencyInputDigest({ workspaceDir: wsDir, ecosystem: 'node' });
    const fixtureId1 = computeDependencyFixtureId({
      dependencyInputDigest: digest1,
      runtimeImage: 'node:20-bookworm-slim',
      platformArch: 'x64',
      installerPolicy: 'npm ci --ignore-scripts',
    });

    const buildFixture = (dest) => writeFileSync(join(dest, 'fixture-built.txt'), fixtureId1);
    const res1 = registry.resolveFixture({ fixtureId: fixtureId1, builderFn: buildFixture });
    assert.strictEqual(res1.reused, false);
    assert.strictEqual(existsSync(join(res1.fixturePath, 'fixture-built.txt')), true);

    // Resolving again with same fixtureId reuses cached fixture
    const res1Reuse = registry.resolveFixture({ fixtureId: fixtureId1 });
    assert.strictEqual(res1Reuse.reused, true);

    // 2. Lockfile modified by candidate
    writeFileSync(join(wsDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { foo: '2.0.0' } }));
    const digest2 = computeDependencyInputDigest({ workspaceDir: wsDir, ecosystem: 'node' });
    assert.notStrictEqual(digest1, digest2);

    const fixtureId2 = computeDependencyFixtureId({
      dependencyInputDigest: digest2,
      runtimeImage: 'node:20-bookworm-slim',
      platformArch: 'x64',
      installerPolicy: 'npm ci --ignore-scripts',
    });
    assert.notStrictEqual(fixtureId1, fixtureId2);
    const res2 = registry.resolveFixture({
      fixtureId: fixtureId2,
      builderFn: (dest) => writeFileSync(join(dest, 'fixture-built.txt'), fixtureId2),
    });
    assert.strictEqual(res2.reused, false, 'Modified lockfile must not reuse old fixture');

    // 3. Runtime image or installer policy modified
    const fixtureIdPolicy = computeDependencyFixtureId({
      dependencyInputDigest: digest1,
      runtimeImage: 'node:22-bookworm-slim', // image changed
      platformArch: 'x64',
      installerPolicy: 'npm ci --ignore-scripts',
    });
    assert.notStrictEqual(fixtureId1, fixtureIdPolicy);

    assert.throws(
      () => registry.resolveFixture({ fixtureId: fixtureIdPolicy }),
      (err) => err.code === 'DEPENDENCY_FIXTURE_BUILDER_REQUIRED'
    );

    assert.throws(
      () => registry.getFixturePath('../outside'),
      (err) => {
        assert.strictEqual(err.code, 'INVALID_FIXTURE_ID');
        return true;
      }
    );
  } finally {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 2: TI-26 Evidence Replay protection (7-tuple binding)
// ----------------------------------------------------------------------------
test('TI-26: Evidence Replay: R1 PASS is marked stale on R2 (cannot cross-replay)', () => {
  const r1SnapshotDigest = sha256('snapshot:R1');
  const r2SnapshotDigest = sha256('snapshot:R2');
  const baselineOid = '1111111111111111111111111111111111111111';
  const fixtureId = sha256('fixture:node-20');
  const command = 'npm test';

  // R1 passes acceptance
  const evidenceR1 = createEvidenceRecord({
    status: 'PASS',
    tier: 'TierB',
    candidateSnapshotDigest: r1SnapshotDigest,
    baselineOid,
    dependencyFixtureId: fixtureId,
    commandBinding: command,
    acceptanceProfileDigest,
    acceptanceAssetsDigest,
    policySectionDigests,
  });

  // 1. Valid for R1 context
  const verifyR1 = verifyEvidenceReplay(evidenceR1, {
    candidateSnapshotDigest: r1SnapshotDigest,
    baselineOid,
    dependencyFixtureId: fixtureId,
    commandBinding: command,
    acceptanceProfileDigest,
    acceptanceAssetsDigest,
    policySectionDigests,
  });
  assert.strictEqual(verifyR1.valid, true);
  assert.strictEqual(verifyR1.isStale, false);

  const forgedEvidence = { ...evidenceR1, status: 'PASS', evidence_id: 'forged' };
  const verifyForged = verifyEvidenceReplay(forgedEvidence, {
    candidateSnapshotDigest: r1SnapshotDigest,
    baselineOid,
    dependencyFixtureId: fixtureId,
    commandBinding: command,
    acceptanceProfileDigest,
    acceptanceAssetsDigest,
    policySectionDigests,
  });
  assert.strictEqual(verifyForged.valid, false, 'Forged evidence must fail its integrity check');

  // 2. Candidate changes produce R2 -> Attempting to replay R1 PASS fails as STALE!
  const verifyR2 = verifyEvidenceReplay(evidenceR1, {
    candidateSnapshotDigest: r2SnapshotDigest, // New revision snapshot!
    baselineOid,
    dependencyFixtureId: fixtureId,
    commandBinding: command,
    acceptanceProfileDigest,
    acceptanceAssetsDigest,
    policySectionDigests,
  });
  assert.strictEqual(verifyR2.valid, false);
  assert.strictEqual(verifyR2.isStale, true, 'Cross-revision replay must be identified as stale');

  // 3. Baseline drift also invalidates evidence
  const verifyDrift = verifyEvidenceReplay(evidenceR1, {
    candidateSnapshotDigest: r1SnapshotDigest,
    baselineOid: '2222222222222222222222222222222222222222', // Baseline moved!
    dependencyFixtureId: fixtureId,
    commandBinding: command,
    acceptanceProfileDigest,
    acceptanceAssetsDigest,
    policySectionDigests,
  });
  assert.strictEqual(verifyDrift.valid, false);
  assert.strictEqual(verifyDrift.isStale, true);

  const incompleteContext = verifyEvidenceReplay(
    { ...evidenceR1, candidate_snapshot_digest: undefined },
    {}
  );
  assert.strictEqual(incompleteContext.valid, false);
});

// ----------------------------------------------------------------------------
// TEST 3: TI-27 Tier B Baseline Regression Closure neutralizes helper tampering
// ----------------------------------------------------------------------------
test('TI-27: Tier B Baseline Regression Closure overwrites tampered test helpers with authentic baseline', () => {
  const repoDir = makeTempDir('af-ti27-repo-');
  const stagingDir = makeTempDir('af-ti27-staging-');

  try {
    initTestGitRepo(repoDir);
    mkdirSync(join(repoDir, 'tests', 'helpers'), { recursive: true });
    writeFileSync(
      join(repoDir, 'tests', 'helpers', 'auth-checker.js'),
      'export function verify(user) { return user.role === "admin"; }\n'
    );
    writeFileSync(
      join(repoDir, 'tests', 'auth.test.js'),
      'import { verify } from "./helpers/auth-checker.js";\n'
    );
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Baseline with tests'], { cwd: repoDir, stdio: 'pipe' });
    const baselineOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // In staging workspace, simulate candidate tampering with helper to fake PASS:
    mkdirSync(join(stagingDir, 'tests', 'helpers'), { recursive: true });
    writeFileSync(
      join(stagingDir, 'tests', 'helpers', 'auth-checker.js'),
      'export function verify(user) { return true; /* TAMPERED */ }\n'
    );
    assert.ok(
      readFileSync(join(stagingDir, 'tests', 'helpers', 'auth-checker.js'), 'utf8').includes('TAMPERED')
    );

    // Tier B executes: injects Baseline Regression Closure (RO) from baselineOid
    const injected = injectBaselineRegressionClosure({
      repoDir,
      baselineOid,
      stagingDir,
      testPathPatterns: ['tests/**'],
    });

    assert.ok(injected.includes('tests/helpers/auth-checker.js'));
    assert.strictEqual(
      statSync(join(stagingDir, 'tests', 'helpers', 'auth-checker.js')).mode & 0o777,
      0o444,
      'baseline regression assets must be read-only in acceptance staging'
    );

    // Verify: Tampered helper is replaced with authentic baseline helper!
    const restoredContent = readFileSync(join(stagingDir, 'tests', 'helpers', 'auth-checker.js'), 'utf8');
    assert.strictEqual(
      restoredContent,
      'export function verify(user) { return user.role === "admin"; }\n'
    );
    assert.strictEqual(restoredContent.includes('TAMPERED'), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('TI-27: Baseline Regression Closure rejects symlinked staging parents', () => {
  const repoDir = makeTempDir('af-ti27-symlink-repo-');
  const stagingDir = makeTempDir('af-ti27-symlink-staging-');
  const outsideDir = makeTempDir('af-ti27-symlink-outside-');

  try {
    initTestGitRepo(repoDir);
    mkdirSync(join(repoDir, 'tests'));
    writeFileSync(join(repoDir, 'tests', 'helper.js'), 'export const trusted = true;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Baseline'], { cwd: repoDir, stdio: 'pipe' });
    const baselineOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    symlinkSync(outsideDir, join(stagingDir, 'tests'));
    assert.throws(
      () => injectBaselineRegressionClosure({ repoDir, baselineOid, stagingDir, testPathPatterns: ['tests/**'] }),
      (err) => {
        assert.strictEqual(err.code, 'ACCEPTANCE_STAGING_PATH_UNSAFE');
        return true;
      }
    );
    assert.strictEqual(existsSync(join(outsideDir, 'helper.js')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 4: TI-18 Acceptance staging never touches canonical .git & disposable git
// ----------------------------------------------------------------------------
test('TI-18: Acceptance staging has NO canonical .git; disposable git is sanitized', () => {
  const stagingDir = makeTempDir('af-ti18-staging-');

  try {
    writeFileSync(join(stagingDir, 'app.js'), 'console.log(1);\n');
    assert.strictEqual(existsSync(join(stagingDir, '.git')), false, 'Staging must not contain canonical .git');

    // If runner requires git, initialize disposable sanitized repo
    initSanitizedDisposableGit(stagingDir);

    assert.strictEqual(existsSync(join(stagingDir, '.git')), true);

    // Verify: No remotes, no canonical tracking
    const remotes = execFileSync('git', ['remote'], { cwd: stagingDir, encoding: 'utf8' }).trim();
    assert.strictEqual(remotes, '', 'Disposable git must have no remotes');
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
});

test('TI-11: Acceptance pipeline only accepts a branded allowlisted runner', async () => {
  const stagingDir = makeTempDir('af-ti11-staging-');
  writeFileSync(join(stagingDir, 'ok.test.mjs'), "import { test } from 'node:test'; test('ok', () => {});\n");
  const runner = createTrustedAcceptanceRunner({
    task: {
      task_id: 'TASK-TI11',
      fixture_dir: stagingDir,
      acceptance_cmd: { command: 'node', args: ['--test', 'ok.test.mjs'] },
    },
  });

  const args = {
    tier: 'TierA',
    stagingDir,
    baselineOid: '1'.repeat(40),
    candidateSnapshotDigest: sha256('ti11-snapshot'),
    dependencyFixtureId: sha256('ti11-fixture'),
    acceptanceProfileDigest: 'profile:ti11',
    acceptanceAssetsDigest: 'assets:ti11',
    policySectionDigests: { acceptance: 'ti11' },
  };
  const evidence = await runAcceptancePipeline({ ...args, trustedRunner: runner });
  assert.strictEqual(evidence.status, 'PASS');

  await assert.rejects(
    () => runAcceptancePipeline({ ...args, trustedRunner: async () => ({ ok: true }) }),
    (err) => err.code === 'ACCEPTANCE_RUNNER_UNTRUSTED'
  );
});

// ----------------------------------------------------------------------------
// TEST 5: TI-23 Pre-acceptance closure blocks acceptance on unresolved DENY
// ----------------------------------------------------------------------------
test('TI-23: Pre-acceptance closure blocks acceptance when unresolved DENY exists', () => {
  // Gate outcome with an unresolved DENY
  const dirtyGateOutcome = {
    verdict: 'DENIED',
    blockingObligations: [{ path: '.env', decision: 'DENY', reason: 'import.deny' }],
    needsHuman: [],
  };

  assert.throws(
    () => assertPreAcceptanceClosure(dirtyGateOutcome),
    (err) => {
      assert.strictEqual(err.code, 'PRE_ACCEPTANCE_CLOSURE_FAILED');
      return true;
    }
  );

  // Clean gate outcome passes pre-acceptance closure
  const cleanGateOutcome = {
    verdict: 'APPROVED',
    blockingObligations: [],
    needsHuman: [],
  };
  assert.doesNotThrow(() => assertPreAcceptanceClosure(cleanGateOutcome));
});

// ----------------------------------------------------------------------------
// TEST 6: TI-31 Diagnostic vs Promotion decoupling
// ----------------------------------------------------------------------------
test('TI-31: Diagnostic dry-run runs during DENY, but promotion acceptance is strictly blocked', () => {
  const wsDir = makeTempDir('af-ti31-ws-');

  try {
    writeFileSync(join(wsDir, 'app.js'), 'const a = 1;');

    // 1. Diagnostic Dry-run executes and returns compiler/test stack trace
    const mockRunner = (cwd, cmd) => ({
      exitCode: 1,
      stdout: 'Compile error at app.js:1: parse error',
      stderr: '',
    });

    const diagResult = runDiagnosticDryrun({
      workspaceDir: wsDir,
      command: 'npm run build',
      commandRunner: mockRunner,
      viewMode: 'exact-candidate',
    });

    assert.strictEqual(diagResult.permitted_for_promotion, false);
    assert.strictEqual(diagResult.diagnostic_output.exitCode, 1);
    assert.ok(diagResult.diagnostic_output.stdout.includes('Compile error'));

    // 2. Diagnostic result CANNOT be used for promotion acceptance
    assert.throws(
      () => assertPromotionNotPermittedFromDiagnostic(diagResult),
      (err) => {
        assert.strictEqual(err.code, 'PROMOTION_DISALLOWED_FOR_DIAGNOSTIC');
        return true;
      }
    );
  } finally {
    rmSync(wsDir, { recursive: true, force: true });
  }
});
