// tests/provider-error-taxonomy.test.mjs - account/billing refusals must never retry
//
// The classifier maps raw provider evidence onto safety and retry semantics, and
// the scheduler only reads `retryable`. Getting an ACCOUNT refusal wrong is the
// most dangerous direction of error: retrying an account that cannot serve
// requests burns budget and hides the problem, and it contradicts the documented
// "account refusal => fail-closed, never silently retried" guarantee.
//
// Three real gaps were measured against documented provider error shapes:
//
//   OpenAI    "account_deactivated"        -> was TRANSIENT_FAULT, retryable
//   OpenAI    "insufficient_quota"         -> was TRANSIENT_FAULT, retryable
//   Anthropic "credit balance is too low"  -> was TRANSIENT_FAULT, retryable
//
//   PE-1  account-state refusals are non-retryable and open the manual gate
//   PE-2  billing/quota refusals are non-retryable and say so
//   PE-3  the same holds when the evidence arrives on stdout (codex --json)
//   PE-4  no false positives: logs and bare numbers never trip the breaker
//   PE-5  genuinely transient failures stay retryable
//   PE-6  classification is executor-agnostic
//   PE-7  the safety action reaches the runtime guard (breaker opens, no retry)
//   PE-8  the table covers every documented provider family this repo drives

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyExecutionError } from '../lib/executor-error-classifier.mjs';
import { ExecutorRuntimeGuard } from '../lib/executor-runtime-guard.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTORS = ['claude', 'codex', 'cline', 'vertex-gemini', 'antigravity'];

/** Documented account-state refusals, one per provider wording. */
const ACCOUNT_STATE_SAMPLES = Object.freeze([
  ['OpenAI', '{"error":{"message":"Your account was deactivated.","code":"account_deactivated"}}'],
  ['OpenAI (organization)', '{"error":{"message":"Your organization has been deactivated"}}'],
  ['Anthropic', '{"type":"error","error":{"type":"permission_error","message":"Your account has been disabled"}}'],
  ['generic', 'ACCOUNT_SUSPENDED: this account is suspended'],
  ['generic', 'account banned by the provider'],
]);

/** Documented billing/quota refusals. */
const BILLING_SAMPLES = Object.freeze([
  ['OpenAI insufficient_quota', '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}'],
  ['Anthropic credit balance', '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'],
  ['generic billing', 'billing_not_active: please add a payment method'],
  ['generic payment', '402 Payment Required'],
]);

/** Failures that genuinely should be retried. */
const TRANSIENT_SAMPLES = Object.freeze([
  ['Anthropic overloaded', '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'],
  ['503', '503 Service Unavailable'],
  ['500', '500 Internal Server Error'],
  ['network', 'Error: socket hang up ECONNRESET'],
]);

function classify(executor, text, channel = 'stderr') {
  return channel === 'stdout'
    ? classifyExecutionError(executor, { exit_code: 1, stdout: text })
    : classifyExecutionError(executor, { exit_code: 1, stderr: text });
}

// ------------------------------------------------------------------ PE-1
test('PE-1: account-state refusals are non-retryable and open the manual gate', () => {
  for (const [label, sample] of ACCOUNT_STATE_SAMPLES) {
    for (const channel of ['stderr', 'stdout']) {
      const result = classify('codex', sample, channel);
      assert.strictEqual(result.category, 'ACCOUNT_POLICY', `${label} on ${channel} must be ACCOUNT_POLICY`);
      assert.strictEqual(result.retryable, false, `${label} must never be retried`);
      assert.strictEqual(result.safety_action, 'OPEN_MANUAL_RESET', `${label} must require operator admission`);
    }
  }
  // A ban reported as an account-state refusal must name that family, not "TOS".
  const result = classify('codex', ACCOUNT_STATE_SAMPLES[0][1]);
  assert.match(String(result.reason), /account state refusal/i, `reason must name the family (${result.reason})`);
});

// ------------------------------------------------------------------ PE-2
test('PE-2: billing and quota refusals are non-retryable and actionable', () => {
  for (const [label, sample] of BILLING_SAMPLES) {
    const result = classify('codex', sample);
    assert.strictEqual(result.category, 'ACCOUNT_POLICY', `${label} must be ACCOUNT_POLICY`);
    assert.strictEqual(result.retryable, false, `${label} must never be retried`);
    assert.strictEqual(result.safety_action, 'OPEN_MANUAL_RESET', `${label} must require a human`);
    assert.match(String(result.reason), /billing|quota/i, `${label} reason must tell the operator it is money (${result.reason})`);
  }
});

// ------------------------------------------------------------------ PE-3
test('PE-3: the same holds when the refusal arrives on stdout (codex --json)', () => {
  for (const [, sample] of [...ACCOUNT_STATE_SAMPLES, ...BILLING_SAMPLES]) {
    const onStderr = classify('codex', sample, 'stderr');
    const onStdout = classify('codex', sample, 'stdout');
    assert.strictEqual(onStdout.category, onStderr.category, `channel must not change the verdict: ${sample.slice(0, 60)}`);
    assert.strictEqual(onStdout.retryable, onStderr.retryable);
    assert.strictEqual(onStdout.safety_action, onStderr.safety_action);
  }
});

