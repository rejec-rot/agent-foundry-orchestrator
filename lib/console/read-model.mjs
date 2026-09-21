// read-model.mjs - the pure read adapter for the read-only operations console.
//
// CONTRACT (SYSTEM-ARCHITECTURE-NEXT.md §5.1.1, OPERATIONS-CONSOLE-DESIGN.md):
//   * read-only means: this module may not create, rewrite or delete ANY file, and may not
//     take any lock. `inspectBoundaryAlerts()` is therefore off limits (it repairs the state
//     index with `writeState()`); alerts are replayed in memory from the event log instead.
//   * every block carries source / read_status / as_of so a failure can never be rendered as
//     "nothing to report".
//   * containment checks are path-aware, never bare string prefixes.
//   * redaction happens while building the model, BEFORE any JSON is produced, so no output
//     path can leak credentials.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createHash } from 'node:crypto';

import { replayBoundaryAlerts } from '../boundary-alerts.mjs';
import { inspectPendingNotifications, readNotifyEventsStrict, redactSecrets } from '../boundary-notify.mjs';
import { isLockStale } from '../tasklock.mjs';

// ---------------------------------------------------------------- roots & containment

/** Resolve the configured data roots once, with symlinks collapsed. */
export function resolveDataRoots(env = process.env, cwd = process.cwd()) {
  const candidates = {
    tasks: env.AF_TASKS_DIR || join(cwd, 'tasks'),
    locks: env.AF_LOCKS_DIR || join(cwd, 'locks'),
    runtime: env.AF_RUNTIME_DIR || join(cwd, 'runtime'),
    audit: env.AF_BOUNDARY_AUDIT_DIR || null,
    snapshots: env.AF_BOUNDARY_SNAPSHOT_DIR || null,
    alerts: env.AF_BOUNDARY_ALERTS_FILE || join(env.AF_RUNTIME_DIR || join(cwd, 'runtime'), 'boundary-alerts.jsonl'),
  };
  const roots = {};
  for (const [key, value] of Object.entries(candidates)) {
    if (!value) continue;
    roots[key] = canonicalize(value);
  }
  return roots;
}

/** Best-effort realpath: non-existent paths are canonicalised textually (no creation). */
function canonicalize(target) {
  const absolute = resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    // Not created yet: canonicalise the deepest existing ancestor instead.
    let head = absolute;
    const tail = [];
    for (;;) {
      try {
        const real = realpathSync(head);
        return tail.length ? join(real, ...tail.reverse()) : real;
      } catch {
        const parent = resolve(head, '..');
        if (parent === head) return absolute;
        tail.push(basename(head));
        head = parent;
      }
    }
  }
}

/**
 * Path-aware containment: `target` must be the root itself or live under it.
 * A bare string prefix is NOT enough (`/data/tasks-evil` must not pass for root `/data/tasks`).
 *
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function assertWithinRoot(target, root) {
  if (typeof target !== 'string' || target.length === 0) return { ok: false, reason: 'path is required' };
  if (target.includes('\0')) return { ok: false, reason: 'path contains a NUL byte' };
  const canonicalRoot = canonicalize(root);
  const canonicalTarget = canonicalize(target);
  if (!isAbsolute(canonicalTarget)) return { ok: false, reason: 'path must be absolute' };
  const rel = relative(canonicalRoot, canonicalTarget);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!inside) return { ok: false, reason: `path escapes the configured root ${canonicalRoot}` };
  return { ok: true, path: canonicalTarget };
}

/** Refuse anything that is not inside at least one configured root. */
export function assertWithinRoots(target, roots, { allow = Object.keys(roots) } = {}) {
  const tried = [];
  for (const key of allow) {
    if (!roots[key]) continue;
    const result = assertWithinRoot(target, roots[key]);
    if (result.ok) return { ok: true, path: result.path, root: key };
    tried.push(result.reason);
  }
  // A symlink can point outside while sitting inside: the parent must still be a real path.
  if (typeof target === 'string') {
    const probe = statOrError(target);
    if (!probe.ok) return { ok: false, reason: `path cannot be inspected: ${probe.reason}` };
    if (probe.stat !== null) {
      try {
        if (lstatSync(target).isSymbolicLink()) return { ok: false, reason: `refusing to follow a symlink out of the data roots: ${target}` };
      } catch { /* falls through to the generic refusal */ }
    }
  }
  return { ok: false, reason: tried[0] ?? 'path is not inside any configured data root' };
}

