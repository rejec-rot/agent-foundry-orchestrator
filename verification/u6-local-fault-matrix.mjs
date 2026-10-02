// u6-local-fault-matrix.mjs - U6 acceptance, LOCAL ONLY: fault injection + restart consistency.
//
// Scope authorised by the operator: A1 (no external model calls), B1 (no outbound notification),
// C1 (concurrency 1, local throw-away fixtures, rollback point 88a76c6). Everything here runs on
// local fixtures and local processes; it never calls a model, never sends a notification and never
// installs/enables a unit.
//
// Two groups:
//   G1 fault injection : success, eligibility refusal, audit-unwritable, snapshot-missing,
//                        release-ran-but-unverifiable. Each asserts the boundary is either fully
//                        restored or provably untouched - never a silent half state.
//   G2 restart consistency : a real child process dies mid-transaction (after MUTATION_STARTED,
//                        before RESULT) and a SECOND fresh process must interpret the durable
//                        evidence: a started-but-unfinished release is never re-released, while an
//                        INTENT-only record still proves "nothing was modified" and may proceed.
//
// Usage: node verification/u6-local-fault-matrix.mjs [--keep]

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  engageTaskHostBoundary,
  disengageTaskHostBoundary,
  recoverRetainedBoundary,
  forgetPathSnapshot,
} from '../lib/host-boundary.mjs';
import { recordBoundaryAlert, inspectBoundaryAlerts, listBoundaryAlerts } from '../lib/boundary-alerts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const keep = process.argv.includes('--keep');
const HOST_UID = typeof process.getuid === 'function' ? process.getuid() : null;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const PHASE_FILE = /^recovery-.*-(intent|mutation-started|result|persisted|alert-closed)\.json$/;
const phaseRecords = (dir) => readdirSync(dir).filter((n) => PHASE_FILE.test(n))
  .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
const countPhase = (dir, phase) => phaseRecords(dir).filter((r) => r.phase === phase).length;

function metadataMap(dir) {
  const out = {};
  const walk = (current, rel) => {
    const st = lstatSync(current);
    out[rel] = `${st.uid}:${st.gid}:${(st.mode & 0o7777).toString(8)}`;
    if (st.isDirectory()) for (const name of readdirSync(current).sort()) walk(join(current, name), rel === '' ? name : `${rel}/${name}`);
  };
  walk(dir, '');
  return out;
}

/** A throw-away fixture, really protected with root ownership + snapshot + epoch. */
function fixture(tag) {
  const root = mkdtempSync(join(tmpdir(), `af-u6-${tag}-`));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const auditDir = join(root, 'audit');
  const snapDir = join(root, 'snap');
  const locksDir = join(root, 'locks');
  const scopes = join(root, 'scopes');
  const alertsFile = join(root, 'alerts.jsonl');
  for (const d of [canonicalDir, casDir, auditDir, snapDir, locksDir, scopes]) mkdirSync(d, { recursive: true });
  writeFileSync(join(canonicalDir, 'main.js'), 'export const canonical = 1;\n');
  writeFileSync(join(casDir, 'blob.txt'), 'blob\n');
  // Capture the TRUE original metadata (before protection): a successful recovery must restore
  // exactly this, not the protected state.
  const originalMetadata = metadataMap(canonicalDir);
  Object.assign(process.env, {
    AF_CGROUP_BASE: scopes,
    AF_BOUNDARY_SNAPSHOT_DIR: snapDir,
    AF_ASSET_LOCK_DIR: locksDir,
    AF_BOUNDARY_ALERTS_FILE: alertsFile,
    AF_BOUNDARY_AUDIT_DIR: auditDir,
    AF_PROTECTION_EPOCH_DIR: join(auditDir, 'epochs'),
  });
  engageTaskHostBoundary({ canonicalDir, casDir });
  return { root, canonicalDir, casDir, auditDir, snapDir, locksDir, scopes, alertsFile, originalMetadata };
}

function cleanup(fx) {
  try { recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, justification: 'U6 cleanup (controlled)', auditDir: fx.auditDir }); } catch { /* fall through */ }
  try { disengageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, force: true }); } catch { /* best effort */ }
  if (!keep) rmSync(fx.root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// G1 - fault injection
// ---------------------------------------------------------------------------

function g1_1_success() {
  const fx = fixture('g1-ok');
  try {
    recordBoundaryAlert({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, taskId: 'U6-1', reason: 'scope-anomaly' });
    const res = recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, justification: 'U6 G1-1 success', auditDir: fx.auditDir });
    check('G1-1 outcome DISENGAGED + delivered', res.outcome === 'DISENGAGED' && res.delivered === true, `outcome=${res.outcome} delivered=${res.delivered}`);
    check('G1-1 alert closed', res.alert_closed === true, `alert_closed=${res.alert_closed}`);
    check('G1-1 ownership restored to host', statSync(fx.canonicalDir).uid === HOST_UID, `uid=${statSync(fx.canonicalDir).uid}`);
    check('G1-1 metadata restored entry-by-entry to the ORIGINAL', JSON.stringify(metadataMap(fx.canonicalDir)) === JSON.stringify(fx.originalMetadata));
    check('G1-1 alert open=false', inspectBoundaryAlerts({ file: fx.alertsFile, includeResolved: true }).alerts[0]?.open === false);
    const phases = ['intent', 'mutation-started', 'result', 'alert-closed'];
    check('G1-1 ordered phases recorded', phases.every((p) => countPhase(fx.auditDir, p) === 1), phases.map((p) => `${p}=${countPhase(fx.auditDir, p)}`).join(' '));
    console.log(`  raw: ${JSON.stringify({ outcome: res.outcome, delivered: res.delivered, alert_closed: res.alert_closed, reason: res.reason })}`);
  } finally { cleanup(fx); }
}

