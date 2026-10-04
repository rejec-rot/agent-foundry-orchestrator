// error-advisory.mjs - OPTIONAL advisory overlay for the deterministic error classifier.
//
// The deterministic `classifyExecutionError()` is and stays authoritative: it decides
// `category` / `retryable` / `safety_action`, and it is what the circuit breaker records. This
// overlay only ATTACHES an advisory hint (from the decision model) for observability, so an
// operator can see where the model agrees or disagrees.
//
// Hard rules (guarded by tests):
//   * default OFF: with the model off, the classification object is returned UNCHANGED (same
//     reference) and no network call is made;
//   * the advisory NEVER alters category/retryable/safety_action - a disagreement is recorded
//     explicitly (`disagrees: true`), never applied;
//   * fail-closed: any model failure leaves the deterministic classification untouched.

import { ERROR_CATEGORIES } from './executor-error-classifier.mjs';
import { decisionModelConfig, decide, confidenceBand } from './decision-model.mjs';
import { redactSecrets } from './boundary-notify.mjs';

export const ERROR_ADVISORY_SCHEMA = 'af-error-advisory-v1';

/** Failure categories the model may suggest (SUCCESS is not an error class). */
export const ADVISORY_CANDIDATES = Object.freeze(
  Object.values(ERROR_CATEGORIES).filter((category) => category !== ERROR_CATEGORIES.SUCCESS),
);

const EXECUTOR_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PUBLIC_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const MAX_STDERR = 2_000;

function safeExecutorId(value, env) {
  const apiKey = typeof env?.AF_TYPESAFE_API_KEY === 'string' ? env.AF_TYPESAFE_API_KEY : '';
  return typeof value === 'string' && EXECUTOR_ID.test(value) && !(apiKey && value.includes(apiKey)) ? value : 'unknown';
}

function safeModelId(value, env) {
  if (typeof value !== 'string' || !PUBLIC_MODEL_ID.test(value) || value.includes('://') || /^(?:sk-|tk_|bearer\b)/i.test(value)) return null;
  if (typeof env?.AF_TYPESAFE_API_KEY === 'string' && env.AF_TYPESAFE_API_KEY && value.includes(env.AF_TYPESAFE_API_KEY)) return null;
  return value;
}

function safeStderr(value, env) {
  let output;
  try { output = String(value ?? ''); } catch { return ''; }
  output = redactSecrets(output, { maxLength: null });
  const apiKey = typeof env?.AF_TYPESAFE_API_KEY === 'string' ? env.AF_TYPESAFE_API_KEY : '';
  if (apiKey) output = output.split(apiKey).join('<redacted>');
  output = output.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>;,!?(){}\[\]]+/g, '<redacted-path>');
  output = output.replace(/\/(?:[^\s"'<>;,!?(){}\[\]]+\/)*[^\s"'<>;,!?(){}\[\]]+/g, (path) => path === '/' ? path : '<redacted-path>');
  return output.slice(0, MAX_STDERR).trim();
}

function confidenceValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function noulValue(answer) {
  return answer?.type === 'noul' && typeof answer.noul === 'number'
    && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1 ? answer.noul : null;
}

function scoreValue(answer) {
  return answer?.type === 'score' && typeof answer.score === 'number'
    && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= 3 ? answer.score : null;
}

/**
 * Attach an advisory hint to a classification, without changing it.
 *
 * @returns {Promise<object>} the SAME classification when off/unavailable, otherwise a shallow
 *   copy with an added `advisory` field. `category`/`retryable`/`safety_action` are never changed.
 */
export async function withErrorAdvisory({ executorType = null, classification = null, evidence = {}, deps = {}, env = process.env } = {}) {
  if (!classification || typeof classification !== 'object') return classification;
  if (classification.category === ERROR_CATEGORIES.SUCCESS) return classification;

  const cfg = decisionModelConfig(env);
  if (cfg.mode === 'off') return classification; // unchanged object, no network

  const stderr = safeStderr(evidence.stderr, env);
  if (!stderr) return classification; // nothing for the model to read

  const criteria = Object.fromEntries(ADVISORY_CANDIDATES.map((name) => [name, name]));
  const exitCode = Number.isInteger(evidence.exit_code) ? evidence.exit_code : null;
  const decisionEnv = { ...env, AF_TYPESAFE_TIMEOUT_MS: String(Math.min(cfg.timeout_ms, 3_000)) };
  const decisionDeps = { ...deps, maxRetries: 0 };
  // Speculative fan-out (TypeSafe pattern): ask every judgment a caller might need in ONE call.
  // Additive questions barely change latency, and the code picks which answers to use.
  let res;
  try {
    res = await decide({
      state: {
        executor: safeExecutorId(executorType, env),
        exit_code: exitCode,
        output: stderr,
      },
      questions: {
        suggested_category: { type: 'choice', instructions: 'Which error class does the output best fit?', criteria },
        retryable_hint: { type: 'noul', instructions: 'Is this failure likely transient and safe to retry soon?' },
        suspected_account_ban: { type: 'noul', instructions: 'Does the output suggest the account is suspended or blocked by policy/ToS (e.g. 403)?' },
        severity: { type: 'score', instructions: 'How severe is this failure for the workflow?', criteria: ['trivial', 'minor', 'moderate', 'severe'] },
      },
      deps: decisionDeps,
      env: decisionEnv,
    });
  } catch {
    return classification;
  }
  if (!res.ok) return classification; // fail closed: deterministic result stands

  const category = res.answers?.suggested_category ?? null;
  if (category?.type !== 'choice' || !ADVISORY_CANDIDATES.includes(category.choice)) return classification;
  const categoryConfidence = confidenceValue(category.confidence);

  return {
    ...classification,
    advisory: {
      schema_version: ERROR_ADVISORY_SCHEMA,
      model: safeModelId(cfg.model, env),
      suggested_category: category.choice,
      category_confidence: categoryConfidence,
      category_band: confidenceBand(categoryConfidence),
      retryable_hint: noulValue(res.answers?.retryable_hint),
      suspected_account_ban: noulValue(res.answers?.suspected_account_ban),
      severity: scoreValue(res.answers?.severity),
      deterministic_category: classification.category,
      disagrees: category.choice !== classification.category,
      // advisory only: the fields below are NOT derived from the model
      applies_to: ['observability'],
    },
  };
}
