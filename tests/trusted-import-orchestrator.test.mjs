import './helpers/executors-fixture.mjs';
// Main orchestrator -> V2 Trusted Import integration and recovery tests.

import './helpers/tasks-dir-fixture.mjs';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { executeTask } from '../orchestrator.mjs';
import { acceptanceBinding } from '../lib/acceptance.mjs';
import { getCanonicalOid, sha256 } from '../lib/trusted-import/index.mjs';

const tempRoots = [];
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function initRepo(repoDir, expectedValue = 'v2') {
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'AFR Integration Tester'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'integration@afr.local'], { cwd: repoDir, stdio: 'pipe' });
  mkdirSync(join(repoDir, 'src'));
  mkdirSync(join(repoDir, 'tests'));
  writeFileSync(join(repoDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
  writeFileSync(
    join(repoDir, 'tests', 'gate.test.mjs'),
    `import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nimport { test } from 'node:test';\ntest('trusted import gate', () => assert.equal(value, ${JSON.stringify(expectedValue)}));\n`,
  );
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoDir, stdio: 'pipe' });
}

function makeTask({ repoDir, candidateDir, casDir, materializeDir, taskId }) {
  const task = {
    task_id: taskId,
    task_mode: 'workspace',
    goal: 'run a trusted import through the V2 gates',
    acceptance: 'the trusted import acceptance test passes',
    fixture_dir: repoDir,
    acceptance_cmd: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
    acceptance_binding: null,
    author_executor: 'codex',
    reviewer_executor: 'claude',
    author_role: 'author',
    red_lines: [],
    review_rules: ['inspect the exact candidate snapshot and report evidence'],
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
        acceptance_profile_digest: 'profile:orchestrator-integration',
        acceptance_assets_digest: 'assets:orchestrator-integration',
        dependency_fixture_id: sha256('fixture:orchestrator-integration'),
      },
    },
  };
  task.acceptance_binding = acceptanceBinding(task);
  Object.defineProperty(task, '__tasksDir', {
    value: process.env.AF_TASKS_DIR,
    enumerable: false,
  });
  return task;
}

function writerTermination() {
  return {
    process_started: true,
    process_group_id: 12345,
    process_group_alive: false,
    termination_confirmed: true,
    scope_verified: true,
    scope_kind: 'test-scope',
    scope_empty: true,
    termination_signal: null,
    forced: false,
    checked_at: new Date().toISOString(),
  };
}

function executorResult(type, role, capsule, structuredResult) {
  return {
    executor_run_id: `RUN-${randomUUID().slice(0, 8)}`,
    executor_type: type,
    assigned_role: role,
    status: 'completed',
    session_ref: `${type}-session-${randomUUID()}`,
    structured_result: structuredResult,
    exit_code: 0,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    error: null,
    writer_termination: writerTermination(),
  };
}

function adapterForAuthor(onRun) {
  return {
    type: 'codex',
    supportsMcpUnattended: true,
    async run(capsule) {
      await onRun(capsule);
      return executorResult('codex', 'author', capsule, { result: 'candidate prepared' });
    },
    async resume() {
      throw new Error('trusted import recovery unexpectedly reran the author');
    },
    cancel() { return { cancelled: true }; },
  };
}

function adapterForReviewer() {
  return {
    type: 'claude',
    supportsMcpUnattended: true,
    async run(capsule) {
      return executorResult('claude', 'reviewer', capsule, {
        result: JSON.stringify({
          task_id: capsule.task_id,
          revision: 1,
          decision: 'PASS',
          summary: 'candidate snapshot inspected',
          issues: [],
          required_changes: [],
          evidence: ['src/value.mjs:1'],
        }),
      });
    },
    cancel() { return { cancelled: true }; },
  };
}

function adaptersFor(onAuthor, reviewer = adapterForReviewer()) {
  return {
    codex: adapterForAuthor(onAuthor),
    claude: reviewer,
  };
}

