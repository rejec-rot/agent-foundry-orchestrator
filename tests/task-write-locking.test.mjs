// tests/task-write-locking.test.mjs - every task writer must hold the task lock
//
// Why this file exists (docs/adr/0005):
//
//   `approval/intent-gate.mjs` writes task lifecycle state (WAITING_HUMAN ->
//   APPROVED / CANCELLED, and the alignment write at submission) but it took no
//   task lock, while the scheduler holds that same lock for the whole run. Two
//   writers on one task file with no mutual exclusion is a lost update: both
//   read, both write, and the last writer silently discards the other's change.
//
//   The replacement proposal for this layer (swap the file store for SQLite) was
//   evaluated and rejected in ADR-0005: it collides with the documented
//   "no database introduced (Phase 1.1 boundary)" and "zero heavy runtime
//   dependencies" principles, and it would invalidate the tests that verify the
//   tamper-detection model by rewriting task files on disk. The real defect was
//   lock COVERAGE, which needs no database.
//
//   TW-1  approving while another owner holds the lock is refused, file untouched
//   TW-2  rejecting  while another owner holds the lock is refused, file untouched
//   TW-3  the submission-time alignment write is refused too
//   TW-4  once the lock is released the approval succeeds and state_version advances
//   TW-5  a lock conflict is never swallowed into a "successful" alignment result

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './helpers/executors-fixture.mjs';

