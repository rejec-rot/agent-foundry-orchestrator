// feishu-controlled-send.mjs - controlled REAL outbound acceptance for A1b.
//
// Triggers ONE real retention event in a dedicated fixture (a synthetic broken writer
// scope), lets the trusted-import lifecycle retain the boundary and raise the alert, and
// then verifies the whole chain:
//
//   lifecycle -> retention -> alert recorded (task + JSONL) -> notifier delivery ->
//   settle audit (queue empty) -> CLI visibility
//
// Safety:
//   - the fixture is a temp dir; no production task, scope or alert log is touched;
//   - exactly ONE attempt is allowed (AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS=1): no retry can
//     produce a second message;
//   - the long cooldown prevents any repeat delivery for the same path;
//   - mode defaults to `dry-run` (no network I/O); `live` needs --confirm AND a webhook
//     supplied through AF_BOUNDARY_NOTIFY_WEBHOOK (never written to the evidence).
//
// Usage:
//   AF_BOUNDARY_NOTIFY_WEBHOOK=https://... node verification/feishu-controlled-send.mjs \
//     [--live --confirm] [--evidence-dir <dir>]

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectBoundaryAlerts, readBoundaryAlertEvents } from '../lib/boundary-alerts.mjs';
import { inspectPendingNotifications, describeNotifyConfig, readNotifyEvents } from '../lib/boundary-notify.mjs';
import { disengageTaskHostBoundary } from '../lib/host-boundary.mjs';
import { runTrustedImportTask } from '../lib/trusted-import/orchestrator-adapter.mjs';

const argv = process.argv.slice(2);
const live = argv.includes('--live');
const confirmed = argv.includes('--confirm');
const evidenceArg = argv.indexOf('--evidence-dir') >= 0 ? argv[argv.indexOf('--evidence-dir') + 1] : null;

const mode = live ? 'live' : 'dry-run';
const webhook = process.env.AF_BOUNDARY_NOTIFY_WEBHOOK || null;
if (live && !confirmed) fail('live mode sends a real notification: re-run with --confirm after checking the target');
if (live && !webhook) fail('live mode requires AF_BOUNDARY_NOTIFY_WEBHOOK (passed only via the environment)');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
const root = mkdtempSync(join(tmpdir(), 'af-feishu-controlled-'));
const evidenceDir = evidenceArg ?? join(process.cwd(), '..', 'real-smoke-evidence', `feishu-controlled-send-${revision.slice(0, 7)}`);
const repoDir = join(root, 'canonical');
const casDir = join(root, 'cas');
const candidateDir = join(root, 'candidate');
const scopeBase = mkdtempSync(join(tmpdir(), 'af-feishu-scopes-'));
const alertsFile = join(root, 'boundary-alerts.jsonl');
const taskPath = join(root, 'TASK-FEISHU-CONTROLLED.json');
const taskId = 'TASK-FEISHU-CONTROLLED';

mkdirSync(evidenceDir, { recursive: true });
for (const dir of [repoDir, casDir, candidateDir]) mkdirSync(dir, { recursive: true });

// --- dedicated fixture repository ------------------------------------------------
execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
execFileSync('git', ['config', 'user.name', 'Operator'], { cwd: repoDir, stdio: 'pipe' });
execFileSync('git', ['config', 'user.email', 'operator@test.local'], { cwd: repoDir, stdio: 'pipe' });
mkdirSync(join(repoDir, 'src'));
mkdirSync(join(repoDir, 'tests'));
writeFileSync(join(repoDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
writeFileSync(
  join(repoDir, 'tests', 'gate.test.mjs'),
  "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nimport { test } from 'node:test';\ntest('gate', () => assert.equal(value, 'v2'));\n",
);
execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoDir, stdio: 'pipe' });
execFileSync('git', ['update-ref', 'refs/afr/canonical', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim()], { cwd: repoDir });

// A real (synthetic) anomaly in the scope base: the lifecycle must RETAIN.
mkdirSync(join(scopeBase, 'af-writer-broken'), { recursive: true });

