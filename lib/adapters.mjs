import {instrumentAdapter, disabledExecutors} from './operator-control.mjs';
// adapters.mjs - Agent Foundry Orchestrator executor adapters (Phase 1)
//
// Capability truth lives in agent-foundry-global/executors/*.json - this file
// only implements the runtime mapping from platform-native output to the
// unified ExecutorResult. No capability decisions are duplicated here.
//
// Contract (executors/contract.json):
//   run(taskCapsule) / resume(sessionRef, taskCapsule) / cancel(runId) / health()
// ExecutorResult:
//   executor_run_id, executor_type, assigned_role, status, session_ref,
//   structured_result, exit_code, started_at, finished_at, error

import { spawnManaged, signalTree, capCapture, CAPTURE_LIMIT_BYTES } from './child-process.mjs';
import { executorEnv } from './executor-env.mjs';
import { applyResourceLimits, resolveResourceLimits } from './resource-limits.mjs';
import { planExecutorSandbox, sandboxCleanup } from './sandbox.mjs';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeGuard } from './executor-runtime-guard.mjs';
import { classifyExecutionError } from './executor-error-classifier.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_DIR = join(ROOT_DIR, 'runtime', 'runs');

import {
  HOME,
  AGY_BIN,
  AGY_LAUNCHER,
  CLAUDE_LAUNCHER,
  VERTEX_LAUNCHER,
  CLINE_LAUNCHER,
  COMMAND_CODE_LAUNCHER,
  COMMAND_CODE_BIN,
  CANONICAL_AGENTS_MD,
} from './config.mjs';

const AGY = AGY_BIN;
const CANONICAL = CANONICAL_AGENTS_MD;

function exists(p) {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

// Resolve an executable by name against PATH (codex is spawned by name rather
// than through a launcher, so health has to look it up the same way).
function onPath(name) {
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (dir && exists(join(dir, name))) return join(dir, name);
  }
  return null;
}

// ---- active run registry (PHASE 4 Closure: precise cancellation) ----
// runId -> { child, task_id, adapter_type, pid, started_at }
// In-memory only (same-process cancellation). Cross-process cancellation goes
// through the run-handle files written by the orchestrator (runtime/runs/).
const activeRuns = new Map();
// runIds for which a cancel was requested (cross-process or in-process)
const cancelRequested = new Set();

export function registerActiveRun(runId, { child, task_id, adapter_type }) {
  activeRuns.set(runId, { child, task_id, adapter_type, pid: child.pid ?? null, started_at: new Date().toISOString() });
}

export function unregisterActiveRun(runId) {
  activeRuns.delete(runId);
}

// Cross-process cancel marker: the operator cancel CLI writes `cancelled:true`
// onto the durable run handle BEFORE signalling the process, so the executor
// process itself can classify the resulting exit as RUN_CANCELLED.
function cancelMarkedOnDisk(runId) {
  try {
    const h = JSON.parse(readFileSync(join(RUNS_DIR, `${runId}.json`), 'utf8'));
    return h.cancelled === true;
  } catch {
    return false;
  }
}

// Precise termination of ONE run by its executor_run_id. Never kills by
// platform name or "latest process". Grace: SIGTERM -> wait -> SIGKILL.
// Records the full termination evidence. already_exited is not an error.
export async function terminateRun(runId, { graceMs = 4000 } = {}) {
  const handle = activeRuns.get(runId);
  if (!handle) {
    return { run_id: runId, already_exited: true, termination_signal: null, forced: false, process_exit_observed: false };
  }
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode !== null) {
    // process already gone (natural exit raced with the cancel request)
    activeRuns.delete(runId);
    return { run_id: runId, already_exited: true, termination_signal: null, forced: false, process_exit_observed: true, exit_code: child.exitCode };
  }
  const pid = child.pid;
  let signal = 'SIGTERM';
  let forced = false;
  let observedExit = null;
  const exited = new Promise((res) => child.once('close', (code, sig) => res({ code, sig })));
  // Tree signal: an executor CLI fans out into its own subprocesses, so killing
  // only the leader would leave those descendants running under a task the
  // control plane already considers terminated.
  signalTree(child, 'SIGTERM');
  const inTime = await Promise.race([
    exited.then(() => true),
    new Promise((res) => setTimeout(() => res(false), graceMs)),
  ]);
  if (!inTime) {
    forced = true;
    signal = 'SIGKILL';
    signalTree(child, 'SIGKILL');
    const fin = await Promise.race([exited.then(() => true), new Promise((res) => setTimeout(() => res(false), 3000))]);
    observedExit = fin ? 'observed' : 'not_observed_within_fallback_window';
  } else {
    observedExit = 'observed';
  }
  activeRuns.delete(runId);
  try { unlinkSync(join(RUNS_DIR, `${runId}.json`)); } catch { /* handle file gone */ }
  return { run_id: runId, already_exited: false, pid, termination_signal: signal, forced, process_exit_observed: observedExit };
}

// Precise cancellation from INSIDE the same process (scheduler.cancelTask).
// Marks the run cancelled, then terminates its process with grace.
export async function cancelRun(runId, { graceMs = 4000 } = {}) {
  const handle = activeRuns.get(runId);
  if (handle) handle.cancelled = true;
  cancelRequested.add(runId);
  const evidence = await terminateRun(runId, { graceMs });
  if (handle) evidence.cancelled = true;
  return evidence;
}

// Cancel every active run belonging to ONE task (precise: by run registry
// correlation, never by platform name). Returns per-run evidence.
export async function cancelTaskRuns(taskId, { graceMs = 4000 } = {}) {
  const results = [];
  for (const [runId, handle] of [...activeRuns.entries()]) {
    if (handle.task_id !== taskId) continue;
    handle.cancelled = true;
    cancelRequested.add(runId);
    results.push(await terminateRun(runId, { graceMs }));
    results.at(-1).cancelled = true;
  }
  return results;
}

export function activeRunsForTask(taskId) {
  return [...activeRuns.entries()]
    .filter(([, h]) => h.task_id === taskId)
    .map(([runId, h]) => ({ run_id: runId, pid: h.pid, adapter_type: h.adapter_type, started_at: h.started_at }));
}

export function getAllActiveRuns() {
  return [...activeRuns.entries()].map(([runId, h]) => ({
    run_id: runId,
    task_id: h.task_id,
    adapter_type: h.adapter_type,
    pid: h.pid,
    started_at: h.started_at,
  }));
}

export async function terminateAllActiveRuns({ graceMs = 4000 } = {}) {
  const results = [];
  for (const [runId] of [...activeRuns.entries()]) {
    results.push(await cancelRun(runId, { graceMs }));
  }
  return results;
}

