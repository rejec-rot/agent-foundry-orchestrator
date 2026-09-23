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

export const ERROR_ADVISORY_SCHEMA = 'af-error-advisory-v1';

/** Failure categories the model may suggest (SUCCESS is not an error class). */
export const ADVISORY_CANDIDATES = Object.freeze(
  Object.values(ERROR_CATEGORIES).filter((category) => category !== ERROR_CATEGORIES.SUCCESS),
);

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

  const stderr = String(evidence.stderr ?? '').trim();
  if (!stderr) return classification; // nothing for the model to read

  const criteria = Object.fromEntries(ADVISORY_CANDIDATES.map((name) => [name, name]));
  // Speculative fan-out (TypeSafe pattern): ask every judgment a caller might need in ONE call.
  // Additive questions barely change latency, and the code picks which answers to use.
  const res = await decide({
    state: {
      executor: executorType ?? 'unknown',
      exit_code: evidence.exit_code ?? null,
      output: stderr,
    },
    questions: {
      suggested_category: { type: 'choice', instructions: 'Which error class does the output best fit?', criteria },
      retryable_hint: { type: 'noul', instructions: 'Is this failure likely transient and safe to retry soon?' },
      suspected_account_ban: { type: 'noul', instructions: 'Does the output suggest the account is suspended or blocked by policy/ToS (e.g. 403)?' },
      severity: { type: 'score', instructions: 'How severe is this failure for the workflow?', criteria: ['trivial', 'minor', 'moderate', 'severe'] },
    },
    deps,
    env,
  });
  if (!res.ok) return classification; // fail closed: deterministic result stands

  const category = res.answers?.suggested_category ?? null;
  if (!category?.choice) return classification;

  return {
    ...classification,
    advisory: {
      schema_version: ERROR_ADVISORY_SCHEMA,
      model: res.model,
      suggested_category: category.choice,
      category_confidence: category.confidence ?? null,
      category_band: confidenceBand(category.confidence),
      retryable_hint: res.answers?.retryable_hint?.noul ?? null,
      suspected_account_ban: res.answers?.suspected_account_ban?.noul ?? null,
      severity: res.answers?.severity?.score ?? null,
      deterministic_category: classification.category,
      disagrees: category.choice !== classification.category,
      // advisory only: the fields below are NOT derived from the model
      applies_to: ['observability'],
    },
  };
}
