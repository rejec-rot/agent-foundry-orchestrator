// tests/sandbox.test.mjs - container sandbox for the acceptance command
//
// P2 of docs/ROADMAP.md. The sandbox is what closes three residuals that
// rlimits + process-group killing cannot:
//
//   - memory is unbounded (rlimits cannot cap it: V8 reserves huge virtual ranges)
//   - a daemon that escapes its process group with setsid survives a tree kill
//   - the child shares the orchestrator's UID, which weakens every file-level guard
//
// Measured facts this file asserts (see docs/P2-FEASIBILITY.md):
//   SB-1  the capability probe is honest (and never claims a provider it lacks)
//   SB-2  the launch plan carries the isolation and limit flags
//   SB-3  mode 'require' fails closed when no sandbox exists (no silent degradation)
//   SB-4  mode 'off' produces no plan and says so
//   SB-5  a setsid daemon dies with the container
//   SB-6  the memory cap is enforced
//   SB-7  the pids cap contains a fork bomb
//   SB-8  a sandboxed acceptance run succeeds, records the sandbox, and cleans up
//   SB-9  rlimits are applied through Docker --ulimit (a slim image has no bash)

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import './helpers/runtime-state-fixture.mjs';
import './helpers/executors-fixture.mjs';
import './helpers/acceptance-allowlist.mjs';

import {
  probeSandbox,
  resetSandboxProbe,
  describeSandboxCapabilities,
  buildSandboxCommand,
  planSandbox,
  sandboxMode,
  resolveSandboxSettings,
} from '../lib/sandbox.mjs';
import { runAcceptance, acceptanceBinding } from '../lib/acceptance.mjs';
import { spawnManaged, signalTree } from '../lib/child-process.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = 'alpine:3.20'; // small and already required by the probe documents
const NO_LIMITS = Object.freeze({ enabled: false, cpuSeconds: 0, fileSizeMb: 0, coreDumpKb: 0, maxProcesses: 0 });

