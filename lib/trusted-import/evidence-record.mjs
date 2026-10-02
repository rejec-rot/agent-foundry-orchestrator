// lib/trusted-import/evidence-record.mjs
//
// Acceptance Evidence Record & 7-Tuple Binding (§9.1, TI-26).
// Ensures all acceptance PASS / reviewer evidence is cryptographically bound
// to an exact revision snapshot, baseline OID, fixture, command, and policy.
// Prevents cross-revision evidence replay and stale endorsement reuse.

import { AfrError, sha256 } from './common.mjs';

const VALID_STATUSES = new Set(['PASS', 'FAIL']);
const VALID_TIERS = new Set(['TierA', 'TierB', 'TierC']);

/**
 * Serialize JSON values deterministically, including nested objects.
 * Object insertion order must not change an evidence identity.
 */
function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function computeEvidenceId(evidence) {
  const bindingPayload = [
    evidence.status,
    evidence.tier,
    evidence.candidate_snapshot_digest,
    evidence.baseline_oid,
    evidence.acceptance_profile_digest,
    evidence.acceptance_assets_digest,
    evidence.dependency_fixture_id,
    evidence.command_binding,
    evidence.policy_digest,
  ].join(':');

  let evidenceId = sha256(bindingPayload);
  if (evidence.tier === 'TierC') {
    evidenceId = sha256(evidenceId + ':' + canonicalJson(evidence.tier_c));
  }
  return evidenceId;
}

/**
 * Mint an immutable Evidence Record with strict 7-tuple binding.
 *
 * @param {object} options
 * @param {'PASS'|'FAIL'} options.status - Acceptance test status
 * @param {'TierA'|'TierB'|'TierC'} options.tier - Evidence tier
 * @param {string} options.candidateSnapshotDigest - Bound snapshot digest
 * @param {string} options.baselineOid - Bound baseline commit OID
 * @param {string} options.acceptanceProfileDigest - Digest or identity of acceptance profile
 * @param {string} options.acceptanceAssetsDigest - Digest or identity of acceptance suite assets
 * @param {string} options.dependencyFixtureId - Bound fixture ID
 * @param {string} options.commandBinding - Bound acceptance command string
 * @param {object} options.policySectionDigests - Digest map of trusted policy
 * @param {object|null} [options.tierCData=null] - { review_decision_id, reviewed_test_blob_digests, reviewed_snapshot_digest }
 * @param {object} [options.details={}] - Test run details (stdout, exit code, duration)
 * @returns {object} Frozen Evidence Record
 */
export function createEvidenceRecord({
  status,
  tier,
  candidateSnapshotDigest,
  baselineOid,
  acceptanceProfileDigest,
  acceptanceAssetsDigest,
  dependencyFixtureId,
  commandBinding,
  policySectionDigests,
  tierCData = null,
  details = {},
}) {
  if (
    !VALID_STATUSES.has(status) ||
    !VALID_TIERS.has(tier) ||
    !candidateSnapshotDigest ||
    !baselineOid ||
    !dependencyFixtureId ||
    !commandBinding ||
    typeof acceptanceProfileDigest !== 'string' ||
    acceptanceProfileDigest.length === 0 ||
    typeof acceptanceAssetsDigest !== 'string' ||
    acceptanceAssetsDigest.length === 0 ||
    !policySectionDigests ||
    typeof policySectionDigests !== 'object' ||
    Array.isArray(policySectionDigests)
  ) {
    throw new AfrError('Missing required 7-tuple fields for Evidence Record', 'INVALID_ARGUMENT');
  }

  const profileDigest = sha256(acceptanceProfileDigest);
  const assetsDigest = sha256(acceptanceAssetsDigest);
  const policyDigest = sha256(canonicalJson(policySectionDigests || {}));

  // If Tier C, append reviewer endorsement tuple
  let tierCBinding = null;
  if (tier === 'TierC') {
    if (!tierCData || !tierCData.review_decision_id || !tierCData.reviewed_snapshot_digest) {
      throw new AfrError('Tier C evidence requires reviewer endorsement tuple', 'INVALID_TIER_C_DATA');
    }
    tierCBinding = Object.freeze({
      review_decision_id: tierCData.review_decision_id,
      reviewed_snapshot_digest: tierCData.reviewed_snapshot_digest,
      reviewed_test_blob_digests: Object.freeze([...(tierCData.reviewed_test_blob_digests || [])].sort()),
    });
  }

  const record = {
    evidence_id: null,
    status,
    tier,
    candidate_snapshot_digest: candidateSnapshotDigest,
    baseline_oid: baselineOid,
    acceptance_profile_digest: profileDigest,
    acceptance_assets_digest: assetsDigest,
    dependency_fixture_id: dependencyFixtureId,
    command_binding: commandBinding,
    policy_digest: policyDigest,
    tier_c: tierCBinding,
    details: Object.freeze({ ...details }),
    created_at: new Date().toISOString(),
  };
  record.evidence_id = computeEvidenceId(record);
  return Object.freeze(record);
}

/**
 * Verify whether an Evidence Record is valid for the current revision context (TI-26).
 *
 * @param {object} evidence - EvidenceRecord
 * @param {object} currentContext - Full current Evidence Binding context.
 * @returns {{ valid: boolean, isStale: boolean, reason?: string }}
 */