import { alignTaskIntent, approveIntent, rejectIntent } from '../approval/intent-gate.mjs';
import { acquireTaskLock, releaseTaskLock } from '../lib/tasklock.mjs';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a task file directly: the file on disk IS the control-plane truth. */
function writeTask(dir, task) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${task.task_id}.json`), JSON.stringify(task, null, 2));
}

function readTask(dir, taskId) {
  return JSON.parse(readFileSync(join(dir, `${taskId}.json`), 'utf8'));
}

function waitingHumanTask(taskId) {
  return {
    task_id: taskId,
    goal: 'g',
    state: 'WAITING_HUMAN',
    state_version: 7,
    runs: [],
    revisions_used: 1,
    intent_alignment: { required: true, status: 'PENDING_HUMAN' },
  };
}

/**
 * A capsule that the action contract escalates to WAITING_HUMAN.
 *
 * `impact` is deliberately omitted: the validator fails closed on a missing or
 * invalid `impact.reversible`, which routes the capsule through the gate's write
 * path. That write is what must hold the task lock.
 */
function escalatingCapsule(taskId) {
  return {
    task_id: taskId,
    goal: '清理构建缓存',
    target_path: '/tmp/tw-target',
    action_proposal: {
      contract_version: '1.0',
      action_type: 'DELETE_ARTIFACT',
      target: { path: '/tmp/tw-target', scope: 'LOCAL' },
      // impact intentionally omitted -> fail-closed escalation to WAITING_HUMAN
    },
  };
}

/** Hold the task lock the way the scheduler does for the duration of a run. */
function withLockHeld(locksDir, taskId, fn) {
  const held = acquireTaskLock(locksDir, taskId, { orchestratorInstanceId: 'simulated-scheduler' });
  try {
    return fn(held);
  } finally {
    releaseTaskLock(locksDir, taskId, held.lock);
  }
}

// ------------------------------------------------------------------ TW-1
test('TW-1: approving while another owner holds the lock is refused and changes nothing', () => {
  const work = tmpDir('af-tw1-');
  const locksDir = join(work, 'locks');
  try {
    writeTask(work, waitingHumanTask('TASK-TW1'));
    const before = readTask(work, 'TASK-TW1');

    withLockHeld(locksDir, 'TASK-TW1', () => {
      assert.throws(
        () => approveIntent('TASK-TW1', { reason: 'ok', tasksDir: work, locksDir }),
        (err) => err?.code === 'TASK_LOCKED' && /TASK_LOCKED/.test(err.message),
        'an approval must not proceed while the scheduler holds the task lock'
      );
      // The refusal must be total: no partial write, no version bump.
      assert.deepStrictEqual(readTask(work, 'TASK-TW1'), before, 'the task file must be untouched');
    });

    // After the lock is released the task is still approvable - the refusal was
    // about exclusivity, not about the task being un-approvable.
    const result = approveIntent('TASK-TW1', { reason: 'ok', tasksDir: work, locksDir });
    assert.strictEqual(result.status, 'APPROVED');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ TW-2
test('TW-2: rejecting while another owner holds the lock is refused and changes nothing', () => {
  const work = tmpDir('af-tw2-');
  const locksDir = join(work, 'locks');
  try {
    writeTask(work, waitingHumanTask('TASK-TW2'));
    const before = readTask(work, 'TASK-TW2');

    withLockHeld(locksDir, 'TASK-TW2', () => {
      assert.throws(
        () => rejectIntent('TASK-TW2', { reason: 'no', tasksDir: work, locksDir }),
        (err) => err?.code === 'TASK_LOCKED'
      );
      assert.deepStrictEqual(readTask(work, 'TASK-TW2'), before, 'the task file must be untouched');
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ TW-3
test('TW-3: the submission-time alignment write is refused while the lock is held', () => {
  const work = tmpDir('af-tw3-');
  const locksDir = join(work, 'locks');
  try {
    withLockHeld(locksDir, 'TASK-TW3', () => {
      assert.throws(
        () => alignTaskIntent(escalatingCapsule('TASK-TW3'), null, { tasksDir: work, locksDir }),
        (err) => err?.code === 'TASK_LOCKED',
        'the gate must not write the capsule while another owner holds the task lock'
      );
    });
    // Nothing was written at all.
    assert.throws(() => readTask(work, 'TASK-TW3'), 'no task file may have been created');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ TW-4
test('TW-4: after the lock is released the approval succeeds and state_version advances', () => {
  const work = tmpDir('af-tw4-');
  const locksDir = join(work, 'locks');
  try {
    writeTask(work, waitingHumanTask('TASK-TW4'));
    const versionBefore = readTask(work, 'TASK-TW4').state_version;

    withLockHeld(locksDir, 'TASK-TW4', () => {
      assert.throws(() => approveIntent('TASK-TW4', { reason: 'later', tasksDir: work, locksDir }));
    });

    approveIntent('TASK-TW4', { reason: 'now', tasksDir: work, locksDir });
    const after = readTask(work, 'TASK-TW4');
    assert.strictEqual(after.state, 'APPROVED');
    assert.ok(
      after.state_version > versionBefore,
      `an approval is a lifecycle write and must advance state_version (${versionBefore} -> ${after.state_version})`
    );
    assert.ok(after.acceptance_binding, 'the gate binds the acceptance anchor on write');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ TW-5
test('TW-5: a lock conflict is never swallowed into a successful alignment result', () => {
  const work = tmpDir('af-tw5-');
  const locksDir = join(work, 'locks');
  try {
    // alignTaskIntent tolerates a missing/unwritable tasks dir (in-memory tests),
    // but a lock conflict means the write did NOT happen - reporting success for
    // it would be exactly the kind of silent lie this project keeps finding.
    withLockHeld(locksDir, 'TASK-TW5', () => {
      let threw = null;
      try {
        alignTaskIntent(escalatingCapsule('TASK-TW5'), null, { tasksDir: work, locksDir });
      } catch (err) {
        threw = err;
      }
      assert.ok(threw, 'the tolerant catch must not hide a lock conflict');
      assert.strictEqual(threw.code, 'TASK_LOCKED');
    });

    // With the lock free the same call succeeds and the capsule is persisted.
    alignTaskIntent(escalatingCapsule('TASK-TW5'), null, { tasksDir: work, locksDir });
    const persisted = readTask(work, 'TASK-TW5');
    assert.strictEqual(persisted.state, 'WAITING_HUMAN');
    assert.strictEqual(persisted.intent_alignment.status, 'PENDING_HUMAN');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
