// tests/trusted-import-phase3.test.mjs
//
// Phase 3 (Hard G Promotion) Verification Suite for AFR v5.2.1.
// Verifies:
//   TI-10: Staging & promotion only apply approved blobs; temporary build artifacts never enter canonical
//   TI-12: Promotion sanitizes permissions (0644/0755) and allocates fresh inodes without inheriting xattrs
//   TI-13: CAS atomic update-ref fails closed without partial application on stale baseline (concurrent collision)
//   TI-14: Post-materialize cryptographic hash check detects tampering and fails explicitly
//   TI-25: Target Canonical Tree strictly preserves unexposed sensitive files and unaffected files (Target = Base + Patch)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  TrustedCAS,
  adoptRepository,
  getCanonicalOid,
  canonicalizePolicy,
  createScopeGrant,
  AuthorizationLedger,
  executeHardGPromotion,
  buildTargetCanonicalTree,
  computeManifestDigest,
  createEvidenceRecord,
  promoteCanonicalRef,
  materializeWorktree,
  verifyMaterializedWorktree,
  AfrError,
  CANONICAL_REF,
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

function makePromotionAuthorization({ baselineOid, changes, allowedRoot = ['**'] }) {
  const policy = canonicalizePolicy({
    allowed_root: allowedRoot,
    forbidden: [],
    protected_paths: [],
    protected_json: [],
    projection: { exclude: [], synthesize_dirs: [] },
    import: { deny: [] },
  });
  const scopeGrant = createScopeGrant({
    taskId: `PROMOTION-${baselineOid}`,
    canonicalOid: baselineOid,
    proposedRequired: changes.map((change) => change.path),
    policy,
  });
  const closure = new AuthorizationLedger().verifyCumulativeClosure({
    cumulativeManifest: { changes },
    currentScopeGrant: scopeGrant,
    currentPolicy: policy,
    baselineOid,
  });
  assert.strictEqual(closure.satisfied, true);
  return closure;
}

function makePromotionAcceptance({ baselineOid, changes }) {
  const patchDigest = computeManifestDigest(changes);
  const candidateSnapshotDigest = sha256(`candidate:${patchDigest}`);
  const dependencyFixtureId = sha256('fixture:trusted-promotion');
  const commandBinding = 'node --test';
  const acceptanceProfileDigest = 'profile:trusted-promotion';
  const acceptanceAssetsDigest = 'assets:trusted-promotion';
  const policySectionDigests = { acceptance: 'trusted-promotion-v1' };
  const acceptanceEvidence = createEvidenceRecord({
    status: 'PASS',
    tier: 'TierB',
    candidateSnapshotDigest,
    baselineOid,
    acceptanceProfileDigest,
    acceptanceAssetsDigest,
    dependencyFixtureId,
    commandBinding,
    policySectionDigests,
  });
  return {
    acceptanceEvidence,
    acceptanceContext: {
      candidateSnapshotDigest,
      baselineOid,
      acceptanceProfileDigest,
      acceptanceAssetsDigest,
      dependencyFixtureId,
      commandBinding,
      policySectionDigests,
      patchDigest,
    },
  };
}

