// web-api-actions.test.mjs - the two designed POST routes, and the fact that NOTHING else exists.
//
// P2 deliberately stops at "preflight + record" (a record is PREPARED and started=false) and P3 at
// a READ-ONLY recovery plan: cancelling needs the G4 race work and starting needs an explicit
// operator authorisation, so neither has a route. These assertions pin that boundary.

import './helpers/executors-fixture.mjs'; // MUST precede lib/config.mjs: the registry path is resolved at load
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startReadApi } from '../server/read-api.mjs';

process.env.AF_ACCEPTANCE_ALLOWLIST = process.env.AF_ACCEPTANCE_ALLOWLIST || join(process.cwd(), 'config', 'acceptance-allowlist.json');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-webact-'));
  const tasks = join(root, 'tasks');
  const target = join(root, 'target');
  const submissions = join(root, 'submissions');
  for (const d of [tasks, join(root, 'locks'), join(root, 'runtime'), target, submissions]) mkdirSync(d, { recursive: true });
  writeFileSync(join(tasks, 'TASK-WEBACT-1.json'), JSON.stringify({
    task_id: 'TASK-WEBACT-1', state: 'WAITING_HUMAN', state_version: 5,
    trusted_import: { enabled: true, phase: 'WAITING_HUMAN', pending_human_decisions: [{ path: 'SECURITY.md', action: 'MODIFY', band: 'D', decision: 'WAITING_HUMAN' }] },
  }, null, 2));
  const roots = { tasks, locks: join(root, 'locks'), runtime: join(root, 'runtime'), alerts: join(root, 'alerts.jsonl') };
  return { root, tasks, target, submissions, roots };
}

const spec = (target, extra = {}) => ({
  goal: 'add a hello module',
  target_path: target,
  acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
  idempotency_key: 'web-key-1',
  ...extra,
});

const started = [];
async function serve(fx, options = {}) {
  const handle = await startReadApi({ roots: fx.roots, allowedRoots: [fx.target], ...options });
  started.push(handle);
  return handle;
}

const post = (url, path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

after(async () => { for (const h of started) await h.close(); });

test('WEBACT-1: preflight returns the canonical capsule without writing anything', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const res = await post(url, '/api/v2/tasks/preflight', { spec: spec(fx.target) });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const model = (await res.json()).model;
    assert.equal(model.ok, true);
    assert.equal(model.started, false);
    assert.deepStrictEqual(Object.keys(model.capsule).sort(), ['acceptance', 'goal', 'target_path']);
    assert.equal(readdirSync(fx.submissions).length, 0, 'a preflight must not create a record');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBACT-2: preflight refuses forged platform fields and an out-of-root target', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const forged = await post(url, '/api/v2/tasks/preflight', { spec: spec(fx.target, { role: 'author' }) });
    assert.equal(forged.status, 422);
    assert.match((await forged.json()).model.reason, /PLATFORM_BOUND_FIELD_REJECTED|GOVERNANCE_FIELD_REJECTED/);

    const outside = await post(url, '/api/v2/tasks/preflight', { spec: spec('/etc') });
    assert.equal(outside.status, 422);
    assert.match((await outside.json()).model.reason, /outside|root/i);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBACT-3: record is refused on a read-only server and never starts anything when enabled', async () => {
  const fx = fixture();
  try {
    const readOnly = await serve(fx);
    const refused = await post(readOnly.url, '/api/v2/tasks/record', { spec: spec(fx.target) });
    assert.equal(refused.status, 403, 'record must be opt-in');
    assert.match((await refused.json()).model.reason, /read-only|--allow-write/);

    const w = await serve(fx, { allowRecord: true, env: { ...process.env, AF_SUBMISSION_DIR: fx.submissions } });
    // (the server forwards `env`, so the record lands in this fixture rather than the repo)
    const first = await post(w.url, '/api/v2/tasks/record', { spec: spec(fx.target) });
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    const record = (await first.json()).model;
    assert.equal(record.record.state, 'PREPARED');
    assert.equal(record.record.started, false, 'recording must never start a task');

    const dup = await post(w.url, '/api/v2/tasks/record', { spec: spec(fx.target) });
    assert.equal(dup.status, 200);
    assert.equal((await dup.json()).model.duplicate, true);
    const files = readdirSync(fx.submissions).filter((n) => n.endsWith('.json'));
    assert.equal(files.length, 1, 'exactly one record');
    assert.equal(JSON.parse(readFileSync(join(fx.submissions, files[0]), 'utf8')).started, false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBACT-4: the recovery plan is read-only, version-checked, and names the Human Gate path', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const ok = await post(url, '/api/v2/tasks/TASK-WEBACT-1/recovery-plan', { expected_state_version: 5 });
    assert.equal(ok.status, 200);
    const model = (await ok.json()).model;
    assert.equal(model.executable, false, 'the plan must never be executable from the browser');
    assert.equal(model.plan.recovery_class, 'V2_HUMAN_GATE');
    assert.match(model.plan.recommended_action, /gate-resume/);

    const stale = await post(url, '/api/v2/tasks/TASK-WEBACT-1/recovery-plan', { expected_state_version: 1 });
    assert.equal(stale.status, 409, 'a stale expected_state_version must be refused');
    assert.equal((await stale.json()).model.state_version, 5);

    const missing = await post(url, '/api/v2/tasks/NOPE/recovery-plan', {});
    assert.equal(missing.status, 404);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBACT-5: no other mutating route exists (start/cancel/approve/promote have none)', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx, { allowRecord: true });
    for (const path of ['/api/v2/tasks', '/api/v2/tasks/TASK-WEBACT-1/cancel', '/api/v2/tasks/TASK-WEBACT-1/recover', '/api/v2/tasks/TASK-WEBACT-1/approve', '/api/v2/tasks/TASK-WEBACT-1/promote']) {
      const res = await post(url, path, {});
      assert.equal(res.status, 405, `${path} must not be a route`);
    }
    const caps = (await (await fetch(`${url}/api/v2/capabilities`)).json()).model;
    assert.equal(caps.write.start_task, false);
    assert.equal(caps.write.cancel_task, false);
    assert.equal(caps.write.approve_human_gate, false);
    assert.equal(caps.write.record_task, true, 'the capability must reflect the server flag');

    const src = readFileSync(join(process.cwd(), 'server', 'read-api.mjs'), 'utf8');
    assert.doesNotMatch(src, /submitTask\s*\(/, 'the API must not call submitTask');
    assert.doesNotMatch(src, /executeTask\s*\(/, 'the API must not call executeTask');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBACT-6: an oversized body is refused', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const big = { spec: { ...spec(fx.target), context: 'x'.repeat(80 * 1024) } };
    const res = await post(url, '/api/v2/tasks/preflight', big);
    assert.equal(res.status, 413);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