export function detectThinkingDeadLoop(signatures, minRepetitions = 4) {
  if (!Array.isArray(signatures) || signatures.length < minRepetitions) return null;
  const last = signatures[signatures.length - 1];
  // File edits are active progress and productive work, never a dead loop
  if (!last || last.startsWith('file:')) return null;

  // 1-step repeat of the same command or message:
  let consecutive = 0;
  for (let i = signatures.length - 1; i >= 0; i--) {
    if (signatures[i] === last) consecutive++;
    else break;
  }
  if (consecutive >= minRepetitions) {
    return { detected: true, reason: `Repeated action ${consecutive} times: ${last}` };
  }

  // 2-step to 4-step cycles: only consider cycles where NO file changes occur
  for (let cycleLen = 2; cycleLen <= 4; cycleLen++) {
    const needed = cycleLen * minRepetitions;
    if (signatures.length < needed) continue;
    const slice = signatures.slice(-needed);
    // If any file changes occurred, this is active iteration/editing, not a dead loop
    if (slice.some((s) => s.startsWith('file:'))) continue;
    let matches = true;
    for (let i = 0; i < needed; i++) {
      if (slice[i] !== slice[i % cycleLen]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const pattern = slice.slice(0, cycleLen).join(' -> ');
      return { detected: true, reason: `Repeating cycle (len ${cycleLen}) x${minRepetitions}: ${pattern}` };
    }
  }
  return null;
}

function execAsync(argv, { cwd, timeoutMs, stdin, runId = null, taskId = null, executorType = null, purpose = 'production', protectActiveProcess = false, idleTimeoutMs = null }) {
  // NOTE: the body below is an async IIFE whose rejection is funnelled into
  // resolve(). `new Promise(async (resolve) => …)` leaves a thrown error as an
  // unhandled rejection and the promise NEVER settles, which would hang the
  // caller forever instead of reporting a failed run.
  return new Promise((resolve) => {
    const started = new Date().toISOString();
    const executor = executorType || (argv[0].includes('vertex-gemini') ? 'vertex-gemini' : (argv[0].includes('agy') ? 'antigravity' : (argv[0].includes('claude') ? 'claude' : (argv[0].includes('cline') ? 'cline' : 'codex'))));

    const failSafe = (err) => {
      const msg = String(err?.message ?? err);
      resolve({
        stdout: '', stderr: msg, exit_code: -1, timedOut: false,
        started, finished: new Date().toISOString(), run_id: runId,
        spawn_error: msg,
        error_classification: classifyExecutionError(executor, { exit_code: -1, spawn_error: msg }),
      });
    };

    void (async () => {

    try {
      await runtimeGuard.acquireSlot(executor, purpose);
    } catch (guardErr) {
      // A launch blocked by the safety guard is an ENVIRONMENT situation, not
      // an account-policy violation: labelling it ACCOUNT_POLICY fabricated a
      // provider-policy incident in the audit trail and changed how the
      // scheduler treated the failure.
      const classification = {
        category: 'ENVIRONMENT_FAULT',
        retryable: false,
        safety_action: 'NONE',
        reason: guardErr.message,
      };
      resolve({
        stdout: '', stderr: guardErr.message, exit_code: -1, timedOut: false,
        started, finished: new Date().toISOString(), run_id: runId,
        spawn_error: guardErr.message,
        error_classification: classification,
      });
      return;
    }

    let slotReleased = false;
    const releaseGuardSlot = () => {
      if (!slotReleased) {
        slotReleased = true;
        runtimeGuard.releaseSlot(executor);
      }
    };

    // node quirk: a missing cwd surfaces as a misleading `spawn <exe> ENOENT`
    // pointing at the executable. Detect it explicitly so workspace loss is
    // reported as CWD_MISSING (non-transient) instead of triggering pointless
    // retries against a missing directory.
    if (cwd && !existsSync(cwd)) {
      const classification = classifyExecutionError(executor, { exit_code: -1, spawn_error: `CWD_MISSING: ${cwd}` });
      runtimeGuard.recordResult(executor, classification);
      resolve({
        stdout: '', stderr: `cwd_missing: ${cwd}`, exit_code: -1, timedOut: false,
        started, finished: new Date().toISOString(), run_id: runId,
        spawn_error: `CWD_MISSING: ${cwd}`,
        error_classification: classification,
      });
      releaseGuardSlot();
      return;
    }
    // Resource bounds. The shim ends in `exec "$@"`, so the real executor keeps
    // this pid and the pid-based tree kill still reaches it.
    const limits = resolveResourceLimits();
    const childEnv = executorEnv(executor);
    // Optional container sandbox for the EXECUTOR itself. Off by default and
    // requiring an explicit image: sandboxing needs an image containing the CLI,
    // which is a deployment decision, so this refuses rather than guessing.
    const executorSandbox = planExecutorSandbox({
      command: argv[0], args: argv.slice(1), cwd: cwd || '/tmp', executorType: executor, limits, env: childEnv,
    });
    if (!executorSandbox.allowed) {
      // The operator asked for a sandbox and it is not available: refuse instead of
      // running the executor unsandboxed under a weaker posture than requested.
      resolve({
        stdout: '', stderr: `SANDBOX_UNAVAILABLE: ${executorSandbox.status.reason}`, exit_code: -1,
        timedOut: false, started, finished: new Date().toISOString(), run_id: runId,
        spawn_error: `SANDBOX_UNAVAILABLE: ${executorSandbox.status.reason}`,
        sandbox: executorSandbox.status,
        error_classification: classifyExecutionError(executor, { exit_code: -1, spawn_error: `SANDBOX_UNAVAILABLE: ${executorSandbox.status.reason}` }),
      });
      return;
    }
    const launch = executorSandbox.plan
      ? { command: executorSandbox.plan.command, args: executorSandbox.plan.args, applied: executorSandbox.plan.applied, mechanism: executorSandbox.plan.mechanism }
      : applyResourceLimits(argv[0], argv.slice(1), { limits });
    const sandboxStatus = executorSandbox.status;
    const child = spawnManaged(launch.command, launch.args, {
      cwd: cwd || '/tmp',
      // Only this executor's own credential reaches it - never a sibling's, and
      // never the safety-critical control-plane state. See lib/executor-env.mjs.
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Set when captured output hits CAPTURE_LIMIT_BYTES; the tree is then
    // terminated rather than letting a flooding executor exhaust the heap.
    let outputLimitExceeded = false;
    // PHASE 4 Closure: register the live process under this run's identity so
    // cancel(runId)/cancelTaskRuns can terminate it precisely - never by
    // platform name or "latest process". A durable handle file also lets a
    // DIFFERENT operator process (cancel CLI) find and verify this run.
    if (runId && taskId) {
      registerActiveRun(runId, { child, task_id: taskId, adapter_type: executor });
      try {
        mkdirSync(join(RUNS_DIR), { recursive: true });
        writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify({
          run_id: runId, task_id: taskId, pid: child.pid ?? null,
          adapter_type: executor,
          // Enough for the orphan reaper to prove, after a HARD kill of the
          // control plane, that this pid is still the child we started: who
          // spawned it, and the process group it leads (detached spawning makes
          // the child its own group leader). Without these a pid comparison
          // alone could signal an unrelated process after PID reuse.
          owner_pid: process.pid,
          pgid: child.pid ?? null,
          started_at: new Date().toISOString(),
        }, null, 2));
      } catch { /* handle file is best-effort; in-process registry remains */ }
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelHandled = false;
    // Set once when the run settles, so 'error' + 'close' cannot both report.
    let settled = false;
    let deadLoopInfo = null;
    let lastActivityAt = Date.now();
    let lastLoggedExtension = 0;
    const signatures = [];

    // Cancellation race: the scheduler announces the run id a moment BEFORE the
    // process exists, so a cancel landing in that window finds no handle and
    // cannot terminate anything - the process then runs to completion while the
    // task is already CANCELLED. The request is recorded either way, so honour
    // it now: kill the freshly spawned child (the close handler reads
    // cancelRequested and reports the run as cancelled).
    if (runId && cancelRequested.has(runId)) {
      signalTree(child, 'SIGTERM');
    }

    const recordActivity = (chunkStr) => {
      lastActivityAt = Date.now();
      if (!protectActiveProcess) return;
      const lines = chunkStr.split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('{')) {
          try {
            const ev = JSON.parse(line);
            const item = ev.item || ev;
            if (item.type === 'commandExecution' || item.type === 'command_execution') {
              const cmd = (item.command || item.commandActions?.[0]?.command || '').trim();
              if (cmd) signatures.push(`cmd:${cmd}`);
            } else if (item.type === 'webSearch' || item.type === 'web_search') {
              const q = (item.query || item.action?.query || (Array.isArray(item.action?.queries) ? item.action.queries.join(',') : '') || '').trim();
              if (q) signatures.push(`search:${q}`);
            } else if (item.type === 'fileChange' || item.type === 'file_change') {
              signatures.push(`file:${item.path || item.changes?.[0]?.path || ''}`);
            } else if (item.type === 'agentMessage' || item.type === 'agent_message') {
              const msg = (item.text || '').trim();
              if (msg.length > 20) signatures.push(`msg:${msg.slice(0, 100)}`);
            }
          } catch {
            /* ignore non-json line */
          }
        }
      }
      if (signatures.length > 80) signatures.splice(0, signatures.length - 50);
      const dl = detectThinkingDeadLoop(signatures);
      if (dl) deadLoopInfo = dl;
    };

    const finish = (extra = {}) => {
      releaseGuardSlot();
      if (runId) {
        unregisterActiveRun(runId);
        try { unlinkSync(join(RUNS_DIR, runId + '.json')); } catch { /* handle file gone */ }
      }
      // A sandboxed executor runs as a `docker run` client: killing the client does
      // not stop its container, so remove it by name.
      if (executorSandbox.plan) sandboxCleanup(executorSandbox.plan.containerName);
      return { stdout, stderr, timedOut, output_truncated: outputLimitExceeded, resource_limits: launch.applied, sandbox: sandboxStatus, dead_loop: deadLoopInfo, started, finished: new Date().toISOString(), run_id: runId, ...extra };
    };

    const effectiveIdleMs = idleTimeoutMs || Math.max(600000, Math.min(timeoutMs, 900000));
    const checkIntervalMs = 2000;

    const monitor = setInterval(() => {
      const now = Date.now();
      const elapsed = now - Date.parse(started);
      const idleTime = now - lastActivityAt;

      // 1. Thinking dead loop detected: terminate immediately
      if (deadLoopInfo) {
        clearInterval(monitor);
        timedOut = true;
        console.warn(`[orchestrator] Terminating process (PID ${child.pid}) due to detected thinking dead loop: ${deadLoopInfo.reason}`);
        signalTree(child, 'SIGTERM');
        return;
      }

      // 2. Inactivity stagnation: terminate if silent for longer than effectiveIdleMs
      if (idleTime > effectiveIdleMs) {
        clearInterval(monitor);
        timedOut = true;
        console.warn(`[orchestrator] Terminating process (PID ${child.pid}) due to stagnation/idle timeout (${idleTime}ms silence)`);
        signalTree(child, 'SIGTERM');
        return;
      }

      // 3. Baseline timeout reached
      if (elapsed >= timeoutMs) {
        if (protectActiveProcess) {
          // Task is NOT in thinking dead loop and is actively progressing: DO NOT DESTROY PROCESS!
          if (now - lastLoggedExtension >= 60000) {
            lastLoggedExtension = now;
            console.log(`[orchestrator] Task ${taskId || runId || child.pid} exceeded baseline timeout (${timeoutMs}ms), but active progress is observed (last activity ${Math.round(idleTime / 1000)}s ago, no dead loop). Preserving process execution.`);
          }
        } else {
          clearInterval(monitor);
          timedOut = true;
          signalTree(child, 'SIGTERM');
        }
      }
    }, checkIntervalMs);

    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
    // Bounded capture with a fail-closed cutoff. Accumulating without a limit
    // let a runaway or deliberately noisy executor grow the orchestrator's heap
    // until the OOM killer took down the control plane. Past the cap the tree is
    // terminated and the run is reported as truncated, rather than silently
    // continuing to grow.
    const onOutputLimit = () => {
      if (outputLimitExceeded) return;
      outputLimitExceeded = true;
      signalTree(child, 'SIGKILL');
    };
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout = capCapture(stdout, s);
      if (stdout.length >= CAPTURE_LIMIT_BYTES) onOutputLimit();
      recordActivity(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr = capCapture(stderr, s);
      if (stderr.length >= CAPTURE_LIMIT_BYTES) onOutputLimit();
      recordActivity(s);
    });
    child.on('error', (err) => {
      clearInterval(monitor);
      // 'error' and 'close' can BOTH fire for one run: record the breaker
      // evidence exactly once, and release the cancellation bookkeeping.
      if (settled) return;
      settled = true;
      const classification = classifyExecutionError(executor, { exit_code: -1, stdout, stderr, spawn_error: String(err) });
      runtimeGuard.recordResult(executor, classification);
      if (runId) cancelRequested.delete(runId);
      resolve(finish({ exit_code: -1, spawn_error: String(err), error_classification: classification }));
    });
    child.on('close', (code, sig) => {
      clearInterval(monitor);
      if (settled) return;
      settled = true;
      // PHASE 4 Closure: a run killed by a cancel request is reported as
      // CANCELLED (cancelled flag), never as an ordinary failure. The request
      // may come from THIS process (cancelRequested) or from a DIFFERENT
      // operator process (durable handle marked `cancelled` by the cancel CLI)
      // - without the disk marker a cross-process SIGTERM/SIGKILL would be
      // misread as a crash and the task FAILED-overwritten after the operator
      // already recorded CANCELLED.
      const cancelled = cancelHandled || (runId && (cancelRequested.has(runId) || cancelMarkedOnDisk(runId)));
      let classification = null;
      if (cancelled) {
        classification = { category: 'TRANSIENT_FAULT', retryable: false, safety_action: 'NONE', reason: 'run cancelled by operator' };
      } else if (code !== 0 || timedOut) {
        classification = classifyExecutionError(executor, { exit_code: code, stdout, stderr, timedOut });
        runtimeGuard.recordResult(executor, classification);
      } else {
        classification = { category: 'SUCCESS', retryable: false, safety_action: 'NONE', reason: null };
        runtimeGuard.recordResult(executor, classification);
      }
      if (runId) cancelRequested.delete(runId);
      resolve(finish({ exit_code: code, exit_signal: sig ?? null, cancelled, error_classification: classification }));
    });
    })().catch(failSafe);
  });
}

