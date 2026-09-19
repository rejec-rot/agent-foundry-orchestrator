// tests/orphan-reaper.test.mjs - debris left by a HARD kill of the control plane
//
// The graceful path (SIGTERM/SIGINT) is covered by signalAllManaged() plus the
// executor handle sweep. A SIGKILL cannot be covered from inside the process, and
// it leaves two kinds of debris - both measured before this module existed:
//
//   - a managed child survives, because every child is spawned `detached` so a
//     tree kill can reach its descendants; that also detaches its lifetime
//   - a sandbox container stays `running`, because `docker run` does not stop its
//     container when the client dies
//
// Recovery re-dispatches the task whose owner is gone, so debris means an orphaned
// executor keeps editing the same workspace and spending the same budget while a
// fresh run starts.
//
//   OR-1  pidAlive / processGroupOf behave
//   OR-2  a dead owner's child is reaped, and the stale handle is cleaned up
//   OR-3  a LIVE owner's child is never touched
//   OR-4  a mismatched process group is refused (PID-reuse guard)
//   OR-5  a handle without owner_pid is reported, never signalled
//   OR-6  dry-run reports without killing
//   OR-7  a sandbox container with a dead owner pid is removed
//   OR-8  a sandbox container with a live owner pid is skipped
//   OR-9  reapOrphans returns evidence for both halves
//   OR-10 a SIGTERM-ignoring orphan is escalated to SIGKILL and confirmed gone
//   OR-11 a process that survives even SIGKILL keeps its handle (not lost)
//   OR-12 a durable writer cgroup is reaped before the handle is removed

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  pidAlive,
  processGroupOf,
  reapOrphanRuns,
  reapOrphanSandboxes,
  reapOrphans,
} from '../lib/orphan-reaper.mjs';
import { spawnManaged, signalTree } from '../lib/child-process.mjs';
import { probeSandbox } from '../lib/sandbox.mjs';

const DEAD_PID = 2 ** 31 - 1; // never allocated on Linux
const dockerAvailable = probeSandbox().available;
const IS_LINUX = process.platform === 'linux';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a run handle the way lib/adapters.mjs does. */
function writeHandle(runsDir, runId, handle) {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify({ run_id: runId, ...handle }, null, 2));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return predicate();
}

// ------------------------------------------------------------------ OR-1
test('OR-1: pidAlive and processGroupOf behave', { skip: IS_LINUX ? false : 'requires /proc' }, () => {
  assert.strictEqual(pidAlive(process.pid), true, 'our own pid is alive');
  assert.strictEqual(pidAlive(DEAD_PID), false, 'an unallocated pid is not alive');
  assert.strictEqual(pidAlive(-1), false, 'invalid pids are never treated as alive');
  // process.getpgrp() is not a Node API, so read the expected value with ps.
  const expectedPgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  assert.strictEqual(processGroupOf(process.pid), expectedPgid, 'the group of a live process is readable');
  assert.strictEqual(processGroupOf(DEAD_PID), null, 'an unreadable process yields null, never a guess');
});

