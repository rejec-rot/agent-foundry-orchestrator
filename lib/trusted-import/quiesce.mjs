// lib/trusted-import/quiesce.mjs
//
// QUIESCE State Machine Enforcement (§6).
// Ensures all untrusted writers (containers and descendant processes) are terminated
// before any bounded FS capture or CAS ingestion can commence.
// Immutability Boundary is established by Sealed Snapshot + Trusted CAS.

import { QuiesceError } from './common.mjs';
import { reapProcessGroup, reapWriterScope } from '../child-process.mjs';

// Evidence is intentionally process-local. A caller cannot manufacture a plain
// object with the same fields and cross the capture boundary.
const TRUSTED_QUIESCE_EVIDENCE = new WeakSet();

/**
 * Verify that all untrusted writers for a candidate run have terminated.
 *
 * @param {object} options
 * @param {string|null} [options.containerId] - Docker container ID if sandboxed
 * @param {number|null} [options.pid] - Process group leader PID if host spawned
 * @param {object|null} [options.writerScope] - cgroup/container scope that
 *   covers descendants which can escape the process group
 * @param {Function|null} [options.terminationVerifier=null] - Trusted control-plane check for container/no-PID writers; must return true
 * @param {number} [options.timeoutMs=2000] - Grace period before escalating
 * @returns {Promise<object>} quiesceEvidence
 */
export async function verifyQuiesced({
  containerId = null,
  pid = null,
  writerScope = null,
  terminationVerifier = null,
  timeoutMs = 2000,
} = {}) {
  if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) {
    throw new QuiesceError('pid must be a positive integer or null', {
      reason: 'INVALID_PID',
      pid,
    });
  }
  if (containerId !== null && (typeof containerId !== 'string' || containerId.trim() === '')) {
    throw new QuiesceError('containerId must be a non-empty string or null', {
      reason: 'INVALID_CONTAINER_ID',
      containerId,
    });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new QuiesceError('timeoutMs must be a positive number', {
      reason: 'INVALID_TIMEOUT',
      timeoutMs,
    });
  }
  if (pid === null && typeof terminationVerifier !== 'function') {
    throw new QuiesceError(
      'Quiesce verification requires a host PID or a trusted termination verifier',
      { reason: 'NO_TERMINATION_WITNESS' }
    );
  }

  // If a PID was provided, ensure its process group AND its stronger writer
  // scope are completely dead. A process group alone is not a proof: a
  // double-forked child can call setsid(2) and disappear from the group while
  // continuing to write the candidate.
  if (pid !== null) {
    let scopeOutcome = writerScope;
    try {
      if (writerScope?.kind === 'cgroup') {
        scopeOutcome = await reapWriterScope(writerScope, {
          graceMs: timeoutMs,
          pollMs: Math.min(100, Math.max(10, Math.floor(timeoutMs / 10))),
        });
      }
      const outcome = await reapProcessGroup(pid, {
        graceMs: timeoutMs,
        pollMs: Math.min(100, Math.max(10, Math.floor(timeoutMs / 10))),
        scope: scopeOutcome,
      });
      if (outcome.scope_verified !== true) {
        throw new QuiesceError(
          `Process ${pid} has no verified cgroup or container writer scope`,
          { pid, untrustedWritersActive: true, reason: 'WRITER_SCOPE_UNVERIFIED' },
        );
      }
      if (!outcome.gone) {
        throw new QuiesceError(`Process ${pid} is still alive after scoped termination`, {
          pid,
          untrustedWritersActive: true,
          reason: 'PID_STILL_ALIVE',
        });
      }
    } catch (err) {
      if (err instanceof QuiesceError) throw err;
      throw new QuiesceError(`PID termination failed: ${err.message}`, {
        reason: 'PID_TERMINATION_ERROR',
        pid,
      });
    }
  }

  if (typeof terminationVerifier === 'function') {
    let verified = false;
    try {
      verified = await terminationVerifier({ containerId, pid });
    } catch (err) {
      throw new QuiesceError(`Termination verifier failed: ${err.message}`, {
        reason: 'TERMINATION_VERIFIER_ERROR',
      });
    }
    if (verified !== true) {
      throw new QuiesceError('Termination verifier did not confirm that writers stopped', {
        reason: 'TERMINATION_NOT_CONFIRMED',
        containerId,
        pid,
      });
    }
  }

  // Create immutable evidence record
  const quiesceEvidence = Object.freeze({
    quiesced: true,
    verified_at: new Date().toISOString(),
    container_id: containerId,
    pid: pid,
    termination_verified: true,
    writers_terminated: true,
  });

  TRUSTED_QUIESCE_EVIDENCE.add(quiesceEvidence);

  return quiesceEvidence;
}

/**
 * Assert that capture or import is preceded by valid quiesce evidence (TI-3).
 * @param {object} evidence
 * @throws {QuiesceError} if invalid or missing
 */
export function assertQuiesced(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    throw new QuiesceError('Quiesce evidence missing: refusing capture or import without quiesce proof', {
      code: 'QUIESCE_VERIFICATION_FAILED',
      reason: 'MISSING_EVIDENCE',
    });
  }

  if (
    !TRUSTED_QUIESCE_EVIDENCE.has(evidence) ||
    evidence.quiesced !== true ||
    evidence.writers_terminated !== true ||
    evidence.termination_verified !== true ||
    !evidence.verified_at
  ) {
    throw new QuiesceError('Quiesce evidence invalid: untrusted writers not confirmed terminated', {
      code: 'QUIESCE_VERIFICATION_FAILED',
      reason: 'INVALID_OR_UNTRUSTED_EVIDENCE',
      evidence,
    });
  }
}
