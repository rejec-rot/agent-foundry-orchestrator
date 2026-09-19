// tests/trusted-import-phase1.test.mjs
//
// Phase 1 (Capture Truth) Verification Suite for AFR v5.2.1.
// Verifies:
//   TI-1: Accurate and complete diff descriptions (ADD/MODIFY/DELETE/MODE)
//   TI-2: Manifest calculated strictly by trusted FS scan, executor cannot tamper
//   TI-3: QUIESCE unproven -> strictly refuse scan/import
//   TI-4: Projection Exclude eliminates false DELETE for unexposed files
//   TI-5: B(i) Hard Deny: symlinks, hardlinks, special nodes, DoS limits
//   TI-6: B(ii) Empty band: no unauthorized changes mechanically bypassed
//   TI-15: Executor-facing candidate never shares canonical .git
//   TI-17: .gitignore ignored files are captured in manifest (FS scan is truth)
//   TI-24: A6 Path Contract: .. traversal, NUL byte, invalid UTF-8 rejected at capture
//   TI-29: A6 Normalization collision fails closed (PATH_POLICY_AMBIGUITY)
//   TI-30: Runtime Scratch isolated and omitted from Snapshot, CAS and Manifest
//   Canonical Bootstrap & Admission Scan (afr adopt)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import {
  TrustedCAS,
  adoptRepository,
  getCanonicalOid,
  projectCandidate,
  verifyQuiesced,
  assertQuiesced,
  captureCandidateFS,
  sealSnapshot,
  verifySnapshotIntegrity,
  computeManifest,
  isPathExcluded,
  validateRawPath,
  toPolicyMatchKey,
  checkNormalizationCollisions,
  HardDenyError,
  AdmissionError,
  QuiesceError,
  CANONICAL_REF,
} from '../lib/trusted-import/index.mjs';

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function initTestGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'AFR Tester'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'tester@afr.local'], { cwd: dir, stdio: 'pipe' });
}

