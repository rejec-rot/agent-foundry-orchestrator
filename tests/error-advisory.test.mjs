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
  assert.strictEqual(out.advisory.model, 'jev-latest', 'the configured model is stored, never a provider echo');
  // still never changes the deterministic verdict
  assert.strictEqual(out.retryable, TRANSIENT.retryable);
  assert.strictEqual(out.category, TRANSIENT.category);
});

test('EA-8: outbound stderr is redacted, path-cleaned and bounded; executor and stored model are fixed-safe', async () => {
  const key = 'sk-error-advisory-private';
  const env = { ...envOn, AF_TYPESAFE_API_KEY: key, AF_TYPESAFE_MODEL: 'jev-latest', OTHER_ENV_SECRET: 'must-not-be-sent' };
  const stderr = `fatal token ${key} at /home/private/work, C:\\Users\\private\\work - ${'x'.repeat(2400)}`;
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: 'remote-secret-reflection', answers: {
        suggested_category: { type: 'choice', choice: 'RATE_LIMIT', confidence: 0.9 },
      } }),
    };
  };
  const out = await withErrorAdvisory({
    executorType: key,
    classification: TRANSIENT,
    evidence: { stderr },
    deps: { fetchImpl },
    env,
  });
  assert.ok(request.state.output.length <= 2_000);
  assert.equal(request.state.executor, 'unknown');
  assert.ok(!JSON.stringify(request.state).includes(key));
  assert.ok(!JSON.stringify(request.state).includes('/home/private'));
  assert.ok(!JSON.stringify(request.state).includes('C:\\Users'));
  assert.ok(!JSON.stringify(request.state).includes('OTHER_ENV_SECRET'));
  assert.equal(out.advisory.model, 'jev-latest');
  assert.ok(!JSON.stringify(out).includes('remote-secret-reflection'));
  assert.ok(!JSON.stringify(out).includes(key));
});

test('EA-9: a wrong answer type or unknown category leaves the deterministic object untouched', async () => {
  for (const answer of [
    { type: 'noul', choice: 'RATE_LIMIT', confidence: 0.9 },
    { type: 'choice', choice: 'SUCCESS', confidence: 0.9 },
    { type: 'choice', choice: 'MADE_UP_CATEGORY', confidence: 0.9 },
  ]) {
    const out = await withErrorAdvisory({
      classification: TRANSIENT,
      evidence: { stderr: 'failure' },
      deps: { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ answers: { suggested_category: answer } }) }) },
      env: envOn,
    });
    assert.strictEqual(out, TRANSIENT);
  }
});

test('EA-10: invalid confidence, noul and score values are stored as null', async () => {
  const out = await withErrorAdvisory({
    classification: TRANSIENT,
    evidence: { stderr: 'failure' },
    deps: { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      answers: {
        suggested_category: { type: 'choice', choice: 'RATE_LIMIT', confidence: 1.01 },
        retryable_hint: { type: 'choice', choice: 'yes', noul: 0.9 },
        suspected_account_ban: { type: 'noul', noul: Number.POSITIVE_INFINITY },
        severity: { type: 'score', score: 4 },
      },
    }) }) },
    env: envOn,
  });
  assert.equal(out.advisory.suggested_category, 'RATE_LIMIT');
  assert.equal(out.advisory.category_confidence, null);
  assert.equal(out.advisory.category_band, 'unknown');
  assert.equal(out.advisory.retryable_hint, null);
  assert.equal(out.advisory.suspected_account_ban, null);
  assert.equal(out.advisory.severity, null);
});

test('EA-11: the advisory caps timeout at three seconds and makes only one provider attempt', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let configuredDelay = null;
  let calls = 0;
  let sleeps = 0;
  globalThis.setTimeout = (callback, delay, ...args) => {
    configuredDelay = delay;
    return originalSetTimeout(callback, 1, ...args);
  };
  try {
    const out = await withErrorAdvisory({
      classification: TRANSIENT,
      evidence: { stderr: 'provider unavailable' },
      deps: {
        maxRetries: 4,
        sleep: async () => { sleeps += 1; },
        fetchImpl: async (_url, { signal }) => {
          calls += 1;
          return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, status: 499 }), { once: true }));
        },
      },
      env: { ...envOn, AF_TYPESAFE_TIMEOUT_MS: '12000' },
    });
    assert.strictEqual(out, TRANSIENT);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(configuredDelay, 3_000);
  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
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
