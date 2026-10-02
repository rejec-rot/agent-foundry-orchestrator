// tests/trusted-import-phase5.test.mjs
//
// Phase 5 (Intelligent & Operational Gates) Verification Suite for AFR v5.2.1.
// Verifies:
//   TI-21: Stale baseline: candidate delta is preserved and rebased rather than discarded; conflicts fail closed
//   TI-22: No qualified verifier -> fail-closed to Gate D (Human Gate), never auto-approve
//   Human Gate D approval and audit signature generation

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  TrustedCAS,
  canonicalizePolicy,
  createScopeGrant,
  AuthorizationLedger,
  isTrustedAuthorizationClosure,
  revalidateAuthorizationClosure,
  verifyScopeExpansion,
  rebaseCandidateDelta,
  approveHumanGate,
  isTrustedHumanApproval,
  revalidateHumanApproval,
  sha256,
  AfrError,
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
// TEST 1: TI-22 No qualified verifier -> fail-closed to Gate D
// ----------------------------------------------------------------------------
test('TI-22: No qualified verifier -> fail-closed to Gate D (Human Gate), never auto-approve', async () => {
  const policy = canonicalizePolicy({
    allowed_root: ['src/**', 'tests/**'],
    forbidden: ['.git/**'],
  });

  const grant = createScopeGrant({
    taskId: 'TASK-VERIF-1',
    canonicalOid: '1111111111111111111111111111111111111111',
    proposedRequired: ['src/core/**'],
    policy,
  });

  const pendingBandCEntries = [
    { path: 'src/extra/plugin.js', action: 'ADD' },
  ];

  // 1. Verifier is null / unavailable -> fail closed to Gate D (WAITING_HUMAN)
  const fallbackNull = await verifyScopeExpansion({
    pendingEntries: pendingBandCEntries,
    verifierFn: null,
    scopeGrant: grant,
    policy,
    taskId: 'TASK-VERIF-1',
  });

  assert.strictEqual(fallbackNull.escalatedToHuman, true);
  assert.strictEqual(fallbackNull.status, 'ESCALATED_TO_HUMAN');
  assert.strictEqual(fallbackNull.decisions[0].band, 'D');
  assert.strictEqual(fallbackNull.decisions[0].decision, 'WAITING_HUMAN');
  assert.strictEqual(fallbackNull.decisions[0].path, 'src/extra/plugin.js');

  // 2. Verifier throws an error during model evaluation -> fail closed to Gate D
  const faultyVerifier = async () => {
    throw new Error('LLM model rate limited or disconnected');
  };

  const fallbackErr = await verifyScopeExpansion({
    pendingEntries: pendingBandCEntries,
    verifierFn: faultyVerifier,
    scopeGrant: grant,
    policy,
    taskId: 'TASK-VERIF-1',
  });

  assert.strictEqual(fallbackErr.escalatedToHuman, true);
  assert.strictEqual(fallbackErr.decisions[0].band, 'D');
  assert.strictEqual(fallbackErr.decisions[0].decision, 'WAITING_HUMAN');

  // 3. Qualified verifier succeeds and approves -> advances scope_rev and expands granted write set
  const qualifiedVerifier = async (entries) => {
    return entries.map((e) => ({
      path: e.path,
      decision: 'APPROVE',
      reason: 'Necessary for plugin architecture',
    }));
  };

  const verifierApproved = await verifyScopeExpansion({
    pendingEntries: pendingBandCEntries,
    verifierFn: qualifiedVerifier,
    scopeGrant: grant,
    policy,
    taskId: 'TASK-VERIF-1',
  });

  assert.strictEqual(verifierApproved.escalatedToHuman, false);
  assert.strictEqual(verifierApproved.status, 'APPROVED');
  assert.strictEqual(verifierApproved.scopeGrant.scope_rev, grant.scope_rev + 1);
  assert.ok(verifierApproved.scopeGrant.granted_write_set.includes('src/extra/plugin.js'));
});

