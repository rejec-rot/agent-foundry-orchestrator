// recovery-transaction.test.mjs - U2 recovery transaction (A1a design §1.3, §7.5, H1-H3)
//
// The recovery of a retained boundary is a staged transaction:
//
//   INTENT -> (checks) -> MUTATION_STARTED -> release -> RESULT -> task persist -> alert close
//
// This file pins the three properties the frozen design demands:
//   1. the mutation gate is durable and comes before the first permission change (H1);
//   2. an unfinished prior recovery is reconciled by evidence class before anything is retried
//      (§1.3) - "proven unmodified" may retry, "modified or unconfirmed" and "restored but records
//      incomplete" never may, and neither is ever released again;
//   3. the completion order is RESULT -> persist -> alert close, asserted by PHASE SEQUENCE, and a
//      late failure degrades to RECONCILE_RECORD instead of being swallowed (H3, R4).

import './helpers/asset-lock-root.mjs'; // keeps asset locks out of the repository runtime
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  engageTaskHostBoundary,
  disengageTaskHostBoundary,
  recoverRetainedBoundary,
  classifyUnfinishedRecovery,
  RECOVERY_PHASE_SEQ,
  RECOVERY_RECORD_SCHEMA,
} from '../lib/host-boundary.mjs';
import { recordBoundaryAlert, listBoundaryAlerts, inspectBoundaryAlerts } from '../lib/boundary-alerts.mjs';

const PHASE_FILE = /^recovery-.*-(intent|mutation-started|result|persisted|alert-closed)\.json$/;

function recordsByPhase(dir) {
  const map = {};
  for (const name of readdirSync(dir).filter((n) => PHASE_FILE.test(n))) {
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    (map[record.phase] ??= []).push(record);
  }
  return map;
}

function countPhase(dir, phase) {
  return (recordsByPhase(dir)[phase] ?? []).length;
}

/** Seed a durable recovery record directly, standing in for a process that died mid-transaction. */
function seedRecord(dir, recoveryId, phase, seq, extra = {}) {
  const record = {
    schema_version: RECOVERY_RECORD_SCHEMA,
    recovery_id: recoveryId,
    phase,
    phase_seq: seq,
    at: new Date().toISOString(),
    ...extra,
  };
  writeFileSync(join(dir, `recovery-${recoveryId}-${phase}.json`), JSON.stringify(record, null, 2));
  return record;
}

// ---------------------------------------------------------------------------
// Group A: the evidence-class reconciliation itself (pure, no host boundary needed)
// ---------------------------------------------------------------------------

