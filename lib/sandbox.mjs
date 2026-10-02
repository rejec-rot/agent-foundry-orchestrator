// sandbox.mjs - run an untrusted child inside a container, when the host allows it.
//
// Why this exists (measured, see docs/P2-FEASIBILITY.md):
//
//   resource-limits.mjs bounds disk / CPU / core dumps with POSIX rlimits, and
//   child-process.mjs reaps a process tree. Neither can bound MEMORY (rlimits
//   cannot: V8 reserves huge virtual ranges), and neither can contain a daemon
//   that escapes its process group with setsid. A container does both:
//
//     - `--memory` is OOM-enforced inside the cgroup
//     - the PID namespace takes down every descendant when the container exits,
//       including a double-fork + setsid daemon (verified with a heartbeat file)
//     - the filesystem is opt-in: nothing is visible unless mounted
//     - `--user <uid>:<gid>`: the child does not run as root inside the container
//
// What this sandbox does NOT do, stated plainly so nobody reads more into it than
// is there: it is PATH isolation, not IDENTITY separation. `--user` passes the
// HOST's own uid:gid, so the executor is still the same user as the orchestrator -
// it simply cannot SEE the control plane, because only the workspace is mounted.
// That closes the practical hazard (an executor editing tasks/<id>.json, the action
// contract, or the breaker state) by ABSENCE rather than by permission, which is
// the strongest thing achievable without host root. It is not privilege separation:
// everything reachable through the mounted workspace is still owned and writable by
// the same identity. Real separation needs a second UID on the host (root-owned
// control plane, executor-owned workspaces) or a container volume with a mediated
// copy-back; see docs/PRIVILEGE-SEPARATION.md.
//
// Capability model (ROADMAP principle 5: never degrade silently):
//
//   AF_SANDBOX=auto     (default) use the sandbox when available, otherwise run
//                       WITHOUT it and record that fact in the evidence
//   AF_SANDBOX=require  refuse to run at all when the sandbox is unavailable
//   AF_SANDBOX=off      never sandbox
//
// On this host only Docker is usable: bwrap/unshare fail because unprivileged
// user namespaces are blocked, systemd-run does not enforce MemoryMax, and cgroup
// controllers are not delegated. Those alternatives are therefore NOT silently
// pretended to work - the probe reports 'none' and says why.
//
// @module sandbox

import { runSyncManaged } from './child-process.mjs';
import { resolveResourceLimits } from './resource-limits.mjs';
import { randomUUID } from 'node:crypto';

const KNOWN_PROVIDERS = Object.freeze(['docker', 'none']);

/**
 * Never forwarded into a container, not even through an explicit opt-in: these
 * are pointers to safety-critical control-plane state, and a process that can
 * reach them (by running the orchestrator) could unban an executor or widen the
 * command allowlist. Same rule as lib/executor-env.mjs.
 */
const NEVER_FORWARDED_ENV = Object.freeze([
  'AF_SAFETY_STATE_FILE',
  'AF_RUNTIME_EVENTS_LOG',
  'AF_ACCEPTANCE_ALLOWLIST',
]);

const DEFAULTS = Object.freeze({
  image: 'node:24-alpine',
  memoryMb: 1024,
  pidsLimit: 256,
  cpus: 2,
  network: 'none',
  tmpfs: '/tmp',
});

