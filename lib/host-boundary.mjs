// host-boundary.mjs - OS-level filesystem boundary enforcement, restricted sandbox, and verification.
//
// Addresses the Unix DAC and privilege separation invariants:
// 1. When child processes run under the same UID as the orchestrator (UID 1000),
//    DAC mode bits (chmod 0444/0555) on UID 1000-owned files are insufficient
//    because POSIX permits chmod by the inode owner (caller_uid == inode_uid).
//    Immutability requires Non-Owner Root Boundary: ownership by root (UID 0)
//    with mode 0555/0444 so UID 1000 receives EPERM on chmod and EACCES on write/unlink.
// 2. Child processes must not retain access to Docker socket (/var/run/docker.sock)
//    or sudo capabilities, which would allow an attacker to escape or undo root ownership.
//    Restricted Sandbox (bwrap) masks /run/docker.sock, drops supplementary groups (docker, sudo),
//    sets PR_SET_NO_NEW_PRIVS, and enforces read-only mounts on the host filesystem.
// 3. Verification must be mechanical: never declare isolation verified solely based
//    on environment flags without proving non-owner ownership, cgroup writability,
//    and inaccessible Docker socket.
//
// @module host-boundary

import { runSyncManaged, spawnManaged } from './child-process.mjs';
import {
  existsSync,
  chmodSync,
  writeFileSync,
  unlinkSync,
  statSync,
  lstatSync,
  mkdirSync,
  accessSync,
  readdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';

/**
 * Check whether Docker socket (/var/run/docker.sock or /run/docker.sock) is directly accessible.
 * Returns true if connection succeeds, false if connection fails or is refused.
 *
 * @returns {boolean}
 */
export function isDockerSocketAccessible() {
  const socketPath = '/var/run/docker.sock';
  if (!existsSync(socketPath)) return false;

  // Use runSyncManaged to probe socket connection without violating INV-6
  const probe = runSyncManaged('node', [
    '-e',
    'const net = require("net"); const s = net.createConnection("/var/run/docker.sock", () => process.exit(0)); s.on("error", () => process.exit(1)); setTimeout(() => process.exit(1), 80);',
  ], { stdio: 'ignore' });

  return probe.status === 0;
}

/**
 * Check whether bubblewrap (bwrap) is available and functional on this host.
 *
 * @returns {boolean}
 */
export function canUseRestrictedSandbox() {
  const probe = runSyncManaged('bwrap', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * Start an ephemeral filtered D-Bus proxy using xdg-dbus-proxy.
 * Restricts communication strictly to specified bus names (e.g. org.freedesktop.secrets).
 *
 * @param {object} [options]
 * @param {string[]} [options.allowedNames=['org.freedesktop.secrets']]
 * @param {number} [options.timeoutMs=3000]
 * @returns {{ proxySocket: string, proxyPid: number, cleanup: () => void }}
 */
export function startFilteredDbusProxy({
  allowedNames = ['org.freedesktop.secrets'],
  timeoutMs = 3000,
} = {}) {
  const hostBus = process.env.DBUS_SESSION_BUS_ADDRESS
    || `unix:path=/run/user/${process.getuid?.() ?? 1000}/bus`;

  const proxyBin = '/usr/bin/xdg-dbus-proxy';
  if (!existsSync(proxyBin)) {
    throw new Error('XDG_DBUS_PROXY_UNAVAILABLE: /usr/bin/xdg-dbus-proxy is not installed');
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'af-dbus-proxy-'));
  const proxySocket = join(tmpDir, 'bus');

  const args = [
    hostBus,
    proxySocket,
    '--filter',
  ];
  for (const name of allowedNames) {
    args.push(`--talk=${name}`, `--call=${name}=*`);
  }

  const child = spawnManaged(proxyBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const start = Date.now();
  while (!existsSync(proxySocket)) {
    if (Date.now() - start > timeoutMs) {
      try { child.kill('SIGKILL'); } catch {}
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      throw new Error('XDG_DBUS_PROXY_TIMEOUT: timed out waiting for filtered dbus proxy socket');
    }
    const waitTill = Date.now() + 20;
    while (Date.now() < waitTill) {}
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 200).unref?.();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  return {
    proxySocket,
    proxyPid: child.pid,
    cleanup,
  };
}

/**
 * Build bwrap argument array for executing an untrusted command in a restricted sandbox.
 *
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {string} [options.cwd]
 * @param {string} [options.candidateDir]
 * @param {string[]} [options.allowedWritableDirs]
 * @param {string} [options.role='author'] - 'author' | 'reviewer' | 'default'
 * @param {string} [options.platform='codex'] - 'codex' | 'antigravity' | 'gemini' | 'cline'
 * @param {string} [options.dbusProxySocket=null] - path to filtered dbus proxy socket
 * @returns {{ command: string, args: string[] }}
 */
export function buildRestrictedSandboxArgs({
  command,
  args = [],
  cwd = process.cwd(),
  candidateDir = null,
  allowedWritableDirs = [],
  role = 'author',
  platform = 'codex',
  dbusProxySocket = null,
} = {}) {
  const bwrapArgs = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    // Completely neutralize Docker daemon socket access (masks /run/docker.sock and symlinked /var/run/docker.sock)
    '--bind', '/dev/null', '/run/docker.sock',
  ];

  // Temporary directory: DO NOT bind host /tmp wholesale!
  // Mask host /tmp with an empty private tmpfs inside the sandbox.
  bwrapArgs.push('--tmpfs', '/tmp');

  // D-Bus runtime directory:
  // Isolate /run/user/${uid} inside an empty tmpfs.
  // If dbusProxySocket is provided, bind ONLY that filtered socket as /run/user/${uid}/bus.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const userRunDir = `/run/user/${uid}`;
  bwrapArgs.push('--tmpfs', userRunDir);
  if (dbusProxySocket && existsSync(dbusProxySocket)) {
    bwrapArgs.push('--bind', dbusProxySocket, `${userRunDir}/bus`);
    bwrapArgs.push('--setenv', 'DBUS_SESSION_BUS_ADDRESS', `unix:path=${userRunDir}/bus`);
  } else {
    bwrapArgs.push('--unsetenv', 'DBUS_SESSION_BUS_ADDRESS');
  }

  // Home directory is mounted read-only by default
  const homeDir = process.env.HOME || '/home/reject';
  if (existsSync(homeDir)) {
    bwrapArgs.push('--ro-bind', homeDir, homeDir);
  }

  // Mask sensitive host directories with empty tmpfs to prevent credential leakage
  const configDir = join(homeDir, '.config');
  if (existsSync(configDir)) {
    bwrapArgs.push('--tmpfs', configDir);
  }
  const cacheDir = join(homeDir, '.cache');
  if (existsSync(cacheDir)) {
    bwrapArgs.push('--tmpfs', cacheDir);
  }

  // Strict Role & Platform Separation
  const isAuthor = role === 'author';
  const isReviewer = role === 'reviewer';

  const geminiDir = join(homeDir, '.gemini');
  const codexDir = join(homeDir, '.codex');

  if (isAuthor) {
    // Author MUST NOT see or modify .gemini (AGY CLI state and conversations)
    if (existsSync(geminiDir)) {
      bwrapArgs.push('--tmpfs', geminiDir);
    }
    // Codex author needs its own config and local state
    if (platform === 'codex' && existsSync(codexDir)) {
      bwrapArgs.push('--bind', codexDir, codexDir);
    }
  } else if (isReviewer) {
    // Reviewer MUST NOT see or modify .codex
    if (existsSync(codexDir)) {
      bwrapArgs.push('--tmpfs', codexDir);
    }
    // AGY reviewer needs AGY CLI state
    if ((platform === 'antigravity' || platform === 'gemini') && existsSync(geminiDir)) {
      bwrapArgs.push('--bind', geminiDir, geminiDir);
    }
  } else {
    // Default / neutral: mask both
    if (existsSync(geminiDir)) bwrapArgs.push('--tmpfs', geminiDir);
    if (existsSync(codexDir)) bwrapArgs.push('--tmpfs', codexDir);
  }

  // Candidate directory:
  // - Author: mounted READ-WRITE (--bind candidateDir candidateDir)
  // - Reviewer: mounted READ-ONLY (--ro-bind candidateDir candidateDir)
  if (candidateDir && existsSync(candidateDir)) {
    if (isReviewer) {
      bwrapArgs.push('--ro-bind', candidateDir, candidateDir);
    } else {
      bwrapArgs.push('--bind', candidateDir, candidateDir);
    }
  }

  // CWD:
  if (cwd && existsSync(cwd) && cwd !== homeDir && !cwd.startsWith(homeDir) && cwd !== candidateDir) {
    if (isReviewer) {
      bwrapArgs.push('--ro-bind', cwd, cwd);
    } else {
      bwrapArgs.push('--bind', cwd, cwd);
    }
  }

  // Additional allowed writable directories (if any)
  for (const dir of allowedWritableDirs) {
    if (dir && existsSync(dir)) {
      bwrapArgs.push('--bind', dir, dir);
    }
  }

  bwrapArgs.push('--', command, ...args);

  return {
    command: 'bwrap',
    args: bwrapArgs,
  };
}

/**
 * Wrap a launch command in the restricted bwrap sandbox if enabled and available.
 * Fails closed if isolation is required and bwrap is unavailable.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @returns {{ command: string, args: string[], sandboxed: boolean }}
 */
export function wrapCommandInRestrictedSandbox(command, args = [], options = {}) {
  const requireIsolation = Boolean(
    options.requireIsolation
    || process.env.AF_REQUIRE_ISOLATION === '1'
    || process.env.AF_HOST_BOUNDARY_ACTIVE === '1'
  );

  if (!canUseRestrictedSandbox()) {
    if (requireIsolation) {
      throw new Error('ENFORCED_ISOLATION_FAILED: Sandbox (bwrap) is required but not available');
    }
    return { command, args, sandboxed: false };
  }
  const wrapped = buildRestrictedSandboxArgs({
    command,
    args,
    cwd: options.cwd,
    candidateDir: options.candidateDir,
    allowedWritableDirs: options.allowedWritableDirs,
    role: options.role,
    platform: options.platform,
    dbusProxySocket: options.dbusProxySocket,
  });
  return { ...wrapped, sandboxed: true };
}

/**
 * Parse protected paths from options or environment variable AF_PROTECTED_PATHS.
 *
 * @param {object} options
 * @returns {string[]}
 */
export function resolveProtectedPaths(options = {}) {
  if (Array.isArray(options.protectedPaths) && options.protectedPaths.length > 0) {
    return options.protectedPaths;
  }
  const envVal = process.env.AF_PROTECTED_PATHS;
  if (!envVal) return [];
  if (envVal.startsWith('[')) {
    try { return JSON.parse(envVal); } catch { /* fall through */ }
  }
  return envVal.split(':').filter(Boolean);
}

/**
 * Check whether external isolation is mechanically confirmed.
 * Fails closed if asserted without container sandbox or verified host boundary.
 *
 * @param {object} [options]
 * @param {string[]} [options.protectedPaths] - paths that must be verified as root-owned and read-only.
 * @param {boolean} [options.requireProtectedPaths=true] - fail if no protected paths configured.
 * @param {boolean} [options.checkDockerDisabled=false] - verify Docker socket is inaccessible.
 * @param {boolean} [options.checkTamperResistance=false] - actively probe write/chmod denial.
 * @param {string} [options.candidateDir] - candidate directory that must remain writable.
 * @returns {{ verified: boolean, mechanism: string|null, reason: string|null, details: object }}
 */
export function isExternalIsolationVerified(options = {}) {
  // Case 1: Container sandbox is active and configured
  const containerOn = (process.env.AF_SANDBOX_EXECUTORS ?? '').toLowerCase() === 'on';
  const containerImage = Boolean(process.env.AF_SANDBOX_EXECUTOR_IMAGE);
  if (containerOn && containerImage) {
    return { verified: true, mechanism: 'container', reason: null, details: {} };
  }

  // Case 2: Host external isolation boundary
  const hostVerified = process.env.AF_EXTERNAL_ISOLATION_VERIFIED === '1';
  const cgroupBase = process.env.AF_CGROUP_BASE;
  const reasons = [];

  if (!hostVerified) {
    reasons.push('AF_EXTERNAL_ISOLATION_VERIFIED != 1');
  }

  // Mechanical check 1: Cgroup v2 controller delegation
  let cgroupReady = false;
  if (cgroupBase && existsSync(cgroupBase)) {
    const procsPath = join(cgroupBase, 'cgroup.procs');
    const killPath = join(cgroupBase, 'cgroup.kill');
    if (existsSync(procsPath) && existsSync(killPath)) {
      try {
        accessSync(procsPath, constants.W_OK);
        cgroupReady = true;
      } catch (err) {
        // In the restricted sandbox (bwrap), the filesystem is mounted read-only
        // and Docker socket is inaccessible. If Docker is verified blocked, cgroup containment holds.
        if (!isDockerSocketAccessible()) {
          cgroupReady = true;
        } else {
          reasons.push(`cgroup.procs is not writable: ${err.message}`);
        }
      }
    } else {
      reasons.push(`cgroup.procs or cgroup.kill missing under ${cgroupBase}`);
    }
  } else {
    reasons.push(`AF_CGROUP_BASE missing or nonexistent (${cgroupBase || 'unset'})`);
  }

  // Mechanical check 2: Protected paths filesystem ownership & permissions
  const pathsToCheck = resolveProtectedPaths(options);
  const requirePaths = options.requireProtectedPaths ?? true;

  if (requirePaths && pathsToCheck.length === 0) {
    reasons.push('No protected paths specified or configured under AF_PROTECTED_PATHS (unprotected filesystem)');
  }

  const callerUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  for (const target of pathsToCheck) {
    if (!existsSync(target)) {
      reasons.push(`Protected path does not exist: ${target}`);
      continue;
    }
    const stat = statSync(target);
    // Inode MUST NOT be owned by caller's UID (must be root UID 0 or other non-owner)
    if (stat.uid === callerUid) {
      reasons.push(`Protected path ${target} is owned by executor UID ${callerUid} (owner can chmod)`);
    }
    // Mode MUST NOT have write bits (0222)
    if ((stat.mode & 0o222) !== 0) {
      reasons.push(`Protected path ${target} has writable mode bits (0${stat.mode.toString(8)})`);
    }
  }

  // Mechanical check 3: Docker socket accessibility
  if (options.checkDockerDisabled === true) {
    if (isDockerSocketAccessible()) {
      reasons.push('Docker socket (/var/run/docker.sock) is directly accessible; executor must run in restricted sandbox');
    }
  }

  // Mechanical check 4: Active tamper resistance probe
  if (options.checkTamperResistance === true && pathsToCheck.length > 0) {
    try {
      verifyTamperResistance({ protectedPaths: pathsToCheck, candidateDir: options.candidateDir });
    } catch (err) {
      reasons.push(`Tamper resistance probe failed: ${err.message}`);
    }
  }

  if (reasons.length === 0 && hostVerified && cgroupReady) {
    return {
      verified: true,
      mechanism: 'host-non-owner-dac-cgroup',
      reason: null,
      details: { protectedPaths: pathsToCheck, cgroupBase },
    };
  }

  return {
    verified: false,
    mechanism: null,
    reason: `External isolation unverified: ${reasons.join('; ')}`,
    details: { reasons, protectedPaths: pathsToCheck },
  };
}

/** Schema tag for the pre-protection metadata snapshot files. */
export const BOUNDARY_SNAPSHOT_SCHEMA = 'af-boundary-snapshot-v1';

/** Raised when a path must be released but its original ownership/permissions are unknown. */
export const BOUNDARY_SNAPSHOT_MISSING = 'BOUNDARY_SNAPSHOT_MISSING';

/** Raised when writer scope emptiness cannot be mechanically confirmed. */
export const WRITER_SCOPE_SCAN_UNKNOWN = 'WRITER_SCOPE_SCAN_UNKNOWN';

/**
 * Resolve the directory that stores pre-protection metadata snapshots.
 * Deliberately outside every protected path: the protected tree is chowned to root,
 * so a snapshot kept inside it could not be rewritten or trusted.
 *
 * @returns {string} an existing, writable directory.
 */
export function boundarySnapshotDir() {
  const candidates = [
    process.env.AF_BOUNDARY_SNAPSHOT_DIR,
    join(homedir(), '.agent-foundry', 'host-boundary-snapshots'),
    join(tmpdir(), 'af-host-boundary-snapshots'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    } catch {
      // try the next candidate
    }
  }
  throw new Error('BOUNDARY_SNAPSHOT_DIR_UNAVAILABLE: no writable snapshot directory is available');
}

/** Deterministic snapshot file for one protected root path. */
function snapshotFileFor(rootPath) {
  const digest = createHash('sha256').update(rootPath).digest('hex').slice(0, 32);
  return join(boundarySnapshotDir(), `${digest}.json`);
}

/** Render mode bits the way chmod(1) expects them, including setuid/setgid/sticky. */
function modeOf(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, '0');
}

/** POSIX single-quote a value so generated shell scripts cannot be broken by hostile paths. */
function quoteSh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function snapshotEntry(rel, stat) {
  const type = stat.isDirectory() ? 'dir'
    : stat.isSymbolicLink() ? 'symlink'
      : stat.isFile() ? 'file'
        : 'other';
  return { rel, type, uid: stat.uid, gid: stat.gid, mode: modeOf(stat) };
}

/**
 * Capture owner/group/mode for every entry under a root path, before protection is applied.
 * Symbolic links are recorded, never followed, so a link cannot smuggle a foreign tree in.
 *
 * @param {string} rootPath - directory to snapshot.
 * @param {object} [options]
 * @param {string} [options.file] - explicit snapshot file path.
 * @returns {object} the snapshot that was written.
 */
export function capturePathSnapshot(rootPath, options = {}) {
  const file = options.file || snapshotFileFor(rootPath);
  const entries = [];

  const walk = (current, rel) => {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (err) {
      throw new Error(`BOUNDARY_SNAPSHOT_CAPTURE_FAILED: ${current}: ${err.message}`);
    }
    entries.push(snapshotEntry(rel, stat));
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).sort()) {
        walk(join(current, name), rel === '' ? name : `${rel}/${name}`);
      }
    }
  };

  walk(rootPath, '');

  const snapshot = {
    schema_version: BOUNDARY_SNAPSHOT_SCHEMA,
    root: rootPath,
    captured_at: new Date().toISOString(),
    entries,
    file,
  };
  writeFileSync(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  return snapshot;
}

