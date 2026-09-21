// scope-scan-race.mjs - A2 quantification: writer-scope scan vs. concurrent reap
//
// Measures `inspectWriterScopes()` while scope directories are removed by ANOTHER
// PROCESS (an in-process reap cannot interleave with a synchronous scan). Two
// families of scenarios:
//
//   SIMULATED (plain directories + simulated cgroup.procs): S1..S7
//   REAL cgroup (delegated cgroup v2 base, real child processes, production
//   reapWriterScope): S8a reap storm, S8b live-writer property, S9 post-quiesce
//
// This harness never changes a decision: nothing is unlocked, `force` and
// `acknowledgeLiveScopes` are never used.
//
// Methodology notes (fixed after independent review):
//   - the storm window is measured by YIELDING each iteration so the reaper's exit
//     state is observed; scans are split into `during_storm` and `after_storm`;
//   - `classify()` checks errno signals (EACCES/EPERM/EIO) BEFORE the broader
//     "missing cgroup.procs" bucket, and reports co-occurring signals;
//   - persistent classes get a uniform budget of 3 rescans, and the actual number
//     of scans performed is reported.
//
// Usage:
//   node verification/scope-scan-race.mjs [--scopes 400] [--max-scans 60000] [--json <path>]
//   node verification/scope-scan-race.mjs --reaper <dir> --scopes N             (internal)
//   node verification/scope-scan-race.mjs --cgroup-reaper <base> [--keep <path>] (internal)

import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWriterScopes, getActiveWriterScopes, MAX_WRITER_SCOPE_DEPTH } from '../lib/host-boundary.mjs';
import {
  attachWriterScope,
  createWriterScope,
  killTree,
  reapWriterScope,
  spawnManaged,
} from '../lib/child-process.mjs';

const CGROUP_BASE = process.env.AF_RACE_CGROUP_BASE
  || '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice';

const argv = process.argv.slice(2);
function argValue(flag, fallback = null) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const spin = (us) => { const end = process.hrtime.bigint() + BigInt(Math.max(us, 0) * 1000); while (process.hrtime.bigint() < end) { /* spin */ } };
const yieldLoop = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Classify one scan observation into a decision-relevant class.
 * errno signals win over the broader "missing cgroup.procs" bucket, because the
 * production probe uses existsSync() which swallows EACCES/EIO/ELOOP into `false`.
 */
export function classify(observation) {
  if (observation.status === 'empty') return { status: 'empty', klass: 'empty', retain: false, signals: [] };
  if (observation.status === 'active') return { status: 'active', klass: 'active', retain: true, signals: [] };

  const reason = observation.reason || '';
  const signals = [];
  if (/EACCES|EPERM/.test(reason)) signals.push('permission');
  if (/EIO/.test(reason)) signals.push('io');
  if (/cgroup\.procs: ENOENT/.test(reason)) signals.push('procs-vanished');
  if (/missing cgroup\.procs/.test(reason)) signals.push('missing-procs');
  if (/truncated at depth/.test(reason)) signals.push('truncated');
  if (signals.length === 0 && /ENOENT/.test(reason)) signals.push('dir-vanished');

  let klass = 'unknown:other';
  if (signals.includes('truncated')) klass = 'unknown:truncated';
  else if (signals.includes('permission')) klass = 'unknown:permission';
  else if (signals.includes('io')) klass = 'unknown:io';
  else if (signals.includes('procs-vanished')) klass = 'unknown:procs-vanished';
  else if (signals.includes('missing-procs')) klass = 'unknown:missing-procs';
  else if (signals.includes('dir-vanished')) klass = 'unknown:dir-vanished';

  return { status: observation.status, klass, retain: observation.status !== 'empty', reason, signals };
}

