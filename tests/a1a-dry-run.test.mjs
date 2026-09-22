// a1a-dry-run.test.mjs - U3 A1a automatic boundary recovery (dry-run first)
//
// Pins the frozen rules: default off does nothing; an empty/missing allowlist reaches no asset; a
// corrupt state file is a refusal (never an empty queue); the budget is bound to the protection
// epoch; eligibility is twelve guards that must all be explicitly true; and dry-run performs the
// full evaluation while changing NOTHING (permission, task, alert or scheduler state).

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  a1aConfig,
  loadA1aAllowlist,
  matchAllowlistAsset,
  readA1aState,
  writeA1aState,
  assetStateFor,
  backoffMsFor,
  recordA1aAttempt,
  a1aAssetKey,
  evaluateA1aEligibility,
  explainA1aAsset,
  runA1aSweep,
  readA1aEvents,
  findTaskForAsset,
  currentAlertIdFor,
  A1A_ALLOWLIST_SCHEMA,
  A1A_STATE_SCHEMA,
} from '../lib/a1a.mjs';

const ELIGIBLE_BOUNDARY = 'PROTECTION_RETAINED_PENDING_RECOVERY';

function makeCfg(overrides = {}, env = {}) {
  return a1aConfig({ ...process.env, ...env, ...overrides }, process.cwd());
}

function makeTask({ canonicalDir, casDir, state = 'COMPLETED', boundary = ELIGIBLE_BOUNDARY }) {
  return {
    task_id: 'T-A1A',
    state,
    fixture_dir: canonicalDir,
    trusted_import: {
      cas_dir: casDir,
      boundary_state: boundary,
      author_termination_evidence: { termination_confirmed: true, process_group_alive: false, scope_verified: true },
    },
  };
}

function goodDeps({ cfg, task, entry }) {
  return {
    allowlist: { ok: true, configured: true, assets: [entry], reason: null },
    findTask: () => ({ ok: true, missing: false, task }),
    decideScopes: () => ({ decision: 'UNLOCK', status: 'empty', anomalies: [] }),
    loadSnapshot: () => ({ entries: [] }),
    verifyProtection: () => ({ ok: true, checked: 1, expected: { uid: 0, gid: 0, dir_mode: 0o555, file_mode: 0o444 } }),
    checkAuditWritable: () => ({ ok: true }),
    readState: () => readA1aState(cfg),
    classifyRecovery: () => ({ state: 'clean', reason: null }),
    lockStatus: () => [{ path: entry.canonical_dir, state: 'free' }],
  };
}

// ---------------------------------------------------------------------------
// Configuration and off-by-default
// ---------------------------------------------------------------------------

test('A1A-1: the default mode is off, and off reads/attempts nothing', () => {
  const cfg = a1aConfig({}, process.cwd());
  assert.strictEqual(cfg.mode, 'off');

  let allowlistTouched = false;
  const res = runA1aSweep({
    cfg,
    deps: {
      allowlist: () => { allowlistTouched = true; return { ok: true, configured: false, assets: [] }; },
      findTask: () => { throw new Error('off must not read tasks'); },
    },
  });
  assert.strictEqual(res.mode, 'off');
  assert.deepStrictEqual(res.results, []);
  assert.strictEqual(allowlistTouched, false, 'off must not even read the allowlist');
});

test('A1A-2: an unrecognised mode is treated as off, and the mismatch is reported', () => {
  const cfg = a1aConfig({ AF_A1A_MODE: 'yolo' }, process.cwd());
  assert.strictEqual(cfg.mode, 'off');
  assert.strictEqual(cfg.configured_mode, 'yolo');
  assert.strictEqual(cfg.mode_valid, false);
});

// ---------------------------------------------------------------------------
// Allowlist (§2)
// ---------------------------------------------------------------------------

test('A1A-3: no allowlist means no asset is ever considered; a missing file is safe', () => {
  const cfg = a1aConfig({}, process.cwd());
  const none = loadA1aAllowlist(cfg);
  assert.strictEqual(none.ok, true);
  assert.strictEqual(none.assets.length, 0);

  const missing = loadA1aAllowlist({ ...cfg, allowlist_file: '/nonexistent/allowlist.json' });
  assert.strictEqual(missing.ok, true);
  assert.strictEqual(missing.assets.length, 0);
});