// ---------------------------------------------------------------- strict block readers

/** Distinguish a definite absence from an error the operator must see. */
function statOrError(target) {
  try {
    return { ok: true, stat: statSync(target) };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, stat: null };
    return { ok: false, reason: `${err?.code ?? 'error'}: ${err.message}` };
  }
}

const missing = (source, file) => ({ source, file, read_status: 'missing', as_of: null, reason: 'not present', value: null });
const unverifiable = (source, file, reason) => ({ source, file, read_status: 'unverifiable', as_of: null, reason, value: null });

function ok(source, file, value, { as_of = null, derived_from = null } = {}) {
  return { source, file, read_status: 'ok', as_of, reason: null, value, ...(derived_from ? { derived_from } : {}) };
}

/** mtime as an ISO string, or null when unavailable. */
function mtimeOf(file) {
  try { return statSync(file).mtime.toISOString(); } catch { return null; }
}

/** Read one task record strictly: missing / unverifiable are first-class results. */
export function readTaskBlock({ taskId, roots }) {
  const source = 'tasks';
  if (!taskId) return { ...unverifiable(source, null, 'task id is required') };
  const containment = assertWithinRoot(join(roots.tasks, `${taskId}.json`), roots.tasks);
  if (!containment.ok) return unverifiable(source, join(roots.tasks, `${taskId}.json`), containment.reason);
  const file = containment.path;
  const stat = statOrError(file);
  if (!stat.ok) return unverifiable(source, file, `task record cannot be inspected: ${stat.reason}`);
  if (stat.stat === null) return missing(source, file);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return unverifiable(source, file, `task record unreadable: ${err.message}`);
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unverifiable(source, file, 'task record is not an object');
    return ok(source, file, value, { as_of: mtimeOf(file) });
  } catch (err) {
    // A half-written record must never be shown as the previous version.
    return unverifiable(source, file, `task record is not valid JSON: ${err.message}`);
  }
}

/** List the task directory without reading the bodies (list views must stay cheap). */
export function readTaskIndex({ roots }) {
  const source = 'tasks';
  const dir = roots.tasks;
  const dirStat = statOrError(dir);
  if (!dirStat.ok) return unverifiable(source, dir, `task directory cannot be inspected: ${dirStat.reason}`);
  if (dirStat.stat === null) return missing(source, dir);
  try {
    const entries = readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .map((name) => {
        const file = join(dir, name);
        let stat = null;
        try { stat = statSync(file); } catch { /* unreadable entry stays listed */ }
        return { task_id: name.replace(/\.json$/, ''), file, size: stat?.size ?? null, as_of: stat ? stat.mtime.toISOString() : null };
      })
      .sort((a, b) => String(b.as_of).localeCompare(String(a.as_of)));
    return ok(source, dir, entries);
  } catch (err) {
    return unverifiable(source, dir, `task directory unreadable: ${err.message}`);
  }
}

/** Task lock snapshot with staleness, never inferring that a task is dead. */
export function readLockBlock({ taskId, roots, now = Date.now() }) {
  const source = 'locks';
  if (!taskId) return unverifiable(source, null, 'task id is required');
  const containment = assertWithinRoot(join(roots.locks, `${taskId}.lock`), roots.locks);
  if (!containment.ok) return unverifiable(source, join(roots.locks, `${taskId}.lock`), containment.reason);
  const file = containment.path;
  const stat = statOrError(file);
  if (!stat.ok) return { ...unverifiable(source, file, `task lock cannot be inspected: ${stat.reason}`), value: { lease: null, stale: null } };
  if (stat.stat === null) return { ...missing(source, file), value: { lease: null, stale: null } };
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    let stale = null;
    try { stale = isLockStale(lock, now); } catch { stale = null; }
    return ok(source, file, { lease: lock, stale }, { as_of: mtimeOf(file) });
  } catch (err) {
    return unverifiable(source, file, `task lock is not readable JSON: ${err.message}`);
  }
}

/**
 * Alert view: PURE replay of the event log (no index repair, no lock, no write).
 */
