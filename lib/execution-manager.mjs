// One execution entry for V2 CLI and HTTP. Dispatch is durable before a worker is launched.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireTaskLock, maintainTaskLease, releaseTaskLock } from './tasklock.mjs';
import { saveTaskWithVersion } from './store.mjs';
import { withTaskContext } from './task-runtime.mjs';
import { resolveDataRoots } from './data-roots.mjs';
import { normalizeV2Task, V2_TERMINAL_STATES } from './v2-task.mjs';
import { resumeV2Workflow } from './workflows/v2.mjs';
import { activeRunsForTask, terminateRun } from './adapters.mjs';
import { verifyPersistedHumanApproval, persistedHumanApprovalProvider } from './trusted-import/human-gate-provider.mjs';

const DISPATCH_TIMEOUT_MS = 60_000;
const validTaskId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const refused = (taskId, reason, outcome = 'refused', extra = {}) => ({ ok: false, outcome, task_id: taskId ?? null, reason, ...extra });

function validate(task, allowFailedReentry) {
  if (task.trusted_import?.enabled !== true) return 'not a V2 trusted-import task';
  if (!task.trusted_import.acceptance?.acceptance_profile_digest) return 'no trusted acceptance profile is bound to this task; create it through a registered project profile';
  if (task.state === 'WAITING_HUMAN' && !verifyPersistedHumanApproval(task)) return 'the task is parked at the Human Gate; a valid signed approval for this candidate is required';
  if (V2_TERMINAL_STATES.includes(task.state) && !(task.state === 'FAILED' && allowFailedReentry === true)) return `task is ${task.state}; a terminal task is not started by this service`;
  return null;
}

