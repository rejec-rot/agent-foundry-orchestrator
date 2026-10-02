// decision-model.mjs - ADVISORY decision-model adapter (default OFF).
//
// Jev (TypeSafe AI "System One") turns unstructured `state` into typed PROBABILISTIC decisions
// (Choice / Score / Noul) with calibrated confidence. It is a decision model, not a text/chat
// model: it never writes code and never produces free-form output.
//
// Where this may be used (advisory only):
//   classification / routing / scoring / escalation hints - "smart if-statements".
// Where this must NEVER be used (deterministic safety core):
//   boundary release eligibility, lock liveness, writer-scope decisions, the recovery
//   transaction phases, acceptance-command allowlisting. Those must stay mechanical, replayable
//   and auditable, so a probabilistic model has no place there. See the guard in
//   tests/decision-model.test.mjs which asserts no safety module imports this file.
//
// Fail-closed and default-off: with no mode (or an unknown one) `decide()` performs NO network
// call and returns `ok:false`, so callers MUST fall back to their deterministic behaviour. A
// missing key, a non-https endpoint, an invalid question or a transport error are all `ok:false`
// with a reason - never a guess and never a thrown error.
//
// The API key is read from the environment and is NEVER returned, logged or embedded in a result.

export const DECISION_MODEL_MODES = Object.freeze(['off', 'jev']);
export const SYSTEMONE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const DECISION_PRIMITIVES = Object.freeze(['choice', 'score', 'noul']);
export const DEFAULT_SYSTEMONE_MODEL = 'jev-latest';

function intEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the adapter configuration. Defaults fully closed.
 *
 * @returns {{ mode: 'off'|'jev', configured_mode: string, mode_valid: boolean, endpoint: string,
 *   model: string, timeout_ms: number, api_key_configured: boolean }}
 */
export function decisionModelConfig(env = process.env) {
  const configuredMode = env.AF_DECISION_MODEL ?? 'off';
  const mode = DECISION_MODEL_MODES.includes(configuredMode) ? configuredMode : 'off';
  return {
    mode,
    configured_mode: configuredMode,
    mode_valid: mode === configuredMode,
    endpoint: env.AF_TYPESAFE_ENDPOINT || SYSTEMONE_ENDPOINT,
    model: env.AF_TYPESAFE_MODEL || DEFAULT_SYSTEMONE_MODEL,
    timeout_ms: intEnv(env.AF_TYPESAFE_TIMEOUT_MS, 5000),
    api_key_configured: Boolean(env.AF_TYPESAFE_API_KEY),
  };
}

export const MAX_CHOICE_OPTIONS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;
/** Confidence bands (TypeSafe guidance): act / confirm / escalate. Thresholds scale with risk. */
export const CONFIDENCE_BANDS = Object.freeze({ HIGH: 0.8, MEDIUM: 0.5 });

/** Classify a confidence value into an action band. Noul answers have no confidence - pass a
 *  probability (p) or derive one; below MEDIUM the caller should not act on its own. */
export function confidenceBand(confidence) {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return 'unknown';
  if (confidence >= CONFIDENCE_BANDS.HIGH) return 'act';
  if (confidence >= CONFIDENCE_BANDS.MEDIUM) return 'confirm';
  return 'escalate';
}

function instructionsValid(instructions) {
  if (typeof instructions === 'string') return instructions.trim().length > 0;
  if (Array.isArray(instructions)) return instructions.length > 0;
  if (instructions && typeof instructions === 'object') return Object.keys(instructions).length > 0;
  return false;
}

/** Validate one question definition; returns { ok, reason }. */
function validateQuestion(name, question) {
  if (!question || typeof question !== 'object') return { ok: false, reason: `question "${name}" must be an object` };
  if (!DECISION_PRIMITIVES.includes(question.type)) return { ok: false, reason: `question "${name}" has an unsupported type (expected ${DECISION_PRIMITIVES.join('/')})` };
  if (!instructionsValid(question.instructions)) return { ok: false, reason: `question "${name}" needs non-empty instructions (string, object or array)` };
  if (question.type === 'choice') {
    const criteria = question.criteria;
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria) || Object.keys(criteria).length === 0) {
      return { ok: false, reason: `choice question "${name}" needs a non-empty criteria object` };
    }
    if (Object.keys(criteria).length > MAX_CHOICE_OPTIONS) {
      return { ok: false, reason: `choice question "${name}" has ${Object.keys(criteria).length} options (max ${MAX_CHOICE_OPTIONS})` };
    }
  }
  if (question.type === 'score') {
    if (!Array.isArray(question.criteria) || question.criteria.length < MIN_SCORE_LEVELS || question.criteria.length > MAX_SCORE_LEVELS) {
      return { ok: false, reason: `score question "${name}" needs ${MIN_SCORE_LEVELS}-${MAX_SCORE_LEVELS} levels` };
    }
  }
  if (question.type === 'noul' && question.criteria !== undefined) {
    const c = question.criteria;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, reason: `noul question "${name}" criteria must be an object ({ true, false })` };
  }
  return { ok: true };
}

/**
 * Build and validate the System One request body (the official `POST /v1/systemone` shape).
 * @returns {{ ok: boolean, body?: object, reason?: string }}
 */
