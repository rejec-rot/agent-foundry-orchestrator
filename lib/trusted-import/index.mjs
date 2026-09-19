// lib/trusted-import/index.mjs
//
// Trusted Import Subsystem for AFR v5.2.1 (Phase 1 & Phase 2).
// Public API entrypoint.

export {
  CANONICAL_REF,
  ZERO_OID,
  SNAPSHOT_SCHEMA_V1,
  DEFAULT_LIMITS,
  MODE_NORMAL,
  MODE_EXEC,
  AfrError,
  HardDenyError,
  AdmissionError,
  QuiesceError,
  sha256,
  normalizeMode,
  validateRawPath,
  toPolicyMatchKey,
  checkNormalizationCollisions,
} from './common.mjs';

export { TrustedCAS } from './cas.mjs';
export { verifyQuiesced, assertQuiesced } from './quiesce.mjs';
export { captureCandidateFS } from './capture.mjs';
export { sealSnapshot, verifySnapshotIntegrity } from './snapshot.mjs';
export { computeManifest, computeManifestDigest } from './manifest.mjs';
export { adoptRepository, getCanonicalOid } from './adopt.mjs';
export { projectCandidate, isPathExcluded, matchPathPattern } from './projection.mjs';

// Phase 2: Mechanical Authorization & Policy
export {
  DEFAULT_TRUSTED_POLICY,
  canonicalizePolicy,
  resolveJsonPointer,
  evaluateProtectedJson,
} from './policy.mjs';

export {
  createScopeGrant,
  verifyScopeGrantIntegrity,
  isPathInScope,
} from './scope-grant.mjs';

export {
  targetNamespacePreflight,
} from './preflight.mjs';

export {
  evaluateMechanicalGate,
} from './mechanical-gate.mjs';

export {
  AuthorizationLedger,
  isTrustedAuthorizationClosure,
  revalidateAuthorizationClosure,
} from './ledger.mjs';

// Phase 3: Hard G Promotion & Materialization
export {
  buildTargetCanonicalTree,
} from './target-tree.mjs';

export {
  writeGitTree,
  createGitCommit,
  promoteCanonicalRef,
} from './git-promoter.mjs';

export {
  materializeWorktree,
  verifyMaterializedWorktree,
} from './materializer.mjs';

export {
  executeHardGPromotion,
  verifyPromotedCommit,
} from './promoter.mjs';

// Phase 4: Runtime & Evidence
export {
  computeDependencyInputDigest,
  computeDependencyFixtureId,
  DependencyFixtureRegistry,
} from './dependency-fixture.mjs';

export {
  createEvidenceRecord,
  verifyEvidenceReplay,
  assertPromotionEvidence,
} from './evidence-record.mjs';

export {
  assertPreAcceptanceClosure,
  injectBaselineRegressionClosure,
  initSanitizedDisposableGit,
  createTrustedAcceptanceRunner,
  runAcceptancePipeline,
} from './acceptance-engine.mjs';

export {
  runDiagnosticDryrun,
  assertPromotionNotPermittedFromDiagnostic,
} from './diagnostic-runner.mjs';

// Phase 5: Intelligent & Operational Gates
export {
  verifyScopeExpansion,
} from './scope-verifier.mjs';

export {
  rebaseCandidateDelta,
} from './rebase.mjs';

export {
  approveHumanGate,
  isTrustedHumanApproval,
  revalidateHumanApproval,
} from './human-gate.mjs';
