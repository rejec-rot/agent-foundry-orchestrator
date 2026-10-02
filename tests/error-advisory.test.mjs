// error-advisory.test.mjs - the advisory overlay must never change the deterministic classification.

import { test } from 'node:test';
import assert from 'node:assert';

import { withErrorAdvisory } from '../lib/error-advisory.mjs';
import { ERROR_CATEGORIES } from '../lib/executor-error-classifier.mjs';

const TRANSIENT = { category: 'TRANSIENT_FAULT', retryable: true, safety_action: 'NONE', reason: 'boom' };
const envOn = { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk' };

const modelSays = (choice, confidence = 0.9) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ model: 'jev-1.13.0', answers: { suggested_category: { type: 'choice', choice, confidence } } }),
});

test('EA-1: with the model off the classification is returned unchanged (same reference), no network', async () => {
  let called = 0;
  const out = await withErrorAdvisory({ classification: TRANSIENT, evidence: { stderr: 'x' }, deps: { fetchImpl: () => { called += 1; } }, env: {} });
  assert.strictEqual(out, TRANSIENT, 'off must return the identical object');
  assert.strictEqual(called, 0);
});

test('EA-2: a SUCCESS classification is never annotated', async () => {
  const success = { category: ERROR_CATEGORIES.SUCCESS, retryable: false, safety_action: 'NONE', reason: null };
  const out = await withErrorAdvisory({ classification: success, evidence: { stderr: 'x' }, deps: { fetchImpl: modelSays('RATE_LIMIT') }, env: envOn });
  assert.strictEqual(out, success);
});

test('EA-3: with no stderr there is nothing to advise on', async () => {
  let called = 0;
  const out = await withErrorAdvisory({ classification: TRANSIENT, evidence: {}, deps: { fetchImpl: () => { called += 1; } }, env: envOn });
  assert.strictEqual(out, TRANSIENT);
  assert.strictEqual(called, 0);
});

test('EA-4: an attached advisory records agreement and never changes deterministic fields', async () => {
  const out = await withErrorAdvisory({ executorType: 'codex', classification: TRANSIENT, evidence: { stderr: 'rate limit exceeded' }, deps: { fetchImpl: modelSays('RATE_LIMIT', 0.8) }, env: envOn });
  assert.notStrictEqual(out, TRANSIENT);
  assert.strictEqual(out.category, TRANSIENT.category);
  assert.strictEqual(out.retryable, TRANSIENT.retryable);
  assert.strictEqual(out.safety_action, TRANSIENT.safety_action);
  assert.strictEqual(out.reason, TRANSIENT.reason);
  assert.strictEqual(out.advisory.suggested_category, 'RATE_LIMIT');
  assert.strictEqual(out.advisory.category_confidence, 0.8);
  assert.strictEqual(out.advisory.category_band, 'act', '0.8 confidence is the act band');
  assert.strictEqual(out.advisory.deterministic_category, 'TRANSIENT_FAULT');
  assert.strictEqual(out.advisory.disagrees, true, 'TRANSIENT vs RATE_LIMIT is a disagreement');
  assert.deepStrictEqual(out.advisory.applies_to, ['observability']);
});

test('EA-7: the advisory fans out - one call returns category + retryable + ban + severity', async () => {
  const fanOut = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: 'jev-1.13.0',
      answers: {
        suggested_category: { type: 'choice', choice: 'RATE_LIMIT', confidence: 0.95 },
        retryable_hint: { type: 'noul', noul: 0.91 },
        suspected_account_ban: { type: 'noul', noul: 0.02 },
        severity: { type: 'score', score: 1.15, confidence: 0.77 },
      },
    }),
  });
  const out = await withErrorAdvisory({ executorType: 'codex', classification: TRANSIENT, evidence: { stderr: 'rate limit', exit_code: 1 }, deps: { fetchImpl: fanOut }, env: envOn });
  assert.strictEqual(out.advisory.category_band, 'act');
  assert.strictEqual(out.advisory.retryable_hint, 0.91);
  assert.strictEqual(out.advisory.suspected_account_ban, 0.02);
  assert.strictEqual(out.advisory.severity, 1.15);
  // still never changes the deterministic verdict
  assert.strictEqual(out.retryable, TRANSIENT.retryable);
  assert.strictEqual(out.category, TRANSIENT.category);
});

test('EA-5: a DANGEROUS disagreement is recorded, never applied (deterministic stays authoritative)', async () => {
  // The deterministic classifier says retryable; the model suspects an account ban. The advisory
  // must NOT flip retryable (that would be the model deciding safety) - it flags the disagreement.
  const out = await withErrorAdvisory({ executorType: 'codex', classification: TRANSIENT, evidence: { stderr: 'suspicious' }, deps: { fetchImpl: modelSays('ACCOUNT_POLICY') }, env: envOn });
  assert.strictEqual(out.retryable, true, 'the model must never change the retry decision');
  assert.strictEqual(out.category, 'TRANSIENT_FAULT');
  assert.strictEqual(out.advisory.suggested_category, 'ACCOUNT_POLICY');
  assert.strictEqual(out.advisory.disagrees, true);
});

test('EA-6: a model failure leaves the deterministic classification untouched', async () => {
  const failing = async () => { throw new Error('network down'); };
  const out = await withErrorAdvisory({ classification: TRANSIENT, evidence: { stderr: 'x' }, deps: { fetchImpl: failing }, env: envOn });
  assert.strictEqual(out, TRANSIENT);
});
