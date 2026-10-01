import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchV2Task, startOrResumeV2Task } from '../lib/execution-manager.mjs';
import { acquireTaskLock, readLock, releaseTaskLock, renewTaskLock } from '../lib/tasklock.mjs';
import { saveTaskAtomic, saveTaskWithVersion, writeJsonAtomic } from '../lib/store.mjs';
import { acceptanceCommandAllowed, loadAcceptanceAllowlist } from '../lib/acceptance-policy.mjs';
import { loadAcceptanceAllowlist as executionAllowlist } from '../lib/acceptance.mjs';
import { queueMessage } from '../lib/collaboration.mjs';
import { instrumentAdapter } from '../lib/operator-control.mjs';
import { normalizeV2Task } from '../lib/v2-task.mjs';
import { recoverTask } from '../lib/recovery.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-v2-consolidation-'));
  const paths = { root, tasksDir: join(root, 'tasks'), locksDir: join(root, 'locks'), runtimeDir: join(root, 'runtime') };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  const task = { task_id: 'TASK-CONSOLIDATE', state: 'CREATED', state_version: 1, trusted_import: { enabled: true, phase: null, acceptance: { acceptance_profile_digest: 'trusted' } } };
  const file = join(paths.tasksDir, `${task.task_id}.json`);
  saveTaskAtomic(file, task);
  return { ...paths, file, taskId: task.task_id, read: () => JSON.parse(readFileSync(file, 'utf8')), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('execution ownership survives a run longer than its initial lease', async () => {
  const fx = fixture();
  let finish;
  try {
    let began;
    const entered = new Promise((resolve) => { began = resolve; });
    const gate = new Promise((resolve) => { finish = resolve; });
    const first = startOrResumeV2Task({ ...fx, leaseMs: 120, runner: async () => { began(); await gate; } });
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await startOrResumeV2Task({ ...fx, runner: async () => { assert.fail('second owner must not run'); } });
    assert.equal(second.outcome, 'already_running');
    finish();
    assert.equal((await first).ok, true);
    assert.equal(readLock(fx.locksDir, fx.taskId), null);
  } finally { finish?.(); fx.cleanup(); }
});

test('a previous acquisition cannot renew or release a new lock with the same instance id', () => {
  const fx = fixture();
  try {
    const old = acquireTaskLock(fx.locksDir, fx.taskId, { orchestratorInstanceId: 'same-instance' }).lock;
    releaseTaskLock(fx.locksDir, fx.taskId, old);
    const next = acquireTaskLock(fx.locksDir, fx.taskId, { orchestratorInstanceId: 'same-instance' }).lock;
    assert.notEqual(old.owner_token, next.owner_token);
    assert.throws(() => renewTaskLock(fx.locksDir, fx.taskId, old), { code: 'TASK_LOCK_LOST' });
    assert.equal(releaseTaskLock(fx.locksDir, fx.taskId, old), false);
    assert.equal(readLock(fx.locksDir, fx.taskId).owner_token, next.owner_token);
  } finally { fx.cleanup(); }
});

test('losing ownership fences stale task writes and preserves the new owner lock', async () => {
  const fx = fixture();
  let next;
  try {
    const result = await startOrResumeV2Task({ ...fx, runner: async ({ task }) => {
      const old = readLock(fx.locksDir, fx.taskId);
      releaseTaskLock(fx.locksDir, fx.taskId, old);
      next = acquireTaskLock(fx.locksDir, fx.taskId, { orchestratorInstanceId: old.orchestrator_instance_id }).lock;
      const current = fx.read();
      current.marker = 'new owner';
      saveTaskWithVersion(fx.tasksDir, current);
      task.marker = 'stale owner';
      saveTaskWithVersion(fx.tasksDir, task);
    } });
    assert.equal(result.outcome, 'ownership_lost');
    assert.equal(fx.read().marker, 'new owner');
    assert.equal(readLock(fx.locksDir, fx.taskId).owner_token, next.owner_token);
  } finally { if (next) releaseTaskLock(fx.locksDir, fx.taskId, next); fx.cleanup(); }
});

test('a dispatch stays exclusive before worker claim and records the worker receipt', async () => {
  const fx = fixture();
  try {
    const calls = [];
    const dispatcher = (taskId, context) => { calls.push({ taskId, context }); return { pid: 4242 }; };
    const first = await dispatchV2Task({ ...fx, dispatcher });
    assert.equal(first.outcome, 'dispatched');
    assert.equal(fx.read().execution.status, 'DISPATCHED');
    assert.equal((await dispatchV2Task({ ...fx, dispatcher })).outcome, 'already_running');
    assert.equal((await startOrResumeV2Task({ ...fx, runner: async () => assert.fail('must not bypass pending dispatch') })).outcome, 'already_running');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].context.runtimeDir, fx.runtimeDir);
    const claimed = await startOrResumeV2Task({ ...fx, operationId: first.operation_id, runner: async ({ task }) => {
      assert.equal(task.execution.status, 'RUNNING');
      assert.equal(fx.read().execution.owner_token, readLock(fx.locksDir, fx.taskId).owner_token);
      task.state = 'COMPLETED';
      saveTaskWithVersion(fx.tasksDir, task);
    } });
    assert.equal(claimed.ok, true);
    assert.equal(fx.read().execution.status, 'SETTLED');
    assert.equal(fx.read().state, 'COMPLETED');
  } finally { fx.cleanup(); }
});

