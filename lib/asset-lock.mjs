// asset-lock.mjs - the shared asset mutual-exclusion protocol.
//
// Every entry point that can modify a protected asset (the lifecycle's engage/disengage, manual
// recovery and, later, A1a) must take the SAME lock set, because otherwise a new task can start
// while a recovery is mid-flight. The protocol implements the frozen review constraints:
//
//   * the lock set is keyed by inode identity (dev:ino), so a symlink or bind mount that points
//     at the same asset collapses to one lock, and the set includes every protected path - not
//     just canonical_dir;
//   * a LIVE holder is never preempted, however long the lock has been held: liveness means the
//     same boot id, the recorded pid still alive and its start ticks unchanged (guards PID reuse);
//   * an UNVERIFIABLE holder (unreadable or corrupt lock, different boot, unknown pid) is a
//     refusal, never a guess;
//   * a DEAD holder is also not stolen: the caller is told to reconcile the unfinished recovery
//     first (`dead-holder-needs-reconciliation`), which is what H1 requires;
//   * acquisition is ordered by digest so two processes cannot deadlock, and in-process
//     reentrancy lets nested calls pass through while only the outermost releases.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const ASSET_LOCK_SCHEMA = 'af-asset-lock-v1';

/** Lock files live beside the runtime state; tests point this at a temp directory. */
export function assetLockDir(env = process.env, cwd = process.cwd()) {
  return env.AF_ASSET_LOCK_DIR || join(env.AF_RUNTIME_DIR || join(cwd, 'runtime'), 'asset-locks');
}

/** Best-effort realpath: a path that does not exist yet is canonicalised textually. */
function canonical(target) {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Path-aware containment: equal paths, or one an ancestor of the other.
 * A bare string prefix is NOT enough (`/asset-evil` must not overlap `/asset`).
 */
export function pathsOverlap(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = canonical(left).replace(/\/+$/, '') || '/';
  const b = canonical(right).replace(/\/+$/, '') || '/';
  if (a === b) return true;
  const contains = (parent, child) => {
    const rel = relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  return contains(a, b) || contains(b, a);
}

/** Every lock file currently on disk, read strictly (unreadable records are reported). */
export function listAssetLocks(dir = null) {
  const root = dir || assetLockDir();
  let names;
  try {
    names = readdirSync(root).filter((name) => name.startsWith('asset-') && name.endsWith('.lock'));
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, locks: [], missing: true };
    return { ok: false, locks: [], reason: `lock directory unreadable: ${err.message}` };
  }
  const locks = [];
  for (const name of names.sort()) {
    const lockPath = join(root, name);
    const read = readLock(lockPath);
    if (!read.ok) return { ok: false, locks, reason: `lock ${name} unreadable: ${read.reason}` };
    if (read.missing) continue;
    locks.push({ lock_file: lockPath, name, holder: read.holder, classification: classifyHolder(read.holder) });
  }
  return { ok: true, locks };
}

/**
 * Inode identity for one path. `dev:ino` is what makes aliases collapse; a path that cannot be
 * inspected is represented by its canonical path so it can still be locked (and is reported).
 */
export function assetIdentity(target) {
  const path = canonical(target);
  try {
    const stat = statSync(path);
    return { path, identity: `${stat.dev}:${stat.ino}`, kind: stat.isDirectory() ? 'dir' : 'file' };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { path, identity: `path:${path}`, kind: 'absent' };
    return { path, identity: `unverifiable:${path}`, kind: 'unverifiable' };
  }
}

/**
 * Resolve the lock set for an asset: canonical, cas and every protected path, deduplicated by
 * inode identity and sorted by digest so acquisition order is deterministic.
 */
export function resolveAssetLockSet({ canonicalDir = null, casDir = null, protectedPaths = [] } = {}) {
  const entries = [];
  const seen = new Set();
  for (const target of [canonicalDir, casDir, ...protectedPaths].filter(Boolean)) {
    const resolved = assetIdentity(target);
    if (seen.has(resolved.identity)) continue;
    seen.add(resolved.identity);
    entries.push({ ...resolved, digest: createHash('sha256').update(resolved.identity).digest('hex').slice(0, 16) });
  }
  return entries.sort((left, right) => left.digest.localeCompare(right.digest));
}

function bootId() {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return null;
  }
}

function pidStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // field 22 (starttime) - the comm field can contain spaces, so parse after the last ')'
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return after[19] ?? null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Classify the current holder of a lock.
 *
 * @returns {{ state: 'live'|'dead'|'unverifiable', reason: string, holder: object|null }}
 */
