// enospc-failclosed.test.mjs - ENOSPC must behave exactly like any other unwritable audit.
//
// A real full disk cannot be created without root, so this drives the REAL recovery transaction
// with an injected ENOSPC at the two phases that matter and asserts the same fail-closed outcomes
// a full volume would produce: nothing is modified when the pre-mutation gate cannot be written,
// and a restore whose RESULT cannot be recorded becomes RECONCILE_RECORD (never a clean unlock,
// never a second release). The errno is simulated; the code path is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { engageTaskHostBoundary, disengageTaskHostBoundary, recoverRetainedBoundary } from '../lib/host-boundary.mjs';
import { recordBoundaryAlert, listBoundaryAlerts } from '../lib/boundary-alerts.mjs';

const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });

function fixture(tag) {
  const root = mkdtempSync(join(tmpdir(), `af-enospc-${tag}-`));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const auditDir = join(root, 'audit');
  const snapDir = join(root, 'snap');
  const locksDir = join(root, 'locks');
  const scopes = join(root, 'scopes');
  const alertsFile = join(root, 'alerts.jsonl');
  for (const d of [canonicalDir, casDir, auditDir, snapDir, locksDir, scopes]) mkdirSync(d, { recursive: true });
  Object.assign(process.env, {
    AF_CGROUP_BASE: scopes,
    AF_BOUNDARY_SNAPSHOT_DIR: snapDir,
    AF_ASSET_LOCK_DIR: locksDir,
    AF_BOUNDARY_ALERTS_FILE: alertsFile,
    AF_BOUNDARY_AUDIT_DIR: auditDir,
  });
  engageTaskHostBoundary({ canonicalDir, casDir });
  return { root, canonicalDir, casDir, auditDir, alertsFile };
}

const phaseCount = (dir, phase) => readdirSync(dir)
  .filter((n) => /^recovery-.*-(intent|mutation-started|result|persisted|alert-closed)\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')))
  .filter((r) => r.phase === phase).length;

function cleanup(fx) {
  try { recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, justification: 'enospc cleanup', auditDir: fx.auditDir }); } catch { /* fall through */ }
  try { for (const n of readdirSync(join(fx.root, 'locks'))) rmSync(join(fx.root, 'locks', n), { force: true }); } catch { /* best effort */ }
  try { disengageTaskHostBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, force: true }); } catch { /* best effort */ }
  rmSync(fx.root, { recursive: true, force: true });
}

test('ENOSPC-1: a full disk at the pre-mutation gate refuses and modifies nothing', () => {
  const fx = fixture('gate');
  try {
    const before = statSync(fx.canonicalDir).uid;
    const res = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'ENOSPC at the gate',
      auditDir: fx.auditDir,
      hooks: { onPhase: (phase) => { if (phase === 'mutation-started') throw enospc(); } },
    });
    assert.equal(res.outcome, 'REFUSED');
    assert.match(res.reason, /BOUNDARY_MUTATION_GATE_UNWRITABLE/);
    assert.equal(statSync(fx.canonicalDir).uid, before, 'no permission may change when the gate is unwritable');
    assert.equal(phaseCount(fx.auditDir, 'mutation-started'), 0);
  } finally { cleanup(fx); }
});

test('ENOSPC-2: a full disk at the RESULT write is RECONCILE_RECORD - never a clean unlock', () => {
  const fx = fixture('result');
  try {
    recordBoundaryAlert({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, taskId: 'T-ENOSPC', reason: 'scope-anomaly' });
    const res = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'ENOSPC at the RESULT write',
      auditDir: fx.auditDir,
      hooks: { onPhase: (phase) => { if (phase === 'result') throw enospc(); } },
    });
    assert.equal(res.outcome, 'RECONCILE_RECORD');
    assert.equal(res.delivered, false, 'an unrecorded restore must never be delivered as success');
    assert.equal(res.alert_closed, false, 'the alert must not be closed when the record is missing');
    assert.equal(phaseCount(fx.auditDir, 'result'), 0);
    assert.equal(phaseCount(fx.auditDir, 'mutation-started'), 1, 'the mutation marker is the durable evidence that this must not be retried');
    assert.equal(listBoundaryAlerts({ file: fx.alertsFile }).length, 1, 'the alert stays open for a human');

    // A retry must NOT release again: the evidence says a mutation was started.
    const retry = recoverRetainedBoundary({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, justification: 'retry', auditDir: fx.auditDir });
    assert.equal(retry.outcome, 'RECONCILE_REQUIRED');
    assert.match(retry.reason, /UNFINISHED_RECOVERY_MODIFIED_UNCONFIRMED/);
    assert.equal(phaseCount(fx.auditDir, 'mutation-started'), 1, 'no second release');
  } finally { cleanup(fx); }
});

test('ENOSPC-3: a full disk while closing the alert is RECONCILE_RECORD and leaves the alert open', () => {
  const fx = fixture('alert');
  try {
    recordBoundaryAlert({ canonicalDir: fx.canonicalDir, casDir: fx.casDir, taskId: 'T-ENOSPC-3', reason: 'scope-anomaly' });
    const res = recoverRetainedBoundary({
      canonicalDir: fx.canonicalDir,
      casDir: fx.casDir,
      justification: 'ENOSPC while closing the alert',
      auditDir: fx.auditDir,
      closeAlert: () => { throw enospc(); },
    });
    assert.equal(res.outcome, 'RECONCILE_RECORD');
    assert.equal(res.alert_closed, false);
    assert.match(res.reason, /ALERT_CLOSE_FAILED/);
    assert.equal(listBoundaryAlerts({ file: fx.alertsFile }).length, 1, 'the alert must stay open, not be silently dropped');
  } finally { cleanup(fx); }
});