test('RT-A1: an empty audit trail is clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-a1-'));
  try {
    const res = classifyUnfinishedRecovery({ auditDir: dir, assetKey: '/srv/asset' });
    assert.strictEqual(res.state, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-A2: an INTENT with no MUTATION_STARTED proves nothing was modified (may retry)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-a2-'));
  try {
    seedRecord(dir, 'r1', 'intent', RECOVERY_PHASE_SEQ.INTENT, { asset_key: '/srv/asset' });
    const res = classifyUnfinishedRecovery({ auditDir: dir, assetKey: '/srv/asset' });
    assert.strictEqual(res.state, 'clean', 'intent-only is the one class that may retry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-A3: MUTATION_STARTED without a RESULT is modified-or-unconfirmed, never clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-a3-'));
  try {
    seedRecord(dir, 'r1', 'intent', RECOVERY_PHASE_SEQ.INTENT, { asset_key: '/srv/asset' });
    seedRecord(dir, 'r1', 'mutation-started', RECOVERY_PHASE_SEQ.MUTATION_STARTED, { asset_key: '/srv/asset' });
    const res = classifyUnfinishedRecovery({ auditDir: dir, assetKey: '/srv/asset' });
    assert.strictEqual(res.state, 'modified-unconfirmed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-A4: a verified restore whose ALERT_CLOSED marker is missing is record-incomplete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-a4-'));
  try {
    seedRecord(dir, 'r1', 'intent', RECOVERY_PHASE_SEQ.INTENT, { asset_key: '/srv/asset' });
    seedRecord(dir, 'r1', 'mutation-started', RECOVERY_PHASE_SEQ.MUTATION_STARTED, { asset_key: '/srv/asset' });
    seedRecord(dir, 'r1', 'result', RECOVERY_PHASE_SEQ.RESULT, { asset_key: '/srv/asset', outcome: 'DISENGAGED', recovered: true, restored: true, mutation_started: true });
    const res = classifyUnfinishedRecovery({ auditDir: dir, assetKey: '/srv/asset' });
    assert.strictEqual(res.state, 'record-incomplete');
    assert.match(res.reason, /incomplete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-A5: a fully recorded success (with ALERT_CLOSED) is clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-a5-'));
  try {
    seedRecord(dir, 'r1', 'intent', RECOVERY_PHASE_SEQ.INTENT, { asset_key: '/srv/asset' });
    seedRecord(dir, 'r1', 'mutation-started', RECOVERY_PHASE_SEQ.MUTATION_STARTED, { asset_key: '/srv/asset' });
    seedRecord(dir, 'r1', 'result', RECOVERY_PHASE_SEQ.RESULT, { asset_key: '/srv/asset', outcome: 'DISENGAGED', recovered: true, restored: true, mutation_started: true });
    seedRecord(dir, 'r1', 'persisted', RECOVERY_PHASE_SEQ.TASK_PERSISTED, { asset_key: '/srv/asset', ok: true });
    seedRecord(dir, 'r1', 'alert-closed', RECOVERY_PHASE_SEQ.ALERT_CLOSED, { asset_key: '/srv/asset', closed: true });
    const res = classifyUnfinishedRecovery({ auditDir: dir, assetKey: '/srv/asset' });
    assert.strictEqual(res.state, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-A6: a refusal that never modified anything stays clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-a6-'));
  try {
    seedRecord(dir, 'r1', 'intent', RECOVERY_PHASE_SEQ.INTENT, { asset_key: '/srv/asset' });
    seedRecord(dir, 'r1', 'result', RECOVERY_PHASE_SEQ.RESULT, { asset_key: '/srv/asset', outcome: 'PROTECTION_RETAINED', recovered: false, restored: false, mutation_started: false });
    const res = classifyUnfinishedRecovery({ auditDir: dir, assetKey: '/srv/asset' });
    assert.strictEqual(res.state, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-A7: a failed verified restore after a mutation is modified-unconfirmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-a7-'));
  try {
    seedRecord(dir, 'r1', 'intent', RECOVERY_PHASE_SEQ.INTENT, { asset_key: '/srv/asset' });
    seedRecord(dir, 'r1', 'mutation-started', RECOVERY_PHASE_SEQ.MUTATION_STARTED, { asset_key: '/srv/asset' });
    seedRecord(dir, 'r1', 'result', RECOVERY_PHASE_SEQ.RESULT, { asset_key: '/srv/asset', outcome: 'RESTORE_INCOMPLETE', recovered: false, restored: false, mutation_started: true });
    const res = classifyUnfinishedRecovery({ auditDir: dir, assetKey: '/srv/asset' });
    assert.strictEqual(res.state, 'modified-unconfirmed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-A8: an unparseable record is unverifiable - "nothing was modified" cannot be proven (H1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-a8-'));
  try {
    writeFileSync(join(dir, 'recovery-r1-intent.json'), '{ this is not json');
    const res = classifyUnfinishedRecovery({ auditDir: dir, assetKey: '/srv/asset' });
    assert.strictEqual(res.state, 'unverifiable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-A9: records naming a different asset do not decide this asset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-a9-'));
  try {
    seedRecord(dir, 'r1', 'mutation-started', RECOVERY_PHASE_SEQ.MUTATION_STARTED, { asset_key: '/srv/other' });
    const res = classifyUnfinishedRecovery({ auditDir: dir, assetKey: '/srv/asset' });
    assert.strictEqual(res.state, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RT-A10: legacy (pre-transaction) records are read with their coarser semantics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-rt-a10-'));
  try {
    seedRecord(dir, 'old-ok', 'result', RECOVERY_PHASE_SEQ.RESULT, { schema_version: 'af-boundary-recovery-v1', asset_key: '/srv/asset', outcome: 'DISENGAGED', recovered: true });
    seedRecord(dir, 'old-incomplete', 'result', RECOVERY_PHASE_SEQ.RESULT, { schema_version: 'af-boundary-recovery-v1', asset_key: '/srv/asset', outcome: 'RESTORE_INCOMPLETE', recovered: false });
    // A recorded v1 success is treated as complete; the incomplete one still blocks.
    const res = classifyUnfinishedRecovery({ auditDir: dir, assetKey: '/srv/asset' });
    assert.strictEqual(res.state, 'modified-unconfirmed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Group B: the staged transaction against a real boundary
// ---------------------------------------------------------------------------

function fixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(casDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'main.js'), 'export const canonical = 1;\n');
  const auditDir = mkdtempSync(join(tmpdir(), `${prefix}audit-`));
  const scopeBase = mkdtempSync(join(tmpdir(), `${prefix}scopes-`));
  const alertsFile = join(root, 'alerts.jsonl');
  return { root, canonicalDir, casDir, auditDir, scopeBase, alertsFile };
}

function withEnv(fx) {
  const saved = {
    cgroup: process.env.AF_CGROUP_BASE,
    alerts: process.env.AF_BOUNDARY_ALERTS_FILE,
  };
  process.env.AF_CGROUP_BASE = fx.scopeBase;
  process.env.AF_BOUNDARY_ALERTS_FILE = fx.alertsFile;
  return () => {
    if (saved.cgroup !== undefined) process.env.AF_CGROUP_BASE = saved.cgroup; else delete process.env.AF_CGROUP_BASE;
    if (saved.alerts !== undefined) process.env.AF_BOUNDARY_ALERTS_FILE = saved.alerts; else delete process.env.AF_BOUNDARY_ALERTS_FILE;
  };
}

function cleanup(fx) {
  try { disengageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, force: true }); } catch { /* best effort */ }
  rmSync(fx.scopeBase, { recursive: true, force: true });
  rmSync(fx.auditDir, { recursive: true, force: true });
  rmSync(fx.root, { recursive: true, force: true });
}

test('RT-B1: a verified recovery records INTENT < MUTATION_STARTED < RESULT < persist < alert-close and delivers', () => {
  const fx = fixture('af-rt-b1-');
  const restoreEnv = withEnv(fx);
  try {
    engageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir });
    assert.strictEqual(statSync(fx.canonicalDir).uid, 0);
    recordBoundaryAlert({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, taskId: 'T1', reason: 'scope-anomaly' });

    let persisted = 0;
    const res = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'RT-B1 verified no writers remain',
      auditDir: fx.auditDir,
      persistTask: () => { persisted += 1; return true; },
    });

    assert.strictEqual(res.outcome, 'DISENGAGED');
    assert.strictEqual(res.delivered, true);
    assert.strictEqual(res.complete, true);
    assert.strictEqual(res.alert_closed, true);
    assert.strictEqual(persisted, 1, 'the task persist hook must run exactly once');

    const byPhase = recordsByPhase(fx.auditDir);
    for (const phase of ['intent', 'mutation-started', 'result', 'persisted', 'alert-closed']) {
      assert.strictEqual((byPhase[phase] ?? []).length, 1, `${phase} must be recorded exactly once`);
    }
    // H3: order is asserted by phase name + sequence, never by timestamps.
    assert.deepStrictEqual(
      ['intent', 'mutation-started', 'result', 'persisted', 'alert-closed'].map((p) => byPhase[p][0].phase_seq),
      [RECOVERY_PHASE_SEQ.INTENT, RECOVERY_PHASE_SEQ.MUTATION_STARTED, RECOVERY_PHASE_SEQ.RESULT, RECOVERY_PHASE_SEQ.TASK_PERSISTED, RECOVERY_PHASE_SEQ.ALERT_CLOSED],
    );

    const alert = inspectBoundaryAlerts({ file: fx.alertsFile, includeResolved: true });
    assert.strictEqual(alert.alerts[0].open, false, 'the successful recovery must close the alert');
    assert.strictEqual(statSync(fx.canonicalDir).uid, process.getuid());
  } finally {
    restoreEnv();
    cleanup(fx);
  }
});

test('RT-B2: an unwritable MUTATION_STARTED marker refuses without touching the boundary, and does not poison a later retry', () => {
  const fx = fixture('af-rt-b2-');
  const restoreEnv = withEnv(fx);
  try {
    engageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir });

    const refused = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'RT-B2 fault injection at the mutation gate',
      auditDir: fx.auditDir,
      hooks: { onPhase: (phase) => { if (phase === 'mutation-started') throw new Error('injected: audit unwritable'); } },
    });

    assert.strictEqual(refused.outcome, 'REFUSED');
    assert.match(refused.reason, /BOUNDARY_MUTATION_GATE_UNWRITABLE/);
    assert.strictEqual(refused.recovered, false);
    assert.strictEqual(statSync(fx.canonicalDir).uid, 0, 'a failed mutation gate must leave the boundary untouched');
    assert.strictEqual(countPhase(fx.auditDir, 'mutation-started'), 0);
    assert.strictEqual(recordsByPhase(fx.auditDir).result[0].outcome, 'REFUSED');

    // The refusal is classed as "nothing was modified", so a clean retry must still succeed.
    const retried = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'RT-B2 clean retry',
      auditDir: fx.auditDir,
    });
    assert.strictEqual(retried.outcome, 'DISENGAGED');
    assert.strictEqual(statSync(fx.canonicalDir).uid, process.getuid());
  } finally {
    restoreEnv();
    cleanup(fx);
  }
});