export function classifyHolder(holder, { now = Date.now() } = {}) {
  if (!holder || typeof holder !== 'object') return { state: 'unverifiable', reason: 'lock has no readable owner record', holder: holder ?? null };
  const currentBoot = bootId();
  if (!currentBoot || !holder.boot_id) return { state: 'unverifiable', reason: 'the boot id cannot be compared (missing /proc or record)', holder };
  if (holder.boot_id !== currentBoot) return { state: 'unverifiable', reason: 'the holder belongs to a different boot; ownership cannot be confirmed', holder };
  if (!Number.isInteger(holder.pid)) return { state: 'unverifiable', reason: 'the holder record has no usable pid', holder };
  if (!pidAlive(holder.pid)) return { state: 'dead', reason: 'the recorded holder process is gone', holder };
  const ticks = pidStartTicks(holder.pid);
  if (ticks === null) return { state: 'unverifiable', reason: 'the holder process could not be inspected', holder };
  // Identity must be PROVEN: a record without start ticks cannot be confirmed as this process,
  // so it is unverifiable rather than assumed live.
  if (!holder.pid_start_ticks) return { state: 'unverifiable', reason: 'the holder record carries no pid start ticks, so its identity cannot be confirmed', holder };
  if (holder.pid_start_ticks !== ticks) {
    // The pid exists but is a different process: treat as dead, never as ours.
    return { state: 'dead', reason: 'the pid was reused by another process', holder };
  }
  void now; // age is deliberately NOT part of liveness: no TTL preemption, ever.
  return { state: 'live', reason: `held by live pid ${holder.pid}`, holder };
}

function readLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    return { ok: true, raw, holder: JSON.parse(raw) };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, raw: null, holder: null, missing: true };
    return { ok: false, raw: null, holder: null, reason: `lock file unreadable: ${err.message}` };
  }
}

function lockPathFor(entry, dir) {
  return join(dir, `asset-${entry.digest}.lock`);
}

const heldByThisProcess = new Map(); // digest -> { token, depth }

/** Inspect the lock set for an asset without taking anything (read-only). */
export function assetLockStatus({ canonicalDir = null, casDir = null, protectedPaths = [], dir = null } = {}) {
  const root = dir || assetLockDir();
  return resolveAssetLockSet({ canonicalDir, casDir, protectedPaths }).map((entry) => {
    const lockPath = lockPathFor(entry, root);
    const read = readLock(lockPath);
    if (read.missing) return { ...entry, lock_file: lockPath, held: false, state: 'free' };
    if (!read.ok) return { ...entry, lock_file: lockPath, held: true, state: 'unverifiable', reason: read.reason };
    const classification = classifyHolder(read.holder);
    return { ...entry, lock_file: lockPath, held: true, state: classification.state, reason: classification.reason, holder: read.holder };
  });
}

/**
 * Run `fn` while holding the asset lock set.
 *
 * @returns {{ ok: boolean, value?: any, reason?: string, holder?: object, acquired?: object[] }}
 */
