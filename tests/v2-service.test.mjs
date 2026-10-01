// v2-service.test.mjs - §6 G2: dedicated V2 submission and single execution ownership.
//
// The two properties that matter: a submission can never drag the legacy planner back in, and a
// start has exactly ONE owner (a second one is refused, a restart resumes rather than re-authoring).

import './helpers/executors-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createV2Task, startOrResumeV2Task } from '../lib/v2-service.mjs';
import { acquireTaskLock, releaseTaskLock } from '../lib/tasklock.mjs';
import { loadProjectRegistry, PROJECT_REGISTRY_SCHEMA } from '../lib/projects.mjs';
import { acceptanceCommandAllowed, loadAcceptanceAllowlist } from '../lib/submission.mjs';
import { recordSubmission } from '../lib/submission.mjs';
import { submissionKeyDigest } from '../lib/submission-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = loadAcceptanceAllowlist({ file: join(ROOT, 'config', 'acceptance-allowlist.json') });

function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const target = join(root, 'target');
  const tasksDir = join(root, 'tasks');
  const locksDir = join(root, 'locks');
  const submissionsDir = join(root, 'submissions');
  const workspaceRoot = join(root, 'workspaces');
  for (const d of [target, tasksDir, locksDir, submissionsDir, workspaceRoot]) mkdirSync(d, { recursive: true });
  // A V2 task is bound to a control-plane acceptance profile (§6 G6), so every fixture here has a
  // registry; the acceptance in the spec must be the profile's acceptance verbatim.
  const registryFile = join(root, 'projects.json');
  writeFileSync(registryFile, JSON.stringify({
    schema_version: PROJECT_REGISTRY_SCHEMA,
    projects: [{
      project_id: 'fixture-project',
      root: target,
      workspace_root: workspaceRoot,
      policy: { allowed_root: ['**'], forbidden: [], protected_paths: [], projection: { exclude: [] }, import: { deny: [] } },
      acceptance_profiles: [{ profile_id: 'default', acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] }, assets: [] }],
    }],
  }, null, 2));
  const loaded = loadProjectRegistry({ file: registryFile });
  return { root, target, tasksDir, locksDir, submissionsDir, workspaceRoot, registryFile, loaded };
}

const specFor = (fx, extra = {}) => ({
  goal: 'add the hello module',
  target_path: fx.target,
  acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
  idempotency_key: 'svc-key-1',
  ...extra,
});

