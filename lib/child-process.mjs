// child-process.mjs - the single place that creates and reaps child processes.
//
// Two invariants this module exists to hold:
//
//   1. Every child leads its own process GROUP, so a tree kill reaches the
//      grandchildren that `kill(child.pid)` misses. Acceptance commands and
//      executor CLIs both fan out (`bash -c 'a & b'`, test runners, npm/pnpm,
//      the CLI's own subprocesses), so reaping only the direct child leaves
//      orphans behind - which contradicts the documented "graceful shutdown /
//      zero orphan processes" guarantee.
//
//   2. Every live child is registered, so a shutdown reaps the whole set
//      instead of only the executor handles the orchestrator happens to track.
//      Before this module, acceptance children, the vault MCP server and the
//      codex planner were all invisible to the reaper.
//
// INV-8 (tests/architecture-invariant.test.mjs) forbids a bare `spawn(` in
// non-test code precisely so a new long-lived child cannot skip invariant 2.
//
// @module child-process

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IS_WIN = process.platform === 'win32';

/** Marker so callers (and tests) can assert a child came from this module. */
export const MANAGED_CHILD = Symbol.for('agent-foundry.managed-child');

/** Every live managed child, keyed by pid. */
const LIVE = new Map();

/**
 * Spawn a child that this module owns and can reap as a tree.
 *
 * On POSIX the child is detached into its own process group, which is what
 * makes `kill(-pid)` able to reach its descendants. That also means the child
 * no longer dies with the parent, so reaping becomes mandatory - the registry
 * and the shutdown hook exist for exactly that. On Windows there is no killable
 * process group, so the tree kill goes through `taskkill /T` instead and the
 * child is not detached (a detached child there opens a console window).
 *
 * @param {string} command - executable to run.
 * @param {string[]} [args] - arguments.
 * @param {object} [options] - standard child_process.spawn options.
 * @returns {import('node:child_process').ChildProcess} the managed child.
 */
export function spawnManaged(command, args = [], options = {}) {
  const child = spawn(command, args, {
    ...options,
    detached: options.detached ?? !IS_WIN,
  });
  child[MANAGED_CHILD] = true;
  if (typeof child.pid === 'number') {
    LIVE.set(child.pid, child);
    const forget = () => LIVE.delete(child.pid);
    child.once('close', forget);
    child.once('error', forget);
  }
  return child;
}

/**
 * Signal a whole process tree by its leader pid.
 *
 * Used by paths that only kept the pid (the durable run handle written for
 * cross-process cancellation) rather than the ChildProcess object.
 *
 * @param {number} pid - process group leader pid.
 * @param {string|number} [signal] - signal name or number.
 * @returns {boolean} true when a signal was delivered.
 */
