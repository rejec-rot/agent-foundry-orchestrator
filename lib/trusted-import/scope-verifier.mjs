// lib/trusted-import/scope-verifier.mjs
//
// Scope Verifier Interface & Fail-Closed Gate D Escalation (§8.1, TI-22).
// Invariant:
// - Applicant != Approver: Verifier is independent of planner and executor.
// - No Qualified Verifier -> Fail-Closed to Gate D (Human Gate), never auto-approve (TI-22).
// - Scope expansion advances scope_rev (TI-20).

import { AfrError } from './common.mjs';
import { createScopeGrant, verifyScopeGrantIntegrity } from './scope-grant.mjs';

/**
 * Process Band C out-of-scope entries through Scope Verifier or fail closed to Gate D.
 *
 * @param {object} options
 * @param {Array<object>} options.pendingEntries - Array of { path, action }
 * @param {Function|null} [options.verifierFn=null] - (entries, context) => Promise<Array<{ path, decision: 'APPROVE'|'DENY', reason }>>
 * @param {object} options.scopeGrant - Current ScopeGrant
 * @param {object} options.policy - Canonical trusted policy
 * @param {string} options.taskId - Task ID
 * @returns {Promise<object>} Outcome containing updated grant or Gate D escalations
 */
export async function verifyScopeExpansion({
  pendingEntries = [],
  verifierFn = null,
  scopeGrant,
  policy,
  taskId,
}) {
  if (!scopeGrant || !policy || typeof taskId !== 'string' || taskId.length === 0) {
    throw new AfrError('scopeGrant and policy are required', 'INVALID_ARGUMENT');
  }

  const scopeIntegrity = verifyScopeGrantIntegrity(scopeGrant, {
    taskId,
    planRev: scopeGrant.plan_rev,
    canonicalOid: scopeGrant.canonical_oid,
    policy,
  });
  if (!scopeIntegrity.valid) {
    throw new AfrError(
      `Scope Grant integrity verification failed: ${scopeIntegrity.reason}`,
      'SCOPE_GRANT_INVALID',
      { reason: scopeIntegrity.reason }
    );
  }

  if (pendingEntries.length === 0) {
    return {
      status: 'NO_OP',
      scopeGrant,
      decisions: [],
      escalatedToHuman: false,
    };
  }

  // TI-22 Invariant: No qualified verifier -> fail-closed to Band D (Human Gate)
  if (!verifierFn || typeof verifierFn !== 'function') {
    const humanDecisions = pendingEntries.map((e) => ({
      path: e.path,
      action: e.action,
      band: 'D',
      decision: 'WAITING_HUMAN',
      reason: 'No qualified scope verifier available; escalated fail-closed to Human Gate (TI-22)',
      selector_id: 'no_verifier_fallback',
    }));

    return {
      status: 'ESCALATED_TO_HUMAN',
      scopeGrant,
      decisions: humanDecisions,
      escalatedToHuman: true,
      reason: 'NO_QUALIFIED_VERIFIER',
    };
  }

  const escalateMalformedVerifierOutput = (reason, error = null) => {
    const humanDecisions = pendingEntries.map((e) => ({
      path: e.path,
      action: e.action,
      band: 'D',
      decision: 'WAITING_HUMAN',
      reason: `${reason}; escalated fail-closed to Human Gate (TI-22)`,
      selector_id: 'verifier_malformed_output',
    }));
    return {
      status: 'ESCALATED_TO_HUMAN',
      scopeGrant,
      decisions: humanDecisions,
      escalatedToHuman: true,
      reason: 'VERIFIER_MALFORMED_OUTPUT',
      error,
    };
  };

  let verifierDecisions;
  try {
    verifierDecisions = await verifierFn(pendingEntries, { taskId, scopeGrant, policy });
    if (!Array.isArray(verifierDecisions)) {
      throw new Error('Verifier returned non-array result');
    }
  } catch (err) {
    // Verifier error / crash / malformed output -> Fail-closed to Human Gate (TI-22)
    return {
      status: 'ESCALATED_TO_HUMAN',
      scopeGrant,
      decisions: pendingEntries.map((e) => ({
        path: e.path,
        action: e.action,
        band: 'D',
        decision: 'WAITING_HUMAN',
        reason: `Scope verifier execution error: ${err.message}; escalated fail-closed to Human Gate (TI-22)`,
        selector_id: 'verifier_error_fallback',
      })),
      escalatedToHuman: true,
      reason: 'VERIFIER_EXECUTION_ERROR',
      error: err.message,
    };
  }

  // A verifier may only decide the exact entries it was given, exactly once.
  // Unknown, duplicate, missing, or malformed responses cannot expand scope.
  const pendingByPath = new Map();
  for (const entry of pendingEntries) {
    if (!entry || typeof entry.path !== 'string' || pendingByPath.has(entry.path)) {
      return escalateMalformedVerifierOutput('Pending verifier input is malformed');
    }
    pendingByPath.set(entry.path, entry);
  }

  const seenPaths = new Set();
  for (const dec of verifierDecisions) {
    if (
      !dec ||
      typeof dec.path !== 'string' ||
      !pendingByPath.has(dec.path) ||
      seenPaths.has(dec.path) ||
      (dec.decision !== 'APPROVE' && dec.decision !== 'DENY')
    ) {
      return escalateMalformedVerifierOutput('Scope verifier returned an unknown, duplicate, or invalid decision');
    }
    seenPaths.add(dec.path);
  }
  if (seenPaths.size !== pendingByPath.size) {
    return escalateMalformedVerifierOutput('Scope verifier did not decide every pending entry');
  }

  const approvedPaths = [];
  const deniedPaths = [];
  const decisions = [];

  for (const dec of verifierDecisions) {
    if (dec.decision === 'APPROVE') {
      approvedPaths.push(dec.path);
      decisions.push({
        path: dec.path,
        band: 'C',
        decision: 'ALLOW',
        reason: dec.reason || 'Approved by Scope Verifier',
      });
    } else {
      deniedPaths.push(dec.path);
      decisions.push({
        path: dec.path,
        band: 'C',
        decision: 'DENY',
        reason: dec.reason || 'Denied by Scope Verifier',
      });
    }
  }

  // If new paths were approved, advance scope revision (TI-20)
  let updatedGrant = scopeGrant;
  if (approvedPaths.length > 0) {
    try {
      updatedGrant = createScopeGrant({
        taskId: scopeGrant.task_id,
        planRev: scopeGrant.plan_rev,
        canonicalOid: scopeGrant.canonical_oid,
        scopeRev: (scopeGrant.scope_rev || 1) + 1,
        proposedRequired: [...scopeGrant.granted_write_set, ...approvedPaths],
        policy,
      });
    } catch (err) {
      return escalateMalformedVerifierOutput(`Verifier-approved scope could not be admitted: ${err.message}`, err.message);
    }
  }

  return {
    status: deniedPaths.length > 0 ? 'PARTIAL_OR_DENIED' : 'APPROVED',
    scopeGrant: updatedGrant,
    decisions,
    approvedPaths,
    deniedPaths,
    escalatedToHuman: false,
  };
}
