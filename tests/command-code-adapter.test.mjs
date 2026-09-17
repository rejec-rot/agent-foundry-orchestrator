// tests/command-code-adapter.test.mjs - command-code (cmd/cmdc) executor adapter
//
// command-code is the agent CLI actually installed on this host
// (command-code@1.54.1, aliases cmd / cmdc / command-code / commandcode). It was
// added because AFR's adapter set (claude/codex/cline/vertex-gemini/antigravity)
// did not match the machine: only cline of those exists here, while the CLI that
// IS installed had no adapter at all.
//
//   CC-1  the adapter conforms to the unified ExecutorResult contract
//   CC-2  health resolves through PATH/aliases, never a hardcoded path
//   CC-3  the adapter builds the non-interactive argv correctly
//   CC-4  resume is explicit (--session) and refuses an empty session ref
//   CC-5  parsing is tolerant: JSON stream, garbage, and failure all behave
//   CC-6  the MCP capability claim is conservative, not optimistic
//   CC-7  the router can select it, and the default order is NOT changed
//   CC-8  the launcher fails closed without governance and prepends it when present

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import './helpers/executors-fixture.mjs';
import './helpers/runtime-state-fixture.mjs';
import { CommandCodeAdapter, ADAPTERS, selectExecutor } from '../lib/adapters.mjs';
import { resolveExecutorRoute, DEFAULT_PRIORITY_ORDER } from '../lib/executor-router.mjs';
import { COMMAND_CODE_STUB, STUB_ARGV_LOG } from './helpers/executor-stub-launcher.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// AWAIT the callback. A synchronous helper restores the environment as soon as the
// async body returns its first promise - which is BEFORE the child process is
// spawned - so the stub never received AF_STUB_ARGV_LOG and the run failed ENOENT.
async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function lastInvocation() {
  const lines = readFileSync(STUB_ARGV_LOG, 'utf8').split('\n').filter(Boolean);
  return JSON.parse(lines.at(-1));
}

// ------------------------------------------------------------------ CC-1
test('CC-1: the adapter conforms to the unified ExecutorResult contract', () => {
  assert.strictEqual(CommandCodeAdapter.type, 'command-code');
  assert.strictEqual(ADAPTERS['command-code'], CommandCodeAdapter, 'it must be registered in ADAPTERS');
  for (const method of ['health', 'run', 'resume', 'cancel']) {
    assert.strictEqual(typeof CommandCodeAdapter[method], 'function', `the adapter must implement ${method}()`);
  }
  assert.strictEqual(CommandCodeAdapter.exact_resume, true, 'session resume is exact (--session <id>)');
});

// ------------------------------------------------------------------ CC-2
test('CC-2: health resolves through PATH and the aliases, never a hardcoded path', async () => {
  const health = CommandCodeAdapter.health();
  assert.strictEqual(health.executor_type, 'command-code');
  assert.match(String(health.launcher), /command-code-af$/, 'the launcher must be the governance wrapper');
  assert.match(String(health.governance), /prepended to the prompt/, 'the governance mechanism must be stated truthfully');
  assert.strictEqual(typeof health.ok, 'boolean');

  // The CLI is installed on this host, so an override pointing nowhere must still
  // report healthy: this is the same false-negative class the cline health check
  // had (a hardcoded node-version path).
  let cliPresent;
  try {
    execFileSync('sh', ['-c', 'command -v command-code || command -v cmd'], { encoding: 'utf8' });
    cliPresent = true;
  } catch {
    cliPresent = false;
  }
  await withEnv({ COMMAND_CODE_LAUNCHER: join(tmpdir(), 'definitely-absent-command-code-af') }, () => {
    assert.strictEqual(
      CommandCodeAdapter.health().ok,
      cliPresent,
      cliPresent
        ? 'an installed CLI must not be reported unhealthy just because no launcher exists'
        : 'with no CLI installed, health must say so'
    );
  });
});