export function buildSystemOneRequest({ state, questions, model = DEFAULT_SYSTEMONE_MODEL } = {}) {
  const stateOk = (typeof state === 'string' && state.trim())
    || (Array.isArray(state) && state.length > 0)
    || (state && typeof state === 'object' && Object.keys(state).length > 0);
  if (!stateOk) return { ok: false, reason: 'state must be a non-empty string, object or array' };
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
    return { ok: false, reason: 'questions must be a non-empty object' };
  }
  for (const [name, question] of Object.entries(questions)) {
    const valid = validateQuestion(name, question);
    if (!valid.ok) return { ok: false, reason: valid.reason };
  }
  return { ok: true, body: { state, model, questions } };
}

/** Keep only the typed fields the API defines; drop anything unexpected. */
function normalizeAnswer(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const out = { type: answer.type ?? null };
  if (typeof answer.choice === 'string') out.choice = answer.choice;
  if (typeof answer.score === 'number') out.score = answer.score;
  if (typeof answer.noul === 'number') out.noul = answer.noul;
  if (typeof answer.confidence === 'number') out.confidence = answer.confidence;
  if (answer.probabilities && typeof answer.probabilities === 'object') out.probabilities = answer.probabilities;
  if (answer.legend && typeof answer.legend === 'object') out.legend = answer.legend;
  return out;
}

/**
 * Ask the decision model. ADVISORY ONLY, default OFF, never throws.
 *
 * @param {object} params
 * @param {string} params.state - unstructured program state (never a secret).
 * @param {object} params.questions - { name: { type, instructions, criteria? } }.
 * @param {object} [params.deps] - `{ fetchImpl }` injection seam (tests never hit the network).
 * @param {object} [params.env]
 * @returns {Promise<{ ok: boolean, provider: 'off'|'jev', model: string|null, answers: object|null,
 *   usage: object|null, reason: string|null }>}
 */
export async function decide({ state, questions, deps = {}, env = process.env } = {}) {
  const cfg = decisionModelConfig(env);
  const off = { ok: false, provider: 'off', model: null, answers: null, usage: null, reason: 'decision model is off' };
  if (cfg.mode === 'off') return { ...off, reason: cfg.mode_valid ? 'decision model is off' : `unknown mode "${cfg.configured_mode}" is treated as off` };

  // Everything below only runs when the operator explicitly opted into jev.
  if (!/^https:\/\//i.test(cfg.endpoint)) {
    return { ok: false, provider: 'jev', model: null, answers: null, usage: null, reason: 'endpoint must use https' };
  }
  const apiKey = env.AF_TYPESAFE_API_KEY;
  if (!apiKey) {
    return { ok: false, provider: 'jev', model: null, answers: null, usage: null, reason: 'AF_TYPESAFE_API_KEY is not configured' };
  }
  const built = buildSystemOneRequest({ state, questions, model: cfg.model });
  if (!built.ok) {
    return { ok: false, provider: 'jev', model: null, answers: null, usage: null, reason: built.reason };
  }

  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const maxRetries = Number.isInteger(deps.maxRetries) ? deps.maxRetries : 2;
  const retryable = new Set([429, 529]);

  let response;
  let lastReason = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);
    try {
      response = await doFetch(cfg.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(built.body),
        signal: controller.signal,
      });
    } catch (err) {
      lastReason = err?.name === 'AbortError' ? `timed out after ${cfg.timeout_ms}ms` : `request failed: ${err?.message ?? err}`;
      response = null;
    } finally {
      clearTimeout(timer);
    }
    if (response && response.ok === true) break;
    const status = response?.status;
    if (status !== undefined && !retryable.has(status)) break; // only 429/529 are worth retrying
    if (attempt === maxRetries) break;
    await sleep(200 * (2 ** attempt)); // bounded exponential backoff
  }

  if (!response || response.ok !== true) {
    const status = response?.status;
    return { ok: false, provider: 'jev', model: null, answers: null, usage: null, reason: status !== undefined ? `unexpected status ${status}` : (lastReason ?? 'request failed') };
  }
  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return { ok: false, provider: 'jev', model: null, answers: null, usage: null, reason: `response was not JSON: ${err?.message ?? err}` };
  }
  if (!payload || typeof payload !== 'object' || !payload.answers || typeof payload.answers !== 'object') {
    return { ok: false, provider: 'jev', model: null, answers: null, usage: null, reason: 'response did not contain typed answers' };
  }
  const answers = {};
  for (const [name, answer] of Object.entries(payload.answers)) answers[name] = normalizeAnswer(answer);
  // NOTE: the api key is deliberately absent from the result - only the model name and usage.
  return { ok: true, provider: 'jev', model: payload.model ?? cfg.model, answers, usage: payload.usage ?? null, reason: null };
}

/**
 * Advisory example consumer: suggest a class for an executor error from its stderr.
 *
 * This is a hint only - the deterministic classifier stays authoritative. Returns `ok:false`
 * (caller keeps its own classification) whenever the model is off/unavailable.
 *
 * @returns {Promise<{ ok: boolean, choice: string|null, confidence: number|null, reason: string|null }>}
 */
export async function adviseErrorClass({ stderr, classes = [], deps = {}, env = process.env } = {}) {
  if (!Array.isArray(classes) || classes.length === 0) return { ok: false, choice: null, confidence: null, reason: 'no candidate classes were provided' };
  const criteria = Object.fromEntries(classes.map((name) => [name, name]));
  const res = await decide({
    state: String(stderr ?? '').slice(0, 8000),
    questions: { error_class: { type: 'choice', instructions: 'Which class best describes this executor error?', criteria } },
    deps,
    env,
  });
  if (!res.ok) return { ok: false, choice: null, confidence: null, reason: res.reason };
  const answer = res.answers?.error_class ?? null;
  return { ok: true, choice: answer?.choice ?? null, confidence: answer?.confidence ?? null, reason: null };
}
