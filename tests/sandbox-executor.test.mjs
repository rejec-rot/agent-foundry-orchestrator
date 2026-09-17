// tests/sandbox-executor.test.mjs - container sandbox for the EXECUTOR child
//
// The acceptance command is sandboxed by default (tests/sandbox.test.mjs). The
// executor is the other long-lived child, and it is the one that writes to the
// workspace, so it needs the same treatment - but it cannot use the same defaults:
//
//   - an executor NEEDS the network (it talks to its provider), so `--network none`
//     would break it
//   - a container inherits no environment, so the executor's OWN credential must be
//     forwarded or the CLI cannot authenticate
//   - running it in a container needs an image that CONTAINS that CLI, which is a
//     deployment decision, so it is off by default and REFUSES without an explicit
//     image rather than guessing one
//
//   ES-1  off by default, and says so
//   ES-2  enabled without an image is refused (never guesses)
//   ES-3  the plan keeps the network and forwards only the executor's own credential
//   ES-4  end to end: the sandboxed executor sees its own credential, not a sibling's
//   ES-5  no sandbox available while enabled is refused, never run unsandboxed

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planExecutorSandbox, probeSandbox, resetSandboxProbe } from '../lib/sandbox.mjs';
import { executorEnv } from '../lib/executor-env.mjs';
import { spawnManaged, signalTree } from '../lib/child-process.mjs';

const dockerAvailable = probeSandbox().available;
const skipNoDocker = dockerAvailable ? false : 'docker is not available on this host';
const IMAGE = 'alpine:3.20';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run `fn` with temporary env overrides, restoring everything afterwards. */
function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSandboxProbe();
  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSandboxProbe();
  }
}

const SOURCE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  ANTHROPIC_API_KEY: 'ant-own',
  OPENAI_API_KEY: 'openai-own',
});

// ------------------------------------------------------------------ ES-1
test('ES-1: executor sandboxing is off by default and says so', () => {
  const work = tmpDir('af-es1-');
  try {
    withEnv({ AF_SANDBOX_EXECUTORS: undefined, AF_SANDBOX_EXECUTOR_IMAGE: undefined }, () => {
      const decision = planExecutorSandbox({
        command: 'codex', args: ['exec'], cwd: work, executorType: 'codex', env: executorEnv('codex', SOURCE_ENV),
      });
      assert.strictEqual(decision.allowed, true, 'the default posture must not break normal runs');
      assert.strictEqual(decision.plan, null);
      assert.match(String(decision.status.reason), /AF_SANDBOX_EXECUTORS/);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ES-2
test('ES-2: enabled without an image is refused, never guessed', () => {
  const work = tmpDir('af-es2-');
  try {
    withEnv({ AF_SANDBOX_EXECUTORS: 'on', AF_SANDBOX_EXECUTOR_IMAGE: undefined }, () => {
      const decision = planExecutorSandbox({
        command: 'codex', args: ['exec'], cwd: work, executorType: 'codex', env: {},
      });
      assert.strictEqual(decision.allowed, false, 'an image must contain the executor CLI, so it cannot be defaulted');
      assert.strictEqual(decision.plan, null);
      assert.match(String(decision.status.reason), /AF_SANDBOX_EXECUTOR_IMAGE is required/);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ES-3
test('ES-3: the plan keeps the network and forwards only the executor credential', { skip: skipNoDocker }, () => {
  const work = tmpDir('af-es3-');
  try {
    withEnv(
      { AF_SANDBOX_EXECUTORS: 'on', AF_SANDBOX_EXECUTOR_IMAGE: IMAGE, AF_SANDBOX_EXECUTOR_NETWORK: undefined },
      () => {
        const codexEnv = executorEnv('codex', SOURCE_ENV);
        const decision = planExecutorSandbox({
          command: 'codex', args: ['exec'], cwd: work, executorType: 'codex', env: codexEnv,
        });
        assert.strictEqual(decision.allowed, true, `expected a plan: ${decision.status.reason}`);
        const argv = decision.plan.args.join(' ');

        // An executor must reach its provider: `--network none` would break it.
        assert.ok(argv.includes('--network bridge'), 'the executor sandbox must keep a working network');
        assert.ok(!argv.includes('--network none'), 'the acceptance default would break an executor');
        // The image is the configured one, not a guess.
        assert.ok(argv.includes(IMAGE), 'the configured image must be used');
        // Its own credential is forwarded...
        assert.ok(argv.includes('-e OPENAI_API_KEY=openai-own'), 'the executor must receive its own credential');
        // ...and a sibling's is not.
        assert.ok(!argv.includes('ANTHROPIC_API_KEY'), "a sibling's credential must never be forwarded");
        // The container limits still apply.
        for (const flag of ['--memory ', '--pids-limit ', '--cap-drop ALL', '--security-opt no-new-privileges']) {
          assert.ok(argv.includes(flag), `the executor sandbox must include ${flag}`);
        }
        assert.deepStrictEqual(decision.plan.applied.mountedPaths, [work], 'only the workspace is mounted');
        assert.strictEqual(decision.status.executor, 'codex');
        assert.strictEqual(decision.status.image, IMAGE);
      }
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ES-4
test('ES-4: end to end, the sandboxed executor sees its own credential and not a sibling', { skip: skipNoDocker }, async () => {
  const work = tmpDir('af-es4-');
  try {
    await withEnv({ AF_SANDBOX_EXECUTORS: 'on', AF_SANDBOX_EXECUTOR_IMAGE: IMAGE }, async () => {
      const decision = planExecutorSandbox({
        command: 'sh',
        args: ['-c', 'printf "%s|%s" "${OPENAI_API_KEY:-absent}" "${ANTHROPIC_API_KEY:-absent}"'],
        cwd: work,
        executorType: 'codex',
        env: executorEnv('codex', SOURCE_ENV),
      });
      assert.strictEqual(decision.allowed, true, `expected a plan: ${decision.status.reason}`);

      const child = spawnManaged(decision.plan.command, decision.plan.args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      await Promise.race([
        new Promise((resolve) => child.once('close', resolve)),
        new Promise((resolve) => setTimeout(resolve, 60_000)),
      ]);
      signalTree(child, 'SIGKILL');

      assert.strictEqual(out.trim(), 'openai-own|absent', `the container must see only its own credential (saw: ${out.trim()})`);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ ES-5
test('ES-5: enabled with no sandbox available is refused, never run unsandboxed', () => {
  const work = tmpDir('af-es5-');
  try {
    withEnv({ AF_SANDBOX_EXECUTORS: 'on', AF_SANDBOX_EXECUTOR_IMAGE: IMAGE, AF_SANDBOX_PROVIDER: 'none' }, () => {
      const decision = planExecutorSandbox({
        command: 'codex', args: ['exec'], cwd: work, executorType: 'codex', env: {},
      });
      assert.strictEqual(decision.allowed, false, 'asking for a sandbox must never silently degrade to no sandbox');
      assert.strictEqual(decision.plan, null);
      assert.match(String(decision.status.reason), /forced to none|unavailable/i);
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
