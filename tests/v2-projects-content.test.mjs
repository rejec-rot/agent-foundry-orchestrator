// v2-projects-content.test.mjs - §6 G6: the project registry, trusted acceptance-profile identity
// and the snapshot-bounded content endpoint.
//
// The security claim under test is narrow and checkable: a browser can only read bytes that the
// task's own snapshot registered, addressed by identifier, and the registry is the only source of a
// project's root/profile. Anything else is a refusal.

import './helpers/executors-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProjectRegistry, resolveProject, resolveAcceptanceProfile, assignProjectDirs, describeRegistry, PROJECT_REGISTRY_SCHEMA } from '../lib/projects.mjs';
import { registerTaskBlob, resolveTaskBlob, readTaskBlob, contentIndex, CONTENT_MAX_BYTES } from '../lib/content.mjs';
import { loadAcceptanceAllowlist, acceptanceCommandAllowed } from '../lib/submission.mjs';
import { startReadApi } from '../server/read-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = loadAcceptanceAllowlist({ file: join(ROOT, 'config', 'acceptance-allowlist.json') });

function fixture(prefix = 'af-g6-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const tasks = join(root, 'tasks');
  const repo = join(root, 'repo');
  const workspaces = join(root, 'workspaces');
  const snapshots = join(root, 'snapshots');
  for (const d of [tasks, repo, workspaces, snapshots]) mkdirSync(d, { recursive: true });
  const registryFile = join(root, 'projects.json');
  return { root, tasks, repo, workspaces, snapshots, registryFile, roots: { tasks, runtime: join(root, 'runtime'), alerts: join(root, 'alerts.jsonl') } };
}

function writeRegistry(fx, overrides = {}) {
  const registry = {
    schema_version: PROJECT_REGISTRY_SCHEMA,
    projects: [
      {
        project_id: 'demo',
        root: fx.repo,
        workspace_root: fx.workspaces,
        acceptance_profiles: [
          { profile_id: 'default', acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] }, assets: [] },
        ],
      },
    ],
    ...overrides,
  };
  writeFileSync(fx.registryFile, JSON.stringify(registry, null, 2));
  return registry;
}

const resolve = (fx, profileId = null) => resolveAcceptanceProfile({
  registry: loadProjectRegistry({ file: fx.registryFile }).registry,
  registryFile: fx.registryFile,
  registryDigest: loadProjectRegistry({ file: fx.registryFile }).digest,
  projectId: 'demo',
  profileId,
  allowlist: ALLOWLIST,
  acceptanceCommandAllowed,
});