test('RT-B3: a crash after the release (no RESULT) is RECONCILE_RECORD, and the retry never releases again', () => {
  const fx = fixture('af-rt-b3-');
  const restoreEnv = withEnv(fx);
  try {
    engageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir });

    const crashed = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'RT-B3 fault injection: die after the release, before the RESULT',
      auditDir: fx.auditDir,
      hooks: { onPhase: (phase) => { if (phase === 'result') throw new Error('injected: RESULT write fails'); } },
    });
    assert.strictEqual(crashed.outcome, 'RECONCILE_RECORD');
    assert.strictEqual(crashed.delivered, false);
    assert.strictEqual(crashed.alert_closed, false);
    assert.strictEqual(countPhase(fx.auditDir, 'mutation-started'), 1);
    assert.strictEqual(countPhase(fx.auditDir, 'result'), 0);
    assert.strictEqual(statSync(fx.canonicalDir).uid, process.getuid(), 'the release really did happen');

    const retried = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'RT-B3 retry must refuse',
      auditDir: fx.auditDir,
    });
    // On disk there is a marker but no RESULT, so a later observer cannot tell that the release
    // finished: the safe, durable classification is "modified or unconfirmed" -> a human decides.
    assert.strictEqual(retried.outcome, 'RECONCILE_REQUIRED');
    assert.match(retried.reason, /UNFINISHED_RECOVERY_MODIFIED_UNCONFIRMED/);
    assert.strictEqual(countPhase(fx.auditDir, 'mutation-started'), 1, 'the retry must not start a second release');
  } finally {
    restoreEnv();
    cleanup(fx);
  }
});

