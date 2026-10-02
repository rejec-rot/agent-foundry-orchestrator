// Compatibility API and CLI. V2 phases live in lib/workflows/v2.mjs;
// legacy planning, governance and step execution live in lib/legacy/.
// Task lifecycle truth remains tasks/<task_id>.json, with atomic versioned writes.
//
// Usage: node orchestrator.mjs run --task-file <task.json>
//        node orchestrator.mjs status|inspect|cancel --task-id <id>

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ADAPTERS } from './lib/adapters.mjs';
import { readTaskFile } from './lib/store.mjs';
import { normalizeAcceptanceCmd, acceptanceBinding } from './lib/acceptance.mjs';
import { signalPidTree, signalAllManaged } from './lib/child-process.mjs';
import { readLock, isLockStale } from './lib/tasklock.mjs';
import { assertTrustedImportAdmission } from './lib/trusted-import/orchestrator-adapter.mjs';

import { ROOT, TASKS_DIR, LOCKS_DIR, MAX_REVISIONS_DEFAULT, RUNNING_STATES, TERMINAL_STATES, saveTask, loadTask, withTaskContext } from './lib/task-runtime.mjs';
import { executeLegacyTask, continueLegacyTask, resumeGovernance } from './lib/legacy/workflow.mjs';
import { submitTask, approveTaskIntent, rejectTaskIntent } from './lib/legacy/submission.mjs';
import { executeV2Workflow, resumeV2Workflow } from './lib/workflows/v2.mjs';

// Compatibility facade: V2 execution never passes through legacy planning or governance.
export { resumeGovernance } from './lib/legacy/workflow.mjs';
export async function executeTask(task, adapters = ADAPTERS, options = {}) {
  withTaskContext(task, options);
  return task.trusted_import?.enabled === true
    ? executeV2Workflow(task, adapters, options)
    : executeLegacyTask(task, adapters, options);
}

export async function continueTask(taskId, adapters = ADAPTERS, options = {}) {
  const task = withTaskContext(loadTask(taskId, options.tasksDir ?? TASKS_DIR), { ...options, tasksDir: options.tasksDir ?? TASKS_DIR });
  return task.trusted_import?.enabled === true
    ? resumeV2Workflow(task, adapters, options)
    : continueLegacyTask(taskId, adapters, options);
}

