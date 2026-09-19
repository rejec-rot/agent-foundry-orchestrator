// lib/trusted-import/human-gate.mjs
//
// Human Gate D Operator Integration (§5, §8.1).
// Resolves WAITING_HUMAN items through authenticated operator approvals,
// producing immutable audit signatures for the Authorization Ledger.

import { AfrError, sha256 } from './common.mjs';

const TRUSTED_HUMAN_APPROVALS = new WeakSet();

/**
 * Test whether an approval outcome was minted by approveHumanGate.
 * @param {object} approval
 * @returns {boolean}
 */
export function isTrustedHumanApproval(approval) {
  return Boolean(approval && typeof approval === 'object' && TRUSTED_HUMAN_APPROVALS.has(approval));
}

/**
 * Approve pending Human Gate (Band D) decisions.
 *
 * @param {object} options
 * @param {Array<object>} options.pendingDecisions - Entries classified under Band D
 * @param {string} options.operatorIdentity - Identity supplied by the authenticated control plane
 * @param {string} options.justification - Human-readable approval reason
 * @param {Function} options.operatorAuthenticator - Trusted control-plane callback that authenticates and signs the approval
 * @returns {object} Approval outcome with cryptographic audit evidence
 */
export function approveHumanGate({
  pendingDecisions = [],
  operatorIdentity,
  justification,
  operatorAuthenticator = null,
}) {
  if (!Array.isArray(pendingDecisions) || pendingDecisions.length === 0) {
    throw new AfrError('pendingDecisions must be a non-empty array', 'INVALID_ARGUMENT');
  }
  if (typeof operatorIdentity !== 'string' || operatorIdentity.trim() === '') {
    throw new AfrError('operatorIdentity is required', 'HUMAN_AUTH_REQUIRED');
  }
  if (typeof justification !== 'string' || justification.trim() === '') {
    throw new AfrError('justification is required', 'INVALID_ARGUMENT');
  }
  if (typeof operatorAuthenticator !== 'function') {
    throw new AfrError(
      'An authenticated operator callback is required for Human Gate approval',
      'HUMAN_AUTH_REQUIRED'
    );
  }

  const approvedPaths = [];
  const resolvedDecisions = [];

  for (const item of pendingDecisions) {
    if (item.band !== 'D' || item.decision !== 'WAITING_HUMAN') {
      throw new AfrError(`Item for path "${item.path}" is not in WAITING_HUMAN state`, 'INVALID_GATE_STATE');
    }
    approvedPaths.push(item.path);
    resolvedDecisions.push({
      path: item.path,
      action: item.action,
      band: 'D',
      decision: 'ALLOW',
      operator: operatorIdentity,
      justification,
      selector_id: item.selector_id || null,
    });
  }

  const approvedAt = new Date().toISOString();
  const signedDecisions = [...resolvedDecisions]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((item) => ({
      path: item.path,
      action: item.action,
      band: item.band,
      selector_id: item.selector_id,
    }));
  const auditPayload = JSON.stringify({
    operator: operatorIdentity,
    justification,
    decisions: signedDecisions,
    approved_at: approvedAt,
  });
  const auditDigest = sha256(auditPayload);

  let authentication;
  try {
    authentication = operatorAuthenticator({
      operatorIdentity,
      justification,
      approvedPaths: [...approvedPaths].sort(),
      auditDigest,
      auditPayload,
    });
  } catch (err) {
    throw new AfrError(`Operator authentication failed: ${err.message}`, 'HUMAN_AUTH_FAILED');
  }

  if (
    !authentication ||
    authentication.verified !== true ||
    typeof authentication.signature !== 'string' ||
    authentication.signature.length === 0
  ) {
    throw new AfrError('Operator authentication did not produce a verified signature', 'HUMAN_AUTH_FAILED');
  }

  const approvalEvidence = Object.freeze({
    signature: authentication.signature,
    signature_key_id: authentication.keyId || null,
    audit_digest: auditDigest,
    operator: operatorIdentity,
    justification,
    approved_paths: Object.freeze([...approvedPaths].sort()),
    approved_at: approvedAt,
  });

  const outcome = Object.freeze({
    approved: true,
    decisions: Object.freeze(resolvedDecisions),
    approval_evidence: approvalEvidence,
  });

  TRUSTED_HUMAN_APPROVALS.add(outcome);
  return outcome;
}

/**
 * Re-authenticate a serialized Human Gate outcome after a process restart.
 *
 * WeakSet branding is intentionally process-local. A persisted approval is
 * therefore only a record of the operator's previous intent; the current
 * pending paths must match exactly and the authenticated control plane must
 * mint a fresh trusted outcome.
 */
export function revalidateHumanApproval({
  persistedApproval,
  pendingDecisions = [],
  operatorAuthenticator = null,
}) {
  if (!persistedApproval || typeof persistedApproval !== 'object') {
    throw new AfrError('Persisted Human Gate approval is required', 'HUMAN_APPROVAL_STALE');
  }
  const persistedPaths = persistedApproval.approval_evidence?.approved_paths;
  const operator = persistedApproval.operator ?? persistedApproval.approval_evidence?.operator;
  const justification = persistedApproval.justification ?? persistedApproval.approval_evidence?.justification;
  const currentPaths = pendingDecisions
    .filter((item) => item?.band === 'D' && item?.decision === 'WAITING_HUMAN')
    .map((item) => item.path)
    .sort();
  if (
    !Array.isArray(persistedPaths) ||
    JSON.stringify([...persistedPaths].sort()) !== JSON.stringify(currentPaths) ||
    typeof operator !== 'string' ||
    persistedApproval.approval_evidence?.operator !== operator ||
    typeof justification !== 'string' ||
    typeof persistedApproval.approval_evidence?.audit_digest !== 'string'
  ) {
    throw new AfrError(
      'Persisted Human Gate approval is stale for the current pending decisions',
      'HUMAN_APPROVAL_STALE'
    );
  }

  return approveHumanGate({
    pendingDecisions,
    operatorIdentity: operator,
    justification,
    operatorAuthenticator,
  });
}
