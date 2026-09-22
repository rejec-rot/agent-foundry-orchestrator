// a1a-dry-run-eligible.mjs - U5 positive dry-run observation on a dedicated, REALLY protected asset.
//
// The U5 trial so far only exercised the refusal path (an unprotected fixture correctly failed 3.6
// snapshot validation). This harness closes that gap: it protects a throw-away fixture for real
// (root ownership + snapshot + protection epoch), synthesises the task record the guards require,
// and then runs the three read-only/dry-run entry points. A dry-run must reach `WOULD_RECOVER`
// while changing NOTHING: no permission, no task, no alert, no scheduler state.
//
// Cleanup is a real controlled recovery of the same fixture (its snapshot restores ownership).
//
// Usage: node verification/a1a-dry-run-eligible.mjs [--keep]

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { disengageTaskHostBoundary, engageTaskHostBoundary, recoverRetainedBoundary } from '../lib/host-boundary.mjs';
import { a1aConfig, readA1aEvents } from '../lib/a1a.mjs';

const keep = process.argv.includes('--keep');
const root = mkdtempSync(join(tmpdir(), 'af-a1a-eligible-'));
const canonicalDir = join(root, 'canonical');
const casDir = join(root, 'cas');
const tasksDir = join(root, 'tasks');
const auditRoot = join(root, 'audit');
const scopeBase = join(root, 'scopes');
const locksDir = join(root, 'asset-locks');
const alertsFile = join(root, 'boundary-alerts.jsonl');
const allowlistFile = join(root, 'allowlist.json');
const taskId = 'T-U5-ELIGIBLE';