// ------------------------------------------------------------------ OR-2
test('OR-2: a dead owner leaves a reapable child and a stale handle', { skip: IS_LINUX ? false : 'requires /proc' }, async () => {
  const runsDir = tmpDir('af-or2-');
  const child = spawnManaged('sleep', ['60']);
  try {
    writeHandle(runsDir, 'RUN-OR2', {
      task_id: 'TASK-OR2',
      pid: child.pid,
      pgid: child.pid, // detached => the child leads its own group
      owner_pid: DEAD_PID,
      adapter_type: 'codex',
    });

    const result = await reapOrphanRuns({ runsDir });
    assert.strictEqual(result.inspected, 1);
    assert.strictEqual(result.orphans.length, 1, `expected one orphan (${JSON.stringify(result)})`);
    assert.deepStrictEqual(result.killed.map((k) => k.pid), [child.pid]);
    assert.ok(
      await waitFor(() => !pidAlive(child.pid)),
      'the orphaned child must actually be terminated'
    );
    assert.ok(!existsSync(join(runsDir, 'RUN-OR2.json')), 'the stale handle must be removed');
  } finally {
    signalTree(child, 'SIGKILL');
    rmSync(runsDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ OR-3
test('OR-3: a live owner keeps its child', { skip: IS_LINUX ? false : 'requires /proc' }, async () => {
  const runsDir = tmpDir('af-or3-');
  const child = spawnManaged('sleep', ['60']);
  try {
    writeHandle(runsDir, 'RUN-OR3', {
      task_id: 'TASK-OR3',
      pid: child.pid,
      pgid: child.pid,
      owner_pid: process.pid, // this test process is very much alive
      adapter_type: 'codex',
    });

    const result = await reapOrphanRuns({ runsDir });
    assert.deepStrictEqual(result.orphans, [], 'a live owner must not be reaped');
    assert.deepStrictEqual(result.killed, []);
    assert.strictEqual(pidAlive(child.pid), true, 'the child must still be running');
    assert.ok(existsSync(join(runsDir, 'RUN-OR3.json')), 'the handle belongs to a live run and must stay');
  } finally {
    signalTree(child, 'SIGKILL');
    rmSync(runsDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ OR-4
test('OR-4: a mismatched process group is refused (PID-reuse guard)', { skip: IS_LINUX ? false : 'requires /proc' }, async () => {
  const runsDir = tmpDir('af-or4-');
  const child = spawnManaged('sleep', ['60']);
  try {
    // The recorded group does not match reality, which is what a recycled pid
    // would look like. Signalling here could kill an unrelated process.
    writeHandle(runsDir, 'RUN-OR4', {
      task_id: 'TASK-OR4',
      pid: child.pid,
      pgid: child.pid + 12345,
      owner_pid: DEAD_PID,
      adapter_type: 'codex',
    });

    const result = await reapOrphanRuns({ runsDir });
    assert.deepStrictEqual(result.killed, [], 'a fingerprint mismatch must never signal');
    assert.strictEqual(result.unverifiable.length, 1, 'it must be reported as unverifiable');
    assert.match(String(result.unverifiable[0].reason), /process group does not match/i);
    assert.strictEqual(pidAlive(child.pid), true, 'the process must be untouched');
  } finally {
    signalTree(child, 'SIGKILL');
    rmSync(runsDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ OR-5
test('OR-5: a handle without owner_pid is reported, never signalled', { skip: IS_LINUX ? false : 'requires /proc' }, async () => {
  const runsDir = tmpDir('af-or5-');
  const child = spawnManaged('sleep', ['60']);
  try {
    // This is the shape of a handle written before the fingerprint existed.
    writeHandle(runsDir, 'RUN-OR5', { task_id: 'TASK-OR5', pid: child.pid, adapter_type: 'codex' });

    const result = await reapOrphanRuns({ runsDir });
    assert.deepStrictEqual(result.killed, [], 'an unverifiable handle must not be acted on');
    assert.strictEqual(result.unverifiable.length, 1);
    assert.match(String(result.unverifiable[0].reason), /no owner_pid/i);
    assert.strictEqual(pidAlive(child.pid), true);
  } finally {
    signalTree(child, 'SIGKILL');
    rmSync(runsDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ OR-6
test('OR-6: dry-run reports without killing', { skip: IS_LINUX ? false : 'requires /proc' }, async () => {
  const runsDir = tmpDir('af-or6-');
  const child = spawnManaged('sleep', ['60']);
  try {
    writeHandle(runsDir, 'RUN-OR6', {
      task_id: 'TASK-OR6', pid: child.pid, pgid: child.pid, owner_pid: DEAD_PID, adapter_type: 'codex',
    });

    const result = await reapOrphanRuns({ runsDir, apply: false });
    assert.strictEqual(result.orphans.length, 1, 'dry-run still reports the orphan');
    assert.deepStrictEqual(result.killed, [], 'dry-run must not signal');
    assert.strictEqual(pidAlive(child.pid), true, 'the process must be untouched');
    assert.ok(existsSync(join(runsDir, 'RUN-OR6.json')), 'the handle must be untouched too');

    // A handle whose process is already gone is only stale bookkeeping.
    writeHandle(runsDir, 'RUN-OR6B', { task_id: 'T', pid: DEAD_PID, pgid: DEAD_PID, owner_pid: DEAD_PID });
    const second = await reapOrphanRuns({ runsDir, apply: false });
    assert.ok(second.staleHandles.includes('RUN-OR6B.json'), 'a dead pid is a stale handle, not an orphan to kill');
    assert.ok(!second.orphans.some((o) => o.handle === 'RUN-OR6B.json'));
  } finally {
    signalTree(child, 'SIGKILL');
    rmSync(runsDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ OR-7
test('OR-7: a sandbox container with a dead owner pid is removed', { skip: dockerAvailable ? false : 'docker is not available' }, async () => {
  const deadOwnerName = `af-sbx-${DEAD_PID}-ortest`;
  try {
    const started = spawnManaged('docker', ['run', '-d', '--rm', '--name', deadOwnerName, 'alpine:3.20', 'sleep', '120'], { stdio: 'ignore' });
    await new Promise((resolve) => started.once('close', resolve));
    assert.strictEqual(pidAlive(DEAD_PID), false, 'the embedded owner pid must be dead for this test to mean anything');

    const result = reapOrphanSandboxes();
    assert.strictEqual(result.reason, null, `docker must be usable here (${result.reason})`);
    assert.ok(result.orphans.some((o) => o.name === deadOwnerName), `the container must be seen as orphaned (${JSON.stringify(result)})`);
    assert.ok(result.reaped.includes(deadOwnerName), 'it must be reaped');
    assert.ok(
      await waitFor(() => !String(runDockerPs()).includes(deadOwnerName)),
      'the container must be gone afterwards'
    );
  } finally {
    spawnManaged('docker', ['rm', '-f', deadOwnerName], { stdio: 'ignore' });
  }
});

// ------------------------------------------------------------------ OR-8
test('OR-8: a sandbox container with a live owner pid is skipped', { skip: dockerAvailable ? false : 'docker is not available' }, async () => {
  const liveOwnerName = `af-sbx-${process.pid}-ortest`;
  try {
    const started = spawnManaged('docker', ['run', '-d', '--rm', '--name', liveOwnerName, 'alpine:3.20', 'sleep', '120'], { stdio: 'ignore' });
    await new Promise((resolve) => started.once('close', resolve));

    const result = reapOrphanSandboxes({ apply: false });
    assert.ok(
      !result.orphans.some((o) => o.name === liveOwnerName),
      'a live owner instance must not have its container removed'
    );
    assert.ok(result.skipped.some((s) => s.name === liveOwnerName && s.reason === 'owner is alive'));
  } finally {
    spawnManaged('docker', ['rm', '-f', liveOwnerName], { stdio: 'ignore' });
  }
});

// ------------------------------------------------------------------ OR-9
test('OR-9: reapOrphans returns evidence for both halves', { skip: IS_LINUX ? false : 'requires /proc' }, async () => {
  const runsDir = tmpDir('af-or9-');
  try {
    const result = await reapOrphans({ runsDir, apply: false });
    assert.ok(result.sandboxes && typeof result.sandboxes.inspected === 'number');
    assert.ok(result.runs && typeof result.runs.inspected === 'number');
    assert.ok(Array.isArray(result.sandboxes.orphans) && Array.isArray(result.runs.orphans));
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ OR-10
test('OR-10: a SIGTERM-ignoring orphan is escalated to SIGKILL and confirmed gone', { skip: IS_LINUX ? false : 'requires /proc' }, async () => {
  const runsDir = tmpDir('af-or10-');
  // A child that ignores SIGTERM: the ONLY way it dies is the escalated SIGKILL.
  // The previous fire-and-forget escalation could not be observed, so this is
  // exactly the case that used to be reported as reaped while still running.
  //
  // The ready marker is written AFTER the trap is installed: signalling before
  // that would race the shell's own setup and the child would die on SIGTERM.
  const readyFile = join(runsDir, 'trap-installed');
  const child = spawnManaged('sh', ['-c', `trap "" TERM; : > "${readyFile}"; sleep 60`]);
  try {
    assert.ok(await waitFor(() => existsSync(readyFile)), 'the child must install its SIGTERM trap before we signal');
    writeHandle(runsDir, 'RUN-OR10', {
      task_id: 'TASK-OR10', pid: child.pid, pgid: child.pid, owner_pid: DEAD_PID, adapter_type: 'codex',
    });

    const result = await reapOrphanRuns({ runsDir, graceMs: 300 });
    assert.deepStrictEqual(result.killed.map((k) => k.pid), [child.pid]);
    assert.strictEqual(result.killed[0].escalated, true, 'surviving SIGTERM must be escalated to SIGKILL');
    assert.deepStrictEqual(result.survived, [], 'the process must not be reported as surviving');
    assert.strictEqual(pidAlive(child.pid), false, 'the orphan must actually be gone when reap reports success');
    assert.ok(!existsSync(join(runsDir, 'RUN-OR10.json')), 'the handle is removed only once it is confirmed gone');
  } finally {
    signalTree(child, 'SIGKILL');
    rmSync(runsDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ OR-11
test('OR-11: a process that survives even SIGKILL keeps its handle', { skip: IS_LINUX ? false : 'requires /proc' }, async () => {
  const runsDir = tmpDir('af-or11-');
  const child = spawnManaged('sleep', ['60']);
  try {
    writeHandle(runsDir, 'RUN-OR11', {
      task_id: 'TASK-OR11', pid: child.pid, pgid: child.pid, owner_pid: DEAD_PID, adapter_type: 'codex',
    });

    // Simulate an unkillable process (D-state, or a signal the OS did not
    // deliver): the killer is injected to report "not gone".
    const result = await reapOrphanRuns({
      runsDir,
      kill: async () => ({ killed: true, escalated: true, gone: false }),
    });
    assert.deepStrictEqual(result.killed, [], 'a survivor must not be counted as reaped');
    assert.strictEqual(result.survived.length, 1, 'it must be reported as surviving');
    assert.match(String(result.survived[0].reason), /still alive after SIGKILL/i);
    assert.ok(existsSync(join(runsDir, 'RUN-OR11.json')), 'the handle must be kept so the orphan is not lost');
  } finally {
    signalTree(child, 'SIGKILL');
    rmSync(runsDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ OR-12
test('OR-12: a durable writer scope is reaped before an orphan handle is removed', { skip: IS_LINUX ? false : 'requires /proc' }, async () => {
  const runsDir = tmpDir('af-or12-');
  const child = spawnManaged('sleep', ['60']);
  const scopeCalls = [];
  try {
    writeHandle(runsDir, 'RUN-OR12', {
      task_id: 'TASK-OR12',
      pid: child.pid,
      pgid: child.pid,
      owner_pid: DEAD_PID,
      adapter_type: 'codex',
      writer_scope: {
        kind: 'cgroup',
        path: `/sys/fs/cgroup/af-writer-${DEAD_PID}-test`,
        attached: true,
        verified: true,
        owner_pid: DEAD_PID,
      },
    });

    const result = await reapOrphanRuns({
      runsDir,
      scopeReap: async (scope) => {
        scopeCalls.push(scope);
        return { scope_verified: true, scope_empty: true };
      },
    });
    assert.strictEqual(scopeCalls.length, 1);
    assert.strictEqual(scopeCalls[0].kind, 'cgroup');
    assert.deepStrictEqual(result.killed.map((k) => k.pid), [child.pid]);
    assert.strictEqual(result.killed[0].scope_verified, true);
    assert.ok(!existsSync(join(runsDir, 'RUN-OR12.json')));
  } finally {
    signalTree(child, 'SIGKILL');
    rmSync(runsDir, { recursive: true, force: true });
  }
});

/** Container names currently known to docker, for assertions. */
function runDockerPs() {
  return execFileSync('docker', ['ps', '-a', '--filter', 'name=af-sbx-', '--format', '{{.Names}}'], { encoding: 'utf8' });
}
