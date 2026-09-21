// feishu-card.test.mjs - the Feishu Card JSON 2.0 notification format.
//
// The card must keep the safety properties of the text format: dynamic values are plain
// text, the final signed body stays inside the provider limit, the provider receipt is
// confirmed (HTTP 200 alone is never success), and retries/re-signing/settlement go
// through the same state machine. No test here contacts a real endpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordBoundaryAlert } from '../lib/boundary-alerts.mjs';
import {
  buildFeishuCard,
  buildNotifyPayload,
  buildNotifyRequest,
  cardStateFor,
  flushPendingNotifications,
  inspectPendingNotifications,
  notifyBoundaryAlert,
  readNotifyEvents,
  truncateCardText,
  FEISHU_CARD_MAX_ELEMENTS,
  FEISHU_CARD_TAGS,
} from '../lib/boundary-notify.mjs';

const ENV_KEYS = [
  'AF_BOUNDARY_ALERTS_FILE', 'AF_BOUNDARY_NOTIFY_MODE', 'AF_BOUNDARY_NOTIFY_WEBHOOK',
  'AF_BOUNDARY_NOTIFY_FORMAT', 'AF_BOUNDARY_NOTIFY_COOLDOWN_MS', 'AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS',
  'AF_BOUNDARY_NOTIFY_FEISHU_SECRET', 'AF_BOUNDARY_NOTIFY_MAX_BODY_BYTES',
  'AF_BOUNDARY_NOTIFY_RETRY_BASE_MS', 'AF_BOUNDARY_ALERT_ESCALATE_AFTER',
];

