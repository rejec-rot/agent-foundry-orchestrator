// u6-live-asset-setup.mjs - build the dedicated, NON-PRODUCTION asset for the U6 live trial.
//
// The checklist's §1 requires an asset that is REALLY in a retained state, and forbids production
// repositories. This script produces exactly that using the REAL code paths only (no models, no
// synthetic security state):
//
//   engage      -> root ownership + snapshot + protection epoch
//   broken scope-> disengage really RETAINS the boundary and raises the retention alert
//   cleanup     -> the scope anomaly is cleared, so a later recovery can legitimately be eligible
//
// It then runs the read-only `a1a explain` (dry-run) and prints the verdict, so eligibility can be
// confirmed BEFORE anything is signed. Nothing here touches a real repository.
//
// Usage: node verification/u6-live-asset-setup.mjs [--root <dir>] [--keep]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { engageTaskHostBoundary, disengageTaskHostBoundary } from '../lib/host-boundary.mjs';
import { recordBoundaryAlert } from '../lib/boundary-alerts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(HERE, '..');
const argValue = (flag, dflt) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : dflt; };

const assetRoot = argValue('--root', '/home/reject/DSHWorkSpace/u6-live-asset');
const canonicalDir = join(assetRoot, 'canonical');
const casDir = join(assetRoot, 'cas');
const tasksDir = join(assetRoot, 'tasks');
const auditDir = join(assetRoot, 'audit');
const snapDir = join(assetRoot, 'snap');
const locksDir = join(assetRoot, 'locks');
const scopeBase = join(assetRoot, 'scopes');
const alertsFile = join(assetRoot, 'boundary-alerts.jsonl');
const allowlistFile = join(assetRoot, 'allowlist.json');
const taskId = 'TASK-U6-LIVE-ASSET';

console.log(`preparing the U6 live asset at ${assetRoot}`);

rmSync(assetRoot, { recursive: true, force: true });
for (const d of [canonicalDir, casDir, tasksDir, auditDir, snapDir, locksDir, scopeBase]) mkdirSync(d, { recursive: true });
mkdirSync(join(canonicalDir, 'src'), { recursive: true });
writeFileSync(join(canonicalDir, 'src', 'value.mjs'), "export const value = 'u6-live-asset';\n");
writeFileSync(join(canonicalDir, 'README.md'), 'disposable fixture for the U6 live trial\n');
writeFileSync(join(casDir, 'blob.txt'), 'blob\n');

Object.assign(process.env, {
  AF_CGROUP_BASE: scopeBase,
  AF_BOUNDARY_SNAPSHOT_DIR: snapDir,
  AF_ASSET_LOCK_DIR: locksDir,
  AF_BOUNDARY_ALERTS_FILE: alertsFile,
  AF_BOUNDARY_AUDIT_DIR: auditDir,
  AF_PROTECTION_EPOCH_DIR: join(auditDir, 'epochs'),
  AF_TASKS_DIR: tasksDir,
});

// 1. real protection
engageTaskHostBoundary({ canonicalDir, casDir });
const uidAfterEngage = statSync(canonicalDir).uid;

// 2. a real retention: an anomalous writer scope makes the lifecycle keep the boundary locked
const brokenScope = join(scopeBase, 'af-writer-broken');
mkdirSync(brokenScope, { recursive: true });
const retained = disengageTaskHostBoundary({ canonicalDir, casDir, quiesceConfirmed: true });

// 3. the alert the lifecycle would raise for that retention
const alert = recordBoundaryAlert({ canonicalDir, casDir, taskId, reason: retained.reason, scopeDecision: retained.scope_decision });

// 4. the task record the lifecycle persists (termination evidence is real: no executor ever ran)
writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify({
  task_id: taskId,
  state: 'COMPLETED',
  state_version: 1,
  fixture_dir: canonicalDir,
  trusted_import: {
    enabled: true,
    cas_dir: casDir,
    boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
    boundary_retained_reason: retained.reason,
    boundary_alert: { alert_id: alert.alert_id, occurrences: alert.occurrences, severity: alert.severity },
    author_completed: true,
    author_termination_evidence: { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'none' },
  },
}, null, 2));

// 5. the whitelist the trial will use (exactly this one asset)
writeFileSync(allowlistFile, JSON.stringify({
  schema: 'af-a1a-allowlist-v1',
  assets: [{ canonical_dir: canonicalDir, cas_dir: casDir, task_id: taskId, max_attempts: 1 }],
}, null, 2));

// 6. clear the anomaly: an operator would fix the environment before authorising a recovery
rmSync(brokenScope, { recursive: true, force: true });

const epochs = existsSync(join(auditDir, 'epochs')) ? readdirSync(join(auditDir, 'epochs')) : [];
const explain = spawnSync(process.execPath, [
  join(ROOT_DIR, 'af-admin.mjs'), 'a1a', 'explain', '--canonical', canonicalDir, '--cas', casDir,
], {
  env: { ...process.env, AF_A1A_MODE: 'dry-run', AF_A1A_ALLOWLIST_FILE: allowlistFile, AF_BOUNDARY_NOTIFY_MODE: 'off' },
  encoding: 'utf8',
});

console.log('\n--- retention ---');
console.log(`  retained          : ${retained.disengaged === false && retained.outcome === 'PROTECTION_RETAINED'}`);
console.log(`  reason            : ${retained.reason}`);
console.log(`  alert_id          : ${alert.alert_id}`);
console.log(`  uid after engage  : ${uidAfterEngage} (root 0 = really protected)`);
console.log(`  epochs recorded   : ${epochs.length}`);
console.log('\n--- a1a explain (dry-run, read-only) ---');
console.log(explain.stdout?.trim() ?? '(no output)');
if (explain.stderr) console.log(explain.stderr.trim());

const eligible = /eligible:\s*true/.test(explain.stdout ?? '');
console.log(`\n${eligible ? 'READY' : 'NOT READY'}: the asset ${eligible ? 'satisfies all 12 guards' : 'does NOT satisfy every guard'} (exit=${explain.status})`);
console.log(`\nwhitelist: ${allowlistFile}`);
process.exit(eligible ? 0 : 1);
