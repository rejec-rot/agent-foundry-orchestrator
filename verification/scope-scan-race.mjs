// scope-scan-race.mjs - A2 quantification: writer-scope scan vs. concurrent reap
//
// Measures how `inspectWriterScopes()` behaves when scope directories are removed by
// ANOTHER PROCESS while the orchestrator scans. The in-process case cannot race (a
// synchronous scan cannot be interleaved by JS), so the reaper here is a child process,
// exactly like a second orchestrator instance / `af-admin reclaim orphans` would be.
//
// It does NOT change any decision: nothing is unlocked, no `force` and no
// `acknowledgeLiveScopes` is used, and every anomaly stays fail-closed. The point is to
// quantify the classes, their reasons, and whether a BOUNDED rescan converges.
//
// Scenarios:
//   S1 burst reap race   : child process removes scope dirs while we scan in a tight loop
//   S2 persistent orphan : scope dir present with NO cgroup.procs (never converges)
//   S3 unreadable scope  : scope dir present, procs unreadable (permission error)
//   S4 truncated scan    : nesting deeper than MAX_WRITER_SCOPE_DEPTH
//   S5 clean reap        : everything reaped -> confirmed empty
//   S6 bounded rescan    : for every `unknown` seen in S1, how many immediate rescans
//                          (K = 1..3) reach a confirmed answer
//
// Usage:
//   node verification/scope-scan-race.mjs [--scopes 400] [--max-scans 60000] [--json <path>]
//   node verification/scope-scan-race.mjs --reaper <baseDir> --scopes 400   (internal)

import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectWriterScopes, getActiveWriterScopes, MAX_WRITER_SCOPE_DEPTH } from '../lib/host-boundary.mjs';

const argv = process.argv.slice(2);
function argValue(flag, fallback = null) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

/** Classify one scan observation into a decision-relevant class. */
export function classify(observation) {
  if (observation.status === 'empty') return { status: 'empty', klass: 'empty', retain: false };
  if (observation.status === 'active') return { status: 'active', klass: 'active', retain: true };

  const reason = observation.reason || '';
  let klass = 'unknown:other';
  if (/truncated at depth/.test(reason)) klass = 'unknown:truncated';
  else if (/missing cgroup\.procs/.test(reason)) klass = 'unknown:missing-procs';
  else if (/cgroup\.procs: ENOENT/.test(reason)) klass = 'unknown:procs-vanished';
  else if (/EACCES|EPERM/.test(reason)) klass = 'unknown:permission';
  else if (/EIO/.test(reason)) klass = 'unknown:io';
  else if (/ENOENT/.test(reason)) klass = 'unknown:dir-vanished';
  return { status: observation.status, klass, retain: observation.status !== 'empty', reason };
}