// ------------------------------------------------------------------ PE-4
test('PE-4: no false positives - logs and bare numbers never trip the breaker', () => {
  const benign = [
    ['test log mentioning 403', '✔ 403 retries with Retry-After and then succeeds\n✖ test/features/auth.test.mjs (1 of 12 failed)'],
    ['bare number 402', 'processed 402 bytes in 402ms'],
    ['bare number 403', 'wrote 403 lines'],
    ['quota wording in a test name', '✖ test("quota exceeded handling") assertions 1'],
    // A realistic workspace test-log line: it carries test-runner framing, which
    // is what the suppression rule keys on. A bare prose line with no framing is
    // indistinguishable from a provider refusal - see the boundary test below.
    ['payment wording inside a test log', '✖ test/features/billing.test.mjs (1 of 3 failed)\n  AssertionError: assert "payment required" is returned for unpaid orgs'],
  ];
  for (const [label, sample] of benign) {
    const result = classify('codex', sample, 'stdout');
    assert.notStrictEqual(
      result.category,
      'ACCOUNT_POLICY',
      `${label} must not be read as an account refusal (a false breaker trip stops every task)`
    );
  }
});

// ------------------------------------------------------------------ PE-4b
test('PE-4b: the documented boundary of the ambiguity rule', () => {
  // Deliberate asymmetry, in writing so nobody has to guess later:
  //
  //   - DISTINCTIVE tokens (account_deactivated, insufficient_quota, credit
  //     balance is too low) are never suppressed, even inside a test log,
  //     because suppressing them could retry a banned or unpaid account.
  //   - AMBIGUOUS prose ("payment required", "billing ... issue") is suppressed
  //     on stdout only when the output looks like a test-runner log. Without
  //     that framing a bare prose line is treated as a refusal: tripping the
  //     breaker is recoverable by an operator, silently retrying a dead account
  //     is not.
  const distinctiveInLog = classify(
    'codex',
    '✖ test("account deactivation handling") assertions 1\n  AssertionError: account_deactivated was returned',
    'stdout'
  );
  assert.strictEqual(
    distinctiveInLog.category,
    'ACCOUNT_POLICY',
    'a distinctive account token must still be read as a refusal even inside a test log'
  );

  const proseWithoutFraming = classify('codex', 'payment required', 'stdout');
  assert.strictEqual(
    proseWithoutFraming.category,
    'ACCOUNT_POLICY',
    'ambiguous prose with no test framing is treated as a refusal (fail-closed on money signals)'
  );
});

// ------------------------------------------------------------------ PE-5
test('PE-5: genuinely transient failures stay retryable', () => {
  for (const [label, sample] of TRANSIENT_SAMPLES) {
    const result = classify('codex', sample);
    assert.strictEqual(result.category, 'TRANSIENT_FAULT', `${label} is transient`);
    assert.strictEqual(result.retryable, true, `${label} must stay retryable`);
    assert.strictEqual(result.safety_action, 'NONE', `${label} must not touch the breaker`);
  }
  // RESOURCE_EXHAUSTED is deliberately paced rather than retried immediately.
  const exhausted = classify('vertex-gemini', '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}');
  assert.strictEqual(exhausted.category, 'RATE_LIMIT');
  assert.strictEqual(exhausted.safety_action, 'COOLDOWN');
});

// ------------------------------------------------------------------ PE-6
test('PE-6: classification is executor-agnostic', () => {
  const samples = [...ACCOUNT_STATE_SAMPLES, ...BILLING_SAMPLES, ...TRANSIENT_SAMPLES];
  for (const [, sample] of samples) {
    const verdicts = EXECUTORS.map((executor) => JSON.stringify(classify(executor, sample)));
    assert.strictEqual(
      new Set(verdicts).size,
      1,
      `the same evidence must classify identically across executors: ${sample.slice(0, 60)} -> ${[...new Set(verdicts)].join(' | ')}`
    );
  }
});

// ------------------------------------------------------------------ PE-7
test('PE-7: the safety action reaches the runtime guard (breaker opens, no retry)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'af-pe7-'));
  const stateFile = join(dir, 'state.json');
  const eventsLog = join(dir, 'events.jsonl');
  const policyFile = join(ROOT_DIR, 'config', 'executor-safety-profiles.json');
  try {
    for (const [label, sample] of [...ACCOUNT_STATE_SAMPLES, ...BILLING_SAMPLES]) {
      const guard = new ExecutorRuntimeGuard({ policyFile, stateFile, eventsLogFile: eventsLog });
      const classification = classify('codex', sample);
      guard.recordResult('codex', classification);
      assert.strictEqual(
        guard.canExecute('codex'),
        false,
        `${label} must block the executor until an operator admits it`
      );
      assert.strictEqual(guard.getCircuitState('codex').state, 'OPEN_MANUAL_RESET');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ PE-8
test('PE-8: the table covers every provider family this repo drives', () => {
  // One refusal per driven executor family, using each provider's own wording.
  const perProvider = [
    ['claude', '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}'],
    ['codex', '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'],
    ['cline', '{"error":{"message":"account_deactivated"}}'],
    ['vertex-gemini', '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"Permission denied"}}'],
    ['antigravity', '{"error":{"message":"Your account has been suspended"}}'],
  ];
  for (const [executor, sample] of perProvider) {
    const result = classify(executor, sample);
    assert.strictEqual(result.category, 'ACCOUNT_POLICY', `${executor} sample must be ACCOUNT_POLICY`);
    assert.strictEqual(result.retryable, false, `${executor} sample must not be retried`);
  }
});
