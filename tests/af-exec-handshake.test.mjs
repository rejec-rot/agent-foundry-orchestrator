// af-exec-handshake.test.mjs - the option-A capability handshake and artifact boundary are
// fail-closed: an unverifiable identity separation never produces a dispatch descriptor, and an
// executor artifact outside its own workspace (or inside the control plane) is refused.

import { test } from 'node:test';
import assert from 'node:assert';

import {
  ISOLATION_CLAIM_SCHEMA,
  readIsolationClaim,
  verifyIsolationClaim,
  buildExecutorDispatch,
  assertParentOwnedArtifact,
  planRunIsolation,
  executorIsolationMode,
} from '../lib/af-exec-handshake.mjs';

const WS = '/srv/af-workspace';
const CLAIM_FILE = '/etc/af-exec/claim.json';
const LAUNCHER = '/usr/local/sbin/af-exec-run';
const SURFACES = ['/repo/lib', '/repo/af-admin.mjs'];

const goodFiles = {
  [WS]: { uid: 900, gid: 900, mode: 0o750 },
  [CLAIM_FILE]: { uid: 0, mode: 0o600 },
  '/repo/lib': { uid: 0, mode: 0o755 },
  '/repo/af-admin.mjs': { uid: 0, mode: 0o755 },
  [LAUNCHER]: { uid: 0, mode: 0o755 },
};

const goodDeps = (overrides = {}) => ({
  stat: (p) => {
    const f = overrides.files?.[p] ?? goodFiles[p];
    if (!f) { const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT'; throw err; }
    return f;
  },
  resolveUser: (name) => (name === 'af-exec' ? { uid: 900, gid: 900 } : null),
  controlUid: 0,
});

const goodClaim = {
  schema: ISOLATION_CLAIM_SCHEMA,
  af_exec: { user: 'af-exec', uid: 900, gid: 900 },
  workspace: WS,
  control_plane_surfaces: SURFACES,
  launcher: LAUNCHER,
};

test('AFH-1: a fully verifiable claim passes and yields a descriptor for the executor uid', () => {
  const verify = verifyIsolationClaim({ claim: goodClaim, claimFile: CLAIM_FILE, deps: goodDeps() });
  assert.strictEqual(verify.ok, true, JSON.stringify(verify.checks.filter((c) => c.ok !== true)));
  assert.deepStrictEqual(verify.checks.map((c) => c.id), [
    'H1-schema', 'H2-separated-identity', 'H3-user-matches-claim', 'H4-claim-file-protected',
    'H5-workspace-owned-by-executor', 'H6-control-plane-protected', 'H7-launcher-root-owned',
  ]);
  const dispatch = buildExecutorDispatch({ claim: goodClaim, claimFile: CLAIM_FILE, command: 'node', args: ['a.mjs'], deps: goodDeps() });
  assert.strictEqual(dispatch.ok, true);
  assert.strictEqual(dispatch.uid, 900);
  assert.strictEqual(dispatch.gid, 900);
  assert.strictEqual(dispatch.argv.command, 'node');
  assert.strictEqual(dispatch.launcher, LAUNCHER);
});

test('AFH-2: a missing claim is a refusal, never a downgrade to the control-plane identity', () => {
  const dispatch = buildExecutorDispatch({
    claim: null,
    claimFile: CLAIM_FILE,
    command: 'node',
    deps: { ...goodDeps(), stat: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } },
  });
  assert.strictEqual(dispatch.ok, false);
  assert.match(dispatch.reason, /no downgrade/);
  assert.strictEqual(dispatch.uid, undefined, 'no descriptor may be produced without a handshake');
});

test('AFH-3: readIsolationClaim distinguishes absent (missing) from unverifiable', () => {
  const missing = readIsolationClaim({ file: CLAIM_FILE, deps: { readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } } });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.missing, true);
  const corrupt = readIsolationClaim({ file: CLAIM_FILE, deps: { readFile: () => '{ not json' } });
  assert.strictEqual(corrupt.ok, false);
  assert.strictEqual(corrupt.missing, false, 'a corrupt claim is NOT "missing"');
});

test('AFH-4: an identity that equals the control plane is refused (no separation)', () => {
  const claim = { ...goodClaim, af_exec: { user: 'af-exec', uid: 0, gid: 0 } };
  const verify = verifyIsolationClaim({ claim, claimFile: CLAIM_FILE, deps: goodDeps() });
  assert.strictEqual(verify.ok, false);
  assert.match(verify.reason, /H2-separated-identity/);
});

test('AFH-5: a claim writable by group/other, or a workspace not owned by the executor, is refused', () => {
  const looseClaim = goodDeps({ files: { [CLAIM_FILE]: { uid: 0, mode: 0o666 } } });
  assert.match(verifyIsolationClaim({ claim: goodClaim, claimFile: CLAIM_FILE, deps: looseClaim }).reason, /H4-claim-file-protected/);

  const wrongOwner = goodDeps({ files: { [WS]: { uid: 0, gid: 0, mode: 0o750 } } });
  assert.match(verifyIsolationClaim({ claim: goodClaim, claimFile: CLAIM_FILE, deps: wrongOwner }).reason, /H5-workspace-owned-by-executor/);
});

