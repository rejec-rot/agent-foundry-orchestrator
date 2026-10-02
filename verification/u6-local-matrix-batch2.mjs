// u6-local-matrix-batch2.mjs - U6 acceptance, LOCAL ONLY, batch 2.
//
// Scope authorised by the operator: A1 (no external model calls), B1 (no outbound notification),
// C1 (concurrency 1, local throw-away fixtures, rollback point 88a76c6). No model call, no
// notification, no unit install anywhere in this run.
//
// Groups (dependency order):
//   H1 hang/kill during release : a controllable hanging "docker" makes the release stall; the
//                                 recovery process is killed after MUTATION_STARTED is durable and
//                                 before RESULT. A fresh process must refuse (never re-release).
//   H2 scope scan unreadable    : a writer scope whose cgroup.procs cannot be read must keep the
//                                 boundary locked (fail closed), never treated as empty.
//   H3 real retention chain     : the lifecycle's RETAIN decision (A2) -> retained alert -> A1a
//                                 eligibility refuses while the anomaly stands -> after the
//                                 anomaly is cleared, a controlled recovery completes and closes
//                                 the alert. This joins A2 + A1a + U2 into one real chain.
//   H4 A1a state across restart : the epoch-bound budget/backoff in state.json is re-read by a
//                                 fresh process.
//
// Usage: node verification/u6-local-matrix-batch2.mjs [--keep]

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  engageTaskHostBoundary,
  disengageTaskHostBoundary,
  recoverRetainedBoundary,
} from '../lib/host-boundary.mjs';
import { recordBoundaryAlert, listBoundaryAlerts, inspectBoundaryAlerts } from '../lib/boundary-alerts.mjs';
import { a1aConfig, explainA1aAsset } from '../lib/a1a.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AF_ROOT = join(HERE, '..');
const keep = process.argv.includes('--keep');
const HOST_UID = typeof process.getuid === 'function' ? process.getuid() : null;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const PHASE_FILE = /^recovery-.*-(intent|mutation-started|result|persisted|alert-closed)\.json$/;
const countPhase = (dir, phase) => readdirSync(dir).filter((n) => PHASE_FILE.test(n))
  .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8'))).filter((r) => r.phase === phase).length;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(tag) {
  const root = mkdtempSync(join(tmpdir(), `af-u6b2-${tag}-`));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const auditDir = join(root, 'audit');
  const snapDir = join(root, 'snap');
  const locksDir = join(root, 'locks');
  const scopes = join(root, 'scopes');
  const alertsFile = join(root, 'alerts.jsonl');
  const tasksDir = join(root, 'tasks');
  for (const d of [canonicalDir, casDir, auditDir, snapDir, locksDir, scopes, tasksDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(canonicalDir, 'main.js'), 'export const canonical = 1;\n');
  writeFileSync(join(casDir, 'blob.txt'), 'blob\n');
  Object.assign(process.env, {
    AF_CGROUP_BASE: scopes,
    AF_BOUNDARY_SNAPSHOT_DIR: snapDir,
    AF_ASSET_LOCK_DIR: locksDir,
    AF_BOUNDARY_ALERTS_FILE: alertsFile,
    AF_BOUNDARY_AUDIT_DIR: auditDir,
    AF_PROTECTION_EPOCH_DIR: join(auditDir, 'epochs'),
    AF_TASKS_DIR: tasksDir,
  });
  engageTaskHostBoundary({ canonicalDir, casDir });
  return { root, canonicalDir, casDir, auditDir, snapDir, locksDir, scopes, alertsFile, tasksDir };
}

function cleanup(fx) {
  try { recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, justification: 'U6 b2 cleanup (controlled)', auditDir: fx.auditDir }); } catch { /* fall through */ }
  // A SIGKILLed child leaves a stale asset lock; this is a disposable fixture, so drop it (a real
  // operator must NOT do this - the lock protocol reports dead-holder-needs-reconciliation for a
  // human). Then force-disengage so no root-owned tree is left behind.
  try { for (const name of readdirSync(fx.locksDir)) rmSync(join(fx.locksDir, name), { force: true }); } catch { /* best effort */ }
  try { disengageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, force: true }); } catch { /* best effort */ }
  if (!keep) rmSync(fx.root, { recursive: true, force: true });
}

