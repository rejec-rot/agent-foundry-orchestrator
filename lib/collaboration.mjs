// collaboration.mjs - the operator/workbench collaboration projection (§6 G7).
//
// The plan is precise about what may be claimed:
//
//   "the existing operator-control collects messages BEFORE a run/resume starts, it is not live
//    injection into a running CLI; and 'received' does not prove the request was carried out.
//    When this is wired up, show queued / received-by-a-run, and only show APPLIED when there is
//    separate evidence."
//
// So the status ladder here is deliberately conservative and each rung needs its own artifact:
//
//   queued   - an input file exists in runtime/operator-input/<task>/
//   received - a run wrote runtime/operator-received/<task>/<id>-<run>.json (names WHICH run)
//   applied  - ONLY when a separate runtime/operator-applied/<task>/<id>.json exists. Nothing in the
//              queue path can create it, so no code path here can upgrade a message by itself.
//
// This module is read-only about history and append-only about new messages; it never injects into
// a running process and never edits a task record.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './store.mjs';

export const COLLABORATION_SCHEMA = 'af-v2-collaboration-v1';
export const MESSAGE_MAX_CHARS = 4000;
export const MESSAGE_LIST_MAX = 200;

const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function operatorDirs(runtimeDir) {
  return {
    input: join(runtimeDir, 'operator-input'),
    received: join(runtimeDir, 'operator-received'),
    activity: join(runtimeDir, 'operator-activity'),
    applied: join(runtimeDir, 'operator-applied'),
  };
}

function readJsonDir(dir) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json')).map((name) => {
      try { return { name, value: JSON.parse(readFileSync(join(dir, name), 'utf8')) }; } catch { return { name, value: null }; }
    });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    return [];
  }
}

/**
 * Queue one message for a task.
 *
 * It is written atomically and never overwrites: this is an inbox, and the next run/resume of the
 * task collects it. It does NOT reach into a running process - the caller must say so in the UI.
 */
export function queueMessage({ runtimeDir, taskId, message, author = 'operator', now = () => new Date() }) {
  if (!SAFE_TASK_ID.test(String(taskId ?? ''))) return { ok: false, reason: 'a task id of [A-Za-z0-9_-] is required' };
  const text = String(message ?? '').trim();
  if (text.length === 0) return { ok: false, reason: 'the message is empty' };
  if (text.length > MESSAGE_MAX_CHARS) return { ok: false, reason: `the message is ${text.length} characters, over the ${MESSAGE_MAX_CHARS} limit` };

  const { input } = operatorDirs(runtimeDir);
  const dir = join(input, taskId);
  const id = randomUUID();
  const record = {
    schema_version: COLLABORATION_SCHEMA,
    id,
    task_id: taskId,
    author,
    message: text,
    created_at: now().toISOString(),
  };
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${id}.json`);
    writeJsonAtomic(target, record, { noOverwrite: true });
  } catch (err) {
    return { ok: false, reason: `the message could not be queued: ${err.message}` };
  }
  return { ok: true, message: record, note: 'queued: the next run/resume of this task receives it; it is not injected into a running process' };
}

/**
 * The projection the browser shows: every message with the highest rung its OWN artifacts support.
 * @returns {{ ok: boolean, task_id: string, messages: object[], counts: object, activity: object[], truncated: boolean, reason: string|null }}
 */
export function collaborationView({ runtimeDir, taskId, limit = 50 }) {
  if (!SAFE_TASK_ID.test(String(taskId ?? ''))) return { ok: false, task_id: taskId, messages: [], counts: {}, activity: [], truncated: false, reason: 'a task id of [A-Za-z0-9_-] is required' };
  const dirs = operatorDirs(runtimeDir);
  const inputs = readJsonDir(join(dirs.input, taskId)).map((e) => e.value).filter(Boolean);
  const received = readJsonDir(join(dirs.received, taskId)).map((e) => e.value).filter(Boolean);
  const applied = new Set(readJsonDir(join(dirs.applied, taskId)).map((e) => e.value?.input_id).filter(Boolean));
  const activity = readJsonDir(join(dirs.activity, taskId)).map((e) => e.value).filter(Boolean);

  const messages = inputs
    .map((input) => {
      const receipts = received.filter((r) => r.input_id === input.id);
      const isApplied = applied.has(input.id);
      // The ladder stops at `received` unless a SEPARATE artifact says otherwise.
      const status = isApplied ? 'applied' : (receipts.length > 0 ? 'received' : 'queued');
      return {
        id: input.id,
        message: input.message,
        author: input.author ?? 'operator',
        created_at: input.created_at,
        status,
        received_by: receipts.map((r) => ({ run_id: r.run_id, received_at: r.received_at })),
        claim: status === 'applied'
          ? 'applied: a separate applied record exists for this message'
          : (status === 'received'
            ? 'received by a run - this does NOT prove the request was carried out'
            : 'queued: no run has collected it yet'),
      };
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const counts = { queued: 0, received: 0, applied: 0 };
  for (const m of messages) counts[m.status] += 1;

  return {
    ok: true,
    task_id: taskId,
    messages: messages.slice(0, Math.max(1, Math.min(limit, MESSAGE_LIST_MAX))),
    counts,
    activity: activity.slice(0, 20).map((a) => ({
      run_id: a.run_id, executor: a.executor ?? null, role: a.role ?? null, status: a.status ?? null,
      started_at: a.started_at ?? null, finished_at: a.finished_at ?? null, input_ids: a.input_ids ?? [],
    })),
    truncated: messages.length > Math.max(1, Math.min(limit, MESSAGE_LIST_MAX)),
    reason: null,
  };
}

/** True when the projection may honestly say "applied" for this input. Exported for the tests. */
export function hasAppliedEvidence({ runtimeDir, taskId, inputId }) {
  return existsSync(join(operatorDirs(runtimeDir).applied, String(taskId), `${String(inputId)}.json`));
}
