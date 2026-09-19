// resource-limits.mjs - bound what an executor or acceptance child may consume.
//
// "Bounded execution" was already half-implemented in this codebase:
//
//   time        -> task.timeout_ms, executor idle timeout           (covered)
//   concurrency -> max_parallel / min_interval_ms in the profiles   (covered)
//   process tree-> whole-group reaping via child-process.mjs        (covered)
//   disk / CPU  -> nothing                                          (gap)
//   memory      -> nothing                                          (gap)
//
// So a runaway - or deliberately hostile - child could fill the filesystem or
// spin a core until a human noticed. This module closes the affordable part of
// that gap, and reports honestly about the part it cannot close here.
//
// Mechanism 1 (used): POSIX rlimits through a `bash -c` shim that ends in
// `exec "$@"`, so the real process keeps the wrapper's pid (a tree kill by pid
// therefore still works) and NO user data is ever interpolated into the shell
// script - the command and its arguments travel as argv.
//
// Mechanism 2 (reported here, used for writer scoping in child-process.mjs):
// cgroup v2 memory.max / pids.max / cpu.max plus cgroup.kill. That is the only
// correct way to cap MEMORY, because resource limits are not namespaced per
// process. Resource-limit enforcement still needs a delegated, writable
// subtree; the child-process module uses the same capability boundary to scope
// and reap V2 writers, and this module reports whether resource controllers are
// available.
//
// Deliberately NOT used: RLIMIT_AS (`ulimit -v`). V8 and the JVM reserve large
// virtual address ranges up front, so a virtual-memory cap breaks real
// executors (they fail to start) while barely constraining a runaway. A cap
// that only breaks legitimate work is worse than no cap.
//
// @module resource-limits

import { createWriterScope, discardWriterScope, runSyncManaged } from './child-process.mjs';
import { readFileSync } from 'node:fs';

/** 512-byte blocks, which is the unit `ulimit -f` uses. */
const BLOCKS_PER_MB = 2048;

const DEFAULTS = Object.freeze({
  cpuSeconds: 3600,      // wall-independent CPU time; far above any real run
  fileSizeMb: 2048,      // single-file write cap, so a runaway cannot fill the disk
  coreDumpKb: 0,         // no core dumps: a crash must not write a huge file
  maxProcesses: 0,       // off by default; per-UID and shared, so opt in deliberately
});

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve the limits to apply.
 *
 * `AF_LIMIT_DISABLED=1` turns them off entirely (for a deployment that manages
 * limits outside the orchestrator).
 *
 * @returns {{enabled: boolean, cpuSeconds: number, fileSizeMb: number, coreDumpKb: number, maxProcesses: number}}
 */
export function resolveResourceLimits() {
  const disabled = process.env.AF_LIMIT_DISABLED === '1';
  const limits = {
    cpuSeconds: envNumber('AF_LIMIT_CPU_SECONDS', DEFAULTS.cpuSeconds),
    fileSizeMb: envNumber('AF_LIMIT_FILE_MB', DEFAULTS.fileSizeMb),
    coreDumpKb: envNumber('AF_LIMIT_CORE_KB', DEFAULTS.coreDumpKb),
    maxProcesses: envNumber('AF_LIMIT_MAX_PROCESSES', DEFAULTS.maxProcesses),
  };
  const anyLimit = limits.cpuSeconds > 0 || limits.fileSizeMb > 0 || limits.maxProcesses > 0 || limits.coreDumpKb >= 0;
  return { enabled: !disabled && anyLimit, ...limits };
}

let posixSupport = null;

/**
 * Whether this host can apply POSIX rlimits through the shim. Probed once with
 * a trivial invocation so the answer reflects the real shell, not an assumption.
 *
 * @returns {boolean} true when the shim is usable.
 */
export function posixRlimitsSupported() {
  if (posixSupport !== null) return posixSupport;
  if (process.platform === 'win32') {
    posixSupport = false;
    return posixSupport;
  }
  try {
    const probe = runSyncManaged('bash', ['-c', 'ulimit -t 1 -f 1024 -c 0'], { stdio: 'ignore' });
    posixSupport = probe.status === 0;
  } catch {
    posixSupport = false;
  }
  return posixSupport;
}