/** Run the one-shot recovery helper in a fresh process and return its parsed JSON result. */
function runChildSync(fx, fault) {
  const proc = spawnSync(process.execPath, [join(HERE, 'u6-recover-once.mjs')], {
    env: {
      ...process.env,
      AF_U6_CANONICAL: fx.canonicalDir,
      AF_U6_CAS: fx.casDir,
      AF_U6_AUDIT: fx.auditDir,
      AF_U6_JUSTIFICATION: `U6 b2 probe (fault=${fault || 'none'})`,
      AF_U6_FAULT: fault,
      AF_CGROUP_BASE: fx.scopes,
      AF_BOUNDARY_SNAPSHOT_DIR: fx.snapDir,
      AF_ASSET_LOCK_DIR: fx.locksDir,
      AF_BOUNDARY_ALERTS_FILE: fx.alertsFile,
      AF_BOUNDARY_AUDIT_DIR: fx.auditDir,
    },
    encoding: 'utf8',
  });
  if (proc.status !== 0 || !proc.stdout.trim()) return { outcome: 'CHILD_NONZERO', stderr: proc.stderr };
  return JSON.parse(proc.stdout.trim().split('\n').pop());
}

// ---------------------------------------------------------------------------
// H1 - hang during release, killed before RESULT
// ---------------------------------------------------------------------------

async function h1_hang_kill() {
  const fx = fixture('h1');
  try {
    // A fake docker that stalls: the release can start but never finish.
    const shimDir = join(fx.root, 'shim');
    mkdirSync(shimDir, { recursive: true });
    const shimPidFile = join(shimDir, 'pid');
    writeFileSync(join(shimDir, 'docker'), `#!/bin/sh\necho $$ > "${shimPidFile}"\nsleep 60\n`, { mode: 0o755 });
    recordBoundaryAlert({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, taskId: 'U6-H1', reason: 'scope-anomaly' });

    const child = spawn(process.execPath, [join(HERE, 'u6-recover-once.mjs')], {
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        AF_U6_CANONICAL: fx.canonicalDir,
        AF_U6_CAS: fx.casDir,
        AF_U6_AUDIT: fx.auditDir,
        AF_U6_JUSTIFICATION: 'U6 H1 hang during release',
        AF_U6_FAULT: '',
        AF_CGROUP_BASE: fx.scopes,
        AF_BOUNDARY_SNAPSHOT_DIR: fx.snapDir,
        AF_ASSET_LOCK_DIR: fx.locksDir,
        AF_BOUNDARY_ALERTS_FILE: fx.alertsFile,
        AF_BOUNDARY_AUDIT_DIR: fx.auditDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait until MUTATION_STARTED is durable, then kill the process mid-release.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && countPhase(fx.auditDir, 'mutation-started') === 0) await sleep(20);
    const sawMarker = countPhase(fx.auditDir, 'mutation-started') === 1;
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
    try { process.kill(Number(readFileSync(shimPidFile, 'utf8').trim()), 'SIGKILL'); } catch { /* shim already gone */ }

    check('H1 process died after MUTATION_STARTED, before RESULT', sawMarker && countPhase(fx.auditDir, 'result') === 0, `mutation=${countPhase(fx.auditDir, 'mutation-started')} result=${countPhase(fx.auditDir, 'result')}`);
    check('H1 boundary untouched by the stalled release (still root)', statSync(fx.canonicalDir).uid === 0, `uid=${statSync(fx.canonicalDir).uid}`);

    // Layer 1 - a post-kill process cannot even take the lock: the dead holder is reported for
    // reconciliation, never stolen (the lock protocol's H1). This is MORE conservative than the
    // evidence classification, and is the correct outcome for a hard-killed holder.
    const locked = runChildSync(fx, '');
    check('H1 fresh process blocked by the dead-holder lock (never stolen)',
      locked.outcome === 'REFUSED' && /dead-holder-needs-reconciliation/.test(locked.reason ?? ''),
      `outcome=${locked.outcome}`);
    check('H1 still not re-released under the dead-holder lock', countPhase(fx.auditDir, 'mutation-started') === 1);

    // Layer 2 - with the stale lock removed (disposable fixture only), the DURABLE EVIDENCE still
    // refuses: a started-but-unfinished release is never assumed unmodified.
    for (const name of readdirSync(fx.locksDir)) rmSync(join(fx.locksDir, name), { force: true });
    const retry = runChildSync(fx, '');
    check('H1 after stale-lock removal -> RECONCILE_REQUIRED (evidence layer)', retry.outcome === 'RECONCILE_REQUIRED', `outcome=${retry.outcome}`);
    check('H1 evidence layer also did not re-release', countPhase(fx.auditDir, 'mutation-started') === 1, `mutation=${countPhase(fx.auditDir, 'mutation-started')}`);
    console.log(`  raw: locked=${JSON.stringify(locked)} retry=${JSON.stringify(retry)}`);
  } finally { cleanup(fx); }
}

// ---------------------------------------------------------------------------
// H2 - an unreadable writer scope must keep the boundary locked
// ---------------------------------------------------------------------------

function h2_scope_unreadable() {
  const fx = fixture('h2');
  try {
    const scope = join(fx.scopes, 'af-writer-live');
    mkdirSync(scope, { recursive: true });
    const procs = join(scope, 'cgroup.procs');
    writeFileSync(procs, '1\n');
    chmodSync(procs, 0o000); // cannot be read -> emptiness cannot be confirmed
    let res;
    try {
      res = recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, justification: 'U6 H2 unreadable scope', auditDir: fx.auditDir });
    } finally {
      chmodSync(procs, 0o644);
    }
    check('H2 unreadable scope -> PROTECTION_RETAINED (fail closed)', res.outcome === 'PROTECTION_RETAINED', `outcome=${res.outcome}`);
    check('H2 boundary untouched', statSync(fx.canonicalDir).uid === 0, `uid=${statSync(fx.canonicalDir).uid}`);
    check('H2 no release attempted', countPhase(fx.auditDir, 'mutation-started') === 0);
    console.log(`  raw: ${JSON.stringify({ outcome: res.outcome, reason: res.reason })}`);
  } finally { cleanup(fx); }
}

