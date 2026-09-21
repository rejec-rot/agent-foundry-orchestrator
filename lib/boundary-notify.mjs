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

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';

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
    const kind = released ? 'released' : (escalated ? 'escalated' : 'first');
    // Cooldown groups by PATH; the delivery budget groups by EVENT (alert_id), so a new
    // alert never inherits the attempts of a previous one.
    const cooldownKey = `${mode}|${alert.canonical_dir}|${kind}`;
    const key = `${mode}|${alert.alert_id ?? alert.canonical_dir}|${kind}`;
    const payload = buildNotifyPayload({ event, alert, scopeDecision });
    const stateFile = notifyStateFile(file);
    const cooldown = notifyCooldownMs();

    const record = (fields) => withBoundaryAlertLock(file, () => {
      appendNotifyEvent(file, {
        event: 'boundary_notify',
        at: new Date().toISOString(),
        canonical_dir: alert.canonical_dir,
        alert_id: alert.alert_id ?? null,
        notify_key: key,
        mode,
        ...fields,
      });
    });

    if (mode === 'dry-run') {
      // Dry-run only touches the dedupe index (mode-scoped), never the retry queue.
      const dryGate = withBoundaryAlertLock(file, () => {
        const state = readNotifyState(stateFile);
        const previous = state[cooldownKey];
        if (previous?.last_sent_at && cooldown > 0 && Date.now() - Date.parse(previous.last_sent_at) < cooldown) {
          return { suppressed: true, reason: `cooldown ${cooldown}ms not elapsed since ${previous.last_sent_at}` };
        }
        state[cooldownKey] = { ...(previous ?? {}), claimed_at: null, last_sent_at: new Date().toISOString(), last_status: 'would-notify' };
        writeNotifyState(stateFile, state);
        return { suppressed: false, reason: null };
      });
      if (dryGate.suppressed) {
        record({ status: 'suppressed', reason: dryGate.reason });
        return { status: 'suppressed', reason: 'cooldown', mode, key };
      }
      record({ status: 'would-notify', target_configured: Boolean(notifyWebhook()), format: notifyFormat(), payload, request_body: buildNotifyRequest({ event, payload }).body });
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

    // Unified state machine: cap check, cooldown and the atomic claim happen together,
    // and the attempt counter is shared with the retry flush.
    const begin = beginDelivery(file, { key, cooldownKey, event, alert, payload, format: notifyFormat(), mode });
    if (!begin.proceed) {
      const budget = String(begin.reason).startsWith('retry budget exhausted') || String(begin.reason).startsWith('queue unverifiable');
      record({ status: budget ? 'failed' : 'suppressed', reason: begin.reason });
      return { status: budget ? 'failed' : 'suppressed', reason: begin.reason, mode, key };
    }

    const request = buildNotifyRequest({ event, payload });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), notifyTimeoutMs());
    let httpStatus = null;
    let error = null;
    let providerCode = null;
    let providerMessage = null;
    let responseUnreadable = false;
    try {
      const headers = { ...request.headers };
      if (process.env.AF_BOUNDARY_NOTIFY_TOKEN) headers.authorization = `Bearer ${process.env.AF_BOUNDARY_NOTIFY_TOKEN}`;
      const response = await doFetch(webhook, { method: 'POST', headers, body: request.body, signal: controller.signal });
      httpStatus = response?.status ?? null;
      if (!response?.ok) error = `non-2xx response: ${httpStatus}`;
      // Chat providers answer HTTP 200 for rejected messages, and an unreadable body
      // cannot confirm delivery either.
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
    // Success settles (clears) the entry, so a previously failed attempt can never be
    // delivered a second time; failure persists the bounded retry state.
    const settled = finishDelivery(file, { key, claimToken: begin.claim_token, ok: !error, error, httpStatus, providerCode });
    record({
      status,
      retry_state: settled.state ?? null,
      http_status: httpStatus,
      provider_code: providerCode,
      provider_message: providerMessage,
      reason: safeError,
      format: request.format,
      payload,
      request_body: request.body,
      attempt: begin.attempts,
      max_attempts: begin.max_attempts,
    });
    return { status, reason: safeError, mode, key, http_status: httpStatus, provider_code: providerCode, provider_message: providerMessage, attempts: begin.attempts, max_attempts: begin.max_attempts };
  } catch (err) {
    return { status: 'failed', reason: redactSecrets(`notify error: ${err?.message ?? err}`), mode: notifyMode(), key: null };
  }
}

