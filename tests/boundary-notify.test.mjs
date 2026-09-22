// boundary-notify.test.mjs - A1b outbound notification: no egress without authorisation,
// dry-run fidelity, escalation + cooldown policy, and the live transport (local mock only).

import './helpers/asset-lock-root.mjs'; // keeps asset locks out of the repository runtime
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { recordBoundaryAlert, readBoundaryAlertEvents } from '../lib/boundary-alerts.mjs';
import {
  notifyBoundaryAlert,
  readNotifyEvents,
  buildNotifyPayload,
  describeNotifyConfig,
  notifyLogFile,
  listPendingNotifications,
  inspectPendingNotifications,
  buildNotifyRequest,
  flushPendingNotifications,
  notifyBackoffMs,
} from '../lib/boundary-notify.mjs';
import { runTrustedImportTask } from '../lib/trusted-import/orchestrator-adapter.mjs';
import { disengageTaskHostBoundary } from '../lib/host-boundary.mjs';

const CLI = join(process.cwd(), 'af-admin.mjs');

/** Start a mock webhook on 127.0.0.1; records every request it receives. */
function startMockWebhook({ status = 200, hang = false, reply = '{"ok":true}' } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (hang) return; // never respond: exercises the timeout path
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(reply);
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
  'AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS', 'AF_BOUNDARY_NOTIFY_RETRY_BASE_MS', 'AF_BOUNDARY_NOTIFY_RETRY_MAX_MS',
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
  alert_id: `A-${occurrences}`,
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
  const mock = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
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
  const mock = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
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

test('A1b notify: a 2xx answer with a non-zero provider code counts as failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-provider-'));
  const file = join(root, 'alerts.jsonl');
  // Feishu/DingTalk answer HTTP 200 even when the bot rejects the message.
  const rejecting = await startMockWebhook({ status: 200, reply: '{"code":19002,"msg":"sign match fail"}' });
  const accepting = await startMockWebhook({ status: 200, reply: '{"code":0,"msg":"success"}' });
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu', AF_BOUNDARY_NOTIFY_WEBHOOK: rejecting.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(res.status, 'failed', 'HTTP 200 + code!=0 must not be reported as sent');
      assert.equal(res.provider_code, 19002);
      assert.match(res.reason, /sign match fail/);
    });
    const record = readNotifyEvents({ file })[0];
    assert.equal(record.status, 'failed');
    assert.equal(record.provider_code, 19002);

    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu', AF_BOUNDARY_NOTIFY_WEBHOOK: accepting.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 3) });
      assert.equal(res.status, 'sent');
      assert.equal(res.provider_code, null);
    });
  } finally {
    await rejecting.close();
    await accepting.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: provider errors echoing the target or token are sanitised before storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-echo-'));
  const file = join(root, 'alerts.jsonl');
  const token = 'tk_super_secret_token_value';
  const leaking = await startMockWebhook({
    status: 200,
    reply: JSON.stringify({ code: 19002, msg: `bad token ${token} while calling https://open.feishu.cn/open-apis/bot/v2/hook/SECRET-PATH` }),
  });
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: leaking.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_TOKEN: token,
    }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(res.status, 'failed');
      assert.doesNotMatch(res.reason, new RegExp(token), 'the token must not survive in the returned reason');
      assert.doesNotMatch(res.reason, /SECRET-PATH/, 'the echoed URL path must not survive');
    });
    const raw = readFileSync(notifyLogFile(file), 'utf8');
    assert.doesNotMatch(raw, new RegExp(token), 'the token must never reach the delivery log');
    assert.doesNotMatch(raw, /SECRET-PATH/, 'the echoed URL must never reach the delivery log');
    assert.doesNotMatch(raw, new RegExp(leaking.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the webhook URL must never reach the delivery log');
  } finally {
    await leaking.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: a transport error containing the URL is sanitised too', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-throw-'));
  const file = join(root, 'alerts.jsonl');
  const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/THROW-SECRET';
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu', AF_BOUNDARY_NOTIFY_WEBHOOK: url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const res = await notifyBoundaryAlert({
        event: 'boundary_retained',
        alert: alertFor(root, 1),
        fetchImpl: async () => { throw new Error(`request to ${url} failed`); },
      });
      assert.equal(res.status, 'failed');
      assert.doesNotMatch(res.reason, /THROW-SECRET/);
    });
    const raw = readFileSync(notifyLogFile(file), 'utf8');
    assert.doesNotMatch(raw, /THROW-SECRET/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: a path inside the free-text reason is redacted when paths are off', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-reason-'));
  const file = join(root, 'alerts.jsonl');
  const secretRepo = '/home/reject/very-secret-repo';
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_BOUNDARY_NOTIFY_INCLUDE_PATHS: '0' }, async () => {
      await notifyBoundaryAlert({
        event: 'boundary_retained',
        alert: alertFor(root, 1, { reason: `scope anomaly detected at ${secretRepo}/src` }),
      });
    });
    const record = readNotifyEvents({ file })[0];
    // Redaction governs EGRESS: the outbound payload and body must be path-free, while the
    // local record keeps the real path so an operator can act on it.
    assert.equal(record.canonical_dir, root, 'the local audit record keeps the real path');
    const outbound = `${JSON.stringify(record.payload)}${record.request_body ?? ''}`;
    assert.doesNotMatch(outbound, /very-secret-repo/, 'a path quoted in the reason must not leave the host');
    assert.doesNotMatch(outbound, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the canonical path must not leave the host');
    assert.ok(JSON.stringify(record.payload.reason).includes('sha256:'), 'the path is replaced by its digest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: an unverifiable 200 response is never recorded as sent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-unverifiable-'));
  const file = join(root, 'alerts.jsonl');
  const notJson = await startMockWebhook({ status: 200, reply: 'OK' });
  const noCode = await startMockWebhook({ status: 200, reply: '{"ok":true}' });
  const plain = await startMockWebhook({ status: 200, reply: 'OK' });
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu', AF_BOUNDARY_NOTIFY_WEBHOOK: notJson.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(res.status, 'failed', 'a non-JSON body cannot confirm a Feishu delivery');
      assert.match(res.reason, /cannot be confirmed/);
    });
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu', AF_BOUNDARY_NOTIFY_WEBHOOK: noCode.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 3) });
      assert.equal(res.status, 'failed', 'a body without a provider status code cannot confirm delivery');
    });
    // A generic endpoint has no provider code to check: HTTP 200 remains sufficient.
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'generic', AF_BOUNDARY_NOTIFY_WEBHOOK: plain.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 5) });
      assert.equal(res.status, 'sent');
    });
    const statuses = readNotifyEvents({ file }).map((r) => r.status);
    assert.ok(!statuses.slice(0, 2).includes('sent'), `unverifiable responses must not be sent: ${statuses.join(',')}`);
  } finally {
    await notJson.close();
    await noCode.close();
    await plain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: a dry-run never consumes the live cooldown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-modekey-'));
  const file = join(root, 'alerts.jsonl');
  const mock = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu', AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '600000' }, async () => {
      const dry = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(dry.status, 'would-notify');
    });
    assert.equal(mock.requests.length, 0);
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu', AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '600000' }, async () => {
      const live = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(live.status, 'sent', 'the live delivery must not be suppressed by the dry-run record');
    });
    assert.equal(mock.requests.length, 1, 'exactly one real delivery happened');
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b notify: concurrent calls for one event claim the delivery exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-concurrent-'));
  const file = join(root, 'alerts.jsonl');
  // Slow responder so both callers overlap while the claim is held.
  const slow = await new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({ body });
        setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"code":0,"msg":"success"}'); }, 250);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise((r) => server.close(r)) }));
  });
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu', AF_BOUNDARY_NOTIFY_WEBHOOK: slow.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const [a, b] = await Promise.all([
        notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) }),
        notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, ['sent', 'suppressed'], `one caller must be suppressed, got ${statuses.join(',')}`);
      const suppressed = [a, b].find((r) => r.status === 'suppressed');
      assert.equal(suppressed.reason, 'in-flight-claim', 'a live claim by another caller suppresses this one');
    });
    assert.equal(slow.requests.length, 1, 'exactly one HTTP request may be made');
  } finally {
    await slow.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b retry: a failed live delivery is queued with bounded backoff and no secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-retry-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await startMockWebhook({ status: 500, reply: '{"code":19002,"msg":"boom"}' });
  const token = 'tk_retry_secret';
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_TOKEN: token,
      AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '3', AF_BOUNDARY_NOTIFY_RETRY_BASE_MS: '5000',
    }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(res.status, 'failed');
    });

    const pending = listPendingNotifications({ file });
    assert.equal(pending.length, 1, 'the failed delivery must be queued for retry');
    assert.equal(pending[0].state, 'pending');
    assert.equal(pending[0].attempts, 1);
    assert.equal(pending[0].max_attempts, 3);
    assert.ok(Date.parse(pending[0].next_attempt_at) > Date.now(), 'the retry must be scheduled in the future');
    // The queue stores the UNSIGNED payload: each attempt rebuilds the request so a
    // rotated secret or a stale timestamp can never be replayed.
    assert.equal(pending[0].request_body, undefined, 'the signed body must not be persisted');
    assert.equal(pending[0].payload.schema, 'af-boundary-alert-v1');
    assert.equal(pending[0].event, 'boundary_retained');
    const rebuilt = JSON.parse((await import('../lib/boundary-notify.mjs')).buildNotifyRequest({ event: 'boundary_retained', payload: pending[0].payload, format: pending[0].format }).body);
    assert.equal(rebuilt.msg_type, 'text');
    const rawPending = readFileSync(`${file}.notify-pending.json`, 'utf8');
    assert.doesNotMatch(rawPending, new RegExp(token));
    assert.doesNotMatch(rawPending, /127\.0\.0\.1/, 'the target is never stored');
    assert.equal(pending[0].last_error, 'non-2xx response: 500', 'the recorded error describes the failure without the target');
  } finally {
    await failing.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b retry: a new process resumes the queue and delivers, and backoff grows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-resume-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await startMockWebhook({ status: 500, reply: '{"code":1,"msg":"down"}' });
  const good = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
  try {
    // First "process": the delivery fails and is queued.
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '4',
      AF_BOUNDARY_NOTIFY_RETRY_BASE_MS: '1000',
    }, async () => {
      await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      await flushPendingNotifications({ file, now: Date.now() + 10000 }); // still failing (same target)
    });
    const afterTwo = listPendingNotifications({ file })[0];
    assert.equal(afterTwo.attempts, 2);
    const secondDelay = Date.parse(afterTwo.next_attempt_at) - Date.now();
    assert.ok(secondDelay > 1000, `backoff must grow: ${secondDelay}ms`);

    // Second "process" (fresh state read) points at a healthy target and resumes.
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: good.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '4',
    }, async () => {
      const res = await flushPendingNotifications({ file, now: Date.now() + 600000 });
      assert.equal(res.attempted, 1);
      assert.equal(res.delivered, 1);
    });
    assert.equal(good.requests.length, 1);
    assert.equal(listPendingNotifications({ file }).length, 0, 'a delivered entry leaves the queue');
    // The series is removed on success, so a later event on this path starts fresh.
    assert.equal(inspectPendingNotifications({ file, includeDelivered: true }).pending.length, 0);
    assert.equal(readNotifyEvents({ file }).some((r) => r.status === 'sent'), true, 'the delivery is still auditable');
  } finally {
    await failing.close();
    await good.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b retry: attempts are bounded and exhaustion is visible without the webhook', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-exhaust-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await startMockWebhook({ status: 500, reply: '{"code":1,"msg":"down"}' });
  const cli = CLI;
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '2',
    }, async () => {
      await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      const first = await flushPendingNotifications({ file, now: Date.now() + 60000 });
      assert.equal(first.exhausted, 1, 'the second failure exhausts the budget');
      const pending = listPendingNotifications({ file });
      assert.equal(pending[0].state, 'exhausted');
      assert.equal(pending[0].next_attempt_at, null, 'no further attempt is scheduled');
      const again = await flushPendingNotifications({ file, now: Date.now() + 600000, force: true });
      assert.equal(again.attempted, 0, 'an exhausted entry is never retried again');
    });

    // Visible locally: notify-status exits non-zero while a delivery is stuck.
    const status = (() => {
      try {
        const out = execFileSync(process.execPath, [cli, 'boundary', 'notify-status'], {
          env: { ...process.env, AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url },
          encoding: 'utf8',
        });
        return { code: 0, out };
      } catch (err) { return { code: err.status, out: `${err.stdout ?? ''}` }; }
    })();
    assert.equal(status.code, 1, 'a stuck delivery must fail the status check loudly');
    assert.match(status.out, /exhausted: 1/);
    // In dry-run/off the flush refuses instead of silently doing nothing.
    const refused = (() => {
      try {
        execFileSync(process.execPath, [cli, 'boundary', 'notify-flush', '--confirm'], {
          env: { ...process.env, AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run' }, encoding: 'utf8',
        });
        return 0;
      } catch (err) { return err.status; }
    })();
    assert.equal(refused, 2, 'retries only run in live mode');
  } finally {
    await failing.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b retry: backoff is exponential and capped', () => {
  return withEnvAsync({ AF_BOUNDARY_NOTIFY_RETRY_BASE_MS: '1000', AF_BOUNDARY_NOTIFY_RETRY_MAX_MS: '5000' }, () => {
    assert.equal(notifyBackoffMs(1), 1000);
    assert.equal(notifyBackoffMs(2), 2000);
    assert.equal(notifyBackoffMs(3), 4000);
    assert.equal(notifyBackoffMs(4), 5000, 'the delay is capped');
    assert.equal(notifyBackoffMs(9), 5000);
  });
});