export function readAlertBlock({ file }) {
  const source = 'boundary-alerts';
  const fileStat = statOrError(file);
  if (!fileStat.ok) return { ...unverifiable(source, file, `alert log cannot be inspected: ${fileStat.reason}`), value: { alerts: [], invalid_lines: 0 } };
  const replay = replayBoundaryAlerts({ file, includeResolved: true });
  if (replay.ok && replay.source === 'none') return { ...missing(source, file), value: { alerts: [], invalid_lines: 0 } };
  if (!replay.ok) {
    return {
      source,
      file,
      read_status: 'unverifiable',
      as_of: mtimeOf(file),
      reason: `${replay.reason}; ${replay.invalid_lines} invalid line(s)`,
      value: { alerts: replay.alerts, invalid_lines: replay.invalid_lines },
    };
  }
  return ok(source, file, { alerts: replay.alerts, invalid_lines: 0 }, { as_of: mtimeOf(file), derived_from: 'event-log-replay' });
}

/** Notification view: delivery records plus the retry queue's verifiability. */
export function readNotifyBlock({ file }) {
  const source = 'boundary-notify';
  const log = readNotifyEventsStrict({ file });            // strict: bad lines are reported, not skipped
  const queue = inspectPendingNotifications({ file });
  const pending = queue.ok ? queue.pending.filter((entry) => entry.state === 'pending') : [];
  const exhausted = queue.ok ? queue.pending.filter((entry) => entry.state === 'exhausted') : [];
  const value = { deliveries: log.events, pending, exhausted, queue_ok: queue.ok, invalid_lines: log.invalid_lines, log_ok: log.ok };

  if (!queue.ok) {
    return { source, file, read_status: 'unverifiable', as_of: mtimeOf(file), reason: `retry queue unverifiable: ${queue.reason}`, value };
  }
  if (!log.ok) {
    return { source, file, read_status: 'unverifiable', as_of: mtimeOf(file), reason: log.reason ?? 'delivery log unverifiable', value };
  }
  if (log.missing && pending.length === 0 && exhausted.length === 0) return { ...missing(source, file), value };
  return ok(source, file, value, { as_of: mtimeOf(file) });
}

/** Recovery audit records for one asset or recovery id (read-only, bounded to the root). */
export function readRecoveryBlock({ roots, recoveryId = null }) {
  const source = 'recovery-audit';
  if (!roots.audit) return { ...missing(source, null), reason: 'no audit root configured' };
  const auditStat = statOrError(roots.audit);
  if (!auditStat.ok) return unverifiable(source, roots.audit, `audit root cannot be inspected: ${auditStat.reason}`);
  if (auditStat.stat === null) return missing(source, roots.audit);
  try {
    const names = readdirSync(roots.audit)
      .filter((name) => /^recovery-.*-(intent|result)\.json$/.test(name))
      .filter((name) => !recoveryId || name.includes(recoveryId));
    const records = [];
    let bad = 0;
    let refused = 0;
    for (const name of names.sort()) {
      const file = join(roots.audit, name);
      // A record name is not enough: a symlinked record could read outside the root.
      const containment = assertWithinRoot(file, roots.audit);
      if (!containment.ok) { refused += 1; continue; }
      try {
        if (lstatSync(containment.path).isSymbolicLink()) { refused += 1; continue; }
      } catch { refused += 1; continue; }
      try {
        records.push({ file, phase: name.endsWith('-intent.json') ? 'intent' : 'result', record: JSON.parse(readFileSync(containment.path, 'utf8')) });
      } catch {
        bad += 1;
      }
    }
    if (refused > 0) return { ...unverifiable(source, roots.audit, `${refused} recovery record(s) refused as out-of-root or symlinked`), value: { records } };
    if (bad > 0) return { ...unverifiable(source, roots.audit, `${bad} recovery record(s) could not be read`), value: { records } };
    return ok(source, roots.audit, { records }, { as_of: mtimeOf(roots.audit) });
  } catch (err) {
    return unverifiable(source, roots.audit, `audit root unreadable: ${err.message}`);
  }
}

// ---------------------------------------------------------------- correlation

/**
 * Correlate blocks by the documented keys and report what could NOT be linked.
 * Missing links are reported, never guessed.
 */
