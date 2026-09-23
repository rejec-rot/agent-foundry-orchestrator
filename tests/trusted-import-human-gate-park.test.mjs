// trusted-import-human-gate-park.test.mjs - V2 Band D (Human Gate) must PARK, never fail.
//
// The design (docs/design/V2-HUMAN-GATE-WIRING.md) requires a genuine Human Gate payload to stop
// the task in WAITING_HUMAN with its pending decisions persisted, while a DENY or an
// independent-verifier case keeps failing closed.

import { test } from 'node:test';
import assert from 'node:assert';

import { humanGateParkDecision, parkForHumanGate, HUMAN_GATE_PARK_PHASE } from '../lib/trusted-import/human-gate-park.mjs';

const bandD = {
  verdict: 'WAITING_HUMAN',
  blockingObligations: [],
  needsVerifier: [],
  needsHuman: [{ band: 'D', path: 'SECURITY.md', decision: 'WAITING_HUMAN', reason: 'protected path' }],
  cumulative_manifest_digest: 'digest-1',
  baseline_oid: 'a'.repeat(40),
};

test('HG-P1: a genuine Band D payload parks; DENY and verifier cases do not', () => {
  assert.strictEqual(humanGateParkDecision(bandD).park, true);
  assert.strictEqual(humanGateParkDecision({ ...bandD, blockingObligations: [{ path: '.env' }] }).park, false, 'DENY must never park');
  assert.strictEqual(humanGateParkDecision({ ...bandD, needsVerifier: [{ path: 'src/other.js' }] }).park, false, 'verifier case is not a human gate');
  assert.strictEqual(humanGateParkDecision({ ...bandD, needsHuman: [] }).park, false, 'nothing pending');
  assert.strictEqual(humanGateParkDecision(null).park, false);
});

test('HG-P2: parking sets WAITING_HUMAN, persists the pending list and the re-verify context', () => {
  const task = { task_id: 'T-HG-1', state: 'TRUSTED_IMPORT_RUNNING', state_version: 7, trusted_import: { enabled: true, phase: 'AUTHORIZATION' } };
  let saved = null;
  const res = parkForHumanGate({ task, closure: bandD, saveTask: (t) => { saved = t; } });

  assert.strictEqual(res.parked, true);
  assert.strictEqual(task.state, 'WAITING_HUMAN');
  assert.strictEqual(saved, task, 'the park must be persisted by the caller-provided saveTask');
  assert.strictEqual(task.trusted_import.phase, HUMAN_GATE_PARK_PHASE);
  assert.deepStrictEqual(task.trusted_import.pending_human_decisions, bandD.needsHuman);
  assert.strictEqual(task.trusted_import.pending_human_context.state_version, 7, 'state_version is captured for the later re-check');
  assert.strictEqual(task.trusted_import.pending_human_context.cumulative_manifest_digest, 'digest-1');
  assert.strictEqual(task.trusted_import.pending_human_context.baseline_oid, bandD.baseline_oid);
});

test('HG-P3: a DENY closure leaves the task untouched and unsaved', () => {
  const task = { task_id: 'T-HG-2', state: 'TRUSTED_IMPORT_RUNNING', trusted_import: { enabled: true } };
  let saved = false;
  const res = parkForHumanGate({ task, closure: { ...bandD, blockingObligations: [{ path: '.env' }] }, saveTask: () => { saved = true; } });
  assert.strictEqual(res.parked, false);
  assert.strictEqual(task.state, 'TRUSTED_IMPORT_RUNNING', 'a DENY must not change the state');
  assert.strictEqual(saved, false);
});