test('TI-22: malformed verifier output cannot expand scope and escalates to Human Gate', async () => {
  const policy = canonicalizePolicy({
    allowed_root: ['src/**'],
    forbidden: [],
  });
  const scopeGrant = createScopeGrant({
    taskId: 'TASK-VERIF-MALFORMED',
    canonicalOid: '1111111111111111111111111111111111111111',
    proposedRequired: ['src/core/**'],
    policy,
  });
  const pendingEntries = [
    { path: 'src/extra/a.js', action: 'ADD' },
    { path: 'src/extra/b.js', action: 'ADD' },
  ];

  const outcome = await verifyScopeExpansion({
    pendingEntries,
    verifierFn: async () => [
      { path: 'src/extra/a.js', decision: 'APPROVE' },
      { path: 'src/forged.js', decision: 'APPROVE' },
    ],
    scopeGrant,
    policy,
    taskId: 'TASK-VERIF-MALFORMED',
  });

  assert.strictEqual(outcome.escalatedToHuman, true);
  assert.strictEqual(outcome.reason, 'VERIFIER_MALFORMED_OUTPUT');
  assert.strictEqual(outcome.decisions.length, 2);
  assert.ok(outcome.decisions.every((decision) => decision.decision === 'WAITING_HUMAN'));
});