/**
 * Health for a launcher-wrapped executor.
 *
 * EVERY launcher in bin/ verifies the canonical governance and exits 2 without it,
 * so a health check that only looks for the launcher file reports an executor that
 * cannot start at all. Measured on a host without agent-foundry-global: cline and
 * command-code reported ok=true and then exited 2 on every run, and the same host
 * had no canonical governance, so NOTHING could start while half the executors
 * claimed to be healthy. A diagnostic that cannot say "this will fail" is not a
 * diagnostic.
 *
 * @param {object} options - executor identity, launcher path, governance label, and
 *   the executor-specific readiness condition.
 * @returns {object} health with an explicit `reason` whenever ok is false.
 */
function launcherHealth({ executorType, launcher, governance, cliPath = null, cliName = null, extraOk = true, extraReason = null }) {
  const launcherOk = typeof launcher === 'string' && launcher.length > 0 && exists(launcher);
  // NOTE the distinction, because getting it wrong is silent: the local `exists()`
  // above is an EXECUTABLE check (accessSync X_OK), right for launchers and binaries
  // and always FALSE for the canonical AGENTS.md. Using it here made every
  // launcher-wrapped executor report unhealthy even with governance present; the
  // positive-path test (EH-5) caught it.
  const governanceOk = CANONICAL !== '' && existsSync(CANONICAL);
  const cliOk = cliName ? !!onPath(cliName) : (cliPath ? exists(cliPath) : true);
  const ok = launcherOk && governanceOk && cliOk && extraOk;
  // The executor-specific blocker leads: it is the actionable one.
  const reasons = [];
  if (!extraOk) reasons.push(extraReason ?? 'executor-specific readiness check failed');
  if (!launcherOk) reasons.push(`launcher not found: ${launcher || '<unresolved>'}`);
  if (!governanceOk) reasons.push(`canonical governance not readable: ${CANONICAL || '<unresolved>'} (every launcher exits 2 without it)`);
  if (!cliOk) reasons.push(`${cliName ?? cliPath} not found on PATH`);
  return { executor_type: executorType, launcher, governance, ok, reason: ok ? null : reasons.join('; ') };
}

