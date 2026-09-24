// preview.mjs - the running-result preview, built fail-closed and OFF by default (§ preview).
//
// A preview that runs a command is an EXECUTION surface, so this module is written the way the rest
// of the system treats execution: nothing happens unless an operator explicitly turns it on, names
// the allowed commands in a trusted file, and passes a confirmation; and every step either records
// its evidence or refuses.
//
//   AF_PREVIEW_MODE            off (default) | static | live
//   AF_PREVIEW_ALLOWLIST       absolute path to a file of allowed preview commands (fail-closed)
//   AF_PREVIEW_PORT_RANGE      "43000-43100" (a bounded range; a missing range means no port can be
//                              assigned, which is a refusal rather than a random pick)
//   AF_PREVIEW_DIR             where preview records live (default: <runtime>/previews)
//
// `static` mode serves the task's REGISTERED snapshot blobs and never executes anything (that is the
// §6 G6 content endpoint). `live` mode spawns an allowlisted command inside the task's materialized
// workspace, records its pid/pgid and port, and can be stopped with verified termination evidence.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

import { spawnManaged, signalPidTree, pidIsAlive, reapProcessGroup } from './child-process.mjs';

export const PREVIEW_SCHEMA = 'af-v2-preview-v1';
export const PREVIEW_MODES = Object.freeze(['off', 'static', 'live']);
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function previewConfig(env = process.env) {
  const rawMode = String(env.AF_PREVIEW_MODE ?? 'off').trim().toLowerCase();
  const mode = PREVIEW_MODES.includes(rawMode) ? rawMode : null;
  const allowlistFile = env.AF_PREVIEW_ALLOWLIST ?? null;
  const dir = env.AF_PREVIEW_DIR ?? null;
  const range = parsePortRange(env.AF_PREVIEW_PORT_RANGE);
  let allowlist = { ok: false, commands: [], reason: 'no preview allowlist is configured' };
  if (allowlistFile) {
    try {
      const parsed = JSON.parse(readFileSync(allowlistFile, 'utf8'));
      if (!Array.isArray(parsed.allowed)) allowlist = { ok: false, commands: [], reason: 'the preview allowlist has no "allowed" array' };
      else {
        const commands = parsed.allowed.filter((c) => typeof c?.command === 'string' && c.command.trim() !== '')
          .map((c) => ({ command: c.command.trim(), args_prefix: Array.isArray(c.args_prefix) ? c.args_prefix.map(String) : [] }));
        allowlist = commands.length > 0
          ? { ok: true, commands, reason: null }
          : { ok: false, commands: [], reason: 'the preview allowlist contains no usable commands' };
      }
    } catch (err) {
      allowlist = { ok: false, commands: [], reason: `the preview allowlist is unreadable: ${err.message}` };
    }
  }
  return {
    mode,
    raw_mode: rawMode,
    enabled: mode === 'static' || mode === 'live',
    allowlist_file: allowlistFile,
    allowlist,
    port_range: range,
    dir,
    reason: mode === null
      ? `AF_PREVIEW_MODE must be one of ${PREVIEW_MODES.join('|')} (got "${rawMode}")`
      : (mode === 'off' ? 'previews are off' : null),
  };
}

export function parsePortRange(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const match = /^(\d{4,5})\s*-\s*(\d{4,5})$/.exec(value.trim());
  if (!match) return null;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 1024 || to > 65535 || from > to) return null;
  return { from, to, size: to - from + 1 };
}

function previewRecordPath(dir, taskId) {
  return join(dir, `${taskId}.json`);
}

export function readPreviewRecord({ dir, taskId }) {
  try { return JSON.parse(readFileSync(previewRecordPath(dir, taskId), 'utf8')); } catch { return null; }
}

