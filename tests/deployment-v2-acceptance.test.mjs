// Deployment acceptance for a real Docker writer boundary.
//
// This suite is opt-in because it starts Docker containers and is a deployment
// check rather than a default unit regression. It uses deterministic local
// author/reviewer programs, so it never needs a provider account.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { acceptanceBinding } from '../lib/acceptance.mjs';
import { probeSandbox, planExecutorSandbox, sandboxCleanup, sandboxIsGone } from '../lib/sandbox.mjs';
import { signalTree, spawnManaged } from '../lib/child-process.mjs';

const ENABLED = process.env.AF_RUN_DEPLOYMENT_ACCEPTANCE === '1';
const SANDBOX = probeSandbox({ fresh: true });
const roots = [];
const deploymentRoot = mkdtempSync(join(tmpdir(), 'af-deploy-v2-'));
roots.push(deploymentRoot);
const tasksDir = join(deploymentRoot, 'tasks');
mkdirSync(tasksDir, { recursive: true });

if (ENABLED && SANDBOX.available) {
  // These are deployment assertions, so an unavailable acceptance or executor
  // sandbox must fail closed instead of silently changing the test posture.
  process.env.AF_TASKS_DIR = tasksDir;
  process.env.AF_SANDBOX = 'require';
  process.env.AF_SANDBOX_IMAGE = 'node:24-alpine';
  process.env.AF_SANDBOX_NETWORK = 'none';
  process.env.AF_SANDBOX_EXECUTORS = 'on';
  process.env.AF_SANDBOX_EXECUTOR_IMAGE = 'node:24-alpine';
  process.env.AF_SANDBOX_EXECUTOR_NETWORK = 'none';
  process.env.AF_SAFETY_STATE_FILE = join(deploymentRoot, 'safety-state.json');
  process.env.AF_RUNTIME_EVENTS_LOG = join(deploymentRoot, 'runtime-events.jsonl');
}

const executeTask = ENABLED && SANDBOX.available
  ? (await import('../orchestrator.mjs')).executeTask
  : null;

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, stdio: 'pipe', ...options });
}

function initRepo(repoDir) {
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.name', 'AFR Docker Deployment Tester']);
  git(repoDir, ['config', 'user.email', 'docker-deployment@afr.local']);
  mkdirSync(join(repoDir, 'src'));
  mkdirSync(join(repoDir, 'tests'));
  writeFileSync(join(repoDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
  writeFileSync(join(repoDir, 'tests', 'gate.test.mjs'), [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { value } from '../src/value.mjs';",
    "test('deployment value', () => assert.equal(value, 'v2'));",
    '',
  ].join('\n'));
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'deployment baseline']);
}

function makeTask({ repoDir, taskId }) {
  const candidateDir = join(deploymentRoot, `${taskId}-candidate`);
  const casDir = join(deploymentRoot, `${taskId}-cas`);
  const materializeDir = join(deploymentRoot, `${taskId}-materialized`);
  mkdirSync(candidateDir);
  mkdirSync(casDir);
  mkdirSync(materializeDir);

  const task = {
    task_id: taskId,
    task_mode: 'workspace',
    goal: 'perform a deterministic isolated V2 deployment acceptance',
    acceptance: 'the Docker acceptance test passes',
    fixture_dir: repoDir,
    acceptance_cmd: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
    author_executor: 'local-docker-author',
    reviewer_executor: 'local-docker-reviewer',
    author_role: 'author',
    reviewer_role: 'reviewer',
    red_lines: [],
    review_rules: ['inspect the sealed candidate snapshot and report evidence'],
    max_revisions: 1,
    trusted_import: {
      enabled: true,
      candidate_dir: candidateDir,
      cas_dir: casDir,
      materialize_dir: materializeDir,
      proposed_required: ['src/**'],
      policy: {
        allowed_root: ['src/**', 'tests/**'],
        forbidden: [],
        protected_paths: [],
        protected_json: [],
        projection: { exclude: [], synthesize_dirs: [] },
        import: { deny: [] },
      },
      acceptance: {
        tier: 'TierB',
        acceptance_profile_digest: 'profile:docker-deployment-acceptance',
        acceptance_assets_digest: 'assets:docker-deployment-acceptance',
        dependency_fixture_id: 'fixture:docker-deployment-acceptance',
      },
    },
  };
  task.acceptance_binding = acceptanceBinding(task);
  Object.defineProperty(task, '__tasksDir', { value: tasksDir, enumerable: false });
  return task;
}