function normalizeReadOnlyMount(value) {
  const raw = String(value);
  const marker = '=>';
  const splitAt = raw.indexOf(marker);
  const source = splitAt < 0 ? raw : raw.slice(0, splitAt).trim();
  const target = splitAt < 0 ? raw : raw.slice(splitAt + marker.length).trim();
  if (!source || !target) throw new Error(`invalid read-only mount: ${raw}`);
  return { source, target };
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The configured sandbox mode.
 * @returns {'auto'|'require'|'off'} resolved mode.
 */
export function sandboxMode() {
  const raw = (process.env.AF_SANDBOX ?? 'auto').toLowerCase();
  return raw === 'require' || raw === 'off' ? raw : 'auto';
}

/**
 * The limits and image a sandboxed run is given.
 * @returns {object} resolved sandbox settings.
 */
export function resolveSandboxSettings() {
  return {
    image: process.env.AF_SANDBOX_IMAGE || DEFAULTS.image,
    memoryMb: envNumber('AF_SANDBOX_MEMORY_MB', DEFAULTS.memoryMb),
    pidsLimit: envNumber('AF_SANDBOX_PIDS', DEFAULTS.pidsLimit),
    cpus: envNumber('AF_SANDBOX_CPUS', DEFAULTS.cpus),
    network: process.env.AF_SANDBOX_NETWORK || DEFAULTS.network,
    tmpfs: process.env.AF_SANDBOX_TMPFS || DEFAULTS.tmpfs,
  };
}

let cachedProbe = null;

/**
 * Probe the host for a usable sandbox provider. Cached: the answer cannot change
 * within a process, and probing spawns a container runtime client.
 *
 * `AF_SANDBOX_PROVIDER` may force a provider ('docker' | 'none') so the
 * unavailable path is testable on a host that has Docker.
 *
 * @param {object} [options] - options.
 * @param {boolean} [options.fresh] - bypass the cache.
 * @returns {{provider: 'docker'|'none', available: boolean, version: string|null, reason: string|null}}
 */
export function probeSandbox({ fresh = false } = {}) {
  if (cachedProbe && !fresh) return cachedProbe;

  const forced = (process.env.AF_SANDBOX_PROVIDER ?? '').toLowerCase();
  if (forced && !KNOWN_PROVIDERS.includes(forced)) {
    cachedProbe = {
      provider: 'none',
      available: false,
      version: null,
      reason: `unknown sandbox provider forced (AF_SANDBOX_PROVIDER=${forced}); known: ${KNOWN_PROVIDERS.join(', ')}`,
    };
    return cachedProbe;
  }
  if (forced === 'none') {
    cachedProbe = { provider: 'none', available: false, version: null, reason: 'provider forced to none (AF_SANDBOX_PROVIDER=none)' };
    return cachedProbe;
  }
  // `forced === 'docker'` (or unset) falls through to the probe below: docker is
  // the only implemented provider, so an explicit request for it is the same work
  // and its availability is reported truthfully either way.

  const probe = runSyncManaged('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (probe.error || probe.status !== 0) {
    const detail = probe.error?.message
      ?? ((probe.stderr || '').trim() || `exit ${probe.status}`);
    cachedProbe = {
      provider: 'none',
      available: false,
      version: null,
      reason: `docker unavailable: ${detail}`,
    };
    return cachedProbe;
  }
  cachedProbe = {
    provider: 'docker',
    available: true,
    version: String(probe.stdout).trim() || null,
    reason: null,
  };
  return cachedProbe;
}

/**
 * Clear the cached probe. Exported for tests and diagnostics: `planSandbox`
 * reads the cache, so a test that flips `AF_SANDBOX_PROVIDER` must reset it to
 * observe the forced provider.
 */
export function resetSandboxProbe() {
  cachedProbe = null;
}

/**
 * Human-readable capability report, for startup diagnostics and tests.
 * @returns {object} capability report.
 */
export function describeSandboxCapabilities() {
  const probe = probeSandbox();
  return {
    mode: sandboxMode(),
    provider: probe.provider,
    available: probe.available,
    version: probe.version,
    reason: probe.reason,
    settings: resolveSandboxSettings(),
    // What a sandbox would add over the rlimit + tree-kill baseline.
    covers: {
      memory: probe.available,
      descendantsAfterSetsid: probe.available,
      filesystem: probe.available,
      distinctUid: probe.available,
    },
  };
}

/**
 * Build a `docker run` command that executes `command` inside the sandbox.
 *
 * Returns null when no sandbox is available, so the caller decides what that
 * means (mode 'auto' proceeds and records it; mode 'require' refuses).
 *
 * Security-relevant choices:
 *  - `--network none` by default: an acceptance command needs no network
 *  - `--cap-drop ALL` + `no-new-privileges`: no privileges to escalate with
 *  - only the working directory is mounted; the orchestrator root is never mounted
 *  - `--user <uid>:<gid>`: the child does not run as root inside
 *
 * @param {object} options - options.
 * @param {string} options.command - executable (must resolve inside the image).
 * @param {string[]} [options.args] - arguments.
 * @param {string} options.cwd - working directory, bind-mounted read-write.
 * @param {object} [options.limits] - resolved resource limits (rlimits become
 *   Docker --ulimit flags; the rlimit shell shim cannot be used inside a slim
 *   image because those have `sh` but not `bash`).
 * @param {object} [options.extraEnv] - explicitly opted-in variables to forward
 *   into the container (from AF_ACCEPTANCE_ENV_*). A container starts with no
 *   inherited environment, so without this an opt-in passthrough would silently
 *   stop working. Safety-critical keys are refused even here.
 * @returns {object|null} launch plan, or null when unavailable.
 */
export function buildSandboxCommand({
  command, args = [], cwd, limits = resolveResourceLimits(), extraEnv = {},
  image = null, network = null, roMounts = [],
}) {
  const probe = probeSandbox();
  if (!probe.available) return null;
  if (!cwd) throw new Error('buildSandboxCommand requires cwd (it is the only mounted path)');
  const readOnlyMounts = roMounts.map(normalizeReadOnlyMount);

  const base = resolveSandboxSettings();
  const settings = { ...base, image: image || base.image, network: network || base.network };
  // rlimits are applied by the container runtime, so the shell shim is not
  // needed and `bash` is not required inside the image.
  const ulimitFlags = [];
  if (limits.enabled) {
    const coreBytes = Math.max(0, Math.floor(limits.coreDumpKb)) * 1024;
    ulimitFlags.push('--ulimit', `core=${coreBytes}:${coreBytes}`);
    if (limits.fileSizeMb > 0) {
      const bytes = Math.floor(limits.fileSizeMb) * 1024 * 1024;
      ulimitFlags.push('--ulimit', `fsize=${bytes}:${bytes}`);
    }
    if (limits.cpuSeconds > 0) {
      const seconds = Math.floor(limits.cpuSeconds);
      ulimitFlags.push('--ulimit', `cpu=${seconds}:${seconds}`);
    }
  }
  const forwardedEnv = {};
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) continue;
    if (NEVER_FORWARDED_ENV.includes(key)) continue;
    forwardedEnv[key] = String(value);
  }
  const envFlags = Object.entries(forwardedEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const settingsFlags = [
    '--rm',
    '--name', null, // filled below
    '--network', settings.network,
    '--memory', `${settings.memoryMb}m`,
    '--memory-swap', `${settings.memoryMb}m`,
    '--pids-limit', String(settings.pidsLimit),
    '--cpus', String(settings.cpus),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    ...ulimitFlags,
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    // A writable scratch space. Skipped when the workspace IS that path: docker
    // rejects the plan with "Duplicate mount point" (measured, exit 125) when
    // `--tmpfs /tmp` and `-v /tmp:/tmp` are combined, and the workspace bind mount
    // already provides a writable directory there.
    ...(cwd === settings.tmpfs ? [] : ['--tmpfs', settings.tmpfs]),
    '-e', `HOME=${settings.tmpfs}`,
    ...envFlags,
    '-v', `${cwd}:${cwd}`,
    // Extra READ-ONLY mounts, used to make a host-installed executor CLI visible
    // inside the container (see planExecutorSandbox). Read-only on purpose: the
    // sandbox must not be able to modify the toolchain it runs.
    ...readOnlyMounts.flatMap(({ source, target }) => ['-v', `${source}:${target}:ro`]),
    '-w', cwd,
  ];
  const containerName = `af-sbx-${process.pid}-${randomUUID().slice(0, 8)}`;
  settingsFlags[settingsFlags.indexOf(null)] = containerName;

  return {
    command: 'docker',
    args: ['run', ...settingsFlags, settings.image, command, ...args],
    containerName,
    mechanism: 'docker',
    applied: {
      image: settings.image,
      memoryMb: settings.memoryMb,
      pidsLimit: settings.pidsLimit,
      cpus: settings.cpus,
      network: settings.network,
      mountedPaths: [cwd],
      readOnlyMounts: readOnlyMounts.map(({ source, target }) => source === target ? source : `${source}=>${target}`),
      user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      forwardedEnv: Object.keys(forwardedEnv).sort(),
      rlimitsViaDocker: limits.enabled
        ? { coreKb: limits.coreDumpKb, fileSizeMb: limits.fileSizeMb, cpuSeconds: limits.cpuSeconds }
        : null,
    },
  };
}