export function correlateAlertsAndNotify(alertBlock, notifyBlock) {
  const alerts = alertBlock.value?.alerts ?? [];
  const deliveries = notifyBlock.value?.deliveries ?? [];
  const pending = notifyBlock.value?.pending ?? [];
  const unmatched = [];

  // Delivery records carry `notify_key` shaped `<mode>|<asset>|<kind>` and `canonical_dir`.
  // Association uses the EXACT asset value, never a substring: `/srv/repo-other` must not
  // satisfy `/srv/repo`.
  const deliveryAssets = new Set();
  for (const entry of [...deliveries, ...pending]) {
    const asset = exactDeliveryAsset(entry);
    if (asset) deliveryAssets.add(asset);
  }
  for (const alert of alerts) {
    if (!deliveryAssets.has(alert.canonical_dir)) {
      unmatched.push({ kind: 'alert-without-delivery', alert_id: alert.alert_id ?? null, canonical_dir: alert.canonical_dir });
    }
  }
  for (const entry of [...deliveries, ...pending]) {
    const asset = exactDeliveryAsset(entry);
    if (!asset) {
      unmatched.push({ kind: 'delivery-without-asset-key', notify_key: entry.notify_key ?? null, alert_id: entry.alert_id ?? null });
      continue;
    }
    if (!alerts.some((alert) => alert.canonical_dir === asset)) {
      unmatched.push({ kind: 'delivery-without-alert', asset, status: entry.status ?? entry.state ?? null });
    }
  }
  return { unmatched, alert_count: alerts.length, delivery_count: deliveries.length, pending_count: pending.length };
}

/**
 * Extract the asset from a delivery record by EXACT key parsing.
 * `<mode>|<asset>|<kind>` splits on '|' (an asset path cannot contain '|'); a record that
 * carries `canonical_dir` directly is preferred. Anything else returns null (unmatched).
 */
export function exactDeliveryAsset(entry) {
  if (entry && typeof entry.canonical_dir === 'string' && entry.canonical_dir.length > 0) return entry.canonical_dir;
  const key = typeof entry?.notify_key === 'string' ? entry.notify_key : null;
  if (!key) return null;
  const parts = key.split('|');
  if (parts.length < 3) return null;
  const asset = parts[1];
  return asset && asset.length > 0 ? asset : null;
}

// ---------------------------------------------------------------- redaction (before JSON)

/** Sensitive field names whose VALUE is a credential, whatever it looks like. */
export const SENSITIVE_FIELDS = Object.freeze([
  'api_key', 'apikey', 'x_api_key', 'access_key', 'access_token', 'secret', 'secret_key',
  'client_secret', 'private_key', 'password', 'passwd', 'credential', 'credentials',
  'authorization', 'auth', 'auth_token', 'refresh_token', 'session', 'session_id',
  'bearer', 'token', 'sign', 'webhook', 'webhook_url', 'cookie', 'set_cookie',
]);

/** Field names that hold a path (documented checklist; the substring rule below also applies). */
export const PATH_BEARING_FIELDS = Object.freeze([
  'file', 'canonical_dir', 'cas_dir', 'fixture_dir', 'candidate_dir', 'path', 'paths',
  'root', 'audit_root', 'snapshot_path', 'snapshot_dir', 'tasks_dir', 'locks_dir', 'runtime_dir',
]);

/**
 * Field-name normalisation: `X-Api-Key`, `x.api.key` and `x api key` all name the same secret,
 * so separators are folded to `_` before the lookup. A near-miss name must not leak an opaque
 * value that no text pattern could catch.
 */
function isSensitiveField(key) {
  const normalized = String(key).toLowerCase().replace(/[\s.-]+/g, '_');
  if (SENSITIVE_FIELDS.includes(normalized)) return true;
  return SENSITIVE_FIELDS.some((name) => normalized === name || normalized.endsWith(`_${name}`));
}

// A path segment may contain CJK, spaces and the usual punctuation, but must start and end
// with a word-ish character so prose is not swallowed.
const PATH_SEGMENT = String.raw`[\p{L}\p{N}._@+-](?:[\p{L}\p{N}._@+ -]{0,60}[\p{L}\p{N}._@+-])?`;
const PATH_SUBSTRING = new RegExp(String.raw`(?:/${PATH_SEGMENT}){2,}`, 'gu');
const ABSOLUTE_PATH_VALUE = new RegExp(String.raw`^/${PATH_SEGMENT}(?:/${PATH_SEGMENT})*$`, 'u');