function loadTaskFile(path) {
  const def = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(def.task_id ?? '')) throw new Error('valid task_id is required');
  try {
    const existing = loadTask(def.task_id);
    if (existing) throw Object.assign(new Error(`TASK_ALREADY_EXISTS: ${def.task_id} is ${existing.state}; use resume or a new task id`), { code: 'TASK_ALREADY_EXISTS' });
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const now = new Date().toISOString();
  // validate acceptance command shape early (trust boundary entry point);
  // legacy shell strings are forbidden unless the task file explicitly allows
  normalizeAcceptanceCmd(def.acceptance_cmd, {
    allowLegacy: def.allow_legacy_shell_acceptance === true,
  });
  if ((def.task_mode ?? 'workspace') === 'governed_write' && !def.governance_env?.vault_root) {
    // fail-closed at load time: a governed task without an explicit target
    // vault must not run at all (it could otherwise fall back to the real
    // vault - the exact Phase 2 leak this closes).
    const err = new Error('GOVERNANCE_ENV_REQUIRED: governed_write task must declare governance_env.vault_root (no implicit real-vault fallback)');
    err.code = 'GOVERNANCE_ENV_REQUIRED';
    throw err;
  }
  const task = {
    task_id: def.task_id,
    task_mode: def.task_mode ?? 'workspace', // workspace | governed_write
    goal: def.goal,
    acceptance: def.acceptance,
    acceptance_cmd: def.acceptance_cmd ?? null,
    allow_legacy_shell_acceptance: def.allow_legacy_shell_acceptance === true,
    candidate: def.candidate ?? null, // governed_write: {title, target, knowledge_class, sources, publish_tags, publish_summary, rationale}
    governance_env: def.governance_env ?? null, // {server_path, vault_root, state_db, reviewer_mcp_config, reviewer_allowed_tools, reviewer_server_name}
    red_lines: def.red_lines ?? [],
    review_rules: def.review_rules ?? [],
    fixture_dir: def.fixture_dir,
    requires_mcp: !!def.requires_mcp,
    author_executor: def.author_executor ?? 'auto',
    reviewer_executor: def.reviewer_executor ?? 'auto',
    author_role: def.author_role ?? 'author',
    reviewer_role: 'reviewer',
    max_revisions: def.max_revisions ?? MAX_REVISIONS_DEFAULT,
    timeout_ms: def.timeout_ms,
    state: 'CREATED',
    state_version: 0,
    created_at: now,
    updated_at: now,
    runs: [],
    revisions_used: 1,
    planner_result: def.planner_result ?? null,
    multi_step_dispatch: def.multi_step_dispatch ?? false,
    plan_execution: def.plan_execution ?? [],
    step_executors: def.step_executors ?? null,
    author_model: def.author_model,
    author_effort: def.author_effort,
    model: def.model,
    effort: def.effort,
    reviewer_model: def.reviewer_model,
    reviewer_effort: def.reviewer_effort,
    cline_model: def.cline_model,
    cline_effort: def.cline_effort,
    cline_fallback_model: def.cline_fallback_model,
    cline_fallback_effort: def.cline_fallback_effort,
    researcher_executor: def.researcher_executor ?? null,
    trusted_import: def.trusted_import ?? null,
  };
  if (!task.goal || !task.acceptance || !task.fixture_dir) {
    throw new Error('task file must define goal, acceptance, fixture_dir');
  }
  if (task.task_mode === 'governed_write' && !task.candidate?.target) {
    throw new Error('governed_write tasks must define candidate.target');
  }
  if (task.trusted_import?.enabled === true) assertTrustedImportAdmission(task);
  // Bind the acceptance trust anchor to the validated definition, so a later
  // edit of tasks/<id>.json is detected before the command is executed.
  task.acceptance_binding = acceptanceBinding(task);
  saveTask(task);
  return task;
}

function inspectTask(task, { locksDir = null, recovery = null } = {}) {
  const lastRun = task.runs[task.runs.length - 1] ?? null;
  const lastReviewRun = [...task.runs].reverse().find((r) => r.purpose === 'review') ?? null;
  const interrupted = RUNNING_STATES.has(task.state);
  const out = {
    task_id: task.task_id,
    status: task.state,
    revision: task.revisions_used,
    state_version: task.state_version ?? 0,
    author_session_ref: task.author_session_ref ?? null,
    author_session_executor_type: task.author_session_executor_type ?? null,
    latest_reviewer_result: task.last_review
      ? { decision: task.last_review.decision, summary: task.last_review.summary }
      : null,
    latest_executor_run: lastRun,
    latest_review_run_id: lastReviewRun?.executor_run_id ?? null,
    last_error: task.failure_reason ?? task.runs.find((r) => r.error)?.error ?? null,
  };
  // PHASE 4: lock owner / staleness and the recovery classification
  if (locksDir) {
    const lock = readLock(locksDir, task.task_id);
    if (lock) {
      out.lock_owner = lock.orchestrator_instance_id ?? null;
      out.lock_pid = lock.pid ?? null;
      out.lock_stale = isLockStale(lock);
    }
  }
  if (recovery) {
    out.recovery_class = recovery.recovery_class;
    out.recommended_action = recovery.recommended_action ?? null;
    if (recovery.reason) out.recovery_reason = recovery.reason;
    out.recoverable = recovery.recoverable ?? null;
  }
  if (task.scheduler_state) out.scheduler_state = task.scheduler_state;
  if (interrupted) {
    // A task found in a running state with no live orchestrator process was
    // interrupted. Never report it as COMPLETED (Phase 1.1: no fake success).
    out.interrupted_stage = task.state;
    out.recoverable = out.recoverable ?? !!(task.author_session_ref && task.author_session_executor_type);
    out.note = 'task was left in a running state; use recover --task-id to resume safely';
  }
  if (task.cancelled_at) {
    out.cancellation = {
      cancel_requested_at: task.cancel_requested_at ?? null,
      cancelled_at: task.cancelled_at,
      cancel_reason: task.cancel_reason ?? null,
      cancelled_by: task.cancelled_by ?? null,
      active_run_id: task.active_run_id ?? null,
    };
  }
  if (task.governance) {
    out.governance = {
      governance_source: task.governance.governance_source,
      candidate_id: task.governance.candidate_id ?? null,
      policy_decision: task.governance.policy_decision ?? null,
      human_gate_status: task.governance.human_gate_status ?? null,
      publish_status: task.governance.publish_status ?? null,
    };
  }
  return out;
}

