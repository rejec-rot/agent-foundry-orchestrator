#!/usr/bin/env node

// af-admin.mjs - PHASE 5-B Executor Operations CLI
import {
  getExecutorOperationsStatus,
  formatExecutorStatus,
  listCircuitBreakers,
  formatCircuitList,
  resetCircuitBreaker,
  executeRecoveryProbe,
  admitRecoveredExecutor,
  formatRecoveryProbeResult,
  formatAdmissionResult,
  pruneTasks,
  formatTasksPruneResult,
  rotateLogs,
  formatLogRotationResult,
} from './lib/executor-ops.mjs';
import { reapOrphans, formatReclaimResult } from './lib/orphan-reaper.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureRestorePoint,
  listRestorePoints,
  restoreToPoint,
  formatRollbackResult,
} from './lib/rollback.mjs';
import { acquireTaskLock, releaseTaskLock } from './lib/tasklock.mjs';
import { saveTaskWithVersion } from './lib/store.mjs';
import { recoverRetainedBoundary } from './lib/host-boundary.mjs';

const AF_ROOT = join(dirname(fileURLToPath(import.meta.url)));
const TASKS_DIR = process.env.AF_TASKS_DIR || join(AF_ROOT, 'tasks');
const LOCKS_DIR = process.env.AF_LOCKS_DIR || join(AF_ROOT, 'locks');