async function withEnv(patch, fn) {
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

function mockServer({ status = 200, reply = '{"code":0,"msg":"success"}' } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(reply);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    requests,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

const basePayload = (extra = {}) => ({
  schema: 'af-boundary-alert-v1',
  event: 'boundary_retained',
  alert_id: 'AF-TEST-1',
  severity: 'warning',
  occurrences: 1,
  canonical_dir: '/srv/agent-foundry-next',
  cas_dir: '/srv/trusted-cas',
  task_id: 'TASK-CARD-1',
  boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
  reason: 'scope-anomaly',
  scope_decision: { decision: 'RETAIN', reason: 'scope-anomaly', attempts: 1, quiesce_confirmed: true, anomalies: ['broken-scope'] },
  at: '2026-09-21T08:00:00.000Z',
  source: 'agent-foundry-next/boundary-alerts',
  ...extra,
});

/** Flatten every string in the card so text assertions are simple. */
const cardText = (card) => JSON.stringify(card);

test('card: the four designed states map to the right colour and title', () => {
  const retained = buildFeishuCard({ event: 'boundary_retained', payload: basePayload() });
  assert.equal(retained.state, 'retained');
  assert.equal(retained.card.header.template, 'orange');
  assert.match(retained.card.header.title.content, /边界保护已保留/);

  const escalated = buildFeishuCard({ event: 'boundary_retained', payload: basePayload({ severity: 'escalated', occurrences: 3 }) });
  assert.equal(escalated.state, 'escalated');
  assert.equal(escalated.card.header.template, 'red');
  assert.match(escalated.card.header.title.content, /持续保留/);

  const incomplete = buildFeishuCard({
    event: 'boundary_retained',
    payload: basePayload({ boundary_state: 'RESTORE_INCOMPLETE', reason: 'release could not be verified' }),
  });
  assert.equal(incomplete.state, 'restore-incomplete');
  assert.equal(incomplete.card.header.template, 'red');
  assert.match(incomplete.card.header.title.content, /恢复未完成/);
  assert.match(cardText(incomplete.card), /保护完整性不可确认/, 'the restore-incomplete state must say the protection cannot be confirmed');
  assert.match(cardText(incomplete.card), /不得假定已解锁/);

  const recovered = buildFeishuCard({ event: 'boundary_released', payload: basePayload({ event: 'boundary_released', boundary_state: 'DISENGAGED', occurrences: 0, severity: 'warning' }) });
  assert.equal(recovered.state, 'recovered');
  assert.equal(recovered.card.header.template, 'green');
  assert.match(recovered.card.header.title.content, /边界已恢复/);

  // Escalation threshold is decided by the same env var as the alerting layer.
  return withEnv({ AF_BOUNDARY_ALERT_ESCALATE_AFTER: '2' }, () => {
    assert.equal(cardStateFor(basePayload({ occurrences: 2, severity: 'warning' })), 'escalated');
    assert.equal(cardStateFor(basePayload({ occurrences: 1, severity: 'warning' })), 'retained');
  });
});

test('card: Card JSON 2.0 envelope, known tags, plain-text dynamic values, no actions', () => {
  const secret = 'card-signature-secret';
  return withEnv({ AF_BOUNDARY_NOTIFY_FEISHU_SECRET: secret, AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card' }, () => {
    const { card, elements } = buildFeishuCard({ event: 'boundary_retained', payload: basePayload() });
    assert.equal(card.schema, '2.0', '2.0 must be declared explicitly');
    assert.deepEqual(Object.keys(card.header).sort(), ['template', 'title']);
    assert.equal(card.config.update_multi, true, 'Card JSON 2.0 only supports shared cards');
    assert.ok(Array.isArray(card.body?.elements), 'components live under body.elements');
    assert.equal(card.elements, undefined, 'a 2.0 card must not use the v1 top-level elements');
    assert.ok(elements <= FEISHU_CARD_MAX_ELEMENTS, `too many elements: ${elements}`);

    // Only tags confirmed valid in 2.0, and no interactive component at all.
    const walk = (nodes) => {
      for (const node of nodes) {
        assert.ok(FEISHU_CARD_TAGS.includes(node.tag), `unexpected tag: ${node.tag}`);
        assert.notEqual(node.tag, 'note', 'note is not part of the 2.0 component set');
        assert.notEqual(node.tag, 'button', 'the card must never offer an action');
        assert.notEqual(node.tag, 'action');
        assert.notEqual(node.tag, 'input');
        if (node.text) assert.equal(node.text.tag, 'plain_text', 'dynamic values must be plain text');
        if (Array.isArray(node.elements)) walk(node.elements);
      }
    };
    walk(card.body.elements);

    // Every dynamic value appears verbatim (plain text, no markdown escaping needed).
    const text = cardText(card);
    for (const value of ['/srv/agent-foundry-next', '/srv/trusted-cas', 'TASK-CARD-1', 'scope-anomaly', 'broken-scope', 'AF-TEST-1']) {
      assert.ok(text.includes(value), `the card must carry ${value}`);
    }

    // The signed envelope is a valid custom-bot request whose signature verifies.
    const request = buildNotifyRequest({ event: 'boundary_retained', payload: basePayload() });
    const body = JSON.parse(request.body);
    assert.equal(body.msg_type, 'interactive');
    assert.equal(body.card.schema, '2.0');
    const expected = createHmac('sha256', `${body.timestamp}\n${secret}`).update('').digest('base64');
    assert.equal(body.sign, expected, 'the card request must be signed like the text format');
    assert.equal(request.bytes, Buffer.byteLength(request.body, 'utf8'), 'bytes describe the final signed body');
  });
});

test('card: over-long dynamic values are truncated with an explicit marker', () => {
  const longPath = `/srv/${'a'.repeat(400)}/repo`;
  const longReason = 'x'.repeat(900);
  const { card, truncated } = buildFeishuCard({
    event: 'boundary_retained',
    payload: basePayload({ canonical_dir: longPath, reason: longReason, scope_decision: null }),
  });
  const text = cardText(card);
  assert.ok(truncated >= 2, `truncation must be counted, got ${truncated}`);
  assert.match(text, /…\[已截断\]/, 'every clipped field carries a marker');
  assert.match(text, /内容已截断 \d+ 处/, 'the audit line states how many fields were clipped');
  assert.ok(!text.includes('x'.repeat(320)), 'the reason must be bounded');

  assert.deepEqual(truncateCardText('short', 10), { text: 'short', truncated: false });
  assert.deepEqual(truncateCardText('0123456789abc', 10), { text: '0123456789 …[已截断]', truncated: true });
});

test('card: an oversized final body is refused before any send', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-card-size-'));
  const file = join(root, 'alerts.jsonl');
  const mock = await mockServer();
  try {
    await withEnv({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card',
      AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0',
      AF_BOUNDARY_NOTIFY_MAX_BODY_BYTES: '200',
    }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: { canonical_dir: root, alert_id: 'AF-BIG', occurrences: 1, severity: 'warning', boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY', reason: 'r' } });
      assert.equal(res.status, 'failed');
      assert.match(res.reason, /exceeds the limit of 200/);
      assert.ok(res.bytes > 200);
    });
    assert.equal(mock.requests.length, 0, 'an oversized body must never be sent');
    const events = readNotifyEvents({ file });
    assert.equal(events.some((e) => e.status === 'oversized-request-body'), true, 'the refusal must be audited');
    // Nothing was claimed, so there is no phantom retry to chase.
    assert.equal(inspectPendingNotifications({ file }).pending.length, 0);
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('card: HTTP 200 alone is never success for the card format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-card-receipt-'));
  const file = join(root, 'alerts.jsonl');
  const noCode = await mockServer({ status: 200, reply: '{"ok":true}' });
  const rejected = await mockServer({ status: 200, reply: '{"code":19002,"msg":"sign match fail"}' });
  const accepted = await mockServer({ status: 200, reply: '{"code":0,"msg":"success"}' });
  const alert = (id) => ({ canonical_dir: root, alert_id: id, occurrences: 1, severity: 'warning', boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY', reason: 'scope-anomaly' });
  try {
    await withEnv({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card', AF_BOUNDARY_NOTIFY_WEBHOOK: noCode.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alert('AF-NOCODE') });
      assert.equal(res.status, 'failed', 'a 200 without a provider status code cannot confirm a card delivery');
      assert.match(res.reason, /cannot be confirmed/);
    });
    await withEnv({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card', AF_BOUNDARY_NOTIFY_WEBHOOK: rejected.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alert('AF-REJECT') });
      assert.equal(res.status, 'failed');
      assert.equal(res.provider_code, 19002);
    });
    await withEnv({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card', AF_BOUNDARY_NOTIFY_WEBHOOK: accepted.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0' }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: alert('AF-OK') });
      assert.equal(res.status, 'sent');
      assert.equal(res.settled, true);
    });
    assert.equal(accepted.requests.length, 1);
    assert.equal(JSON.parse(accepted.requests[0].body).card.schema, '2.0', 'the provider receives the 2.0 card');
  } finally {
    await noCode.close();
    await rejected.close();
    await accepted.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('card: retries re-sign the card with the current secret', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-card-resign-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await mockServer({ status: 500, reply: '{"code":1,"msg":"down"}' });
  const good = await mockServer({ reply: '{"code":0,"msg":"success"}' });
  const alert = { canonical_dir: root, cas_dir: '/cas', task_id: 'T', alert_id: 'AF-RESIGN', occurrences: 1, severity: 'warning', boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY', reason: 'scope-anomaly' };
  try {
    await withEnv({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_FEISHU_SECRET: 'old-secret',
    }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert });
      assert.equal(res.status, 'failed');
    });
    await withEnv({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card',
      AF_BOUNDARY_NOTIFY_WEBHOOK: good.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0', AF_BOUNDARY_NOTIFY_FEISHU_SECRET: 'rotated-secret',
    }, async () => {
      const res = await flushPendingNotifications({ file, force: true });
      assert.equal(res.delivered, 1, 'the queued card delivery must resume');
    });
    const body = JSON.parse(good.requests[0].body);
    assert.equal(body.card.schema, '2.0');
    const expected = createHmac('sha256', `${body.timestamp}\nrotated-secret`).update('').digest('base64');
    assert.equal(body.sign, expected, 'the retried card must use the current secret');
    assert.equal(inspectPendingNotifications({ file }).pending.length, 0, 'the settled card leaves the queue');
  } finally {
    await failing.close();
    await good.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('card: dry-run records the rendered card and performs no network I/O', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-card-dry-'));
  const file = join(root, 'alerts.jsonl');
  const mock = await mockServer();
  try {
    await withEnv({ AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'dry-run', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card', AF_BOUNDARY_NOTIFY_WEBHOOK: mock.url }, async () => {
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: { canonical_dir: root, cas_dir: '/cas', task_id: 'T', alert_id: 'AF-DRY', occurrences: 1, severity: 'warning', boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY', reason: 'scope-anomaly' } });
      assert.equal(res.status, 'would-notify');
    });
    assert.equal(mock.requests.length, 0, 'dry-run must not touch the network');
    const record = readNotifyEvents({ file })[0];
    assert.equal(record.format, 'feishu-card');
    assert.ok(record.bytes > 0 && record.bytes <= record.limit, `byte accounting must be recorded (${record.bytes}/${record.limit})`);
    assert.equal(JSON.parse(record.request_body).card.schema, '2.0');
  } finally {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('card: the alert payload feeds the card through the real alert record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-card-alert-'));
  const file = join(root, 'alerts.jsonl');
  try {
    mkdirSync(root, { recursive: true });
    const recorded = recordBoundaryAlert({
      canonicalDir: root,
      casDir: '/srv/cas',
      taskId: 'TASK-CARD-ALERT',
      reason: 'scope-anomaly',
      scopeDecision: { decision: 'RETAIN', reason: 'scope-anomaly', attempts: 4, quiesceConfirmed: true, anomalies: [{ class: 'broken-scope', code: 'ENOENT' }] },
      file,
    });
    const payload = buildNotifyPayload({
      event: 'boundary_retained',
      alert: { canonical_dir: root, cas_dir: '/srv/cas', task_id: 'TASK-CARD-ALERT', alert_id: recorded.alert_id, occurrences: recorded.occurrences, severity: recorded.severity, boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY', reason: 'scope-anomaly' },
      scopeDecision: { decision: 'RETAIN', reason: 'scope-anomaly', attempts: 4, anomalies: [{ class: 'broken-scope' }] },
    });
    const { card, state } = buildFeishuCard({ event: 'boundary_retained', payload });
    assert.equal(state, 'retained');
    const text = cardText(card);
    assert.ok(text.includes(recorded.alert_id), 'the card carries the real alert id');
    assert.match(text, /本次扫描 4 次/);
    assert.match(text, /broken-scope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('card retry: an unconfirmable 200 response is never counted as delivered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-card-retry-receipt-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await mockServer({ status: 500, reply: '{"code":1,"msg":"down"}' });
  // The retry target answers 200 but carries NO provider status code.
  const unconfirmable = await mockServer({ status: 200, reply: '{"ok":true}' });
  const alert = { canonical_dir: root, cas_dir: '/cas', task_id: 'T', alert_id: 'AF-RETRY-NOCODE', occurrences: 1, severity: 'warning', boundary_state: 'PROTECTION_RETAINED_PENDING_RETRY', reason: 'scope-anomaly' };
  try {
    await withEnv({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0',
    }, async () => {
      const first = await notifyBoundaryAlert({ event: 'boundary_retained', alert });
      assert.equal(first.status, 'failed');
    });
    assert.equal(inspectPendingNotifications({ file }).pending.length, 1, 'the failed card must be queued');

    await withEnv({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card',
      AF_BOUNDARY_NOTIFY_WEBHOOK: unconfirmable.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0',
    }, async () => {
      const res = await flushPendingNotifications({ file, force: true });
      assert.equal(res.attempted, 1);
      assert.equal(res.delivered, 0, 'a 200 without a provider code must never be delivered for a card');
      assert.equal(res.failed, 1);
    });
    assert.equal(unconfirmable.requests.length, 1, 'the retry did reach the provider');
    const events = readNotifyEvents({ file });
    assert.equal(events.some((e) => e.status === 'sent'), false, 'no success may be audited for the retry');
    assert.equal(events.some((e) => /cannot be confirmed/.test(e.reason ?? '')), true, 'the unconfirmable receipt must be recorded');
    const pending = inspectPendingNotifications({ file }).pending;
    assert.equal(pending.length, 1, 'the entry stays retryable');
    assert.equal(pending[0].state, 'pending');
    assert.match(pending[0].last_error, /cannot be confirmed/);
  } finally {
    await failing.close();
    await unconfirmable.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('card retry: an oversized retry settles its claim, sends nothing and does not throw', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-card-retry-size-'));
  const file = join(root, 'alerts.jsonl');
  const failing = await mockServer({ status: 500, reply: '{"code":1,"msg":"down"}' });
  const healthy = await mockServer({ reply: '{"code":0,"msg":"success"}' });
  const alert = { canonical_dir: root, cas_dir: '/cas', task_id: 'T', alert_id: 'AF-RETRY-BIG', occurrences: 1, severity: 'warning', boundary_state: 'PROTECTION_RETAINED_PENDING_RETRY', reason: 'scope-anomaly' };
  try {
    await withEnv({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card',
      AF_BOUNDARY_NOTIFY_WEBHOOK: failing.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0',
    }, async () => {
      const first = await notifyBoundaryAlert({ event: 'boundary_retained', alert });
      assert.equal(first.status, 'failed');
    });

    // The retry body (about 1.1 KB) is now above the configured limit.
    await withEnv({
      AF_BOUNDARY_ALERTS_FILE: file, AF_BOUNDARY_NOTIFY_MODE: 'live', AF_BOUNDARY_NOTIFY_FORMAT: 'feishu-card',
      AF_BOUNDARY_NOTIFY_WEBHOOK: healthy.url, AF_BOUNDARY_NOTIFY_COOLDOWN_MS: '0',
      AF_BOUNDARY_NOTIFY_MAX_BODY_BYTES: '300',
    }, async () => {
      const res = await flushPendingNotifications({ file, force: true });
      assert.equal(res.attempted, 1, 'the attempt is accounted for');
      assert.equal(res.delivered, 0);
      assert.equal(res.failed, 1);
    });
    assert.equal(healthy.requests.length, 0, 'an oversized retry must make zero network requests');

    const pending = inspectPendingNotifications({ file }).pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].claimed_at, null, 'the claim must be settled, not left in flight');
    assert.equal(pending[0].claim_token, null);
    assert.match(pending[0].last_error, /exceeds the limit of 300/);
    assert.equal(pending[0].attempts, 2, 'the failed retry is counted');
    const events = readNotifyEvents({ file });
    assert.equal(events.some((e) => e.status === 'oversized-request-body'), true, 'the refusal must be audited');
    assert.equal(events.some((e) => e.status === 'sent'), false);
  } finally {
    await failing.close();
    await healthy.close();
    rmSync(root, { recursive: true, force: true });
  }
});