const dockerAvailable = probeSandbox().available;
const skipNoDocker = dockerAvailable ? false : 'docker is not available on this host';

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run a sandbox plan to completion and collect its output. */
async function runPlan(plan, timeoutMs = 60_000) {
  const child = spawnManaged(plan.command, plan.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const result = await Promise.race([
    new Promise((resolve) => child.once('close', (code) => resolve({ code, timedOut: false }))),
    new Promise((resolve) => setTimeout(() => resolve({ code: null, timedOut: true }), timeoutMs)),
  ]);
  if (result.timedOut) signalTree(child, 'SIGKILL');
  return { ...result, out };
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

// ------------------------------------------------------------------ SB-1
test('SB-1: the capability probe is honest about what this host provides', () => {
  const report = describeSandboxCapabilities();
  assert.ok(['docker', 'none'].includes(report.provider), `unexpected provider ${report.provider}`);
  assert.strictEqual(report.available, report.provider !== 'none');

  // Every capability the sandbox is supposed to add must be claimed ONLY when a
  // provider actually exists - claiming them without one would be exactly the
  // silent degradation ROADMAP principle 5 forbids.
  for (const [name, covered] of Object.entries(report.covers)) {
    assert.strictEqual(covered, report.available, `capability "${name}" must track availability`);
  }
  if (!report.available) {
    assert.ok(report.reason, 'an unavailable sandbox must explain why');
  }
});

// ------------------------------------------------------------------ SB-2
test('SB-2: the launch plan carries the isolation and limit flags', { skip: skipNoDocker }, () => {
  const work = tmpDir('af-sb2-');
  try {
    const plan = buildSandboxCommand({
      command: 'node',
      args: ['--test', 'ok.test.mjs'],
      cwd: work,
      limits: NO_LIMITS,
    });
    const argv = plan.args.join(' ');
    assert.strictEqual(plan.command, 'docker');
    assert.strictEqual(plan.mechanism, 'docker');
    for (const flag of ['--rm', '--network none', '--memory ', '--memory-swap ', '--pids-limit ', '--cpus ', '--cap-drop ALL', '--security-opt no-new-privileges']) {
      assert.ok(argv.includes(flag), `the plan must include ${flag}`);
    }
    assert.ok(argv.includes(`--user ${process.getuid?.()}:${process.getgid?.()}`), 'the child must not run as root');
    assert.ok(argv.includes(`-v ${work}:${work}`), 'the working directory must be mounted');
    assert.ok(argv.includes(`-w ${work}`), 'the working directory must be the cwd');

    // The only mounted path is the workspace: the orchestrator root is never
    // exposed, which is what makes the root check enforceable.
    assert.deepStrictEqual(plan.applied.mountedPaths, [work]);
    assert.ok(!argv.includes(ROOT_DIR), 'the orchestrator root must never be mounted');
    assert.ok(plan.containerName.startsWith('af-sbx-'), 'the container must be named so it can be reaped');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ SB-3
test('SB-3: mode "require" fails closed when no sandbox exists', () => {
  const work = tmpDir('af-sb3-');
  try {
    withEnv({ AF_SANDBOX_PROVIDER: 'none', AF_SANDBOX: 'require' }, () => {
      const decision = planSandbox({ command: 'node', args: ['--test'], cwd: work, limits: NO_LIMITS });
      assert.strictEqual(decision.allowed, false, 'require must not fall back to an unsandboxed run');
      assert.strictEqual(decision.plan, null);
      assert.match(String(decision.status.reason), /forced to none|unavailable/i);
    });

    // ...and 'auto' proceeds while RECORDING the weaker posture (never silently).
    withEnv({ AF_SANDBOX_PROVIDER: 'none', AF_SANDBOX: 'auto' }, () => {
      const decision = planSandbox({ command: 'node', args: ['--test'], cwd: work, limits: NO_LIMITS });
      assert.strictEqual(decision.allowed, true);
      assert.strictEqual(decision.plan, null);
      assert.strictEqual(decision.status.provider, 'none');
      assert.ok(decision.status.reason, 'an unsandboxed run must record why');
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ SB-4
test('SB-4: mode "off" produces no plan and says so', () => {
  const work = tmpDir('af-sb4-');
  try {
    withEnv({ AF_SANDBOX: 'off' }, () => {
      assert.strictEqual(sandboxMode(), 'off');
      const decision = planSandbox({ command: 'node', args: ['--test'], cwd: work, limits: NO_LIMITS });
      assert.strictEqual(decision.allowed, true);
      assert.strictEqual(decision.plan, null);
      assert.strictEqual(decision.status.provider, 'disabled');
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ SB-5
test('SB-5: a setsid daemon dies with the container', { skip: skipNoDocker }, async () => {
  const work = tmpDir('af-sb5-');
  try {
    const plan = withEnv({ AF_SANDBOX_IMAGE: IMAGE }, () => buildSandboxCommand({
      command: 'sh',
      args: ['-c',
        "setsid sh -c 'while :; do date +%s%N >> heartbeat; sleep 0.1; done' </dev/null >/dev/null 2>&1 & sleep 1.2"],
      cwd: work,
      limits: NO_LIMITS,
    }));

    const result = await runPlan(plan);
    assert.strictEqual(result.timedOut, false, 'the container must finish');

    const heartbeat = join(work, 'heartbeat');
    assert.ok(existsSync(heartbeat), `the daemon must have written inside the mounted workspace (${result.out})`);
    const before = readFileSync(heartbeat, 'utf8').split('\n').length;
    await new Promise((r) => { setTimeout(r, 1500); });
    const after = readFileSync(heartbeat, 'utf8').split('\n').length;

    // Counting lines rather than host PIDs: container PIDs are not host PIDs, so
    // liveness must be judged by a host-visible side effect.
    assert.strictEqual(
      after,
      before,
      `the setsid daemon must be gone once the container exits (heartbeat kept growing: ${before} -> ${after})`
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ SB-6
test('SB-6: the memory cap is enforced', { skip: skipNoDocker }, async () => {
  const work = tmpDir('af-sb6-');
  try {
    const plan = withEnv({ AF_SANDBOX_IMAGE: IMAGE, AF_SANDBOX_MEMORY_MB: '64' }, () => buildSandboxCommand({
      command: 'sh',
      // tmpfs pages are charged to the container's memory cgroup.
      args: ['-c', 'dd if=/dev/zero of=/dev/shm/hog bs=1M count=256 2>&1 | tail -2; echo "exit=$?"'],
      cwd: work,
      limits: NO_LIMITS,
    }));

    const result = await runPlan(plan);
    assert.strictEqual(result.timedOut, false);
    // The allocation cannot both succeed and be within a 64 MiB cap.
    assert.ok(
      result.code !== 0 || /killed|out of memory|cannot allocate/i.test(result.out),
      `a 256MB allocation under a 64MB cap must fail (exit ${result.code}, out: ${result.out.slice(0, 200)})`
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ SB-7
test('SB-7: the pids cap contains a fork bomb', { skip: skipNoDocker }, async () => {
  const work = tmpDir('af-sb7-');
  try {
    const plan = withEnv({ AF_SANDBOX_IMAGE: IMAGE, AF_SANDBOX_PIDS: '24' }, () => buildSandboxCommand({
      command: 'sh',
      args: ['-c', 'i=0; while [ $i -lt 200 ]; do sleep 5 & i=$((i+1)); done; echo "forked $i"'],
      cwd: work,
      limits: NO_LIMITS,
    }));

    const result = await runPlan(plan);
    assert.strictEqual(result.timedOut, false);
    assert.ok(
      !/forked 200/.test(result.out),
      `200 forks must not all succeed under a pids limit of 24 (out: ${result.out.slice(0, 200)})`
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ SB-8
test('SB-8: a sandboxed acceptance run succeeds, records the sandbox, and cleans up', { skip: skipNoDocker }, async () => {
  const work = tmpDir('af-sb8-');
  try {
    writeFileSync(join(work, 'ok.test.mjs'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
    const task = {
      task_id: 'TASK-SB8',
      acceptance_cmd: { command: 'node', args: ['--test', 'ok.test.mjs'] },
      fixture_dir: work,
    };
    task.acceptance_binding = acceptanceBinding(task);

    let containerName = null;
    await withEnv({ AF_SANDBOX: 'auto', AF_SANDBOX_IMAGE: 'node:24-alpine' }, async () => {
      const res = await runAcceptance(task);
      assert.strictEqual(res.ok, true, `sandboxed acceptance must pass (${res.record?.stderr_summary ?? ''})`);
      assert.strictEqual(res.record.sandbox.provider, 'docker', 'the evidence must record that it ran sandboxed');
      assert.strictEqual(res.record.sandbox.applied.image, 'node:24-alpine');
      assert.ok(res.record.sandbox.applied.memoryMb > 0, 'the recorded plan must include the memory cap');
      containerName = null;
      return undefined;
    });

    // No container may be left behind (the `docker run` client is removed by
    // --rm, and the explicit cleanup covers an abrupt kill).
    const leftover = await runPlan({ command: 'docker', args: ['ps', '-a', '--filter', 'name=af-sbx-', '--format', '{{.Names}}'] });
    const strays = String(leftover.out).trim().split('\n').filter((n) => n.startsWith('af-sbx-'));
    assert.deepStrictEqual(strays, [], `no sandbox container may survive the run: ${strays.join(', ')}`);
    if (containerName) assert.fail('unreachable');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ SB-9
test('SB-9: rlimits are applied through Docker --ulimit, not the shell shim', { skip: skipNoDocker }, () => {
  const work = tmpDir('af-sb9-');
  try {
    const plan = buildSandboxCommand({
      command: 'node',
      args: ['--test'],
      cwd: work,
      limits: { enabled: true, cpuSeconds: 30, fileSizeMb: 2, coreDumpKb: 0, maxProcesses: 0 },
    });
    const argv = plan.args.join(' ');
    // A slim image has sh but not bash, so the rlimit shim cannot be nested.
    assert.ok(!argv.includes('ulimit -t'), 'the shell shim must not be used inside the sandbox');
    assert.ok(argv.includes('--ulimit core=0:0'), 'core dumps must be disabled');
    assert.ok(argv.includes(`--ulimit fsize=${2 * 1024 * 1024}:${2 * 1024 * 1024}`), 'fsize must become a Docker ulimit');
    assert.ok(argv.includes('--ulimit cpu=30:30'), 'cpu seconds must become a Docker ulimit');
    assert.strictEqual(plan.applied.rlimitsViaDocker.fileSizeMb, 2);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
