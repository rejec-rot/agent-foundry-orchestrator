// v2-cancel-boundary.test.mjs - §6 G4: a cancel is a durable request honoured at a boundary,
// never a promise. Once the ref update has begun it is recorded as too-late instead.

import './helpers/executors-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTrustedImportTask } from '../lib/trusted-import/orchestrator-adapter.mjs';
import { requestCancel, readCancelRequest, cancelDecision } from '../lib/trusted-import/cancel.mjs';

const TERMINATION = { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' };

function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repoDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const candidateDir = join(root, 'candidate');
  const tasksDir = join(root, 'tasks');
  for (const d of [repoDir, casDir, candidateDir, tasksDir]) mkdirSync(d, { recursive: true });

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  mkdirSync(join(repoDir, 'src'));
  mkdirSync(join(repoDir, 'tests'));
  writeFileSync(join(repoDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
  writeFileSync(join(repoDir, 'tests', 'gate.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nimport { test } from 'node:test';\ntest('gate', () => assert.equal(value, 'v2'));\n");
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoDir, stdio: 'pipe' });
  const baselineOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/afr/canonical', baselineOid], { cwd: repoDir });

  const taskId = 'TASK-CANCEL';
  const task = {
    task_id: taskId,
    fixture_dir: repoDir,
    state: 'CREATED',
    author_executor: 'codex',
    reviewer_executor: 'claude',
    acceptance_cmd: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
    acceptance_binding: null,
    trusted_import: {
      enabled: true,
      candidate_dir: candidateDir,
      cas_dir: casDir,
      proposed_required: ['src/**'],
      policy: { allowed_root: ['src/**', 'tests/**'], forbidden: [], protected_paths: [], projection: { exclude: [] }, import: { deny: [] } },
      acceptance: { tier: 'TierA', acceptance_profile_digest: 'd', acceptance_assets_digest: 'a', dependency_fixture_id: 'f' },
    },
  };
  return { root, repoDir, tasksDir, taskPath: join(tasksDir, `${taskId}.json`), task, baselineOid };
}

const readTask = (p) => JSON.parse(readFileSync(p, 'utf8'));
const canonicalOid = (repoDir) => execFileSync('git', ['rev-parse', 'refs/afr/canonical'], { cwd: repoDir, encoding: 'utf8' }).trim();

const deps = (fx, holder) => ({
  tasksDir: fx.tasksDir,
  runAuthor: async (revision, { cwd }) => {
    holder.authorRan = true;
    writeFileSync(join(cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
    if (holder.cancelDuringAuthor) requestCancel({ tasksDir: fx.tasksDir, taskId: fx.task.task_id, requestedBy: 'operator', reason: 'stop while the author was running' });
    return { executor_run_id: `RUN-A${revision}`, writer_termination: TERMINATION };
  },
  runReview: async () => {
    holder.reviewRan = true;
    fx.task.last_review_termination_evidence = TERMINATION;
    return { decision: 'PASS', summary: 'ok' };
  },
  saveTask: (t) => writeFileSync(fx.taskPath, `${JSON.stringify(t, null, 2)}\n`),
  trustedImportHooks: { afterRefUpdate: () => { holder.afterRefUpdate = true; if (holder.cancelDuringCommit) requestCancel({ tasksDir: fx.tasksDir, taskId: fx.task.task_id, requestedBy: 'operator', reason: 'cancel arrived as the ref update completed' }); } },
});

// ---------------------------------------------------------------- unit

test('CAN-U1: a cancel request is validated, idempotent and bound to an existing task', () => {
  const fx = fixture('af-can-u1-');
  try {
    writeFileSync(fx.taskPath, JSON.stringify(fx.task, null, 2));
    assert.equal(requestCancel({ tasksDir: fx.tasksDir, taskId: 'NOPE', requestedBy: 'op', reason: 'x' }).ok, false, 'unknown task');
    assert.equal(requestCancel({ tasksDir: fx.tasksDir, taskId: fx.task.task_id, requestedBy: '', reason: 'x' }).ok, false, 'requestedBy required');
    assert.equal(requestCancel({ tasksDir: fx.tasksDir, taskId: fx.task.task_id, requestedBy: 'op', reason: '  ' }).ok, false, 'reason required');

    const first = requestCancel({ tasksDir: fx.tasksDir, taskId: fx.task.task_id, requestedBy: 'op', reason: 'first' });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    const second = requestCancel({ tasksDir: fx.tasksDir, taskId: fx.task.task_id, requestedBy: 'op2', reason: 'second' });
    assert.equal(second.created, false, 'idempotent');
    assert.equal(second.request.reason, 'first', 'the first request wins');
    assert.equal(readCancelRequest({ tasksDir: fx.tasksDir, taskId: fx.task.task_id }).state, 'requested');
    assert.equal(readCancelRequest({ tasksDir: fx.tasksDir, taskId: 'OTHER' }).state, 'none');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('CAN-U2: an unreadable cancel request is treated as a stop (fail-closed)', () => {
  const fx = fixture('af-can-u2-');
  try {
    writeFileSync(join(fx.tasksDir, `${fx.task.task_id}.cancel.json`), '{ not json');
    const read = readCancelRequest({ tasksDir: fx.tasksDir, taskId: fx.task.task_id });
    assert.equal(read.state, 'unverifiable');
    assert.equal(cancelDecision({ phase: 'REVIEW', cancel: read }).action, 'cancel', 'we cannot rule out that an operator asked us to stop');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('CAN-U3: the decision matrix - proceed / cancel / too-late', () => {
  const requested = { state: 'requested', request: { task_id: 'T' }, reason: null };
  assert.equal(cancelDecision({ phase: 'REVIEW', cancel: { state: 'none' } }).action, 'proceed');
  assert.equal(cancelDecision({ phase: 'REVIEW', cancel: requested }).action, 'cancel');
  assert.equal(cancelDecision({ phase: 'ACCEPTANCE', cancel: requested }).action, 'cancel');
  assert.equal(cancelDecision({ phase: 'PROMOTION', cancel: requested }).action, 'cancel', 'still cancellable before the ref update');
  assert.equal(cancelDecision({ phase: 'PROMOTION', cancel: requested, promotionStarted: true }).action, 'too-late');
  assert.equal(cancelDecision({ phase: 'REF_UPDATE', cancel: requested }).action, 'too-late');
});

// ---------------------------------------------------------------- integration (real adapter)

test('CAN-I1: a cancel requested before the run stops it at the first boundary without promoting', async () => {
  const fx = fixture('af-can-i1-');
  try {
    const holder = { authorRan: false, reviewRan: false };
    writeFileSync(fx.taskPath, JSON.stringify(fx.task, null, 2));
    requestCancel({ tasksDir: fx.tasksDir, taskId: fx.task.task_id, requestedBy: 'operator', reason: 'change of plan' });

    await runTrustedImportTask(fx.task, deps(fx, holder));
    const onDisk = readTask(fx.taskPath);
    assert.equal(onDisk.state, 'CANCELLED');
    assert.match(onDisk.failure_reason, /CANCELLED_AT_BOUNDARY/);
    assert.equal(onDisk.trusted_import.cancel_outcome.action, 'cancel');
    assert.equal(holder.authorRan, false, 'no executor may start once the cancel was requested');
    assert.equal(canonicalOid(fx.repoDir), fx.baselineOid, 'the canonical ref must not move');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('CAN-I2: a cancel that arrives WHILE the author runs stops the task before review/acceptance', async () => {
  const fx = fixture('af-can-i2-');
  try {
    const holder = { authorRan: false, reviewRan: false, cancelDuringAuthor: true };
    writeFileSync(fx.taskPath, JSON.stringify(fx.task, null, 2));

    await runTrustedImportTask(fx.task, deps(fx, holder));
    const onDisk = readTask(fx.taskPath);
    assert.equal(holder.authorRan, true, 'the author had already started');
    assert.equal(onDisk.state, 'CANCELLED');
    assert.equal(onDisk.trusted_import.cancel_outcome.boundary, 'REVIEW', 'honoured at the next trusted boundary');
    assert.equal(holder.reviewRan, false, 'the review must not run after a cancel');
    assert.equal(canonicalOid(fx.repoDir), fx.baselineOid, 'nothing may be promoted');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('CAN-I3: a cancel arriving at the ref update is TOO-LATE - the promotion stands and says so', async () => {
  const fx = fixture('af-can-i3-');
  try {
    const holder = { authorRan: false, reviewRan: false, cancelDuringCommit: true };
    writeFileSync(fx.taskPath, JSON.stringify(fx.task, null, 2));

    await runTrustedImportTask(fx.task, deps(fx, holder));
    const onDisk = readTask(fx.taskPath);
    assert.equal(holder.afterRefUpdate, true, 'the ref update really ran');
    assert.equal(onDisk.state, 'COMPLETED', 'a late cancel must not abort a committed promotion');
    assert.equal(onDisk.trusted_import.phase, 'PROMOTED');
    assert.equal(onDisk.trusted_import.cancel_outcome.action, 'too-late');
    assert.equal(onDisk.trusted_import.cancel_outcome.boundary, 'REF_UPDATE');
    assert.notEqual(canonicalOid(fx.repoDir), fx.baselineOid, 'the promotion is a fact');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('CAN-I4: an unreadable cancel request stops the run (never proceeds on a guess)', async () => {
  const fx = fixture('af-can-i4-');
  try {
    const holder = { authorRan: false, reviewRan: false };
    writeFileSync(fx.taskPath, JSON.stringify(fx.task, null, 2));
    writeFileSync(join(fx.tasksDir, `${fx.task.task_id}.cancel.json`), '{ corrupt');

    await runTrustedImportTask(fx.task, deps(fx, holder));
    const onDisk = readTask(fx.taskPath);
    assert.equal(onDisk.state, 'CANCELLED');
    assert.equal(holder.authorRan, false);
    assert.equal(canonicalOid(fx.repoDir), fx.baselineOid);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
