// tests/resource-limits.test.mjs - bounded disk, CPU and core dumps
//
// "Bounded execution" covered time and concurrency but nothing bounded what a
// runaway (or hostile) child may CONSUME. These assertions check the limits
// actually bite at the kernel level, not merely that a wrapper string was built.
//
//   RL-1  the shim execs the real command, keeping the wrapper pid
//   RL-2  the file-size cap stops a child from filling the disk
//   RL-3  the CPU cap ends a spinning child
//   RL-4  disabling the limits leaves the command untouched
//   RL-5  the capability report is honest about what is NOT covered
//   RL-6  no user data is interpolated into the shim script
//   RL-7  core dumps are disabled so a crash cannot write a huge file

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyResourceLimits,
  resolveResourceLimits,
  posixRlimitsSupported,
  describeResourceLimitCapabilities,
} from '../lib/resource-limits.mjs';
import { spawnManaged, signalTree } from '../lib/child-process.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const LIMITS = Object.freeze({ enabled: true, cpuSeconds: 2, fileSizeMb: 1, coreDumpKb: 0, maxProcesses: 0 });

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run a wrapped command and collect its exit information. */
async function runLimited(command, args, { limits = LIMITS, timeoutMs = 10_000 } = {}) {
  const launch = applyResourceLimits(command, args, { limits });
  const child = spawnManaged(launch.command, launch.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const result = await Promise.race([
    new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, timedOut: false }))),
    new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), timeoutMs)),
  ]);
  if (result.timedOut) signalTree(child, 'SIGKILL');
  return { ...result, out, launch, child };
}