test('failed dispatch can be retried and an obsolete worker cannot claim a newer request', async () => {
  const fx = fixture();
  try {
    const failed = await dispatchV2Task({ ...fx, dispatcher: () => { throw new Error('launcher unavailable'); } });
    assert.equal(failed.outcome, 'dispatch_failed');
    assert.equal(fx.read().execution.status, 'DISPATCH_FAILED');
    const next = await dispatchV2Task({ ...fx, dispatcher: () => ({ pid: 4242 }) });
    assert.equal(next.ok, true);
    assert.notEqual(next.operation_id, failed.operation_id);
    const obsolete = await startOrResumeV2Task({ ...fx, operationId: failed.operation_id, runner: async () => assert.fail('obsolete dispatch') });
    assert.equal(obsolete.outcome, 'refused');
    assert.equal(fx.read().execution.operation_id, next.operation_id);
  } finally { fx.cleanup(); }
});

test('expired dispatch is recoverable; failed-task reentry authorization survives dispatch', async () => {
  const fx = fixture();
  try {
    const task = fx.read();
    task.state = 'FAILED';
    saveTaskAtomic(fx.file, task);
    assert.equal((await dispatchV2Task({ ...fx, dispatcher: () => ({ pid: 1 }) })).ok, false);
    const expired = await dispatchV2Task({ ...fx, allowFailedReentry: true, dispatchTimeoutMs: 0, dispatcher: () => ({ pid: 1 }) });
    assert.equal((await startOrResumeV2Task({ ...fx, operationId: expired.operation_id, runner: async () => assert.fail('expired request') })).ok, false);
    const retry = await dispatchV2Task({ ...fx, allowFailedReentry: true, dispatcher: () => ({ pid: 1 }) });
    const result = await startOrResumeV2Task({ ...fx, operationId: retry.operation_id, runner: async ({ task: current }) => {
      assert.equal(current.execution.allow_failed_reentry, true);
      current.state = 'COMPLETED';
      saveTaskWithVersion(fx.tasksDir, current);
    } });
    assert.equal(result.ok, true);
  } finally { fx.cleanup(); }
});

test('workflow failure is returned as failure, with a settled execution receipt', async () => {
  const fx = fixture();
  try {
    const result = await startOrResumeV2Task({ ...fx, runner: async ({ task }) => {
      task.state = 'FAILED'; task.failure_reason = 'acceptance rejected';
      saveTaskWithVersion(fx.tasksDir, task);
      return task;
    } });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'failed');
    assert.equal(fx.read().execution.status, 'FAILED');
  } finally { fx.cleanup(); }
});

