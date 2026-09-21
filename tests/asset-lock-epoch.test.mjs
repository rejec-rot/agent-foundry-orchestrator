// asset-lock-epoch.test.mjs - U1: protection epoch, expected protection metadata, shared asset lock.
//
// These tests exercise the safety rules that were frozen for A1a (H1-H3):
//   * a LIVE lock holder is never preempted, however old the lock is;
//   * an unverifiable holder is a refusal, never a guess;
//   * a DEAD holder is not stolen either: the caller must reconcile first;
//   * the lock set is keyed by inode identity so aliases collapse, and it covers every
//     protected path, not just the canonical directory;
//   * protection is verified against the EXPECTED protection metadata, never the
//     pre-protection snapshot.
//
// Integration points (engage/disengage/recover) are exercised for the lock and epoch wiring; the
// filesystem-level protection itself is covered by the host-isolation suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assetIdentity,
  assetLockDir,
  classifyHolder,
  countAssetLocks,
  listAssetLocks,
  pathsOverlap,
  resolveAssetLockSet,
  withAssetLockSet,
} from '../lib/asset-lock.mjs';
import {
  expectedProtectionMetadata,
  latestProtectionEpochFor,
  readProtectionEpoch,
  verifyProtectionExpectation,
  verifyProtectionFor,
  writeProtectionEpoch,
} from '../lib/protection-epoch.mjs';
import { disengageTaskHostBoundary, engageTaskHostBoundary } from '../lib/host-boundary.mjs';

function makeAsset() {
  const root = mkdtempSync(join(tmpdir(), 'af-u1-'));
  const canonical = join(root, 'canonical');
  const cas = join(root, 'cas');
  const locks = join(root, 'locks');
  const epochs = join(root, 'epochs');
  mkdirSync(canonical, { recursive: true });
  mkdirSync(cas, { recursive: true });
  mkdirSync(locks, { recursive: true });
  mkdirSync(epochs, { recursive: true });
  writeFileSync(join(canonical, 'file.txt'), 'content\n');
  return { root, canonical, cas, locks, epochs };
}