function writePreviewRecord({ dir, taskId, record }) {
  mkdirSync(dir, { recursive: true });
  const target = previewRecordPath(dir, taskId);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

function commandAllowed(allowlist, command, args) {
  if (!allowlist.ok) return { ok: false, reason: allowlist.reason };
  const entry = allowlist.commands.find((c) => c.command === command && (c.args_prefix.length === 0 || c.args_prefix.every((a, i) => args[i] === a)));
  if (!entry) return { ok: false, reason: `the preview command is not on the allowlist: ${command} ${args.join(' ')}`.trim() };
  return { ok: true, entry };
}

/**
 * Decide what a preview WOULD do. Pure: it never spawns, never binds, never writes.
 * @returns {{ ok: boolean, executable: boolean, plan: object|null, reason: string|null }}
 */
export function planPreview({ task, config = previewConfig(), command = null, args = [], workspace = null, now = () => new Date() }) {
  const base = { schema: PREVIEW_SCHEMA, task_id: task?.task_id ?? null, mode: config.mode, generated_at: now().toISOString() };
  if (!task || !SAFE_TASK_ID.test(String(task.task_id ?? ''))) return { ...base, ok: false, executable: false, plan: null, reason: 'a task with a safe id is required' };
  if (config.mode === null) return { ...base, ok: false, executable: false, plan: null, reason: config.reason };
  if (config.mode === 'off') return { ...base, ok: true, executable: false, plan: { kind: 'none' }, reason: 'previews are off (set AF_PREVIEW_MODE=static or live to plan one)' };

  if (config.mode === 'static') {
    return {
      ...base,
      ok: true,
      executable: false,
      reason: 'static previews are served through the snapshot content endpoint; nothing is executed',
      plan: { kind: 'static', note: 'use GET /api/v2/tasks/:id/content/<blob_id>' },
    };
  }

  // live
  if (!command) return { ...base, ok: false, executable: false, plan: null, reason: 'a live preview needs an explicit command' };
  const allowed = commandAllowed(config.allowlist, command, args);
  if (!allowed.ok) return { ...base, ok: false, executable: false, plan: null, reason: allowed.reason };
  if (!config.port_range) return { ...base, ok: false, executable: false, plan: null, reason: 'no preview port range is configured (AF_PREVIEW_PORT_RANGE), so no port can be assigned' };
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || !existsSync(workspace)) {
    return { ...base, ok: false, executable: false, plan: null, reason: 'a live preview needs an existing absolute workspace' };
  }

  return {
    ...base,
    ok: true,
    executable: true,
    reason: null,
    plan: {
      kind: 'live',
      command,
      args,
      workspace,
      port_range: config.port_range,
      // The caller still needs an explicit confirmation; the plan itself never authorises anything.
      requires_confirmation: true,
      cleanup: 'the preview process group is signalled on stop and its termination is verified before the record is closed',
    },
  };
}

function pickPort(range, record) {
  const used = new Set(Array.isArray(record?.used_ports) ? record.used_ports : []);
  for (let port = range.from; port <= range.to; port += 1) if (!used.has(port)) return port;
  return null;
}

/**
 * Start a live preview. Refuses unless every gate passes: mode=live, an allowlisted command, a
 * workspace, and `confirm === true`. The spawned process is recorded so it can always be stopped.
 */