test('submission and execution share the same command identity without basename widening', () => {
  const fx = fixture();
  try {
    const file = join(fx.root, 'allowlist.json');
    writeJsonAtomic(file, { allowed: [{ command: 'node', args_prefix: ['--test'] }] });
    const policy = loadAcceptanceAllowlist({ file });
    assert.deepEqual(policy.allowed, executionAllowlist(file));
    assert.equal(acceptanceCommandAllowed({ command: process.execPath, args: ['--test'] }, policy).ok, true);
    assert.equal(acceptanceCommandAllowed({ command: join(fx.root, 'node'), args: ['--test'] }, policy).ok, false);
    writeJsonAtomic(file, { allowed: [{ command: 'node', args_prefix: '--test' }] });
    assert.equal(loadAcceptanceAllowlist({ file }).ok, false);
    assert.deepEqual(executionAllowlist(file), []);
  } finally { fx.cleanup(); }
});

test('operator messages and receipts use the runtime directory injected into the capsule', async () => {
  const fx = fixture();
  try {
    const queued = queueMessage({ runtimeDir: fx.runtimeDir, taskId: fx.taskId, message: 'use the deployment inbox' });
    let prompt;
    const adapter = instrumentAdapter('test-author', { run: async (capsule) => { prompt = capsule.prompt; return { status: 'completed' }; } }, join(fx.root, 'other-installation'));
    await adapter.run({ task_id: fx.taskId, runId: 'RUN-INBOX', runtime_dir: fx.runtimeDir, prompt: 'goal' });
    assert.match(prompt, /use the deployment inbox/);
    assert.deepEqual(readdirSync(join(fx.runtimeDir, 'operator-received', fx.taskId)), [`${queued.message.id}-RUN-INBOX.json`]);
  } finally { fx.cleanup(); }
});

test('first publication never replaces a record and atomic failures leave the previous value intact', () => {
  const fx = fixture();
  try {
    const file = join(fx.root, 'record.json');
    assert.equal(writeJsonAtomic(file, { value: 1 }, { noOverwrite: true }), true);
    assert.equal(writeJsonAtomic(file, { value: 2 }, { noOverwrite: true }), false);
    assert.throws(() => writeJsonAtomic(file, { value: 3 }, { fail: 'rename' }), /injected rename failure/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { value: 1 });
    assert.equal(readdirSync(fx.root).some((name) => name.includes('.tmp-')), false);
  } finally { fx.cleanup(); }
});

test('legacy V2 budget migrates while phase budget and author revision retain distinct meanings', () => {
  const task = { max_revisions: 1, revisions_used: 2, trusted_import: { enabled: true, phase: null, revisions_used: 1 } };
  normalizeV2Task(task);
  assert.equal(task.trusted_import.max_revisions, 1);
  assert.equal(task.trusted_import.phase, 'CREATED');
  assert.equal(task.trusted_import.revisions_used, 1);
  assert.equal(task.revisions_used, 2);
});

test('operator recovery shares the renewable lease throughout its continuation', async () => {
  const fx = fixture();
  let finish;
  try {
    const task = fx.read();
    delete task.trusted_import;
    task.task_mode = 'governed_write'; task.state = 'WAITING_HUMAN'; task.governance = { candidate_id: 'candidate-only-this-task' };
    saveTaskAtomic(fx.file, task);
    let began;
    const entered = new Promise((resolve) => { began = resolve; });
    const gate = new Promise((resolve) => { finish = resolve; });
    const recovery = recoverTask(fx.taskId, { ...fx, orchestratorInstanceId: 'recovery-owner', leaseMs: 120,
      resumeGovernanceFn: async (_id, options) => {
        began(); await gate; options.assertOwnership();
        const current = fx.read(); current.state = 'COMPLETED'; return current;
      },
    });
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => acquireTaskLock(fx.locksDir, fx.taskId, { orchestratorInstanceId: 'other' }), { code: 'TASK_ALREADY_RUNNING' });
    finish();
    assert.equal((await recovery).state, 'COMPLETED');
    assert.equal(readLock(fx.locksDir, fx.taskId), null);
  } finally { finish?.(); fx.cleanup(); }
});