test('A1A-4: a malformed allowlist is a refusal, never "no assets" or "all assets"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-a1a-bad-'));
  try {
    const file = join(dir, 'allowlist.json');
    writeFileSync(file, '{ not json');
    const cfg = { ...a1aConfig({}, process.cwd()), allowlist_file: file };
    const parsed = loadA1aAllowlist(cfg);
    assert.strictEqual(parsed.ok, false);

    writeFileSync(file, JSON.stringify({ schema: 'wrong', assets: [] }));
    assert.strictEqual(loadA1aAllowlist(cfg).ok, false);

    writeFileSync(file, JSON.stringify({ schema: A1A_ALLOWLIST_SCHEMA, assets: [{ canonical_dir: '/a' }] }));
    assert.strictEqual(loadA1aAllowlist(cfg).ok, false, 'an asset without cas_dir is invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A1A-5: matching is exact on realpath for BOTH dirs (no prefix, no wildcard)', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-a1a-m-'));
  try {
    const canonical = join(root, 'canonical');
    const cas = join(root, 'cas');
    mkdirSync(canonical);
    mkdirSync(cas);
    const assets = [{ canonical_dir: canonical, cas_dir: cas, task_id: null, max_attempts: null }];
    assert.ok(matchAllowlistAsset(assets, { canonicalDir: canonical, casDir: cas }));
    assert.strictEqual(matchAllowlistAsset(assets, { canonicalDir: join(root, 'canonical-evil'), casDir: cas }), null);
    assert.strictEqual(matchAllowlistAsset(assets, { canonicalDir: canonical, casDir: join(root, 'other') }), null);
    const scoped = [{ ...assets[0], task_id: 'T1' }];
    assert.strictEqual(matchAllowlistAsset(scoped, { canonicalDir: canonical, casDir: cas, taskId: 'T2' }), null);
    assert.ok(matchAllowlistAsset(scoped, { canonicalDir: canonical, casDir: cas, taskId: 'T1' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// State: budget, backoff, exhaustion, corruption (§5)
// ---------------------------------------------------------------------------

test('A1A-6: a missing state file is empty, a corrupt one is a refusal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-a1a-st-'));
  try {
    const file = join(dir, 'state.json');
    const cfg = { ...a1aConfig({}, process.cwd()), queue_file: file };
    assert.strictEqual(readA1aState(cfg).ok, true);
    assert.strictEqual(readA1aState(cfg).missing, true);

    writeFileSync(file, '{ broken');
    const corrupt = readA1aState(cfg);
    assert.strictEqual(corrupt.ok, false, 'a corrupt state must never be an empty (budget-reset) queue');

    writeFileSync(file, JSON.stringify({ schema_version: 'af-a1a-state-v1', assets: 'not-an-object' }));
    assert.strictEqual(readA1aState(cfg).ok, false);

    writeA1aState(cfg, { schema_version: A1A_STATE_SCHEMA, assets: {} });
    assert.strictEqual(readA1aState(cfg).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A1A-7: the budget is bound to the epoch; a new epoch resets it', () => {
  const state = { schema_version: A1A_STATE_SCHEMA, assets: {} };
  const key = 'k';
  state.assets[key] = { epoch_id: 'e1', attempts: 2, next_attempt_at: null, phase: 'DEFERRED' };
  const same = assetStateFor(state, key, 'e1');
  assert.strictEqual(same.attempts, 2);
  const reset = assetStateFor(state, key, 'e2');
  assert.strictEqual(reset.attempts, 0);
  assert.strictEqual(reset.epoch_reset, true);
});

test('A1A-8: backoff is exponential and capped; exhaustion is a terminal phase', () => {
  const cfg = { retry_base_ms: 60000, retry_max_ms: 1800000, max_attempts: 3 };
  assert.strictEqual(backoffMsFor(0, cfg), 0);
  assert.strictEqual(backoffMsFor(1, cfg), 60000);
  assert.strictEqual(backoffMsFor(2, cfg), 120000);
  assert.strictEqual(backoffMsFor(9, cfg), 1800000, 'backoff must be capped');

  let record = { epoch_id: 'e1', attempts: 0 };
  record = recordA1aAttempt(record, cfg, Date.parse('2026-01-01T00:00:00Z'));
  assert.strictEqual(record.attempts, 1);
  assert.strictEqual(record.phase, 'DEFERRED');
  record = recordA1aAttempt(record, cfg, Date.parse('2026-01-01T00:00:00Z'));
  record = recordA1aAttempt(record, cfg, Date.parse('2026-01-01T00:00:00Z'));
  assert.strictEqual(record.attempts, 3);
  assert.strictEqual(record.phase, 'EXHAUSTED');
  assert.ok(record.exhausted_at);
});

// ---------------------------------------------------------------------------
// Eligibility (§3)
// ---------------------------------------------------------------------------

test('A1A-9: all twelve guards true -> eligible; each guard can independently refuse', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-a1a-el-'));
  try {
    const canonicalDir = join(root, 'canonical');
    const casDir = join(root, 'cas');
    mkdirSync(canonicalDir);
    mkdirSync(casDir);
    const entry = { canonical_dir: canonicalDir, cas_dir: casDir, task_id: null, max_attempts: null };
    const task = makeTask({ canonicalDir, casDir });
    const cfg = makeCfg({}, { AF_BOUNDARY_AUDIT_DIR: join(root, 'audit') });

    const ok = evaluateA1aEligibility({ entry, cfg, task, deps: goodDeps({ cfg, task, entry }) });
    assert.strictEqual(ok.eligible, true, JSON.stringify(ok.checks.filter((c) => c.ok !== true)));
    assert.strictEqual(ok.checks.length, 12);

    const cases = [
      ['3.2-boundary-state', { task: { ...task, trusted_import: { ...task.trusted_import, boundary_state: 'RESTORE_INCOMPLETE' } } }],
      ['3.3-task-terminal', { task: { ...task, state: 'WAITING_HUMAN' } }],
      ['3.3-task-terminal', { task: { ...task, state: 'AUTHOR_RUNNING' } }],
      ['3.4-writer-termination', { task: { ...task, trusted_import: { ...task.trusted_import, author_termination_evidence: null } } }],
      ['3.4-writer-termination', { task: { ...task, trusted_import: { ...task.trusted_import, author_termination_evidence: { termination_confirmed: true, process_group_alive: true, scope_verified: true } } } }],
      ['3.5-scopes-empty', { deps: { decideScopes: () => ({ decision: 'RETAIN', status: 'active', anomalies: [] }) } }],
      ['3.5-scopes-empty', { deps: { decideScopes: () => ({ decision: 'RETAIN', status: 'unknown', anomalies: [{ class: 'x' }] }) } }],
      ['3.6-snapshots-valid', { deps: { loadSnapshot: () => null } }],
      ['3.7-protection-expectation', { deps: { verifyProtection: () => ({ ok: false, reason: 'metadata mismatch' }) } }],
      ['3.8-audit-writable', { deps: { checkAuditWritable: () => ({ ok: false, reason: 'read-only' }) } }],
      ['3.9-budget', { deps: { readState: () => ({ ok: false, reason: 'corrupt' }) } }],
      ['3.10-no-unfinished-recovery', { deps: { classifyRecovery: () => ({ state: 'modified-unconfirmed' }) } }],
      ['3.11-asset-lock', { deps: { lockStatus: () => [{ path: canonicalDir, state: 'live' }] } }],
    ];
    for (const [guard, override] of cases) {
      const deps = { ...goodDeps({ cfg, task, entry }), ...(override.deps ?? {}) };
      const t = override.task ?? task;
      const res = evaluateA1aEligibility({ entry, cfg, task: t, deps });
      assert.strictEqual(res.eligible, false, `${guard} must refuse`);
      assert.strictEqual(res.first_failure, guard, `expected ${guard}, got ${res.first_failure}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1A-10: a corrupted state during evaluation refuses instead of acting (3.9)', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-a1a-cs-'));
  try {
    const canonicalDir = join(root, 'canonical');
    const casDir = join(root, 'cas');
    mkdirSync(canonicalDir);
    mkdirSync(casDir);
    const stateFile = join(root, 'state.json');
    writeFileSync(stateFile, '{ corrupt');
    const cfg = makeCfg({}, { AF_BOUNDARY_AUDIT_DIR: join(root, 'audit'), AF_A1A_QUEUE_FILE: stateFile });
    const entry = { canonical_dir: canonicalDir, cas_dir: casDir, task_id: null, max_attempts: null };
    const task = makeTask({ canonicalDir, casDir });
    const deps = { ...goodDeps({ cfg, task, entry }), readState: () => readA1aState(cfg) };
    const res = evaluateA1aEligibility({ entry, cfg, task, deps });
    assert.strictEqual(res.eligible, false);
    assert.strictEqual(res.first_failure, '3.9-budget');
    assert.match(res.reason, /state unreadable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Dry-run performs the evaluation but changes nothing (F18)
// ---------------------------------------------------------------------------

test('A1A-11: dry-run records would-recover and changes NO permission, task, alert or state', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-a1a-dr-'));
  try {
    const canonicalDir = join(root, 'canonical');
    const casDir = join(root, 'cas');
    const tasksDir = join(root, 'tasks');
    mkdirSync(canonicalDir);
    mkdirSync(casDir);
    mkdirSync(tasksDir);
    const entry = { canonical_dir: canonicalDir, cas_dir: casDir, task_id: null, max_attempts: null };
    const task = makeTask({ canonicalDir, casDir });
    writeFileSync(join(tasksDir, `${task.task_id}.json`), JSON.stringify(task, null, 2));
    const taskBefore = readFileSync(join(tasksDir, `${task.task_id}.json`), 'utf8');

    const auditRoot = join(root, 'audit');
    const stateFile = join(auditRoot, 'a1a', 'state.json');
    const cfg = makeCfg({}, { AF_BOUNDARY_AUDIT_DIR: auditRoot, AF_A1A_MODE: 'dry-run', AF_A1A_QUEUE_FILE: stateFile });

    const res = runA1aSweep({ cfg, deps: goodDeps({ cfg, task, entry }) });
    assert.strictEqual(res.mode, 'dry-run');
    assert.strictEqual(res.results.length, 1);
    assert.strictEqual(res.results[0].decision, 'WOULD_RECOVER');

    // Zero change: the task file is byte-identical and the scheduler state was never written.
    assert.strictEqual(readFileSync(join(tasksDir, `${task.task_id}.json`), 'utf8'), taskBefore, 'dry-run must not touch task state');
    assert.strictEqual(existsSync(stateFile), false, 'dry-run must not write scheduler state');

    // ... but it leaves an audit trail saying what it WOULD have done.
    const events = readA1aEvents(cfg);
    assert.ok(events.ok);
    assert.ok(events.events.some((e) => e.event === 'a1a_would_recover'), 'dry-run must record a would-recover event');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1A-12: dry-run refuses (never releases) on a corrupt state and on an ineligible asset', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-a1a-dr2-'));
  try {
    const canonicalDir = join(root, 'canonical');
    const casDir = join(root, 'cas');
    mkdirSync(canonicalDir);
    mkdirSync(casDir);
    const entry = { canonical_dir: canonicalDir, cas_dir: casDir, task_id: null, max_attempts: null };
    const task = makeTask({ canonicalDir, casDir, boundary: 'RESTORE_INCOMPLETE' });
    const cfg = makeCfg({}, { AF_BOUNDARY_AUDIT_DIR: join(root, 'audit'), AF_A1A_MODE: 'dry-run' });
    const res = runA1aSweep({ cfg, deps: goodDeps({ cfg, task, entry }) });
    assert.strictEqual(res.results[0].decision, 'REFUSED_INELIGIBLE');
    assert.strictEqual(res.results[0].reason_code, 'a1a_ineligible(3.2-boundary-state)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Explain + CLI wiring
// ---------------------------------------------------------------------------

test('A1A-13: explain reports each guard and the first failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-a1a-ex-'));
  try {
    const canonicalDir = join(root, 'canonical');
    const casDir = join(root, 'cas');
    mkdirSync(canonicalDir);
    mkdirSync(casDir);
    const cfg = makeCfg({}, { AF_BOUNDARY_AUDIT_DIR: join(root, 'audit') });
    const explanation = explainA1aAsset({
      cfg,
      canonicalDir,
      casDir,
      deps: {
        allowlist: { ok: true, configured: false, assets: [], reason: null },
        findTask: () => ({ ok: true, missing: true, task: null }),
        decideScopes: () => ({ decision: 'RETAIN', status: 'unknown', anomalies: [] }),
        loadSnapshot: () => null,
        verifyProtection: () => ({ ok: false, reason: 'no epoch' }),
        checkAuditWritable: () => ({ ok: true }),
        readState: () => ({ ok: true, state: { assets: {} } }),
        classifyRecovery: () => ({ state: 'clean' }),
        lockStatus: () => [],
      },
    });
    assert.strictEqual(explanation.ok, true);
    assert.strictEqual(explanation.entry, null);
    assert.strictEqual(explanation.evaluation.eligible, false);
    assert.strictEqual(explanation.evaluation.first_failure, '3.1-allowlisted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1A-14: CLI a1a status is exit 0 in off mode and exit 3 on a corrupt state', () => {
  const cli = join(process.cwd(), 'af-admin.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'af-a1a-cli-'));
  try {
    const offRun = spawnSync(process.execPath, [cli, 'a1a', 'status'], {
      env: { ...process.env, AF_A1A_MODE: 'off', AF_BOUNDARY_AUDIT_DIR: dir },
      encoding: 'utf8',
    });
    assert.strictEqual(offRun.status, 0, offRun.stderr);
    assert.match(offRun.stdout, /a1a mode: off/);

    const stateFile = join(dir, 'a1a', 'state.json');
    mkdirSync(join(dir, 'a1a'), { recursive: true });
    writeFileSync(stateFile, '{ corrupt');
    const corruptRun = spawnSync(process.execPath, [cli, 'a1a', 'status'], {
      env: { ...process.env, AF_A1A_MODE: 'dry-run', AF_BOUNDARY_AUDIT_DIR: dir, AF_A1A_QUEUE_FILE: stateFile },
      encoding: 'utf8',
    });
    assert.strictEqual(corruptRun.status, 3, `expected exit 3, got ${corruptRun.status}: ${corruptRun.stdout}${corruptRun.stderr}`);
    assert.match(corruptRun.stderr, /state unverifiable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A1A-15: several tasks on one asset are resolved only by an exact key, never by file order', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-a1a-amb-'));
  try {
    const canonicalDir = join(root, 'canonical');
    const casDir = join(root, 'cas');
    const tasksDir = join(root, 'tasks');
    mkdirSync(canonicalDir);
    mkdirSync(casDir);
    mkdirSync(tasksDir);
    const taskWith = (taskId, alertId) => ({
      ...makeTask({ canonicalDir, casDir }),
      task_id: taskId,
      trusted_import: { ...makeTask({ canonicalDir, casDir }).trusted_import, boundary_alert: { alert_id: alertId } },
    });
    writeFileSync(join(tasksDir, 'T-X.json'), JSON.stringify(taskWith('T-X', 'AF-X')));
    writeFileSync(join(tasksDir, 'T-Y.json'), JSON.stringify(taskWith('T-Y', 'AF-Y')));

    // Two candidates: alphabetical order must NOT decide which task a recovery binds to.
    const ambiguous = findTaskForAsset({ tasksDir, canonicalDir, casDir });
    assert.strictEqual(ambiguous.ok, false, 'an ambiguous asset must be refused');
    assert.match(ambiguous.reason, /task-ambiguous/);
    assert.deepStrictEqual(ambiguous.candidates.map((task) => task.task_id).sort(), ['T-X', 'T-Y']);

    // An exact alert id selects exactly one task.
    const exact = findTaskForAsset({ tasksDir, canonicalDir, casDir, alertId: 'AF-Y' });
    assert.strictEqual(exact.ok, true);
    assert.strictEqual(exact.task.task_id, 'T-Y');
    assert.strictEqual(exact.disambiguated_by, 'alert_id');

    // An alert id matching nothing stays refused (no fallback to "the first one").
    const none = findTaskForAsset({ tasksDir, canonicalDir, casDir, alertId: 'AF-NOPE' });
    assert.strictEqual(none.ok, false);
    assert.match(none.reason, /task-ambiguous/);

    // An explicit task_id always wins.
    const pinned = findTaskForAsset({ tasksDir, canonicalDir, casDir, taskId: 'T-X' });
    assert.strictEqual(pinned.task.task_id, 'T-X');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1A-16: the exhaustion event references the ORIGINAL alert and never fakes a count', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-a1a-ex-'));
  try {
    const canonicalDir = join(root, 'canonical');
    const casDir = join(root, 'cas');
    const auditRoot = join(root, 'audit');
    mkdirSync(canonicalDir);
    mkdirSync(casDir);
    mkdirSync(auditRoot);
    const alertsFile = join(root, 'boundary-alerts.jsonl');
    const alertEvent = (alertId) => JSON.stringify({
      event: 'boundary_retained', alert_id: alertId, at: '2026-09-21T00:00:00.000Z',
      canonical_dir: canonicalDir, cas_dir: casDir, task_id: 'T-A1A',
      boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY', reason: 'scope-anomaly',
      occurrences: 2, severity: 'warning', threshold: 3,
    });
    writeFileSync(alertsFile, `${alertEvent('AF-EX')}\n`);
    // The pure reader is what resolves the link, and it never writes the index.
    assert.deepStrictEqual(currentAlertIdFor({ alertsFile, canonicalDir }), { ok: true, alert_id: 'AF-EX', reason: null });

    const cfg = makeCfg({}, {
      AF_A1A_MODE: 'live',
      AF_BOUNDARY_ALERT_ESCALATE_AFTER: '3',
      AF_BOUNDARY_ALERTS_FILE: alertsFile,
      AF_BOUNDARY_AUDIT_DIR: auditRoot,
      AF_A1A_ALLOWLIST_FILE: null,
      AF_A1A_MAX_ATTEMPTS: '2',
      AF_A1A_QUEUE_FILE: join(auditRoot, 'state.json'),
    });
    const entry = { canonical_dir: canonicalDir, cas_dir: casDir, task_id: null, max_attempts: null };
    const task = {
      ...makeTask({ canonicalDir, casDir }),
      trusted_import: { ...makeTask({ canonicalDir, casDir }).trusted_import, boundary_alert: { alert_id: 'AF-EX' } },
    };
    // Seed a state whose epoch matches the verified epoch and already used one attempt.
    const epochId = 'epoch-test-1';
    const key = a1aAssetKey({ canonicalDir, casDir });
    writeA1aState(cfg, { schema_version: A1A_STATE_SCHEMA, assets: { [key]: { epoch_id: epochId, attempts: 1, phase: 'PENDING' } } });

    const res = runA1aSweep({
      cfg,
      deps: {
        allowlist: { ok: true, configured: true, assets: [entry], reason: null },
        findTask: () => ({ ok: true, missing: false, task }),
        decideScopes: () => ({ decision: 'UNLOCK', status: 'empty', anomalies: [] }),
        loadSnapshot: () => ({ entries: [] }),
        verifyProtection: () => ({ ok: true, checked: 1, epoch: { epoch_id: epochId }, expected: { uid: 0, gid: 0, dir_mode: 0o555, file_mode: 0o444 } }),
        checkAuditWritable: () => ({ ok: true }),
        classifyRecovery: () => ({ state: 'clean', reason: null }),
        lockStatus: () => [{ path: canonicalDir, state: 'free' }],
        // A live attempt that neither completes nor needs a human: the second one exhausts.
        recover: () => ({ outcome: 'PROTECTION_RETAINED', recovered: false, delivered: false, reason: 'scopes not empty' }),
      },
    });
    assert.strictEqual(res.mode, 'live');

    const events = readA1aEvents(cfg).events;
    const exhausted = events.filter((event) => event.event === 'a1a_recovery_exhausted');
    assert.strictEqual(exhausted.length, 1, 'the exhaustion event must be recorded');
    assert.strictEqual(exhausted[0].alert_id, 'AF-EX', 'the event must reference the original alert');
    assert.strictEqual(exhausted[0].alert_resolution, 'linked');
    assert.strictEqual(exhausted[0].attempts, 2);
    assert.strictEqual(exhausted[0].occurrences, undefined, 'it must not fabricate a retention count');
    const state = readA1aState(cfg);
    assert.strictEqual(state.state.assets[key].phase, 'EXHAUSTED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A1A-17: an unreadable alert log is not "no alert" for the exhaustion link', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-a1a-ex2-'));
  try {
    const canonicalDir = join(root, 'canonical');
    mkdirSync(canonicalDir);
    const alertsFile = join(root, 'boundary-alerts.jsonl');
    writeFileSync(alertsFile, '{ torn alert line\n');
    const resolved = currentAlertIdFor({ alertsFile, canonicalDir });
    assert.strictEqual(resolved.ok, false, 'an unreadable log must not resolve to "no alert"');
    assert.match(resolved.reason, /unparseable|invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
