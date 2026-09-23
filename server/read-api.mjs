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
export function capabilities({ allowRecord = false } = {}) {
  return {
    schema: 'af-v2-capabilities-v1',
    read: { task_list: true, task_detail: true, task_evidence: true, exceptions: true, executors: true, environment: true, recovery_plan: true, submit_preflight: true },
    // `record_task` only appears when the operator started the server with --allow-write; it writes
    // a PREPARED record and never starts anything. Start/cancel/approve/promote have NO route at
    // all: cancel needs the G4 race work and starting needs an explicit authorisation.
    write: {
      record_task: allowRecord === true,
      start_task: false,
      cancel_task: false,
      recover_task: false,
      approve_human_gate: false,
      promote: false,
    },
    note: allowRecord
      ? 'record-only: submitting stores a PREPARED record (started=false); nothing is ever started here'
      : 'read-only slice: no browser action can start, cancel, approve or promote anything',
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
export function createReadApi({ roots = resolveDataRoots(), redact = true, hashPaths = true, now = () => Date.now(), allowedRoots = [], allowRecord = false, env = process.env, maxBodyBytes = 64 * 1024 } = {}) {
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
      const postRoutes = new Set(['/api/v2/tasks/preflight', '/api/v2/tasks/record']);
      const recoveryMatch = /^\/api\/v2\/tasks\/([^/]+)\/recovery-plan$/.exec(path);
      if (req.method !== 'POST' || (!postRoutes.has(path) && !recoveryMatch)) {
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

      try {
        if (path === '/api/v2/tasks/preflight') {
          // READ-ONLY: evaluates the spec (containment, allowlist, isolation, executors) and returns
          // the canonical capsule. Nothing is written and nothing is started.
          const model = planPreview({ spec: payload.spec, allowedRoots, env });
          sendJson(res, model.ok ? 200 : 422, shape(model));
          return;
        }
        if (path === '/api/v2/tasks/record') {
          if (allowRecord !== true) {
            sendJson(res, 403, shape({ error: 'record_disabled', reason: 'this server was started read-only; restart with --allow-write to record submissions (a record never starts a task)' }));
            return;
          }
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
      if (path === '/api/v2/capabilities') return sendJson(res, 200, shape({ ...capabilities({ allowRecord }), generated_at: new Date(at).toISOString() }));
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
      if (path.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found', reason: `no such API route: ${path}` });

      return sendStatic(res, path);
    } catch (err) {
      sendJson(res, 500, { error: 'query_failed', reason: String(err?.message ?? err) });
    }
  };
}

/** Start the server. Loopback by default; returns { server, port, url, close }. */
export function startReadApi({ port = 0, host = '127.0.0.1', logger = null, allowedRoots = [], allowRecord = false, env = process.env, ...options } = {}) {
  const server = createServer(createReadApi({ allowedRoots, allowRecord, env, ...options }));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (logger) logger(`v2 read api on http://${host}:${address.port} (loopback=${host === '127.0.0.1' || host === '::1'}, record=${allowRecord ? 'enabled (never starts)' : 'disabled (read-only)'})`);
      resolve({ server, port: address.port, url: `http://${host}:${address.port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
