// Shared task persistence and execution context; context is never serialized.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataRoots } from './data-roots.mjs';
import { readTaskFile, taskFileExists, saveTaskWithVersion } from './store.mjs';

export const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

// A cancellation is sticky: a later dispatch must never revive a cancelled task
// or overwrite its verdict. FAILED is excluded because the scheduler
// deliberately re-dispatches it to spend its bounded retry / fallback budget.
export const NON_REVIVABLE_STATES = new Set(['CANCELLED']);

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const roots = resolveDataRoots(process.env, ROOT);
export const TASKS_DIR = roots.tasks;
export const LOCKS_DIR = roots.locks;
export const MAX_REVISIONS_DEFAULT = 3;

export const RUNNING_STATES = new Set(['AUTHOR_RUNNING', 'FIX_RUNNING', 'REVIEW_RUNNING', 'TRUSTED_IMPORT_RUNNING']);

export function taskPath(taskId) {
  return join(TASKS_DIR, `${taskId}.json`);
}

// A task object may carry a non-enumerable __tasksDir (set by continueTask /
// resumeGovernance when recovering from an injected tasks dir); default writes
// always go to the canonical TASKS_DIR.
export function tasksDirOf(task) {
  return task?.__tasksDir ?? TASKS_DIR;
}

export function saveTask(task) {
  // Phase 1.1: atomic write + monotonic state_version for update ordering.
  // Delegates to the single version-incrementing writer in lib/store.mjs.
  saveTaskWithVersion(tasksDirOf(task), task);
}

export function loadTask(taskId, tasksDir = TASKS_DIR) {
  const p = join(tasksDir, `${taskId}.json`);
  if (!taskFileExists(p)) throw new Error(`task not found: ${taskId}`);
  return readTaskFile(p);
}

export function withTasksDir(task, tasksDir) {
  if (tasksDir && tasksDir !== TASKS_DIR) {
    Object.defineProperty(task, '__tasksDir', { value: tasksDir, enumerable: false, configurable: true });
  }
  return task;
}

export function withTaskContext(task, { tasksDir, runtimeDir, assertOwnership } = {}) {
  withTasksDir(task, tasksDir);
  if (runtimeDir) Object.defineProperty(task, '__runtimeDir', { value: runtimeDir, enumerable: false, configurable: true });
  if (assertOwnership) Object.defineProperty(task, '__assertOwnership', { value: assertOwnership, enumerable: false, configurable: true });
  return task;
}
