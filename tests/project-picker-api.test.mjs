import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers/team-fixture.mjs';
import { startReadApi } from '../server/read-api.mjs';
import { loadProjectRegistry, PROJECT_REGISTRY_SCHEMA } from '../lib/projects.mjs';

const TOKEN = 'project-picker-test-token';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'x-af-csrf': '1' };
const ALLOWLIST = join(process.cwd(), 'config', 'acceptance-allowlist.json');

function post(url, body, headers = AUTH) {
  return fetch(`${url}/api/v2/projects/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

async function setup({ acceptanceFile = null, assets = [], allowRecord = true, extraProject = null, registrySymlink = false } = {}) {
  const fx = fixture();
  const browseRoot = join(fx.root, 'browse');
  const selectedRoot = join(browseRoot, 'new-project');
  const registryFile = join(fx.root, 'projects.json');
  const registryTargetFile = registrySymlink ? join(fx.root, 'projects-target.json') : registryFile;
  const workspaceRoot = join(fx.root, 'v2-workspaces');
  mkdirSync(join(selectedRoot, 'tests'), { recursive: true });
  if (acceptanceFile !== null) {
    writeFileSync(join(fx.repo, 'tests', 'gate.test.mjs'), acceptanceFile);
    writeFileSync(join(selectedRoot, 'tests', 'gate.test.mjs'), acceptanceFile);
  } else {
    writeFileSync(join(selectedRoot, 'tests', 'gate.test.mjs'), readFileSync(join(fx.repo, 'tests', 'gate.test.mjs')));
  }
  const projects = [{
    project_id: 'template-project', root: fx.repo,
    tier: 'TierB',
    policy: { allowed_root: ['src/**', 'tests/**'], forbidden: ['secrets/**'], protected_paths: [], projection: { exclude: [] }, import: { deny: [] } },
    acceptance_profiles: [{ profile_id: 'unit-tests', acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] }, assets }],
  }, ...(extraProject ? [extraProject] : [])];
  writeFileSync(registryTargetFile, JSON.stringify({ schema_version: PROJECT_REGISTRY_SCHEMA, projects }));
  if (registrySymlink) symlinkSync(registryTargetFile, registryFile);
  const server = await startReadApi({
    roots: { tasks: fx.options.tasksDir, locks: fx.options.locksDir, runtime: fx.options.runtimeDir, alerts: join(fx.root, 'alerts.jsonl') },
    allowedRoots: [fx.options.tasksDir], allowRecord, redact: true, ensureController: null,
    env: {
      ...process.env, AF_WEB_TOKEN: TOKEN, AF_WEB_TOKEN_FILE: '', AF_PROJECTS_FILE: registryFile,
      AF_PROJECT_BROWSE_ROOT: browseRoot, AF_V2_WORKSPACE_ROOT: workspaceRoot,
      AF_ACCEPTANCE_ALLOWLIST: ALLOWLIST, AF_SUBMISSION_DIR: join(fx.options.runtimeDir, 'submissions'),
    },
  });
  return { fx, browseRoot, selectedRoot, registryFile, registryTargetFile, workspaceRoot, server, cleanup: async () => { await server.close(); fx.cleanup(); } };
}

test('project directory browsing requires token and CSRF, stays below the configured root, and returns canonical paths', async () => {
  const fx = await setup();
  const outside = join(fx.fx.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(fx.browseRoot, 'escape'));
  try {
    const path = '/api/v2/project-directories';
    assert.equal((await fetch(fx.server.url + path)).status, 401);
    assert.equal((await fetch(fx.server.url + path, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 403);
    assert.equal((await fetch(fx.server.url + path, { headers: { ...AUTH, origin: 'http://evil.example' } })).status, 403);

    const response = await fetch(fx.server.url + path, { headers: AUTH });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.paths_redacted, false);
    assert.equal(body.model.schema, 'af-v2-project-directories-v1');
    assert.equal(body.model.browse_root, fx.browseRoot);
    assert.equal(body.model.current_path, fx.browseRoot);
    assert.equal(body.model.parent_path, null);
    assert.equal(body.model.entries.find((entry) => entry.name === 'new-project').path, fx.selectedRoot);
    assert.equal(body.model.entries.some((entry) => entry.name === 'escape'), false, 'a symlink to an external directory is hidden');

    const child = await fetch(`${fx.server.url}${path}?path=${encodeURIComponent(fx.selectedRoot)}`, { headers: AUTH });
    assert.equal(child.status, 200);
    assert.equal((await child.json()).model.current_path, fx.selectedRoot);
    const escape = await fetch(`${fx.server.url}${path}?path=${encodeURIComponent(outside)}`, { headers: AUTH });
    assert.equal(escape.status, 403);
  } finally { await fx.cleanup(); }
});

test('project registration copies only a selected trusted profile, verifies its file assets, and never runs acceptance', async () => {
  const marker = join('/tmp', `af-project-picker-${process.pid}-acceptance-ran`);
  rmSync(marker, { force: true });
  const source = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`;
  const asset = { asset_id: 'tests/gate.test.mjs', digest: createHash('sha256').update(source).digest('hex') };
  const fx = await setup({ acceptanceFile: source, assets: [asset] });
  try {
    const projectsBefore = readFileSync(fx.registryFile, 'utf8');
    const listed = await fetch(fx.server.url + '/api/v2/projects');
    const registryDigest = (await listed.json()).model.registry_digest;
    const payload = {
      root: fx.selectedRoot, project_id: 'new-project', template_project_id: 'template-project',
      template_profile_id: 'unit-tests', expected_registry_digest: registryDigest,
    };
    const unauthorized = await post(fx.server.url, payload, {});
    assert.equal(unauthorized.status, 401);
    const noCsrf = await post(fx.server.url, payload, { authorization: `Bearer ${TOKEN}` });
    assert.equal(noCsrf.status, 403);
    const forged = await post(fx.server.url, { ...payload, acceptance: { command: 'sh', args: ['-c', 'touch /tmp/pwned'] } });
    assert.equal(forged.status, 422);
    assert.equal(readFileSync(fx.registryFile, 'utf8'), projectsBefore, 'rejected fields never rewrite the registry');

    const beforeTasks = readdirSync(fx.fx.options.tasksDir).sort();
    const response = await post(fx.server.url, payload);
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    const body = await response.json();
    assert.equal(body.paths_redacted, false);
    assert.deepEqual(body.model.project, { project_id: 'new-project', root: fx.selectedRoot, profiles: ['unit-tests'] });
    assert.deepEqual(body.model.template, { project_id: 'template-project', profile_id: 'unit-tests' });
    assert.equal(existsSync(marker), false, 'registration checks trust metadata without executing the acceptance command');
    assert.deepEqual(readdirSync(fx.fx.options.tasksDir).sort(), beforeTasks, 'registration does not create a task');

    const loaded = loadProjectRegistry({ file: fx.registryFile });
    assert.equal(loaded.ok, true);
    const registered = loaded.registry.projects.find((project) => project.project_id === 'new-project');
    assert.equal(registered.root, fx.selectedRoot);
    assert.equal(registered.workspace_root, fx.workspaceRoot);
    assert.equal(registered.tier, 'TierB');
    assert.deepEqual(registered.policy.forbidden, ['secrets/**']);
    assert.deepEqual(registered.acceptance_profiles[0], {
      profile_id: 'unit-tests', acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] }, assets: [asset],
    });

    const browsedProject = await fetch(`${fx.server.url}/api/v2/project-directories?path=${encodeURIComponent(fx.selectedRoot)}`, { headers: AUTH });
    assert.equal((await browsedProject.json()).model.current_project_id, 'new-project');
    const parentBrowse = await fetch(fx.server.url + '/api/v2/project-directories', { headers: AUTH });
    assert.equal((await parentBrowse.json()).model.entries.find((entry) => entry.name === 'new-project').project_id, 'new-project');

    const repeated = await post(fx.server.url, payload);
    assert.equal(repeated.status, 200, 'a lost-response retry with the same payload is safely idempotent despite its stale digest');
    assert.equal((await repeated.json()).model.project.project_id, 'new-project');
    assert.equal(loadProjectRegistry({ file: fx.registryFile }).digest, loaded.digest, 'an idempotent retry does not rewrite the registry');

    const differentId = await post(fx.server.url, { ...payload, project_id: 'other-name' });
    assert.equal(differentId.status, 409, 'a stale retry cannot claim the already registered directory under another ID');

    const changed = JSON.parse(readFileSync(fx.registryFile, 'utf8'));
    changed.projects[0].acceptance_profiles.push({ profile_id: 'other-unit-tests', acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] }, assets: [asset] });
    writeFileSync(fx.registryFile, JSON.stringify(changed));
    const differentProfile = await post(fx.server.url, { ...payload, template_profile_id: 'other-unit-tests' });
    assert.equal(differentProfile.status, 409, 'a stale retry with a different profile is not treated as the original registration');

    changed.projects[0].policy.forbidden.push('credentials/**');
    writeFileSync(fx.registryFile, JSON.stringify(changed));
    const differentPolicy = await post(fx.server.url, payload);
    assert.equal(differentPolicy.status, 409, 'a changed trust policy cannot be confused with the original registration');

    const current = readFileSync(fx.registryFile, 'utf8');
    const elsewhere = join(fx.browseRoot, 'elsewhere'); mkdirSync(elsewhere);
    const stale = await post(fx.server.url, { ...payload, root: elsewhere, project_id: 'stale-project' });
    assert.equal(stale.status, 409, 'a stale project-list digest cannot overwrite a newer registry');
    assert.equal(readFileSync(fx.registryFile, 'utf8'), current, 'all stale or mismatched retries leave the registry unchanged');
  } finally { rmSync(marker, { force: true }); await fx.cleanup(); }
});

