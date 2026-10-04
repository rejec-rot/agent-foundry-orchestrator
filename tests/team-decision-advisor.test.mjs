import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../lib/decision-model.mjs';
import { plannerDecisionConfig, proposePlannerDecision } from '../lib/team/decision-advisor.mjs';

const ENV = {
  AF_DECISION_MODEL: 'jev',
  AF_TYPESAFE_API_KEY: 'sk-advisor-test-secret',
  AF_TYPESAFE_MODEL: 'jev-latest',
};

function catalog(models = [{ id: 'model-a', reasoning_efforts: ['low', 'high'], reasoning_status: 'verified' }]) {
  return [{
    executor_type: 'codex',
    supports_model: true,
    default_model: models[0]?.id ?? null,
    models,
  }];
}

function team(extra = {}) {
  return { goal: 'Split the migration into safe tasks.', planning: {}, work_items: [], ...extra };
}

function chooseAll({ questions, choiceFor = () => null, confidence = 0.95 }) {
  const answers = {};
  for (const [name, question] of Object.entries(questions)) {
    const choice = choiceFor(name, question) ?? Object.keys(question.criteria)[0];
    answers[name] = { type: 'choice', choice, confidence };
  }
  return { ok: true, provider: 'jev', model: 'jev-1.13.0', answers };
}

function mockFetch(payload) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => payload(calls.at(-1).body) };
  };
  return { calls, fetchImpl };
}