export function installGracefulShutdown(scheduler, opts = {}) {
  if (!scheduler) throw new Error('scheduler is required for installGracefulShutdown');
  return scheduler.installSignalHandlers(opts);
}

export { submitTask, approveTaskIntent, rejectTaskIntent };

export function getTaskStatus(taskId, { tasksDir = null } = {}) {
  if (!taskId) throw new Error('getTaskStatus requires taskId');
  const dir = tasksDir || TASKS_DIR;
  const task = loadTask(taskId, dir);
  const lastRun = Array.isArray(task.runs) && task.runs.length ? task.runs[task.runs.length - 1] : null;
  const executor = lastRun?.executor_type || task.author_session_executor_type || task.author_executor || null;
  return {
    task_id: task.task_id,
    state: task.state,
    executor,
  };
}

// CLI entry point - only when executed directly, not when imported by tests
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const [, , cmd, ...rest] = process.argv;
function argValue(flag) {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : null;
}

// The CLI is a Control Plane owner in its own right: `run` and `resume` used to
// execute a task with no lock at all, so two operators could drive the same task
// concurrently. The lock is taken here (not inside the library entry points,
// which recovery already calls while holding one) and released in a finally, so
// a refusal leaves no lock behind.
async function withTaskLock(taskId, fn) {
  const { acquireTaskLock, releaseTaskLock, maintainTaskLease } = await import('./lib/tasklock.mjs');
  let lockInfo;
  try {
    lockInfo = acquireTaskLock(LOCKS_DIR, taskId, { orchestratorInstanceId: `af-cli-${process.pid}` });
  } catch (err) {
    console.error(`[orchestrator] ${err.message}`);
    process.exit(3);
  }
  if (lockInfo.stale_lock_recovered) {
    console.log(`[orchestrator] recovered a stale lock for ${taskId} (${lockInfo.recovered_from?.stale_reason ?? 'unknown'})`);
  }
  const lease = maintainTaskLease(LOCKS_DIR, taskId, lockInfo.lock);
  try {
    return await fn(lease.assertOwned);
  } finally {
    lease.stop();
    releaseTaskLock(LOCKS_DIR, taskId, lockInfo.lock);
  }
}