/**
 * Strict queue read. A queue that exists but cannot be read or parsed is UNVERIFIABLE:
 * it must never be reported as "nothing pending", because that would hide a stuck
 * delivery exactly like the alert-state bug did.
 *
 * @returns {{ ok: boolean, missing: boolean, pending: object, reason: string|null }}
 */
export function readPendingStrict({ file = boundaryAlertsFile() } = {}) {
  const pendingFile = notifyPendingFile(file);
  // Only a definite ENOENT means "no queue": a permission or I/O error is unverifiable.
  let stat = null;
  try {
    stat = statSync(pendingFile);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, missing: true, pending: {}, reason: null };
    return { ok: false, missing: false, pending: {}, reason: `retry queue cannot be inspected: ${err?.code ?? ''} ${err.message}` };
  }
  if (!stat.isFile()) return { ok: false, missing: false, pending: {}, reason: 'retry queue path is not a regular file' };

  let raw;
  try {
    raw = readFileSync(pendingFile, 'utf8');
  } catch (err) {
    return { ok: false, missing: false, pending: {}, reason: `retry queue unreadable: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, missing: false, pending: {}, reason: `retry queue is not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, missing: false, pending: {}, reason: 'retry queue is not an object' };
  }
  for (const [key, entry] of Object.entries(parsed)) {
    const problem = validatePendingEntry(key, entry);
    if (problem) return { ok: false, missing: false, pending: {}, reason: `retry queue entry ${key} ${problem}` };
  }
  return { ok: true, missing: false, pending: parsed, reason: null };
}

/** Full field validation: an entry that does not match the schema is unverifiable. */
function validatePendingEntry(key, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'is not an object';
  if (entry.notify_key !== key) return 'has a mismatched notify_key';
  if (!['boundary_retained', 'boundary_released'].includes(entry.event)) return 'has an unknown event';
  if (typeof entry.canonical_dir !== 'string' || entry.canonical_dir.length === 0) return 'has no canonical_dir';
  if (!['pending', 'exhausted'].includes(entry.state)) return `has an invalid state (${entry.state})`;
  if (!Number.isInteger(entry.attempts) || entry.attempts < 0) return 'has an invalid attempts counter';
  if (!Number.isInteger(entry.max_attempts) || entry.max_attempts < 1) return 'has an invalid max_attempts';
  if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) return 'has no payload';
  if (entry.next_attempt_at !== null && !Number.isFinite(Date.parse(entry.next_attempt_at))) return 'has an invalid next_attempt_at';
  if (entry.claimed_at !== null && entry.claimed_at !== undefined && !Number.isFinite(Date.parse(entry.claimed_at))) return 'has an invalid claimed_at';
  if (!['feishu', 'dingtalk', 'wecom', 'slack', 'discord', 'ntfy', 'generic'].includes(entry.format)) return `has an unknown format (${entry.format})`;
  return null;
}

