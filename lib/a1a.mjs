// a1a.mjs - A1a automatic boundary recovery (scheduler engine).
//
// This is the implementation baseline frozen in docs/design/A1A-AUTO-RECOVERY-DESIGN.md. It is
// deliberately conservative and dry-run first:
//
//   * mode defaults to `off`, and `off` reads nothing, locks nothing and attempts nothing;
//   * an asset is only ever considered when it matches the EXPLICIT allowlist (realpath-equal
//     canonical_dir AND cas_dir, optional task_id) - an empty/missing allowlist means no asset;
//   * eligibility is twelve guards that must all be explicitly true; any unknown is a refusal
//     with a reason code, never a guess;
//   * the automatic-attempt budget is bound to the protection EPOCH (a new protection batch
//     starts a fresh budget) and persisted atomically; a corrupt state file is a refusal, never
//     an empty queue;
//   * `dry-run` runs the whole evaluation (including taking the asset lock and re-verifying) and
//     records what it WOULD do, but changes nothing: no permission, no task, no alert, no state.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeJsonAtomic, saveTaskWithVersion } from './store.mjs';
import { decideWriterScopesEmpty, loadPathSnapshot, boundaryRecoveryAuditDir, classifyUnfinishedRecovery, recoverRetainedBoundary } from './host-boundary.mjs';
import { verifyProtectionFor, expectedProtectionMetadata } from './protection-epoch.mjs';
import { assetLockStatus } from './asset-lock.mjs';
import { replayBoundaryAlerts } from './boundary-alerts.mjs';

export const A1A_STATE_SCHEMA = 'af-a1a-state-v1';
export const A1A_ALLOWLIST_SCHEMA = 'af-a1a-allowlist-v1';
export const A1A_MODES = Object.freeze(['off', 'dry-run', 'live']);
/** A task in one of these states has provably stopped for good (§3.3). WAITING_HUMAN is excluded. */
export const A1A_TERMINAL_TASK_STATES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED']);
/** The only boundary state automatic recovery may act on. */
export const A1A_ELIGIBLE_BOUNDARY_STATE = 'PROTECTION_RETAINED_PENDING_RECOVERY';

function intEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function canonical(target) {
  try {
    return realpathSync(target);
  } catch {
    return typeof target === 'string' ? target : null;
  }
}

// ---------------------------------------------------------------------------
// Configuration (§2)
// ---------------------------------------------------------------------------

/** Resolve the A1a configuration. Every knob defaults closed. */
export function a1aConfig(env = process.env, cwd = process.cwd()) {
  const configuredMode = env.AF_A1A_MODE ?? 'off';
  // An unrecognised mode is `off`, not a guessed-on mode.
  const mode = A1A_MODES.includes(configuredMode) ? configuredMode : 'off';
  return {
    mode,
    configured_mode: configuredMode,
    mode_valid: mode === configuredMode,
    allowlist_file: env.AF_A1A_ALLOWLIST_FILE ?? null,
    interval_ms: intEnv(env.AF_A1A_INTERVAL_MS, 300000),
    max_attempts: intEnv(env.AF_A1A_MAX_ATTEMPTS, 3),
    retry_base_ms: intEnv(env.AF_A1A_RETRY_BASE_MS, 60000),
    retry_max_ms: intEnv(env.AF_A1A_RETRY_MAX_MS, 1800000),
    lock_ttl_ms: intEnv(env.AF_A1A_LOCK_TTL_MS, 600000),
    audit_root: env.AF_BOUNDARY_AUDIT_DIR || boundaryRecoveryAuditDir(),
    audit_subdir: env.AF_A1A_AUDIT_SUBDIR ?? 'a1a',
    notify_on_success: env.AF_A1A_NOTIFY_ON_SUCCESS === '1',
    tasks_dir: env.AF_TASKS_DIR || join(cwd, 'tasks'),
    alerts_file: env.AF_BOUNDARY_ALERTS_FILE || join(env.AF_RUNTIME_DIR || join(cwd, 'runtime'), 'boundary-alerts.jsonl'),
    queue_file: env.AF_A1A_QUEUE_FILE ?? null,
  };
}

/** The directory holding A1a's own audit trail: `<audit root>/<subdir>`. */
export function a1aAuditDir(cfg) {
  return join(cfg.audit_root, cfg.audit_subdir);
}

/** The state file: `AF_A1A_QUEUE_FILE` or `<audit root>/<subdir>/state.json`. */
export function a1aStateFile(cfg) {
  return cfg.queue_file || join(a1aAuditDir(cfg), 'state.json');
}

// ---------------------------------------------------------------------------
// Allowlist (§2)
// ---------------------------------------------------------------------------