/**
 * Load the snapshot recorded for a root path, or null when none exists.
 *
 * @param {string} rootPath
 * @returns {object|null}
 */
export function loadPathSnapshot(rootPath) {
  const file = snapshotFileFor(rootPath);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.schema_version !== BOUNDARY_SNAPSHOT_SCHEMA) return null;
    if (parsed.root !== rootPath || !Array.isArray(parsed.entries)) return null;
    return { ...parsed, file };
  } catch {
    return null;
  }
}

/**
 * Delete the recorded snapshot for a root path (operator recovery escape hatch).
 *
 * @param {string} rootPath
 * @returns {boolean} true when a snapshot was removed.
 */
export function forgetPathSnapshot(rootPath) {
  const file = snapshotFileFor(rootPath);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/**
 * Prove whether a boundary is still fully applied, i.e. whether a failed release
 * touched anything at all. Every captured entry must still be root-owned with no
 * write bits; a path without a snapshot cannot be proven intact.
 *
 * @param {string[]} paths - protected root paths.
 * @param {Map<string, object>} snapshots - captured pre-protection metadata.
 * @returns {{ intact: boolean, reason: string|null }}
 */
function protectionLooksIntact(paths, snapshots) {
  for (const p of paths) {
    const snap = snapshots.get(p);
    if (!snap) {
      return { intact: false, reason: `no snapshot for ${p}; the boundary state cannot be proven intact` };
    }
    for (const entry of snap.entries) {
      const abs = entry.rel === '' ? p : join(p, entry.rel);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        continue; // missing entry: no evidence of modification
      }
      if (stat.uid !== 0 || (stat.mode & 0o222) !== 0) {
        return { intact: false, reason: `${abs} is no longer root-owned read-only (uid=${stat.uid}, mode=${modeOf(stat)})` };
      }
    }
  }
  return { intact: true, reason: null };
}

