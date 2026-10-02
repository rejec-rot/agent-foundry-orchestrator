// cline-adapter.test.mjs - Cline Executor Adapter & Router Integration tests
//
// Test Matrix:
//   CLINE-1: ClineAdapter contract conforms to unified ExecutorResult interface
//   CLINE-2: Health check verifies binary and governance
//   CLINE-3: ROLE != PLATFORM: cline can be routed as author or reviewer
//   CLINE-4: Capability: requires_mcp retains cline (supports unattended MCP)
//   CLINE-5: Router Priority: priority_order and preference correctly select cline
//   CLINE-10: Health resolves the CLI through PATH, not a hardcoded node version

import { test } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import './helpers/runtime-state-fixture.mjs';
import './helpers/executors-fixture.mjs';
import { ClineAdapter, ADAPTERS } from '../lib/adapters.mjs';
import { resolveExecutorRoute } from '../lib/executor-router.mjs';

test('CLINE-1: ClineAdapter contract conforms to unified ExecutorResult interface', () => {
  assert.strictEqual(ClineAdapter.type, 'cline');
  assert.strictEqual(ClineAdapter.supportsMcpUnattended, true);
  assert.strictEqual(ClineAdapter.exact_resume, true);
  assert.strictEqual(typeof ClineAdapter.run, 'function');
  assert.strictEqual(typeof ClineAdapter.resume, 'function');
  assert.strictEqual(typeof ClineAdapter.cancel, 'function');
  assert.strictEqual(typeof ClineAdapter.health, 'function');
  assert.strictEqual(ADAPTERS.cline, ClineAdapter, 'ClineAdapter must be registered in ADAPTERS');
});