function digestOf(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

/**
 * Console-grade string sanitisation: credential TEXT rules from `redactSecrets` (no length cap
 * here - truncation is recorded separately) plus path hashing when requested. Paths may contain
 * CJK characters and spaces, and a path may be embedded in a longer string.
 */
function redactString(value, hashPaths) {
  const secretSafe = redactSecrets(value, { maxLength: null });
  const text = typeof secretSafe === 'string' ? secretSafe : String(secretSafe);
  if (!hashPaths) return text;
  if (ABSOLUTE_PATH_VALUE.test(text)) return digestOf(text);
  return text.replace(PATH_SUBSTRING, (match) => digestOf(match));
}

function redactValue(value, hashPaths, ctx) {
  if (typeof value === 'string') {
    const safe = redactString(value, hashPaths);
    if (value.length > ctx.maxChars && safe.length > ctx.maxChars) return truncateRecorded(safe, value, ctx);
    return safe;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactValue(entry, hashPaths, { ...ctx, path: `${ctx.path}[${index}]` }));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      // A sensitive field value is masked by NAME as well as by text rules: an opaque value
      // such as "DUMMY_PRIVATE_VALUE" carries no pattern for a regex to catch.
      if (isSensitiveField(key)) {
        out[key] = inner === null || inner === undefined ? inner : '<redacted-field>';
        continue;
      }
      out[key] = redactValue(inner, hashPaths, { ...ctx, path: ctx.path ? `${ctx.path}.${key}` : key });
    }
    return out;
  }
  return value;
}

/** Truncation is a separate, recorded decision - never a silent side effect of redaction. */
function truncateRecorded(text, original, ctx) {
  const kept = text.slice(0, ctx.maxChars);
  ctx.truncations.push({
    path: ctx.path || '<root>',
    original_chars: original.length,
    kept_chars: kept.length,
    marker: '…[已截断]',
  });
  return `${kept} …[已截断 ${original.length - kept.length} 字符]`;
}

/**
 * Redact a model BEFORE serialisation.
 *
 * Contract (decisions recorded for the console): credentials are ALWAYS redacted; local paths
 * are hashed by default, and only `--no-redact` (i.e. `redact: false`, for local viewing)
 * shows them verbatim. Renderers are never trusted to hide anything.
 */
export function redactModel(model, { redact = true, hash = true, maxChars = Number(process.env.AF_CONSOLE_MAX_TEXT ?? 4000) } = {}) {
  const truncations = [];
  const cleaned = redactValue(model, redact, { maxChars, truncations, path: '' });
  const base = cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) ? cleaned : { value: cleaned };
  return {
    model: { ...base, truncations },
    paths_redacted: redact,
    path_mode: redact && hash !== false ? 'hash' : 'full',
    truncations,
  };
}

// ---------------------------------------------------------------- assembled queries

/**
 * `overview`: what needs attention right now, with every block's verifiability intact.
 * Independent statuses are reported side by side - there is deliberately no merged "success".
 */
export function buildOverview({ roots, now = Date.now() }) {
  const index = readTaskIndex({ roots });
  const alerts = readAlertBlock({ file: roots.alerts });
  const notify = readNotifyBlock({ file: roots.alerts });
  const correlation = correlateAlertsAndNotify(alerts, notify);

  const tasks = [];
  for (const entry of index.value ?? []) {
    const record = readTaskBlock({ taskId: entry.task_id, roots });
    const lock = readLockBlock({ taskId: entry.task_id, roots, now });
    const state = record.value?.state ?? null;
    const boundary = record.value?.trusted_import?.boundary_state ?? null;
    tasks.push({
      task_id: entry.task_id,
      state,
      state_version: record.value?.state_version ?? null,
      boundary_state: boundary,
      lock_stale: lock.value?.stale ?? null,
      needs_human: state === 'WAITING_HUMAN' || boundary === 'RESTORE_INCOMPLETE' || boundary === 'RECONCILE_REQUIRED',
      read_status: record.read_status,
      as_of: record.as_of,
      source: record.source,
    });
  }

  // `unverifiable` (damage/uncertainty) drives exit 3; `missing` is a normal absence and is
  // still reported explicitly so a reader never confuses it with "nothing to report".
  const allSources = [index, alerts, notify, ...tasks.map((t) => ({ source: `task:${t.task_id}`, read_status: t.read_status, reason: null }))];
  const unverifiableSources = allSources
    .filter((block) => block.read_status === 'unverifiable')
    .map((block) => ({ source: block.source, read_status: block.read_status, reason: block.reason ?? null }));
  const missingSources = allSources
    .filter((block) => block.read_status === 'missing')
    .map((block) => ({ source: block.source, read_status: 'missing' }));

  return {
    schema: 'af-console-overview-v1',
    generated_at: new Date(now).toISOString(),
    blocks: {
      tasks: { source: index.source, read_status: index.read_status, as_of: index.as_of, count: tasks.length, reason: index.reason },
      alerts: { source: alerts.source, read_status: alerts.read_status, as_of: alerts.as_of, open: (alerts.value?.alerts ?? []).filter((a) => a.open).length, reason: alerts.reason },
      notify: { source: notify.source, read_status: notify.read_status, as_of: notify.as_of, pending: notify.value?.pending?.length ?? 0, exhausted: notify.value?.exhausted?.length ?? 0, reason: notify.reason },
    },
    needs_human: tasks.filter((t) => t.needs_human).map((t) => ({ task_id: t.task_id, state: t.state, boundary_state: t.boundary_state })),
    unverifiable: unverifiableSources,
    missing: missingSources,
    correlation,
    tasks,
  };
}