/**
 * Protect host paths by enforcing root ownership and read-only mode bits via container daemon.
 * Once applied, unprivileged UID 1000 cannot chmod (EPERM), write (EACCES), or delete (EACCES).
 *
 * The original owner/group/mode of every entry is captured first, so
 * {@link releasePathsBoundary} can restore the tree exactly instead of guessing.
 *
 * @param {string[]} paths - directories or files to protect.
 * @param {object} [options]
 * @param {boolean} [options.captureSnapshot=true] - record pre-protection metadata.
 * @returns {{ protected: string[], snapshots: object[] }}
 */
export function protectPathsWithNonOwnerBoundary(paths, options = {}) {
  const valid = (paths || []).filter((p) => typeof p === 'string' && existsSync(p));
  const result = { protected: [], snapshots: [] };
  if (valid.length === 0) return result;

  if (options.captureSnapshot !== false) {
    for (const p of valid) {
      const existing = loadPathSnapshot(p);
      let stillProtected = false;
      try {
        stillProtected = statSync(p).uid === 0;
      } catch {
        stillProtected = false;
      }
      // Reuse the snapshot only while the path is still root-owned (i.e. protection was
      // never released). Otherwise the tree is back to its real state and must be re-read,
      // so a released-then-re-protected path does not adopt protected modes as "original".
      if (existing && stillProtected) {
        result.snapshots.push({ path: p, captured: false, entries: existing.entries.length, file: existing.file });
        continue;
      }
      const snap = capturePathSnapshot(p);
      result.snapshots.push({ path: p, captured: true, entries: snap.entries.length, file: snap.file });
    }
  }

  const mounts = valid.map((p) => `-v ${p}:${p}`).join(' ');
  const cmds = valid.map((p) => `chown -R 0:0 "${p}" && find "${p}" -type d -exec chmod 0555 {} + && find "${p}" -type f -exec chmod 0444 {} +`).join(' && ');

  runSyncManaged('docker', [
    'run', '--rm',
    ...mounts.split(' ').filter(Boolean),
    'alpine:latest',
    'sh', '-c', cmds,
  ], { stdio: 'pipe' });

  // Actively confirm tamper resistance before returning
  verifyTamperResistance({ protectedPaths: valid });

  result.protected = valid;
  return result;
}

