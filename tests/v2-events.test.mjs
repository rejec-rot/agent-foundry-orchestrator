// v2-events.test.mjs - §6 G5: the phase-event projection and structured errors.
//
// The two rules under test: a missing or lagging history is MARKED (never prettied up), and an
// error code is never invented from a natural-language message.

import './helpers/executors-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendTaskEvent, readTaskEvents, recordTrustedImportError, eventsDirFor, V2_MAX_LIMIT } from '../lib/v2-events.mjs';
import { startReadApi } from '../server/read-api.mjs';
import { resolveDataRoots } from '../lib/console/read-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(prefix = 'af-v2ev-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const tasks = join(root, 'tasks');
  const events = join(root, 'v2-events');
  for (const d of [tasks, events]) mkdirSync(d, { recursive: true });
  return { root, tasks, events, roots: { tasks, runtime: join(root, 'runtime'), alerts: join(root, 'alerts.jsonl') } };
}

test('V2EV-1: events append in order and take their code and message from the thrown error only', () => {
  const fx = fixture();
  try {
    for (const phase of ['PROJECTED', 'AUTHOR_RUNNING', 'QUIESCE']) {
      assert.equal(appendTaskEvent({ eventsDir: fx.events, taskId: 'T-1', type: 'phase', phase }).ok, true);
    }
    const read = readTaskEvents({ eventsDir: fx.events, taskId: 'T-1', snapshot: { trusted_import: { phase: 'QUIESCE' } } });
    assert.equal(read.ok, true);
    assert.deepEqual(read.events.map((e) => e.phase), ['PROJECTED', 'AUTHOR_RUNNING', 'QUIESCE']);
    assert.equal(read.gap, null, 'a consistent history has no gap');
    assert.equal(read.missing, false);

    // a real code is kept verbatim
    const task = {};
    const withCode = recordTrustedImportError(task, Object.assign(new Error('BOUNDARY_AUDIT_UNAVAILABLE'), { code: 'BOUNDARY_AUDIT_UNAVAILABLE', details: { path: '/x', token: 'abcdef0123456789abcdef0123456789' } }));
    assert.equal(withCode.code, 'BOUNDARY_AUDIT_UNAVAILABLE');
    assert.equal(withCode.code_source, 'err.code');
    assert.equal(withCode.message, 'BOUNDARY_AUDIT_UNAVAILABLE');
    assert.equal(withCode.details.token, '[redacted]', 'secrets are redacted on the way in');
    // Audit identifiers are NOT credentials: a real promotion's event trail had its commit oid and
    // patch digest redacted because the "opaque value" heuristic was accidentally case-insensitive.
    const oid = 'cb5c537578b1d16c41cf2602af5493e924ac178f';
    const digest = 'e42de6744263dea4364026aae78618514717e782a929f060c3e779ee6da23924';
    const kept = recordTrustedImportError({}, Object.assign(new Error('promotion recorded'), { details: { new_commit_oid: oid, patch_digest: digest, code: 'BOUNDARY_AUDIT_UNAVAILABLE' } }));
    assert.equal(kept.details.new_commit_oid, oid, 'a git oid must survive redaction');
    assert.equal(kept.details.patch_digest, digest, 'a sha256 digest must survive redaction');
    assert.equal(kept.details.code, 'BOUNDARY_AUDIT_UNAVAILABLE');
    assert.equal(appendTaskEvent({ eventsDir: fx.events, taskId: 'T-OID', type: 'promotion-started', detail: { new_commit_oid: oid } }).ok, true);
    const trail = readTaskEvents({ eventsDir: fx.events, taskId: 'T-OID' });
    assert.equal(trail.events[0].detail.new_commit_oid, oid, 'the event trail keeps the identifier it is meant to audit');

    // a random-looking credential IS redacted, twice in a row (the regex must not carry state)
    const cred = 'k3JdP9xQ2mLs7ZbV1nR4tY6wA8cE0fG5';
    assert.equal(recordTrustedImportError({}, new Error(`auth failed for ${cred} and ${cred}`)).message, 'auth failed for [redacted] and [redacted]');
    assert.equal(recordTrustedImportError({}, new Error(`auth failed for ${cred}`)).message, 'auth failed for [redacted]');
    assert.equal(withCode.details.path, '/x');

    // a message-only error yields NO code: an honest gap beats a wrong code
    const bare = recordTrustedImportError({}, new Error('QA-4711: something went wrong with the boundary'));
    assert.equal(bare.code, null);
    assert.equal(bare.code_source, 'absent');
    assert.equal(bare.message, 'QA-4711: something went wrong with the boundary', 'the message is preserved for display');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2EV-2: a missing or lagging history is marked as a gap, never presented as clean', () => {
  const fx = fixture();
  try {
    const none = readTaskEvents({ eventsDir: fx.events, taskId: 'T-2', snapshot: { trusted_import: { phase: 'PROMOTED' } } });
    assert.equal(none.ok, true);
    assert.equal(none.missing, true);
    assert.equal(none.events.length, 0);
    assert.equal(none.gap.marked, true);
    assert.match(none.gap.reason, /no event history/);
    assert.equal(none.gap.snapshot_phase, 'PROMOTED');

    appendTaskEvent({ eventsDir: fx.events, taskId: 'T-2', type: 'phase', phase: 'CAPTURE' });
    const lagging = readTaskEvents({ eventsDir: fx.events, taskId: 'T-2', snapshot: { trusted_import: { phase: 'PROMOTION' } } });
    assert.equal(lagging.gap.marked, true);
    assert.match(lagging.gap.reason, /snapshot is at PROMOTION but the newest event is at CAPTURE/);
    assert.equal(lagging.events.length, 1, 'the events we DO have are still returned');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2EV-3: pagination is bounded and reports has_more honestly', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 12; i += 1) appendTaskEvent({ eventsDir: fx.events, taskId: 'T-3', type: 'phase', phase: `P${i}` });
    const first = readTaskEvents({ eventsDir: fx.events, taskId: 'T-3', limit: 5 });
    assert.equal(first.events.length, 5);
    assert.equal(first.total, 12);
    assert.equal(first.has_more, true);
    const last = readTaskEvents({ eventsDir: fx.events, taskId: 'T-3', limit: 5, offset: 10 });
    assert.equal(last.events.length, 2);
    assert.equal(last.has_more, false);
    const huge = readTaskEvents({ eventsDir: fx.events, taskId: 'T-3', limit: 10_000 });
    assert.equal(huge.events.length, 12, `limit is capped at ${V2_MAX_LIMIT}`);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2EV-4: an unwritable projection never breaks a run', () => {
  // NOTE: deliberately NOT under /proc - `mkdirSync(..., {recursive:true})` blocks indefinitely on
  // /proc entries on this host (an OS quirk), which no synchronous API can survive. The contract
  // under test is "a write that FAILS is reported, never thrown": /sys gives a fast, real EACCES.
  const denied = appendTaskEvent({ eventsDir: '/sys/af-events-not-writable', taskId: 'T', type: 'phase' });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /could not be recorded: EACCES/);
  const notADir = appendTaskEvent({ eventsDir: '/dev/null/nope', taskId: 'T', type: 'phase' });
  assert.equal(notADir.ok, false, 'a path through a file is reported, not thrown');
  assert.equal(appendTaskEvent({ eventsDir: null, taskId: 'T', type: 'phase' }).ok, false);

  // A non-existent history is MISSING (a legitimate state), while a history that exists but cannot
  // be read is an ERROR. Both must be distinguishable, so prove the second with a real EISDIR.
  const fx = fixture('af-v2ev-unreadable-');
  try {
    assert.equal(readTaskEvents({ eventsDir: '/sys/af-events-not-writable', taskId: 'T' }).missing, true, 'no history -> missing');
    mkdirSync(join(fx.events, 'T-dir.jsonl'), { recursive: true });
    const read = readTaskEvents({ eventsDir: fx.events, taskId: 'T-dir' });
    assert.equal(read.ok, false);
    assert.match(read.reason, /could not be read/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
  // a projection failure must never surface as an exception to the caller
  assert.doesNotThrow(() => appendTaskEvent({ eventsDir: '/sys/nope', taskId: 'T', type: 'phase' }));
});

test('V2EV-5: the API returns a bounded page plus the gap, and 404s only for a missing task', async () => {
  const fx = fixture('af-v2ev-api-');
  const api = await startReadApi({ roots: { ...fx.roots, events: fx.events } });
  try {
    writeFileSync(join(fx.tasks, 'T-API.json'), JSON.stringify({ task_id: 'T-API', state: 'COMPLETED', trusted_import: { enabled: true, phase: 'PROMOTED' } }));
    for (let i = 0; i < 7; i += 1) appendTaskEvent({ eventsDir: fx.events, taskId: 'T-API', type: 'phase', phase: i === 6 ? 'CAPTURE' : `E${i}` });

    const res = await fetch(`${api.url}/api/v2/tasks/T-API/events?limit=3`);
    assert.equal(res.status, 200);
    const model = (await res.json()).model;
    assert.equal(model.events.length, 3);
    assert.equal(model.total, 7);
    assert.equal(model.has_more, true);
    assert.equal(model.gap.marked, true, 'the snapshot (PROMOTED) is ahead of the events (CAPTURE)');
    assert.match(model.gap.reason, /snapshot is at PROMOTED/);

    // a task that exists but has no history: explicit, not an empty timeline
    writeFileSync(join(fx.tasks, 'T-NOHIST.json'), JSON.stringify({ task_id: 'T-NOHIST', state: 'CREATED', trusted_import: { enabled: true, phase: null } }));
    const noHist = await (await fetch(`${api.url}/api/v2/tasks/T-NOHIST/events`)).json();
    assert.equal(noHist.model.missing, true);
    assert.equal(noHist.model.gap.marked, true);

    const missing = await fetch(`${api.url}/api/v2/tasks/T-ABSENT/events`);
    assert.equal(missing.status, 404);

    const caps = await (await fetch(`${api.url}/api/v2/capabilities`)).json();
    assert.equal(caps.model.read.task_events, true, 'the capability list must advertise the timeline');
  } finally { await api.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test('V2EV-5b: a reader looks where the writer wrote - one convention, not three', () => {
  // The workbench showed "no event history" for a task whose events were on disk, because the
  // adapter wrote to <tasks>/events while the reader looked in <runtime>/v2-events. Resolving the
  // root through the shared helper is what makes that impossible.
  const tasksDir = '/tmp/af-convention/tasks';
  const viaEnv = resolveDataRoots({ AF_TASKS_DIR: tasksDir, AF_RUNTIME_DIR: '/tmp/af-convention/runtime' }, '/tmp/af-convention');
  assert.equal(viaEnv.events, eventsDirFor(tasksDir), 'the reader default must equal the writer default');
  assert.equal(viaEnv.events, '/tmp/af-convention/tasks/events');
  const explicit = resolveDataRoots({ AF_TASKS_DIR: tasksDir, AF_V2_EVENTS_DIR: '/tmp/elsewhere/events' }, '/tmp/af-convention');
  assert.equal(explicit.events, '/tmp/elsewhere/events', 'an explicit override still wins');

  const apiSource = readFileSync(join(ROOT, 'server', 'read-api.mjs'), 'utf8');
  assert.match(apiSource, /eventsDirFor\(roots\.tasks\)/, 'the route must use the shared helper');
  assert.doesNotMatch(apiSource, /'v2-events'/, 'the third convention must be gone');
});

test('V2EV-5c: a finished task leaves a projection that MATCHES its snapshot', () => {
  // Otherwise every COMPLETED task in the workbench shows a gap warning forever, which trains an
  // operator to ignore the one signal that is supposed to mean "the history is incomplete".
  const source = readFileSync(join(ROOT, 'lib', 'trusted-import', 'orchestrator-adapter.mjs'), 'utf8');
  assert.match(source, /emit\('promotion-completed'/, 'the promotion must close the timeline');
  assert.match(source, /'promotion-started'/, 'and still open it');
});

test('V2EV-6: the adapter and orchestrator actually emit events on the real paths', () => {
  const adapter = readFileSync(join(ROOT, 'lib', 'trusted-import', 'orchestrator-adapter.mjs'), 'utf8');
  const phaseCallSites = adapter.match(/phase\(task, saveTask, '[A-Z_]+'/g) ?? [];
  assert.ok(phaseCallSites.length >= 8, `every phase transition must emit an event (found ${phaseCallSites.length})`);
  const withoutSink = (adapter.match(/phase\(task, saveTask, '[A-Z_]+'\)/g) ?? []);
  assert.deepEqual(withoutSink, [], 'no phase transition may silently skip the projection');

  const orchestrator = readFileSync(join(ROOT, 'orchestrator.mjs'), 'utf8');
  assert.match(orchestrator, /recordTrustedImportError\(task, err\)/, 'the V2 failure path must persist a structured error');
  assert.match(orchestrator, /appendTaskEvent\(\{ eventsDir: eventsDirFor\(tasksDirOf\(task\)\)/, 'the failure must also land in the timeline');
  assert.equal(eventsDirFor('/tmp/x/tasks'), '/tmp/x/tasks/events', 'events live inside the tasks dir, so isolation follows the task records');
});
