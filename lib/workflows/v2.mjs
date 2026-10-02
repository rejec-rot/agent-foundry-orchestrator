// Dedicated V2 workflow: all retries re-enter the complete Trusted Import gate sequence.
import { ADAPTERS, activeRunsForTask } from '../adapters.mjs';
import { assertTrustedImportAdmission, runTrustedImportTask } from '../trusted-import/orchestrator-adapter.mjs';
import { saveTask, tasksDirOf, TERMINAL_STATES } from '../task-runtime.mjs';
import { runAuthor, runReview } from '../task-execution.mjs';
import { prepareTaskForExecution, settleExecutionError } from '../workflow-state.mjs';
import { normalizeV2Task } from '../v2-task.mjs';
import { persistedHumanApprovalProvider } from '../trusted-import/human-gate-provider.mjs';

export async function executeV2Workflow(task, adapters = ADAPTERS, {
  onRunStart = null, trustedImportHooks = {}, humanApprovalProvider = null,
  isShutdownRequested = null, shutdownMode = null,
  deliverySource = null, validateDelivery = null,
  onRunSettled = null,
} = {}) {
  if (task.team_binding && typeof deliverySource !== 'function') {
    throw Object.assign(new Error('team deliveries must be produced by the collaboration controller'), {code:'TEAM_CONTROLLER_REQUIRED'});
  }
  const cancelled = prepareTaskForExecution(task);
  if (cancelled) return cancelled;
  normalizeV2Task(task);
  humanApprovalProvider ??= persistedHumanApprovalProvider();
  assertTrustedImportAdmission(task);
  task.state = 'TRUSTED_IMPORT_RUNNING';
  saveTask(task);
  try {
    for (;;) {
      task.__assertOwnership?.();
      try {
        return await runTrustedImportTask(task, {
          tasksDir: tasksDirOf(task),
          runAuthor: (revision, opts = {}) => deliverySource ? deliverySource(revision,opts) : runAuthor(task, revision, adapters, { ...opts, onRunStart: opts.onRunStart ?? onRunStart }),
          runReview: (revision, opts = {}) => runReview(task, revision, adapters, { ...opts, requireIndependentExecutor: true, onRunStart: opts.onRunStart ?? onRunStart, onRunSettled }),
          saveTask, onRunStart, trustedImportHooks, humanApprovalProvider, validateDelivery,
          terminationVerifier: async ({ task: currentTask, evidence }) => (
            activeRunsForTask(currentTask.task_id).length === 0
            && evidence.every((item) => item?.termination_confirmed === true && item?.process_group_alive === false && item?.scope_verified === true)
          ),
        });
      } catch (err) {
        // Only a reviewer-requested, durably budgeted fix continues automatically.
        if (err?.code !== 'TRUSTED_IMPORT_NEEDS_FIX_RETRY') throw err;
        const shutdown = typeof isShutdownRequested === 'function' ? isShutdownRequested() : isShutdownRequested;
        if (shutdown) throw err;
      }
    }
  } catch (err) {
    return settleExecutionError(task, err, { isShutdownRequested, shutdownMode });
  }
}

export async function resumeV2Workflow(task, adapters = ADAPTERS, options = {}) {
  const reentry = task.state === 'FAILED' && options.allowV2FailedReentry === true;
  if (TERMINAL_STATES.has(task.state) && !reentry) {
    throw Object.assign(new Error(`TASK_TERMINAL: task ${task.task_id} is ${task.state} - recovery refused`), { code: 'TASK_TERMINAL' });
  }
  if (reentry) {
    task.trusted_import.reentry_authorized_at = new Date().toISOString();
    task.trusted_import.reentry_from_state = task.state;
  }
  return executeV2Workflow(task, adapters, options);
}