test('RT-B4: a killed-after-mutation recovery with no RESULT at all goes to RECONCILE_REQUIRED', () => {
  const fx = fixture('af-rt-b4-');
  const restoreEnv = withEnv(fx);
  try {
    engageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir });
    // Stand in for a process killed between the marker and the release: no RESULT was ever written.
    seedRecord(fx.auditDir, 'r-killed', 'intent', RECOVERY_PHASE_SEQ.INTENT, { asset_key: realpathSync(fx.canonicalDir) });
    seedRecord(fx.auditDir, 'r-killed', 'mutation-started', RECOVERY_PHASE_SEQ.MUTATION_STARTED, { asset_key: realpathSync(fx.canonicalDir) });

    const res = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'RT-B4 must refuse and defer to a human',
      auditDir: fx.auditDir,
    });
    assert.strictEqual(res.outcome, 'RECONCILE_REQUIRED');
    assert.match(res.reason, /UNFINISHED_RECOVERY_MODIFIED_UNCONFIRMED/);
    assert.strictEqual(statSync(fx.canonicalDir).uid, 0, 'an unconfirmed mutation must not be released again');
    assert.strictEqual(countPhase(fx.auditDir, 'mutation-started'), 1);
  } finally {
    restoreEnv();
    cleanup(fx);
  }
});

