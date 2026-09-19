import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerActiveRun, terminateRun, writerTerminationAllowsHandleRemoval } from '../lib/adapters.mjs';
import { signalTree, spawnManaged } from '../lib/child-process.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_DIR = join(ROOT_DIR, 'runtime', 'runs');

test('writer termination keeps a durable cgroup handle when scope cleanup is unconfirmed', () => {
  assert.strictEqual(writerTerminationAllowsHandleRemoval({
    process_group_alive: false,
    termination_confirmed: false,
    scope_kind: 'cgroup',
    scope_verified: false,
    scope_empty: false,
  }), false);

  assert.strictEqual(writerTerminationAllowsHandleRemoval({
    process_group_alive: false,
    termination_confirmed: true,
    scope_kind: 'cgroup',
    scope_verified: true,
    scope_empty: true,
  }), true);

  assert.strictEqual(writerTerminationAllowsHandleRemoval({
    process_group_alive: false,
    termination_confirmed: false,
    scope_kind: 'unavailable',
    scope_verified: false,
    scope_empty: false,
  }), false, 'an unavailable scope is not evidence that cleanup completed');
});

test('terminateRun leaves a strong-scope handle for finish or orphan-reaper', async () => {
  const runId = `RUN-WRITER-SCOPE-${process.pid}-${Date.now()}`;
  const handleFile = join(RUNS_DIR, `${runId}.json`);
  const child = spawnManaged('sleep', ['60']);
  try {
    mkdirSync(RUNS_DIR, { recursive: true });
    registerActiveRun(runId, { child, task_id: 'TASK-WRITER-SCOPE', adapter_type: 'test' });
    writeFileSync(handleFile, JSON.stringify({
      run_id: runId,
      task_id: 'TASK-WRITER-SCOPE',
      pid: child.pid,
      writer_scope: { kind: 'cgroup', path: '/sys/fs/cgroup/af-writer-test' },
    }));

    await terminateRun(runId, { graceMs: 100 });
    assert.ok(existsSync(handleFile), 'cancellation must not delete a strong-scope handle before verification');
  } finally {
    signalTree(child, 'SIGKILL');
    try { unlinkSync(handleFile); } catch { /* already cleaned */ }
  }
});