/** `task <id>`: one task plus its locks, alerts and deliveries, still fully attributed. */
export function buildTaskView({ taskId, roots, now = Date.now() }) {
  const task = readTaskBlock({ taskId, roots });
  const lock = readLockBlock({ taskId, roots, now });
  const alerts = readAlertBlock({ file: roots.alerts });
  const notify = readNotifyBlock({ file: roots.alerts });
  const recovery = readRecoveryBlock({ roots });
  const ti = task.value?.trusted_import ?? {};
  const canonical = ti.canonical_dir ?? task.value?.fixture_dir ?? null;
  const alertId = ti.boundary_alert?.alert_id ?? null;
  const recoveryId = ti.boundary_recovery_id ?? null;

  const unmatched = [];
  // A recovery record belongs to the asset when it lists that exact path.
  const belongsToAsset = (record) => Boolean(canonical)
    && Array.isArray(record.record?.paths) && record.record.paths.includes(canonical);
  // Without ANY key nothing may be attached to this task: a "select everything" fallback would
  // silently mix other tasks' evidence into this one.
  const hasKey = Boolean(canonical || alertId || recoveryId);
  let relatedAlerts = [];
  let relatedDeliveries = [];
  let relatedPending = [];
  let relatedExhausted = [];
  let relatedRecovery = [];
  let assetHistory = [];
  if (hasKey) {
    // Alerts: an explicit alert_id WINS and is the only criterion - adding "same path" alerts
    // would pull in evidence belonging to other tasks on the same repository.
    relatedAlerts = (alerts.value?.alerts ?? []).filter((alert) => (alertId
      ? alert.alert_id === alertId
      : canonical && alert.canonical_dir === canonical));

    const matchesDelivery = (entry) => (alertId
      ? entry.alert_id === alertId
      : canonical && exactDeliveryAsset(entry) === canonical);
    relatedDeliveries = (notify.value?.deliveries ?? []).filter(matchesDelivery);
    relatedPending = (notify.value?.pending ?? []).filter(matchesDelivery);
    relatedExhausted = (notify.value?.exhausted ?? []).filter(matchesDelivery);

    // Recovery: compare the PARSED recovery id for equality (a prefix such as `recovery-1`
    // must never match `recovery-10`). An EXPLICIT id is the only source of "current recovery"
    // evidence; other records for the same asset are reported separately as asset history and
    // must never be folded into the current attempt's evidence.
    const allRecovery = recovery.value?.records ?? [];
    if (recoveryId) {
      relatedRecovery = allRecovery.filter((record) => parseRecoveryId(record.file) === recoveryId);
      assetHistory = allRecovery.filter((record) => parseRecoveryId(record.file) !== recoveryId && belongsToAsset(record));
    } else if (canonical) {
      relatedRecovery = allRecovery.filter(belongsToAsset);
    }
  } else {
    unmatched.push({ kind: 'task-without-asset-key', task_id: taskId, detail: 'no canonical_dir, alert_id or recovery id: related evidence is deliberately NOT attached' });
  }

  if (task.read_status === 'ok' && hasKey) {
    if (relatedAlerts.length === 0 && (alerts.value?.alerts ?? []).length > 0) {
      // Explain WHY nothing attached: the alert log keeps ONE current entry per path, so a task
      // whose recorded alert id is no longer the path's current entry attaches nothing rather
      // than silently taking another task's alert.
      const available = (alerts.value?.alerts ?? [])
        .filter((alert) => !canonical || alert.canonical_dir === canonical || alert.alert_id === alertId)
        .map((alert) => alert.alert_id);
      unmatched.push({
        kind: 'task-without-alert',
        task_id: taskId,
        canonical_dir: canonical,
        requested_alert_id: alertId,
        available_alert_ids: available,
        detail: 'the alert log holds one current entry per path; an explicit alert id is never replaced by a same-path match',
      });
    }
    if (relatedDeliveries.length === 0 && (notify.value?.deliveries ?? []).length > 0) {
      unmatched.push({ kind: 'task-without-delivery', task_id: taskId, canonical_dir: canonical, alert_id: alertId });
    }
    if (relatedRecovery.length === 0 && (recovery.value?.records ?? []).length > 0) {
      // Show what this ASSET actually has, so a missing explicit id is diagnosable.
      const available = (recovery.value?.records ?? [])
        .filter((record) => (canonical && belongsToAsset(record)) || (recoveryId && parseRecoveryId(record.file) === recoveryId))
        .map((record) => parseRecoveryId(record.file));
      unmatched.push({
        kind: recoveryId ? 'recovery-id-not-found' : 'task-without-recovery-record',
        task_id: taskId,
        canonical_dir: canonical,
        requested_recovery_id: recoveryId,
        available_recovery_ids: [...new Set(available)],
        asset_history_count: assetHistory.length,
        detail: 'an explicit recovery id never falls back to other records of the same asset; other attempts are listed as asset history',
      });
    }
  }

  return {
    schema: 'af-console-task-v1',
    generated_at: new Date(now).toISOString(),
    task_id: taskId,
    keys: { canonical_dir: canonical, alert_id: alertId, recovery_id: recoveryId },
    blocks: {
      task,
      lock,
      alerts: { ...alerts, value: { alerts: relatedAlerts } },
      notify: { ...notify, value: { ...notify.value, deliveries: relatedDeliveries, pending: relatedPending, exhausted: relatedExhausted } },
      recovery: {
        ...recovery,
        value: {
          // `records` stays the current attempt's evidence; history is separate and labelled.
          records: relatedRecovery,
          current_recovery: relatedRecovery,
          current_recovery_id: recoveryId,
          asset_history: assetHistory,
        },
      },
    },
    unmatched,
  };
}

