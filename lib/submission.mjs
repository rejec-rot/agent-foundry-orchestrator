// submission.mjs - controlled task submission, FIRST SLICE (stage 2).
//
// What this module does: validate a structured submission, run read-only preflight checks, produce
// a plan preview, and record the submission idempotently.
//
// What it deliberately does NOT do: execute anything. It never calls `orchestrator.submitTask`,
// never binds an executor or a role, never infers limits and never starts a run. Recording a
// submission is not starting it. That separation is the whole point of this slice: it gives the
// operator a preview and a durable, de-duplicated record, while the start action remains a separate
// explicitly authorised step.
//
// Architecture constraints honoured here (from the existing gateway contract and capsule shape):
//   * the entry layer may only forward the canonical capsule fields
//     (goal / context / source_agent / target_path / acceptance);
//   * authority-bearing input is rejected loudly, not stripped quietly: forgeable governance fields
//     and anything that would let a submitter choose the executor, role, model or resource limits
//     (ROLE != PLATFORM - the platform binds those);
//   * the acceptance command is a trust anchor: it must be on the acceptance allowlist.

import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { canUseRestrictedSandbox } from './host-boundary.mjs';
import { loadExecutorStatus } from './executor-status.mjs';

export const SUBMISSION_SCHEMA = 'af-submission-v1';

/** The only capsule fields the entry layer may forward (mirrors the gateway contract). */
export const CANONICAL_CAPSULE_FIELDS = Object.freeze(['goal', 'context', 'source_agent', 'target_path', 'acceptance']);

/** Forgeable governance fields: present anywhere in a submission, the whole submission is refused. */
export const FORBIDDEN_GOVERNANCE_FIELDS = Object.freeze([
  'publish',
  'published',
  'published_path',
  'policy_decision',
  'human_gate_status',
  'human_required',
  'governance_bypass',
  'governance_source',
  'candidate_id',
  'agent_instance_id',
  'formal_review_decision',
]);

/**
 * Fields a submitter must not choose: the platform binds executors, roles, models and limits.
 * These are refused rather than stripped, because silently dropping them would let an operator
 * believe a constraint was honoured when it never was.
 */
export const PLATFORM_BOUND_FIELDS = Object.freeze([
  'author_executor',
  'reviewer_executor',
  'executor',
  'executor_type',
  'role',
  'model',
  'effort',
  'resource_limits',
  'timeout_ms',
  'reviewer_timeout_ms',
  'max_concurrent',
  'boundary_state',
  'host_isolation',
  'task_id',
]);

/** Fixed pipeline a submission enters once it is started (platform-derived; a gate may stop it). */
export const SUBMISSION_PIPELINE = Object.freeze([
  'intake', 'governance-gate', 'plan', 'author', 'reviewer', 'fix-loop', 'acceptance', 'trusted-import', 'promotion-decision',
]);

// ---------------------------------------------------------------- paths & containers

/** Default submission record directory; override with AF_SUBMISSION_DIR. */
export function submissionDir(env = process.env, cwd = process.cwd()) {
  return env.AF_SUBMISSION_DIR || join(env.AF_RUNTIME_DIR || join(cwd, 'runtime'), 'submissions');
}

/** Best-effort realpath; a path that does not exist yet is canonicalised textually. */
function canonical(target) {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

/** Bounded synchronous pause for a just-published file, instead of a bare spin. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Path-aware containment: `target` is the root or lives under it.
 * A bare string prefix is NOT enough (`/data/repo-evil` must not pass for root `/data/repo`).
 */
export function pathWithinRoot(target, root) {
  if (typeof target !== 'string' || target.length === 0) return { ok: false, reason: 'path is required' };
  if (target.includes('\0')) return { ok: false, reason: 'path contains a NUL byte' };
  if (!isAbsolute(target)) return { ok: false, reason: `path must be absolute: ${target}` };
  const canonicalRoot = canonical(root);
  const canonicalTarget = canonical(target);
  const rel = relative(canonicalRoot, canonicalTarget);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!inside) return { ok: false, reason: `${canonicalTarget} is outside the allowed root ${canonicalRoot}` };
  return { ok: true, path: canonicalTarget, root: canonicalRoot };
}

/** First matching allowed root, or a refusal that names every root that was tried. */
export function withinAllowedRoots(target, roots = []) {
  if (!Array.isArray(roots) || roots.length === 0) return { ok: false, reason: 'no allowed root is configured' };
  const tried = [];
  for (const root of roots) {
    const result = pathWithinRoot(target, root);
    if (result.ok) return result;
    tried.push(result.reason);
  }
  return { ok: false, reason: tried.join('; ') };
}