// ------------------------------------------------------------------ CC-3
test('CC-3: the adapter builds the non-interactive argv correctly', async () => {
  rmSync(STUB_ARGV_LOG, { force: true });
  await withEnv({ COMMAND_CODE_LAUNCHER: COMMAND_CODE_STUB, AF_STUB_ARGV_LOG: STUB_ARGV_LOG }, async () => {
    const result = await CommandCodeAdapter.run({
      task_id: 'TASK-CC-3',
      assigned_role: 'author',
      prompt: 'implement the thing',
      model: 'some/model',
      effort: 'High',
      max_turns: 7,
      cwd: tmpdir(),
      timeout_ms: 20000,
    });
    assert.strictEqual(result.status, 'completed', `the stub run must complete (${result.error ?? ''})`);
    assert.strictEqual(result.executor_type, 'command-code');
    assert.ok(result.started_at && result.finished_at, 'both timestamps must be present');

    const args = lastInvocation();
    assert.ok(args.includes('--trust'), '--trust is required headlessly or the run stalls on the permission prompt');
    assert.ok(args.includes('--output-format') && args.includes('json'), 'json output is what the parser expects');
    assert.deepStrictEqual(
      args.slice(args.indexOf('--model'), args.indexOf('--model') + 2),
      ['--model', 'some/model'],
      'the model must be passed through'
    );
    assert.deepStrictEqual(
      args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2),
      ['--effort', 'high'],
      'effort must be lower-cased for the CLI'
    );
    assert.strictEqual(args[args.indexOf('--max-turns') + 1], '7', 'the loop cap must be passed through');
    // The prompt is bound to -p so it can never be read as a flag.
    assert.strictEqual(args[args.indexOf('-p') + 1], 'implement the thing');
    assert.strictEqual(args.at(-1), 'implement the thing', 'the launcher injects governance into the LAST argument');
  });
});

// ------------------------------------------------------------------ CC-4
test('CC-4: resume uses --session and refuses an empty session ref', async () => {
  await assert.rejects(
    () => CommandCodeAdapter.resume('', { prompt: 'x' }),
    /requires an explicit sessionRef/,
    'resuming with no session must be refused, not silently started fresh'
  );

  rmSync(STUB_ARGV_LOG, { force: true });
  await withEnv({ COMMAND_CODE_LAUNCHER: COMMAND_CODE_STUB, AF_STUB_ARGV_LOG: STUB_ARGV_LOG }, async () => {
    const result = await CommandCodeAdapter.resume('SES-EXISTING', {
      task_id: 'TASK-CC-4', assigned_role: 'author', prompt: 'continue', cwd: tmpdir(), timeout_ms: 20000,
    });
    assert.strictEqual(result.status, 'completed');
    const args = lastInvocation();
    assert.deepStrictEqual(
      args.slice(args.indexOf('--session'), args.indexOf('--session') + 2),
      ['--session', 'SES-EXISTING'],
      'resume must name the session'
    );
  });
});

