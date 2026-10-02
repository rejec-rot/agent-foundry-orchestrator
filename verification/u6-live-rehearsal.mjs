// u6-live-rehearsal.mjs - a REAL live A1a sweep, on a disposable non-production asset.
//
// This is the closest thing to the U6 live trial that can be run without operator-supplied values:
// a throw-away fixture is really protected (root ownership + snapshot + epoch), a synthetic task
// records the retained boundary, and then the operator path is exercised exactly as documented:
//
//   AF_A1A_MODE=live  af-admin a1a sweep --confirm
//
// No timer is installed, no unit is enabled, no model is called and no notification is sent
// (notification mode stays off). It is a REHEARSAL: it proves the live path end to end on a
// disposable asset, and does not stand in for production acceptance on a real asset.
//
// Usage: node verification/u6-live-rehearsal.mjs [--keep]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { engageTaskHostBoundary, disengageTaskHostBoundary, recoverRetainedBoundary } from '../lib/host-boundary.mjs';
import { recordBoundaryAlert, listBoundaryAlerts, inspectBoundaryAlerts } from '../lib/boundary-alerts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(HERE, '..');
const keep = process.argv.includes('--keep');
const HOST_UID = typeof process.getuid === 'function' ? process.getuid() : null;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const root = mkdtempSync(join(tmpdir(), 'af-u6-live-'));
const canonicalDir = join(root, 'canonical');
const casDir = join(root, 'cas');
const tasksDir = join(root, 'tasks');
const auditRoot = join(root, 'audit');
const snapDir = join(root, 'snap');
const locksDir = join(root, 'locks');
const scopes = join(root, 'scopes');
const alertsFile = join(root, 'alerts.jsonl');
const allowlistFile = join(root, 'allowlist.json');
const queueFile = join(auditRoot, 'a1a', 'state.json');
const taskId = 'TASK-U6-LIVE';

for (const d of [canonicalDir, casDir, tasksDir, auditRoot, snapDir, locksDir, scopes]) mkdirSync(d, { recursive: true });
mkdirSync(join(canonicalDir, 'src'), { recursive: true });
writeFileSync(join(canonicalDir, 'src', 'value.mjs'), "export const value = 'live-rehearsal';\n");
writeFileSync(join(casDir, 'blob.txt'), 'blob\n');

const env = {
  ...process.env,
  AF_CGROUP_BASE: scopes,
  AF_BOUNDARY_SNAPSHOT_DIR: snapDir,
  AF_ASSET_LOCK_DIR: locksDir,
  AF_BOUNDARY_ALERTS_FILE: alertsFile,
  AF_BOUNDARY_AUDIT_DIR: auditRoot,
  AF_PROTECTION_EPOCH_DIR: join(auditRoot, 'epochs'),
  AF_TASKS_DIR: tasksDir,
  AF_A1A_ALLOWLIST_FILE: allowlistFile,
  AF_A1A_QUEUE_FILE: queueFile,
  AF_A1A_MODE: 'live',
  AF_A1A_MAX_ATTEMPTS: '3',
  AF_A1A_RETRY_BASE_MS: '60000',
  AF_BOUNDARY_NOTIFY_MODE: 'off', // no outbound notification, by design
};
Object.assign(process.env, env);

console.log('U6 live rehearsal (disposable asset; no timer, no unit, no model, no notification)\n');

