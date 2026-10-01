// acceptance.mjs - deterministic acceptance execution (trusted boundary)
//
// TRUST BOUNDARY (Phase 1.1): the acceptance command comes ONLY from the
// user-provided task definition (or a trusted fixture/task config shipped
// with the Orchestrator). Agent output - author structured_result, reviewer
// result, required_changes, README, source code, MCP content - is DATA and
// can never become an Orchestrator command. There is deliberately no code
// path here that reads a command from any ExecutorResult.

import { spawnManaged, signalTree, capCapture } from './child-process.mjs';
import { applyResourceLimits, resolveResourceLimits } from './resource-limits.mjs';
import { planSandbox, sandboxCleanup } from './sandbox.mjs';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
import { acceptanceAllowlistFile, loadAcceptanceAllowlist as readAcceptancePolicy, acceptanceCommandAllowed } from './acceptance-policy.mjs';

const STDOUT_LIMIT = 1500;
const STDERR_LIMIT = 1500;

// The acceptance command is a trust anchor: it is executed with the operator's
// privileges. A task may only run a command the allowlist names, and only with
// the argument prefix it names. A missing or unreadable allowlist denies
// everything (fail-closed) rather than falling back to "anything goes".
export function loadAcceptanceAllowlist(file = acceptanceAllowlistFile()) {
  return readAcceptancePolicy({ file }).allowed;
}

function isAllowed(spec, allowlist) {
  return !spec.legacy_shell && acceptanceCommandAllowed(spec, { allowed: allowlist }).ok;
}