// ---------------------------------------------------------------------------
// H3 - real retention chain: A2 RETAIN -> alert -> A1a refuses -> fix -> recover
// ---------------------------------------------------------------------------

function h3_real_retention_chain() {
  const fx = fixture('h3');
  try {
    // A2: the lifecycle tries to disengage, but a broken scope keeps the boundary locked.
    const brokenScope = join(fx.scopes, 'af-writer-broken');
    mkdirSync(brokenScope, { recursive: true }); // no cgroup.procs -> scope-anomaly/broken-scope
    const retire = disengageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, quiesceConfirmed: true });
    check('H3 lifecycle RETAIN (not disengaged)', retire.disengaged === false && retire.outcome === 'PROTECTION_RETAINED', `outcome=${retire.outcome}`);
    check('H3 retained because scope could not be confirmed', /CANNOT_CONFIRM_WRITER_SCOPES/.test(retire.reason ?? ''), retire.reason ?? '');
    check('H3 boundary still protected after retain', statSync(fx.canonicalDir).uid === 0);

    // The lifecycle records the retention as an alert and a task boundary_state.
    recordBoundaryAlert({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, taskId: 'T-U6-H3', reason: retire.reason, scopeDecision: retire.scope_decision });
    writeFileSync(join(fx.tasksDir, 'T-U6-H3.json'), JSON.stringify({
      task_id: 'T-U6-H3',
      state: 'COMPLETED',
      fixture_dir: fx.canonicalDir,
      trusted_import: {
        cas_dir: fx.casDir,
        boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
        boundary_retained_reason: retire.reason,
        author_completed: true,
        author_termination_evidence: { termination_confirmed: true, process_group_alive: false, scope_verified: true },
      },
    }, null, 2));
    check('H3 retention alert is open', listBoundaryAlerts({ file: fx.alertsFile }).length === 1);

    // A1a (dry-run) must refuse while the anomaly stands: the retained boundary is not eligible.
    const cfg = a1aConfig({ ...process.env, AF_A1A_MODE: 'dry-run' }, AF_ROOT);
    const explanation = explainA1aAsset({
      cfg,
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      deps: { allowlist: { ok: true, configured: true, assets: [{ canonical_dir: fx.canonicalDir, cas_dir: fx.casDir, task_id: 'T-U6-H3', max_attempts: 3 }] } },
    });
    check('H3 A1a refuses the retained boundary (3.5 scopes)', explanation.evaluation.eligible === false && explanation.evaluation.first_failure === '3.5-scopes-empty', `first=${explanation.evaluation.first_failure}`);
    check('H3 A1a did not release anything', statSync(fx.canonicalDir).uid === 0);

    // Clear the anomaly, then a controlled recovery completes and closes the alert.
    rmSync(brokenScope, { recursive: true, force: true });
    const recovered = recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, justification: 'U6 H3 anomaly cleared, controlled recovery', auditDir: fx.auditDir });
    check('H3 controlled recovery completes', recovered.outcome === 'DISENGAGED' && recovered.delivered === true, `outcome=${recovered.outcome}`);
    check('H3 ownership restored to host', statSync(fx.canonicalDir).uid === HOST_UID);
    check('H3 alert closed by the recovery', inspectBoundaryAlerts({ file: fx.alertsFile, includeResolved: true }).alerts[0]?.open === false);
    console.log(`  raw: retain=${JSON.stringify({ outcome: retire.outcome, reason: retire.reason })} recover=${JSON.stringify({ outcome: recovered.outcome, delivered: recovered.delivered })}`);
  } finally { cleanup(fx); }
}

