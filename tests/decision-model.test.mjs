// decision-model.test.mjs - the advisory decision-model adapter must stay default-off, fail-closed,
// secret-free, and OFF the safety path.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  decide,
  decisionModelConfig,
  buildSystemOneRequest,
  adviseErrorClass,
  confidenceBand,
  MAX_CHOICE_OPTIONS,
  SYSTEMONE_ENDPOINT,
  resolveDecisionEnv,
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

test('DM-17: timeout covers a response body that never settles, even when it ignores abort', { timeout: 1500 }, async () => {
  let calls = 0, requestSignal;
  const started = performance.now();
  const result = await decide({ state: 'x', questions: OK_QUESTIONS,
    env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'private-test-key', AF_TYPESAFE_TIMEOUT_MS: '20' },
    deps: { maxRetries: 0, fetchImpl: async (_url, options) => {
      calls++; requestSignal = options.signal;
      return { ok: true, status: 200, json: () => new Promise(() => {}) };
    } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timed out after 20ms');
  assert.equal(calls, 1);
  assert.equal(requestSignal.aborted, true);
  assert.ok(performance.now() - started < 1000, 'a stalled body must release the caller');
});

test('DM-18: an already cancelled caller does not issue a provider request', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = await decide({ state: 'x', questions: OK_QUESTIONS, signal: controller.signal,
    env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'private-test-key' },
    deps: { fetchImpl: async () => { calls++; return jsonResponse(okPayload); } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'decision request cancelled');
  assert.equal(calls, 0);
});

test('DM-19: caller cancellation releases requests stalled before headers or during body parsing', { timeout: 1500 }, async () => {
  for (const stall of ['headers', 'body']) {
    const controller = new AbortController();
    let requestSignal, announceEntered;
    const entered = new Promise(resolve => { announceEntered = resolve; });
    const resultPromise = decide({ state: 'x', questions: OK_QUESTIONS, signal: controller.signal,
      env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'private-test-key', AF_TYPESAFE_TIMEOUT_MS: '5000' },
      deps: { maxRetries: 0, fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        if (stall === 'headers') { announceEntered(); return new Promise(() => {}); }
        return { ok: true, status: 200, json: () => { announceEntered(); return new Promise(() => {}); } };
      } },
    });
    await entered; controller.abort(new Error('private caller reason'));
    const result = await resultPromise;
    assert.equal(result.ok, false, stall);
    assert.equal(result.reason, 'decision request cancelled', stall);
    assert.equal(requestSignal.aborted, true, stall);
  }
});

test('DM-20: provider and body errors cannot echo the API key or raw failure text', async () => {
  const secret = 'sk-private-provider-error';
  const failures = [
    async () => { throw new Error('Bearer ' + secret + ' endpoint detail'); },
    async () => ({ ok: true, status: 200, json: async () => { throw new Error(secret); } }),
    async () => ({ ok: false, status: 401, json: async () => ({ error: secret }) }),
  ];
  for (const fetchImpl of failures) {
    const result = await decide({ state: 'x', questions: OK_QUESTIONS,
      env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: secret }, deps: { fetchImpl, maxRetries: 0 },
    });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /sk-private-provider-error|endpoint detail|Bearer/);
    assert.ok(['request failed', 'response was not JSON', 'unexpected status 401'].includes(result.reason));
  }
});