if (isMain) {
  if (cmd === 'run') {
    const { terminateAllActiveRuns } = await import('./lib/adapters.mjs');
    const onSignal = async (sig) => {
      console.log(`[orchestrator] Received ${sig}, gracefully terminating active executor runs...`);
      // Reap every managed child (acceptance commands, the vault MCP server,
      // the planner) as process trees: the executor handle registry alone never
      // covered them, and a plain pid kill misses their descendants.
      signalAllManaged('SIGTERM');
      await terminateAllActiveRuns();
      process.exit(130);
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    const definition = JSON.parse(readFileSync(argValue('--task-file'), 'utf8'));
    const done = await withTaskLock(definition.task_id, (assertOwnership) => {
      const task = loadTaskFile(argValue('--task-file'));
      console.log(`[orchestrator] task=${task.task_id} author=${task.author_executor} reviewer=${task.reviewer_executor} max_revisions=${task.max_revisions}`);
      return executeTask(task, ADAPTERS, { assertOwnership });
    });
    console.log(`[orchestrator] final state: ${done.state}${done.failure_reason ? ` (${done.failure_reason})` : ''}`);
    console.log(JSON.stringify({
      task_id: done.task_id,
      state: done.state,
      revisions_used: done.revisions_used,
      acceptance_runs: (done.acceptance_runs ?? []).map((a) => `${a.command} exit=${a.exit_code}`),
      runs: done.runs.map((r) => `${r.purpose}:${r.executor_type}:${r.status}:${r.executor_run_id}`),
      failure_reason: done.failure_reason ?? null,
    }, null, 2));
    process.exit(done.state === 'COMPLETED' ? 0 : 1);
  } else if (cmd === 'submit') {
    const taskFilePath = argValue('--task-file');
    if (!taskFilePath) { console.error('usage: orchestrator.mjs submit --task-file <json>'); process.exit(2); }
    const taskCapsule = JSON.parse(readFileSync(taskFilePath, 'utf8'));
    const autoRun = rest.includes('--auto-run') || rest.includes('--run');
    const res = await submitTask(taskCapsule, { autoRun });
    console.log(JSON.stringify({ task_id: res.task_id, status: res.status, message: 'Task submitted to Agent Foundry' }, null, 2));
    process.exit(0);
  } else if (cmd === 'approve') {
    const tid = argValue('--task-id');
    if (!tid) { console.error('usage: orchestrator.mjs approve --task-id <id> [--reason <reason>]'); process.exit(2); }
    const reason = argValue('--reason') || '确认执行该方案';
    const autoRun = rest.includes('--auto-run') || rest.includes('--run');
    const res = await approveTaskIntent(tid, { reason, autoRun });
    console.log(JSON.stringify({ task_id: res.task_id, status: res.status, message: res.message }, null, 2));
    process.exit(0);
  } else if (cmd === 'reject') {
    const tid = argValue('--task-id');
    if (!tid) { console.error('usage: orchestrator.mjs reject --task-id <id> [--reason <reason>]'); process.exit(2); }
    const reason = argValue('--reason') || '方向不符合要求';
    const res = await rejectTaskIntent(tid, { reason });
    console.log(JSON.stringify({ task_id: res.task_id, status: res.status, message: res.message }, null, 2));
    process.exit(0);
  } else if (cmd === 'status') {
    const tid = argValue('--task-id');
    let t;
    try {
      t = loadTask(tid);
    } catch (err) {
      // An operator asking about an unknown task should get one clear line, not
      // an uncaught exception and a raw stack trace.
      console.error(`[orchestrator] ${String(err?.message ?? err)}`);
      process.exit(2);
    }
    console.log(JSON.stringify(t, null, 2));
  } else if (cmd === 'inspect') {
    const tid = argValue('--task-id');
    let t;
    try {
      t = loadTask(tid);
    } catch (err) {
      console.error(`[orchestrator] ${String(err?.message ?? err)}`);
      process.exit(2);
    }
    const { classifyRecovery } = await import('./lib/recovery.mjs');
    const { loadExecutorStatus } = await import('./lib/executor-status.mjs');
    const recovery = classifyRecovery(t, { availability: loadExecutorStatus() });
    console.log(JSON.stringify(inspectTask(t, { locksDir: LOCKS_DIR, recovery }), null, 2));
  } else if (cmd === 'list') {
    // PHASE 4 operator listing: every task with its recovery classification
    const { scanRecovery } = await import('./lib/recovery.mjs');
    const { loadExecutorStatus } = await import('./lib/executor-status.mjs');
    const rows = scanRecovery(TASKS_DIR, { locksDir: LOCKS_DIR, availability: loadExecutorStatus() });
    const filter = argValue('--status');
    const shown = filter ? rows.filter((r) => r.state === filter || r.recovery_class === filter) : rows;
    for (const r of shown) {
      console.log(`${(r.task_id ?? r.file ?? '?').padEnd(28)} ${(r.state ?? '?').padEnd(18)} rev=${String(r.revision ?? '?').padEnd(3)} class=${r.recovery_class}${r.lock ? ` lock=${r.lock.stale ? 'STALE' : 'held'}` : ''}`);
    }
    console.log(`total: ${shown.length}`);
  } else if (cmd === 'recover') {
    // PHASE 4 operator control. --scan ONLY reports; --task-id executes the
    // recovery after the user explicitly names the task. Never auto-recover.
    const { scanRecovery, classifyRecovery, recoverTask } = await import('./lib/recovery.mjs');
    const { loadExecutorStatus } = await import('./lib/executor-status.mjs');
    const availability = loadExecutorStatus();
    if (rest.includes('--scan')) {
      const rows = scanRecovery(TASKS_DIR, { locksDir: LOCKS_DIR, availability });
      const active = rows.filter((r) => r.recovery_class !== 'TERMINAL');
      for (const r of active) {
        console.log(JSON.stringify({
          task_id: r.task_id, status: r.state, recovery_class: r.recovery_class,
          recommended_action: r.recommended_action, revision: r.revision,
          state_version: r.state_version,
          author_session_ref: r.author_session_ref,
          candidate_id: r.candidate_id, latest_run: r.latest_run, last_error: r.last_error,
        }, null, 1));
      }
      console.log(`scan complete: ${active.length} non-terminal task(s), ${rows.length - active.length} terminal (reported as TERMINAL, never auto-rerun)`);
      process.exit(0);
    }
    const tid = argValue('--task-id');
    if (!tid) { console.error('usage: recover --scan | recover --task-id <id>'); process.exit(2); }
    const instance = `af-orch-${randomUUID().slice(0, 8)}`;
    // Opt-in: reaping sweeps side effects, so it is not on by default. Enabled,
    // it runs before a continuation dispatches, clearing debris a hard-killed
    // previous owner left behind (ADR-0007, consequence section). The flag exists
    // because turning it on changes what recovery does; see tests/recovery-orphan-reap.
    const reapOnRecover = ['1', 'true', 'on'].includes(String(process.env.AF_REAP_ORPHANS_ON_RECOVER ?? '').toLowerCase());
    const done = await recoverTask(tid, {
      adapters: ADAPTERS, tasksDir: TASKS_DIR, locksDir: LOCKS_DIR,
      availability, orchestratorInstanceId: instance,
      continueTaskFn: (id, o = {}) => continueTask(id, ADAPTERS, o),
      resumeGovernanceFn: (id, o = {}) => resumeGovernance(id, o),
      governanceBridge: null, targetCoordination: null,
      reapOrphans: reapOnRecover
        ? async () => (await import('./lib/orphan-reaper.mjs')).reapOrphans({ apply: true })
        : null,
    });
    console.log(`[orchestrator] recover result: ${JSON.stringify(done, null, 2)}`);
    process.exit(done?.outcome === 'RECOVERED' && done?.state === 'COMPLETED' ? 0 : (done?.outcome === 'TERMINAL' || done?.outcome === 'WAITING_EXTERNAL' ? 0 : 1));
  } else if (cmd === 'resume') {
    // Phase 2: re-query the Governance Plane for a WAITING_HUMAN task. The
    // Human Gate itself stays in vault-mcp / local-human-cli - the user does
    // the real gate, then this re-reads the truth. Never trusts local mirror.
    const resumeTaskId = argValue('--task-id');
    const done = await withTaskLock(resumeTaskId, (assertOwnership) => resumeGovernance(resumeTaskId, { assertOwnership }));
    console.log(`[orchestrator] resume result: ${done.state}${done.failure_reason ? ` (${done.failure_reason})` : ''}`);
    console.log(JSON.stringify({
      task_id: done.task_id,
      state: done.state,
      governance: done.governance ?? null,
      failure_reason: done.failure_reason ?? null,
    }, null, 2));
    process.exit(done.state === 'COMPLETED' ? 0 : 1);
  } else if (cmd === 'cancel') {
    // PHASE 4 Closure: cancellation with precise active-process termination.
    // 1) RUNNING-like: find the durable run handle(s) for this task, verify
    //    each PID's identity via /proc/<pid>/cmdline (CANCEL_TARGET_NOT_CONFIRMED
    //    on mismatch - never a blind kill), SIGTERM -> grace -> SIGKILL.
    // 2) WAITING_HUMAN / queued: Control Plane row only, no process to kill.
    // Governance audit trail (candidate/review/approval) is never touched.
    const tid = argValue('--task-id');
    const reason = argValue('--reason') ?? 'cancelled by operator';
    const graceMs = Number(argValue('--grace-ms') ?? 4000);
    const t0 = (() => {
      try {
        return loadTask(tid);
      } catch (err) {
        console.error(`[orchestrator] ${String(err?.message ?? err)}`);
        process.exit(2);
      }
    })();
    if (TERMINAL_STATES.has(t0.state)) {
      console.error(`[orchestrator] task=${tid} is already ${t0.state} (TASK_TERMINAL) - cancel refused`);
      process.exit(2);
    }
    const RUNS_HANDLE_DIR = join(process.env.AF_RUNTIME_DIR || join(ROOT, 'runtime'), 'runs');
    // Identity hints for PID-reuse protection. Matched as SUBSTRINGS against
    // /proc/<pid>/cmdline: launchers are bash wrappers (claude-af/agy-af) that
    // `exec` into the real CLI, so the live cmdline shows claude-ccs/claude or
    // agy - the family substring is the durable identity, not the wrapper name.
    const launchers = { claude: 'claude', antigravity: 'agy', codex: 'codex' };
    const nowTs = new Date().toISOString();
    const termination = { requested: true, pid: null, signal: null, forced: false, observed_exit: null, already_exited: false, identity_confirmed: false };
    if (RUNNING_STATES.has(t0.state)) {
      let handles = [];
      try {
        for (const f of readdirSync(RUNS_HANDLE_DIR)) {
          if (!f.endsWith('.json')) continue;
          try {
            const h = JSON.parse(readFileSync(join(RUNS_HANDLE_DIR, f), 'utf8'));
            if (h.task_id === tid) handles.push(h);
          } catch { /* corrupt handle */ }
        }
      } catch { /* no runs dir */ }
      for (const h of handles) {
        if (!h.pid || !Number.isInteger(h.pid)) continue;
        // PID-reuse protection: confirm identity via /proc/<pid>/cmdline
        let cmdline = '';
        try { cmdline = readFileSync(`/proc/${h.pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { /* dead */ }
        const launcher = launchers[h.adapter_type] ?? h.adapter_type;
        if (!cmdline.includes(launcher)) {
          termination.identity_confirmed = false;
          termination.note = `CANCEL_TARGET_NOT_CONFIRMED: pid ${h.pid} cmdline does not contain ${launcher}`;
          continue;
        }
        termination.identity_confirmed = true;
        termination.pid = h.pid;
        // Mark the durable handle BEFORE signalling: the executor process's
        // execAsync reads this marker on exit so this SIGTERM/SIGKILL is
        // classified RUN_CANCELLED (never a crash -> FAILED overwrite of the
        // CANCELLED state recorded below).
        try {
          const hp = join(RUNS_HANDLE_DIR, `${h.run_id}.json`);
          const cur = JSON.parse(readFileSync(hp, 'utf8'));
          writeFileSync(hp, JSON.stringify({ ...cur, cancelled: true, cancel_requested_at: nowTs }, null, 2));
        } catch { /* handle gone - process already exited */ }
        let sig = 'SIGTERM';
        // Tree signal by pid: the recorded pid is the process-group leader (the
        // managed spawner detaches every child), so the descendants of an
        // executor CLI are terminated with it instead of being orphaned.
        signalPidTree(h.pid, 'SIGTERM');
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          let alive = true;
          try { process.kill(h.pid, 0); } catch { alive = false; }
          if (!alive) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        let stillAlive = false;
        try { process.kill(h.pid, 0); stillAlive = true; } catch { /* dead */ }
        if (stillAlive) {
          sig = 'SIGKILL';
          signalPidTree(h.pid, 'SIGKILL');
          termination.forced = true;
        }
        termination.signal = sig;
        termination.observed_exit = !stillAlive;
      }
      if (!handles.length) {
        termination.already_exited = true;
      }
    } else {
      termination.already_exited = true; // WAITING_HUMAN / non-running: no process to kill
    }
    // Re-read the task right before writing the terminal state (race vs a
    // natural completion): never overwrite a terminal state with CANCELLED.
    const t = loadTask(tid);
    const nowTs2 = new Date().toISOString();
    t.cancel_requested_at = t0.cancel_requested_at ?? t0.updated_at ?? nowTs2;
    t.cancel_reason = reason;
    t.cancelled_by = 'operator';
    const lastRun = t.runs[t.runs.length - 1] ?? null;
    t.active_run_id = lastRun && !TERMINAL_STATES.has(t.state) ? lastRun.executor_run_id : null;
    t.termination = { ...termination };
    if (TERMINAL_STATES.has(t.state)) {
      console.log(`[orchestrator] task=${tid} already ${t.state} - cancel recorded but terminal state kept`);
      console.log(JSON.stringify({ task_id: tid, state: t.state, termination: t.termination }, null, 2));
      process.exit(0);
    }
    t.state = 'CANCELLED';
    t.cancelled_at = nowTs;
    saveTask(t);
    console.log(`[orchestrator] task=${tid} state=CANCELLED (governance audit trail untouched)`);
    console.log(JSON.stringify({ task_id: tid, termination: t.termination }, null, 2));
  } else if (cmd === 'executor') {
    const { getExecutorOperationsStatus, formatExecutorStatus, listCircuitBreakers } = await import('./lib/executor-ops.mjs');
    const sub = rest[0];
    if (sub === 'status') {
      const target = rest[1] && !rest[1].startsWith('-') ? rest[1] : argValue('--executor');
      if (target) {
        console.log(formatExecutorStatus(getExecutorOperationsStatus(target)));
      } else {
        const list = listCircuitBreakers();
        console.log(list.map((item) => formatExecutorStatus(getExecutorOperationsStatus(item.id))).join('\n\n---\n\n'));
      }
      process.exit(0);
    } else if (sub === 'profile') {
      const { getExecutorEffectiveProfile } = await import('./lib/executor-status.mjs');
      const target = rest[1] && !rest[1].startsWith('-') ? rest[1] : argValue('--executor');
      const targets = target ? [target] : ['codex', 'cline', 'claude'];
      for (const t of targets) {
        const p = getExecutorEffectiveProfile(t);
        console.log(`Executor: ${p.executor.toUpperCase()}`);
        if (p.configured === false) {
          console.log(`  Status:  未配置 (UNCONFIGURED)`);
          console.log(`  Note:    ${p.note}\n`);
          continue;
        }
        console.log(`  Model:   ${p.model} (source: ${p.model_source})`);
        console.log(`  Effort:  ${p.effort} (source: ${p.effort_source})`);
        console.log(`  MCP:     ${p.mcp_unattended ? 'unattended PASS' : 'none'}`);
        console.log(`  Sandbox: ${p.sandbox}\n`);
      }
      process.exit(0);
    } else {
      console.error('usage: orchestrator.mjs executor status [executor] | executor profile [executor]');
      process.exit(2);
    }
  } else if (cmd === 'circuit') {
    const { listCircuitBreakers, formatCircuitList, resetCircuitBreaker } = await import('./lib/executor-ops.mjs');
    const sub = rest[0];
    if (sub === 'list') {
      console.log(formatCircuitList(listCircuitBreakers()));
      process.exit(0);
    } else if (sub === 'reset') {
      const target = rest[1] && !rest[1].startsWith('-') ? rest[1] : argValue('--executor');
      const reason = argValue('--reason');
      const resetBy = argValue('--reset-by') || process.env.USER || 'operator';
      if (!target) { console.error('error: executor is required: orchestrator.mjs circuit reset <executor> --reason "<reason>"'); process.exit(1); }
      if (!reason || !reason.trim()) { console.error('error: --reason is required for manual circuit reset'); process.exit(1); }
      const res = resetCircuitBreaker(target, { reason, reset_by: resetBy });
      console.log(`Circuit reset successful:`);
      console.log(`executor: ${res.executorType}`);
      console.log(`state: ${res.state}`);
      console.log(`reset_by: ${res.reset_by}`);
      console.log(`reset_time: ${res.reset_time}`);
      console.log(`reason: ${res.reason}`);
      process.exit(0);
    } else {
      console.error('usage: orchestrator.mjs circuit list | circuit reset <executor> --reason "<reason>"');
      process.exit(2);
    }
  } else {
    console.error('usage: orchestrator.mjs run --task-file <json> | status|inspect|resume|cancel --task-id <id> | list [--status <f>] | recover --scan | recover --task-id <id> | executor status [executor] | circuit list | circuit reset <executor> --reason "<reason>"');
    process.exit(2);
  }
}