for (const dir of [canonicalDir, casDir, tasksDir, auditRoot, scopeBase, locksDir]) mkdirSync(dir, { recursive: true });
mkdirSync(join(canonicalDir, 'src'), { recursive: true });
mkdirSync(join(canonicalDir, 'tests'), { recursive: true });
writeFileSync(join(canonicalDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
writeFileSync(join(canonicalDir, 'tests', 'gate.test.mjs'), "import { test } from 'node:test';\ntest('g', () => {});\n");
writeFileSync(join(casDir, 'objects.json'), '{}\n');

Object.assign(process.env, {
  AF_CGROUP_BASE: scopeBase,
  AF_TASKS_DIR: tasksDir,
  AF_BOUNDARY_AUDIT_DIR: auditRoot,
  AF_PROTECTION_EPOCH_DIR: join(auditRoot, 'epochs'),
  AF_ASSET_LOCK_DIR: locksDir,
  AF_BOUNDARY_ALERTS_FILE: alertsFile,
  AF_A1A_ALLOWLIST_FILE: allowlistFile,
  AF_A1A_MODE: 'dry-run',
  AF_A1A_QUEUE_FILE: join(auditRoot, 'a1a', 'state.json'),
});

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Metadata map used to prove the dry-run changed no ownership/mode. */
function metadataMap(dir) {
  const out = {};
  const walk = (current, rel) => {
    const stat = lstatSync(current);
    out[rel] = `${stat.uid}:${stat.gid}:${(stat.mode & 0o7777).toString(8)}`;
    if (stat.isDirectory()) for (const name of readdirSync(current).sort()) walk(join(current, name), rel === '' ? name : `${rel}/${name}`);
  };
  walk(dir, '');
  return out;
}

const cli = (args) => {
  try {
    const stdout = execFileSync(process.execPath, [join(process.cwd(), 'af-admin.mjs'), ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: `${err.stdout ?? ''}`, stderr: `${err.stderr ?? ''}` };
  }
};

let protectedOk = false;
try {
  // ---- 1. protect the fixture FOR REAL (ownership + snapshot + protection epoch) -------------
  const protection = engageTaskHostBoundary({ canonicalDir, casDir });
  protectedOk = lstatSync(canonicalDir).uid === 0;
  check('fixture is really protected (root-owned)', protectedOk, `uid=${lstatSync(canonicalDir).uid}`);
  check('engage recorded a protection epoch', Boolean(protection.epoch?.epoch_id), protection.epoch_error ?? protection.epoch?.epoch_id);

  // ---- 2. the task record and the alert the guards expect -----------------------------------
  writeFileSync(allowlistFile, `${JSON.stringify({
    schema: 'af-a1a-allowlist-v1',
    assets: [{ canonical_dir: canonicalDir, cas_dir: casDir, task_id: taskId, max_attempts: 3 }],
  }, null, 2)}\n`);
  writeFileSync(alertsFile, `${JSON.stringify({
    event: 'boundary_retained', alert_id: 'AF-U5-1', at: new Date().toISOString(), canonical_dir: canonicalDir, cas_dir: casDir,
    task_id: taskId, boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY', reason: 'scope-anomaly', occurrences: 1, severity: 'warning', threshold: 3,
  })}\n`);
  const taskPath = join(tasksDir, `${taskId}.json`);
  writeFileSync(taskPath, `${JSON.stringify({
    task_id: taskId, state: 'COMPLETED', state_version: 9, fixture_dir: canonicalDir,
    trusted_import: {
      cas_dir: casDir,
      boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
      boundary_retained_reason: 'scope-anomaly',
      boundary_alert: { alert_id: 'AF-U5-1', occurrences: 1 },
      author_completed: true,
      author_termination_evidence: { termination_confirmed: true, process_group_alive: false, scope_verified: true },
    },
  }, null, 2)}\n`);

  const before = { metadata: metadataMap(canonicalDir), task: readFileSync(taskPath, 'utf8'), alerts: readFileSync(alertsFile, 'utf8') };
  const stateFile = process.env.AF_A1A_QUEUE_FILE;

  // ---- 3. the three entry points ------------------------------------------------------------
  const status = cli(['a1a', 'status']);
  check('status exits 0', status.code === 0, status.stdout.trim().split('\n')[0]);
  const explain = cli(['a1a', 'explain', '--canonical', canonicalDir, '--cas', casDir]);
  const explainOut = `${explain.stdout}${explain.stderr}`;
  check('explain reports eligible (positive path)', /eligible\s*[:=]\s*true/i.test(explainOut) || /WOULD_RECOVER/.test(explainOut), explainOut.split('\n').find((l) => /eligible|first_failure/i.test(l)) ?? '');
  check('explain exits 0 when eligible', explain.code === 0, `exit=${explain.code}`);

  const sweep = cli(['a1a', 'sweep', '--json']);
  const sweepJson = (() => { try { return JSON.parse(sweep.stdout); } catch { return null; } })();
  const decision = sweepJson?.results?.[0]?.decision ?? null;
  check('dry-run sweep reaches WOULD_RECOVER', decision === 'WOULD_RECOVER', `decision=${decision} exit=${sweep.code}`);
  check('a dry-run sweep exits 0', sweep.code === 0, `exit=${sweep.code}`);

  // ---- 4. zero change ----------------------------------------------------------------------
  check('no permission/ownership change', JSON.stringify(metadataMap(canonicalDir)) === JSON.stringify(before.metadata));
  check('the fixture is still root-owned', lstatSync(canonicalDir).uid === 0);
  check('the task record is untouched (byte-identical)', readFileSync(taskPath, 'utf8') === before.task);
  check('the alert log is untouched (byte-identical)', readFileSync(alertsFile, 'utf8') === before.alerts);
  check('no scheduler state file was written', !existsSync(stateFile));
  // `readA1aEvents` takes the resolved config (it derives the audit directory), not a file path.
  const events = readA1aEvents(a1aConfig()).events;
  check('the would-recover audit event was recorded', events.some((event) => event.event === 'a1a_would_recover'), `${events.length} event(s)`);
  check('no asset lock file is left behind', readdirSync(locksDir).filter((name) => name.endsWith('.lock')).length === 0);
} finally {
  // ---- 5. cleanup: a real controlled recovery of the throw-away fixture --------------------
  if (protectedOk) {
    const recovery = recoverRetainedBoundary({
      canonicalDir,
      casDir,
      justification: 'U5 positive dry-run harness cleanup (throw-away fixture)',
      recoveredBy: 'verification-harness',
    });
    const released = existsSync(canonicalDir) && lstatSync(canonicalDir).uid !== 0;
    check('cleanup released the fixture (controlled recovery, no force)', released, `outcome=${recovery.outcome}`);
    check('cleanup recovery delivered a complete record', recovery.delivered === true, recovery.reason ?? '');
  } else {
    disengageTaskHostBoundary({ canonicalDir, casDir, force: true });
  }
  if (keep) console.log(`fixture kept at ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — FAILED: ${failed.map((c) => c.name).join('; ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
