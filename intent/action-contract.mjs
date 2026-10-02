// action-contract.mjs - the single reader of contracts/action-types.json
//
// The contract file declares itself the single source of truth, and
// FINAL_ARCHITECTURE.md points at it as the canonical action whitelist. It
// declares FOUR lists:
//
//   action_types         target_asset_types         impact_scopes         gates
//
// Only `action_types` used to be read. The other three lived as hand-written
// copies inside the modules that enforce them (`intent/asset-classifier.mjs`,
// `intent/action-validator.mjs`), so the contract could drift from its
// enforcement while the architecture doc kept calling the file authoritative.
// That is the same defect class the earlier fix repaired for `action_types`
// alone - this module completes it for all four.
//
// FAIL-CLOSED, and specifically guarded against a partial contract:
//
//   Deriving an enum from an absent list yields `{}`, and a comparison such as
//   `required_gate === GATE_VERDICTS.WAITING_HUMAN` then evaluates
//   `undefined === undefined`-style false, which is fail-OPEN. A contract
//   missing `action_types` would still be caught by the schema check, but one
//   missing only `gates` would not. `isActionContractUsable()` therefore
//   requires ALL FOUR lists to be present and non-empty, and callers must refuse
//   to make a decision when it is false.
//
// @module action-contract

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/**
 * The action contract file.
 *
 * `AF_ACTION_CONTRACT` overrides it. That exists so the fail-closed path is
 * testable end-to-end (point a fresh process at a partial contract and assert it
 * refuses to decide) and so a deployment can pin its own contract without
 * editing the checkout.
 */
export const ACTION_CONTRACT_FILE = process.env.AF_ACTION_CONTRACT || join(ROOT, 'contracts', 'action-types.json');

/** The four lists the contract must declare for it to be usable. */
export const REQUIRED_CONTRACT_LISTS = Object.freeze([
  'action_types',
  'target_asset_types',
  'impact_scopes',
  'gates',
]);

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter((entry) => entry.trim() !== '');
}

/**
 * Read the action contract.
 *
 * A missing, unreadable or malformed file yields empty lists rather than being
 * masked with defaults: see `contractUsable`, which turns that into a refusal.
 *
 * @param {string} [file] - contract path (parameterised for tests).
 * @returns {{action_types: string[], target_asset_types: string[], impact_scopes: string[], gates: string[], source: string, error: string|null}}
 */
export function loadActionContract(file = ACTION_CONTRACT_FILE) {
  let parsed = null;
  let error = null;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    error = String(err?.message ?? err);
  }
  return {
    action_types: normalizeList(parsed?.action_types),
    target_asset_types: normalizeList(parsed?.target_asset_types),
    impact_scopes: normalizeList(parsed?.impact_scopes),
    gates: normalizeList(parsed?.gates),
    source: file,
    error,
  };
}

/**
 * Whether a loaded contract declares every required list.
 * @param {object} lists - a result from loadActionContract.
 * @returns {boolean} true when all four lists are present and non-empty.
 */
export function contractUsable(lists) {
  return REQUIRED_CONTRACT_LISTS.every((key) => Array.isArray(lists?.[key]) && lists[key].length > 0);
}

/**
 * Build the frozen enum object the rest of the codebase compares against.
 * The shape is deliberately identical to the hand-written constants it replaces
 * (`IMPACT_SCOPES.LOCAL`, `GATE_VERDICTS.WAITING_HUMAN`, ...).
 *
 * @param {string[]} list - values from the contract.
 * @returns {Record<string, string>} frozen value-to-value map.
 */
export function enumFrom(list) {
  return Object.freeze(Object.fromEntries((list ?? []).map((value) => [String(value), String(value)])));
}

const LOADED_CONTRACT = loadActionContract();

/** The lists as declared by the contract, verbatim. */
export const ACTION_CONTRACT = Object.freeze(LOADED_CONTRACT);

/** Canonical semantic action types. */
export const CANONICAL_ACTION_TYPES = Object.freeze([...LOADED_CONTRACT.action_types]);

/** Canonical target asset types. */
export const TARGET_ASSET_TYPES = enumFrom(LOADED_CONTRACT.target_asset_types);

/** Canonical impact scopes. */
export const IMPACT_SCOPES = enumFrom(LOADED_CONTRACT.impact_scopes);

/** Canonical gate verdicts. */
export const GATE_VERDICTS = enumFrom(LOADED_CONTRACT.gates);

/**
 * Whether the shipped contract is usable. Callers must refuse to decide when it
 * is not: an empty enum is a fail-OPEN comparison, not a fail-closed one.
 * @returns {boolean} true when every required list was read.
 */
export function isActionContractUsable() {
  return contractUsable(LOADED_CONTRACT);
}

/**
 * A precise reason for an unusable contract, for error messages.
 * @returns {string} human-readable reason.
 */
export function actionContractProblem() {
  if (LOADED_CONTRACT.error) {
    return `cannot read ${LOADED_CONTRACT.source}: ${LOADED_CONTRACT.error}`;
  }
  const missing = REQUIRED_CONTRACT_LISTS.filter(
    (key) => !Array.isArray(LOADED_CONTRACT[key]) || LOADED_CONTRACT[key].length === 0,
  );
  return missing.length > 0
    ? `${LOADED_CONTRACT.source} is missing or declares an empty list for: ${missing.join(', ')}`
    : '';
}