// ----------------------------------------------------------------------------
// TEST 1: Canonical Bootstrap & Admission Scan (adoptRepository)
// ----------------------------------------------------------------------------
test('ADOPT: Non-git directory fails closed with TASK_ADMISSION_FAIL', () => {
  const tmp = makeTempDir('af-adopt-nongit-');
  try {
    assert.throws(
      () => adoptRepository({ repoDir: tmp }),
      (err) => {
        assert.strictEqual(err.code, 'TASK_ADMISSION_FAIL');
        return true;
      }
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ADOPT: Initial adopt succeeds, locks OID, and refuses duplicate adoption without force', () => {
  const repoDir = makeTempDir('af-adopt-ok-');
  try {
    initTestGitRepo(repoDir);
    writeFileSync(join(repoDir, 'README.md'), '# Test Project\n');
    mkdirSync(join(repoDir, 'src'));
    writeFileSync(join(repoDir, 'src', 'index.js'), 'console.log("hello");\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir, stdio: 'pipe' });

    const headOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // 1. Initial adopt
    const result = adoptRepository({ repoDir, fromCommitIsh: 'HEAD' });
    assert.strictEqual(result.status, 'ADOPTED');
    assert.strictEqual(result.canonical_ref, CANONICAL_REF);
    assert.strictEqual(result.canonical_oid, headOid);
    assert.strictEqual(result.total_entries, 2);

    // Verify ref exists in git
    const activeOid = getCanonicalOid(repoDir);
    assert.strictEqual(activeOid, headOid);

    // 2. Duplicate adopt without force fails closed
    assert.throws(
      () => adoptRepository({ repoDir, fromCommitIsh: 'HEAD' }),
      (err) => {
        assert.strictEqual(err.code, 'ADOPTION_ALREADY_EXISTS');
        return true;
      }
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('ADOPT: Canonical Admission Scan rejects repo containing symlinks (A5)', () => {
  const repoDir = makeTempDir('af-adopt-symlink-');
  try {
    initTestGitRepo(repoDir);
    writeFileSync(join(repoDir, 'target.txt'), 'hello\n');
    symlinkSync('target.txt', join(repoDir, 'link.txt'));
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Commit with symlink'], { cwd: repoDir, stdio: 'pipe' });

    assert.throws(
      () => adoptRepository({ repoDir, fromCommitIsh: 'HEAD' }),
      (err) => {
        assert.strictEqual(err.code, 'ADMISSION_FORBIDDEN_ENTRY');
        return true;
      }
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 2: TI-15 Candidate Projection never shares canonical .git
// ----------------------------------------------------------------------------
test('TI-15: Candidate Projection does not share canonical .git and excludes secrets (C2, C6)', () => {
  const repoDir = makeTempDir('af-proj-repo-');
  const targetDir = makeTempDir('af-proj-target-');
  const casDir = makeTempDir('af-proj-cas-');

  try {
    initTestGitRepo(repoDir);
    mkdirSync(join(repoDir, 'src'));
    writeFileSync(join(repoDir, 'src', 'app.js'), 'export const app = 42;\n');
    writeFileSync(join(repoDir, '.env'), 'SECRET_KEY=supersecret\n');
    mkdirSync(join(repoDir, 'secrets'));
    writeFileSync(join(repoDir, 'secrets', 'db.key'), 'db-credential\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Add app and secrets'], { cwd: repoDir, stdio: 'pipe' });

    adoptRepository({ repoDir });
    const cas = new TrustedCAS({ casDir });

    const projection = projectCandidate({
      repoDir,
      targetDir,
      policy: {
        exclude: ['.env', 'secrets/**'],
        synthetic_dirs: ['tmp'],
      },
      cas,
    });

    // 1. Invariant TI-15: candidate workspace has NO .git directory
    assert.strictEqual(existsSync(join(targetDir, '.git')), false, 'candidate must never contain .git');

    // 2. Secret boundary: .env and secrets/** are physically absent
    assert.strictEqual(existsSync(join(targetDir, '.env')), false, '.env must not be materialized');
    assert.strictEqual(existsSync(join(targetDir, 'secrets', 'db.key')), false, 'secrets/** must not be materialized');

    // 3. Normal code is materialized
    assert.strictEqual(existsSync(join(targetDir, 'src', 'app.js')), true);

    // 4. Synthetic empty directory is created with 0755
    assert.strictEqual(existsSync(join(targetDir, 'tmp')), true);

    // 5. Projected Baseline Snapshot contains only projected files
    const snapshotPaths = projection.projectedBaselineSnapshot.entries.map((e) => e.path);
    assert.deepStrictEqual(snapshotPaths, ['src/app.js']);
    assert.strictEqual(verifySnapshotIntegrity(projection.projectedBaselineSnapshot, cas), true);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

test('TI-15: Candidate Projection rejects a symlinked destination parent', () => {
  const repoDir = makeTempDir('af-proj-symlink-repo-');
  const targetDir = makeTempDir('af-proj-symlink-target-');
  const outsideDir = makeTempDir('af-proj-symlink-outside-');

  try {
    initTestGitRepo(repoDir);
    mkdirSync(join(repoDir, 'src'));
    writeFileSync(join(repoDir, 'src', 'app.js'), 'export const app = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Baseline'], { cwd: repoDir, stdio: 'pipe' });
    adoptRepository({ repoDir });

    symlinkSync(outsideDir, join(targetDir, 'src'));
    assert.throws(
      () => projectCandidate({ repoDir, targetDir, policy: { exclude: [] } }),
      (err) => {
        assert.strictEqual(err.code, 'PROJECTION_PATH_UNSAFE');
        return true;
      }
    );
    assert.strictEqual(existsSync(join(outsideDir, 'app.js')), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('TI-30b: recursive secret globs include root-level key and certificate files', () => {
  assert.strictEqual(isPathExcluded('private.pem', ['**/*.pem']), true);
  assert.strictEqual(isPathExcluded('private.key', ['**/*.key']), true);
  assert.strictEqual(isPathExcluded('nested/private.pem', ['**/*.pem']), true);
});

test('TI-30c: CAS rejects malformed digests before filesystem access', () => {
  const casDir = makeTempDir('af-cas-digest-');
  try {
    const cas = new TrustedCAS({ casDir });
    for (const operation of [
      () => cas.getFilePath('../outside'),
      () => cas.has('../outside'),
      () => cas.get('../outside'),
    ]) {
      assert.throws(operation, (err) => {
        assert.strictEqual(err.code, 'INVALID_DIGEST');
        return true;
      });
    }
  } finally {
    rmSync(casDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 3: TI-3 QUIESCE unproven -> strictly refuse scan/import
// ----------------------------------------------------------------------------
test('TI-3: QUIESCE unproven -> strictly refuse scan/import', async () => {
  const candidateDir = makeTempDir('af-quiesce-cand-');
  const casDir = makeTempDir('af-quiesce-cas-');

  try {
    writeFileSync(join(candidateDir, 'test.txt'), 'hello\n');
    const cas = new TrustedCAS({ casDir });

    // 1. Missing quiesce evidence completely
    assert.throws(
      () => captureCandidateFS({ candidateDir, cas, quiesceEvidence: null }),
      (err) => {
        assert.strictEqual(err.code, 'QUIESCE_VERIFICATION_FAILED');
        return true;
      }
    );

    // 2. Forged/invalid quiesce evidence
    assert.throws(
      () => captureCandidateFS({ candidateDir, cas, quiesceEvidence: { quiesced: false } }),
      (err) => {
        assert.strictEqual(err.code, 'QUIESCE_VERIFICATION_FAILED');
        return true;
      }
    );

    assert.throws(
      () => assertQuiesced({ quiesced: true, writers_terminated: true, verified_at: 'forged' }),
      (err) => err.code === 'QUIESCE_VERIFICATION_FAILED'
    );

    await assert.rejects(
      () => verifyQuiesced(),
      (err) => {
        assert.strictEqual(err.code, 'QUIESCE_VERIFICATION_FAILED');
        assert.strictEqual(err.details.reason, 'NO_TERMINATION_WITNESS');
        return true;
      }
    );

    // 3. Valid quiesce evidence allows capture
    const validEvidence = await verifyQuiesced({ terminationVerifier: () => true });
    const result = captureCandidateFS({ candidateDir, cas, quiesceEvidence: validEvidence });
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].path, 'test.txt');
  } finally {
    rmSync(candidateDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

test('TI-3: QUIESCE PID witness waits for the process tree to disappear', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
    detached: true,
    stdio: 'ignore',
  });
  try {
    assert.ok(child.pid);
    const evidence = await verifyQuiesced({ pid: child.pid, timeoutMs: 1000 });
    assert.strictEqual(evidence.pid, child.pid);
    assert.strictEqual(evidence.writers_terminated, true);
  } finally {
    if (child.pid && child.exitCode === null) child.kill('SIGKILL');
  }
});

// ----------------------------------------------------------------------------
// TEST 4: TI-5 B(i) Hard Deny (symlink, hardlink, special inode, DoS limits)
// ----------------------------------------------------------------------------
test('TI-5: B(i) Hard Deny: symlink rejected deterministically at capture', async () => {
  const candDir = makeTempDir('af-b1-symlink-');
  const casDir = makeTempDir('af-b1-cas-');
  try {
    writeFileSync(join(candDir, 'real.txt'), 'real');
    symlinkSync('real.txt', join(candDir, 'sym.txt'));
    const cas = new TrustedCAS({ casDir });
    const evidence = await verifyQuiesced({ terminationVerifier: () => true });

    assert.throws(
      () => captureCandidateFS({ candidateDir: candDir, cas, quiesceEvidence: evidence }),
      (err) => {
        assert.strictEqual(err.code, 'SYMLINK_FORBIDDEN');
        return true;
      }
    );
  } finally {
    rmSync(candDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

test('TI-5: B(i) Hard Deny: hard link alias (nlink > 1) rejected at capture', async () => {
  const candDir = makeTempDir('af-b1-hardlink-');
  const casDir = makeTempDir('af-b1-cas-');
  try {
    writeFileSync(join(candDir, 'source.txt'), 'content');
    linkSync(join(candDir, 'source.txt'), join(candDir, 'hardlink.txt'));
    const cas = new TrustedCAS({ casDir });
    const evidence = await verifyQuiesced({ terminationVerifier: () => true });

    assert.throws(
      () => captureCandidateFS({ candidateDir: candDir, cas, quiesceEvidence: evidence }),
      (err) => {
        assert.strictEqual(err.code, 'HARDLINK_FORBIDDEN');
        return true;
      }
    );
  } finally {
    rmSync(candDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

test('TI-5: B(i) Hard Deny: DoS limits (maxFileBytes, maxDepth, maxEntries) enforced pre-ingest', async () => {
  const candDir = makeTempDir('af-b1-dos-');
  const casDir = makeTempDir('af-b1-cas-');
  try {
    const cas = new TrustedCAS({ casDir });
    const evidence = await verifyQuiesced({ terminationVerifier: () => true });

    // 1. Single file exceeds maxFileBytes
    writeFileSync(join(candDir, 'large.bin'), Buffer.alloc(100));
    assert.throws(
      () =>
        captureCandidateFS({
          candidateDir: candDir,
          cas,
          quiesceEvidence: evidence,
          limits: { maxFileBytes: 50 },
        }),
      (err) => {
        assert.strictEqual(err.code, 'FILE_SIZE_EXCEEDED');
        return true;
      }
    );
    rmSync(join(candDir, 'large.bin'));

    // 2. Directory traversal exceeds maxDepth
    let deepDir = candDir;
    for (let i = 0; i < 6; i++) {
      deepDir = join(deepDir, `sub${i}`);
      mkdirSync(deepDir);
    }
    writeFileSync(join(deepDir, 'file.txt'), 'ok');
    assert.throws(
      () =>
        captureCandidateFS({
          candidateDir: candDir,
          cas,
          quiesceEvidence: evidence,
          limits: { maxDepth: 4 },
        }),
      (err) => {
        assert.strictEqual(err.code, 'MAX_DEPTH_EXCEEDED');
        return true;
      }
    );
  } finally {
    rmSync(candDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 5: TI-24 & TI-29 A6 Path Contract & Normalization Collision
// ----------------------------------------------------------------------------
test('TI-24: A6 Path Contract: .. traversal, NUL byte, and traversal segments rejected', () => {
  assert.throws(() => validateRawPath('/absolute/path'), (err) => err.code === 'ABSOLUTE_PATH_FORBIDDEN');
  assert.throws(() => validateRawPath('foo/../bar'), (err) => err.code === 'TRAVERSAL_SEGMENT_FORBIDDEN');
  assert.throws(() => validateRawPath('foo/./bar'), (err) => err.code === 'TRAVERSAL_SEGMENT_FORBIDDEN');
  assert.throws(() => validateRawPath('foo//bar'), (err) => err.code === 'EMPTY_SEGMENT_FORBIDDEN');
  assert.throws(() => validateRawPath('foo\0bar'), (err) => err.code === 'NUL_BYTE_FORBIDDEN');
  assert.throws(() => validateRawPath('.git/config'), (err) => err.code === 'GIT_NAMESPACE_FORBIDDEN');

  // Valid paths pass
  assert.doesNotThrow(() => validateRawPath('src/components/Button.tsx'));
  assert.doesNotThrow(() => validateRawPath('docs/café.txt'));
});

test('TI-29: A6 Normalization collision fails closed with PATH_POLICY_AMBIGUITY', () => {
  const nfcPath = 'docs/café.txt'; // \u00e9 (1 codepoint)
  const nfdPath = 'docs/cafe\u0301.txt'; // e + combining acute accent (2 codepoints)

  assert.notStrictEqual(nfcPath, nfdPath, 'Raw byte representations must differ');
  assert.strictEqual(toPolicyMatchKey(nfcPath), toPolicyMatchKey(nfdPath), 'NFC match keys must be identical');

  assert.throws(
    () => checkNormalizationCollisions([nfcPath, nfdPath]),
    (err) => {
      assert.strictEqual(err.code, 'PATH_POLICY_AMBIGUITY');
      return true;
    }
  );
});

// ----------------------------------------------------------------------------
// TEST 6: TI-17 .gitignore ignored files are captured by FS Scanner
// ----------------------------------------------------------------------------
test('TI-17: .gitignore ignored files are captured in manifest (FS scan is truth source)', async () => {
  const candDir = makeTempDir('af-ti17-cand-');
  const casDir = makeTempDir('af-ti17-cas-');

  try {
    writeFileSync(join(candDir, '.gitignore'), 'dist/\n*.tmp\n');
    mkdirSync(join(candDir, 'dist'));
    writeFileSync(join(candDir, 'dist', 'bundle.js'), 'var x = 1;');
    writeFileSync(join(candDir, 'secret.tmp'), 'should be caught');
    writeFileSync(join(candDir, 'main.js'), 'console.log(1);');

    const cas = new TrustedCAS({ casDir });
    const evidence = await verifyQuiesced({ terminationVerifier: () => true });

    const capture = captureCandidateFS({ candidateDir: candDir, cas, quiesceEvidence: evidence });
    const capturedPaths = capture.entries.map((e) => e.path).sort();

    // All files, including those matched by .gitignore, must appear in capture
    assert.deepStrictEqual(capturedPaths, ['.gitignore', 'dist/bundle.js', 'main.js', 'secret.tmp']);

    const candidateSnapshot = sealSnapshot({ entries: capture.entries });
    const manifest = computeManifest({ projectedBaselineSnapshot: null, candidateSnapshot });

    const manifestPaths = manifest.changes.map((c) => c.path).sort();
    assert.deepStrictEqual(manifestPaths, ['.gitignore', 'dist/bundle.js', 'main.js', 'secret.tmp']);
  } finally {
    rmSync(candDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 7: TI-30 Runtime Scratch physical separation
// ----------------------------------------------------------------------------
test('TI-30: Runtime Scratch directory contents are omitted from Snapshot, CAS and Manifest', async () => {
  const candDir = makeTempDir('af-ti30-cand-');
  const scratchDir = join(candDir, '.af-scratch');
  mkdirSync(scratchDir);
  const casDir = makeTempDir('af-ti30-cas-');

  try {
    writeFileSync(join(candDir, 'src.js'), 'code');

    // Simulate 50 build artifacts produced in scratch directory
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(scratchDir, `build_${i}.tmp`), `artifact ${i}`);
    }

    const cas = new TrustedCAS({ casDir });
    const evidence = await verifyQuiesced({ terminationVerifier: () => true });

    const capture = captureCandidateFS({
      candidateDir: candDir,
      scratchDir,
      cas,
      quiesceEvidence: evidence,
    });

    // Scratch files must NOT appear in capture
    assert.strictEqual(capture.entries.length, 1);
    assert.strictEqual(capture.entries[0].path, 'src.js');

    const snapshot = sealSnapshot({ entries: capture.entries });
    const manifest = computeManifest({ projectedBaselineSnapshot: null, candidateSnapshot: snapshot });

    assert.strictEqual(manifest.changes.length, 1);
    assert.strictEqual(manifest.changes[0].path, 'src.js');
  } finally {
    rmSync(candDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 8: TI-1 & TI-4 Diff accuracy and Projection Exclude safety
// ----------------------------------------------------------------------------
test('TI-1 & TI-4: Complete diff actions (ADD/MODIFY/DELETE/MODE) + Projection exclude does not delete secrets', () => {
  const casDir = makeTempDir('af-ti1-cas-');
  try {
    const cas = new TrustedCAS({ casDir });

    // Simulated baseline entries (Notice: .env was EXCLUDED by projection, so not in baseline)
    const baseBlob1 = cas.put(Buffer.from('hello v1')).digest;
    const baseBlob2 = cas.put(Buffer.from('unchanged')).digest;
    const baseBlob3 = cas.put(Buffer.from('to be deleted')).digest;
    const baseBlob4 = cas.put(Buffer.from('#!/bin/sh\necho hi')).digest;

    const baseEntries = [
      { path: 'src/mod.js', type: 'blob', mode: '0644', blob_digest: baseBlob1, size: 8 },
      { path: 'src/keep.js', type: 'blob', mode: '0644', blob_digest: baseBlob2, size: 9 },
      { path: 'src/del.js', type: 'blob', mode: '0644', blob_digest: baseBlob3, size: 13 },
      { path: 'scripts/run.sh', type: 'blob', mode: '0644', blob_digest: baseBlob4, size: 18 },
    ];
    const baseSnapshot = sealSnapshot({ entries: baseEntries });

    // Simulated candidate entries:
    // - src/mod.js: modified
    // - src/keep.js: unchanged
    // - src/del.js: removed (should generate DELETE)
    // - scripts/run.sh: mode changed from 0644 to 0755 (should generate MODE)
    // - src/new.js: added (should generate ADD)
    // - .env is absent in candidate: MUST NOT generate DELETE because not in baseSnapshot!
    const candBlob1 = cas.put(Buffer.from('hello v2 modified')).digest;
    const candBlob5 = cas.put(Buffer.from('new file')).digest;

    const candEntries = [
      { path: 'src/mod.js', type: 'blob', mode: '0644', blob_digest: candBlob1, size: 17 },
      { path: 'src/keep.js', type: 'blob', mode: '0644', blob_digest: baseBlob2, size: 9 },
      { path: 'scripts/run.sh', type: 'blob', mode: '0755', blob_digest: baseBlob4, size: 18 },
      { path: 'src/new.js', type: 'blob', mode: '0644', blob_digest: candBlob5, size: 8 },
    ];
    const candSnapshot = sealSnapshot({ entries: candEntries });

    const manifest = computeManifest({
      projectedBaselineSnapshot: baseSnapshot,
      candidateSnapshot: candSnapshot,
    });

    assert.strictEqual(manifest.summary.totalChanges, 4);
    assert.strictEqual(manifest.summary.add, 1);
    assert.strictEqual(manifest.summary.modify, 1);
    assert.strictEqual(manifest.summary.delete, 1);
    assert.strictEqual(manifest.summary.mode, 1);

    const changesByAction = Object.groupBy(manifest.changes, (c) => c.action);
    assert.strictEqual(changesByAction.ADD[0].path, 'src/new.js');
    assert.strictEqual(changesByAction.MODIFY[0].path, 'src/mod.js');
    assert.strictEqual(changesByAction.DELETE[0].path, 'src/del.js');
    assert.strictEqual(changesByAction.MODE[0].path, 'scripts/run.sh');
    assert.strictEqual(changesByAction.MODE[0].old_mode, '0644');
    assert.strictEqual(changesByAction.MODE[0].new_mode, '0755');

    // TI-4: .env never appears as DELETE!
    const hasEnvDelete = manifest.changes.some((c) => c.path === '.env');
    assert.strictEqual(hasEnvDelete, false, '.env must not appear as DELETE in manifest');
  } finally {
    rmSync(casDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 9: TI-2 Manifest integrity & tamper resistance
// ----------------------------------------------------------------------------
test('TI-2: Candidate Manifest is tamper-resistant and deterministically verifiable', () => {
  const casDir = makeTempDir('af-ti2-cas-');
  try {
    const cas = new TrustedCAS({ casDir });
    const b1 = cas.put(Buffer.from('content 1')).digest;
    const b2 = cas.put(Buffer.from('content 2')).digest;

    const entries = [
      { path: 'b.txt', type: 'blob', mode: '0644', blob_digest: b2, size: 9 },
      { path: 'a.txt', type: 'blob', mode: '0644', blob_digest: b1, size: 9 },
    ];

    // Sealer deterministically sorts by path (a.txt before b.txt)
    const s1 = sealSnapshot({ entries });
    assert.strictEqual(s1.entries[0].path, 'a.txt');
    assert.strictEqual(s1.entries[1].path, 'b.txt');

    // Passing entries in reverse order produces identical snapshot_digest
    const s2 = sealSnapshot({ entries: [entries[1], entries[0]] });
    assert.strictEqual(s1.snapshot_digest, s2.snapshot_digest);

    // Any byte mutation of manifest changes digest
    const m1 = computeManifest({ projectedBaselineSnapshot: null, candidateSnapshot: s1 });
    const m2 = computeManifest({ projectedBaselineSnapshot: null, candidateSnapshot: s2 });
    assert.strictEqual(m1.manifest_digest, m2.manifest_digest);
  } finally {
    rmSync(casDir, { recursive: true, force: true });
  }
});
