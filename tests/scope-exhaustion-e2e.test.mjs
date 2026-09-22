// scope-exhaustion-e2e.test.mjs - A2/A1b end-to-end: a REAL reap race that exhausts the
// DEFAULT rescan budget inside ONE trusted-import lifecycle, then verifies retention,
// on-disk persistence, the alert log, the operator CLI, and controlled recovery.
//
// How the race is made deterministic WITHOUT touching production code:
//   `inspectWriterScopes()` probes each `af-*` directory in `readdir()` order, reading
//   `<scope>/cgroup.procs`. If that file is a FIFO, the scan's `readFileSync` parks until
//   a writer appears. The test therefore creates two synthetic scopes in a dedicated temp
//   base, ordered [fifo, target]:
//     1. the scan lists both, parks on the FIFO;
//     2. the reaper's `open(FIFO, 'w')` returns exactly while the scan is parked, so it can
//        remove the TARGET - which the scan has listed but not yet `lstat`ed;
//     3. a zero-byte write releases the scan, which then sees ENOENT for the target:
//        one `reaped` observation, the real race, with no timing guesswork;
//     4. the reaper recreates the target for the next scan and repeats.
//   Four rounds therefore produce `attempts=4` under the DEFAULT budget (3 rescans).
//
// Fixtures are dedicated temp dirs; no production task, scope or alert log is touched.

import './helpers/asset-lock-root.mjs'; // keeps asset locks out of the repository runtime
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { spawnManaged, killTree } from '../lib/child-process.mjs';
import {
  disengageTaskHostBoundary,
  recoverRetainedBoundary,
} from '../lib/host-boundary.mjs';
import {
  inspectBoundaryAlerts,
  readBoundaryAlertEvents,
} from '../lib/boundary-alerts.mjs';
import { runTrustedImportTask } from '../lib/trusted-import/orchestrator-adapter.mjs';

const CLI = join(process.cwd(), 'af-admin.mjs');
const ROUNDS = 4; // default budget: 3 rescans + the final attempt

/** Owner/group/mode map used to prove the recovery restores the tree exactly. */
function metadataMap(dir) {
  const out = {};
  const walk = (current, rel) => {
    const st = lstatSync(current);
    out[rel] = `${st.uid}:${st.gid}:${(st.mode & 0o7777).toString(8)}`;
    if (st.isDirectory()) {
      for (const name of readdirSync(current).sort()) walk(join(current, name), rel === '' ? name : `${rel}/${name}`);
    }
  };
  walk(dir, '');
  return out;
}

const REAPER_SOURCE = `
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
const { GATE1, GATE2, TARGET, ROUNDS, EVIDENCE } = process.env;
const log = (o) => appendFileSync(EVIDENCE, JSON.stringify({ at: Date.now(), ...o }) + '\\n');
for (let i = 1; i <= Number(ROUNDS); i += 1) {
  // Phase 1: the scan has passed its readdir and parked on GATE1 (both the target and GATE2
  // were listed, and the target has NOT been lstat'ed yet).
  const t0 = Date.now();
  const fd1 = openSync(GATE1, 'w');
  const gate1Ms = Date.now() - t0;
  const existedBefore = existsSync(TARGET);
  rmSync(TARGET, { recursive: true, force: true });
  const removed = !existsSync(TARGET);
  writeSync(fd1, ''); closeSync(fd1);          // release: the scan now hits ENOENT on the target
  // Phase 2: the scan parked on GATE2, which proves its lstat(target) already happened, so
  // re-creating the target now cannot erase the observation and is in place before the next
  // readdir. This ordering is what removes the previous sleep-based timing dependency.
  const t1 = Date.now();
  const fd2 = openSync(GATE2, 'w');
  const gate2Ms = Date.now() - t1;
  mkdirSync(TARGET, { recursive: true });
  writeFileSync(TARGET + '/cgroup.procs', '\\n');
  const recreated = existsSync(TARGET);
  writeSync(fd2, ''); closeSync(fd2);
  log({ round: i, gate1Ms, gate2Ms, existedBefore, removed, recreated });
}
// Disarm so nothing can ever block on a FIFO again.
for (const gate of [GATE1, GATE2]) { rmSync(gate, { force: true }); writeFileSync(gate, '\\n'); }
log({ disarmed: true });
`;