test('AFH-6: an unprotected control-plane surface or launcher blocks the handshake', () => {
  const openSurfaces = goodDeps({ files: { '/repo/lib': { uid: 0, mode: 0o775 } } });
  assert.match(verifyIsolationClaim({ claim: goodClaim, claimFile: CLAIM_FILE, deps: openSurfaces }).reason, /H6-control-plane-protected/);

  const badLauncher = goodDeps({ files: { [LAUNCHER]: { uid: 1000, mode: 0o755 } } });
  assert.match(verifyIsolationClaim({ claim: goodClaim, claimFile: CLAIM_FILE, deps: badLauncher }).reason, /H7-launcher-root-owned/);
});

test('AFH-7: an unresolvable user is UNKNOWN and refuses', () => {
  const deps = { ...goodDeps(), resolveUser: () => null };
  const verify = verifyIsolationClaim({ claim: goodClaim, claimFile: CLAIM_FILE, deps });
  assert.strictEqual(verify.ok, false);
  assert.match(verify.reason, /H3-user-matches-claim/);
});

test('AFH-8: the parent-owned artifact boundary refuses anything outside the workspace or inside the control plane', () => {
  const inside = assertParentOwnedArtifact({ workspace: WS, artifactPath: `${WS}/out/result.json`, controlPlaneSurfaces: SURFACES });
  assert.strictEqual(inside.ok, true);

  assert.strictEqual(assertParentOwnedArtifact({ workspace: WS, artifactPath: '/srv/elsewhere/result.json', controlPlaneSurfaces: SURFACES }).ok, false, 'outside the workspace');
  assert.strictEqual(assertParentOwnedArtifact({ workspace: WS, artifactPath: '/repo/lib/adapters.mjs', controlPlaneSurfaces: SURFACES }).ok, false, 'control-plane path');
  assert.strictEqual(assertParentOwnedArtifact({ workspace: WS, artifactPath: 'relative/result.json', controlPlaneSurfaces: SURFACES }).ok, false, 'relative path');
  assert.strictEqual(assertParentOwnedArtifact({ workspace: WS, artifactPath: `${WS}/x\0y`, controlPlaneSurfaces: SURFACES }).ok, false, 'NUL byte');
  assert.strictEqual(assertParentOwnedArtifact({ workspace: WS, artifactPath: '/srv/af-workspace-evil/result.json', controlPlaneSurfaces: SURFACES }).ok, false, 'prefix trap');
});

test('AFH-9: isolation defaults to off - the argv is untouched and no claim is read', () => {
  assert.strictEqual(executorIsolationMode({}), 'off');
  assert.strictEqual(executorIsolationMode({ AF_EXEC_ISOLATION: 'yes-please' }), 'off', 'unknown values are off');
  const argv = ['/usr/bin/node', 'run.mjs'];
  const res = planRunIsolation({
    argv,
    env: {},
    deps: { readFile: () => { throw new Error('the claim must not be read when isolation is off'); } },
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.mode, 'off');
  assert.strictEqual(res.argv, argv, 'off must return the very same argv');
});

test('AFH-10: require + no verifiable claim is a refusal with a null argv (never the original)', () => {
  const res = planRunIsolation({
    argv: ['/usr/bin/node', 'run.mjs'],
    env: { AF_EXEC_ISOLATION: 'require' },
    claimFile: CLAIM_FILE,
    deps: { readFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } },
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.argv, null, 'a refusal must not hand back the unisolated argv');
  assert.match(res.reason, /AF_EXEC_ISOLATION=require/);
});

test('AFH-11: require + a verifiable claim rewrites the argv through the privileged launcher', () => {
  const deps = { ...goodDeps(), readFile: () => JSON.stringify(goodClaim) };
  const res = planRunIsolation({ argv: ['/usr/bin/node', 'run.mjs'], env: { AF_EXEC_ISOLATION: 'require' }, claimFile: CLAIM_FILE, deps });
  assert.strictEqual(res.ok, true, res.reason ?? '');
  assert.deepStrictEqual(res.argv, [LAUNCHER, '--uid', '900', '--gid', '900', '--', '/usr/bin/node', 'run.mjs']);
});

test('AFH-12: the shared executor path is wired to the isolation gate', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const adapters = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'adapters.mjs'), 'utf8');
  assert.match(adapters, /planRunIsolation\(\{ argv, env: process\.env \}\)/, 'execAsync must consult the gate');
  assert.match(adapters, /EXECUTOR_ISOLATION_REQUIRED/, 'the refusal must be explicit');
});
