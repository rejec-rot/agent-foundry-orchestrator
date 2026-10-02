// tests/rollback.test.mjs - a task workspace can be rolled back to a known-good state
//
// P7 of docs/ROADMAP.md, referencing shepherd-agents/shepherd: execution should be
// a reversible trace, not a one-way ratchet. recovery.mjs can continue from a
// breakpoint but nothing could go back, so a revision that made the workspace worse
// had no way back to the last state that passed.
//
//   RB-1  capability is refused explicitly on a non-git workspace
//   RB-2  capturing does not move HEAD or the branch
//   RB-3  restoring reverts modified files (the core property)
//   RB-4  files added after the capture are kept, and only pruned on request
//   RB-5  a restore is itself reversible (the replaced state is captured first)
//   RB-6  an unknown restore point is refused
//   RB-7  dry-run touches nothing
//   RB-8  list reports captured points

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  rollbackCapability,
  captureRestorePoint,
  listRestorePoints,
  restoreToPoint,
  formatRollbackResult,
} from '../lib/rollback.mjs';
import { runGit } from '../lib/worktree.mjs';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A git repository with one commit and a tracked file. */
function makeRepo() {
  const dir = tmpDir('af-rb-');
  runGit(['init', '-q', '-b', 'main', '.'], dir);
  runGit(['config', 'user.email', 'test@local'], dir);
  runGit(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'tracked.txt'), 'original\n');
  runGit(['add', '-A'], dir);
  runGit(['commit', '-qm', 'init'], dir);
  return dir;
}