// ------------------------------------------------------------------ CC-5
test('CC-5: parsing is tolerant, and a failure is reported as a failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-cc5-'));
  const makeStub = (name, source) => {
    const path = join(dir, name);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
    return path;
  };
  try {
    // The exact envelope is unverified, so the parser must find text and session
    // under several plausible names and never lose the output.
    const streamStub = makeStub('stream.sh', `#!/bin/bash
cat <<'EOF'
{"type":"event","message":"thinking"}
{"session_id":"SES-STREAM","type":"result","text":"the final answer"}
EOF
`);
    let invocation;
    await withEnv({ COMMAND_CODE_LAUNCHER: streamStub }, async () => {
      const result = await CommandCodeAdapter.run({
        task_id: 'TASK-CC-5A', assigned_role: 'author', prompt: 'q', cwd: dir, timeout_ms: 20000,
      });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.session_ref, 'SES-STREAM', 'the session must be recovered from the stream');
      assert.strictEqual(result.structured_result, null, 'no structured payload is present here');
      invocation = result;
    });
    assert.ok(invocation, 'the stream run must return');

    // Unparseable output must degrade to raw text, not to an empty result.
    const junkStub = makeStub('junk.sh', `#!/bin/bash
echo "not json at all, but still the answer"
`);
    await withEnv({ COMMAND_CODE_LAUNCHER: junkStub }, async () => {
      const result = await CommandCodeAdapter.run({
        task_id: 'TASK-CC-5B', assigned_role: 'author', prompt: 'q', cwd: dir, timeout_ms: 20000,
      });
      assert.strictEqual(result.status, 'completed');
      assert.ok(result.session_ref === null, 'no session can be recovered from junk');
    });

    // A non-zero exit must be a failure, never a success with empty output.
    const failStub = makeStub('fail.sh', `#!/bin/bash
echo "boom" >&2
exit 3
`);
    await withEnv({ COMMAND_CODE_LAUNCHER: failStub }, async () => {
      const result = await CommandCodeAdapter.run({
        task_id: 'TASK-CC-5C', assigned_role: 'author', prompt: 'q', cwd: dir, timeout_ms: 20000,
      });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.exit_code, 3);
      assert.ok(result.error, 'a failed run must carry an error');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ CC-6
test('CC-6: the MCP capability claim is conservative', () => {
  // MCP support is unverified, so the claim must not let a requires_mcp task be
  // routed here and fail at run time.
  assert.strictEqual(CommandCodeAdapter.supportsMcpUnattended, false);
  assert.throws(
    () => selectExecutor('command-code', { requiresMcp: true, adapters: ADAPTERS }),
    /unattended MCP/,
    'a requires_mcp task must be refused explicitly, not routed to an unverified executor'
  );
});

// ------------------------------------------------------------------ CC-7
test('CC-7: the router can select it, and the default order is unchanged', () => {
  const route = resolveExecutorRoute(
    { author_executor: 'command-code' },
    { priorityOrder: ['command-code', 'cline', 'claude'] }
  );
  assert.strictEqual(route.primary, 'command-code');

  // Adding an adapter must not silently change which executor is chosen by
  // default: that is a routing/product decision, not a side effect of registering
  // a new executor.
  assert.deepStrictEqual(
    [...DEFAULT_PRIORITY_ORDER],
    ['vertex-gemini', 'claude', 'codex', 'antigravity'],
    'the default priority order must not change when an adapter is added'
  );
  assert.ok(
    !DEFAULT_PRIORITY_ORDER.includes('command-code'),
    'command-code is selectable explicitly (or via AF_EXECUTOR_PRIORITY), not by default'
  );
});

// ------------------------------------------------------------------ CC-8
test('CC-8: the launcher fails closed without governance and prepends it when present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-cc8-'));
  const launcher = join(ROOT_DIR, 'bin', 'command-code-af');
  try {
    // A stub CLI that prints its argv as JSON, so the injected prompt is visible.
    // JSON rather than a line-per-argument dump: once governance is prepended the
    // prompt argument is multi-line, so splitting on newlines cannot be asserted on.
    const cliStub = join(dir, 'cli.mjs');
    writeFileSync(cliStub, `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)));
`);
    chmodSync(cliStub, 0o755);

    // 1. No governance -> refuse. Running ungoverned must not be an option.
    let refused = null;
    try {
      execFileSync(launcher, ['--trust', '-p', 'do it'], {
        env: { ...process.env, COMMAND_CODE_BIN: cliStub, AF_CANONICAL_AGENTS_MD: '', AF_GLOBAL_DIR: '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      refused = err;
    }
    assert.ok(refused, 'the launcher must refuse when the canonical governance is unreadable');
    assert.match(String(refused.stderr), /canonical governance not readable/, 'and it must say why');

    // 2. With governance -> the canonical text is prepended to the prompt.
    const canonical = join(dir, 'AGENTS.md');
    writeFileSync(canonical, 'GOVERNANCE-MARKER-CONTENT\n');
    const out = execFileSync(launcher, ['--trust', '-p', 'do it'], {
      env: { ...process.env, COMMAND_CODE_BIN: cliStub, AF_CANONICAL_AGENTS_MD: canonical, AF_GLOBAL_DIR: '' },
      encoding: 'utf8',
    });
    const argv = JSON.parse(out);
    assert.strictEqual(argv.length, 3, `only the prompt argument is rewritten (got ${JSON.stringify(argv)})`);
    assert.strictEqual(argv[0], '--trust', 'other arguments must pass through unchanged');
    assert.strictEqual(argv[1], '-p', 'other arguments must pass through unchanged');
    assert.notStrictEqual(argv[2], 'do it', 'the prompt must actually carry the governance prefix');
    assert.match(argv[2], /GOVERNANCE-MARKER-CONTENT/, 'the canonical governance must reach the CLI inside the prompt');
    assert.match(argv[2], /do it/, 'the original prompt must survive inside it');

    // 3. A missing prompt must be refused rather than injected into a flag.
    let noPrompt = null;
    try {
      execFileSync(launcher, ['--trust'], {
        env: { ...process.env, COMMAND_CODE_BIN: cliStub, AF_CANONICAL_AGENTS_MD: canonical, AF_GLOBAL_DIR: '' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      noPrompt = err;
    }
    assert.ok(noPrompt, 'a flag-only invocation must be refused');
    assert.match(String(noPrompt.stderr), /looks like a flag/, 'and the reason must be explicit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});