/** Load a task file, or exit with a clear message. */
function loadTaskForRollback(taskId, tasksDir) {
  const path = join(tasksDir, `${taskId}.json`);
  try {
    return { path, task: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    console.error(`error: cannot read task ${taskId} from ${tasksDir}: ${String(err?.message ?? err)}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const mainCmd = args[0];
const subCmd = args[1];

function argValue(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return null;
}

function printUsage() {
  console.log(`usage:
  af-admin executor status [executor]
  af-admin executor recovery probe <executor>
  af-admin executor recovery admit <executor> --evidence <id> --reason "<reason>" [--admitted-by "<name>"]
  af-admin circuit list
  af-admin circuit reset <executor> --reason "<reason>" [--reset-by "<name>"]
  af-admin tasks prune [--confirm] [--tasks-dir <path>]
  af-admin logs rotate [--days <N>] [--events-file <path>] [--archive-dir <path>]
  af-admin reclaim orphans [--confirm] [--runs-dir <path>]
  af-admin boundary recover --canonical <dir> [--cas <dir>] --reason "<reason>" [--ack-live-scopes] [--allow-guessed-modes] [--recovered-by "<name>"]
  af-admin restore-point list --task-id <id> [--tasks-dir <path>]
  af-admin restore-point capture --task-id <id> [--revision <n>] [--label <text>] [--tasks-dir <path>]
  af-admin restore-point restore --task-id <id> --revision <n> [--confirm] [--prune] [--tasks-dir <path>]`);
}

async function main() {
  if (!mainCmd || mainCmd === '--help' || mainCmd === '-h' || mainCmd === 'help') {
    printUsage();
    process.exit(0);
  }

  if (mainCmd === 'executor') {
    if (subCmd === 'status') {
      const target = args[2] && !args[2].startsWith('-') ? args[2] : argValue('--executor');
      if (target) {
        try {
          const status = getExecutorOperationsStatus(target);
          console.log(formatExecutorStatus(status));
          process.exit(0);
        } catch (err) {
          console.error(`error: ${err.message}`);
          process.exit(1);
        }
      } else {
        const list = listCircuitBreakers();
        const formatted = list.map((item) => {
          const status = getExecutorOperationsStatus(item.id);
          return formatExecutorStatus(status);
        }).join('\n\n---\n\n');
        console.log(formatted);
        process.exit(0);
      }
    } else if (subCmd === 'recovery') {
      const action = args[2];
      if (action === 'probe') {
        const target = args[3] && !args[3].startsWith('-') ? args[3] : argValue('--executor');
        if (!target) {
          console.error('error: executor is required: af-admin executor recovery probe <executor>');
          process.exit(1);
        }
        try {
          const res = await executeRecoveryProbe(target);
          console.log(formatRecoveryProbeResult(res));
          process.exit(res.success ? 0 : 1);
        } catch (err) {
          console.error(`error: ${err.message}`);
          process.exit(1);
        }
      } else if (action === 'admit') {
        const target = args[3] && !args[3].startsWith('-') ? args[3] : argValue('--executor');
        const evidence = argValue('--evidence');
        const reason = argValue('--reason');
        const admittedBy = argValue('--admitted-by') || process.env.USER || 'operator';

        if (!target) {
          console.error('error: executor is required: af-admin executor recovery admit <executor> --evidence <id> --reason "<reason>"');
          process.exit(1);
        }
        if (!evidence || !evidence.trim()) {
          console.error('error: --evidence is required for recovery admission');
          process.exit(1);
        }
        if (!reason || !reason.trim()) {
          console.error('error: --reason is required for recovery admission');
          process.exit(1);
        }

        try {
          const res = admitRecoveredExecutor(target, {
            evidence_id: evidence.trim(),
            reason: reason.trim(),
            admitted_by: admittedBy,
          });
          console.log(formatAdmissionResult(res));
          process.exit(0);
        } catch (err) {
          console.error(`error: ${err.message}`);
          process.exit(1);
        }
      } else {
        console.error(`unknown recovery action: ${action} (expected: probe | admit)`);
        printUsage();
        process.exit(1);
      }
    } else {
      console.error(`unknown executor subcommand: ${subCmd}`);
      printUsage();
      process.exit(1);
    }
  } else if (mainCmd === 'circuit') {
    if (subCmd === 'list') {
      const list = listCircuitBreakers();
      console.log(formatCircuitList(list));
      process.exit(0);
    } else if (subCmd === 'reset') {
      const target = args[2] && !args[2].startsWith('-') ? args[2] : argValue('--executor');
      const reason = argValue('--reason');
      const resetBy = argValue('--reset-by') || process.env.USER || 'operator';

      if (!target) {
        console.error('error: executor is required: af-admin circuit reset <executor> --reason "<reason>"');
        process.exit(1);
      }
      if (!reason || !reason.trim()) {
        console.error('error: --reason is required for manual circuit reset');
        process.exit(1);
      }

      try {
        const res = resetCircuitBreaker(target, { reason, reset_by: resetBy });
        console.log(`Circuit reset successful:`);
        console.log(`executor: ${res.executorType}`);
        console.log(`state: ${res.state}`);
        console.log(`reset_by: ${res.reset_by}`);
        console.log(`reset_time: ${res.reset_time}`);
        console.log(`reason: ${res.reason}`);
        process.exit(0);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`unknown circuit subcommand: ${subCmd}`);
      printUsage();
      process.exit(1);
    }
  } else if (mainCmd === 'tasks') {
    if (subCmd === 'prune') {
      const confirm = args.includes('--confirm');
      const tasksDir = argValue('--tasks-dir') || undefined;
      try {
        const res = pruneTasks({ tasksDir, confirm });
        console.log(formatTasksPruneResult(res));
        process.exit(0);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`unknown tasks subcommand: ${subCmd} (expected: prune)`);
      printUsage();
      process.exit(1);
    }
  } else if (mainCmd === 'logs') {
    if (subCmd === 'rotate') {
      const daysArg = argValue('--days');
      const days = daysArg ? parseInt(daysArg, 10) : 7;
      const eventsLogFile = argValue('--events-file') || undefined;
      const archiveDir = argValue('--archive-dir') || undefined;
      try {
        const res = rotateLogs({ eventsLogFile, archiveDir, days });
        console.log(formatLogRotationResult(res));
        process.exit(0);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`unknown logs subcommand: ${subCmd} (expected: rotate)`);
      printUsage();
      process.exit(1);
    }
  } else if (mainCmd === 'boundary') {
    if (subCmd === 'recover') {
      // Controlled recovery of a boundary a failed lifecycle deliberately retained.
      // Never guesses silently; every attempt (including a missing --reason) is
      // audited, and an unaudited recovery is never reported as success.
      const canonicalDir = argValue('--canonical');
      const casDir = argValue('--cas') || null;
      const justification = argValue('--reason');
      const recoveredBy = argValue('--recovered-by') || process.env.USER || 'operator';
      const acknowledgeLiveScopes = args.includes('--ack-live-scopes');
      const allowGuessedModes = args.includes('--allow-guessed-modes');

      if (!canonicalDir) {
        console.error('error: --canonical <dir> is required: af-admin boundary recover --canonical <dir> --reason "<reason>"');
        process.exit(2);
      }

      // A missing --reason is NOT a usage dead-end: it must still be recorded as a
      // refused attempt (the audit trail has to show that someone tried).
      const res = recoverRetainedBoundary({
        canonicalDir,
        casDir,
        justification: justification ? justification.trim() : null,
        recoveredBy,
        acknowledgeLiveScopes,
        allowGuessedModes,
      });

      console.log(`boundary recovery: ${res.outcome}`);
      console.log(`  recovered   : ${res.recovered}`);
      console.log(`  delivered   : ${res.delivered}${res.delivered ? '' : ' (do NOT treat this as a completed recovery)'}`);
      console.log(`  reason      : ${res.reason ?? 'none'}`);
      console.log(`  scopes      : ${res.scopes ? `${res.scopes.status} (${res.scopes.active.length} active)` : 'not checked'}`);
      if (res.report) {
        console.log(`  restore     : ${res.report.entries_restored} restored, ${res.report.entries_skipped} missing, ${res.report.mismatches.length} mismatched, ${res.report.fallback.length} guessed`);
      }
      console.log(`  audit intent: ${res.audit.intent_file ?? `NOT WRITTEN (${res.audit.error})`}`);
      console.log(`  audit result: ${res.audit.result_file ?? (res.audit.intent_ok ? `NOT WRITTEN (${res.audit.error})` : 'not attempted')}`);
      if (!res.delivered) {
        console.error('error: boundary recovery did not complete cleanly; reconcile the boundary state manually before retrying');
      }
      process.exit(res.delivered ? 0 : 1);
    }
    console.error(`unknown boundary subcommand: ${subCmd} (expected: recover)`);
    printUsage();
    process.exit(1);
  } else if (mainCmd === 'reclaim') {
    if (subCmd === 'orphans') {
      // Debris from a HARD kill (SIGKILL): detached children survive and sandbox
      // containers keep running, while recovery re-dispatches the same task.
      // Default is a dry-run; --confirm executes.
      const confirm = args.includes('--confirm');
      const runsDir = argValue('--runs-dir') || undefined;
      try {
        const res = await reapOrphans({ runsDir, apply: confirm });
        console.log(formatReclaimResult(res, confirm));
        process.exit(0);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`unknown reclaim subcommand: ${subCmd} (expected: orphans)`);
      printUsage();
      process.exit(1);
    }
  } else if (mainCmd === 'restore-point') {
    const taskId = argValue('--task-id');
    const tasksDir = argValue('--tasks-dir') || TASKS_DIR;
    if (!taskId) {
      console.error('error: --task-id is required');
      printUsage();
      process.exit(1);
    }
    const { path: taskPath, task } = loadTaskForRollback(taskId, tasksDir);
    const fixtureDir = task.fixture_dir;
    try {
      if (subCmd === 'list') {
        console.log(formatRollbackResult(listRestorePoints({ dir: fixtureDir, taskId }), 'list'));
        process.exit(0);
      }
      if (subCmd === 'capture') {
        const revision = argValue('--revision') || `manual-${Date.now()}`;
        const label = argValue('--label') || 'manual capture';
        const result = captureRestorePoint({ dir: fixtureDir, taskId, revision, label });
        console.log(formatRollbackResult(result, 'capture'));
        if (result.ok) {
          // Record the point on the task under its lock, so the audit trail lives
          // with the task (the control-plane truth) rather than only in a terminal.
          const lock = acquireTaskLock(LOCKS_DIR, taskId, { orchestratorInstanceId: `af-admin-${process.pid}` });
          try {
            const fresh = JSON.parse(readFileSync(taskPath, 'utf8'));
            fresh.restore_points = fresh.restore_points ?? [];
            fresh.restore_points.push({ revision, sha: result.sha, ref: result.ref, captured_at: result.captured_at, label });
            saveTaskWithVersion(tasksDir, fresh);
          } finally {
            releaseTaskLock(LOCKS_DIR, taskId, lock.lock);
          }
        }
        process.exit(result.ok ? 0 : 1);
      }
      if (subCmd === 'restore') {
        const revision = argValue('--revision');
        if (!revision) {
          console.error('error: --revision is required');
          process.exit(1);
        }
        const confirm = args.includes('--confirm');
        const result = restoreToPoint({ dir: fixtureDir, taskId, revision, apply: confirm, prune: args.includes('--prune') });
        console.log(formatRollbackResult(result, 'restore'));
        if (result.ok && result.applied) {
          const lock = acquireTaskLock(LOCKS_DIR, taskId, { orchestratorInstanceId: `af-admin-${process.pid}` });
          try {
            const fresh = JSON.parse(readFileSync(taskPath, 'utf8'));
            fresh.rollbacks = fresh.rollbacks ?? [];
            fresh.rollbacks.push({
              revision,
              target: result.target,
              safety_ref: result.safety_ref,
              pruned: result.pruned,
              restored_at: result.restored_at,
            });
            saveTaskWithVersion(tasksDir, fresh);
          } finally {
            releaseTaskLock(LOCKS_DIR, taskId, lock.lock);
          }
        }
        process.exit(result.ok ? 0 : 1);
      }
      console.error(`unknown restore-point subcommand: ${subCmd} (expected: list, capture, restore)`);
      printUsage();
      process.exit(1);
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.error(`unknown command: ${mainCmd}`);
    printUsage();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
