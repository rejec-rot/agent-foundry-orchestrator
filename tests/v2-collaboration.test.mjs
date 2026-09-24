// v2-collaboration.test.mjs - §6 G7: the collaboration projection never overclaims.
//
// The rule from the plan: "received does not prove the request was carried out; show queued /
// received-by-a-run, and only show applied when there is separate evidence."
//
// These assertions exist to make overclaiming impossible rather than merely discouraged.

import './helpers/executors-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collaborationView, queueMessage, hasAppliedEvidence, operatorDirs, MESSAGE_MAX_CHARS } from '../lib/collaboration.mjs';
import { startReadApi } from '../server/read-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'collab-token';
const AUTH = { authorization: `Bearer ${TOKEN}`, 'x-af-csrf': '1' };

function fixture(prefix = 'af-g7-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const tasks = join(root, 'tasks');
  const runtime = join(root, 'runtime');
  const tokenFile = join(root, 'token');
  for (const d of [tasks, runtime]) mkdirSync(d, { recursive: true });
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(tasks, 'T-COLLAB.json'), JSON.stringify({ task_id: 'T-COLLAB', state: 'AUTHOR_RUNNING', trusted_import: { enabled: true } }));
  return { root, tasks, runtime, tokenFile, roots: { tasks, runtime, alerts: join(root, 'alerts.jsonl') } };
}