function realOrResolved(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

// The control plane (tasks/, runtime/, locks/, config/) lives under the
// orchestrator root. An executor workspace must never be able to reach it.
function isInsideOrchestratorRoot(dir) {
  if (!dir) return false;
  const root = realOrResolved(ROOT_DIR);
  const target = realOrResolved(dir);
  return target === root || target.startsWith(`${root}/`);
}

// Binds the acceptance trust anchor to a digest. The task file is rewritten
// constantly as a task runs, so hashing the whole file would trip on every
// state change; what must not change silently is the command that will be
// executed and the legacy flag that widens it.
//
// fixture_dir is deliberately NOT part of the digest: the control plane fills
// in a default for a task that did not declare one, so it is not a stable
// declared value. Where the command may run is enforced separately (the
// workspace must not be inside the orchestrator root).
export function acceptanceBinding(task = {}) {
  const anchor = {
    acceptance_cmd: task.acceptance_cmd ?? null,
    allow_legacy_shell_acceptance: task.allow_legacy_shell_acceptance === true,
  };
  return createHash('sha256').update(JSON.stringify(anchor)).digest('hex');
}

export function verifyAcceptanceBinding(task = {}) {
  // A missing binding does NOT mean "nothing to verify": deleting the field
  // used to return ok, which silently unbound the anchor (and the scheduler's
  // `??=` backfill then re-bound whatever the tampered file currently said).
  // Every task reaches execution already bound - loadTaskFile() and
  // Scheduler.enqueue() both bind it - so an unbound task here means the file
  // lost its binding. Fail closed.
  if (!task.acceptance_binding) {
    return {
      ok: false,
      bound: false,
      reason: 'acceptance_binding missing: the acceptance trust anchor is unbound',
    };
  }
  const actual = acceptanceBinding(task);
  if (actual !== task.acceptance_binding) {
    return { ok: false, bound: true, expected: task.acceptance_binding, actual };
  }
  return { ok: true, bound: true };
}

function failRecord(spec, cwd, reason, extraErr) {
  return {
    ok: false,
    output: `acceptance environment error: ${reason}`,
    record: {
      command: spec.command, args: spec.args, cwd, legacy_shell: spec.legacy_shell,
      exit_code: -1, duration_ms: 0, started_at: new Date().toISOString(),
      stdout_summary: '', stderr_summary: extraErr ?? '',
      failure_reason: reason,
    },
  };
}

function truncate(s, limit) {
  if (!s) return '';
  return s.length > limit ? `${s.slice(0, limit)}…(truncated ${s.length - limit} chars)` : s;
}

// Normalizes task.acceptance_cmd to {command, args, legacy_shell} or null.
// Structured form (required by default): {command: "node", args: ["--test"]}
// Legacy string form is FORBIDDEN by default (Phase 1.1 closure): it may only
// be enabled explicitly by the trusted task file via
// allow_legacy_shell_acceptance=true. It can never be enabled by agent output.
//
// The structured form must additionally match config/acceptance-allowlist.json
// (or AF_ACCEPTANCE_ALLOWLIST): the acceptance command is a trust anchor and a
// task definition must not be able to run an arbitrary program.
export function normalizeAcceptanceCmd(acceptanceCmd, { allowLegacy = false, allowlist = null } = {}) {
  if (!acceptanceCmd) return null;
  if (typeof acceptanceCmd === 'string') {
    if (!allowLegacy) {
      throw new Error('legacy shell-string acceptance_cmd is forbidden by default; use structured {command, args} or set allow_legacy_shell_acceptance=true in the trusted task file');
    }
    // The legacy flag only unlocks the string FORM; it never widens the
    // allowlist. isAllowed() rejects legacy_shell unconditionally, so the check
    // below is what actually closes this path - the previous code returned
    // before consulting the allowlist, which made the "legacy_shell is never
    // allowlisted" guard in isAllowed unreachable and let a task file run an
    // arbitrary `bash -lc` string.
    const spec = { command: acceptanceCmd, args: null, legacy_shell: true };
    if (!isAllowed(spec, allowlist ?? loadAcceptanceAllowlist())) {
      throw new Error('acceptance_command_not_allowlisted: a legacy shell string is never allowlisted; use the structured {command, args} form');
    }
    return spec;
  }
  if (typeof acceptanceCmd === 'object' && typeof acceptanceCmd.command === 'string') {
    if (!Array.isArray(acceptanceCmd.args)) throw new Error('acceptance_cmd.args must be an array');
    const spec = { command: acceptanceCmd.command, args: acceptanceCmd.args, legacy_shell: false };
    if (!isAllowed(spec, allowlist ?? loadAcceptanceAllowlist())) {
      throw new Error(`acceptance_command_not_allowlisted: ${spec.command} ${spec.args.join(' ')}`.trim());
    }
    return spec;
  }
  throw new Error('acceptance_cmd must be a string or {command, args}');
}

/**
 * An acceptance record proves the anchor was pinned AND that this exact command
 * has already been executed; from that point a missing binding means the field
 * was removed.
 *
 * Tasks with runs but no acceptance history are treated as first sight on
 * purpose: a task file written directly by a tool, or created before this
 * anchor existed, has no binding yet, and pinning it there is the migration
 * path rather than a tamper signal.
 */
function hasAcceptanceHistory(task) {
  return Array.isArray(task?.acceptance_runs) && task.acceptance_runs.length > 0;
}

/**
 * Verify the acceptance trust anchor, pinning it on FIRST SIGHT while the task
 * has no acceptance history.
 *
 * Pinning a task whose command has never run grants no new capability on its
 * own: whoever supplied the command supplied the anchor with it. What the
 * anchor must catch is a command that was pinned and then edited or unbound, so
 * once an acceptance has been recorded a missing binding is tampering.
 *
 * @param {object} task - task definition; mutated only when it is pinned.
 * @returns {{ok: boolean, pinned: boolean, bound: boolean, reason?: string, expected?: string, actual?: string}}
 */
export function ensureAcceptanceBinding(task = {}) {
  if (task.acceptance_binding) {
    return { ...verifyAcceptanceBinding(task), pinned: false };
  }
  if (hasAcceptanceHistory(task)) {
    return {
      ok: false,
      pinned: false,
      bound: false,
      reason: 'acceptance_binding was removed after an acceptance had run: the acceptance trust anchor is no longer verifiable',
    };
  }
  task.acceptance_binding = acceptanceBinding(task);
  return { ok: true, pinned: true, bound: true };
}

// An acceptance command that never exits used to wedge the scheduler forever
// and to survive SIGTERM as an orphan: the orchestrator's handle registry only
// tracks executor runs. Every acceptance child now goes through
// lib/child-process.mjs, which owns it as a process GROUP and registers it, so
// a shutdown reaps it (and its descendants) through signalAllManaged().
const ACCEPTANCE_KILL_GRACE_MS = 4000;
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 30 * 60_000;

function resolveAcceptanceTimeoutMs(task) {
  const raw = task?.acceptance_timeout_ms ?? process.env.AF_ACCEPTANCE_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_ACCEPTANCE_TIMEOUT_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_ACCEPTANCE_TIMEOUT_MS;
}

// Executes the trusted acceptance command with cwd pinned to the task
// workspace. Returns a structured evidence record (never throws on
// non-zero exit - a failed acceptance is workflow data, not a crash).
export function runAcceptance(task) {
  // Rejected trust anchors are workflow failures, never crashes: the caller
  // records them as evidence and fails the task closed. A task with no
  // execution history is pinned here (see ensureAcceptanceBinding).
  const binding = ensureAcceptanceBinding(task);
  if (!binding.ok) {
    return Promise.resolve(failRecord(
      { command: '(unverified)', args: null, legacy_shell: false },
      task.fixture_dir ?? '',
      'TASK_FILE_TAMPERED',
      binding.bound
        ? `the acceptance trust anchor changed after task creation (expected ${binding.expected}, got ${binding.actual})`
        : binding.reason
    ));
  }

  let spec;
  try {
    spec = normalizeAcceptanceCmd(task.acceptance_cmd, {
      allowLegacy: task.allow_legacy_shell_acceptance === true,
    });
  } catch (err) {
    return Promise.resolve(failRecord(
      { command: '(rejected)', args: null, legacy_shell: false },
      task.fixture_dir ?? '',
      'ACCEPTANCE_COMMAND_REJECTED',
      String(err?.message ?? err)
    ));
  }
  if (!spec) return Promise.resolve({ ok: true, output: '(no acceptance command defined)', record: null });
  const cwd = task.fixture_dir; // never an agent-provided path
  if (!existsSync(cwd)) {
    // fail fast with a precise reason instead of a cryptic spawn ENOENT
    return Promise.resolve(failRecord(spec, cwd, 'cwd_missing', `workspace ${cwd} does not exist`));
  }
  if (isInsideOrchestratorRoot(cwd)) {
    // An executor with write tools must not be able to reach the control plane
    // (tasks/, runtime/, locks/) through its workspace.
    return Promise.resolve(failRecord(spec, cwd, 'FIXTURE_DIR_INSIDE_ORCHESTRATOR', `workspace ${cwd} is inside the orchestrator root ${ROOT_DIR}`));
  }
  const started = new Date().toISOString();
  const t0 = Date.now();
  const timeoutMs = resolveAcceptanceTimeoutMs(task);
  const limits = resolveResourceLimits();

  // Sandbox first, rlimits as the fallback.
  //
  // The two cannot be nested: the rlimit path uses a `bash -c` shim, and a slim
  // image (node:24-alpine) has `sh` but not `bash`. When the sandbox is active
  // it applies the same rlimits through Docker's --ulimit, so the shim is
  // skipped rather than stacked.
  //
  // Mode 'require' fails the run closed instead of quietly running unsandboxed
  // (ROADMAP principle 5). Mode 'auto' proceeds and RECORDS that no sandbox was
  // used, so an evidence record never hides the weaker posture.
  const sandbox = planSandbox({
    command: spec.legacy_shell ? 'bash' : spec.command,
    args: spec.legacy_shell ? ['-lc', spec.command] : spec.args,
    cwd,
    limits,
    extraEnv: acceptancePassthroughEnv(),
  });
  if (!sandbox.allowed) {
    return Promise.resolve(failRecord(spec, cwd, 'SANDBOX_UNAVAILABLE',
      `AF_SANDBOX=require but no sandbox is available: ${sandbox.status.reason}`));
  }
  const sandboxEvidence = { ...sandbox.status, applied: sandbox.plan?.applied ?? null };
  const launch = sandbox.plan
    ? { command: sandbox.plan.command, args: sandbox.plan.args, applied: sandbox.plan.applied, mechanism: sandbox.plan.mechanism }
    : applyResourceLimits(
      spec.legacy_shell ? 'bash' : spec.command,
      spec.legacy_shell ? ['-lc', spec.command] : spec.args,
      { limits },
    );

  return new Promise((resolve) => {
    // A sandboxed run's child is the `docker run` client. The shim path ends in
    // `exec "$@"` so it keeps this pid either way, which is what lets the
    // timeout tree kill reach it.
    const child = spawnManaged(launch.command, launch.args, { cwd, env: acceptanceEnv() });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    // Escalate SIGTERM -> SIGKILL so a child that ignores the first signal
    // cannot hold the scheduler hostage. The signal goes to the whole process
    // GROUP, so a command that fanned out (`bash -c 'a & b'`, a test runner's
    // workers) does not leave descendants behind. Timers are unref'd: an
    // acceptance budget must never keep the process alive on its own.
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        signalTree(child, 'SIGTERM');
        killTimer = setTimeout(() => {
          signalTree(child, 'SIGKILL');
        }, ACCEPTANCE_KILL_GRACE_MS);
        killTimer.unref?.();
      }, timeoutMs)
      : null;
    timeout?.unref();

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      // Killing the `docker run` client does NOT stop its container, and the
      // timeout path escalates to SIGKILL (no signal proxy). Remove it by name
      // so an abrupt kill cannot leave a container running.
      if (sandbox.plan) sandboxCleanup(sandbox.plan.containerName);
      resolve(payload);
    };

    child.stdout.on('data', (d) => { stdout = capCapture(stdout, d); });
    child.stderr.on('data', (d) => { stderr = capCapture(stderr, d); });
    child.on('error', (e) => {
      finish({
        ok: false,
        output: truncate(`${stdout}\n${stderr}`, STDOUT_LIMIT),
        record: {
          command: spec.command, args: spec.args, cwd, legacy_shell: spec.legacy_shell,
          resource_limits: launch.applied,
          sandbox: sandboxEvidence,
          exit_code: -1, duration_ms: Date.now() - t0, started_at: started,
          stdout_summary: truncate(stdout, STDOUT_LIMIT), stderr_summary: truncate(`${stderr}\n${String(e)}`, STDERR_LIMIT),
          failure_reason: 'spawn_error',
        },
      });
    });
    child.on('close', (code) => {
      finish({
        ok: code === 0 && !timedOut,
        output: truncate(`${stdout}\n${stderr}`, STDOUT_LIMIT + STDERR_LIMIT),
        record: {
          command: spec.command, args: spec.args, cwd, legacy_shell: spec.legacy_shell,
          resource_limits: launch.applied,
          sandbox: sandboxEvidence,
          exit_code: code, duration_ms: Date.now() - t0, started_at: started,
          stdout_summary: truncate(stdout, STDOUT_LIMIT), stderr_summary: truncate(stderr, STDERR_LIMIT),
          failure_reason: timedOut ? `timeout after ${timeoutMs}ms` : (code === 0 ? null : `exit ${code}`),
        },
      });
    });
  });
}