// ---------------------------------------------------------------- acceptance allowlist

/** Trusted acceptance commands: `config/acceptance-allowlist.json` or AF_ACCEPTANCE_ALLOWLIST. */
export function acceptanceAllowlistFile(env = process.env, cwd = process.cwd()) {
  return env.AF_ACCEPTANCE_ALLOWLIST || join(cwd, 'config', 'acceptance-allowlist.json');
}

/** Strict read: a corrupt allowlist is a refusal, never "no commands allowed" and never "any". */
export function loadAcceptanceAllowlist({ file = acceptanceAllowlistFile() } = {}) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: false, configured: false, allowed: [], reason: `acceptance allowlist not found at ${file}` };
    return { ok: false, configured: true, allowed: [], reason: `acceptance allowlist unreadable: ${err.message}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.allowed)) return { ok: false, configured: true, allowed: [], reason: 'acceptance allowlist has no "allowed" array' };
    const allowed = parsed.allowed
      .filter((entry) => entry && typeof entry.command === 'string' && entry.command.length > 0)
      .map((entry) => ({ command: entry.command, args_prefix: Array.isArray(entry.args_prefix) ? entry.args_prefix.map(String) : [] }));
    return { ok: true, configured: true, allowed, reason: null, file };
  } catch (err) {
    return { ok: false, configured: true, allowed: [], reason: `acceptance allowlist is not valid JSON: ${err.message}` };
  }
}

/** An acceptance command matches when the command equals an entry and its args start with the prefix. */
export function acceptanceCommandAllowed(acceptance, allowlist) {
  if (!acceptance || typeof acceptance.command !== 'string' || acceptance.command.length === 0) {
    return { ok: false, reason: 'acceptance.command is required' };
  }
  const args = Array.isArray(acceptance.args) ? acceptance.args.map(String) : [];
  if (acceptance.args !== undefined && !Array.isArray(acceptance.args)) return { ok: false, reason: 'acceptance.args must be an array' };
  const entry = (allowlist?.allowed ?? []).find((candidate) => candidate.command === acceptance.command
    && candidate.args_prefix.every((value, index) => args[index] === value));
  if (!entry) return { ok: false, reason: `acceptance command is not on the allowlist: ${acceptance.command} ${args.join(' ')}`.trim() };
  return { ok: true, entry };
}

// ---------------------------------------------------------------- spec normalisation

function walkKeys(value, path = '', onKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    onKey(key, here);
    walkKeys(child, here, onKey);
  }
}

/**
 * Normalise a structured submission into the canonical capsule.
 *
 * @returns {{ ok: boolean, capsule: object|null, stripped: string[], violations: string[], reason: string|null }}
 */
export function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, capsule: null, stripped: [], violations: [], reason: 'a submission must be an object' };
  }
  const violations = [];
  walkKeys(spec, '', (key, here) => {
    if (FORBIDDEN_GOVERNANCE_FIELDS.includes(key)) violations.push({ kind: 'forbidden-governance-field', field: here });
    else if (PLATFORM_BOUND_FIELDS.includes(key)) violations.push({ kind: 'platform-bound-field', field: here });
  });
  if (violations.length > 0) {
    const first = violations[0];
    return {
      ok: false,
      capsule: null,
      stripped: [],
      violations,
      reason: first.kind === 'forbidden-governance-field'
        ? `GOVERNANCE_FIELD_REJECTED: ${first.field} is forgeable and must never be submitted`
        : `PLATFORM_BOUND_FIELD_REJECTED: ${first.field} is bound by the platform, not by the submitter`,
    };
  }
  if (typeof spec.goal !== 'string' || spec.goal.trim().length === 0) {
    return { ok: false, capsule: null, stripped: [], violations, reason: 'goal is required' };
  }
  if (typeof spec.target_path !== 'string' || spec.target_path.length === 0) {
    return { ok: false, capsule: null, stripped: [], violations, reason: 'target_path is required' };
  }
  if (!spec.acceptance || typeof spec.acceptance !== 'object') {
    return { ok: false, capsule: null, stripped: [], violations, reason: 'acceptance is required' };
  }

  const stripped = Object.keys(spec).filter((key) => !CANONICAL_CAPSULE_FIELDS.includes(key));
  const capsule = {};
  for (const field of CANONICAL_CAPSULE_FIELDS) {
    if (spec[field] !== undefined) capsule[field] = spec[field];
  }
  return { ok: true, capsule, stripped, violations, reason: null };
}

/** Deterministic JSON: object keys sorted at every depth, so key order cannot change identity. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Stable digest of a capsule, so idempotency can tell "same submission" from "same key, new spec". */
export function capsuleDigest(capsule) {
  return createHash('sha256').update(stableStringify(capsule)).digest('hex');
}

// ---------------------------------------------------------------- preflight (read-only)

function check(id, ok, detail) {
  return { id, ok: ok === true, detail };
}

/**
 * Read-only preflight for one submission. Every check must be explicitly true; nothing is written.
 *
 * @param {object} params
 * @param {object} params.spec
 * @param {string[]} params.allowedRoots
 * @param {object} [params.env]
 * @param {object} [params.deps] - injection seams: allowlist, sandboxAvailable, executorStatus, storeWritable
 */
export function preflightSubmission({ spec, allowedRoots = [], env = process.env, cwd = process.cwd(), deps = {} } = {}) {
  const checks = [];
  const normalized = normalizeSpec(spec);
  checks.push(check('spec-capsule', normalized.ok, normalized.reason ?? 'the submission maps to the canonical capsule'));
  if (!normalized.ok) return { ok: false, checks, first_failure: checks[0].id, reason: normalized.reason, normalized };

  const capsule = normalized.capsule;
  checks.push(check('target-path-within-allowed-root', withinAllowedRoots(capsule.target_path, allowedRoots).ok,
    withinAllowedRoots(capsule.target_path, allowedRoots).reason ?? capsule.target_path));
  const targetExists = (() => { try { return statSync(capsule.target_path).isDirectory(); } catch { return false; } })();
  checks.push(check('target-path-is-a-directory', targetExists, targetExists ? capsule.target_path : `${capsule.target_path} is not a readable directory`));

  const allowlist = deps.allowlist ?? loadAcceptanceAllowlist({ file: acceptanceAllowlistFile(env, cwd) });
  const acceptance = allowlist.ok ? acceptanceCommandAllowed(capsule.acceptance, allowlist) : { ok: false, reason: allowlist.reason };
  checks.push(check('acceptance-command-allowlisted', acceptance.ok === true, acceptance.reason ?? `${capsule.acceptance.command} is allowlisted`));

  // NOTE: the injected dependency must be CALLED - `deps.x ?? default()` would return the injected
  // function itself, not its result (operator precedence), and every downstream check would fail.
  const sandboxFn = deps.sandboxAvailable ?? (() => { try { return canUseRestrictedSandboxDefault(); } catch { return false; } });
  const sandbox = sandboxFn();
  checks.push(check('isolation-capability', sandbox === true, sandbox ? 'a restricted sandbox is available' : 'no restricted sandbox capability detected'));

  const statusFn = deps.executorStatus ?? loadExecutorStatusDefault;
  const status = statusFn();
  const usable = (status?.executors ?? status?.entries ?? []).filter?.((entry) => entry && entry.available !== false) ?? [];
  checks.push(check('executor-availability', Array.isArray(status?.executors ?? status?.entries) ? usable.length > 0 : false,
    Array.isArray(status?.executors ?? status?.entries) ? `${usable.length} executor(s) reported available (the platform binds which one runs)` : 'executor status could not be read'));

  const idempotencyKey = spec?.idempotency_key ?? null;
  checks.push(check('idempotency-key-present', typeof idempotencyKey === 'string' && idempotencyKey.trim().length > 0,
    idempotencyKey ? 'an idempotency key is present' : 'an idempotency key is required so a retry cannot create a duplicate task'));

  const storeCheck = deps.storeWritable ?? (() => ({ ok: true }));
  const store = storeCheck({ dir: submissionDir(env, cwd) });
  checks.push(check('submission-store-writable', store.ok === true, store.reason ?? 'the submission record directory is writable'));

  const firstFailure = checks.find((entry) => entry.ok !== true) ?? null;
  return {
    ok: firstFailure === null,
    checks,
    first_failure: firstFailure ? firstFailure.id : null,
    reason: firstFailure ? firstFailure.detail : null,
    normalized,
    stripped: normalized.stripped,
  };
}

/* Defaults behind tiny wrappers so tests can inject without patching imports. */
function canUseRestrictedSandboxDefault() {
  return canUseRestrictedSandbox();
}
function loadExecutorStatusDefault() {
  // `loadExecutorStatus()` returns a Map keyed by executor id, while the availability check reads
  // `status.executors` / `status.entries`. Returning the Map made the check report "executor status
  // could not be read" for EVERY default caller (the operator CLI), so the projection is explicit.
  const status = loadExecutorStatus();
  const entries = [...(status?.values?.() ?? [])];
  return {
    executors: entries.map((entry) => ({
      id: entry.executor_id,
      available: entry.availability_status === 'AVAILABLE',
      reason: entry.reason ?? null,
    })),
  };
}

// ---------------------------------------------------------------- plan preview

/**
 * A deterministic preview of what submitting would mean. It describes the fixed pipeline, names the
 * parts the platform binds, and states plainly that nothing has been started or executed.
 */
export function planPreview({ spec, allowedRoots = [], env = process.env, cwd = process.cwd(), deps = {} } = {}) {
  const preflight = preflightSubmission({ spec, allowedRoots, env, cwd, deps });
  if (!preflight.ok) return { ok: false, reason: preflight.reason, first_failure: preflight.first_failure, checks: preflight.checks, started: false };
  return {
    ok: true,
    started: false,
    capsule: preflight.normalized.capsule,
    stripped_fields: preflight.stripped,
    pipeline: [...SUBMISSION_PIPELINE],
    platform_bound: ['executor and role', 'model and effort', 'resource and time limits', 'task id', 'boundary and isolation policy'],
    note: 'nothing is scheduled or executed by this preview; starting the task is a separate, explicitly authorised step',
    checks: preflight.checks,
  };
}

// ---------------------------------------------------------------- idempotent record

function publishRecord(recordPath, record) {
  const tmp = `${recordPath}.${process.pid}-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)}.tmp`;
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, recordPath);
    return true;
  } catch (err) {
    if (err?.code === 'EEXIST') return false;
    throw err;
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function readRecord(recordPath) {
  try {
    return { ok: true, record: JSON.parse(readFileSync(recordPath, 'utf8')) };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, record: null };
    return { ok: false, reason: `submission record unreadable: ${err.message}` };
  }
}

/**
 * Record ONE submission for an idempotency key, without starting anything.
 *
 * The same key with the same capsule is a duplicate (returned, not created twice). The same key with
 * a DIFFERENT capsule is refused: an idempotency key must not silently turn into a different task.
 *
 * @returns {{ ok: boolean, duplicate?: boolean, record?: object, reason?: string, checks?: object[] }}
 */
export function recordSubmission({ spec, allowedRoots = [], env = process.env, cwd = process.cwd(), deps = {}, now = Date.now() } = {}) {
  const preflight = preflightSubmission({ spec, allowedRoots, env, cwd, deps });
  if (!preflight.ok) return { ok: false, reason: preflight.reason, checks: preflight.checks, first_failure: preflight.first_failure };

  const dir = submissionDir(env, cwd);
  const key = String(spec.idempotency_key).trim();
  const keyDigest = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const recordPath = join(dir, `${keyDigest}.json`);
  const digest = capsuleDigest(preflight.normalized.capsule);

  const candidate = {
    schema_version: SUBMISSION_SCHEMA,
    idempotency_key_digest: keyDigest,
    spec_digest: digest,
    capsule: preflight.normalized.capsule,
    stripped_fields: preflight.stripped,
    state: 'PREPARED',
    started: false,
    recorded_at: new Date(now).toISOString(),
  };

  if (publishRecord(recordPath, candidate)) {
    return { ok: true, duplicate: false, record: { ...candidate, record_file: recordPath } };
  }
  // Somebody already recorded this key: read it back (bounded retry for a just-published file).
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const read = readRecord(recordPath);
    if (!read.ok) return { ok: false, reason: read.reason };
    if (read.record) {
      if (read.record.spec_digest !== digest) {
        return {
          ok: false,
          reason: `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_SPEC: key ${keyDigest} already recorded a different submission; refusing to treat it as the same task`,
          existing: read.record.record_file ? read.record : { ...read.record, record_file: recordPath },
        };
      }
      return { ok: true, duplicate: true, record: { ...read.record, record_file: recordPath } };
    }
    // The other writer is between link() and visibility: pause briefly rather than guess.
    sleepSync(5);
  }
  return { ok: false, reason: 'submission record could not be read back after a concurrent write' };
}

/** Read-only listing of recorded submissions (strict about unreadable records). */
export function listSubmissions({ dir = submissionDir() } = {}) {
  if (!existsSync(dir)) return { ok: true, records: [] };
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return { ok: false, records: [], reason: `submission directory unreadable: ${err.message}` };
  }
  const records = [];
  for (const name of names.sort()) {
    const read = readRecord(join(dir, name));
    if (!read.ok) return { ok: false, records, reason: read.reason };
    if (read.record) records.push({ ...read.record, record_file: join(dir, name) });
  }
  return { ok: true, records };
}

/** Remove one record (an operator action; used by tests and by a deliberate retraction). */
export function forgetSubmission({ key, dir = submissionDir() }) {
  const keyDigest = createHash('sha256').update(String(key).trim()).digest('hex').slice(0, 16);
  try {
    rmSync(join(dir, `${keyDigest}.json`), { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