function g1_2_refusal() {
  const fx = fixture('g1-refuse');
  try {
    const before = metadataMap(fx.canonicalDir);
    const res = recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, auditDir: fx.auditDir });
    check('G1-2 no justification -> REFUSED', res.outcome === 'REFUSED', `outcome=${res.outcome}`);
    check('G1-2 boundary untouched (still root)', statSync(fx.canonicalDir).uid === 0, `uid=${statSync(fx.canonicalDir).uid}`);
    check('G1-2 metadata untouched', JSON.stringify(metadataMap(fx.canonicalDir)) === JSON.stringify(before));
    check('G1-2 refusal still audited (intent + result)', countPhase(fx.auditDir, 'intent') === 1 && countPhase(fx.auditDir, 'result') === 1);
    check('G1-2 no mutation marker written', countPhase(fx.auditDir, 'mutation-started') === 0);
    console.log(`  raw: ${JSON.stringify({ outcome: res.outcome, reason: res.reason })}`);
  } finally { cleanup(fx); }
}

function g1_3_audit_unwritable() {
  const fx = fixture('g1-noaudit');
  try {
    const before = metadataMap(fx.canonicalDir);
    chmodSync(fx.auditDir, 0o500); // audit unwritable: nothing may be modified without a trail
    let res;
    try {
      res = recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, justification: 'U6 G1-3 audit unwritable', auditDir: fx.auditDir });
    } finally {
      chmodSync(fx.auditDir, 0o700);
    }
    check('G1-3 audit unwritable -> REFUSED', res.outcome === 'REFUSED' && /BOUNDARY_AUDIT_UNAVAILABLE/.test(res.reason ?? ''), `outcome=${res.outcome}`);
    check('G1-3 boundary untouched (still root)', statSync(fx.canonicalDir).uid === 0, `uid=${statSync(fx.canonicalDir).uid}`);
    check('G1-3 metadata untouched', JSON.stringify(metadataMap(fx.canonicalDir)) === JSON.stringify(before));
    console.log(`  raw: ${JSON.stringify({ outcome: res.outcome, reason: res.reason })}`);
  } finally { cleanup(fx); }
}

function g1_4_snapshot_missing() {
  const fx = fixture('g1-nosnap');
  try {
    forgetPathSnapshot(fx.canonicalDir);
    forgetPathSnapshot(fx.casDir);
    const res = recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, justification: 'U6 G1-4 snapshot lost', auditDir: fx.auditDir });
    check('G1-4 missing snapshot -> PROTECTION_RETAINED (never guess)', res.outcome === 'PROTECTION_RETAINED', `outcome=${res.outcome}`);
    check('G1-4 boundary untouched (still root)', statSync(fx.canonicalDir).uid === 0, `uid=${statSync(fx.canonicalDir).uid}`);
    check('G1-4 no release attempted (no mutation marker)', countPhase(fx.auditDir, 'mutation-started') === 0);
    console.log(`  raw: ${JSON.stringify({ outcome: res.outcome, reason: res.reason })}`);
  } finally { cleanup(fx); }
}

function g1_5_unverifiable_release() {
  const fx = fixture('g1-guess');
  try {
    forgetPathSnapshot(fx.canonicalDir);
    forgetPathSnapshot(fx.casDir);
    recordBoundaryAlert({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, taskId: 'U6-5', reason: 'scope-anomaly' });
    const res = recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, justification: 'U6 G1-5 guessed modes', allowGuessedModes: true, auditDir: fx.auditDir });
    check('G1-5 guessed restore -> RESTORE_INCOMPLETE (never a clean unlock)', res.outcome === 'RESTORE_INCOMPLETE' && res.recovered === false, `outcome=${res.outcome}`);
    check('G1-5 not delivered', res.delivered === false);
    check('G1-5 alert NOT closed (unverified unlock must not raise success)', listBoundaryAlerts({ file: fx.alertsFile }).length === 1, `open=${listBoundaryAlerts({ file: fx.alertsFile }).length}`);
    check('G1-5 ownership released even though unverified', statSync(fx.canonicalDir).uid === HOST_UID, `uid=${statSync(fx.canonicalDir).uid}`);
    console.log(`  raw: ${JSON.stringify({ outcome: res.outcome, recovered: res.recovered, delivered: res.delivered, reason: res.reason })}`);
  } finally { cleanup(fx); }
}