import { CURRENT_NODE_BIN_DIR } from './config.mjs';

// The acceptance child is handed an explicit environment, never the whole
// parent environment: it runs a command derived from a task definition, so
// credentials that happen to be exported in the operator's shell must not be
// reachable from it.
const ACCEPTANCE_ENV_ALLOW = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LANGUAGE', 'TZ',
  'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'SHELL', 'TERM',
];

function acceptanceEnv() {
  const env = {};
  for (const key of ACCEPTANCE_ENV_ALLOW) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Explicit opt-in passthrough for anything else the operator wants to expose.
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('AF_ACCEPTANCE_ENV_')) {
      env[key.slice('AF_ACCEPTANCE_ENV_'.length)] = value;
    }
  }
  env.PATH = `${CURRENT_NODE_BIN_DIR}:${env.PATH ?? ''}`;
  return env;
}

/**
 * The same explicit opt-ins, as a map for the sandbox to forward with `-e`.
 *
 * A container starts with no inherited environment, so without this the
 * documented `AF_ACCEPTANCE_ENV_*` passthrough would silently stop working the
 * moment the sandbox is enabled - a feature quietly broken by a security
 * improvement is exactly the kind of regression this project keeps finding.
 *
 * @returns {Record<string, string>} variables to forward into the container.
 */
function acceptancePassthroughEnv() {
  const forwarded = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('AF_ACCEPTANCE_ENV_') || value === undefined) continue;
    forwarded[key.slice('AF_ACCEPTANCE_ENV_'.length)] = value;
  }
  return forwarded;
}
