// web-api-readonly.test.mjs - the browser-facing V2 API must be read-only, contained and redacted.
//
// It is the first surface a browser talks to, so the guarantees are asserted directly: no mutating
// route exists, every response is a redacted projection (never whole task JSON), a path that
// escapes the web root is refused, an unknown task is 404 (not "no tasks"), and the default bind
// is loopback.

import './helpers/executors-fixture.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startReadApi } from '../server/read-api.mjs';

const TASK_SECRET = 'super-secret-value-that-must-not-leak';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-webapi-'));
  const tasks = join(root, 'tasks');
  mkdirSync(tasks, { recursive: true });
  mkdirSync(join(root, 'locks'), { recursive: true });
  mkdirSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(join(tasks, 'TASK-WEB-1.json'), JSON.stringify({
    task_id: 'TASK-WEB-1',
    state: 'COMPLETED',
    state_version: 3,
    goal: 'add a hello module',
    author_executor: 'codex',
    reviewer_executor: 'claude',
    token: TASK_SECRET,
    trusted_import: { enabled: true, phase: 'PROMOTED', boundary_state: 'DISENGAGED' },
  }, null, 2));
  // The read model expects the full root set (tasks, locks, runtime, alerts) - the same shape
  // resolveDataRoots() produces.
  return {
    root,
    tasks,
    roots: {
      tasks,
      locks: join(root, 'locks'),
      runtime: join(root, 'runtime'),
      alerts: join(root, 'alerts.jsonl'),
    },
  };
}

const started = [];
async function serve(fx) {
  const handle = await startReadApi({ roots: fx.roots });
  started.push(handle);
  return handle;
}

after(async () => { for (const h of started) await h.close(); });