function baseResult(partial) {
  return {
    executor_run_id: `RUN-${randomUUID().slice(0, 8)}`,
    executor_type: partial.executor_type,
    assigned_role: partial.assigned_role,
    status: partial.status,            // completed | failed
    session_ref: partial.session_ref ?? null,
    structured_result: partial.structured_result ?? null,
    exit_code: partial.exit_code,
    started_at: partial.started_at,
    finished_at: partial.finished_at,
    error: partial.error ?? null,
    error_classification: partial.error_classification ?? null,
  };
}

// A run terminated by a cancel request (in-process cancelRun or the operator
// cancel CLI's durable handle marker) is surfaced as status 'cancelled' so the
// orchestrator converges to CANCELLED - never to a crash/FAILED.
function cancelledResult(executorType, assignedRole, r) {
  return baseResult({
    executor_type: executorType,
    assigned_role: assignedRole,
    status: 'cancelled',
    session_ref: null,
    structured_result: null,
    exit_code: r.exit_code ?? -1,
    started_at: r.started,
    finished_at: r.finished,
    error: 'run cancelled by operator',
    error_classification: r?.error_classification ?? { category: 'TRANSIENT_FAULT', retryable: false, safety_action: 'NONE', reason: 'run cancelled by operator' },
  });
}

function timeoutError(partial, timeoutMs) {
  return baseResult({
    ...partial,
    status: 'failed',
    error: `timeout after ${timeoutMs}ms`,
    exit_code: partial.exit_code ?? -1,
    error_classification: partial.error_classification ?? { category: 'TRANSIENT_FAULT', retryable: true, safety_action: 'NONE', reason: `timeout after ${timeoutMs}ms` },
  });
}

// ---------------------------------------------------------------- codex
// Audited on 0.153.4: pre-authorized MCP execution succeeds unattended
// with default_tools_approval_mode = approve in config.toml while strictly
// preserving the read-only or workspace-write sandbox.
export const CodexAdapter = {
  type: 'codex',
  supportsMcpUnattended: true,
  health() {
    // A claimed-ok health that never checks anything hides a broken
    // installation until a task fails mid-run; codex is spawned by name, so
    // look it up on PATH.
    const launcher = onPath('codex');
    return {
      executor_type: 'codex',
      launcher: launcher ?? 'direct codex exec (not found on PATH)',
      governance: 'deployed-copy',
      ok: !!launcher,
      reason: launcher ? null : 'codex not found on PATH',
    };
  },
  async run(capsule) {
    const timeoutMs = capsule.timeout_ms ?? 600000;
    const sandbox = capsule.acceptEdits ? 'workspace-write' : 'read-only';
    const args = ['codex', 'exec', '--skip-git-repo-check', '-s', sandbox, '--json'];
    if (capsule.model) args.push('-m', capsule.model);
    const effort = capsule.effort || capsule.reasoning_effort;
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    if (capsule.cwd) args.push('-C', capsule.cwd);
    args.push(capsule.prompt);
    const protectActiveProcess = capsule.protect_active_process !== false;
    const idleTimeoutMs = capsule.idle_timeout_ms ?? null;
    const r = await execAsync(args, {
      timeoutMs,
      stdin: '',
      runId: capsule.runId ?? null,
      taskId: capsule.task_id ?? null,
      executorType: 'codex',
      purpose: capsule.purpose || 'production',
      protectActiveProcess,
      idleTimeoutMs,
    });
    if (r.timedOut) return timeoutError({ executor_type: 'codex', assigned_role: capsule.assigned_role, started_at: r.started, finished_at: r.finished, error_classification: r.error_classification }, timeoutMs);
    if (r.cancelled) return cancelledResult('codex', capsule.assigned_role, r);
    let structured = null;
    let sessionRef = null;
    for (const line of r.stdout.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const ev = JSON.parse(t);
        if (ev.type === 'thread.started') sessionRef = ev.thread_id ?? sessionRef;
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') structured = { result: ev.item.text };
      } catch { /* skip non-JSON lines */ }
    }
    return baseResult({
      executor_type: 'codex',
      assigned_role: capsule.assigned_role,
      status: r.exit_code === 0 ? 'completed' : 'failed',
      session_ref: sessionRef,
      structured_result: structured,
      exit_code: r.exit_code,
      started_at: r.started,
      finished_at: r.finished,
      error: r.exit_code === 0 ? null : (r.stderr || `exit ${r.exit_code}`),
      error_classification: r.error_classification ?? null,
    });
  },
  async resume(sessionRef, capsule) {
    const timeoutMs = capsule.timeout_ms ?? 600000;
    const args = ['codex', 'exec', 'resume', sessionRef, '--skip-git-repo-check', '--json'];
    if (capsule.model) args.push('-m', capsule.model);
    const effort = capsule.effort || capsule.reasoning_effort;
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(capsule.prompt);
    const protectActiveProcess = capsule.protect_active_process !== false;
    const idleTimeoutMs = capsule.idle_timeout_ms ?? null;
    const r = await execAsync(args, {
      timeoutMs,
      stdin: '',
      runId: capsule.runId ?? null,
      taskId: capsule.task_id ?? null,
      executorType: 'codex',
      purpose: capsule.purpose || 'production',
      protectActiveProcess,
      idleTimeoutMs,
    });
    if (r.timedOut) return timeoutError({ executor_type: 'codex', assigned_role: capsule.assigned_role, started_at: r.started, finished_at: r.finished, error_classification: r.error_classification }, timeoutMs);
    if (r.cancelled) return cancelledResult('codex', capsule.assigned_role, r);
    let structured = null;
    for (const line of r.stdout.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const ev = JSON.parse(t);
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') structured = { result: ev.item.text };
      } catch { /* skip */ }
    }
    return baseResult({
      executor_type: 'codex',
      assigned_role: capsule.assigned_role,
      status: r.exit_code === 0 ? 'completed' : 'failed',
      session_ref: sessionRef,
      structured_result: structured,
      exit_code: r.exit_code,
      started_at: r.started,
      finished_at: r.finished,
      error: r.exit_code === 0 ? null : (r.stderr || `exit ${r.exit_code}`),
      error_classification: r.error_classification ?? null,
    });
  },
  cancel(runId) { return cancelRun(runId, { graceMs: 4000 }); },
};

