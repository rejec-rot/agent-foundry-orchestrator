// human-gate-resume.mjs - resolve a parked V2 Human Gate (Band D) item and resume.
//
// The mechanical gate has no notion of "approved": a protected path is Band D and stays
// WAITING_HUMAN unless a HUMAN decision is supplied through the trusted Human Gate
// (evaluateMechanicalGate accepts `humanApproval` and honours it only when
// isTrustedHumanApproval() confirms it was minted in-process by approveHumanGate).
//
// This module is the operator-facing half: it re-checks the park, mints the signed approval, and
// records the evidence on the task so the resumed run can be re-verified. It refuses on:
//   * a task that is not a parked V2 Human Gate case;
//   * a STALE park (the task changed after it was parked - the state_version must match);
//   * a missing or failed operator authentication (unsigned approvals never exist).

import { approveHumanGate, isTrustedHumanApproval } from './human-gate.mjs';

export const HUMAN_GATE_RESUME_SCHEMA = 'af-human-gate-resume-v1';

/**
 * Mint a signed Human Gate approval for a parked V2 task and record it.
 *
 * @returns {{ ok: boolean, reason: string|null, code: string|null, approval?: object,
 *   approved_paths?: string[], resume?: object }}
 */
export function resolveV2HumanGate({
  task,
  operatorIdentity = null,
  justification = null,
  operatorAuthenticator = null,
  saveTask = null,
  now = new Date(),
} = {}) {
  const refuse = (reason, code = 'HUMAN_GATE_RESUME_REFUSED') => ({ ok: false, reason, code });

  if (!task || typeof task !== 'object') return refuse('no task was supplied');
  const ti = task.trusted_import ?? null;
  if (!ti || ti.enabled !== true) return refuse('not a Trusted Import V2 task');
  if (task.state !== 'WAITING_HUMAN') return refuse(`task is ${task.state ?? 'unknown'}, not WAITING_HUMAN`, 'NOT_PARKED');

  const pending = Array.isArray(ti.pending_human_decisions) ? ti.pending_human_decisions : [];
  if (pending.length === 0) return refuse('no pending human decisions are recorded; nothing to approve', 'NOT_PARKED');

  const ctx = ti.pending_human_context ?? null;
  if (!ctx) return refuse('the park context is missing, so a stale approval cannot be ruled out', 'HUMAN_APPROVAL_STALE');
  const currentVersion = task.state_version ?? 0;
  if (ctx.state_version !== currentVersion) {
    return refuse(`stale park: the task changed after it was parked (parked at state_version ${ctx.state_version}, now ${currentVersion}); re-derive the pending decisions before approving`, 'HUMAN_APPROVAL_STALE');
  }

  if (typeof operatorAuthenticator !== 'function') {
    return refuse('an authenticated operator callback is required; an unsigned approval must never exist', 'HUMAN_AUTH_REQUIRED');
  }

  let approval;
  try {
    approval = approveHumanGate({
      pendingDecisions: pending,
      operatorIdentity,
      justification,
      operatorAuthenticator,
    });
  } catch (err) {
    return { ok: false, reason: `approval refused: ${err.message}`, code: err.code ?? 'HUMAN_AUTH_FAILED' };
  }
  if (!isTrustedHumanApproval(approval)) {
    return refuse('the approval was not minted by the trusted Human Gate', 'HUMAN_AUTH_FAILED');
  }

  const approvedPaths = [...(approval.approval_evidence?.approved_paths ?? [])].sort();
  if (approvedPaths.length === 0) return refuse('the approval covers no paths');

  task.trusted_import = {
    ...ti,
    human_approval: {
      schema_version: HUMAN_GATE_RESUME_SCHEMA,
      approval_evidence: approval.approval_evidence,
      decisions: approval.decisions,
      resolved_at: new Date(now).toISOString(),
    },
    pending_human_decisions: null,
    pending_human_context: null,
    phase: 'AUTHORIZATION',
  };
  // The task deliberately stays WAITING_HUMAN until a run actually resumes: the V2 entrypoint
  // re-enters through executeTask (which precedes the governance branch for V2 tasks), re-mints
  // the approval in-process and recomputes the closure - so an unapproved resume simply parks again.
  if (typeof saveTask === 'function') saveTask(task);

  return {
    ok: true,
    reason: null,
    code: null,
    approval,
    approved_paths: approvedPaths,
    resume: { required: true, state: task.state, entry: 'executeTask' },
  };
}
