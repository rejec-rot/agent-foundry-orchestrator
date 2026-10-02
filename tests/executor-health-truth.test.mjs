// tests/executor-health-truth.test.mjs - health() must not claim an executor can run
//
// Why this file exists:
//
//   Every launcher in bin/ verifies the canonical governance and exits 2 without it.
//   The health checks only looked for the launcher FILE, so on a host without
//   agent-foundry-global they reported healthy for executors that could not start at
//   all. Measured on this host: cline and command-code said ok=true and then exited 2
//   on every run, and vertex-gemini - the DEFAULT route's first choice - was reported
//   healthy while its launcher is a STUB that fabricates a result and a fixed
//   `decision: 'PASS'`.
//
//   A diagnostic that cannot say "this will fail" is not a diagnostic, and a
//   test that asserts ok === true unconditionally turns the lie into a contract
//   (TEST 6A-4 did exactly that).
//
//   EH-1  ok is a boolean, and false always carries a reason
//   EH-2  a launcher-wrapped executor is NOT healthy without canonical governance
//   EH-3  the shipped vertex stub is flagged, unhealthy, and non-schedulable
//   EH-4  no stub may ever be schedulable (guard for future executors)
//   EH-5  the positive path works: with governance + CLI, health flips to ok
//   EH-6  a non-schedulable executor is skipped by the router rather than chosen

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import './helpers/executors-fixture.mjs';
import './helpers/runtime-state-fixture.mjs';
import { ADAPTERS, VertexGeminiAdapter, ClineAdapter, CommandCodeAdapter } from '../lib/adapters.mjs';
import { resolveExecutorRoute } from '../lib/executor-router.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_WRAPPED = ['claude', 'cline', 'command-code', 'antigravity'];

// ------------------------------------------------------------------ EH-1
test('EH-1: ok is a boolean, and false always carries a reason', () => {
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    const health = adapter.health();
    assert.strictEqual(typeof health.ok, 'boolean', `${id}.health().ok must be a boolean`);
    assert.strictEqual(health.executor_type, id, `${id}.health() must identify itself`);
    if (health.ok === false) {
      assert.ok(
        typeof health.reason === 'string' && health.reason.length > 0,
        `${id} reports unhealthy without a reason; an unexplained false sends operators through the logs`
      );
    }
  }
});

// ------------------------------------------------------------------ EH-2
test('EH-2: a launcher-wrapped executor is not healthy without canonical governance', () => {
  // The launchers exit 2 when the canonical is unreadable, so health must agree.
  // This host has no agent-foundry-global, which is exactly the measured case.
  let canonical;
  try {
    canonical = execFileSync(process.execPath, ['--input-type=module', '-e',
      "const c = await import('file://" + join(ROOT_DIR, 'lib/config.mjs') + "'); process.stdout.write(c.CANONICAL_AGENTS_MD);",
    ], { encoding: 'utf8' });
  } catch {
    canonical = '';
  }

  if (canonical) return; // governance present: nothing to assert here (EH-5 covers the positive path)

  for (const id of LAUNCHER_WRAPPED) {
    const health = ADAPTERS[id].health();
    assert.strictEqual(
      health.ok,
      false,
      `${id} cannot start without governance (its launcher exits 2), so health must not be ok`
    );
    assert.match(
      String(health.reason),
      /canonical governance not readable/,
      `${id}.health() must name the governance precondition`
    );
  }
});

// ------------------------------------------------------------------ EH-3
test('EH-3: the shipped vertex stub is flagged, unhealthy, and non-schedulable', () => {
  // bin/vertex-gemini-af performs no provider call: it fabricates a result and, for a
  // review schema, `decision: 'PASS'`. It is first in DEFAULT_PRIORITY_ORDER, so
  // without this flag a task could "pass review" with nothing having reviewed it.
  assert.strictEqual(VertexGeminiAdapter.stub, true, 'the shipped launcher must be flagged as a stub');
  assert.strictEqual(VertexGeminiAdapter.schedulable, false, 'a stub that fabricates PASS must never be auto-selected');
  assert.match(String(VertexGeminiAdapter.blocked_reason), /stub/i, 'the blocked reason must say why');
  const health = VertexGeminiAdapter.health();
  assert.strictEqual(health.ok, false);
  assert.match(String(health.reason), /stub/, 'health must name the stub as the reason');
});

