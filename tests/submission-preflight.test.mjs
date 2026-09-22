// submission-preflight.test.mjs - stage 2 first slice: validation, preflight, preview, idempotency.
//
// This slice must never execute anything: the tests assert that a submission is only validated,
// previewed and recorded, that authority-bearing input is refused (not silently dropped), that the
// acceptance command must be allowlisted, and that an idempotency key cannot turn into a second
// different task.

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANONICAL_CAPSULE_FIELDS,
  FORBIDDEN_GOVERNANCE_FIELDS,
  PLATFORM_BOUND_FIELDS,
  acceptanceCommandAllowed,
  capsuleDigest,
  listSubmissions,
  loadAcceptanceAllowlist,
  normalizeSpec,
  pathWithinRoot,
  planPreview,
  preflightSubmission,
  recordSubmission,
  stableStringify,
  submissionDir,
} from '../lib/submission.mjs';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'af-sub-'));
  const repo = join(root, 'repo');
  const other = join(root, 'repo-evil');
  const submissions = join(root, 'submissions');
  mkdirSync(repo);
  mkdirSync(other);
  mkdirSync(submissions);
  return { root, repo, other, submissions, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const spec = (repo, extra = {}) => ({
  goal: 'make the gate pass',
  context: 'fixture',
  source_agent: 'operator',
  target_path: repo,
  acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
  idempotency_key: 'key-1',
  ...extra,
});

/** Permissive-but-honest deps: the platform side is stubbed, the submission side is not. */
const deps = (allowlist = { ok: true, configured: true, allowed: [{ command: 'node', args_prefix: ['--test'] }] }) => ({
  allowlist,
  sandboxAvailable: () => true,
  executorStatus: () => ({ executors: [{ executor: 'codex', available: true }] }),
  storeWritable: () => ({ ok: true }),
});

test('SUB-1: only the canonical capsule fields survive, and extra fields are reported as stripped', () => {
  const ws = workspace();
  try {
    const result = normalizeSpec(spec(ws.repo, { notes: 'ignore me', nested: { extra: 1 } }));
    assert.strictEqual(result.ok, true, result.reason ?? '');
    assert.deepStrictEqual(Object.keys(result.capsule).sort(), [...CANONICAL_CAPSULE_FIELDS].sort());
    assert.deepStrictEqual(result.stripped.sort(), ['idempotency_key', 'nested', 'notes']);
    // The idempotency key is a control field, not part of the capsule the platform receives.
    assert.strictEqual(result.capsule.idempotency_key, undefined);
  } finally { ws.cleanup(); }
});

test('SUB-2: forgeable governance fields are refused, and the offending path is named', () => {
  const ws = workspace();
  try {
    for (const field of FORBIDDEN_GOVERNANCE_FIELDS) {
      const result = normalizeSpec(spec(ws.repo, { [field]: true }));
      assert.strictEqual(result.ok, false, `${field} must be refused`);
      assert.match(result.reason, /GOVERNANCE_FIELD_REJECTED/);
      assert.strictEqual(result.violations[0].field, field);
    }
    // Nested occurrences are refused too, with the full path.
    const nested = normalizeSpec(spec(ws.repo, { meta: { deeper: { human_required: true } } }));
    assert.strictEqual(nested.ok, false);
    assert.strictEqual(nested.violations[0].field, 'meta.deeper.human_required');
  } finally { ws.cleanup(); }
});

test('SUB-3: platform-bound fields are refused loudly instead of being silently dropped', () => {
  const ws = workspace();
  try {
    for (const field of PLATFORM_BOUND_FIELDS) {
      const result = normalizeSpec(spec(ws.repo, { [field]: 'anything' }));
      assert.strictEqual(result.ok, false, `${field} must be refused`);
      assert.match(result.reason, /PLATFORM_BOUND_FIELD_REJECTED|GOVERNANCE_FIELD_REJECTED/);
    }
    // Choosing an executor is the canonical example: ROLE != PLATFORM.
    const executor = normalizeSpec(spec(ws.repo, { author_executor: 'codex' }));
    assert.match(executor.reason, /PLATFORM_BOUND_FIELD_REJECTED/);
  } finally { ws.cleanup(); }
});

test('SUB-4: required fields are enforced with specific messages', () => {
  const ws = workspace();
  try {
    assert.match(normalizeSpec(null).reason, /must be an object/);
    assert.match(normalizeSpec({ target_path: ws.repo, acceptance: { command: 'node' } }).reason, /goal is required/);
    assert.match(normalizeSpec({ goal: 'g', acceptance: { command: 'node' } }).reason, /target_path is required/);
    assert.match(normalizeSpec({ goal: 'g', target_path: ws.repo }).reason, /acceptance is required/);
  } finally { ws.cleanup(); }
});

test('SUB-5: target_path containment is path-aware (prefix trap and traversal refused)', () => {
  const ws = workspace();
  try {
    assert.strictEqual(pathWithinRoot(ws.repo, ws.repo).ok, true);
    assert.strictEqual(pathWithinRoot(join(ws.repo, 'sub'), ws.repo).ok, true);
    assert.strictEqual(pathWithinRoot(ws.other, ws.repo).ok, false, 'repo-evil must not pass for repo');
    assert.strictEqual(pathWithinRoot(join(ws.repo, '..', 'repo-evil'), ws.repo).ok, false);
    assert.strictEqual(pathWithinRoot('relative/path', ws.repo).ok, false, 'a relative path is refused');
    assert.strictEqual(pathWithinRoot(`${ws.repo}\0/x`, ws.repo).ok, false, 'NUL is refused');

    const outside = preflightSubmission({ spec: spec(ws.other), allowedRoots: [ws.repo], deps: deps() });
    assert.strictEqual(outside.ok, false);
    assert.strictEqual(outside.first_failure, 'target-path-within-allowed-root');
    // No allowed root at all is a refusal, never "anything goes".
    const noRoots = preflightSubmission({ spec: spec(ws.repo), allowedRoots: [], deps: deps() });
    assert.strictEqual(noRoots.ok, false);
    assert.match(noRoots.reason, /no allowed root/);
  } finally { ws.cleanup(); }
});

test('SUB-6: the acceptance command is a trust anchor and must be allowlisted', () => {
  const ws = workspace();
  try {
    const allowlist = { ok: true, configured: true, allowed: [{ command: 'node', args_prefix: ['--test'] }] };
    assert.strictEqual(acceptanceCommandAllowed({ command: 'node', args: ['--test', 'x'] }, allowlist).ok, true);
    assert.strictEqual(acceptanceCommandAllowed({ command: 'node', args: ['-e', 'evil()'] }, allowlist).ok, false);
    assert.strictEqual(acceptanceCommandAllowed({ command: 'rm', args: ['-rf', '/'] }, allowlist).ok, false);
    assert.strictEqual(acceptanceCommandAllowed({ command: 'node' }, allowlist).ok, false, 'the required prefix must be present');

    const refused = preflightSubmission({ spec: spec(ws.repo, { acceptance: { command: 'bash', args: ['-c', 'rm -rf /'] } }), allowedRoots: [ws.repo], deps: deps() });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.first_failure, 'acceptance-command-allowlisted');

    // A corrupt or missing allowlist refuses everything rather than allowing anything.
    const missing = loadAcceptanceAllowlist({ file: join(ws.root, 'nope.json') });
    assert.strictEqual(missing.ok, false);
    const corrupt = join(ws.root, 'bad.json');
    writeFileSync(corrupt, '{ not json');
    const bad = loadAcceptanceAllowlist({ file: corrupt });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.reason, /not valid JSON/);
  } finally { ws.cleanup(); }
});