/**
 * Parse the recovery id out of an audit file name: `recovery-<id>-intent.json` /
 * `recovery-<id>-result.json`. Comparison happens on the parsed value, never by substring.
 */
export function parseRecoveryId(file) {
  if (typeof file !== 'string') return null;
  const name = file.split('/').pop() ?? '';
  const match = /^recovery-(.+)-(intent|result)\.json$/.exec(name);
  return match ? match[1] : null;
}

/** Evidence view: what the decision was based on, with every absent piece stated. */
export function buildEvidenceView({ taskId, roots, now = Date.now() }) {
  const task = readTaskBlock({ taskId, roots });
  const ti = task.value?.trusted_import ?? {};
  const review = task.value?.last_review ?? task.value?.final_review ?? null;
  const acceptanceRuns = Array.isArray(task.value?.acceptance_runs) ? task.value.acceptance_runs : [];
  const evidenceId = ti.acceptance_evidence_id ?? null;

  const absent = [];
  if (task.read_status !== 'ok') absent.push({ part: 'task-record', read_status: task.read_status, reason: task.reason });
  if (!review) absent.push({ part: 'review-result', read_status: 'missing', reason: 'no review result recorded on the task' });
  if (acceptanceRuns.length === 0) absent.push({ part: 'acceptance-runs', read_status: 'missing', reason: 'no acceptance run recorded on the task' });
  if (!evidenceId) absent.push({ part: 'acceptance-evidence-id', read_status: 'missing', reason: 'no evidence id recorded' });
  if (!ti.baseline_oid || !ti.new_commit_oid) absent.push({ part: 'promotion-oids', read_status: 'missing', reason: 'baseline/new commit oid not recorded' });

  return {
    schema: 'af-console-evidence-v1',
    generated_at: new Date(now).toISOString(),
    task_id: taskId,
    blocks: {
      task,
      review: { source: 'task-record.last_review', read_status: review ? 'ok' : 'missing', as_of: task.as_of, value: review },
      acceptance: {
        source: 'task-record.acceptance_runs',
        read_status: acceptanceRuns.length > 0 ? 'ok' : 'missing',
        as_of: task.as_of,
        value: acceptanceRuns.map((run) => ({
          revision: run.revision ?? null,
          command: run.command ?? null,
          exit_code: run.exit_code ?? null,
          failure_reason: run.failure_reason ?? null,
          output: run.output ?? null,
          author_run_id: run.author_run_id ?? null,
        })),
      },
      promotion: {
        source: 'task-record.trusted_import',
        read_status: task.read_status,
        as_of: task.as_of,
        value: {
          baseline_oid: ti.baseline_oid ?? null,
          new_commit_oid: ti.new_commit_oid ?? null,
          patch_digest: ti.patch_digest ?? null,
          tree_oid: ti.tree_oid ?? null,
          acceptance_evidence_id: evidenceId,
          candidate_dir: ti.candidate_dir ?? null,
          // Reading git refs would require spawning git or reading outside the data roots, so the
          // console deliberately does not do it; the operator can check git directly.
          canonical_ref: 'not-read (out of scope for the read-only model)',
        },
      },
    },
    absent,
  };
}

