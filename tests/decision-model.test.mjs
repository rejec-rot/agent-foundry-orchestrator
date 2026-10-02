// decision-model.test.mjs - the advisory decision-model adapter must stay default-off, fail-closed,
// secret-free, and OFF the safety path.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decide,
  decisionModelConfig,
  buildSystemOneRequest,
  adviseErrorClass,
  confidenceBand,
  MAX_CHOICE_OPTIONS,
  SYSTEMONE_ENDPOINT,
} from '../lib/decision-model.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const OK_QUESTIONS = {
  department: { type: 'choice', instructions: 'Which team should handle this', criteria: { billing: 'b', technical: 't' } },
  urgency: { type: 'noul', instructions: 'Does this convey urgency?' },
};

const okPayload = {
  model: 'jev-1.13.0',
  answers: {
    department: { type: 'choice', choice: 'technical', confidence: 0.78, probabilities: { technical: 0.85, billing: 0.15 } },
    urgency: { type: 'noul', noul: 1.0 },
  },
  usage: { input_tokens: 392, output_tokens: 65 },
};

const jsonResponse = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

test('DM-1: default OFF performs no network call and returns ok:false', async () => {
  let called = 0;
  const res = await decide({ state: 'x', questions: OK_QUESTIONS, deps: { fetchImpl: () => { called += 1; } }, env: {} });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.provider, 'off');
  assert.strictEqual(called, 0, 'off must never touch the network');
});

test('DM-2: an unknown mode is treated as off, and the mismatch is visible', () => {
  const cfg = decisionModelConfig({ AF_DECISION_MODEL: 'gpt' });
  assert.strictEqual(cfg.mode, 'off');
  assert.strictEqual(cfg.mode_valid, false);
});

test('DM-3: jev without a key is refused without any network call', async () => {
  let called = 0;
  const res = await decide({ state: 'x', questions: OK_QUESTIONS, deps: { fetchImpl: () => { called += 1; } }, env: { AF_DECISION_MODEL: 'jev' } });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /AF_TYPESAFE_API_KEY/);
  assert.strictEqual(called, 0);
});

