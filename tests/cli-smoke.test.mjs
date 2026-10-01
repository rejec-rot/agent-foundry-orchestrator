// tests/cli-smoke.test.mjs - the operator-facing entrypoints actually run
//
// Everything else in the suite imports a module and calls its functions. That
// leaves the CLI layer unexecuted: a broken argv handler, a command that cannot
// start, or an uncaught exception printed as a raw stack trace would all pass.
// (It did: `orchestrator status --task-id <unknown>` threw before this test
// existed.) Each case runs the real entrypoint in a child process.
//
// The child is given temporary runtime paths so the repository is untouched.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = mkdtempSync(join(tmpdir(), 'af-cli-'));
process.on('exit', () => { try { rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ } });

function cli(script, args) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      AF_TASKS_DIR: join(SANDBOX, 'tasks'),
      AF_LOCKS_DIR: join(SANDBOX, 'locks'),
      AF_RUNTIME_DIR: join(SANDBOX, 'runtime'),
      AF_EXECUTORS_DIR: join(ROOT, 'fixtures', 'agent-foundry-global', 'executors'),
      AF_SAFETY_STATE_FILE: join(SANDBOX, 'safety-state.json'),
      AF_RUNTIME_EVENTS_LOG: join(SANDBOX, 'events.jsonl'),
    },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const NO_STACK_TRACE = /^\s+at |node:internal\/modules|file:\/\/\//m;

// ------------------------------------------------------------------ CLI-1
test('CLI-1: status 对不存在的任务给出干净错误，而不是裸栈', () => {
  const r = cli('orchestrator.mjs', ['status', '--task-id', 'TASK-DOES-NOT-EXIST']);
  assert.strictEqual(r.code, 2, `expected a clean exit 2, got ${r.code}`);
  assert.match(r.err, /task not found/);
  assert.doesNotMatch(r.err, NO_STACK_TRACE, 'an unknown task must not print a stack trace');
});

// ------------------------------------------------------------------ CLI-2
test('CLI-2: inspect 与 cancel 对不存在的任务同样干净失败', () => {
  for (const cmd of ['inspect', 'cancel']) {
    const r = cli('orchestrator.mjs', [cmd, '--task-id', 'TASK-DOES-NOT-EXIST']);
    assert.strictEqual(r.code, 2, `${cmd}: expected exit 2, got ${r.code}`);
    assert.match(r.err, /task not found/, `${cmd}: expected a clear message`);
    assert.doesNotMatch(r.err, NO_STACK_TRACE, `${cmd}: must not print a stack trace`);
  }
});

// ------------------------------------------------------------------ CLI-3
test('CLI-3: recover --scan 可运行且无副作用', () => {
  const r = cli('orchestrator.mjs', ['recover', '--scan']);
  assert.strictEqual(r.code, 0, r.err.slice(0, 300));
  assert.match(r.out, /scan complete/);
});

// ------------------------------------------------------------------ CLI-4
test('CLI-4: af-admin circuit list 可运行', () => {
  const r = cli('af-admin.mjs', ['circuit', 'list']);
  assert.strictEqual(r.code, 0, r.err.slice(0, 300));
  assert.match(r.out, /claude/, 'every known executor must be listed');
  assert.doesNotMatch(r.out, /undefined/, 'the listing must not leak undefined fields');
});

// ------------------------------------------------------------------ CLI-5
test('CLI-5: af-admin executor status 读取能力真源', () => {
  const r = cli('af-admin.mjs', ['executor', 'status', 'claude']);
  assert.strictEqual(r.code, 0, r.err.slice(0, 300));
  assert.match(r.out, /capability:\nREADY/, 'the fixture registry must project READY');
});

test('CLI-6: terminal-task recovery, inspect and cancel retain their compatibility behavior', () => {
  const tasksDir = join(SANDBOX, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const taskId = 'TASK-CLI-TERMINAL';
  const file = join(tasksDir, `${taskId}.json`);
  writeFileSync(file, JSON.stringify({ task_id: taskId, state: 'COMPLETED', state_version: 1, runs: [] }));
  for (const command of ['recover', 'inspect', 'cancel']) {
    const result = cli('orchestrator.mjs', [command, '--task-id', taskId]);
    assert.equal(result.code, command === 'cancel' ? 2 : 0, `${command}: ${result.err}`);
    assert.doesNotMatch(result.err, NO_STACK_TRACE);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'COMPLETED');
  }
});

test('CLI-7: a run refused by an existing lock cannot overwrite the live task at definition load', () => {
  const taskId = 'TASK-CLI-HELD';
  const tasksDir = join(SANDBOX, 'tasks');
  const locksDir = join(SANDBOX, 'locks');
  mkdirSync(tasksDir, { recursive: true }); mkdirSync(locksDir, { recursive: true });
  const file = join(tasksDir, `${taskId}.json`);
  const original = { task_id: taskId, state: 'AUTHOR_RUNNING', state_version: 7, marker: 'live owner' };
  writeFileSync(file, JSON.stringify(original));
  writeFileSync(join(locksDir, `${taskId}.lock`), JSON.stringify({ orchestrator_instance_id: 'live-owner', owner_token: 'live-token', pid: process.pid, lease_expires_at: new Date(Date.now() + 60_000).toISOString() }));
  const definition = join(SANDBOX, 'definition.json');
  writeFileSync(definition, JSON.stringify({ task_id: taskId, goal: 'do work', acceptance: 'pass', fixture_dir: SANDBOX, acceptance_cmd: { command: 'node', args: ['--test'] } }));
  const result = cli('orchestrator.mjs', ['run', '--task-file', definition]);
  assert.equal(result.code, 3, result.err);
  assert.match(result.err, /TASK_ALREADY_RUNNING/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), original);
});
