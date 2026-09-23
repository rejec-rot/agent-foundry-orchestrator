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
  buildOverview,
  buildTaskView,
  buildEvidenceView,
  buildExceptionsView,
  redactModel,
} from '../lib/console/read-model.mjs';
import { loadExecutorStatus } from '../lib/executor-status.mjs';
import { probeAfExecIsolation } from '../lib/af-exec-isolation.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const WEB_ROOT = join(HERE, '..', 'web');

/** What the first slice actually implements - honest, so the UI never shows a dead button. */
export function capabilities() {
  return {
    schema: 'af-v2-capabilities-v1',
    read: { task_list: true, task_detail: true, task_evidence: true, exceptions: true, executors: true, environment: true },
    write: { create_task: false, cancel_task: false, recover_task: false, approve_human_gate: false, promote: false },
    note: 'read-only slice: no browser action can start, cancel, approve or promote anything',
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
export function createReadApi({ roots = resolveDataRoots(), redact = true, hashPaths = true, now = () => Date.now() } = {}) {
  const shape = (model) => redactModel(model, { redact, hash: hashPaths });

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Read-only by construction: there is no write route, so a non-GET cannot be "handled".
      res.setHeader('allow', 'GET');
      sendJson(res, 405, { error: 'method_not_allowed', reason: 'this API is read-only; it exposes no mutating route' });
      return;
    }

    const at = now();
    try {
      if (path === '/api/v2/capabilities') return sendJson(res, 200, shape({ ...capabilities(), generated_at: new Date(at).toISOString() }));
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
export function startReadApi({ port = 0, host = '127.0.0.1', logger = null, ...options } = {}) {
  const server = createServer(createReadApi(options));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (logger) logger(`v2 read api on http://${host}:${address.port} (read-only, loopback=${host === '127.0.0.1' || host === '::1'})`);
      resolve({ server, port: address.port, url: `http://${host}:${address.port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