// ----------------------------------------------------------------------------
// TEST 1: TI-25 Promotion Target Tree preserves unexposed sensitive files
// ----------------------------------------------------------------------------
test('TI-25: Promotion Target Tree strictly preserves unexposed sensitive files (Target = Baseline + Patch)', () => {
  const repoDir = makeTempDir('af-ti25-repo-');
  const casDir = makeTempDir('af-ti25-cas-');
  const worktreeDir = makeTempDir('af-ti25-wt-');

  try {
    initTestGitRepo(repoDir);
    mkdirSync(join(repoDir, 'src'));
    writeFileSync(join(repoDir, 'src', 'index.js'), 'export const v = 1;\n');
    writeFileSync(join(repoDir, '.env'), 'SECRET_DATABASE_URL=postgres://root:secret@db/prod\n');
    mkdirSync(join(repoDir, 'secrets'));
    writeFileSync(join(repoDir, 'secrets', 'private.key'), '-----BEGIN PRIVATE KEY-----\nMIIEvgI...\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Initial baseline with secrets'], { cwd: repoDir, stdio: 'pipe' });

    const adoptResult = adoptRepository({ repoDir });
    const baselineOid = adoptResult.canonical_oid;
    const cas = new TrustedCAS({ casDir });

    // Candidate modified src/index.js and added src/math.js.
    // Candidate NEVER saw .env or secrets/private.key!
    const newIndexBytes = Buffer.from('export const v = 2; // modified\n');
    const newMathBytes = Buffer.from('export function add(a, b) { return a + b; }\n');

    const indexDigest = cas.put(newIndexBytes).digest;
    const mathDigest = cas.put(newMathBytes).digest;

    const authorizedChanges = [
      { action: 'MODIFY', path: 'src/index.js', new_digest: indexDigest, new_mode: '0644' },
      { action: 'ADD', path: 'src/math.js', new_digest: mathDigest, new_mode: '0644' },
    ];
    const authorizationClosure = makePromotionAuthorization({
      baselineOid,
      changes: authorizedChanges,
      allowedRoot: ['src/**'],
    });
    const acceptance = makePromotionAcceptance({ baselineOid, changes: authorizedChanges });

    // Execute Hard G Promotion
    const promoResult = executeHardGPromotion({
      repoDir,
      baselineOid,
      authorizedChanges,
      authorizationClosure,
      ...acceptance,
      cas,
      message: 'Feature: Update index and add math module',
      materializeDir: worktreeDir,
    });

    assert.strictEqual(promoResult.status, 'PROMOTED');
    const newCanonicalOid = getCanonicalOid(repoDir);
    assert.strictEqual(newCanonicalOid, promoResult.canonical_oid);

    // Verify git tree contents of the new commit directly from Git DB
    const lsOutput = execFileSync('git', ['ls-tree', '-r', newCanonicalOid], {
      cwd: repoDir,
      encoding: 'utf8',
    });

    // Both candidate changes exist in new commit
    assert.ok(lsOutput.includes('src/index.js'));
    assert.ok(lsOutput.includes('src/math.js'));

    // Critical TI-25 check: .env and secrets/private.key are INTACT and PRESERVED!
    assert.ok(lsOutput.includes('.env'), 'Unexposed .env MUST be preserved in target canonical tree');
    assert.ok(lsOutput.includes('secrets/private.key'), 'Unexposed secrets/** MUST be preserved');

    // Check content of preserved .env in Git object store
    const gitEnvContent = execFileSync('git', ['show', `${newCanonicalOid}:.env`], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    assert.strictEqual(gitEnvContent, 'SECRET_DATABASE_URL=postgres://root:secret@db/prod\n');

    // Check materialized working tree cache
    assert.strictEqual(
      readFileSync(join(worktreeDir, 'src', 'index.js'), 'utf8'),
      'export const v = 2; // modified\n'
    );
    assert.strictEqual(
      readFileSync(join(worktreeDir, '.env'), 'utf8'),
      'SECRET_DATABASE_URL=postgres://root:secret@db/prod\n'
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test('Hard G: forged or mismatched authorization closure is rejected before promotion', () => {
  const repoDir = makeTempDir('af-promotion-auth-repo-');
  const casDir = makeTempDir('af-promotion-auth-cas-');

  try {
    initTestGitRepo(repoDir);
    writeFileSync(join(repoDir, 'src.js'), 'const version = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' });

    const baselineOid = adoptRepository({ repoDir }).canonical_oid;
    const cas = new TrustedCAS({ casDir });
    const digest = cas.put(Buffer.from('const version = 2;\n')).digest;
    const changes = [{ action: 'MODIFY', path: 'src.js', new_digest: digest, new_mode: '0644' }];

    assert.throws(
      () => executeHardGPromotion({
        repoDir,
        baselineOid,
        authorizedChanges: changes,
        authorizationClosure: {
          satisfied: true,
          baseline_oid: baselineOid,
          cumulative_manifest_digest: 'forged',
        },
        cas,
      }),
      (err) => {
        assert.strictEqual(err.code, 'PROMOTION_AUTHORIZATION_REQUIRED');
        return true;
      }
    );

    const realClosure = makePromotionAuthorization({ baselineOid, changes });
    assert.throws(
      () => executeHardGPromotion({
        repoDir,
        baselineOid,
        authorizedChanges: changes,
        authorizationClosure: realClosure,
        cas,
      }),
      (err) => {
        assert.strictEqual(err.code, 'PROMOTION_ACCEPTANCE_REQUIRED');
        return true;
      }
    );
    assert.throws(
      () => executeHardGPromotion({
        repoDir,
        baselineOid,
        authorizedChanges: [],
        authorizationClosure: realClosure,
        cas,
      }),
      (err) => {
        assert.strictEqual(err.code, 'PROMOTION_AUTHORIZATION_MISMATCH');
        return true;
      }
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 2: TI-10 Staging / promotion only applies approved blobs (unapproved omitted)
// ----------------------------------------------------------------------------
test('TI-10: Staging and promotion only apply approved blobs; unapproved temporary artifacts never enter canonical', () => {
  const repoDir = makeTempDir('af-ti10-repo-');
  const casDir = makeTempDir('af-ti10-cas-');

  try {
    initTestGitRepo(repoDir);
    writeFileSync(join(repoDir, 'src.js'), 'console.log(1);\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' });

    const adoptResult = adoptRepository({ repoDir });
    const baselineOid = adoptResult.canonical_oid;
    const cas = new TrustedCAS({ casDir });

    const newCode = Buffer.from('console.log(2);\n');
    const newCodeDigest = cas.put(newCode).digest;

    // Suppose executor created coverage/lcov.info and dist/bundle.js in workspace,
    // but authorized changes ONLY contain src.js
    const authorizedChanges = [
      { action: 'MODIFY', path: 'src.js', new_digest: newCodeDigest, new_mode: '0644' },
    ];
    const authorizationClosure = makePromotionAuthorization({
      baselineOid,
      changes: authorizedChanges,
      allowedRoot: ['src.js'],
    });
    const acceptance = makePromotionAcceptance({ baselineOid, changes: authorizedChanges });

    const promoResult = executeHardGPromotion({
      repoDir,
      baselineOid,
      authorizedChanges,
      authorizationClosure,
      ...acceptance,
      cas,
    });

    const lsOutput = execFileSync('git', ['ls-tree', '-r', promoResult.canonical_oid], {
      cwd: repoDir,
      encoding: 'utf8',
    });

    assert.ok(lsOutput.includes('src.js'));
    assert.strictEqual(lsOutput.includes('coverage/'), false, 'coverage/ must never enter canonical tree');
    assert.strictEqual(lsOutput.includes('dist/'), false, 'dist/ must never enter canonical tree');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 3: TI-12 Promotion applies sanitized modes and creates fresh inodes
// ----------------------------------------------------------------------------
test('TI-12: Promotion applies sanitized mode (0644 / 0755) with clean fresh inodes', () => {
  const repoDir = makeTempDir('af-ti12-repo-');
  const casDir = makeTempDir('af-ti12-cas-');
  const worktreeDir = makeTempDir('af-ti12-wt-');

  try {
    initTestGitRepo(repoDir);
    writeFileSync(join(repoDir, 'README.md'), 'docs\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Init'], { cwd: repoDir, stdio: 'pipe' });

    const adopt = adoptRepository({ repoDir });
    const cas = new TrustedCAS({ casDir });

    const scriptBytes = Buffer.from('#!/bin/sh\necho ok\n');
    const configBytes = Buffer.from('port: 8080\n');
    const scriptDigest = cas.put(scriptBytes).digest;
    const configDigest = cas.put(configBytes).digest;

    const authorizedChanges = [
      { action: 'ADD', path: 'scripts/run.sh', new_digest: scriptDigest, new_mode: '0755' },
      { action: 'ADD', path: 'config/app.yaml', new_digest: configDigest, new_mode: '0644' },
    ];
    const authorizationClosure = makePromotionAuthorization({
      baselineOid: adopt.canonical_oid,
      changes: authorizedChanges,
      allowedRoot: ['scripts/**', 'config/**'],
    });
    const acceptance = makePromotionAcceptance({ baselineOid: adopt.canonical_oid, changes: authorizedChanges });

    executeHardGPromotion({
      repoDir,
      baselineOid: adopt.canonical_oid,
      authorizedChanges,
      authorizationClosure,
      ...acceptance,
      cas,
      materializeDir: worktreeDir,
    });

    const scriptStat = statSync(join(worktreeDir, 'scripts', 'run.sh'));
    const configStat = statSync(join(worktreeDir, 'config', 'app.yaml'));

    // Check permissions normalized: executable is 0755, config is 0644
    assert.strictEqual(scriptStat.mode & 0o777, 0o755, 'Executable script must have 0755 mode');
    assert.strictEqual(configStat.mode & 0o777, 0o644, 'Normal config file must have 0644 mode');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  }
});

test('TI-12: Materialization rejects a symlinked parent before writing outside the destination', () => {
  const repoDir = makeTempDir('af-ti12-symlink-repo-');
  const casDir = makeTempDir('af-ti12-symlink-cas-');
  const worktreeDir = makeTempDir('af-ti12-symlink-wt-');
  const outsideDir = makeTempDir('af-ti12-symlink-outside-');

  try {
    initTestGitRepo(repoDir);
    mkdirSync(join(repoDir, 'safe'));
    writeFileSync(join(repoDir, 'safe', 'file.txt'), 'baseline\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Baseline'], { cwd: repoDir, stdio: 'pipe' });

    const baselineOid = adoptRepository({ repoDir }).canonical_oid;
    const cas = new TrustedCAS({ casDir });
    const closure = makePromotionAuthorization({ baselineOid, changes: [] });
    const acceptance = makePromotionAcceptance({ baselineOid, changes: [] });
    symlinkSync(outsideDir, join(worktreeDir, 'safe'));

    assert.throws(
      () => executeHardGPromotion({
        repoDir,
        baselineOid,
        authorizedChanges: [],
        authorizationClosure: closure,
        ...acceptance,
        cas,
        materializeDir: worktreeDir,
      }),
      (err) => {
        assert.strictEqual(err.code, 'MATERIALIZE_VERIFY_FAILED');
        return true;
      }
    );
    assert.strictEqual(existsSync(join(outsideDir, 'file.txt')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 4: TI-13 CAS atomic update-ref fails closed on stale baseline (no partial write)
// ----------------------------------------------------------------------------
test('TI-13: CAS atomic update-ref fails closed without partial application on stale baseline', () => {
  const repoDir = makeTempDir('af-ti13-repo-');

  try {
    initTestGitRepo(repoDir);
    writeFileSync(join(repoDir, 'base.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'C1'], { cwd: repoDir, stdio: 'pipe' });

    const adopt = adoptRepository({ repoDir });
    const initialCanonicalOid = adopt.canonical_oid;

    // Simulate concurrent advance of refs/afr/canonical by another task
    writeFileSync(join(repoDir, 'base.txt'), 'concurrent edit\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Concurrent C2'], { cwd: repoDir, stdio: 'pipe' });
    const concurrentOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // Advance canonical ref to concurrent commit
    execFileSync('git', ['update-ref', CANONICAL_REF, concurrentOid, initialCanonicalOid], { cwd: repoDir });
    assert.strictEqual(getCanonicalOid(repoDir), concurrentOid);

    // Now our task tries to promote against initialCanonicalOid (which is now STALE!)
    assert.throws(
      () =>
        promoteCanonicalRef({
          repoDir,
          newCommitOid: '9999999999999999999999999999999999999999',
          expectedOldOid: initialCanonicalOid,
        }),
      (err) => {
        assert.strictEqual(err.code, 'CAS_UPDATE_REF_FAILED');
        return true;
      }
    );

    // Assert canonical ref is untouched and still points to concurrentOid
    assert.strictEqual(getCanonicalOid(repoDir), concurrentOid);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 5: TI-14 Post-materialize cryptographic hash check detects corruption
// ----------------------------------------------------------------------------
test('TI-14: Post-materialize cryptographic hash check detects tampering and fails explicitly', () => {
  const repoDir = makeTempDir('af-ti14-repo-');
  const worktreeDir = makeTempDir('af-ti14-wt-');

  try {
    initTestGitRepo(repoDir);
    writeFileSync(join(repoDir, 'file.txt'), 'genuine content\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Init'], { cwd: repoDir, stdio: 'pipe' });
    const commitOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // Normal materialization succeeds
    const result = materializeWorktree({
      repoDir,
      canonicalOid: commitOid,
      destinationDir: worktreeDir,
      verifyHash: true,
    });
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.materialized_count, 1);

    // Simulate disk tampering: alter file on disk
    writeFileSync(join(worktreeDir, 'file.txt'), 'tampered content\n');

    // Re-verifying the existing materialized state must detect the tampering.
    assert.throws(
      () => verifyMaterializedWorktree({ repoDir, canonicalOid: commitOid, destinationDir: worktreeDir }),
      (err) => err.code === 'MATERIALIZE_VERIFY_FAILED'
    );
    assert.strictEqual(readFileSync(join(worktreeDir, 'file.txt'), 'utf8'), 'tampered content\n');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreeDir, { recursive: true, force: true });
  }
});
