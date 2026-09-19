// orphan-reaper.mjs - clean up children that survived a HARD kill of the control plane
//
// The graceful path is covered: SIGTERM/SIGINT run signalAllManaged() plus the
// executor handle sweep. A SIGKILL is not covered and cannot be - the process
// gets no chance to run anything. It leaves two kinds of debris, both measured:
//
//   1. Managed children. Every child is spawned `detached` so a tree kill can
//      reach its descendants (lib/child-process.mjs), which also means the child
//      no longer dies with its parent. Measured: killing the parent with SIGKILL
//      leaves the child alive.
//   2. Sandbox containers. `docker run` does not stop its container when the
//      client dies. Measured: after SIGKILLing the client the container is still
//      `running`.
//
// Why that matters beyond tidiness: recovery re-dispatches a task whose owner is
// gone, so an orphaned executor keeps editing the same workspace and spending the
// same API budget WHILE a fresh run for that task starts.
//
// Both facts are recoverable from durable state, so this module reaps them:
//
//   - a sandbox container is named `af-sbx-<ownerpid>-<uuid>` (lib/sandbox.mjs),
//     so the owning pid is in the name
//   - an executor run handle records the pid; after this change it also records
//     the owner pid, the child's process group, and (when available) its
//     delegated writer cgroup
//
// Safety rules, because killing the wrong process is worse than leaving debris:
//
//   - a container is removed only when its owner pid is dead (a live sibling
//     instance's container is left alone)
//   - a process is signalled only when the owner is dead AND its process group
//     still matches the recorded one. Two independent checks make a PID-reuse
//     accident far less likely than a pid comparison alone
//   - a durable writer cgroup is accepted only when its path and owner binding
//     match the handle that created it; otherwise it is reported unverifiable
//   - a handle with no owner/fingerprint (written before this change) is reported
//     as unverifiable and NEVER signalled
//
// @module orphan-reaper

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSyncManaged, killPidTree, pidIsAlive, reapWriterScope } from './child-process.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the executor run handles live (the only durable record of a child pid). */
export const DEFAULT_RUNS_DIR = process.env.AF_RUNS_DIR || join(ROOT_DIR, 'runtime', 'runs');

/** Sandbox container names embed the owning pid: af-sbx-<pid>-<uuid>. */
const SANDBOX_NAME_RE = /^af-sbx-(\d+)-/;

function durableWriterScopeIsTrusted(scope, ownerPid) {
  if (!scope || scope.kind !== 'cgroup' || typeof scope.path !== 'string' || scope.path.length === 0) return false;
  if (typeof ownerPid !== 'number' || scope.owner_pid !== ownerPid) return false;
  const base = process.env.AF_CGROUP_BASE || '/sys/fs/cgroup';
  const name = basename(scope.path);
  if (!new RegExp(`^af-writer-${ownerPid}-[A-Za-z0-9-]+$`).test(name)) return false;
  return resolve(dirname(scope.path)) === resolve(base);
}

/**
 * Whether a pid currently exists.
 *
 * Kept as a named export (tests import it) but implemented once, in
 * lib/child-process.mjs, so the liveness rule cannot drift between the reaper
 * and the killer.
 */
export const pidAlive = pidIsAlive;

/**
 * The process group of a live process, read from /proc.
 *
 * Returns null when it cannot be determined (not Linux, no permission, gone).
 * Callers must treat null as "unverifiable" and refrain from signalling.
 *
 * @param {number} pid - process id.
 * @param {string} [procRoot] - /proc override for tests.
 * @returns {number|null} the process group id, or null.
 */
export function processGroupOf(pid, procRoot = '/proc') {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    // "pid (comm) state ppid pgrp ..." - comm may contain spaces and parens, so
    // split after the LAST ')'.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const pgrp = Number(afterComm[2]);
    return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : null;
  } catch {
    return null;
  }
}

/**
 * Remove sandbox containers whose owning process is gone.
 *
 * @param {object} [options] - options.
 * @param {boolean} [options.apply] - false lists candidates without removing.
 * @returns {{inspected: number, orphans: object[], reaped: string[], skipped: object[], reason: string|null}}
 */
