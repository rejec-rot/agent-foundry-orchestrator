// trusted-import-human-gate-resume.test.mjs - a HUMAN approval is the only thing that may turn a
// Band D (protected path) into ALLOW, and only when it was minted by the trusted Human Gate.
//
// HG-5 is the feasibility proof: the same manifest that parks the task becomes a SATISFIED closure
// once a signed approval is supplied, and stays unsatisfied for a forged look-alike.

import { test } from 'node:test';
import assert from 'node:assert';

import { evaluateMechanicalGate } from '../lib/trusted-import/mechanical-gate.mjs';
import { AuthorizationLedger } from '../lib/trusted-import/ledger.mjs';
import { createScopeGrant } from '../lib/trusted-import/scope-grant.mjs';
import { canonicalizePolicy } from '../lib/trusted-import/policy.mjs';
import { resolveV2HumanGate } from '../lib/trusted-import/human-gate-resume.mjs';
import { approveHumanGate } from '../lib/trusted-import/human-gate.mjs';

const OID = 'a'.repeat(40);
const policy = canonicalizePolicy({ protected_paths: ['SECURITY.md'] });
const authenticator = ({ auditDigest }) => ({ verified: true, signature: `sig:${auditDigest.slice(0, 8)}`, keyId: 'test-key' });

const grant = () => createScopeGrant({ taskId: 'T-HG', canonicalOid: OID, proposedRequired: ['src/app.js'], policy });
const manifest = { changes: [{ action: 'MODIFY', path: 'SECURITY.md' }] };
const baseline = [{ path: 'SECURITY.md' }];

const closureOf = (ledger, g, humanApproval = null) => ledger.verifyCumulativeClosure({
  cumulativeManifest: manifest,
  currentScopeGrant: g,
  currentPolicy: policy,
  baselineOid: OID,
  baselineCanonicalEntries: baseline,
  humanApproval,
});

test('HG-1: without an approval a protected path is Band D (WAITING_HUMAN)', () => {
  const outcome = evaluateMechanicalGate({ manifest, scopeGrant: grant(), policy, baselineCanonicalEntries: baseline });
  assert.strictEqual(outcome.verdict, 'WAITING_HUMAN');
  assert.strictEqual(outcome.needsHuman.length, 1);
  assert.strictEqual(outcome.allowed.length, 0);
});

test('HG-2: a FORGED approval object is ignored (no self-approval)', () => {
  const forged = { approved: true, decisions: [{ path: 'SECURITY.md', action: 'MODIFY', band: 'D', decision: 'ALLOW', operator: 'attacker' }] };
  const outcome = evaluateMechanicalGate({ manifest, scopeGrant: grant(), policy, baselineCanonicalEntries: baseline, humanApproval: forged });
  assert.strictEqual(outcome.verdict, 'WAITING_HUMAN', 'an unbranded object must not unlock a protected path');
  assert.strictEqual(outcome.needsHuman.length, 1);
});

test('HG-3: a minted approval turns the protected path into ALLOW and closes the closure', () => {
  const pending = evaluateMechanicalGate({ manifest, scopeGrant: grant(), policy, baselineCanonicalEntries: baseline }).needsHuman;
  const approval = approveHumanGate({ pendingDecisions: pending, operatorIdentity: 'alice', justification: 'reviewed', operatorAuthenticator: authenticator });

  const ledger = new AuthorizationLedger();
  const before = closureOf(new AuthorizationLedger(), grant());
  assert.strictEqual(before.satisfied, false, 'precondition: parked without an approval');

  const after = closureOf(ledger, grant(), approval);
  assert.strictEqual(after.satisfied, true);
  assert.strictEqual(after.needsHuman.length, 0);
  assert.strictEqual(after.verdict, 'APPROVED');
  assert.strictEqual(after.allowed[0].band, 'D');
  assert.strictEqual(after.allowed[0].operator, 'alice');
});

test('HG-4: resolveV2HumanGate refuses a non-parked task, a stale park and missing auth', () => {
  const parked = {
    task_id: 'T-HG', state: 'WAITING_HUMAN', state_version: 4,
    trusted_import: { enabled: true, pending_human_decisions: [{ path: 'SECURITY.md', action: 'MODIFY', band: 'D', decision: 'WAITING_HUMAN' }], pending_human_context: { state_version: 4 } },
  };
  assert.strictEqual(resolveV2HumanGate({ task: { ...parked, state: 'FAILED' }, operatorIdentity: 'a', justification: 'j', operatorAuthenticator: authenticator }).code, 'NOT_PARKED');
  const stale = { ...parked, state_version: 9 };
  assert.strictEqual(resolveV2HumanGate({ task: stale, operatorIdentity: 'a', justification: 'j', operatorAuthenticator: authenticator }).code, 'HUMAN_APPROVAL_STALE');
  assert.strictEqual(resolveV2HumanGate({ task: parked, operatorIdentity: 'a', justification: 'j' }).code, 'HUMAN_AUTH_REQUIRED');
});

test('HG-5: resolveV2HumanGate records the approval and hands back a usable, trusted approval', () => {
  const parked = {
    task_id: 'T-HG', state: 'WAITING_HUMAN', state_version: 4,
    trusted_import: {
      enabled: true,
      pending_human_decisions: [{ path: 'SECURITY.md', action: 'MODIFY', band: 'D', decision: 'WAITING_HUMAN' }],
      pending_human_context: { state_version: 4, cumulative_manifest_digest: 'd', baseline_oid: OID },
    },
  };
  let saved = false;
  const res = resolveV2HumanGate({ task: parked, operatorIdentity: 'alice', justification: 'operator reviewed the protected edit', operatorAuthenticator: authenticator, saveTask: () => { saved = true; } });

  assert.strictEqual(res.ok, true, res.reason ?? '');
  assert.deepStrictEqual(res.approved_paths, ['SECURITY.md']);
  assert.strictEqual(saved, true, 'the evidence must be persisted');
  assert.strictEqual(parked.trusted_import.pending_human_decisions, null, 'the pending list is consumed');
  assert.strictEqual(parked.trusted_import.human_approval.approval_evidence.operator, 'alice');
  assert.strictEqual(parked.state, 'WAITING_HUMAN', 'the task is not marked running until a run actually resumes');

  // The approval handed back is the SAME kind the gate accepts: the closure closes.
  const closed = closureOf(new AuthorizationLedger(), grant(), res.approval);
  assert.strictEqual(closed.satisfied, true, 'a resumed run can now reach ACCEPTANCE');
});