test('registration refuses browse-root, escaping, incompatible, stale-lock and read-only cases without registry changes', async () => {
  const fx = await setup({ assets: [{ asset_id: 'tests/gate.test.mjs', digest: 'a'.repeat(64) }] });
  try {
    const digest = loadProjectRegistry({ file: fx.registryFile }).digest;
    const payload = { project_id: 'candidate', template_project_id: 'template-project', template_profile_id: 'unit-tests', expected_registry_digest: digest };
    const original = readFileSync(fx.registryFile, 'utf8');

    const root = await post(fx.server.url, { ...payload, root: fx.browseRoot });
    assert.equal(root.status, 403, 'the configured browse root itself cannot be registered as a project');
    const outside = await post(fx.server.url, { ...payload, root: fx.fx.repo });
    assert.equal(outside.status, 403, 'a directory outside the configured browse root cannot be registered');
    const assetMismatch = await post(fx.server.url, { ...payload, root: fx.selectedRoot });
    assert.equal(assetMismatch.status, 422);
    assert.match((await assetMismatch.json()).model.reason, /digest does not match/);

    const lockPath = `${fx.registryFile}.project-registration.lock`;
    writeFileSync(lockPath, 'another-writer');
    const busy = await post(fx.server.url, { ...payload, root: fx.selectedRoot });
    assert.equal(busy.status, 409);
    rmSync(lockPath, { force: true });
    assert.equal(readFileSync(fx.registryFile, 'utf8'), original);

    const readOnly = await setup({ assets: [], allowRecord: false });
    try {
      const readOnlyDigest = loadProjectRegistry({ file: readOnly.registryFile }).digest;
      const denied = await post(readOnly.server.url, {
        ...payload, root: readOnly.selectedRoot, expected_registry_digest: readOnlyDigest,
      });
      assert.equal(denied.status, 403, 'a configured token cannot enable registry writes when the server is read-only');
      assert.equal(loadProjectRegistry({ file: readOnly.registryFile }).registry.projects.length, 1);
    } finally { await readOnly.cleanup(); }
  } finally { await fx.cleanup(); }
});