function authorProgram(value) {
  const childProgram = [
    "const fs = require('node:fs');",
    "fs.mkdirSync('.af-scratch', { recursive: true });",
    "fs.writeFileSync('.af-scratch/writer-started', String(process.pid));",
    "setInterval(() => fs.writeFileSync('.af-scratch/writer-heartbeat', String(Date.now())), 20);",
  ].join(' ');
  const source = `export const value = ${JSON.stringify(value)};\n`;
  return [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `fs.writeFileSync('src/value.mjs', ${JSON.stringify(source)});`,
    `const writer = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { cwd: process.cwd(), detached: true, stdio: 'ignore' });`,
    'writer.unref();',
    "setTimeout(() => process.stdout.write('author-ready\\n'), 250);",
  ].join('\n');
}

const reviewerProgram = [
  "const fs = require('node:fs');",
  "const observed = fs.readFileSync('src/value.mjs', 'utf8');",
  "process.stdout.write(JSON.stringify({ decision: 'PASS', summary: 'sealed snapshot inspected', issues: [], required_changes: [], evidence: ['src/value.mjs:1'], observed }));",
].join('\n');

async function runDockerProgram({ cwd, executorType, script }) {
  const decision = planExecutorSandbox({
    command: 'node',
    args: ['-e', script],
    cwd,
    executorType,
    env: {},
  });
  assert.strictEqual(decision.allowed, true, `Docker executor sandbox must be allowed: ${decision.status.reason}`);
  assert.strictEqual(decision.plan?.mechanism, 'docker');

  const child = spawnManaged(decision.plan.command, decision.plan.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });

  const close = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: -1, signal: null, error: String(error) }));
    child.once('close', (code, signal) => resolve({ code, signal, error: null }));
  });
  let timer;
  const outcome = await Promise.race([
    close,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ code: -1, signal: null, timed_out: true, error: 'Docker executor timeout' }), 15_000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.timed_out) {
    signalTree(child, 'SIGKILL');
    await Promise.race([close, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }

  // --rm handles the normal path. This explicit cleanup also covers a killed
  // docker client, which otherwise leaves a container and its writers behind.
  sandboxCleanup(decision.plan.containerName);
  const scopeEmpty = sandboxIsGone(decision.plan.containerName);
  assert.strictEqual(scopeEmpty, true, `Docker writer container must be gone: ${decision.plan.containerName}`);

  return {
    ...outcome,
    stdout,
    stderr,
    writer_termination: {
      process_started: true,
      process_group_id: child.pid ?? null,
      process_group_alive: false,
      termination_confirmed: scopeEmpty,
      scope_verified: scopeEmpty,
      scope_kind: 'container',
      scope_id: decision.plan.containerName,
      scope_empty: scopeEmpty,
      termination_signal: outcome.signal ?? null,
      forced: outcome.timed_out === true,
      checked_at: new Date().toISOString(),
    },
  };
}

function deterministicAdapters({ value, containerNames }) {
  const author = {
    type: 'local-docker-author',
    supportsMcpUnattended: true,
    async run(capsule) {
      const result = await runDockerProgram({
        cwd: capsule.cwd,
        executorType: this.type,
        script: authorProgram(value),
      });
      containerNames.push(result.writer_termination.scope_id);
      assert.strictEqual(result.code, 0, result.stderr || result.stdout);
      assert.ok(existsSync(join(capsule.cwd, '.af-scratch', 'writer-started')), 'background writer must have started inside the container');
      return {
        executor_run_id: `RUN-${randomUUID()}`,
        executor_type: this.type,
        assigned_role: capsule.assigned_role,
        status: 'completed',
        session_ref: `local-author-${randomUUID()}`,
        structured_result: { result: 'deterministic Docker author completed' },
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: null,
        writer_termination: result.writer_termination,
      };
    },
    async resume() { throw new Error('deployment acceptance must not resume the author'); },
    cancel() { return { cancelled: true }; },
  };

  const reviewer = {
    type: 'local-docker-reviewer',
    supportsMcpUnattended: true,
    async run(capsule) {
      const result = await runDockerProgram({
        cwd: capsule.cwd,
        executorType: this.type,
        script: reviewerProgram,
      });
      containerNames.push(result.writer_termination.scope_id);
      assert.strictEqual(result.code, 0, result.stderr || result.stdout);
      const review = JSON.parse(result.stdout.trim());
      return {
        executor_run_id: `RUN-${randomUUID()}`,
        executor_type: this.type,
        assigned_role: capsule.assigned_role,
        status: 'completed',
        session_ref: `local-reviewer-${randomUUID()}`,
        structured_result: { result: JSON.stringify(review) },
        exit_code: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        error: null,
        writer_termination: result.writer_termination,
      };
    },
    cancel() { return { cancelled: true }; },
  };

  return { [author.type]: author, [reviewer.type]: reviewer };
}

function persistableTask(task) {
  const persisted = JSON.parse(readFileSync(join(tasksDir, `${task.task_id}.json`), 'utf8'));
  Object.defineProperty(persisted, '__tasksDir', { value: tasksDir, enumerable: false });
  return persisted;
}

function canonicalFile(repoDir) {
  const canonical = execFileSync('git', ['rev-parse', 'refs/afr/canonical'], { cwd: repoDir, encoding: 'utf8' }).trim();
  return execFileSync('git', ['show', `${canonical}:src/value.mjs`], { cwd: repoDir, encoding: 'utf8' });
}

const deploymentSkip = !ENABLED
  ? 'disabled by default; set AF_RUN_DEPLOYMENT_ACCEPTANCE=1 to run the Docker deployment gate'
  : (SANDBOX.available ? false : `Docker unavailable: ${SANDBOX.reason}`);

test('DEPLOY-V2-SUCCESS: Docker author/reviewer, isolated acceptance, and promotion', { skip: deploymentSkip, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(deploymentRoot, 'success-'));
  const repoDir = join(root, 'repo');
  mkdirSync(repoDir);
  initRepo(repoDir);
  const task = makeTask({ repoDir, taskId: `TASK-DEPLOY-SUCCESS-${randomUUID().slice(0, 8)}` });
  const baseline = git(repoDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const containerNames = [];

  const result = await executeTask(task, deterministicAdapters({ value: 'v2', containerNames }));

  assert.strictEqual(result.state, 'COMPLETED');
  assert.strictEqual(result.trusted_import.phase, 'PROMOTED');
  assert.notStrictEqual(result.trusted_import.canonical_oid, baseline);
  assert.strictEqual(result.trusted_import.acceptance_evidence.status, 'PASS');
  assert.strictEqual(canonicalFile(repoDir), 'export const value = "v2";\n');
  assert.deepStrictEqual(
    result.runs.map((run) => run.executor_type),
    ['local-docker-author', 'local-docker-reviewer'],
    'author and reviewer must be separate deterministic executor instances',
  );
  assert.ok(containerNames.length >= 2, 'author and reviewer must each have a Docker scope');
  assert.ok(containerNames.every((name) => sandboxIsGone(name)), 'all Docker writer scopes must be empty');
  assert.ok(existsSync(join(tasksDir, `${task.task_id}.json`)), 'the task record must be durable');
  const saved = JSON.parse(readFileSync(join(tasksDir, `${task.task_id}.json`), 'utf8'));
  assert.strictEqual(saved.trusted_import.acceptance_evidence.status, 'PASS');
  assert.strictEqual(saved.trusted_import.promotion.promoted_oid, result.trusted_import.promotion.promoted_oid);
});

test('DEPLOY-V2-FAILURE: acceptance failure preserves canonical and recovery refuses a concurrent overwrite', { skip: deploymentSkip, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(deploymentRoot, 'failure-'));
  const repoDir = join(root, 'repo');
  mkdirSync(repoDir);
  initRepo(repoDir);
  const task = makeTask({ repoDir, taskId: `TASK-DEPLOY-FAIL-${randomUUID().slice(0, 8)}` });
  const baseline = git(repoDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const containerNames = [];

  const failed = await executeTask(task, deterministicAdapters({ value: 'broken', containerNames }));
  assert.strictEqual(failed.state, 'FAILED');
  assert.strictEqual(failed.trusted_import.acceptance_evidence.status, 'FAIL');
  const savedFailure = JSON.parse(readFileSync(join(tasksDir, `${task.task_id}.json`), 'utf8'));
  assert.strictEqual(savedFailure.state, 'FAILED');
  assert.strictEqual(savedFailure.trusted_import.acceptance_evidence.status, 'FAIL');
  assert.strictEqual(git(repoDir, ['rev-parse', 'refs/afr/canonical'], { encoding: 'utf8' }).trim(), baseline);
  assert.strictEqual(canonicalFile(repoDir), "export const value = 'v1';\n");

  writeFileSync(join(repoDir, 'src', 'value.mjs'), "export const value = 'other-task-v3';\n");
  git(repoDir, ['add', 'src/value.mjs']);
  git(repoDir, ['commit', '-m', 'other deployment task']);
  const other = git(repoDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  git(repoDir, ['update-ref', 'refs/afr/canonical', other, baseline]);

  const recovered = await executeTask(persistableTask(task), deterministicAdapters({ value: 'broken', containerNames }));
  assert.strictEqual(recovered.state, 'FAILED');
  assert.match(recovered.failure_reason, /Rebase conflict/i);
  assert.strictEqual(canonicalFile(repoDir), "export const value = 'other-task-v3';\n");
  assert.ok(containerNames.every((name) => sandboxIsGone(name)), 'failed and recovery paths must leave no Docker writer scope');
});