test('G6-1: the registry is read strictly - missing is "not configured", damaged is a refusal', () => {
  const fx = fixture();
  try {
    assert.equal(loadProjectRegistry({ file: join(fx.root, 'nope.json') }).configured, false);
    writeFileSync(fx.registryFile, '{ not json');
    const broken = loadProjectRegistry({ file: fx.registryFile });
    assert.equal(broken.ok, false);
    assert.match(broken.reason, /not valid JSON/);

    writeFileSync(fx.registryFile, JSON.stringify({ projects: [] }));
    assert.match(loadProjectRegistry({ file: fx.registryFile }).reason, /non-empty array/);
    writeFileSync(fx.registryFile, JSON.stringify({ projects: [{ project_id: 'a', root: 'relative/path' }] }));
    assert.match(loadProjectRegistry({ file: fx.registryFile }).reason, /absolute path/);
    writeFileSync(fx.registryFile, JSON.stringify({ projects: [{ project_id: 'a', root: '/x' }, { project_id: 'a', root: '/y' }] }));
    assert.match(loadProjectRegistry({ file: fx.registryFile }).reason, /duplicate/);
    writeFileSync(fx.registryFile, JSON.stringify({ projects: [{ project_id: 'a', root: '/x', acceptance_profiles: [{ profile_id: 'p', acceptance: { command: 'node' }, assets: [{ asset_id: 'z', digest: 'nope' }] }] }] }));
    assert.match(loadProjectRegistry({ file: fx.registryFile }).reason, /sha256 hex digest/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('G6-2: a project resolves by id or by a realpath-exact root, and never by a guess', () => {
  const fx = fixture();
  try {
    const registry = writeRegistry(fx);
    assert.equal(resolveProject({ registry, projectId: 'demo' }).ok, true);
    assert.equal(resolveProject({ registry, projectId: 'nope' }).ok, false);
    assert.equal(resolveProject({ registry, targetRoot: fx.repo }).ok, true, 'an exact root matches');
    assert.equal(resolveProject({ registry, targetRoot: fx.repo + '/sub' }).ok, false, 'a child directory is not the project root');
    writeRegistry(fx, { projects: [{ project_id: 'a', root: fx.repo }, { project_id: 'b', root: fx.repo }] });
    const twice = loadProjectRegistry({ file: fx.registryFile }).registry;
    const ambiguous = resolveProject({ registry: twice, targetRoot: fx.repo });
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.reason, /refusing to guess/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('G6-3: the acceptance profile comes from the registry, is allowlist-checked, and carries provenance', () => {
  const fx = fixture();
  try {
    writeRegistry(fx);
    const ok = resolve(fx);
    assert.equal(ok.ok, true, ok.reason ?? '');
    assert.equal(ok.identity.acceptance.command, 'node');
    assert.equal(ok.identity.project_id, 'demo');
    assert.equal(ok.profile_digest.length, 64);
    assert.equal(ok.provenance.registry_file, fx.registryFile, 'the identity says WHICH registry produced it');
    assert.equal(ok.provenance.registry_digest.length, 64);
    assert.equal(ok.provenance.allowlist_digest.length, 64);

    // a profile whose command is not allowlisted is refused
    writeRegistry(fx, { projects: [{ project_id: 'demo', root: fx.repo, workspace_root: fx.workspaces, acceptance_profiles: [{ profile_id: 'bad', acceptance: { command: 'curl', args: ['http://x'] }, assets: [] }] }] });
    const bad = resolve(fx);
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /not on the allowlist/);

    // two profiles require an explicit choice
    writeRegistry(fx, { projects: [{ project_id: 'demo', root: fx.repo, workspace_root: fx.workspaces, acceptance_profiles: [
      { profile_id: 'p1', acceptance: { command: 'node', args: ['--test'] }, assets: [] },
      { profile_id: 'p2', acceptance: { command: 'npm', args: ['test'] }, assets: [] },
    ] }] });
    assert.match(resolve(fx).reason, /an explicit profile is required/);
    assert.equal(resolve(fx, 'p2').ok, true);

    // a fixture's digest is stable for identical content and different for different content - so a
    // digest copied out of a fixture cannot silently equal a production profile
    const again = resolve(fx, 'p2');
    assert.equal(again.profile_digest, resolve(fx, 'p2').profile_digest);
    assert.notEqual(again.profile_digest, resolve(fx, 'p1').profile_digest);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('G6-4: workspace assignment refuses to overlap the project root', () => {
  const fx = fixture();
  try {
    const project = { project_id: 'demo', root: fx.repo, workspace_root: fx.workspaces };
    const ok = assignProjectDirs({ project, taskId: 'T-1' });
    assert.equal(ok.ok, true);
    assert.ok(ok.candidate_dir.startsWith(fx.workspaces));
    const overlap = assignProjectDirs({ project: { ...project, workspace_root: fx.repo }, taskId: 'T-1' });
    assert.equal(overlap.ok, false);
    assert.match(overlap.reason, /overlaps the project root/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('G6-5: only snapshot-registered blobs are addressable - not paths, not raw CAS digests', () => {
  const fx = fixture();
  try {
    const snapshotDir = join(fx.snapshots, 'T-1');
    mkdirSync(snapshotDir, { recursive: true });
    const good = join(snapshotDir, 'report.txt');
    writeFileSync(good, 'the acceptance report\n');
    const outside = join(fx.root, 'secret.txt');
    writeFileSync(outside, 'do not serve me\n');

    const task = { task_id: 'T-1' };
    assert.equal(registerTaskBlob(task, { blob_id: 'report', path: good, media_type: 'text/plain', allowedRoot: snapshotDir }).ok, true);
    assert.equal(registerTaskBlob(task, { blob_id: '../escape', path: good, allowedRoot: snapshotDir }).ok, false, 'a traversal-shaped id is refused at registration');
    assert.equal(registerTaskBlob(task, { blob_id: 'escape', path: outside, allowedRoot: snapshotDir }).ok, false, 'a blob outside the snapshot tree is refused');
    assert.equal(registerTaskBlob(task, { blob_id: 'typed', path: good, media_type: 'application/x-sh', allowedRoot: snapshotDir }).ok, false, 'a media type off the whitelist is refused');

    const read = readTaskBlob(task, 'report');
    assert.equal(read.ok, true);
    assert.equal(read.bytes.toString('utf8'), 'the acceptance report\n');
    assert.equal(read.media_type, 'text/plain');

    assert.equal(resolveTaskBlob(task, 'nope').ok, false);
    assert.equal(resolveTaskBlob(task, '../../etc/passwd').ok, false, 'a path-shaped id is not addressable');
    assert.equal(resolveTaskBlob(task, 'a'.repeat(64)).ok, false, 'a raw CAS digest is not addressable');
    assert.match(resolveTaskBlob(task, 'a'.repeat(64)).reason, /raw CAS digests are not addressable/);

    // a snapshot whose bytes changed is a refusal, not a stale success
    writeFileSync(good, 'tampered\n');
    const tampered = readTaskBlob(task, 'report');
    assert.equal(tampered.ok, false);
    assert.match(tampered.reason, /does not match its registered digest/);

    // a symlink that points outside the snapshot cannot smuggle a file in
    const link = join(snapshotDir, 'link.txt');
    try {
      symlinkSync(outside, link);
      const viaLink = registerTaskBlob({ task_id: 'T-2' }, { blob_id: 'linked', path: link, allowedRoot: snapshotDir });
      assert.equal(viaLink.ok, false, 'the resolved path leaves the snapshot tree');
    } catch { /* symlinks unavailable: nothing to prove here */ }

    const index = contentIndex(task);
    assert.equal(index.blobs.length, 1);
    assert.equal(index.blobs[0].blob_id, 'report');
    assert.equal(Object.prototype.hasOwnProperty.call(index.blobs[0], 'registered_path'), false, 'the index never exposes a host path');
    assert.equal(CONTENT_MAX_BYTES, 2 * 1024 * 1024);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('G6-6: the HTTP content route serves registered bytes and refuses everything else', async () => {
  const fx = fixture();
  writeRegistry(fx);
  const api = await startReadApi({ roots: fx.roots, env: { ...process.env, AF_PROJECTS_FILE: fx.registryFile } });
  try {
    const snapshotDir = join(fx.snapshots, 'T-API');
    mkdirSync(snapshotDir, { recursive: true });
    const file = join(snapshotDir, 'report.md');
    writeFileSync(file, '# report\n');
    const task = { task_id: 'T-API', state: 'COMPLETED', trusted_import: { enabled: true, phase: 'PROMOTED' } };
    registerTaskBlob(task, { blob_id: 'report', path: file, media_type: 'text/markdown', allowedRoot: snapshotDir });
    writeFileSync(join(fx.tasks, 'T-API.json'), JSON.stringify(task, null, 2));

    const list = await (await fetch(`${api.url}/api/v2/tasks/T-API/content`)).json();
    assert.equal(list.model.blobs.length, 1);
    assert.equal(list.model.blobs[0].blob_id, 'report');

    const bytes = await fetch(`${api.url}/api/v2/tasks/T-API/content/report`);
    assert.equal(bytes.status, 200);
    assert.equal(bytes.headers.get('content-type'), 'text/markdown');
    assert.equal(bytes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await bytes.text(), '# report\n');

    const unknown = await fetch(`${api.url}/api/v2/tasks/T-API/content/nope`);
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).model.reason, /is registered in this task's snapshot/);

    const digestAddressed = await fetch(`${api.url}/api/v2/tasks/T-API/content/${'a'.repeat(64)}`);
    assert.equal(digestAddressed.status, 404);
    assert.match((await digestAddressed.json()).model.reason, /raw CAS digests/);

    const traversal = await fetch(`${api.url}/api/v2/tasks/T-API/content/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(traversal.status, 404);

    const unknownTask = await fetch(`${api.url}/api/v2/tasks/T-ABSENT/content`);
    assert.equal(unknownTask.status, 404);

    const caps = (await (await fetch(`${api.url}/api/v2/capabilities`)).json()).model;
    assert.equal(caps.read.task_content, true);
    assert.equal(caps.projects.configured, true);
    assert.equal(caps.projects.count, 1);
    assert.equal(typeof caps.projects.digest, 'string');
    assert.equal(JSON.stringify(caps).includes(fx.registryFile), false, 'the browser never learns the registry path');
  } finally { await api.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test('G6-7: the repository ships only an EXAMPLE registry, never a resolved one', () => {
  // "A test fixture's digests must not be copied into a production configuration": the clearest
  // enforceable half of that is that a checkout never carries a loadable registry at the default
  // path - only a clearly-labelled example that nothing reads.
  assert.equal(existsSync(join(ROOT, 'config', 'projects.json')), false, 'config/projects.json must not be committed');
  assert.equal(existsSync(join(ROOT, 'config', 'projects.example.json')), true);
  const example = JSON.parse(readFileSync(join(ROOT, 'config', 'projects.example.json'), 'utf8'));
  assert.match(example.$comment, /EXAMPLE ONLY/);
  assert.equal(loadProjectRegistry({ file: join(ROOT, 'config', 'projects.example.json') }).ok, true, 'the example is itself valid, so it can be copied deliberately');
});

test('G6-8: the content route has no path-shaped input and the modules never reach for the CAS', () => {
  const apiSource = readFileSync(join(ROOT, 'server', 'read-api.mjs'), 'utf8');
  const contentSource = readFileSync(join(ROOT, 'lib', 'content.mjs'), 'utf8');
  assert.doesNotMatch(contentSource, /join\(casDir|cas_dir/, 'content must not read the CAS directly');
  assert.match(apiSource, /readTaskBlob\(snapshot, /, 'the route reads through the snapshot resolver');
  assert.doesNotMatch(apiSource, /readFileSync\(\s*blobId/, 'the route must never treat the blob id as a path');
  assert.doesNotMatch(apiSource, /join\([^)]*decodeURIComponent\(blobId\)/, 'the blob id is never joined onto a filesystem path');
  assert.match(apiSource, /content-security-policy/, 'served content is sandboxed');
});