// ---------------------------------------------------------------------------
// G2 - restart consistency (real child processes)
// ---------------------------------------------------------------------------

function runChild(fx, fault) {
  const proc = spawnSync(process.execPath, [join(HERE, 'u6-recover-once.mjs')], {
    env: {
      ...process.env,
      AF_U6_CANONICAL: fx.canonicalDir,
      AF_U6_CAS: fx.casDir,
      AF_U6_AUDIT: fx.auditDir,
      AF_U6_JUSTIFICATION: `U6 restart probe (fault=${fault || 'none'})`,
      AF_U6_FAULT: fault,
      AF_CGROUP_BASE: fx.scopes,
      AF_BOUNDARY_SNAPSHOT_DIR: fx.snapDir,
      AF_ASSET_LOCK_DIR: fx.locksDir,
      AF_BOUNDARY_ALERTS_FILE: fx.alertsFile,
      AF_BOUNDARY_AUDIT_DIR: fx.auditDir,
    },
    encoding: 'utf8',
  });
  if (proc.status !== 0) return { outcome: 'CHILD_NONZERO', stderr: proc.stderr };
  return JSON.parse(proc.stdout.trim().split('\n').pop());
}

function g2_1_die_before_result() {
  const fx = fixture('g2-kill');
  try {
    recordBoundaryAlert({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, taskId: 'U6-G2-1', reason: 'scope-anomaly' });
    const first = runChild(fx, 'result'); // process "dies" after MUTATION_STARTED, before RESULT
    check('G2-1 first process -> RECONCILE_RECORD (physical restore, record missing)', first.outcome === 'RECONCILE_RECORD', `outcome=${first.outcome}`);
    check('G2-1 durable evidence: MUTATION_STARTED present, RESULT absent', countPhase(fx.auditDir, 'mutation-started') === 1 && countPhase(fx.auditDir, 'result') === 0, `mutation=${countPhase(fx.auditDir, 'mutation-started')} result=${countPhase(fx.auditDir, 'result')}`);

    const second = runChild(fx, ''); // a FRESH process reinterprets the durable evidence
    check('G2-1 fresh process -> RECONCILE_REQUIRED (never assume unmodified)', second.outcome === 'RECONCILE_REQUIRED', `outcome=${second.outcome}`);
    check('G2-1 fresh process did NOT release again (still one mutation marker)', countPhase(fx.auditDir, 'mutation-started') === 1, `mutation=${countPhase(fx.auditDir, 'mutation-started')}`);
    check('G2-1 ownership stays with host (no second release attempt on the tree)', statSync(fx.canonicalDir).uid === HOST_UID);

    const records = phaseRecords(fx.auditDir);
    const seqOrdered = records.every((r) => typeof r.phase_seq === 'number');
    check('G2-1 all records carry a phase_seq (order reconstructible after restart)', seqOrdered);
    console.log(`  raw: first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  } finally { cleanup(fx); }
}

function g2_2_intent_only_may_retry() {
  const fx = fixture('g2-intent');
  try {
    // A dangling INTENT with no MUTATION_STARTED: proof that nothing was modified.
    const assetKey = realpathSync(fx.canonicalDir);
    writeFileSync(join(fx.auditDir, 'recovery-seed-intent.json'), JSON.stringify({
      schema_version: 'af-boundary-recovery-v2',
      recovery_id: 'seed',
      asset_key: assetKey,
      phase: 'intent',
      phase_seq: 1,
      at: new Date().toISOString(),
      paths: [fx.canonicalDir, fx.casDir],
    }, null, 2));

    const res = runChild(fx, '');
    check('G2-2 INTENT-only prior recovery may proceed (not RECONCILE_*)', !/^RECONCILE/.test(res.outcome), `outcome=${res.outcome}`);
    check('G2-2 the retry completed the recovery', res.outcome === 'DISENGAGED' && res.delivered === true, `outcome=${res.outcome} delivered=${res.delivered}`);
    console.log(`  raw: ${JSON.stringify(res)}`);
  } finally { cleanup(fx); }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('U6 local fault matrix (no external effects: no model calls, no notifications, no unit install)');
console.log(`rollback point: 88a76c6 (tag stage5-u5-dry-run-authorization); host uid=${HOST_UID}\n`);

for (const [label, fn] of [
  ['G1-1 success', g1_1_success],
  ['G1-2 refusal', g1_2_refusal],
  ['G1-3 audit unwritable', g1_3_audit_unwritable],
  ['G1-4 snapshot missing', g1_4_snapshot_missing],
  ['G1-5 unverifiable release', g1_5_unverifiable_release],
  ['G2-1 die before RESULT', g2_1_die_before_result],
  ['G2-2 intent-only may retry', g2_2_intent_only_may_retry],
]) {
  console.log(`\n== ${label} ==`);
  try {
    fn();
  } catch (err) {
    check(`${label}: no unhandled error`, false, err.message);
  }
}

// Residue: a local run must leave no lock files behind.
const repoLocks = join(HERE, '..', 'runtime', 'asset-locks');
check('no residue: repo runtime/asset-locks absent', !existsSync(repoLocks));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(', ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
