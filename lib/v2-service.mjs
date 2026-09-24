// v2-service.mjs - the dedicated V2 submission and EXECUTION OWNERSHIP service (§6 G2).
//
// Why this exists: the legacy `submitTask` defaults to `withPlan=true`/`withIntentGate=true`, so a
// V2 task submitted through it can wander into the legacy planning/approval path, and an HTTP handler
// that calls `executeTask` directly ties the run's lifetime to the request. This module replaces
// both: it validates, resolves trusted configuration, assigns the control-plane-owned workspace
// paths, persists the task record, and hands the run to a SINGLE lock-guarded owner.
//
// Guarantees:
//   * the submitter never chooses executors, roles, limits or paths (platform-bound), and the
//     created record carries `multi_step_dispatch: false` with no plan attached - the legacy
//     planning path is never consulted here (asserted by a static guard in the tests);
//   * creation is IDEMPOTENT per idempotency key: the first writer binds the key to a task and any
//     retry returns that same task instead of creating a second one;
//   * starting is owned by exactly one process at a time via the existing task lock, and a second
//     start is refused rather than racing; a restart RESUMES from the durable phase machine, so the
//     author is never re-run;
//   * terminal tasks are refused; a FAILED V2 task needs the explicit re-entry authorisation.

import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { planPreview } from './submission.mjs';
import { saveTaskAtomic } from './store.mjs';
import { acquireTaskLock, releaseTaskLock } from './tasklock.mjs';

export const V2_TASK_SCHEMA = 'af-v2-task-v1';
export const V2_TERMINAL_STATES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED']);
export const V2_RESUMABLE_STATES = Object.freeze(['TRUSTED_IMPORT_RUNNING', 'AUTHOR_RUNNING', 'REVIEW_RUNNING']);