test('DM-21: explicit private literal environment file loads once without changing process environment', t => {
  const directory = mkdtempSync(join(tmpdir(), 'af-decision-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'decision.env');
  writeFileSync(file, '# Private configuration\nAF_DECISION_MODEL=jev\nAF_TYPESAFE_API_KEY="file-key"\nAF_TYPESAFE_ENDPOINT=https://api.typesafe.ai/v1/systemone\nAF_TYPESAFE_MODEL=\'jev-file-model\'\nAF_TYPESAFE_TIMEOUT_MS=1200\n', { mode: 0o600 });
  const env = { AF_DECISION_ENV_FILE: file, AF_TYPESAFE_MODEL: 'explicit-model', AF_TYPESAFE_API_KEY: '', OTHER_ENV: 'preserved' };
  const resolved = resolveDecisionEnv(env);
  assert.equal(resolved.AF_DECISION_MODEL, 'jev');
  assert.equal(resolved.AF_TYPESAFE_MODEL, 'explicit-model');
  assert.equal(resolved.AF_TYPESAFE_API_KEY, '', 'an explicit empty value intentionally overrides the file');
  assert.equal(resolved.AF_TYPESAFE_TIMEOUT_MS, '1200');
  assert.equal(resolved.OTHER_ENV, 'preserved');
  assert.equal(env.AF_DECISION_MODEL, undefined, 'the input environment is not mutated');
  assert.equal(resolveDecisionEnv({ AF_DECISION_ENV_FILE: file }).AF_TYPESAFE_API_KEY, 'file-key');
  assert.equal(decisionModelConfig(resolveDecisionEnv({})).mode, 'off');
  assert.equal(decisionModelConfig(resolveDecisionEnv({ AF_DECISION_ENV_FILE: file, AF_DECISION_MODEL: 'off' })).mode, 'off');
});

test('DM-22: the adapter never implicitly reads an environment file or activates Jev', async () => {
  const env = { AF_DECISION_ENV_FILE: '/does/not/exist/private-decision.env' };
  let called = 0;
  const result = await decide({ state: 'x', questions: OK_QUESTIONS, env, deps: { fetchImpl: () => { called++; } } });
  assert.equal(result.provider, 'off');
  assert.equal(called, 0);
  assert.deepEqual(resolveDecisionEnv({}), {});
});

test('DM-23: environment files reject shell syntax, unknown fields, duplicates, malformed values and unsafe permissions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'af-decision-env-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'secret-private-name.env');
  const invalid = [
    'export AF_DECISION_MODEL=jev\n',
    'source /private/secret\n',
    'AF_TYPESAFE_API_KEY=$(printf private-secret)\n',
    'AF_TYPESAFE_API_KEY="${PRIVATE_SECRET}"\n',
    'AF_TYPESAFE_API_KEY=`printf private-secret`\n',
    'AF_WEB_TOKEN=private-secret\n',
    'AF_DECISION_ENV_FILE=/private/secret\n',
    'AF_DECISION_MODEL=off\nAF_DECISION_MODEL=jev\n',
    'AF_TYPESAFE_API_KEY="private-secret\n',
    'AF_TYPESAFE_API_KEY=private-secret # extra\n',
    'AF_TYPESAFE_API_KEY=private\u0000secret\n',
    'AF_TYPESAFE_API_KEY=' + 'x'.repeat(16 * 1024),
  ];
  const assertPrivateError = () => assert.throws(() => resolveDecisionEnv({ AF_DECISION_ENV_FILE: file }), error => {
    assert.equal(error.code, 'AF_DECISION_ENV_INVALID');
    assert.equal(error.message, 'decision environment file is invalid or unavailable');
    assert.doesNotMatch(JSON.stringify(error), /private-secret|secret-private-name|\/private\/secret/);
    return true;
  });
  for (const contents of invalid) { writeFileSync(file, contents, { mode: 0o600 }); chmodSync(file, 0o600); assertPrivateError(); }
  writeFileSync(file, 'AF_DECISION_MODEL=jev\n'); chmodSync(file, 0o644); assertPrivateError();
  rmSync(file); mkdirSync(file, { mode: 0o700 }); assertPrivateError();
  rmSync(file, { recursive: true });
  const target = join(directory, 'target.env'); writeFileSync(target, 'AF_DECISION_MODEL=jev\n', { mode: 0o600 });
  symlinkSync(target, file); assertPrivateError();
  rmSync(file); assertPrivateError();
});
