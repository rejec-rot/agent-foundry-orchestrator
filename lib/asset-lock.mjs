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

import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const ASSET_LOCK_SCHEMA = 'af-asset-lock-v1';
export const ASSET_REGISTRY_SCHEMA = 'af-asset-registry-lock-v1';

/**
 * Reentrancy is bound to an OPERATION CONTEXT, never to the process: two independent calls in one
 * process (e.g. two async lifecycles) must be mutually exclusive, while a genuinely nested call
 * made from inside the holder's own callback may pass through. AsyncLocalStorage gives us exactly
 * that boundary and propagates across awaits.
 */
const lockContext = new AsyncLocalStorage();

/**
 * Publish a lock file atomically WITH its content.
 *
 * `open(..., 'wx')` followed by a write leaves a window in which a contender reads an empty file
 * and cannot tell "being created" from "corrupt". Writing the record to a temporary file and
 * `link()`ing it into place makes the visible lock always complete, and `link` still fails with
 * EEXIST when somebody else owns it.
 *
 * @returns {true} when the lock was published, {false} when it is already held.
 */
function publishLock(lockPath, record) {
  const tmp = `${lockPath}.${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/** Bounded synchronous sleep for the short registry critical section. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
function registryLockPath(dir) {
  return join(dir, 'registry.lock');
}

/**
 * Run a short critical section under the shared REGISTRY mutex.
 *
 * The mutex is what makes "scan for overlaps + register the whole lock set" atomic: without it two
 * processes can both observe no conflict and then take a parent lock and a child lock at the same
 * time. It is held only for the short, synchronous bookkeeping, never across the caller's work.
 *
 * Takeover: a PROVABLY dead holder may be reclaimed (a permanently stuck registry would block
 * every recovery); a holder whose identity cannot be confirmed is a refusal, never a guess.
 */
function withRegistryMutex(dir, fn, { timeoutMs = 5000, sleep = sleepSync } = {}) {
  const store = lockContext.getStore();
  if (store?.registryHeld) return fn(); // nested: the outermost holder owns the registry
  mkdirSync(dir, { recursive: true });
  const lockPath = registryLockPath(dir);
  const deadline = Date.now() + timeoutMs;
  let token = null;
  for (;;) {
    const candidate = randomUUID();
    const published = publishLock(lockPath, {
      schema_version: ASSET_REGISTRY_SCHEMA,
      token: candidate,
      pid: process.pid,
      pid_start_ticks: pidStartTicks(process.pid),
      boot_id: bootId(),
      acquired_at: new Date().toISOString(),
    });
    if (published) { token = candidate; break; }
    const read = readLock(lockPath);
    // The holder released it between our publish attempt and this read: retry immediately. This is
    // a transient gap, not an unverifiable owner.
    if (read.missing) continue;
    if (!read.ok) throw new Error(`holder-unverifiable: the registry lock could not be read (${read.reason})`);
    const classification = classifyHolder(read.holder);
    if (classification.state === 'dead') {
      releaseOwned(lockPath, read.holder?.token); // provably dead: reclaim, then retry
      continue;
    }
    if (classification.state === 'unverifiable') throw new Error(`holder-unverifiable: ${classification.reason}`);
    if (Date.now() > deadline) throw new Error('registry-busy: the registry mutex is held by a live owner and the wait timed out');
    sleep(5);
  }
  if (store) store.registryHeld = true;
  try {
    return fn();
  } finally {
    if (store) store.registryHeld = false;
    releaseOwned(lockPath, token);
  }
}

/** Registry mutex status (read-only, for diagnostics and tests). */
export function registryMutexStatus(dir = null) {
  const root = dir || assetLockDir();
  const read = readLock(registryLockPath(root));
  if (read.missing) return { held: false, state: 'free' };
  if (!read.ok) return { held: true, state: 'unverifiable', reason: read.reason };
  return { held: true, ...classifyHolder(read.holder), holder: read.holder };
}

/**
 * Run `fn` while holding the asset lock set for this asset.
 *
 * Isolation model: the lock set is inode-keyed (aliases collapse) AND overlap-checked (ancestor
 * and descendant paths exclude each other), and both the scan and the registration happen under
 * the registry mutex. Reentrancy is bound to the OPERATION CONTEXT: a nested call from inside the
 * holder's own callback passes through, while an independent call - even in the same process, even
 * for the same asset - is mutually exclusive.
 *
 * An async callback keeps the lock until it settles; a refused lock takes nothing.
 */
export function withAssetLockSet({ canonicalDir = null, casDir = null, protectedPaths = [], dir = null, phase = 'unknown', holder = null } = {}, fn) {
  const root = dir || assetLockDir();
  const entries = resolveAssetLockSet({ canonicalDir, casDir, protectedPaths });
  if (entries.length === 0) return { ok: false, reason: 'no asset paths were provided' };

  const store = lockContext.getStore();
  // The operation context is created BEFORE acquisition so the registration records the same
  // context the callback will run in; otherwise our own lock would look foreign to a nested call.
  const context = store ?? { id: randomUUID(), registryHeld: false };
  const acquired = [];
  const acquiredOwn = [];

  // Unwind EVERYTHING acquired so far (own locks AND reentrant depth), in reverse, under the
  // registry mutex so a release can never interleave with another process's register step.
  const unwind = () => {
    if (acquired.length === 0) return;
    try {
      withRegistryMutex(root, () => {
        for (const entry of [...acquired].reverse()) {
          const heldEntry = heldByThisProcess.get(entry.digest);
          if (!heldEntry) continue;
          heldEntry.depth -= 1;
          if (heldEntry.depth > 0) continue;
          heldByThisProcess.delete(entry.digest);
          releaseOwned(heldEntry.lockPath, heldEntry.token);
        }
      });
    } catch { /* a failed unwind must not mask the caller's outcome; the lock file remains */ }
    acquired.length = 0;
    acquiredOwn.length = 0;
  };

  let refusal = null;
  try {
    withRegistryMutex(root, () => {
      const existing = listAssetLocks(root);
      if (!existing.ok) {
        refusal = { reason: `holder-unverifiable: ${existing.reason}`, holder: null };
        return;
      }
      for (const lock of existing.locks) {
        const heldPath = lock.holder?.path;
        if (!heldPath) continue;
        // Reentrancy needs BOTH the same lock (same digest) AND the same operation context:
        // an overlapping lock we hold ourselves is a different asset and stays a conflict.
        const heldEntry = heldByThisProcess.get(lock.holder?.digest);
        const sameLock = entries.some((entry) => entry.digest === lock.holder?.digest);
        const ours = sameLock && heldEntry && heldEntry.context === context && heldEntry.token === lock.holder?.token;
        if (ours) continue;
        const overlap = entries.find((entry) => pathsOverlap(entry.path, heldPath));
        if (!overlap) continue;
        const state = lock.classification.state;
        const detail = `${overlap.path} overlaps the held path ${heldPath} (${lock.classification.reason})`;
        if (state === 'live') refusal = { reason: `asset-overlap-held-by-live-owner: ${detail}`, holder: lock.holder };
        else if (state === 'unverifiable') refusal = { reason: `asset-overlap-holder-unverifiable: ${detail}`, holder: lock.holder };
        else refusal = { reason: `asset-overlap-dead-holder-needs-reconciliation: ${detail}`, holder: lock.holder };
        return;
      }

      for (const entry of entries) {
        const heldEntry = heldByThisProcess.get(entry.digest);
        // Reentrancy requires the SAME operation context and the lock still verifiably on disk.
        if (heldEntry && heldEntry.context === context && stillOwned(heldEntry)) {
          heldEntry.depth += 1;
          acquired.push(entry);
          continue;
        }
        if (heldEntry) heldByThisProcess.delete(entry.digest);

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
        let published;
        try {
          published = publishLock(lockPath, record);
        } catch (err) {
          refusal = { reason: `could not create the asset lock: ${err.message}`, holder: null };
          return;
        }
        if (!published) {
          const read = readLock(lockPath);
          // The other party released it in the meantime: try to publish again rather than
          // reporting a holder that no longer exists.
          if (read.missing) continue;
          if (!read.ok) {
            refusal = { reason: `holder-unverifiable: ${read.reason}`, holder: null };
            return;
          }
          if (!read.holder) continue;
          const classification = classifyHolder(read.holder);
          if (classification.state === 'live') refusal = { reason: `held-by-live-owner: ${classification.reason}`, holder: classification.holder };
          else if (classification.state === 'unverifiable') refusal = { reason: `holder-unverifiable: ${classification.reason}`, holder: classification.holder };
          else refusal = { reason: `dead-holder-needs-reconciliation: ${classification.reason}`, holder: classification.holder };
          return;
        }
        heldByThisProcess.set(entry.digest, { token, depth: 1, lockPath, context });
        acquired.push(entry);
        acquiredOwn.push({ entry, lockPath, token });
      }
    });
  } catch (err) {
    unwind();
    return { ok: false, reason: `registry-unavailable: ${err.message}`, holder: null };
  }
  if (refusal) {
    unwind();
    return { ok: false, reason: refusal.reason, holder: refusal.holder ?? null };
  }

  const acquiredSummary = acquired.map((entry) => ({ digest: entry.digest, identity: entry.identity, path: entry.path }));
  const settle = () => unwind();
  // Run the callback INSIDE this operation's context so nested calls recognise it while
  // independent calls remain mutually exclusive.
  const runInContext = () => (store ? fn() : lockContext.run(context, fn));

  let value;
  try {
    value = runInContext();
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