// ----------------------------------------------------------------------------
// TEST 2: TI-21 Stale baseline preserves candidate delta and rebases cleanly
// ----------------------------------------------------------------------------
test('TI-21: Stale baseline preserves candidate delta and rebases cleanly onto new canonical baseline', () => {
  const repoDir = makeTempDir('af-ti21-repo-');
  const casDir = makeTempDir('af-ti21-cas-');

  try {
    initTestGitRepo(repoDir);
    mkdirSync(join(repoDir, 'src'));
    writeFileSync(join(repoDir, 'src', 'app.js'), 'export const app = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Baseline C1'], { cwd: repoDir, stdio: 'pipe' });
    const baseline1Oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // Concurrent Task A advances canonical: adds docs/guide.md
    mkdirSync(join(repoDir, 'docs'));
    writeFileSync(join(repoDir, 'docs', 'guide.md'), '# Guide\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Task A: Add docs'], { cwd: repoDir, stdio: 'pipe' });
    const baseline2Oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // Task B had worked against baseline1: modified src/app.js and added src/utils.js
    const cas = new TrustedCAS({ casDir });
    const appModBytes = Buffer.from('export const app = 2;\n');
    const utilsBytes = Buffer.from('export const util = true;\n');

    const appDigest = cas.put(appModBytes).digest;
    const utilsDigest = cas.put(utilsBytes).digest;

    const candidateManifest = {
      changes: [
        { action: 'MODIFY', path: 'src/app.js', new_digest: appDigest, new_mode: '0644' },
        { action: 'ADD', path: 'src/utils.js', new_digest: utilsDigest, new_mode: '0644' },
      ],
    };

    // Rebase Task B candidate delta from baseline1 onto baseline2
    const rebaseOutcome = rebaseCandidateDelta({
      repoDir,
      staleBaselineOid: baseline1Oid,
      currentCanonicalOid: baseline2Oid,
      candidateManifest,
      cas,
    });

    assert.strictEqual(rebaseOutcome.status, 'REBASED');
    assert.strictEqual(rebaseOutcome.rebased, true);
    assert.strictEqual(rebaseOutcome.new_baseline_oid, baseline2Oid);

    // The rebased snapshot must contain:
    // 1. Task A's concurrent addition: docs/guide.md
    // 2. Task B's modifications: src/app.js, src/utils.js
    const snapshotPaths = rebaseOutcome.rebased_snapshot.entries.map((e) => e.path).sort();
    assert.deepStrictEqual(snapshotPaths, ['docs/guide.md', 'src/app.js', 'src/utils.js']);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 3: TI-21 Rebase conflict fails closed with REBASE_CONFLICT
// ----------------------------------------------------------------------------
test('TI-21: Rebase conflict on identical file fails closed with REBASE_CONFLICT', () => {
  const repoDir = makeTempDir('af-ti21-conflict-');
  const casDir = makeTempDir('af-ti21-cas-');

  try {
    initTestGitRepo(repoDir);
    writeFileSync(join(repoDir, 'shared.js'), 'version 1\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Init'], { cwd: repoDir, stdio: 'pipe' });
    const baseline1Oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // Concurrent task modified shared.js to version 1.1
    writeFileSync(join(repoDir, 'shared.js'), 'version 1.1\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'Concurrent edit on shared.js'], { cwd: repoDir, stdio: 'pipe' });
    const baseline2Oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    // Candidate also modified shared.js
    const cas = new TrustedCAS({ casDir });
    const candBytes = Buffer.from('candidate version 2\n');
    const digest = cas.put(candBytes).digest;

    const candidateManifest = {
      changes: [{ action: 'MODIFY', path: 'shared.js', new_digest: digest, new_mode: '0644' }],
    };

    assert.throws(
      () =>
        rebaseCandidateDelta({
          repoDir,
          staleBaselineOid: baseline1Oid,
          currentCanonicalOid: baseline2Oid,
          candidateManifest,
          cas,
        }),
      (err) => {
        assert.strictEqual(err.code, 'REBASE_CONFLICT');
        assert.strictEqual(err.details.path, 'shared.js');
        return true;
      }
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(casDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// TEST 4: Human Gate D operator approval & audit signing
// ----------------------------------------------------------------------------
test('Human Gate D: Operator approval signs audit evidence and resolves WAITING_HUMAN', () => {
  const pendingDecisions = [
    { path: '.github/workflows/ci.yml', action: 'MODIFY', band: 'D', decision: 'WAITING_HUMAN' },
    { path: 'SECURITY.md', action: 'MODIFY', band: 'D', decision: 'WAITING_HUMAN' },
  ];

  const outcome = approveHumanGate({
    pendingDecisions,
    operatorIdentity: 'sec-admin-alice',
    justification: 'Approved update for new CI runner and security disclosures',
    operatorAuthenticator: ({ auditDigest }) => ({
      verified: true,
      signature: sha256(`test-key:${auditDigest}`),
      keyId: 'test-key',
    }),
  });

  assert.strictEqual(outcome.approved, true);
  assert.strictEqual(outcome.decisions.length, 2);
  assert.strictEqual(outcome.decisions[0].decision, 'ALLOW');
  assert.strictEqual(outcome.decisions[0].operator, 'sec-admin-alice');
  assert.ok(outcome.approval_evidence.signature.length === 64, 'Signature must be 64-char hex digest');
  assert.strictEqual(outcome.approval_evidence.signature_key_id, 'test-key');
  assert.deepStrictEqual([...outcome.approval_evidence.approved_paths], [
    '.github/workflows/ci.yml',
    'SECURITY.md',
  ]);

  // A JSON round-trip loses the process-local brand. Recovery must compare the
  // current pending paths and re-authenticate before minting a fresh outcome.
  const persisted = JSON.parse(JSON.stringify(outcome));
  const renewed = revalidateHumanApproval({
    persistedApproval: persisted,
    pendingDecisions,
    operatorAuthenticator: ({ auditDigest }) => ({
      verified: true,
      signature: sha256(`test-key:${auditDigest}`),
      keyId: 'test-key',
    }),
  });
  assert.strictEqual(isTrustedHumanApproval(renewed), true);
  assert.notStrictEqual(renewed, outcome);
  assert.throws(
    () => revalidateHumanApproval({
      persistedApproval: persisted,
      pendingDecisions: [...pendingDecisions, { path: 'NOTICE.md', action: 'MODIFY', band: 'D', decision: 'WAITING_HUMAN' }],
      operatorAuthenticator: () => ({ verified: true, signature: 'sig' }),
    }),
    (err) => err.code === 'HUMAN_APPROVAL_STALE'
  );
});

test('Authorization closure recovery re-mints trust and rejects a changed patch', () => {
  const policy = canonicalizePolicy({ allowed_root: ['src/**'], forbidden: [] });
  const baselineOid = '2'.repeat(40);
  const scopeGrant = createScopeGrant({
    taskId: 'TASK-CLOSURE-RECOVERY',
    canonicalOid: baselineOid,
    proposedRequired: ['src/**'],
    policy,
  });
  const manifest = { changes: [{ action: 'ADD', path: 'src/recovered.js', new_digest: sha256('v1'), new_mode: '0644' }] };
  const original = new AuthorizationLedger().verifyCumulativeClosure({
    cumulativeManifest: manifest,
    currentScopeGrant: scopeGrant,
    currentPolicy: policy,
    baselineOid,
  });
  const fresh = revalidateAuthorizationClosure({
    persistedClosure: JSON.parse(JSON.stringify(original)),
    cumulativeManifest: manifest,
    currentScopeGrant: scopeGrant,
    currentPolicy: policy,
    baselineOid,
  });
  assert.strictEqual(isTrustedAuthorizationClosure(fresh), true);
  assert.notStrictEqual(fresh, original);

  const changedManifest = { changes: [{ ...manifest.changes[0], new_digest: sha256('v2') }] };
  assert.throws(
    () => revalidateAuthorizationClosure({
      persistedClosure: JSON.parse(JSON.stringify(original)),
      cumulativeManifest: changedManifest,
      currentScopeGrant: scopeGrant,
      currentPolicy: policy,
      baselineOid,
    }),
    (err) => err.code === 'AUTHORIZATION_CLOSURE_STALE'
  );
});
