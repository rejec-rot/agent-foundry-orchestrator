// boundary-alerts.mjs - A1b: durable, queryable, escalating alerts for retained boundaries.
//
// A retained boundary locks the canonical repo and the CAS store until an operator
// recovers it. Before this module that state existed only inside the task record, so a
// forgotten task could hold the repository indefinitely with nothing raising its hand.
//
// Design (hardened after review):
//   - the JSONL EVENT LOG is the source of truth; the state file is a derived index.
//     A damaged/unreadable state file is repaired by replaying the log, so corruption
//     can never be reported as "no alerts".
//   - if the log itself cannot be trusted (unreadable or contains unparseable lines)
//     the query is explicitly `unverifiable` and callers must fail loudly; alerts
//     recovered from the valid prefix are still returned so nothing is hidden.
//   - state updates are serialized with a lock file, and the streak is recomputed from
//     the log inside that lock, so concurrent writers cannot lose alerts or counts.
//   - resolving an alert resets the streak: a later retain starts counting from 1 again,
//     which is what "consecutive retains" means.
//   - `af-admin boundary alerts` exits 1 while an alert is open and 3 when the state
//     cannot be verified.
// External notification (webhook/e-mail/chat) is still NOT implemented.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_FILE = join(ROOT, 'runtime', 'boundary-alerts.jsonl');

/** Alert log path (env-overridable so tests never touch the production log). */
export function boundaryAlertsFile() {
  return process.env.AF_BOUNDARY_ALERTS_FILE || DEFAULT_FILE;
}

/** Streak state path, derived from the log path. */
export function boundaryAlertsStateFile(file = boundaryAlertsFile()) {
  return `${file}.state.json`;
}

/** How many consecutive retains for one path escalate the alert. */
export function alertEscalationThreshold() {
  const raw = Number(process.env.AF_BOUNDARY_ALERT_ESCALATE_AFTER ?? 3);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy fallback */ }
  }
}

/**
 * Serialize state updates. The lock is a file created with O_EXCL; a stale lock (dead
 * writer) is reclaimed after `staleMs`.
 */
function readLockOwner(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const owner = JSON.parse(raw);
    // Legacy PID-only locks can be reclaimed only after that PID is dead.
    const pid = typeof owner === 'number' ? owner : owner?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return { raw, pid };
  } catch { return null; }
}

function ownerIsDead(owner) {
  if (!owner) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (err) { return err.code === 'ESRCH'; }
}

function removeOwnedLock(path, raw) {
  try {
    if (readFileSync(path, 'utf8') === raw) rmSync(path);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function reclaimDeadLock(lockPath, staleMs) {
  // Serialize reclaimers so a stale observation can never unlink a new owner's
  // lock. An orphaned reclaim guard is deliberately NOT age-reclaimed: operators
  // must reconcile it; guessing here would reintroduce the same race.
  const guard = `${lockPath}.reclaim`;
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let fd;
  try { fd = openSync(guard, 'wx', 0o600); }
  catch (err) { if (err.code === 'EEXIST') return; throw err; }
  try {
    writeSync(fd, token);
    const owner = readLockOwner(lockPath);
    if (ownerIsDead(owner) && Date.now() - statSync(lockPath).mtimeMs > staleMs) {
      removeOwnedLock(lockPath, owner.raw);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  } finally {
    closeSync(fd);
    removeOwnedLock(guard, token);
  }
}

/** Synchronous critical section; live owners are never evicted on age alone. */
export function withBoundaryAlertLock(file, fn, { timeoutMs = 5000, staleMs = 10000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(staleMs) || staleMs < 0) {
    throw new Error('Invalid boundary alert lock timeout');
  }
  const lockPath = `${file}.lock`;
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  mkdirSync(dirname(file), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, token); } finally { closeSync(fd); }
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      reclaimDeadLock(lockPath, staleMs);
      if (Date.now() - start > timeoutMs) {
        const lockErr = new Error(`BOUNDARY_ALERT_LOCK_TIMEOUT: could not lock ${lockPath} within ${timeoutMs}ms`);
        lockErr.code = 'BOUNDARY_ALERT_LOCK_TIMEOUT';
        throw lockErr;
      }
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    removeOwnedLock(lockPath, token);
  }
}

/** Read the event log. Returns partial results plus any unparseable lines. */
function readEventsStrict(file) {
  if (!existsSync(file)) return { ok: true, events: [], invalid_lines: 0, missing: true };
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, events: [], invalid_lines: 0, reason: `event log unreadable: ${err.message}` };
  }
  const events = [];
  let invalid = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!isValidAlertEvent(event)) throw new Error('Invalid alert event schema');
      events.push(event);
    } catch {
      invalid += 1;
    }
  }
  return {
    ok: invalid === 0,
    events,
    invalid_lines: invalid,
    reason: invalid === 0 ? null : `event log contains ${invalid} unparseable or invalid-schema line(s)`,
  };
}

function isValidAlertEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (!['boundary_retained', 'boundary_released'].includes(event.event)) return false;
  if (!['canonical_dir', 'alert_id', 'at'].every((key) => typeof event[key] === 'string' && event[key].trim())) return false;
  return Number.isFinite(Date.parse(event.at));
}

/** Replay the event log into alert state (the authoritative derivation). */
export function reduceAlertEvents(events, threshold = alertEscalationThreshold()) {
  const state = {};
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const key = event.canonical_dir;
    if (!key) continue;
    if (event.event === 'boundary_retained') {
      const previous = state[key];
      const continuing = previous?.open === true ? previous.occurrences : 0; // closed => streak restarts
      const occurrences = continuing + 1;
      state[key] = {
        alert_id: event.alert_id ?? previous?.alert_id ?? null,
        occurrences,
        severity: occurrences >= threshold ? 'escalated' : 'warning',
        first_seen: previous?.open === true ? (previous.first_seen ?? event.at) : event.at,
        last_seen: event.at,
        task_id: event.task_id ?? null,
        boundary_state: event.boundary_state ?? null,
        reason: event.reason ?? null,
        open: true,
        resolved_at: null,
      };
    } else if (event.event === 'boundary_released') {
      const previous = state[key];
      if (!previous) continue;
      state[key] = {
        ...previous,
        open: false,
        occurrences: 0, // streak broken: the next retain starts from 1 again
        resolved_at: event.at,
        resolved_reason: event.reason ?? null,
      };
    }
  }
  return state;
}

function writeState(file, state) {
  const stateFile = boundaryAlertsStateFile(file);
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function readStateStrict(file) {
  const stateFile = boundaryAlertsStateFile(file);
  if (!existsSync(stateFile)) return { ok: false, state: null, reason: 'state file missing' };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, state: null, reason: 'state file is not an object' };
    }
    return { ok: true, state: parsed, reason: null };
  } catch (err) {
    return { ok: false, state: null, reason: `state file unreadable: ${err.message}` };
  }
}