// ------------------------------------------------------------------ RL-1
test('RL-1: the shim execs the real command and keeps the wrapper pid', { skip: IS_WIN || !posixRlimitsSupported() }, async () => {
  const r = await runLimited(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  assert.strictEqual(r.timedOut, false, 'the shim must not hang');
  assert.strictEqual(r.code, 0, `the wrapped command must run normally (out: ${r.out})`);
  assert.strictEqual(
    r.out.trim(),
    String(r.child.pid),
    'exec must preserve the pid, otherwise the pid-based tree kill would lose the process'
  );
  assert.strictEqual(r.launch.mechanism, 'posix-rlimits');
});

// ------------------------------------------------------------------ RL-2
test('RL-2: the file-size cap stops a child from filling the disk', { skip: IS_WIN || !posixRlimitsSupported() }, async () => {
  const dir = tmpDir('af-rl2-');
  try {
    const target = join(dir, 'flood.bin');
    // Ask for 8 MiB while the cap allows 1 MiB.
    const script = `const fs=require('fs');const b=Buffer.alloc(1024*1024);const f=fs.openSync(${JSON.stringify(target)},'w');for(let i=0;i<8;i++){try{fs.writeSync(f,b);}catch(e){process.exit(7);}}fs.closeSync(f);`;
    const r = await runLimited(process.execPath, ['-e', script]);
    assert.strictEqual(r.timedOut, false, 'a bounded write must finish, not hang');

    const written = existsSync(target) ? statSync(target).size : 0;
    assert.ok(
      written <= 2 * 1024 * 1024,
      `the file must be capped near 1 MiB, wrote ${written} bytes (exit ${r.code}, signal ${r.signal})`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ RL-3
test('RL-3: the CPU cap ends a spinning child', { skip: IS_WIN || !posixRlimitsSupported() }, async () => {
  const limits = { ...LIMITS, cpuSeconds: 1, fileSizeMb: 0 };
  const r = await runLimited('bash', ['-c', 'while :; do :; done'], { limits, timeoutMs: 8000 });
  assert.strictEqual(r.timedOut, false, 'the CPU cap must end the spin; waiting for a human is not a limit');
  assert.notStrictEqual(r.code, 0, 'a CPU-capped child must report failure, not success');
});

// ------------------------------------------------------------------ RL-4
test('RL-4: disabling the limits leaves the command untouched', () => {
  const disabled = applyResourceLimits('node', ['--test'], {
    limits: { enabled: false, cpuSeconds: 60, fileSizeMb: 1, coreDumpKb: 0, maxProcesses: 0 },
  });
  assert.strictEqual(disabled.command, 'node', 'a disabled policy must not wrap the command');
  assert.deepStrictEqual(disabled.args, ['--test']);
  assert.strictEqual(disabled.mechanism, 'none');
  assert.strictEqual(disabled.applied.cpuSeconds, 0);

  // And the env switch is honoured by the resolver.
  const previous = process.env.AF_LIMIT_DISABLED;
  process.env.AF_LIMIT_DISABLED = '1';
  try {
    assert.strictEqual(resolveResourceLimits().enabled, false, 'AF_LIMIT_DISABLED=1 must turn the policy off');
  } finally {
    if (previous === undefined) delete process.env.AF_LIMIT_DISABLED;
    else process.env.AF_LIMIT_DISABLED = previous;
  }
});

// ------------------------------------------------------------------ RL-5
test('RL-5: the capability report is honest about what is not covered', () => {
  const report = describeResourceLimitCapabilities();
  assert.ok(report.covers.disk, 'disk must be covered where rlimits are available');
  assert.ok(report.covers.cpu, 'CPU must be covered where rlimits are available');
  assert.strictEqual(report.covers.coreDumps, posixRlimitsSupported());

  // A capability probe that silently fails must not read as "not available
  // here": that is indistinguishable from a genuine absence, and it once hid a
  // missing import. If the cgroup filesystem is present on this host, the probe
  // has to say so.
  const controllersPath = join(report.cgroup.base, 'cgroup.controllers');
  if (existsSync(controllersPath)) {
    assert.strictEqual(report.cgroup.version, 'v2', 'a mounted cgroup v2 must be detected, not reported absent');
    assert.ok(
      !/not mounted/.test(String(report.cgroup.reason)),
      `a present cgroup.controllers must never be reported as absent (reason: ${report.cgroup.reason})`
    );
  }

  if (!report.cgroup.available) {
    // The limit that matters most and genuinely cannot be done without
    // delegation must be reported as missing, not silently assumed.
    assert.strictEqual(report.covers.memory, false, 'memory must not be claimed without cgroup delegation');
    assert.match(String(report.cgroup.reason), /cgroup/i, 'the reason must name the missing capability');
  }
});

// ------------------------------------------------------------------ RL-6
test('RL-6: no user data is interpolated into the shim script', () => {
  const nasty = 'echo "$(id -un)"; rm -rf /tmp/x';
  const launch = applyResourceLimits('node', ['-e', nasty], { limits: LIMITS });
  if (launch.mechanism === 'none') return; // host without rlimits
  const script = launch.args[1];
  assert.ok(!script.includes('id -un'), 'the command must not appear in the shell script');
  assert.ok(!script.includes('rm -rf'), 'arguments must not appear in the shell script');
  assert.match(script, /^ulimit [-\s\w]+ 2>\/dev\/null \|\| true; exec "\$@"$/, 'the script must be a fixed shape');
  assert.ok(launch.args.includes(nasty), 'the command must travel as an argv element');
});

// ------------------------------------------------------------------ RL-7
test('RL-7: core dumps are disabled so a crash cannot write a huge file', { skip: IS_WIN || !posixRlimitsSupported() }, async () => {
  const r = await runLimited('bash', ['-c', 'ulimit -c']);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out.trim(), '0', 'the child must inherit a zero core-dump limit');
});

// ------------------------------------------------------------------ RL-8
test('RL-8: both production call sites apply the limits', () => {
  for (const file of ['lib/adapters.mjs', 'lib/acceptance.mjs']) {
    const source = readFileSync(join(ROOT_DIR, file), 'utf8');
    assert.ok(/applyResourceLimits\(/.test(source), `${file} must bound the child it launches`);
  }
  // And they must surface what was applied, so an evidence record is verifiable.
  const adapters = readFileSync(join(ROOT_DIR, 'lib', 'adapters.mjs'), 'utf8');
  assert.ok(/resource_limits: launch\.applied/.test(adapters), 'the executor result must record the applied limits');
});