export async function startPreview({ task, config = previewConfig(), command, args = [], workspace, confirm = false, env = process.env, now = () => new Date() }) {
  if (confirm !== true) return { ok: false, reason: 'starting a preview is an explicit operator action; re-run with --confirm' };
  const planned = planPreview({ task, config, command, args, workspace, now });
  if (!planned.ok || planned.executable !== true) return { ok: false, reason: planned.reason ?? 'the preview cannot be started', plan: planned.plan };
  const dir = config.dir ?? join(env.AF_RUNTIME_DIR ?? join(process.cwd(), 'runtime'), 'previews');
  const existing = readPreviewRecord({ dir, taskId: task.task_id });
  if (existing?.pid && pidIsAlive(existing.pid)) return { ok: false, reason: `a preview is already running for this task (pid ${existing.pid}); stop it first` };

  const port = pickPort(config.port_range, existing);
  if (port === null) return { ok: false, reason: `every port in ${config.port_range.from}-${config.port_range.to} is recorded as used; stop a preview or widen the range` };

  const record = {
    schema_version: PREVIEW_SCHEMA,
    task_id: task.task_id,
    command,
    args,
    workspace,
    port,
    requested_port: port,
    status: 'starting',
    started_at: now().toISOString(),
    used_ports: [...new Set([...(existing?.used_ports ?? []), port])],
    child_pgid: null,
    pid: null,
  };
  let child;
  try {
    child = spawnManaged(command, args, { cwd: workspace, env: { ...env, PORT: String(port) }, detached: true, stdio: 'ignore' });
  } catch (err) {
    return { ok: false, reason: `the preview command could not be spawned: ${err.message}` };
  }
  record.pid = child.pid ?? null;
  record.status = 'running';
  writePreviewRecord({ dir, taskId: task.task_id, record });
  return { ok: true, record, note: 'the preview is recorded; stop it with the same command so its termination is verified' };
}

/** Stop a preview and verify the process group is gone before closing the record. */
export async function stopPreview({ taskId, config = previewConfig(), env = process.env, now = () => new Date(), graceMs = 800 }) {
  if (!SAFE_TASK_ID.test(String(taskId ?? ''))) return { ok: false, reason: 'a task id of [A-Za-z0-9_-] is required' };
  const dir = config.dir ?? join(env.AF_RUNTIME_DIR ?? join(process.cwd(), 'runtime'), 'previews');
  const record = readPreviewRecord({ dir, taskId });
  if (!record) return { ok: false, reason: `no preview record exists for ${taskId}` };
  if (!record.pid) return { ok: false, reason: 'the record has no pid; nothing to stop' };

  const aliveBefore = pidIsAlive(record.pid);
  if (aliveBefore) signalPidTree(record.pid, 'SIGTERM');
  if (aliveBefore) await reapProcessGroup(record.pid, { graceMs });
  const aliveAfter = pidIsAlive(record.pid);

  const updated = {
    ...record,
    status: aliveAfter ? 'stop_unconfirmed' : 'stopped',
    stopped_at: now().toISOString(),
    termination: { alive_before: aliveBefore, alive_after: aliveAfter, signal: 'SIGTERM', verified: aliveAfter === false },
  };
  writePreviewRecord({ dir, taskId, record: updated });
  if (aliveAfter) return { ok: false, reason: `the preview process ${record.pid} is still alive after SIGTERM; it was reported, not forgotten`, record: updated };
  return { ok: true, record: updated };
}

/** List the recorded previews, flagging records whose process is gone. */
export function listPreviews({ config = previewConfig(), env = process.env } = {}) {
  const dir = config.dir ?? join(env.AF_RUNTIME_DIR ?? join(process.cwd(), 'runtime'), 'previews');
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return { ok: true, previews: [] }; }
  const previews = names.map((name) => {
    const record = (() => { try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return null; } })();
    if (!record) return null;
    return {
      task_id: record.task_id,
      status: record.status,
      alive: record.pid ? pidIsAlive(record.pid) : false,
      port: record.port ?? null,
      command: record.command,
      started_at: record.started_at,
      stopped_at: record.stopped_at ?? null,
    };
  }).filter(Boolean);
  return { ok: true, previews };
}

/** A stable fingerprint of the allowlist, so a record can say which policy allowed it. */
export function allowlistDigest(allowlist) {
  if (!allowlist?.ok) return null;
  return createHash('sha256').update(JSON.stringify(allowlist.commands)).digest('hex');
}

/** Cleanup helper for tests and for a record that was never started. */
export function forgetPreview({ dir, taskId }) {
  rmSync(previewRecordPath(dir, taskId), { force: true });
}