const create = (fx, extra = {}, overrides = {}) => createV2Task({
  spec: specFor(fx, extra),
  allowedRoots: [fx.target],
  tasksDir: fx.tasksDir,
  submissionsDir: fx.submissionsDir,
  workspaceRoot: fx.workspaceRoot,
  authorExecutor: 'command-code',
  reviewerExecutor: 'cline',
  projectRegistry: fx.loaded.registry,
  registryFile: fx.registryFile,
  registryDigest: fx.loaded.digest,
  allowlist: ALLOWLIST,
  acceptanceCommandAllowed,
  ...overrides,
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
    const outside = create(fx, { target_path: '/etc' });
    assert.equal(outside.ok, false);
    assert.match(outside.reason, /outside|root/i);
    const forged = create(fx, { role: 'author' });
    assert.equal(forged.ok, false);
    assert.match(forged.reason, /PLATFORM_BOUND_FIELD_REJECTED|GOVERNANCE_FIELD_REJECTED/);
    assert.equal(readdirSync(fx.tasksDir).length, 0);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-4: a workspace that overlaps the target is refused', () => {
  const fx = fixture('af-v2svc-4-');
  try {
    const res = create(fx, {}, { workspaceRoot: fx.target }); // the "workspace" is the repository itself
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

test('V2SVC-9: an executor the operator disabled is refused AT CREATION, naming it', () => {
  const fx = fixture('af-v2svc-9-');
  const previous = process.env.AF_OPERATOR_EXECUTORS_FILE;
  try {
    // The suite's shared helper points the restriction file at an EMPTY fixture (so the engine is
    // testable on any host). This test is about the restriction itself, so it supplies its own.
    const restriction = join(fx.root, 'operator-executors.json');
    writeFileSync(restriction, JSON.stringify({ disabled: ['codex'], reason: 'test: codex out of quota' }));
    process.env.AF_OPERATOR_EXECUTORS_FILE = restriction;
    const disabled = create(fx, {}, { authorExecutor: 'codex' });
    assert.equal(disabled.ok, false, 'a disabled executor must not be bound to a new task');
    assert.match(disabled.reason, /author executor "codex" is disabled by the operator/);
    assert.equal(readdirSync(fx.tasksDir).length, 0, 'no task file may be written for a refused creation');

    const disabledReviewer = create(fx, {}, { reviewerExecutor: 'codex' });
    assert.equal(disabledReviewer.ok, false);
    assert.match(disabledReviewer.reason, /reviewer executor "codex" is disabled/);
  } finally {
    if (previous === undefined) delete process.env.AF_OPERATOR_EXECUTORS_FILE;
    else process.env.AF_OPERATOR_EXECUTORS_FILE = previous;
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('V2SVC-10: a V2 task without a trusted acceptance identity is not startable', async () => {
  const fx = fixture('af-v2svc-10-');
  try {
    const created = create(fx);
    assert.equal(created.ok, true, created.reason ?? '');
    const taskPath = join(fx.tasksDir, `${created.task_id}.json`);
    const task = JSON.parse(readFileSync(taskPath, 'utf8'));
    // Simulate a hand-written record: enabled, but no control-plane acceptance identity bound.
    delete task.trusted_import.acceptance;
    writeFileSync(taskPath, JSON.stringify(task, null, 2));
    const res = await startOrResumeV2Task({ taskId: created.task_id, tasksDir: fx.tasksDir, locksDir: fx.locksDir, runner: async () => { throw new Error('must not run'); } });
    assert.equal(res.outcome, 'refused');
    assert.match(res.reason, /no trusted acceptance profile/);
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

test('V2SVC-11: record and create share one ledger, including subsequent record retries', () => {
  const fx = fixture('af-v2svc-ledger-');
  try {
    const spec = specFor(fx);
    const env = { ...process.env, AF_SUBMISSION_DIR: fx.submissionsDir };
    const prepared = recordSubmission({ spec, allowedRoots: [fx.target], env });
    assert.equal(prepared.ok, true, prepared.reason);
    assert.equal(prepared.record.state, 'PREPARED');
    const created = create(fx);
    assert.equal(created.ok, true, created.reason);
    const retry = recordSubmission({ spec, allowedRoots: [fx.target], env });
    assert.equal(retry.record.state, 'TASK_CREATED');
    assert.equal(retry.record.task_id, created.task_id);
    assert.deepEqual(readdirSync(fx.submissionsDir), [`${submissionKeyDigest(spec.idempotency_key)}.json`]);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-12: reusing a key with changed goal, context or scope is refused', () => {
  const fx = fixture('af-v2svc-identity-');
  try {
    const first = create(fx);
    assert.equal(first.ok, true, first.reason);
    for (const changes of [{ goal: 'a different goal' }, { context: 'new context' }, { proposed_required: ['src/**'] }]) {
      const retry = create(fx, changes);
      assert.equal(retry.ok, false);
      assert.match(retry.reason, /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_SPEC/);
    }
    assert.equal(readdirSync(fx.tasksDir).length, 1);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-13: interrupted creation repairs the ledger and reuses the assigned task id', () => {
  const fx = fixture('af-v2svc-crash-');
  try {
    const first = create(fx);
    const ledgerPath = join(fx.submissionsDir, `${submissionKeyDigest(specFor(fx).idempotency_key)}.json`);
    const record = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    record.state = 'CREATING';
    writeFileSync(ledgerPath, JSON.stringify(record));
    unlinkSync(join(fx.tasksDir, `${first.task_id}.json`));
    const repaired = create(fx);
    assert.equal(repaired.ok, true, repaired.reason);
    assert.equal(repaired.task_id, first.task_id);
    assert.equal(JSON.parse(readFileSync(ledgerPath, 'utf8')).state, 'TASK_CREATED');
    assert.equal(readdirSync(fx.tasksDir).length, 1);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-14: a legacy binding is adopted without replacing its task', () => {
  const fx = fixture('af-v2svc-legacy-');
  try {
    const first = create(fx);
    const digest = submissionKeyDigest(specFor(fx).idempotency_key);
    unlinkSync(join(fx.submissionsDir, `${digest}.json`));
    writeFileSync(join(fx.submissionsDir, `${digest}.task.json`), JSON.stringify({ task_id: first.task_id }));
    const adopted = create(fx);
    assert.equal(adopted.ok, true, adopted.reason);
    assert.equal(adopted.created, false);
    assert.equal(adopted.task_id, first.task_id);
    assert.equal(JSON.parse(readFileSync(join(fx.submissionsDir, `${digest}.json`), 'utf8')).task_id, first.task_id);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-15: healthy but unschedulable executors are refused at creation', () => {
  const fx = fixture('af-v2svc-eligibility-');
  try {
    const res = create(fx, {}, {
      authorExecutor: 'blocked', reviewerExecutor: 'ready',
      adapters: { blocked: { health: () => ({ ok: true }), schedulable: false }, ready: { health: () => ({ ok: true }) } },
      capabilityMap: new Map(), availabilityMap: new Map(), runtimeGuard: null,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /not schedulable/);
    assert.equal(readdirSync(fx.tasksDir).length, 0);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2SVC-16: the configured fix budget is persisted in the V2 phase contract', () => {
  const fx = fixture('af-v2svc-budget-');
  try {
    const res = create(fx, {}, { maxRevisions: 0 });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.task.trusted_import.max_revisions, 0);
    assert.equal(res.task.trusted_import.phase, 'CREATED');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
