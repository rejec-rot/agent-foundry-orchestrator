// human-gate-park.mjs - V2 Human Gate (Band D) parking.
//
// V2 previously FAILED a task whenever the authorization closure was unsatisfied, which meant a
// Band D ("a human must decide") item was indistinguishable from a hard DENY. This module turns
// the Band D case into a durable PARK instead: the task is set to WAITING_HUMAN and the pending
// decisions are persisted, so an authenticated approval can later be applied and the task resumed.
//
// Fail-closed rules kept here:
//   * DENY (blockingObligations) is NEVER parked - it stays a failure;
//   * an independent-verifier case (needsVerifier) is NOT a human-gate case and is not parked;
//   * only a genuine Band D payload (needsHuman non-empty, nothing blocking) parks.

export const HUMAN_GATE_PARK_PHASE = 'WAITING_HUMAN';

/**
 * Decide whether a closure payload is a park-able Human Gate case.
 * @returns {{ park: boolean, reason: string|null, pending?: object[] }}
 */
export function humanGateParkDecision(closure) {
  if (!closure || typeof closure !== 'object') return { park: false, reason: 'no closure payload' };
  const needsHuman = Array.isArray(closure.needsHuman) ? closure.needsHuman : [];
  const needsVerifier = Array.isArray(closure.needsVerifier) ? closure.needsVerifier : [];
  const blocking = Array.isArray(closure.blockingObligations) ? closure.blockingObligations : [];
  if (needsHuman.length === 0) return { park: false, reason: 'no human-gate items' };
  if (blocking.length > 0) return { park: false, reason: 'blocking DENY obligations present' };
  if (needsVerifier.length > 0) return { park: false, reason: 'independent verifier required - not a human-gate case' };
  return { park: true, reason: null, pending: needsHuman };
}

/**
 * Park a V2 task for a signed human decision. Persists the pending Band D items and the context
 * needed to re-verify after approval (state_version + manifest/baseline identity).
 *
 * @returns {{ parked: boolean, reason: string|null, pending?: object[] }}
 */
export function parkForHumanGate({ task, closure, saveTask = null, now = new Date() } = {}) {
  const decision = humanGateParkDecision(closure);
  if (!decision.park) return { parked: false, reason: decision.reason };
  if (!task || typeof task !== 'object') return { parked: false, reason: 'no task' };

  task.state = 'WAITING_HUMAN';
  task.trusted_import = {
    ...(task.trusted_import ?? {}),
    phase: HUMAN_GATE_PARK_PHASE,
    pending_human_decisions: decision.pending,
    pending_human_context: {
      verdict: closure.verdict ?? null,
      cumulative_manifest_digest: closure.cumulative_manifest_digest ?? null,
      baseline_oid: closure.baseline_oid ?? null,
      state_version: task.state_version ?? 0,
      parked_at: now.toISOString(),
    },
  };
  if (typeof saveTask === 'function') saveTask(task);
  return { parked: true, reason: null, pending: decision.pending };
}