test('advisor stays off by default and reports only a safe config view', async () => {
  let calls = 0;
  const result = await proposePlannerDecision({
    team: team(), kind: 'plan', catalog: catalog(), env: {},
    decideImpl: async () => { calls += 1; return chooseAll({ questions: {} }); },
  });
  assert.equal(result.status, 'off');
  assert.equal(calls, 0);
  assert.deepEqual(plannerDecisionConfig({}), {
    provider: 'jev', enabled: false, configured: false, model: 'jev-latest', available: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /endpoint|secret|sk-advisor/);
});

test('a missing key is unconfigured and never invokes the injected decision client', async () => {
  let calls = 0;
  const result = await proposePlannerDecision({
    team: team(), kind: 'plan', catalog: catalog(), env: { AF_DECISION_MODEL: 'jev' },
    decideImpl: async () => { calls += 1; return { ok: true }; },
  });
  assert.equal(result.status, 'unconfigured');
  assert.equal(calls, 0);
  assert.equal(plannerDecisionConfig({ AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk-private' }).available, true);
});

test('one real decision-model call chooses a count and allows repeated legal profiles', async () => {
  const { calls, fetchImpl } = mockFetch((body) => {
    const answers = {};
    for (const [name, question] of Object.entries(body.questions)) {
      const choice = name === 'worker_count' ? 'count_2' : 'profile_1';
      assert.ok(Object.hasOwn(question.criteria, choice));
      answers[name] = { type: 'choice', choice, confidence: 0.93 };
    }
    return { model: 'jev-1.13.0', answers };
  });
  let forwardedSignal;
  const controller = new AbortController();
  const result = await proposePlannerDecision({
    team: team({
      goal: `Migrate with ${ENV.AF_TYPESAFE_API_KEY} from /home/private/project.`,
      goal_revision: 5,
      messages: [
        { from_agent_id: 'operator', to_agent_id: 'lead', goal_revision: 4, status: 'applied', message: 'Old constraint must be ignored.' },
        { from_agent_id: 'operator', to_agent_id: 'lead', goal_revision: 5, status: 'applied', message: `Preserve audit boundary; omit ${ENV.AF_TYPESAFE_API_KEY} at /home/private/project.` },
        { from_agent_id: 'worker-1', to_agent_id: 'lead', goal_revision: 5, status: 'received', message: 'Retry path needs repair at C:\\Users\\private\\work.' },
        { from_agent_id: 'worker-2', to_agent_id: 'lead', goal_revision: 5, status: 'applied', message: 'Already applied feedback is not current.' },
      ],
    }),
    kind: 'plan', catalog: catalog(), env: { ...ENV, AF_TYPESAFE_TIMEOUT_MS: '12000' }, signal: controller.signal,
    decideImpl: (input) => {
      assert.equal(input.deps.maxRetries, 0);
      assert.equal(input.env.AF_TYPESAFE_TIMEOUT_MS, '3000');
      forwardedSignal = input.signal;
      return decide({ ...input, deps: { ...input.deps, fetchImpl } });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(forwardedSignal, controller.signal);
  assert.equal(calls[0].body.model, 'jev-latest');
  assert.equal(calls[0].body.questions.worker_count.type, 'choice');
  assert.equal(Object.keys(calls[0].body.questions.worker_count.criteria).length, 8);
  assert.equal(calls[0].body.questions.worker_8.type, 'choice');
  assert.deepEqual(calls[0].body.state.operator_context, ['Preserve audit boundary; omit <redacted> at <redacted-path>']);
  assert.deepEqual(calls[0].body.state.current_feedback, ['Retry path needs repair at <redacted-path>']);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${ENV.AF_TYPESAFE_API_KEY}`);
  assert.doesNotMatch(JSON.stringify(calls[0].body.state), /sk-advisor-test-secret|\/home\/private/);
  assert.equal(result.status, 'suggested');
  assert.equal(result.confidence, 0.93);
  assert.equal(result.model, 'jev-latest', 'only the configured public model is reported');
  assert.deepEqual(result.recommendation, {
    worker_count: 2,
    workers: [
      { executor_type: 'codex', model: null, effort: null },
      { executor_type: 'codex', model: null, effort: null },
    ],
    retry_work_item_ids: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /sk-advisor-test-secret|api\.typesafe\.ai|Migrate with|rawresponse/i);
  assert.equal(calls[0].options.signal.aborted, false);
});

test('catalog choices are capped at 255, effort variants are model-specific and spread across models', async () => {
  const models = Array.from({ length: 100 }, (_, i) => ({
    id: `model-${i}`,
    reasoning_efforts: ['low', 'medium', 'high'],
    reasoning_status: 'verified',
  }));
  const seen = [];
  const result = await proposePlannerDecision({
    team: team(), kind: 'plan', catalog: catalog(models), env: ENV,
    decideImpl: async ({ questions }) => {
      for (const question of Object.values(questions)) seen.push(Object.keys(question.criteria).length);
      return chooseAll({ questions, choiceFor: (name) => name === 'worker_count' ? 'count_1' : 'profile_1' });
    },
  });
  assert.equal(result.status, 'suggested');
  assert.equal(result.catalog_limited, true);
  assert.equal(result.candidate_count, 401);
  assert.ok(seen.every((count) => count <= 255));
  assert.equal(seen[0], 8);
  assert.equal(seen[1], 255);
});

test('human worker preferences fix the count and profile choices, even when the catalog is truncated', async () => {
  const models = Array.from({ length: 100 }, (_, i) => ({
    id: `model-${i}`,
    reasoning_efforts: ['low', 'medium', 'high', 'ultra'],
    reasoning_status: 'verified',
  }));
  const preferences = [
    { executor_type: 'codex', model: 'model-99', effort: 'ultra' },
    { executor_type: 'codex', model: null },
  ];
  let observedQuestions;
  const result = await proposePlannerDecision({
    team: team({ planning: { worker_preferences: preferences } }),
    kind: 'plan', catalog: catalog(models), env: ENV,
    decideImpl: async ({ questions }) => {
      observedQuestions = questions;
      return chooseAll({ questions, confidence: 0.88 });
    },
  });
  assert.equal(result.status, 'suggested');
  assert.equal(result.catalog_limited, true);
  assert.ok(!Object.hasOwn(observedQuestions, 'worker_count'));
  assert.deepEqual(Object.keys(observedQuestions), ['worker_1', 'worker_2']);
  assert.deepEqual(observedQuestions.worker_1.criteria, { profile_1: 'codex; model=model-99; effort=ultra' });
  assert.deepEqual(result.recommendation, {
    worker_count: 2,
    workers: [
      { executor_type: 'codex', model: 'model-99', effort: 'ultra' },
      { executor_type: 'codex', model: null, effort: null },
    ],
    retry_work_item_ids: [],
  });
});

test('unknown and configured-only models never gain effort choices; invalid grades cannot enter a recommendation', async () => {
  const options = catalog([
    { id: 'unknown-model', reasoning_efforts: ['ultra'], reasoning_status: 'unverified' },
    { id: 'hidden-model', reasoning_efforts: ['high'], reasoning_status: 'verified', configured_only: true },
    { id: 'deepseek/deepseek-v4.1-flash', reasoning_efforts: ['low'], reasoning_status: 'verified' },
  ]);
  let profileCriteria;
  const result = await proposePlannerDecision({
    team: team(), kind: 'plan', catalog: options, env: ENV,
    decideImpl: async ({ questions }) => {
      profileCriteria = questions.worker_1.criteria;
      return chooseAll({ questions, choiceFor: (name) => name === 'worker_count' ? 'count_1' : 'profile_2' });
    },
  });
  assert.ok(!JSON.stringify(profileCriteria).includes('hidden-model'));
  assert.ok(!JSON.stringify(profileCriteria).includes('effort=ultra'));
  assert.equal(result.recommendation.workers[0].model, 'unknown-model');
  assert.equal(result.recommendation.workers[0].effort, null);

  const invalid = await proposePlannerDecision({
    team: team(), kind: 'plan', catalog: options, env: ENV,
    decideImpl: async ({ questions }) => {
      const good = chooseAll({ questions, choiceFor: (name) => name === 'worker_count' ? 'count_1' : 'profile_999' });
      return good;
    },
  });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.recommendation, null);
});

test('revise keeps active worker count and profiles and includes only bounded queued feedback', async () => {
  const active = team({
    members: [
      { agent_id: 'lead', role: 'lead', executor_type: 'codex', model: null },
      { agent_id: 'worker-1', role: 'worker', executor_type: 'codex', model: 'deepseek/deepseek-v4.1-flash', effort: 'low' },
      { agent_id: 'worker-2', role: 'worker', executor_type: 'codex', model: null, effort: null },
    ],
    rework_requests: [{
      request_id: 'change-1', work_item_id: 'work-a', affected_items: ['work-a', 'work-b'],
      feedback: 'Keep the graph and update the existing service boundary.', agent_id: 'worker-1', status: 'queued',
    }],
    work_items: [
      { work_item_id: 'work-a', goal: 'Update the service boundary', status: 'HELD' },
      { work_item_id: 'work-b', goal: 'Retain downstream compatibility', status: 'HELD' },
    ],
  });
  let supplied;
  const result = await proposePlannerDecision({
    team: active,
    kind: 'revise',
    catalog: catalog([{ id: 'deepseek/deepseek-v4.1-flash', reasoning_efforts: ['low'], reasoning_status: 'verified' }]),
    env: ENV,
    decideImpl: async (input) => {
      supplied = input;
      return chooseAll({
        questions: input.questions,
        confidence: 0.9,
        choiceFor: (name) => name === 'revision_focus' ? 'repair_implementation' : null,
      });
    },
  });
  assert.equal(result.status, 'suggested');
  assert.equal(Object.hasOwn(supplied.questions, 'worker_count'), false);
  assert.deepEqual(result.recommendation, {
    worker_count: 2,
    workers: [
      { executor_type: 'codex', model: 'deepseek/deepseek-v4.1-flash', effort: 'low' },
      { executor_type: 'codex', model: null, effort: null },
    ],
    retry_work_item_ids: ['work-a', 'work-b'],
    revision_focus: 'repair_implementation',
  });
  assert.equal(supplied.state.rework_request.feedback, 'Keep the graph and update the existing service boundary.');
  assert.deepEqual(supplied.state.rework_request.affected_items, ['work-a', 'work-b']);
  assert.equal(JSON.stringify(supplied.state).includes('allowed_paths'), false);
});

test('coordinate uses per-item yes/no choices and only returns existing retry ids', async () => {
  const current = team({ work_items: [
    { work_item_id: 'work-a', goal: 'Update the adapter', status: 'DONE' },
    { work_item_id: 'work-b', goal: 'Run acceptance', status: 'BLOCKED' },
  ] });
  const result = await proposePlannerDecision({
    team: current, kind: 'coordinate', catalog: [], env: ENV,
    decideImpl: async ({ questions }) => chooseAll({
      questions,
      choiceFor: (name) => name === 'retry_work-a' ? 'yes' : 'no',
      confidence: 0.91,
    }),
  });
  assert.equal(result.status, 'suggested');
  assert.equal(result.confidence, 0.91);
  assert.deepEqual(result.recommendation, { worker_count: null, workers: [], retry_work_item_ids: ['work-a'] });
});

test('low confidence, malformed probabilities and thrown raw errors fail closed without leaking details', async () => {
  const low = await proposePlannerDecision({
    team: team({ planning: { worker_preferences: [{ executor_type: 'codex', model: 'model-a', effort: 'low' }] } }),
    kind: 'plan', catalog: catalog(), env: ENV,
    decideImpl: async ({ questions }) => chooseAll({ questions, confidence: 0.42 }),
  });
  assert.equal(low.status, 'low_confidence');
  assert.equal(low.recommendation, null);
  assert.equal(low.confidence, 0.42);

  const malformed = await proposePlannerDecision({
    team: team(), kind: 'plan', catalog: catalog(), env: ENV,
    decideImpl: async ({ questions }) => {
      const value = chooseAll({ questions, choiceFor: (name) => name === 'worker_count' ? 'count_1' : 'profile_1' });
      value.answers.worker_count.confidence = 1.01;
      return value;
    },
  });
  assert.equal(malformed.status, 'invalid');
  assert.equal(malformed.recommendation, null);

  const failed = await proposePlannerDecision({
    team: team(), kind: 'plan', catalog: catalog(), env: ENV,
    decideImpl: async () => { throw new Error(`raw socket ${ENV.AF_TYPESAFE_API_KEY} https://private.example/path`); },
  });
  assert.equal(failed.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(failed), /raw socket|sk-advisor-test-secret|private\.example/);
});