function dirsFor(root) {
  const repoDir = join(root, 'repo');
  const candidateDir = join(root, 'candidate');
  const casDir = join(root, 'cas');
  const materializeDir = join(root, 'materialized');
  mkdirSync(repoDir);
  mkdirSync(candidateDir);
  mkdirSync(casDir);
  mkdirSync(materializeDir);
  return { repoDir, candidateDir, casDir, materializeDir };
}

test('V2 main entry: failed acceptance leaves canonical unchanged, recovery revalidates and promotes', async () => {
  const root = tempRoot('af-ti-orch-');
  const dirs = dirsFor(root);
  initRepo(dirs.repoDir, 'v2');
  const task = makeTask({ ...dirs, taskId: `TASK-TI-${randomUUID().slice(0, 8)}` });
  const baselineOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirs.repoDir, encoding: 'utf8' }).trim();
  let authorCalls = 0;

  const failed = await executeTask(task, adaptersFor(async (capsule) => {
    authorCalls += 1;
    assert.strictEqual(capsule.cwd, dirs.candidateDir);
  }));
  assert.strictEqual(failed.state, 'FAILED');
  assert.strictEqual(failed.trusted_import.acceptance_evidence.status, 'FAIL');
  assert.strictEqual(getCanonicalOid(dirs.repoDir), baselineOid);
  assert.strictEqual(authorCalls, 1);
  assert.strictEqual(failed.trusted_import.last_review.decision, 'PASS');

  writeFileSync(join(dirs.candidateDir, 'src', 'value.mjs'), "export const value = 'v2';\n");
  const persisted = JSON.parse(readFileSync(join(process.env.AF_TASKS_DIR, `${task.task_id}.json`), 'utf8'));
  Object.defineProperty(persisted, '__tasksDir', { value: process.env.AF_TASKS_DIR, enumerable: false });
  const recovered = await executeTask(persisted, adaptersFor(async () => {
    throw new Error('author must not be rerun during recovery');
  }));

  assert.strictEqual(recovered.state, 'COMPLETED');
  assert.strictEqual(recovered.trusted_import.phase, 'PROMOTED');
  assert.strictEqual(authorCalls, 1, 'recovery must not rerun an already completed author');
  assert.notStrictEqual(getCanonicalOid(dirs.repoDir), baselineOid);
  assert.strictEqual(
    execFileSync('git', ['show', `${getCanonicalOid(dirs.repoDir)}:src/value.mjs`], { cwd: dirs.repoDir, encoding: 'utf8' }),
    "export const value = 'v2';\n",
  );
  assert.strictEqual(readFileSync(join(dirs.materializeDir, 'src', 'value.mjs'), 'utf8'), "export const value = 'v2';\n");
});

test('V2 recovery rebases before Hard G and refuses a concurrent same-path overwrite', async () => {
  const root = tempRoot('af-ti-conflict-');
  const dirs = dirsFor(root);
  initRepo(dirs.repoDir, 'v3');
  const task = makeTask({ ...dirs, taskId: `TASK-TI-CONFLICT-${randomUUID().slice(0, 8)}` });
  const baselineOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirs.repoDir, encoding: 'utf8' }).trim();

  const first = await executeTask(task, adaptersFor(async (capsule) => {
    writeFileSync(join(capsule.cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
  }));
  assert.strictEqual(first.state, 'FAILED');
  assert.strictEqual(getCanonicalOid(dirs.repoDir), baselineOid);

  // Another task accepts a change to the same path and advances canonical.
  writeFileSync(join(dirs.repoDir, 'src', 'value.mjs'), "export const value = 'other-task-v3';\n");
  execFileSync('git', ['add', 'src/value.mjs'], { cwd: dirs.repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'other task v3'], { cwd: dirs.repoDir, stdio: 'pipe' });
  const otherOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirs.repoDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/afr/canonical', otherOid, baselineOid], { cwd: dirs.repoDir, stdio: 'pipe' });

  const persisted = JSON.parse(readFileSync(join(process.env.AF_TASKS_DIR, `${task.task_id}.json`), 'utf8'));
  Object.defineProperty(persisted, '__tasksDir', { value: process.env.AF_TASKS_DIR, enumerable: false });
  const recovered = await executeTask(persisted, adaptersFor(async () => {
    throw new Error('author must not be rerun during stale-baseline recovery');
  }));

  assert.strictEqual(recovered.state, 'FAILED');
  assert.match(recovered.failure_reason, /Rebase conflict/);
  assert.strictEqual(
    execFileSync('git', ['show', `${getCanonicalOid(dirs.repoDir)}:src/value.mjs`], { cwd: dirs.repoDir, encoding: 'utf8' }),
    "export const value = 'other-task-v3';\n",
  );
});