// ------------------------------------------------------------------ EH-4
test('EH-4: no stub may be schedulable (guard for future executors)', () => {
  for (const [id, adapter] of Object.entries(ADAPTERS)) {
    if (adapter.stub === true) {
      assert.strictEqual(
        adapter.schedulable,
        false,
        `${id} is flagged as a stub but is still schedulable; a fabricated result must never be routed to`
      );
      assert.ok(adapter.blocked_reason, `${id} must explain why it is excluded`);
    }
  }
});

// ------------------------------------------------------------------ EH-5
test('EH-5: the positive path works - with governance and a CLI, health flips to ok', () => {
  // Guard against the opposite failure: health must not simply always be false.
  const dir = mkdtempSync(join(tmpdir(), 'af-eh5-'));
  try {
    const canonical = join(dir, 'AGENTS.md');
    writeFileSync(canonical, 'GOVERNANCE\n');

    const probe = `
      const { ADAPTERS } = await import('file://${join(ROOT_DIR, 'lib/adapters.mjs')}');
      const out = {};
      for (const id of ['cline', 'command-code']) out[id] = ADAPTERS[id].health();
      process.stdout.write(JSON.stringify(out));
    `;
    const raw = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      env: { ...process.env, AF_CANONICAL_AGENTS_MD: canonical, AF_GLOBAL_DIR: '' },
    });
    const healths = JSON.parse(raw);

    // cline is installed on this host, so with governance provided it must be ok.
    let clineOnPath = false;
    try {
      execFileSync('sh', ['-c', 'command -v cline'], { stdio: 'ignore' });
      clineOnPath = true;
    } catch { /* not installed */ }
    if (clineOnPath) {
      assert.strictEqual(
        healths.cline.ok,
        true,
        `with governance provided, an installed executor must be healthy (reason: ${healths.cline.reason})`
      );
      assert.strictEqual(healths.cline.reason, null, 'a healthy executor needs no reason');
    }

    // command-code is installed too, and its CLI must also be resolvable.
    if (healths['command-code'].ok === false) {
      assert.match(
        String(healths['command-code'].reason),
        /governance|not found/,
        'an unhealthy executor must still explain itself precisely'
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ EH-6
test('EH-6: a non-schedulable executor is skipped by the router, not chosen', () => {
  // The router must fall THROUGH to the next candidate, which is what makes blocking
  // a stub safe rather than breaking every unrouted task.
  const route = resolveExecutorRoute({}, { adapters: ADAPTERS });
  assert.notStrictEqual(route.primary, 'vertex-gemini', 'the stub must not be selected');
  assert.ok(!route.fallbacks.includes('vertex-gemini'), 'and it must not appear as a fallback either');

  // Explicitly demanding it fails closed instead of silently running the stub.
  const explicit = resolveExecutorRoute({ author_executor: 'vertex-gemini' }, { adapters: ADAPTERS });
  assert.notStrictEqual(explicit.primary, 'vertex-gemini', 'an explicit request for a stub must fail closed');

  // And the deliberate opt-in still works for tests/dev, which is why the flag exists.
  const optedIn = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { ADAPTERS } = await import('file://${join(ROOT_DIR, 'lib/adapters.mjs')}');
    process.stdout.write(JSON.stringify({
      stub: ADAPTERS['vertex-gemini'].stub,
      schedulable: ADAPTERS['vertex-gemini'].schedulable !== false,
    }));
  `], { encoding: 'utf8', env: { ...process.env, AF_ALLOW_STUB_EXECUTORS: '1', AF_CANONICAL_AGENTS_MD: '' } });
  const flags = JSON.parse(optedIn);
  assert.strictEqual(flags.stub, false, 'AF_ALLOW_STUB_EXECUTORS=1 must clear the stub flag');
  assert.strictEqual(flags.schedulable, true, 'and make the stub schedulable again for deliberate use');
});