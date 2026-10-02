// tests/dsh-adapter.test.mjs - DSH (DeepSeek Harness) as an AFR executor
//
// AFR is the work system; DSH is one of the agents inside it. This adapter drives
// DSH's one-shot mode: `dsh --profile headless "<task>"`.
//
// Shape verified from the shipped dsh-headless README and by running its help on
// this host: the final assistant message goes to stdout, reasoning to stderr, exit 0
// means completed and exit 1 means aborted/errored, one task per process, no port,
// nothing left running.
//
//   DSH-1  the adapter conforms to the unified ExecutorResult contract
//   DSH-2  health resolves dsh through PATH and says governance is NOT injected
//   DSH-3  the adapter builds `--profile headless <task>`
//   DSH-4  resume is refused explicitly (one task per process, no continuation)
//   DSH-5  exit codes map to completed/failed, and stdout becomes the result text
//   DSH-6  a requested model is reported, never silently ignored
//   DSH-7  the MCP capability claim is conservative
//   DSH-8  the REAL dsh resolves the headless profile (zero-cost integration proof)

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import './helpers/executors-fixture.mjs';
import './helpers/runtime-state-fixture.mjs';
import { DshAdapter, ADAPTERS, selectExecutor } from '../lib/adapters.mjs';
import { resolveExecutorRoute, DEFAULT_PRIORITY_ORDER } from '../lib/executor-router.mjs';
import { realCliSkip } from './helpers/real-cli.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// AWAIT the callback: a synchronous helper restores the environment as soon as the
// async body returns its first promise, i.e. before the child process is spawned.
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

