// content.mjs - the snapshot-bounded content endpoint's resolver (§6 G6).
//
// The plan is explicit: "the content endpoint may only read blobs REGISTERED in the task's own
// snapshot; it must not offer arbitrary CAS digest or host-path reads."
//
// So a blob is addressed by the id the snapshot registered, and the bytes are read from the path
// that was recorded AT REGISTRATION (inside the task's own materialized tree). A request can never
// supply a path, never supply a raw CAS digest, and never widen the readable set: if it is not in
// the snapshot's own list, the answer is a refusal.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const TASK_CONTENT_SCHEMA = 'af-v2-task-content-v1';
export const CONTENT_MAX_BYTES = 2 * 1024 * 1024;
export const CONTENT_MEDIA_TYPES = Object.freeze(['text/plain', 'text/markdown', 'text/html', 'application/json', 'text/csv', 'image/svg+xml', 'image/png', 'image/jpeg']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function isContained(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The snapshot's own blob list. Created lazily so an older task simply has none. */
export function taskBlobs(task) {
  const blobs = task?.content?.blobs;
  return Array.isArray(blobs) ? blobs : [];
}

/**
 * Register one blob in the task snapshot. `allowedRoot` is the task's OWN materialized tree: a blob
 * outside it (or a symlinked escape) is refused, because the endpoint's whole guarantee is that it
 * can only read what the snapshot owns.
 */
export function registerTaskBlob(task, { blob_id, path, media_type = null, allowedRoot, maxBytes = CONTENT_MAX_BYTES }) {
  if (!task || typeof task !== 'object') return { ok: false, reason: 'a task is required' };
  if (typeof blob_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(blob_id)) return { ok: false, reason: 'blob_id must be 1-128 chars of [A-Za-z0-9._-]' };
  if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, reason: 'path must be absolute' };
  if (typeof allowedRoot !== 'string' || !isAbsolute(allowedRoot)) return { ok: false, reason: 'allowedRoot must be absolute' };
  if (media_type !== null && !CONTENT_MEDIA_TYPES.includes(media_type)) return { ok: false, reason: `media_type ${media_type} is not on the content whitelist` };

  let real;
  try { real = resolve(path); } catch (err) { return { ok: false, reason: `the blob path cannot be resolved: ${err.message}` }; }
  if (!isContained(allowedRoot, real)) return { ok: false, reason: 'the blob is outside the task snapshot tree' };

  let buf;
  let stats;
  try {
    stats = statSync(real);
    if (!stats.isFile()) return { ok: false, reason: 'the blob is not a regular file' };
    if (stats.size > maxBytes) return { ok: false, reason: `the blob is ${stats.size} bytes, over the ${maxBytes} byte limit` };
    buf = readFileSync(real);
  } catch (err) {
    return { ok: false, reason: `the blob could not be read: ${err.message}` };
  }

  const entry = {
    schema_version: TASK_CONTENT_SCHEMA,
    blob_id,
    digest: sha256(buf),
    size: stats.size,
    media_type,
    // The registration records where the bytes came from, so a reader never needs a path argument.
    registered_path: real,
    registered_root: resolve(allowedRoot),
  };
  const blobs = taskBlobs(task).filter((b) => b.blob_id !== blob_id);
  task.content = { ...(task.content ?? {}), schema_version: TASK_CONTENT_SCHEMA, blobs: [...blobs, entry] };
  return { ok: true, blob: entry };
}

/** Look up a blob by the id in the snapshot. Nothing else is addressable. */
export function resolveTaskBlob(task, blobId) {
  if (typeof blobId !== 'string' || blobId.trim() === '') return { ok: false, reason: 'a blob id is required' };
  if (blobId.includes('/') || blobId.includes('\\') || blobId.includes('..')) return { ok: false, reason: 'a blob id is an identifier, not a path' };
  if (/^[0-9a-f]{64}$/.test(blobId)) return { ok: false, reason: 'raw CAS digests are not addressable; use the blob id registered in the snapshot' };
  const found = taskBlobs(task).find((b) => b.blob_id === blobId) ?? null;
  if (!found) return { ok: false, reason: `no blob with id ${blobId} is registered in this task's snapshot` };
  return { ok: true, blob: found };
}

/**
 * Read a registered blob's bytes, re-verifying containment and the digest on every read: a snapshot
 * entry that no longer matches its bytes is a refusal, not a stale success.
 */
export function readTaskBlob(task, blobId, { maxBytes = CONTENT_MAX_BYTES } = {}) {
  const resolved = resolveTaskBlob(task, blobId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const blob = resolved.blob;
  try {
    if (!isContained(blob.registered_root, blob.registered_path)) return { ok: false, reason: 'the registered blob escaped its snapshot root' };
    const stats = statSync(blob.registered_path);
    if (!stats.isFile()) return { ok: false, reason: 'the registered blob is no longer a regular file' };
    if (stats.size > maxBytes) return { ok: false, reason: `the blob is ${stats.size} bytes, over the ${maxBytes} byte limit` };
    const buf = readFileSync(blob.registered_path);
    const digest = sha256(buf);
    if (digest !== blob.digest) return { ok: false, reason: `the blob content does not match its registered digest (snapshot recorded ${blob.digest.slice(0, 12)}…, found ${digest.slice(0, 12)}…)` };
    return { ok: true, blob, bytes: buf, media_type: blob.media_type ?? 'application/octet-stream' };
  } catch (err) {
    return { ok: false, reason: `the blob could not be read: ${err.message}` };
  }
}

/** The index the browser sees: ids, sizes and types - never a path. */
export function contentIndex(task) {
  return {
    schema_version: TASK_CONTENT_SCHEMA,
    task_id: task?.task_id ?? null,
    blobs: taskBlobs(task).map((b) => ({ blob_id: b.blob_id, digest: b.digest, size: b.size, media_type: b.media_type })),
  };
}
