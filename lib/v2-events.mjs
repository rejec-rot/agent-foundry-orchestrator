// v2-events.mjs - the phase-event projection and structured error persistence (§6 G5).
//
// Two rules shape this module, both from the plan:
//
//   1. Events are a DISPLAY/AUDIT projection. The task file remains the lifecycle truth, and the
//      event stream is never a second scheduler: when the two disagree we reconcile against the
//      task snapshot and MARK the gap instead of inventing a history.
//   2. An error code is only ever taken from a real `err.code` (or an explicit classification
//      code). A natural-language message is NEVER parsed into a precise code - a wrong code is
//      worse than an honest "absent".

import { appendFileSync, mkdirSync, openSync, closeSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const V2_EVENT_SCHEMA = 'af-v2-task-event-v1';
export const V2_MAX_LIMIT = 200;

/** Secrets by key name, and by shape: an explicit credential prefix, or a long opaque string that
 *  mixes cases (a random token). A long UPPER_CASE identifier is a code, not a secret - redacting
 *  it would destroy the very diagnostic this module exists to preserve. */
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;
// TWO expressions on purpose. The credential PREFIXES are case-insensitive, but the "long opaque
// value" heuristic needs a genuine case MIX to tell a random token from a hex digest - and an `i`
// flag silently breaks that (it makes both case lookaheads mean "some letter"), which redacted every
// git commit oid and sha256 in the event log. Found by reading a real promotion's event trail.
const CREDENTIAL_PREFIX = /(bearer\s+[A-Za-z0-9._-]{16,})|((?:sk|pk|ghp|gho|ghs|xox[baprs]|AKIA|AIza)[-_A-Za-z0-9]{16,})/i;
const MIXED_CASE_OPAQUE = /(?=[A-Za-z0-9_-]{32,})(?=[^a-z]*[a-z])(?=[^A-Z]*[A-Z])[A-Za-z0-9_-]{32,}/;

function redactValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const clipped = value.length > 500 ? `${value.slice(0, 500)}…[clipped]` : value;
    // test() uses non-global expressions (a `g` regex keeps lastIndex between calls and would
    // alternate true/false); the replacement builds fresh global copies so EVERY match goes.
    if (!CREDENTIAL_PREFIX.test(clipped) && !MIXED_CASE_OPAQUE.test(clipped)) return clipped;
    return clipped
      .replace(new RegExp(CREDENTIAL_PREFIX.source, 'gi'), '[redacted]')
      .replace(new RegExp(MIXED_CASE_OPAQUE.source, 'g'), '[redacted]');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) { out[k] = '[redacted]'; continue; }
      out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  return '[unrepresentable]';
}

/**
 * Where a task's events live: INSIDE the directory that holds the task records.
 *
 * That placement is deliberate. Earlier this was a sibling directory (`<tasks>/../v2-events`),
 * which meant a caller that isolated its tasks in a temp dir still had its events land beside the
 * *default* tasks dir - and suites that never pass an explicit tasksDir wrote a stray `v2-events/`
 * into the repository root. Keeping the projection inside the tasks dir makes isolation structural:
 * whoever isolates the task records isolates the events with them.
 */
export function eventsDirFor(tasksDir) {
  return process.env.AF_V2_EVENTS_DIR || join(tasksDir, 'events');
}

function eventsPath(eventsDir, taskId) {
  return join(eventsDir, `${taskId}.jsonl`);
}

/**
 * Append one event. BEST EFFORT: a projection that cannot be written must never break a run, so
 * this function reports the failure instead of throwing.
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function appendTaskEvent({ eventsDir, taskId, type, phase = null, detail = null, at = new Date().toISOString() }) {
  if (!eventsDir || !taskId || !type) return { ok: false, reason: 'eventsDir, taskId and type are required' };
  try {
    mkdirSync(eventsDir, { recursive: true });
    const line = JSON.stringify({ schema_version: V2_EVENT_SCHEMA, at, type, phase, detail: redactValue(detail) });
    appendFileSync(eventsPath(eventsDir, taskId), `${line}\n`);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: `the event could not be recorded: ${err.message}` };
  }
}

/**
 * Read a bounded page of events and reconcile them against the task snapshot.
 *
 * @returns {{ ok: boolean, task_id: string, events: object[], total: number, has_more: boolean,
 *   missing: boolean, gap: object|null, reason: string|null }}
 */
