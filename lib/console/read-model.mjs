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
import { inspectPendingNotifications, readNotifyEvents, redactSecrets } from '../boundary-notify.mjs';
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
  if (typeof target === 'string' && existsSync(target)) {
    try {
      const link = lstatSync(target);
      if (link.isSymbolicLink()) return { ok: false, reason: `refusing to follow a symlink out of the data roots: ${target}` };
    } catch { /* falls through to the generic refusal */ }
  }
  return { ok: false, reason: tried[0] ?? 'path is not inside any configured data root' };
}

// ---------------------------------------------------------------- strict block readers

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
  if (!existsSync(file)) return missing(source, file);
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
  if (!existsSync(dir)) return missing(source, dir);
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
  if (!existsSync(file)) return { ...missing(source, file), value: { lease: null, stale: null } };
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
  const events = readNotifyEvents({ file });
  const queue = inspectPendingNotifications({ file });
  if (!queue.ok) {
    return {
      source,
      file,
      read_status: 'unverifiable',
      as_of: mtimeOf(file),
      reason: `retry queue unverifiable: ${queue.reason}`,
      value: { deliveries: events, pending: [], exhausted: [], queue_ok: false },
    };
  }
  const pending = queue.pending.filter((entry) => entry.state === 'pending');
  const exhausted = queue.pending.filter((entry) => entry.state === 'exhausted');
  if (events.length === 0 && pending.length === 0 && exhausted.length === 0 && !existsSync(file)) {
    return missing(source, file);
  }
  return ok(source, file, { deliveries: events, pending, exhausted, queue_ok: true }, { as_of: mtimeOf(file) });
}

/** Recovery audit records for one asset or recovery id (read-only, bounded to the root). */
export function readRecoveryBlock({ roots, recoveryId = null }) {
  const source = 'recovery-audit';
  if (!roots.audit) return { ...missing(source, null), reason: 'no audit root configured' };
  if (!existsSync(roots.audit)) return missing(source, roots.audit);
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

  const notifyKeys = new Set([...deliveries, ...pending].map((entry) => entry.notify_key).filter(Boolean));
  for (const alert of alerts) {
    const linked = [...notifyKeys].some((key) => String(key).includes(alert.canonical_dir));
    if (!linked) unmatched.push({ kind: 'alert-without-delivery', alert_id: alert.alert_id ?? null, canonical_dir: alert.canonical_dir });
  }
  for (const entry of [...deliveries, ...pending]) {
    const key = String(entry.notify_key ?? '');
    const pieces = key.split('|');
    const dir = pieces.length >= 3 ? pieces[1] : null;
    if (!dir || !alerts.some((alert) => alert.canonical_dir === dir)) {
      unmatched.push({ kind: 'delivery-without-alert', notify_key: key || null, status: entry.status ?? entry.state ?? null });
    }
  }
  return { unmatched, alert_count: alerts.length, delivery_count: deliveries.length, pending_count: pending.length };
}

// ---------------------------------------------------------------- redaction (before JSON)

const PATH_SUBSTRING = /(?:\/[\w.@+-]+){2,}/g;

function digestOf(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

/**
 * Credentials are always removed. When `hashPaths` is on, absolute paths are replaced by
 * digests BOTH as whole values and as substrings (`live|/srv/repo|first` contains a path).
 */
function redactString(value, hashPaths) {
  const secretSafe = redactSecrets(value);
  const text = typeof secretSafe === 'string' ? secretSafe : String(secretSafe);
  if (!hashPaths) return text;
  return text.replace(PATH_SUBSTRING, (match) => digestOf(match));
}

function redactValue(value, hashPaths) {
  if (typeof value === 'string') return redactString(value, hashPaths);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, hashPaths));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redactValue(inner, hashPaths);
    return out;
  }
  return value;
}

// Documented path-bearing fields (kept as a checklist for reviewers); the substring rule above
// is what actually enforces redaction, so an unknown field cannot leak a path.
export const PATH_BEARING_FIELDS = Object.freeze(['file', 'canonical_dir', 'cas_dir', 'fixture_dir', 'path', 'root', 'audit_root', 'snapshot_path']);

/**
 * Redact a model BEFORE serialisation.
 *
 * Contract (decisions recorded for the console): credentials are ALWAYS redacted; local paths
 * are hashed by default, and only `--no-redact` (i.e. `redact: false`, for local viewing)
 * shows them verbatim. Renderers are never trusted to hide anything.
 */
export function redactModel(model, { redact = true, hash = true } = {}) {
  if (!redact) return { model: redactValue(model, false), paths_redacted: false, path_mode: 'full' };
  return { model: redactValue(model, true), paths_redacted: true, path_mode: hash === false ? 'full' : 'hash' };
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

  const unverifiableSources = [index, alerts, notify, ...tasks.map((t) => ({ source: `task:${t.task_id}`, read_status: t.read_status }))]
    .filter((block) => block.read_status !== 'ok')
    .map((block) => ({ source: block.source, read_status: block.read_status }));

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
  const canonical = task.value?.trusted_import?.fixture_dir ?? task.value?.fixture_dir ?? null;
  const relatedAlerts = (alerts.value?.alerts ?? []).filter((alert) => !canonical || alert.canonical_dir === canonical);
  const relatedDeliveries = (notify.value?.deliveries ?? []).filter((entry) => !canonical || String(entry.notify_key ?? '').includes(canonical));

  const unmatched = [];
  if (task.read_status === 'ok' && canonical && relatedAlerts.length === 0 && (alerts.value?.alerts ?? []).length > 0) {
    unmatched.push({ kind: 'task-without-alert', task_id: taskId, canonical_dir: canonical });
  }
  if (task.read_status === 'ok' && canonical && relatedDeliveries.length === 0 && (notify.value?.deliveries ?? []).length > 0) {
    unmatched.push({ kind: 'task-without-delivery', task_id: taskId, canonical_dir: canonical });
  }

  return {
    schema: 'af-console-task-v1',
    generated_at: new Date(now).toISOString(),
    task_id: taskId,
    blocks: { task, lock, alerts: { ...alerts, value: { alerts: relatedAlerts } }, notify: { ...notify, value: { ...notify.value, deliveries: relatedDeliveries } }, recovery },
    unmatched,
  };
}

/** `exceptions`: retained boundaries, unverifiable sources, delivery failures - side by side. */
export function buildExceptionsView({ roots, now = Date.now() }) {
  const index = readTaskIndex({ roots });
  const alerts = readAlertBlock({ file: roots.alerts });
  const notify = readNotifyBlock({ file: roots.alerts });
  const recovery = readRecoveryBlock({ roots });

  const retained = [];
  for (const entry of index.value ?? []) {
    const record = readTaskBlock({ taskId: entry.task_id, roots });
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
    ].filter((block) => block.read_status !== 'ok'),
  };
}
