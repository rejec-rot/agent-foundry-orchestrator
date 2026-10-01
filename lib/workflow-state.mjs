// Common lifecycle normalization and failure persistence.
import { loadTask, tasksDirOf, saveTask, NON_REVIVABLE_STATES } from './task-runtime.mjs';
import { classifyExecutionError } from './executor-error-classifier.mjs';
import { appendTaskEvent, eventsDirFor, recordTrustedImportError } from './v2-events.mjs';

export function prepareTaskForExecution(task) {
  // Never revive a task that already reached a terminal state, and never start
  // an executor for one the operator already cancelled: the on-disk task is the
  // lifecycle truth, so a stale in-memory copy must not overwrite it.
  try {
    const onDiskAtEntry = loadTask(task.task_id, tasksDirOf(task));
    if (NON_REVIVABLE_STATES.has(onDiskAtEntry.state)) return onDiskAtEntry;
    if (onDiskAtEntry.cancel_requested_at) {
      task.cancel_requested_at = onDiskAtEntry.cancel_requested_at;
      task.cancelled_by = onDiskAtEntry.cancelled_by ?? task.cancelled_by;
      task.cancel_reason = task.cancel_reason ?? 'cancelled by operator before execution';
      task.state = 'CANCELLED';
      task.cancelled_at = task.cancelled_at ?? new Date().toISOString();
      task.retryable = false;
      saveTask(task);
      return task;
    }
  } catch (err) { if (err?.code === 'TASK_LOCK_LOST') throw err; /* task not persisted yet */ }

  // tolerate minimally-shaped task objects (tests, programmatic callers)
  task.runs = task.runs ?? [];
  task.revisions_used = task.revisions_used ?? 1;
  task.author_role = task.author_role ?? 'author';
  task.reviewer_role = task.reviewer_role ?? 'reviewer';
  task.red_lines = Array.isArray(task.red_lines) ? task.red_lines : [];
  task.review_rules = Array.isArray(task.review_rules) ? task.review_rules : [];
  task.fixture_dir = task.fixture_dir ?? '/tmp';
  task.acceptance = task.acceptance ?? (task.goal || '');
  if (task.task_mode === 'governed_write') {
    // governed tasks imply unattended MCP steps (formal review via vault-mcp)
    task.requires_mcp = true;
  }
  return null;
}

export function settleExecutionError(task, err, { isShutdownRequested = null, shutdownMode = null } = {}) {
  task.__assertOwnership?.();
  if (err?.code === 'TASK_LOCK_LOST') throw err;
  const isShutdown = typeof isShutdownRequested === 'function' ? isShutdownRequested() : !!isShutdownRequested;
  const sMode = typeof shutdownMode === 'function' ? shutdownMode() : shutdownMode;
  if (isShutdown) {
    if (sMode === 'interrupt' || err?.code !== 'RUN_CANCELLED') {
      task.interrupted_at = new Date().toISOString();
      task.interrupted_reason = 'shutdown requested during task execution';
      saveTask(task);
      return task;
    }
  }
  if (err?.code === 'RUN_CANCELLED') {
    try {
      const onDisk = loadTask(task.task_id, tasksDirOf(task));
      if (onDisk.termination) task.termination = onDisk.termination;
      if (onDisk.cancel_requested_at) task.cancel_requested_at = onDisk.cancel_requested_at;
      if (onDisk.cancelled_by) task.cancelled_by = onDisk.cancelled_by;
    } catch { /* ignore */ }
    task.state = 'CANCELLED';
    task.cancelled_at = task.cancelled_at ?? new Date().toISOString();
    task.cancel_reason = task.cancel_reason ?? 'cancelled while executor run was active';
    task.retryable = false;
    saveTask(task);
    return task;
  }
  // A non-revivable state already on disk wins: an operator cancellation that
  // landed while this run was unwinding must not be overwritten with FAILED.
  try {
    const onDisk = loadTask(task.task_id, tasksDirOf(task));
    if (NON_REVIVABLE_STATES.has(onDisk.state)) return onDisk;
  } catch { /* ignore */ }
  task.state = 'FAILED';
  task.failure_reason = String(err?.message ?? err);
  // §6 G5: keep the legacy message AND persist the structured code/details beside it. V2 tasks
  // only - the field is part of the trusted-import projection.
  if (task.trusted_import?.enabled === true) {
    try {
      recordTrustedImportError(task, err);
      appendTaskEvent({ eventsDir: eventsDirFor(tasksDirOf(task)), taskId: task.task_id, type: 'failure', phase: task.trusted_import?.phase ?? null, detail: { message: task.failure_reason, code: task.trusted_import.last_error.code } });
    } catch { /* the projection must never mask the original failure */ }
  }
  if (err?.error_classification) {
    task.error_classification = err.error_classification;
    task.retryable = err.error_classification.retryable;
  } else {
    const classification = classifyExecutionError(task.author_session_executor_type || task.author_executor, {
      exit_code: 1,
      stderr: task.failure_reason,
    });
    task.error_classification = classification;
    task.retryable = classification.retryable;
  }
  saveTask(task);
  return task;
}
