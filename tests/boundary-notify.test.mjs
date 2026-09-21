// boundary-notify.test.mjs - A1b outbound notification: no egress without authorisation,
// dry-run fidelity, escalation + cooldown policy, and the live transport (local mock only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { recordBoundaryAlert } from '../lib/boundary-alerts.mjs';
import {
  notifyBoundaryAlert,
  readNotifyEvents,
  buildNotifyPayload,
  describeNotifyConfig,
  notifyLogFile,
} from '../lib/boundary-notify.mjs';
import { runTrustedImportTask } from '../lib/trusted-import/orchestrator-adapter.mjs';
import { disengageTaskHostBoundary } from '../lib/host-boundary.mjs';

const CLI = join(process.cwd(), 'af-admin.mjs');

/** Start a mock webhook on 127.0.0.1; records every request it receives. */
function startMockWebhook({ status = 200, hang = false } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (hang) return; // never respond: exercises the timeout path
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, requests, url: `http://127.0.0.1:${port}/hook`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const ENV_KEYS = [
  'AF_BOUNDARY_ALERTS_FILE', 'AF_BOUNDARY_NOTIFY_MODE', 'AF_BOUNDARY_NOTIFY_WEBHOOK',
  'AF_BOUNDARY_NOTIFY_COOLDOWN_MS', 'AF_BOUNDARY_NOTIFY_TIMEOUT_MS', 'AF_BOUNDARY_NOTIFY_INCLUDE_PATHS',
  'AF_BOUNDARY_NOTIFY_ON_RELEASE', 'AF_BOUNDARY_NOTIFY_TOKEN', 'AF_BOUNDARY_ALERT_ESCALATE_AFTER',
  'AF_BOUNDARY_NOTIFY_FORMAT', 'AF_BOUNDARY_NOTIFY_FEISHU_SECRET',
];

function withEnv(patch, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, patch);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function withEnvAsync(patch, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, patch);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const alertFor = (dir, occurrences, extra = {}) => ({
  canonical_dir: dir,
  cas_dir: null,
  task_id: 'T-NOTIFY',
  alert_id: 'A-1',
  occurrences,
  severity: occurrences >= 3 ? 'escalated' : 'warning',
  boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
  reason: 'scope-anomaly',
  ...extra,
});

test('A1b notify: mode=off sends nothing even with a webhook configured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-off-'));
  const file = join(root, 'alerts.jsonl');
  const mock = await startMockWebhook();
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'off', AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(res.status, 'disabled');
      assert.equal(describeNotifyConfig().webhook_configured, true, 'the webhook is configured but must not be used');
    });
    assert.equal(mock.requests.length, 0, 'no request may leave the host while notifications are off');
    assert.equal(readNotifyEvents({ file }).length, 0, 'off mode writes no delivery records');
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: dry-run records the exact payload and never performs network I/O', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-dry-'));
  const file = join(root, 'alerts.jsonl');
  const mock = await startMockWebhook();
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1), scopeDecision: { decision: 'RETAIN', reason: 'scope-anomaly', attempts: 1, anomalies: [{ class: 'broken-scope' }] } });
      assert.equal(res.status, 'would-notify');
    });
    assert.equal(mock.requests.length, 0, 'dry-run must not touch the network');
    const records = readNotifyEvents({ file });
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'would-notify');
    assert.equal(records[0].payload.schema, 'af-boundary-alert-v1');
    assert.equal(records[0].payload.scope_decision.reason, 'scope-anomaly');
    assert.deepEqual(records[0].payload.scope_decision.anomalies, ['broken-scope']);
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: policy is first retain + escalation, with cooldown dedupe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-policy-'));
  const file = join(root, 'alerts.jsonl');
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '60000' }, async () => {
      const first = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      const second = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 2) });
      const third = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 3) });
      const fourth = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 4) });
      assert.equal(first.status, 'would-notify', 'the first retain notifies');
      assert.equal(second.status, 'suppressed', 'a plain repeat is not an escalation');
      assert.equal(third.status, 'would-notify', 'the escalation notifies');
      assert.equal(fourth.status, 'suppressed', 'the escalated delivery is in cooldown');
      assert.equal(fourth.reason, 'cooldown');
      // Policy suppressions are decisions, not deliveries: only deliveries/cooldowns are logged.
      const statuses = readNotifyEvents({ file }).map((r) => r.status);
      assert.deepEqual(statuses, ['would-notify', 'would-notify', 'suppressed']);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: cooldown expiry allows a further escalation notice; release is opt-in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-cooldown-'));
  const file = join(root, 'alerts.jsonl');
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const a = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 3) });
      const b = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 4) });
      assert.equal(a.status, 'would-notify');
      assert.equal(b.status, 'would-notify', 'cooldown 0 must not suppress');
      const released = await notifyBoundaryAlert({ event: 'boundary_released', alert: alertFor(root, 0) });
      assert.equal(released.status, 'suppressed');
      assert.match(released.reason, /release notifications disabled/);
    });
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_ON_RELEASE: '1' }, async () => {
      const released = await notifyBoundaryAlert({ event: 'boundary_released', alert: alertFor(root, 0) });
      assert.equal(released.status, 'would-notify', 'release notices are opt-in');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: live transport posts the payload and records delivery/failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-live-'));
  const file = join(root, 'alerts.jsonl');
  const ok = await startMockWebhook({ status: 200 });
  const bad = await startMockWebhook({ status: 500 });
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_WEBHOOK: ok.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_TOKEN: 'secret-token-value' }, async () => {
      const sent = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(sent.status, 'sent');
      assert.equal(sent.http_status, 200);
    });
    assert.equal(ok.requests.length, 1, 'exactly one POST');
    assert.equal(ok.requests[0].method, 'POST');
    assert.equal(ok.requests[0].headers.authorization, 'Bearer secret-token-value');
    const posted = JSON.parse(ok.requests[0].body);
    assert.equal(posted.schema, 'af-boundary-alert-v1');
    assert.equal(posted.canonical_dir, root);

    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_WEBHOOK: bad.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const failed = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 3) });
      assert.equal(failed.status, 'failed');
      assert.equal(failed.http_status, 500);
    });

    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_WEBHOOK: 'http://127.0.0.1:9/unreachable', AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_TIMEOUT_MS: '200' }, async () => {
      const failed = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 5) });
      assert.equal(failed.status, 'failed', 'an unreachable target must be recorded, never thrown');
    });

    // The delivery log must not leak the target or the token.
    const raw = readFileSync(notifyLogFile(file), 'utf8');
    assert.doesNotMatch(raw, /secret-token-value/);
    assert.doesNotMatch(raw, /127\.0\.0\.1:\d+\/hook/);
  } finally {
    await ok.close();
    await bad.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: paths can be redacted in the outbound payload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-redact-'));
  const file = join(root, 'alerts.jsonl');
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_BOUNDARY_NOTIFY_INCLUDE_PATHS: '0' }, async () => {
      await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      // Redaction governs EGRESS (the payload), not the local audit record: the record
      // keeps the real path for the operator, the outbound body must not carry it.
      const records = readNotifyEvents({ file });
      assert.equal(records.length, 1);
      assert.equal(records[0].canonical_dir, root, 'the local audit record keeps the real path');
      assert.doesNotMatch(
        JSON.stringify(records[0].payload),
        new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'the outbound payload must not carry the host path when redaction is on',
      );
      const payload = buildNotifyPayload({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.match(payload.canonical_dir, /^sha256:/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: a retained lifecycle drives the notifier (dry-run, on disk)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-lifecycle-'));
  const repoDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const candidateDir = join(root, 'candidate');
  const tasksDir = join(root, 'tasks');
  const scopeBase = mkdtempSync(join(tmpdir(), 'af-notify-scopes-'));
  const file = join(root, 'alerts.jsonl');
  for (const d of [repoDir, casDir, candidateDir, tasksDir]) mkdirSync(d, { recursive: true });

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  mkdirSync(join(repoDir, 'src'));
  mkdirSync(join(repoDir, 'tests'));
  writeFileSync(join(repoDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
  writeFileSync(join(repoDir, 'tests', 'gate.test.mjs'), `import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nimport { test } from 'node:test';\ntest('gate', () => assert.equal(value, 'v2'));\n`);
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoDir, stdio: 'pipe' });
  const oid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/afr/canonical', oid], { cwd: repoDir });
  mkdirSync(join(scopeBase, 'af-writer-broken'), { recursive: true }); // real on-disk anomaly

  const taskId = 'TASK-NOTIFY-LIFECYCLE';
  const taskPath = join(tasksDir, `${taskId}.json`);
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
      acceptance: { tier: 'TierA', acceptance_profile_digest: 'd', acceptance_assets_digest: 'a', dependency_fixture_id: 'f' },
    },
  };

  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_CGROUP_BASE: scopeBase }, async () => {
      await runTrustedImportTask(task, {
        runAuthor: async (rev, { cwd }) => {
          writeFileSync(join(cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
          return { executor_run_id: 'RUN-A', writer_termination: { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' } };
        },
        runReview: async () => {
          task.last_review_termination_evidence = { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' };
          return { decision: 'PASS', summary: 'ok' };
        },
        saveTask: (t) => writeFileSync(taskPath, `${JSON.stringify(t, null, 2)}\n`),
      });
    });

    const onDisk = JSON.parse(readFileSync(taskPath, 'utf8'));
    assert.equal(onDisk.trusted_import.boundary_state, 'PROTECTION_RETAINED_PENDING_RECOVERY');
    assert.equal(onDisk.trusted_import.boundary_alert.occurrences, 1);
    assert.equal(onDisk.trusted_import.boundary_notify.status, 'would-notify', 'the lifecycle must drive the notifier');

    const deliveries = readNotifyEvents({ file });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, 'would-notify');
    assert.equal(deliveries[0].payload.task_id, taskId);
    assert.equal(deliveries[0].payload.scope_decision.reason, 'scope-anomaly');

    // CLI visibility of the notifier state, in dry-run.
    const out = execFileSync(process.execPath, [CLI, 'boundary', 'notify-status'], {
      env: {
        ...process.env,
        AF_BOUNDARY_ALERTS_FILE: file,
        AF_BOUNDARY_NOTIFY_MODE: 'dry-run',
        AF_BOUNDARY_NOTIFY_WEBHOOK: 'https://example.invalid/hook-secret-path-token',
      },
      encoding: 'utf8',
    });
    assert.match(out, /mode: dry-run/);
    assert.match(out, /webhook_configured: true/);
    assert.match(out, /webhook_host: example\.invalid/, 'only the host may be shown');
    assert.doesNotMatch(out, /hook-secret-path-token/, 'the full target URL must never be printed');
    assert.match(out, /delivery records: 1/);
  } finally {
    disengageTaskHostBoundary({ canonicalDir: repoDir, casDir, force: true });
    rmSync(scopeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: feishu custom-bot schema is rendered and posted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-feishu-'));
  const file = join(root, 'alerts.jsonl');
  const mock = await startMockWebhook();
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0',
    }, async () => {
      const res = await notifyBoundaryAlert({
        event: 'boundary_retained',
        alert: alertFor(root, 3),
        scopeDecision: { decision: 'RETAIN', reason: 'rescan-budget-exhausted', attempts: 4, anomalies: [{ class: 'broken-scope' }] },
      });
      assert.equal(res.status, 'sent');
    });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].headers['content-type'], 'application/json; charset=utf-8');
    const body = JSON.parse(mock.requests[0].body);
    assert.equal(body.msg_type, 'text');
    assert.equal(typeof body.content.text, 'string');
    assert.match(body.content.text, /Agent Foundry/);
    assert.match(body.content.text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(body.content.text, /rescan-budget-exhausted/);
    assert.match(body.content.text, /attempts=4/);
    assert.match(body.content.text, /broken-scope/);
    assert.equal(body.timestamp, undefined, 'no signature fields when no secret is configured');
    assert.equal(body.sign, undefined);
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: feishu signature is emitted and independently verifiable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-feishu-sign-'));
  const file = join(root, 'alerts.jsonl');
  const mock = await startMockWebhook();
  const secret = 'unit-test-secret';
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_FEISHU_SECRET: secret,
    }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(res.status, 'sent');
    });
    const body = JSON.parse(mock.requests[0].body);
    assert.match(body.timestamp, /^\d+$/, 'the timestamp must be seconds, as a string');
    const expected = createHmac('sha256', `${body.timestamp}\n${secret}`).update('').digest('base64');
    assert.equal(body.sign, expected, 'sign = base64(hmac_sha256(key = timestamp\\nsecret, data = ""))');
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: feishu text honours path redaction in dry-run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-feishu-redact-'));
  const file = join(root, 'alerts.jsonl');
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_INCLUDE_PATHS: '0',
    }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(res.status, 'would-notify');
    });
    const record = readNotifyEvents({ file })[0];
    assert.equal(record.format, 'feishu');
    assert.doesNotMatch(record.request_body, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the outbound text must not carry the host path');
    assert.match(record.request_body, /sha256:[0-9a-f]{16}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