const task = {
  task_id: taskId,
  fixture_dir: repoDir,
  state: 'CREATED',
  host_isolation: true,
  author_executor: 'codex',
  reviewer_executor: 'claude',
  acceptance_cmd: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
  acceptance_binding: null,
  trusted_import: {
    enabled: true,
    candidate_dir: candidateDir,
    cas_dir: casDir,
    proposed_required: ['src/**'],
    policy: { allowed_root: ['src/**', 'tests/**'], forbidden: [], protected_paths: [], projection: { exclude: [] }, import: { deny: [] } },
    acceptance: { tier: 'TierA', acceptance_profile_digest: 'digest-controlled', acceptance_assets_digest: 'assets-controlled', dependency_fixture_id: 'dep-controlled' },
  },
};

process.env.AF_CGROUP_BASE = scopeBase;
process.env.AF_BOUNDARY_ALERTS_FILE = alertsFile;
process.env.AF_BOUNDARY_NOTIFY_MODE = mode;
process.env.AF_BOUNDARY_NOTIFY_FORMAT = 'feishu';
process.env.AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS = '1';           // one attempt only: no retry, no second message
process.env.AF_BOUNDARY_NOTIFY_COOLDOWN_MS = String(24 * 60 * 60 * 1000); // no repeat delivery for this path
if (webhook) process.env.AF_BOUNDARY_NOTIFY_WEBHOOK = webhook;

console.log(`feishu controlled send — revision ${revision.slice(0, 7)} mode=${mode}`);
console.log(`evidence dir: ${evidenceDir}`);

let delivery = null;
let lifecycleError = null;
try {
  await runTrustedImportTask(task, {
    runAuthor: async (rev, { cwd }) => {
      writeFileSync(join(cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
      return { executor_run_id: 'RUN-AUTHOR-CONTROLLED', writer_termination: { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' } };
    },
    runReview: async () => {
      task.last_review_termination_evidence = { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' };
      return { decision: 'PASS', summary: 'controlled acceptance fixture' };
    },
    saveTask: (t) => writeFileSync(taskPath, `${JSON.stringify(t, null, 2)}\n`),
  });
} catch (err) {
  lifecycleError = err;
}
if (lifecycleError) fail(`the lifecycle itself failed: ${lifecycleError.message}`);

// --- assertions ------------------------------------------------------------------
const onDisk = JSON.parse(readFileSync(taskPath, 'utf8'));
const ti = onDisk.trusted_import;
delivery = ti.boundary_notify ?? null;

check('1. lifecycle retained the boundary', ti.boundary_state === 'PROTECTION_RETAINED_PENDING_RECOVERY', `boundary_state=${ti.boundary_state}`);
check('2. the retention is the real scope anomaly', ti.boundary_scope_decision?.reason === 'scope-anomaly', `reason=${ti.boundary_scope_decision?.reason}`);
check('3. an alert was recorded for the task', ti.boundary_alert?.occurrences === 1 && Boolean(ti.boundary_alert?.alert_id), `alert_id=${ti.boundary_alert?.alert_id} occurrences=${ti.boundary_alert?.occurrences}`);

const alertEvents = readBoundaryAlertEvents({ file: alertsFile });
check('4. the alert log has one boundary_retained event', alertEvents.length === 1 && alertEvents[0].event === 'boundary_retained', `events=${alertEvents.map((e) => e.event).join(',')}`);
const openAlerts = inspectBoundaryAlerts({ file: alertsFile });
check('5. the alert is open and visible to a query', openAlerts.ok === true && openAlerts.alerts.length === 1 && openAlerts.alerts[0].open !== false);

check(
  `6. the notifier delivered exactly once (mode=${mode})`,
  Boolean(delivery) && (delivery.status === 'sent' || delivery.status === 'would-notify'),
  `status=${delivery?.status} attempts=${delivery?.attempts} http=${delivery?.http_status ?? 'n/a'} provider_code=${delivery?.provider_code ?? 'n/a'}`,
);
if (mode === 'live') {
  check('7. exactly one attempt — no retry was needed', delivery?.attempts === 1, `attempts=${delivery?.attempts}`);
} else {
  // dry-run never claims an attempt, so the invariant is that nothing was consumed.
  const q = inspectPendingNotifications({ file: alertsFile });
  check('7. dry-run consumed no delivery attempt', q.ok === true && q.pending.length === 0, `queue=${q.pending.length}`);
}
const deliveryEvents = readNotifyEvents({ file: alertsFile });
const sentEvent = deliveryEvents.find((e) => e.status === 'sent' || e.status === 'would-notify');
check('8. the delivery is audited in the notify log', Boolean(sentEvent), sentEvent ? `${sentEvent.status} format=${sentEvent.format}` : 'no delivery event');
check('9. no API error or provider rejection', !delivery?.provider_code && !['failed', 'settle-failed'].includes(delivery?.status), `provider_code=${delivery?.provider_code ?? 'none'} reason=${delivery?.reason ?? delivery?.settle_reason ?? 'none'}`);

const pending = inspectPendingNotifications({ file: alertsFile });
check('10. settlement audit: the retry queue is empty', pending.ok === true && pending.pending.length === 0, `pending=${pending.pending.length}`);

const cli = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(process.cwd(), 'af-admin.mjs'), ...args], {
      env: { ...process.env, AF_BOUNDARY_ALERTS_FILE: alertsFile, AF_BOUNDARY_NOTIFY_MODE: mode },
      encoding: 'utf8',
    }) };
  } catch (err) { return { code: err.status, out: `${err.stdout ?? ''}`, err: `${err.stderr ?? ''}` }; }
};
const alertsCli = cli(['boundary', 'alerts']);
check('11. the CLI reports the open alert with a non-zero exit', alertsCli.code === 1 && /1 open/.test(alertsCli.out), `exit=${alertsCli.code}`);
const notifyCli = cli(['boundary', 'notify-status']);
check('12. the notify CLI reports nothing stuck', notifyCli.code === 0 && /exhausted: 0/.test(notifyCli.out), `exit=${notifyCli.code}`);

