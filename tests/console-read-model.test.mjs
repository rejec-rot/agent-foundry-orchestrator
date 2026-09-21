// console-read-model.test.mjs - first batch behaviour tests for the read-only console.
//
// B1 read-only filesystem, B2 damaged sources are never empty, B3 no file writes at all,
// B4 no network requests, plus out-of-bounds reads, redaction-before-JSON and golden files.
// Everything runs against a dedicated fixture under the OS temp dir: no production record is
// read, written or even referenced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { renderHuman } from '../lib/console/render.mjs';
import {
  assertWithinRoot,
  exactDeliveryAsset,
  buildEvidenceView,
  parseRecoveryId,
  assertWithinRoots,
  buildExceptionsView,
  buildOverview,
  buildTaskView,
  correlateAlertsAndNotify,
  readAlertBlock,
  readNotifyBlock,
  redactModel,
  resolveDataRoots,
} from '../lib/console/read-model.mjs';

const CLI = join(process.cwd(), 'af-admin.mjs');
const FIXED_NOW = Date.parse('2026-09-21T12:00:00.000Z');
const FIXED_FILE_TIME = new Date('2026-09-21T09:00:00.000Z');
const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/SECRET-HOOK-PATH';
const TOKEN = 'tk_secret_console_token';

/** A dedicated fixture: task records, a lock, the alert log, notify log/queue and recovery audit. */
function makeFixture({ broken = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'af-console-'));
  const dirs = {
    tasks: join(root, 'tasks'),
    locks: join(root, 'locks'),
    runtime: join(root, 'runtime'),
    audit: join(root, 'audit'),
    snapshots: join(root, 'snapshots'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

  const repo = join(root, 'repo');
  const alertsFile = join(dirs.runtime, 'boundary-alerts.jsonl');

  writeFileSync(join(dirs.tasks, 'T-OK.json'), `${JSON.stringify({
    task_id: 'T-OK',
    state: 'COMPLETED',
    state_version: 7,
    fixture_dir: repo,
    updated_at: '2026-09-21T08:00:00.000Z',
    trusted_import: {
      boundary_state: 'DISENGAGED',
      boundary_alert: { alert_id: 'AF-1', occurrences: 1 },
      boundary_notify: { status: 'sent', notify_key: `live|${repo}|first` },
      boundary_notify_secret_echo: `token ${TOKEN} via ${WEBHOOK}`,
    },
  }, null, 2)}\n`);

  writeFileSync(join(dirs.tasks, 'T-RETAIN.json'), `${JSON.stringify({
    task_id: 'T-RETAIN',
    state: 'FAILED',
    state_version: 3,
    fixture_dir: repo,
    trusted_import: {
      boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
      boundary_retained_reason: 'scope-anomaly',
      boundary_alert: { alert_id: 'AF-1', occurrences: 1 },
      boundary_scope_decision: { decision: 'RETAIN', reason: 'scope-anomaly', attempts: 1, anomalies: [{ class: 'broken-scope', code: 'ENOENT' }] },
    },
  }, null, 2)}\n`);

  // Half-written record: must be unverifiable, never the previous version. Kept out of the
  // default fixture so "clean" queries can legitimately exit 0; B2 adds it explicitly.
  if (broken) writeFileSync(join(dirs.tasks, 'T-BROKEN.json'), '{"task_id":"T-BROKEN","state":"AUTHOR_');

  writeFileSync(join(dirs.locks, 'T-RETAIN.lock'), `${JSON.stringify({
    task_id: 'T-RETAIN',
    orchestrator_instance_id: 'af-orch-dead',
    pid: 999999,
    acquired_at: '2026-09-21T08:00:00.000Z',
    lease_expires_at: '2026-09-21T09:00:00.000Z',
  }, null, 2)}\n`);

  const alertEvent = (extra) => JSON.stringify({
    event: 'boundary_retained',
    alert_id: 'AF-1',
    at: '2026-09-21T08:30:00.000Z',
    canonical_dir: repo,
    cas_dir: join(root, 'cas'),
    task_id: 'T-RETAIN',
    boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
    reason: 'scope-anomaly',
    occurrences: 1,
    severity: 'warning',
    threshold: 3,
    ...extra,
  });
  writeFileSync(alertsFile, `${alertEvent({})}\n`);

  writeFileSync(`${alertsFile}.notify.jsonl`, [
    JSON.stringify({
      event: 'boundary_notify', at: '2026-09-21T08:30:05.000Z', canonical_dir: repo, alert_id: 'AF-1',
      notify_key: `live|${repo}|first`, status: 'sent', mode: 'live', format: 'feishu', http_status: 200,
      provider_message: null, reason: null,
    }),
    JSON.stringify({
      event: 'boundary_notify', at: '2026-09-21T08:31:00.000Z', canonical_dir: repo, alert_id: 'AF-1',
      notify_key: `live|${repo}|escalated`, status: 'failed', mode: 'live', format: 'feishu', http_status: 200,
      provider_code: 19002, reason: `provider rejected the message: code=19002 bad token ${TOKEN} for ${WEBHOOK}`,
    }),
  ].join('\n') + '\n');

  writeFileSync(`${alertsFile}.notify-pending.json`, `${JSON.stringify({
    [`live|${repo}|escalated`]: {
      notify_key: `live|${repo}|escalated`, cooldown_key: `live|${repo}|escalated`, event: 'boundary_retained',
      canonical_dir: repo, cas_dir: null, task_id: 'T-RETAIN', alert_id: 'AF-1', format: 'feishu', mode: 'live',
      payload: { schema: 'af-boundary-alert-v1' }, attempts: 3, max_attempts: 3, state: 'exhausted',
      first_attempt_at: '2026-09-21T08:31:00.000Z', first_failed_at: '2026-09-21T08:31:00.000Z',
      claimed_at: null, claim_token: null, last_attempt_at: '2026-09-21T08:32:00.000Z',
      next_attempt_at: null, last_error: `failed with ${TOKEN}`,
    },
  }, null, 2)}\n`);

  writeFileSync(join(dirs.audit, 'recovery-2026-09-21T08-40-00-000Z-1-intent.json'), `${JSON.stringify({
    schema_version: 'af-boundary-recovery-v1', phase: 'intent', at: '2026-09-21T08:40:00.000Z',
    recovered_by: 'operator', justification: 'manual recovery', paths: [repo],
  }, null, 2)}\n`);
  writeFileSync(join(dirs.audit, 'recovery-2026-09-21T08-40-00-000Z-1-result.json'), `${JSON.stringify({
    schema_version: 'af-boundary-recovery-v1', phase: 'result', at: '2026-09-21T08:40:02.000Z',
    outcome: 'DISENGAGED', delivered: true, report: { restored: true, mismatches: [], failures: [] },
  }, null, 2)}\n`);

  // Fixed mtimes make the golden files deterministic.
  for (const file of listFiles(root)) utimesSync(file, FIXED_FILE_TIME, FIXED_FILE_TIME);

  const env = {
    AF_TASKS_DIR: dirs.tasks,
    AF_LOCKS_DIR: dirs.locks,
    AF_RUNTIME_DIR: dirs.runtime,
    AF_BOUNDARY_AUDIT_DIR: dirs.audit,
    AF_BOUNDARY_SNAPSHOT_DIR: dirs.snapshots,
    AF_BOUNDARY_ALERTS_FILE: alertsFile,
  };
  return { root, dirs, repo, alertsFile, env, roots: resolveDataRoots(env, root) };
}

function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) listFiles(full, base, out);
    else out.push(full);
  }
  return out;
}