test('registry symlink registration updates the canonical target and shares its lock with the alias', async () => {
  const fx = await setup({ registrySymlink: true });
  try {
    const initial = loadProjectRegistry({ file: fx.registryFile });
    const payload = {
      root: fx.selectedRoot, project_id: 'new-project', template_project_id: 'template-project',
      template_profile_id: 'unit-tests', expected_registry_digest: initial.digest,
    };
    const response = await post(fx.server.url, payload);
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    assert.equal(lstatSync(fx.registryFile).isSymbolicLink(), true, 'the configured alias remains a symlink after the atomic write');
    assert.equal(readlinkSync(fx.registryFile), fx.registryTargetFile);
    assert.equal(loadProjectRegistry({ file: fx.registryTargetFile }).registry.projects.length, 2, 'the canonical target receives the registration');
    assert.equal(loadProjectRegistry({ file: fx.registryFile }).digest, loadProjectRegistry({ file: fx.registryTargetFile }).digest);

    const lockFile = `${fx.registryTargetFile}.project-registration.lock`;
    writeFileSync(lockFile, 'writer using the canonical registry path');
    const secondRoot = join(fx.browseRoot, 'second-project'); mkdirSync(secondRoot);
    const conflict = await post(fx.server.url, {
      ...payload, root: secondRoot, project_id: 'second-project',
      expected_registry_digest: loadProjectRegistry({ file: fx.registryTargetFile }).digest,
    });
    assert.equal(conflict.status, 409, 'a lock keyed by the canonical target also blocks writes through its symlink alias');
    assert.equal(existsSync(lockFile), true, 'a lock not owned by this request is preserved');
  } finally { await fx.cleanup(); }
});

test('registered roots below AF_PROJECT_BROWSE_ROOT are allowed for project-scoped team creation only', async () => {
  const fx = await setup();
  try {
    cpSync(fx.fx.repo, fx.selectedRoot, { recursive: true });
    const profile = { profile_id: 'unit-tests', acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] }, assets: [] };
    const registry = {
      schema_version: PROJECT_REGISTRY_SCHEMA,
      projects: [{ project_id: 'browse-project', root: fx.selectedRoot, workspace_root: fx.workspaceRoot,
        policy: { allowed_root: ['src/**', 'tests/**'], forbidden: [], protected_paths: [], projection: { exclude: [] }, import: { deny: [] } },
        acceptance_profiles: [profile] }],
    };
    writeFileSync(fx.registryFile, JSON.stringify(registry));
    const request = { project_id: 'browse-project', profile_id: 'unit-tests', spec: { goal: 'check the selected project', idempotency_key: 'browse-root-team' } };
    const created = await fetch(`${fx.server.url}/api/teams`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify(request),
    });
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const task = (await created.json()).model.task_id;
    assert.equal(JSON.parse(readFileSync(join(fx.fx.options.tasksDir, `${task}.json`), 'utf8')).fixture_dir, fx.selectedRoot);

    const unscoped = await fetch(`${fx.server.url}/api/teams`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ spec: { goal: 'unscoped request', target_path: fx.selectedRoot, acceptance: profile.acceptance, idempotency_key: 'unscoped-browse-root' } }),
    });
    assert.equal(unscoped.status, 422, 'AF_PROJECT_BROWSE_ROOT is added only for registered project-scoped intake');
  } finally { await fx.cleanup(); }
});
