// v2-service.test.mjs - §6 G2: dedicated V2 submission and single execution ownership.
//
// The two properties that matter: a submission can never drag the legacy planner back in, and a
// start has exactly ONE owner (a second one is refused, a restart resumes rather than re-authoring).

import './helpers/executors-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createV2Task, startOrResumeV2Task } from '../lib/v2-service.mjs';
import { acquireTaskLock, releaseTaskLock } from '../lib/tasklock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.AF_ACCEPTANCE_ALLOWLIST = process.env.AF_ACCEPTANCE_ALLOWLIST || join(ROOT, 'config', 'acceptance-allowlist.json');

function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const target = join(root, 'target');
  const tasksDir = join(root, 'tasks');
  const locksDir = join(root, 'locks');
  const submissionsDir = join(root, 'submissions');
  const workspaceRoot = join(root, 'workspaces');
  for (const d of [target, tasksDir, locksDir, submissionsDir, workspaceRoot]) mkdirSync(d, { recursive: true });
  return { root, target, tasksDir, locksDir, submissionsDir, workspaceRoot };
}

const specFor = (fx, extra = {}) => ({
  goal: 'add the hello module',
  target_path: fx.target,
  acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
  idempotency_key: 'svc-key-1',
  ...extra,
});

const create = (fx, extra = {}) => createV2Task({
  spec: specFor(fx, extra),
  allowedRoots: [fx.target],
  tasksDir: fx.tasksDir,
  submissionsDir: fx.submissionsDir,
  workspaceRoot: fx.workspaceRoot,
});