/** Write the queue atomically so a crash cannot leave a half-written file. */
function writePendingAtomic(file, pending) {
  const pendingFile = notifyPendingFile(file);
  mkdirSync(dirname(pendingFile), { recursive: true });
  const tmp = `${pendingFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, pendingFile);
}

/**
 * Inspect the retry queue without collapsing "unknown" into "empty".
 *
 * @returns {{ ok: boolean, pending: object[], reason: string|null, file: string }}
 */
export function inspectPendingNotifications({ file = boundaryAlertsFile(), includeDelivered = false } = {}) {
  const q = readPendingStrict({ file });
  if (!q.ok) return { ok: false, pending: [], reason: q.reason, file: notifyPendingFile(file) };
  const pending = Object.values(q.pending)
    .filter((entry) => includeDelivered || entry.state !== 'delivered')
    .sort((a, b) => String(a.next_attempt_at).localeCompare(String(b.next_attempt_at)));
  return { ok: true, pending, reason: null, file: notifyPendingFile(file) };
}

/**
 * Deliveries that failed and are still pending or exhausted.
 * Throws when the queue is unverifiable: returning [] there would hide a stuck delivery.
 */
export function listPendingNotifications(options = {}) {
  const inspection = inspectPendingNotifications(options);
  if (!inspection.ok) {
    const err = new Error(`BOUNDARY_NOTIFY_QUEUE_UNVERIFIABLE: ${inspection.reason}`);
    err.code = 'BOUNDARY_NOTIFY_QUEUE_UNVERIFIABLE';
    throw err;
  }
  return inspection.pending;
}

function pendingEntryFor(q, key) {
  return q.pending[key] ?? null;
}

/**
 * Unified delivery state machine - the single place that claims an attempt.
 *
 * Both the normal notification entry and the retry flush go through this, so the
 * attempt counter, the retry cap, the claim and the backoff are shared. A second
 * concurrent caller (in either path) sees the fresh claim and is refused.
 *
 * @returns {{ proceed: boolean, reason: string|null, claim_token?: string, attempts?: number, max_attempts?: number }}
 */
export function beginDelivery(file, { key, cooldownKey = null, event, alert, payload, format, mode, allowEarly = false, now = Date.now() }) {
  return withBoundaryAlertLock(file, () => {
    const q = readPendingStrict({ file });
    if (!q.ok) return { proceed: false, reason: `queue unverifiable: ${q.reason}` };

    // Budgets are per DELIVERY EVENT (key), so a new alert never inherits the attempts of
    // a previous, already delivered one.
    const entry = pendingEntryFor(q, key);
    const maxAttempts = entry?.max_attempts ?? notifyMaxAttempts();
    const attempts = entry?.attempts ?? 0;
    if (entry?.state === 'exhausted' || attempts >= maxAttempts) {
      return { proceed: false, reason: `retry budget exhausted (${attempts}/${maxAttempts})` };
    }

    if (entry?.claimed_at && now - Date.parse(entry.claimed_at) < notifyClaimTtlMs()) {
      return { proceed: false, reason: 'concurrent-claim' };
    }

    // Retry backoff is shared by both entries: only an explicit operator action
    // (`allowEarly`, i.e. `notify-flush --force`) may shorten the wait - never the cap.
    const notBefore = entry?.next_attempt_at ? Date.parse(entry.next_attempt_at) : null;
    if (!allowEarly && notBefore !== null && notBefore > now) {
      return { proceed: false, reason: `backoff until ${entry.next_attempt_at}` };
    }

    // Cooldown is per PATH (cooldownKey), independent of the delivery-event budget.
    const groupKey = cooldownKey ?? key;
    const cooldown = notifyCooldownMs();
    const state = readNotifyState(notifyStateFile(file));
    const previousSent = state[groupKey];
    if (previousSent?.last_sent_at && cooldown > 0 && now - Date.parse(previousSent.last_sent_at) < cooldown) {
      return { proceed: false, reason: 'cooldown' };
    }

    const claimToken = randomUUID();
    q.pending[key] = {
      ...(entry ?? {}),
      notify_key: key,
      cooldown_key: groupKey,
      event,
      canonical_dir: alert.canonical_dir,
      cas_dir: alert.cas_dir ?? null,
      task_id: alert.task_id ?? null,
      alert_id: alert.alert_id ?? null,
      format,
      mode,
      payload,
      attempts: attempts + 1,
      max_attempts: maxAttempts,
      state: 'pending',
      first_attempt_at: entry?.first_attempt_at ?? new Date().toISOString(),
      first_failed_at: entry?.first_failed_at ?? null,
      claimed_at: new Date().toISOString(),
      claim_token: claimToken,
      last_error: entry?.last_error ?? null,
      next_attempt_at: entry?.next_attempt_at ?? null,
    };
    writePendingAtomic(file, q.pending);
    return { proceed: true, reason: null, claim_token: claimToken, attempts: attempts + 1, max_attempts: maxAttempts };
  });
}

/**
 * Settle one claimed attempt. Success CLEARS the entry (so a previously failed
 * attempt can never be delivered again); failure schedules the bounded retry.
 * Only the claim owner may settle.
 */
export function finishDelivery(file, { key, claimToken, ok, error = null, httpStatus = null, providerCode = null, now = Date.now() }) {
  return withBoundaryAlertLock(file, () => {
    const q = readPendingStrict({ file });
    if (!q.ok) return { settled: false, state: null, reason: q.reason };
    const entry = pendingEntryFor(q, key);
    if (!entry) return { settled: false, state: null, reason: 'entry missing' };
    if (claimToken && entry.claim_token !== claimToken) return { settled: false, state: entry.state, reason: 'claim ownership changed' };

    const at = new Date().toISOString();
    const stateFile = notifyStateFile(file);
    const state = readNotifyState(stateFile);
    const groupKey = entry.cooldown_key ?? key;

    if (ok) {
      // The delivery series is finished: the entry is removed so a later event on this
      // path starts from a clean budget, while the path-level cooldown is recorded.
      delete q.pending[key];
      writePendingAtomic(file, q.pending);
      state[groupKey] = { ...(state[groupKey] ?? {}), claimed_at: null, last_sent_at: at, last_status: 'sent', attempts: entry.attempts };
      writeNotifyState(stateFile, state);
      return { settled: true, state: 'delivered', reason: null };
    }

    const exhausted = entry.attempts >= entry.max_attempts;
    q.pending[key] = {
      ...entry,
      state: exhausted ? 'exhausted' : 'pending',
      claimed_at: null,
      claim_token: null,
      last_attempt_at: at,
      first_failed_at: entry.first_failed_at ?? at,
      last_error: redactSecrets(error),
      http_status: httpStatus,
      provider_code: providerCode,
      next_attempt_at: exhausted ? null : new Date(now + notifyBackoffMs(entry.attempts)).toISOString(),
    };
    writePendingAtomic(file, q.pending);
    state[groupKey] = { ...(state[groupKey] ?? {}), claimed_at: null, last_attempt_at: at, last_status: 'failed' };
    writeNotifyState(stateFile, state);
    return { settled: true, state: exhausted ? 'exhausted' : 'pending', reason: null };
  });
}

/**
 * Persist the terminal state of a delivery series whose budget is spent.
 *
 * This is the "the last attempt was claimed and then the process died" case: the outcome
 * of that attempt is UNKNOWN (the message may or may not have been delivered), so it is
 * recorded as such instead of being repeated forever. The attempt audit is preserved and
 * the active claim is released.
 *
 * @returns {{ ok: boolean, changed: boolean, reason: string|null }}
 */
export function finalizeExhaustedDelivery(file, { key, now = Date.now() } = {}) {
  return withBoundaryAlertLock(file, () => {
    const q = readPendingStrict({ file });
    if (!q.ok) return { ok: false, changed: false, reason: q.reason };
    const entry = pendingEntryFor(q, key);
    if (!entry) return { ok: false, changed: false, reason: 'entry missing' };
    if (entry.state === 'exhausted' && !entry.claimed_at) return { ok: true, changed: false, reason: null };

    const priorClaim = entry.claimed_at ?? null;
    const at = new Date(now).toISOString();
    q.pending[key] = {
      ...entry,
      state: 'exhausted',
      claimed_at: null,
      claim_token: null,
      next_attempt_at: null,
      outcome_unknown: Boolean(priorClaim) || entry.outcome_unknown === true,
      last_error: priorClaim
        ? redactSecrets(`last attempt (claimed ${priorClaim}) ended without settling: delivery outcome unknown`)
        : entry.last_error,
      terminal_at: at,
      terminal_reason: 'retry-budget-exhausted',
    };
    writePendingAtomic(file, q.pending);
    return { ok: true, changed: true, reason: null };
  });
}

/**
 * Attempt every due retry. Safe to run concurrently: each entry is claimed through
 * `beginDelivery()`, so two flushes cannot deliver the same entry twice.
 *
 * @returns {Promise<{ ok: boolean, due: number, attempted: number, delivered: number, failed: number, exhausted: number, skipped: string|null }>}
 */
export async function flushPendingNotifications({ file = boundaryAlertsFile(), fetchImpl = null, now = Date.now(), force = false } = {}) {
  const mode = notifyMode();
  if (mode !== 'live') return { ok: true, due: 0, attempted: 0, delivered: 0, failed: 0, exhausted: 0, skipped: `mode=${mode}: retries only run in live mode` };
  const webhook = notifyWebhook();
  if (!webhook) return { ok: true, due: 0, attempted: 0, delivered: 0, failed: 0, exhausted: 0, skipped: 'AF_BOUNDARY_NOTIFY_WEBHOOK is not configured' };

  const inspection = inspectPendingNotifications({ file });
  if (!inspection.ok) return { ok: false, due: 0, attempted: 0, delivered: 0, failed: 0, exhausted: 0, skipped: `queue unverifiable: ${inspection.reason}` };

  // A pending entry is due when its schedule has arrived, when it has no schedule at all
  // (the last attempt crashed before settling) or when its claim is stale (the claimant
  // died). Otherwise a crash would leave it pending forever.
  const isDue = (e) => {
    if (e.state !== 'pending') return false;
    if (force) return true;
    if (!e.next_attempt_at) return true;
    if (Date.parse(e.next_attempt_at) <= now) return true;
    return Boolean(e.claimed_at) && now - Date.parse(e.claimed_at) >= notifyClaimTtlMs();
  };
  const dueEntries = inspection.pending.filter(isDue);
  const result = { ok: true, due: dueEntries.length, attempted: 0, delivered: 0, failed: 0, exhausted: 0, skipped: null };
  const doFetch = fetchImpl ?? globalThis.fetch;

  for (const entry of dueEntries) {
    const alert = {
      canonical_dir: entry.canonical_dir,
      cas_dir: entry.cas_dir,
      task_id: entry.task_id,
      alert_id: entry.alert_id,
      occurrences: 0,
      severity: 'warning',
      boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
      reason: entry.last_error,
    };
    // Re-enter the shared state machine: it re-checks the cap, claims atomically and
    // increments the ONE attempt counter.
    const begin = beginDelivery(file, {
      key: entry.notify_key,
      cooldownKey: entry.cooldown_key ?? entry.notify_key,
      event: entry.event,
      alert,
      payload: entry.payload,
      format: entry.format,
      mode,
      allowEarly: force,
      now,
    });
    if (!begin.proceed) {
      if (String(begin.reason).startsWith('retry budget exhausted')) {
        result.exhausted += 1;
        // Do not leave a spent series as `pending` with a dead claim: persist the terminal
        // state (with "outcome unknown") so the sweep stops listing it as due.
        const finalized = finalizeExhaustedDelivery(file, { key: entry.notify_key, now });
        if (finalized.changed) {
          appendNotifyEvent(file, {
            event: 'boundary_notify',
            at: new Date().toISOString(),
            canonical_dir: entry.canonical_dir,
            alert_id: entry.alert_id ?? null,
            notify_key: entry.notify_key,
            status: 'exhausted',
            mode,
            attempts: entry.attempts,
            max_attempts: entry.max_attempts,
            outcome_unknown: true,
            reason: 'retry budget exhausted; the last attempt ended without settling',
            format: entry.format,
          });
        }
      }
      if (String(begin.reason).startsWith('backoff')) result.deferred = (result.deferred ?? 0) + 1;
      continue;
    }
    result.attempted += 1;

    // Rebuild the request from the stored payload: a fresh timestamp and a fresh
    // signature are produced with the CURRENT credentials on every attempt.
    const request = buildNotifyRequest({ event: entry.event, payload: entry.payload, format: entry.format });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), notifyTimeoutMs());
    let httpStatus = null;
    let providerCode = null;
    let error = null;
    try {
      const headers = { ...request.headers };
      if (process.env.AF_BOUNDARY_NOTIFY_TOKEN) headers.authorization = `Bearer ${process.env.AF_BOUNDARY_NOTIFY_TOKEN}`;
      const response = await doFetch(webhook, { method: 'POST', headers, body: request.body, signal: controller.signal });
      httpStatus = response?.status ?? null;
      if (!response?.ok) error = `non-2xx response: ${httpStatus}`;
      if (!error) {
        const providerRequiresCode = ['feishu', 'dingtalk', 'wecom'].includes(request.format);
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

    const settled = finishDelivery(file, { key: entry.notify_key, claimToken: begin.claim_token, ok: !error, error, httpStatus, providerCode, now });
    if (error) {
      result.failed += 1;
      if (settled.state === 'exhausted') result.exhausted += 1;
    } else {
      result.delivered += 1;
    }
    appendNotifyEvent(file, {
      event: 'boundary_notify',
      at: new Date().toISOString(),
      canonical_dir: entry.canonical_dir,
      alert_id: entry.alert_id ?? null,
      notify_key: entry.notify_key,
      status: error ? (settled.state === 'exhausted' ? 'exhausted' : 'retry-failed') : 'sent',
      mode,
      retry_attempt: begin.attempts,
      max_attempts: begin.max_attempts,
      http_status: httpStatus,
      provider_code: providerCode,
      reason: error ? redactSecrets(error) : null,
      format: entry.format,
    });
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