try {
  // ---- really protect the fixture (root ownership) --------------------------
  engageTaskHostBoundary({ canonicalDir, casDir });
  check('fixture is really protected (root-owned)', statSync(canonicalDir).uid === 0, `uid=${statSync(canonicalDir).uid}`);

  // ---- the retained boundary the scheduler must recover --------------------
  recordBoundaryAlert({ canonicalDir, casDir, taskId, reason: 'scope-anomaly (rehearsal)' });
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify({
    task_id: taskId,
    state: 'COMPLETED',
    state_version: 7,
    fixture_dir: canonicalDir,
    trusted_import: {
      enabled: true,
      cas_dir: casDir,
      boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
      boundary_retained_reason: 'scope-anomaly (rehearsal)',
      author_completed: true,
      author_termination_evidence: { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' },
    },
  }, null, 2));
  writeFileSync(allowlistFile, JSON.stringify({
    schema: 'af-a1a-allowlist-v1',
    assets: [{ canonical_dir: canonicalDir, cas_dir: casDir, task_id: taskId, max_attempts: 3 }],
  }, null, 2));
  check('the retention alert is open before the sweep', listBoundaryAlerts({ file: alertsFile }).length === 1);

  // ---- the documented operator path: one manual live sweep -----------------
  const run = spawnSync(process.execPath, [join(ROOT_DIR, 'af-admin.mjs'), 'a1a', 'sweep', '--confirm', '--json'], {
    env,
    encoding: 'utf8',
  });
  const stdout = run.stdout ?? '';
  let payload = null;
  try { payload = JSON.parse(stdout); } catch { /* reported below */ }
  const result = payload?.results?.[0] ?? null;

  check('the live sweep exits 0', run.status === 0, `exit=${run.status} stderr=${(run.stderr ?? '').slice(0, 200)}`);
  check('the asset was ATTEMPTED (not skipped/refused)', result?.decision === 'ATTEMPTED', `decision=${result?.decision} reason=${result?.reason_code ?? result?.reason ?? ''}`);
  check('the recovery reports DISENGAGED and delivered', result?.outcome === 'DISENGAGED' && result?.delivered === true, `outcome=${result?.outcome} delivered=${result?.delivered}`);

  // ---- ordered audit chain, persistence included (H3/H4) -------------------
  const phases = readdirSync(auditRoot)
    .filter((n) => /^recovery-.*-(intent|mutation-started|result|persisted|alert-closed)\.json$/.test(n))
    .map((n) => JSON.parse(readFileSync(join(auditRoot, n), 'utf8')))
    .sort((a, b) => a.phase_seq - b.phase_seq);
  check('the audit chain is intent(1) -> mutation-started(2) -> result(3) -> persisted(4) -> alert-closed(5)',
    JSON.stringify(phases.map((p) => p.phase_seq)) === '[1,2,3,4,5]',
    JSON.stringify(phases.map((p) => `${p.phase}:${p.phase_seq}`)));

  // ---- the real-world effects ---------------------------------------------
  check('ownership is restored to the host user', statSync(canonicalDir).uid === HOST_UID, `uid=${statSync(canonicalDir).uid}`);
  check('the alert is closed by the recovery', inspectBoundaryAlerts({ file: alertsFile, includeResolved: true }).alerts[0]?.open === false);
  const task = JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf8'));
  check('the task record shows the boundary DISENGAGED (persist hook ran)', task.trusted_import.boundary_state === 'DISENGAGED', `boundary_state=${task.trusted_import.boundary_state}`);

  const state = JSON.parse(readFileSync(queueFile, 'utf8'));
  const record = Object.values(state.assets)[0];
  check('the scheduler state records COMPLETE for this epoch', record?.phase === 'COMPLETE', `phase=${record?.phase} attempts=${record?.attempts}`);

  // ---- no residue ---------------------------------------------------------
  const lockFiles = readdirSync(locksDir).filter((n) => n.startsWith('asset-'));
  check('no asset lock files are left behind', lockFiles.length === 0, `locks=${lockFiles.length}`);
  check('no registry lock is left behind', !existsSync(join(locksDir, 'registry.lock')));
} catch (err) {
  check('the rehearsal completed without an unexpected error', false, err.message);
} finally {
  try { recoverRetainedBoundary({ canonicalDir, casDir, justification: 'u6 live rehearsal cleanup', auditDir: auditRoot }); } catch { /* fall through */ }
  try { for (const n of readdirSync(locksDir)) rmSync(join(locksDir, n), { force: true }); } catch { /* best effort */ }
  try { disengageTaskHostBoundary({ canonicalDir, casDir, force: true }); } catch { /* best effort */ }
  if (!keep) rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(', ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
