// cancel.mjs - the V2 cancellation boundary (V2-FRONTEND-PLAN §6 G4).
//
// The rule the design demands: a cancel is honoured only at a TRUSTED PHASE BOUNDARY, and never
// once the promotion has begun - "a cancel API returning success" must never be read as "this task
// can no longer promote". So a cancel is a durable REQUEST, and the run itself decides at each
// boundary whether it can still be honoured:
//
//   proceed   - no request, keep going
//   cancel    - honoured at this boundary: the task stops as CANCELLED and releases its protection
//   too-late  - the ref update has begun: the promotion finishes and the outcome says so
//
// The request lives in a SIDECAR file next to the task (`<taskId>.cancel.json`) so the operator's
// write can never clobber the task record the running adapter owns. Publication is atomic
// (tmp + link), so requesting twice is idempotent and a partially written request is impossible.
//
// Fail-closed: an UNREADABLE request file is treated as "cancel" - we cannot rule out that an
// operator asked us to stop, so the run must not keep going on a guess.

import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CANCEL_REQUEST_SCHEMA = 'af-v2-cancel-request-v1';

/** Phases where a cancel may still be honoured (a trusted boundary precedes the next action). */
export const CANCELLABLE_PHASES = Object.freeze([
  'PROJECTED', 'AUTHOR_RUNNING', 'QUIESCE', 'CAPTURE', 'REVIEW', 'AUTHORIZATION', 'ACCEPTANCE',
  // The PROMOTION phase itself is still cancellable: the true point of no return is the moment the
  // ref update begins, which the adapter records as `promotion_started_at` (see beforeRefUpdate).
  'PROMOTION',
]);

/**
 * There is no phase after the ref update: `promotionStarted` is the real switch, and this constant
 * exists to name the post-commit state explicitly in the evidence.
 */
export const UNCANCELLABLE_PHASES = Object.freeze(['REF_UPDATE']);

const taskFile = (tasksDir, taskId) => join(tasksDir, `${taskId}.json`);
const requestFile = (tasksDir, taskId) => join(tasksDir, `${taskId}.cancel.json`);

/**
 * Publish a durable cancel request for a task. Idempotent: the first request wins and a second one
 * returns the original (an operator may retry without changing the recorded intent).
 *
 * @returns {{ ok: boolean, created?: boolean, request?: object, reason?: string }}
 */
export function requestCancel({ tasksDir, taskId, requestedBy = null, reason = null, now = Date.now() } = {}) {
  if (typeof taskId !== 'string' || !taskId.trim()) return { ok: false, reason: 'taskId is required' };
  if (typeof requestedBy !== 'string' || !requestedBy.trim()) return { ok: false, reason: 'requestedBy is required' };
  if (typeof reason !== 'string' || !reason.trim()) return { ok: false, reason: 'a cancel needs a recorded reason' };

  // Never create a marker for a task that does not exist: it would outlive a typo and block a
  // later, unrelated run that happens to reuse the id.
  try {
    readFileSync(taskFile(tasksDir, taskId), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: false, reason: `no such task: ${taskId}` };
    return { ok: false, reason: `the task record could not be read: ${err.message}` };
  }

  const record = {
    schema_version: CANCEL_REQUEST_SCHEMA,
    task_id: taskId,
    requested_at: new Date(now).toISOString(),
    requested_by: requestedBy.trim(),
    reason: reason.trim(),
  };
  const target = requestFile(tasksDir, taskId);
  const tmp = `${target}.${process.pid}-${now}.tmp`;
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, target);
    return { ok: true, created: true, request: record };
  } catch (err) {
    if (err?.code === 'EEXIST') {
      const existing = readCancelRequest({ tasksDir, taskId });
      return { ok: true, created: false, request: existing.request, reason: 'a cancel was already requested for this task (idempotent)' };
    }
    return { ok: false, reason: `the cancel request could not be published: ${err.message}` };
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Read the cancel request strictly.
 * @returns {{ state: 'none'|'requested'|'unverifiable', request: object|null, reason: string|null }}
 */
export function readCancelRequest({ tasksDir, taskId } = {}) {
  try {
    const raw = readFileSync(requestFile(tasksDir, taskId), 'utf8');
    const request = JSON.parse(raw);
    if (!request || request.schema_version !== CANCEL_REQUEST_SCHEMA) {
      return { state: 'unverifiable', request: null, reason: 'the cancel request has an unknown schema' };
    }
    return { state: 'requested', request, reason: null };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { state: 'none', request: null, reason: null };
    return { state: 'unverifiable', request: null, reason: `the cancel request could not be read (${err.message}); treating it as a stop request rather than guessing` };
  }
}

/**
 * Decide what a boundary should do.
 *
 * @returns {{ action: 'proceed'|'cancel'|'too-late', reason: string|null }}
 */
export function cancelDecision({ phase, cancel, promotionStarted = false } = {}) {
  if (!cancel || cancel.state === 'none') return { action: 'proceed', reason: null };
  if (cancel.state === 'unverifiable') return { action: 'cancel', reason: `cancel request unverifiable: ${cancel.reason}` };
  if (promotionStarted === true || UNCANCELLABLE_PHASES.includes(phase)) {
    return { action: 'too-late', reason: 'the promotion has begun; the ref update cannot be undone - the outcome will say so' };
  }
  if (!CANCELLABLE_PHASES.includes(phase)) {
    return { action: 'too-late', reason: `phase ${phase} is not a cancellable boundary` };
  }
  return { action: 'cancel', reason: `cancel honoured at the ${phase} boundary` };
}