test('epoch: engage records a protection epoch with the expected metadata', () => {
  const asset = makeAsset();
  const previousEpochDir = process.env.AF_PROTECTION_EPOCH_DIR;
  process.env.AF_PROTECTION_EPOCH_DIR = asset.epochs;
  process.env.AF_ASSET_LOCK_DIR = asset.locks;
  try {
    const result = engageTaskHostBoundary({ canonicalDir: asset.canonical, casDir: asset.cas });
    assert.equal(result.lock.ok, true, `engage must take the asset lock: ${result.lock.reason ?? ''}`);
    assert.ok(result.epoch?.epoch_id, 'engage must record a protection epoch');
    assert.equal(result.epoch_error, null);

    const read = readProtectionEpoch({ file: result.epoch.file });
    assert.equal(read.ok, true, read.reason ?? '');
    assert.deepEqual(read.epoch.expected, expectedProtectionMetadata());
    assert.deepEqual(read.epoch.paths.sort(), [asset.canonical, asset.cas].sort());
    assert.equal(read.epoch.schema_version, 'af-protection-epoch-v1');

    // Verification compares against the EXPECTED metadata and passes on a freshly protected tree.
    const verification = verifyProtectionFor({ canonicalDir: asset.canonical, dir: asset.epochs });
    assert.equal(verification.ok, true, `${verification.reason ?? ''} (checked ${verification.checked})`);
    assert.ok(verification.checked > 0, 'verification must actually inspect entries');
    assert.deepEqual(verification.mismatches, []);
    assert.equal(verification.unverifiable, 0);
  } finally {
    // Cleanup: disengage uses its own elevated path; force is a cleanup-only escape hatch.
    disengageTaskHostBoundary({ canonicalDir: asset.canonical, casDir: asset.cas, force: true });
    if (previousEpochDir === undefined) delete process.env.AF_PROTECTION_EPOCH_DIR; else process.env.AF_PROTECTION_EPOCH_DIR = previousEpochDir;
    delete process.env.AF_ASSET_LOCK_DIR;
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('epoch: a metadata deviation is a mismatch, never a pass', () => {
  const asset = makeAsset();
  try {
    const written = writeProtectionEpoch({ canonicalDir: asset.canonical, casDir: asset.cas, paths: [asset.canonical], dir: asset.epochs });
    // A file that deviates from the expectation (not root-owned, wrong mode).
    chmodSync(join(asset.canonical, 'file.txt'), 0o600);
    const verification = verifyProtectionExpectation({ epoch: written.epoch });
    assert.equal(verification.ok, false, 'a deviation must fail verification');
    assert.ok(verification.mismatches.length >= 1);
    assert.match(verification.reason, /deviate|expected/);
    const deviating = verification.mismatches.find((entry) => entry.path.endsWith('file.txt'));
    assert.equal(deviating.expected_mode, '444');
    assert.equal(deviating.mode, '600');
  } finally {
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('epoch: an entry that cannot be inspected makes the verification unverifiable', () => {
  const asset = makeAsset();
  const unreadable = join(asset.canonical, 'no-read');
  mkdirSync(unreadable, { recursive: true });
  writeFileSync(join(unreadable, 'inner.txt'), 'x');
  chmodSync(unreadable, 0o300); // owner may write/execute but cannot list
  try {
    const written = writeProtectionEpoch({ canonicalDir: asset.canonical, paths: [asset.canonical], dir: asset.epochs });
    const verification = verifyProtectionExpectation({ epoch: written.epoch });
    assert.equal(verification.ok, false);
    assert.ok(verification.unverifiable >= 1, 'an unlistable directory must count as unverifiable');
    assert.match(verification.reason, /could not be inspected/);
  } finally {
    chmodSync(unreadable, 0o755);
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('lock: a live holder is never preempted, and a dead holder needs reconciliation', async () => {
  const asset = makeAsset();
  const holderScript = join(asset.root, 'holder.mjs');
  const moduleUrl = new URL('../lib/asset-lock.mjs', import.meta.url).href;
  writeFileSync(holderScript, [
    `import { withAssetLockSet } from ${JSON.stringify(moduleUrl)};`,
    'const [dir, canonical, cas] = process.argv.slice(2);',
    'const res = withAssetLockSet({ canonicalDir: canonical, casDir: cas, dir, phase: "test-holder" }, () => {',
    '  process.stdout.write("LOCKED\\n");',
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);',
    '});',
    'if (!res.ok) { process.stdout.write(`FAILED ${res.reason}\\n`); }',
    '',
  ].join('\n'));

  const child = spawn(process.execPath, [holderScript, asset.locks, asset.canonical, asset.cas], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the holder never acquired the lock')), 15000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('LOCKED')) { clearTimeout(timer); resolve(); }
      });
      child.on('exit', () => { clearTimeout(timer); reject(new Error('the holder exited before acquiring the lock')); });
    });

    const blocked = withAssetLockSet({ canonicalDir: asset.canonical, casDir: asset.cas, dir: asset.locks, phase: 'contender' }, () => 'should not run');
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /held-by-live-owner/, 'a live holder must block, not be taken over');
    assert.ok(blocked.holder?.pid, 'the refusal must name the holder so an operator can act');
    assert.equal(countAssetLocks(asset.locks), 2, 'the holder holds both the canonical and the cas lock');

    // Age does not matter: the same lock is still refused after a wait.
    const status = resolveAssetLockSet({ canonicalDir: asset.canonical, casDir: asset.cas });
    assert.equal(status.length, 2, 'the lock set covers canonical and cas');
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
  }

  // The holder is now dead - and a dead holder is STILL not stolen: reconcile first.
  const afterDeath = withAssetLockSet({ canonicalDir: asset.canonical, casDir: asset.cas, dir: asset.locks, phase: 'contender' }, () => 'should not run');
  assert.equal(afterDeath.ok, false, 'a dead holder must not be taken over automatically');
  assert.match(afterDeath.reason, /dead-holder-needs-reconciliation/);
  assert.equal(countAssetLocks(asset.locks), 2, 'the dead holder\'s locks are left for reconciliation');
  rmSync(asset.root, { recursive: true, force: true });
});

test('lock: an unverifiable holder is refused, never guessed', () => {
  const asset = makeAsset();
  try {
    const [entry] = resolveAssetLockSet({ canonicalDir: asset.canonical });
    writeFileSync(join(asset.locks, `asset-${entry.digest}.lock`), '{ not json');
    const result = withAssetLockSet({ canonicalDir: asset.canonical, dir: asset.locks, phase: 'contender' }, () => 'should not run');
    assert.equal(result.ok, false);
    assert.match(result.reason, /holder-unverifiable/);
    assert.equal(readFileSync(join(asset.locks, `asset-${entry.digest}.lock`), 'utf8'), '{ not json', 'the unreadable lock is left untouched');
  } finally {
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('lock: aliases collapse to one lock and a foreign lock is never unlinked', () => {
  const asset = makeAsset();
  const alias = join(asset.root, 'alias');
  symlinkSync(asset.canonical, alias);
  try {
    const set = resolveAssetLockSet({ canonicalDir: asset.canonical, casDir: asset.cas, protectedPaths: [alias] });
    assert.equal(set.length, 2, 'the symlink alias must collapse onto the canonical inode');
    assert.equal(assetIdentity(asset.canonical).identity, assetIdentity(alias).identity);

    // Reentrancy: a nested acquisition for the same asset passes through.
    const nested = withAssetLockSet({ canonicalDir: asset.canonical, dir: asset.locks, phase: 'outer' }, () => {
      const inner = withAssetLockSet({ canonicalDir: asset.canonical, dir: asset.locks, phase: 'inner' }, () => 'inner-ran');
      assert.equal(inner.ok, true, 'a nested acquisition by the same process must succeed');
      // Ownership check: replace the lock with a foreign record; our release must not unlink it.
      const [entry] = resolveAssetLockSet({ canonicalDir: asset.canonical });
      const lockPath = join(asset.locks, `asset-${entry.digest}.lock`);
      writeFileSync(lockPath, `${JSON.stringify({ schema_version: 'af-asset-lock-v1', token: 'foreign', pid: 1 })}`);
      return lockPath;
    });
    const lockPath = nested.value;
    assert.equal(existsSync(lockPath), true, 'a lock now owned by somebody else must survive our release');
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'foreign');
  } finally {
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('lock: overlapping assets share a lock digest', () => {
  const asset = makeAsset();
  const child = join(asset.canonical, 'sub');
  mkdirSync(child, { recursive: true });
  try {
    const outerSet = resolveAssetLockSet({ canonicalDir: asset.canonical });
    const innerSet = resolveAssetLockSet({ canonicalDir: child });
    // Different inodes => different locks; but a caller that lists BOTH paths gets both locks,
    // which is what makes overlapping protection detectable before any modification.
    assert.notEqual(outerSet[0].digest, innerSet[0].digest);
    const combined = resolveAssetLockSet({ canonicalDir: asset.canonical, protectedPaths: [child] });
    assert.equal(combined.length, 2, 'both paths must be locked together');
    const acquired = withAssetLockSet({ canonicalDir: asset.canonical, protectedPaths: [child], dir: asset.locks, phase: 'overlap' }, () => countAssetLocks(asset.locks));
    assert.equal(acquired.ok, true);
    assert.equal(acquired.value, 2, 'both locks are held while the function runs');
    assert.equal(countAssetLocks(asset.locks), 0, 'both locks are released afterwards');
  } finally {
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('lock: classifyHolder distinguishes live, dead and unverifiable owners', () => {
  const live = { pid: process.pid, boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  assert.equal(classifyHolder(live).state, 'unverifiable', 'a record without start ticks cannot be confirmed');
  const withTicks = { ...live, pid_start_ticks: 'not-the-real-ticks' };
  assert.equal(classifyHolder(withTicks).state, 'dead', 'a reused pid must not be treated as ours');
  assert.equal(classifyHolder({ ...live, pid: 999999, pid_start_ticks: '1' }).state, 'dead');
  assert.equal(classifyHolder(null).state, 'unverifiable');
  assert.equal(classifyHolder({ pid: process.pid, boot_id: 'other-boot' }).state, 'unverifiable');
});

test('lock: engage refuses and protects nothing when the asset is already locked', async () => {
  const asset = makeAsset();
  const previousEpochDir = process.env.AF_PROTECTION_EPOCH_DIR;
  process.env.AF_PROTECTION_EPOCH_DIR = asset.epochs;
  try {
    const held = withAssetLockSet({ canonicalDir: asset.canonical, casDir: asset.cas, dir: asset.locks, phase: 'holder' }, () => 'held');
    assert.equal(held.ok, true);
    // NOTE: the same process is reentrant, so use a foreign lock file to simulate another owner.
    const [entry] = resolveAssetLockSet({ canonicalDir: asset.canonical });
    const lockPath = join(asset.locks, `asset-${entry.digest}.lock`);
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, `${JSON.stringify({ schema_version: 'af-asset-lock-v1', pid: 999999, boot_id: 'other-boot', token: 'x', pid_start_ticks: '1' })}`);

    process.env.AF_ASSET_LOCK_DIR = asset.locks;
    const result = engageTaskHostBoundary({ canonicalDir: asset.canonical, casDir: asset.cas });
    assert.equal(result.lock.ok, false);
    assert.match(result.lock.reason, /holder-unverifiable|held-by-live-owner|dead-holder-needs-reconciliation/);
    assert.deepEqual(result.protected, [], 'a refused lock must not protect anything');
    assert.equal(result.epoch, null, 'no epoch may be recorded when the lock was refused');
    assert.equal(existsSync(join(asset.epochs)) && readdirSync(asset.epochs).length, 0, 'no epoch file is written');
  } finally {
    if (previousEpochDir === undefined) delete process.env.AF_PROTECTION_EPOCH_DIR; else process.env.AF_PROTECTION_EPOCH_DIR = previousEpochDir;
    delete process.env.AF_ASSET_LOCK_DIR;
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('lock: an ancestor and a descendant exclude each other', () => {
  const asset = makeAsset();
  const child = join(asset.canonical, 'child');
  mkdirSync(child, { recursive: true });
  const sibling = join(asset.root, 'canonical-evil');
  mkdirSync(sibling, { recursive: true });
  try {
    // Path-aware, not a bare prefix: siblings must NOT overlap.
    assert.equal(pathsOverlap(asset.canonical, child), true);
    assert.equal(pathsOverlap(child, asset.canonical), true, 'containment works in both directions');
    assert.equal(pathsOverlap(asset.canonical, asset.canonical), true);
    assert.equal(pathsOverlap(asset.canonical, sibling), false, 'a name prefix is not containment');

    // Holding the parent must block a contender for the child, and vice versa.
    const outer = withAssetLockSet({ canonicalDir: asset.canonical, dir: asset.locks, phase: 'parent' }, () => {
      const inner = withAssetLockSet({ canonicalDir: child, dir: asset.locks, phase: 'child-contender' }, () => 'should not run');
      assert.equal(inner.ok, false, 'the child must not be lockable while the parent is held');
      assert.match(inner.reason, /asset-overlap/);
      return countAssetLocks(asset.locks);
    });
    assert.equal(outer.ok, true);
    assert.equal(outer.value, 1);

    // Reverse direction: hold the child, contend for the parent.
    const reverse = withAssetLockSet({ canonicalDir: child, dir: asset.locks, phase: 'child' }, () => {
      const contender = withAssetLockSet({ canonicalDir: asset.canonical, dir: asset.locks, phase: 'parent-contender' }, () => 'should not run');
      assert.equal(contender.ok, false);
      assert.match(contender.reason, /asset-overlap/);
      return true;
    });
    assert.equal(reverse.ok, true);
    assert.equal(countAssetLocks(asset.locks), 0, 'all locks released');
  } finally {
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('lock: an async callback keeps the lock until it settles', async () => {
  const asset = makeFixtureLockSet();
  try {
    let duringRelease = null;
    const pending = withAssetLockSet({ canonicalDir: asset.canonical, dir: asset.locks, phase: 'async' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return 'async-done';
    });
    assert.equal(typeof pending.then, 'function', 'an async callback must return a promise, never a resolved result');
    // While the promise is pending the lock must still be on disk and must still block others.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(countAssetLocks(asset.locks), 1, 'the lock is on disk while the callback is pending');
    // The same process is reentrant, so "still owned" is asserted on the disk lock and its
    // classification: a live holder record, not a released one.
    const listed = listAssetLocks(asset.locks);
    assert.equal(listed.ok, true);
    assert.equal(listed.locks.length, 1);
    assert.equal(listed.locks[0].classification.state, 'live', 'the pending holder is still classified live');
    assert.equal(listed.locks[0].holder.pid, process.pid);

    const settled = await pending;
    assert.equal(settled.ok, true);
    assert.equal(settled.value, 'async-done');
    duringRelease = countAssetLocks(asset.locks);
    assert.equal(duringRelease, 0, 'the lock is released once the promise settles');
  } finally {
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('lock: a mid-acquisition failure unwinds completely (files AND reentrancy state)', () => {
  const asset = makeAsset();
  try {
    const entries = resolveAssetLockSet({ canonicalDir: asset.canonical, casDir: asset.cas });
    assert.equal(entries.length, 2);
    // A foreign lock on the SECOND digest (sorted order) makes acquisition fail halfway.
    const blocked = entries[entries.length - 1];
    writeFileSync(join(asset.locks, `asset-${blocked.digest}.lock`), `${JSON.stringify({
      schema_version: 'af-asset-lock-v1', digest: blocked.digest, path: blocked.path, pid: 999999,
      boot_id: 'other-boot', pid_start_ticks: '1', token: 'foreign',
    })}`);

    const failed = withAssetLockSet({ canonicalDir: asset.canonical, casDir: asset.cas, dir: asset.locks, phase: 'partial' }, () => 'should not run');
    assert.equal(failed.ok, false);
    assert.equal(countAssetLocks(asset.locks), 1, 'the partially acquired lock was rolled back, only the foreign one remains');

    // Reentrancy state must be clean: the same asset is lockable again on disk.
    rmSync(join(asset.locks, `asset-${blocked.digest}.lock`), { force: true });
    const again = withAssetLockSet({ canonicalDir: asset.canonical, dir: asset.locks, phase: 'retry' }, () => countAssetLocks(asset.locks));
    assert.equal(again.ok, true, 'a failed acquisition must not leave phantom reentrancy');
    assert.equal(again.value, 1, 'a real disk lock is taken on the retry');
    assert.equal(countAssetLocks(asset.locks), 0);
  } finally {
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('lock: a nested acquisition that fails restores the outer depth', () => {
  const asset = makeAsset();
  const second = join(asset.root, 'second');
  mkdirSync(second, { recursive: true });
  try {
    const secondEntry = resolveAssetLockSet({ canonicalDir: second })[0];
    writeFileSync(join(asset.locks, `asset-${secondEntry.digest}.lock`), `${JSON.stringify({
      schema_version: 'af-asset-lock-v1', digest: secondEntry.digest, path: secondEntry.path, pid: process.pid,
      boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pid_start_ticks: '1', token: 'foreign',
    })}`);

    const outer = withAssetLockSet({ canonicalDir: asset.canonical, dir: asset.locks, phase: 'outer' }, () => {
      const inner = withAssetLockSet({ canonicalDir: asset.canonical, protectedPaths: [second], dir: asset.locks, phase: 'inner' }, () => 'should not run');
      assert.equal(inner.ok, false, 'the inner acquisition must fail on the foreign lock');
      // The outer lock must still be held exactly once (no leaked depth, no lost file).
      return countAssetLocks(asset.locks);
    });
    assert.equal(outer.ok, true);
    assert.ok(outer.value >= 1, 'the foreign lock survives the failed inner acquisition');
    // End state: only the foreign lock remains, and it is untouched.
    const remaining = listAssetLocks(asset.locks);
    assert.equal(remaining.locks.length, 1, 'the outer released exactly its own lock');
    assert.equal(remaining.locks[0].holder.token, 'foreign', 'the foreign lock was never ours to remove');

    // Decisive check for a leaked reentrancy depth: a fresh acquisition must take a REAL lock
    // (files on disk), not pass through because the in-process map still believes it holds one.
    const retry = withAssetLockSet({ canonicalDir: asset.canonical, dir: asset.locks, phase: 'retry' }, () => countAssetLocks(asset.locks));
    assert.equal(retry.ok, true);
    assert.equal(retry.value, 2, 'a fresh acquisition creates its own disk lock alongside the foreign one');
    assert.equal(countAssetLocks(asset.locks), 1, 'and releases it again');
  } finally {
    rmSync(asset.root, { recursive: true, force: true });
  }
});

test('epoch: selection fails closed when any record is unreadable', () => {
  const asset = makeAsset();
  try {
    // Oldest valid epoch covers the asset...
    const valid = writeProtectionEpoch({ canonicalDir: asset.canonical, paths: [asset.canonical], dir: asset.epochs, at: '2026-09-21T01:00:00.000Z' });
    assert.equal(latestProtectionEpochFor({ canonicalDir: asset.canonical, dir: asset.epochs }).epoch?.epoch_id, valid.epoch_id);
    // ...then a NEWER record is corrupted: the newest epoch cannot be established.
    writeFileSync(join(asset.epochs, 'epoch-2026-09-21T02-00-00-000Z-broken.json'), '{ truncated');
    const damaged = latestProtectionEpochFor({ canonicalDir: asset.canonical, dir: asset.epochs });
    assert.equal(damaged.ok, false, 'an unreadable record must not be skipped in favour of an older one');
    assert.equal(damaged.epoch, null);
    assert.match(damaged.reason, /could not be read/);
    assert.equal(damaged.unreadable.length, 1);

    // All records unreadable must be `ok:false`, never `missing`.
    rmSync(join(asset.epochs, `epoch-${valid.epoch_id}.json`), { force: true });
    const allBad = latestProtectionEpochFor({ canonicalDir: asset.canonical, dir: asset.epochs });
    assert.equal(allBad.ok, false);
    assert.equal(allBad.missing, false, 'unreadable is not the same as absent');

    // A genuinely empty directory is missing, which is honest.
    const empty = mkdtempSync(join(tmpdir(), 'af-u1-empty-'));
    const missing = latestProtectionEpochFor({ canonicalDir: asset.canonical, dir: empty });
    assert.equal(missing.ok, true);
    assert.equal(missing.missing, true);
    rmSync(empty, { recursive: true, force: true });
  } finally {
    rmSync(asset.root, { recursive: true, force: true });
  }
});

function makeFixtureLockSet() {
  const root = mkdtempSync(join(tmpdir(), 'af-u1-lock-'));
  const canonical = join(root, 'canonical');
  const locks = join(root, 'locks');
  mkdirSync(canonical, { recursive: true });
  mkdirSync(locks, { recursive: true });
  return { root, canonical, locks };
}
