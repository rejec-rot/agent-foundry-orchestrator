// lib/trusted-import/ledger.mjs
//
// Authorization Ledger & Cumulative Closure Engine (§8.2, C1, C3).
// - Ledger stores provenance evidence (WHY an entry was authorized/denied), not authority itself.
// - Historical allowed records automatically become stale when scope grant revision advances (C1).
// - DENY items create blocking remediation obligations that cannot be ignored or auto-deleted (C3).
// - Cumulative closure check validates that all cumulative changes satisfy current policy and grant.

import { evaluateMechanicalGate } from './mechanical-gate.mjs';
import { computeManifestDigest } from './manifest.mjs';
import { AfrError } from './common.mjs';

// A closure is minted by the trusted ledger and consumed immediately by the
// promotion boundary. The process-local brand prevents a caller from cloning
// a plain object with { satisfied: true } and treating it as authorization.
const TRUSTED_AUTHORIZATION_CLOSURES = new WeakSet();

/**
 * Test whether a closure was actually minted by AuthorizationLedger.
 * @param {object} closure
 * @returns {boolean}
 */
export function isTrustedAuthorizationClosure(closure) {
  return Boolean(closure && typeof closure === 'object' && TRUSTED_AUTHORIZATION_CLOSURES.has(closure));
}

export class AuthorizationLedger {
  constructor() {
    /** @type {Array<object>} */
    this.records = [];
  }

  /**
   * Record an authorization decision in the ledger.
   *
   * @param {object} entry
   * @param {string} entry.path
   * @param {'ALLOW'|'DENY'|'WAITING_HUMAN'|'PENDING_VERIFIER'} entry.decision
   * @param {'A'|'B(i)'|'C'|'D'} entry.band
   * @param {number} entry.grantRevision
   * @param {string} entry.policyDigest
   * @param {string|null} [entry.selectorId]
   * @param {number|string} entry.candidateRevision
   * @param {string} [entry.reason]
   */
  record({
    path,
    decision,
    band,
    grantRevision,
    policyDigest,
    selectorId = null,
    candidateRevision,
    reason = '',
  }) {
    const item = Object.freeze({
      path,
      decision,
      band,
      grant_revision: grantRevision,
      policy_digest: policyDigest,
      selector_id: selectorId,
      candidate_revision: candidateRevision,
      reason,
      recorded_at: new Date().toISOString(),
    });
    this.records.push(item);
    return item;
  }

  /**
   * Record batch evaluation from Mechanical Gate.
   * @param {object} gateOutcome
   * @param {object} context
   * @param {number} context.grantRevision
   * @param {string} context.policyDigest
   * @param {number|string} context.candidateRevision
   */
  recordGateOutcome(gateOutcome, { grantRevision, policyDigest, candidateRevision }) {
    for (const d of gateOutcome.decisions) {
      this.record({
        path: d.path,
        decision: d.decision,
        band: d.band,
        grantRevision,
        policyDigest,
        selectorId: d.selector_id || null,
        candidateRevision,
        reason: d.reason,
      });
    }
  }

  /**
   * Get all ledger records.
   * @returns {ReadonlyArray<object>}
   */
  getAllRecords() {
    return Object.freeze([...this.records]);
  }

  /**
   * Get records for a specific path.
   * @param {string} path
   * @returns {Array<object>}
   */
  getRecordsForPath(path) {
    return this.records.filter((r) => r.path === path);
  }

  /**
   * Verify cumulative authorization closure against the current grant and policy (§8.2, C1, C3).
   *
   * Invariant:
   * ∀ entry ∈ cumulative_manifest: must be validly authorized under CURRENT grant and CURRENT policy.
   * Any DENY is a blocking remediation obligation (C3).
   *
   * @param {object} options
   * @param {object} options.cumulativeManifest - Cumulative Candidate Manifest
   * @param {object} options.currentScopeGrant - Active ScopeGrant
   * @param {object} options.currentPolicy - Active Canonical Policy
   * @param {string|null} [options.baselineOid=null] - Baseline commit bound to the closure
   * @param {Array<object>} [options.baselineCanonicalEntries=[]]
   * @param {Function} [options.fileContentResolver]
   * @returns {object} Closure verification outcome
   */
  verifyCumulativeClosure({
    cumulativeManifest,
    currentScopeGrant,
    currentPolicy,
    baselineOid = null,
    baselineCanonicalEntries = [],
    fileContentResolver = null,
    humanApproval = null,
  }) {
    // Re-evaluate cumulative manifest against current policy and current grant
    const gateOutcome = evaluateMechanicalGate({
      manifest: cumulativeManifest,
      scopeGrant: currentScopeGrant,
      policy: currentPolicy,
      baselineCanonicalEntries,
      fileContentResolver,
      humanApproval,
    });

    const isClosed =
      gateOutcome.blockingObligations.length === 0 &&
      gateOutcome.needsHuman.length === 0 &&
      gateOutcome.needsVerifier.length === 0;

    const closure = Object.freeze({
      satisfied: isClosed,
      verdict: gateOutcome.verdict,
      blockingObligations: gateOutcome.blockingObligations,
      needsHuman: gateOutcome.needsHuman,
      needsVerifier: gateOutcome.needsVerifier,
      allowed: gateOutcome.allowed,
      evaluatedCount: cumulativeManifest.changes.length,
      baseline_oid: baselineOid,
      cumulative_manifest_digest: computeManifestDigest(cumulativeManifest.changes),
      verified_at: new Date().toISOString(),
    });

    TRUSTED_AUTHORIZATION_CLOSURES.add(closure);
    return closure;
  }
}

/**
 * Revalidate a serialized authorization closure after a restart.
 *
 * The serialized object is never accepted as a trusted closure. Its baseline
 * and patch digest are checked against the exact current inputs, then a fresh
 * ledger instance evaluates and brands a new closure.
 */
export function revalidateAuthorizationClosure({
  persistedClosure = null,
  cumulativeManifest,
  currentScopeGrant,
  currentPolicy,
  baselineOid = null,
  baselineCanonicalEntries = [],
  fileContentResolver = null,
  humanApproval = null,
}) {
  if (!cumulativeManifest || !Array.isArray(cumulativeManifest.changes)) {
    throw new AfrError('cumulativeManifest is required for authorization revalidation', 'INVALID_ARGUMENT');
  }
  const patchDigest = computeManifestDigest(cumulativeManifest.changes);
  if (persistedClosure) {
    if (
      persistedClosure.baseline_oid !== baselineOid ||
      persistedClosure.cumulative_manifest_digest !== patchDigest
    ) {
      throw new AfrError(
        'Persisted authorization closure is stale for the current baseline or patch',
        'AUTHORIZATION_CLOSURE_STALE',
        {
          persistedBaselineOid: persistedClosure.baseline_oid,
          baselineOid,
          persistedManifestDigest: persistedClosure.cumulative_manifest_digest,
          patchDigest,
        }
      );
    }
  }

  const fresh = new AuthorizationLedger().verifyCumulativeClosure({
    cumulativeManifest,
    currentScopeGrant,
    currentPolicy,
    baselineOid,
    baselineCanonicalEntries,
    fileContentResolver,
    humanApproval,
  });
  return fresh;
}