// ----------------------------------------------------------- antigravity
// agy: --output-format json envelope {conversation_id, status, response,
// structured_output, usage}.
// Phase 1.1: exact resume verified black-box - `--conversation <id>` restores
// the requested conversation (A/B codeword cross-check passed), so resume
// never depends on --continue/latest. exact_resume = true.
export const AntigravityAdapter = {
  type: 'antigravity',
  supportsMcpUnattended: true,
  exact_resume: true,
  // USER DECISION (2026-09-05): agy must never be invoked by automated
  // workflows. The account was disabled by Antigravity (ToS 403) after
  // headless automation; even if the appeal succeeds, schedulable stays
  // false unless the user explicitly changes this. Interactive manual use
  // of agy-af by the user is unaffected.
  // Semantics:
  //   - capability: READY (mechanisms PASS)
  //   - availability: ACCOUNT_DISABLED_403 (account blocker)
  //   - scheduler: excluded (schedulable = false)
  //   - reason: availability failure, NOT capability failure, NOT ROLE binding.
  schedulable: false,
  blocked_reason: 'user decision: agy is excluded from automation (ToS 403 account disable on 2026-09-05)',
  health() {
    return {
      ...launcherHealth({
        executorType: 'antigravity',
        launcher: AGY_LAUNCHER,
        governance: 'direct canonical via --add-dir',
        cliPath: AGY,
      }),
    };
  },
  async run(capsule) {
    return agyExec(['--output-format', 'json'], capsule);
  },
  async resume(sessionRef, capsule) {
    if (!sessionRef) throw new Error('antigravity resume requires an explicit conversation_id (no latest/continue fallback)');
    return agyExec(['--conversation', sessionRef, '--output-format', 'json'], capsule, sessionRef);
  },
  cancel(runId) { return cancelRun(runId, { graceMs: 4000 }); },
};

async function agyExec(preArgs, capsule, expectSession) {
  const timeoutMs = capsule.timeout_ms ?? 600000;
  // --mode accept-edits: official mechanism so headless author runs can edit
  // fixture files without interactive approval (no bypass-all involved).
  // agy's --print takes the prompt as its flag argument (no stdin mode).
  const args = [AGY_LAUNCHER, ...preArgs, '--mode', 'accept-edits', '--print', capsule.prompt];
  let schemaFile = null;
  if (capsule.response_schema) {
    // schema-constrained structured_output (verified in Phase 2C audit)
    schemaFile = `/tmp/af-schema-${randomUUID().slice(0, 8)}.json`;
    writeFileSync(schemaFile, JSON.stringify(capsule.response_schema));
    args.splice(args.indexOf('--print'), 0, '--json-schema', schemaFile);
  }
  const r = await execAsync(args, { cwd: capsule.cwd, timeoutMs, runId: capsule.runId ?? null, taskId: capsule.task_id ?? null, purpose: capsule.purpose || 'production' });
  if (schemaFile) { try { unlinkSync(schemaFile); } catch { /* cleanup best-effort */ } }
  if (r.cancelled) return cancelledResult('antigravity', capsule.assigned_role, r);
  return finalizeAgy(r, capsule, expectSession, timeoutMs);
}

function finalizeAgy(r, capsule, expectSession, timeoutMs) {
  if (r.timedOut) return timeoutError({ executor_type: 'antigravity', assigned_role: capsule.assigned_role, started_at: r.started, finished_at: r.finished, error_classification: r.error_classification }, timeoutMs);
  let envelope = null;
  const start = r.stdout.indexOf('{');
  const end = r.stdout.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { envelope = JSON.parse(r.stdout.slice(start, end + 1)); } catch { envelope = null; }
  }
  const sessionRef = envelope?.conversation_id ?? null;
  const sessionMismatch = expectSession && sessionRef && expectSession !== sessionRef;
  const structured = capsule.response_schema
    ? { parsed: envelope?.structured_output ?? null, raw: envelope }
    : { result: envelope?.response ?? r.stdout, raw: envelope };
  const failDetail = `exit ${r.exit_code} | stderr: ${(r.stderr || '').slice(0, 300)} | stdout head: ${(r.stdout || '').slice(0, 400)}`;
  return baseResult({
    executor_type: 'antigravity',
    assigned_role: capsule.assigned_role,
    status: r.exit_code === 0 && !sessionMismatch ? 'completed' : 'failed',
    session_ref: sessionRef,
    structured_result: structured,
    exit_code: r.exit_code,
    started_at: r.started,
    finished_at: r.finished,
    error: sessionMismatch ? `session mismatch: expected ${expectSession}, got ${sessionRef}`
      : (r.exit_code === 0 ? null : (r.stderr || failDetail)),
    error_classification: r.error_classification ?? null,
  });
}

// ---------------------------------------------------------------- claude
// claude-af -> claude-ccs -> claude (CC Switch routing preserved).
// --output-format json envelope {type:"result", result, session_id, ...}.
// resume via --resume <session-id> (explicit, no ambiguity).
export const ClaudeAdapter = {
  type: 'claude',
  supportsMcpUnattended: true,
  health() {
    return {
      ...launcherHealth({
        executorType: 'claude',
        launcher: CLAUDE_LAUNCHER,
        governance: 'direct canonical via --append-system-prompt-file',
      }),
    };
  },
  async run(capsule) {
    return claudeExec([], capsule);
  },
  async resume(sessionRef, capsule) {
    return claudeExec(['--resume', sessionRef], capsule);
  },
  cancel(runId) { return cancelRun(runId, { graceMs: 4000 }); },
};

async function claudeExec(preArgs, capsule) {
  const timeoutMs = capsule.timeout_ms ?? 600000;
  // --print consumes the IMMEDIATELY following token as its prompt; value-type
  // flags (--mcp-config, --allowedTools) also consume the next token, so a
  // trailing prompt would be swallowed whenever those flags are present. The
  const args = [CLAUDE_LAUNCHER, ...preArgs, '--print', capsule.prompt];
  if (capsule.model) args.push('--model', capsule.model);
  const effort = capsule.effort || capsule.reasoning_effort || 'low';
  args.push('--effort', String(effort).toLowerCase());
  if (capsule.acceptEdits) {
    args.push('--permission-mode', 'bypassPermissions');
  } else {
    args.push('--permission-mode', 'plan');
  }
  // Phase 2: governance steps may attach an extra MCP config (e.g. a fixture
  // vault server under a distinct name) and scope tool permissions precisely.
  if (capsule.mcpConfigPath) args.push('--mcp-config', capsule.mcpConfigPath);
  if (capsule.tools) {
    args.push('--tools', capsule.tools);
  } else {
    args.push('--tools', 'Bash,Edit,Read,Write');
  }
  if (capsule.allowedTools) args.push('--allowedTools', capsule.allowedTools);
  args.push('--output-format', 'json');
    const r = await execAsync(args, { cwd: capsule.cwd, timeoutMs, runId: capsule.runId ?? null, taskId: capsule.task_id ?? null, purpose: capsule.purpose || 'production' });
    if (r.timedOut) return timeoutError({ executor_type: 'claude', assigned_role: capsule.assigned_role, started_at: r.started, finished_at: r.finished, error_classification: r.error_classification }, timeoutMs);
    if (r.cancelled) return cancelledResult('claude', capsule.assigned_role, r);
  let envelope = null;
  const start = r.stdout.indexOf('{');
  if (start >= 0) {
    try { envelope = JSON.parse(r.stdout.slice(start)); } catch { envelope = null; }
  }
  const ok = envelope?.type === 'result' && envelope.is_error === false && r.exit_code === 0;
  const failMsg = r.spawn_error
    ? `spawn error: ${r.spawn_error}`
    : (envelope?.result || r.stderr || `exit ${r.exit_code}`);
  return baseResult({
    executor_type: 'claude',
    assigned_role: capsule.assigned_role,
    status: ok ? 'completed' : 'failed',
    session_ref: envelope?.session_id ?? null,
    structured_result: { result: envelope?.result ?? r.stdout, raw: envelope },
    exit_code: r.exit_code,
    started_at: r.started,
    finished_at: r.finished,
    error: ok ? null : failMsg,
    error_classification: r.error_classification ?? null,
  });
}

