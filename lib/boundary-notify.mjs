// boundary-notify.mjs - A1b outbound notification for retained boundaries (generic webhook).
//
// SAFETY POSTURE (deliberate):
//   - default mode is `off`: nothing is built and nothing is sent;
//   - `dry-run` records exactly what WOULD be sent (into a dedicated notify log) and
//     never performs network I/O;
//   - `live` requires BOTH `AF_BOUNDARY_NOTIFY_MODE=live` and a configured
//     `AF_BOUNDARY_NOTIFY_WEBHOOK`; without either the call refuses and records why.
//   Nothing here can send an alert the operator has not authorised.
//
// Policy: notify on the FIRST retain for a path and again when it ESCALATES, with a
// per-(path, event) cooldown so a retry loop cannot spam. Release notifications are off
// unless AF_BOUNDARY_NOTIFY_ON_RELEASE=1.
//
// Egress note: the payload carries the canonical/CAS paths so the operator knows which
// repository is locked. AF_BOUNDARY_NOTIFY_INCLUDE_PATHS=0 redacts them to a digest.
//
// Delivery records live in `<alert log>.notify.jsonl`, separate from the alert event log:
// the alert log stays strictly alert-state events, so its replay/validation is unaffected.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, createHmac } from 'node:crypto';

import { boundaryAlertsFile, withBoundaryAlertLock } from './boundary-alerts.mjs';

/** Notification mode: off | dry-run | live. */
export function notifyMode() {
  const raw = String(process.env.AF_BOUNDARY_NOTIFY_MODE ?? 'off').toLowerCase();
  return ['off', 'dry-run', 'live'].includes(raw) ? raw : 'off';
}

export function notifyWebhook() {
  return process.env.AF_BOUNDARY_NOTIFY_WEBHOOK || null;
}

/** Outbound body format: generic | feishu | dingtalk | wecom | slack | discord | ntfy. */
export function notifyFormat() {
  const raw = String(process.env.AF_BOUNDARY_NOTIFY_FORMAT ?? 'generic').toLowerCase();
  return ['generic', 'feishu', 'dingtalk', 'wecom', 'slack', 'discord', 'ntfy'].includes(raw) ? raw : 'generic';
}