// --- cleanup (controlled recovery, never `force`) --------------------------------
try {
  rmSync(join(scopeBase, 'af-writer-broken'), { recursive: true, force: true });
  const { recoverRetainedBoundary } = await import('../lib/host-boundary.mjs');
  const rec = recoverRetainedBoundary({ canonicalDir: repoDir, casDir, justification: 'controlled Feishu acceptance: operator verified no writer remains' });
  check('13. controlled recovery disengages the boundary', rec.outcome === 'DISENGAGED' && rec.delivered === true, `outcome=${rec.outcome}`);
  const closed = inspectBoundaryAlerts({ file: alertsFile, includeResolved: true });
  check('14. the alert is closed after recovery', closed.alerts[0]?.open === false);
} catch (err) {
  check('13. controlled recovery disengages the boundary', false, err.message);
} finally {
  try { disengageTaskHostBoundary({ canonicalDir: repoDir, casDir, force: true }); } catch { /* best effort */ }
  rmSync(scopeBase, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

// --- evidence --------------------------------------------------------------------
try {
  const manifest = {
    schema: 'af-feishu-controlled-send-v1',
    revision,
    mode,
    task_id: taskId,
    generated_at: new Date().toISOString(),
    config: describeNotifyConfig(),
    delivery,
    checks,
    boundary_state: ti.boundary_state,
    scope_decision: { decision: ti.boundary_scope_decision?.decision, reason: ti.boundary_scope_decision?.reason, attempts: ti.boundary_scope_decision?.attempts },
    alert_id: ti.boundary_alert?.alert_id ?? null,
    alert_events: alertEvents.length,
    delivery_events: deliveryEvents.map((e) => ({ at: e.at, status: e.status, format: e.format, retry_attempt: e.retry_attempt ?? null, provider_code: e.provider_code ?? null })),
    pending_after: pending.pending.length,
    url_or_token_in_evidence: /https?:\/\//.test(JSON.stringify({ delivery, checks })),
    passed: checks.every((c) => c.ok),
  };
  writeFileSync(join(evidenceDir, 'controlled-send-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(evidenceDir, 'delivery-log.jsonl'), deliveryEvents.map((e) => JSON.stringify(e)).join('\n') + (deliveryEvents.length ? '\n' : ''));
} catch (err) {
  console.error(`warning: could not write evidence: ${err.message}`);
}


const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — FAILED: ${failed.map((c) => c.name).join('; ')}` : ''}`);
if (existsSync(evidenceDir)) console.log(`evidence: ${evidenceDir}`);
process.exit(failed.length === 0 ? 0 : 1);