test('A1b retry: two concurrent flushes deliver an entry exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-flushrace-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await startMockWebhook({ status: 500, reply: '{"code":1,"msg":"down"}' });
  // Slow healthy target so the second flush overlaps the first one's claim.
  const slowGood = await new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requests.push({ body });
        setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"code":0,"msg":"success"}'); }, 250);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise((r) => server.close(r)) }));
  });
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '5',
    }, async () => {
      await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
    });

    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: slowGood.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '5',
    }, async () => {
      const [a, b] = await Promise.all([
        flushPendingNotifications({ file, force: true }),
        flushPendingNotifications({ file, force: true }),
      ]);
      assert.equal(a.attempted + b.attempted, 1, `exactly one flush may attempt the entry, got ${a.attempted}+${b.attempted}`);
      assert.equal(a.delivered + b.delivered, 1);
    });
    assert.equal(slowGood.requests.length, 1, 'the transport must be called exactly once');
    assert.equal(inspectPendingNotifications({ file }).pending.filter((e) => e.state === 'pending').length, 0);
  } finally {
    await failing.close();
    await slowGood.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b retry: a later success through the normal entry settles the failed entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-settle-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await startMockWebhook({ status: 500, reply: '{"code":1,"msg":"down"}' });
  const good = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_RETRY_BASE_MS: '1',
    }, async () => {
      const first = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(first.status, 'failed');
    });
    assert.equal(inspectPendingNotifications({ file }).pending.filter((e) => e.state === 'pending').length, 1);
    await new Promise((r) => setTimeout(r, 20)); // let the 1ms backoff window pass

    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: good.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_RETRY_BASE_MS: '1',
    }, async () => {
      const second = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(second.status, 'sent', 'the normal entry must be able to retry and succeed');
    });
    const after = inspectPendingNotifications({ file });
    assert.equal(after.pending.length, 0, 'the failed entry must be settled and removed, not left pending');
    // A queue flush now has nothing to send.
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu', AF_BOUNDARY_NOTIFY_WEBHOOK: good.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const res = await flushPendingNotifications({ file, force: true });
      assert.equal(res.attempted, 0, 'a settled entry must never be delivered again');
    });
    assert.equal(good.requests.length, 1, 'exactly one successful delivery overall');
  } finally {
    await failing.close();
    await good.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b retry: the normal entry honours the same attempt cap as the flush', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-cap-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await startMockWebhook({ status: 500, reply: '{"code":1,"msg":"down"}' });
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '2',
    }, async () => {
      const first = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(first.status, 'failed');
      // Attempt 2 is driven by the operator flush (which may shorten the wait, never the cap).
      const flushed = await flushPendingNotifications({ file, force: true });
      assert.equal(flushed.attempted, 1);
      assert.equal(flushed.exhausted, 1, 'the second failure exhausts the budget');
      // Attempt 3 must be refused by the cap before any I/O.
      const third = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(third.status, 'failed');
      assert.match(third.reason, /retry budget exhausted/);
      assert.equal(third.attempts, undefined, 'the refused attempt must not be counted');
    });
    assert.equal(failing.requests.length, 2, `max_attempts=2 must cap the transport calls, got ${failing.requests.length}`);
    assert.equal(inspectPendingNotifications({ file }).pending[0].state, 'exhausted');
  } finally {
    await failing.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b retry: every attempt re-signs with the current secret and a fresh timestamp', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-resign-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await startMockWebhook({ status: 500, reply: '{"code":1,"msg":"down"}' });
  const good = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_FEISHU_SECRET: 'old-secret',
    }, async () => {
      await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
    });

    const rotatedAt = Date.now();
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: good.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_FEISHU_SECRET: 'rotated-secret',
    }, async () => {
      const res = await flushPendingNotifications({ file, force: true });
      assert.equal(res.delivered, 1);
    });

    const body = JSON.parse(good.requests[0].body);
    assert.equal(body.msg_type, 'text', 'the retry rebuilds the request');
    const expected = createHmac('sha256', `${body.timestamp}\nrotated-secret`).update('').digest('base64');
    assert.equal(body.sign, expected, 'the retry must sign with the CURRENT secret, not the stored one');
    assert.ok(Number(body.timestamp) * 1000 >= rotatedAt - 2000, 'the timestamp must be fresh, not the one from the failed attempt');
  } finally {
    await failing.close();
    await good.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b retry: a corrupt queue is unverifiable, never "nothing pending"', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-corruptq-'));
  const file = join(root, 'alerts.jsonl');
  const queueFile = `${file}.notify-pending.json`;
  const mock = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
  try {
    writeFileSync(queueFile, '{ this is not json');
    const inspection = inspectPendingNotifications({ file });
    assert.equal(inspection.ok, false);
    assert.match(inspection.reason, /not valid JSON/);
    assert.throws(() => listPendingNotifications({ file }), (err) => err.code === 'BOUNDARY_NOTIFY_QUEUE_UNVERIFIABLE');

    const cli = (argv) => {
      try {
        const out = execFileSync(process.execPath, [CLI, ...argv], {
          env: { ...process.env, AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url },
          encoding: 'utf8',
        });
        return { code: 0, out };
      } catch (err) { return { code: err.status, out: `${err.stdout ?? ''}`, err: `${err.stderr ?? ''}` }; }
    };
    const status = cli(['boundary', 'notify-status']);
    assert.equal(status.code, 3, 'an unverifiable queue must exit non-zero');
    assert.match(status.out, /UNVERIFIABLE/);
    assert.doesNotMatch(status.out, /pending retries: 0/);

    const flush = cli(['boundary', 'notify-flush', '--confirm']);
    assert.equal(flush.code, 3, 'flush must refuse on an unverifiable queue');
    assert.equal(readFileSync(queueFile, 'utf8'), '{ this is not json', 'the damaged queue must not be overwritten');
    assert.equal(mock.requests.length, 0, 'nothing may be sent from an unverifiable queue');
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b budget: a new alert on the same path starts with a fresh budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-newalert-'));
  const file = join(root, 'alerts.jsonl');
  const mock = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '2',
    }, async () => {
      // Three DIFFERENT alerts on the same path: the budget belongs to the event, so a
      // successful delivery must not consume the next alert's attempts.
      for (const id of ['A-1', 'A-2', 'A-3']) {
        const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1, { alert_id: id }) });
        assert.equal(res.status, 'sent', `alert ${id} must be delivered, got ${res.status} (${res.reason})`);
      }
    });
    assert.equal(mock.requests.length, 3, 'three distinct alerts must produce three deliveries');
    assert.equal(inspectPendingNotifications({ file }).pending.length, 0, 'a delivered series is removed');
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b budget: the normal entry obeys the retry backoff (no early resend)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-backoff-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await startMockWebhook({ status: 500, reply: '{"code":1,"msg":"down"}' });
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0',
      AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '5', AF_BOUNDARY_NOTIFY_RETRY_BASE_MS: '60000',
    }, async () => {
      const first = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(first.status, 'failed');
      // Immediately again: the wait has not elapsed, so the normal entry must NOT send.
      const second = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1) });
      assert.equal(second.status, 'suppressed');
      assert.match(second.reason, /backoff until/);
      // Only an explicit operator action may shorten the wait - and never the cap.
      const forced = await flushPendingNotifications({ file, force: true });
      assert.equal(forced.attempted, 1, 'the operator flush may bypass the wait');
    });
    assert.equal(failing.requests.length, 2, 'the normal entry must not add a second immediate send');
  } finally {
    await failing.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b retry: a crashed claim is resumable and visible, never stuck pending forever', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-crash-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await startMockWebhook({ status: 500, reply: '{"code":1,"msg":"down"}' });
  const good = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
  try {
    // Simulate a process that claimed the delivery and died before settling.
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '5',
      AF_BOUNDARY_NOTIFY_RETRY_BASE_MS: '60000',
    }, async () => {
      await notifyBoundaryAlert({ event: 'boundary_retained', alert: alertFor(root, 1), fetchImpl: async () => { throw new Error('process died during the send'); } });
      // Craft the crashed state: claimed, no schedule, still pending.
      const q = JSON.parse(readFileSync(`${file}.notify-pending.json`, 'utf8'));
      const key = Object.keys(q)[0];
      q[key].claimed_at = new Date(Date.now() - 120000).toISOString();
      q[key].claim_token = 'dead-claim';
      q[key].next_attempt_at = null;
      writeFileSync(`${file}.notify-pending.json`, JSON.stringify(q, null, 2));
    });

    // The queue must be visible as needing attention...
    const inspection = inspectPendingNotifications({ file });
    assert.equal(inspection.pending.length, 1);
    assert.equal(inspection.pending[0].next_attempt_at, null);

    // ...and a later (healthy) flush must pick it up even though no schedule exists.
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: good.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '5',
    }, async () => {
      const res = await flushPendingNotifications({ file });
      assert.equal(res.due, 1, 'a crashed last attempt must be treated as due');
      assert.equal(res.attempted, 1);
      assert.equal(res.delivered, 1);
    });
    assert.equal(good.requests.length, 1);
    assert.equal(inspectPendingNotifications({ file }).pending.length, 0, 'the resumed delivery settles the entry');
  } finally {
    await failing.close();
    await good.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b queue: unreadable path and malformed entries are unverifiable, not empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-schema-'));
  const file = join(root, 'alerts.jsonl');
  const queueFile = `${file}.notify-pending.json`;
  try {
    // (a) malformed entries: unknown state, bad counter, missing payload, bad dates
    const malformed = [
      { state: 'weird' },
      { attempts: -1 },
      { payload: null },
      { next_attempt_at: 'not-a-date' },
      { format: 'telegram' },
    ];
    for (const patch of malformed) {
      const entry = {
        notify_key: 'live|A-1|first', cooldown_key: 'live|/tmp|first', event: 'boundary_retained',
        canonical_dir: '/tmp/x', cas_dir: null, task_id: 'T', alert_id: 'A-1', format: 'feishu', mode: 'live',
        payload: { schema: 'af-boundary-alert-v1' }, attempts: 1, max_attempts: 5, state: 'pending',
        first_attempt_at: new Date().toISOString(), claimed_at: null, claim_token: null,
        next_attempt_at: null, last_error: null,
        ...patch,
      };
      writeFileSync(queueFile, JSON.stringify({ 'live|A-1|first': entry }, null, 2));
      const inspection = inspectPendingNotifications({ file });
      assert.equal(inspection.ok, false, `a malformed entry must be unverifiable: ${JSON.stringify(patch)}`);
      assert.match(inspection.reason, /retry queue entry/);
    }

    // (b) a queue file that cannot be inspected (directory in its place) is unverifiable
    rmSync(queueFile, { force: true });
    mkdirSync(queueFile);
    const dirInspection = inspectPendingNotifications({ file });
    assert.equal(dirInspection.ok, false);
    assert.match(dirInspection.reason, /cannot be inspected|not a regular file/);
    rmSync(queueFile, { recursive: true, force: true });

    // (c) only a definite absence counts as an empty queue
    const missing = inspectPendingNotifications({ file });
    assert.equal(missing.ok, true);
    assert.deepEqual(missing.pending, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b retry: a crashed last attempt becomes a persisted terminal state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-terminal-'));
  const file = join(root, 'alerts.jsonl');
  const queueFile = `${file}.notify-pending.json`;
  const good = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
  try {
    // max_attempts = 1: the single attempt is claimed and the process "dies" before settling.
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: good.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '1',
    }, async () => {
      const res = await notifyBoundaryAlert({
        event: 'boundary_retained',
        alert: alertFor(root, 1),
        fetchImpl: async () => { throw new Error('process died during the send'); },
      });
      assert.equal(res.status, 'failed');
    });
    // Craft the crashed state: claim held, no schedule, still marked pending.
    const q = JSON.parse(readFileSync(queueFile, 'utf8'));
    const key = Object.keys(q)[0];
    q[key].state = 'pending';
    q[key].attempts = 1;
    q[key].max_attempts = 1;
    q[key].claimed_at = new Date(Date.now() - 120000).toISOString();
    q[key].claim_token = 'dead-claim';
    q[key].next_attempt_at = null;
    writeFileSync(queueFile, JSON.stringify(q, null, 2));

    // Sweep 1: the cap refuses the send and the terminal state must be persisted.
    const first = await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: good.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '1',
    }, async () => flushPendingNotifications({ file }));
    assert.equal(first.due, 1);
    assert.equal(first.attempted, 0, 'the cap must prevent any further send');
    assert.equal(first.exhausted, 1);
    assert.equal(good.requests.length, 0, 'nothing may be sent once the budget is spent');

    // Restart re-read: the terminal state is on disk, the claim is released, the attempt
    // audit is kept, and the unknown outcome is recorded rather than asserted.
    const onDisk = JSON.parse(readFileSync(queueFile, 'utf8'));
    const entry = onDisk[key];
    assert.equal(entry.state, 'exhausted');
    assert.equal(entry.claimed_at, null, 'the dead claim must be released');
    assert.equal(entry.claim_token, null);
    assert.equal(entry.next_attempt_at, null);
    assert.equal(entry.attempts, 1, 'the original attempt audit is preserved');
    assert.equal(entry.max_attempts, 1);
    assert.equal(entry.outcome_unknown, true, 'the last attempt outcome must be marked unknown');
    assert.match(entry.last_error, /outcome unknown/);
    assert.equal(entry.terminal_reason, 'retry-budget-exhausted');

    // Sweep 2: it is no longer due, but it is still visible as needing manual attention.
    const second = await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: good.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '1',
    }, async () => flushPendingNotifications({ file }));
    assert.equal(second.due, 0, 'a terminal entry must not be listed as due again');
    assert.equal(second.exhausted, 0);

    const inspection = inspectPendingNotifications({ file });
    assert.equal(inspection.pending.length, 1, 'the terminal entry stays visible');
    assert.equal(inspection.pending[0].state, 'exhausted');

    const status = (() => {
      try {
        const out = execFileSync(process.execPath, [CLI, 'boundary', 'notify-status'], {
          env: { ...process.env, AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_WEBHOOK: good.url },
          encoding: 'utf8',
        });
        return { code: 0, out };
      } catch (err) { return { code: err.status, out: `${err.stdout ?? ''}` }; }
    })();
    assert.equal(status.code, 1, 'a terminal delivery still needs a human');
    assert.match(status.out, /exhausted: 1/);
    const events = readNotifyEvents({ file });
    assert.equal(events.some((e) => e.status === 'exhausted' && e.outcome_unknown === true), true, 'the terminal transition is audited');
  } finally {
    await good.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b race: a sweep must not terminate an in-flight last attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-inflight-'));
  const file = join(root, 'alerts.jsonl');
  const queueFile = `${file}.notify-pending.json`;
  const mock = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
  let releaseSend;
  const gate = new Promise((resolve) => { releaseSend = resolve; });
  let transportCalls = 0;
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0',
      AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS: '1', AF_BOUNDARY_NOTIFY_CLAIM_TTL_MS: '60000',
    }, async () => {
      // The one allowed attempt is claimed and its transport hangs.
      const inFlight = notifyBoundaryAlert({
        event: 'boundary_retained',
        alert: alertFor(root, 1),
        fetchImpl: async () => {
          transportCalls += 1;
          await gate;
          return { ok: true, status: 200, text: async () => '{"code":0,"msg":"success"}' };
        },
      });
      // Wait (bounded) for the claim to appear instead of assuming a fixed delay: under a
      // loaded full-suite run 20ms is not a guarantee. The TTL is 60s, so the race window
      // is unaffected by waiting here.
      const claimDeadline = Date.now() + 5000;
      let claimed = {};
      for (;;) {
        try { claimed = JSON.parse(readFileSync(queueFile, 'utf8')); } catch { claimed = {}; }
        const firstEntry = Object.values(claimed)[0];
        if (firstEntry?.claim_token) break;
        if (Date.now() > claimDeadline) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      const key = Object.keys(claimed)[0];
      const claimBefore = claimed[key].claim_token;
      assert.ok(claimBefore, 'the in-flight attempt must hold a claim');
      const claimedAtBefore = claimed[key].claimed_at;

      // A routine sweep, and even a forced one, must leave the live claim alone.
      const routine = await flushPendingNotifications({ file });
      assert.equal(routine.attempted, 0, 'the sweep must not start a parallel send');
      assert.equal(routine.exhausted, 0, 'a valid claim must not be declared exhausted');
      assert.equal(routine.in_flight, 1, 'the sweep must report the in-flight attempt');
      const forced = await flushPendingNotifications({ file, force: true });
      assert.equal(forced.attempted, 0, '--force must not bypass a live claim either');
      assert.equal(forced.exhausted, 0);

      const during = JSON.parse(readFileSync(queueFile, 'utf8'));
      assert.equal(during[key].state, 'pending', 'the entry must still be pending while the attempt runs');
      assert.equal(during[key].claim_token, claimBefore, 'the live claim must be untouched');
      assert.equal(during[key].claimed_at, claimedAtBefore);
      const statusCheck = (() => {
        try {
          const out = execFileSync(process.execPath, [CLI, 'boundary', 'notify-status'], {
            env: { ...process.env, AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url },
            encoding: 'utf8',
          });
          return { code: 0, out };
        } catch (err) { return { code: err.status, out: `${err.stdout ?? ''}` }; }
      })();
      assert.match(statusCheck.out, /exhausted: 0/, 'an in-flight attempt is not an exhausted delivery');

      releaseSend();
      const res = await inFlight;
      assert.equal(res.status, 'sent', 'the in-flight attempt must be allowed to finish successfully');
      assert.equal(res.settled, true, 'and it must settle cleanly');
    });
    assert.equal(transportCalls, 1, 'exactly one transport call, made by the in-flight attempt');
    assert.equal(inspectPendingNotifications({ file }).pending.length, 0, 'the queue is cleared once the attempt settles');
  } finally {
    releaseSend?.();
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b settle: a delivery whose bookkeeping fails is not reported as settled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-settlefail-'));
  const file = join(root, 'alerts.jsonl');
  const mock = await startMockWebhook({ reply: '{"code":0,"msg":"success"}' });
  try {
    await withEnvAsync({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu',
      AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0',
    }, async () => {
      // The transport succeeds, but the claimed entry disappears before it can be settled.
      const res = await notifyBoundaryAlert({
        event: 'boundary_retained',
        alert: alertFor(root, 1),
        fetchImpl: async () => {
          rmSync(`${file}.notify-pending.json`, { force: true });
          return { ok: true, status: 200, text: async () => '{"code":0,"msg":"success"}' };
        },
      });
      assert.equal(res.transport_status, 'sent', 'the transport did succeed');
      assert.equal(res.settled, false, 'the bookkeeping did not');
      assert.equal(res.status, 'failed', 'an unsettled delivery must not be reported as delivered');
      assert.match(res.settle_reason, /entry missing/);
    });
    const events = readNotifyEvents({ file });
    assert.equal(events.some((e) => e.status === 'settle-failed'), true, 'the inconsistency must be auditable');
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b payload: a non-string path never renders as "[object Object]"', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-nonstring-'));
  const file = join(root, 'alerts.jsonl');
  try {
    // A CAS instance (or any object) mistakenly passed as cas_dir must become null, not
    // "[object Object]" in the alert log or in an outbound notification.
    const res = recordBoundaryAlert({
      canonicalDir: root,
      casDir: { casDir: '/tmp/af-cas-should-not-appear', objectsDir: '/tmp/x' },
      taskId: 'T-NONSTRING',
      reason: 'scope-anomaly',
      file,
    });
    assert.deepEqual(res.input_anomalies, ['cas_dir-not-a-string']);

    const events = readBoundaryAlertEvents({ file });
    assert.equal(events[0].cas_dir, null, 'the object must not be stored as cas_dir');
    assert.deepEqual(events[0].input_anomalies, ['cas_dir-not-a-string']);
    const raw = readFileSync(file, 'utf8');
    assert.doesNotMatch(raw, /\[object Object\]/);
    assert.doesNotMatch(raw, /af-cas-should-not-appear/, 'no internals of the object may leak into the log');

    const payload = buildNotifyPayload({ event: 'boundary_retained', alert: { canonical_dir: root, cas_dir: { bogus: true }, task_id: 12345, occurrences: 1 } });
    assert.equal(payload.cas_dir, null);
    assert.equal(payload.task_id, null, 'a non-string task id is not rendered either');
    const body = buildNotifyRequest({ event: 'boundary_retained', payload, format: 'feishu' }).body;
    assert.doesNotMatch(body, /\[object Object\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1b lifecycle: the delivered message carries real paths, not objects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-notify-paths-'));
  const repoDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const candidateDir = join(root, 'candidate');
  const scopeBase = mkdtempSync(join(tmpdir(), 'af-notify-paths-scopes-'));
  const file = join(root, 'alerts.jsonl');
  const taskId = 'TASK-PATHS';
  const taskPath = join(root, 'task.json');
  for (const d of [repoDir, casDir, candidateDir]) mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repoDir, stdio: 'pipe' });
  mkdirSync(join(repoDir, 'src'));
  mkdirSync(join(repoDir, 'tests'));
  writeFileSync(join(repoDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
  writeFileSync(join(repoDir, 'tests', 'gate.test.mjs'), "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nimport { test } from 'node:test';\ntest('g', () => assert.equal(value, 'v2'));\n");
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['update-ref', 'refs/afr/canonical', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim()], { cwd: repoDir });
  mkdirSync(join(scopeBase, 'af-writer-broken'), { recursive: true });

  const task = {
    task_id: taskId, fixture_dir: repoDir, state: 'CREATED', host_isolation: true,
    author_executor: 'codex', reviewer_executor: 'claude',
    acceptance_cmd: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] }, acceptance_binding: null,
    trusted_import: {
      enabled: true, candidate_dir: candidateDir, cas_dir: casDir, proposed_required: ['src/**'],
      policy: { allowed_root: ['src/**', 'tests/**'], forbidden: [], protected_paths: [], projection: { exclude: [] }, import: { deny: [] } },
      acceptance: { tier: 'TierA', acceptance_profile_digest: 'd', acceptance_assets_digest: 'a', dependency_fixture_id: 'f' },
    },
  };
  try {
    await withEnvAsync({ AF_BOUNDARY_ALERTS_FILE: file, AF_CGROUP_BASE: scopeBase, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu' }, async () => {
      await runTrustedImportTask(task, {
        runAuthor: async (rev, { cwd }) => {
          writeFileSync(join(cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
          return { executor_run_id: 'RUN-P', writer_termination: { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' } };
        },
        runReview: async () => {
          task.last_review_termination_evidence = { process_started: true, process_group_alive: false, termination_confirmed: true, scope_verified: true, scope_kind: 'cgroup' };
          return { decision: 'PASS', summary: 'ok' };
        },
        saveTask: (t) => writeFileSync(taskPath, `${JSON.stringify(t, null, 2)}\n`),
      });
    });
    const record = readNotifyEvents({ file })[0];
    assert.equal(record.status, 'would-notify');
    assert.doesNotMatch(record.request_body, /\[object Object\]/, 'the outbound message must not contain an object rendering');
    const parsed = JSON.parse(record.request_body);
    assert.match(parsed.content.text, new RegExp(casDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the CAS path must be a real path');
    const onDisk = JSON.parse(readFileSync(taskPath, 'utf8'));
    assert.equal(onDisk.trusted_import.boundary_alert.occurrences, 1);
    const alertEvent = readBoundaryAlertEvents({ file })[0];
    assert.equal(alertEvent.cas_dir, casDir, 'the alert log must store the CAS path string');
    assert.equal(alertEvent.input_anomalies, undefined, 'no input anomaly is expected here');
  } finally {
    disengageTaskHostBoundary({ canonicalDir: repoDir, casDir, force: true });
    rmSync(scopeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