/**
 * Remove a sandbox container by name. Needed because killing the `docker run`
 * client does NOT stop the container: an abrupt SIGKILL (the escalation path in
 * resource/timeout handling) can leave it running. `--rm` covers the graceful
 * case; this covers the rest. Best effort - never throws.
 *
 * @param {string|null} containerName - the name from the launch plan.
 * @returns {boolean} true when a removal command ran without error.
 */
export function sandboxCleanup(containerName) {
  if (!containerName) return false;
  try {
    const result = runSyncManaged('docker', ['rm', '-f', containerName], {
      stdio: 'ignore',
      timeout: 20_000,
    });
    return !result.error;
  } catch {
    return false;
  }
}

/**
 * Verify that a container scope no longer exists. A failed Docker inspection is
 * only treated as proof when Docker explicitly reports the object is missing;
 * a daemon or transport failure leaves the result unverified.
 *
 * @param {string|null} containerName - sandbox container name.
 * @returns {boolean} true only when Docker confirms the container is gone.
 */
export function sandboxIsGone(containerName) {
  if (!containerName) return false;
  try {
    const result = runSyncManaged('docker', ['inspect', containerName], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (!result.error && result.status === 0) return false;
    const detail = `${result.stderr || ''} ${result.stdout || ''}`.toLowerCase();
    return /no such object|no such container|not found/.test(detail);
  } catch {
    return false;
  }
}

/**
 * Decide how one launch should be wrapped, applying the configured mode.
 *
 * This is the single place that answers "is this run sandboxed, and what do we
 * tell the evidence record". Callers must not re-derive it.
 *
 * @param {object} options - options.
 * @param {string} options.command - executable.
 * @param {string[]} [options.args] - arguments.
 * @param {string} options.cwd - working directory.
 * @param {object} [options.limits] - resolved resource limits.
 * @param {object} [options.extraEnv] - explicitly opted-in variables to forward.
 * @returns {{allowed: boolean, plan: object|null, status: object}}
 *   `allowed:false` means mode 'require' was set and no sandbox exists.
 */
export function planSandbox({ command, args = [], cwd, limits = resolveResourceLimits(), extraEnv = {} }) {
  const mode = sandboxMode();
  const probe = probeSandbox();

  if (mode === 'off') {
    return { allowed: true, plan: null, status: { mode, provider: 'disabled', available: false, reason: 'AF_SANDBOX=off' } };
  }
  if (!probe.available) {
    return {
      allowed: mode !== 'require',
      plan: null,
      status: { mode, provider: 'none', available: false, reason: probe.reason },
    };
  }
  const plan = buildSandboxCommand({ command, args, cwd, limits, extraEnv });
  return {
    allowed: true,
    plan,
    status: { mode, provider: plan.mechanism, available: true, reason: null },
  };
}

/**
 * Sandbox an EXECUTOR child, as opposed to an acceptance command.
 *
 * Off by default and requiring an explicit image, because an executor is the CLI
 * the task actually runs: sandboxing it needs an image that CONTAINS that CLI, and
 * choosing that image is a deployment decision (docs/P2-FEASIBILITY.md section 4).
 * Rather than guessing an image, this refuses with a precise reason - a silent
 * fallback would hide which posture the run actually had.
 *
 * Two deliberate differences from the acceptance sandbox:
 *   - network is REQUIRED (the executor talks to its provider), so it defaults to
 *     Docker's bridge network instead of `--network none`
 *   - the executor's own credential environment is forwarded, and only its own: a
 *     container inherits nothing, so without this the CLI could not authenticate.
 *     The caller passes lib/executor-env.mjs output, which is already restricted to
 *     that executor's credential.
 *
 * @param {object} options - options.
 * @param {string} options.command - executor executable.
 * @param {string[]} [options.args] - arguments.
 * @param {string} options.cwd - working directory (the only mounted path).
 * @param {string} options.executorType - which executor is being launched.
 * @param {object} [options.limits] - resolved resource limits.
 * @param {object} [options.env] - the executor's own environment to forward.
 * @returns {{allowed: boolean, plan: object|null, status: object}}
 */
export function planExecutorSandbox({ command, args = [], cwd, executorType, limits = resolveResourceLimits(), env = {} }) {
  const status = (provider, available, reason) => ({ mode: 'executors', provider, available, reason });

  if ((process.env.AF_SANDBOX_EXECUTORS ?? 'off').toLowerCase() !== 'on') {
    return { allowed: true, plan: null, status: status('disabled', false, 'AF_SANDBOX_EXECUTORS is not "on"') };
  }
  const image = process.env.AF_SANDBOX_EXECUTOR_IMAGE;
  if (!image) {
    return {
      allowed: false,
      plan: null,
      status: status('none', false, 'AF_SANDBOX_EXECUTOR_IMAGE is required: the image must contain the executor CLI it runs'),
    };
  }
  const probe = probeSandbox();
  if (!probe.available) {
    return { allowed: false, plan: null, status: status('none', false, probe.reason) };
  }
  // A host-installed CLI is not in the image, so it has to be made visible.
  // AF_SANDBOX_EXECUTOR_MOUNTS is a comma-separated list of host paths mounted
  // read-only at the same path. An entry may use source=>target when a secret
  // file must be exposed at a writable temporary home path without exposing its
  // host directory. Measured: the real cline CLI runs inside a glibc image this
  // way, but NOT in an alpine one (its platform binary is a dynamically linked
  // ELF needing /lib64/ld-linux-x86-64.so.2).
  const roMounts = String(process.env.AF_SANDBOX_EXECUTOR_MOUNTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const plan = buildSandboxCommand({
    command,
    args,
    cwd,
    limits,
    extraEnv: env,
    image,
    network: process.env.AF_SANDBOX_EXECUTOR_NETWORK || 'bridge',
    roMounts,
  });
  if (!plan) return { allowed: false, plan: null, status: status('none', false, 'docker became unavailable') };
  return {
    allowed: true,
    plan,
    status: { ...status(plan.mechanism, true, null), executor: executorType, image, readOnlyMounts: plan.applied.readOnlyMounts },
  };
}