test('V2 clean rebase refreshes the candidate so a later recovery preserves concurrent files', async () => {
  const root = tempRoot('af-ti-rebase-clean-');
  const dirs = dirsFor(root);
  initRepo(dirs.repoDir, 'v3');
  const task = makeTask({ ...dirs, taskId: `TASK-TI-REBASE-${randomUUID().slice(0, 8)}` });
  const baselineOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirs.repoDir, encoding: 'utf8' }).trim();

  const first = await executeTask(task, adaptersFor(async (capsule) => {
    writeFileSync(join(capsule.cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
  }));
  assert.strictEqual(first.state, 'FAILED');

  mkdirSync(join(dirs.repoDir, 'docs'));
  writeFileSync(join(dirs.repoDir, 'docs', 'other-task.md'), 'other task accepted\n');
  execFileSync('git', ['add', 'docs/other-task.md'], { cwd: dirs.repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'other task docs'], { cwd: dirs.repoDir, stdio: 'pipe' });
  const otherOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirs.repoDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/afr/canonical', otherOid, baselineOid], { cwd: dirs.repoDir, stdio: 'pipe' });

  const persisted = JSON.parse(readFileSync(join(process.env.AF_TASKS_DIR, `${task.task_id}.json`), 'utf8'));
  Object.defineProperty(persisted, '__tasksDir', { value: process.env.AF_TASKS_DIR, enumerable: false });
  const stillFailing = await executeTask(persisted, adaptersFor(async () => {
    throw new Error('author must not rerun during clean rebase');
  }));
  assert.strictEqual(stillFailing.state, 'FAILED');
  assert.strictEqual(readFileSync(join(dirs.candidateDir, 'docs', 'other-task.md'), 'utf8'), 'other task accepted\n');

  writeFileSync(join(dirs.candidateDir, 'src', 'value.mjs'), "export const value = 'v3';\n");
  const retried = JSON.parse(readFileSync(join(process.env.AF_TASKS_DIR, `${task.task_id}.json`), 'utf8'));
  Object.defineProperty(retried, '__tasksDir', { value: process.env.AF_TASKS_DIR, enumerable: false });
  const completed = await executeTask(retried, adaptersFor(async () => {
    throw new Error('author must not rerun after clean rebase');
  }));
  assert.strictEqual(completed.state, 'COMPLETED');
  assert.strictEqual(
    execFileSync('git', ['show', `${getCanonicalOid(dirs.repoDir)}:docs/other-task.md`], { cwd: dirs.repoDir, encoding: 'utf8' }),
    'other task accepted\n',
  );
});

test('V2 admission rejects governed and multi-step task modes before author launch', async () => {
  const root = tempRoot('af-ti-admission-');
  const dirs = dirsFor(root);
  initRepo(dirs.repoDir);
  const governed = makeTask({ ...dirs, taskId: `TASK-TI-GOV-${randomUUID().slice(0, 8)}` });
  governed.task_mode = 'governed_write';
  await assert.rejects(
    executeTask(governed, adaptersFor(async () => { throw new Error('author must not run'); })),
    (err) => err.code === 'TRUSTED_IMPORT_MODE_UNSUPPORTED',
  );

  const planned = makeTask({ ...dirs, taskId: `TASK-TI-PLAN-${randomUUID().slice(0, 8)}` });
  planned.multi_step_dispatch = true;
  await assert.rejects(
    executeTask(planned, adaptersFor(async () => { throw new Error('author must not run'); })),
    (err) => err.code === 'TRUSTED_IMPORT_MULTI_STEP_UNSUPPORTED',
  );
});