// ---------------------------------------------------------------- vertex-gemini
// Enterprise Executor Adapter for Google Cloud Vertex AI / Gemini.
// Follows the unified contract:
//   run(taskCapsule) / resume(sessionRef, taskCapsule) / cancel(runId) / health()
// Output conforms strictly to ExecutorResult.
// Secret handling: credentials injected via environment / runtime only;
// zero secrets written to disk/logs. ROLE != PLATFORM: role assigned dynamically.
// bin/vertex-gemini-af SHIPS AS A STUB in this repository: it performs no provider
// call and fabricates both a result and - for a review schema - a fixed
// `decision: 'PASS'`. A fabricated PASS is indistinguishable from a real review
// outcome, so the shipped placeholder must never be auto-selected: it would let a
// task "pass review" without anything having reviewed it.
//
// Point VERTEX_GEMINI_LAUNCHER at a real Vertex client to make this executor
// schedulable, or set AF_ALLOW_STUB_EXECUTORS=1 to run the stub deliberately.
const VERTEX_LAUNCHER_IS_SHIPPED_STUB =
  !process.env.VERTEX_GEMINI_LAUNCHER && process.env.AF_ALLOW_STUB_EXECUTORS !== '1';

export const VertexGeminiAdapter = {
  type: 'vertex-gemini',
  stub: VERTEX_LAUNCHER_IS_SHIPPED_STUB,
  ...(VERTEX_LAUNCHER_IS_SHIPPED_STUB
    ? {
      schedulable: false,
      blocked_reason: 'shipped launcher is a stub that fabricates results (and a fixed review decision: PASS); set VERTEX_GEMINI_LAUNCHER to a real client',
    }
    : {}),
  supportsMcpUnattended: true,
  exact_resume: true,
  health() {
    const launcher = process.env.VERTEX_GEMINI_LAUNCHER || VERTEX_LAUNCHER;
    return {
      ...launcherHealth({
        executorType: 'vertex-gemini',
        launcher,
        governance: 'systemInstruction via canonical AGENTS.md',
        // The old check was `exists(launcher) || credentials...`, and the launcher is
        // a file this repo ships, so the first term was ALWAYS true and the credential
        // check was dead code.
        extraOk: !VERTEX_LAUNCHER_IS_SHIPPED_STUB
          && !!(process.env.VERTEX_API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS),
        extraReason: VERTEX_LAUNCHER_IS_SHIPPED_STUB
          ? 'shipped launcher is a stub that fabricates a result; it performs no provider call'
          : 'no Vertex credentials (VERTEX_API_KEY / GOOGLE_APPLICATION_CREDENTIALS)',
      }),
    };
  },
  async run(capsule) {
    return vertexExec([], capsule);
  },
  async resume(sessionRef, capsule) {
    if (!sessionRef) throw new Error('vertex-gemini resume requires an explicit sessionRef');
    return vertexExec(['--resume', sessionRef], capsule, sessionRef);
  },
  cancel(runId) { return cancelRun(runId, { graceMs: 4000 }); },
};

async function vertexExec(preArgs, capsule, expectSession = null) {
  const timeoutMs = capsule.timeout_ms ?? 600000;
  const launcher = process.env.VERTEX_GEMINI_LAUNCHER || VERTEX_LAUNCHER;
  const args = [launcher, ...preArgs, '--print', capsule.prompt];
  let schemaFile = null;
  if (capsule.response_schema) {
    schemaFile = `/tmp/af-schema-${randomUUID().slice(0, 8)}.json`;
    writeFileSync(schemaFile, JSON.stringify(capsule.response_schema));
    args.push('--json-schema', schemaFile);
  }
  args.push('--output-format', 'json');

  const purpose = capsule.purpose === 'recovery_probe' ? 'recovery_probe' : 'production';
  const r = await execAsync(args, {
    cwd: capsule.cwd,
    timeoutMs,
    runId: capsule.runId ?? null,
    taskId: capsule.task_id ?? null,
    executorType: 'vertex-gemini',
    purpose,
  });

  if (schemaFile) {
    try { unlinkSync(schemaFile); } catch { /* best-effort */ }
  }

  if (r.timedOut) {
    return timeoutError({
      executor_type: 'vertex-gemini',
      assigned_role: capsule.assigned_role,
      started_at: r.started,
      finished_at: r.finished,
      error_classification: r.error_classification,
    }, timeoutMs);
  }

  if (r.cancelled) {
    return cancelledResult('vertex-gemini', capsule.assigned_role, r);
  }

  return finalizeVertex(r, capsule, expectSession, timeoutMs);
}

function finalizeVertex(r, capsule, expectSession) {
  let envelope = null;
  const start = r.stdout.indexOf('{');
  const end = r.stdout.lastIndexOf('}');
  if (start >= 0 && end >= start) {
    try { envelope = JSON.parse(r.stdout.slice(start, end + 1)); } catch { envelope = null; }
  }

  const sessionRef = envelope?.session_id ?? expectSession ?? null;
  const sessionMismatch = expectSession && sessionRef && expectSession !== sessionRef;

  let structured = null;
  if (capsule.response_schema) {
    structured = {
      parsed: envelope?.structured_output ?? (envelope?.result ? (typeof envelope.result === 'object' ? envelope.result : null) : null),
      raw: envelope,
    };
  } else {
    structured = {
      result: envelope?.result ?? envelope?.response ?? r.stdout,
      raw: envelope,
    };
  }

  const ok = r.exit_code === 0 && !sessionMismatch && (envelope?.is_error !== true);
  let rawError = r.spawn_error
    ? `spawn error: ${r.spawn_error}`
    : (sessionMismatch ? `session mismatch: expected ${expectSession}, got ${sessionRef}`
      : (ok ? null : (r.stderr || envelope?.error || `exit ${r.exit_code}`)));
  if (rawError) {
    // Redact any credential-like tokens from error string
    rawError = rawError.replace(/(?:key|token|secret|password|bearer)[=:\s]+[A-Za-z0-9_\-\.]{8,}/gi, '$1=[REDACTED]');
  }

  return baseResult({
    executor_type: 'vertex-gemini',
    assigned_role: capsule.assigned_role,
    status: ok ? 'completed' : 'failed',
    session_ref: sessionRef,
    structured_result: structured,
    exit_code: r.exit_code,
    started_at: r.started,
    finished_at: r.finished,
    error: rawError,
    error_classification: r.error_classification ?? null,
  });
}

// ---------------------------------------------------------------- cline
// cline-af -> cline CLI (Node/TypeScript CLI).
// Non-interactive mode: --json --auto-approve true "<prompt>"
// Output format: JSON Lines ending in a run_result event:
//   { type: "run_result", finishReason: "completed", usage: {...}, text: "..." }
// Session resume: --id <session-id>
// MCP: configured via ~/.cline/cline_mcp_settings.json with autoApprove.
export const ClineAdapter = {
  type: 'cline',
  supportsMcpUnattended: true,
  exact_resume: true,
  health() {
    const launcher = process.env.CLINE_LAUNCHER || CLINE_LAUNCHER;
    return {
      executor_type: 'cline',
      launcher,
      governance: 'direct canonical via -s / --system',
      // Look the CLI up the same way the codex adapter does. The previous
      // fallback hardcoded one node version
      // (`~/.nvm/versions/node/v24.20.0/bin/cline`), which is author-machine
      // residue: on any host with a different node version it reported the
      // executor unhealthy even though the CLI was installed and on PATH. A
      // health check that can produce a false negative is worse than none.
      ...launcherHealth({
        executorType: 'cline',
        launcher,
        governance: 'direct canonical via -s / --system',
        cliName: 'cline',
      }),
    };
  },
  async run(capsule) {
    return clineExec([], capsule);
  },
  async resume(sessionRef, capsule) {
    if (!sessionRef) throw new Error('cline resume requires an explicit sessionRef (--id <session-id>)');
    return clineExec(['--id', sessionRef], capsule, sessionRef);
  },
  cancel(runId) { return cancelRun(runId, { graceMs: 4000 }); },
};