export function notifyCooldownMs() {
  const raw = Number(process.env.AF_BOUNDARY_NOTIFY_COOLDOWN_MS ?? 15 * 60 * 1000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15 * 60 * 1000;
}

export function notifyTimeoutMs() {
  const raw = Number(process.env.AF_BOUNDARY_NOTIFY_TIMEOUT_MS ?? 5000);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

function includePaths() {
  return String(process.env.AF_BOUNDARY_NOTIFY_INCLUDE_PATHS ?? '1') !== '0';
}

function notifyOnRelease() {
  return String(process.env.AF_BOUNDARY_NOTIFY_ON_RELEASE ?? '0') === '1';
}

/** Append-only delivery log (separate from the alert state log). */
export function notifyLogFile(file = boundaryAlertsFile()) {
  return `${file}.notify.jsonl`;
}

function notifyStateFile(file = boundaryAlertsFile()) {
  return `${file}.notify.json`;
}

/** Delivery records, newest last (torn lines are skipped, they never gate state). */
export function readNotifyEvents({ file = boundaryAlertsFile() } = {}) {
  const log = notifyLogFile(file);
  if (!existsSync(log)) return [];
  const out = [];
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

function appendNotifyEvent(file, record) {
  const log = notifyLogFile(file);
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify(record)}\n`);
}

function readNotifyState(stateFile) {
  if (!existsSync(stateFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // a damaged dedupe index only weakens suppression, never delivery
  }
}

function writeNotifyState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Redact a path to a stable digest when paths must not leave the host. */
function pathFor(payloadPath) {
  if (!payloadPath) return null;
  if (includePaths()) return payloadPath;
  return `sha256:${createHash('sha256').update(payloadPath).digest('hex').slice(0, 16)}`;
}

/**
 * Build the outbound payload for one alert event.
 *
 * @param {object} params
 * @param {'boundary_retained'|'boundary_released'} params.event
 * @param {object} params.alert
 * @param {object} [params.scopeDecision]
 * @returns {object}
 */
export function buildNotifyPayload({ event, alert, scopeDecision = null }) {
  const decision = scopeDecision ?? alert.scope_decision ?? null;
  return {
    schema: 'af-boundary-alert-v1',
    event,
    alert_id: alert.alert_id ?? null,
    severity: alert.severity ?? 'warning',
    occurrences: alert.occurrences ?? 0,
    canonical_dir: pathFor(alert.canonical_dir),
    cas_dir: pathFor(alert.cas_dir),
    task_id: alert.task_id ?? null,
    boundary_state: alert.boundary_state ?? null,
    reason: alert.reason ?? null,
    scope_decision: decision
      ? {
        decision: decision.decision ?? null,
        reason: decision.reason ?? null,
        attempts: decision.attempts ?? null,
        quiesce_confirmed: decision.quiesce_confirmed ?? null,
        anomalies: (decision.anomalies ?? []).map((a) => (typeof a === 'string' ? a : a.class)),
      }
      : null,
    at: new Date().toISOString(),
    source: 'agent-foundry-next/boundary-alerts',
  };
}

/** One-line summary used by every chat format. */
function notifyText(event, payload) {
  const lines = [
    `【Agent Foundry 边界保留告警】${event === 'boundary_released' ? '（已释放）' : ''}`,
    `级别: ${payload.severity}${payload.occurrences ? `（连续第 ${payload.occurrences} 次）` : ''}`,
    `仓库: ${payload.canonical_dir ?? 'n/a'}`,
    `CAS: ${payload.cas_dir ?? 'n/a'}`,
    `任务: ${payload.task_id ?? 'n/a'}`,
    `状态: ${payload.boundary_state ?? 'n/a'}`,
    `原因: ${payload.reason ?? 'n/a'}`,
  ];
  if (payload.scope_decision) {
    lines.push(`scope 决策: ${payload.scope_decision.decision} / ${payload.scope_decision.reason} / attempts=${payload.scope_decision.attempts ?? 'n/a'}`);
    if (payload.scope_decision.anomalies?.length) lines.push(`异常类别: ${payload.scope_decision.anomalies.join(', ')}`);
  }
  lines.push(`时间: ${payload.at}`);
  return lines.join('\n');
}

/** Feishu (Lark) custom-bot signature: base64(hmac_sha256(key = `${ts}\\n${secret}`, data = "")). */
function feishuSign(timestampSeconds, secret) {
  return createHmac('sha256', `${timestampSeconds}\n${secret}`).update('').digest('base64');
}

/**
 * Render the outbound HTTP request for the configured chat format.
 *
 * @param {object} params
 * @param {'boundary_retained'|'boundary_released'} params.event
 * @param {object} params.payload - canonical alert payload (see buildNotifyPayload).
 * @param {string} [params.format]
 * @param {number} [params.now] - clock injection for deterministic signature tests.
 * @returns {{ headers: object, body: string, format: string }}
 */
export function buildNotifyRequest({ event, payload, format = notifyFormat(), now = Date.now() } = {}) {
  const text = notifyText(event, payload);
  const json = (body, extraHeaders = {}) => ({
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: JSON.stringify(body),
    format,
  });

  switch (format) {
    case 'feishu': {
      const body = { msg_type: 'text', content: { text } };
      const secret = process.env.AF_BOUNDARY_NOTIFY_FEISHU_SECRET;
      if (secret) {
        const ts = String(Math.floor(now / 1000));
        body.timestamp = ts;
        body.sign = feishuSign(ts, secret);
      }
      return json(body);
    }
    case 'dingtalk':
    case 'wecom':
      return json({ msgtype: 'text', text: { content: text } });
    case 'slack':
      return json({ text });
    case 'discord':
      return json({ content: text });
    case 'ntfy':
      return {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          title: process.env.AF_BOUNDARY_NOTIFY_TITLE || 'Agent Foundry 边界保留告警',
          priority: payload.severity === 'escalated' ? 'urgent' : 'high',
          tags: 'warning',
        },
        body: text,
        format,
      };
    default:
      return json(payload);
  }
}

/**
 * Decide whether this event should be delivered, and deliver it when authorised.
 *
 * Never throws into the caller: a notification failure is recorded and returned.
 * The alert-file lock is only held for the short state read/update; the network call
 * happens outside it.
 *
 * @param {object} params
 * @param {'boundary_retained'|'boundary_released'} params.event
 * @param {object} params.alert - { canonical_dir, alert_id, occurrences, severity, ... }
 * @param {object} [params.scopeDecision]
 * @param {string} [params.file]
 * @param {Function} [params.fetchImpl] - injectable transport (tests use a local mock).
 * @returns {Promise<{ status: 'sent'|'would-notify'|'suppressed'|'failed'|'disabled', reason: string|null, mode: string, key: string|null, http_status?: number|null }>}
 */
export async function notifyBoundaryAlert({
  event,
  alert,
  scopeDecision = null,
  file = boundaryAlertsFile(),
  fetchImpl = null,
} = {}) {
  try {
    const mode = notifyMode();
    if (mode === 'off') return { status: 'disabled', reason: 'AF_BOUNDARY_NOTIFY_MODE=off', mode, key: null };
    if (!alert?.canonical_dir) return { status: 'failed', reason: 'alert.canonical_dir is required', mode, key: null };

    const occurrences = alert.occurrences ?? 0;
    const threshold = Number(process.env.AF_BOUNDARY_ALERT_ESCALATE_AFTER ?? 3);
    const firstRetain = event === 'boundary_retained' && occurrences === 1;
    const escalated = event === 'boundary_retained' && occurrences >= threshold;
    const released = event === 'boundary_released';

    if (released && !notifyOnRelease()) {
      return { status: 'suppressed', reason: 'policy: release notifications disabled', mode, key: null };
    }
    if (!firstRetain && !escalated && !released) {
      return { status: 'suppressed', reason: 'policy: not the first retain nor an escalation', mode, key: null };
    }

    const key = `${alert.canonical_dir}|${released ? 'released' : (escalated ? 'escalated' : 'first')}`;
    const payload = buildNotifyPayload({ event, alert, scopeDecision });
    const stateFile = notifyStateFile(file);
    const cooldown = notifyCooldownMs();

    // Short critical section: decide, then record a suppression if the cooldown holds.
    const gate = withBoundaryAlertLock(file, () => {
      const state = readNotifyState(stateFile);
      const previous = state[key];
      if (previous?.last_sent_at && cooldown > 0 && Date.now() - Date.parse(previous.last_sent_at) < cooldown) {
        const reason = `cooldown ${cooldown}ms not elapsed since ${previous.last_sent_at}`;
        appendNotifyEvent(file, {
          event: 'boundary_notify',
          at: new Date().toISOString(),
          canonical_dir: alert.canonical_dir,
          alert_id: alert.alert_id ?? null,
          notify_key: key,
          status: 'suppressed',
          mode,
          reason,
        });
        return { suppressed: true, reason };
      }
      return { suppressed: false, reason: null };
    });

    if (gate.suppressed) return { status: 'suppressed', reason: 'cooldown', mode, key };

    if (mode === 'dry-run') {
      withBoundaryAlertLock(file, () => {
        appendNotifyEvent(file, {
          event: 'boundary_notify',
          at: new Date().toISOString(),
          canonical_dir: alert.canonical_dir,
          alert_id: alert.alert_id ?? null,
          notify_key: key,
          status: 'would-notify',
          mode,
          target_configured: Boolean(notifyWebhook()),
          format: notifyFormat(),
          payload,
          request_body: buildNotifyRequest({ event, payload }).body,
        });
        const state = readNotifyState(stateFile);
        state[key] = { last_sent_at: new Date().toISOString(), last_status: 'would-notify' };
        writeNotifyState(stateFile, state);
      });
      return { status: 'would-notify', reason: null, mode, key };
    }

    // mode === 'live': explicitly authorised by the operator.
    const webhook = notifyWebhook();
    if (!webhook) {
      const reason = 'AF_BOUNDARY_NOTIFY_MODE=live but AF_BOUNDARY_NOTIFY_WEBHOOK is not configured';
      withBoundaryAlertLock(file, () => {
        appendNotifyEvent(file, {
          event: 'boundary_notify',
          at: new Date().toISOString(),
          canonical_dir: alert.canonical_dir,
          alert_id: alert.alert_id ?? null,
          notify_key: key,
          status: 'failed',
          mode,
          reason,
        });
      });
      return { status: 'failed', reason, mode, key };
    }

    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') return { status: 'failed', reason: 'no fetch implementation available', mode, key };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), notifyTimeoutMs());
    let httpStatus = null;
    let error = null;
    let providerCode = null;
    let providerMessage = null;
    try {
      const request = buildNotifyRequest({ event, payload });
      const headers = { ...request.headers };
      if (process.env.AF_BOUNDARY_NOTIFY_TOKEN) headers.authorization = `Bearer ${process.env.AF_BOUNDARY_NOTIFY_TOKEN}`;
      const response = await doFetch(webhook, { method: 'POST', headers, body: request.body, signal: controller.signal });
      httpStatus = response?.status ?? null;
      if (!response?.ok) error = `non-2xx response: ${httpStatus}`;
      // Chat providers answer HTTP 200 for rejected messages (Feishu uses `code`,
      // DingTalk/WeCom `errcode`), so a 2xx alone does not mean delivered.
      if (!error && typeof response?.text === 'function') {
        let rawBody = '';
        try { rawBody = await response.text(); } catch { rawBody = ''; }
        if (rawBody) {
          try {
            const parsed = JSON.parse(rawBody);
            const code = parsed?.code ?? parsed?.errcode ?? parsed?.StatusCode ?? null;
            if (code !== null && Number(code) !== 0) {
              providerCode = Number(code);
              providerMessage = String(parsed?.msg ?? parsed?.errmsg ?? parsed?.StatusMessage ?? '').slice(0, 200);
              error = `provider rejected the message: code=${providerCode} ${providerMessage}`;
            }
          } catch { /* non-JSON body: the HTTP status is all we have */ }
        }
      }
    } catch (err) {
      error = err?.name === 'AbortError' ? `timeout after ${notifyTimeoutMs()}ms` : String(err?.message ?? err);
    } finally {
      clearTimeout(timer);
    }

    const status = error ? 'failed' : 'sent';
    withBoundaryAlertLock(file, () => {
      appendNotifyEvent(file, {
        event: 'boundary_notify',
        at: new Date().toISOString(),
        canonical_dir: alert.canonical_dir,
        alert_id: alert.alert_id ?? null,
        notify_key: key,
        status,
        mode,
        http_status: httpStatus,
        provider_code: providerCode,
        provider_message: providerMessage,
        reason: error,
        format: notifyFormat(),
        payload,
        request_body: buildNotifyRequest({ event, payload }).body,
      });
      if (status === 'sent') {
        const state = readNotifyState(stateFile);
        state[key] = { last_sent_at: new Date().toISOString(), last_status: 'sent', http_status: httpStatus };
        writeNotifyState(stateFile, state);
      }
    });
    return { status, reason: error, mode, key, http_status: httpStatus, provider_code: providerCode, provider_message: providerMessage };
  } catch (err) {
    return { status: 'failed', reason: `notify error: ${err?.message ?? err}`, mode: notifyMode(), key: null };
  }
}

/** Describe the current notification configuration without disclosing the target. */
export function describeNotifyConfig() {
  const webhook = notifyWebhook();
  return {
    mode: notifyMode(),
    format: notifyFormat(),
    webhook_configured: Boolean(webhook),
    webhook_host: webhook ? (() => { try { return new URL(webhook).host; } catch { return 'invalid-url'; } })() : null,
    cooldown_ms: notifyCooldownMs(),
    timeout_ms: notifyTimeoutMs(),
    include_paths: includePaths(),
    on_release: notifyOnRelease(),
    token_configured: Boolean(process.env.AF_BOUNDARY_NOTIFY_TOKEN),
    feishu_signature_configured: Boolean(process.env.AF_BOUNDARY_NOTIFY_FEISHU_SECRET),
  };
}
