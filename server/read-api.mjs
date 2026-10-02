// Browser API: read projections plus explicitly enabled, authenticated V2 write routes.
// HTTP dispatches through the execution manager; a detached process owns the workflow.
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
import { spawnManaged } from '../lib/child-process.mjs';
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
import { acceptanceAllowlistFile, acceptanceCommandAllowed, loadAcceptanceAllowlist, planPreview, recordSubmission } from '../lib/submission.mjs';
import { loadExecutorStatus } from '../lib/executor-status.mjs';
import { probeAfExecIsolation } from '../lib/af-exec-isolation.mjs';
import { createV2Task, dispatchV2Task } from '../lib/v2-service.mjs';
import { requestCancel, readCancelRequest } from '../lib/trusted-import/cancel.mjs';
import { eventsDirFor, readTaskEvents } from '../lib/v2-events.mjs';
import { contentIndex, readTaskBlob } from '../lib/content.mjs';
import { describeRegistry, loadProjectRegistry } from '../lib/projects.mjs';
import { collaborationView, queueMessage } from '../lib/collaboration.mjs';
import { authorizeWrite, resolveWriteToken } from './web-auth.mjs';
import { disabledExecutors } from '../lib/operator-control.mjs';
import { createCollaborationTeam, commandTeam } from '../lib/team/service.mjs';
import { listTeams, teamView } from '../lib/team/store.mjs';

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
    read: { task_list: true, task_detail: true, task_evidence: true, task_events: true, task_content: true, collaboration: true, exceptions: true, executors: true, environment: true, recovery_plan: true, submit_preflight: true },
    // Writes are advertised only when the operator started the server with --allow-write AND a
    // write token is configured: an unauthenticated mutating route is never exposed (§7.3).
    // Recovering/approving/promoting stay unavailable in both cases.
    write: {
      record_task: allowRecord === true && writesAuthenticated === true,
      create_task: allowRecord === true && writesAuthenticated === true,
      start_task: allowRecord === true && writesAuthenticated === true,
      cancel_task: allowRecord === true && writesAuthenticated === true,
      queue_message: allowRecord === true && writesAuthenticated === true,
      create_team: allowRecord === true && writesAuthenticated === true,
      team_command: allowRecord === true && writesAuthenticated === true,
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
  ensureController = undefined,
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
      const messageMatch = /^\/api\/v2\/tasks\/([^/]+)\/messages$/.exec(path);
      const teamCommandMatch = /^\/api\/teams\/([^/]+)\/commands$/.exec(path);
      const teamWrite = path==='/api/teams' || Boolean(teamCommandMatch);
      if (req.method !== 'POST' || (!postRoutes.has(path) && !recoveryMatch && !actionMatch && !messageMatch && !teamWrite)) {
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
      const mutating = path === '/api/v2/tasks/record' || path === '/api/v2/tasks/create' || Boolean(actionMatch) || Boolean(messageMatch) || teamWrite;
      if (mutating) {
        const auth = writeAuth(req);
        if (!auth.ok) { sendJson(res, auth.status, shape({ error: 'unauthorized', reason: auth.reason })); return; }
        if (allowRecord !== true) {
          sendJson(res, 403, shape({ error: 'writes_disabled', reason: 'this server was started read-only; restart with --allow-write to enable the authenticated write routes' }));
          return;
        }
      }

      try {
        if(teamCommandMatch) {
          const result=await commandTeam({runtimeDir:roots.runtime,tasksDir:roots.tasks,locksDir:locksDir??roots.locks,
            teamId:teamCommandMatch[1],command:payload.command,commandId:payload.command_id,ensure:ensureController});
          sendJson(res,202,shape(result));return;
        }
        if(path==='/api/teams') {
          const registryFile=env.AF_PROJECTS_FILE??join(process.cwd(),'config','projects.json');
          const loaded=loadProjectRegistry({file:registryFile});
          if(!loaded.ok){sendJson(res,422,shape({ok:false,reason:loaded.reason}));return;}
          const result=createCollaborationTeam({spec:payload.spec,workerCount:payload.worker_count??3,allowedRoots,
            tasksDir:roots.tasks,runtimeDir:roots.runtime,locksDir:locksDir??roots.locks,env,
            submissionsDir:env.AF_SUBMISSION_DIR??join(roots.runtime,'submissions'),
            projectRegistry:loaded.registry,registryFile,registryDigest:loaded.digest,
            allowlist:loadAcceptanceAllowlist({file:acceptanceAllowlistFile(env)}),acceptanceCommandAllowed});
          sendJson(res,result.ok?(result.created?201:200):422,shape(result));return;
        }
        if (path === '/api/v2/tasks/create') {
          // §6 G2 + G6: dedicated V2 submission. The trusted acceptance identity and the change
          // policy come from the CONTROL-PLANE registry, never from the request body.
          const registryFile = env.AF_PROJECTS_FILE ?? join(process.cwd(), 'config', 'projects.json');
          const loadedRegistry = loadProjectRegistry({ file: registryFile });
          if (!loadedRegistry.ok) {
            sendJson(res, 422, shape({ ok: false, created: false, reason: loadedRegistry.reason }));
            return;
          }
          const allowlist = loadAcceptanceAllowlist({ file: acceptanceAllowlistFile(env) });
          const model = createV2Task({
            spec: payload.spec,
            allowedRoots,
            tasksDir: roots.tasks,
            submissionsDir: env.AF_SUBMISSION_DIR ?? join(roots.runtime, 'submissions'),
            env,
            projectRegistry: loadedRegistry.registry,
            registryFile,
            registryDigest: loadedRegistry.digest,
            allowlist,
            acceptanceCommandAllowed,
          });
          sendJson(res, model.ok ? (model.created ? 201 : 200) : 422, shape(model));
          return;
        }
        if (messageMatch) {
          const taskId = messageMatch[1];
          const task=readTaskJson(roots.tasks, taskId);
          if (!task) { sendJson(res, 404, shape({ error: 'not_found', reason: `no such task: ${taskId}` })); return; }
          if(task.team_binding) {
            const result=await commandTeam({runtimeDir:roots.runtime,tasksDir:roots.tasks,locksDir:locksDir??roots.locks,ensure:ensureController,
              teamId:task.team_binding.team_id,commandId:payload.command_id,actor:payload.author??'operator',command:{type:'message',agent_id:payload.agent_id??'lead',message:payload.message,work_item_id:payload.work_item_id??null}});
            sendJson(res,202,shape(result));return;
          }
          const queued = queueMessage({
            runtimeDir: roots.runtime ?? join(process.cwd(), 'runtime'),
            taskId,
            message: payload.message,
            author: payload.author ?? 'operator',
          });
          sendJson(res, queued.ok ? 202 : 422, shape(queued));
          return;
        }
        if (actionMatch) {
          const [, taskId, action] = actionMatch;
          if (action === 'cancel') {
            const task=readTaskJson(roots.tasks,taskId);
            if(task?.team_binding) {
              const result=await commandTeam({runtimeDir:roots.runtime,tasksDir:roots.tasks,locksDir:locksDir??roots.locks,ensure:ensureController,
                teamId:task.team_binding.team_id,commandId:payload.command_id,actor:payload.requested_by??'operator',command:{type:'cancel',reason:payload.reason??null}});
              sendJson(res,202,shape({...result,note:'team cancellation is queued; its receipt confirms when all member scopes have stopped'}));return;
            }
            const model = requestCancel({ tasksDir: roots.tasks, taskId, requestedBy: payload.requested_by ?? 'operator', reason: payload.reason ?? null });
            if (!model.ok) { sendJson(res, 422, shape(model)); return; }
            const outcome = readCancelRequest({ tasksDir: roots.tasks, taskId });
            sendJson(res, 200, shape({ ok: true, created: model.created, task_id: taskId, request: model.request, note: 'honoured at the next trusted boundary; too-late once the ref update has begun' }));
            void outcome;
            return;
          }
          // start: hand the run to a DETACHED worker so the request lifetime never owns it.
          const boundTask=readTaskJson(roots.tasks,taskId);
          if(boundTask?.team_binding) {
            const result=await commandTeam({runtimeDir:roots.runtime,tasksDir:roots.tasks,locksDir:locksDir??roots.locks,ensure:ensureController,
              teamId:boundTask.team_binding.team_id,commandId:payload.command_id,command:{type:'start'}});
            sendJson(res,202,shape({...result,note:'team start is queued; the leased controller owns member execution'}));return;
          }
          const spawner = spawnWorker ?? ((id, operation) => {
            const args = [join(WEB_ROOT, '..', 'af-admin.mjs'), 'v2', 'start', '--task', id,
              '--tasks-dir', operation.tasksDir, '--locks-dir', operation.locksDir,
              '--runtime-dir', operation.runtimeDir, '--operation-id', operation.operationId,
              ...(operation.allowFailedReentry ? ['--allow-failed-reentry'] : [])];
            const child = spawnManaged(process.execPath, args, {
              detached: true, stdio: 'ignore',
              env: { ...process.env, ...env, AF_TASKS_DIR: operation.tasksDir, AF_LOCKS_DIR: operation.locksDir, AF_RUNTIME_DIR: operation.runtimeDir },
            });
            return new Promise((resolve, reject) => {
              child.once('error', reject);
              child.once('spawn', () => { child.unref(); resolve({ pid: child.pid }); });
            });
          });
          const accepted = await dispatchV2Task({
            taskId,
            tasksDir: roots.tasks,
            locksDir: locksDir ?? roots.locks,
            runtimeDir: roots.runtime,
            allowFailedReentry: payload.allow_failed_reentry === true,
            dispatcher: spawner,
          });
          const status = accepted.ok ? 202 : (accepted.outcome === 'already_running' ? 409 : 422);
          sendJson(res, status, shape({ ...accepted, note: accepted.ok ? 'accepted: a detached worker is dispatched and will claim the run; closing the browser cannot stop it' : accepted.reason }));
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
        sendJson(res, err.code?.startsWith('TEAM_')?(err.code==='TEAM_NOT_FOUND'?404:err.code==='TEAM_VERSION_CONFLICT'?409:422):500, { error: 'operation_failed', reason: String(err?.message ?? err) });
      }
      return;
    }

    const at = now();
    try {
      if(path==='/api/teams') return sendJson(res,200,shape({teams:listTeams(roots.runtime).map(t=>teamView(roots.runtime,t.team_id))}));
      const teamMatch=/^\/api\/teams\/([^/]+)$/.exec(path);
      if(teamMatch){const model=teamView(roots.runtime,teamMatch[1]);return sendJson(res,model?200:404,shape(model??{error:'not_found'}));}
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
        // The deployed registry says whether an executor CAN run; the operator's restriction file
        // says whether it MAY. Showing "AVAILABLE" for an executor the system will refuse is a false
        // statement to the operator, so the disable list wins here too.
        const operatorDisabled = new Set(disabledExecutors());
        const executors = [...(status?.values?.() ?? [])].map((entry) => ({
          id: entry.executor_id,
          availability: operatorDisabled.has(entry.executor_id) ? 'DISABLED_BY_OPERATOR' : entry.availability_status,
          capability: entry.capability_status,
          reason: operatorDisabled.has(entry.executor_id)
            ? 'disabled by the operator (config/operator-executors.json); the platform will refuse to bind or run it'
            : (entry.reason ?? null),
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
      const collabMatch = /^\/api\/v2\/tasks\/([^/]+)\/messages$/.exec(path);
      if (collabMatch) {
        // §6 G7: the collaboration projection. Statuses are earned by their own artifacts; the view
        // never upgrades a message to "applied" on the strength of a receipt alone.
        const taskId = collabMatch[1];
        if (!readTaskJson(roots.tasks, taskId)) return sendJson(res, 404, shape({ error: 'not_found', reason: `no such task: ${taskId}` }));
        const model = collaborationView({
          runtimeDir: roots.runtime ?? join(process.cwd(), 'runtime'),
          taskId,
          limit: Number.parseInt(url.searchParams.get('limit') ?? '50', 10),
        });
        return sendJson(res, model.ok ? 200 : 422, shape(model));
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
          // `roots.events` is resolved by resolveDataRoots() through the same helper the adapter
          // writes events with; the fallback keeps a hand-built roots object working.
          eventsDir: roots.events ?? eventsDirFor(roots.tasks),
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