async function clineExec(preArgs, capsule, expectSession = null) {
  const timeoutMs = capsule.timeout_ms ?? 600000;
  const launcher = process.env.CLINE_LAUNCHER || CLINE_LAUNCHER;

  let prompt = capsule.prompt || '';
  if (!/\s/.test(prompt)) {
    prompt = prompt + ' ';
  }

  const args = [launcher, ...preArgs, '--json', '--auto-approve', 'true'];
  if (capsule.model) args.push('-m', capsule.model);
  let effort = capsule.effort || capsule.reasoning_effort;
  if (!effort && capsule.model && capsule.model.includes('deepseek')) {
    effort = 'xhigh';
  }
  if (effort) args.push('--thinking', String(effort).toLowerCase());
  if (capsule.cwd) {
    args.push('-c', capsule.cwd);
  }
  args.push(prompt);

  const purpose = capsule.purpose === 'recovery_probe' ? 'recovery_probe' : 'production';
  const r = await execAsync(args, {
    cwd: capsule.cwd,
    timeoutMs,
    runId: capsule.runId ?? null,
    taskId: capsule.task_id ?? null,
    executorType: 'cline',
    purpose,
    protectActiveProcess: capsule.protect_active_process !== false,
    idleTimeoutMs: capsule.idle_timeout_ms ?? null,
  });

  if (r.timedOut) {
    return timeoutError({
      executor_type: 'cline',
      assigned_role: capsule.assigned_role,
      started_at: r.started,
      finished_at: r.finished,
      error_classification: r.error_classification,
    }, timeoutMs);
  }

  if (r.cancelled) {
    return cancelledResult('cline', capsule.assigned_role, r);
  }

  const fallbackModel = capsule.cline_fallback_model || 'cline-pass/deepseek-v4-flash';
  const fallbackEffort = capsule.cline_fallback_effort || 'xhigh';
  // Strict model-quota switch: only switch if execution failed (non-zero or error)
  // AND the failure is an actual AI provider rate limit / quota exhaustion.
  // Never trigger fallback on clean exits (exit_code === 0), and never match on project test logs in stdout.
  const isFailed = (r.exit_code !== 0 && r.exit_code !== null) || r.spawn_error || r.error_classification?.category === 'RATE_LIMIT';
  const isDailyOrRateLimit = isFailed && (
    r.error_classification?.category === 'RATE_LIMIT' ||
    /daily.*(?:limit|quota).*reached|quota\s*exceeded|insufficient_quota|RateLimitError|ResourceExhausted|(?:provider|api|model).*(?:429|rate\s*limit)/i.test(`${r.stderr || ''}\n${r.spawn_error || ''}`)
  );

  if (isDailyOrRateLimit && capsule.model !== fallbackModel) {
    console.warn(`[cline-adapter] Daily rate limit / quota exceeded for cline (model=${capsule.model || 'default'}), automatically switching to ${fallbackModel} (effort=${fallbackEffort})...`);
    // The fallback affects THIS call only. It must not clear the breaker:
    // resetting it here silently un-banned an executor that the runtime guard
    // had locked out, bypassing the probe -> admit gate that exists precisely
    // so a human confirms the upstream problem is gone.
    const fallbackCapsule = {
      ...capsule,
      model: fallbackModel,
      effort: fallbackEffort,
      reasoning_effort: fallbackEffort,
    };
    const fallbackResult = await clineExec(preArgs, fallbackCapsule, expectSession);

    // If the fallback could not even START because the guard had the executor
    // locked out, reporting that refusal as the run's outcome hides the real
    // reason the task failed (the quota refusal). The caller must see the root
    // cause; the blocked fallback is recorded alongside it.
    if (/EXECUTOR_CIRCUIT_OPEN/.test(String(fallbackResult?.error_classification?.reason ?? ''))) {
      const original = finalizeCline(r, capsule, expectSession);
      original.fallback_blocked = {
        reason: fallbackResult.error_classification.reason,
        attempted_model: fallbackModel,
      };
      return original;
    }
    return fallbackResult;
  }

  return finalizeCline(r, capsule, expectSession);
}

function finalizeCline(r, capsule, expectSession) {
  let sessionRef = expectSession || null;
  let resultText = '';
  let finishReason = null;
  let lastEvent = null;

  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.taskId) {
        sessionRef = ev.taskId;
      }
      if (ev.type === 'run_result') {
        finishReason = ev.finishReason;
        if (ev.text) resultText = ev.text;
        lastEvent = ev;
      } else if (ev.type === 'agent_event' && ev.event?.type === 'done' && ev.event.text) {
        if (!resultText) resultText = ev.event.text;
      }
    } catch { /* skip non-JSON lines */ }
  }

  if (!resultText) {
    resultText = r.stdout;
  }

  const sessionMismatch = expectSession && sessionRef && expectSession !== sessionRef;
  const ok = r.exit_code === 0 && !sessionMismatch && (finishReason === 'completed' || !finishReason);

  let structured = null;
  if (capsule.response_schema) {
    let parsed = null;
    try {
      parsed = JSON.parse(resultText);
    } catch {
      const m = resultText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (m) {
        try { parsed = JSON.parse(m[1]); } catch { /* ignore */ }
      }
    }
    structured = { parsed, raw: lastEvent || resultText };
  } else {
    structured = { result: resultText, raw: lastEvent || resultText };
  }

  const failMsg = r.spawn_error
    ? `spawn error: ${r.spawn_error}`
    : (sessionMismatch ? `session mismatch: expected ${expectSession}, got ${sessionRef}`
      : (ok ? null : (r.stderr || `exit ${r.exit_code}`)));

  return baseResult({
    executor_type: 'cline',
    assigned_role: capsule.assigned_role,
    status: ok ? 'completed' : 'failed',
    session_ref: sessionRef,
    structured_result: structured,
    exit_code: r.exit_code,
    started_at: r.started,
    finished_at: r.finished,
    error: ok ? null : failMsg,
    error_classification: r.error_classification ?? null,
  });
}