// ---------------------------------------------------------------------------
// Internal child mode: remove plain (simulated) scope directories.
// ---------------------------------------------------------------------------
if (argv.includes('--reaper')) {
  const base = argValue('--reaper');
  const scopes = Number(argValue('--scopes', '400'));
  for (let i = 0; i < scopes; i += 1) {
    spin(50 + Math.floor(Math.random() * 450));
    try { rmSync(join(base, `af-writer-race-${i}`), { recursive: true, force: true }); } catch { /* already gone */ }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Internal child mode: reap REAL writer cgroups with production logic.
// ---------------------------------------------------------------------------
if (argv.includes('--cgroup-reaper')) {
  const base = argValue('--cgroup-reaper');
  const keep = argValue('--keep');
  const scopes = Number(argValue('--scopes', '60'));
  for (let i = 0; i < scopes; i += 1) {
    spin(50 + Math.floor(Math.random() * 450));
    const candidates = readdirSync(base).filter((n) => n.startsWith('af-writer-') && join(base, n) !== keep);
    if (candidates.length === 0) break;
    const path = join(base, candidates[0]);
    const handle = {
      kind: 'cgroup',
      path,
      procs_path: join(path, 'cgroup.procs'),
      kill_path: join(path, 'cgroup.kill'),
      attached: true,
      verified: true,
      reason: null,
    };
    try { await reapWriterScope(handle, { graceMs: 500, pollMs: 10 }); } catch { /* best effort */ }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent mode
// ---------------------------------------------------------------------------
const SCOPES = Number(argValue('--scopes', '400'));
const MAX_SCANS = Number(argValue('--max-scans', '60000'));
const JSON_OUT = argValue('--json');
const PERSISTENT_RESCANS = 3;

const results = {
  schema: 'af-scope-race-quantification-v2',
  started_at: new Date().toISOString(),
  parameters: { scopes: SCOPES, max_scans: MAX_SCANS, persistent_rescans: PERSISTENT_RESCANS, cgroup_base: CGROUP_BASE },
  methodology: {
    storm_window: 'each scan iteration yields to the event loop, so the reaper exit state is observed; during_storm and after_storm scans are counted separately',
    classifier_priority: ['truncated', 'permission(EACCES/EPERM)', 'io(EIO)', 'procs-vanished', 'missing-procs', 'dir-vanished'],
    simulated_vs_real: 'S1..S7 use plain directories with simulated cgroup.procs; S8*/S9 use the delegated cgroup v2 base with real child processes and production reapWriterScope',
  },
  s1_burst: null,
  s2_orphan: null,
  s3_unreadable: null,
  s4_truncated: null,
  s5_clean: null,
  s6_rescan: null,
  s7_live_writer_simulated: null,
  s8a_real_cgroup_storm: null,
  s8b_real_live_writer: null,
  s9_post_quiesce: null,
};

const waitExit = (child) => (child.exitCode === null && child.signalCode === null
  ? new Promise((resolve) => { child.once('exit', resolve); })
  : Promise.resolve());

const tally = (classes) => classes.reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {});

/** Scan a base in a yielding loop until `isDone()` is true (or the budget is hit). */
async function scanStorm({ base, isDone, maxScans }) {
  const during = [];
  const started = Date.now();
  let scans = 0;
  while (scans < maxScans) {
    if (isDone()) break;
    during.push(classify(inspectWriterScopes(base)));
    scans += 1;
    await yieldLoop();
  }
  const elapsedMs = Date.now() - started;
  const after = [];
  for (let i = 0; i < 50; i += 1) after.push(classify(inspectWriterScopes(base)));
  return {
    during,
    after,
    elapsed_ms: elapsedMs,
    scans_per_sec: Math.round((scans / Math.max(elapsedMs, 1)) * 1000),
    residual_entries: (() => {
      try { return readdirSync(base).filter((n) => n.startsWith('af-writer-')).length; } catch { return null; }
    })(),
  };
}

function summarise(storm) {
  const classes = tally(storm.during.map((o) => o.klass));
  const afterClasses = tally(storm.after.map((o) => o.klass));
  const unknown = storm.during.filter((o) => o.status === 'unknown').length;
  const signalPairs = {};
  for (const o of storm.during) {
    if (o.signals.length > 1) signalPairs[o.signals.join('+')] = (signalPairs[o.signals.join('+')] || 0) + 1;
  }
  return {
    scans_during_storm: storm.during.length,
    scans_after_storm: storm.after.length,
    elapsed_ms: storm.elapsed_ms,
    scans_per_sec: storm.scans_per_sec,
    classes_during_storm: classes,
    classes_after_storm: afterClasses,
    unknown_during_storm: unknown,
    unknown_rate_during_storm: storm.during.length ? Number((unknown / storm.during.length).toExponential(3)) : null,
    co_occurring_signals: signalPairs,
    residual_af_writer_entries_after: storm.residual_entries,
  };
}

const base = mkdtempSync(join(tmpdir(), 'af-scope-race-'));
let createdRealScopes = [];

try {
  // -------------------------------------------------------------------------
  // S1: burst reap race (SIMULATED dirs), separate-process reaper
  // -------------------------------------------------------------------------
  for (let i = 0; i < SCOPES; i += 1) {
    const dir = join(base, `af-writer-race-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.procs'), '\n');
  }
  const reaper = spawn(process.execPath, [fileURLToPath(import.meta.url), '--reaper', base, '--scopes', String(SCOPES)], { stdio: 'ignore' });
  const s1 = summarise(await scanStorm({ base, isDone: () => reaper.exitCode !== null, maxScans: MAX_SCANS }));
  await waitExit(reaper);
  results.s1_burst = { ...s1, mode: 'simulated directories' };

  // -------------------------------------------------------------------------
  // S6: bounded rescan convergence during a storm (SIMULATED)
  // -------------------------------------------------------------------------
  const base2 = mkdtempSync(join(tmpdir(), 'af-scope-race2-'));
  for (let i = 0; i < SCOPES; i += 1) {
    const dir = join(base2, `af-writer-race-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.procs'), '\n');
  }
  const reaper2 = spawn(process.execPath, [fileURLToPath(import.meta.url), '--reaper', base2, '--scopes', String(SCOPES)], { stdio: 'ignore' });
  const convergence = { unknown_total: 0, converged_at_1: 0, converged_at_2: 0, converged_at_3: 0, never: 0 };
  let scans2 = 0;
  while (scans2 < MAX_SCANS) {
    if (reaper2.exitCode !== null) break;
    const first = classify(inspectWriterScopes(base2));
    scans2 += 1;
    if (first.status === 'unknown') {
      convergence.unknown_total += 1;
      let settled = 0;
      for (let k = 1; k <= 3 && settled === 0; k += 1) {
        const again = classify(inspectWriterScopes(base2));
        if (again.status !== 'unknown') settled = k;
      }
      if (settled === 0) convergence.never += 1;
      else convergence[`converged_at_${settled}`] += 1;
    }
    await yieldLoop();
  }
  await waitExit(reaper2);
  results.s6_rescan = {
    mode: 'simulated directories',
    scans_during_storm: scans2,
    ...convergence,
    converged_rate: convergence.unknown_total
      ? Number(((convergence.unknown_total - convergence.never) / convergence.unknown_total).toFixed(4))
      : null,
    final_status_after_storm: classify(inspectWriterScopes(base2)).status,
  };
  rmSync(base2, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // S5: clean base
  // -------------------------------------------------------------------------
  const emptyDir = mkdtempSync(join(tmpdir(), 'af-scope-empty-'));
  const s5 = inspectWriterScopes(emptyDir);
  results.s5_clean = { status: s5.status, reason: s5.reason, retain: classify(s5).retain };
  rmSync(emptyDir, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // Persistent classes S2/S3/S4 - uniform budget: first scan + 3 rescans
  // -------------------------------------------------------------------------
  const describePersistent = (obsList) => ({
    scans_performed: obsList.length,
    statuses: obsList.map((o) => o.status),
    classes: obsList.map((o) => o.klass),
    signals: obsList.map((o) => o.signals),
    converged: obsList.some((o) => o.status !== 'unknown'),
    retain: obsList[0].retain,
    first_reason: obsList[0].reason,
  });

  const orphanBase = mkdtempSync(join(tmpdir(), 'af-scope-orphan-'));
  mkdirSync(join(orphanBase, 'af-writer-orphan'), { recursive: true });
  const orphanObs = [];
  for (let k = 0; k <= PERSISTENT_RESCANS; k += 1) orphanObs.push(classify(inspectWriterScopes(orphanBase)));
  results.s2_orphan = { mode: 'simulated', ...describePersistent(orphanObs) };
  rmSync(orphanBase, { recursive: true, force: true });

  const permBase = mkdtempSync(join(tmpdir(), 'af-scope-perm-'));
  const permDir = join(permBase, 'af-writer-perm');
  mkdirSync(permDir, { recursive: true });
  writeFileSync(join(permDir, 'cgroup.procs'), '4242\n');
  chmodSync(permDir, 0o000);
  const permObs = [];
  for (let k = 0; k <= PERSISTENT_RESCANS; k += 1) permObs.push(classify(inspectWriterScopes(permBase)));
  results.s3_unreadable = {
    mode: 'simulated',
    ...describePersistent(permObs),
    existsSync_swallows_error: existsSync(join(permDir, 'cgroup.procs')) === false,
    note: 'existsSync() reports false for EACCES; with the fixed classifier priority this observation is a permission class, not "missing cgroup.procs"',
  };
  chmodSync(permDir, 0o700);
  rmSync(permBase, { recursive: true, force: true });

  const deepBase = mkdtempSync(join(tmpdir(), 'af-scope-deep-'));
  let cur = join(deepBase, 'af-writer-deep');
  mkdirSync(cur, { recursive: true });
  writeFileSync(join(cur, 'cgroup.procs'), '\n');
  for (let i = 0; i < MAX_WRITER_SCOPE_DEPTH + 2; i += 1) {
    cur = join(cur, `level-${i}`);
    mkdirSync(cur);
    writeFileSync(join(cur, 'cgroup.procs'), '\n');
  }
  const deepObs = [];
  for (let k = 0; k <= PERSISTENT_RESCANS; k += 1) deepObs.push(classify(inspectWriterScopes(deepBase)));
  results.s4_truncated = { mode: 'simulated', ...describePersistent(deepObs) };
  rmSync(deepBase, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // S7: SIMULATED live writer during a storm (kept, but labelled simulated)
  // -------------------------------------------------------------------------
  const liveBase = mkdtempSync(join(tmpdir(), 'af-scope-live-'));
  const liveDir = join(liveBase, 'af-writer-live');
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, 'cgroup.procs'), `${process.pid}\n`);
  for (let i = 0; i < SCOPES; i += 1) {
    const dir = join(liveBase, `af-writer-race-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.procs'), '\n');
  }
  const liveReaper = spawn(process.execPath, [fileURLToPath(import.meta.url), '--reaper', liveBase, '--scopes', String(SCOPES)], { stdio: 'ignore' });
  const liveDuring = [];
  let liveScans = 0;
  while (liveScans < MAX_SCANS) {
    if (liveReaper.exitCode !== null) break;
    liveDuring.push(classify(inspectWriterScopes(liveBase)));
    liveScans += 1;
    await yieldLoop();
  }
  await waitExit(liveReaper);
  results.s7_live_writer_simulated = {
    mode: 'simulated directories (the PID is written but the process is NOT joined to a real cgroup)',
    scans_during_storm: liveScans,
    classes: tally(liveDuring.map((o) => o.klass)),
    false_empty_while_live_scope_exists: liveDuring.filter((o) => o.status === 'empty').length,
    final_status: classify(inspectWriterScopes(liveBase)).status,
  };
  rmSync(liveBase, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // S8a/S8b/S9: REAL cgroup v2 base, real child processes, production reaping
  // -------------------------------------------------------------------------
  const realBaseAvailable = existsSync(CGROUP_BASE)
    && existsSync(join(CGROUP_BASE, 'cgroup.procs'))
    && existsSync(join(CGROUP_BASE, 'cgroup.controllers'));

  if (!realBaseAvailable) {
    results.s8a_real_cgroup_storm = { skipped: `no delegated cgroup v2 base at ${CGROUP_BASE}` };
    results.s8b_real_live_writer = { skipped: 'no delegated cgroup v2 base' };
    results.s9_post_quiesce = { skipped: 'no delegated cgroup v2 base' };
  } else {
    process.env.AF_CGROUP_BASE = CGROUP_BASE;
    const REAL_SCOPES = Number(argValue('--real-scopes', '60'));
    const preexisting = readdirSync(CGROUP_BASE).filter((n) => n.startsWith('af-writer-'));

    const spawnRealWriter = () => {
      const scope = createWriterScope({ runId: 'A2-QUANT', taskId: 'A2-QUANT' });
      if (!scope || scope.kind !== 'cgroup') return null;
      const child = spawnManaged('bash', ['-c', 'exec sleep 30'], { stdio: 'ignore' });
      attachWriterScope(scope, child.pid);
      createdRealScopes.push({ scope, child });
      return { scope, child };
    };

    // S8a: reap storm over real cgroups
    const realScopes = [];
    for (let i = 0; i < REAL_SCOPES; i += 1) {
      const w = spawnRealWriter();
      if (w) realScopes.push(w);
    }
    const cgReaper = spawn(process.execPath, [fileURLToPath(import.meta.url), '--cgroup-reaper', CGROUP_BASE, '--scopes', String(realScopes.length)], { stdio: 'ignore' });
    const s8a = summarise(await scanStorm({ base: CGROUP_BASE, isDone: () => cgReaper.exitCode !== null, maxScans: MAX_SCANS }));
    await waitExit(cgReaper);
    results.s8a_real_cgroup_storm = {
      mode: 'REAL cgroup v2 (delegated base), real sleep(30) children, production reapWriterScope in a separate process',
      scopes_created: realScopes.length,
      preexisting_foreign_scopes: preexisting.length,
      ...s8a,
    };

    // Cleanup any real scope the reaper did not finish.
    for (const w of createdRealScopes) {
      try { await reapWriterScope(w.scope, { graceMs: 500, pollMs: 10 }); } catch { /* best effort */ }
      try { await killTree(w.child, { graceMs: 500 }); } catch { /* best effort */ }
    }

    // S8b: a REAL live writer must never be reported as empty during a storm
    createdRealScopes = [];
    const liveReal = spawnRealWriter();
    const stormScopes = [];
    for (let i = 0; i < REAL_SCOPES; i += 1) {
      const w = spawnRealWriter();
      if (w) stormScopes.push(w);
    }
    const cgReaper2 = spawn(process.execPath, [
      fileURLToPath(import.meta.url), '--cgroup-reaper', CGROUP_BASE,
      '--keep', liveReal ? liveReal.scope.path : '',
      '--scopes', String(stormScopes.length),
    ], { stdio: 'ignore' });
    const liveRealDuring = [];
    let liveRealScans = 0;
    while (liveRealScans < MAX_SCANS) {
      if (cgReaper2.exitCode !== null) break;
      liveRealDuring.push(classify(inspectWriterScopes(CGROUP_BASE)));
      liveRealScans += 1;
      await yieldLoop();
    }
    await waitExit(cgReaper2);
    results.s8b_real_live_writer = {
      mode: 'REAL cgroup v2: one live scope is never reaped while neighbours are reaped',
      live_scope_created: Boolean(liveReal),
      live_child_pid: liveReal?.child?.pid ?? null,
      scans_during_storm: liveRealScans,
      classes: tally(liveRealDuring.map((o) => o.klass)),
      false_empty_while_live_scope_exists: liveRealDuring.filter((o) => o.status === 'empty').length,
      active_seen: liveRealDuring.some((o) => o.status === 'active'),
    };

    // S9: post-quiesce measurement (no concurrent reaping at all)
    for (const w of createdRealScopes) {
      if (liveReal && w.scope.path === liveReal.scope.path) continue;
      try { await reapWriterScope(w.scope, { graceMs: 500, pollMs: 10 }); } catch { /* best effort */ }
      try { await killTree(w.child, { graceMs: 500 }); } catch { /* best effort */ }
    }
    if (liveReal) {
      try { await reapWriterScope(liveReal.scope, { graceMs: 500, pollMs: 10 }); } catch { /* best effort */ }
      try { await killTree(liveReal.child, { graceMs: 500 }); } catch { /* best effort */ }
    }

    // S9: post-quiesce measurement (no concurrent reaping at all). Settle first so
    // the last rmdir() has definitely completed before the quiet state is measured.
    await new Promise((resolve) => { setTimeout(resolve, 250); });
    const postScans = [];
    for (let i = 0; i < 200; i += 1) {
      postScans.push(classify(inspectWriterScopes(CGROUP_BASE)));
      await yieldLoop();
    }
    results.s9_post_quiesce = {
      mode: 'REAL cgroup v2 after every reaper finished (quiesced)',
      scans: postScans.length,
      classes: tally(postScans.map((o) => o.klass)),
      unknown_count: postScans.filter((o) => o.status === 'unknown').length,
      residual_af_writer_entries: readdirSync(CGROUP_BASE).filter((n) => n.startsWith('af-writer-')).length,
    };
  }

  // -------------------------------------------------------------------------
  // Decision helper sanity
  // -------------------------------------------------------------------------
  const unknownBase = mkdtempSync(join(tmpdir(), 'af-scope-unknown-'));
  process.env.AF_CGROUP_BASE = unknownBase;
  rmSync(unknownBase, { recursive: true, force: true });
  let getActiveThrew = false;
  try { getActiveWriterScopes(); } catch (err) { getActiveThrew = err.code === 'WRITER_SCOPE_SCAN_UNKNOWN'; }
  results.decision_helpers = {
    getActiveWriterScopes_throws_on_unknown: getActiveThrew,
    force_used: false,
    acknowledge_live_scopes_used: false,
  };

  results.finished_at = new Date().toISOString();

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  console.log('=== A2 quantification v2: writer-scope scan vs. concurrent reap ===\n');
  console.log(`S1 simulated reap storm (${SCOPES} dirs, separate-process reaper)`);
  console.log(`  during-storm scans=${results.s1_burst.scans_during_storm} unknown=${results.s1_burst.unknown_during_storm} rate=${results.s1_burst.unknown_rate_during_storm}`);
  console.log(`  classes(during)=${JSON.stringify(results.s1_burst.classes_during_storm)}`);
  console.log(`  classes(after) =${JSON.stringify(results.s1_burst.classes_after_storm)}  co-occurring signals=${JSON.stringify(results.s1_burst.co_occurring_signals)}`);
  console.log('\nS6 bounded rescan (during storm)');
  console.log(`  unknown=${results.s6_rescan.unknown_total} k1=${results.s6_rescan.converged_at_1} k2=${results.s6_rescan.converged_at_2} k3=${results.s6_rescan.converged_at_3} never=${results.s6_rescan.never} final=${results.s6_rescan.final_status_after_storm}`);
  console.log('\nPersistent classes (uniform budget: 1 scan + 3 rescans)');
  for (const key of ['s2_orphan', 's3_unreadable', 's4_truncated']) {
    const r = results[key];
    console.log(`  ${key}: scans=${r.scans_performed} classes=${JSON.stringify(r.classes)} converged=${r.converged} retain=${r.retain}`);
  }
  console.log(`  s3 existsSync swallows EACCES: ${results.s3_unreadable.existsSync_swallows_error}`);
  console.log(`  s5 clean base: ${JSON.stringify(results.s5_clean)}`);
  console.log('\nS7 SIMULATED live writer during storm');
  console.log(`  scans=${results.s7_live_writer_simulated.scans_during_storm} classes=${JSON.stringify(results.s7_live_writer_simulated.classes)} false_empty=${results.s7_live_writer_simulated.false_empty_while_live_scope_exists}`);
  console.log('\nS8a REAL cgroup reap storm');
  console.log(`  ${JSON.stringify({ scopes: results.s8a_real_cgroup_storm.scopes_created, scans: results.s8a_real_cgroup_storm.scans_during_storm, unknown: results.s8a_real_cgroup_storm.unknown_during_storm, rate: results.s8a_real_cgroup_storm.unknown_rate_during_storm, classes: results.s8a_real_cgroup_storm.classes_during_storm, skipped: results.s8a_real_cgroup_storm.skipped })}`);
  console.log('\nS8b REAL live writer during storm');
  console.log(`  ${JSON.stringify(results.s8b_real_live_writer)}`);
  console.log('\nS9 REAL post-quiesce');
  console.log(`  ${JSON.stringify(results.s9_post_quiesce)}`);
  console.log(`\nDecision helpers: ${JSON.stringify(results.decision_helpers)}`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nJSON written to ${JSON_OUT}`);
  }
} finally {
  // Never leave a real writer scope or a child behind.
  for (const w of createdRealScopes) {
    try { await reapWriterScope(w.scope, { graceMs: 500, pollMs: 10 }); } catch { /* best effort */ }
    try { await killTree(w.child, { graceMs: 500 }); } catch { /* best effort */ }
  }
  rmSync(base, { recursive: true, force: true });
}
