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

export function notifyMaxAttempts() {
  const raw = Number(process.env.AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS ?? 5);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 5;
}

export function notifyRetryBaseMs() {
  const raw = Number(process.env.AF_BOUNDARY_NOTIFY_RETRY_BASE_MS ?? 60000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
}

export function notifyRetryMaxMs() {
  const raw = Number(process.env.AF_BOUNDARY_NOTIFY_RETRY_MAX_MS ?? 30 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

/** Bounded exponential backoff after `attempts` failures. */
export function notifyBackoffMs(attempts) {
  const base = notifyRetryBaseMs();
  const capped = Math.min(base * (2 ** Math.max(0, attempts - 1)), notifyRetryMaxMs());
  return capped;
}

/** Queue of deliveries that still need to be attempted (survives a restart). */
export function notifyPendingFile(file = boundaryAlertsFile()) {
  return `${file}.notify-pending.json`;
}

/** How long a delivery claim stays valid before a crashed claim can be retaken. */
export function notifyClaimTtlMs() {
  const raw = Number(process.env.AF_BOUNDARY_NOTIFY_CLAIM_TTL_MS ?? 60000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
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

function digestPath(p) {
  return `sha256:${createHash('sha256').update(p).digest('hex').slice(0, 16)}`;
}

/** Redact a path to a stable digest when paths must not leave the host. */
function pathFor(payloadPath) {
  if (!payloadPath) return null;
  if (includePaths()) return payloadPath;
  return digestPath(payloadPath);
}

/**
 * Remove credentials and targets from any text that is about to be stored or returned.
 * Provider error messages echo what was sent (they can contain the webhook URL or the
 * token), and fetch errors can embed the URL, so every recorded string goes through here.
 */
export function redactSecrets(text) {
  if (text === null || text === undefined) return text;
  let out = String(text);
  const secrets = [
    process.env.AF_BOUNDARY_NOTIFY_WEBHOOK,
    process.env.AF_BOUNDARY_NOTIFY_TOKEN,
    process.env.AF_BOUNDARY_NOTIFY_FEISHU_SECRET,
  ].filter((v) => typeof v === 'string' && v.length > 0);
  for (const secret of secrets) out = out.split(secret).join('<redacted>');
  out = out.replace(/https?:\/\/[^\s"'<>]+/g, '<redacted-url>');
  out = out.replace(/\b(access_token|token|sign|secret|key)=([A-Za-z0-9._-]+)/gi, '$1=<redacted>');
  out = out.replace(/\btk_[A-Za-z0-9]+\b/g, '<redacted-token>');
  return out.slice(0, 500);
}

/** Apply the same path policy to free text (a reason can quote a path). */
function redactPathsInText(text, paths) {
  if (!text) return text;
  if (includePaths()) return text;
  let out = String(text);
  for (const p of paths.filter(Boolean)) out = out.split(p).join(digestPath(p));
  // Any remaining absolute-looking path is replaced by its digest.
  out = out.replace(/\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/g, (m) => digestPath(m));
  return out;
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
    reason: redactPathsInText(alert.reason ?? null, [alert.canonical_dir, alert.cas_dir]),
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

    // The dedupe key is scoped by mode: a dry-run must never consume the live cooldown.
    const key = `${mode}|${alert.canonical_dir}|${released ? 'released' : (escalated ? 'escalated' : 'first')}`;
    const payload = buildNotifyPayload({ event, alert, scopeDecision });
    const stateFile = notifyStateFile(file);
    const cooldown = notifyCooldownMs();
    const claimTtl = notifyClaimTtlMs();

    // One atomic critical section: re-check the cooldown AND claim the delivery. A second
    // concurrent caller therefore sees the claim and is suppressed instead of sending twice.
    const gate = withBoundaryAlertLock(file, () => {
      const state = readNotifyState(stateFile);
      const previous = state[key];
      const now = Date.now();
      const cooldownActive = previous?.last_sent_at && cooldown > 0 && now - Date.parse(previous.last_sent_at) < cooldown;
      if (cooldownActive) {
        const reason = `cooldown ${cooldown}ms not elapsed since ${previous.last_sent_at}`;
        appendNotifyEvent(file, { event: 'boundary_notify', at: new Date().toISOString(), canonical_dir: alert.canonical_dir, alert_id: alert.alert_id ?? null, notify_key: key, status: 'suppressed', mode, reason });
        return { suppressed: true, reason: 'cooldown' };
      }
      const claimFresh = previous?.claimed_at && now - Date.parse(previous.claimed_at) < claimTtl;
      if (claimFresh) {
        const reason = `delivery already claimed at ${previous.claimed_at}`;
        appendNotifyEvent(file, { event: 'boundary_notify', at: new Date().toISOString(), canonical_dir: alert.canonical_dir, alert_id: alert.alert_id ?? null, notify_key: key, status: 'suppressed', mode, reason });
        return { suppressed: true, reason: 'concurrent-claim' };
      }
      state[key] = {
        ...(previous ?? {}),
        claimed_at: new Date().toISOString(),
        mode,
        format: notifyFormat(),
        alert_id: alert.alert_id ?? null,
        attempts: (previous?.attempts ?? 0) + 1,
      };
      writeNotifyState(stateFile, state);
      return { suppressed: false, reason: null };
    });

    if (gate.suppressed) return { status: 'suppressed', reason: gate.reason, mode, key };

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
        state[key] = { ...(state[key] ?? {}), claimed_at: null, last_sent_at: new Date().toISOString(), last_status: 'would-notify' };
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
    let responseUnreadable = false;
    let request = null;
    try {
      request = buildNotifyRequest({ event, payload });
      const headers = { ...request.headers };
      if (process.env.AF_BOUNDARY_NOTIFY_TOKEN) headers.authorization = `Bearer ${process.env.AF_BOUNDARY_NOTIFY_TOKEN}`;
      const response = await doFetch(webhook, { method: 'POST', headers, body: request.body, signal: controller.signal });
      httpStatus = response?.status ?? null;
      if (!response?.ok) error = `non-2xx response: ${httpStatus}`;
      // Chat providers answer HTTP 200 for rejected messages (Feishu uses `code`,
      // DingTalk/WeCom `errcode`), so a 2xx alone does not mean delivered. When the body
      // cannot be read or parsed, delivery is UNVERIFIABLE for those providers and must
      // not be recorded as sent.
      if (!error) {
        const providerRequiresCode = ['feishu', 'dingtalk', 'wecom'].includes(request.format);
        let rawBody = null;
        if (typeof response?.text === 'function') {
          try { rawBody = await response.text(); } catch { rawBody = null; responseUnreadable = true; }
        } else {
          responseUnreadable = true;
        }
        if (responseUnreadable) {
          if (providerRequiresCode) error = 'response body could not be read; delivery cannot be confirmed';
        } else if (rawBody) {
          try {
            const parsed = JSON.parse(rawBody);
            const code = parsed?.code ?? parsed?.errcode ?? parsed?.StatusCode ?? null;
            if (code === null) {
              if (providerRequiresCode) error = 'response body carried no provider status code; delivery cannot be confirmed';
            } else if (Number(code) !== 0) {
              providerCode = Number(code);
              providerMessage = redactSecrets(String(parsed?.msg ?? parsed?.errmsg ?? parsed?.StatusMessage ?? ''));
              error = `provider rejected the message: code=${providerCode} ${providerMessage}`;
            }
          } catch {
            if (providerRequiresCode) error = 'response body was not JSON; delivery cannot be confirmed';
          }
        } else if (providerRequiresCode) {
          error = 'response body was empty; delivery cannot be confirmed';
        }
      }
    } catch (err) {
      error = err?.name === 'AbortError' ? `timeout after ${notifyTimeoutMs()}ms` : String(err?.message ?? err);
    } finally {
      clearTimeout(timer);
    }

    const status = error ? 'failed' : 'sent';
    const safeError = error ? redactSecrets(error) : null;
    if (status === 'failed' && request) {
      // Persist the failed delivery so a bounded retry can resume it (even after a
      // restart). No URL or token is stored: the target is re-read from the environment.
      enqueuePendingDelivery(file, { key, alert, request, error, format: request.format, mode });
    }
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
        reason: safeError,
        format: notifyFormat(),
        payload,
        request_body: buildNotifyRequest({ event, payload }).body,
      });
      {
        const state = readNotifyState(stateFile);
        state[key] = {
          ...(state[key] ?? {}),
          claimed_at: null,
          last_attempt_at: new Date().toISOString(),
          last_sent_at: status === 'sent' ? new Date().toISOString() : state[key]?.last_sent_at ?? null,
          last_status: status,
          http_status: httpStatus,
          attempts: state[key]?.attempts ?? 1,
        };
        writeNotifyState(stateFile, state);
      }
    });
    return { status, reason: safeError, mode, key, http_status: httpStatus, provider_code: providerCode, provider_message: providerMessage };
  } catch (err) {
    return { status: 'failed', reason: redactSecrets(`notify error: ${err?.message ?? err}`), mode: notifyMode(), key: null };
  }
}

function readPending(file) {
  const pendingFile = notifyPendingFile(file);
  if (!existsSync(pendingFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(pendingFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePending(file, pending) {
  const pendingFile = notifyPendingFile(file);
  mkdirSync(dirname(pendingFile), { recursive: true });
  writeFileSync(pendingFile, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Deliveries that failed and are still pending or have exhausted their attempts.
 * Visible without depending on the (possibly broken) webhook.
 *
 * @param {object} [options]
 * @returns {object[]}
 */
export function listPendingNotifications({ file = boundaryAlertsFile(), includeDelivered = false } = {}) {
  return Object.values(readPending(file))
    .filter((entry) => includeDelivered || entry.state !== 'delivered')
    .sort((a, b) => String(a.next_attempt_at).localeCompare(String(b.next_attempt_at)));
}

/** Record a failed live delivery for a later, bounded retry (no URL or token is stored). */
function enqueuePendingDelivery(file, { key, alert, request, error, format, mode }) {
  const pending = readPending(file);
  const previous = pending[key] ?? {};
  const attempts = (previous.attempts ?? 0) + 1;
  const maxAttempts = notifyMaxAttempts();
  const exhausted = attempts >= maxAttempts;
  pending[key] = {
    notify_key: key,
    canonical_dir: alert.canonical_dir,
    cas_dir: alert.cas_dir ?? null,
    task_id: alert.task_id ?? null,
    alert_id: alert.alert_id ?? null,
    format,
    mode,
    request_body: request.body,
    request_headers: request.headers,
    attempts,
    max_attempts: maxAttempts,
    state: exhausted ? 'exhausted' : 'pending',
    first_failed_at: previous.first_failed_at ?? new Date().toISOString(),
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: exhausted ? null : new Date(Date.now() + notifyBackoffMs(attempts)).toISOString(),
    last_error: redactSecrets(error),
  };
  writePending(file, pending);
  return pending[key];
}

/**
 * Attempt every due retry. Intended to be run by a timer/cron, or by hand after a
 * restart: because the queue is on disk, a new process resumes where the old one stopped.
 *
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.now]
 * @param {boolean} [options.force] - attempt even when next_attempt_at is in the future.
 * @returns {Promise<{ due: number, attempted: number, delivered: number, failed: number, exhausted: number, skipped: string|null }>}
 */
export async function flushPendingNotifications({ file = boundaryAlertsFile(), fetchImpl = null, now = Date.now(), force = false } = {}) {
  const mode = notifyMode();
  if (mode !== 'live') return { due: 0, attempted: 0, delivered: 0, failed: 0, exhausted: 0, skipped: `mode=${mode}: retries only run in live mode` };
  const webhook = notifyWebhook();
  if (!webhook) return { due: 0, attempted: 0, delivered: 0, failed: 0, exhausted: 0, skipped: 'AF_BOUNDARY_NOTIFY_WEBHOOK is not configured' };

  const dueEntries = listPendingNotifications({ file }).filter((e) => e.state === 'pending'
    && (force || (e.next_attempt_at && Date.parse(e.next_attempt_at) <= now)));
  const result = { due: dueEntries.length, attempted: 0, delivered: 0, failed: 0, exhausted: 0, skipped: null };
  const doFetch = fetchImpl ?? globalThis.fetch;

  for (const entry of dueEntries) {
    result.attempted += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), notifyTimeoutMs());
    let httpStatus = null;
    let providerCode = null;
    let error = null;
    try {
      const headers = { ...(entry.request_headers ?? {}) };
      if (process.env.AF_BOUNDARY_NOTIFY_TOKEN) headers.authorization = `Bearer ${process.env.AF_BOUNDARY_NOTIFY_TOKEN}`;
      const response = await doFetch(webhook, { method: 'POST', headers, body: entry.request_body, signal: controller.signal });
      httpStatus = response?.status ?? null;
      if (!response?.ok) error = `non-2xx response: ${httpStatus}`;
      if (!error) {
        const providerRequiresCode = ['feishu', 'dingtalk', 'wecom'].includes(entry.format);
        let rawBody = null;
        try { rawBody = await response.text(); } catch { rawBody = null; }
        if (rawBody === null) { if (providerRequiresCode) error = 'response body could not be read; delivery cannot be confirmed'; }
        else {
          try {
            const parsed = JSON.parse(rawBody);
            const code = parsed?.code ?? parsed?.errcode ?? parsed?.StatusCode ?? null;
            if (code === null) { if (providerRequiresCode) error = 'response body carried no provider status code; delivery cannot be confirmed'; }
            else if (Number(code) !== 0) { providerCode = Number(code); error = `provider rejected the message: code=${providerCode}`; }
          } catch { if (providerRequiresCode) error = 'response body was not JSON; delivery cannot be confirmed'; }
        }
      }
    } catch (err) {
      error = err?.name === 'AbortError' ? `timeout after ${notifyTimeoutMs()}ms` : String(err?.message ?? err);
    } finally {
      clearTimeout(timer);
    }

    if (!error) {
      result.delivered += 1;
      withBoundaryAlertLock(file, () => {
        const pending = readPending(file);
        pending[entry.notify_key] = { ...pending[entry.notify_key], state: 'delivered', delivered_at: new Date().toISOString(), last_error: null };
        writePending(file, pending);
        const state = readNotifyState(notifyStateFile(file));
        state[entry.notify_key] = { ...(state[entry.notify_key] ?? {}), claimed_at: null, last_sent_at: new Date().toISOString(), last_status: 'sent', attempts: pending[entry.notify_key].attempts };
        writeNotifyState(notifyStateFile(file), state);
        appendNotifyEvent(file, { event: 'boundary_notify', at: new Date().toISOString(), canonical_dir: entry.canonical_dir, alert_id: entry.alert_id ?? null, notify_key: entry.notify_key, status: 'sent', mode, http_status: httpStatus, retry_attempt: entry.attempts, format: entry.format });
      });
    } else {
      result.failed += 1;
      const queued = withBoundaryAlertLock(file, () => {
        const pending = readPending(file);
        const attempts = (pending[entry.notify_key]?.attempts ?? entry.attempts) + 1;
        const maxAttempts = pending[entry.notify_key]?.max_attempts ?? notifyMaxAttempts();
        const exhausted = attempts >= maxAttempts;
        if (exhausted) result.exhausted += 1;
        pending[entry.notify_key] = {
          ...pending[entry.notify_key],
          attempts,
          max_attempts: maxAttempts,
          state: exhausted ? 'exhausted' : 'pending',
          last_attempt_at: new Date().toISOString(),
          last_error: redactSecrets(error),
          next_attempt_at: exhausted ? null : new Date(Date.now() + notifyBackoffMs(attempts)).toISOString(),
        };
        writePending(file, pending);
        appendNotifyEvent(file, { event: 'boundary_notify', at: new Date().toISOString(), canonical_dir: entry.canonical_dir, alert_id: entry.alert_id ?? null, notify_key: entry.notify_key, status: exhausted ? 'exhausted' : 'retry-scheduled', mode, http_status: httpStatus, provider_code: providerCode, reason: redactSecrets(error), next_attempt_at: pending[entry.notify_key].next_attempt_at, attempts, format: entry.format });
        return pending[entry.notify_key];
      });
      void queued;
    }
  }
  return result;
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
    max_attempts: notifyMaxAttempts(),
    retry_base_ms: notifyRetryBaseMs(),
    retry_max_ms: notifyRetryMaxMs(),
  };
}
