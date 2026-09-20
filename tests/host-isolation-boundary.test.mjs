// tests/host-isolation-boundary.test.mjs - Comprehensive OS-level Boundary & Anti-Tamper Test Suite
//
// Verifies:
// 1. Ownership separation (root:root vs UID 1000) prevents chmod (EPERM), write (EACCES), and delete (EACCES).
// 2. Candidate workspace remains cleanly writable by author.
// 3. CodexAdapter and agy-af fail-closed when external isolation is asserted without verification.
// 4. Sibling credentials are strictly excluded from the executor environment.
// 5. Cgroup v2 boundary terminates all descendants including double-fork background workers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  isExternalIsolationVerified,
  protectPathsWithNonOwnerBoundary,
  releasePathsBoundary,
  verifyTamperResistance,
  isDockerSocketAccessible,
  canUseRestrictedSandbox,
  buildRestrictedSandboxArgs,
  wrapCommandInRestrictedSandbox,
  withElevatedBoundary,
  engageTaskHostBoundary,
  disengageTaskHostBoundary,
  startFilteredDbusProxy,
  getActiveWriterScopes,
  inspectWriterScopes,
  capturePathSnapshot,
  loadPathSnapshot,
  BOUNDARY_SNAPSHOT_MISSING,
  WRITER_SCOPE_SCAN_UNKNOWN,
  MAX_WRITER_SCOPE_DEPTH,
} from '../lib/host-boundary.mjs';
import { CodexAdapter, executorScratchDir } from '../lib/adapters.mjs';
import { executorEnv } from '../lib/executor-env.mjs';
import {
  createWriterScope,
  attachWriterScope,
  reapWriterScope,
  spawnManaged,
  pidIsAlive,
} from '../lib/child-process.mjs';
import { runTrustedImportTask } from '../lib/trusted-import/orchestrator-adapter.mjs';

const CGROUP_BASE = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice';

test('HIB-1: Non-owner DAC boundary prevents chmod on canonical repo, CAS, and task state (EPERM)', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib1-'));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const tasksDir = join(root, 'tasks');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(casDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });

  const canonFile = join(canonicalDir, 'main.js');
  const casBlob = join(casDir, 'blob-abc123');
  const taskFile = join(tasksDir, 'task-001.json');

  writeFileSync(canonFile, 'canonical-code');
  writeFileSync(casBlob, 'cas-immutable-data');
  writeFileSync(taskFile, JSON.stringify({ state: 'AUTHOR_RUNNING' }));

  try {
    // Protect paths via non-owner DAC
    protectPathsWithNonOwnerBoundary([canonicalDir, casDir, tasksDir]);

    // Attempt chmod 0777 on canonical file -> Must fail with EPERM
    assert.throws(
      () => chmodSync(canonFile, 0o777),
      (err) => err.code === 'EPERM' || err.code === 'EACCES',
      'chmod on non-owned canonical file must be blocked by kernel DAC',
    );

    // Attempt chmod 0777 on CAS blob -> Must fail with EPERM
    assert.throws(
      () => chmodSync(casBlob, 0o777),
      (err) => err.code === 'EPERM' || err.code === 'EACCES',
      'chmod on non-owned CAS blob must be blocked by kernel DAC',
    );

    // Attempt chmod 0777 on task file -> Must fail with EPERM
    assert.throws(
      () => chmodSync(taskFile, 0o777),
      (err) => err.code === 'EPERM' || err.code === 'EACCES',
      'chmod on non-owned task file must be blocked by kernel DAC',
    );
  } finally {
    releasePathsBoundary([canonicalDir, casDir, tasksDir]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-2: Non-owner DAC boundary prevents direct write / append on canonical, CAS, and task state (EACCES)', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib2-'));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const tasksDir = join(root, 'tasks');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(casDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });

  const canonFile = join(canonicalDir, 'main.js');
  const taskFile = join(tasksDir, 'task-001.json');
  writeFileSync(canonFile, 'canonical-code');
  writeFileSync(taskFile, JSON.stringify({ state: 'AUTHOR_RUNNING' }));

  try {
    protectPathsWithNonOwnerBoundary([canonicalDir, casDir, tasksDir]);

    // Overwrite canonical file -> EACCES
    assert.throws(
      () => writeFileSync(canonFile, 'tampered-code', { flag: 'w' }),
      (err) => err.code === 'EACCES' || err.code === 'EPERM',
      'write to non-owned canonical file must be blocked by kernel DAC',
    );

    // Overwrite task state file -> EACCES
    assert.throws(
      () => writeFileSync(taskFile, '{"state":"TAMPERED"}', { flag: 'w' }),
      (err) => err.code === 'EACCES' || err.code === 'EPERM',
      'write to non-owned task file must be blocked by kernel DAC',
    );

    // Create unauthorized blob in CAS dir -> EACCES
    assert.throws(
      () => writeFileSync(join(casDir, 'forged-blob'), 'forged', { flag: 'w' }),
      (err) => err.code === 'EACCES' || err.code === 'EPERM',
      'create inside non-owned CAS directory must be blocked by kernel DAC',
    );
  } finally {
    releasePathsBoundary([canonicalDir, casDir, tasksDir]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-3: Non-owner DAC boundary prevents delete / unlink of canonical files and task records (EACCES)', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib3-'));
  const canonicalDir = join(root, 'canonical');
  const tasksDir = join(root, 'tasks');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });

  const canonFile = join(canonicalDir, 'main.js');
  const taskFile = join(tasksDir, 'task-001.json');
  writeFileSync(canonFile, 'canonical-code');
  writeFileSync(taskFile, JSON.stringify({ state: 'AUTHOR_RUNNING' }));

  try {
    protectPathsWithNonOwnerBoundary([canonicalDir, tasksDir]);

    // Unlink canonical file -> EACCES
    assert.throws(
      () => unlinkSync(canonFile),
      (err) => err.code === 'EACCES' || err.code === 'EPERM',
      'unlink of non-owned canonical file must be blocked by kernel DAC',
    );

    // Unlink task state file -> EACCES
    assert.throws(
      () => unlinkSync(taskFile),
      (err) => err.code === 'EACCES' || err.code === 'EPERM',
      'unlink of non-owned task file must be blocked by kernel DAC',
    );
  } finally {
    releasePathsBoundary([canonicalDir, tasksDir]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-4: Protected canonical and tasks files remain readable for reviewer and orchestrator', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib4-'));
  const canonicalDir = join(root, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  const canonFile = join(canonicalDir, 'main.js');
  writeFileSync(canonFile, 'function answer() { return 42; }');

  try {
    protectPathsWithNonOwnerBoundary([canonicalDir]);
    const content = readFileSync(canonFile, 'utf8');
    assert.strictEqual(content, 'function answer() { return 42; }', 'protected file must be readable');
  } finally {
    releasePathsBoundary([canonicalDir]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-5: Candidate workspace remains fully writable while protected paths are guarded', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib5-'));
  const canonicalDir = join(root, 'canonical');
  const candidateDir = join(root, 'candidate');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'base.js'), 'base');

  try {
    protectPathsWithNonOwnerBoundary([canonicalDir]);

    // Candidate must be writable
    const candidateFile = join(candidateDir, 'edit.js');
    writeFileSync(candidateFile, 'export function fix() {}');
    assert.strictEqual(readFileSync(candidateFile, 'utf8'), 'export function fix() {}');

    // Tamper verification helper confirms candidate is writable and canonical is guarded
    const audit = verifyTamperResistance({
      protectedPaths: [canonicalDir],
      candidateDir,
    });
    assert.strictEqual(audit.verified, true);
    assert.ok(audit.attacksBlocked >= 2);
  } finally {
    releasePathsBoundary([canonicalDir]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-6: CodexAdapter refuses --dangerously-bypass-approvals-and-sandbox when external isolation is unverified', async () => {
  const oldVerified = process.env.AF_EXTERNAL_ISOLATION_VERIFIED;
  const oldCgroup = process.env.AF_CGROUP_BASE;
  const oldCodexExt = process.env.AF_CODEX_EXTERNAL_SANDBOX;
  const oldSbx = process.env.AF_SANDBOX_EXECUTORS;

  try {
    delete process.env.AF_EXTERNAL_ISOLATION_VERIFIED;
    delete process.env.AF_CGROUP_BASE;
    delete process.env.AF_SANDBOX_EXECUTORS;
    process.env.AF_CODEX_EXTERNAL_SANDBOX = '1';

    const result = await CodexAdapter.run({
      acceptEdits: true,
      prompt: 'unverified-test',
      assigned_role: 'author',
    });

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.exit_code, -1);
    assert.match(result.error, /SANDBOX_UNVERIFIED/);
    assert.match(result.error, /External isolation unverified/i);
  } finally {
    if (oldVerified !== undefined) process.env.AF_EXTERNAL_ISOLATION_VERIFIED = oldVerified; else delete process.env.AF_EXTERNAL_ISOLATION_VERIFIED;
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    if (oldCodexExt !== undefined) process.env.AF_CODEX_EXTERNAL_SANDBOX = oldCodexExt; else delete process.env.AF_CODEX_EXTERNAL_SANDBOX;
    if (oldSbx !== undefined) process.env.AF_SANDBOX_EXECUTORS = oldSbx; else delete process.env.AF_SANDBOX_EXECUTORS;
  }
});