test('WEBAPI-1: the read routes answer with a redacted projection', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    for (const path of ['/api/v2/capabilities', '/api/v2/tasks', '/api/v2/tasks/TASK-WEB-1', '/api/v2/tasks/TASK-WEB-1/evidence', '/api/v2/exceptions', '/api/v2/executors', '/api/v2/environment']) {
      const res = await fetch(`${url}${path}`);
      assert.equal(res.status, 200, `${path} should be readable`);
      const body = await res.json();
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(typeof body.model, 'object', `${path} must return the redaction envelope`);
      assert.equal(body.path_mode, 'hash', 'paths must be hashed by default');
      assert.ok(body.model.schema || body.model.blocks, `${path} must carry a schema or blocks`);
    }
    const list = (await (await fetch(`${url}/api/v2/tasks`)).json()).model;
    assert.equal(list.blocks.tasks.read_status, 'ok');
    assert.equal(list.tasks.length, 1);
    assert.equal(list.page.total, 1);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAPI-2: there is no mutating route - any non-GET is refused', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${url}/api/v2/tasks`, { method, body: '{}' });
      assert.equal(res.status, 405, `${method} must be refused`);
      assert.equal(res.headers.get('allow'), 'GET');
      const body = await res.json();
      assert.match(body.reason, /read-only/);
    }
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAPI-3: an unknown task is 404 with an explicit reason, never a silent empty answer', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const res = await fetch(`${url}/api/v2/tasks/TASK-DOES-NOT-EXIST`);
    assert.equal(res.status, 404);
    const body = (await res.json()).model;
    assert.equal(body.blocks.task.read_status, 'missing');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAPI-4: secrets and raw paths are redacted by default, and hashing is on', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const res = await fetch(`${url}/api/v2/tasks/TASK-WEB-1`);
    const text = await res.text();
    assert.doesNotMatch(text, new RegExp(TASK_SECRET), 'a sensitive field must never reach the browser');
    assert.doesNotMatch(text, new RegExp(fx.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'host paths must be hashed by default');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAPI-5: static assets are served, but only from the web root', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const index = await fetch(`${url}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /只读/);

    const escape = await fetch(`${url}/..%2f..%2fetc%2fpasswd`);
    assert.ok(escape.status === 403 || escape.status === 404, `a traversal attempt must be refused, got ${escape.status}`);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAPI-6: the default bind is loopback and the capabilities are honest about writes', async () => {
  const fx = fixture();
  try {
    const handle = await serve(fx);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:/, 'the API must bind to loopback by default');
    const caps = (await (await fetch(`${handle.url}/api/v2/capabilities`)).json()).model;
    assert.ok(Object.values(caps.write).every((v) => v === false), 'no write capability may be advertised in this slice');
    assert.equal(caps.read.task_list, true);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAPI-EXEC: the executor panel reflects the operator disable list, not just the registry', async () => {
  // The deployed registry answers "can this executor run"; the operator's restriction file answers
  // "may it". Reporting AVAILABLE for an executor the platform will refuse is a false statement.
  const fx = fixture();
  const file = join(fx.root, 'operator-executors.json');
  writeFileSync(file, JSON.stringify({ disabled: ['codex'], reason: 'test: no quota' }));
  const previous = process.env.AF_OPERATOR_EXECUTORS_FILE;
  process.env.AF_OPERATOR_EXECUTORS_FILE = file;
  try {
    const { url } = await serve(fx);
    const payload = await (await fetch(`${url}/api/v2/executors`)).json();
    const model = payload.model ?? payload;
    const entries = model.entries ?? model.executors ?? [];
    const codex = entries.find((e) => e.id === 'codex');
    assert.ok(codex, 'the panel must still LIST the executor (hiding it would be a different lie)');
    assert.equal(codex.availability, 'DISABLED_BY_OPERATOR');
    assert.match(String(codex.reason), /disabled by the operator/);
    const others = entries.filter((e) => e.id !== 'codex');
    assert.ok(others.every((e) => e.availability !== 'DISABLED_BY_OPERATOR'), 'only the disabled one is marked');
  } finally {
    if (previous === undefined) delete process.env.AF_OPERATOR_EXECUTORS_FILE;
    else process.env.AF_OPERATOR_EXECUTORS_FILE = previous;
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('WEBAPI-LIST: the task lane projection carries goal/phase and never the whole record', async () => {
  // The operator scans WHAT each task is doing; an id alone cannot be scanned. That is a deliberate
  // widening of the whitelist, so it is pinned: the two fields are present, and the record's own
  // internals (policy, acceptance, digests) stay out of the browser payload.
  const fx = fixture();
  const tasksDir = fx.roots.tasks;
  writeFileSync(join(tasksDir, 'TASK-LANE.json'), JSON.stringify({
    task_id: 'TASK-LANE',
    state: 'COMPLETED',
    state_version: 9,
    goal: 'ship the lane projection',
    author_executor: 'command-code',
    reviewer_executor: 'cline',
    trusted_import: {
      enabled: true,
      phase: 'PROMOTED',
      policy: { allowed_root: ['secret/**'] },
      acceptance: { acceptance_profile_digest: 'do-not-send-this' },
      candidate_dir: '/tmp/private/candidate',
    },
  }, null, 2));
  try {
    const { url } = await serve(fx);
    const payload = await (await fetch(`${url}/api/v2/tasks`)).json();
    const model = payload.model ?? payload;
    const row = (model.tasks ?? []).find((t) => t.task_id === 'TASK-LANE');
    assert.ok(row, 'the task must appear in the lane');
    assert.equal(row.goal, 'ship the lane projection');
    assert.equal(row.phase, 'PROMOTED');
    assert.equal(row.author_executor, 'command-code');
    assert.equal(row.state_version, 9);
    const blob = JSON.stringify(row);
    for (const forbidden of ['do-not-send-this', '/tmp/private', 'allowed_root', 'trusted_import']) {
      assert.equal(blob.includes(forbidden), false, `the lane must not carry ${forbidden}`);
    }
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
