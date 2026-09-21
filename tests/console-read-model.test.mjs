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

import {
  assertWithinRoot,
  assertWithinRoots,
  buildExceptionsView,
  buildOverview,
  buildTaskView,
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