test('SUB-7: preflight reports every check and fails on the first missing one', () => {
  const ws = workspace();
  try {
    const ok = preflightSubmission({ spec: spec(ws.repo), allowedRoots: [ws.repo], deps: deps() });
    assert.strictEqual(ok.ok, true, ok.reason ?? '');
    const ids = ok.checks.map((check) => check.id);
    for (const expected of ['spec-capsule', 'target-path-within-allowed-root', 'target-path-is-a-directory', 'acceptance-command-allowlisted', 'isolation-capability', 'executor-availability', 'idempotency-key-present', 'submission-store-writable']) {
      assert.ok(ids.includes(expected), `missing check ${expected}`);
    }
    // No usable executor at all is a refusal (the platform must have somebody to bind).
    const noExecutor = preflightSubmission({ spec: spec(ws.repo), allowedRoots: [ws.repo], deps: { ...deps(), executorStatus: () => ({ executors: [] }) } });
    assert.strictEqual(noExecutor.ok, false);
    assert.strictEqual(noExecutor.first_failure, 'executor-availability');
    // No sandbox capability is a refusal, never a silent downgrade to unsandboxed execution.
    const noSandbox = preflightSubmission({ spec: spec(ws.repo), allowedRoots: [ws.repo], deps: { ...deps(), sandboxAvailable: () => false } });
    assert.strictEqual(noSandbox.ok, false);
    assert.strictEqual(noSandbox.first_failure, 'isolation-capability');
    // A missing idempotency key is a refusal.
    const noKey = preflightSubmission({ spec: spec(ws.repo, { idempotency_key: undefined }), allowedRoots: [ws.repo], deps: deps() });
    assert.strictEqual(noKey.ok, false);
    assert.strictEqual(noKey.first_failure, 'idempotency-key-present');
  } finally { ws.cleanup(); }
});

