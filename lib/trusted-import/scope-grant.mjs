// lib/trusted-import/scope-grant.mjs
//
// Scope Grant Model & Trusted Admission (§5, §5.1).
// Planner only has application capability (proposed_required, proposed_anticipated).
// Trusted Scope Validator admits paths only within policy.allowed_root and outside forbidden,
// producing a cryptographically bound, immutable Scope Grant (TI-9, C5).

import { AdmissionError, sha256 } from './common.mjs';
import { matchPathPattern } from './projection.mjs';

/**
 * Validate proposed paths against trusted policy admission rules and mint a Scope Grant.
 *
 * @param {object} options
 * @param {string} options.taskId - Bound Task ID
 * @param {number} [options.planRev=1] - Bound Plan Revision
 * @param {string} options.canonicalOid - Bound Canonical Commit OID
 * @param {number} [options.scopeRev=1] - Incremental Scope Revision
 * @param {string[]} [options.proposedRequired=[]] - Required paths proposed by planner
 * @param {string[]} [options.proposedAnticipated=[]] - Anticipated paths proposed by planner
 * @param {object} options.policy - Canonical trusted policy
 * @returns {object} Frozen ScopeGrant
 */
export function createScopeGrant({
  taskId,
  planRev = 1,
  canonicalOid,
  scopeRev = 1,
  proposedRequired = [],
  proposedAnticipated = [],
  policy,
}) {
  if (!taskId || !canonicalOid || !policy || !policy.bundle_digest) {
    throw new AdmissionError('taskId, canonicalOid, and canonical policy are required', 'INVALID_ARGUMENT');
  }

  const allProposed = [...new Set([...proposedRequired, ...proposedAnticipated])];

  // Admission Rule 1 & 2: proposed_* ⊆ policy.allowed_root, and not forbidden
  for (const proposed of allProposed) {
    // 1. Forbidden check
    const isForbidden = policy.forbidden.some((pat) => matchPathPattern(pat, proposed));
    if (isForbidden) {
      throw new AdmissionError(
        `Proposed path "${proposed}" hits trusted policy forbidden rule`,
        'PROPOSED_PATH_FORBIDDEN',
        { path: proposed }
      );
    }

    // 2. Allowed root subset check
    const isAllowed = policy.allowed_root.some((pat) => matchPathPattern(pat, proposed));
    if (!isAllowed) {
      throw new AdmissionError(
        `Proposed path "${proposed}" is outside trusted policy allowed_root`,
        'PROPOSED_OUTSIDE_ALLOWED_ROOT',
        { path: proposed, allowed_root: policy.allowed_root }
      );
    }
  }

  const grantedWriteSet = [...allProposed].sort();
  const scopeDigest = sha256(JSON.stringify(grantedWriteSet));

  // Three-point anchoring: task_id + plan_rev + canonical_oid + scope_rev + scope_digest + policy_bundle_digest
  const bindingPayload = [
    taskId,
    planRev,
    canonicalOid,
    scopeRev,
    scopeDigest,
    policy.bundle_digest,
  ].join(':');
  const writeScopeBinding = sha256(bindingPayload);

  return Object.freeze({
    task_id: taskId,
    plan_rev: planRev,
    canonical_oid: canonicalOid,
    scope_rev: scopeRev,
    granted_write_set: Object.freeze(grantedWriteSet),
    scope_digest: scopeDigest,
    write_scope_binding: writeScopeBinding,
    policy_bundle_digest: policy.bundle_digest,
    granted_at: new Date().toISOString(),
  });
}

/**
 * Validate that a Scope Grant remains authentic and unbroken (TI-9).
 * Any change to plan_rev, canonical_oid, granted_write_set, or policy invalidates the grant.
 *
 * @param {object} grant - The active ScopeGrant
 * @param {object} context - Current execution context
 * @param {string} context.taskId
 * @param {number} context.planRev
 * @param {string} context.canonicalOid
 * @param {object} context.policy
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyScopeGrantIntegrity(grant, { taskId, planRev, canonicalOid, policy }) {
  if (
    !grant ||
    typeof grant !== 'object' ||
    typeof grant.task_id !== 'string' ||
    grant.task_id.length === 0 ||
    !Number.isInteger(grant.plan_rev) ||
    typeof grant.canonical_oid !== 'string' ||
    grant.canonical_oid.length === 0 ||
    !Number.isInteger(grant.scope_rev) ||
    !Array.isArray(grant.granted_write_set) ||
    typeof grant.scope_digest !== 'string' ||
    typeof grant.write_scope_binding !== 'string' ||
    !policy ||
    typeof policy.bundle_digest !== 'string'
  ) {
    return { valid: false, reason: 'Scope grant missing' };
  }

  if (grant.granted_write_set.some((pattern) => typeof pattern !== 'string')) {
    return { valid: false, reason: 'Scope grant contains a non-string path pattern' };
  }

  if (grant.task_id !== taskId) {
    return { valid: false, reason: `Task ID mismatch (grant: ${grant.task_id}, context: ${taskId})` };
  }

  if (grant.plan_rev !== planRev) {
    return { valid: false, reason: `Plan revision mismatch (grant: ${grant.plan_rev}, context: ${planRev})` };
  }

  if (grant.canonical_oid !== canonicalOid) {
    return { valid: false, reason: `Canonical OID mismatch (grant: ${grant.canonical_oid}, context: ${canonicalOid})` };
  }

  if (grant.policy_bundle_digest !== policy.bundle_digest) {
    return { valid: false, reason: 'Policy bundle digest mismatch (policy was updated)' };
  }

  // Verify internal integrity of write_scope_binding
  let recomputedScopeDigest;
  try {
    recomputedScopeDigest = sha256(JSON.stringify(grant.granted_write_set));
  } catch {
    return { valid: false, reason: 'Scope grant write set is not serializable' };
  }
  if (recomputedScopeDigest !== grant.scope_digest) {
    return { valid: false, reason: 'Scope digest tamper detected' };
  }

  const expectedBinding = sha256([
    grant.task_id,
    grant.plan_rev,
    grant.canonical_oid,
    grant.scope_rev,
    recomputedScopeDigest,
    policy.bundle_digest,
  ].join(':'));

  if (expectedBinding !== grant.write_scope_binding) {
    return { valid: false, reason: 'Write scope binding anchor corrupt or altered' };
  }

  return { valid: true };
}

/**
 * Test whether a target path is covered by the granted write set.
 * @param {string} path
 * @param {object} grant - ScopeGrant
 * @returns {boolean}
 */
export function isPathInScope(path, grant) {
  if (!grant || !Array.isArray(grant.granted_write_set)) return false;
  return grant.granted_write_set.some((pattern) => matchPathPattern(pattern, path));
}
