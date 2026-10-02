// trusted-import-human-gate-e2e.test.mjs - END-TO-END feasibility of the V2 Human Gate loop.
//
// Drives the real adapter (only the author/reviewer executors are injected) through:
//   run 1  -> the candidate touches a PROTECTED path, so the task must PARK (WAITING_HUMAN)
//   approve-> a signed operator approval is minted and recorded
//   run 2  -> the resumed run carries the approval, the closure closes, and the task completes
// and it also asserts the negative: a resumed run WITHOUT an approval parks again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTrustedImportTask } from '../lib/trusted-import/orchestrator-adapter.mjs';
import { resolveV2HumanGate } from '../lib/trusted-import/human-gate-resume.mjs';
import { getCanonicalOid } from '../lib/trusted-import/index.mjs';

const OID = 'a'.repeat(40);

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
  writeFileSync(join(repoDir, 'SECURITY.md'), 'baseline policy\n');
  writeFileSync(join(repoDir, 'tests', 'gate.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nimport { test } from 'node:test';\ntest('gate', () => assert.equal(value, 'v2'));\n");
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoDir, stdio: 'pipe' });
  const oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/afr/canonical', oid], { cwd: repoDir });
  return { root, repoDir, casDir, candidateDir, tasksDir, baselineOid: oid };
}

function makeTask(fx, { touchProtected = true } = {}) {
  const taskId = 'TASK-HG-E2E';
  return {
    task: {
      task_id: taskId,
      fixture_dir: fx.repoDir,
      state: 'CREATED',
      author_executor: 'codex',
      reviewer_executor: 'claude',
      acceptance_cmd: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
      acceptance_binding: null,
      trusted_import: {
        enabled: true,
        candidate_dir: fx.candidateDir,
        cas_dir: fx.casDir,
        proposed_required: ['src/**'],
        policy: { allowed_root: ['src/**', 'tests/**', 'SECURITY.md'], forbidden: [], protected_paths: ['SECURITY.md'], projection: { exclude: [] }, import: { deny: [] } },
        acceptance: { tier: 'TierA', acceptance_profile_digest: 'd', acceptance_assets_digest: 'a', dependency_fixture_id: 'f' },
      },
    },
    taskPath: join(fx.tasksDir, `${taskId}.json`),
    touchProtected,
  };
}

const TERMINATION = { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' };

const deps = (fx, holder, task) => ({
  runAuthor: async (rev, { cwd }) => {
    writeFileSync(join(cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
    if (holder.touchProtected) writeFileSync(join(cwd, 'SECURITY.md'), 'baseline policy\nhardened note\n');
    return { executor_run_id: 'RUN-A', writer_termination: TERMINATION };
  },
  runReview: async () => {
    // The adapter records the reviewer's termination evidence from the task field (same contract
    // the lifecycle tests use): a review without it is refused as unconfirmed.
    task.last_review_termination_evidence = TERMINATION;
    return { decision: 'PASS', summary: 'ok' };
  },
  saveTask: (t) => writeFileSync(holder.taskPath, `${JSON.stringify(t, null, 2)}\n`),
});

test('V2HG-E2E: a protected change PARKS, a signed approval resumes it, and the task completes', async () => {
  const fx = fixture('af-hg-e2e-');
  try {
    const holder = { taskPath: null, touchProtected: true };
    const { task, taskPath } = makeTask(fx);
    holder.taskPath = taskPath;

    // ---- run 1: must park, not fail ----------------------------------------
    await runTrustedImportTask(task, deps(fx, holder, task));
    const parked = JSON.parse(readFileSync(taskPath, 'utf8'));
    assert.equal(parked.state, 'WAITING_HUMAN', 'a protected change must park the task, never fail it');
    assert.equal(parked.trusted_import.phase, 'WAITING_HUMAN');
    assert.equal(parked.trusted_import.pending_human_decisions.length, 1);
    assert.equal(parked.trusted_import.pending_human_decisions[0].path, 'SECURITY.md');
    assert.equal(parked.failure_reason ?? null, null, 'parking is not a failure');

    // ---- an UNapproved resume parks again (fail-closed) ---------------------
    const stillParked = { ...parked };
    await runTrustedImportTask(stillParked, deps(fx, holder, stillParked));
    assert.equal(stillParked.state, 'WAITING_HUMAN', 'without an approval the run must park again');
    assert.equal(stillParked.trusted_import.pending_human_decisions.length, 1);

    // ---- approve -----------------------------------------------------------
    const authenticator = ({ auditDigest }) => ({ verified: true, signature: `sig:${auditDigest.slice(0, 8)}`, keyId: 'e2e' });
    const approved = resolveV2HumanGate({
      task: stillParked,
      operatorIdentity: 'alice',
      justification: 'operator reviewed the protected edit',
      operatorAuthenticator: authenticator,
      saveTask: (t) => writeFileSync(taskPath, `${JSON.stringify(t, null, 2)}\n`),
    });
    assert.equal(approved.ok, true, approved.reason ?? '');
    assert.deepEqual(approved.approved_paths, ['SECURITY.md']);

    // ---- run 2: the approval closes the closure and the task completes ------
    await runTrustedImportTask(stillParked, {
      ...deps(fx, holder, stillParked),
      humanApprovalProvider: async () => approved.approval,
    });
    const done = JSON.parse(readFileSync(taskPath, 'utf8'));
    assert.equal(done.state, 'COMPLETED', `expected COMPLETED, got ${done.state} (${done.failure_reason ?? 'no reason'})`);
    assert.equal(done.trusted_import.phase, 'PROMOTED');
    assert.notEqual(getCanonicalOid(fx.repoDir), fx.baselineOid, 'the canonical ref must advance after the approved promotion');

    const content = execFileSync('git', ['show', 'refs/afr/canonical:SECURITY.md'], { cwd: fx.repoDir, encoding: 'utf8' });
    assert.match(content, /hardened note/, 'the operator-approved protected change must be what was promoted');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
