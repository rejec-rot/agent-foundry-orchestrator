// The Codex adapter must pass the task workspace to the child-process layer.
// The CLI also receives -C for the initial run, but the process cwd is the
// isolation boundary used by the sandbox and must remain correct independently.

import { test } from 'node:test';
import assert from 'node:assert';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

import './helpers/runtime-state-fixture.mjs';
import './helpers/executors-fixture.mjs';

const { CodexAdapter } = await import('../lib/adapters.mjs');

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('Codex run and resume launch from the supplied task workspace', async () => {
  const work = tmpDir('af-codex-cwd-');
  const bin = tmpDir('af-codex-bin-');
  const observed = join(work, 'observed-cwd');
  const previous = new Map([
    ['PATH', process.env.PATH],
    ['AF_SANDBOX', process.env.AF_SANDBOX],
    ['AF_SANDBOX_EXECUTORS', process.env.AF_SANDBOX_EXECUTORS],
    ['AF_STUB_CWD_FILE', process.env.AF_STUB_CWD_FILE],
    ['AF_STUB_HANG', process.env.AF_STUB_HANG],
  ]);

  const restore = () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    writeFileSync(join(bin, 'codex'), `#!/bin/sh
if [ "\${AF_STUB_HANG:-0}" = 1 ]; then
  sleep 30
  exit 0
fi
printf '%s' "$PWD" > "$AF_STUB_CWD_FILE"
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"stub complete"}}'
`, 'utf8');
    chmodSync(join(bin, 'codex'), 0o755);
    process.env.PATH = `${bin}${delimiter}${previous.get('PATH') ?? ''}`;
    process.env.AF_SANDBOX = 'off';
    process.env.AF_SANDBOX_EXECUTORS = 'off';
    process.env.AF_STUB_CWD_FILE = observed;

    const first = await CodexAdapter.run({
      runId: `RUN-CODEX-CWD-${Date.now()}`,
      task_id: 'TASK-CODEX-CWD',
      assigned_role: 'author',
      prompt: 'stub run',
      cwd: work,
      timeout_ms: 10_000,
      protect_active_process: false,
    });
    assert.strictEqual(first.status, 'completed');
    assert.strictEqual(readFileSync(observed, 'utf8'), work);

    const resumed = await CodexAdapter.resume('SESSION-CODEX-CWD', {
      runId: `RUN-CODEX-CWD-RESUME-${Date.now()}`,
      task_id: 'TASK-CODEX-CWD-RESUME',
      assigned_role: 'author',
      prompt: 'stub resume',
      cwd: work,
      timeout_ms: 10_000,
      protect_active_process: false,
    });
    assert.strictEqual(resumed.status, 'completed');
    assert.strictEqual(readFileSync(observed, 'utf8'), work);

    process.env.AF_STUB_HANG = '1';
    const timed = await CodexAdapter.run({
      runId: `RUN-CODEX-TIMEOUT-${Date.now()}`,
      task_id: 'TASK-CODEX-TIMEOUT',
      assigned_role: 'author',
      prompt: 'stub timeout',
      cwd: work,
      timeout_ms: 1_000,
      idle_timeout_ms: 1_000,
      protect_active_process: false,
    });
    assert.strictEqual(timed.status, 'failed');
    assert.match(String(timed.error), /timeout after 1000ms/);
    assert.ok(timed.writer_termination, 'timeout results must retain writer termination evidence');
    assert.strictEqual(timed.writer_termination.process_group_alive, false);
  } finally {
    restore();
    rmSync(bin, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
