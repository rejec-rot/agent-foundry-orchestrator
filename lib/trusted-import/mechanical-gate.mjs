// lib/trusted-import/mechanical-gate.mjs
//
// The Four-Band Mechanical Policy Funnel (§5).
// Evaluates Candidate Manifest entries strictly by deterministic rules:
// - Band A: In-scope & non-protected -> Mechanical Allow (no model, TI-4, TI-20)
// - Band B(i): Hard Deny (forbidden, import.deny, collision) -> Deterministic Deny (TI-5)
// - Band B(ii): Deliberately empty (no silent bypass) (TI-6)
// - Band C: Out-of-scope & not B(i) -> Requires Scope Verifier (TI-7)
// - Band D: Protected path / protected_json / control-plane -> Human Gate (TI-8, TI-19)

import { HardDenyError } from './common.mjs';
import { isTrustedHumanApproval } from './human-gate.mjs';
import { matchPathPattern } from './projection.mjs';
import { isPathInScope, verifyScopeGrantIntegrity } from './scope-grant.mjs';
import { evaluateProtectedJson } from './policy.mjs';
import { targetNamespacePreflight } from './preflight.mjs';

/**
 * Classify manifest changes across the Four-Band Funnel.
 *
 * @param {object} options
 * @param {object} options.manifest - Candidate Manifest
 * @param {object} options.scopeGrant - Active ScopeGrant
 * @param {object} options.policy - Canonical trusted policy
 * @param {Array<object>} [options.baselineCanonicalEntries=[]] - All baseline canonical entries for preflight
 * @param {Function} [options.fileContentResolver] - (path, 'old'|'new') => Buffer|string|null
 * @returns {object} Funnel evaluation outcome
 */
export function evaluateMechanicalGate({
  manifest,
  scopeGrant,
  policy,
  baselineCanonicalEntries = [],
  fileContentResolver = null,
  humanApproval = null,
}) {
  if (!manifest || !scopeGrant || !policy) {
    throw new HardDenyError('manifest, scopeGrant, and policy are required', { code: 'INVALID_ARGUMENT' });
  }

  // Band D can only be resolved by a HUMAN decision that was minted by the trusted Human Gate
  // (human-gate.mjs brands its outcomes in a process-local WeakSet). A plain object that merely
  // LOOKS like an approval is ignored, so a task can never self-approve its own protected paths.
  const approvedByHuman = new Map();
  if (isTrustedHumanApproval(humanApproval)) {
    for (const item of humanApproval.decisions ?? []) {
      if (item?.band === 'D' && item?.decision === 'ALLOW' && typeof item.path === 'string') {
        approvedByHuman.set(item.path, item);
      }
    }
  }

  const scopeIntegrity = verifyScopeGrantIntegrity(scopeGrant, {
    taskId: scopeGrant.task_id,
    planRev: scopeGrant.plan_rev,
    canonicalOid: scopeGrant.canonical_oid,
    policy,
  });
  if (!scopeIntegrity.valid) {
    throw new HardDenyError(
      `Scope Grant integrity verification failed: ${scopeIntegrity.reason}`,
      { code: 'SCOPE_GRANT_INVALID', reason: scopeIntegrity.reason }
    );
  }

  // 1. Execute Target Namespace Preflight (§10.1, 1.6, TI-29)
  targetNamespacePreflight({
    baselineCanonicalEntries,
    candidateChanges: manifest.changes,
  });

  const decisions = [];
  const blockingObligations = [];
  const needsHuman = [];
  const needsVerifier = [];
  const allowed = [];

  for (const change of manifest.changes) {
    const path = change.path;

    // Check Band B(i): Forbidden list or import.deny
    const isForbidden = policy.forbidden.some((pat) => matchPathPattern(pat, path));
    const isImportDenied = policy.import?.deny?.some((pat) => matchPathPattern(pat, path));

    if (isForbidden || isImportDenied) {
      const decision = {
        path,
        action: change.action,
        band: 'B(i)',
        decision: 'DENY',
        reason: isForbidden ? 'Matched policy forbidden rule' : 'Matched import.deny rule',
      };
      decisions.push(decision);
      blockingObligations.push(decision);
      continue;
    }

    // Check Band D: Protected paths
    const isProtectedPath = policy.protected_paths?.some((pat) => matchPathPattern(pat, path));
    if (isProtectedPath) {
      const approved = approvedByHuman.get(path);
      if (approved) {
        const decision = {
          path,
          action: change.action,
          band: 'D',
          decision: 'ALLOW',
          reason: `Approved by operator ${approved.operator}`,
          selector_id: 'protected_paths',
          operator: approved.operator,
          justification: approved.justification ?? null,
        };
        decisions.push(decision);
        allowed.push(decision);
        continue;
      }
      const decision = {
        path,
        action: change.action,
        band: 'D',
        decision: 'WAITING_HUMAN',
        reason: 'Matched protected_paths rule',
        selector_id: 'protected_paths',
      };
      decisions.push(decision);
      needsHuman.push(decision);
      continue;
    }

    // Check Band D: protected_json (TI-19)
    if (policy.protected_json && policy.protected_json.length > 0 && fileContentResolver) {
      const oldContent = fileContentResolver(path, 'old');
      const newContent = fileContentResolver(path, 'new');
      const jsonCheck = evaluateProtectedJson({
        path,
        oldContent,
        newContent,
        protectedJsonSelectors: policy.protected_json,
      });

      if (jsonCheck.hitProtected) {
        const approved = approvedByHuman.get(path);
        if (approved) {
          const decision = {
            path,
            action: change.action,
            band: 'D',
            decision: 'ALLOW',
            reason: `Approved by operator ${approved.operator} (${jsonCheck.reason})`,
            selector_id: jsonCheck.selector,
            operator: approved.operator,
            justification: approved.justification ?? null,
          };
          decisions.push(decision);
          allowed.push(decision);
          continue;
        }
        const decision = {
          path,
          action: change.action,
          band: 'D',
          decision: 'WAITING_HUMAN',
          reason: jsonCheck.reason,
          selector_id: jsonCheck.selector,
        };
        decisions.push(decision);
        needsHuman.push(decision);
        continue;
      }
    }

    // Check Band A: Inside granted write set
    const inScope = isPathInScope(path, scopeGrant);
    if (inScope) {
      const decision = {
        path,
        action: change.action,
        band: 'A',
        decision: 'ALLOW',
        reason: 'Within granted write set and non-protected',
      };
      decisions.push(decision);
      allowed.push(decision);
      continue;
    }

    // Band C: Outside scope, not B(i) and not D
    const decision = {
      path,
      action: change.action,
      band: 'C',
      decision: 'PENDING_VERIFIER',
      reason: 'Outside granted write set, requires scope verification',
    };
    decisions.push(decision);
    needsVerifier.push(decision);
  }

  // Determine overall aggregate verdict
  let verdict = 'APPROVED';
  if (blockingObligations.length > 0) {
    verdict = 'DENIED';
  } else if (needsHuman.length > 0) {
    verdict = 'WAITING_HUMAN';
  } else if (needsVerifier.length > 0) {
    verdict = 'NEEDS_VERIFIER';
  }

  return Object.freeze({
    verdict,
    decisions: Object.freeze(decisions.map((d) => Object.freeze({ ...d }))),
    blockingObligations: Object.freeze(blockingObligations),
    needsHuman: Object.freeze(needsHuman),
    needsVerifier: Object.freeze(needsVerifier),
    allowed: Object.freeze(allowed),
    total_evaluated: manifest.changes.length,
    evaluated_at: new Date().toISOString(),
  });
}