function readTask(tasksDir, taskId) {
  try { return JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf8')); }
  catch (err) { if (err?.code === 'ENOENT') return null; throw err; }
}

function pendingDispatch(task) {
  return task.execution?.status === 'DISPATCHED' && Date.parse(task.execution.claim_deadline) > Date.now();
}

function takeLock(locksDir, taskId, instanceId, leaseMs) {
  try { return acquireTaskLock(locksDir, taskId, { orchestratorInstanceId: instanceId, leaseMs }); }
  catch (err) {
    if (err?.code === 'TASK_ALREADY_RUNNING') return refused(taskId, 'another owner holds the task lock', 'already_running', { holder: err.lock ?? null });
    throw err;
  }
}

/** Reserve a dispatch; a retry cannot spawn another worker before the first one claims it. */
export async function dispatchV2Task({ taskId, tasksDir, locksDir, runtimeDir, dispatcher, allowFailedReentry = false, dispatchTimeoutMs = DISPATCH_TIMEOUT_MS } = {}) {
  if (!validTaskId(taskId) || !tasksDir || typeof dispatcher !== 'function') return refused(taskId, 'valid taskId, tasksDir and dispatcher are required');
  if (!Number.isFinite(dispatchTimeoutMs) || dispatchTimeoutMs < 0) return refused(taskId, 'dispatchTimeoutMs must be a non-negative number');
  const roots = resolveDataRoots();
  locksDir ??= roots.locks;
  runtimeDir ??= roots.runtime;
  const existing=readTask(tasksDir,taskId);
  if(existing?.team_binding) {
    const {commandTeam}=await import('./team/service.mjs');
    return commandTeam({runtimeDir,tasksDir,locksDir,teamId:existing.team_binding.team_id,command:{type:'start'}});
  }
  const owned = takeLock(locksDir, taskId, `v2-dispatch-${process.pid}-${randomUUID()}`, 15 * 60_000);
  if (owned.ok === false) return owned;
  let task;
  let operation;
  try {
    task = readTask(tasksDir, taskId);
    if (!task) return refused(taskId, 'no such task');
    if(task.team_binding) return refused(taskId,'task was bound to a team; use its controller','team_controller_required',{team_id:task.team_binding.team_id});
    const reason = validate(task, allowFailedReentry);
    if (reason) return refused(taskId, reason);
    if (pendingDispatch(task)) return refused(taskId, 'a worker dispatch is already pending', 'already_running', { operation_id: task.execution.operation_id });
    operation = {
      operation_id: `op-${taskId}-${randomUUID()}`, status: 'DISPATCHED',
      requested_at: new Date().toISOString(), claim_deadline: new Date(Date.now() + dispatchTimeoutMs).toISOString(),
      allow_failed_reentry: allowFailedReentry === true,
    };
    task.execution = operation;
    saveTaskWithVersion(tasksDir, task);
  } finally { releaseTaskLock(locksDir, taskId, owned.lock); }

  // The short dispatch lock has been released; the worker claims the durable operation id.
  try {
    const worker = await dispatcher(taskId, { operationId: operation.operation_id, tasksDir, locksDir, runtimeDir, allowFailedReentry: operation.allow_failed_reentry });
    if (worker?.ok === false) throw new Error(worker.reason ?? 'worker dispatch failed');
    return { ok: true, outcome: 'dispatched', task_id: taskId, operation_id: operation.operation_id, worker_pid: worker?.pid ?? null, reason: null };
  } catch (err) {
    // Reconcile only our own unclaimed request. A worker that already claimed it owns all writes.
    const guard = takeLock(locksDir, taskId, `v2-dispatch-failure-${randomUUID()}`, 15 * 60_000);
    if (guard.ok !== false) {
      try {
        const current = readTask(tasksDir, taskId);
        if (current?.execution?.operation_id === operation.operation_id && current.execution.status === 'DISPATCHED') {
          current.execution = { ...current.execution, status: 'DISPATCH_FAILED', finished_at: new Date().toISOString(), error: String(err.message ?? err) };
          saveTaskWithVersion(tasksDir, current);
        }
      } finally { releaseTaskLock(locksDir, taskId, guard.lock); }
    }
    return refused(taskId, `worker dispatch failed: ${err.message ?? err}`, 'dispatch_failed', { operation_id: operation.operation_id });
  }
}

/** Claim the task for the entire run, with a shared heartbeat and fenced lifecycle writes. */
export async function startOrResumeV2Task({
  taskId, tasksDir, locksDir, runtimeDir, runner = null, operationId = null,
  orchestratorInstanceId = `v2-execution-${process.pid}-${randomUUID()}`,
  allowFailedReentry = false, leaseMs = 15 * 60_000,
} = {}) {
  if (!validTaskId(taskId) || !tasksDir) return refused(taskId, 'valid taskId and tasksDir are required');
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) return refused(taskId, 'leaseMs must be a positive number');
  const roots = resolveDataRoots();
  locksDir ??= roots.locks;
  runtimeDir ??= roots.runtime;
  const existing=readTask(tasksDir,taskId);
  if(existing?.team_binding && !runner) {
    const {commandTeam}=await import('./team/service.mjs');
    return commandTeam({runtimeDir,tasksDir,locksDir,teamId:existing.team_binding.team_id,command:{type:'start'}});
  }
  const owned = takeLock(locksDir, taskId, orchestratorInstanceId, leaseMs);
  if (owned.ok === false) return owned;
  let lease;
  let task;
  try {
    task = readTask(tasksDir, taskId);
    if (!task) return refused(taskId, 'no such task');
    if(task.team_binding && !runner) return refused(taskId,'task was bound to a team; use its controller','team_controller_required',{team_id:task.team_binding.team_id});
    if (operationId) {
      if (task.execution?.operation_id !== operationId || task.execution.status !== 'DISPATCHED') return refused(taskId, 'this dispatch was superseded or already claimed');
      if (!pendingDispatch(task)) return refused(taskId, 'the worker claim deadline expired; submit a new start request');
      allowFailedReentry = task.execution.allow_failed_reentry === true;
    } else if (pendingDispatch(task)) {
      return refused(taskId, 'a worker dispatch is already pending', 'already_running', { operation_id: task.execution.operation_id });
    }
    const reason = validate(task, allowFailedReentry);
    if (reason) return refused(taskId, reason);
    normalizeV2Task(task);
    const mode = task.state === 'CREATED' ? 'start' : 'resume';
    lease = maintainTaskLease(locksDir, taskId, owned.lock, {
      leaseMs, onLost: () => { for (const run of activeRunsForTask(taskId)) void terminateRun(run.run_id).catch(() => {}); },
    });
    withTaskContext(task, { tasksDir, runtimeDir, assertOwnership: lease.assertOwned });
    task.execution = {
      ...(operationId ? task.execution : { operation_id: `op-${taskId}-${randomUUID()}`, requested_at: new Date().toISOString() }),
      status: 'RUNNING', owner_pid: process.pid, owner_token: owned.lock.owner_token, claimed_at: new Date().toISOString(),
    };
    saveTaskWithVersion(tasksDir, task);
    const result = runner
      ? await runner({ task, mode, assertOwnership: lease.assertOwned })
      : await resumeV2Workflow(task, undefined, { allowV2FailedReentry: allowFailedReentry, humanApprovalProvider:persistedHumanApprovalProvider() });
    lease.assertOwned();
    const current = readTask(tasksDir, taskId) ?? task;
    current.execution = { ...task.execution, status: current.state === 'FAILED' ? 'FAILED' : 'SETTLED', task_state: current.state, finished_at: new Date().toISOString() };
    if(current.state==='WAITING_HUMAN' && current.trusted_import?.pending_human_context) current.trusted_import.pending_human_context.state_version=(current.state_version??0)+1;
    saveTaskWithVersion(tasksDir, current);
    if (current.state === 'FAILED' || result?.state === 'FAILED') return refused(taskId, current.failure_reason ?? result.failure_reason ?? 'the V2 workflow failed', 'failed', { operation_id: task.execution.operation_id });
    return { ok: true, outcome: mode === 'start' ? 'started' : 'resumed', mode, task_id: taskId, operation_id: task.execution.operation_id, state: current.state, reason: null };
  } catch (err) {
    if (err?.code === 'TASK_LOCK_LOST') return refused(taskId, err.message, 'ownership_lost');
    if (task && lease) {
      lease.assertOwned();
      const current = readTask(tasksDir, taskId) ?? task;
      current.execution = { ...task.execution, status: 'FAILED', finished_at: new Date().toISOString(), error: String(err.message ?? err) };
      saveTaskWithVersion(tasksDir, current);
    }
    throw err;
  } finally {
    lease?.stop();
    releaseTaskLock(locksDir, taskId, owned.lock);
  }
}