/**
 * cgroup v2 capability report. Memory and process-count limits require a
 * delegated, writable subtree; without it they are simply unavailable.
 *
 * @returns {{available: boolean, version: string|null, base: string, reason: string|null}}
 */
export function describeCgroupCapability() {
  const base = process.env.AF_CGROUP_BASE || '/sys/fs/cgroup';
  const result = { available: false, version: null, base, reason: null };
  let controllers;
  try {
    controllers = readFileIfExists(`${base}/cgroup.controllers`);
  } catch (err) {
    // Do NOT collapse this into "not mounted": a permission error or a bug must
    // be distinguishable from an absent cgroup filesystem, because the two lead
    // an operator to completely different conclusions.
    result.reason = `cgroup probe failed: ${String(err?.message ?? err)}`;
    return result;
  }
  if (controllers === null) {
    result.reason = 'cgroup v2 not mounted (no cgroup.controllers)';
    return result;
  }
  result.version = 'v2';
  const scope = createWriterScope();
  if (scope.kind === 'cgroup') {
    result.available = true;
    result.reason = null;
    discardWriterScope(scope);
  } else {
    result.reason = scope.reason || 'no delegated writable cgroup subtree; memory/pids limits need cgroup v2 delegation (AF_CGROUP_BASE)';
  }
  return result;
}

/**
 * Read a probe file. Returns null ONLY when the file is genuinely absent, so a
 * programming error cannot masquerade as "the feature is not available here"
 * (that mistake silently disabled the cgroup probe once already).
 */
function readFileIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Human-readable capability summary, for startup diagnostics and tests.
 * @returns {object} capability report.
 */
export function describeResourceLimitCapabilities() {
  const limits = resolveResourceLimits();
  const posix = posixRlimitsSupported();
  const cgroup = describeCgroupCapability();
  return {
    limits,
    mechanism: limits.enabled && posix ? 'posix-rlimits' : 'none',
    covers: {
      cpu: posix && limits.cpuSeconds > 0,
      disk: posix && limits.fileSizeMb > 0,
      coreDumps: posix,
      processes: posix && limits.maxProcesses > 0,
      memory: cgroup.available,
    },
    cgroup,
  };
}

/** The shim script. Numbers only - no user data is ever interpolated. */
function shimScript(limits) {
  const parts = [];
  if (limits.cpuSeconds > 0) parts.push(`-t ${Math.floor(limits.cpuSeconds)}`);
  if (limits.fileSizeMb > 0) parts.push(`-f ${Math.floor(limits.fileSizeMb) * BLOCKS_PER_MB}`);
  if (limits.coreDumpKb >= 0) parts.push(`-c ${Math.floor(limits.coreDumpKb)}`);
  if (limits.maxProcesses > 0) parts.push(`-u ${Math.floor(limits.maxProcesses)}`);
  // `exec "$@"` replaces the shell, so the child keeps this pid and the existing
  // pid-based tree kill keeps working.
  return `ulimit ${parts.join(' ')} 2>/dev/null || true; exec "$@"`;
}

/**
 * Wrap a command so its child is resource-bounded.
 *
 * Returns the original command untouched when limits are disabled or the host
 * cannot apply them - the caller keeps working either way, and the returned
 * `applied` field says what actually happened.
 *
 * @param {string} command - executable to run.
 * @param {string[]} args - its arguments.
 * @param {object} [options] - options.
 * @param {object} [options.limits] - resolved limits (defaults to resolveResourceLimits()).
 * @returns {{command: string, args: string[], applied: object, mechanism: string}}
 */
export function applyResourceLimits(command, args = [], { limits = resolveResourceLimits() } = {}) {
  const base = {
    applied: {
      cpuSeconds: 0, fileSizeMb: 0, maxProcesses: 0, coreDumpKb: 0, memoryMb: null,
    },
    mechanism: 'none',
  };
  if (!limits.enabled || !posixRlimitsSupported()) {
    return { command, args, ...base };
  }
  return {
    command: 'bash',
    args: ['-c', shimScript(limits), 'af-limited', command, ...args],
    applied: {
      cpuSeconds: limits.cpuSeconds,
      fileSizeMb: limits.fileSizeMb,
      maxProcesses: limits.maxProcesses,
      coreDumpKb: limits.coreDumpKb,
      memoryMb: null, // requires cgroup v2 delegation
    },
    mechanism: 'posix-rlimits',
  };
}