export function withAssetLockSet({ canonicalDir = null, casDir = null, protectedPaths = [], dir = null, phase = 'unknown', holder = null } = {}, fn) {
  const root = dir || assetLockDir();
  const entries = resolveAssetLockSet({ canonicalDir, casDir, protectedPaths });
  if (entries.length === 0) return { ok: false, reason: 'no asset paths were provided' };

  // The lock set is inode-keyed, which covers the SAME path and its aliases - but not an ancestor
  // or a descendant: `/asset` and `/asset/child` are different inodes while protecting one
  // protects the other. So acquisition also refuses when any held lock's path contains (or is
  // contained by) one of ours, unless that lock is ours (reentrancy).
  const existing = listAssetLocks(root);
  if (!existing.ok) return { ok: false, reason: `holder-unverifiable: ${existing.reason}` };
  for (const lock of existing.locks) {
    const heldPath = lock.holder?.path;
    if (!heldPath) continue;
    // Reentrancy applies ONLY to the same lock (same digest). An overlapping lock we happen to
    // hold ourselves - a parent while we contend for its child, or the reverse - is still a
    // conflict: protecting one modifies the other.
    const ours = entries.some((entry) => entry.digest === lock.holder?.digest)
      && heldByThisProcess.get(lock.holder?.digest)?.token === lock.holder?.token;
    if (ours) continue;
    const overlap = entries.find((entry) => pathsOverlap(entry.path, heldPath));
    if (!overlap) continue;
    const state = lock.classification.state;
    const detail = `${overlap.path} overlaps the held path ${heldPath} (${lock.classification.reason})`;
    if (state === 'live') return { ok: false, reason: `asset-overlap-held-by-live-owner: ${detail}`, holder: lock.holder };
    if (state === 'unverifiable') return { ok: false, reason: `asset-overlap-holder-unverifiable: ${detail}`, holder: lock.holder };
    return { ok: false, reason: `asset-overlap-dead-holder-needs-reconciliation: ${detail}`, holder: lock.holder };
  }

  const acquired = [];
  const acquiredOwn = [];
  // Unwind EVERYTHING acquired so far, including reentrant depth increments: leaving a depth
  // behind would make a later call believe it already holds a lock that no longer exists.
  const unwind = () => {
    for (const entry of [...acquired].reverse()) {
      const held = heldByThisProcess.get(entry.digest);
      if (!held) continue;
      held.depth -= 1;
      if (held.depth > 0) continue;
      heldByThisProcess.delete(entry.digest);
      releaseOwned(held.lockPath, held.token);
    }
    acquired.length = 0;
    acquiredOwn.length = 0;
  };

  for (const entry of entries) {
    // In-process reentrancy: a nested call for a lock we already hold passes through - but only
    // while we VERIFIABLY still hold it. A vanished file (inode reuse after a temp dir was
    // deleted, an external cleanup, a crashed unwind) drops the stale entry so the call takes a
    // real lock instead of proceeding unprotected.
    const held = heldByThisProcess.get(entry.digest);
    if (held && stillOwned(held)) {
      held.depth += 1;
      acquired.push(entry);
      continue;
    }
    if (held) heldByThisProcess.delete(entry.digest);
    mkdirSync(root, { recursive: true });
    const lockPath = lockPathFor(entry, root);
    const token = randomUUID();
    const record = {
      schema_version: ASSET_LOCK_SCHEMA,
      digest: entry.digest,
      identity: entry.identity,
      path: entry.path,
      pid: process.pid,
      pid_start_ticks: pidStartTicks(process.pid),
      boot_id: bootId(),
      token,
      acquired_at: new Date().toISOString(),
      phase,
      holder,
    };
    let fd = null;
    let created = false;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, `${JSON.stringify(record)}\n`);
      created = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        unwind();
        return { ok: false, reason: `could not create the asset lock: ${err.message}` };
      }
      // Somebody holds it: classify the holder and refuse without ever taking it over.
      const read = readLock(lockPath);
      unwind();
      if (!read.ok) return { ok: false, reason: `holder-unverifiable: ${read.reason}`, holder: null };
      const classification = classifyHolder(read.holder);
      if (classification.state === 'live') return { ok: false, reason: `held-by-live-owner: ${classification.reason}`, holder: classification.holder };
      if (classification.state === 'unverifiable') return { ok: false, reason: `holder-unverifiable: ${classification.reason}`, holder: classification.holder };
      return { ok: false, reason: `dead-holder-needs-reconciliation: ${classification.reason}`, holder: classification.holder };
    } finally {
      if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    }
    if (created) {
      heldByThisProcess.set(entry.digest, { token, depth: 1, lockPath });
      acquired.push(entry);
      acquiredOwn.push({ entry, lockPath, token });
    }
  }

  const acquiredSummary = acquired.map((entry) => ({ digest: entry.digest, identity: entry.identity, path: entry.path }));
  // An async callback must keep the lock until it SETTLES: releasing when the promise is merely
  // returned would let a second process in while the first is still mid-operation.
  const settle = () => {
    for (const entry of [...acquired].reverse()) {
      const held = heldByThisProcess.get(entry.digest);
      if (!held) continue;
      held.depth -= 1;
      if (held.depth > 0) continue;
      heldByThisProcess.delete(entry.digest);
      releaseOwned(held.lockPath, held.token);
    }
  };

  let value;
  try {
    value = fn();
  } catch (err) {
    settle();
    throw err;
  }
  if (value && typeof value.then === 'function') {
    return value.then(
      (resolved) => { settle(); return { ok: true, value: resolved, acquired: acquiredSummary }; },
      (err) => { settle(); throw err; },
    );
  }
  settle();
  return { ok: true, value, acquired: acquiredSummary };
}

/** Release only locks this process acquired, and only while we still own them. */
function releaseAll(owned) {
  for (const { lockPath, token } of owned) {
    releaseOwned(lockPath, token);
  }
}

/** True only while our own lock file is still on disk and still ours. */
function stillOwned(held) {
  try {
    return JSON.parse(readFileSync(held.lockPath, 'utf8'))?.token === held.token;
  } catch {
    return false;
  }
}

function releaseOwned(lockPath, token) {
  try {
    const current = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (current?.token !== token) return; // somebody else owns it now: leave it alone
    rmSync(lockPath, { force: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') return; // best effort; an unreadable lock is left for a human
  }
}

/** Count lock files, for tests and for operators. */
export function countAssetLocks(dir = null) {
  const root = dir || assetLockDir();
  if (!existsSync(root)) return 0;
  try {
    return readdirSync(root).filter((name) => name.startsWith('asset-') && name.endsWith('.lock')).length;
  } catch {
    return -1;
  }
}

/** Whether a path is a symlink whose target is outside the given root (used by callers). */
export function isEscapingSymlink(target, root) {
  try {
    if (!lstatSync(target).isSymbolicLink()) return false;
    const resolved = realpathSync(target);
    const resolvedRoot = canonical(root);
    return !(resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}/`));
  } catch {
    return false;
  }
}
