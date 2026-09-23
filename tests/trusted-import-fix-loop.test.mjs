// trusted-import-fix-loop.test.mjs - the V2 bounded fix loop.
//
// A NEEDS_FIX verdict must re-author WITH the reviewer's feedback (the author capsule reads
// last_review when revision > 1), re-enter the whole pipeline, and stop at a hard bound. A PASS
// after one retry must complete normally; exhausting the budget must fail loudly, never loop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTrustedImportTask } from '../lib/trusted-import/orchestrator-adapter.mjs';

const TERMINATION = { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' };

function fixture(prefix, { maxRevisions } = {}) {
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
  execFileSync('git', ['update-ref', 'refs/afr/canonical', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim()], { cwd: repoDir });

  const taskId = 'TASK-FIX-LOOP';
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
      ...(maxRevisions === undefined ? {} : { max_revisions: maxRevisions }),
      policy: { allowed_root: ['src/**', 'tests/**'], forbidden: [], protected_paths: [], projection: { exclude: [] }, import: { deny: [] } },
      acceptance: { tier: 'TierA', acceptance_profile_digest: 'd', acceptance_assets_digest: 'a', dependency_fixture_id: 'f' },
    },
  };
  return { root, repoDir, tasksDir, taskPath: join(tasksDir, `${taskId}.json`), task };
}

const readTask = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('FIXLOOP-1: NEEDS_FIX re-authors with feedback (revision 2) and then completes', async () => {
  const fx = fixture('af-fixloop-ok-');
  try {
    const revisions = [];
    let reviewCall = 0;
    const deps = (task) => ({
      runAuthor: async (revision, { cwd }) => {
        revisions.push(revision);
        // Revision 1 produces a value the gate test rejects; revision 2 fixes it.
        writeFileSync(join(cwd, 'src', 'value.mjs'), revision === 1 ? "export const value = 'v1-broken';\n" : "export const value = 'v2';\n");
        return { executor_run_id: `RUN-A${revision}`, writer_termination: TERMINATION };
      },
      runReview: async () => {
        reviewCall += 1;
        task.last_review_termination_evidence = TERMINATION;
        return reviewCall === 1
          ? { decision: 'NEEDS_FIX', required_changes: ['export value as v2'], issues: ['gate would fail'] }
          : { decision: 'PASS', summary: 'ok' };
      },
      saveTask: (t) => writeFileSync(fx.taskPath, `${JSON.stringify(t, null, 2)}\n`),
    });

    // ---- attempt 1: must ask for a re-author, not fail outright -------------
    let firstError = null;
    try { await runTrustedImportTask(fx.task, deps(fx.task)); } catch (err) { firstError = err; }
    assert.ok(firstError, 'a NEEDS_FIX review must interrupt the run');
    assert.equal(firstError.code, 'TRUSTED_IMPORT_NEEDS_FIX_RETRY');

    const afterFirst = readTask(fx.taskPath);
    assert.equal(afterFirst.trusted_import.revisions_used, 1);
    assert.equal(afterFirst.trusted_import.author_completed, false, 'the author phase must be reset for the retry');
    assert.equal(afterFirst.trusted_import.review_completed, false);
    assert.equal(afterFirst.trusted_import.fix_loop.attempts, 1);
    assert.deepEqual(afterFirst.trusted_import.fix_loop.last_required_changes, ['export value as v2']);

    // ---- attempt 2: a fresh invocation re-authors and completes -------------
    const resumed = readTask(fx.taskPath);
    await runTrustedImportTask(resumed, deps(resumed));
    const done = readTask(fx.taskPath);
    assert.equal(done.state, 'COMPLETED', `expected COMPLETED, got ${done.state} (${done.failure_reason ?? 'no reason'})`);
    assert.equal(done.trusted_import.phase, 'PROMOTED');
    assert.deepEqual(revisions, [1, 2], 'the retry must re-author as revision 2 so the capsule carries the feedback');
    assert.equal(done.trusted_import.revisions_used, 1, 'a successful review does not consume more budget');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('FIXLOOP-2: exhausting the revision budget is a hard failure, never an endless loop', async () => {
  const fx = fixture('af-fixloop-exhaust-', { maxRevisions: 1 });
  try {
    const deps = (task) => ({
      runAuthor: async (revision, { cwd }) => {
        writeFileSync(join(cwd, 'src', 'value.mjs'), `export const value = 'still-wrong-${revision}';\n`);
        return { executor_run_id: `RUN-A${revision}`, writer_termination: TERMINATION };
      },
      runReview: async () => {
        task.last_review_termination_evidence = TERMINATION;
        return { decision: 'NEEDS_FIX', required_changes: ['still not v2'] };
      },
      saveTask: (t) => writeFileSync(fx.taskPath, `${JSON.stringify(t, null, 2)}\n`),
    });

    let first = null;
    try { await runTrustedImportTask(fx.task, deps(fx.task)); } catch (err) { first = err; }
    assert.equal(first.code, 'TRUSTED_IMPORT_NEEDS_FIX_RETRY', 'the first retry is allowed');
    assert.equal(readTask(fx.taskPath).trusted_import.revisions_used, 1);

    const resumed = readTask(fx.taskPath);
    let second = null;
    try { await runTrustedImportTask(resumed, deps(resumed)); } catch (err) { second = err; }
    assert.equal(second.code, 'TRUSTED_IMPORT_FIX_LOOP_EXHAUSTED', 'the budget must be enforced');
    const finalTask = readTask(fx.taskPath);
    assert.equal(finalTask.trusted_import.revisions_used, 1, 'no further revisions are consumed once exhausted');
    assert.notEqual(finalTask.state, 'COMPLETED');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('FIXLOOP-3: a non-fixable verdict (FAIL) is not retried', async () => {
  const fx = fixture('af-fixloop-fail-');
  try {
    const deps = (task) => ({
      runAuthor: async (revision, { cwd }) => {
        writeFileSync(join(cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
        return { executor_run_id: `RUN-A${revision}`, writer_termination: TERMINATION };
      },
      runReview: async () => {
        task.last_review_termination_evidence = TERMINATION;
        return { decision: 'FAIL', issues: ['unsafe change'] };
      },
      saveTask: (t) => writeFileSync(fx.taskPath, `${JSON.stringify(t, null, 2)}\n`),
    });
    let err = null;
    try { await runTrustedImportTask(fx.task, deps(fx.task)); } catch (e) { err = e; }
    assert.equal(err.code, 'TRUSTED_IMPORT_REVIEW_FAILED');
    assert.equal(readTask(fx.taskPath).trusted_import.revisions_used ?? 0, 0, 'FAIL must not consume fix-loop budget');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