/** Full tree fingerprint: paths, sizes and mtimes. Any write shows up here. */
function fingerprint(root) {
  const out = {};
  for (const file of listFiles(root)) {
    const stat = statSync(file);
    out[relative(root, file)] = `${stat.size}:${stat.mtimeMs}`;
  }
  return out;
}

function runCli(env, args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'console', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: `${err.stdout ?? ''}`, stderr: `${err.stderr ?? ''}` };
  }
}

const scrub = (json, root) => JSON.stringify(json).split(root).join('<ROOT>');

test('B3: the console writes nothing at all (no index repair, no lock, no temp file)', () => {
  const fx = makeFixture();
  try {
    const before = fingerprint(fx.root);
    buildOverview({ roots: fx.roots, now: FIXED_NOW });
    buildTaskView({ taskId: 'T-RETAIN', roots: fx.roots, now: FIXED_NOW });
    buildExceptionsView({ roots: fx.roots, now: FIXED_NOW });
    const cli = runCli(fx.env, ['overview', '--json']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.deepEqual(fingerprint(fx.root), before, 'the read path must not create, rewrite or delete any file');

    // The decisive check: `inspectBoundaryAlerts()` would have created/rewritten this index.
    assert.equal(existsSync(`${fx.alertsFile}.state.json`), false, 'the derived alert index must not be written');
    assert.equal(existsSync(fx.roots.locks) && readdirSync(fx.dirs.locks).length, 1, 'no lock file may be added');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('B1: every query runs on a read-only filesystem', () => {
  const fx = makeFixture();
  try {
    // Freeze the fixture: dirs 0555, files 0444 - any write attempt would throw EACCES.
    for (const file of listFiles(fx.root)) chmodSync(file, 0o444);
    for (const dir of [fx.dirs.tasks, fx.dirs.locks, fx.dirs.runtime, fx.dirs.audit, fx.dirs.snapshots, fx.root]) chmodSync(dir, 0o555);
    try {
      assert.equal(buildOverview({ roots: fx.roots, now: FIXED_NOW }).schema, 'af-console-overview-v1');
      assert.equal(buildTaskView({ taskId: 'T-OK', roots: fx.roots, now: FIXED_NOW }).schema, 'af-console-task-v1');
      assert.equal(buildExceptionsView({ roots: fx.roots, now: FIXED_NOW }).schema, 'af-console-exceptions-v1');
      const cli = runCli(fx.env, ['exceptions', '--json']);
      assert.equal(cli.code, 0, `read-only filesystem run failed: ${cli.stderr}`);
    } finally {
      for (const dir of [fx.root, fx.dirs.tasks, fx.dirs.locks, fx.dirs.runtime, fx.dirs.audit, fx.dirs.snapshots]) chmodSync(dir, 0o755);
      for (const file of listFiles(fx.root)) chmodSync(file, 0o644);
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('B2: damaged sources are unverifiable, never an empty list', () => {
  const fx = makeFixture({ broken: true });
  try {
    const clean = buildOverview({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(clean.blocks.alerts.read_status, 'ok');

    // A torn alert log line: the block must be unverifiable while still surfacing the prefix.
    writeFileSync(fx.alertsFile, `${readFileSync(fx.alertsFile, 'utf8')}{ torn alert line\n`);
    const damagedAlerts = buildOverview({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(damagedAlerts.blocks.alerts.read_status, 'unverifiable');
    assert.match(damagedAlerts.blocks.alerts.reason, /invalid line/);
    assert.notEqual(damagedAlerts.blocks.alerts.read_status, 'ok');
    const cliAlerts = runCli(fx.env, ['overview', '--json']);
    assert.equal(cliAlerts.code, 3, 'an unverifiable source must exit 3');
    assert.match(cliAlerts.stdout, /unverifiable/);

    // A damaged retry queue: unverifiable, and never "no pending deliveries".
    writeFileSync(`${fx.alertsFile}.notify-pending.json`, '{ broken queue');
    const damagedQueue = buildOverview({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(damagedQueue.blocks.notify.read_status, 'unverifiable');
    assert.match(damagedQueue.blocks.notify.reason, /queue unverifiable/);

    // The half-written task is listed and marked unverifiable, never silently dropped.
    const taskView = buildTaskView({ taskId: 'T-BROKEN', roots: fx.roots, now: FIXED_NOW });
    assert.equal(taskView.blocks.task.read_status, 'unverifiable');
    assert.match(taskView.blocks.task.reason, /not valid JSON/);

    // A genuinely missing source is reported as missing, which is distinguishable from empty.
    const absent = buildTaskView({ taskId: 'T-NOPE', roots: fx.roots, now: FIXED_NOW });
    assert.equal(absent.blocks.task.read_status, 'missing');
    assert.equal(runCli(fx.env, ['task', 'T-NOPE', '--json']).code, 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('B3-static: the read model imports no write, lock or process API', () => {
  const source = readFileSync(join(process.cwd(), 'lib', 'console', 'read-model.mjs'), 'utf8');
  const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)]
    .flatMap(([, names, from]) => names.split(',').map((name) => ({ name: name.trim(), from })));
  const forbiddenNames = new Set(['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync',
    'unlinkSync', 'chmodSync', 'chownSync', 'openSync', 'writeSync', 'createWriteStream', 'truncateSync',
    'utimesSync', 'symlinkSync', 'linkSync', 'copyFileSync', 'spawn', 'spawnSync', 'execSync', 'execFileSync',
    'acquireTaskLock', 'withBoundaryAlertLock', 'writeState', 'writeJsonAtomic', 'saveTaskAtomic',
    'saveTaskWithVersion', 'recordBoundaryAlert', 'resolveBoundaryAlert', 'notifyBoundaryAlert',
    'flushPendingNotifications', 'recoverRetainedBoundary', 'disengageTaskHostBoundary', 'engageTaskHostBoundary',
    'inspectBoundaryAlerts']);
  for (const { name, from } of imports) {
    assert.equal(forbiddenNames.has(name), false, `read-model must not import ${name} (from ${from})`);
  }
  for (const api of ['node:child_process', 'node:fs/promises']) {
    assert.equal(source.includes(api), false, `read-model must not import ${api}`);
  }
  // The CLI console branch must not reach a mutating entry point either.
  const cli = readFileSync(join(process.cwd(), 'af-admin.mjs'), 'utf8');
  const branch = cli.slice(cli.indexOf("mainCmd === 'console'"), cli.indexOf("} else if (mainCmd === 'reclaim')"));
  for (const mutating of ['recoverRetainedBoundary', 'flushPendingNotifications', 'notifyBoundaryAlert',
    'acquireTaskLock', 'saveTaskWithVersion', 'pruneTasks', 'rotateLogs', 'reapOrphans']) {
    assert.equal(branch.includes(mutating), false, `console branch must not call ${mutating}`);
  }
});

test('B4: no network requests, in the source and at run time', () => {
  const moduleSource = readFileSync(join(process.cwd(), 'lib', 'console', 'read-model.mjs'), 'utf8');
  for (const api of ['node:http', 'node:https', 'node:net', 'node:dns', 'node:tls', 'XMLHttpRequest']) {
    assert.equal(moduleSource.includes(api), false, `the read model must not import ${api}`);
  }
  assert.equal(/\bfetch\s*\(/.test(moduleSource), false, 'the read model must not call fetch');

  const fx = makeFixture();
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...args) => { fetchCalls += 1; return realFetch(...args); };
  try {
    buildOverview({ roots: fx.roots, now: FIXED_NOW });
    buildTaskView({ taskId: 'T-RETAIN', roots: fx.roots, now: FIXED_NOW });
    buildExceptionsView({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(fetchCalls, 0, 'a console query must not perform any network request');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('containment is path-aware: prefixes, traversal and symlinks are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-console-roots-'));
  const dataRoot = join(root, 'data');
  const sibling = join(root, 'data-evil');
  const outside = join(root, 'outside');
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(sibling, 'x.json'), '{}');
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
  symlinkSync(join(outside, 'secret.txt'), join(dataRoot, 'link.json'));
  try {
    // A bare string prefix would wrongly accept `data-evil` for root `data`.
    assert.equal(assertWithinRoot(sibling, dataRoot).ok, false);
    assert.equal(assertWithinRoot(join(dataRoot, 'x.json'), dataRoot).ok, true);
    assert.equal(assertWithinRoot(join(dataRoot, '..', 'data-evil', 'x.json'), dataRoot).ok, false);
    assert.equal(assertWithinRoot(join(dataRoot, 'sub', '..', '..', 'outside', 'secret.txt'), dataRoot).ok, false);
    assert.equal(assertWithinRoot(`${dataRoot}\0/x`, dataRoot).ok, false, 'NUL bytes are refused');
    // A symlink that escapes the root is refused by canonicalisation.
    assert.equal(assertWithinRoot(join(dataRoot, 'link.json'), dataRoot).ok, false, 'symlink escapes are refused');
    assert.equal(assertWithinRoots(join(outside, 'secret.txt'), { data: dataRoot }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('console audit refuses every out-of-bounds reference with exit 2', () => {
  const fx = makeFixture();
  try {
    const inside = join(fx.dirs.tasks, 'T-OK.json');
    assert.equal(runCli(fx.env, ['audit', inside, '--json']).code, 0);
    for (const ref of [
      '/etc/passwd',
      join(fx.root, '..', 'outside.json'),
      `${fx.dirs.tasks}-evil/x.json`,           // string prefix of a root must not pass
      join(fx.dirs.tasks, '..', '..', 'etc', 'passwd'),
    ]) {
      const res = runCli(fx.env, ['audit', ref, '--json']);
      assert.equal(res.code, 2, `expected refusal (2) for ${ref}, got ${res.code}`);
      assert.match(res.stderr, /outside the configured data roots|refusing/);
    }
    // A symlinked record inside a data root pointing outside must be refused too.
    const outsideFile = join(fx.root, 'outside-secret.json');
    writeFileSync(outsideFile, '{"secret":true}');
    symlinkSync(outsideFile, join(fx.dirs.tasks, 'T-LINK.json'));
    const linked = runCli(fx.env, ['audit', join(fx.dirs.tasks, 'T-LINK.json'), '--json']);
    assert.equal(linked.code, 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('redaction happens before serialisation: credentials never reach the JSON', () => {
  const fx = makeFixture();
  try {
    const overview = buildOverview({ roots: fx.roots, now: FIXED_NOW });
    const cli = runCli(fx.env, ['overview', '--json']);
    assert.equal(cli.code, 0, cli.stderr);
    for (const output of [JSON.stringify(overview), cli.stdout]) {
      assert.equal(output.includes(TOKEN), false, 'the token must not appear in the model or its JSON');
      assert.equal(output.includes('SECRET-HOOK-PATH'), false, 'the webhook path must not appear');
    }

    // Default output redacts paths (digests) as well as credentials. The overview carries no
    // paths at all, so the digest assertion belongs to a view that does (task/exceptions).
    assert.equal(cli.stdout.includes(fx.repo), false, 'paths are hashed by default');
    assert.equal(cli.stdout.includes('"path_mode": "hash"'), true);
    const taskRedacted = runCli(fx.env, ['task', 'T-OK', '--json']);
    assert.equal(taskRedacted.stdout.includes(fx.repo), false, 'task paths are hashed by default');
    assert.equal(taskRedacted.stdout.includes(fx.root), false, 'no absolute path from the fixture may survive redaction');
    assert.match(taskRedacted.stdout, /sha256:[0-9a-f]{16}/, 'hashed paths carry the digest form');

    // --no-redact is for local viewing: paths appear verbatim, credentials still do not.
    const noRedact = runCli(fx.env, ['task', 'T-OK', '--json', '--no-redact']);
    assert.equal(noRedact.stdout.includes(TOKEN), false);
    assert.equal(noRedact.stdout.includes('SECRET-HOOK-PATH'), false);
    assert.equal(noRedact.stdout.includes(fx.repo), true, '--no-redact keeps local paths visible');
    assert.equal(noRedact.stdout.includes('"path_mode": "full"'), true);

    // The hashed output of a task view keeps credentials out too.
    const hashed = runCli(fx.env, ['task', 'T-OK', '--json']);
    assert.equal(hashed.stdout.includes(fx.repo), false);
    assert.match(hashed.stdout, /sha256:[0-9a-f]{16}/);

    // The redaction helper is applied to the model itself, so no renderer can leak.
    const { model } = redactModel({ nested: { file: fx.alertsFile, reason: `${WEBHOOK} ${TOKEN}` } }, { redact: true, hash: true });
    assert.equal(JSON.stringify(model).includes(TOKEN), false);
    assert.match(model.nested.file, /^sha256:/);
    // An unknown field name holding an absolute path is still redacted (shape rule).
    const { model: shaped } = redactModel({ some_future_field: '/srv/secret-repo', other: 'plain text' }, { redact: true });
    assert.match(shaped.some_future_field, /^sha256:/);
    assert.equal(shaped.other, 'plain text');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('alert replay is pure and notifies the caller of invalid lines', () => {
  const fx = makeFixture();
  try {
    const block = readAlertBlock({ file: fx.alertsFile });
    assert.equal(block.read_status, 'ok');
    assert.equal(block.derived_from, 'event-log-replay');
    assert.equal(block.value.alerts.length, 1);
    assert.equal(block.value.alerts[0].open, true);

    writeFileSync(fx.alertsFile, `${readFileSync(fx.alertsFile, 'utf8')}not json\n`);
    const damaged = readAlertBlock({ file: fx.alertsFile });
    assert.equal(damaged.read_status, 'unverifiable');
    assert.equal(damaged.value.invalid_lines, 1);
    assert.equal(damaged.value.alerts.length, 1, 'the recoverable prefix is still surfaced');
    assert.equal(existsSync(`${fx.alertsFile}.state.json`), false, 'replay must not write the index');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('correlation reports unmatched links instead of guessing', () => {
  const fx = makeFixture();
  try {
    const overview = buildOverview({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(overview.correlation.alert_count, 1);
    assert.equal(overview.correlation.delivery_count, 2);
    assert.deepEqual(overview.correlation.unmatched, [], 'both sides link on the asset key here');

    // A delivery whose asset has no alert at all must be reported, never silently paired.
    const orphan = { notify_key: `live|/srv/other-repo|first`, status: 'sent' };
    const queue = JSON.parse(readFileSync(`${fx.alertsFile}.notify.jsonl`, 'utf8').trim().split('\n')[0]);
    writeFileSync(`${fx.alertsFile}.notify.jsonl`, `${JSON.stringify({ ...queue, notify_key: orphan.notify_key, canonical_dir: '/srv/other-repo' })}\n`);
    const after = buildOverview({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(after.correlation.unmatched.some((entry) => entry.kind === 'delivery-without-alert'), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('golden: the overview model is stable for a fixed fixture and clock', () => {
  const fx = makeFixture();
  try {
    const model = buildOverview({ roots: fx.roots, now: FIXED_NOW });
    const golden = scrub(model, fx.root);
    const goldenPath = join(process.cwd(), 'tests', 'fixtures', 'console-overview.golden.json');
    if (process.env.AF_UPDATE_GOLDEN === '1') {
      mkdirSync(join(process.cwd(), 'tests', 'fixtures'), { recursive: true });
      writeFileSync(goldenPath, `${JSON.stringify(JSON.parse(golden), null, 2)}\n`);
    }
    assert.equal(existsSync(goldenPath), true, 'the golden file must be committed');
    const expected = readFileSync(goldenPath, 'utf8');
    assert.equal(golden, JSON.stringify(JSON.parse(expected)), 'the overview model changed: review and update the golden file deliberately');
    // The golden file itself must not contain credentials.
    assert.equal(expected.includes(TOKEN), false);
    assert.equal(expected.includes('SECRET-HOOK-PATH'), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('read-model surfaces queue failures separately from deliveries', () => {
  const fx = makeFixture();
  try {
    const block = readNotifyBlock({ file: fx.alertsFile });
    assert.equal(block.read_status, 'ok');
    assert.equal(block.value.deliveries.length, 2);
    assert.equal(block.value.exhausted.length, 1);
    assert.equal(block.value.pending.length, 0);
    assert.equal(block.value.queue_ok, true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('G1: credentials are masked by field name, by Bearer text and in opaque values', () => {
  const { model } = redactModel({
    api_key: 'DUMMY_PRIVATE_VALUE',
    authorization: 'Bearer DUMMY_BEARER_VALUE',
    headers: { 'x-api-key': 'DUMMY_PRIVATE_VALUE' },
    log_line: 'Authorization: Bearer DUMMY_BEARER_VALUE and api_key=DUMMY_PRIVATE_VALUE',
    json_blob: '{"api_key": "DUMMY_PRIVATE_VALUE", "client_secret": "DUMMY_PRIVATE_VALUE"}',
    nested: [{ password: 'p', private_key: 'k', session_id: 's' }],
    harmless: 'plain text stays',
  }, { redact: true });
  const text = JSON.stringify(model);
  for (const secret of ['DUMMY_PRIVATE_VALUE', 'DUMMY_BEARER_VALUE']) {
    assert.equal(text.includes(secret), false, `${secret} must never survive redaction`);
  }
  assert.equal(model.api_key, '<redacted-field>');
  assert.equal(model.harmless, 'plain text stays');
  assert.match(model.log_line, /Bearer <redacted>/);
});

test('G1: paths with CJK characters and spaces are hashed by default', () => {
  const { model } = redactModel({
    file: '/tmp/私有目录/secret.txt',
    note: 'see /tmp/我的 目录/子目录/secret.txt for details',
    key: 'live|/tmp/私有目录/secret.txt|first',
  }, { redact: true });
  const text = JSON.stringify(model);
  assert.equal(text.includes('私有目录'), false, 'a CJK path must be redacted by default');
  assert.equal(text.includes('我的 目录'), false, 'a path containing a space must be redacted');
  assert.match(model.file, /^sha256:/);
  assert.match(model.key, /\|sha256:[0-9a-f]{16}\|/);
});

test('G1: truncation is recorded, never a silent shrink', () => {
  // 700 chars must survive the old 500-char cap of redactSecrets...
  const long = 'x'.repeat(700);
  const { model: untouched, truncations: none } = redactModel({ note: long }, { redact: true });
  assert.equal(untouched.note.length, 700, 'a 700-char value must not be silently shortened');
  assert.deepEqual(none, []);

  // ...and above the documented budget it is cut WITH a marker and a record.
  const { model, truncations } = redactModel({ note: long, nested: { deep: long } }, { redact: true, maxChars: 100 });
  assert.match(model.note, /…\[已截断 600 字符\]/);
  assert.equal(model.note.startsWith('x'.repeat(100)), true);
  assert.equal(truncations.length, 2, 'every truncated field is recorded');
  assert.deepEqual(truncations.map((t) => t.kept_chars), [100, 100]);
  assert.deepEqual(truncations.map((t) => t.original_chars), [700, 700]);
  assert.equal(truncations.some((t) => t.path === 'nested.deep'), true, 'the record points at the field');
});

test('G2: association uses the exact asset, never a substring', () => {
  assert.equal(exactDeliveryAsset({ notify_key: 'live|/srv/repo|first' }), '/srv/repo');
  assert.equal(exactDeliveryAsset({ notify_key: 'live|/srv/repo-other|first' }), '/srv/repo-other');
  assert.equal(exactDeliveryAsset({ notify_key: 'no-separators' }), null);
  assert.equal(exactDeliveryAsset({ notify_key: 'live||first' }), null);

  const alertBlock = { value: { alerts: [{ alert_id: 'AF-1', canonical_dir: '/srv/repo', open: true }] } };
  const otherOnly = { value: { deliveries: [{ notify_key: 'live|/srv/repo-other|first', status: 'sent' }], pending: [] } };
  const correlation = correlateAlertsAndNotify(alertBlock, otherOnly);
  assert.equal(
    correlation.unmatched.some((entry) => entry.kind === 'alert-without-delivery' && entry.canonical_dir === '/srv/repo'),
    true,
    'a neighbouring repo must not satisfy /srv/repo',
  );
  assert.equal(correlation.unmatched.some((entry) => entry.kind === 'delivery-without-alert' && entry.asset === '/srv/repo-other'), true);
});

test('G2: a task without asset keys attaches nothing instead of everything', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.dirs.tasks, 'T-NOKEY.json'), `${JSON.stringify({ task_id: 'T-NOKEY', state: 'FAILED', state_version: 1 })}\n`);
    const view = buildTaskView({ taskId: 'T-NOKEY', roots: fx.roots, now: FIXED_NOW });
    assert.equal(view.blocks.alerts.value.alerts.length, 0, 'alerts must not be attached without an asset/alert key');
    assert.equal(view.blocks.notify.value.deliveries.length, 0, 'deliveries must not be attached without a key');
    assert.equal(view.blocks.recovery.value.records.length, 0, 'recovery records must not be attached without a key');
    assert.equal(view.unmatched.some((entry) => entry.kind === 'task-without-asset-key'), true);

    // A task WITH a key gets only its own evidence.
    const own = buildTaskView({ taskId: 'T-RETAIN', roots: fx.roots, now: FIXED_NOW });
    assert.equal(own.blocks.alerts.value.alerts.length, 1);
    assert.equal(own.blocks.alerts.value.alerts[0].canonical_dir, fx.repo);
    assert.equal(own.blocks.notify.value.deliveries.length, 2, 'both deliveries belong to this asset');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('G2: recovery records are filtered by the task asset, not attached wholesale', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.dirs.audit, 'recovery-2026-09-21T09-00-00-000Z-2-intent.json'), `${JSON.stringify({
      schema_version: 'af-boundary-recovery-v1', phase: 'intent', at: '2026-09-21T09:00:00.000Z', paths: ['/srv/other-repo'],
    })}\n`);
    const view = buildTaskView({ taskId: 'T-RETAIN', roots: fx.roots, now: FIXED_NOW });
    const files = view.blocks.recovery.value.records.map((record) => record.file);
    assert.equal(files.length, 1, 'only this asset\'s recovery record may be attached');
    assert.equal(files[0].includes('other-repo'), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('G3: a damaged delivery log is unverifiable, not a silently shorter list', () => {
  const fx = makeFixture();
  try {
    const clean = buildOverview({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(clean.blocks.notify.read_status, 'ok');
    writeFileSync(`${fx.alertsFile}.notify.jsonl`, `${readFileSync(`${fx.alertsFile}.notify.jsonl`, 'utf8')}{ torn delivery line\n`);
    const damaged = buildOverview({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(damaged.blocks.notify.read_status, 'unverifiable');
    assert.match(damaged.blocks.notify.reason, /unparseable line/);
    assert.equal(runCli(fx.env, ['overview', '--json']).code, 3, 'a damaged delivery log must exit 3');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('G3: every per-task source failure reaches the exceptions report', () => {
  const fx = makeFixture({ broken: true });
  try {
    const view = buildExceptionsView({ roots: fx.roots, now: FIXED_NOW });
    const sources = view.unverifiable.map((entry) => entry.source);
    assert.equal(sources.includes('task:T-BROKEN'), true, 'a damaged task must appear in the unverifiable list');
    assert.equal(view.retained_boundaries.some((entry) => entry.task_id === 'T-BROKEN'), false, 'an unreadable task has no boundary evidence to report');

    // A lock that cannot be read is reported too, and never silently dropped.
    writeFileSync(join(fx.dirs.locks, 'T-BROKEN.lock'), '{ broken lock');
    const after = buildExceptionsView({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(after.unverifiable.some((entry) => entry.source === 'lock:T-BROKEN'), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('G3: access errors are unverifiable, only a definite absence is missing', () => {
  const fx = makeFixture();
  try {
    // A task file that exists but cannot be read (no read permission).
    const denied = join(fx.dirs.tasks, 'T-DENIED.json');
    writeFileSync(denied, '{"task_id":"T-DENIED","state":"FAILED"}');
    chmodSync(denied, 0o000);
    try {
      const block = buildTaskView({ taskId: 'T-DENIED', roots: fx.roots, now: FIXED_NOW }).blocks.task;
      assert.equal(block.read_status, 'unverifiable', 'an unreadable record must not be reported as missing');
      assert.match(block.reason, /EACCES|permission/);
    } finally {
      chmodSync(denied, 0o644);
    }

    // A data root that exists but cannot be listed.
    const unreadableDir = join(fx.root, 'unreadable-tasks');
    mkdirSync(unreadableDir, { recursive: true });
    writeFileSync(join(unreadableDir, 'T-X.json'), '{}');
    chmodSync(unreadableDir, 0o000);
    try {
      const roots = { ...fx.roots, tasks: unreadableDir };
      const index = buildOverview({ roots, now: FIXED_NOW }).blocks.tasks;
      assert.equal(index.read_status, 'unverifiable');
      assert.match(index.reason, /cannot be inspected|unreadable/);
    } finally {
      chmodSync(unreadableDir, 0o755);
    }

    // A genuinely absent task is `missing`, which is NOT unverifiable and NOT an error list entry.
    const absent = buildTaskView({ taskId: 'T-NOPE', roots: fx.roots, now: FIXED_NOW });
    assert.equal(absent.blocks.task.read_status, 'missing');
    const overview = buildOverview({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(overview.unverifiable.length, 0, 'missing sources must not be reported as unverifiable');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('G2b: two tasks on the same repository never share alert evidence', () => {
  const fx = makeFixture();
  try {
    // Second task on the SAME repo with its own alert id: the alert must not be shared.
    const alertIdB = 'AF-2';
    writeFileSync(join(fx.dirs.tasks, 'T-SECOND.json'), `${JSON.stringify({
      task_id: 'T-SECOND', state: 'FAILED', state_version: 1, fixture_dir: fx.repo,
      trusted_import: { boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY', boundary_alert: { alert_id: alertIdB } },
    })}\n`);
    writeFileSync(fx.alertsFile, `${readFileSync(fx.alertsFile, 'utf8')}${JSON.stringify({
      event: 'boundary_retained', alert_id: alertIdB, at: '2026-09-21T08:45:00.000Z', canonical_dir: fx.repo,
      cas_dir: null, task_id: 'T-SECOND', boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
      reason: 'scope-anomaly', occurrences: 1, severity: 'warning', threshold: 3,
    })}\n`);

    // The alert log keeps ONE current entry per path (occurrences accumulate), so after the
    // second retention the path's current entry is AF-2. A task that recorded AF-1 must attach
    // NOTHING and say why - attaching the path's current entry would import another task's
    // evidence.
    const first = buildTaskView({ taskId: 'T-RETAIN', roots: fx.roots, now: FIXED_NOW });
    assert.equal(first.blocks.alerts.value.alerts.length, 0, 'a non-matching explicit alert id must not fall back to the path');
    const unmatchedAlert = first.unmatched.find((entry) => entry.kind === 'task-without-alert');
    assert.equal(unmatchedAlert.requested_alert_id, 'AF-1');
    assert.deepEqual(unmatchedAlert.available_alert_ids, ['AF-2'], 'the reason lists what the path currently holds');

    const second = buildTaskView({ taskId: 'T-SECOND', roots: fx.roots, now: FIXED_NOW });
    assert.deepEqual(second.blocks.alerts.value.alerts.map((a) => a.alert_id), [alertIdB], 'the task holding the current entry attaches it');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('G2c: recovery ids match exactly - a prefix must not collide', () => {
  assert.equal(parseRecoveryId('/a/recovery-2026-09-21T08-40-00-000Z-1-intent.json'), '2026-09-21T08-40-00-000Z-1');
  assert.equal(parseRecoveryId('/a/recovery-2026-09-21T08-40-00-000Z-10-result.json'), '2026-09-21T08-40-00-000Z-10');
  assert.equal(parseRecoveryId('/a/not-a-recovery.json'), null);

  const fx = makeFixture();
  try {
    const base = '2026-09-21T08-40-00-000Z-1';
    // A second record whose id has the first as a strict prefix.
    writeFileSync(join(fx.dirs.audit, `recovery-${base}0-intent.json`), `${JSON.stringify({
      schema_version: 'af-boundary-recovery-v1', phase: 'intent', at: '2026-09-21T08:50:00.000Z', paths: ['/srv/other-repo'],
    })}\n`);
    writeFileSync(join(fx.dirs.tasks, 'T-REC.json'), `${JSON.stringify({
      task_id: 'T-REC', state: 'FAILED', state_version: 1,
      trusted_import: { boundary_state: 'RECONCILE_REQUIRED', boundary_recovery_id: base },
    })}\n`);

    const view = buildTaskView({ taskId: 'T-REC', roots: fx.roots, now: FIXED_NOW });
    const files = view.blocks.recovery.value.records.map((record) => record.file);
    // The fixture holds one intent+result pair for this id, so both exact matches attach...
    assert.equal(files.length, 2, 'the intent and result records of the exact id attach');
    assert.equal(files.every((file) => parseRecoveryId(file) === base), true);
    // ...while the sibling whose id merely starts with it must NOT.
    assert.equal(files.some((file) => file.endsWith(`recovery-${base}0-intent.json`)), false, 'a prefix collision must not match');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('G2d: a task with only a recovery id still correlates (and stays honest about the rest)', () => {
  const fx = makeFixture();
  try {
    const recoveryId = '2026-09-21T08-40-00-000Z-1';
    writeFileSync(join(fx.dirs.tasks, 'T-RECONLY.json'), `${JSON.stringify({
      task_id: 'T-RECONLY', state: 'FAILED', state_version: 1,
      trusted_import: { boundary_state: 'RECONCILE_REQUIRED', boundary_recovery_id: recoveryId },
    })}\n`);
    const view = buildTaskView({ taskId: 'T-RECONLY', roots: fx.roots, now: FIXED_NOW });
    assert.equal(view.blocks.recovery.value.records.length, 2, 'the matching intent+result records are attached');
    assert.equal(view.blocks.alerts.value.alerts.length, 0, 'without an asset or alert id, no alert may be attached');
    assert.equal(view.blocks.notify.value.deliveries.length, 0);
    assert.equal(view.unmatched.some((entry) => entry.kind === 'task-without-asset-key'), false, 'a recovery id is a usable key');
    assert.equal(view.keys.recovery_id, recoveryId);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('G2e: pending and exhausted deliveries are filtered like deliveries', () => {
  const fx = makeFixture();
  try {
    const queuePath = `${fx.alertsFile}.notify-pending.json`;
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'));
    const own = Object.values(queue)[0];
    queue[`live|/srv/repo-other|escalated`] = { ...own, notify_key: 'live|/srv/repo-other|escalated', canonical_dir: '/srv/repo-other', alert_id: 'AF-OTHER' };
    writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`);

    const view = buildTaskView({ taskId: 'T-RETAIN', roots: fx.roots, now: FIXED_NOW });
    assert.equal(view.blocks.notify.value.exhausted.length, 1, 'only this task\'s exhausted entry belongs here');
    assert.equal(view.blocks.notify.value.exhausted[0].canonical_dir, fx.repo);
    assert.equal(view.blocks.notify.value.pending.length, 0);
    // The global view still shows both, so filtering never hides the other task's problem.
    const exceptions = buildExceptionsView({ roots: fx.roots, now: FIXED_NOW });
    assert.equal(exceptions.exhausted_deliveries.length, 2);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('six-view CLI: each view renders and reports its exit status', () => {
  const fx = makeFixture();
  try {
    const record = join(fx.dirs.tasks, 'T-OK.json');
    for (const [args, expected] of [
      [['overview'], 0],
      [['tasks'], 0],
      [['task', 'T-OK'], 0],
      [['task', 'T-MISSING'], 2],
      [['evidence', 'T-OK'], 0],
      [['evidence', 'T-MISSING'], 2],
      [['exceptions'], 0],
      [['audit', record], 0],
      [['audit', '/etc/passwd'], 2],
      [['not-a-view'], 2],
    ]) {
      const res = runCli(fx.env, args);
      assert.equal(res.code, expected, `${args.join(' ')} → ${res.code} (${res.stderr})`);
    }

    // Human output is readable, carries the redaction notice and never a credential.
    const human = runCli(fx.env, ['exceptions']);
    assert.match(human.stdout, /af-console-exceptions-v1/);
    assert.match(human.stdout, /credentials always redacted/);
    assert.equal(human.stdout.includes(TOKEN), false);
    assert.equal(human.stdout.includes('SECRET-HOOK-PATH'), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('render: unverifiable and truncation are announced in the human view', async () => {
  const fx = makeFixture({ broken: true });
  try {
    writeFileSync(fx.alertsFile, `${readFileSync(fx.alertsFile, 'utf8')}{ torn alert line\n`);
    const res = runCli(fx.env, ['overview']);
    assert.equal(res.code, 3);
    assert.match(res.stdout, /! UNVERIFIABLE/);
    assert.match(res.stdout, /do not read this as "nothing to report"/);
    assert.match(res.stdout, /boundary-alerts/);

    // A truncated field is announced as an incomplete view.
    const text = renderHuman({ schema: 'af-console-task-v1', generated_at: 'x', path_mode: 'hash', truncations: [{ path: 'blocks.task.value.x', original_chars: 900, kept_chars: 100 }] });
    assert.match(text, /truncated fields: blocks\.task\.value\.x \(900→100\)/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