test('DM-4: jev sends the official request shape and parses typed answers', async () => {
  let seen = null;
  const fetchImpl = async (url, options) => { seen = { url, options }; return jsonResponse(okPayload); };
  const res = await decide({
    state: 'the integration keeps failing',
    questions: OK_QUESTIONS,
    deps: { fetchImpl },
    env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk-test-123' },
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(seen.url, SYSTEMONE_ENDPOINT);
  assert.strictEqual(seen.options.method, 'POST');
  assert.strictEqual(seen.options.headers.authorization, 'Bearer sk-test-123');
  assert.ok(seen.options.signal, 'a timeout AbortSignal must be attached');
  const body = JSON.parse(seen.options.body);
  assert.strictEqual(body.model, 'jev-latest');
  assert.strictEqual(body.state, 'the integration keeps failing');
  assert.deepStrictEqual(Object.keys(body.questions), ['department', 'urgency']);
  assert.strictEqual(res.answers.department.choice, 'technical');
  assert.strictEqual(res.answers.department.confidence, 0.78);
  assert.strictEqual(res.answers.urgency.noul, 1.0);
  assert.strictEqual(res.usage.input_tokens, 392);
  assert.strictEqual(res.model, 'jev-1.13.0');
});

test('DM-5: invalid questions/state are refused before any network call', async () => {
  const env = { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk' };
  const cases = [
    { state: '', questions: OK_QUESTIONS },
    { state: 'x', questions: {} },
    { state: 'x', questions: { q: { type: 'text', instructions: 'hi' } } },
    { state: 'x', questions: { q: { type: 'choice', instructions: 'hi' } } },
    { state: 'x', questions: { q: { type: 'score', instructions: 'hi', criteria: [] } } },
    { state: 'x', questions: { q: { type: 'noul', instructions: '   ' } } },
  ];
  for (const params of cases) {
    let called = 0;
    const res = await decide({ ...params, deps: { fetchImpl: () => { called += 1; } }, env });
    assert.strictEqual(res.ok, false, JSON.stringify(params));
    assert.strictEqual(called, 0, 'an invalid request must not reach the network');
  }
});

test('DM-6: a non-https endpoint is refused', async () => {
  let called = 0;
  const res = await decide({ state: 'x', questions: OK_QUESTIONS, deps: { fetchImpl: () => { called += 1; } }, env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk', AF_TYPESAFE_ENDPOINT: 'http://api.typesafe.ai/v1/systemone' } });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /https/);
  assert.strictEqual(called, 0);
});

test('DM-7: transport/status/parse failures are ok:false (never a throw, never a guess)', async () => {
  const env = { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk' };
  const thrower = async () => { throw new Error('socket hang up'); };
  const badStatus = async () => jsonResponse({}, 500);
  const badJson = async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } });
  const noAnswers = async () => jsonResponse({ model: 'x' });
  for (const fetchImpl of [thrower, badStatus, badJson, noAnswers]) {
    const res = await decide({ state: 'x', questions: OK_QUESTIONS, deps: { fetchImpl }, env });
    assert.strictEqual(res.ok, false);
    assert.ok(res.reason, 'a failure must carry a reason');
  }
});

test('DM-8: the api key never appears in a result object', async () => {
  const fetchImpl = async () => jsonResponse(okPayload);
  const secret = 'sk-super-secret-value';
  const res = await decide({ state: 'x', questions: OK_QUESTIONS, deps: { fetchImpl }, env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: secret } });
  assert.ok(!JSON.stringify(res).includes(secret), 'the key must not be echoed in the result');
});

test('DM-9: result carries only the model name and usage - no config or key leakage', () => {
  const cfg = decisionModelConfig({ AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk' });
  assert.strictEqual(cfg.api_key_configured, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(cfg, 'API_KEY'), false);
  // the config exposes a boolean, never the key itself
  assert.ok(!JSON.stringify(cfg).includes('"sk"'));
});

test('DM-10: the adapter is advisory only - no safety-critical module imports it', () => {
  const safetyModules = [
    'lib/host-boundary.mjs',
    'lib/a1a.mjs',
    'lib/asset-lock.mjs',
    'lib/protection-epoch.mjs',
    'lib/trusted-import/orchestrator-adapter.mjs',
    'lib/recovery.mjs',
  ];
  for (const rel of safetyModules) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.doesNotMatch(src, /decision-model/, `${rel} must not depend on the advisory decision model`);
  }
});

test('DM-11: adviseErrorClass is a hint only and degrades to ok:false when off', async () => {
  const off = await adviseErrorClass({ stderr: 'boom', classes: ['timeout', 'auth'], env: {} });
  assert.strictEqual(off.ok, false);
  assert.strictEqual(off.choice, null);
  const res = await adviseErrorClass({
    stderr: 'request timed out after 30s',
    classes: ['timeout', 'auth'],
    deps: { fetchImpl: async () => jsonResponse({ model: 'm', answers: { error_class: { type: 'choice', choice: 'timeout', confidence: 0.9 } } }) },
    env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk' },
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.choice, 'timeout');
  assert.strictEqual(res.confidence, 0.9);
});

test('DM-12: buildSystemOneRequest matches the documented shape', () => {
  const built = buildSystemOneRequest({ state: 's', questions: { q: { type: 'noul', instructions: 'true?' } } });
  assert.strictEqual(built.ok, true);
  assert.strictEqual(built.body.model, 'jev-latest');
  assert.deepStrictEqual(built.body.questions.q, { type: 'noul', instructions: 'true?' });
});

test('DM-13: the official primitive limits are enforced', () => {
  const many = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => [`o${i}`, 'x']));
  assert.strictEqual(buildSystemOneRequest({ state: 's', questions: { q: { type: 'choice', instructions: 'pick', criteria: many } } }).ok, false, 'choice options capped at 255');
  const okChoice = Object.fromEntries(Array.from({ length: MAX_CHOICE_OPTIONS }, (_, i) => [`o${i}`, 'x']));
  assert.strictEqual(buildSystemOneRequest({ state: 's', questions: { q: { type: 'choice', instructions: 'pick', criteria: okChoice } } }).ok, true);
  assert.strictEqual(buildSystemOneRequest({ state: 's', questions: { q: { type: 'score', instructions: 'rate', criteria: ['only one'] } } }).ok, false, 'score needs >= 2 levels');
  assert.strictEqual(buildSystemOneRequest({ state: 's', questions: { q: { type: 'score', instructions: 'rate', criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) } } }).ok, false, 'score capped at 10 levels');
});

test('DM-14: structured instructions and structured state are accepted', () => {
  const built = buildSystemOneRequest({
    state: { ticket: { messages: [{ text: 'refund please' }] } },
    questions: {
      refund: { type: 'noul', instructions: { question: 'Does `ticket.messages[0].text` request a refund?', policy: 'x' } },
    },
  });
  assert.strictEqual(built.ok, true);
});

test('DM-15: confidenceBand maps confidence to act/confirm/escalate', () => {
  assert.strictEqual(confidenceBand(0.95), 'act');
  assert.strictEqual(confidenceBand(0.8), 'act');
  assert.strictEqual(confidenceBand(0.6), 'confirm');
  assert.strictEqual(confidenceBand(0.3), 'escalate');
  assert.strictEqual(confidenceBand(undefined), 'unknown');
});

test('DM-16: 429/529 are retried with backoff; other statuses are not', async () => {
  let calls = 0;
  const flaky = async () => { calls += 1; return calls < 3 ? jsonResponse({}, 429) : jsonResponse(okPayload); };
  const slept = [];
  const res = await decide({ state: 'x', questions: OK_QUESTIONS, deps: { fetchImpl: flaky, sleep: (ms) => { slept.push(ms); }, maxRetries: 2 }, env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk' } });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(calls, 3, 'two retries then success');
  assert.deepStrictEqual(slept, [200, 400], 'exponential backoff');

  let hardCalls = 0;
  const hardFail = async () => { hardCalls += 1; return jsonResponse({}, 500); };
  const res2 = await decide({ state: 'x', questions: OK_QUESTIONS, deps: { fetchImpl: hardFail, sleep: () => {} }, env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk' } });
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(hardCalls, 1, '500 is not retried');
});
