// read-api.mjs - the browser-facing READ-ONLY API for the V2 workbench.
//
// Design source: docs/design/V2-FRONTEND-PLAN.md §6 G1 (a browser service boundary) and §7.3
// (browser vs control plane). This is the first, deliberately minimal slice: every route is a
// GET, every response is a projection of the existing read model (lib/console/read-model.mjs), and
// nothing here can mutate state - there is no write route at all, so no "approve", "cancel" or
// "start" action can be reached from a browser.
//
// Defaults are fail-safe:
//   * binds to LOOPBACK unless an operator says otherwise;
//   * redacts by default (paths hashed, sensitive fields removed) and never returns whole task
//     JSON, environment variables or executor credentials;
//   * an unreadable record is reported as unverifiable, never as "nothing to see".
//
// Response shape: every JSON body is the redaction envelope produced by `redactModel()`,
// `{ model, paths_redacted, path_mode, truncations }`. The browser therefore always knows whether
// host paths were hashed, instead of having to assume it.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveDataRoots,
  readTaskBlock,
  buildOverview,
  buildTaskView,
  buildEvidenceView,
  buildExceptionsView,
  redactModel,
} from '../lib/console/read-model.mjs';
import { classifyRecovery } from '../lib/recovery.mjs';
import { planPreview, recordSubmission } from '../lib/submission.mjs';
import { loadExecutorStatus } from '../lib/executor-status.mjs';
import { probeAfExecIsolation } from '../lib/af-exec-isolation.mjs';
import { createV2Task, startOrResumeV2Task } from '../lib/v2-service.mjs';
import { requestCancel, readCancelRequest } from '../lib/trusted-import/cancel.mjs';
import { readTaskEvents } from '../lib/v2-events.mjs';
import { contentIndex, readTaskBlob } from '../lib/content.mjs';
import { describeRegistry, loadProjectRegistry } from '../lib/projects.mjs';
import { authorizeWrite, resolveWriteToken } from './web-auth.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const WEB_ROOT = join(HERE, '..', 'web');

/**
 * The READ-ONLY recovery plan (V2-FRONTEND-PLAN §7.2 `recovery-plan`): it classifies what a
 * recovery WOULD involve and refuses to guess when the task moved on. Executing it is deliberately
 * not exposed - that needs operator authentication, not a browser click.
 */
export function recoveryPlanFor({ taskId, roots, expectedStateVersion = null, now = Date.now() } = {}) {
  const base = { schema: 'af-v2-recovery-plan-v1', generated_at: new Date(now).toISOString(), task_id: taskId, executable: false };
  const record = readTaskBlock({ taskId, roots });
  if (record.read_status === 'missing') return { ...base, status: 404, read_status: 'missing', reason: 'no such task' };
  if (record.read_status !== 'ok' || !record.value) return { ...base, status: 503, read_status: record.read_status, reason: record.reason ?? 'the task record could not be read' };
  const currentVersion = record.value.state_version ?? 0;
  if (expectedStateVersion !== null && Number(expectedStateVersion) !== currentVersion) {
    return {
      ...base,
      status: 409,
      state_version: currentVersion,
      expected_state_version: Number(expectedStateVersion),
      reason: `state_version changed (expected ${expectedStateVersion}, now ${currentVersion}); re-read the task before computing a plan`,
    };
  }
  return {
    ...base,
    status: 200,
    state_version: currentVersion,
    plan: classifyRecovery(record.value, { lockHeld: false }),
    note: 'read-only plan: executing a recovery requires --confirm and operator authentication in the CLI',
  };
}

