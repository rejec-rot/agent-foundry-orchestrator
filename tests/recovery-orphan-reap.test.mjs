// recovery-orphan-reap.test.mjs - recovery reaps hard-kill debris before continuing
//
// ADR-0007 left one consequence open: the orphan reaper existed but nothing in
// the RECOVERY path called it. Recovery re-dispatches a task whose owner is gone,
// so an executor the dead owner left running could keep editing the same
// workspace and spending budget WHILE the new run starts - the exact hazard the
// reaper was written for.
//
// recoverTask now takes an injected `reapOrphans` and awaits it BEFORE the
// continuation, recording the evidence in the recovery attempt. It is injected
// (no import of the reaper into the control plane) and opt-in, which is what
// these tests pin:
//
//   ROR-1  the reaper runs BEFORE the continuation, and its evidence is recorded
//   ROR-2  no reaper supplied -> nothing is reaped
//   ROR-3  a reaper that throws does not block recovery, but is not swallowed
//   ROR-4  a classification that will not continue (INTERRUPTED) does not reap

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverTask } from '../lib/recovery.mjs';
import { readTaskFile, saveTaskAtomic } from '../lib/store.mjs';

/** A task whose classification is RESUMABLE (author result fully persisted). */
function resumableTask(id) {
  return {
    task_id: id,
    state: 'AUTHOR_RUNNING',
    revisions_used: 1,
    runs: [{ executor_run_id: 'RUN-A', executor_type: 'claude', purpose: 'author', status: 'completed' }],
    last_author_content: 'the author output',
    author_content_revision: 1,
    state_version: 1,
    created_at: '2026-09-18T00:00:00.000Z',
    updated_at: '2026-09-18T00:00:00.000Z',
  };
}

function setup(task) {
  const dir = mkdtempSync(join(tmpdir(), 'af-ror-'));
  const tasksDir = join(dir, 'tasks');
  const locksDir = join(dir, 'locks');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(locksDir, { recursive: true });
  saveTaskAtomic(join(tasksDir, `${task.task_id}.json`), task);
  return { dir, tasksDir, locksDir };
}

// ------------------------------------------------------------------ ROR-1
test('ROR-1: the reaper runs BEFORE the continuation and its evidence is recorded', async () => {
  const { dir, tasksDir, locksDir } = setup(resumableTask('TASK-ROR1'));
  const order = [];
  try {
    const done = await recoverTask('TASK-ROR1', {
      tasksDir,
      locksDir,
      orchestratorInstanceId: 'af-test',
      continueTaskFn: async (id) => {
        order.push('continue');
        return readTaskFile(join(tasksDir, `${id}.json`));
      },
      resumeGovernanceFn: async () => readTaskFile(join(tasksDir, 'TASK-ROR1.json')),
      reapOrphans: async () => {
        order.push('reap');
        return {
          sandboxes: { inspected: 1, orphans: [], reaped: ['af-sbx-1-abcd'], skipped: [] },
          runs: { inspected: 2, orphans: [], killed: [{ handle: 'run.json', pid: 123 }], survived: [], staleHandles: [], unverifiable: [] },
        };
      },
    });

    assert.strictEqual(done.outcome, 'RECOVERED');
    assert.deepStrictEqual(order, ['reap', 'continue'], 'debris must be cleared before a second executor starts');

    const finalTask = readTaskFile(join(tasksDir, 'TASK-ROR1.json'));
    const attempt = finalTask.recovery_attempts.at(-1);
    assert.ok(attempt.orphan_reap, 'the reap evidence must be recorded on the recovery attempt');
    assert.strictEqual(attempt.orphan_reap.ok, true);
    assert.strictEqual(attempt.orphan_reap.reaped_runs, 1);
    assert.strictEqual(attempt.orphan_reap.removed_sandboxes, 1);
    assert.strictEqual(attempt.orphan_reap.survived_runs, 0);
    assert.strictEqual(attempt.orphan_reap.note, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ROR-2
test('ROR-2: with no reaper supplied, nothing is reaped', async () => {
  const { dir, tasksDir, locksDir } = setup(resumableTask('TASK-ROR2'));
  try {
    await recoverTask('TASK-ROR2', {
      tasksDir,
      locksDir,
      orchestratorInstanceId: 'af-test',
      continueTaskFn: async (id) => readTaskFile(join(tasksDir, `${id}.json`)),
      resumeGovernanceFn: async () => readTaskFile(join(tasksDir, 'TASK-ROR2.json')),
      // reapOrphans omitted: the default posture must not sweep side effects
    });

    const finalTask = readTaskFile(join(tasksDir, 'TASK-ROR2.json'));
    const attempt = finalTask.recovery_attempts.at(-1);
    assert.strictEqual(attempt.orphan_reap, undefined, 'no reaper means no reap evidence');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ROR-3
test('ROR-3: a reaper that throws does not block recovery, and is not swallowed', async () => {
  const { dir, tasksDir, locksDir } = setup(resumableTask('TASK-ROR3'));
  const order = [];
  try {
    const done = await recoverTask('TASK-ROR3', {
      tasksDir,
      locksDir,
      orchestratorInstanceId: 'af-test',
      continueTaskFn: async (id) => {
        order.push('continue');
        return readTaskFile(join(tasksDir, `${id}.json`));
      },
      resumeGovernanceFn: async () => readTaskFile(join(tasksDir, 'TASK-ROR3.json')),
      reapOrphans: async () => {
        order.push('reap');
        throw new Error('docker unavailable');
      },
    });

    assert.strictEqual(done.outcome, 'RECOVERED', 'a failed sweep must not block the recovery');
    assert.deepStrictEqual(order, ['reap', 'continue']);

    const finalTask = readTaskFile(join(tasksDir, 'TASK-ROR3.json'));
    const attempt = finalTask.recovery_attempts.at(-1);
    assert.strictEqual(attempt.orphan_reap.ok, false);
    assert.match(String(attempt.orphan_reap.error), /docker unavailable/, 'the failure must be recorded, not swallowed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ROR-4
test('ROR-4: a classification that will not continue does not reap', async () => {
  // AUTHOR_RUNNING with no durable result is INTERRUPTED: recovery records the
  // unknown outcome and does NOT re-dispatch, so there is no second executor to
  // protect against - and reaping there would be an unmotivated side effect.
  const task = resumableTask('TASK-ROR4');
  task.last_author_content = '';
  task.author_content_revision = undefined;
  const { dir, tasksDir, locksDir } = setup(task);
  let reapCalls = 0;
  let continueCalls = 0;
  try {
    const done = await recoverTask('TASK-ROR4', {
      tasksDir,
      locksDir,
      orchestratorInstanceId: 'af-test',
      continueTaskFn: async (id) => { continueCalls += 1; return readTaskFile(join(tasksDir, `${id}.json`)); },
      resumeGovernanceFn: async () => readTaskFile(join(tasksDir, 'TASK-ROR4.json')),
      reapOrphans: async () => { reapCalls += 1; return { sandboxes: {}, runs: {} }; },
    });

    assert.strictEqual(done.classification, 'INTERRUPTED');
    assert.strictEqual(continueCalls, 0, 'an interrupted task is not auto-continued');
    assert.strictEqual(reapCalls, 0, 'no continuation means no reaping');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
