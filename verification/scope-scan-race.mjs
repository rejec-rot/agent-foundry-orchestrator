// scope-scan-race.mjs - A2 quantification: writer-scope scan vs. concurrent reap
//
// Measures `inspectWriterScopes()` while scope directories are removed by ANOTHER
// PROCESS (an in-process reap cannot interleave with a synchronous scan).
//
// Scenario families:
//   SIMULATED (plain directories + simulated cgroup.procs): S1..S7
//   REAL cgroup (delegated cgroup v2 base, real child processes, production
//   reapWriterScope): S8a reap storm, S8b live-writer property, S9 post-quiesce
//
// Safety of the tool itself:
//   - a reaper NEVER enumerates the base; it only touches the exact list of paths
//     this run created (passed as a manifest file);
//   - nothing is ever unlocked: `force` and `acknowledgeLiveScopes` are not used.
//
// Methodology (fixed across two review rounds):
//   - the measured window is [first removal, last removal]: the reaper writes a
//     `started` marker immediately before its first removal and a `done` marker
//     after its last one, with timestamps; each scan is attributed to
//     pre_storm / during_storm / after_storm from those markers, not from the
//     reaper process lifetime;
//   - when the scan budget runs out the tool WAITS for the reaper to exit before
//     taking the after-storm samples, and records `budget_exhausted`;
//   - `classify()` checks errno signals (EACCES/EPERM/EIO) BEFORE the broad
//     "missing cgroup.procs" bucket and reports co-occurring signals;
//   - persistent classes get a uniform budget of 1 scan + 3 rescans;
//   - S8b asserts, per observation, that the designated live writer PID is
//     actually reported (not merely that `empty` was never seen), and asserts the
//     `attachWriterScope()` result;
//   - S9 distinguishes "no live writer" from "no leftover directory" by reporting
//     the residual entry count at measurement time and after settling.
//
// Usage:
//   node verification/scope-scan-race.mjs [--scopes 400] [--max-scans 60000] [--real-scopes 40] [--json <path>]
//   node verification/scope-scan-race.mjs --reaper <dir> --scopes N --marker-dir <dir>      (internal)
//   node verification/scope-scan-race.mjs --cgroup-reaper <base> --only <manifest> --marker-dir <dir> (internal)

import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const waitExit = (child, timeoutMs = 30000) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve('already-exited'); return; }
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* best effort */ } resolve('killed-after-timeout'); }, timeoutMs);
  child.once('exit', () => { clearTimeout(timer); resolve('exited'); });
});