/** Write an executable stub named `dsh` so the adapter's PATH lookup finds it. */
function makeDshStub(body) {
  const dir = mkdtempSync(join(tmpdir(), 'af-dshstub-'));
  const path = join(dir, 'dsh');
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

/** Run a capsule against a stub `dsh` placed first on PATH. */
async function runWithStub(body, capsule = {}, extraEnv = {}) {
  const stub = makeDshStub(body);
  try {
    return await withEnv({ PATH: `${stub.dir}:${process.env.PATH}`, ...extraEnv }, () => DshAdapter.run({
      task_id: 'TASK-DSH', assigned_role: 'author', prompt: 'do the task', cwd: stub.dir, timeout_ms: 20000, ...capsule,
    }));
  } finally {
    rmSync(stub.dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ DSH-1
test('DSH-1: the adapter conforms to the unified ExecutorResult contract', () => {
  assert.strictEqual(DshAdapter.type, 'dsh');
  assert.strictEqual(ADAPTERS.dsh, DshAdapter, 'it must be registered in ADAPTERS');
  for (const method of ['health', 'run', 'resume', 'cancel']) {
    assert.strictEqual(typeof DshAdapter[method], 'function', `the adapter must implement ${method}()`);
  }
  assert.strictEqual(DshAdapter.exact_resume, false, 'the headless profile cannot continue a session');
});

// ------------------------------------------------------------------ DSH-2
test('DSH-2: health resolves dsh through PATH and says governance is NOT injected', async () => {
  const health = DshAdapter.health();
  assert.strictEqual(health.executor_type, 'dsh');
  assert.strictEqual(typeof health.ok, 'boolean');

  // Truthfulness about governance matters more here than anywhere else: AFR cannot
  // inject its canonical AGENTS.md into the headless profile, so the agent does not
  // see AFR's governance text. Claiming otherwise would misrepresent what governs
  // the agent's behaviour.
  assert.match(String(health.governance), /NOT injected/, 'governance must not be claimed as injected');
  assert.match(String(health.governance), /no system-prompt flag/i, 'and it must say why');

  // A PATH lookup, proven by stripping PATH.
  const stripped = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { ADAPTERS } = await import('file://${join(ROOT_DIR, 'lib', 'adapters.mjs')}');
    process.stdout.write(JSON.stringify(ADAPTERS.dsh.health()));
  `], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent-bin' } });
  const absent = JSON.parse(stripped);
  assert.strictEqual(absent.ok, false, 'with dsh absent from PATH the executor cannot run');
  assert.match(String(absent.reason), /dsh not found on PATH/, 'and the reason must name the lookup');
});

// ------------------------------------------------------------------ DSH-3
test('DSH-3: the adapter builds `--profile headless <task>`', async () => {
  // The stub echoes its argv as JSON, which the adapter exposes as the result text.
  const result = await runWithStub('process.stdout.write(JSON.stringify(process.argv.slice(2)));', {
    prompt: 'rewrite the parser',
  });
  assert.strictEqual(result.status, 'completed', `the stub run must complete (${result.error ?? ''})`);
  const argv = JSON.parse(result.structured_result.result);
  assert.deepStrictEqual(argv.slice(0, 2), ['--profile', 'headless'], 'the one-shot profile must be requested');
  assert.strictEqual(argv[2], 'rewrite the parser', 'the task is positional and must arrive as one argument');
  assert.strictEqual(argv.length, 3, `nothing else may be passed (got ${JSON.stringify(argv)})`);
});

// ------------------------------------------------------------------ DSH-4
test('DSH-4: resume is refused explicitly', async () => {
  // A fix run cannot continue the author's session. Silently opening a fresh session
  // would look like a continuation while losing all prior context, so it must fail
  // loudly instead.
  await assert.rejects(
    () => DshAdapter.resume('SES-ANY', { prompt: 'continue' }),
    /dsh resume is not available/,
    'resume must refuse rather than silently start a new session'
  );
  await assert.rejects(() => DshAdapter.resume('', {}), /dsh resume is not available/);
});

// ------------------------------------------------------------------ DSH-5
test('DSH-5: exit codes map to completed/failed, and stdout becomes the result text', async () => {
  const ok = await runWithStub('process.stdout.write("the final answer");');
  assert.strictEqual(ok.status, 'completed');
  assert.strictEqual(ok.exit_code, 0);
  assert.strictEqual(ok.structured_result.result, 'the final answer', 'stdout is the final assistant message');
  assert.strictEqual(ok.session_ref, null, 'a one-shot run has no session to resume');
  assert.strictEqual(ok.error, null);
  assert.ok(ok.started_at && ok.finished_at, 'both timestamps must be present');

  // A non-zero exit must be a failure carrying the stderr text, never a success.
  const failed = await runWithStub('process.stderr.write("task aborted"); process.exit(1);');
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.exit_code, 1);
  assert.match(String(failed.error), /task aborted/);

  // A successful run with empty output is reported as a failure by dsh itself, so an
  // empty stdout must not be presented as a usable result.
  const empty = await runWithStub('process.stdout.write("   \\n"); process.exit(1);');
  assert.strictEqual(empty.status, 'failed');
  assert.strictEqual(empty.structured_result, null, 'no text means no result payload');
});

// ------------------------------------------------------------------ DSH-6
test('DSH-6: a requested model is reported, never silently ignored', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const result = await runWithStub('process.stdout.write(JSON.stringify(process.argv.slice(2)));', {
      model: 'some/specific-model',
    });
    assert.strictEqual(result.status, 'completed');
    // dsh headless takes its model from the profile, not from argv, so the request
    // cannot be honoured - and must not be silently dropped either.
    assert.ok(
      warnings.some((w) => /capsule\.model is ignored/.test(w)),
      `the model override must be reported (warnings: ${JSON.stringify(warnings)})`
    );
    const argv = JSON.parse(result.structured_result.result);
    assert.ok(!argv.includes('some/specific-model'), 'the model must not be passed as an argument');
    assert.ok(!argv.some((a) => /--model/.test(a)), 'headless accepts no --model flag');
  } finally {
    console.warn = originalWarn;
  }
});

// ------------------------------------------------------------------ DSH-7
test('DSH-7: the MCP capability claim is conservative', () => {
  assert.strictEqual(DshAdapter.supportsMcpUnattended, false, 'MCP support is unverified, so it must not be claimed');
  assert.throws(
    () => selectExecutor('dsh', { requiresMcp: true, adapters: ADAPTERS }),
    /unattended MCP/,
    'a requires_mcp task must be refused explicitly rather than routed to an unverified executor'
  );
});

// ------------------------------------------------------------------ DSH-8
test('DSH-8: the REAL dsh resolves the headless profile', { skip: realCliSkip() || (() => { try { execFileSync('sh', ['-c', 'command -v dsh'], { stdio: 'ignore' }); return false; } catch { return 'dsh is not installed on this host'; } })() }, () => {
  // Zero-cost integration proof. dsh-headless documents that `--help` "prints the
  // command's help text and exits without running anything", so this exercises the
  // real launcher, the real profile resolution and the real argument shape without
  // invoking a provider or spending anything.
  const out = execFileSync('dsh', ['--profile', 'headless', '--help'], { encoding: 'utf8', timeout: 120_000 });
  assert.match(out, /--profile headless/, 'the headless profile must resolve');
  assert.match(out, /Answer one task/, 'and it must describe the one-shot behaviour the adapter depends on');
  assert.match(out, /task\s+the task text/, 'the task must be a positional argument, which is what the adapter sends');
});

// ------------------------------------------------------------------ DSH-9
test('DSH-9: the router can select it, and the default order is unchanged', () => {
  const route = resolveExecutorRoute({ author_executor: 'dsh' }, { priorityOrder: ['dsh', 'cline'] });
  assert.strictEqual(route.primary, 'dsh');

  // Points 2 of the user's model: DSH is ONE agent inside the work system; making it
  // the default choice for every task is a routing decision, not a side effect of
  // adding an adapter.
  assert.ok(!DEFAULT_PRIORITY_ORDER.includes('dsh'), 'dsh must be selectable explicitly, not by default');
  assert.deepStrictEqual(
    [...DEFAULT_PRIORITY_ORDER],
    ['vertex-gemini', 'claude', 'codex', 'antigravity'],
    'the default priority order must not change when an adapter is added'
  );
});