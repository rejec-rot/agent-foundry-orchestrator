// Browser one-click authorization is a process-local session; bearer credentials remain supported.
import './helpers/executors-fixture.mjs';
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startReadApi } from '../server/read-api.mjs';
import { createLocalWriteSessionAuth, LOCAL_SESSION_TTL_MS } from '../server/web-auth.mjs';
import { PROJECT_REGISTRY_SCHEMA } from '../lib/projects.mjs';
import { ADAPTERS } from '../lib/adapters.mjs';

for (const id of ['codex', 'cline', 'command-code']) {
  mock.method(ADAPTERS[id], 'health', () => ({ ok: true }));
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.AF_ACCEPTANCE_ALLOWLIST = process.env.AF_ACCEPTANCE_ALLOWLIST || join(ROOT, 'config', 'acceptance-allowlist.json');
const TOKEN = 'local-session-test-operator-token';
const started = [];

test('LOCALAUTH-8: authorization pages refuse embedding by another page', async () => {
  const fx = fixture();
  const handle = await serve(fx);
  try {
    for (const page of ['teams.html', 'workbench.html']) {
      const response = await fetch(`${handle.url}/${page}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
    }
    const status = (await (await fetch(`${handle.url}/api/v2/access/status`)).json()).model;
    assert.equal(status.authorized, false, 'loading a page does not grant access');
  } finally {
    await stop(handle);
    rmSync(fx.root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-local-session-'));
  const tasks = join(root, 'tasks');
  const target = join(root, 'target');
  const submissions = join(root, 'submissions');
  const locks = join(root, 'locks');
  for (const dir of [tasks, target, submissions, locks, join(root, 'runtime'), join(root, 'workspaces')]) mkdirSync(dir, { recursive: true });
  const registryFile = join(root, 'projects.json');
  writeFileSync(registryFile, JSON.stringify({
    schema_version: PROJECT_REGISTRY_SCHEMA,
    projects: [{
      project_id: 'local-session-project',
      root: target,
      workspace_root: join(root, 'workspaces'),
      policy: { allowed_root: ['**'], forbidden: [], protected_paths: [], projection: { exclude: [] }, import: { deny: [] } },
      acceptance_profiles: [{ profile_id: 'default', acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] }, assets: [] }],
    }],
  }, null, 2));
  return {
    root, tasks, target, submissions, locks, registryFile,
    roots: { tasks, locks, runtime: join(root, 'runtime'), alerts: join(root, 'alerts.jsonl') },
  };
}

async function serve(fx, options = {}) {
  const handle = await startReadApi({
    roots: fx.roots,
    allowedRoots: [fx.target],
    allowRecord: true,
    locksDir: fx.locks,
    token: { configured: true, token: TOKEN, source: 'test', reason: null },
    env: { ...process.env, AF_SUBMISSION_DIR: fx.submissions, AF_PROJECTS_FILE: fx.registryFile },
    spawnWorker: () => ({ pid: 4242 }),
    ...options,
  });
  started.push(handle);
  return handle;
}

async function stop(handle) {
  const index = started.indexOf(handle);
  if (index >= 0) started.splice(index, 1);
  await handle.close();
}

after(async () => { for (const handle of started) await handle.close(); });

const originOf = (url) => new URL(url).origin;
const controlHeaders = (url, extra = {}) => ({
  origin: originOf(url),
  'x-af-csrf': '1',
  'sec-fetch-site': 'same-origin',
  ...extra,
});
const post = (url, path, headers = {}, body = {}) => fetch(`${url}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const cookieFrom = (response) => response.headers.get('set-cookie')?.split(';', 1)[0] ?? null;
const taskSpec = (fx, key) => ({
  goal: 'add the hello module',
  target_path: fx.target,
  acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
  idempotency_key: key,
});

test('LOCALAUTH-1: one click grants an HttpOnly cookie that can create a task; regrant rotates it', async () => {
  const fx = fixture();
  try {
    const sessions = createLocalWriteSessionAuth({ maxSessions: 1 });
    const { url } = await serve(fx, { localSessionAuth: sessions });
    const before = (await (await fetch(`${url}/api/v2/access/status`)).json()).model;
    assert.deepEqual({ authorized: before.authorized, available: before.local_authorization_available }, { authorized: false, available: true });
    const caps = (await (await fetch(`${url}/api/v2/capabilities`)).json()).model;
    assert.equal(caps.local_access.available, true);

    const grant = await post(url, '/api/v2/access/authorize', controlHeaders(url));
    assert.equal(grant.status, 200, JSON.stringify(await grant.clone().json()));
    const firstCookie = cookieFrom(grant);
    assert.ok(firstCookie?.startsWith('af_local_session='));
    assert.match(grant.headers.get('set-cookie'), /HttpOnly/);
    assert.match(grant.headers.get('set-cookie'), /SameSite=Strict/);
    assert.match(grant.headers.get('set-cookie'), /Path=\//);
    assert.doesNotMatch(grant.headers.get('set-cookie'), /(?:Max-Age|Expires)=/i, 'the browser cookie is session-scoped');
    assert.ok(!JSON.stringify(await grant.json()).includes(TOKEN));

    const secondGrant = await post(url, '/api/v2/access/authorize', controlHeaders(url, { cookie: firstCookie }));
    assert.equal(secondGrant.status, 200, 'the current browser session can be replaced at the bounded session limit');
    const secondCookie = cookieFrom(secondGrant);
    assert.ok(secondCookie && secondCookie !== firstCookie);
    const oldReplay = await post(url, '/api/v2/tasks/create', controlHeaders(url, { cookie: firstCookie }), { spec: taskSpec(fx, 'old-cookie') });
    assert.equal(oldReplay.status, 401, 'a replaced nonce cannot be replayed');

    const status = (await (await fetch(`${url}/api/v2/access/status`, { headers: { cookie: secondCookie } })).json()).model;
    assert.equal(status.authorized, true);
    const created = await post(url, '/api/v2/tasks/create', controlHeaders(url, { cookie: secondCookie }), { spec: taskSpec(fx, 'cookie-create') });
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    assert.equal((await created.json()).model.created, true);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('LOCALAUTH-2: failed grant, foreign origin, missing CSRF, rebind, and tampering never authorize', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const grant = await post(url, '/api/v2/access/authorize', controlHeaders(url));
    assert.equal(grant.status, 200);
    const cookie = cookieFrom(grant);

    const foreign = await post(url, '/api/v2/access/authorize', { ...controlHeaders(url, { cookie }), origin: 'http://evil.example' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('set-cookie'), null, 'a failed grant leaves the existing cookie untouched');
    const noCsrf = await post(url, '/api/v2/access/authorize', { origin: originOf(url), cookie });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.headers.get('set-cookie'), null);
    const badFetchSite = await post(url, '/api/v2/access/authorize', controlHeaders(url, { cookie, 'sec-fetch-site': 'same-site' }));
    assert.equal(badFetchSite.status, 403);

    const port = new URL(url).port;
    const reboundUrl = `http://localhost:${port}`;
    const rebound = await post(reboundUrl, '/api/v2/tasks/create', controlHeaders(reboundUrl, { cookie }), { spec: taskSpec(fx, 'rebound-cookie') });
    assert.equal(rebound.status, 403);
    assert.match((await rebound.json()).model.reason, /bound to a different local origin/);

    const tamperedCookie = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`;
    const tampered = await post(url, '/api/v2/tasks/create', controlHeaders(url, { cookie: tamperedCookie }), { spec: taskSpec(fx, 'tampered-cookie') });
    assert.equal(tampered.status, 401);
    assert.equal((await (await fetch(`${url}/api/v2/access/status`, { headers: { cookie: tamperedCookie } })).json()).model.authorized, false);

    const createWithOriginal = await post(url, '/api/v2/tasks/create', controlHeaders(url, { cookie }), { spec: taskSpec(fx, 'original-cookie') });
    assert.equal(createWithOriginal.status, 201, 'rejected grant attempts do not revoke the prior valid session');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('LOCALAUTH-3: logout revokes the nonce server-side and clears the browser cookie', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const grant = await post(url, '/api/v2/access/authorize', controlHeaders(url));
    const cookie = cookieFrom(grant);
    const revoke = await post(url, '/api/v2/access/revoke', controlHeaders(url, { cookie }));
    assert.equal(revoke.status, 200, JSON.stringify(await revoke.clone().json()));
    assert.match(revoke.headers.get('set-cookie'), /Max-Age=0/);
    const replay = await post(url, '/api/v2/tasks/create', controlHeaders(url, { cookie }), { spec: taskSpec(fx, 'revoked-cookie') });
    assert.equal(replay.status, 401, 'replaying a saved cookie after logout is refused');
    const status = (await (await fetch(`${url}/api/v2/access/status`, { headers: { cookie } })).json()).model;
    assert.equal(status.authorized, false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('LOCALAUTH-4: read-only and missing-token servers never grant local sessions', async () => {
  const fx = fixture();
  try {
    const noToken = await serve(fx, { token: { configured: false, token: null, source: null, reason: 'no token configured' } });
    const noTokenCaps = (await (await fetch(`${noToken.url}/api/v2/capabilities`)).json()).model;
    assert.equal(noTokenCaps.local_access.available, false);
    assert.equal(noTokenCaps.local_access.reason_code, 'server_credentials_missing');
    assert.equal((await post(noToken.url, '/api/v2/access/authorize', controlHeaders(noToken.url))).status, 403);
    const denied = await post(noToken.url, '/api/v2/tasks/create', controlHeaders(noToken.url), { spec: taskSpec(fx, 'no-token') });
    assert.equal(denied.status, 403);
    await stop(noToken);

    const readOnly = await serve(fx, { allowRecord: false });
    const readOnlyCaps = (await (await fetch(`${readOnly.url}/api/v2/capabilities`)).json()).model;
    assert.equal(readOnlyCaps.local_access.available, false);
    assert.equal(readOnlyCaps.local_access.reason_code, 'write_routes_disabled');
    assert.equal((await post(readOnly.url, '/api/v2/access/authorize', controlHeaders(readOnly.url))).status, 403);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('LOCALAUTH-5: sessions expire after eight hours and a server restart invalidates cookies', async () => {
  const fx = fixture();
  try {
    let currentTime = Date.now();
    const { url } = await serve(fx, { now: () => currentTime });
    const grant = await post(url, '/api/v2/access/authorize', controlHeaders(url));
    const cookie = cookieFrom(grant);
    assert.doesNotMatch(grant.headers.get('set-cookie'), /(?:Max-Age|Expires)=/i);
    currentTime += LOCAL_SESSION_TTL_MS;
    const expiredStatus = (await (await fetch(`${url}/api/v2/access/status`, { headers: { cookie } })).json()).model;
    assert.equal(expiredStatus.authorized, false);
    const expiredWrite = await post(url, '/api/v2/tasks/create', controlHeaders(url, { cookie }), { spec: taskSpec(fx, 'expired-cookie') });
    assert.equal(expiredWrite.status, 401);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }

  const restartFx = fixture();
  try {
    const first = await serve(restartFx);
    const firstGrant = await post(first.url, '/api/v2/access/authorize', controlHeaders(first.url));
    const oldCookie = cookieFrom(firstGrant);
    const fixedPort = first.port;
    await stop(first);
    const restarted = await serve(restartFx, { port: fixedPort });
    const replay = await post(restarted.url, '/api/v2/tasks/create', controlHeaders(restarted.url, { cookie: oldCookie }), { spec: taskSpec(restartFx, 'restart-cookie') });
    assert.equal(replay.status, 401, 'the process-local HMAC key and nonce table do not survive restart');
  } finally { rmSync(restartFx.root, { recursive: true, force: true }); }
});

test('LOCALAUTH-6: a non-loopback HTTP client cannot bootstrap a cookie, while bearer status remains compatible', async (t) => {
  const fx = fixture();
  try {
    const address = Object.values(networkInterfaces()).flat().find((entry) => entry && !entry.internal && entry.family === 'IPv4')?.address;
    if (!address) return t.skip('no non-loopback IPv4 interface is available for this HTTP check');
    const handle = await serve(fx, { host: '0.0.0.0' });
    const port = handle.port;
    const remoteUrl = `http://${address}:${port}`;
    const localHost = `127.0.0.1:${port}`;
    const remoteGrant = await post(remoteUrl, '/api/v2/access/authorize', {
      host: localHost,
      origin: `http://${localHost}`,
      'x-af-csrf': '1',
      'sec-fetch-site': 'same-origin',
    });
    assert.equal(remoteGrant.status, 403);
    assert.equal(cookieFrom(remoteGrant), null);

    const bearerStatus = (await (await fetch(`${remoteUrl}/api/v2/access/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).model;
    assert.equal(bearerStatus.authorized, true, 'legacy bearer status remains usable over an explicitly remote bind');
    assert.equal(bearerStatus.local_authorization_available, false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('LOCALAUTH-7: legacy bearer writes still work without changing their existing Origin behavior', async () => {
  const fx = fixture();
  try {
    const { url } = await serve(fx);
    const created = await post(url, '/api/v2/tasks/create', {
      authorization: `Bearer ${TOKEN}`,
      'x-af-csrf': '1',
    }, { spec: taskSpec(fx, 'legacy-bearer') });
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    assert.equal((await created.json()).model.created, true);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