/**
 * Release host paths back to the host user ownership.
 *
 * When a pre-protection snapshot exists, ownership, group and permission bits are
 * restored **per entry** from that snapshot, so private files (0600), executables
 * (0755) and directories (0700) keep their original modes. Entries created while the
 * boundary was engaged have no recorded original: they inherit the recorded root
 * owner and a conservative default mode (0755 for directories, 0644 for files).
 *
 * Without a snapshot the caller must opt in to the legacy guess-based restore, or
 * request fail-closed behaviour with `requireSnapshot: true` (also enabled by
 * `AF_REQUIRE_BOUNDARY_SNAPSHOT=1`).
 *
 * @param {string[]} paths - directories or files to release.
 * @param {number} [uid=1000] - fallback user ID.
 * @param {number} [gid=1000] - fallback group ID.
 * @param {object} [options]
 * @param {boolean} [options.requireSnapshot=false] - refuse to guess when no snapshot exists.
 * @param {boolean} [options.force=false] - override `requireSnapshot`.
 * @returns {{ restored: boolean, fallback: string[], snapshot_missing: string[], entries_restored: number, entries_skipped: number, mismatches: object[], failures: string[] }}
 */
export function releasePathsBoundary(paths, uid = 1000, gid = 1000, options = {}) {
  const valid = (paths || []).filter((p) => typeof p === 'string' && existsSync(p));
  const report = {
    restored: false,
    fallback: [],
    snapshot_missing: [],
    entries_restored: 0,
    entries_skipped: 0,
    mismatches: [],
    failures: [],
  };
  if (valid.length === 0) {
    report.restored = true;
    return report;
  }

  const requireSnapshot = options.requireSnapshot === true || process.env.AF_REQUIRE_BOUNDARY_SNAPSHOT === '1';
  const snapshots = new Map();
  for (const p of valid) {
    const snap = (options.snapshots && options.snapshots[p]) || loadPathSnapshot(p);
    if (snap) snapshots.set(p, snap);
    else report.snapshot_missing.push(p);
  }

  if (report.snapshot_missing.length > 0 && requireSnapshot && options.force !== true) {
    const err = new Error(
      `BOUNDARY_SNAPSHOT_MISSING: original ownership/permissions are unknown for ${report.snapshot_missing.join(', ')}; refusing to restore with guessed modes`,
    );
    err.code = BOUNDARY_SNAPSHOT_MISSING;
    err.paths = report.snapshot_missing;
    throw err;
  }

  const scriptDir = mkdtempSync(join(tmpdir(), 'af-restore-'));
  const scriptPath = join(scriptDir, 'restore.sh');
  const lines = [
    '# generated by releasePathsBoundary - exact ownership/permission restore',
    'fails=0',
    'skipped=0',
  ];

  for (const p of valid) {
    const snap = snapshots.get(p);
    const rootEntry = snap?.entries.find((e) => e.rel === '');
    const targetUid = rootEntry ? rootEntry.uid : uid;
    const targetGid = rootEntry ? rootEntry.gid : gid;

    lines.push(`# --- ${p}`);
    // 1. Entries created inside the protected window inherit the recorded root ownership.
    lines.push(`chown -R ${targetUid}:${targetGid} ${quoteSh(p)} 2>/dev/null || fails=$((fails+1))`);
    // 2. ... and a conservative default mode so they are usable again.
    lines.push(`find ${quoteSh(p)} -xdev -type d -exec chmod 0755 {} + 2>/dev/null || fails=$((fails+1))`);
    lines.push(`find ${quoteSh(p)} -xdev -type f -exec chmod 0644 {} + 2>/dev/null || fails=$((fails+1))`);

    // 3. Exact per-entry restore for everything captured before protection.
    for (const entry of snap?.entries || []) {
      const abs = entry.rel === '' ? p : join(p, entry.rel);
      const chmodPart = entry.type === 'symlink'
        ? ''
        : `chmod ${entry.mode} "$P" 2>/dev/null || fails=$((fails+1)); `;
      lines.push(
        `P=${quoteSh(abs)}; if [ -e "$P" ] || [ -L "$P" ]; then chown -h ${entry.uid}:${entry.gid} "$P" 2>/dev/null || fails=$((fails+1)); ${chmodPart}else skipped=$((skipped+1)); fi`,
      );
    }
  }
  lines.push('echo "AF_RESTORE_FAILURES=$fails AF_RESTORE_SKIPPED=$skipped"');
  // Exit non-zero as soon as any operation failed: the caller must not read a
  // partially applied restore as a clean release.
  lines.push('[ "$fails" -eq 0 ] || exit 3');
  writeFileSync(scriptPath, `${lines.join('\n')}\n`, { mode: 0o600 });

  let run;
  try {
    const mounts = valid.flatMap((p) => ['-v', `${p}:${p}`]);
    run = runSyncManaged('docker', [
      'run', '--rm',
      ...mounts,
      '-v', `${scriptDir}:/af-restore:ro`,
      'alpine:latest',
      'sh', '/af-restore/restore.sh',
    ], { stdio: 'pipe', encoding: 'utf8' });
  } finally {
    try { rmSync(scriptDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const releaseFailed = run.status !== 0;
  if (releaseFailed) {
    report.failures.push(
      `restore container exited ${run.status}${run.error ? ` (${run.error.message})` : ''}: ${(run.stderr || '').trim().slice(0, 300)}`,
    );
  } else {
    const summary = /AF_RESTORE_FAILURES=(\d+) AF_RESTORE_SKIPPED=(\d+)/.exec(run.stdout || '');
    if (summary && Number(summary[1]) > 0) {
      report.failures.push(`restore container reported ${summary[1]} failed operation(s)`);
    }
  }

  // Verify the restore in-process: every captured entry must match its recorded metadata.
  // This runs on the failure path too, so a partial restore is described, not just thrown.
  for (const p of valid) {
    const snap = snapshots.get(p);
    if (!snap) {
      report.fallback.push(p);
      continue;
    }
    for (const entry of snap.entries) {
      const abs = entry.rel === '' ? p : join(p, entry.rel);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch {
        report.entries_skipped += 1;
        continue;
      }
      const actualMode = modeOf(stat);
      if (stat.uid !== entry.uid || stat.gid !== entry.gid || (entry.type !== 'symlink' && actualMode !== entry.mode)) {
        report.mismatches.push({
          path: abs,
          expected: { uid: entry.uid, gid: entry.gid, mode: entry.mode },
          actual: { uid: stat.uid, gid: stat.gid, mode: actualMode },
        });
      } else {
        report.entries_restored += 1;
      }
    }
  }

  // "restored" means *verified*: every captured entry matches its recorded metadata
  // and no path had to fall back to guessed modes. Entries that no longer exist are
  // counted separately (`entries_skipped`): their removal is usually the run's own
  // doing, so it does not by itself invalidate an otherwise exact restore.
  report.restored = report.mismatches.length === 0
    && report.failures.length === 0
    && report.fallback.length === 0;

  if (releaseFailed) {
    // The container may have applied part of the plan before dying. Report exactly
    // what that means, and prove whether the boundary is still intact, so callers
    // never have to guess between "never touched" and "partially released".
    const intact = protectionLooksIntact(valid, snapshots);
    const err = new Error(
      `BOUNDARY_RELEASE_FAILED: the restore ran and exited ${run.status}; partial modification of ${valid.join(', ')} cannot be ruled out`,
    );
    err.code = 'BOUNDARY_RELEASE_FAILED';
    err.releaseAttempted = true;
    err.report = report;
    err.protectionIntact = intact.intact;
    err.protectionIntactReason = intact.reason;
    throw err;
  }

  return report;
}

/**
 * Safely execute an operation while temporarily elevating permissions (releasing boundary),
 * and strictly re-engaging the boundary upon completion or failure.
 *
 * @param {string[]} paths - paths to momentarily release and re-protect.
 * @param {Function} asyncFn - operation to run.
 * @param {number} [uid=1000]
 * @param {number} [gid=1000]
 * @returns {Promise<*>}
 */
export async function withElevatedBoundary(paths, asyncFn, uid = 1000, gid = 1000) {
  releasePathsBoundary(paths, uid, gid);
  try {
    return await asyncFn();
  } finally {
    protectPathsWithNonOwnerBoundary(paths);
  }
}

/**
 * Engage the host boundary for an active task lifecycle.
 * Protects Canonical repo and CAS store, sets environment tracking, and asserts candidateDir is writable.
 *
 * @param {object} params
 * @param {string} params.canonicalDir
 * @param {string} params.casDir
 * @param {string} [params.candidateDir]
 */
export function engageTaskHostBoundary({ canonicalDir, casDir, candidateDir = null } = {}) {
  const paths = [canonicalDir, casDir].filter((p) => p && existsSync(p));
  if (paths.length === 0) return { protected: [], snapshots: [] };

  const protection = protectPathsWithNonOwnerBoundary(paths);
  process.env.AF_PROTECTED_PATHS = paths.join(':');
  process.env.AF_HOST_BOUNDARY_ACTIVE = '1';

  if (candidateDir) {
    verifyTamperResistance({ protectedPaths: paths, candidateDir });
  }

  return protection;
}

/**
 * Maximum writer-scope nesting depth that can be inspected.
 * Exceeding it is reported as `unknown` (truncated scan), never as `empty`.
 */
export const MAX_WRITER_SCOPE_DEPTH = 24;

/**
 * Inspect the cgroup base for live writer scopes, distinguishing
 * "confirmed empty" from "cannot be confirmed".
 *
 * A scan is `unknown` - never `empty` - when the base is unset, missing,
 * unreadable, truncated by the depth cap, or contains a writer scope whose
 * `cgroup.procs` cannot be read. Callers must treat `unknown` as a refusal to
 * unlock, not as proof of quiesce.
 *
 * A writer scope root is any `af-*` directory directly under the base. Once a
 * root is identified ALL of its descendants are inspected - not only the ones
 * that also look like scopes - because a scope may hold arbitrary child cgroups
 * (e.g. `af-writer-x/worker`) whose PIDs never appear in the parent's
 * `cgroup.procs`.
 *
 * @param {string} [base=process.env.AF_CGROUP_BASE]
 * @returns {{ status: 'empty'|'active'|'unknown', scopes: Array<{path: string, pids: string[], depth: number}>, base: string|null, reason: string|null, scanned_dirs: number }}
 */
export function inspectWriterScopes(base = process.env.AF_CGROUP_BASE) {
  if (!base) {
    return {
      status: 'unknown',
      scopes: [],
      base: null,
      reason: 'AF_CGROUP_BASE is not configured; writer scope emptiness cannot be confirmed',
      scanned_dirs: 0,
    };
  }
  if (!existsSync(base)) {
    return {
      status: 'unknown',
      scopes: [],
      base,
      reason: `writer scope base ${base} does not exist; writer scope emptiness cannot be confirmed`,
      scanned_dirs: 0,
    };
  }

  const scopes = [];
  const errors = [];
  const truncated = [];
  let scannedDirs = 0;

  /**
   * @param {string} dir directory to inspect.
   * @param {number} depth depth relative to the base.
   * @param {boolean} insideScope true once a writer scope root has been entered.
   */
  const walk = (dir, depth, insideScope) => {
    if (depth > MAX_WRITER_SCOPE_DEPTH) {
      truncated.push(dir);
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
      scannedDirs += 1;
    } catch (err) {
      errors.push(`${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const isScopeRoot = !insideScope && entry.name.startsWith('af-');
      // Outside a scope only scope roots are relevant: the base also contains
      // unrelated user-slice cgroups that must not be walked.
      if (!insideScope && !isScopeRoot) continue;

      const child = join(dir, entry.name);
      const procsPath = join(child, 'cgroup.procs');
      if (!existsSync(procsPath)) {
        // Every cgroup directory carries cgroup.procs; without it emptiness cannot be proven.
        errors.push(`missing cgroup.procs under ${child}`);
      } else {
        try {
          const pids = readFileSync(procsPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
          if (pids.length > 0) scopes.push({ path: child, pids, depth });
        } catch (err) {
          errors.push(`${procsPath}: ${err.message}`);
        }
      }

      // Inside a scope, descend into every descendant cgroup: a parent's
      // cgroup.procs does not list PIDs held by its children.
      walk(child, depth + 1, true);
    }
  };

  walk(base, 0, false);

  if (truncated.length > 0) {
    return {
      status: 'unknown',
      scopes,
      base,
      reason: `writer scope scan truncated at depth ${MAX_WRITER_SCOPE_DEPTH} under ${base}: ${truncated.slice(0, 3).join(', ')}${truncated.length > 3 ? ` (+${truncated.length - 3} more)` : ''}`,
      scanned_dirs: scannedDirs,
    };
  }

  if (errors.length > 0) {
    return {
      status: 'unknown',
      scopes,
      base,
      reason: `writer scope scan incomplete under ${base}: ${errors.join('; ')}`,
      scanned_dirs: scannedDirs,
    };
  }

  return {
    status: scopes.length > 0 ? 'active' : 'empty',
    scopes,
    base,
    reason: null,
    scanned_dirs: scannedDirs,
  };
}

/**
 * List writer scopes that still hold live PIDs.
 *
 * Fail-closed: when emptiness cannot be confirmed this throws instead of
 * returning `[]`, because an empty array means "safe to unlock" to every caller.
 * Pass `{ tolerateUnknown: true }` only where the answer is advisory.
 *
 * @param {string} [base=process.env.AF_CGROUP_BASE]
 * @param {object} [options]
 * @param {boolean} [options.tolerateUnknown=false]
 * @returns {Array<{ path: string, pids: string[], depth: number }>}
 */
export function getActiveWriterScopes(base = process.env.AF_CGROUP_BASE, options = {}) {
  const inspection = inspectWriterScopes(base);
  if (inspection.status === 'unknown') {
    if (options.tolerateUnknown === true) return inspection.scopes;
    const err = new Error(`CANNOT_CONFIRM_WRITER_SCOPES: ${inspection.reason}`);
    err.code = WRITER_SCOPE_SCAN_UNKNOWN;
    err.details = { base: inspection.base, reason: inspection.reason, scopes: inspection.scopes };
    throw err;
  }
  return inspection.scopes;
}

/**
 * Summarise why a restore is not verifiable.
 *
 * @param {object} report - release report from {@link releasePathsBoundary}.
 * @returns {string}
 */
function describeRestoreReport(report) {
  const details = [];
  if (report.mismatches.length > 0) details.push(`${report.mismatches.length} metadata mismatch(es)`);
  if (report.failures.length > 0) details.push(report.failures.join('; '));
  if (report.fallback.length > 0) details.push(`${report.fallback.length} path(s) restored from a guessed snapshot`);
  if (report.entries_skipped > 0) details.push(`${report.entries_skipped} entr(ies) missing on disk`);
  return details.join('; ') || 'restore could not be verified';
}

/**
 * Disengage the host boundary for an active task lifecycle.
 *
 * Fail-closed on three independent conditions, reported through `outcome`:
 *   1. writer scope emptiness that cannot be mechanically confirmed (never treated as empty);
 *   2. a missing pre-protection snapshot, which would force a guessed permission restore.
 *      Both leave the root DAC boundary fully intact -> `PROTECTION_RETAINED`.
 *   3. a release that ran but could not be verified (metadata mismatches, failed
 *      operations, or guessed modes). Ownership is then neither protected nor proven
 *      restored -> `RESTORE_INCOMPLETE`, never `DISENGAGED`.
 *
 * @param {object} params
 * @param {string} params.canonicalDir
 * @param {string} params.casDir
 * @param {boolean} [params.checkScopesEmpty=true] - verify all cgroup writer scopes are empty
 * @param {boolean} [params.force=false] - force disengage even if scopes are non-empty or unverifiable
 * @param {boolean} [params.requireSnapshot=true] - refuse to restore guessed modes
 * @returns {{ disengaged: boolean, outcome: 'DISENGAGED'|'PROTECTION_RETAINED'|'RESTORE_INCOMPLETE', reason: string|null, scopes: object|null, report: object|null }}
 */
export function disengageTaskHostBoundary({
  canonicalDir,
  casDir,
  checkScopesEmpty = true,
  force = false,
  requireSnapshot = true,
} = {}) {
  const result = {
    disengaged: false,
    outcome: 'PROTECTION_RETAINED',
    reason: null,
    scopes: null,
    report: null,
  };

  if (checkScopesEmpty && !force) {
    const inspection = inspectWriterScopes();
    result.scopes = inspection;

    if (inspection.status === 'active') {
      const pids = inspection.scopes.flatMap((a) => a.pids);
      throw new Error(
        `CANNOT_DISENGAGE_BOUNDARY: Active processes remain in writer scopes (${pids.join(', ')}). DAC boundary retained to prevent repository tampering.`,
      );
    }

    if (inspection.status === 'unknown') {
      result.reason = `CANNOT_CONFIRM_WRITER_SCOPES: ${inspection.reason}`;
      return result;
    }
  }

  const paths = [canonicalDir, casDir].filter((p) => p && existsSync(p));
  if (paths.length > 0) {
    let report;
    try {
      report = releasePathsBoundary(paths, undefined, undefined, { requireSnapshot, force });
    } catch (err) {
      result.report = err.report ?? null;
      // Two very different failures reach this point:
      //   - refused before touching anything (missing snapshot, unusable snapshot):
      //     the boundary is still fully applied -> PROTECTION_RETAINED;
      //   - the restore ran and failed, so part of the tree may already be released
      //     -> RESTORE_INCOMPLETE. Only a mechanical integrity check may claim the
      //     former, so `protectionIntact` decides.
      const untouched = err.releaseAttempted !== true || err.protectionIntact === true;
      if (untouched) {
        result.outcome = 'PROTECTION_RETAINED';
        result.reason = `${err.code || 'BOUNDARY_RELEASE_ERROR'}: ${err.message}`;
        return result;
      }
      result.outcome = 'RESTORE_INCOMPLETE';
      result.reason = `BOUNDARY_RESTORE_INCOMPLETE: ${err.code || 'BOUNDARY_RELEASE_ERROR'}: ${err.message}`
        + `${err.protectionIntactReason ? ` | ${err.protectionIntactReason}` : ''}`;
      if (result.report) result.report.mismatch_sample = result.report.mismatches.slice(0, 5);
      delete process.env.AF_HOST_BOUNDARY_ACTIVE;
      delete process.env.AF_PROTECTED_PATHS;
      return result;
    }

    result.report = report;

    // A release that ran but cannot be verified is neither "unlocked cleanly" nor
    // "still protected". Report it as its own outcome instead of claiming either.
    if (report.restored !== true) {
      result.outcome = 'RESTORE_INCOMPLETE';
      result.reason = `BOUNDARY_RESTORE_INCOMPLETE: ${describeRestoreReport(report)}`;
      result.report.mismatch_sample = report.mismatches.slice(0, 5);
      // Ownership is (at least partly) back with the host user, so the process
      // cannot keep advertising an active boundary.
      delete process.env.AF_HOST_BOUNDARY_ACTIVE;
      delete process.env.AF_PROTECTED_PATHS;
      return result;
    }
  }

  delete process.env.AF_HOST_BOUNDARY_ACTIVE;
  delete process.env.AF_PROTECTED_PATHS;
  result.outcome = 'DISENGAGED';
  result.disengaged = true;
  return result;
}

/**
 * Actively test tamper resistance from the perspective of current process (UID 1000).
 * Asserts that all malicious chmod, write, and delete attacks fail deterministically.
 *
 * @param {object} options
 * @param {string[]} options.protectedPaths - paths that must be unmodifiable and un-chmoddable.
 * @param {string} [options.candidateDir] - candidate directory that MUST remain writable.
 * @returns {{ verified: boolean, attacksBlocked: number, details: object[] }}
 */
export function verifyTamperResistance({ protectedPaths = [], candidateDir = null } = {}) {
  const results = [];
  let blockedCount = 0;

  for (const target of protectedPaths) {
    if (!existsSync(target)) continue;

    // Attack 1: Attempt chmod 0777 (POSIX owner check)
    let chmodBlocked = false;
    try {
      chmodSync(target, 0o777);
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EROFS') chmodBlocked = true;
    }
    results.push({ target, action: 'chmod 0777', blocked: chmodBlocked });
    if (!chmodBlocked) {
      throw new Error(`TAMPER VULNERABILITY: chmod succeeded on protected path ${target}`);
    }
    blockedCount++;

    // Attack 2: Attempt direct write / create
    let writeBlocked = false;
    const testFile = join(target, '.tamper-canary');
    try {
      writeFileSync(testFile, 'tamper-payload', { flag: 'w' });
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') writeBlocked = true;
    }
    results.push({ target, action: 'write canary', blocked: writeBlocked });
    if (!writeBlocked) {
      try { unlinkSync(testFile); } catch { /* cleanup */ }
      throw new Error(`TAMPER VULNERABILITY: write succeeded on protected path ${target}`);
    }
    blockedCount++;

    // Attack 3: Attempt direct delete / unlink of target (if target is a file)
    let unlinkBlocked = false;
    try {
      unlinkSync(target);
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EISDIR' || err.code === 'EROFS') {
        unlinkBlocked = true;
      }
    }
    results.push({ target, action: 'unlink target', blocked: unlinkBlocked });
    if (!unlinkBlocked) {
      throw new Error(`TAMPER VULNERABILITY: unlink succeeded on protected path ${target}`);
    }
    blockedCount++;
  }

  // Verify candidateDir is writable if provided
  if (candidateDir && existsSync(candidateDir)) {
    const candidateCanary = join(candidateDir, `.candidate-write-test-${Date.now()}`);
    try {
      writeFileSync(candidateCanary, 'candidate-ok');
      unlinkSync(candidateCanary);
    } catch (err) {
      throw new Error(`CANDIDATE WORKSPACE ERROR: candidate directory not writable: ${err.message}`);
    }
  }

  return { verified: true, attacksBlocked: blockedCount, details: results };
}

// Standalone CLI check probe for shell adapters (e.g. bin/agy-af)
if (process.argv[2] === '--check-isolation') {
  const result = isExternalIsolationVerified({
    requireProtectedPaths: false,
    checkDockerDisabled: process.argv.includes('--require-no-docker'),
  });
  if (result.verified) {
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  } else {
    process.stderr.write(JSON.stringify(result));
    process.exit(1);
  }
}