test('HIB-7: bin/agy-af fails closed when AF_REQUIRE_ISOLATION=1 and isolation is unverified', () => {
  const agyAf = join(process.cwd(), 'bin', 'agy-af');
  const res = spawnSync(agyAf, ['--version'], {
    env: {
      ...process.env,
      AF_REQUIRE_ISOLATION: '1',
      AF_EXTERNAL_ISOLATION_VERIFIED: '0',
      AF_CGROUP_BASE: '',
    },
    encoding: 'utf8',
  });

  assert.strictEqual(res.status, 2, 'agy-af must exit with code 2 when isolation is required but unverified');
  assert.match(res.stderr, /refusing to append --dangerously-skip-permissions/);
});

test('HIB-8: Credential isolation guarantees sibling keys are absent from executor environment', () => {
  const sourceEnv = {
    PATH: '/bin:/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-openai-secret',
    VERTEX_BEARER_TOKEN: 'vertex-token-secret',
  };

  const agyEnv = executorEnv('antigravity', sourceEnv);
  assert.strictEqual(agyEnv.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY must not be passed to antigravity');
  assert.strictEqual(agyEnv.OPENAI_API_KEY, undefined, 'OPENAI_API_KEY must not be passed to antigravity');
  assert.strictEqual(agyEnv.VERTEX_BEARER_TOKEN, undefined, 'VERTEX_BEARER_TOKEN must not be passed to antigravity');

  const codexEnv = executorEnv('codex', sourceEnv);
  assert.strictEqual(codexEnv.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY must not be passed to codex');
  assert.strictEqual(codexEnv.VERTEX_BEARER_TOKEN, undefined, 'VERTEX_BEARER_TOKEN must not be passed to codex');
});

test('HIB-9: Cgroup v2 boundary terminates double-fork background worker without survivors', async () => {
  if (!existsSync(CGROUP_BASE) || !existsSync(join(CGROUP_BASE, 'cgroup.procs'))) {
    return; // Skip if host cgroup v2 delegated controller is not active
  }

  const oldCgroup = process.env.AF_CGROUP_BASE;
  process.env.AF_CGROUP_BASE = CGROUP_BASE;

  try {
    const scope = createWriterScope();
    assert.ok(scope && scope.kind === 'cgroup', 'cgroup writer scope must be created');

    // Spawn a detached double-fork process that attempts to survive in background
    const script = `
      sh -c '(sh -c "sleep 60" &) && sleep 1'
    `;
    const child = spawnManaged('bash', ['-c', script], {
      stdio: 'ignore',
    });

    // Attach child to scope
    const attached = attachWriterScope(scope, child.pid);

    // Reap writer scope via cgroup.kill
    const evidence = await reapWriterScope(attached, { graceMs: 2000 });
    assert.strictEqual(evidence.scope_empty, true, 'cgroup scope must be empty');
    assert.strictEqual(evidence.scope_verified, true, 'scope verification must succeed');

    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once('close', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    assert.strictEqual(pidIsAlive(child.pid), false, 'leader process must be reaped');
  } finally {
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
  }
});

test('HIB-10: 伪造隔离标志拦截: isExternalIsolationVerified rejects assertion without cgroup writability or non-owner root paths', () => {
  const oldVerified = process.env.AF_EXTERNAL_ISOLATION_VERIFIED;
  const oldCgroup = process.env.AF_CGROUP_BASE;
  const oldPaths = process.env.AF_PROTECTED_PATHS;

  try {
    // Attack 1: User probe: only setting env flags without real protection
    process.env.AF_EXTERNAL_ISOLATION_VERIFIED = '1';
    process.env.AF_CGROUP_BASE = '/sys/fs/cgroup';
    delete process.env.AF_PROTECTED_PATHS;

    const probeResult = isExternalIsolationVerified();
    assert.strictEqual(probeResult.verified, false, 'Probe with fake cgroup and no protected paths must be rejected');
    assert.match(probeResult.reason, /External isolation unverified/);

    // Attack 2: Protected path exists, but is owned by current UID (1000)
    const root = mkdtempSync(join(tmpdir(), 'af-fake-iso-'));
    try {
      const resultWithOwnerDir = isExternalIsolationVerified({
        protectedPaths: [root],
      });
      assert.strictEqual(resultWithOwnerDir.verified, false, 'Directory owned by executor UID must fail verification');
      assert.match(resultWithOwnerDir.reason, /owned by executor UID/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    if (oldVerified !== undefined) process.env.AF_EXTERNAL_ISOLATION_VERIFIED = oldVerified; else delete process.env.AF_EXTERNAL_ISOLATION_VERIFIED;
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    if (oldPaths !== undefined) process.env.AF_PROTECTED_PATHS = oldPaths; else delete process.env.AF_PROTECTED_PATHS;
  }
});

test('HIB-11: 直接传入危险参数拦截: bin/agy-af rejects --dangerously-skip-permissions when external isolation is unverified', () => {
  const agyAf = join(process.cwd(), 'bin', 'agy-af');

  // Direct pass without isolation flags
  const resDirect = spawnSync(agyAf, ['--dangerously-skip-permissions', '--version'], {
    env: { ...process.env },
    encoding: 'utf8',
  });
  assert.strictEqual(resDirect.status, 2, 'Directly passing --dangerously-skip-permissions must exit code 2');
  assert.match(resDirect.stderr, /refusing explicit --dangerously-skip-permissions: external isolation is unverified/);

  // Direct pass with forged environment flags
  const resForged = spawnSync(agyAf, ['--dangerously-skip-permissions', '--version'], {
    env: {
      ...process.env,
      AF_EXTERNAL_ISOLATION_VERIFIED: '1',
      AF_CGROUP_BASE: '/sys/fs/cgroup',
    },
    encoding: 'utf8',
  });
  assert.strictEqual(resForged.status, 2, 'Passing --dangerously-skip-permissions with forged env must exit code 2');
  assert.match(resForged.stderr, /refusing explicit --dangerously-skip-permissions: external isolation is unverified/);
});

test('HIB-12: Docker socket 访问阻断与特权剥离: restricted sandbox masks docker.sock and strips sudo/groups', () => {
  if (!canUseRestrictedSandbox()) {
    return; // Skip if bwrap is not available
  }

  const launch = buildRestrictedSandboxArgs({
    command: 'bash',
    args: ['-c', `
      # 1. Probe docker socket accessibility
      node -e "
        const net = require('net');
        const s = net.createConnection('/var/run/docker.sock', () => process.exit(10));
        s.on('error', (err) => {
          if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT' || err.code === 'EACCES') process.exit(0);
          process.exit(11);
        });
        setTimeout(() => process.exit(12), 200);
      " || exit 1

      # 2. Check sudo privilege restriction (PR_SET_NO_NEW_PRIVS)
      sudo -n true 2>/dev/null && exit 2

      # 3. Check group stripping: gid 984 (docker) and gid 27 (sudo) must NOT be present
      id | grep -q "(docker)" && exit 3
      id | grep -q "(sudo)" && exit 4

      exit 0
    `],
  });

  const res = spawnSync(launch.command, launch.args, { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `Sandbox probe failed with code ${res.status}: stderr=${res.stderr}`);
});

test('HIB-13: Author 阶段受控越权写入拦截: unauthorized writes to Canonical or CAS are blocked by OS boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib13-'));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const candidateDir = join(root, 'candidate');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(casDir, { recursive: true });
  mkdirSync(candidateDir, { recursive: true });

  writeFileSync(join(canonicalDir, 'main.js'), 'export const canonical = 1;');
  writeFileSync(join(casDir, 'blob-original'), 'cas-original-data');

  // A delegated, verified-empty cgroup base: unlocking requires positive evidence.
  const oldCgroup = process.env.AF_CGROUP_BASE;
  const emptyScopeBase = mkdtempSync(join(tmpdir(), 'af-hib13-scopes-'));
  process.env.AF_CGROUP_BASE = emptyScopeBase;

  try {
    // Engage host boundary on canonical and CAS
    engageTaskHostBoundary({ canonicalDir, casDir, candidateDir });

    // Attack 1: Attempt direct write to canonical
    assert.throws(() => {
      writeFileSync(join(canonicalDir, 'hack.js'), 'evil');
    }, /(EACCES|EROFS|EPERM)/);

    // Attack 2: Attempt chmod on canonical
    assert.throws(() => {
      chmodSync(canonicalDir, 0o777);
    }, /(EPERM|EROFS|EACCES)/);

    // Attack 3: Attempt write to CAS
    assert.throws(() => {
      writeFileSync(join(casDir, 'hack.blob'), 'evil');
    }, /(EACCES|EROFS|EPERM)/);

    // Legitimate action: write to candidate directory must succeed
    const editFile = join(candidateDir, 'edit.js');
    writeFileSync(editFile, 'export const fix = 2;');
    assert.strictEqual(readFileSync(editFile, 'utf8'), 'export const fix = 2;');
  } finally {
    const disengage = disengageTaskHostBoundary({ canonicalDir, casDir });
    assert.strictEqual(disengage.disengaged, true, 'verified-empty scope base must allow a clean disengage');
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    rmSync(emptyScopeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-14: 正式生命周期受控提升与回退: withElevatedBoundary permits orchestrator promotion and re-locks boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib14-'));
  const canonicalDir = join(root, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'base.js'), 'base');

  try {
    protectPathsWithNonOwnerBoundary([canonicalDir]);

    // Outside elevation: write must fail
    assert.throws(() => {
      writeFileSync(join(canonicalDir, 'outside.js'), 'outside');
    }, /(EACCES|EPERM)/);

    // Inside withElevatedBoundary: write succeeds
    await withElevatedBoundary([canonicalDir], async () => {
      writeFileSync(join(canonicalDir, 'promoted.js'), 'promoted');
    });

    // Verification: promoted file exists
    assert.strictEqual(readFileSync(join(canonicalDir, 'promoted.js'), 'utf8'), 'promoted');

    // After withElevatedBoundary: write is strictly locked again
    assert.throws(() => {
      writeFileSync(join(canonicalDir, 'after.js'), 'after');
    }, /(EACCES|EPERM)/);
  } finally {
    releasePathsBoundary([canonicalDir]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-15: Gap 1 强制隔离模式下 bwrap 不可用时拒绝裸机启动 (Fail-Closed)', async () => {
  // Test 1: wrapCommandInRestrictedSandbox throws when requireIsolation=true and sandbox cannot run
  const oldPath = process.env.PATH;
  try {
    // Override PATH to simulate missing bwrap
    process.env.PATH = '/nonexistent-bin-dir';
    assert.strictEqual(canUseRestrictedSandbox(), false, 'canUseRestrictedSandbox must be false without bwrap in PATH');

    assert.throws(
      () => wrapCommandInRestrictedSandbox('echo', ['hello'], { requireIsolation: true }),
      /ENFORCED_ISOLATION_FAILED/,
      'wrapCommandInRestrictedSandbox must fail closed when isolation is required and bwrap is unavailable',
    );
  } finally {
    process.env.PATH = oldPath;
  }

  // Test 2: CodexAdapter refuses to launch on bare host when isolation is demanded but bwrap is missing
  const oldRequire = process.env.AF_REQUIRE_ISOLATION;
  try {
    process.env.AF_REQUIRE_ISOLATION = '1';
    process.env.PATH = '/nonexistent-bin-dir';

    const res = await CodexAdapter.run({
      prompt: 'test prompt',
      cwd: tmpdir(),
      assigned_role: 'author',
    });

    assert.strictEqual(res.status, 'failed');
    assert.match(res.error, /ENFORCED_ISOLATION_FAILED/);
    assert.strictEqual(res.writer_termination.termination_confirmed, false);
  } finally {
    process.env.PATH = oldPath;
    if (oldRequire !== undefined) process.env.AF_REQUIRE_ISOLATION = oldRequire;
    else delete process.env.AF_REQUIRE_ISOLATION;
  }
});

test('HIB-16: Gap 2 挂载范围最小化与角色分离 (Author vs Reviewer)', () => {
  if (!canUseRestrictedSandbox()) return;

  const root = mkdtempSync(join(tmpdir(), 'af-hib16-'));
  const candidateDir = join(root, 'candidate');
  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(join(candidateDir, 'seed.js'), 'seed-data');

  // Canary on host /tmp to test /tmp isolation
  const hostTmpCanary = join(tmpdir(), `host-secret-${Date.now()}.txt`);
  writeFileSync(hostTmpCanary, 'sensitive-host-tmp-secret');

  try {
    // 1. Author probe
    const authorLaunch = buildRestrictedSandboxArgs({
      command: 'bash',
      args: ['-c', `
        # Candidate must be writable
        echo "author-edit" > "${candidateDir}/seed.js" || exit 1

        # Host /tmp canary must NOT be visible inside tmpfs /tmp
        if [ -f "${hostTmpCanary}" ]; then exit 2; fi

        # ~/.gemini must be masked (empty)
        if [ -d "$HOME/.gemini" ] && [ "$(ls -A "$HOME/.gemini" 2>/dev/null)" != "" ]; then exit 3; fi

        exit 0
      `],
      candidateDir,
      role: 'author',
      platform: 'codex',
    });

    const resAuthor = spawnSync(authorLaunch.command, authorLaunch.args, { encoding: 'utf8' });
    assert.strictEqual(resAuthor.status, 0, `Author probe failed: stderr=${resAuthor.stderr}`);
    assert.strictEqual(readFileSync(join(candidateDir, 'seed.js'), 'utf8').trim(), 'author-edit');

    // 2. Reviewer probe
    const reviewerLaunch = buildRestrictedSandboxArgs({
      command: 'bash',
      args: ['-c', `
        # Candidate MUST BE READ-ONLY for reviewer (mutation fails with EROFS)
        echo "malicious-reviewer-edit" > "${candidateDir}/seed.js" 2>/dev/null && exit 4

        # ~/.codex must be masked (empty)
        if [ -d "$HOME/.codex" ] && [ "$(ls -A "$HOME/.codex" 2>/dev/null)" != "" ]; then exit 5; fi

        exit 0
      `],
      candidateDir,
      role: 'reviewer',
      platform: 'antigravity',
    });

    const resReviewer = spawnSync(reviewerLaunch.command, reviewerLaunch.args, { encoding: 'utf8' });
    assert.strictEqual(resReviewer.status, 0, `Reviewer probe failed: stderr=${resReviewer.stderr}`);
    // Candidate must remain untouched by reviewer
    assert.strictEqual(readFileSync(join(candidateDir, 'seed.js'), 'utf8').trim(), 'author-edit');
  } finally {
    try { unlinkSync(hostTmpCanary); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-17: Gap 3 D-Bus 精准过滤代理 (Secret Service 独立透传 & 其它服务阻断)', () => {
  if (!canUseRestrictedSandbox()) return;

  const proxy = startFilteredDbusProxy({ allowedNames: ['org.freedesktop.secrets'] });
  try {
    const launch = buildRestrictedSandboxArgs({
      command: 'bash',
      args: ['-c', `
        # 1. Calling org.freedesktop.secrets introspect must SUCCEED
        gdbus introspect --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets >/dev/null 2>&1 || exit 1

        # 2. Calling unauthorized service (e.g. systemd1) must FAIL / be filtered
        if gdbus introspect --session --dest org.freedesktop.systemd1 --object-path /org/freedesktop/systemd1 >/dev/null 2>&1; then
          exit 2
        fi

        # 3. User run directory must contain only bus socket
        ENTRIES=$(ls -A /run/user/$(id -u))
        if [ "$ENTRIES" != "bus" ]; then
          exit 3
        fi

        exit 0
      `],
      role: 'reviewer',
      platform: 'antigravity',
      dbusProxySocket: proxy.proxySocket,
    });

    const res = spawnSync(launch.command, launch.args, { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `Filtered D-Bus probe failed (code ${res.status}): stderr=${res.stderr}`);
  } finally {
    proxy.cleanup();
  }
});

test('HIB-18: Gap 4 终止证据失败时保留 root DAC 保护 (不解锁属主权限)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib18-'));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const candidateDir = join(root, 'candidate');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(casDir, { recursive: true });
  mkdirSync(candidateDir, { recursive: true });

  // Init minimal git repo
  execFileSync('git', ['init', canonicalDir]);
  execFileSync('git', ['-C', canonicalDir, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', canonicalDir, 'config', 'user.email', 'test@test.com']);
  writeFileSync(join(canonicalDir, 'file.txt'), 'initial');
  execFileSync('git', ['-C', canonicalDir, 'add', '.']);
  execFileSync('git', ['-C', canonicalDir, 'commit', '-m', 'initial']);
  const headOid = execFileSync('git', ['-C', canonicalDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', canonicalDir, 'update-ref', 'refs/afr/canonical', headOid]);

  const task = {
    task_id: 'TASK-HIB-18-TERMINATION-FAIL',
    fixture_dir: canonicalDir,
    state: 'CREATED',
    host_isolation: true,
    acceptance_cmd: 'echo ok',
    author_executor: 'codex',
    reviewer_executor: 'antigravity',
    trusted_import: {
      enabled: true,
      candidate_dir: candidateDir,
      cas_dir: casDir,
      policy: { projection: { allow: ['*'] } },
    },
  };

  let caughtError = null;
  try {
    await runTrustedImportTask(task, {
      runAuthor: async () => ({
        executor_run_id: 'RUN-FAIL-AUTHOR',
        writer_termination: {
          process_started: true,
          process_group_alive: true, // ROGUE PROCESS STILL ALIVE!
          termination_confirmed: false,
          scope_verified: false,
          reason: 'unconfirmed writer termination',
        },
      }),
      runReview: async () => ({ decision: 'PASS' }),
      saveTask: (t) => Object.assign(task, t),
    });
  } catch (err) {
    caughtError = err;
  }

  try {
    assert.ok(caughtError, 'runTrustedImportTask must throw on unconfirmed writer termination');
    assert.strictEqual(caughtError.code, 'TRUSTED_IMPORT_WRITER_TERMINATION_UNCONFIRMED');

    // Verification 1: task record records retained boundary
    assert.strictEqual(task.trusted_import.boundary_state, 'PROTECTION_RETAINED_PENDING_RECOVERY');

    // Verification 2: root ownership must NOT have been released! (stat.uid must still be 0)
    const stat = statSync(canonicalDir);
    assert.strictEqual(stat.uid, 0, 'Canonical directory must remain root-owned when termination is unconfirmed');

    // Verification 3: chmod attempt must still fail with EPERM
    assert.throws(
      () => chmodSync(canonicalDir, 0o777),
      /(EPERM|EACCES)/,
      'chmod on canonical repo must be blocked by retained root DAC boundary',
    );
  } finally {
    // Clean up with force: true
    disengageTaskHostBoundary({ canonicalDir, casDir, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-19: 完整 Orchestrator 生命周期在强隔离下的提升与正常回收', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib19-'));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const candidateDir = join(root, 'candidate');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(casDir, { recursive: true });
  mkdirSync(candidateDir, { recursive: true });

  execFileSync('git', ['init', '-b', 'main'], { cwd: canonicalDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: canonicalDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'tester@test.local'], { cwd: canonicalDir, stdio: 'pipe' });
  mkdirSync(join(canonicalDir, 'src'));
  mkdirSync(join(canonicalDir, 'tests'));
  writeFileSync(join(canonicalDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
  writeFileSync(
    join(canonicalDir, 'tests', 'gate.test.mjs'),
    `import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nimport { test } from 'node:test';\ntest('gate', () => assert.equal(value, 'v2'));\n`,
  );
  execFileSync('git', ['add', '.'], { cwd: canonicalDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: canonicalDir, stdio: 'pipe' });
  const baseOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: canonicalDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/afr/canonical', baseOid], { cwd: canonicalDir });

  const task = {
    task_id: 'TASK-HIB-19-FULL-LIFECYCLE',
    fixture_dir: canonicalDir,
    state: 'CREATED',
    host_isolation: true,
    author_executor: 'codex',
    reviewer_executor: 'claude',
    acceptance_cmd: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
    acceptance_binding: null,
    trusted_import: {
      enabled: true,
      candidate_dir: candidateDir,
      cas_dir: casDir,
      proposed_required: ['src/**'],
      policy: {
        allowed_root: ['src/**', 'tests/**'],
        forbidden: [],
        protected_paths: [],
        projection: { exclude: [] },
        import: { deny: [] },
      },
      acceptance: {
        tier: 'TierA',
        acceptance_profile_digest: 'digest-hib-19',
        acceptance_assets_digest: 'assets-hib-19',
        dependency_fixture_id: 'dep-hib-19',
      },
    },
  };

  // Unlocking now requires positive scope evidence: point AF_CGROUP_BASE at a
  // verified-empty base so the lifecycle can prove quiesce instead of assuming it.
  const oldCgroup = process.env.AF_CGROUP_BASE;
  const emptyScopeBase = mkdtempSync(join(tmpdir(), 'af-hib19-scopes-'));
  process.env.AF_CGROUP_BASE = emptyScopeBase;

  try {
    const res = await runTrustedImportTask(task, {
      runAuthor: async (rev, { cwd }) => {
        writeFileSync(join(cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
        return {
          executor_run_id: 'RUN-AUTHOR-OK',
          writer_termination: {
            process_started: true,
            process_group_alive: false,
            termination_confirmed: true,
            scope_verified: true,
            scope_kind: 'cgroup',
          },
        };
      },
      runReview: async (rev, { cwd }) => {
        task.last_review_termination_evidence = {
          process_started: true,
          process_group_alive: false,
          termination_confirmed: true,
          scope_verified: true,
          scope_kind: 'cgroup',
        };
        return {
          decision: 'PASS',
          summary: 'value is correctly v2 and test passes',
        };
      },
      saveTask: (t) => Object.assign(task, t),
    });

    // Verification 1: task completed
    assert.strictEqual(res.state, 'COMPLETED');
    assert.strictEqual(res.trusted_import.phase, 'PROMOTED');

    // Verification 2: Git canonical ref was promoted to a new commit OID
    const newOid = execFileSync('git', ['rev-parse', 'refs/afr/canonical'], { cwd: canonicalDir, encoding: 'utf8' }).trim();
    assert.notStrictEqual(newOid, baseOid, 'Canonical ref must be promoted to a new commit OID');

    // Verification 3: Content in promoted canonical is updated
    const canonicalContent = execFileSync('git', ['cat-file', '-p', `${newOid}:src/value.mjs`], { cwd: canonicalDir, encoding: 'utf8' });
    assert.match(canonicalContent, /v2/);

    // Verification 4: Boundary was cleanly disengaged after confirmed quiesce & termination
    assert.strictEqual(res.trusted_import.boundary_state, 'DISENGAGED');
    const stat = statSync(canonicalDir);
    assert.strictEqual(stat.uid, process.getuid(), 'Canonical dir must be returned to user UID after clean completion');
    // Restore-consistency evidence: the release reported no ownership/mode mismatch.
    assert.strictEqual(res.trusted_import.boundary_restore.mismatch_count, 0, 'restore must be metadata-exact');
  } finally {
    disengageTaskHostBoundary({ canonicalDir, casDir, force: true });
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    rmSync(emptyScopeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-20: 作用域扫描未知状态必须拒绝解锁 (fail-closed: 未知 != 清空)', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib20-'));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(casDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'main.js'), 'export const canonical = 1;');

  const oldCgroup = process.env.AF_CGROUP_BASE;
  delete process.env.AF_CGROUP_BASE;

  try {
    // 1. Unset base -> unknown, and the array API refuses to answer "[]"
    assert.strictEqual(inspectWriterScopes().status, 'unknown');
    assert.throws(
      () => getActiveWriterScopes(),
      (err) => err.code === WRITER_SCOPE_SCAN_UNKNOWN,
      'getActiveWriterScopes must throw rather than report zero active scopes when it cannot look',
    );

    // 2. Nonexistent base -> unknown
    assert.strictEqual(inspectWriterScopes('/nonexistent/af-cgroup-base').status, 'unknown');

    // 3. An unconfirmable scan must retain the boundary instead of unlocking
    engageTaskHostBoundary({ canonicalDir, casDir });
    assert.strictEqual(statSync(canonicalDir).uid, 0, 'engage must take root ownership');

    const res = disengageTaskHostBoundary({ canonicalDir, casDir });
    assert.strictEqual(res.disengaged, false, 'unknown scope state must never unlock the boundary');
    assert.match(res.reason, /CANNOT_CONFIRM_WRITER_SCOPES/);
    assert.strictEqual(statSync(canonicalDir).uid, 0, 'root DAC protection must be retained');
    assert.throws(
      () => writeFileSync(join(canonicalDir, 'later.js'), 'evil'),
      /(EACCES|EPERM)/,
      'write must still be blocked while the boundary is retained',
    );
  } finally {
    disengageTaskHostBoundary({ canonicalDir, casDir, force: true });
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-21: 嵌套 writer scope 覆盖与缺失 cgroup.procs 的未知语义', () => {
  const base = mkdtempSync(join(tmpdir(), 'af-hib21-scopes-'));
  try {
    // Empty base -> confirmed empty
    assert.strictEqual(inspectWriterScopes(base).status, 'empty');

    // Parent scope with empty cgroup.procs is not active ...
    const parent = join(base, 'af-writer-outer');
    mkdirSync(parent, { recursive: true });
    writeFileSync(join(parent, 'cgroup.procs'), '\n');
    assert.strictEqual(inspectWriterScopes(base).status, 'empty', 'empty parent scope must not be reported active');

    // ... but a NESTED scope holding live PIDs must be detected (parents do not list descendant PIDs)
    const nested = join(parent, 'af-writer-inner');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'cgroup.procs'), '4242\n4243\n');

    const nestedScan = inspectWriterScopes(base);
    assert.strictEqual(nestedScan.status, 'active', 'nested writer scope must be detected');
    assert.deepStrictEqual(nestedScan.scopes.map((s) => s.path), [nested]);
    assert.deepStrictEqual(nestedScan.scopes[0].pids, ['4242', '4243']);

    // A scope whose cgroup.procs cannot be read is unknown, never empty
    const orphan = join(base, 'af-writer-orphan');
    mkdirSync(orphan, { recursive: true });
    const unknownScan = inspectWriterScopes(base);
    assert.strictEqual(unknownScan.status, 'unknown', 'scope without cgroup.procs must not count as empty');
    assert.match(unknownScan.reason, /missing cgroup\.procs/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('HIB-22: 解除保护精确恢复原属主/组/权限 (私有文件、可执行文件、目录)', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib22-'));
  const repoDir = join(root, 'canonical');
  const privateDir = join(repoDir, 'private');
  const binDir = join(repoDir, 'bin');
  mkdirSync(privateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  chmodSync(privateDir, 0o700);
  chmodSync(binDir, 0o755);

  const secret = join(privateDir, 'secret.txt');
  const runSh = join(binDir, 'run.sh');
  const readme = join(repoDir, 'README.md');
  writeFileSync(secret, 'secret');
  writeFileSync(runSh, '#!/bin/sh\necho hi\n');
  writeFileSync(readme, 'readme');
  chmodSync(secret, 0o600);
  chmodSync(runSh, 0o755);
  chmodSync(readme, 0o644);
  const link = join(repoDir, 'run-link.sh');
  symlinkSync(runSh, link);

  const metadata = (dir) => {
    const out = {};
    const walk = (current, rel) => {
      const st = lstatSync(current);
      out[rel] = `${st.uid}:${st.gid}:${(st.mode & 0o7777).toString(8)}`;
      if (st.isDirectory()) {
        for (const name of readdirSync(current).sort()) walk(join(current, name), rel === '' ? name : `${rel}/${name}`);
      }
    };
    walk(dir, '');
    return out;
  };

  const before = metadata(repoDir);
  try {
    protectPathsWithNonOwnerBoundary([repoDir]);
    assert.strictEqual(statSync(readme).uid, 0, 'protection must take root ownership');

    const report = releasePathsBoundary([repoDir]);
    assert.deepStrictEqual(report.mismatches, [], `restore mismatches: ${JSON.stringify(report.mismatches)}`);
    assert.deepStrictEqual(report.failures, []);
    assert.strictEqual(report.restored, true);

    const after = metadata(repoDir);
    assert.deepStrictEqual(after, before, 'owner, group and permission bits must be restored exactly');
    assert.strictEqual(statSync(secret).mode & 0o777, 0o600, 'private file must not become world-readable');
    assert.strictEqual(statSync(runSh).mode & 0o777, 0o755, 'executable bit must survive protect/release');
    assert.strictEqual(statSync(privateDir).mode & 0o777, 0o700, 'directory mode must survive protect/release');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-23: 缺少保护前快照时拒绝猜测式恢复 (BOUNDARY_SNAPSHOT_MISSING)', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib23-'));
  const canonicalDir = join(root, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'main.js'), 'export const canonical = 1;');

  const oldCgroup = process.env.AF_CGROUP_BASE;
  const emptyScopeBase = mkdtempSync(join(tmpdir(), 'af-hib23-scopes-'));
  process.env.AF_CGROUP_BASE = emptyScopeBase;

  try {
    // Protect WITHOUT capturing metadata: original ownership/permissions are unknown.
    protectPathsWithNonOwnerBoundary([canonicalDir], { captureSnapshot: false });
    assert.strictEqual(loadPathSnapshot(canonicalDir), null, 'no snapshot must have been recorded');

    assert.throws(
      () => releasePathsBoundary([canonicalDir], undefined, undefined, { requireSnapshot: true }),
      (err) => err.code === BOUNDARY_SNAPSHOT_MISSING,
      'release must refuse to guess when the original metadata is unknown',
    );

    // The lifecycle path must react the same way: retain, do not unlock.
    const res = disengageTaskHostBoundary({ canonicalDir, casDir: null });
    assert.strictEqual(res.disengaged, false);
    assert.match(res.reason, /BOUNDARY_SNAPSHOT_MISSING/);
    assert.strictEqual(statSync(canonicalDir).uid, 0, 'boundary must be retained when restore cannot be exact');
  } finally {
    releasePathsBoundary([canonicalDir], undefined, undefined, { force: true });
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    rmSync(emptyScopeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-24: 完整生命周期在作用域状态不可确认时保留保护 (不误判为清空)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib24-'));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const candidateDir = join(root, 'candidate');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(casDir, { recursive: true });
  mkdirSync(candidateDir, { recursive: true });

  execFileSync('git', ['init', '-b', 'main'], { cwd: canonicalDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: canonicalDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'tester@test.local'], { cwd: canonicalDir, stdio: 'pipe' });
  mkdirSync(join(canonicalDir, 'src'));
  mkdirSync(join(canonicalDir, 'tests'));
  writeFileSync(join(canonicalDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
  writeFileSync(
    join(canonicalDir, 'tests', 'gate.test.mjs'),
    `import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nimport { test } from 'node:test';\ntest('gate', () => assert.equal(value, 'v2'));\n`,
  );
  execFileSync('git', ['add', '.'], { cwd: canonicalDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: canonicalDir, stdio: 'pipe' });
  const baseOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: canonicalDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/afr/canonical', baseOid], { cwd: canonicalDir });

  const task = {
    task_id: 'TASK-HIB-24-SCOPE-UNKNOWN',
    fixture_dir: canonicalDir,
    state: 'CREATED',
    host_isolation: true,
    author_executor: 'codex',
    reviewer_executor: 'claude',
    acceptance_cmd: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
    acceptance_binding: null,
    trusted_import: {
      enabled: true,
      candidate_dir: candidateDir,
      cas_dir: casDir,
      proposed_required: ['src/**'],
      policy: {
        allowed_root: ['src/**', 'tests/**'],
        forbidden: [],
        protected_paths: [],
        projection: { exclude: [] },
        import: { deny: [] },
      },
      acceptance: {
        tier: 'TierA',
        acceptance_profile_digest: 'digest-hib-24',
        acceptance_assets_digest: 'assets-hib-24',
        dependency_fixture_id: 'dep-hib-24',
      },
    },
  };

  const oldCgroup = process.env.AF_CGROUP_BASE;
  delete process.env.AF_CGROUP_BASE; // scope emptiness is now UNKNOWABLE

  try {
    const res = await runTrustedImportTask(task, {
      runAuthor: async (rev, { cwd }) => {
        writeFileSync(join(cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
        return {
          executor_run_id: 'RUN-AUTHOR-HIB24',
          writer_termination: {
            process_started: true,
            process_group_alive: false,
            termination_confirmed: true,
            scope_verified: true,
            scope_kind: 'cgroup',
          },
        };
      },
      runReview: async () => {
        task.last_review_termination_evidence = {
          process_started: true,
          process_group_alive: false,
          termination_confirmed: true,
          scope_verified: true,
          scope_kind: 'cgroup',
        };
        return { decision: 'PASS', summary: 'value is v2 and the gate passes' };
      },
      saveTask: (t) => Object.assign(task, t),
    });

    // Promotion may legitimately complete, but the boundary must NOT be released
    // on the strength of an unconfirmable scope scan.
    assert.strictEqual(res.trusted_import.boundary_state, 'PROTECTION_RETAINED_PENDING_RECOVERY');
    assert.match(res.trusted_import.boundary_retained_reason, /could not be confirmed/);
    assert.strictEqual(statSync(canonicalDir).uid, 0, 'root DAC boundary must be retained');
    assert.throws(() => chmodSync(canonicalDir, 0o777), /(EPERM|EACCES)/);
  } finally {
    disengageTaskHostBoundary({ canonicalDir, casDir, force: true });
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-25: 宿主 /tmp 被屏蔽时 executor scratch 目录仍对沙箱可见 (schema 交接)', () => {
  if (!canUseRestrictedSandbox()) return;

  const scratch = executorScratchDir(`HIB-25-${process.pid}`);
  const schemaFile = join(scratch, 'response-schema.json');
  writeFileSync(schemaFile, '{"type":"object"}');
  const childOutput = join(scratch, 'child-output.txt');
  const hostTmpCanary = join(tmpdir(), `af-hib25-canary-${Date.now()}.json`);
  writeFileSync(hostTmpCanary, '{"secret":true}');

  try {
    // A real executor failure mode: agy receives --json-schema <host /tmp file> and
    // aborts with "failed to read schema file" when /tmp is masked.
    const launch = buildRestrictedSandboxArgs({
      command: 'bash',
      args: ['-c', `
        # host-prepared input must be readable through the scratch bind
        [ -r "${schemaFile}" ] || exit 1

        # a bare host /tmp file must stay invisible (tmpfs masking still holds)
        if [ -e "${hostTmpCanary}" ]; then exit 2; fi

        # the executor must be able to write its own output into the scratch dir
        echo ok > "${childOutput}" || exit 3

        exit 0
      `],
      role: 'reviewer',
      platform: 'antigravity',
      allowedWritableDirs: [scratch],
    });

    const res = spawnSync(launch.command, launch.args, { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `scratch hand-off probe failed (code ${res.status}): stderr=${res.stderr}`);
    assert.strictEqual(readFileSync(childOutput, 'utf8').trim(), 'ok', 'sandbox must be able to write into the scratch dir');
    assert.strictEqual(readFileSync(schemaFile, 'utf8'), '{"type":"object"}', 'host schema file must be reachable and unchanged');
  } finally {
    try { unlinkSync(hostTmpCanary); } catch { /* best effort */ }
    try { unlinkSync(childOutput); } catch { /* best effort */ }
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('HIB-26: scope 根目录下的任意后代都被扫描, 扫描截断必须返回未知', () => {
  const base = mkdtempSync(join(tmpdir(), 'af-hib26-scopes-'));
  const deepBase = mkdtempSync(join(tmpdir(), 'af-hib26-deep-'));
  try {
    const scope = join(base, 'af-writer-outer');
    mkdirSync(scope, { recursive: true });
    writeFileSync(join(scope, 'cgroup.procs'), '\n'); // scope root itself is idle

    // A NON af-* child cgroup holding a live pid: the parent's cgroup.procs never lists it.
    const worker = join(scope, 'worker');
    mkdirSync(worker, { recursive: true });
    writeFileSync(join(worker, 'cgroup.procs'), '5150\n');

    // Every cgroup directory carries its own cgroup.procs, so the synthetic tree must too.
    const pool = join(worker, 'pool');
    mkdirSync(pool, { recursive: true });
    writeFileSync(join(pool, 'cgroup.procs'), '\n');

    const deep = join(pool, 'task-1');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'cgroup.procs'), '5151\n');

    const scan = inspectWriterScopes(base);
    assert.strictEqual(scan.status, 'active', 'descendants of a scope root must be scanned');
    assert.deepStrictEqual(
      scan.scopes.map((s) => s.path).sort(),
      [deep, worker].sort(),
      'every descendant cgroup holding a live pid must be reported',
    );
    assert.deepStrictEqual(scan.scopes.find((s) => s.path === worker).pids, ['5150']);

    // Unrelated sibling cgroups outside af-* roots are not walked.
    const unrelated = join(base, 'not-a-scope');
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, 'cgroup.procs'), '9999\n');
    const narrowed = inspectWriterScopes(base);
    assert.strictEqual(narrowed.scopes.some((s) => s.path === unrelated), false, 'non af-* roots must not be walked');

    // A truncated scan is `unknown`, never `empty`.
    let cur = join(deepBase, 'af-writer-deep');
    mkdirSync(cur, { recursive: true });
    writeFileSync(join(cur, 'cgroup.procs'), '\n');
    for (let i = 0; i < MAX_WRITER_SCOPE_DEPTH + 2; i += 1) {
      cur = join(cur, `level-${i}`);
      mkdirSync(cur);
      writeFileSync(join(cur, 'cgroup.procs'), '\n');
    }
    const truncated = inspectWriterScopes(deepBase);
    assert.strictEqual(truncated.status, 'unknown', 'a truncated scan must never be reported as empty');
    assert.match(truncated.reason, /truncated at depth/);
  } finally {
    rmSync(deepBase, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

test('HIB-27: 猜模式恢复不得报告已解锁 (RESTORE_INCOMPLETE, 且不冒充保护完整)', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib27-'));
  const canonicalDir = join(root, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'main.js'), 'export const canonical = 1;');

  const oldCgroup = process.env.AF_CGROUP_BASE;
  const emptyScopeBase = mkdtempSync(join(tmpdir(), 'af-hib27-scopes-'));
  process.env.AF_CGROUP_BASE = emptyScopeBase;

  try {
    // Protected without a snapshot: the release can only guess, so it is unverified.
    protectPathsWithNonOwnerBoundary([canonicalDir], { captureSnapshot: false });
    assert.strictEqual(statSync(canonicalDir).uid, 0);

    const res = disengageTaskHostBoundary({ canonicalDir, casDir: null, force: true });
    assert.strictEqual(res.disengaged, false, 'a guessed restore must not be reported as a clean unlock');
    assert.strictEqual(res.outcome, 'RESTORE_INCOMPLETE');
    assert.match(res.reason, /BOUNDARY_RESTORE_INCOMPLETE/);
    assert.deepStrictEqual(res.report.fallback, [canonicalDir], 'the guessed path must be named in the report');

    // Ownership went back to the host user, so the boundary must NOT be advertised as active.
    assert.strictEqual(statSync(canonicalDir).uid, process.getuid(), 'guessed release returns host ownership');
    assert.strictEqual(process.env.AF_HOST_BOUNDARY_ACTIVE, undefined, 'an unverifiable release must clear the boundary flag');
  } finally {
    releasePathsBoundary([canonicalDir], undefined, undefined, { force: true });
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    rmSync(emptyScopeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-28: 恢复失配/操作失败时 disengage 报告 RESTORE_INCOMPLETE 而非 DISENGAGED', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib28-'));
  const canonicalDir = join(root, 'canonical');
  mkdirSync(canonicalDir, { recursive: true });
  writeFileSync(join(canonicalDir, 'main.js'), 'export const canonical = 1;');

  const oldCgroup = process.env.AF_CGROUP_BASE;
  const emptyScopeBase = mkdtempSync(join(tmpdir(), 'af-hib28-scopes-'));
  process.env.AF_CGROUP_BASE = emptyScopeBase;

  try {
    protectPathsWithNonOwnerBoundary([canonicalDir]);
    const snapshot = loadPathSnapshot(canonicalDir);
    assert.ok(snapshot, 'a pre-protection snapshot must exist');

    // Simulate an unusable snapshot entry: a mode the restore cannot apply.
    const parsed = JSON.parse(readFileSync(snapshot.file, 'utf8'));
    const entry = parsed.entries.find((e) => e.rel === 'main.js');
    assert.ok(entry, 'snapshot must contain the protected file');
    entry.mode = '99';
    writeFileSync(snapshot.file, JSON.stringify(parsed));

    const res = disengageTaskHostBoundary({ canonicalDir, casDir: null });
    assert.strictEqual(res.disengaged, false, 'a failed/partial restore must never claim success');
    assert.strictEqual(res.outcome, 'RESTORE_INCOMPLETE');
    assert.match(res.reason, /BOUNDARY_RESTORE_INCOMPLETE/);
    assert.ok(
      res.report.mismatches.length + res.report.failures.length > 0,
      'the report must carry the failure detail instead of reporting success',
    );
    assert.ok(res.report.mismatch_sample.length > 0, 'a sample of mismatching entries must be exposed for recovery');
  } finally {
    releasePathsBoundary([canonicalDir], undefined, undefined, { force: true });
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    rmSync(emptyScopeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('HIB-29: 生命周期把无法验证的恢复记录为 RESTORE_INCOMPLETE (不冒充 DISENGAGED)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-hib29-'));
  const canonicalDir = join(root, 'canonical');
  const casDir = join(root, 'cas');
  const candidateDir = join(root, 'candidate');
  mkdirSync(canonicalDir, { recursive: true });
  mkdirSync(casDir, { recursive: true });
  mkdirSync(candidateDir, { recursive: true });

  execFileSync('git', ['init', '-b', 'main'], { cwd: canonicalDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: canonicalDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'tester@test.local'], { cwd: canonicalDir, stdio: 'pipe' });
  mkdirSync(join(canonicalDir, 'src'));
  mkdirSync(join(canonicalDir, 'tests'));
  writeFileSync(join(canonicalDir, 'src', 'value.mjs'), "export const value = 'v1';\n");
  writeFileSync(
    join(canonicalDir, 'tests', 'gate.test.mjs'),
    `import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nimport { test } from 'node:test';\ntest('gate', () => assert.equal(value, 'v2'));\n`,
  );
  execFileSync('git', ['add', '.'], { cwd: canonicalDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: canonicalDir, stdio: 'pipe' });
  const baseOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: canonicalDir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/afr/canonical', baseOid], { cwd: canonicalDir });

  const task = {
    task_id: 'TASK-HIB-29-RESTORE-INCOMPLETE',
    fixture_dir: canonicalDir,
    state: 'CREATED',
    host_isolation: true,
    author_executor: 'codex',
    reviewer_executor: 'claude',
    acceptance_cmd: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
    acceptance_binding: null,
    trusted_import: {
      enabled: true,
      candidate_dir: candidateDir,
      cas_dir: casDir,
      proposed_required: ['src/**'],
      policy: {
        allowed_root: ['src/**', 'tests/**'],
        forbidden: [],
        protected_paths: [],
        projection: { exclude: [] },
        import: { deny: [] },
      },
      acceptance: {
        tier: 'TierA',
        acceptance_profile_digest: 'digest-hib-29',
        acceptance_assets_digest: 'assets-hib-29',
        dependency_fixture_id: 'dep-hib-29',
      },
    },
  };

  const oldCgroup = process.env.AF_CGROUP_BASE;
  const emptyScopeBase = mkdtempSync(join(tmpdir(), 'af-hib29-scopes-'));
  process.env.AF_CGROUP_BASE = emptyScopeBase;

  try {
    let corrupted = false;
    const res = await runTrustedImportTask(task, {
      runAuthor: async (rev, { cwd }) => {
        writeFileSync(join(cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
        return {
          executor_run_id: 'RUN-AUTHOR-HIB29',
          writer_termination: {
            process_started: true,
            process_group_alive: false,
            termination_confirmed: true,
            scope_verified: true,
            scope_kind: 'cgroup',
          },
        };
      },
      runReview: async () => {
        task.last_review_termination_evidence = {
          process_started: true,
          process_group_alive: false,
          termination_confirmed: true,
          scope_verified: true,
          scope_kind: 'cgroup',
        };
        return { decision: 'PASS', summary: 'value is v2 and the gate passes' };
      },
      saveTask: (t) => {
        Object.assign(task, t);
        // The promotion step releases and re-protects the repo, which re-captures the
        // snapshot. Corrupt it only once promotion is done, i.e. right before the
        // lifecycle's final release, to simulate a snapshot that cannot be applied.
        if (!corrupted && t?.trusted_import?.phase === 'PROMOTED') {
          corrupted = true;
          const snap = loadPathSnapshot(canonicalDir);
          const parsed = JSON.parse(readFileSync(snap.file, 'utf8'));
          parsed.entries.find((e) => e.rel === 'src/value.mjs').mode = '99';
          writeFileSync(snap.file, JSON.stringify(parsed));
        }
      },
    });
    assert.strictEqual(corrupted, true, 'promotion must have completed for this scenario to be exercised');

    assert.strictEqual(res.trusted_import.boundary_state, 'RESTORE_INCOMPLETE', 'an unverifiable restore must not be recorded as DISENGAGED');
    assert.match(res.trusted_import.boundary_retained_reason, /BOUNDARY_RESTORE_INCOMPLETE/);
    assert.ok(
      res.trusted_import.boundary_restore.mismatch_count > 0 || res.trusted_import.boundary_restore.failures.length > 0,
      'the task record must carry the restore failure evidence',
    );
    assert.strictEqual(statSync(canonicalDir).uid, process.getuid(), 'ownership is released even though the restore is unverified');
  } finally {
    disengageTaskHostBoundary({ canonicalDir, casDir, force: true });
    if (oldCgroup !== undefined) process.env.AF_CGROUP_BASE = oldCgroup; else delete process.env.AF_CGROUP_BASE;
    rmSync(emptyScopeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