// ------------------------------------------------------------------ RB-1
test('RB-1: capability is refused explicitly on a non-git workspace', () => {
  const plain = tmpDir('af-rb-plain-');
  try {
    const capability = rollbackCapability(plain);
    assert.strictEqual(capability.available, false);
    assert.match(String(capability.reason), /NOT_A_GIT_REPO/);

    const capture = captureRestorePoint({ dir: plain, taskId: 'TASK-RB1', revision: 1 });
    assert.strictEqual(capture.ok, false, 'a non-git workspace must refuse rather than capture nothing');
    assert.match(String(capture.reason), /NOT_A_GIT_REPO/);

    const restore = restoreToPoint({ dir: plain, taskId: 'TASK-RB1', revision: 1 });
    assert.strictEqual(restore.ok, false);
    assert.match(String(restore.reason), /NOT_A_GIT_REPO/);
    assert.strictEqual(rollbackCapability('').available, false, 'a missing directory is refused too');
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ RB-2
test('RB-2: capturing does not move HEAD or the branch', () => {
  const dir = makeRepo();
  try {
    const before = runGit(['rev-parse', 'HEAD'], dir);
    const branchBefore = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);

    const captured = captureRestorePoint({ dir, taskId: 'TASK-RB2', revision: 1, label: 'acceptance passed' });
    assert.strictEqual(captured.ok, true, `capture failed: ${captured.reason}`);
    assert.ok(captured.sha, 'a commit object is created');
    assert.strictEqual(captured.ref, 'refs/af-restore/TASK-RB2/1');

    assert.strictEqual(runGit(['rev-parse', 'HEAD'], dir), before, 'HEAD must be left alone');
    assert.strictEqual(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir), branchBefore, 'the branch must be left alone');
    // The captured commit is reachable only through the restore ref.
    assert.strictEqual(runGit(['rev-parse', `${captured.ref}^{commit}`], dir), captured.sha);
    assert.strictEqual(runGit(['branch', '--contains', captured.sha], dir), '', 'it must not be on any branch');
    assert.ok(formatRollbackResult(captured, 'capture').includes('HEAD and the branch were left unchanged'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ RB-3
test('RB-3: restoring reverts modified files', () => {
  const dir = makeRepo();
  try {
    // The state that passes: tracked.txt says "good".
    writeFileSync(join(dir, 'tracked.txt'), 'good\n');
    const captured = captureRestorePoint({ dir, taskId: 'TASK-RB3', revision: 1, label: 'acceptance passed' });
    assert.strictEqual(captured.ok, true, `capture failed: ${captured.reason}`);
    const headBefore = runGit(['rev-parse', 'HEAD'], dir);

    // A later revision makes it worse.
    writeFileSync(join(dir, 'tracked.txt'), 'broken\n');
    assert.strictEqual(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'broken\n');

    const restored = restoreToPoint({ dir, taskId: 'TASK-RB3', revision: 1 });
    assert.strictEqual(restored.ok, true, `restore failed: ${restored.reason}`);
    assert.strictEqual(restored.applied, true);
    assert.strictEqual(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'good\n', 'the file must be back to the captured content');
    assert.strictEqual(restored.head_unchanged, true, 'restoring must not rewrite history');
    assert.strictEqual(runGit(['rev-parse', 'HEAD'], dir), headBefore, 'HEAD is untouched by a restore');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ RB-4
test('RB-4: files added after the capture are kept unless pruning is asked for', () => {
  const dir = makeRepo();
  try {
    const captured = captureRestorePoint({ dir, taskId: 'TASK-RB4', revision: 1 });
    assert.strictEqual(captured.ok, true);

    writeFileSync(join(dir, 'added-later.txt'), 'new work\n');
    const first = restoreToPoint({ dir, taskId: 'TASK-RB4', revision: 1 });
    assert.strictEqual(first.ok, true);
    assert.ok(
      existsSync(join(dir, 'added-later.txt')),
      'deleting untracked files by default would destroy legitimate new work'
    );
    assert.deepStrictEqual(first.files_added_since_capture, ['added-later.txt']);
    assert.deepStrictEqual(first.pruned, []);

    const second = restoreToPoint({ dir, taskId: 'TASK-RB4', revision: 1, prune: true });
    assert.strictEqual(second.ok, true);
    assert.deepStrictEqual(second.pruned, ['added-later.txt'], 'prune must report exactly what it removed');
    assert.ok(!existsSync(join(dir, 'added-later.txt')), 'prune removes the additions');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ RB-5
test('RB-5: a restore is itself reversible', () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'good\n');
    captureRestorePoint({ dir, taskId: 'TASK-RB5', revision: 1 });

    writeFileSync(join(dir, 'tracked.txt'), 'in-progress work\n');
    const restored = restoreToPoint({ dir, taskId: 'TASK-RB5', revision: 1 });
    assert.strictEqual(restored.ok, true);
    assert.strictEqual(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'good\n');
    assert.ok(restored.safety_ref, 'the replaced state must have been captured first');

    // Roll the rollback back: an operator must never have to choose between a bad
    // state and losing the work that produced it.
    const safetyRevision = String(restored.safety_ref).split('/').pop();
    const undone = restoreToPoint({ dir, taskId: 'TASK-RB5', revision: safetyRevision });
    assert.strictEqual(undone.ok, true, `restoring to the safety point failed: ${undone.reason}`);
    assert.strictEqual(
      readFileSync(join(dir, 'tracked.txt'), 'utf8'),
      'in-progress work\n',
      'the state the restore replaced must come back'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ RB-6
test('RB-6: an unknown restore point is refused', () => {
  const dir = makeRepo();
  try {
    const result = restoreToPoint({ dir, taskId: 'TASK-RB6', revision: 99 });
    assert.strictEqual(result.ok, false);
    assert.match(String(result.reason), /NO_SUCH_RESTORE_POINT/);
    assert.ok(formatRollbackResult(result, 'restore').startsWith('restore: refused'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ RB-7
test('RB-7: dry-run touches nothing', () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, 'tracked.txt'), 'good\n');
    const captured = captureRestorePoint({ dir, taskId: 'TASK-RB7', revision: 1 });
    assert.strictEqual(captured.ok, true);
    writeFileSync(join(dir, 'tracked.txt'), 'broken\n');

    const report = restoreToPoint({ dir, taskId: 'TASK-RB7', revision: 1, apply: false });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.applied, false);
    assert.strictEqual(readFileSync(join(dir, 'tracked.txt'), 'utf8'), 'broken\n', 'dry-run must not modify the workspace');
    assert.strictEqual(runGit(['for-each-ref', '--format=%(refname)', 'refs/af-restore/TASK-RB7/'], dir).split('\n').filter(Boolean).length, 1,
      'dry-run must not create a safety point either');
    assert.ok(formatRollbackResult(report, 'restore').includes('DRY-RUN'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ RB-8
test('RB-8: list reports captured points for the task', () => {
  const dir = makeRepo();
  try {
    captureRestorePoint({ dir, taskId: 'TASK-RB8', revision: 1, label: 'rev 1 passed' });
    captureRestorePoint({ dir, taskId: 'TASK-RB8', revision: 2, label: 'rev 2 passed' });
    captureRestorePoint({ dir, taskId: 'TASK-OTHER', revision: 1 });

    const listed = listRestorePoints({ dir, taskId: 'TASK-RB8' });
    assert.strictEqual(listed.ok, true);
    assert.deepStrictEqual(listed.points.map((p) => p.revision).sort(), ['1', '2'], 'only this task\'s points are listed');
    assert.ok(listed.points.every((p) => p.sha && p.created_at));
    assert.ok(formatRollbackResult(listed, 'list').includes('restore points:'));

    const none = listRestorePoints({ dir, taskId: 'TASK-NONE' });
    assert.strictEqual(none.ok, true);
    assert.deepStrictEqual(none.points, []);
    assert.match(formatRollbackResult(none, 'list'), /none recorded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