test('V2 recovery survives a real process restart after canonical promotion', () => {
  const root = tempRoot('af-ti-crash-');
  const dirs = dirsFor(root);
  initRepo(dirs.repoDir, 'v2');
  const task = makeTask({ ...dirs, taskId: `TASK-TI-CRASH-${randomUUID().slice(0, 8)}` });
  const taskPath = join(process.env.AF_TASKS_DIR, `${task.task_id}.json`);
  writeFileSync(taskPath, JSON.stringify(task, null, 2));

  const worker = join(process.cwd(), 'tests', 'helpers', 'trusted-import-worker.mjs');
  const crashed = spawnSync(process.execPath, [worker, taskPath, 'crash'], {
    cwd: process.cwd(),
    env: { ...process.env, AF_TASKS_DIR: process.env.AF_TASKS_DIR },
    encoding: 'utf8',
  });
  assert.strictEqual(crashed.status, 97, `worker should crash at the post-CAS fault point: ${crashed.stderr}`);
  const afterCrash = JSON.parse(readFileSync(taskPath, 'utf8'));
  assert.ok(afterCrash.trusted_import.promotion_intent?.new_commit_oid);
  assert.notStrictEqual(afterCrash.state, 'COMPLETED');
  assert.strictEqual(
    execFileSync('git', ['show', `${getCanonicalOid(dirs.repoDir)}:src/value.mjs`], { cwd: dirs.repoDir, encoding: 'utf8' }),
    "export const value = 'v2';\n",
  );

  const recovered = spawnSync(process.execPath, [worker, taskPath, 'recover'], {
    cwd: process.cwd(),
    env: { ...process.env, AF_TASKS_DIR: process.env.AF_TASKS_DIR },
    encoding: 'utf8',
  });
  assert.strictEqual(recovered.status, 0, recovered.stderr || recovered.stdout);
  const afterRecovery = JSON.parse(readFileSync(taskPath, 'utf8'));
  assert.strictEqual(afterRecovery.state, 'COMPLETED');
  assert.strictEqual(afterRecovery.trusted_import.phase, 'PROMOTED');
  assert.strictEqual(afterRecovery.trusted_import.promotion_intent, null);
});