test('V2SVC-1: creation persists the V2 shape and never attaches legacy planning', () => {
  const fx = fixture('af-v2svc-1-');
  try {
    const res = create(fx);
    assert.equal(res.ok, true, res.reason ?? '');
    assert.equal(res.created, true);
    assert.ok(res.operation_id, 'an operation id is returned to the caller');

    const task = JSON.parse(readFileSync(join(fx.tasksDir, `${res.task_id}.json`), 'utf8'));
    assert.equal(task.state, 'CREATED');
    assert.equal(task.multi_step_dispatch, false, 'multi-step dispatch must be off');
    assert.equal(Object.prototype.hasOwnProperty.call(task, 'planner_result'), false, 'no planner result may exist');
    assert.equal(task.trusted_import.enabled, true);
    assert.notEqual(task.author_executor, task.reviewer_executor, 'the reviewer must be independent');
    assert.ok(task.trusted_import.candidate_dir.startsWith(fx.workspaceRoot), 'the control plane assigns the workspace');
    assert.ok(task.trusted_import.cas_dir.startsWith(fx.workspaceRoot));
    assert.equal(task.fixture_dir, fx.target);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-2: creation is idempotent per key - a retry returns the original task', () => {
  const fx = fixture('af-v2svc-2-');
  try {
    const first = create(fx);
    const second = create(fx);
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.task_id, first.task_id, 'the same key must map to the same task');
    assert.equal(readdirSync(fx.tasksDir).filter((n) => n.endsWith('.json')).length, 1, 'exactly one task file');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-3: a refused preflight creates no task', () => {
  const fx = fixture('af-v2svc-3-');
  try {
    const outside = createV2Task({ spec: specFor(fx, { target_path: '/etc' }), allowedRoots: [fx.target], tasksDir: fx.tasksDir, submissionsDir: fx.submissionsDir, workspaceRoot: fx.workspaceRoot });
    assert.equal(outside.ok, false);
    assert.match(outside.reason, /outside|root/i);
    const forged = createV2Task({ spec: specFor(fx, { role: 'author' }), allowedRoots: [fx.target], tasksDir: fx.tasksDir, submissionsDir: fx.submissionsDir, workspaceRoot: fx.workspaceRoot });
    assert.equal(forged.ok, false);
    assert.match(forged.reason, /PLATFORM_BOUND_FIELD_REJECTED|GOVERNANCE_FIELD_REJECTED/);
    assert.equal(readdirSync(fx.tasksDir).length, 0);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-4: a workspace that overlaps the target is refused', () => {
  const fx = fixture('af-v2svc-4-');
  try {
    const res = createV2Task({
      spec: specFor(fx), allowedRoots: [fx.target], tasksDir: fx.tasksDir, submissionsDir: fx.submissionsDir,
      workspaceRoot: fx.target, // the "workspace" is the repository itself
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /must not overlap the target/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-5: starting takes the lock, runs once, and releases it', async () => {
  const fx = fixture('af-v2svc-5-');
  try {
    const created = create(fx);
    const calls = [];
    const res = await startOrResumeV2Task({
      taskId: created.task_id, tasksDir: fx.tasksDir, locksDir: fx.locksDir,
      runner: async ({ mode }) => { calls.push(mode); },
    });
    assert.equal(res.ok, true);
    assert.equal(res.outcome, 'started');
    assert.equal(res.mode, 'start');
    assert.deepEqual(calls, ['start']);
    const lock = acquireTaskLock(fx.locksDir, created.task_id, { orchestratorInstanceId: 'probe' });
    assert.ok(lock?.lock, 'the lock must be released after the run');
    releaseTaskLock(fx.locksDir, created.task_id, lock.lock);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-6: a second concurrent start is refused, not raced', async () => {
  const fx = fixture('af-v2svc-6-');
  try {
    const created = create(fx);
    const held = acquireTaskLock(fx.locksDir, created.task_id, { orchestratorInstanceId: 'other-owner' });
    assert.ok(held?.lock, 'precondition: another owner holds the lock');
    let ran = false;
    const res = await startOrResumeV2Task({ taskId: created.task_id, tasksDir: fx.tasksDir, locksDir: fx.locksDir, runner: async () => { ran = true; } });
    assert.equal(res.ok, false);
    assert.equal(res.outcome, 'already_running');
    assert.equal(ran, false, 'the second owner must not run anything');
    releaseTaskLock(fx.locksDir, created.task_id, held.lock);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-7: a restart RESUMES (never re-authors) and terminal states are refused', async () => {
  const fx = fixture('af-v2svc-7-');
  try {
    const created = create(fx);
    const taskPath = join(fx.tasksDir, `${created.task_id}.json`);
    const task = JSON.parse(readFileSync(taskPath, 'utf8'));

    task.state = 'TRUSTED_IMPORT_RUNNING';
    task.trusted_import = { ...task.trusted_import, author_completed: true, review_completed: false };
    writeFileSync(taskPath, JSON.stringify(task, null, 2));
    const calls = [];
    const resumed = await startOrResumeV2Task({ taskId: created.task_id, tasksDir: fx.tasksDir, locksDir: fx.locksDir, runner: async ({ mode, task: t }) => { calls.push({ mode, authorCompleted: t.trusted_import.author_completed }); } });
    assert.equal(resumed.outcome, 'resumed');
    assert.deepEqual(calls, [{ mode: 'resume', authorCompleted: true }], 'the durable phase machine decides what to do; the author is not re-run');

    task.state = 'COMPLETED';
    writeFileSync(taskPath, JSON.stringify(task, null, 2));
    const terminal = await startOrResumeV2Task({ taskId: created.task_id, tasksDir: fx.tasksDir, locksDir: fx.locksDir, runner: async () => { throw new Error('must not run'); } });
    assert.equal(terminal.outcome, 'refused');
    assert.match(terminal.reason, /terminal/);

    task.state = 'WAITING_HUMAN';
    writeFileSync(taskPath, JSON.stringify(task, null, 2));
    const parked = await startOrResumeV2Task({ taskId: created.task_id, tasksDir: fx.tasksDir, locksDir: fx.locksDir, runner: async () => { throw new Error('must not run'); } });
    assert.equal(parked.outcome, 'refused');
    assert.match(parked.reason, /Human Gate/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-8: the service never consults the legacy planning path', () => {
  // Comments may legitimately NAME what the code must not do (that is how this file explains
  // itself), so the guard strips comments before matching - the project's own convention.
  const src = readFileSync(join(ROOT, 'lib', 'v2-service.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /require\(['"]\.\/planner|from ['"]\.\/planner|planner_result/i, 'no planning-layer dependency may exist in the V2 submission path');
  assert.doesNotMatch(src, /withIntentGate|withPlan/, 'the legacy submit flags must not appear');
  assert.doesNotMatch(src, /intent-gate|action-validator/, 'the intent gate must not be invoked');
});