// ---------------------------------------------------------------- command-code
// command-code (aliases: cmd, cmdc, commandcode) - Node CLI coding agent.
//
// Non-interactive mode: `-p "<prompt>"`. The prompt is bound to `-p` exactly the
// way the CLI documents it ("command-code -p \"your query\""), so it cannot be
// mistaken for a flag.
//   --trust                 REQUIRED headlessly: without it the CLI waits on its
//                           initial permission prompt and the run stalls to timeout
//   --output-format json    NDJSON event stream whose last line is the result
//   --model / --effort      model and reasoning effort
//   --max-turns             cap the agent loop (exit 8 on cap hit)
//   --session <id|path>     resume a session; -r/--resume pick by name
//
// Governance: unlike cline (-s/--system) or claude (--append-system-prompt-file),
// command-code exposes NO system-prompt flag in `--help`, so bin/command-code-af
// PREPENDS the canonical AGENTS.md to the prompt and fails closed when the
// canonical is unreadable. The prefix is therefore visible to the model as user
// content, which is weaker than a real system instruction; if a native setting
// appears (e.g. through --config), it should replace the prefix.
export const CommandCodeAdapter = {
  type: 'command-code',
  // MCP support is UNVERIFIED. Claiming `true` would let a requires_mcp task route
  // here and fail at run time; `false` keeps it out of routes it cannot serve.
  // Capability claims must never be guesses in the permissive direction.
  supportsMcpUnattended: false,
  exact_resume: true,
  health() {
    const launcher = process.env.COMMAND_CODE_LAUNCHER || COMMAND_CODE_LAUNCHER;
    const bin = process.env.COMMAND_CODE_BIN || COMMAND_CODE_BIN;
    return {
      executor_type: 'command-code',
      launcher,
      governance: 'canonical AGENTS.md prepended to the prompt (the CLI has no system-prompt flag)',
      // Resolved through PATH (and the cmd/cmdc/commandcode aliases), never a
      // hardcoded node-version path.
      ...launcherHealth({
        executorType: 'command-code',
        launcher,
        governance: 'canonical AGENTS.md prepended to the prompt (the CLI has no system-prompt flag)',
        extraOk: !!bin,
        extraReason: 'command-code CLI not found on PATH (aliases: cmd, cmdc, commandcode)',
      }),
    };
  },
  async run(capsule) {
    return commandCodeExec([], capsule);
  },
  async resume(sessionRef, capsule) {
    if (!sessionRef) throw new Error('command-code resume requires an explicit sessionRef (--session <id|path>)');
    return commandCodeExec(['--session', sessionRef], capsule, sessionRef);
  },
  cancel(runId) { return cancelRun(runId, { graceMs: 4000 }); },
};

/**
 * Parse command-code's `--output-format json` output.
 *
 * The exact envelope is UNVERIFIED: confirming it needs an authenticated run, which
 * needs an account and spends credits. The parser is therefore tolerant by design -
 * it reads the LAST parseable JSON line, looks for text/session/structured data
 * under several plausible field names, and falls back to the raw stdout. An
 * unexpected shape degrades to plain text; it never loses the result or throws.
 *
 * @param {string} stdout - captured stdout.
 * @returns {{text: string, sessionRef: string|null, structured: object|null}}
 */
function parseCommandCodeStream(stdout) {
  const raw = String(stdout ?? '');
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  let text = null;
  let sessionRef = null;
  let structured = null;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let envelope;
    try {
      envelope = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) continue;

    sessionRef = sessionRef
      ?? envelope.session_id ?? envelope.sessionId ?? envelope.session?.id
      ?? (typeof envelope.session === 'string' ? envelope.session : null);

    const candidate = envelope.text ?? envelope.result ?? envelope.response
      ?? envelope.content ?? envelope.message?.content ?? envelope.message;
    if (text === null && typeof candidate === 'string' && candidate) text = candidate;

    if (!structured) {
      const candidateStructured = envelope.structured_output ?? envelope.structured_result
        ?? (envelope.result && typeof envelope.result === 'object' ? envelope.result : null);
      if (candidateStructured && typeof candidateStructured === 'object') structured = candidateStructured;
    }
    if (text !== null && sessionRef) break;
  }

  return { text: text ?? raw.trim(), sessionRef, structured };
}

async function commandCodeExec(preArgs, capsule, expectSession = null) {
  const timeoutMs = capsule.timeout_ms ?? 600000;
  const launcher = process.env.COMMAND_CODE_LAUNCHER || COMMAND_CODE_LAUNCHER;

  let prompt = capsule.prompt || '';
  // A single-token prompt could be read as a flag; keep it unambiguous.
  if (!/\s/.test(prompt)) prompt = `${prompt} `;

  const args = [launcher, ...preArgs, '--trust', '--output-format', 'json'];
  if (capsule.model) args.push('--model', capsule.model);
  const effort = capsule.effort || capsule.reasoning_effort;
  if (effort) args.push('--effort', String(effort).toLowerCase());
  if (capsule.max_turns) args.push('--max-turns', String(capsule.max_turns));
  for (const extraDir of capsule.add_dirs ?? []) args.push('--add-dir', extraDir);
  args.push('-p', prompt);

  const purpose = capsule.purpose === 'recovery_probe' ? 'recovery_probe' : 'production';
  const r = await execAsync(args, {
    cwd: capsule.cwd,
    timeoutMs,
    runId: capsule.runId ?? null,
    taskId: capsule.task_id ?? null,
    executorType: 'command-code',
    purpose,
    protectActiveProcess: capsule.protect_active_process !== false,
    idleTimeoutMs: capsule.idle_timeout_ms ?? null,
  });

  if (r.timedOut) {
    return timeoutError({
      executor_type: 'command-code',
      assigned_role: capsule.assigned_role,
      started_at: r.started,
      finished_at: r.finished,
      error_classification: r.error_classification,
    }, timeoutMs);
  }

  if (r.cancelled) {
    return cancelledResult('command-code', capsule.assigned_role, r);
  }

  const parsed = parseCommandCodeStream(r.stdout);
  const ok = r.exit_code === 0 && !r.spawn_error;
  return baseResult({
    executor_type: 'command-code',
    assigned_role: capsule.assigned_role,
    status: ok ? 'completed' : 'failed',
    session_ref: parsed.sessionRef ?? expectSession,
    structured_result: parsed.structured,
    exit_code: r.exit_code,
    started_at: r.started,
    // baseResult reads `finished_at`; passing `finished` silently produced a result
    // with no end timestamp (caught while wiring the adapter, not by a test).
    finished_at: r.finished,
    error: ok ? null : (r.spawn_error || r.stderr || parsed.text || `exit ${r.exit_code}`),
    error_classification: r.error_classification ?? null,
  });
}

const BASE_ADAPTERS = {
  codex: CodexAdapter,
  antigravity: AntigravityAdapter,
  claude: ClaudeAdapter,
  'vertex-gemini': VertexGeminiAdapter,
  cline: ClineAdapter,
  'command-code': CommandCodeAdapter,
};

export const ADAPTERS = Object.fromEntries(Object.entries(BASE_ADAPTERS).map(([id,a]) => [id,instrumentAdapter(id,a)]));

export function selectExecutor(preference, { requiresMcp, adapters = ADAPTERS } = {}) {
  const disabled = new Set(disabledExecutors());
  const pick = (id) => {
    if (disabled.has(id)) throw new Error(`OPERATOR_EXECUTOR_DISABLED: ${id}`);
    const a = adapters[id];
    if (!a) throw new Error(`unknown executor: ${id}`);
    if (a.schedulable === false) {
      throw new Error(`executor ${id} is not schedulable (${a.blocked_reason ?? 'user/blocked'})`);
    }
    if (requiresMcp && a.supportsMcpUnattended === false) {
      throw new Error(`executor ${id} does not support unattended MCP (capability constraint, see executors/codex.json)`);
    }
    return a;
  };
  if (preference && preference !== 'auto') return pick(preference);
  // auto-scheduling order excludes non-schedulable executors entirely
  for (const id of ['antigravity', 'claude', 'codex', 'cline']) {
    const a = adapters[id];
    if (!a || a.schedulable === false || disabled.has(id)) continue;
    if (requiresMcp && a.supportsMcpUnattended === false) continue;
    return a;
  }
  throw new Error('no executor satisfies the task constraints');
}