const MARKER_DIR = argValue('--marker-dir');
function writeMarker(name, payload) {
  if (!MARKER_DIR) return;
  try { writeFileSync(join(MARKER_DIR, name), `${JSON.stringify(payload)}\n`); } catch { /* best effort */ }
}

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
// Internal child mode: remove plain (simulated) scope directories - exact list.
// ---------------------------------------------------------------------------
if (argv.includes('--reaper')) {
  const base = argValue('--reaper');
  const scopes = Number(argValue('--scopes', '400'));
  let removed = 0;
  let failures = 0;
  let firstRemovalAt = null;
  let lastRemovalAt = null;
  for (let i = 0; i < scopes; i += 1) {
    spin(50 + Math.floor(Math.random() * 450));
    if (i === 0) { firstRemovalAt = Date.now(); writeMarker('started.json', { at: firstRemovalAt, planned: scopes }); }
    try { rmSync(join(base, `af-writer-race-${i}`), { recursive: true, force: true }); removed += 1; } catch { failures += 1; }
    lastRemovalAt = Date.now();
  }
  writeMarker('done.json', { at: Date.now(), removed, failures, first_removal_at: firstRemovalAt, last_removal_at: lastRemovalAt });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Internal child mode: reap REAL writer cgroups - only the exact paths listed in
// the manifest. The base directory is never enumerated for candidates.
// ---------------------------------------------------------------------------
if (argv.includes('--cgroup-reaper')) {
  const only = argValue('--only');
  const keep = argValue('--keep');
  const manifest = JSON.parse(readFileSync(only, 'utf8'));
  let removed = 0;
  let failures = 0;
  let firstRemovalAt = null;
  let lastRemovalAt = null;
  for (let i = 0; i < manifest.length; i += 1) {
    const path = manifest[i];
    if (path === keep) continue; // never touch the designated live scope
    spin(50 + Math.floor(Math.random() * 450));
    if (firstRemovalAt === null) { firstRemovalAt = Date.now(); writeMarker('started.json', { at: firstRemovalAt, planned: manifest.length }); }
    const handle = {
      kind: 'cgroup',
      path,
      procs_path: join(path, 'cgroup.procs'),
      kill_path: join(path, 'cgroup.kill'),
      attached: true,
      verified: true,
      reason: null,
    };
    try {
      const evidence = await reapWriterScope(handle, { graceMs: 500, pollMs: 10 });
      if (evidence?.scope_empty === true || evidence?.removed === true) removed += 1;
      else failures += 1;
    } catch { failures += 1; }
    lastRemovalAt = Date.now();
  }
  writeMarker('done.json', { at: Date.now(), removed, failures, planned: manifest.length, first_removal_at: firstRemovalAt, last_removal_at: lastRemovalAt });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent mode
// ---------------------------------------------------------------------------
const SCOPES = Number(argValue('--scopes', '400'));
const MAX_SCANS = Number(argValue('--max-scans', '60000'));
const REAL_SCOPES = Number(argValue('--real-scopes', '40'));
const JSON_OUT = argValue('--json');
const PERSISTENT_RESCANS = 3;
const AFTER_SAMPLES = 50;

const markerRoot = mkdtempSync(join(tmpdir(), 'af-race-markers-'));
const results = {
  schema: 'af-scope-race-quantification-v3',
  started_at: new Date().toISOString(),
  parameters: {
    scopes: SCOPES, max_scans: MAX_SCANS, real_scopes: REAL_SCOPES,
    persistent_rescans: PERSISTENT_RESCANS, cgroup_base: CGROUP_BASE,
  },
  methodology: {
    window: 'measured window = [first removal, last removal], from reaper-written started/done markers with timestamps; scans are attributed per iteration',
    budget: 'if the scan budget is exhausted the tool waits for the reaper to exit before taking after-storm samples (recorded as budget_exhausted)',
    classifier_priority: ['truncated', 'permission(EACCES/EPERM)', 'io(EIO)', 'procs-vanished', 'missing-procs', 'dir-vanished'],
    reaper_safety: 'the real reaper only touches the exact path manifest created by this run; it never enumerates the base',
    simulated_vs_real: 'S1..S7 use plain directories with simulated cgroup.procs; S8*/S9 use the delegated cgroup v2 base with real child processes and production reapWriterScope',
  },
  s1_burst: null, s2_orphan: null, s3_unreadable: null, s4_truncated: null, s5_clean: null,
  s6_rescan: null, s7_live_writer_simulated: null,
  s8a_real_cgroup_storm: null, s8b_real_live_writer: null, s9_post_quiesce: null,
};

const tally = (classes) => classes.reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {});

function summarisePhases(storm) {
  const duringUnknown = storm.during.filter((o) => o.status === 'unknown').length;
  const signalPairs = {};
  for (const o of storm.during) {
    if (o.signals.length > 1) signalPairs[o.signals.join('+')] = (signalPairs[o.signals.join('+')] || 0) + 1;
  }
  // Approximate window = marker visibility at scan time. Exact window = scans whose own
  // [t0, t1] lie fully inside [first_removal_at, last_removal_at]; the two are reported
  // separately because the approximate one can include a scan that started earlier.
  const first = storm.report?.first_removal_at ?? null;
  const last = storm.report?.last_removal_at ?? null;
  const exact = (first && last)
    ? storm.during.filter((o) => o.t0 >= first && o.t1 <= last)
    : [];
  const exactUnknown = exact.filter((o) => o.status === 'unknown').length;
  const beforeWindow = (first ? storm.during.filter((o) => o.t1 < first) : []).length;
  const afterWindow = (last ? storm.during.filter((o) => o.t0 > last) : []).length;
  return {
    pre_storm_scans: storm.pre.length,
    pre_storm_classes: tally(storm.pre.map((o) => o.klass)),
    scans_during_storm: storm.during.length,
    classes_during_storm: tally(storm.during.map((o) => o.klass)),
    unknown_during_storm: duringUnknown,
    unknown_rate_during_storm: storm.during.length ? Number((duringUnknown / storm.during.length).toExponential(3)) : null,
    scans_in_exact_window: exact.length,
    unknown_in_exact_window: exactUnknown,
    unknown_rate_exact_window: exact.length ? Number((exactUnknown / exact.length).toExponential(3)) : null,
    scans_before_exact_window: beforeWindow,
    scans_after_exact_window: afterWindow,
    co_occurring_signals: signalPairs,
    after_storm_scans: storm.after.length,
    classes_after_storm: tally(storm.after.map((o) => o.klass)),
    budget_exhausted: storm.budget_exhausted,
    reaper_exited_without_markers: storm.reaper_exited_without_markers,
    reaper_exit_state: storm.exit_state,
    reaper_report: storm.report,
    measured_window_ms: storm.report && storm.report.first_removal_at && storm.report.last_removal_at
      ? storm.report.last_removal_at - storm.report.first_removal_at
      : null,
  };
}

const base = mkdtempSync(join(tmpdir(), 'af-scope-race-'));
let createdRealScopes = [];

try {
  // -------------------------------------------------------------------------
  // S1: simulated reap storm, exact-list reaper in a separate process
  // -------------------------------------------------------------------------
  for (let i = 0; i < SCOPES; i += 1) {
    const dir = join(base, `af-writer-race-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.procs'), '\n');
  }
  const reaper = spawn(process.execPath, [
    fileURLToPath(import.meta.url), '--reaper', base, '--scopes', String(SCOPES), '--marker-dir', markerRoot,
  ], { stdio: 'ignore' });
  results.s1_burst = {
    mode: 'simulated directories',
    ...summarisePhases(await scanPhasedWithMarkers({ base, reaper, maxScans: MAX_SCANS, markerDir: markerRoot })),
  };

  // -------------------------------------------------------------------------
  // S6: bounded rescan convergence during the measured window (simulated)
  // -------------------------------------------------------------------------
  const base2 = mkdtempSync(join(tmpdir(), 'af-scope-race2-'));
  for (let i = 0; i < SCOPES; i += 1) {
    const dir = join(base2, `af-writer-race-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.procs'), '\n');
  }
  const markerRoot2 = mkdtempSync(join(tmpdir(), 'af-race-markers2-'));
  const reaper2 = spawn(process.execPath, [
    fileURLToPath(import.meta.url), '--reaper', base2, '--scopes', String(SCOPES), '--marker-dir', markerRoot2,
  ], { stdio: 'ignore' });
  const convergence = { unknown_total: 0, converged_at_1: 0, converged_at_2: 0, converged_at_3: 0, never: 0 };
  const s6Scans = [];
  let scans2 = 0;
  while (true) {
    if (existsSync(join(markerRoot2, 'done.json'))) break;
    if (reaper2.exitCode !== null) break;
    if (scans2 >= MAX_SCANS) break;
    const t0 = Date.now();
    const first = classify(inspectWriterScopes(base2));
    const t1 = Date.now();
    scans2 += 1;
    let settled = 0;
    if (first.status === 'unknown') {
      convergence.unknown_total += 1;
      for (let k = 1; k <= 3 && settled === 0; k += 1) {
        const again = classify(inspectWriterScopes(base2));
        if (again.status !== 'unknown') settled = k;
      }
      if (settled === 0) convergence.never += 1;
      else convergence[`converged_at_${settled}`] += 1;
    }
    s6Scans.push({ t0, t1, status: first.status, settled });
    await yieldLoop();
  }
  await waitExit(reaper2);
  let s6Report = null;
  try { s6Report = JSON.parse(readFileSync(join(markerRoot2, 'done.json'), 'utf8')); } catch { s6Report = null; }
  const s6First = s6Report?.first_removal_at ?? null;
  const s6Last = s6Report?.last_removal_at ?? null;
  const s6Exact = (s6First && s6Last) ? s6Scans.filter((sc) => sc.t0 >= s6First && sc.t1 <= s6Last) : [];
  results.s6_rescan = {
    mode: 'simulated directories',
    scans_during_storm: scans2,
    scans_in_exact_window: s6Exact.length,
    unknown_in_exact_window: s6Exact.filter((sc) => sc.status === 'unknown').length,
    unknown_before_exact_window: (s6First ? s6Scans.filter((sc) => sc.t1 < s6First && sc.status === 'unknown').length : null),
    ...convergence,
    converged_rate: convergence.unknown_total
      ? Number(((convergence.unknown_total - convergence.never) / convergence.unknown_total).toFixed(4))
      : null,
    final_status_after_storm: classify(inspectWriterScopes(base2)).status,
  };
  rmSync(base2, { recursive: true, force: true });
  rmSync(markerRoot2, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // S5 / S2 / S3 / S4
  // -------------------------------------------------------------------------
  const emptyDir = mkdtempSync(join(tmpdir(), 'af-scope-empty-'));
  const s5 = inspectWriterScopes(emptyDir);
  results.s5_clean = { status: s5.status, reason: s5.reason, retain: classify(s5).retain };
  rmSync(emptyDir, { recursive: true, force: true });

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
    note: 'existsSync() reports false for EACCES; the fixed classifier priority reports this as a permission class, while the raw reason also contains "missing cgroup.procs"',
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
  // S7: SIMULATED live writer during a storm
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
  const markerRoot3 = mkdtempSync(join(tmpdir(), 'af-race-markers3-'));
  const liveReaper = spawn(process.execPath, [
    fileURLToPath(import.meta.url), '--reaper', liveBase, '--scopes', String(SCOPES), '--marker-dir', markerRoot3,
  ], { stdio: 'ignore' });
  const simLiveChecks = { active_observations: 0, active_with_live_pid: 0, active_missing_live_pid: 0, empty_observations: 0 };
  const s7 = await scanPhasedWithMarkers({
    base: liveBase,
    reaper: liveReaper,
    maxScans: MAX_SCANS,
    markerDir: markerRoot3,
    checkObservation: (raw, classified) => {
      if (classified.status === 'empty') simLiveChecks.empty_observations += 1;
      if (classified.status === 'active') {
        simLiveChecks.active_observations += 1;
        const live = raw.scopes.find((s) => s.path === liveDir);
        if (live && live.pids.includes(String(process.pid))) simLiveChecks.active_with_live_pid += 1;
        else simLiveChecks.active_missing_live_pid += 1;
      }
    },
  });
  results.s7_live_writer_simulated = {
    mode: 'simulated directories (the PID is written but the process is NOT joined to a real cgroup)',
    ...summarisePhases(s7),
    live_pid_checks: simLiveChecks,
    live_scope_still_present_after_storm: existsSync(liveDir),
  };
  rmSync(liveBase, { recursive: true, force: true });
  rmSync(markerRoot3, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // S8a/S8b/S9: REAL cgroup v2 base, real child processes, production reaping
  // -------------------------------------------------------------------------
  const realBaseAvailable = existsSync(CGROUP_BASE)
    && existsSync(join(CGROUP_BASE, 'cgroup.procs'))
    && existsSync(join(CGROUP_BASE, 'cgroup.controllers'));

  if (!realBaseAvailable) {
    const skipped = { skipped: `no delegated cgroup v2 base at ${CGROUP_BASE}` };
    results.s8a_real_cgroup_storm = skipped;
    results.s8b_real_live_writer = skipped;
    results.s9_post_quiesce = skipped;
  } else {
    process.env.AF_CGROUP_BASE = CGROUP_BASE;
    const preexisting = readdirSync(CGROUP_BASE).filter((n) => n.startsWith('af-writer-'));
    const attachFailures = [];

    const spawnRealWriter = () => {
      const scope = createWriterScope({ runId: 'A2-QUANT', taskId: 'A2-QUANT' });
      if (!scope || scope.kind !== 'cgroup') return null;
      const child = spawnManaged('bash', ['-c', 'exec sleep 30'], { stdio: 'ignore' });
      const attached = attachWriterScope(scope, child.pid);
      if (attached?.verified !== true) {
        attachFailures.push({ path: scope.path, pid: child.pid, reason: attached?.reason ?? 'attach not verified' });
      }
      // Keep the ATTACHED handle: reapWriterScope() refuses handles that are not
      // attached/verified (it would otherwise only try a bare rmdir), which would
      // both leak the scope and report misleading cleanup evidence.
      createdRealScopes.push({ scope: attached, child });
      return { scope: attached, child, attached_verified: attached?.verified === true };
    };

    // S8a: reap storm over real cgroups (exact path manifest, separate process)
    const realScopes = [];
    for (let i = 0; i < REAL_SCOPES; i += 1) {
      const w = spawnRealWriter();
      if (w) realScopes.push(w);
    }
    const manifestA = join(markerRoot, 'manifest-a.json');
    writeFileSync(manifestA, JSON.stringify(realScopes.map((w) => w.scope.path)));
    const markerRootA = mkdtempSync(join(tmpdir(), 'af-race-markersA-'));
    const cgReaper = spawn(process.execPath, [
      fileURLToPath(import.meta.url), '--cgroup-reaper', CGROUP_BASE,
      '--only', manifestA, '--marker-dir', markerRootA,
    ], { stdio: 'ignore' });
    const s8aStorm = await scanPhasedWithMarkers({ base: CGROUP_BASE, reaper: cgReaper, maxScans: MAX_SCANS, markerDir: markerRootA });
    results.s8a_real_cgroup_storm = {
      mode: 'REAL cgroup v2 (delegated base), real sleep(30) children, production reapWriterScope in a separate process',
      scopes_created: realScopes.length,
      attach_failures: attachFailures.length,
      preexisting_foreign_scopes: preexisting.length,
      ...summarisePhases(s8aStorm),
    };
    rmSync(markerRootA, { recursive: true, force: true });

    for (const w of createdRealScopes) {
      try { await reapWriterScope(w.scope, { graceMs: 500, pollMs: 10 }); } catch { /* best effort */ }
      try { await killTree(w.child, { graceMs: 500 }); } catch { /* best effort */ }
    }

    // S8b: a REAL live writer must keep being reported, WITH its PID, during a storm
    createdRealScopes = [];
    const liveReal = spawnRealWriter();
    const stormScopes = [];
    for (let i = 0; i < REAL_SCOPES; i += 1) {
      const w = spawnRealWriter();
      if (w) stormScopes.push(w);
    }
    const livePath = liveReal?.scope?.path ?? null;
    const livePid = liveReal?.child?.pid ?? null;
    const manifestB = join(markerRoot, 'manifest-b.json');
    writeFileSync(manifestB, JSON.stringify(stormScopes.map((w) => w.scope.path)));
    const markerRootB = mkdtempSync(join(tmpdir(), 'af-race-markersB-'));
    const cgReaper2 = spawn(process.execPath, [
      fileURLToPath(import.meta.url), '--cgroup-reaper', CGROUP_BASE,
      '--only', manifestB, '--keep', livePath ?? '', '--marker-dir', markerRootB,
    ], { stdio: 'ignore' });

    const realLiveChecks = { active_observations: 0, active_with_live_pid: 0, active_missing_live_pid: 0, empty_observations: 0 };
    const s8bStorm = await scanPhasedWithMarkers({
      base: CGROUP_BASE,
      reaper: cgReaper2,
      maxScans: MAX_SCANS,
      markerDir: markerRootB,
      checkObservation: (raw, classified) => {
        if (classified.status === 'empty') realLiveChecks.empty_observations += 1;
        if (classified.status === 'active') {
          realLiveChecks.active_observations += 1;
          const live = raw.scopes.find((s) => s.path === livePath);
          if (live && live.pids.includes(String(livePid))) realLiveChecks.active_with_live_pid += 1;
          else realLiveChecks.active_missing_live_pid += 1;
        }
      },
    });
    results.s8b_real_live_writer = {
      mode: 'REAL cgroup v2: one live scope is never reaped while neighbours are reaped',
      live_scope_created: Boolean(liveReal),
      live_attach_verified: liveReal?.attached_verified === true,
      live_child_pid: livePid,
      ...summarisePhases(s8bStorm),
      live_pid_checks: realLiveChecks,
      live_scope_still_present_after_storm: livePath ? existsSync(livePath) : null,
    };
    rmSync(markerRootB, { recursive: true, force: true });

    // S9: post-quiesce measurement. Distinguish "no live writer" from "no leftover dir".
    // Cleanup evidence is recorded instead of swallowed: a scope that survives the
    // first reap attempt is retried once before the quiet state is measured.
    const cleanupEvidence = [];
    const reapAll = async () => {
      for (const w of createdRealScopes) {
        if (livePath && w.scope.path === livePath) continue;
        let evidence = null;
        try { evidence = await reapWriterScope(w.scope, { graceMs: 500, pollMs: 10 }); } catch (err) { evidence = { error: String(err?.message ?? err) }; }
        try { await killTree(w.child, { graceMs: 500 }); } catch { /* best effort */ }
        cleanupEvidence.push({ path: w.scope.path, removed: evidence?.removed === true, scope_empty: evidence?.scope_empty === true, verified: evidence?.scope_verified === true });
      }
      if (liveReal) {
        let evidence = null;
        try { evidence = await reapWriterScope(liveReal.scope, { graceMs: 500, pollMs: 10 }); } catch (err) { evidence = { error: String(err?.message ?? err) }; }
        try { await killTree(liveReal.child, { graceMs: 500 }); } catch { /* best effort */ }
        cleanupEvidence.push({ path: liveReal.scope.path, removed: evidence?.removed === true, scope_empty: evidence?.scope_empty === true, verified: evidence?.scope_verified === true });
      }
    };

    await reapAll();
    let residualBeforeMeasurement = readdirSync(CGROUP_BASE).filter((n) => n.startsWith('af-writer-')).length;
    if (residualBeforeMeasurement > 0) {
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      await reapAll(); // one bounded retry, evidence appended
      residualBeforeMeasurement = readdirSync(CGROUP_BASE).filter((n) => n.startsWith('af-writer-')).length;
    }
    const residualAtMeasurement = residualBeforeMeasurement;
    const postScans = [];
    for (let i = 0; i < 200; i += 1) {
      postScans.push(classify(inspectWriterScopes(CGROUP_BASE)));
      await yieldLoop();
    }
    const settleStart = Date.now();
    let residualAfterWait = residualAtMeasurement;
    while (residualAfterWait > 0 && Date.now() - settleStart < 3000) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      residualAfterWait = readdirSync(CGROUP_BASE).filter((n) => n.startsWith('af-writer-')).length;
    }
    results.s9_post_quiesce = {
      mode: 'REAL cgroup v2 after every reaper finished (quiesced)',
      scans: postScans.length,
      classes: tally(postScans.map((o) => o.klass)),
      unknown_count: postScans.filter((o) => o.status === 'unknown').length,
      residual_entries_at_measurement: residualAtMeasurement,
      residual_entries_after_wait: residualAfterWait,
      residual_wait_ms: Date.now() - settleStart,
      cleanup_evidence: cleanupEvidence,
      cleanup_failed_paths: cleanupEvidence.filter((e) => !e.removed && !e.scope_empty).map((e) => e.path),
      note: '"empty" means no live PID was found in any writer scope; it does NOT mean the base contains zero directories, see residual_entries_*',
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

  // Final PASS/FAIL verdict. Counting alone is not an acceptance criterion: any
  // missed live writer, attach failure, unexpected convergence of a persistent
  // class, or leftover scope/residual directory must fail the run loudly.
  const v7 = results.s7_live_writer_simulated;
  const v8b = results.s8b_real_live_writer;
  const v9 = results.s9_post_quiesce;
  const checks = [
    { id: 'attach_failures_zero', ok: results.s8a_real_cgroup_storm?.attach_failures === 0 || Boolean(results.s8a_real_cgroup_storm?.skipped), detail: results.s8a_real_cgroup_storm?.attach_failures },
    { id: 'sim_live_pid_never_missed', ok: (v7?.live_pid_checks?.active_missing_live_pid ?? 0) === 0, detail: v7?.live_pid_checks },
    { id: 'sim_no_false_empty', ok: (v7?.live_pid_checks?.empty_observations ?? 0) === 0, detail: v7?.live_pid_checks?.empty_observations },
    { id: 'real_live_pid_never_missed', ok: v8b?.skipped ? true : (v8b?.live_pid_checks?.active_missing_live_pid ?? 0) === 0, detail: v8b?.live_pid_checks },
    { id: 'real_no_false_empty', ok: v8b?.skipped ? true : (v8b?.live_pid_checks?.empty_observations ?? 0) === 0, detail: v8b?.live_pid_checks?.empty_observations },
    { id: 'real_live_scope_present_after_storm', ok: v8b?.skipped ? true : v8b?.live_scope_still_present_after_storm === true, detail: v8b?.live_scope_still_present_after_storm },
    { id: 'persistent_classes_never_converge', ok: ['s2_orphan', 's3_unreadable', 's4_truncated'].every((k) => results[k].converged === false && results[k].retain === true), detail: ['s2_orphan', 's3_unreadable', 's4_truncated'].map((k) => ({ k, converged: results[k].converged })) },
    { id: 'post_quiesce_no_unknown', ok: v9?.skipped ? true : (v9?.unknown_count ?? 1) === 0, detail: v9?.unknown_count },
    { id: 'post_quiesce_no_residual_dir', ok: v9?.skipped ? true : (v9?.residual_entries_at_measurement === 0 && v9?.residual_entries_after_wait === 0), detail: { at: v9?.residual_entries_at_measurement, after: v9?.residual_entries_after_wait } },
    { id: 'cleanup_no_failed_paths', ok: v9?.skipped ? true : (v9?.cleanup_failed_paths ?? []).length === 0, detail: v9?.cleanup_failed_paths },
    { id: 'no_escape_hatches_used', ok: results.decision_helpers.force_used === false && results.decision_helpers.acknowledge_live_scopes_used === false, detail: results.decision_helpers },
  ];
  const failed = checks.filter((c) => !c.ok);
  results.verdict = { passed: failed.length === 0, checks, failed_checks: failed.map((c) => c.id) };
  process.exitCode = failed.length === 0 ? 0 : 1;

  results.finished_at = new Date().toISOString();

  console.log('=== A2 quantification v3: writer-scope scan vs. concurrent reap ===\n');
  console.log('S1 simulated reap storm (separate-process reaper, exact list, measured window)');
  console.log(`  pre=${results.s1_burst.pre_storm_scans} during=${results.s1_burst.scans_during_storm} unknown=${results.s1_burst.unknown_during_storm} rate=${results.s1_burst.unknown_rate_during_storm} window_ms=${results.s1_burst.measured_window_ms} budget_exhausted=${results.s1_burst.budget_exhausted}`);
  console.log(`  classes(during)=${JSON.stringify(results.s1_burst.classes_during_storm)} classes(after)=${JSON.stringify(results.s1_burst.classes_after_storm)}`);
  console.log(`  co-signals=${JSON.stringify(results.s1_burst.co_occurring_signals)} reaper=${JSON.stringify(results.s1_burst.reaper_report)}`);
  console.log('\nS6 bounded rescan (during measured window)');
  console.log(`  ${JSON.stringify({ unknown: results.s6_rescan.unknown_total, k1: results.s6_rescan.converged_at_1, k2: results.s6_rescan.converged_at_2, k3: results.s6_rescan.converged_at_3, never: results.s6_rescan.never, final: results.s6_rescan.final_status_after_storm })}`);
  console.log('\nPersistent classes (1 scan + 3 rescans)');
  for (const key of ['s2_orphan', 's3_unreadable', 's4_truncated']) {
    const r = results[key];
    console.log(`  ${key}: scans=${r.scans_performed} classes=${JSON.stringify(r.classes)} signals=${JSON.stringify(r.signals[0])} converged=${r.converged} retain=${r.retain}`);
  }
  console.log(`  s5 clean: ${JSON.stringify(results.s5_clean)}`);
  console.log('\nS7 SIMULATED live writer');
  console.log(`  ${JSON.stringify({ during: results.s7_live_writer_simulated.scans_during_storm, checks: results.s7_live_writer_simulated.live_pid_checks, still_present: results.s7_live_writer_simulated.live_scope_still_present_after_storm })}`);
  console.log('\nS8a REAL cgroup reap storm');
  console.log(`  ${JSON.stringify({ scopes: results.s8a_real_cgroup_storm.scopes_created, attach_failures: results.s8a_real_cgroup_storm.attach_failures, during: results.s8a_real_cgroup_storm.scans_during_storm, unknown: results.s8a_real_cgroup_storm.unknown_during_storm, rate: results.s8a_real_cgroup_storm.unknown_rate_during_storm, window_ms: results.s8a_real_cgroup_storm.measured_window_ms, classes: results.s8a_real_cgroup_storm.classes_during_storm, skipped: results.s8a_real_cgroup_storm.skipped })}`);
  console.log('\nS8b REAL live writer');
  console.log(`  ${JSON.stringify({ live_pid: results.s8b_real_live_writer.live_child_pid, attach_verified: results.s8b_real_live_writer.live_attach_verified, during: results.s8b_real_live_writer.scans_during_storm, checks: results.s8b_real_live_writer.live_pid_checks, still_present: results.s8b_real_live_writer.live_scope_still_present_after_storm })}`);
  console.log('\nS9 REAL post-quiesce');
  console.log(`  ${JSON.stringify(results.s9_post_quiesce)}`);
  console.log(`\nDecision helpers: ${JSON.stringify(results.decision_helpers)}`);
  console.log(`\nHARNESS VERDICT: ${results.verdict.passed ? 'PASS' : `FAIL (${results.verdict.failed_checks.join(', ')})`}`);
  for (const c of results.verdict.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}${c.ok ? '' : ` -> ${JSON.stringify(c.detail)}`}`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nJSON written to ${JSON_OUT}`);
  }
} finally {
  for (const w of createdRealScopes) {
    try { await reapWriterScope(w.scope, { graceMs: 500, pollMs: 10 }); } catch { /* best effort */ }
    try { await killTree(w.child, { graceMs: 500 }); } catch { /* best effort */ }
  }
  rmSync(base, { recursive: true, force: true });
  rmSync(markerRoot, { recursive: true, force: true });
}

/**
 * Scan `base` in a yielding loop, attributing every scan to pre/during/after from
 * the reaper's started/done markers in `markerDir` (each reaper gets its own dir so
 * several reapers cannot collide). After the reaper has definitely exited, the
 * after-storm samples are taken.
 */
async function scanPhasedWithMarkers({ base, reaper, maxScans, markerDir, checkObservation = null }) {
  const startedMarker = join(markerDir, 'started.json');
  const doneMarker = join(markerDir, 'done.json');
  const pre = [];
  const during = [];
  const after = [];
  let budgetExhausted = false;
  let reaperExitedWithoutMarkers = false;

  while (true) {
    if (existsSync(doneMarker)) break;
    if (reaper.exitCode !== null && !existsSync(doneMarker)) { reaperExitedWithoutMarkers = true; break; }
    if (pre.length + during.length >= maxScans) { budgetExhausted = true; break; }
    const t0 = Date.now();
    const raw = inspectWriterScopes(base);
    const t1 = Date.now();
    const classified = classify(raw);
    classified.t0 = t0;
    classified.t1 = t1;
    if (checkObservation) checkObservation(raw, classified);
    (existsSync(startedMarker) ? during : pre).push(classified);
    await yieldLoop();
  }

  const exitState = await waitExit(reaper);
  let report = null;
  try { report = JSON.parse(readFileSync(doneMarker, 'utf8')); } catch { report = null; }

  for (let i = 0; i < AFTER_SAMPLES; i += 1) {
    const t0 = Date.now();
    const raw = inspectWriterScopes(base);
    const t1 = Date.now();
    const classified = classify(raw);
    classified.t0 = t0;
    classified.t1 = t1;
    if (checkObservation) checkObservation(raw, classified);
    after.push(classified);
  }

  return { pre, during, after, budget_exhausted: budgetExhausted, reaper_exited_without_markers: reaperExitedWithoutMarkers, exit_state: exitState, report };
}
