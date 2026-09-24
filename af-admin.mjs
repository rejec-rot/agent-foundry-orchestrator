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
import { createHmac } from 'node:crypto';
import { saveTaskWithVersion } from './lib/store.mjs';
import { resolveV2HumanGate } from './lib/trusted-import/human-gate-resume.mjs';
import { requestCancel } from './lib/trusted-import/cancel.mjs';
import { createV2Task, startOrResumeV2Task } from './lib/v2-service.mjs';
import { planPreview, recordSubmission } from './lib/submission.mjs';
import { startReadApi } from './server/read-api.mjs';
import { recoverRetainedBoundary } from './lib/host-boundary.mjs';
import { inspectBoundaryAlerts, formatBoundaryAlerts, resolveBoundaryAlert, boundaryAlertsFile } from './lib/boundary-alerts.mjs';
import { describeNotifyConfig, notifyBoundaryAlert, readNotifyEvents, buildNotifyPayload, buildNotifyRequest, inspectPendingNotifications, flushPendingNotifications } from './lib/boundary-notify.mjs';
import { a1aConfig, a1aStatus, formatA1aStatus, explainA1aAsset, formatA1aExplanation, runA1aSweep, sweepExitCode } from './lib/a1a.mjs';
import {
  resolveDataRoots,
  assertWithinRoots,
  buildOverview,
  buildTaskView,
  buildEvidenceView,
  buildExceptionsView,
  redactModel,
} from './lib/console/read-model.mjs';
import { renderHuman } from './lib/console/render.mjs';

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
  af-admin console overview|tasks|task <id>|evidence <id>|exceptions|audit <ref> [--json] [--no-redact] [--hash-paths]
  af-admin boundary alerts [--json] [--include-resolved]
  af-admin boundary alert-resolve --canonical <dir> --reason "<reason>"
  af-admin boundary notify-status [--json]
  af-admin boundary notify-flush [--force] [--confirm]
  af-admin boundary notify-test --canonical <dir> [--reason "<reason>"] [--confirm]
  af-admin a1a status [--json]
  af-admin a1a explain --canonical <dir> --cas <dir> [--task <id>] [--json]
  af-admin a1a sweep [--json] [--confirm]
  af-admin v2 gate-resume --task <id> --reason "<why>" [--operator <name>] --confirm   (needs AF_OPERATOR_KEY)
  af-admin v2 cancel --task <id> --reason "<why>" --confirm                 (durable request; honoured at a trusted boundary)
  af-admin v2 create --spec <file.json> --root <dir> [--json]              (V2 submission: no legacy planning path)
  af-admin v2 start --task <id> [--allow-failed-reentry] [--json]        (single execution owner; resumes, never re-authors)
  af-admin submit --spec <file.json> --root <dir> [--preview|--record] [--json]   (record never starts a task)
  af-admin web serve [--port <n>] [--host <addr>] [--allow-non-loopback] [--no-redact]   (read-only workbench)
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
    if (subCmd === 'alerts') {
      // A1b: retained boundaries must be visible to an operator without reading task
      // files, and an unverifiable state must never be reported as "no alerts".
      const includeResolved = args.includes('--include-resolved');
      const inspection = inspectBoundaryAlerts({ includeResolved });
      if (args.includes('--json')) {
        console.log(JSON.stringify({ file: boundaryAlertsFile(), ...inspection }, null, 2));
      } else {
        console.log(formatBoundaryAlerts(inspection.alerts, {
          file: boundaryAlertsFile(),
          unverifiable: inspection.ok ? null : inspection.reason,
          source: inspection.source,
        }));
      }
      if (!inspection.ok) {
        console.error(`error: alert state unverifiable (${inspection.reason}); do not treat this as "no alerts"`);
        process.exit(3);
      }
      process.exit(inspection.alerts.some((a) => a.open === true) ? 1 : 0);
    }
    if (subCmd === 'alert-resolve') {
      const target = argValue('--canonical');
      const reason = argValue('--reason');
      if (!target || !reason || !reason.trim()) {
        console.error('error: --canonical <dir> and --reason "<reason>" are required');
        process.exit(1);
      }
      const res = resolveBoundaryAlert({ canonicalDir: target, reason: reason.trim() });
      console.log(`boundary alert resolved: ${res.resolved} (occurrences=${res.occurrences}, log=${res.file})`);
      process.exit(0);
    }
    if (subCmd === 'notify-status') {
      // Reports configuration only; the webhook target itself is never printed.
      const cfg = describeNotifyConfig();
      const deliveries = readNotifyEvents();
      const inspection = inspectPendingNotifications();
      const pending = inspection.ok ? inspection.pending : [];
      const nowMs = Date.now();
      const due = pending.filter((e) => e.state === 'pending' && (
        !e.next_attempt_at
        || Date.parse(e.next_attempt_at) <= nowMs
        || (e.claimed_at && nowMs - Date.parse(e.claimed_at) >= 60000)
      ));
      const exhausted = pending.filter((e) => e.state === 'exhausted');
      const stuckClaims = pending.filter((e) => e.state === 'pending' && e.claimed_at && nowMs - Date.parse(e.claimed_at) >= 60000);
      if (!inspection.ok) {
        if (args.includes('--json')) {
          console.log(JSON.stringify({ config: cfg, delivery_records: deliveries.length, queue: { ok: false, reason: inspection.reason } }, null, 2));
        } else {
          console.log(`boundary notification retry queue: UNVERIFIABLE - ${inspection.reason}`);
          console.log('  (this is NOT "no pending deliveries": do not treat the queue as clear)');
        }
        console.error(`error: retry queue unverifiable (${inspection.reason}); do not treat this as "nothing pending"`);
        process.exit(3);
      }
      if (args.includes('--json')) {
        console.log(JSON.stringify({ config: cfg, delivery_records: deliveries.length, queue: { ok: true, file: inspection.file }, pending: due, exhausted }, null, 2));
      } else {
        console.log('boundary notification configuration');
        for (const [k, v] of Object.entries(cfg)) console.log(`  ${k}: ${v}`);
        console.log(`  delivery records: ${deliveries.length}`);
        for (const d of deliveries.slice(-5)) console.log(`    ${d.at} ${d.status} ${d.mode} ${d.notify_key ?? ''} ${d.reason ?? ''}`);
        console.log(`  pending retries: ${due.length}   exhausted: ${exhausted.length}   stale claims: ${stuckClaims.length}`);
        for (const e of [...due, ...exhausted]) {
          console.log(`    [${e.state}] ${e.canonical_dir} attempts=${e.attempts}/${e.max_attempts} next=${e.next_attempt_at ?? 'n/a'} last_error=${e.last_error ?? 'n/a'}`);
        }
      }
      // A stuck delivery is a local, visible failure: exit non-zero so a watchdog sees it.
      process.exit(exhausted.length > 0 || due.length > 0 ? 1 : 0);
    }
    if (subCmd === 'notify-flush') {
      const cfg = describeNotifyConfig();
      if (cfg.mode !== 'live') {
        console.error(`error: retries only run in live mode (mode=${cfg.mode})`);
        process.exit(2);
      }
      if (!args.includes('--confirm')) {
        console.error('error: notify-flush sends real notifications; re-run with --confirm');
        process.exit(2);
      }
      const res = await flushPendingNotifications({ force: args.includes('--force') });
      console.log(`notify-flush: due=${res.due} attempted=${res.attempted} delivered=${res.delivered} failed=${res.failed} exhausted=${res.exhausted}${res.skipped ? ` skipped=${res.skipped}` : ''}`);
      if (!res.ok) {
        console.error(`error: ${res.skipped}`);
        process.exit(3);
      }
      const after = inspectPendingNotifications();
      if (!after.ok) {
        console.error(`error: retry queue unverifiable after flush (${after.reason})`);
        process.exit(3);
      }
      const stuck = after.pending.filter((e) => e.state === 'exhausted').length;
      process.exit(stuck > 0 ? 1 : 0);
    }
    if (subCmd === 'notify-test') {
      const target = argValue('--canonical');
      const reason = argValue('--reason') || 'operator notification test';
      if (!target) {
        console.error('error: --canonical <dir> is required');
        process.exit(1);
      }
      const cfg = describeNotifyConfig();
      if (cfg.mode === 'off') {
        console.error('error: AF_BOUNDARY_NOTIFY_MODE is off; set dry-run (or live, once authorised) to test');
        process.exit(2);
      }
      if (cfg.mode === 'live' && !args.includes('--confirm')) {
        console.error('error: live mode sends a real notification; re-run with --confirm after checking the target with notify-status');
        process.exit(2);
      }
      const testAlert = { canonical_dir: target, occurrences: 1, severity: 'warning', task_id: 'NOTIFY-TEST', boundary_state: 'NOTIFY_TEST', reason };
      const payload = buildNotifyPayload({ event: 'boundary_retained', alert: testAlert });
      const rendered = buildNotifyRequest({ event: 'boundary_retained', payload });
      const res = await notifyBoundaryAlert({ event: 'boundary_retained', alert: testAlert });
      console.log(`notify-test: ${res.status} (mode=${res.mode}, format=${rendered.format})${res.reason ? ` - ${res.reason}` : ''}`);
      console.log('request headers:', JSON.stringify(Object.fromEntries(Object.entries(rendered.headers).filter(([k]) => k.toLowerCase() !== 'authorization'))));
      console.log('request body:');
      try { console.log(JSON.stringify(JSON.parse(rendered.body), null, 2)); } catch { console.log(rendered.body); }
      process.exit(res.status === 'sent' || res.status === 'would-notify' ? 0 : 1);
    }
    console.error(`unknown boundary subcommand: ${subCmd} (expected: recover, alerts, alert-resolve, notify-status, notify-test)`);
    printUsage();
    process.exit(1);
  } else if (mainCmd === 'a1a') {
    let cfg;
    try {
      cfg = a1aConfig();
    } catch (err) {
      console.error(`error: a1a configuration is unavailable: ${err.message}`);
      process.exit(3);
    }
    if (subCmd === 'status' || subCmd === undefined) {
      const status = a1aStatus(cfg);
      if (args.includes('--json')) console.log(JSON.stringify(status, null, 2));
      else console.log(formatA1aStatus(status));
      if (!status.state.ok) {
        console.error(`error: a1a state unverifiable (${status.state.reason}); do not treat it as an empty queue`);
        process.exit(3);
      }
      // Needs-human / exhausted assets are a local, visible obligation (F14/F21).
      process.exit(status.needs_human > 0 || status.exhausted > 0 ? 1 : 0);
    }
    if (subCmd === 'explain') {
      const canonicalDir = argValue('--canonical') ?? (args[2] && !args[2].startsWith('-') ? args[2] : null);
      const casDir = argValue('--cas');
      if (!canonicalDir || !casDir) {
        console.error('error: --canonical <dir> and --cas <dir> are required');
        process.exit(2);
      }
      const explanation = explainA1aAsset({ cfg, canonicalDir, casDir, taskId: argValue('--task') });
      if (args.includes('--json')) console.log(JSON.stringify(explanation, null, 2));
      else console.log(formatA1aExplanation(explanation));
      process.exit(explanation.ok ? 0 : 3);
    }
    if (subCmd === 'sweep') {
      // The scheduler's one-shot entry point. `live` is gated behind --confirm (a real recovery
      // changes ownership); `dry-run` and `off` need no confirmation.
      if (cfg.mode === 'live' && !args.includes('--confirm')) {
        console.error('error: a live sweep performs real recoveries; re-run with --confirm');
        process.exit(2);
      }
      const res = runA1aSweep({ cfg });
      if (args.includes('--json')) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(`a1a sweep: mode=${res.mode} assets=${res.results.length}${res.note ? ` (${res.note})` : ''}`);
        for (const r of res.results) {
          console.log(`  ${r.canonical_dir}: ${r.decision}${r.reason_code ? ` ${r.reason_code}` : ''}${r.outcome ? ` outcome=${r.outcome}` : ''}${r.delivered ? ' delivered' : ''}`);
        }
      }
      // Exit codes must not hide a needs-human outcome behind a successful sweep: 3 = could not be
      // verified, 1 = an asset needs a human (reconcile/exhausted/refused/deferred), 0 = nothing to do.
      const code = sweepExitCode(res.results);
      if (code !== 0) {
        console.error(code === 3
          ? 'error: an asset could not be verified during the sweep; do not treat this as "nothing to do"'
          : 'error: the sweep left an asset needing a human (reconcile, exhausted, refused or deferred)');
      }
      process.exit(code);
    }
    console.error(`unknown a1a subcommand: ${subCmd} (expected: status, explain, sweep)`);
    printUsage();
    process.exit(1);
  } else if (mainCmd === 'v2') {
    if (subCmd === 'gate-resume') {
      // Operator entry for a parked V2 Human Gate (Band D) item. Library/CLI only (no web UI).
      const taskId = argValue('--task') ?? (args[2] && !args[2].startsWith('-') ? args[2] : null);
      const reason = argValue('--reason');
      const operator = argValue('--operator') || process.env.USER || null;
      if (!taskId) { console.error('error: --task <id> is required'); process.exit(2); }
      if (!reason || !reason.trim()) { console.error('error: --reason "<why>" is required'); process.exit(2); }
      if (!args.includes('--confirm')) { console.error('error: approving a Human Gate item is a signed, auditable decision; re-run with --confirm'); process.exit(2); }
      const key = process.env.AF_OPERATOR_KEY;
      if (!key) { console.error('error: AF_OPERATOR_KEY is not configured; an unsigned approval must never exist (fail-closed)'); process.exit(3); }

      const tasksDir = argValue('--tasks-dir') || TASKS_DIR;
      const taskPath = join(tasksDir, `${taskId}.json`);
      let task;
      try { task = JSON.parse(readFileSync(taskPath, 'utf8')); } catch (err) {
        console.error(`error: cannot read task ${taskId} from ${tasksDir}: ${err.message}`); process.exit(1);
      }

      const operatorAuthenticator = ({ operatorIdentity, justification, approvedPaths, auditPayload }) => {
        const signature = createHmac('sha256', key).update(auditPayload).digest('hex');
        return { verified: true, signature, keyId: process.env.AF_OPERATOR_KEY_ID || 'local-operator-key' };
      };

      const res = resolveV2HumanGate({
        task,
        operatorIdentity: operator,
        justification: reason.trim(),
        operatorAuthenticator,
        saveTask: (t) => saveTaskWithVersion(tasksDir, t),
      });
      if (!res.ok) {
        console.error(`error: ${res.code ?? 'REFUSED'}: ${res.reason}`);
        process.exit(1);
      }
      console.log(`v2 gate approve: ok (operator=${operator}, paths=${res.approved_paths.join(', ')})`);
      console.log(`  evidence file: ${taskPath}`);
      console.log(`  approved at  : ${task.trusted_import.human_approval.resolved_at}`);
      console.log('  resume       : re-run the task through the V2 entrypoint with a humanApprovalProvider');
      console.log('                 (the provider re-mints the approval in-process; without it the task parks again)');
      process.exit(0);
    }
    if (subCmd === 'create' || subCmd === 'start') {
      // §6 G2: the dedicated V2 submission + execution-ownership service (no legacy planning path).
      const tasksDir = argValue('--tasks-dir') || TASKS_DIR;
      const locksDir = argValue('--locks-dir') || LOCKS_DIR;

      if (subCmd === 'create') {
        const specFile = argValue('--spec') ?? (args[2] && !args[2].startsWith('-') ? args[2] : null);
        if (!specFile) { console.error('error: --spec <file.json> is required'); process.exit(2); }
        let spec;
        try { spec = JSON.parse(readFileSync(specFile, 'utf8')); } catch (err) {
          console.error(`error: cannot read the submission spec ${specFile}: ${err.message}`); process.exit(2);
        }
        const roots = [];
        for (let i = 0; i < args.length; i += 1) if (args[i] === '--root' && args[i + 1]) roots.push(args[i + 1]);
        if (roots.length === 0 && process.env.AF_SUBMISSION_ROOTS) roots.push(...process.env.AF_SUBMISSION_ROOTS.split(':').filter(Boolean));
        if (roots.length === 0) { console.error('error: at least one --root <dir> is required so target_path can be contained'); process.exit(2); }

        const res = createV2Task({ spec, allowedRoots: roots, tasksDir, submissionsDir: argValue('--submissions-dir') || null });
        if (args.includes('--json')) console.log(JSON.stringify(res, null, 2));
        else if (!res.ok) console.error(`error: ${res.first_failure ?? 'REFUSED'}: ${res.reason}`);
        else {
          console.log(`v2 create: ${res.created ? 'created' : 'already exists (idempotent)'}`);
          console.log(`  task_id      : ${res.task_id}`);
          console.log(`  operation_id : ${res.operation_id ?? '(existing task)'}`);
          console.log(`  state        : ${res.task?.state ?? 'CREATED'} (start it with: af-admin v2 start --task ${res.task_id})`);
        }
        process.exit(res.ok ? 0 : 1);
      }

      const taskId = argValue('--task') ?? (args[2] && !args[2].startsWith('-') ? args[2] : null);
      if (!taskId) { console.error('error: --task <id> is required'); process.exit(2); }
      const { continueTask } = await import('./orchestrator.mjs');
      const res = await startOrResumeV2Task({
        taskId,
        tasksDir,
        locksDir,
        allowFailedReentry: args.includes('--allow-failed-reentry'),
        runner: async ({ mode, task }) => {
          console.log(`v2 start: ${mode} ${taskId} (state=${task.state})`);
          await continueTask(taskId, undefined, { tasksDir, allowV2FailedReentry: args.includes('--allow-failed-reentry') });
        },
      });
      if (args.includes('--json')) console.log(JSON.stringify(res, null, 2));
      else if (!res.ok) console.error(`error: ${res.outcome}: ${res.reason}`);
      else console.log(`v2 start: ${res.outcome} (${res.mode}) for ${taskId}`);
      process.exit(res.ok ? 0 : 1);
    }
    if (subCmd === 'cancel') {
      // §6 G4: a cancel is a durable REQUEST honoured at a trusted boundary, never a promise.
      const taskId = argValue('--task') ?? (args[2] && !args[2].startsWith('-') ? args[2] : null);
      const reason = argValue('--reason');
      if (!taskId) { console.error('error: --task <id> is required'); process.exit(2); }
      if (!reason || !reason.trim()) { console.error('error: --reason "<why>" is required'); process.exit(2); }
      if (!args.includes('--confirm')) { console.error('error: cancelling is an explicit operator action; re-run with --confirm'); process.exit(2); }
      const tasksDir = argValue('--tasks-dir') || TASKS_DIR;
      const res = requestCancel({ tasksDir, taskId, requestedBy: argValue('--requested-by') || process.env.USER || 'operator', reason: reason.trim() });
      if (!res.ok) { console.error(`error: ${res.reason}`); process.exit(1); }
      console.log(`v2 cancel: ${res.created ? 'requested' : 'already requested (idempotent)'} for ${taskId}`);
      console.log(`  by     : ${res.request.requested_by}`);
      console.log(`  reason : ${res.request.reason}`);
      console.log('  note   : honoured at the next trusted boundary; once the ref update has begun it is recorded as too-late');
      try {
        const onDisk = JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf8'));
        const outcome = onDisk?.trusted_import?.cancel_outcome;
        if (outcome) console.log(`  outcome: ${outcome.action} at ${outcome.boundary} (${outcome.reason})`);
      } catch { /* the request itself is recorded regardless */ }
      process.exit(0);
    }
    console.error(`unknown v2 subcommand: ${subCmd} (expected: gate-resume)`);
    printUsage();
    process.exit(1);
  } else if (mainCmd === 'web') {
    // The browser-facing READ-ONLY API + workbench. Loopback by default; no write route exists.
    if (subCmd !== 'serve') {
      console.error(`unknown web subcommand: ${subCmd} (expected: serve)`);
      printUsage();
      process.exit(1);
    }
    const port = Number.parseInt(argValue('--port') ?? '8787', 10) || 8787;
    const host = argValue('--host') || '127.0.0.1';
    if (!args.includes('--allow-non-loopback') && host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      console.error(`error: refusing to bind ${host}: this API is unauthenticated, so it stays on loopback unless --allow-non-loopback is given`);
      process.exit(2);
    }
    const handle = await startReadApi({
      port,
      host,
      roots: resolveDataRoots(),
      redact: !args.includes('--no-redact'),
      logger: (line) => console.log(line),
    });
    console.log(`  open ${handle.url} in a browser (read-only: no start/cancel/approve/promote)`);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => { await handle.close(); process.exit(0); });
    }
  } else if (mainCmd === 'submit') {
    // Stage-2 operator surface: PREVIEW and RECORD only. Nothing is scheduled or executed here -
    // starting a task stays a separate, explicitly authorised step.
    const specFile = argValue('--spec') ?? (args[1] && !args[1].startsWith('-') ? args[1] : null);
    if (!specFile) { console.error('error: --spec <file.json> is required'); process.exit(2); }
    let spec;
    try { spec = JSON.parse(readFileSync(specFile, 'utf8')); } catch (err) {
      console.error(`error: cannot read the submission spec ${specFile}: ${err.message}`); process.exit(2);
    }
    const roots = [];
    for (let i = 0; i < args.length; i += 1) if (args[i] === '--root' && args[i + 1]) roots.push(args[i + 1]);
    if (roots.length === 0 && process.env.AF_SUBMISSION_ROOTS) roots.push(...process.env.AF_SUBMISSION_ROOTS.split(':').filter(Boolean));
    if (roots.length === 0) { console.error('error: at least one --root <dir> (or AF_SUBMISSION_ROOTS) is required so target_path can be contained'); process.exit(2); }

    if (args.includes('--record')) {
      const res = recordSubmission({ spec, allowedRoots: roots });
      if (args.includes('--json')) console.log(JSON.stringify(res, null, 2));
      else if (res.ok) {
        console.log(`submit record: ok${res.duplicate ? ' (duplicate - the original record is returned)' : ''}`);
        console.log(`  spec digest : ${res.record.spec_digest}`);
        console.log(`  state       : ${res.record.state} (started=${res.record.started})`);
        console.log(`  record file : ${res.record.record_file}`);
        if (res.record.stripped_fields?.length) console.log(`  stripped    : ${res.record.stripped_fields.join(', ')}`);
      } else console.error(`error: ${res.first_failure ?? 'REFUSED'}: ${res.reason}`);
      process.exit(res.ok ? 0 : 1);
    }

    const preview = planPreview({ spec, allowedRoots: roots });
    if (args.includes('--json')) console.log(JSON.stringify(preview, null, 2));
    else if (preview.ok) {
      console.log(`submit preview: ok (started=${preview.started})`);
      console.log(`  goal        : ${String(preview.capsule.goal).slice(0, 160)}`);
      if (preview.stripped_fields?.length) console.log(`  stripped    : ${preview.stripped_fields.join(', ')}`);
      console.log(`  pipeline    : ${preview.pipeline.join(' -> ')}`);
      console.log(`  platform    : ${preview.platform_bound.join(', ')}`);
      console.log(`  note        : ${preview.note}`);
    } else console.error(`error: ${preview.first_failure ?? 'REFUSED'}: ${preview.reason}`);
    process.exit(preview.ok ? 0 : 1);
  } else if (mainCmd === 'console') {
    // READ-ONLY: never writes a file, never takes a lock, never calls a mutating API.
    // Every block carries source/read_status/as_of so a failure is never "nothing to report".
    const sub = subCmd;
    const json = args.includes('--json');
    const redact = !args.includes('--no-redact');
    const hashPaths = args.includes('--hash-paths');
    const roots = resolveDataRoots();
    const now = Date.now();
    let model = null;
    let exitCode = 0;
    try {
      if (sub === 'overview' || sub === 'tasks') {
        model = buildOverview({ roots, now });
      } else if (sub === 'task') {
        const taskId = args[2];
        if (!taskId) { console.error('error: console task <task_id> is required'); process.exit(2); }
        model = buildTaskView({ taskId, roots, now });
        if (model.blocks.task.read_status === 'missing') exitCode = 2;
        else if (model.blocks.task.read_status !== 'ok') exitCode = 3;
      } else if (sub === 'evidence') {
        const taskId = args[2];
        if (!taskId) { console.error('error: console evidence <task_id> is required'); process.exit(2); }
        model = buildEvidenceView({ taskId, roots, now });
        if (model.blocks.task.read_status === 'missing') exitCode = 2;
        else if (model.blocks.task.read_status !== 'ok') exitCode = 3;
      } else if (sub === 'exceptions') {
        model = buildExceptionsView({ roots, now });
      } else if (sub === 'audit') {
        // A record reference must resolve inside the configured data roots; never a raw path.
        const ref = args[2];
        if (!ref) { console.error('error: console audit <record-reference> is required'); process.exit(2); }
        const containment = assertWithinRoots(ref, roots);
        if (!containment.ok) {
          console.error(`error: refusing to read outside the configured data roots: ${containment.reason}`);
          process.exit(2);
        }
        try {
          model = {
            schema: 'af-console-audit-v1',
            generated_at: new Date(now).toISOString(),
            ref,
            root: containment.root,
            record: JSON.parse(readFileSync(containment.path, 'utf8')),
          };
        } catch (err) {
          console.error(`error: record could not be read as JSON: ${err.message}`);
          process.exit(3);
        }
      } else {
        console.error(`unknown console subcommand: ${sub ?? '(none)'} (expected: overview, tasks, task, evidence, exceptions, audit)`);
        process.exit(2);
      }
    } catch (err) {
      console.error(`error: console query failed: ${err.message}`);
      process.exit(3);
    }

    // Default output is redacted (paths hashed, credentials removed); --no-redact shows local
    // paths verbatim, and credentials are still removed.
    const { model: safe, paths_redacted, path_mode } = redactModel(model, { redact, hash: hashPaths || redact });
    const blockUnverifiable = Object.values(model.blocks ?? {}).filter((block) => block?.read_status === 'unverifiable').length;
    const listedUnverifiable = (model.unverifiable ?? []).length;
    if (json) {
      process.stdout.write(`${JSON.stringify({ ...safe, paths_redacted, path_mode, credentials_redacted: true }, null, 2)}\n`);
    } else {
      // Human view: same redacted model (with the redaction metadata), rendered for a terminal.
      console.log(renderHuman({ ...safe, paths_redacted, path_mode, credentials_redacted: true }));
    }
    if (blockUnverifiable + listedUnverifiable > 0 && exitCode === 0) exitCode = 3;
    process.exit(exitCode);
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
