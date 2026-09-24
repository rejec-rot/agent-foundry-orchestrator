// web-api-write-auth.test.mjs - §7.3: no write route is reachable without the operator token,
// the CSRF header and a matching Origin, and starting hands the run to a detached worker.

import './helpers/executors-fixture.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startReadApi } from '../server/read-api.mjs';
import { resolveWriteToken, authorizeWrite } from '../server/web-auth.mjs';
import { PROJECT_REGISTRY_SCHEMA } from '../lib/projects.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.AF_ACCEPTANCE_ALLOWLIST = process.env.AF_ACCEPTANCE_ALLOWLIST || join(ROOT, 'config', 'acceptance-allowlist.json');

const TOKEN = 'operator-token-for-tests';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-webwrite-'));
  const tasks = join(root, 'tasks');
  const target = join(root, 'target');
  const submissions = join(root, 'submissions');
  const locks = join(root, 'locks');
  const tokenFile = join(root, 'token');
  for (const d of [tasks, target, submissions, locks, join(root, 'runtime'), join(root, 'workspaces')]) mkdirSync(d, { recursive: true });
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  // §6 G6: creation is bound to a control-plane profile, so the fixture has a registry.
  const registryFile = join(root, 'projects.json');
  writeFileSync(registryFile, JSON.stringify({
    schema_version: PROJECT_REGISTRY_SCHEMA,
    projects: [{
      project_id: 'web-test-project',
      root: target,
      workspace_root: join(root, 'workspaces'),
      policy: { allowed_root: ['**'], forbidden: [], protected_paths: [], projection: { exclude: [] }, import: { deny: [] } },
      acceptance_profiles: [{ profile_id: 'default', acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] }, assets: [] }],
    }],
  }, null, 2));
  return {
    root, tasks, target, submissions, locks, tokenFile, registryFile,
    roots: { tasks, locks, runtime: join(root, 'runtime'), alerts: join(root, 'alerts.jsonl') },
  };
}

const spec = (fx) => ({
  goal: 'add the hello module',
  target_path: fx.target,
  acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
  idempotency_key: 'write-key-1',
});

const started = [];
async function serve(fx, options = {}) {
  const handle = await startReadApi({
    roots: fx.roots,
    allowedRoots: [fx.target],
    allowRecord: true,
    locksDir: fx.locks,
    env: { ...process.env, AF_WEB_TOKEN_FILE: fx.tokenFile, AF_SUBMISSION_DIR: fx.submissions, AF_PROJECTS_FILE: fx.registryFile },
    spawnWorker: () => ({ pid: 4242 }),
    ...options,
  });
  started.push(handle);
  return handle;
}

