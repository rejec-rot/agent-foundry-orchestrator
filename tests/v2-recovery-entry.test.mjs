// v2-recovery-entry.test.mjs - V2 recovery classification and the explicit re-entry gate.
//
// The generic recovery classifier describes the GOVERNANCE path: a parked task without a
// candidate_id is "unsafe", and a FAILED task is terminal. Neither is true for V2 Trusted Import,
// which resumes from its own durable phase machine - so V2 gets its own classification, and
// re-entering a FAILED V2 task is an explicit operator decision. Cancellation stays final.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyRecovery } from '../lib/recovery.mjs';
import { continueTask } from '../orchestrator.mjs';

const v2 = (over = {}) => ({
  task_id: 'T-V2R',
  state: 'WAITING_HUMAN',
  state_version: 3,
  trusted_import: {
    enabled: true,
    phase: 'WAITING_HUMAN',
    pending_human_decisions: [{ path: 'SECURITY.md', action: 'MODIFY', band: 'D', decision: 'WAITING_HUMAN' }],
    ...(over.trusted_import ?? {}),
  },
  ...over.task,
});

test('V2R-1: a parked V2 task is a Human Gate case (not "unsafe without candidate_id")', () => {
  const c = classifyRecovery(v2());
  assert.equal(c.recovery_class, 'V2_HUMAN_GATE');
  assert.equal(c.recoverable, true);
  assert.match(c.recommended_action, /af-admin v2 gate-resume/);
  assert.deepEqual(c.pending_paths, ['SECURITY.md']);
});

test('V2R-2: a parked V2 task with no recorded pending items needs reconciliation', () => {
  const c = classifyRecovery(v2({ trusted_import: { pending_human_decisions: [] } }));
  assert.equal(c.recovery_class, 'V2_HUMAN_GATE');
  assert.equal(c.recoverable, false);
  assert.match(c.recommended_action, /RECONCILE/);
});

test('V2R-3: a FAILED V2 task is re-entry recoverable, and says it needs an operator decision', () => {
  const c = classifyRecovery(v2({ task: { state: 'FAILED', failure_reason: 'boom' }, trusted_import: { phase: 'REVIEW', fix_loop: { attempts: 1 } } }));
  assert.equal(c.recovery_class, 'V2_REENTRY');
  assert.notEqual(c.recovery_class, 'TERMINAL');
  assert.equal(c.requires_operator_decision, true);
  assert.equal(c.recoverable, true);
  assert.equal(c.failure_kind, 'FIX_LOOP');
});

test('V2R-4: a V2 run interrupted mid-flight reports its durable phase evidence', () => {
  const c = classifyRecovery(v2({ task: { state: 'TRUSTED_IMPORT_RUNNING' }, trusted_import: { phase: 'AUTHORIZATION', author_completed: true, review_completed: true } }));
  assert.equal(c.recovery_class, 'V2_REENTRY');
  assert.equal(c.phase, 'AUTHORIZATION');
  assert.equal(c.author_completed, true);
  assert.equal(c.review_completed, true);
});

test('V2R-5: the governance classification is unchanged for non-V2 tasks', () => {
  const governanceParked = { task_id: 'T-GOV', state: 'WAITING_HUMAN', governance: {} };
  const c = classifyRecovery(governanceParked);
  assert.equal(c.recovery_class, 'WAITING_EXTERNAL');
  assert.match(c.recommended_action, /UNSAFE/);
  assert.equal(c.recoverable, false);

  const genericFailed = { task_id: 'T-GEN', state: 'FAILED' };
  assert.equal(classifyRecovery(genericFailed).recovery_class, 'TERMINAL');
});

test('V2R-6: re-entry is explicit and cancellation stays final', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-v2r-'));
  try {
    const write = (task) => writeFileSync(join(dir, `${task.task_id}.json`), JSON.stringify(task, null, 2));

    write({ ...v2({ task: { state: 'FAILED' } }), task_id: 'T-FAILED-V2' });
    await assert.rejects(
      async () => continueTask('T-FAILED-V2', {}, { tasksDir: dir }),
      /TASK_TERMINAL/,
      'a FAILED V2 task must NOT re-enter without the explicit flag',
    );

    write({ ...v2({ task: { state: 'CANCELLED' } }), task_id: 'T-CANCELLED-V2' });
    await assert.rejects(
      async () => continueTask('T-CANCELLED-V2', {}, { tasksDir: dir, allowV2FailedReentry: true }),
      /TASK_TERMINAL/,
      'cancellation is final: the flag must not resurrect a cancelled task',
    );

    write({ task_id: 'T-FAILED-GEN', state: 'FAILED' });
    await assert.rejects(
      async () => continueTask('T-FAILED-GEN', {}, { tasksDir: dir, allowV2FailedReentry: true }),
      /TASK_TERMINAL/,
      'the flag applies to V2 tasks only',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