/** What the first slice actually implements - honest, so the UI never shows a dead button. */
/** Read the task snapshot exactly as stored; callers decide how to report a missing file. */
export function readTaskJson(tasksDir, taskId) {
  try { return JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf8')); } catch { return null; }
}

export function capabilities({ allowRecord = false, writesAuthenticated = false } = {}) {
  return {
    schema: 'af-v2-capabilities-v1',
    read: { task_list: true, task_detail: true, task_evidence: true, task_events: true, task_content: true, exceptions: true, executors: true, environment: true, recovery_plan: true, submit_preflight: true },
    // Writes are advertised only when the operator started the server with --allow-write AND a
    // write token is configured: an unauthenticated mutating route is never exposed (§7.3).
    // Recovering/approving/promoting stay unavailable in both cases.
    write: {
      record_task: allowRecord === true && writesAuthenticated === true,
      create_task: allowRecord === true && writesAuthenticated === true,
      start_task: allowRecord === true && writesAuthenticated === true,
      cancel_task: allowRecord === true && writesAuthenticated === true,
      recover_task: false,
      approve_human_gate: false,
      promote: false,
    },
    note: writesAuthenticated !== true
      ? 'writes are disabled: no operator token is configured (set AF_WEB_TOKEN_FILE)'
      : (allowRecord === true
        ? 'writes are authenticated: create/start/cancel are available; recovering, approving and promoting are not'
        : 'read-only slice: pass --allow-write to enable the authenticated write routes'),
  };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

/** Serve a file from web/ only; anything that escapes the directory is refused. */
function sendStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = normalize(join(WEB_ROOT, rel));
  if (!target.startsWith(WEB_ROOT + sep)) {
    sendJson(res, 403, { error: 'forbidden', reason: 'path is outside the web root' });
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    sendJson(res, 404, { error: 'not_found', reason: 'no such asset' });
    return;
  }
  const body = readFileSync(target);
  res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * Build the request handler. `now` is injectable so tests can pin time.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createReadApi({
  roots = resolveDataRoots(),
  redact = true,
  hashPaths = true,
  now = () => Date.now(),
  allowedRoots = [],
  allowRecord = false,
  env = process.env,
  maxBodyBytes = 64 * 1024,
  token = null,
  locksDir = null,
  spawnWorker = null,
} = {}) {
  const writeToken = token ?? resolveWriteToken(env);
  const writeAuth = (req) => authorizeWrite({ req, token: writeToken, expectedHosts: [req.headers?.host ?? ''] });
  const shape = (model) => redactModel(model, { redact, hash: hashPaths });

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) { reject(new Error(`body exceeds ${maxBodyBytes} bytes`)); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Only the two explicitly-designed POST routes are accepted; everything else keeps the
      // read-only refusal, and none of them can start, cancel, approve or promote.
      const postRoutes = new Set(['/api/v2/tasks/preflight', '/api/v2/tasks/record', '/api/v2/tasks/create']);
      const recoveryMatch = /^\/api\/v2\/tasks\/([^/]+)\/recovery-plan$/.exec(path);
      const actionMatch = /^\/api\/v2\/tasks\/([^/]+)\/(start|cancel)$/.exec(path);
      if (req.method !== 'POST' || (!postRoutes.has(path) && !recoveryMatch && !actionMatch)) {
        res.setHeader('allow', 'GET');
        sendJson(res, 405, { error: 'method_not_allowed', reason: 'this API is read-only apart from the two designed POST routes; it never starts, cancels, approves or promotes anything' });
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        req.resume(); // drain so the 413 can actually be delivered
        sendJson(res, 413, { error: 'body_rejected', reason: err.message });
        return;
      }
      let payload;
      try {
        payload = body.trim() ? JSON.parse(body) : {};
      } catch (err) {
        sendJson(res, 400, { error: 'invalid_json', reason: err.message });
        return;
      }

      // Read-only POSTs (preflight, recovery-plan) stay open; everything that mutates requires the
      // operator token + CSRF header + a matching Origin.
      const mutating = path === '/api/v2/tasks/record' || path === '/api/v2/tasks/create' || Boolean(actionMatch);
      if (mutating) {
        const auth = writeAuth(req);
        if (!auth.ok) { sendJson(res, auth.status, shape({ error: 'unauthorized', reason: auth.reason })); return; }
        if (allowRecord !== true) {
          sendJson(res, 403, shape({ error: 'writes_disabled', reason: 'this server was started read-only; restart with --allow-write to enable the authenticated write routes' }));
          return;
        }
      }

      try {
        if (path === '/api/v2/tasks/create') {
          // §6 G2: dedicated V2 submission. Idempotent per key; no legacy planning path.
          const model = createV2Task({ spec: payload.spec, allowedRoots, tasksDir: roots.tasks, submissionsDir: payload.submissions_dir ?? null });
          sendJson(res, model.ok ? (model.created ? 201 : 200) : 422, shape(model));
          return;
        }
        if (actionMatch) {
          const [, taskId, action] = actionMatch;
          if (action === 'cancel') {
            const model = requestCancel({ tasksDir: roots.tasks, taskId, requestedBy: payload.requested_by ?? 'operator', reason: payload.reason ?? null });
            if (!model.ok) { sendJson(res, 422, shape(model)); return; }
            const outcome = readCancelRequest({ tasksDir: roots.tasks, taskId });
            sendJson(res, 200, shape({ ok: true, created: model.created, task_id: taskId, request: model.request, note: 'honoured at the next trusted boundary; too-late once the ref update has begun' }));
            void outcome;
            return;
          }
          // start: hand the run to a DETACHED worker so the request lifetime never owns it.
          const spawner = spawnWorker ?? ((id) => {
            const child = spawn(process.execPath, [join(WEB_ROOT, '..', 'af-admin.mjs'), 'v2', 'start', '--task', id, '--tasks-dir', roots.tasks, ...(locksDir ? ['--locks-dir', locksDir] : [])], { detached: true, stdio: 'ignore' });
            child.unref();
            return { pid: child.pid };
          });
          const accepted = await startOrResumeV2Task({
            taskId,
            tasksDir: roots.tasks,
            locksDir: locksDir ?? join(roots.runtime ?? roots.tasks, 'locks'),
            allowFailedReentry: payload.allow_failed_reentry === true,
            // The route only CLAIMS ownership and dispatches; the worker itself is the runner.
            runner: async ({ task }) => { spawner(task.task_id); },
          });
          const status = accepted.ok ? 202 : (accepted.outcome === 'already_running' ? 409 : 422);
          sendJson(res, status, shape({ ...accepted, operation_id: `op-${taskId}`, note: 'accepted: a detached worker owns the run, so closing the browser cannot stop it' }));
          return;
        }
        if (path === '/api/v2/tasks/preflight') {
          // READ-ONLY: evaluates the spec (containment, allowlist, isolation, executors) and returns
          // the canonical capsule. Nothing is written and nothing is started.
          const model = planPreview({ spec: payload.spec, allowedRoots, env });
          sendJson(res, model.ok ? 200 : 422, shape(model));
          return;
        }
        if (path === '/api/v2/tasks/record') {
          const model = recordSubmission({ spec: payload.spec, allowedRoots, env });
          sendJson(res, model.ok ? 200 : 422, shape(model));
          return;
        }
        const model = recoveryPlanFor({ taskId: recoveryMatch[1], roots, expectedStateVersion: payload.expected_state_version ?? null, now: now() });
        sendJson(res, model.status, shape(model));
      } catch (err) {
        sendJson(res, 500, { error: 'operation_failed', reason: String(err?.message ?? err) });
      }
      return;
    }

    const at = now();
    try {
      if (path === '/api/v2/capabilities') {
        const registry = loadProjectRegistry({ file: env.AF_PROJECTS_FILE ?? join(process.cwd(), 'config', 'projects.json') });
        return sendJson(res, 200, shape({
          ...capabilities({ allowRecord, writesAuthenticated: writeToken.configured === true }),
          projects: registry.ok
            ? { configured: true, digest: registry.digest, count: registry.registry.projects.length }
            : { configured: registry.configured === true, digest: null, count: 0, reason: registry.reason },
          generated_at: new Date(at).toISOString(),
        }));
      }
      if (path === '/api/v2/tasks') {
        const model = buildOverview({ roots, now: at });
        const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 200);
        const offset = Math.max(Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
        const tasks = model.tasks.slice(offset, offset + limit);
        return sendJson(res, 200, shape({ ...model, tasks, page: { offset, limit, total: model.tasks.length } }));
      }
      if (path === '/api/v2/exceptions') return sendJson(res, 200, shape(buildExceptionsView({ roots, now: at })));
      if (path === '/api/v2/executors') {
        // A read-only projection of the capability truth; never probes an executor.
        const status = loadExecutorStatus();
        const executors = [...(status?.values?.() ?? [])].map((entry) => ({
          id: entry.executor_id,
          availability: entry.availability_status,
          capability: entry.capability_status,
          reason: entry.reason ?? null,
        }));
        return sendJson(res, 200, shape({ schema: 'af-v2-executors-v1', generated_at: new Date(at).toISOString(), executors, source: 'executor capability registry (read-only projection)' }));
      }
      if (path === '/api/v2/environment') {
        return sendJson(res, 200, shape({
          schema: 'af-v2-environment-v1',
          generated_at: new Date(at).toISOString(),
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          executor_isolation: probeAfExecIsolation(),
          note: 'cached, read-only summary: opening this page never probes an executor or runs a check',
        }));
      }
      const taskMatch = /^\/api\/v2\/tasks\/([^/]+)$/.exec(path);
      if (taskMatch) {
        const model = buildTaskView({ taskId: taskMatch[1], roots, now: at });
        if (model.blocks.task.read_status === 'missing') return sendJson(res, 404, shape(model));
        return sendJson(res, 200, shape(model));
      }
      const evidenceMatch = /^\/api\/v2\/tasks\/([^/]+)\/evidence$/.exec(path);
      if (evidenceMatch) {
        const model = buildEvidenceView({ taskId: evidenceMatch[1], roots, now: at });
        if (model.blocks.task.read_status === 'missing') return sendJson(res, 404, shape(model));
        return sendJson(res, 200, shape(model));
      }
      const contentMatch = /^\/api\/v2\/tasks\/([^/]+)\/content(?:\/([^/]+))?$/.exec(path);
      if (contentMatch) {
        // §6 G6: only blobs REGISTERED in the task's own snapshot are addressable. The request
        // supplies an identifier, never a path and never a raw CAS digest.
        const taskId = contentMatch[1];
        const blobId = contentMatch[2] ?? null;
        const snapshot = readTaskJson(roots.tasks, taskId);
        if (!snapshot) return sendJson(res, 404, shape({ error: 'not_found', reason: `no such task: ${taskId}` }));
        if (!blobId) return sendJson(res, 200, shape(contentIndex(snapshot)));
        const blob = readTaskBlob(snapshot, decodeURIComponent(blobId));
        if (!blob.ok) return sendJson(res, 404, shape({ error: 'blob_unavailable', reason: blob.reason, task_id: taskId, blob_id: decodeURIComponent(blobId) }));
        res.writeHead(200, {
          'content-type': blob.media_type,
          'content-length': blob.bytes.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        });
        res.end(blob.bytes);
        return;
      }
      const eventsMatch = /^\/api\/v2\/tasks\/([^/]+)\/events$/.exec(path);
      if (eventsMatch) {
        // §6 G5: a bounded page of the phase-event projection, reconciled against the task snapshot.
        // A missing history is reported as `missing` with a marked gap - never as a clean timeline.
        const taskId = eventsMatch[1];
        const snapshot = readTaskJson(roots.tasks, taskId);
        if (!snapshot) return sendJson(res, 404, shape({ error: 'not_found', reason: `no such task: ${taskId}` }));
        const model = readTaskEvents({
          eventsDir: roots.events ?? join(roots.runtime ?? roots.tasks, 'v2-events'),
          taskId,
          snapshot,
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
          offset: Number.parseInt(url.searchParams.get('offset') ?? '0', 10),
        });
        return sendJson(res, model.ok ? 200 : 500, shape(model));
      }
      if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found', reason: `no such API route: ${path}` });

      return sendStatic(res, path);
    } catch (err) {
      sendJson(res, 500, { error: 'query_failed', reason: String(err?.message ?? err) });
    }
  };
}

/** Start the server. Loopback by default; returns { server, port, url, close }. */
export function startReadApi({ port = 0, host = '127.0.0.1', logger = null, allowedRoots = [], allowRecord = false, env = process.env, token = null, locksDir = null, spawnWorker = null, ...options } = {}) {
  const server = createServer(createReadApi({ allowedRoots, allowRecord, env, token, locksDir, spawnWorker, ...options }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (logger) logger(`v2 read api on http://${host}:${address.port} (loopback=${host === '127.0.0.1' || host === '::1'}, record=${allowRecord ? 'enabled (never starts)' : 'disabled (read-only)'})`);
      resolve({ server, port: address.port, url: `http://${host}:${address.port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