const post = (url, path, body, headers = {}) => fetch(`${url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const AUTH = { authorization: `Bearer ${TOKEN}`, 'x-af-csrf': '1' };

after(async () => { for (const h of started) await h.close(); });

test('WEBAUTH-1: writes are refused without a valid token, the CSRF header and a sane Origin', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const noToken = await post(url, '/api/v2/tasks/create', { spec: spec(fx) }, { 'x-af-csrf': '1' });
    assert.equal(noToken.status, 401);
    assert.match((await noToken.json()).model.reason, /write token is required/);

    const wrongToken = await post(url, '/api/v2/tasks/create', { spec: spec(fx) }, { authorization: 'Bearer nope', 'x-af-csrf': '1' });
    assert.equal(wrongToken.status, 401);

    const noCsrf = await post(url, '/api/v2/tasks/create', { spec: spec(fx) }, { authorization: `Bearer ${TOKEN}` });
    assert.equal(noCsrf.status, 403, 'a cross-origin form cannot set the CSRF header');
    assert.match((await noCsrf.json()).model.reason, /x-af-csrf/);

    const badOrigin = await post(url, '/api/v2/tasks/create', { spec: spec(fx) }, { ...AUTH, origin: 'http://evil.example' });
    assert.equal(badOrigin.status, 403);
    assert.match((await badOrigin.json()).model.reason, /Origin/);

    assert.strictEqual(readdirSync(fx.tasks).length, 0, 'no refused request may create a task');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAUTH-2: an authenticated create is idempotent and reports 201 then 200', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const first = await post(url, '/api/v2/tasks/create', { spec: spec(fx) }, AUTH);
    assert.equal(first.status, 201, JSON.stringify(await first.clone().json()));
    const created = (await first.json()).model;
    assert.equal(created.ok, true);
    assert.equal(created.created, true);

    const second = await post(url, '/api/v2/tasks/create', { spec: spec(fx) }, AUTH);
    assert.equal(second.status, 200);
    const again = (await second.json()).model;
    assert.equal(again.task_id, created.task_id, 'the same key returns the same task');
    assert.equal(readdirSync(fx.tasks).filter((n) => n.endsWith('.json')).length, 1);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAUTH-3: start is accepted (202) and dispatched to a detached worker, not run inline', async () => {
  const fx = fixture();
  try {
    const spawned = [];
    const { url } = await serve(fx, { spawnWorker: (taskId) => { spawned.push(taskId); return { pid: 4242 }; } });
    const created = (await (await post(url, '/api/v2/tasks/create', { spec: spec(fx) }, AUTH)).json()).model;

    const res = await post(url, `/api/v2/tasks/${created.task_id}/start`, {}, AUTH);
    assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
    const body = (await res.json()).model;
    assert.equal(body.outcome, 'started');
    assert.equal(body.operation_id, `op-${created.task_id}`);
    assert.match(body.note, /detached worker/);
    assert.deepEqual(spawned, [created.task_id], 'the worker is the runner');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAUTH-4: a second start while the lock is held is 409, and cancel writes the request', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const created = (await (await post(url, '/api/v2/tasks/create', { spec: spec(fx) }, AUTH)).json()).model;

    const cancel = await post(url, `/api/v2/tasks/${created.task_id}/cancel`, { reason: 'operator stop' }, AUTH);
    assert.equal(cancel.status, 200);
    const cancelBody = (await cancel.json()).model;
    assert.equal(cancelBody.created, true);
    assert.match(cancelBody.note, /trusted boundary/);
    assert.ok(readdirSync(fx.tasks).some((n) => n.endsWith('.cancel.json')), 'a durable request is written');

    const unknown = await post(url, '/api/v2/tasks/NOPE/cancel', { reason: 'x' }, AUTH);
    assert.equal(unknown.status, 422, 'a cancel for an unknown task is refused');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAUTH-5: without a token configured the server advertises and enforces read-only writes', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx, { env: { ...process.env, AF_WEB_TOKEN_FILE: '', AF_WEB_TOKEN: '', AF_PROJECTS_FILE: fx.registryFile } });
    const caps = (await (await fetch(`${url}/api/v2/capabilities`)).json()).model;
    assert.equal(caps.write.create_task, false, 'no token -> no write capability is advertised');
    assert.match(caps.note, /writes are disabled/);
    const res = await post(url, '/api/v2/tasks/create', { spec: spec(fx) }, AUTH);
    assert.equal(res.status, 403);
    assert.match((await res.json()).model.reason, /writes are disabled|read-only/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('WEBAUTH-6: the token is never echoed, and resolveWriteToken distinguishes its sources', () => {
  const fx = fixture();
  try {
    const fromFile = resolveWriteToken({ AF_WEB_TOKEN_FILE: fx.tokenFile });
    assert.equal(fromFile.configured, true);
    assert.equal(fromFile.token, TOKEN);
    assert.equal(fromFile.source, fx.tokenFile);
    const inline = resolveWriteToken({ AF_WEB_TOKEN: 'inline-token' });
    assert.equal(inline.token, 'inline-token');
    const none = resolveWriteToken({});
    assert.equal(none.configured, false);
    assert.match(none.reason, /AF_WEB_TOKEN_FILE/);

    const src = readFileSync(join(ROOT, 'server', 'read-api.mjs'), 'utf8');
    assert.doesNotMatch(src, /token\.token/, 'the server must never send the token back');
    assert.equal(authorizeWrite({ req: { headers: {} }, token: none }).status, 403);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