test('V2 recovery accepts a committed promotion that is an ancestor of current canonical', () => {
  const root = tempRoot('af-ti-crash-descendant-');
  const dirs = dirsFor(root);
  initRepo(dirs.repoDir, 'v2');
  const task = makeTask({ ...dirs, taskId: `TASK-TI-CRASH-DESC-${randomUUID().slice(0, 8)}` });
  const taskPath = join(process.env.AF_TASKS_DIR, `${task.task_id}.json`);
  writeFileSync(taskPath, JSON.stringify(task, null, 2));

  const worker = join(process.cwd(), 'tests', 'helpers', 'trusted-import-worker.mjs');
  const crashed = spawnSync(process.execPath, [worker, taskPath, 'crash'], {
    cwd: process.cwd(),
    env: { ...process.env, AF_TASKS_DIR: process.env.AF_TASKS_DIR },
    encoding: 'utf8',
  });
  assert.strictEqual(crashed.status, 97, `worker should crash at the post-CAS fault point: ${crashed.stderr}`);
  const promotedOid = getCanonicalOid(dirs.repoDir);

  // Simulate another accepted task committing on top of the already-promoted
  // transaction before the first task's completion journal is written.
  execFileSync('git', ['checkout', '--detach', promotedOid], { cwd: dirs.repoDir, stdio: 'pipe' });
  mkdirSync(join(dirs.repoDir, 'docs'));
  writeFileSync(join(dirs.repoDir, 'docs', 'other-task.md'), 'other task accepted\n');
  execFileSync('git', ['add', 'docs/other-task.md'], { cwd: dirs.repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'other task after trusted import'], { cwd: dirs.repoDir, stdio: 'pipe' });
  const descendantOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirs.repoDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/afr/canonical', descendantOid, promotedOid], { cwd: dirs.repoDir, stdio: 'pipe' });

  const recovered = spawnSync(process.execPath, [worker, taskPath, 'recover'], {
    cwd: process.cwd(),
    env: { ...process.env, AF_TASKS_DIR: process.env.AF_TASKS_DIR },
    encoding: 'utf8',
  });
  assert.strictEqual(recovered.status, 0, recovered.stderr || recovered.stdout);
  const afterRecovery = JSON.parse(readFileSync(taskPath, 'utf8'));
  assert.strictEqual(afterRecovery.state, 'COMPLETED');
  assert.strictEqual(afterRecovery.trusted_import.phase, 'PROMOTED');
  assert.strictEqual(afterRecovery.trusted_import.promotion_intent, null);
  assert.strictEqual(afterRecovery.trusted_import.promotion.promoted_oid, promotedOid);
  assert.strictEqual(afterRecovery.trusted_import.canonical_oid, descendantOid);
  assert.strictEqual(getCanonicalOid(dirs.repoDir), descendantOid);
  assert.strictEqual(readFileSync(join(dirs.materializeDir, 'docs', 'other-task.md'), 'utf8'), 'other task accepted\n');
});

test('V2 review retry: the verdict names the run that produced it, and the discarded attempt stays in the trail', async () => {
  const root = tempRoot('af-ti-retry-');
  const dirs = dirsFor(root);
  initRepo(dirs.repoDir, 'v2');
  const task = makeTask({ ...dirs, taskId: `TASK-TI-RETRY-${randomUUID().slice(0, 8)}` });
  let reviewCalls = 0;

  const reviewer = {
    type: 'claude',
    supportsMcpUnattended: true,
    async run(capsule) {
      reviewCalls += 1;
      // First attempt: prose that cannot be parsed into a decision. Second: a valid verdict.
      const structured = reviewCalls === 1
        ? { result: 'I looked at the files and they seem fine, but I did not return JSON.' }
        : {
          result: JSON.stringify({
            task_id: capsule.task_id,
            revision: 1,
            decision: 'PASS',
            summary: 'the candidate satisfies the scope',
            issues: [],
            required_changes: [],
            evidence: ['src/value.mjs:1'],
          }),
        };
      return executorResult('claude', 'reviewer', capsule, structured);
    },
    cancel() { return { cancelled: true }; },
  };

  const result = await executeTask(task, adaptersFor(async (capsule) => {
    writeFileSync(join(capsule.cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
  }, reviewer));

  assert.equal(reviewCalls, 2, 'the unparseable review is retried exactly once');
  const reviewRuns = (result.runs ?? []).filter((r) => r.purpose === 'review');
  assert.equal(reviewRuns.length, 2, 'both attempts are recorded');
  assert.notEqual(reviewRuns[0].executor_run_id, reviewRuns[1].executor_run_id, 'each attempt has its own run id');
  assert.equal(result.last_review_run_id, reviewRuns[1].executor_run_id, 'the recorded review run is the one that produced the verdict');
  assert.equal(result.review_retry?.first_run_id, reviewRuns[0].executor_run_id, 'the discarded attempt is named, not lost');
  assert.equal(result.review_retry?.retried_run_id, reviewRuns[1].executor_run_id);
  assert.match(result.review_retry?.reason ?? '', /did not parse/);
  assert.equal(result.last_review?.decision, 'PASS', 'the verdict is the retry\'s');
});