test('G7-1: a message climbs the ladder only when its OWN artifact exists', () => {
  const fx = fixture();
  try {
    const queued = queueMessage({ runtimeDir: fx.runtime, taskId: 'T-COLLAB', message: 'please use the v2 schema' });
    assert.equal(queued.ok, true);
    const id = queued.message.id;

    const at1 = collaborationView({ runtimeDir: fx.runtime, taskId: 'T-COLLAB' });
    assert.equal(at1.messages.length, 1);
    assert.equal(at1.messages[0].status, 'queued');
    assert.deepEqual(at1.counts, { queued: 1, received: 0, applied: 0 });
    assert.match(at1.messages[0].claim, /no run has collected it yet/);

    // a run collects it: that is a RECEIPT, and the projection must say exactly that much
    mkdirSync(join(operatorDirs(fx.runtime).received, 'T-COLLAB'), { recursive: true });
    writeFileSync(join(operatorDirs(fx.runtime).received, 'T-COLLAB', `${id}-RUN-9.json`), JSON.stringify({ input_id: id, run_id: 'RUN-9', received_at: new Date().toISOString() }));
    const at2 = collaborationView({ runtimeDir: fx.runtime, taskId: 'T-COLLAB' });
    assert.equal(at2.messages[0].status, 'received');
    assert.equal(at2.messages[0].received_by[0].run_id, 'RUN-9');
    assert.match(at2.messages[0].claim, /does NOT prove the request was carried out/);
    assert.equal(at2.counts.applied, 0, 'a receipt must never be reported as applied');

    // only a SEPARATE applied artifact may promote it
    mkdirSync(join(operatorDirs(fx.runtime).applied, 'T-COLLAB'), { recursive: true });
    writeFileSync(join(operatorDirs(fx.runtime).applied, 'T-COLLAB', `${id}.json`), JSON.stringify({ input_id: id, applied_at: new Date().toISOString(), evidence: 'commit abc123' }));
    const at3 = collaborationView({ runtimeDir: fx.runtime, taskId: 'T-COLLAB' });
    assert.equal(at3.messages[0].status, 'applied');
    assert.match(at3.messages[0].claim, /separate applied record exists/);
    assert.equal(hasAppliedEvidence({ runtimeDir: fx.runtime, taskId: 'T-COLLAB', inputId: id }), true);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('G7-2: queuing validates its input and is append-only', () => {
  const fx = fixture();
  try {
    assert.equal(queueMessage({ runtimeDir: fx.runtime, taskId: 'T-COLLAB', message: '   ' }).ok, false);
    assert.equal(queueMessage({ runtimeDir: fx.runtime, taskId: 'T-COLLAB', message: 'x'.repeat(MESSAGE_MAX_CHARS + 1) }).ok, false);
    assert.match(queueMessage({ runtimeDir: fx.runtime, taskId: 'T-COLLAB', message: 'x'.repeat(MESSAGE_MAX_CHARS + 1) }).reason, /over the 4000 limit/);
    assert.equal(queueMessage({ runtimeDir: fx.runtime, taskId: '../escape', message: 'hi' }).ok, false, 'a traversal-shaped task id is refused');

    const a = queueMessage({ runtimeDir: fx.runtime, taskId: 'T-COLLAB', message: 'first' });
    const b = queueMessage({ runtimeDir: fx.runtime, taskId: 'T-COLLAB', message: 'second' });
    assert.equal(a.ok && b.ok, true);
    assert.notEqual(a.message.id, b.message.id, 'each message gets its own id');
    const files = readdirSync(join(operatorDirs(fx.runtime).input, 'T-COLLAB'));
    assert.equal(files.length, 2, 'both messages are kept: an inbox, not a slot');
    assert.equal(files.some((n) => n.endsWith('.tmp')), false, 'no temporary file is left behind');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('G7-3: the activity projection shows which run is doing what', () => {
  const fx = fixture();
  try {
    const dir = join(operatorDirs(fx.runtime).activity, 'T-COLLAB');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'RUN-1.json'), JSON.stringify({ task_id: 'T-COLLAB', run_id: 'RUN-1', executor: 'codex', role: 'author', status: 'running', started_at: '2026-09-24T00:00:00.000Z', input_ids: [] }));
    const view = collaborationView({ runtimeDir: fx.runtime, taskId: 'T-COLLAB' });
    assert.equal(view.activity.length, 1);
    assert.equal(view.activity[0].executor, 'codex');
    assert.equal(view.activity[0].status, 'running');
    assert.deepEqual(Object.keys(view.activity[0]).includes('prompt'), false, 'raw prompts are never projected');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('G7-4: the HTTP side reads openly but queues only with the operator token', async () => {
  const fx = fixture();
  const api = await startReadApi({
    roots: fx.roots,
    allowRecord: true,
    locksDir: join(fx.runtime, 'locks'),
    token: { configured: true, token: TOKEN, source: fx.tokenFile },
  });
  try {
    const empty = await (await fetch(`${api.url}/api/v2/tasks/T-COLLAB/messages`)).json();
    assert.equal(empty.model.ok, true);
    assert.equal(empty.model.messages.length, 0);
    assert.equal(empty.model.counts.queued, 0);

    const unauthed = await fetch(`${api.url}/api/v2/tasks/T-COLLAB/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-af-csrf': '1' }, body: JSON.stringify({ message: 'hi' }) });
    assert.equal(unauthed.status, 401, 'queuing is a write and needs the token');

    const queued = await fetch(`${api.url}/api/v2/tasks/T-COLLAB/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ message: 'please re-run the review with the stricter gate' }) });
    assert.equal(queued.status, 202);
    const model = (await queued.json()).model;
    assert.equal(model.ok, true);
    assert.match(model.note, /queued/);
    assert.match(model.note, /not injected into a running process/);

    const after = await (await fetch(`${api.url}/api/v2/tasks/T-COLLAB/messages`)).json();
    assert.equal(after.model.messages.length, 1);
    assert.equal(after.model.messages[0].status, 'queued');

    const unknown = await fetch(`${api.url}/api/v2/tasks/T-ABSENT/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify({ message: 'hi' }) });
    assert.equal(unknown.status, 404, 'a message for an unknown task is refused');

    const caps = (await (await fetch(`${api.url}/api/v2/capabilities`)).json()).model;
    assert.equal(caps.read.collaboration, true);
    assert.equal(caps.write.queue_message, true);
  } finally { await api.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test('G7-5: nothing in the queue path can create the applied evidence', () => {
  const source = readFileSync(join(ROOT, 'lib', 'collaboration.mjs'), 'utf8');
  const queueBody = source.slice(source.indexOf('export function queueMessage'), source.indexOf('export function collaborationView'));
  assert.doesNotMatch(queueBody, /applied/, 'queueMessage must not touch the applied directory at all');
  const apiSource = readFileSync(join(ROOT, 'server', 'read-api.mjs'), 'utf8');
  assert.doesNotMatch(apiSource, /operator-applied/, 'the API never writes applied evidence');
  // Precise, not keyword-shaped: an injectable *clock* is fine; reaching into a live process is not.
  assert.doesNotMatch(apiSource, /process\.kill\s*\(/, 'the API never signals a process');
  assert.doesNotMatch(apiSource, /SIGKILL|SIGTERM/, 'the API never terminates a run');
  assert.doesNotMatch(apiSource, /operator-received|operator-input/, 'only lib/collaboration.mjs knows the queue layout');
});