/** `exceptions`: retained boundaries, unverifiable sources, delivery failures - side by side. */
export function buildExceptionsView({ roots, now = Date.now() }) {
  const index = readTaskIndex({ roots });
  const alerts = readAlertBlock({ file: roots.alerts });
  const notify = readNotifyBlock({ file: roots.alerts });
  const recovery = readRecoveryBlock({ roots });

  const retained = [];
  const taskFailures = [];
  for (const entry of index.value ?? []) {
    const record = readTaskBlock({ taskId: entry.task_id, roots });
    const lock = readLockBlock({ taskId: entry.task_id, roots, now });
    // Every per-task source failure is surfaced, whether or not a boundary field was readable.
    if (record.read_status !== 'ok') {
      taskFailures.push({ source: `task:${entry.task_id}`, read_status: record.read_status, reason: record.reason, file: record.file });
    }
    if (lock.read_status !== 'ok') {
      taskFailures.push({ source: `lock:${entry.task_id}`, read_status: lock.read_status, reason: lock.reason, file: lock.file });
    }
    const boundary = record.value?.trusted_import?.boundary_state ?? null;
    if (boundary && boundary !== 'DISENGAGED') {
      retained.push({
        task_id: entry.task_id,
        boundary_state: boundary,
        reason: record.value?.trusted_import?.boundary_retained_reason ?? null,
        scope_decision: record.value?.trusted_import?.boundary_scope_decision ?? null,
        read_status: record.read_status,
      });
    }
  }

  return {
    schema: 'af-console-exceptions-v1',
    generated_at: new Date(now).toISOString(),
    retained_boundaries: retained,
    open_alerts: (alerts.value?.alerts ?? []).filter((alert) => alert.open),
    exhausted_deliveries: notify.value?.exhausted ?? [],
    failed_deliveries: (notify.value?.deliveries ?? []).filter((entry) => ['failed', 'settle-failed', 'oversized-request-body'].includes(entry.status)),
    recovery_records: recovery.value?.records ?? [],
    unverifiable: [
      { source: alerts.source, read_status: alerts.read_status, reason: alerts.reason },
      { source: notify.source, read_status: notify.read_status, reason: notify.reason },
      { source: recovery.source, read_status: recovery.read_status, reason: recovery.reason },
      { source: index.source, read_status: index.read_status, reason: index.reason },
      ...taskFailures,
    ].filter((block) => block.read_status === 'unverifiable'),
    missing: [
      { source: alerts.source, read_status: alerts.read_status },
      { source: notify.source, read_status: notify.read_status },
      { source: recovery.source, read_status: recovery.read_status },
      { source: index.source, read_status: index.read_status },
      ...taskFailures,
    ].filter((block) => block.read_status === 'missing').map((block) => ({ source: block.source, read_status: 'missing' })),
  };
}