test('SUB-8: the preview describes the pipeline and states that nothing was started', () => {
  const ws = workspace();
  try {
    const preview = planPreview({ spec: spec(ws.repo), allowedRoots: [ws.repo], deps: deps(), env: { AF_SUBMISSION_DIR: ws.submissions } });
    assert.strictEqual(preview.ok, true, preview.reason ?? '');
    assert.strictEqual(preview.started, false, 'a preview must never start anything');
    assert.match(preview.note, /nothing is scheduled or executed/);
    assert.ok(preview.pipeline.includes('governance-gate') && preview.pipeline.includes('acceptance'));
    assert.ok(preview.platform_bound.some((entry) => /executor and role/.test(entry)), 'the platform-bound parts must be named');
    assert.ok(Array.isArray(preview.checks) && preview.checks.length > 0);

    const refused = planPreview({ spec: spec(ws.other), allowedRoots: [ws.repo], deps: deps() });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.started, false);
  } finally { ws.cleanup(); }
});

test('SUB-9: recording is idempotent for the same key and capsule, and never starts a task', () => {
  const ws = workspace();
  try {
    const env = { AF_SUBMISSION_DIR: ws.submissions };
    const first = recordSubmission({ spec: spec(ws.repo), allowedRoots: [ws.repo], deps: deps(), env });
    assert.strictEqual(first.ok, true, first.reason ?? '');
    assert.strictEqual(first.duplicate, false);
    assert.strictEqual(first.record.started, false, 'recording must never start a task');
    assert.strictEqual(first.record.state, 'PREPARED');
    assert.strictEqual(existsSync(join(ws.submissions, `${first.record.idempotency_key_digest}.json`)), true);
    assert.deepStrictEqual(readdirSync(ws.submissions).filter((n) => n.endsWith('.tmp')), [], 'no temporary file is left behind');

    const again = recordSubmission({ spec: spec(ws.repo), allowedRoots: [ws.repo], deps: deps(), env });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.duplicate, true, 'the same key and capsule is a duplicate');
    assert.strictEqual(again.record.recorded_at, first.record.recorded_at, 'the original record is returned, not replaced');
    assert.strictEqual(readdirSync(ws.submissions).filter((n) => n.endsWith('.json')).length, 1, 'one record only');
  } finally { ws.cleanup(); }
});

test('SUB-10: the same key with a DIFFERENT capsule is refused, never silently merged', () => {
  const ws = workspace();
  try {
    const env = { AF_SUBMISSION_DIR: ws.submissions };
    const first = recordSubmission({ spec: spec(ws.repo, { goal: 'first goal' }), allowedRoots: [ws.repo], deps: deps(), env });
    assert.strictEqual(first.ok, true);
    const clash = recordSubmission({ spec: spec(ws.repo, { goal: 'a completely different goal' }), allowedRoots: [ws.repo], deps: deps(), env });
    assert.strictEqual(clash.ok, false);
    assert.match(clash.reason, /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_SPEC/);
    assert.strictEqual(clash.existing.spec_digest, first.record.spec_digest);
    // A reordering of the same capsule is still the same submission (stable digest).
    const reordered = recordSubmission({
      spec: { acceptance: { args: ['--test', 'tests/gate.test.mjs'], command: 'node' }, goal: 'first goal', target_path: ws.repo, source_agent: 'operator', context: 'fixture', idempotency_key: 'key-1' },
      allowedRoots: [ws.repo],
      deps: deps(),
      env,
    });
    assert.strictEqual(reordered.ok, true);
    assert.strictEqual(reordered.duplicate, true, 'key order must not change the identity of a submission');
  } finally { ws.cleanup(); }
});