export function reapOrphanSandboxes({ apply = true } = {}) {
  const listed = runSyncManaged('docker', ['ps', '-a', '--filter', 'name=af-sbx-', '--format', '{{.Names}}'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (listed.error || listed.status !== 0) {
    return {
      inspected: 0,
      orphans: [],
      reaped: [],
      skipped: [],
      reason: `docker unavailable: ${listed.error?.message ?? (String(listed.stderr ?? '').trim() || `exit ${listed.status}`)}`,
    };
  }

  const names = String(listed.stdout ?? '').split('\n').map((n) => n.trim()).filter(Boolean);
  const orphans = [];
  const skipped = [];
  const reaped = [];

  for (const name of names) {
    const match = SANDBOX_NAME_RE.exec(name);
    if (!match) {
      skipped.push({ name, reason: 'name does not embed an owner pid' });
      continue;
    }
    const ownerPid = Number(match[1]);
    if (pidAlive(ownerPid)) {
      skipped.push({ name, ownerPid, reason: 'owner is alive' });
      continue;
    }
    orphans.push({ name, ownerPid });
    if (!apply) continue;
    const removed = runSyncManaged('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 20_000 });
    if (!removed.error) reaped.push(name);
  }

  return { inspected: names.length, orphans, reaped, skipped, reason: null };
}

/**
 * Reap executor processes whose owning orchestrator is gone.
 *
 * Asynchronous because reaping must OBSERVE the result: SIGTERM, a bounded
 * grace period, then SIGKILL, and a handle is only removed once the process is
 * confirmed gone. The previous fire-and-forget escalation ran on an unref'd
 * timer that `af-admin` never waited for, so an orphan that ignored SIGTERM was
 * reported killed and its handle deleted - losing the only record of debris
 * that was still running.
 *
 * @param {object} [options] - options.
 * @param {string} [options.runsDir] - directory of run handle files.
 * @param {boolean} [options.apply] - false reports without signalling.
 * @param {(pid: number) => boolean} [options.isAlive] - liveness probe (injectable).
 * @param {(pid: number) => number|null} [options.pgidOf] - process-group probe (injectable).
 * @param {number} [options.graceMs] - grace period before SIGKILL.
 * @param {(pid: number) => Promise<{gone: boolean, escalated?: boolean}>} [options.kill] - killer (injectable).
 * @param {(scope: object, options: object) => Promise<{scope_verified: boolean}>} [options.scopeReap] - cgroup reaper (injectable).
 * @returns {Promise<{inspected: number, orphans: object[], killed: object[], survived: object[], staleHandles: string[], unverifiable: object[]}>}
 */
export async function reapOrphanRuns({
  runsDir = DEFAULT_RUNS_DIR,
  apply = true,
  isAlive = pidAlive,
  pgidOf = processGroupOf,
  graceMs = 4000,
  kill = (pid) => killPidTree(pid, { graceMs, isAlive }),
  scopeReap = (scope, options) => reapWriterScope(scope, options),
} = {}) {
  const result = { inspected: 0, orphans: [], killed: [], survived: [], staleHandles: [], unverifiable: [] };
  if (!runsDir || !existsSync(runsDir)) return result;

  let entries = [];
  try {
    entries = readdirSync(runsDir).filter((name) => name.endsWith('.json'));
  } catch {
    return result;
  }

  for (const entry of entries) {
    const path = join(runsDir, entry);
    let handle = null;
    try {
      handle = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      result.unverifiable.push({ handle: entry, reason: 'unreadable handle' });
      continue;
    }
    result.inspected += 1;

    const pid = handle?.pid;
    const ownerPid = handle?.owner_pid;
    const rawWriterScope = handle?.writer_scope;
    const hasMalformedWriterScope = rawWriterScope?.kind === 'cgroup'
      && !durableWriterScopeIsTrusted(rawWriterScope, ownerPid);
    const writerScope = hasMalformedWriterScope
      ? null
      : (rawWriterScope?.kind === 'cgroup'
        ? {
          ...rawWriterScope,
          procs_path: rawWriterScope.procs_path || join(rawWriterScope.path, 'cgroup.procs'),
          kill_path: rawWriterScope.kill_path || join(rawWriterScope.path, 'cgroup.kill'),
          attached: rawWriterScope.attached !== false,
          verified: rawWriterScope.verified !== false,
        }
        : null);
    if (hasMalformedWriterScope) {
      result.unverifiable.push({ handle: entry, pid, reason: 'malformed durable writer scope; refusing to signal' });
      continue;
    }
    if (!isAlive(pid)) {
      if (writerScope && typeof ownerPid === 'number' && isAlive(ownerPid)) {
        // The leader can exit before an in-process owner finishes its scope
        // cleanup. Never let the cross-process reaper kill a live instance's
        // descendants.
        continue;
      }
      if (writerScope && typeof ownerPid !== 'number') {
        result.unverifiable.push({ handle: entry, pid, reason: 'writer scope has no verifiable owner pid' });
        continue;
      }
      // A dry-run is observational. In particular, do not call the injected
      // or default scope reaper here: the default implementation writes
      // cgroup.kill and would mutate the host even though apply=false.
      if (!apply) {
        result.staleHandles.push(entry);
        continue;
      }
      if (writerScope) {
        let scopeOutcome;
        try {
          scopeOutcome = await scopeReap(writerScope, { graceMs, pollMs: 25 });
        } catch (error) {
          scopeOutcome = { scope_verified: false, reason: String(error?.message ?? error) };
        }
        if (scopeOutcome?.scope_verified !== true) {
          result.unverifiable.push({
            handle: entry,
            pid,
            reason: `writer scope could not be verified after the leader exited: ${scopeOutcome?.reason ?? 'unknown error'}`,
          });
          continue;
        }
      }
      // The process is already gone; the handle is simply stale.
      result.staleHandles.push(entry);
      if (apply) { try { unlinkSync(path); } catch { /* raced */ } }
      continue;
    }

    if (typeof ownerPid !== 'number') {
      result.unverifiable.push({ handle: entry, pid, reason: 'handle has no owner_pid (written before this check existed)' });
      continue;
    }
    if (isAlive(ownerPid)) {
      // A live instance still owns it.
      continue;
    }
    const recordedPgid = handle?.pgid;
    const actualPgid = pgidOf(pid);
    if (actualPgid === null || typeof recordedPgid !== 'number' || actualPgid !== recordedPgid) {
      result.unverifiable.push({
        handle: entry,
        pid,
        reason: `process group does not match the recorded one (recorded ${recordedPgid}, actual ${actualPgid}); refusing to signal`,
      });
      continue;
    }

    result.orphans.push({ handle: entry, pid, pgid: actualPgid, taskId: handle?.task_id ?? null });
    if (!apply) continue;

    let scopeOutcome = null;
    if (writerScope) {
      try {
        scopeOutcome = await scopeReap(writerScope, { graceMs, pollMs: 25 });
      } catch (error) {
        scopeOutcome = { scope_verified: false, reason: String(error?.message ?? error) };
      }
    }
    const outcome = await kill(pid);
    if (!outcome.gone || (writerScope && scopeOutcome?.scope_verified !== true)) {
      // The signal(s) did not take it down. Keeping the handle is the whole
      // point: it is the only durable record that this orphan exists, and
      // deleting it here would make the debris invisible to the next sweep.
      result.survived.push({
        handle: entry,
        pid,
        reason: writerScope && scopeOutcome?.scope_verified !== true
          ? `writer scope was not verified: ${scopeOutcome?.reason ?? 'unknown error'}`
          : 'still alive after SIGKILL; the handle is kept so the orphan is not lost',
      });
      continue;
    }
    result.killed.push({
      handle: entry,
      pid,
      escalated: outcome.escalated === true,
      scope_verified: writerScope ? scopeOutcome.scope_verified === true : null,
    });
    try { unlinkSync(path); } catch { /* raced */ }
  }

  return result;
}

/**
 * Reap everything a hard kill may have left behind.
 *
 * @param {object} options - options.
 * @param {string} options.runsDir - run handle directory.
 * @param {boolean} [options.apply] - false reports without acting.
 * @returns {Promise<{sandboxes: object, runs: object}>} combined evidence.
 */
export async function reapOrphans({ runsDir = DEFAULT_RUNS_DIR, apply = true } = {}) {
  return {
    sandboxes: reapOrphanSandboxes({ apply }),
    runs: await reapOrphanRuns({ runsDir, apply }),
  };
}

/**
 * Render a reclaim result for the operator CLI.
 * @param {object} result - a reapOrphans result.
 * @param {boolean} apply - whether the run acted.
 * @returns {string} human-readable report.
 */
export function formatReclaimResult(result, apply) {
  const sandboxes = result?.sandboxes ?? {};
  const runs = result?.runs ?? {};
  const lines = [
    `orphan reclaim (${apply ? 'APPLIED' : 'DRY-RUN'})`,
    `  sandbox containers: inspected ${sandboxes.inspected ?? 0}, orphaned ${(sandboxes.orphans ?? []).length}, removed ${(sandboxes.reaped ?? []).length}`,
    `  executor runs:      inspected ${runs.inspected ?? 0}, orphaned ${(runs.orphans ?? []).length}, signalled ${(runs.killed ?? []).length}, survived ${(runs.survived ?? []).length}, stale handles cleared ${(runs.staleHandles ?? []).length}, unverifiable ${(runs.unverifiable ?? []).length}`,
  ];
  if (sandboxes.reason) lines.push(`  sandbox note: ${sandboxes.reason}`);
  for (const item of sandboxes.orphans ?? []) lines.push(`  orphan container ${item.name} (owner pid ${item.ownerPid} is gone)`);
  for (const item of runs.orphans ?? []) lines.push(`  orphan run ${item.handle} pid ${item.pid} (task ${item.taskId ?? '?'})`);
  for (const item of runs.killed ?? []) lines.push(`  reaped ${item.handle} pid ${item.pid}${item.escalated ? ' (required SIGKILL)' : ''}`);
  for (const item of runs.survived ?? []) lines.push(`  SURVIVED ${item.handle} pid ${item.pid}: ${item.reason}`);
  for (const item of runs.unverifiable ?? []) lines.push(`  REFUSED ${item.handle}: ${item.reason}`);
  if (!apply) lines.push('  To execute, run: af-admin reclaim orphans --confirm');
  return lines.join('\n');
}
