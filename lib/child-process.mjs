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