// ---------------------------------------------------------------------------
// Internal child mode: remove scope directories as fast as possible.
// ---------------------------------------------------------------------------
if (argv.includes('--reaper')) {
  const base = argValue('--reaper');
  const scopes = Number(argValue('--scopes', '400'));
  // Busy-wait a randomized microsecond amount so removals interleave with the
  // parent's scans instead of happening in one burst.
  const spin = (us) => { const end = process.hrtime.bigint() + BigInt(us * 1000); while (process.hrtime.bigint() < end) { /* spin */ } };
  for (let i = 0; i < scopes; i += 1) {
    spin(50 + Math.floor(Math.random() * 450));
    try { rmSync(join(base, `af-writer-race-${i}`), { recursive: true, force: true }); } catch { /* already gone */ }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent mode
// ---------------------------------------------------------------------------
const SCOPES = Number(argValue('--scopes', '400'));
const MAX_SCANS = Number(argValue('--max-scans', '60000'));
const JSON_OUT = argValue('--json');
const base = mkdtempSync(join(tmpdir(), 'af-scope-race-'));

const results = {
  schema: 'af-scope-race-quantification-v1',
  started_at: new Date().toISOString(),
  parameters: { scopes: SCOPES, max_scans: MAX_SCANS, base },
  s1_burst: null,
  s2_orphan: null,
  s3_unreadable: null,
  s4_truncated: null,
  s5_clean: null,
  s6_rescan: null,
  s7_live_writer: null,
};

const tally = (classes) => classes.reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {});

try {
  // -------------------------------------------------------------------------
  // S1: burst reap race, real inspectWriterScopes, reaper in a separate process
  // -------------------------------------------------------------------------
  for (let i = 0; i < SCOPES; i += 1) {
    const dir = join(base, `af-writer-race-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.procs'), '\n');
  }

  const reaper = spawn(process.execPath, [fileURLToPath(import.meta.url), '--reaper', base, '--scopes', String(SCOPES)], {
    stdio: 'ignore',
  });

  const observations = [];
  let scans = 0;
  const started = Date.now();
  while (reaper.exitCode === null && scans < MAX_SCANS) {
    const obs = inspectWriterScopes(base);
    const c = classify(obs);
    observations.push(c);
    scans += 1;
  }
  await new Promise((resolve) => { reaper.once('exit', resolve); });
  const elapsedMs = Date.now() - started;

  const s1Classes = tally(observations.map((o) => o.klass));
  const s1Reasons = {};
  for (const o of observations) {
    if (!o.reason) continue;
    const key = o.reason.replace(base, '<base>').slice(0, 160);
    s1Reasons[key] = (s1Reasons[key] || 0) + 1;
  }
  results.s1_burst = {
    scans,
    elapsed_ms: elapsedMs,
    scans_per_sec: Math.round((scans / Math.max(elapsedMs, 1)) * 1000),
    classes: s1Classes,
    unknown_rate: observations.length ? Number(((scans - (s1Classes.empty || 0) - (s1Classes.active || 0)) / scans).toFixed(6)) : 0,
    top_reasons: Object.entries(s1Reasons).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };

  // -------------------------------------------------------------------------
  // S6: bounded rescan convergence for transient `unknown`
  // -------------------------------------------------------------------------
  // Rebuild the scopes and reap them again, but this time record, for every
  // `unknown`, how many immediate rescans (K = 1..3) reach a confirmed answer.
  const base2 = mkdtempSync(join(tmpdir(), 'af-scope-race2-'));
  for (let i = 0; i < SCOPES; i += 1) {
    const dir = join(base2, `af-writer-race-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.procs'), '\n');
  }
  const reaper2 = spawn(process.execPath, [fileURLToPath(import.meta.url), '--reaper', base2, '--scopes', String(SCOPES)], {
    stdio: 'ignore',
  });

  const convergence = { unknown_total: 0, converged_at_1: 0, converged_at_2: 0, converged_at_3: 0, never: 0 };
  let scans2 = 0;
  while (reaper2.exitCode === null && scans2 < MAX_SCANS) {
    const first = classify(inspectWriterScopes(base2));
    scans2 += 1;
    if (first.status !== 'unknown') continue;
    convergence.unknown_total += 1;
    let settled = 0;
    for (let k = 1; k <= 3 && settled === 0; k += 1) {
      const again = classify(inspectWriterScopes(base2));
      if (again.status !== 'unknown') settled = k;
    }
    if (settled === 0) convergence.never += 1;
    else convergence[`converged_at_${settled}`] += 1;
  }
  await new Promise((resolve) => { reaper2.once('exit', resolve); });

  const finalScan2 = classify(inspectWriterScopes(base2));
  results.s6_rescan = {
    scans: scans2,
    ...convergence,
    converged_rate: convergence.unknown_total
      ? Number(((convergence.unknown_total - convergence.never) / convergence.unknown_total).toFixed(4))
      : null,
    final_status_after_all_reaps: finalScan2.status,
  };
  rmSync(base2, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // S5: clean reap -> confirmed empty
  // -------------------------------------------------------------------------
  const emptyDir = mkdtempSync(join(tmpdir(), 'af-scope-empty-'));
  const s5 = inspectWriterScopes(emptyDir);
  results.s5_clean = { status: s5.status, reason: s5.reason, retain: classify(s5).retain };
  rmSync(emptyDir, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // S2: persistent orphan (scope dir, no cgroup.procs) - must never converge
  // -------------------------------------------------------------------------
  const orphanBase = mkdtempSync(join(tmpdir(), 'af-scope-orphan-'));
  mkdirSync(join(orphanBase, 'af-writer-orphan'), { recursive: true });
  const orphanScans = [];
  for (let k = 1; k <= 3; k += 1) orphanScans.push(classify(inspectWriterScopes(orphanBase)));
  results.s2_orphan = {
    first: orphanScans[0],
    rescans: orphanScans.slice(1).map((o) => o.status),
    converged: orphanScans.slice(1).some((o) => o.status !== 'unknown'),
    retain: orphanScans[0].retain,
  };
  rmSync(orphanBase, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // S3: unreadable scope (procs exists but the directory denies traversal)
  // -------------------------------------------------------------------------
  const permBase = mkdtempSync(join(tmpdir(), 'af-scope-perm-'));
  const permDir = join(permBase, 'af-writer-perm');
  mkdirSync(permDir, { recursive: true });
  writeFileSync(join(permDir, 'cgroup.procs'), '4242\n');
  chmodSync(permDir, 0o000);
  const permFirst = classify(inspectWriterScopes(permBase));
  const permAgain = classify(inspectWriterScopes(permBase));
  // What the PRODUCTION probe can currently tell: existsSync() swallows EACCES.
  const procsVisibleToExistsSync = existsSync(join(permDir, 'cgroup.procs'));
  results.s3_unreadable = {
    first: permFirst,
    rescan: permAgain.status,
    converged: permAgain.status !== 'unknown',
    retain: permFirst.retain,
    existsSync_swallows_error: procsVisibleToExistsSync === false,
    note: 'existsSync() reports "missing" for EACCES, so the current reason cannot distinguish a reaped scope from an unreadable one',
  };
  chmodSync(permDir, 0o700);
  rmSync(permBase, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // S4: truncation (deeper than MAX_WRITER_SCOPE_DEPTH)
  // -------------------------------------------------------------------------
  const deepBase = mkdtempSync(join(tmpdir(), 'af-scope-deep-'));
  let cur = join(deepBase, 'af-writer-deep');
  mkdirSync(cur, { recursive: true });
  writeFileSync(join(cur, 'cgroup.procs'), '\n');
  for (let i = 0; i < MAX_WRITER_SCOPE_DEPTH + 2; i += 1) {
    cur = join(cur, `level-${i}`);
    mkdirSync(cur);
    writeFileSync(join(cur, 'cgroup.procs'), '\n');
  }
  const deep = classify(inspectWriterScopes(deepBase));
  results.s4_truncated = { ...deep, retain: deep.retain };
  rmSync(deepBase, { recursive: true, force: true });

  // -------------------------------------------------------------------------
  // Decision sanity: the production helpers stay fail-closed on `unknown`
  // -------------------------------------------------------------------------
  const unknownBase = mkdtempSync(join(tmpdir(), 'af-scope-unknown-'));
  process.env.AF_CGROUP_BASE = unknownBase;
  rmSync(unknownBase, { recursive: true, force: true }); // now nonexistent -> unknown
  let getActiveThrew = false;
  try { getActiveWriterScopes(); } catch (err) { getActiveThrew = err.code === 'WRITER_SCOPE_SCAN_UNKNOWN'; }
  results.decision_helpers = {
    getActiveWriterScopes_throws_on_unknown: getActiveThrew,
    force_used: false,
    acknowledge_live_scopes_used: false,
  };

  // -------------------------------------------------------------------------
  // S7: a LIVE writer must never be missed, even while other scopes are reaped
  // -------------------------------------------------------------------------
  // A bounded rescan is only safe if it can never turn a live writer into "empty".
  // Here one scope holds this process's own pid and is never reaped, while a storm
  // removes neighbouring scopes; every observation must be `active` or `unknown`.
  const liveBase = mkdtempSync(join(tmpdir(), 'af-scope-live-'));
  const liveDir = join(liveBase, 'af-writer-live');
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, 'cgroup.procs'), `${process.pid}\n`);
  for (let i = 0; i < SCOPES; i += 1) {
    const dir = join(liveBase, `af-writer-race-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.procs'), '\n');
  }
  const liveReaper = spawn(process.execPath, [fileURLToPath(import.meta.url), '--reaper', liveBase, '--scopes', String(SCOPES)], {
    stdio: 'ignore',
  });
  const liveClasses = {};
  let liveScans = 0;
  let falseEmpty = 0;
  let missedLive = 0;
  while (liveReaper.exitCode === null && liveScans < MAX_SCANS) {
    const obs = inspectWriterScopes(liveBase);
    const c = classify(obs);
    liveClasses[c.klass] = (liveClasses[c.klass] || 0) + 1;
    liveScans += 1;
    if (c.status === 'empty') falseEmpty += 1;
    if (c.status === 'active' && !obs.scopes.some((s) => s.pids.includes(String(process.pid)))) missedLive += 1;
  }
  await new Promise((resolve) => { liveReaper.once('exit', resolve); });
  results.s7_live_writer = {
    scans: liveScans,
    classes: liveClasses,
    false_empty_while_live_scope_exists: falseEmpty,
    active_without_the_live_pid: missedLive,
    final_status: classify(inspectWriterScopes(liveBase)).status,
  };
  rmSync(liveBase, { recursive: true, force: true });

  results.finished_at = new Date().toISOString();

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  console.log('=== A2 quantification: writer-scope scan vs. concurrent reap ===\n');
  console.log(`S1 burst reap race (separate-process reaper, ${SCOPES} scopes)`);
  console.log(`  scans=${results.s1_burst.scans} in ${elapsedMs}ms (${results.s1_burst.scans_per_sec}/s)`);
  console.log(`  classes: ${JSON.stringify(results.s1_burst.classes)}`);
  console.log(`  unknown rate: ${results.s1_burst.unknown_rate}`);
  for (const [reason, n] of results.s1_burst.top_reasons) console.log(`    x${n}  ${reason}`);
  console.log('\nS6 bounded rescan convergence');
  console.log(`  unknown observations: ${results.s6_rescan.unknown_total}`);
  console.log(`  converged at K=1/2/3: ${results.s6_rescan.converged_at_1}/${results.s6_rescan.converged_at_2}/${results.s6_rescan.converged_at_3}`);
  console.log(`  never converged: ${results.s6_rescan.never}  (rate=${results.s6_rescan.converged_rate})`);
  console.log(`  final status after all reaps: ${results.s6_rescan.final_status_after_all_reaps}`);
  console.log('\nPersistent classes (must stay fail-closed)');
  console.log(`  S2 orphan dir without procs : ${JSON.stringify(results.s2_orphan)}`);
  console.log(`  S3 unreadable scope dir     : ${JSON.stringify({ first: results.s3_unreadable.first, rescan: results.s3_unreadable.rescan, existsSync_swallows_error: results.s3_unreadable.existsSync_swallows_error })}`);
  console.log(`  S4 truncated scan           : ${JSON.stringify({ klass: results.s4_truncated.klass, retain: results.s4_truncated.retain })}`);
  console.log(`  S5 clean empty base         : ${JSON.stringify(results.s5_clean)}`);
  console.log(`\nS7 live writer during a reap storm`);
  console.log(`  scans=${results.s7_live_writer.scans} classes=${JSON.stringify(results.s7_live_writer.classes)}`);
  console.log(`  false 'empty' while a live scope exists: ${results.s7_live_writer.false_empty_while_live_scope_exists}`);
  console.log(`  'active' without the live pid          : ${results.s7_live_writer.active_without_the_live_pid}`);
  console.log(`  final status                           : ${results.s7_live_writer.final_status}`);
  console.log(`\nDecision helpers: ${JSON.stringify(results.decision_helpers)}`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`\nJSON written to ${JSON_OUT}`);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