test('RT-B5: an alert that cannot be closed is RECONCILE_RECORD, leaves the alert open, and is never swallowed', () => {
  const fx = fixture('af-rt-b5-');
  const restoreEnv = withEnv(fx);
  try {
    engageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir });
    recordBoundaryAlert({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, taskId: 'T5', reason: 'scope-anomaly' });

    const res = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'RT-B5 alert close failure',
      auditDir: fx.auditDir,
      closeAlert: () => { throw new Error('injected: alert store unavailable'); },
    });
    assert.strictEqual(res.outcome, 'RECONCILE_RECORD');
    assert.strictEqual(res.delivered, false);
    assert.strictEqual(res.alert_closed, false);
    assert.match(res.reason, /ALERT_CLOSE_FAILED/);
    assert.strictEqual(countPhase(fx.auditDir, 'alert-closed'), 0);
    assert.strictEqual(listBoundaryAlerts({ file: fx.alertsFile }).length, 1, 'the alert must be left open, not silently dropped');

    const retried = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'RT-B5 retry must not release again',
      auditDir: fx.auditDir,
    });
    assert.strictEqual(retried.outcome, 'RECONCILE_RECORD');
    assert.strictEqual(countPhase(fx.auditDir, 'mutation-started'), 1, 'the retry must not start a second release');
  } finally {
    restoreEnv();
    cleanup(fx);
  }
});

test('RT-B6: a task persist failure is RECONCILE_RECORD, keeps the alert open, and is never re-released', () => {
  const fx = fixture('af-rt-b6-');
  const restoreEnv = withEnv(fx);
  try {
    engageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir });
    recordBoundaryAlert({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, taskId: 'T6', reason: 'scope-anomaly' });

    const res = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'RT-B6 task persist failure',
      auditDir: fx.auditDir,
      persistTask: () => { throw new Error('injected: task store unavailable'); },
    });
    assert.strictEqual(res.outcome, 'RECONCILE_RECORD');
    assert.strictEqual(res.delivered, false);
    assert.strictEqual(res.alert_closed, false);
    assert.match(res.reason, /TASK_PERSIST_FAILED/);
    assert.strictEqual(countPhase(fx.auditDir, 'persisted'), 0);
    assert.strictEqual(countPhase(fx.auditDir, 'alert-closed'), 0);
    assert.strictEqual(listBoundaryAlerts({ file: fx.alertsFile }).length, 1, 'the alert must not be closed when the task state is not recorded');
  } finally {
    restoreEnv();
    cleanup(fx);
  }
});