test('A2/A1b e2e: real race exhausts the DEFAULT budget in one lifecycle, then recovery closes the alert', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-e2e-exhaustion-'));
  const repoDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const candidateDir = join(root, 'candidate');
  const tasksDir = join(root, 'tasks');
  const scopeBase = mkdtempSync(join(tmpdir(), 'af-e2e-scopes-'));
  const alertsFile = join(root, 'boundary-alerts.jsonl');
  const evidenceFile = join(root, 'reaper-evidence.jsonl');
  const reaperSource = join(root, 'reaper.mjs');
  // The scan meets entries in readdir order, and on a hash-ordered filesystem (ext2/3, as
  // /tmp is here) that order depends on the NAMES, not on creation order. So the three
  // scope names are chosen by a bounded search until the measured order is exactly
  // [gate1, target, gate2]; the final order is then asserted before the run.
  const pickNames = () => {
    const suffix = () => Math.random().toString(36).slice(2, 8);
    return { gate1: `af-writer-${suffix()}`, target: `af-writer-${suffix()}`, gate2: `af-writer-${suffix()}` };
  };
  let names = null;
  for (let attempt = 0; attempt < 200 && !names; attempt += 1) {
    const candidate = pickNames();
    const created = [candidate.gate1, candidate.target, candidate.gate2];
    for (const n of created) mkdirSync(join(scopeBase, n), { recursive: true });
    const seen = readdirSync(scopeBase).filter((n) => n.startsWith('af-writer-'));
    if (seen.indexOf(candidate.gate1) < seen.indexOf(candidate.target)
      && seen.indexOf(candidate.target) < seen.indexOf(candidate.gate2)) {
      names = candidate;
    } else {
      for (const n of created) rmSync(join(scopeBase, n), { recursive: true, force: true });
    }
  }
  assert.ok(names, 'could not find scope names whose readdir order is gate1 < target < gate2');
  const gate1Scope = join(scopeBase, names.gate1);
  const gate1Path = join(gate1Scope, 'cgroup.procs');
  const target = join(scopeBase, names.target);
  const gate2Scope = join(scopeBase, names.gate2);
  const gate2Path = join(gate2Scope, 'cgroup.procs');

  for (const dir of [repoDir, casDir, candidateDir, tasksDir]) mkdirSync(dir, { recursive: true });

  // Dedicated fixture repository (never the working repo).
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'tester@test.local'], { cwd: repoDir, stdio: 'pipe' });
  mkdirSync(join(repoDir, 'src'));
  mkdirSync(join(repoDir, 'tests'));
  writeFileSync(join(repoDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
  writeFileSync(join(repoDir, 'README.md'), 'fixture\n');
  chmodSync(join(repoDir, 'src', 'value.mjs'), 0o600); // private file must survive the round trip
  writeFileSync(
    join(repoDir, 'tests', 'gate.test.mjs'),
    `import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nimport { test } from 'node:test';\ntest('gate', () => assert.equal(value, 'v2'));\n`,
  );
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoDir, stdio: 'pipe' });
  const baseOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/afr/canonical', baseOid], { cwd: repoDir });

  // Synthetic scope base: [fifo, target] in readdir order.
  execFileSync('mkfifo', [gate1Path]);
  execFileSync('mkfifo', [gate2Path]);
  writeFileSync(join(target, 'cgroup.procs'), '\n');
  const order = readdirSync(scopeBase).filter((n) => n.startsWith('af-writer-'));
  assert.deepEqual(order, [names.gate1, names.target, names.gate2],
    `the scan must meet gate1, then the target, then gate2: got ${order.join(', ')}`);

  const taskId = 'TASK-A2-E2E-EXHAUSTION';
  const taskPath = join(tasksDir, `${taskId}.json`);
  const task = {
    task_id: taskId,
    fixture_dir: repoDir,
    state: 'CREATED',
    host_isolation: true,
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
      acceptance: { tier: 'TierA', acceptance_profile_digest: 'digest-e2e', acceptance_assets_digest: 'assets-e2e', dependency_fixture_id: 'dep-e2e' },
    },
  };

  const oldCgroup = process.env.AF_CGROUP_BASE;
  const oldAlerts = process.env.AF_BOUNDARY_ALERTS_FILE;
  const oldBudget = process.env.AF_SCOPE_RESCAN_BUDGET;
  let reaper = null;
  let before = null;

  try {
    // The DEFAULT budget must be in force: no override, no zero-budget shortcut.
    delete process.env.AF_SCOPE_RESCAN_BUDGET;
    process.env.AF_CGROUP_BASE = scopeBase;
    process.env.AF_BOUNDARY_ALERTS_FILE = alertsFile;

    before = metadataMap(repoDir);
    // NOTE: the lifecycle engages the boundary itself (casDir is initialised before the
    // engage step), so the fixture must NOT be pre-engaged here.
    writeFileSync(reaperSource, REAPER_SOURCE);
    reaper = spawnManaged(process.execPath, [reaperSource], {
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, GATE1: gate1Path, GATE2: gate2Path, TARGET: target, ROUNDS: String(ROUNDS), EVIDENCE: evidenceFile },
    });

    await runTrustedImportTask(task, {
      runAuthor: async (rev, { cwd }) => {
        writeFileSync(join(cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
        return {
          executor_run_id: 'RUN-AUTHOR-E2E',
          writer_termination: { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' },
        };
      },
      runReview: async () => {
        task.last_review_termination_evidence = { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' };
        return { decision: 'PASS', summary: 'value is v2 and the gate passes' };
      },
      saveTask: (t) => writeFileSync(taskPath, `${JSON.stringify(t, null, 2)}\n`),
    });

    // The reaper should have finished all rounds and disarmed the FIFO by itself.
    const exit = await new Promise((resolve) => {
      if (reaper.exitCode !== null || reaper.signalCode !== null) { resolve('already-exited'); return; }
      const timer = setTimeout(() => resolve('timeout'), 15000);
      reaper.once('exit', () => { clearTimeout(timer); resolve('exited'); });
    });
    assert.notEqual(exit, 'timeout', 'the reaper must finish its rounds without being killed');

    const rounds = readFileSync(evidenceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const armed = rounds.filter((r) => r.round);
    assert.equal(armed.length, ROUNDS, `every default-budget attempt must have been armed by a real deletion, got ${armed.length}`);
    assert.deepEqual(armed.map((r) => r.round), [1, 2, 3, 4]);
    assert.equal(armed.every((r) => r.existedBefore === true), true, 'each scan must have listed the target before it was removed');
    assert.equal(armed.every((r) => r.removed === true && r.recreated === true), true, 'each round removes then re-creates the target');
    assert.equal(rounds[rounds.length - 1].disarmed, true, 'both gates must be disarmed so later scans cannot block');
    assert.equal(readFileSync(gate1Path, 'utf8'), '\n', 'gate1 is a regular file again after disarming');
    assert.equal(readFileSync(gate2Path, 'utf8'), '\n', 'gate2 is a regular file again after disarming');

    // 1. RETAIN under the DEFAULT budget, driven by a real race.
    const ti = task.trusted_import;
    assert.equal(ti.boundary_state, 'PROTECTION_RETAINED_PENDING_RECOVERY');
    const decision = ti.boundary_scope_decision;
    assert.equal(decision.decision, 'RETAIN');
    assert.equal(decision.reason, 'rescan-budget-exhausted');
    assert.equal(decision.attempts, 4, `default budget must exhaust on attempt 4, got ${decision.attempts}`);
    assert.equal(decision.quiesce_confirmed, true);
    assert.equal(decision.reaped_observations >= 1, true, 'the race must have been observed as a reaped scope');
    assert.equal(decision.anomalies.length, 0, 'a reaped observation is not an anomaly');

    // 2. Protection retained: the canonical tree is still root-owned.
    assert.equal(lstatSync(repoDir).uid, 0);
    assert.throws(() => chmodSync(repoDir, 0o777), /(EPERM|EACCES)/);

    // 3. Persisted: the task record re-read from disk carries the decision.
    const onDisk = JSON.parse(readFileSync(taskPath, 'utf8'));
    assert.equal(onDisk.trusted_import.boundary_state, 'PROTECTION_RETAINED_PENDING_RECOVERY');
    assert.equal(onDisk.trusted_import.boundary_scope_decision.reason, 'rescan-budget-exhausted');
    assert.equal(onDisk.trusted_import.boundary_scope_decision.attempts, 4);
    assert.equal(onDisk.trusted_import.boundary_alert.occurrences, 1);
    assert.equal(onDisk.trusted_import.boundary_alert.severity, 'warning');

    // 4. The alert log re-read from disk, plus the operator CLI.
    const events = readBoundaryAlertEvents({ file: alertsFile });
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'boundary_retained');
    assert.equal(events[0].task_id, taskId);
    assert.equal(events[0].scope_decision.reason, 'rescan-budget-exhausted');
    assert.equal(events[0].scope_decision.attempts, 4);
    const open = inspectBoundaryAlerts({ file: alertsFile });
    assert.equal(open.ok, true);
    assert.equal(open.alerts.length, 1);
    assert.equal(open.alerts[0].canonical_dir, repoDir);

    // execFileSync throws on a non-zero exit, so the CLI run is wrapped to assert the code.
    const cliRun = (() => {
      try {
        const out = execFileSync(process.execPath, [CLI, 'boundary', 'alerts'], {
          env: { ...process.env, AF_BOUNDARY_ALERTS_FILE: alertsFile }, encoding: 'utf8',
        });
        return { status: 0, stdout: out };
      } catch (err) {
        return { status: err.status, stdout: `${err.stdout ?? ''}` };
      }
    })();
    assert.equal(cliRun.status, 1, 'an open alert must make the CLI exit 1');
    assert.match(cliRun.stdout, /boundary alerts: 1 open/);
    assert.match(cliRun.stdout, new RegExp(repoDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // 5. Cleanup through the CONTROLLED recovery (never `force`), then verify closure.
    rmSync(gate1Scope, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(gate2Scope, { recursive: true, force: true });
    const recovered = recoverRetainedBoundary({
      canonicalDir: repoDir,
      casDir,
      justification: 'A2/A1b e2e: operator verified no writer processes remain',
    });
    assert.equal(recovered.outcome, 'DISENGAGED', `recovery failed: ${recovered.reason}`);
    assert.equal(recovered.delivered, true);
    assert.equal(recovered.report.mismatches.length, 0);
    // Only pre-existing entries can be compared: the run legitimately creates new git
    // objects while the tree is protected (they get the conservative default mode).
    const after = metadataMap(repoDir);
    const drifted = Object.entries(before)
      .filter(([rel, meta]) => after[rel] !== undefined && after[rel] !== meta)
      .map(([rel, meta]) => ({ rel, before: meta, after: after[rel] }));
    assert.deepEqual(drifted, [], `the recovery must restore pre-existing metadata exactly: ${JSON.stringify(drifted)}`);
    assert.equal(lstatSync(repoDir).uid, process.getuid());

    const closed = inspectBoundaryAlerts({ file: alertsFile, includeResolved: true });
    assert.equal(closed.alerts[0].open, false, 'the recovery must close the alert');
    const finalEvents = readBoundaryAlertEvents({ file: alertsFile });
    assert.equal(finalEvents[finalEvents.length - 1].event, 'boundary_released');
    assert.equal(readdirSync(scopeBase).filter((n) => n.startsWith('af-writer-')).length, 0, 'no synthetic scope residue');
  } finally {
    if (reaper && reaper.exitCode === null && reaper.signalCode === null) {
      try { await killTree(reaper, { graceMs: 500 }); } catch { /* best effort */ }
    }
    try { disengageTaskHostBoundary({ canonicalDir: repoDir, casDir, force: true }); } catch { /* best effort */ }
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    if (oldAlerts !== undefined) process.env.AF_BOUNDARY_ALERTS_FILE = oldAlerts; else delete process.env.AF_BOUNDARY_ALERTS_FILE;
    if (oldBudget !== undefined) process.env.AF_SCOPE_RESCAN_BUDGET = oldBudget; else delete process.env.AF_SCOPE_RESCAN_BUDGET;
    rmSync(scopeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