/**
 * Load and validate the allowlist.
 *
 * A missing file is "no assets", which is safe. A file that exists but cannot be parsed or is
 * malformed is `ok:false`: a broken allowlist must never silently become "no assets" (that would
 * hide an operator mistake) nor "everything".
 */
export function loadA1aAllowlist(cfg) {
  if (!cfg.allowlist_file) {
    return { ok: true, configured: false, assets: [], reason: 'no allowlist is configured (no asset is ever considered)' };
  }
  let raw;
  try {
    raw = readFileSync(cfg.allowlist_file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { ok: true, configured: true, assets: [], missing: true, reason: `allowlist file not found: ${cfg.allowlist_file}` };
    }
    return { ok: false, configured: true, assets: [], reason: `allowlist file could not be read: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, configured: true, assets: [], reason: `allowlist file is not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schema !== A1A_ALLOWLIST_SCHEMA || !Array.isArray(parsed.assets)) {
    return { ok: false, configured: true, assets: [], reason: `allowlist must be an object with schema "${A1A_ALLOWLIST_SCHEMA}" and an assets array` };
  }
  const assets = [];
  for (const [index, entry] of parsed.assets.entries()) {
    if (!entry || typeof entry.canonical_dir !== 'string' || !entry.canonical_dir
      || typeof entry.cas_dir !== 'string' || !entry.cas_dir) {
      return { ok: false, configured: true, assets: [], reason: `allowlist asset #${index} must name both canonical_dir and cas_dir` };
    }
    if (entry.task_id !== undefined && entry.task_id !== null && typeof entry.task_id !== 'string') {
      return { ok: false, configured: true, assets: [], reason: `allowlist asset #${index} has a non-string task_id` };
    }
    assets.push({
      canonical_dir: entry.canonical_dir,
      cas_dir: entry.cas_dir,
      task_id: entry.task_id ?? null,
      max_attempts: Number.isInteger(entry.max_attempts) && entry.max_attempts > 0 ? entry.max_attempts : null,
    });
  }
  return { ok: true, configured: true, assets, reason: null };
}

/**
 * The allowlist entry that matches an asset (canonical_dir + cas_dir, realpath-compared), or null.
 *
 * `taskId` is an OPTIONAL narrowing: an entry that pins a `task_id` still matches the asset when
 * the caller does not name a task (the entry's own task_id is used downstream). Only an explicit,
 * conflicting `taskId` is a mismatch - otherwise `a1a explain` would report "not allowlisted" for
 * any allowlist entry that pins a task, while the sweep (which uses the entry directly) matched it.
 */
export function matchAllowlistAsset(assets, { canonicalDir, casDir, taskId = null }) {
  const targetCanonical = canonical(canonicalDir);
  const targetCas = canonical(casDir);
  for (const entry of assets) {
    if (canonical(entry.canonical_dir) !== targetCanonical) continue;
    if (canonical(entry.cas_dir) !== targetCas) continue;
    if (taskId != null && entry.task_id !== null && entry.task_id !== taskId) continue;
    return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scheduler state: budget, backoff, terminal phases (§5)
// ---------------------------------------------------------------------------

function emptyState() {
  return { schema_version: A1A_STATE_SCHEMA, updated_at: new Date().toISOString(), assets: {} };
}

/** `asset + epoch` is the budget key, so a new protection batch starts the budget at zero (§1.2). */
export function a1aAssetKey({ canonicalDir, casDir }) {
  return `${canonical(canonicalDir)}|${canonical(casDir)}`;
}

/**
 * Read the scheduler state strictly.
 * A missing file is an empty state; an unreadable or malformed file is `ok:false` - the caller
 * must refuse to act rather than treat a damaged state as an empty (budget-reset) queue.
 */
export function readA1aState(cfg) {
  const file = a1aStateFile(cfg);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, missing: true, state: emptyState(), file };
    return { ok: false, missing: false, state: null, file, reason: `state file could not be read: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, missing: false, state: null, file, reason: `state file is not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schema_version !== A1A_STATE_SCHEMA || typeof parsed.assets !== 'object' || parsed.assets === null) {
    return { ok: false, missing: false, state: null, file, reason: `state file does not match schema ${A1A_STATE_SCHEMA}` };
  }
  return { ok: true, missing: false, state: parsed, file };
}

/** Persist the scheduler state atomically. */
export function writeA1aState(cfg, state) {
  const file = a1aStateFile(cfg);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const next = { ...state, schema_version: A1A_STATE_SCHEMA, updated_at: new Date().toISOString() };
  writeJsonAtomic(file, next);
  return file;
}

/** The per-asset record for one epoch; a changed epoch resets the budget (§1.2, F24). */
export function assetStateFor(state, key, epochId) {
  const existing = state.assets[key];
  if (!existing || existing.epoch_id !== epochId) {
    return { epoch_id: epochId, attempts: 0, next_attempt_at: null, phase: 'IDLE', last_reason: null, needs_human: false, exhausted_at: null, epoch_reset: Boolean(existing) };
  }
  return existing;
}

/** Exponential backoff, capped; the actual retry happens at the NEXT sweep, not "in N minutes" (§5). */
export function backoffMsFor(attempts, cfg) {
  if (attempts <= 0) return 0;
  const raw = cfg.retry_base_ms * (2 ** (attempts - 1));
  return Math.min(raw, cfg.retry_max_ms);
}

/** Record one real attempt against the epoch budget and schedule the next sweep. */
export function recordA1aAttempt(record, cfg, nowMs = Date.now()) {
  const attempts = (record.attempts ?? 0) + 1;
  const exhausted = attempts >= cfg.max_attempts;
  return {
    ...record,
    attempts,
    next_attempt_at: new Date(nowMs + backoffMsFor(attempts, cfg)).toISOString(),
    phase: exhausted ? 'EXHAUSTED' : 'DEFERRED',
    exhausted_at: exhausted ? new Date(nowMs).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Audit trail (§5)
// ---------------------------------------------------------------------------

/** Append one A1a audit event. Never throws into the caller's decision path. */
export function appendA1aEvent(cfg, event, fields = {}) {
  const dir = a1aAuditDir(cfg);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record = { schema_version: A1A_STATE_SCHEMA, at: new Date().toISOString(), event, mode: cfg.mode, ...fields };
    appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(record)}\n`);
    return { ok: true, file: join(dir, 'events.jsonl') };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Read the audit events (strict; an unreadable trail is reported, never treated as empty). */
export function readA1aEvents(cfg) {
  const file = join(a1aAuditDir(cfg), 'events.jsonl');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, missing: true, events: [], file };
    return { ok: false, missing: false, events: [], file, reason: err.message };
  }
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { return { ok: false, missing: false, events: [], file, reason: 'audit trail contains an unparseable line' }; }
  }
  return { ok: true, missing: false, events, file };
}

// ---------------------------------------------------------------------------
// Task lookup
// ---------------------------------------------------------------------------

function readTask(tasksDir, taskId) {
  try {
    return { ok: true, task: JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf8')) };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, missing: true, task: null };
    return { ok: false, task: null, reason: err.message };
  }
}

/** Find the task that owns a boundary for this asset (explicit task_id wins, else scan). */
export function findTaskForAsset({ tasksDir, canonicalDir, casDir, taskId = null, alertId = null }) {
  if (taskId) {
    const read = readTask(tasksDir, taskId);
    if (!read.ok || read.missing) return { ok: read.ok, missing: read.missing ?? false, task: null, reason: read.reason ?? null };
    return { ok: true, missing: false, task: read.task };
  }
  let names;
  try {
    names = readdirSync(tasksDir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, missing: true, task: null };
    return { ok: false, task: null, reason: `tasks directory unreadable: ${err.message}` };
  }
  const targetCanonical = canonical(canonicalDir);
  const targetCas = canonical(casDir);
  const candidates = [];
  for (const name of names.sort()) {
    const read = readTask(tasksDir, name.replace(/\.json$/, ''));
    if (!read.ok || read.missing) continue;
    const task = read.task;
    if (canonical(task?.fixture_dir) !== targetCanonical) continue;
    if (canonical(task?.trusted_import?.cas_dir) !== targetCas) continue;
    if (task?.trusted_import?.boundary_state == null) continue;
    candidates.push(task);
  }
  if (candidates.length === 0) return { ok: true, missing: true, task: null, candidates: [] };
  if (candidates.length === 1) return { ok: true, missing: false, task: candidates[0], candidates };

  // Several tasks share this asset. Choosing one by file order would silently bind the recovery
  // (and the task-state write) to an arbitrary task, so the ONLY accepted disambiguation is an
  // exact key - the asset's current alert id. Anything else is a refusal for a human.
  if (alertId) {
    const exact = candidates.filter((task) => task?.trusted_import?.boundary_alert?.alert_id === alertId);
    if (exact.length === 1) return { ok: true, missing: false, task: exact[0], candidates, disambiguated_by: 'alert_id' };
    if (exact.length > 1) {
      return { ok: false, missing: false, task: null, candidates, reason: `task-ambiguous: ${exact.length} tasks match this asset and alert id ${alertId}` };
    }
  }
  return {
    ok: false,
    missing: false,
    task: null,
    candidates,
    reason: `task-ambiguous: ${candidates.length} tasks match this asset (${candidates.map((task) => task.task_id).join(', ')}) and none can be selected by an exact alert id; pin task_id in the allowlist or reconcile manually`,
  };
}

// ---------------------------------------------------------------------------
// Eligibility (§3)
// ---------------------------------------------------------------------------

function check(id, ok, detail) {
  return { id, ok: ok === true ? true : (ok === 'unknown' ? 'unknown' : false), detail };
}

function terminationEvidenceConfirmed(evidence) {
  return Boolean(
    evidence
      && evidence.termination_confirmed === true
      && evidence.process_group_alive === false
      && evidence.scope_verified === true,
  );
}

/** The recorded writer-termination evidence for a task (§3.4): all present entries must be confirmed. */
export function writerTerminationEvidence(task) {
  const evidence = [
    task?.trusted_import?.author_termination_evidence,
    task?.trusted_import?.last_reviewer_termination_evidence,
    task?.last_review_termination_evidence,
  ].filter(Boolean);
  return evidence;
}

/**
 * The asset's CURRENT alert id, read with the pure replay (never the index-repairing reader):
 * `{ ok, alert_id, reason }`. An unreadable log is not "no alert".
 */
export function currentAlertIdFor({ alertsFile, canonicalDir }) {
  const replay = replayBoundaryAlerts({ file: alertsFile, includeResolved: true });
  if (!replay.ok) return { ok: false, alert_id: null, reason: replay.reason };
  const match = (replay.alerts ?? []).find((alert) => alert.canonical_dir === canonicalDir);
  return { ok: true, alert_id: match?.alert_id ?? null, reason: match ? null : 'no alert recorded for this asset' };
}

/**
 * Evaluate the twelve eligibility guards (§3.1-§3.12).
 *
 * Every guard must be explicitly true. The result lists each guard so that `a1a explain` can be
 * precise, and `first_failure` names the earliest guard that is not satisfied.
 *
 * @returns {{ eligible: boolean, checks: object[], first_failure: string|null, reason_code: string, epoch_id: string|null, reason: string|null }}
 */
export function evaluateA1aEligibility({
  entry,
  cfg,
  task,
  now = Date.now(),
  deps = {},
} = {}) {
  const canonicalDir = entry?.canonical_dir ?? null;
  const casDir = entry?.cas_dir ?? null;
  const assetKey = canonicalDir && casDir ? a1aAssetKey({ canonicalDir, casDir }) : null;
  const checks = [];

  // 3.1 allowlist
  checks.push(check('3.1-allowlisted', Boolean(entry), entry ? 'asset matches the allowlist' : 'asset is not in the allowlist'));

  // 3.2 boundary state
  const boundaryState = task?.trusted_import?.boundary_state ?? null;
  checks.push(check('3.2-boundary-state',
    boundaryState === A1A_ELIGIBLE_BOUNDARY_STATE,
    `boundary_state=${boundaryState ?? 'unknown'}`));

  // 3.3 task terminal, checked on the TASK state, never the process
  const taskState = task?.state ?? null;
  checks.push(check('3.3-task-terminal',
    A1A_TERMINAL_TASK_STATES.includes(taskState),
    `task.state=${taskState ?? 'unknown'} (eligible: ${A1A_TERMINAL_TASK_STATES.join('/')})`));

  // 3.4 termination evidence. Collecting "all present entries confirmed" is not enough: a role
  // that provably RAN but left no evidence is a missing entry, and a missing entry is a refusal.
  const evidence = writerTerminationEvidence(task);
  const authorRan = task?.trusted_import?.author_completed === true;
  const authorEvidencePresent = Boolean(task?.trusted_import?.author_termination_evidence);
  const missingExpected = authorRan && !authorEvidencePresent;
  const allConfirmed = evidence.length > 0 && evidence.every(terminationEvidenceConfirmed);
  checks.push(check('3.4-writer-termination',
    allConfirmed && !missingExpected,
    missingExpected
      ? 'the author ran but no author termination evidence was recorded'
      : (evidence.length === 0 ? 'no writer-termination evidence recorded' : `${evidence.length} evidence record(s), all confirmed=${allConfirmed}`)));

  // 3.5 writer scopes confirmably empty
  const decideScopes = deps.decideScopes ?? (() => decideWriterScopesEmpty({ quiesceConfirmed: true }));
  let scopeResult;
  try {
    scopeResult = decideScopes();
  } catch (err) {
    scopeResult = { decision: 'RETAIN', status: 'unknown', anomalies: [], reason: err.message };
  }
  checks.push(check('3.5-scopes-empty',
    scopeResult?.decision === 'UNLOCK' && scopeResult?.status === 'empty' && (scopeResult?.anomalies ?? []).length === 0,
    `scope decision=${scopeResult?.decision ?? 'unknown'} status=${scopeResult?.status ?? 'unknown'} anomalies=${(scopeResult?.anomalies ?? []).length}`));

  // 3.6 snapshots present and parseable (used for the exact restore)
  const loadSnapshot = deps.loadSnapshot ?? loadPathSnapshot;
  const canonicalSnap = canonicalDir ? loadSnapshot(canonicalDir) : null;
  const casSnap = casDir ? loadSnapshot(casDir) : null;
  checks.push(check('3.6-snapshots-valid',
    Boolean(canonicalSnap) && Boolean(casSnap),
    `canonical snapshot=${canonicalSnap ? 'ok' : 'missing'}, cas snapshot=${casSnap ? 'ok' : 'missing'}`));

  // 3.7 protection matches the EXPECTED metadata of the epoch (not the pre-protection snapshot)
  const verifyProtection = deps.verifyProtection ?? ((dir) => verifyProtectionFor({ canonicalDir: dir }));
  let protection;
  try {
    protection = verifyProtection(canonicalDir);
  } catch (err) {
    protection = { ok: false, reason: err.message, epoch: null };
  }
  checks.push(check('3.7-protection-expectation',
    protection?.ok === true,
    protection?.ok === true ? `${protection.checked} entries match ${JSON.stringify(protection.expected ?? expectedProtectionMetadata())}` : (protection?.reason ?? 'protection could not be verified')));

  // 3.8 the recovery audit is writable (probe and remove)
  const writable = (deps.checkAuditWritable ?? defaultAuditWritable)(cfg);
  checks.push(check('3.8-audit-writable', writable.ok === true, writable.reason ?? 'audit directory is writable'));

  // 3.9 same-epoch budget not exhausted
  const stateRead = deps.readState ?? (() => readA1aState(cfg));
  const stateRes = stateRead();
  let budgetOk = 'unknown';
  let budgetDetail = 'state could not be read';
  let epochId = protection?.epoch?.epoch_id ?? null;
  if (stateRes.ok && assetKey) {
    const record = stateRes.state.assets[assetKey];
    const sameEpoch = record && record.epoch_id === epochId;
    const attempts = sameEpoch ? (record.attempts ?? 0) : 0;
    budgetOk = attempts < cfg.max_attempts;
    budgetDetail = `attempts=${attempts}/${cfg.max_attempts} for epoch ${epochId ?? 'unknown'}`;
  } else if (!stateRes.ok) {
    budgetOk = false;
    budgetDetail = `state unreadable (${stateRes.reason}) - refusing rather than treating it as an empty queue`;
  }
  checks.push(check('3.9-budget', budgetOk, budgetDetail));

  // 3.10 no unfinished prior recovery needs a human
  const classify = deps.classifyRecovery ?? ((key) => classifyUnfinishedRecovery({ auditDir: cfg.audit_root, assetKey: key }));
  let classification;
  try {
    classification = assetKey ? classify(assetKey) : { state: 'unverifiable', reason: 'no asset key' };
  } catch (err) {
    classification = { state: 'unverifiable', reason: err.message };
  }
  checks.push(check('3.10-no-unfinished-recovery',
    classification.state === 'clean',
    `prior recovery: ${classification.state}${classification.reason ? ` (${classification.reason})` : ''}`));

  // 3.11 asset lock obtainable / no overlap conflict (read-only view here)
  const lockStatus = deps.lockStatus ?? (() => assetLockStatus({ canonicalDir, casDir }));
  let locks;
  try {
    locks = lockStatus();
  } catch (err) {
    locks = [{ state: 'unverifiable', reason: err.message, path: canonicalDir }];
  }
  const conflicts = locks.filter((l) => l.state === 'live' || l.state === 'unverifiable');
  checks.push(check('3.11-asset-lock',
    conflicts.length === 0,
    conflicts.length === 0 ? `${locks.length} lock slot(s), none held by another owner` : `${conflicts.length} lock slot(s) held/unverifiable (${conflicts.map((c) => `${c.path}:${c.state}`).join(', ')})`));

  // 3.12 notifications never participate
  checks.push(check('3.12-notification-independent', true, 'notification availability does not gate recovery'));

  const firstFailure = checks.find((c) => c.ok !== true) ?? null;
  const eligible = firstFailure === null;
  const reasonCode = eligible
    ? 'eligible'
    : (firstFailure.id === '3.1-allowlisted' ? 'SKIPPED_NOT_ALLOWLISTED' : `a1a_ineligible(${firstFailure.id})`);
  return {
    eligible,
    checks,
    first_failure: firstFailure ? firstFailure.id : null,
    reason_code: reasonCode,
    epoch_id: epochId,
    reason: firstFailure ? firstFailure.detail : null,
    classification,
    scope: scopeResult ?? null,
  };
}

function defaultAuditWritable(cfg) {
  const dir = a1aAuditDir(cfg);
  const probe = join(dir, `.a1a-write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(probe, 'probe');
    rmSync(probe, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `recovery audit directory is not writable: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Explain (read-only)
// ---------------------------------------------------------------------------

/** Full, read-only explanation for one asset: allowlist match, task, guards, budget, classification. */
export function explainA1aAsset({ cfg, canonicalDir, casDir, taskId = null, deps = {} }) {
  const allowlist = deps.allowlist ?? loadA1aAllowlist(cfg);
  if (!allowlist.ok) {
    return { ok: false, reason: allowlist.reason, allowlist, entry: null, evaluation: null, task: null };
  }
  const entry = matchAllowlistAsset(allowlist.assets, { canonicalDir, casDir, taskId });
  const taskRead = deps.findTask
    ? deps.findTask()
    : findTaskForAsset({
      tasksDir: cfg.tasks_dir,
      canonicalDir,
      casDir,
      taskId: entry?.task_id ?? taskId,
      alertId: currentAlertIdFor({ alertsFile: cfg.alerts_file, canonicalDir }).alert_id,
    });
  if (!taskRead.ok) {
    return { ok: false, reason: taskRead.reason, allowlist, entry, evaluation: null, task: null };
  }
  const evaluation = evaluateA1aEligibility({ entry, cfg, task: taskRead.task, deps });
  return { ok: true, allowlist, entry, task: taskRead.task ?? null, evaluation };
}

// ---------------------------------------------------------------------------
// Sweep (§1.2 state machine; off / dry-run / live)
// ---------------------------------------------------------------------------

/** The task-state persist hook A1a passes into the recovery transaction (§7.5.1). */
function makePersistTask({ cfg, taskId, epochId, recoveryId }) {
  return () => {
    const read = readTask(cfg.tasks_dir, taskId);
    if (!read.ok || read.missing) throw new Error(`task ${taskId} could not be read back`);
    const task = read.task;
    task.trusted_import = {
      ...(task.trusted_import ?? {}),
      boundary_state: 'DISENGAGED',
      boundary_retained_reason: null,
      auto_recovery: { ...(task.trusted_import?.auto_recovery ?? {}), recovery_id: recoveryId, epoch_id: epochId, recovered_at: new Date().toISOString(), by: 'a1a' },
    };
    saveTaskWithVersion(cfg.tasks_dir, task);
    const reread = readTask(cfg.tasks_dir, taskId);
    if (!reread.ok || reread.missing || reread.task?.trusted_import?.boundary_state !== 'DISENGAGED') {
      return false;
    }
    return true;
  };
}

/**
 * Run one scheduler sweep.
 *
 * `off` performs no asset reads and takes no locks. `dry-run` performs the full evaluation, takes
 * the asset lock, re-verifies, records `a1a_would_recover`, and changes NOTHING (no permission, no
 * task, no alert, no state). `live` performs the real recovery transaction.
 */
export function runA1aSweep({ cfg, now = Date.now(), deps = {} } = {}) {
  if (cfg.mode === 'off') {
    // off means off: no allowlist read, no task read, no lock, no audit.
    return { mode: 'off', results: [], note: 'mode is off: no asset is read, locked or attempted' };
  }

  const allowlist = deps.allowlist ?? loadA1aAllowlist(cfg);
  if (!allowlist.ok) {
    appendA1aEvent(cfg, 'a1a_status', { reason: `allowlist-unverifiable: ${allowlist.reason}` });
    return { mode: cfg.mode, results: [], allowlist, note: `allowlist unverifiable: ${allowlist.reason}` };
  }
  if (allowlist.assets.length === 0) {
    return { mode: cfg.mode, results: [], allowlist, note: allowlist.reason ?? 'no allowlisted assets' };
  }

  const results = [];
  for (const entry of allowlist.assets) {
    results.push(sweepOneAsset({ cfg, entry, now, deps }));
  }
  return { mode: cfg.mode, results, allowlist };
}

function sweepOneAsset({ cfg, entry, now, deps }) {
  const { canonical_dir: canonicalDir, cas_dir: casDir } = entry;
  const assetKey = a1aAssetKey({ canonicalDir, casDir });

  const alertForAsset = currentAlertIdFor({ alertsFile: cfg.alerts_file, canonicalDir });
  const taskRead = deps.findTask
    ? deps.findTask(entry)
    : findTaskForAsset({ tasksDir: cfg.tasks_dir, canonicalDir, casDir, taskId: entry.task_id, alertId: alertForAsset.alert_id });
  if (!taskRead.ok) {
    appendA1aEvent(cfg, 'a1a_skip', { canonical_dir: canonicalDir, cas_dir: casDir, reason: `task-unverifiable: ${taskRead.reason}` });
    return { asset: assetKey, canonical_dir: canonicalDir, decision: 'SKIPPED_TASK_UNVERIFIABLE', reason: taskRead.reason };
  }

  const evaluation = evaluateA1aEligibility({ entry, cfg, task: taskRead.task, now, deps });

  if (!evaluation.eligible) {
    const deferred = evaluation.first_failure === '3.11-asset-lock' && /live|unverifiable/.test(evaluation.reason ?? '');
    appendA1aEvent(cfg, deferred ? 'a1a_lock_deferred' : 'a1a_ineligible', {
      canonical_dir: canonicalDir,
      cas_dir: casDir,
      epoch_id: evaluation.epoch_id,
      reason: evaluation.reason_code,
      detail: evaluation.reason,
    });
    return {
      asset: assetKey,
      canonical_dir: canonicalDir,
      cas_dir: casDir,
      decision: deferred ? 'DEFERRED_LOCK_HELD' : 'REFUSED_INELIGIBLE',
      reason_code: evaluation.reason_code,
      reason: evaluation.reason,
      checks: evaluation.checks,
    };
  }

  // From here the asset is eligible. Dry-run stops before any mutation.
  if (cfg.mode === 'dry-run') {
    appendA1aEvent(cfg, 'a1a_would_recover', {
      canonical_dir: canonicalDir,
      cas_dir: casDir,
      epoch_id: evaluation.epoch_id,
      detail: 'all eligibility guards are satisfied; a live run would release this boundary',
    });
    return {
      asset: assetKey,
      canonical_dir: canonicalDir,
      cas_dir: casDir,
      decision: 'WOULD_RECOVER',
      epoch_id: evaluation.epoch_id,
      checks: evaluation.checks,
    };
  }

  // live: perform the real recovery transaction with the task-persist hook.
  // `deps.recover` is the same injection seam the rest of this module uses (deps.decideScopes,
  // deps.findTask, ...): production always gets the real transaction, while tests can drive every
  // outcome without touching real permissions.
  const recover = deps.recover ?? recoverRetainedBoundary;
  const recovery = recover({
    canonicalDir,
    casDir,
    justification: `A1a automatic boundary recovery (epoch ${evaluation.epoch_id ?? 'unknown'})`,
    recoveredBy: 'a1a',
    persistTask: makePersistTask({
      cfg,
      taskId: taskRead.task?.task_id ?? entry.task_id,
      epochId: evaluation.epoch_id,
      recoveryId: null,
    }),
  });

  const stateRead = deps.readState ? deps.readState() : readA1aState(cfg);
  let stateMutated = false;
  if (stateRead.ok) {
    const state = stateRead.state;
    const record = assetStateFor(state, assetKey, evaluation.epoch_id);
    let next;
    if (recovery.outcome === 'DISENGAGED' && recovery.delivered === true) {
      next = { ...record, phase: 'COMPLETE', needs_human: false, last_reason: null, next_attempt_at: null };
    } else if (recovery.outcome === 'RECONCILE_REQUIRED' || recovery.outcome === 'RECONCILE_RECORD' || recovery.outcome === 'RESTORE_INCOMPLETE') {
      next = { ...record, phase: 'NEEDS_HUMAN', needs_human: true, last_reason: recovery.outcome, next_attempt_at: null };
    } else {
      next = recordA1aAttempt(record, cfg, now);
      next.last_reason = recovery.outcome;
    }
    if (next.phase === 'EXHAUSTED') {
      // The plan's decision: a dedicated exhaustion event that REFERENCES the original alert and
      // never fakes an occurrence count. An alert that cannot be resolved is stated explicitly.
      appendA1aEvent(cfg, 'a1a_recovery_exhausted', {
        canonical_dir: canonicalDir,
        cas_dir: casDir,
        task_id: taskRead.task?.task_id ?? entry.task_id ?? null,
        alert_id: alertForAsset.alert_id,
        alert_resolution: alertForAsset.ok
          ? (alertForAsset.alert_id ? 'linked' : alertForAsset.reason)
          : `alert log unverifiable: ${alertForAsset.reason}`,
        epoch_id: evaluation.epoch_id,
        attempts: next.attempts,
        max_attempts: cfg.max_attempts,
      });
    }
    state.assets[assetKey] = next;
    if (deps.writeState) deps.writeState(state); else writeA1aState(cfg, state);
    stateMutated = true;
  }

  appendA1aEvent(cfg, 'a1a_result', {
    canonical_dir: canonicalDir,
    cas_dir: casDir,
    epoch_id: evaluation.epoch_id,
    outcome: recovery.outcome,
    delivered: recovery.delivered === true,
    alert_closed: recovery.alert_closed ?? null,
  });

  return {
    asset: assetKey,
    canonical_dir: canonicalDir,
    cas_dir: casDir,
    decision: 'ATTEMPTED',
    epoch_id: evaluation.epoch_id,
    outcome: recovery.outcome,
    delivered: recovery.delivered === true,
    state_mutated: stateMutated,
    checks: evaluation.checks,
  };
}

// ---------------------------------------------------------------------------
// Status (§5)
// ---------------------------------------------------------------------------

/** A read-only status view: mode, allowlist, and each asset's epoch/phase/attempts/backoff. */
export function a1aStatus(cfg, { deps = {} } = {}) {
  const allowlist = deps.allowlist ?? loadA1aAllowlist(cfg);
  const stateRead = deps.readState ? deps.readState() : readA1aState(cfg);
  const assets = [];
  if (allowlist.ok) {
    for (const entry of allowlist.assets) {
      const key = a1aAssetKey({ canonicalDir: entry.canonical_dir, casDir: entry.cas_dir });
      const record = stateRead.ok ? stateRead.state.assets[key] : null;
      assets.push({
        canonical_dir: entry.canonical_dir,
        cas_dir: entry.cas_dir,
        task_id: entry.task_id,
        epoch_id: record?.epoch_id ?? null,
        phase: record?.phase ?? 'IDLE',
        attempts: record?.attempts ?? 0,
        max_attempts: entry.max_attempts ?? cfg.max_attempts,
        next_attempt_at: record?.next_attempt_at ?? null,
        last_reason: record?.last_reason ?? null,
        needs_human: record?.needs_human === true,
        exhausted: record?.phase === 'EXHAUSTED',
      });
    }
  }
  return {
    mode: cfg.mode,
    configured_mode: cfg.configured_mode,
    mode_valid: cfg.mode_valid,
    allowlist: { ok: allowlist.ok, configured: allowlist.configured, count: allowlist.ok ? allowlist.assets.length : 0, reason: allowlist.reason },
    state: { ok: stateRead.ok, file: stateRead.file, reason: stateRead.reason ?? null },
    assets,
    needs_human: assets.filter((a) => a.needs_human).length,
    exhausted: assets.filter((a) => a.exhausted).length,
  };
}

export function formatA1aStatus(status) {
  const lines = [];
  lines.push(`a1a mode: ${status.mode}${status.mode_valid ? '' : ` (requested ${status.configured_mode}; unknown modes are treated as off)`}`);
  lines.push(`allowlist: ${status.allowlist.ok ? `${status.allowlist.count} asset(s)` : `UNVERIFIABLE - ${status.allowlist.reason}`}`);
  lines.push(`state file: ${status.state.file}${status.state.ok ? '' : ` UNVERIFIABLE - ${status.state.reason}`}`);
  if (status.assets.length === 0) lines.push('  (no allowlisted assets)');
  for (const a of status.assets) {
    const flags = [a.needs_human ? 'NEEDS_HUMAN' : null, a.exhausted ? 'EXHAUSTED' : null].filter(Boolean).join(',');
    lines.push(`  ${a.canonical_dir} cas=${a.cas_dir} epoch=${a.epoch_id ?? 'n/a'} phase=${a.phase} attempts=${a.attempts}/${a.max_attempts} next=${a.next_attempt_at ?? 'n/a'}${flags ? ` [${flags}]` : ''}${a.last_reason ? ` last=${a.last_reason}` : ''}`);
  }
  return lines.join('\n');
}

export function formatA1aExplanation(explanation) {
  const lines = [];
  if (!explanation.ok) {
    lines.push(`a1a explain: UNVERIFIABLE - ${explanation.reason}`);
    return lines.join('\n');
  }
  lines.push(`allowlist match: ${explanation.entry ? 'yes' : 'no'}`);
  lines.push(`task: ${explanation.task ? `${explanation.task.task_id} state=${explanation.task.state ?? 'n/a'} boundary=${explanation.task.trusted_import?.boundary_state ?? 'n/a'}` : 'not found'}`);
  lines.push(`epoch: ${explanation.evaluation.epoch_id ?? 'n/a'}`);
  lines.push(`eligible: ${explanation.evaluation.eligible}${explanation.evaluation.eligible ? '' : ` (${explanation.evaluation.reason_code})`}`);
  for (const c of explanation.evaluation.checks) {
    const mark = c.ok === true ? 'ok' : (c.ok === 'unknown' ? 'UNKNOWN' : 'NO');
    lines.push(`  [${mark}] ${c.id}: ${c.detail}`);
  }
  return lines.join('\n');
}