test('CLINE-2: Health check verifies binary and governance', () => {
  const h = ClineAdapter.health();
  assert.strictEqual(h.executor_type, 'cline');
  assert.ok(h.launcher.includes('cline-af'), 'launcher must point to cline-af');
  // This used to assert ok === true unconditionally, which was a lie on any host
  // without the canonical governance: bin/cline-af exits 2 without it, so the
  // executor could not start while health claimed otherwise. Health now reports the
  // precondition, and says which one failed.
  const cliPresent = (() => { try { execFileSync('sh', ['-c', 'command -v cline'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  const governancePresent = h.reason === null || !/canonical governance/.test(h.reason);
  assert.strictEqual(
    h.ok,
    cliPresent && governancePresent,
    `health must reflect whether the executor can actually start (reason: ${h.reason})`
  );
  if (!h.ok) assert.ok(h.reason, 'an unhealthy executor must explain why');
});

test('CLINE-3: ROLE != PLATFORM: cline can be routed as author or reviewer', () => {
  const authorRoute = resolveExecutorRoute({ author_executor: 'cline' }, { role: 'author' });
  assert.strictEqual(authorRoute.primary, 'cline');
  assert.ok(authorRoute.fallbacks.includes('claude'));

  const reviewerRoute = resolveExecutorRoute({ reviewer_executor: 'cline' }, { role: 'reviewer' });
  assert.strictEqual(reviewerRoute.primary, 'cline');
  assert.ok(reviewerRoute.fallbacks.includes('claude'));
});

test('CLINE-4: Capability: requires_mcp retains cline (supports unattended MCP)', () => {
  const route = resolveExecutorRoute({ requires_mcp: true, author_executor: 'cline' });
  assert.ok(route.fallbacks.includes('claude'), 'claude should remain as fallback');
  assert.ok(route.fallbacks.includes('codex'), 'codex is also available as an MCP fallback on 0.153.4');
});

test('CLINE-5: Router Priority: priority_order and custom priority correctly order cline', () => {
  const customRoute = resolveExecutorRoute({}, {
    priorityOrder: ['cline', 'claude', 'codex'],
  });
  assert.strictEqual(customRoute.primary, 'cline');
  assert.deepStrictEqual(customRoute.fallbacks, ['claude', 'codex']);
});

test('CLINE-6: Daily rate limit / quota exceeded triggers fallback to cline-pass/deepseek-v4-flash', async () => {
  // Test that error classifier marks daily limit / quota as RATE_LIMIT
  const { classifyExecutionError } = await import('../lib/executor-error-classifier.mjs');
  const cls1 = classifyExecutionError('cline', { exit_code: 1, stderr: 'Daily limit reached for model z-ai/glm-5.3-flash' });
  assert.strictEqual(cls1.category, 'RATE_LIMIT');

  const cls2 = classifyExecutionError('cline', { exit_code: 1, stderr: '429 Quota Exceeded: daily rate limit reached' });
  assert.strictEqual(cls2.category, 'RATE_LIMIT');
});

test('CLINE-7: default effort remains the provider default and explicit effort reaches the CLI', async () => {
  const { rmSync, readFileSync } = await import('node:fs');
  const { CLINE_STUB, STUB_ARGV_LOG } = await import('./helpers/executor-stub-launcher.mjs');

  // Assert the ARGUMENTS the adapter builds, not whether the vendor CLI is
  // installed: the model name must never silently force a reasoning grade.
  rmSync(STUB_ARGV_LOG, { force: true });
  const previousLauncher = process.env.CLINE_LAUNCHER;
  const previousLog = process.env.AF_STUB_ARGV_LOG;
  process.env.CLINE_LAUNCHER = CLINE_STUB;
  process.env.AF_STUB_ARGV_LOG = STUB_ARGV_LOG;

  try {
    const result = await ClineAdapter.run({
      task_id: 'TASK-CLINE-7',
      assigned_role: 'author',
      prompt: 'Verify default reasoning effort',
      model: 'cline-pass/deepseek-v4-flash',
      cwd: tmpdir(),
      timeout_ms: 15000,
    });

    assert.strictEqual(result.status, 'completed', 'stub launcher run must complete');

    const invocations = readFileSync(STUB_ARGV_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const args = invocations.at(-1);

    assert.equal(args.includes('--thinking'),false,'omitted effort must preserve the actual provider default');
    assert.ok(args.includes('--provider'),'execution binds the same provider used for model discovery');
    await ClineAdapter.run({task_id:'TASK-CLINE-7-explicit',assigned_role:'author',prompt:'Respect the selected effort',model:'cline-pass/deepseek-v4-flash',effort:'low',cwd:tmpdir(),timeout_ms:15000});
    const explicitArgs=readFileSync(STUB_ARGV_LOG,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).at(-1);
    assert.strictEqual(explicitArgs[explicitArgs.indexOf('--thinking')+1],'low','explicit effort is forwarded unchanged');
  } finally {
    if (previousLauncher === undefined) delete process.env.CLINE_LAUNCHER;
    else process.env.CLINE_LAUNCHER = previousLauncher;
    if (previousLog === undefined) delete process.env.AF_STUB_ARGV_LOG;
    else process.env.AF_STUB_ARGV_LOG = previousLog;
  }
});

test('CLINE-12: Planner-bound model choices never silently switch model or effort on quota refusal', async () => {
  const { RATE_LIMIT_STUB, STUB_ARGV_LOG } = await import('./helpers/executor-stub-launcher.mjs');
  const { runtimeGuard } = await import('../lib/executor-runtime-guard.mjs');
  const previousLauncher=process.env.CLINE_LAUNCHER,previousLog=process.env.AF_STUB_ARGV_LOG;
  process.env.CLINE_LAUNCHER=RATE_LIMIT_STUB;process.env.AF_STUB_ARGV_LOG=STUB_ARGV_LOG;
  rmSync(STUB_ARGV_LOG,{force:true});
  try {
    const result=await ClineAdapter.run({task_id:'TASK-CLINE-12',assigned_role:'author',prompt:'Preserve operator model configuration',model:'selected/model',effort:'high',allow_model_fallback:false,cwd:tmpdir(),timeout_ms:15000});
    assert.strictEqual(result.status,'failed');assert.strictEqual(result.error_classification.category,'RATE_LIMIT');
    assert.strictEqual(result.fallback_blocked,undefined);
    const calls=readFileSync(STUB_ARGV_LOG,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
    assert.strictEqual(calls.length,1);assert.strictEqual(calls[0][calls[0].indexOf('-m')+1],'selected/model');
    assert.strictEqual(calls[0][calls[0].indexOf('--thinking')+1],'high');
  } finally {
    if(previousLauncher===undefined)delete process.env.CLINE_LAUNCHER;else process.env.CLINE_LAUNCHER=previousLauncher;
    if(previousLog===undefined)delete process.env.AF_STUB_ARGV_LOG;else process.env.AF_STUB_ARGV_LOG=previousLog;
    runtimeGuard.resetCircuit('cline',{reset_by:'test',reason:'CLINE-12 cleanup'});
  }
});

test('CLINE-9: 限流回退不得自动清除熔断（不自动解禁）', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { RATE_LIMIT_STUB } = await import('./helpers/executor-stub-launcher.mjs');
  const { runtimeGuard } = await import('../lib/executor-runtime-guard.mjs');
  const { RUNTIME_EVENTS_LOG } = await import('./helpers/runtime-state-fixture.mjs');

  const previousLauncher = process.env.CLINE_LAUNCHER;
  process.env.CLINE_LAUNCHER = RATE_LIMIT_STUB;

  try {
    const result = await ClineAdapter.run({
      task_id: 'TASK-CLINE-9',
      assigned_role: 'author',
      prompt: 'trigger provider quota refusal',
      model: 'cline-pass/some-model',
      cwd: tmpdir(),
      timeout_ms: 15000,
    });

    // The refusal must leave the breaker open, still attributed to the quota
    // refusal: a fallback that silently reset it would un-ban cline without the
    // probe -> admit gate.
    const circuit = runtimeGuard.getCircuitState('cline');
    assert.strictEqual(circuit.state, 'OPEN_COOLDOWN');
    assert.strictEqual(circuit.category, 'RATE_LIMIT', 'the breaker must keep the original cause');
    assert.strictEqual(runtimeGuard.canExecute('cline'), false);

    // The rooted cause must survive: with the breaker open the fallback cannot
    // start, and reporting that refusal as the outcome would hide WHY the run
    // failed. The blocked fallback is recorded next to the original failure.
    assert.strictEqual(result.error_classification?.category, 'RATE_LIMIT', 'the root cause must be preserved');
    assert.match(String(result.fallback_blocked?.reason ?? ''), /EXECUTOR_CIRCUIT_OPEN/);

    // The decisive check: no automatic reset may have been recorded at all.
    const events = existsSync(RUNTIME_EVENTS_LOG) ? readFileSync(RUNTIME_EVENTS_LOG, 'utf8') : '';
    assert.ok(
      !events.split('\n').filter(Boolean).some((line) => {
        try {
          const e = JSON.parse(line);
          return e.event === 'CIRCUIT_RESET' && e.reset_by === 'cline_fallback';
        } catch { return false; }
      }),
      'the cline fallback must never auto-reset the circuit'
    );
  } finally {
    if (previousLauncher === undefined) delete process.env.CLINE_LAUNCHER;
    else process.env.CLINE_LAUNCHER = previousLauncher;
    runtimeGuard.resetCircuit('cline', { reset_by: 'test', reason: 'CLINE-9 cleanup' });
  }
});

test('CLINE-8: Target workspace test logs containing HTTP 429 must NOT trigger RATE_LIMIT classification', async () => {
  const { classifyExecutionError } = await import('../lib/executor-error-classifier.mjs');
  // Workspace test output has '✔ 429 retries with Retry-After and then succeeds' and then a later assertion failed
  const cls = classifyExecutionError('cline', {
    exit_code: 1,
    stdout: '✔ 429 retries with Retry-After and then succeeds\n✖ test/features/runeInjector.test.mjs (1 of 206 failed)',
    stderr: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal',
  });
  assert.notStrictEqual(cls.category, 'RATE_LIMIT');
  assert.strictEqual(cls.category, 'TRANSIENT_FAULT');
});


// ------------------------------------------------------------------ CLINE-10
test('CLINE-10: health resolves the CLI through PATH, not a hardcoded node version', () => {
  // Regression, found while verifying the executor sandbox against a real CLI: the
  // health fallback used to hardcode `~/.nvm/versions/node/v24.20.0/bin/cline`, so a
  // host with a different node version reported an installed, working executor as
  // unhealthy. Two properties must hold, and the first version of this test asserted
  // NEITHER of them correctly (it claimed an installed CLI must be healthy even with
  // no launcher, which is false: without the wrapper nothing can run).
  const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

  // (1) A PATH lookup, proven by stripping PATH: the CLI is then genuinely absent and
  //     the reason must name it. A hardcoded-path implementation would not notice.
  const dir = mkdtempSync(join(tmpdir(), 'af-cline10-'));
  try {
    const canonical = join(dir, 'AGENTS.md');
    writeFileSync(canonical, 'GOVERNANCE\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { ADAPTERS } = await import('file://${join(ROOT_DIR, 'lib/adapters.mjs')}');
      process.stdout.write(JSON.stringify(ADAPTERS.cline.health()));
    `], {
      encoding: 'utf8',
      env: { ...process.env, AF_CANONICAL_AGENTS_MD: canonical, AF_GLOBAL_DIR: '', PATH: '/nonexistent-bin' },
    });
    const health = JSON.parse(out);
    assert.strictEqual(health.ok, false, 'with the CLI absent from PATH the executor cannot run');
    assert.match(String(health.reason), /cline not found on PATH/, 'the reason must name the CLI');

    // (2) No hardcoded node version may reappear anywhere in that reasoning.
    assert.ok(
      !/v\d+\.\d+\.\d+\/bin/.test(String(health.reason)),
      `a hardcoded node-version path came back: ${health.reason}`
    );
    // Strip comments first: the executable code must not hardcode a node-version
    // path, while the comment that documents the old bug legitimately quotes one.
    const adapterSource = readFileSync(join(ROOT_DIR, 'lib', 'adapters.mjs'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    assert.ok(
      !/v\d+\.\d+\.\d+\/bin/.test(adapterSource),
      'lib/adapters.mjs must not hardcode a node-version path in executable code'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // (3) A missing launcher is reported by name, and it is the actionable blocker.
  const previous = process.env.CLINE_LAUNCHER;
  process.env.CLINE_LAUNCHER = join(tmpdir(), 'definitely-absent-cline-af');
  try {
    const health = ClineAdapter.health();
    assert.strictEqual(health.launcher, process.env.CLINE_LAUNCHER, 'the override is honoured');
    assert.strictEqual(health.ok, false, 'without the wrapper there is nothing to run');
    assert.match(String(health.reason), /launcher not found/, 'and the reason must say so');
  } finally {
    if (previous === undefined) delete process.env.CLINE_LAUNCHER;
    else process.env.CLINE_LAUNCHER = previous;
  }
});

// ------------------------------------------------------------------ CLINE-11
test('CLINE-11: the argv the installed cline 3.0.62 accepts is preserved', async () => {
  // Verified against the real CLI on this host: `cline --json --auto-approve true
  // "<prompt>"` is accepted, but a BARE one-word prompt is rejected with
  // "Unknown command or unquoted prompt" because a single word is ambiguous with
  // a subcommand. The adapter's single-word guard (append a trailing space) is
  // what makes the real invocation work, so it must not be dropped as noise.
  const { CLINE_STUB, STUB_ARGV_LOG } = await import('./helpers/executor-stub-launcher.mjs');
  rmSync(STUB_ARGV_LOG, { force: true });
  const previousLauncher = process.env.CLINE_LAUNCHER;
  const previousLog = process.env.AF_STUB_ARGV_LOG;
  process.env.CLINE_LAUNCHER = CLINE_STUB;
  process.env.AF_STUB_ARGV_LOG = STUB_ARGV_LOG;

  try {
    const result = await ClineAdapter.run({
      task_id: 'TASK-CLINE-11',
      assigned_role: 'author',
      prompt: 'hi', // one word on purpose
      cwd: tmpdir(),
      timeout_ms: 15000,
    });
    assert.strictEqual(result.status, 'completed', 'the stub launcher run must complete');

    const args = readFileSync(STUB_ARGV_LOG, 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line)).at(-1);

    assert.ok(args.includes('--json'), '--json is required for the run_result stream the parser reads');
    assert.strictEqual(args[args.indexOf('--auto-approve') + 1], 'true', '--auto-approve must take a value');
    assert.strictEqual(
      args.at(-1),
      'hi ',
      'a single-word prompt must carry a trailing space, or cline 3.0.62 rejects it as an unknown command'
    );
  } finally {
    if (previousLauncher === undefined) delete process.env.CLINE_LAUNCHER;
    else process.env.CLINE_LAUNCHER = previousLauncher;
    if (previousLog === undefined) delete process.env.AF_STUB_ARGV_LOG;
    else process.env.AF_STUB_ARGV_LOG = previousLog;
  }
});