export function readTaskEvents({ eventsDir, taskId, snapshot = null, limit = 50, offset = 0 } = {}) {
  const bounded = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 50, V2_MAX_LIMIT));
  const from = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0);
  let lines = [];
  let missing = false;
  try {
    lines = readFileSync(eventsPath(eventsDir, taskId), 'utf8').split('\n').filter((l) => l.trim().length > 0);
  } catch (err) {
    if (err?.code !== 'ENOENT') return { ok: false, task_id: taskId, events: [], total: 0, has_more: false, missing: true, gap: null, reason: `the event history could not be read: ${err.message}` };
    missing = true;
  }

  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* a torn line is a real gap, handled below */ }
  }
  const torn = parsed.length !== lines.length;
  const page = parsed.slice(from, from + bounded);

  // Reconcile against the snapshot: the task file decides the lifecycle, so if it advanced past
  // what the projection recorded, say so instead of presenting a prettier history.
  let gap = null;
  const snapshotPhase = snapshot?.trusted_import?.phase ?? null;
  const lastPhase = parsed.length > 0 ? parsed[parsed.length - 1].phase : null;
  if (missing || parsed.length === 0) {
    gap = { marked: true, reason: 'no event history exists for this task (the task file remains the lifecycle truth)', snapshot_phase: snapshotPhase, last_event_phase: null };
  } else if (torn) {
    gap = { marked: true, reason: 'the event history contains unreadable lines', snapshot_phase: snapshotPhase, last_event_phase: lastPhase };
  } else if (snapshotPhase && snapshotPhase !== lastPhase) {
    gap = { marked: true, reason: `the task snapshot is at ${snapshotPhase} but the newest event is at ${lastPhase}`, snapshot_phase: snapshotPhase, last_event_phase: lastPhase };
  }

  return {
    ok: true,
    task_id: taskId,
    events: page,
    total: parsed.length,
    has_more: from + bounded < parsed.length,
    missing,
    gap,
    reason: null,
  };
}

/**
 * Persist the structured error beside the legacy `failure_reason`.
 *
 * The code is taken ONLY from `err.code` or an explicit `err.error_classification.code`. When
 * neither exists the code is `null` with `code_source: 'absent'`: we do not guess a precise code
 * from a message, because a wrong code misleads an operator far more than an honest gap.
 */
export function recordTrustedImportError(task, err, { at = new Date().toISOString() } = {}) {
  const thrownCode = typeof err?.code === 'string' && err.code.length > 0 ? err.code : null;
  const classifiedCode = typeof err?.error_classification?.code === 'string' && err.error_classification.code.length > 0
    ? err.error_classification.code
    : null;
  const code = thrownCode ?? classifiedCode;
  task.trusted_import = {
    ...(task.trusted_import ?? {}),
    last_error: {
      at,
      code,
      code_source: thrownCode ? 'err.code' : (classifiedCode ? 'error_classification.code' : 'absent'),
      message: redactValue(String(err?.message ?? err)),
      details: redactValue(err?.details ?? null),
      classification: redactValue(err?.error_classification ?? null),
    },
  };
  return task.trusted_import.last_error;
}

/** True when the file exists and is non-empty (used by tests and diagnostics). */
export function hasEventHistory(eventsDir, taskId) {
  try { return statSync(eventsPath(eventsDir, taskId)).size > 0; } catch { return false; }
}

/** Pre-create the log file so a reader never races the first append. */
export function ensureEventLog(eventsDir, taskId) {
  try {
    mkdirSync(eventsDir, { recursive: true });
    closeSync(openSync(eventsPath(eventsDir, taskId), 'a'));
    return true;
  } catch { return false; }
}
