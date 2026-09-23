// af-exec-isolation.test.mjs - option-A (af-exec UID) capability probe must be fail-closed.
//
// The probe never escalates and never changes ownership; it only ANSWERS, and an unverifiable
// answer must be a refusal (never a silent downgrade to running executors as the control plane).

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeAfExecIsolation, assertAfExecIsolation, AF_EXEC_USER } from '../lib/af-exec-isolation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROVISION = join(ROOT, 'deploy', 'af-exec', 'provision.sh');

const capableDeps = {
  uid: () => 0,
  userExists: () => true,
  stat: () => ({ uid: 0, mode: 0o700 }),
  canDispatch: () => true,
};

test('AFX-1: a fully verifiable host reports capable with all four checks true', () => {
  const probe = probeAfExecIsolation({ deps: capableDeps });
  assert.strictEqual(probe.capable, true);
  assert.strictEqual(probe.reason, null);
  assert.deepStrictEqual(probe.checks.map((c) => c.id), [
    'A1-running-as-root', 'A2-af-exec-user-exists', 'A3-control-plane-root-owned', 'A4-dispatch-as-af-exec',
  ]);
  assert.ok(probe.checks.every((c) => c.ok === true));
});

test('AFX-2: a missing af-exec user is not capable (provisioning with root is required)', () => {
  const probe = probeAfExecIsolation({ deps: { ...capableDeps, userExists: () => false } });
  assert.strictEqual(probe.capable, false);
  assert.match(probe.reason, /A2-af-exec-user-exists/);
});

test('AFX-3: an unreadable user database is UNKNOWN, never "no" and never capable', () => {
  const probe = probeAfExecIsolation({ deps: { ...capableDeps, userExists: () => null } });
  assert.strictEqual(probe.capable, false, 'unknown must never be read as capable');
  const a2 = probe.checks.find((c) => c.id === 'A2-af-exec-user-exists');
  assert.strictEqual(a2.ok, 'unknown');
  assert.match(a2.detail, /unreadable/);
});

test('AFX-4: an unobtainable dispatch capability fails the gate with an explicit refusal', () => {
  const res = assertAfExecIsolation({ deps: { ...capableDeps, canDispatch: () => null } });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /refusal, not a downgrade/);
  assert.ok(res.checks.some((c) => c.id === 'A4-dispatch-as-af-exec' && c.ok === 'unknown'));
});

test('AFX-5: non-root ownership of the control plane blocks capability', () => {
  const res = assertAfExecIsolation({ deps: { ...capableDeps, stat: () => ({ uid: 1000, mode: 0o755 }) } });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /A3-control-plane-root-owned/);
});

test('AFX-6: the provision template is root-gated: it refuses as non-root and changes nothing', () => {
  const src = readFileSync(PROVISION, 'utf8');
  assert.match(src, /id -u/, 'the template must check uid');
  assert.match(src, /exit 3/, 'a non-root invocation must exit non-zero');
  assert.match(src, /--apply/, 'mutations must require an explicit --apply');

  // Run it exactly as a non-root user (the test's own uid) - it must refuse and print nothing scary.
  const res = spawnSync('sh', [PROVISION], { encoding: 'utf8' });
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    assert.strictEqual(res.status, 3, `expected a root refusal, got ${res.status}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /requires root/);
    assert.match(res.stderr, /Nothing was changed/);
  }
  assert.strictEqual(AF_EXEC_USER, 'af-exec');
});
