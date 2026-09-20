import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecutionError } from '../lib/executor-error-classifier.mjs';

test('AGY location refusal is non-retryable and does not mark an account banned', () => {
  for (const channel of ['stderr', 'stdout']) {
    const result = classifyExecutionError('antigravity', {
      exit_code: 1,
      [channel]: '400 User location is not supported',
    });
    assert.equal(result.category, 'ENVIRONMENT_FAULT');
    assert.equal(result.retryable, false);
    assert.equal(result.safety_action, 'NONE');
    assert.match(result.reason, /^PROVIDER_LOCATION_UNSUPPORTED:/);
  }
});

test('location wording in test output does not manufacture a provider refusal', () => {
  const result = classifyExecutionError('antigravity', {
    exit_code: 1,
    stdout: 'test("User location is not supported") failed',
  });
  assert.equal(result.category, 'TRANSIENT_FAULT');
});

test('explicit account refusal retains precedence over location wording', () => {
  const result = classifyExecutionError('antigravity', {
    exit_code: 1,
    stderr: '403 ACCOUNT_DISABLED; User location is not supported',
  });
  assert.equal(result.category, 'ACCOUNT_POLICY');
  assert.equal(result.retryable, false);
});