function appendEvent(file, event) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`);
}

/**
 * Inspect the alert state without ever treating uncertainty as "no alerts".
 *
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {boolean} [options.includeResolved=false]
 * @returns {{ ok: boolean, alerts: object[], source: 'state'|'event-log'|'event-log-partial'|'state-only'|'none', reason: string|null, file: string, log_ok: boolean, state_ok: boolean }}
 */
export function inspectBoundaryAlerts({ file = boundaryAlertsFile(), includeResolved = false } = {}) {
  const threshold = alertEscalationThreshold();
  const log = readEventsStrict(file);
  const stateRead = readStateStrict(file);

  const project = (state) => Object.entries(state)
    .map(([canonicalDir, entry]) => ({ canonical_dir: canonicalDir, ...entry }))
    .filter((entry) => includeResolved || entry.open === true)
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));

  // Preferred: rebuild from the event log (source of truth) and repair the index.
  if (log.ok && !log.missing) {
    const rebuilt = reduceAlertEvents(log.events, threshold);
    try { writeState(file, rebuilt); } catch { /* repair is best effort */ }
    const drifted = stateRead.ok && JSON.stringify(stateRead.state) !== JSON.stringify(rebuilt);
    const repaired = !stateRead.ok || drifted;
    return {
      ok: true,
      alerts: project(rebuilt),
      source: 'event-log',
      reason: !stateRead.ok
        ? `state index was unusable (${stateRead.reason}); rebuilt from the event log`
        : (drifted ? 'state index was stale and has been rebuilt from the event log' : null),
      file,
      log_ok: true,
      state_ok: stateRead.ok,
      repaired,
    };
  }

  // The log exists but cannot be trusted: recover what is parseable and say so.
  if (!log.ok && !log.missing) {
    const partial = reduceAlertEvents(log.events, threshold);
    return {
      ok: false,
      alerts: project(partial),
      source: 'event-log-partial',
      reason: log.reason,
      file,
      log_ok: false,
      state_ok: stateRead.ok,
      repaired: false,
    };
  }

  // No event log at all: the state index is all we have.
  if (stateRead.ok) {
    return { ok: true, alerts: project(stateRead.state), source: 'state-only', reason: null, file, log_ok: true, state_ok: true, repaired: false };
  }
  if (log.missing && !stateRead.ok) {
    const stateFile = boundaryAlertsStateFile(file);
    const stateExists = existsSync(stateFile);
    // A completely fresh deployment has neither file: that is genuinely "no alerts".
    if (!stateExists) {
      return { ok: true, alerts: [], source: 'none', reason: null, file, log_ok: true, state_ok: true, repaired: false };
    }
    return {
      ok: false,
      alerts: [],
      source: 'unverifiable',
      reason: `alert state cannot be verified: ${stateRead.reason}, and no event log exists to rebuild from`,
      file,
      log_ok: true,
      state_ok: false,
      repaired: false,
    };
  }
  return { ok: false, alerts: [], source: 'unverifiable', reason: stateRead.reason, file, log_ok: log.ok, state_ok: false, repaired: false };
}

/**
 * List open alerts. Throws when the state cannot be verified, because returning `[]`
 * there would silently hide a retained boundary.
 *
 * @param {object} [options]
 * @returns {object[]}
 */
export function listBoundaryAlerts(options = {}) {
  const inspection = inspectBoundaryAlerts(options);
  if (!inspection.ok) {
    const err = new Error(`BOUNDARY_ALERT_STATE_UNVERIFIABLE: ${inspection.reason}`);
    err.code = 'BOUNDARY_ALERT_STATE_UNVERIFIABLE';
    err.alerts = inspection.alerts;
    throw err;
  }
  return inspection.alerts;
}

/** Force a rebuild of the state index from the event log. */
export function repairBoundaryAlertState({ file = boundaryAlertsFile() } = {}) {
  const log = readEventsStrict(file);
  if (!log.ok) {
    const err = new Error(`BOUNDARY_ALERT_STATE_UNVERIFIABLE: ${log.reason}`);
    err.code = 'BOUNDARY_ALERT_STATE_UNVERIFIABLE';
    throw err;
  }
  const rebuilt = reduceAlertEvents(log.events);
  writeState(file, rebuilt);
  return { file, alerts: Object.keys(rebuilt).length };
}

/**
 * Record that a boundary was retained for a path.
 *
 * @param {object} params
 * @returns {{ alert_id: string, occurrences: number, severity: 'warning'|'escalated', escalated: boolean, file: string, threshold: number }}
 */
export function recordBoundaryAlert({
  canonicalDir,
  casDir = null,
  taskId = null,
  boundaryState = 'PROTECTION_RETAINED_PENDING_RECOVERY',
  reason = null,
  scopeDecision = null,
  file = boundaryAlertsFile(),
} = {}) {
  if (!canonicalDir) throw new Error('recordBoundaryAlert requires canonicalDir');
  // A caller passing an object here (e.g. a CAS instance) must never end up as
  // "[object Object]" in the alert log or in an outbound notification: fail soft to null
  // and record the anomaly so the caller's bug is visible.
  const inputAnomalies = [];
  if (casDir !== null && casDir !== undefined && typeof casDir !== 'string') {
    inputAnomalies.push('cas_dir-not-a-string');
    casDir = null;
  }
  return withBoundaryAlertLock(file, () => {
    const log = readEventsStrict(file);
    if (!log.ok && !log.missing) {
      const err = new Error(`BOUNDARY_ALERT_STATE_UNVERIFIABLE: ${log.reason}`);
      err.code = 'BOUNDARY_ALERT_STATE_UNVERIFIABLE';
      throw err;
    }
    const threshold = alertEscalationThreshold();
    const state = reduceAlertEvents(log.events, threshold); // source of truth, inside the lock
    const previous = state[canonicalDir];
    const continuing = previous?.open === true ? previous.occurrences : 0;
    const occurrences = continuing + 1;
    const escalated = occurrences >= threshold;
    const at = new Date().toISOString();
    const alertId = previous?.open === true ? (previous.alert_id ?? randomUUID()) : randomUUID();

    appendEvent(file, {
      event: 'boundary_retained',
      alert_id: alertId,
      at,
      canonical_dir: canonicalDir,
      cas_dir: casDir,
      task_id: taskId,
      boundary_state: boundaryState,
      reason,
      scope_decision: scopeDecision
        ? {
          decision: scopeDecision.decision,
          reason: scopeDecision.reason,
          attempts: scopeDecision.attempts,
          quiesce_confirmed: scopeDecision.quiesce_confirmed ?? null,
          anomalies: (scopeDecision.anomalies ?? []).map((a) => ({ class: a.class, code: a.code ?? null })),
        }
        : null,
      occurrences,
      severity: escalated ? 'escalated' : 'warning',
      threshold,
      ...(inputAnomalies.length ? { input_anomalies: inputAnomalies } : {}),
    });

    const nextState = reduceAlertEvents(readEventsStrict(file).events, threshold);
    writeState(file, nextState);

    return {
      alert_id: alertId,
      occurrences,
      severity: escalated ? 'escalated' : 'warning',
      escalated,
      file,
      threshold,
      ...(inputAnomalies.length ? { input_anomalies: inputAnomalies } : {}),
    };
  });
}

/**
 * Close the alert for a path after a successful release, and record the resolution.
 *
 * @param {object} params
 * @returns {{ resolved: boolean, occurrences: number, file: string }}
 */
export function resolveBoundaryAlert({ canonicalDir, reason = null, taskId = null, file = boundaryAlertsFile() } = {}) {
  if (!canonicalDir) throw new Error('resolveBoundaryAlert requires canonicalDir');
  return withBoundaryAlertLock(file, () => {
    const log = readEventsStrict(file);
    if (!log.ok && !log.missing) {
      const err = new Error(`BOUNDARY_ALERT_STATE_UNVERIFIABLE: ${log.reason}`);
      err.code = 'BOUNDARY_ALERT_STATE_UNVERIFIABLE';
      throw err;
    }
    const threshold = alertEscalationThreshold();
    const state = reduceAlertEvents(log.events, threshold);
    const previous = state[canonicalDir];
    if (!previous || previous.open !== true) return { resolved: false, occurrences: previous?.occurrences ?? 0, file };

    const at = new Date().toISOString();
    appendEvent(file, {
      event: 'boundary_released',
      alert_id: previous.alert_id,
      at,
      canonical_dir: canonicalDir,
      task_id: taskId,
      reason,
      previous_occurrences: previous.occurrences,
    });
    writeState(file, reduceAlertEvents(readEventsStrict(file).events, threshold));
    return { resolved: true, occurrences: previous.occurrences, file };
  });
}

/** Format the open alerts for the operator CLI. */
export function formatBoundaryAlerts(alerts, { file = boundaryAlertsFile(), unverifiable = null, source = null } = {}) {
  const lines = [];
  if (unverifiable) {
    lines.push(`boundary alerts: UNVERIFIABLE - ${unverifiable}`);
    lines.push('  (this is NOT "no alerts": do not treat the boundary state as clear)');
  } else if (alerts.length === 0) {
    lines.push(`boundary alerts: none open (log: ${file})`);
  } else {
    lines.push(`boundary alerts: ${alerts.length} open (log: ${file})`);
  }
  for (const a of alerts) {
    lines.push(`- [${a.severity}] ${a.canonical_dir}`);
    lines.push(`    occurrences=${a.occurrences} task=${a.task_id ?? 'n/a'} since=${a.first_seen} last=${a.last_seen}`);
    lines.push(`    state=${a.boundary_state} reason=${a.reason ?? 'n/a'}`);
  }
  if (source) lines.push(`  source=${source}`);
  return lines.join('\n');
}

/** Read the raw event log (append-only history, newest last). */
export function readBoundaryAlertEvents({ file = boundaryAlertsFile() } = {}) {
  return readEventsStrict(file).events;
}