/** Path containment without following the last component; both sides are resolved first. */
function isInside(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/**
 * Create (or return the already-created) V2 task for a submission.
 *
 * @returns {{ ok: boolean, created?: boolean, task_id?: string, operation_id?: string,
 *   task?: object, reason?: string, first_failure?: string }}
 */
export function createV2Task({
  spec,
  allowedRoots = [],
  tasksDir,
  submissionsDir = null,
  workspaceRoot = null,
  authorExecutor = process.env.AF_V2_AUTHOR_EXECUTOR || 'codex',
  reviewerExecutor = process.env.AF_V2_REVIEWER_EXECUTOR || 'cline',
  env = process.env,
  now = () => new Date(),
} = {}) {
  if (!tasksDir) return { ok: false, reason: 'tasksDir is required' };
  const preflight = planPreview({ spec, allowedRoots, env });
  if (!preflight.ok) return { ok: false, reason: preflight.reason, first_failure: preflight.first_failure };

  const key = String(spec.idempotency_key).trim();
  const digest = keyDigest(key);
  const dir = submissionsDir || join(tasksDir, '..', 'submissions');
  mkdirSync(dir, { recursive: true });
  const bindingPath = join(dir, `${digest}.task.json`);

  // Idempotent binding: the first writer wins; a retry reads the winner's task instead of creating
  // a second one. link() is the atomic test-and-set, so two concurrent submissions cannot both win.
  const taskId = `TASK-V2-${digest.slice(0, 8)}-${now().getTime().toString(36)}`;
  const binding = { schema_version: V2_TASK_SCHEMA, key_digest: digest, task_id: taskId, created_at: now().toISOString() };
  const tmp = `${bindingPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
  let created = true;
  try {
    linkSync(tmp, bindingPath);
  } catch (err) {
    if (err?.code !== 'EEXIST') { rmSync(tmp, { force: true }); return { ok: false, reason: `the submission binding could not be published: ${err.message}` }; }
    created = false;
  } finally {
    rmSync(tmp, { force: true });
  }
  if (!created) {
    const existing = JSON.parse(readFileSync(bindingPath, 'utf8'));
    const existingTask = readTaskFile(tasksDir, existing.task_id);
    return { ok: true, created: false, task_id: existing.task_id, task: existingTask, reason: 'this idempotency key already created a task (the original is returned)' };
  }

  // Platform-bound configuration: the control plane assigns the workspace, never the submitter.
  const targetPath = spec.target_path;
  const root = workspaceRoot || env.AF_V2_WORKSPACE_ROOT || join(tasksDir, '..', 'v2-workspaces');
  const candidateDir = join(root, taskId, 'candidate');
  const casDir = join(root, taskId, 'cas');
  mkdirSync(candidateDir, { recursive: true });
  mkdirSync(casDir, { recursive: true });

  if (isInside(targetPath, candidateDir) || isInside(candidateDir, targetPath)) {
    return { ok: false, reason: 'the assigned candidate directory must not overlap the target repository' };
  }
  if (isInside(targetPath, casDir) || isInside(casDir, targetPath)) {
    return { ok: false, reason: 'the assigned CAS directory must not overlap the target repository' };
  }
  if (resolve(candidateDir) === resolve(casDir)) return { ok: false, reason: 'the candidate and CAS directories must be distinct' };
  if (!authorExecutor || !reviewerExecutor || authorExecutor === reviewerExecutor) {
    return { ok: false, reason: 'the platform must bind two DIFFERENT executors for the author and the independent reviewer' };
  }

  const task = {
    task_id: taskId,
    schema_version: V2_TASK_SCHEMA,
    task_mode: 'workspace',
    state: 'CREATED',
    state_version: 1,
    created_at: now().toISOString(),
    goal: spec.goal,
    fixture_dir: targetPath,
    acceptance_cmd: { command: spec.acceptance.command, args: spec.acceptance.args ?? [] },
    acceptance_binding: null,
    // The legacy multi-step planning path is deliberately not part of this service: dispatch stays
    // single-flow and no plan is ever attached to the record.
    multi_step_dispatch: false,
    requires_mcp: false,
    author_executor: authorExecutor,
    reviewer_executor: reviewerExecutor,
    author_role: 'author',
    reviewer_role: 'reviewer',
    runs: [],
    trusted_import: {
      enabled: true,
      phase: null,
      candidate_dir: candidateDir,
      cas_dir: casDir,
      proposed_required: Array.isArray(spec.proposed_required) && spec.proposed_required.length > 0 ? spec.proposed_required : ['.'],
      source_submission: { key_digest: digest },
    },
  };
  saveTaskAtomic(join(tasksDir, `${taskId}.json`), task);

  return {
    ok: true,
    created: true,
    task_id: taskId,
    operation_id: `op-${digest.slice(0, 12)}`,
    task,
    reason: null,
  };
}

/** Same derivation as lib/submission.mjs (sha256 of the trimmed key, first 16 hex chars) so a
 *  submission record and this binding always agree on which task a key maps to. */
function keyDigest(key) {
  return createHash('sha256').update(String(key).trim()).digest('hex').slice(0, 16);
}

function readTaskFile(tasksDir, taskId) {
  try {
    return JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Take execution ownership and hand the run to `runner`. Exactly one owner at a time (task lock);
 * a second concurrent start is refused, and a restart resumes instead of re-running the author.
 *
 * @returns {{ ok: boolean, outcome: 'started'|'resumed'|'refused'|'already_running', task_id: string,
 *   mode?: 'start'|'resume', reason?: string| null, holder?: object }}
 */
export async function startOrResumeV2Task({
  taskId,
  tasksDir,
  locksDir,
  runner,
  orchestratorInstanceId = `v2-service-${process.pid}`,
  allowFailedReentry = false,
  leaseMs = 15 * 60_000,
} = {}) {
  if (!taskId || !tasksDir) return { ok: false, outcome: 'refused', task_id: taskId ?? null, reason: 'taskId and tasksDir are required' };
  if (typeof runner !== 'function') return { ok: false, outcome: 'refused', task_id: taskId, reason: 'a runner is required' };

  const task = readTaskFile(tasksDir, taskId);
  if (!task) return { ok: false, outcome: 'refused', task_id: taskId, reason: 'no such task' };
  if (task.trusted_import?.enabled !== true) return { ok: false, outcome: 'refused', task_id: taskId, reason: 'not a V2 trusted-import task' };
  if (task.state === 'WAITING_HUMAN') return { ok: false, outcome: 'refused', task_id: taskId, reason: 'the task is parked at the Human Gate; resolve it first' };
  if (V2_TERMINAL_STATES.includes(task.state) && !(task.state === 'FAILED' && allowFailedReentry === true)) {
    return { ok: false, outcome: 'refused', task_id: taskId, reason: `task is ${task.state}; a terminal task is not started by this service` };
  }

  let lock;
  try {
    lock = acquireTaskLock(locksDir, taskId, { orchestratorInstanceId, leaseMs });
  } catch (err) {
    // The lock module reports contention by THROWING; that is a refusal here, never a race.
    if (err?.code === 'TASK_ALREADY_RUNNING') {
      return { ok: false, outcome: 'already_running', task_id: taskId, reason: 'another owner holds the task lock', holder: err.lock ?? null };
    }
    throw err;
  }
  const mode = task.state === 'CREATED' ? 'start' : 'resume';
  try {
    await runner({ task, mode });
    return { ok: true, outcome: mode === 'start' ? 'started' : 'resumed', mode, task_id: taskId, reason: null };
  } finally {
    releaseTaskLock(locksDir, taskId, lock.lock);
  }
}