export function signalPidTree(pid, signal = 'SIGTERM') {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (IS_WIN) {
    // Windows has no process groups; /T includes the whole tree, /F forces.
    const args = ['/PID', String(pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    try {
      return spawnSync('taskkill', args, { stdio: 'ignore' }).status === 0;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, signal); // negative pid = the whole process group
    return true;
  } catch {
    // Fall back to the single process: the child may not have become a group
    // leader (or the group is already gone).
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Signal one managed child's whole tree.
 * @param {import('node:child_process').ChildProcess} child - managed child.
 * @param {string|number} [signal] - signal name or number.
 * @returns {boolean} true when a signal was delivered.
 */
export function signalTree(child, signal = 'SIGTERM') {
  if (!child || typeof child.pid !== 'number') return false;
  return signalPidTree(child.pid, signal);
}

/** True once the child has exited or been signalled. */
function isSettled(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

/**
 * Whether a pid currently exists.
 *
 * `EPERM` counts as alive: the process exists, this user simply may not signal
 * it. Returning false there would make a caller treat a live process as gone.
 *
 * @param {number} pid - process id.
 * @returns {boolean} true when the process exists.
 */
export function pidIsAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Whether the detached process group led by `pid` still contains a process.
 *
 * A child can exit while a shell-launched descendant keeps the group alive;
 * checking only the leader would therefore report a false quiescence. The
 * group probe is deliberately kept beside the process-group signalling code so
 * every caller uses the same ownership boundary.
 */
export function processGroupIsAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (IS_WIN) return pidIsAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function unavailableWriterScope(reason) {
  return Object.freeze({
    kind: 'unavailable',
    path: null,
    attached: false,
    verified: false,
    reason,
  });
}

/**
 * Create a kernel-owned writer scope before an executor is spawned.
 *
 * A POSIX process group is only a signalling boundary: a child can call
 * setsid(2), create a new process group, and survive it. A delegated cgroup v2
 * subtree is the stronger boundary because descendants inherit membership and
 * cgroup.kill reaches them even after they change session or process group.
 *
 * The host must explicitly delegate a writable subtree through AF_CGROUP_BASE.
 * We fail closed when that capability is absent; creating a directory under the
 * host's root cgroup would either fail with EACCES or put unrelated processes at
 * risk. Docker/container scopes are supplied by the sandbox adapter instead.
 *
 * @param {{runId?: string|null, taskId?: string|null}} [identity]
 * @returns {object} an attachable scope, or an unavailable scope.
 */
export function createWriterScope({ runId = null, taskId = null } = {}) {
  if (IS_WIN) return unavailableWriterScope('cgroup writer scopes are not implemented on Windows');

  const base = process.env.AF_CGROUP_BASE || '/sys/fs/cgroup';
  const controllersPath = join(base, 'cgroup.controllers');
  if (!existsSync(controllersPath)) {
    return unavailableWriterScope(`cgroup v2 is not mounted at ${base}`);
  }

  const scopePath = join(base, `af-writer-${process.pid}-${randomUUID().slice(0, 12)}`);
  try {
    // Reading the file distinguishes a real cgroup mount from a test directory
    // with a stale marker and makes permission failures visible to the caller.
    readFileSync(controllersPath, 'utf8');
    mkdirSync(scopePath);
    const procsPath = join(scopePath, 'cgroup.procs');
    const killPath = join(scopePath, 'cgroup.kill');
    if (!existsSync(procsPath) || !existsSync(killPath)) {
      throw new Error('cgroup.procs and cgroup.kill are required');
    }
    return Object.freeze({
      kind: 'cgroup',
      path: scopePath,
      procs_path: procsPath,
      kill_path: killPath,
      run_id: runId,
      task_id: taskId,
      attached: false,
      verified: false,
      reason: null,
    });
  } catch (error) {
    try { rmdirSync(scopePath); } catch { /* directory was never created or is not empty */ }
    return unavailableWriterScope(`cgroup writer scope unavailable: ${String(error?.message ?? error)}`);
  }
}

/**
 * Attach the just-spawned leader to its writer cgroup. Children inherit this
 * membership, including children that create a new session or process group.
 *
 * @param {object} scope - result from createWriterScope.
 * @param {number} pid - spawned process PID.
 * @returns {object} updated scope evidence.
 */
export function attachWriterScope(scope, pid) {
  if (!scope || scope.kind !== 'cgroup') return scope;
  if (!Number.isInteger(pid) || pid <= 0) {
    discardWriterScope(scope);
    return Object.freeze({ ...scope, attached: false, verified: false, reason: 'invalid spawned PID' });
  }
  try {
    writeFileSync(scope.procs_path, `${pid}\n`);
    return Object.freeze({ ...scope, attached: true, verified: true, reason: null });
  } catch (error) {
    discardWriterScope(scope);
    return Object.freeze({
      ...scope,
      attached: false,
      verified: false,
      reason: `cgroup attach failed: ${String(error?.message ?? error)}`,
    });
  }
}

/**
 * Start a command through a tiny fixed POSIX bootstrap that joins the cgroup
 * before the command can execute. The command and every argument remain argv
 * values; no user data is interpolated into shell source. The parent still
 * performs an attach check after spawn, but the bootstrap closes the fork/exec
 * race that would otherwise let a fast child fork before the parent writes
 * cgroup.procs.
 *
 * @param {object} scope - attached cgroup description.
 * @param {string} command - command to exec.
 * @param {string[]} args - command arguments.
 * @returns {{command: string, args: string[]}} launch command.
 */
export function wrapCommandInWriterScope(scope, command, args = []) {
  if (!scope || scope.kind !== 'cgroup' || typeof scope.procs_path !== 'string') {
    return { command, args };
  }
  const bootstrap = 'scope="$1"; shift; [ "$1" = "--" ] || exit 125; shift; printf "%s\\n" "$$" > "$scope" || exit 126; exec "$@"';
  return {
    command: '/bin/sh',
    args: ['-c', bootstrap, 'af-writer-scope', scope.procs_path, '--', command, ...args],
  };
}

/**
 * Remove a scope that was created but never attached or reaped.
 * @param {object|null} scope - writer scope.
 * @returns {boolean} true when the scope directory is gone.
 */
export function discardWriterScope(scope) {
  if (!scope || scope.kind !== 'cgroup' || !scope.path) return true;
  if (!existsSync(scope.path)) return true;
  try {
    rmdirSync(scope.path);
    return true;
  } catch {
    return false;
  }
}

function cgroupEmpty(scope) {
  try {
    return readFileSync(scope.procs_path, 'utf8').trim() === '';
  } catch {
    return false;
  }
}

/**
 * Kill and verify every process in a cgroup scope, then remove the scope.
 *
 * @param {object|null} scope - attached writer scope.
 * @param {{graceMs?: number, pollMs?: number}} [options]
 * @returns {Promise<object>} scope termination evidence.
 */
export async function reapWriterScope(scope, { graceMs = 1000, pollMs = 25 } = {}) {
  if (!scope || scope.kind !== 'cgroup') {
    return Object.freeze({
      scope_verified: false,
      scope_empty: false,
      scope_kind: scope?.kind ?? 'unavailable',
      scope_id: scope?.path ?? null,
      killed: false,
      reason: scope?.reason ?? 'no cgroup writer scope',
    });
  }
  if (scope.attached !== true || scope.verified !== true) {
    discardWriterScope(scope);
    return Object.freeze({
      scope_verified: false,
      scope_empty: false,
      scope_kind: 'cgroup',
      scope_id: scope.path,
      killed: false,
      reason: scope.reason ?? 'writer scope was not attached',
    });
  }
  // A hard-killed owner may leave the durable run handle behind after the
  // graceful path already removed an empty scope. The absent directory is a
  // positive empty-scope result; there is no cgroup left to kill.
  if (!existsSync(scope.path)) {
    return Object.freeze({
      scope_verified: true,
      scope_empty: true,
      scope_kind: 'cgroup',
      scope_id: scope.path,
      killed: false,
      removed: true,
      reason: 'writer scope already absent',
    });
  }

  let killed = false;
  try {
    // cgroup.kill is atomic with respect to membership: it also reaches a
    // descendant that escaped the leader's process group after a double fork.
    writeFileSync(scope.kill_path, '1\n');
    killed = true;
  } catch (error) {
    return Object.freeze({
      scope_verified: false,
      scope_empty: false,
      scope_kind: 'cgroup',
      scope_id: scope.path,
      killed: false,
      reason: `cgroup.kill failed: ${String(error?.message ?? error)}`,
    });
  }

  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() <= deadline) {
    if (cgroupEmpty(scope)) {
      const removed = discardWriterScope(scope);
      return Object.freeze({
        scope_verified: removed,
        scope_empty: true,
        scope_kind: 'cgroup',
        scope_id: scope.path,
        killed,
        removed,
        reason: removed ? null : 'cgroup became empty but could not be removed',
      });
    }
    await new Promise((resolve) => { setTimeout(resolve, pollMs); });
  }
  return Object.freeze({
    scope_verified: false,
    scope_empty: false,
    scope_kind: 'cgroup',
    scope_id: scope.path,
    killed,
    removed: false,
    reason: 'cgroup still contains a process after cgroup.kill',
  });
}

/**
 * Reap the detached process group and return a proof only when a strong writer
 * scope also confirms that all descendants are gone. The group id is the
 * detached child PID, so this cannot target an unrelated platform process by
 * executor name. Without a cgroup or container witness, `group_gone` may be
 * true while `gone` remains false: a double-forked setsid descendant is outside
 * the process group and cannot be ruled out.
 */
export async function reapProcessGroup(pid, { graceMs = 500, pollMs = 25, scope = null } = {}) {
  const outcome = await killPidTree(pid, {
    graceMs,
    pollMs,
    isAlive: processGroupIsAlive,
    signal: signalPidTree,
  });
  const groupGone = outcome.gone === true;
  const scopeVerified = scope?.scope_verified === true || scope?.verified === true;
  return {
    ...outcome,
    group_gone: groupGone,
    scope_verified: scopeVerified,
    gone: groupGone && scopeVerified,
  };
}

/**
 * Escalating tree kill by pid: SIGTERM, bounded grace period, then SIGKILL.
 *
 * The pid-based twin of `killTree`, for callers that only kept a pid (the
 * durable run handle) rather than a ChildProcess. Unlike the previous
 * fire-and-forget escalation, this AWAITS the outcome and reports whether the
 * process is actually gone: an orphan that ignores SIGTERM must be escalated,
 * and a caller must not record "reaped" for a process that survived.
 *
 * @param {number} pid - process group leader pid.
 * @param {object} [options] - options.
 * @param {number} [options.graceMs] - grace period before SIGKILL.
 * @param {number} [options.pollMs] - liveness poll interval.
 * @param {(pid: number) => boolean} [options.isAlive] - liveness probe (injectable).
 * @param {(pid: number, signal: string) => boolean} [options.signal] - signaller (injectable).
 * @returns {Promise<{killed: boolean, escalated: boolean, gone: boolean}>} outcome.
 */
export async function killPidTree(pid, {
  graceMs = 4000,
  pollMs = 200,
  isAlive = pidIsAlive,
  signal = signalPidTree,
} = {}) {
  if (!isAlive(pid)) return { killed: false, escalated: false, gone: true };
  signal(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return { killed: true, escalated: false, gone: true };
    await new Promise((resolve) => { setTimeout(resolve, pollMs); });
  }
  if (!isAlive(pid)) return { killed: true, escalated: false, gone: true };
  signal(pid, 'SIGKILL');
  await new Promise((resolve) => { setTimeout(resolve, pollMs); });
  return { killed: true, escalated: true, gone: !isAlive(pid) };
}

/**
 * Run a short, blocking command through the same factory.
 *
 * This exists so that no other module needs to import node:child_process
 * directly (INV-6): capability probes and similar one-shot checks are
 * synchronous by nature. It is NOT for long-lived children - those must go
 * through spawnManaged so they are registered and reapable as a process tree.
 *
 * @param {string} command - executable to run.
 * @param {string[]} [args] - arguments.
 * @param {object} [options] - child_process.spawnSync options.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} spawnSync's result.
 */
export function runSyncManaged(command, args = [], options = {}) {
  return spawnSync(command, args, options);
}

/**
 * Escalating tree kill: SIGTERM, bounded grace period, then SIGKILL.
 *
 * @param {import('node:child_process').ChildProcess} child - managed child.
 * @param {object} [options] - options.
 * @param {number} [options.graceMs] - grace period before SIGKILL.
 * @param {number} [options.pollMs] - exit poll interval.
 * @returns {Promise<{killed: boolean, escalated: boolean}>} outcome.
 */
export async function killTree(child, { graceMs = 4000, pollMs = 200 } = {}) {
  if (isSettled(child)) return { killed: false, escalated: false };
  signalTree(child, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (isSettled(child)) return { killed: true, escalated: false };
    await new Promise((resolve) => { setTimeout(resolve, pollMs); });
  }
  if (isSettled(child)) return { killed: true, escalated: false };
  signalTree(child, 'SIGKILL');
  return { killed: true, escalated: true };
}

/**
 * Signal every live managed child. This is the shutdown hook: unlike the
 * executor handle registry it also covers acceptance commands, the vault MCP
 * server and the planner.
 *
 * @param {string|number} [signal] - signal name or number.
 * @returns {number} how many children were signalled.
 */
export function signalAllManaged(signal = 'SIGTERM') {
  let signalled = 0;
  for (const child of LIVE.values()) {
    if (signalTree(child, signal)) signalled += 1;
  }
  return signalled;
}

/**
 * Number of live managed children.
 * @returns {number} live count.
 */
export function liveManagedCount() {
  return LIVE.size;
}

/**
 * Hard cap on captured child output.
 *
 * The adapters and the acceptance runner both accumulate stdout/stderr into
 * plain strings. A runaway command - or a deliberately noisy one - would
 * therefore grow the control plane's heap until the OOM killer took the
 * orchestrator down: a denial of service against the thing that supervises the
 * work. 8 MiB is far above any legitimate result payload (codex `--json` emits
 * one JSON object per line; a test runner's summary is kilobytes).
 */
export const CAPTURE_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Append a chunk to a captured stream, hard-stopping at the cap.
 *
 * Returns the new string; once the cap is reached further chunks are dropped.
 * The truncation marker is embedded so an evidence record is self-describing
 * rather than silently short.
 *
 * @param {string} current - output captured so far.
 * @param {string|Buffer} chunk - new chunk.
 * @param {number} [limit] - cap in characters.
 * @returns {string} captured output, capped.
 */
export function capCapture(current, chunk, limit = CAPTURE_LIMIT_BYTES) {
  if (current.length >= limit) return current;
  const s = typeof chunk === 'string' ? chunk : String(chunk);
  const room = limit - current.length;
  if (s.length <= room) return current + s;
  return `${current}${s.slice(0, room)}\n…(output truncated at ${limit} bytes)…`;
}

export const __testing = Object.freeze({ IS_WIN });