// ---------------------------------------------------------------------------
// H4 - A1a budget/epoch state survives a process restart
// ---------------------------------------------------------------------------

function h4_state_across_restart() {
  const fx = fixture('h4');
  try {
    const queueFile = join(fx.auditDir, 'a1a', 'state.json');
    const allowlistFile = join(fx.root, 'allowlist.json');
    writeFileSync(allowlistFile, JSON.stringify({ schema: 'af-a1a-allowlist-v1', assets: [{ canonical_dir: fx.canonicalDir, cas_dir: fx.casDir, task_id: 'T-U6-H4', max_attempts: 3 }] }));
    // State written as if a previous process had attempted twice this epoch.
    mkdirSync(join(fx.auditDir, 'a1a'), { recursive: true });
    writeFileSync(queueFile, JSON.stringify({
      schema_version: 'af-a1a-state-v1',
      updated_at: new Date().toISOString(),
      assets: { [`${fx.canonicalDir}|${fx.casDir}`]: { epoch_id: 'epoch-x', attempts: 2, next_attempt_at: '2026-09-22T12:00:00.000Z', phase: 'DEFERRED', last_reason: 'PROTECTION_RETAINED', needs_human: false, exhausted_at: null } },
    }, null, 2));

    const proc = spawnSync(process.execPath, [join(AF_ROOT, 'af-admin.mjs'), 'a1a', 'status', '--json'], {
      env: { ...process.env, AF_A1A_MODE: 'dry-run', AF_A1A_ALLOWLIST_FILE: allowlistFile, AF_A1A_QUEUE_FILE: queueFile, AF_BOUNDARY_AUDIT_DIR: fx.auditDir, AF_TASKS_DIR: fx.tasksDir, AF_CGROUP_BASE: fx.scopes },
      encoding: 'utf8',
    });
    const status = JSON.parse(proc.stdout);
    const asset = status.assets[0];
    check('H4 fresh process reads the epoch from state.json', asset?.epoch_id === 'epoch-x', `epoch=${asset?.epoch_id}`);
    check('H4 fresh process reads attempts/phase (budget survives restart)', asset?.attempts === 2 && asset?.phase === 'DEFERRED', `attempts=${asset?.attempts} phase=${asset?.phase}`);
    console.log(`  raw: ${JSON.stringify({ epoch_id: asset?.epoch_id, attempts: asset?.attempts, phase: asset?.phase, exit: proc.status })}`);
  } finally { cleanup(fx); }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('U6 local matrix batch 2 (no external effects: no model calls, no notifications, no unit install)');
console.log(`rollback point: 88a76c6; host uid=${HOST_UID}\n`);

for (const [label, fn] of [
  ['H1 hang/kill during release', h1_hang_kill],
  ['H2 scope scan unreadable', h2_scope_unreadable],
  ['H3 real retention chain', h3_real_retention_chain],
  ['H4 A1a state across restart', h4_state_across_restart],
]) {
  console.log(`\n== ${label} ==`);
  try {
    await fn();
  } catch (err) {
    check(`${label}: no unhandled error`, false, err.message);
  }
}

check('no residue: repo runtime/asset-locks absent', !existsSync(join(AF_ROOT, 'runtime', 'asset-locks')));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(', ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