test('SUB-11: a refused submission is never recorded', () => {
  const ws = workspace();
  try {
    const env = { AF_SUBMISSION_DIR: ws.submissions };
    const cases = [
      spec(ws.other),                                                    // outside the allowed root
      spec(ws.repo, { human_required: true }),                            // governance field
      spec(ws.repo, { author_executor: 'codex' }),                        // platform-bound field
      spec(ws.repo, { acceptance: { command: 'bash', args: ['-c', 'x'] } }), // not allowlisted
      spec(ws.repo, { idempotency_key: undefined }),                     // no idempotency key
    ];
    for (const candidate of cases) {
      const result = recordSubmission({ spec: candidate, allowedRoots: [ws.repo], deps: deps(), env });
      assert.strictEqual(result.ok, false, `${JSON.stringify(candidate).slice(0, 60)} must be refused`);
      assert.ok(result.first_failure, 'a refusal must name the failing check');
    }
    assert.deepStrictEqual(readdirSync(ws.submissions), [], 'nothing may be written for a refused submission');
  } finally { ws.cleanup(); }
});

test('SUB-12: a corrupt record is reported, not treated as "no submissions"', () => {
  const ws = workspace();
  try {
    const env = { AF_SUBMISSION_DIR: ws.submissions };
    const recorded = recordSubmission({ spec: spec(ws.repo), allowedRoots: [ws.repo], deps: deps(), env });
    const file = join(ws.submissions, `${recorded.record.idempotency_key_digest}.json`);
    writeFileSync(file, '{ torn record');
    const listed = listSubmissions({ dir: ws.submissions });
    assert.strictEqual(listed.ok, false, 'an unreadable record must not be silently skipped');
    assert.match(listed.reason, /unreadable/);

    const readme = submissionDir(env, ws.root);
    assert.strictEqual(readme, ws.submissions, 'AF_SUBMISSION_DIR is honoured');
  } finally { ws.cleanup(); }
});

test('SUB-13: this slice cannot execute anything (static and runtime)', () => {
  const raw = readFileSync(join(process.cwd(), 'lib', 'submission.mjs'), 'utf8');
  // Comments are allowed to NAME what this slice must not do; only real code counts.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['child_process', 'submitTask(', 'adapters.mjs', 'scheduler.mjs', 'runTrustedImportTask', 'spawn(', 'execSync', 'fork(']) {
    assert.strictEqual(source.includes(forbidden), false, `submission.mjs must not reference ${forbidden}`);
  }
  // The two allowed imports are read-only capability probes; assert they are the only heavy ones.
  const imports = [...source.matchAll(/^import .*from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepStrictEqual(imports.sort(), ['node:crypto', 'node:fs', 'node:path', './executor-status.mjs', './host-boundary.mjs'].sort());
  // Recording must not touch the process environment, start timers or write outside its directory.
  const ws = workspace();
  try {
    const env = { AF_SUBMISSION_DIR: ws.submissions };
    const before = process.env.AF_A1A_MODE;
    recordSubmission({ spec: spec(ws.repo), allowedRoots: [ws.repo], deps: deps(), env });
    assert.strictEqual(process.env.AF_A1A_MODE, before, 'recording must not mutate the environment');
    const entries = readdirSync(ws.submissions);
    assert.strictEqual(entries.every((name) => name.endsWith('.json')), true, 'only records may be written');
  } finally { ws.cleanup(); }
});

test('SUB-14: the stable digest and the gateway contract stay in agreement', () => {
  assert.strictEqual(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.strictEqual(capsuleDigest({ a: 1, b: { y: 2, x: 3 } }), capsuleDigest({ b: { x: 3, y: 2 }, a: 1 }));
  assert.notStrictEqual(capsuleDigest({ a: 1 }), capsuleDigest({ a: 2 }));

  // The forbidden-field list must cover the gateway fixture's list: drift here would let a
  // forgeable field through the local entry layer while the real gateway still rejects it.
  const fixture = readFileSync(join(process.cwd(), 'fixtures', 'gateway', 'tools', 'submit-task.mjs'), 'utf8');
  // Only the FORBIDDEN list body, not the capsule allowlist that follows it.
  const body = fixture.slice(fixture.indexOf('FORBIDDEN_GOVERNANCE_FIELDS'), fixture.indexOf('ALLOWED_CAPSULE_FIELDS'));
  const listed = [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).filter((name) => name !== 'FORBIDDEN_GOVERNANCE_FIELDS');
  const missing = listed.filter((field) => !FORBIDDEN_GOVERNANCE_FIELDS.includes(field));
  assert.deepStrictEqual(missing, [], `fields the gateway refuses but this module allows: ${missing.join(', ')}`);
});
