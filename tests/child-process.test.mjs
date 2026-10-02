// tests/child-process.test.mjs - managed child processes and tree reaping
//
// The guarantees lib/child-process.mjs exists to provide, asserted behaviourally
// rather than by reading the code:
//
//   CP-1  a managed child leads its own process group
//   CP-2  killing it reaps its DESCENDANTS, not just the leader
//   CP-3  the escalation reaches a child that ignores SIGTERM
//   CP-4  live children are registered, so a shutdown can signal the whole set
//   CP-5  the registry forgets a child once it has exited
//
// CP-2 is the one that used to fail: acceptance commands and executor CLIs were
// killed by pid, so `bash -c 'a & b'` and a test runner's workers survived as
// orphans - contradicting the documented "graceful shutdown / zero orphan
// processes" guarantee.

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

import {
  spawnManaged,
  signalTree,
  signalPidTree,
  killTree,
  signalAllManaged,
  liveManagedCount,
  MANAGED_CHILD,
} from '../lib/child-process.mjs';

const IS_WIN = process.platform === 'win32';

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** Direct and transitive children of a pid, read from the process table. */
function descendantsOf(pid) {
  let rows;
  try {
    rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const byParent = new Map();
  for (const line of rows.trim().split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(child);
  }
  const out = [];
  const stack = [...(byParent.get(pid) ?? [])];
  while (stack.length) {
    const next = stack.pop();
    out.push(next);
    stack.push(...(byParent.get(next) ?? []));
  }
  return out;
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return predicate();
}

// ------------------------------------------------------------------ CP-1
test('CP-1: a managed child is tagged and lives in its own process group', { skip: IS_WIN }, async () => {
  const child = spawnManaged('sleep', ['5']);
  try {
    assert.strictEqual(child[MANAGED_CHILD], true, 'the child must carry the managed marker');
    // Its pgid must equal its own pid, i.e. it is a group leader. That is what
    // makes kill(-pid) able to reach its descendants.
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' }).trim());
    assert.strictEqual(pgid, child.pid, 'the managed child must lead its own process group');
  } finally {
    signalTree(child, 'SIGKILL');
  }
});

// ------------------------------------------------------------------ CP-2
test('CP-2: killing a managed child reaps its descendants, not just the leader', { skip: IS_WIN }, async () => {
  // A shell that forks two children which stay in the inherited group.
  const child = spawnManaged('bash', ['-c', 'sleep 30 & sleep 30 & wait']);
  let captured = [];
  try {
    const forked = await waitFor(() => {
      captured = descendantsOf(child.pid);
      return captured.length >= 2;
    });
    assert.ok(forked, `the shell must have forked children (saw ${captured.length})`);

    await killTree(child, { graceMs: 3000, pollMs: 50 });

    // Orphans are reparented to init, so liveness must be checked on the pids
    // captured BEFORE the kill - a fresh descendant scan would come back empty
    // either way and prove nothing.
    const survivors = await waitFor(() => captured.filter((p) => !pidAlive(p)).length === captured.length) === true
      ? []
      : captured.filter((p) => pidAlive(p));
    assert.deepStrictEqual(
      survivors,
      [],
      `descendants must not survive the tree kill: ${survivors.join(', ')}`
    );
  } finally {
    for (const pid of [child.pid, ...captured]) {
      if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  }
});

// ------------------------------------------------------------------ CP-3
test('CP-3: escalation reaches a child that ignores SIGTERM', { skip: IS_WIN }, async () => {
  // A node process with a SIGTERM listener does not exit on SIGTERM, and it has
  // no children - so unlike `bash -c "trap '' TERM; sleep 30"` (where the tree
  // kill takes out the sleep and the leader then exits anyway), only escalation
  // can end it.
  //
  // It announces readiness on stdout because a signal sent before the listener
  // is installed hits the default disposition and kills it: signalling a child
  // that has not started yet is a race, not an escalation.
  const child = spawnManaged(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => {}, 30000);",
  ]);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child never announced readiness')), 5000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    });
    assert.strictEqual(pidAlive(child.pid), true, 'the child must be alive and ignoring SIGTERM');

    const outcome = await killTree(child, { graceMs: 700, pollMs: 50 });
    assert.strictEqual(outcome.escalated, true, 'a SIGTERM-ignoring child must be escalated to SIGKILL');
    assert.ok(
      await waitFor(() => !pidAlive(child.pid), 3000),
      'the escalated child must actually be gone'
    );
  } finally {
    if (pidAlive(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
});

// ------------------------------------------------------------------ CP-4
test('CP-4: live children are registered so a shutdown can signal the whole set', { skip: IS_WIN }, async () => {
  const before = liveManagedCount();
  const children = [spawnManaged('sleep', ['10']), spawnManaged('sleep', ['10'])];
  try {
    assert.strictEqual(liveManagedCount(), before + 2, 'both children must be registered');
    const signalled = signalAllManaged('SIGTERM');
    assert.ok(signalled >= 2, `the shutdown must reach every registered child (signalled ${signalled})`);
    for (const child of children) {
      assert.ok(await waitFor(() => !pidAlive(child.pid), 4000), 'every child must be reaped');
    }
  } finally {
    for (const child of children) {
      if (pidAlive(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  }
});

// ------------------------------------------------------------------ CP-5
test('CP-5: the registry forgets a child once it has exited', { skip: IS_WIN }, async () => {
  const before = liveManagedCount();
  const child = spawnManaged('true');
  await new Promise((resolve) => child.once('close', resolve));
  assert.ok(
    await waitFor(() => liveManagedCount() === before, 4000),
    'an exited child must not linger in the registry (it would be signalled forever)'
  );
});

// ------------------------------------------------------------------ CP-6
test('CP-6: signalling an unknown or exited pid is a no-op, never a throw', () => {
  assert.strictEqual(signalPidTree(-1), false);
  assert.strictEqual(signalPidTree(0), false);
  assert.strictEqual(signalPidTree(2 ** 31 - 1), false);
  assert.strictEqual(signalTree(null), false);
  assert.strictEqual(signalTree({}), false);
});