export function verifyEvidenceReplay(evidence, currentContext) {
  if (!evidence || !currentContext) {
    return { valid: false, isStale: false, reason: 'Evidence or context missing' };
  }

  const requiredEvidenceFields = [
    'candidate_snapshot_digest',
    'baseline_oid',
    'dependency_fixture_id',
    'command_binding',
    'acceptance_profile_digest',
    'acceptance_assets_digest',
    'policy_digest',
  ];
  const requiredContextFields = [
    'candidateSnapshotDigest',
    'baselineOid',
    'dependencyFixtureId',
    'commandBinding',
    'acceptanceProfileDigest',
    'acceptanceAssetsDigest',
  ];
  if (
    requiredEvidenceFields.some((field) => typeof evidence[field] !== 'string' || evidence[field].length === 0) ||
    requiredContextFields.some((field) => typeof currentContext[field] !== 'string' || currentContext[field].length === 0) ||
    !currentContext.policySectionDigests ||
    typeof currentContext.policySectionDigests !== 'object' ||
    Array.isArray(currentContext.policySectionDigests)
  ) {
    return { valid: false, isStale: false, reason: 'Evidence or context binding fields are incomplete' };
  }

  if (
    !VALID_STATUSES.has(evidence.status) ||
    !VALID_TIERS.has(evidence.tier) ||
    typeof evidence.evidence_id !== 'string' ||
    evidence.evidence_id !== computeEvidenceId(evidence)
  ) {
    return { valid: false, isStale: false, reason: 'Evidence integrity check failed' };
  }

  // 1. Revision Snapshot Mismatch -> Stale Evidence (TI-26)
  if (evidence.candidate_snapshot_digest !== currentContext.candidateSnapshotDigest) {
    return {
      valid: false,
      isStale: true,
      reason: `Snapshot digest mismatch: evidence bound to ${evidence.candidate_snapshot_digest}, current revision is ${currentContext.candidateSnapshotDigest}`,
    };
  }

  // 2. Baseline OID Mismatch -> Stale Baseline
  if (evidence.baseline_oid !== currentContext.baselineOid) {
    return {
      valid: false,
      isStale: true,
      reason: `Baseline OID mismatch: evidence bound to ${evidence.baseline_oid}, current baseline is ${currentContext.baselineOid}`,
    };
  }

  // 3. Dependency Fixture Mismatch
  if (evidence.dependency_fixture_id !== currentContext.dependencyFixtureId) {
    return {
      valid: false,
      isStale: true,
      reason: `Dependency fixture mismatch: evidence bound to ${evidence.dependency_fixture_id}, current fixture is ${currentContext.dependencyFixtureId}`,
    };
  }

  // 4. Command Binding Mismatch
  if (evidence.command_binding !== currentContext.commandBinding) {
    return {
      valid: false,
      isStale: false,
      reason: `Command binding mismatch: evidence bound to "${evidence.command_binding}", current command is "${currentContext.commandBinding}"`,
    };
  }

  const expectedPolicyDigest = sha256(canonicalJson(currentContext.policySectionDigests));
  if (evidence.policy_digest !== expectedPolicyDigest) {
    return {
      valid: false,
      isStale: true,
      reason: 'Policy section digest mismatch',
    };
  }

  if (evidence.acceptance_profile_digest !== sha256(currentContext.acceptanceProfileDigest)) {
    return { valid: false, isStale: true, reason: 'Acceptance profile digest mismatch' };
  }

  if (evidence.acceptance_assets_digest !== sha256(currentContext.acceptanceAssetsDigest)) {
    return { valid: false, isStale: true, reason: 'Acceptance assets digest mismatch' };
  }

  // The profile, assets, and policy comparisons above are deliberately
  // mandatory. A replay check with only snapshot/baseline fields would let a
  // PASS from a different acceptance environment reach the promotion gate.
  if (typeof currentContext.patchDigest === 'string' && currentContext.patchDigest.length === 0) {
    return {
      valid: false,
      isStale: false,
      reason: 'Patch binding is empty',
    };
  }

  // 5. Tier C Endorsement check: verify reviewed_snapshot matches current snapshot
  if (evidence.tier === 'TierC') {
    if (!evidence.tier_c || evidence.tier_c.reviewed_snapshot_digest !== currentContext.candidateSnapshotDigest) {
      return {
        valid: false,
        isStale: true,
        reason: 'Tier C reviewer endorsement is stale for current candidate snapshot',
      };
    }
  }

  return { valid: true, isStale: false };
}

/**
 * Assert that a PASS Evidence Record is safe to use at Hard G.
 *
 * Replay validity and PASS status are separate checks: a cryptographically
 * valid FAIL record is still never a promotion authorization.
 */
export function assertPromotionEvidence(evidence, currentContext) {
  if (!evidence || evidence.status !== 'PASS') {
    throw new AfrError('Hard G promotion requires a PASS acceptance evidence record', 'PROMOTION_ACCEPTANCE_REQUIRED');
  }
  const replay = verifyEvidenceReplay(evidence, currentContext);
  if (!replay.valid) {
    throw new AfrError(
      `Acceptance evidence is not valid for promotion: ${replay.reason}`,
      replay.isStale ? 'PROMOTION_ACCEPTANCE_STALE' : 'PROMOTION_ACCEPTANCE_INVALID',
      { replay },
    );
  }
  return evidence;
}
