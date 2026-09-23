// Trusted Import entrypoint for the main orchestrator.
//
// This adapter intentionally keeps the legacy task loop intact. A task opts
// into the V2 path with `trusted_import.enabled === true`; once opted in, the
// candidate never doubles as the canonical repository and promotion is only
// reachable after the same capture, authorization, acceptance, and Hard G
// gates used by the standalone Trusted Import modules.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  engageTaskHostBoundary,
  disengageTaskHostBoundary,
  withElevatedBoundary,
  decideWriterScopesEmpty,
} from '../host-boundary.mjs';

import { recordBoundaryAlert, resolveBoundaryAlert } from '../boundary-alerts.mjs';
import { notifyBoundaryAlert } from '../boundary-notify.mjs';
import { normalizeAcceptanceCmd } from '../acceptance.mjs';
import {
  AfrError,
  AuthorizationLedger,
  TrustedCAS,
  adoptRepository,
  assertPreAcceptanceClosure,
  assertPromotionEvidence,
  canonicalizePolicy,
  captureCandidateFS,
  computeManifest,
  createTrustedAcceptanceRunner,
  createScopeGrant,
  executeHardGPromotion,
  getCanonicalOid,
  injectBaselineRegressionClosure,
  materializeWorktree,
  projectCandidate,
  rebaseCandidateDelta,
  revalidateAuthorizationClosure,
  runAcceptancePipeline,
  sealSnapshot,
  sha256,
  verifyQuiesced,
  verifyPromotedCommit,
} from './index.mjs';
import { parkForHumanGate } from './human-gate-park.mjs';

function trustedImportError(message, code, details = {}) {
  return new AfrError(message, code, details);
}

function requireConfig(task) {
  const config = task?.trusted_import;
  if (!config) return null;
  if (typeof config !== 'object') {
    throw trustedImportError('trusted_import must be an object', 'TRUSTED_IMPORT_CONFIG_INVALID');
  }
  if (config.enabled !== true) return null;
  return config;
}

/**
 * Admission rules for the V2 entrypoint. V2 owns a single workspace candidate
 * and its own review/capture/promotion phases; task modes whose semantics would
 * silently be skipped by that path are rejected before an author is launched.
 */
export function assertTrustedImportAdmission(task) {
  const config = requireConfig(task);
  if (!config) return true;
  const mode = task.task_mode ?? 'workspace';
  if (mode !== 'workspace') {
    throw trustedImportError(
      `Trusted Import V2 does not support task mode "${mode}"`,
      'TRUSTED_IMPORT_MODE_UNSUPPORTED',
      { task_mode: mode },
    );
  }
  if (task.multi_step_dispatch === true
      || (Array.isArray(task.planner_result?.plan) && task.planner_result.plan.length > 0)) {
    throw trustedImportError(
      'Trusted Import V2 requires a single author/reviewer flow; multi-step dispatch must be disabled',
      'TRUSTED_IMPORT_MULTI_STEP_UNSUPPORTED',
    );
  }
  if (typeof task.reviewer_executor !== 'string'
      || task.reviewer_executor.length === 0
      || task.reviewer_executor === 'auto') {
    throw trustedImportError(
      'Trusted Import V2 requires an explicitly assigned independent reviewer executor',
      'TRUSTED_IMPORT_REVIEWER_REQUIRED',
    );
  }
  if (task.author_executor && task.author_executor !== 'auto'
      && task.author_executor === task.reviewer_executor) {
    throw trustedImportError(
      'Trusted Import V2 author and reviewer executors must be independent',
      'TRUSTED_IMPORT_REVIEWER_NOT_INDEPENDENT',
      { author_executor: task.author_executor, reviewer_executor: task.reviewer_executor },
    );
  }
  return true;
}

function assertPathString(path, name) {
  if (typeof path !== 'string' || path.length === 0) {
    throw trustedImportError(`${name} must be a non-empty path`, 'TRUSTED_IMPORT_CONFIG_INVALID', { name });
  }
  return resolve(path);
}

function isWithin(parent, child) {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(`${base}/`);
}

function assertSeparateWorkspace(repoDir, candidateDir, name) {
  if (resolve(repoDir) === resolve(candidateDir) || isWithin(repoDir, candidateDir) || isWithin(candidateDir, repoDir)) {
    throw trustedImportError(
      `${name} must be physically separate from the canonical repository`,
      'TRUSTED_IMPORT_WORKSPACE_NOT_SEPARATE',
      { repoDir, candidateDir, name },
    );
  }
}

function assertEmptyDirectory(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw trustedImportError(`Trusted Import candidate path is not a directory: ${path}`, 'TRUSTED_IMPORT_CANDIDATE_UNSAFE');
  }
  if (readdirSync(path).length > 0) {
    throw trustedImportError(
      `Trusted Import candidate directory must be empty on first admission: ${path}`,
      'TRUSTED_IMPORT_CANDIDATE_NOT_EMPTY',
    );
  }
}

function readCanonicalEntries(repoDir, baselineOid) {
  const output = execFileSync('git', ['ls-tree', '-r', '-z', baselineOid], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const entries = [];
  for (const line of (output ? output.split('\0').filter(Boolean) : [])) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    const path = line.slice(tab + 1);
    if (type !== 'blob') continue;
    const bytes = execFileSync('git', ['cat-file', 'blob', oid], {
      cwd: repoDir,
      encoding: null,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    entries.push({
      path,
      type: 'blob',
      mode,
      oid,
      blob_digest: sha256(bytes),
      size: bytes.length,
    });
  }
  return entries;
}

function assertNoSymlinkAncestors(path) {
  let current = resolve(path);
  while (true) {
    let stat = null;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw trustedImportError(`Unsafe Trusted Import staging component: ${current}`, 'TRUSTED_IMPORT_STAGING_UNSAFE', { path: current });
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function materializeSnapshotForAcceptance({ stagingDir, snapshot, cas }) {
  for (const entry of snapshot.entries) {
    const filePath = join(stagingDir, entry.path);
    const parentDir = dirname(filePath);
    mkdirSync(parentDir, { recursive: true });
    assertNoSymlinkAncestors(parentDir);
    const existing = (() => {
      try { return lstatSync(filePath); } catch (err) { return err?.code === 'ENOENT' ? null : (() => { throw err; })(); }
    })();
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw trustedImportError(`Unsafe Trusted Import staging target: ${entry.path}`, 'TRUSTED_IMPORT_STAGING_UNSAFE');
    }
    const temp = join(parentDir, `.afr-acceptance-${randomUUID()}`);
    try {
      writeFileSync(temp, cas.get(entry.blob_digest), { flag: 'wx', mode: 0o600 });
      chmodSync(temp, entry.mode === '0755' ? 0o755 : 0o644);
      renameSync(temp, filePath);
    } catch (err) {
      rmSync(temp, { force: true });
      throw trustedImportError(`Failed to materialize acceptance staging file ${entry.path}: ${err.message}`, 'TRUSTED_IMPORT_STAGING_WRITE_FAILED');
    }
  }
}

function replaceCandidateWithSnapshot({ candidateDir, scratchDir, snapshot, cas }) {
  // The author has already been quiesced. Replacing the candidate root makes a
  // clean rebase durable: a later recovery capture cannot interpret another
  // task's newly accepted files as deletions just because the old candidate
  // directory was never refreshed.
  assertNoSymlinkAncestors(candidateDir);
  const rootStat = (() => {
    try { return lstatSync(candidateDir); } catch (err) { return err?.code === 'ENOENT' ? null : (() => { throw err; })(); }
  })();
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    throw trustedImportError('Trusted Import candidate root became unsafe during rebase', 'TRUSTED_IMPORT_CANDIDATE_UNSAFE');
  }
  rmSync(candidateDir, { recursive: true, force: true });
  mkdirSync(candidateDir, { recursive: true });
  materializeSnapshotForAcceptance({ stagingDir: candidateDir, snapshot, cas });
  mkdirSync(scratchDir, { recursive: true });
}

function commandBinding(spec) {
  return JSON.stringify({ command: spec.command, args: spec.args });
}

function acceptanceConfig(config) {
  const acceptance = config.acceptance;
  if (!acceptance || typeof acceptance !== 'object') {
    throw trustedImportError('trusted_import.acceptance is required', 'TRUSTED_IMPORT_CONFIG_INVALID');
  }
  for (const [key, value] of [
    ['acceptance_profile_digest', acceptance.acceptance_profile_digest],
    ['acceptance_assets_digest', acceptance.acceptance_assets_digest],
    ['dependency_fixture_id', acceptance.dependency_fixture_id],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw trustedImportError(`trusted_import.acceptance.${key} is required`, 'TRUSTED_IMPORT_CONFIG_INVALID');
    }
  }
  return acceptance;
}

function buildAcceptanceContext({ acceptance, spec, candidateSnapshot, baselineOid, manifest, policy }) {
  const policySectionDigests = acceptance.policy_section_digests ?? policy.section_digests;
  if (!policySectionDigests || typeof policySectionDigests !== 'object' || Array.isArray(policySectionDigests)) {
    throw trustedImportError('A complete acceptance policy section digest map is required', 'TRUSTED_IMPORT_CONFIG_INVALID');
  }
  return {
    candidateSnapshotDigest: candidateSnapshot.snapshot_digest,
    baselineOid,
    acceptanceProfileDigest: acceptance.acceptance_profile_digest,
    acceptanceAssetsDigest: acceptance.acceptance_assets_digest,
    dependencyFixtureId: acceptance.dependency_fixture_id,
    commandBinding: commandBinding(spec),
    policySectionDigests,
    patchDigest: manifest.manifest_digest,
  };
}

function baselineContentResolver({ repoDir, baselineOid, baselineEntries, candidateSnapshot, cas }) {
  const baselineByPath = new Map(baselineEntries.map((entry) => [entry.path, entry.oid]));
  const candidateByPath = new Map(candidateSnapshot.entries.map((entry) => [entry.path, entry.blob_digest]));
  return (path, side) => {
    if (side === 'old') {
      const oid = baselineByPath.get(path);
      return oid
        ? execFileSync('git', ['cat-file', 'blob', oid], { cwd: repoDir, encoding: null, stdio: ['pipe', 'pipe', 'pipe'] })
        : null;
    }
    const digest = candidateByPath.get(path);
    return digest ? cas.get(digest) : null;
  };
}

function terminationEvidenceConfirmed(evidence) {
  return Boolean(
    evidence
      && evidence.termination_confirmed === true
      && evidence.process_group_alive === false
      && evidence.scope_verified === true,
  );
}

function applyManifestToProjectedSnapshot({ projectedSnapshot, manifest, cas, metadata }) {
  const entries = new Map(projectedSnapshot.entries.map((entry) => [entry.path, { ...entry }]));
  for (const change of manifest.changes) {
    if (change.action === 'DELETE') {
      entries.delete(change.path);
      continue;
    }
    if (change.action === 'ADD' || change.action === 'MODIFY') {
      const digest = change.new_digest;
      const bytes = cas.get(digest);
      entries.set(change.path, {
        path: change.path,
        type: 'blob',
        mode: change.new_mode ?? '0644',
        blob_digest: digest,
        size: bytes.length,
      });
      continue;
    }
    if (change.action === 'MODE') {
      const existing = entries.get(change.path);
      if (existing) entries.set(change.path, { ...existing, mode: change.new_mode ?? existing.mode });
    }
  }
  return sealSnapshot({ entries: [...entries.values()], metadata });
}

/**
 * Revalidate a promotion intent left behind after update-ref succeeded but the
 * task JSON did not reach COMPLETED. This is deliberately separate from the
 * normal promotion path: it never creates a second commit or applies a patch
 * twice.
 */
function recoverCommittedPromotion({ task, config, repoDir, materializeDir, cas, policy, saveTask }) {
  const intent = task.trusted_import?.promotion_intent;
  if (!intent) return null;
  const canonicalOid = getCanonicalOid(repoDir);
  if (!canonicalOid) return null;

  // The ref may have advanced after the CAS update but before task completion
  // was journaled. Treat the transaction as committed when its commit is an
  // ancestor of the current canonical ref. An unrelated ref update is still a
  // normal interrupted promotion and must continue through the regular retry
  // and rebase path.
  if (canonicalOid !== intent.new_commit_oid) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', intent.new_commit_oid, canonicalOid], {
        cwd: repoDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      return null;
    }
  }

  const verifiedPromotion = verifyPromotedCommit({ repoDir, canonicalOid, intent, allowDescendant: true });
  const candidateSnapshot = task.trusted_import.candidate_snapshot;
  const manifest = task.trusted_import.manifest;
  const persistedClosure = task.trusted_import.authorization_closure;
  const acceptanceEvidence = task.trusted_import.acceptance_evidence;
  const acceptanceContext = task.trusted_import.acceptance_context;
  if (!candidateSnapshot || !manifest || !persistedClosure || !acceptanceEvidence || !acceptanceContext) {
    throw trustedImportError(
      'Promotion commit exists but its durable gate evidence is incomplete; refusing recovery finalization',
      'PROMOTION_RECOVERY_EVIDENCE_MISSING',
    );
  }
  if (manifest.manifest_digest !== intent.patch_digest
      || acceptanceEvidence.evidence_id !== intent.acceptance_evidence_id) {
    throw trustedImportError(
      'Promotion intent is not bound to the persisted candidate or acceptance evidence',
      'PROMOTION_RECOVERY_BINDING_MISMATCH',
    );
  }
  if (task.trusted_import.review_snapshot_digest !== candidateSnapshot.snapshot_digest
      || task.trusted_import.last_review?.decision !== 'PASS'
      || !terminationEvidenceConfirmed(task.trusted_import.last_reviewer_termination_evidence)) {
    throw trustedImportError(
      'Promotion recovery requires a PASS independent review with termination evidence',
      'PROMOTION_RECOVERY_REVIEW_INVALID',
    );
  }

  const baselineEntries = readCanonicalEntries(repoDir, intent.baseline_oid);
  const scope = createScopeGrant({
    taskId: task.task_id,
    canonicalOid: intent.baseline_oid,
    proposedRequired: Array.isArray(config.proposed_required) ? config.proposed_required : [],
    proposedAnticipated: Array.isArray(config.proposed_anticipated) ? config.proposed_anticipated : [],
    policy,
  });
  const closure = revalidateAuthorizationClosure({
    persistedClosure,
    cumulativeManifest: manifest,
    currentScopeGrant: scope,
    currentPolicy: policy,
    baselineOid: intent.baseline_oid,
    baselineCanonicalEntries: baselineEntries,
    fileContentResolver: baselineContentResolver({
      repoDir,
      baselineOid: intent.baseline_oid,
      baselineEntries,
      candidateSnapshot,
      cas,
    }),
  });
  assertPreAcceptanceClosure(closure);
  assertPromotionEvidence(acceptanceEvidence, acceptanceContext);

  const materialization = materializeDir
    ? materializeWorktree({
      repoDir,
      canonicalOid,
      destinationDir: materializeDir,
      cleanExisting: true,
      verifyHash: true,
    })
    : null;
  const promotion = Object.freeze({
    status: 'PROMOTED',
    canonical_ref: 'refs/afr/canonical',
    canonical_oid: canonicalOid,
    promoted_oid: intent.new_commit_oid,
    tree_oid: intent.tree_oid,
    canonical_tree_oid: execFileSync('git', ['rev-parse', `${canonicalOid}^{tree}`], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim(),
    previous_oid: intent.baseline_oid,
    materialization,
    acceptance_evidence_id: acceptanceEvidence.evidence_id,
    recovered: true,
    promoted_at: intent.prepared_at ?? new Date().toISOString(),
  });
  task.trusted_import = {
    ...task.trusted_import,
    scope_grant: scope,
    authorization_closure: closure,
    promotion,
    canonical_oid: verifiedPromotion.canonical_oid,
    phase: 'PROMOTED',
    promotion_intent: null,
  };
  task.state = 'COMPLETED';
  task.completed_at = task.completed_at ?? new Date().toISOString();
  saveTask(task);
  return task;
}

function phase(task, saveTask, value) {
  task.trusted_import = { ...(task.trusted_import ?? {}), phase: value };
  saveTask(task);
}

/**
 * Run one task through the V2 Trusted Import path.
 *
 * The author function is injected by orchestrator.mjs so this module cannot
 * select an executor or turn model output into a command. It only consumes the
 * already trusted task definition and the bytes observed after QUIESCE.
 */
export async function runTrustedImportTask(task, {
  runAuthor,
  runReview,
  saveTask,
  onRunStart = null,
  terminationVerifier = null,
  trustedImportHooks = {},
} = {}) {
  const config = requireConfig(task);
  if (!config || typeof runAuthor !== 'function' || typeof runReview !== 'function' || typeof saveTask !== 'function') {
    throw trustedImportError('Trusted Import requires runAuthor, runReview, and saveTask adapters', 'TRUSTED_IMPORT_CONFIG_INVALID');
  }
  assertTrustedImportAdmission(task);

  const repoDir = assertPathString(task.fixture_dir, 'fixture_dir');
  const candidateDir = assertPathString(config.candidate_dir, 'trusted_import.candidate_dir');
  const casDir = assertPathString(config.cas_dir, 'trusted_import.cas_dir');
  const scratchDir = config.scratch_dir
    ? assertPathString(config.scratch_dir, 'trusted_import.scratch_dir')
    : join(candidateDir, '.af-scratch');
  const materializeDir = config.materialize_dir
    ? assertPathString(config.materialize_dir, 'trusted_import.materialize_dir')
    : null;

  assertSeparateWorkspace(repoDir, candidateDir, 'candidate_dir');
  assertSeparateWorkspace(repoDir, casDir, 'cas_dir');
  if (materializeDir) assertSeparateWorkspace(repoDir, materializeDir, 'materialize_dir');

  const policy = canonicalizePolicy(config.policy ?? {});
  const cas = new TrustedCAS({ casDir });
  let currentCanonicalOid = getCanonicalOid(repoDir);
  if (!currentCanonicalOid) {
    currentCanonicalOid = adoptRepository({ repoDir, fromCommitIsh: config.from_commit ?? 'HEAD' }).canonical_oid;
  }

  // A crash after update-ref leaves a durable intent. Complete that exact
  // transaction before considering a new author/review run.
  const recovered = recoverCommittedPromotion({
    task,
    config,
    repoDir,
    materializeDir,
    cas,
    policy,
    saveTask,
  });
  if (recovered) return recovered;

  // The persisted baseline is the branch point of this task. Reading the
  // latest canonical OID is only for detecting a concurrent advance; using it
  // as the task baseline would turn a stale candidate into an overwrite.
  let baselineOid = task.trusted_import.baseline_oid ?? currentCanonicalOid;
  const firstRun = task.trusted_import.phase === undefined || task.trusted_import.phase === 'CREATED';
  if (firstRun) {
    assertEmptyDirectory(candidateDir);
    mkdirSync(candidateDir, { recursive: true });
    phase(task, saveTask, 'PROJECTED');
  }

  let projectedBaselineSnapshot = task.trusted_import.projected_baseline_snapshot ?? null;
  if (!projectedBaselineSnapshot) {
    const projection = projectCandidate({
      repoDir,
      canonicalOid: baselineOid,
      targetDir: candidateDir,
      scratchDir,
      policy: policy.projection,
      cas,
    });
    projectedBaselineSnapshot = projection.projectedBaselineSnapshot;
    task.trusted_import = {
      ...task.trusted_import,
      projected_baseline_snapshot: projectedBaselineSnapshot,
      baseline_oid: baselineOid,
    };
    saveTask(task);
  }

  const hostIsolationRequested = Boolean(
    task.host_isolation === true
    || process.env.AF_REQUIRE_ISOLATION === '1'
    || process.env.AF_EXTERNAL_ISOLATION_VERIFIED === '1'
  );

  let authorAttempted = false;
  let reviewAttempted = false;
  let lastAuthorEvidence = null;
  let lastReviewEvidence = null;

  const trackedRuns = [];
  const handleRunStart = (runId, meta = {}) => {
    trackedRuns.push({ runId, meta, startedAt: new Date().toISOString() });
    if (typeof onRunStart === 'function') {
      try { onRunStart(runId, meta); } catch {}
    }
  };

  if (hostIsolationRequested) {
    engageTaskHostBoundary({ canonicalDir: repoDir, casDir, candidateDir });
  }

  try {
    if (!task.trusted_import.author_completed) {
      task.state = 'AUTHOR_RUNNING';
      phase(task, saveTask, 'AUTHOR_RUNNING');
      authorAttempted = true;
      const authorResult = await runAuthor(1, {
        cwd: candidateDir,
        onRunStart: (runId) => handleRunStart(runId, { role: 'author', phase: 'author' }),
      });
      lastAuthorEvidence = authorResult?.writer_termination;
      if (!terminationEvidenceConfirmed(authorResult.writer_termination)) {
        throw trustedImportError(
          'Author run completed without a verified terminated writer scope',
          'TRUSTED_IMPORT_WRITER_TERMINATION_UNCONFIRMED',
          { run_id: authorResult.executor_run_id ?? null },
        );
      }
      task.trusted_import = {
        ...task.trusted_import,
        author_completed: true,
        author_run_id: authorResult.executor_run_id ?? null,
        author_termination_evidence: authorResult.writer_termination,
      };
      saveTask(task);
    }

    task.state = 'TRUSTED_IMPORT_RUNNING';
    phase(task, saveTask, 'QUIESCE');
    const verifyTaskWriters = async () => {
      const evidence = [
        task.trusted_import.author_termination_evidence,
        task.trusted_import.last_reviewer_termination_evidence,
      ].filter(Boolean);
      const localProof = evidence.length > 0 && evidence.every(terminationEvidenceConfirmed);
      if (!localProof) return false;
      if (typeof terminationVerifier === 'function') {
        return (await terminationVerifier({ task, evidence })) === true;
      }
      return true;
    };
    const quiesceEvidence = await verifyQuiesced({ terminationVerifier: verifyTaskWriters });

    phase(task, saveTask, 'CAPTURE');
    const capture = hostIsolationRequested
      ? await withElevatedBoundary([casDir], async () => captureCandidateFS({
        candidateDir,
        scratchDir,
        cas,
        quiesceEvidence,
      }))
      : captureCandidateFS({
        candidateDir,
        scratchDir,
        cas,
        quiesceEvidence,
      });
  let candidateSnapshot = sealSnapshot({
    entries: capture.entries,
    metadata: { task_id: task.task_id, baseline_oid: baselineOid },
  });
  let manifest = computeManifest({ projectedBaselineSnapshot, candidateSnapshot });

  // Rebase from the task's persisted branch point before authorization or
  // promotion. The rebase helper first detects path collisions; the projected
  // baseline is then rebuilt through the policy projection so excluded files
  // never enter the candidate or the acceptance fixture.
  const latestCanonicalOid = getCanonicalOid(repoDir);
  if (latestCanonicalOid && latestCanonicalOid !== baselineOid) {
    const rebaseOutcome = rebaseCandidateDelta({
      repoDir,
      staleBaselineOid: baselineOid,
      currentCanonicalOid: latestCanonicalOid,
      candidateManifest: manifest,
      cas,
    });
    const projectionDir = mkdtempSync(join(tmpdir(), `afr-ti-rebase-${task.task_id}-`));
    try {
      const currentProjection = projectCandidate({
        repoDir,
        canonicalOid: latestCanonicalOid,
        targetDir: projectionDir,
        scratchDir: join(projectionDir, '.af-scratch'),
        policy: policy.projection,
        cas,
      });
      projectedBaselineSnapshot = currentProjection.projectedBaselineSnapshot;
      candidateSnapshot = applyManifestToProjectedSnapshot({
        projectedSnapshot: projectedBaselineSnapshot,
        manifest,
        cas,
        metadata: {
          task_id: task.task_id,
          baseline_oid: latestCanonicalOid,
          rebased_from: baselineOid,
        },
      });
      manifest = computeManifest({ projectedBaselineSnapshot, candidateSnapshot });
      replaceCandidateWithSnapshot({ candidateDir, scratchDir, snapshot: candidateSnapshot, cas });
    } finally {
      rmSync(projectionDir, { recursive: true, force: true });
    }
    baselineOid = latestCanonicalOid;
    task.trusted_import = {
      ...task.trusted_import,
      rebase: rebaseOutcome,
      baseline_oid: baselineOid,
      projected_baseline_snapshot: projectedBaselineSnapshot,
    };
  }
  task.trusted_import = {
    ...task.trusted_import,
    candidate_snapshot: candidateSnapshot,
    manifest,
    baseline_oid: baselineOid,
  };
  saveTask(task);

  // Review the sealed bytes from an isolated read-only fixture. This ensures a
  // reviewer sees the exact snapshot that will be accepted, including a clean
  // concurrent rebase, and cannot mutate the author candidate.
  if (task.trusted_import.review_snapshot_digest !== candidateSnapshot.snapshot_digest) {
    phase(task, saveTask, 'REVIEW');
    reviewAttempted = true;
    const reviewStageDir = mkdtempSync(join(tmpdir(), `afr-ti-review-${task.task_id}-`));
    try {
      materializeSnapshotForAcceptance({ stagingDir: reviewStageDir, snapshot: candidateSnapshot, cas });
      const review = await runReview(1, {
        cwd: reviewStageDir,
        onRunStart: (runId) => handleRunStart(runId, { role: 'reviewer', phase: 'review' }),
      });
      lastReviewEvidence = task.last_review_termination_evidence;
      task.trusted_import = {
        ...task.trusted_import,
        last_review: review,
        last_review_run_id: task.last_review_run_id ?? null,
        last_reviewer_termination_evidence: task.last_review_termination_evidence ?? null,
      };
      if (!terminationEvidenceConfirmed(task.last_review_termination_evidence)) {
        saveTask(task);
        throw trustedImportError(
          'Reviewer completed without a verified terminated writer scope',
          'TRUSTED_IMPORT_WRITER_TERMINATION_UNCONFIRMED',
          { run_id: task.trusted_import.last_review_run_id ?? null },
        );
      }
      if (review.decision !== 'PASS') {
        saveTask(task);
        throw trustedImportError(
          'Trusted Import independent review did not PASS',
          'TRUSTED_IMPORT_REVIEW_FAILED',
          { decision: review.decision, issues: review.issues ?? [], required_changes: review.required_changes ?? [] },
        );
      }
      task.trusted_import = {
        ...task.trusted_import,
        review_snapshot_digest: candidateSnapshot.snapshot_digest,
        review_completed: true,
      };
      saveTask(task);
    } finally {
      rmSync(reviewStageDir, { recursive: true, force: true });
    }
    // The reviewer is also an untrusted writer. Re-enter QUIESCE after it
    // exits, so no post-review child can race the authorization capture.
    await verifyQuiesced({ terminationVerifier: verifyTaskWriters });
  }

  phase(task, saveTask, 'AUTHORIZATION');
  const baselineEntries = readCanonicalEntries(repoDir, baselineOid);
  const scope = createScopeGrant({
    taskId: task.task_id,
    canonicalOid: baselineOid,
    proposedRequired: Array.isArray(config.proposed_required) ? config.proposed_required : [],
    proposedAnticipated: Array.isArray(config.proposed_anticipated) ? config.proposed_anticipated : [],
    policy,
  });
  const ledger = new AuthorizationLedger();
  const closure = ledger.verifyCumulativeClosure({
    cumulativeManifest: manifest,
    currentScopeGrant: scope,
    currentPolicy: policy,
    baselineOid,
    baselineCanonicalEntries: baselineEntries,
    fileContentResolver: baselineContentResolver({
      repoDir,
      baselineOid,
      baselineEntries,
      candidateSnapshot,
      cas,
    }),
  });
  task.trusted_import = { ...task.trusted_import, scope_grant: scope, authorization_closure: closure };
  saveTask(task);
  // Human Gate (Band D): a human must decide. Park durably BEFORE the pre-acceptance assertion,
  // which is designed to refuse any unresolved Human Gate item (so it would otherwise fail the
  // task and lose the pending decisions). A DENY or a needs-verifier case is NOT parked.
  if (parkForHumanGate({ task, closure, saveTask }).parked) return task;
  assertPreAcceptanceClosure(closure);
  if (!closure.satisfied) {
    throw trustedImportError(
      'Trusted Import authorization closure is not satisfied',
      'TRUSTED_IMPORT_AUTHORIZATION_BLOCKED',
      { verdict: closure.verdict, needsVerifier: closure.needsVerifier },
    );
  }

  phase(task, saveTask, 'ACCEPTANCE');
  const acceptance = acceptanceConfig(config);
  const spec = normalizeAcceptanceCmd(task.acceptance_cmd, {
    allowLegacy: task.allow_legacy_shell_acceptance === true,
  });
  if (!spec) {
    throw trustedImportError('Trusted Import requires an allowlisted task acceptance_cmd', 'TRUSTED_IMPORT_ACCEPTANCE_REQUIRED');
  }
  const acceptanceStageDir = mkdtempSync(join(tmpdir(), `afr-ti-${task.task_id}-`));
  let evidence;
  let acceptanceContext;
  try {
    materializeSnapshotForAcceptance({ stagingDir: acceptanceStageDir, snapshot: candidateSnapshot, cas });
    if (acceptance.tier === 'TierB' && acceptance.baseline_regression_closure !== false) {
      injectBaselineRegressionClosure({
        repoDir,
        baselineOid,
        stagingDir: acceptanceStageDir,
        testPathPatterns: acceptance.test_path_patterns ?? ['tests/**', 'test/**'],
      });
    }
    const acceptanceTask = {
      ...task,
      fixture_dir: acceptanceStageDir,
      acceptance_binding: task.acceptance_binding,
    };
    acceptanceContext = buildAcceptanceContext({
      acceptance,
      spec,
      candidateSnapshot,
      baselineOid,
      manifest,
      policy,
    });
    evidence = await runAcceptancePipeline({
      tier: acceptance.tier ?? 'TierA',
      stagingDir: acceptanceStageDir,
      ...acceptanceContext,
      trustedRunner: createTrustedAcceptanceRunner({ task: acceptanceTask }),
    });
  } finally {
    rmSync(acceptanceStageDir, { recursive: true, force: true });
  }

  task.trusted_import = {
    ...task.trusted_import,
    acceptance_evidence: evidence,
    acceptance_context: acceptanceContext,
  };
  saveTask(task);
  if (evidence.status !== 'PASS') {
    throw trustedImportError(
      'Trusted Import acceptance did not PASS; canonical ref was not changed',
      'TRUSTED_IMPORT_ACCEPTANCE_FAILED',
      { evidence_id: evidence.evidence_id },
    );
  }

  phase(task, saveTask, 'PROMOTION');
  const doPromotion = () => executeHardGPromotion({
    repoDir,
    baselineOid,
    authorizedChanges: manifest.changes,
    authorizationClosure: closure,
    acceptanceEvidence: evidence,
    acceptanceContext,
    cas,
    message: config.commit_message ?? `AFR Trusted Import: ${task.task_id}`,
    materializeDir,
    beforeRefUpdate: (plan) => {
      task.trusted_import = {
        ...task.trusted_import,
        promotion_intent: {
          task_id: task.task_id,
          baseline_oid: plan.baseline_oid,
          new_commit_oid: plan.new_commit_oid,
          tree_oid: plan.tree_oid,
          patch_digest: plan.patch_digest,
          acceptance_evidence_id: plan.acceptance_evidence_id,
          prepared_at: new Date().toISOString(),
        },
      };
      saveTask(task);
    },
    afterRefUpdate: (plan) => trustedImportHooks.afterRefUpdate?.(plan),
  });

  const promotion = hostIsolationRequested
    ? await withElevatedBoundary([repoDir], doPromotion)
    : doPromotion();

  task.trusted_import = {
    ...task.trusted_import,
    phase: 'PROMOTED',
    promotion,
    canonical_oid: promotion.canonical_oid,
    promotion_intent: null,
  };
  task.state = 'COMPLETED';
  task.completed_at = new Date().toISOString();
  saveTask(task);
  return task;
  } finally {
    if (hostIsolationRequested) {
      const authorTerminationOk = !authorAttempted
        || (task.trusted_import?.author_completed === true && terminationEvidenceConfirmed(lastAuthorEvidence || task.trusted_import?.author_termination_evidence));

      const reviewTerminationOk = !reviewAttempted
        || terminationEvidenceConfirmed(lastReviewEvidence || task.trusted_import?.last_reviewer_termination_evidence || task.last_review_termination_evidence);

      // Fail-closed scan: 'unknown' is NOT 'empty'. A scan that could not be completed
      // must retain the boundary exactly as live processes would, because the caller
      // cannot distinguish "confirmed quiesced" from "could not look".
      // Quiesce evidence (A2-AC8) is the writer termination gates; only then may the
      // bounded emptiness decision run. It re-observes scopes seen vanishing mid-scan
      // instead of treating them as empty, and never retries an anomaly away.
      const terminationConfirmed = authorTerminationOk && reviewTerminationOk;
      const lifecycleScopeDecision = decideWriterScopesEmpty({
        maxRescans: Number(process.env.AF_SCOPE_RESCAN_BUDGET ?? 3),
        quiesceConfirmed: terminationConfirmed,
      });
      const allWritersReaped = terminationConfirmed && lifecycleScopeDecision.decision === 'UNLOCK';

      let retentionReason = null;
      if (!allWritersReaped) {
        if (!terminationConfirmed) {
          retentionReason = 'Writer termination evidence was unconfirmed or failed; root DAC boundary retained to prevent tampering';
        } else if (lifecycleScopeDecision.reason === 'active-writer') {
          retentionReason = `Active processes remain in writer scopes (${lifecycleScopeDecision.scopes.flatMap((s) => s.pids).join(', ')})`;
        } else {
          const classes = (lifecycleScopeDecision.anomalies ?? []).map((a) => `${a.class}${a.code ? `/${a.code}` : ''}`);
          retentionReason = `Writer scope emptiness could not be confirmed: ${lifecycleScopeDecision.reason}`
            + `${lifecycleScopeDecision.attempts ? ` after ${lifecycleScopeDecision.attempts} scan(s)` : ''}`
            + `${classes.length ? ` [${classes.join(', ')}]` : ''}`;
        }
      }

      let restoreOutcome = null;
      let restoreReason = null;
      let restoreReport = null;
      // A2-AC7: the scope decision (including rescan-budget exhaustion) is recorded,
      // so a retained boundary is traceable and never a silent background retry.
      let scopeDecision = {
        decision: lifecycleScopeDecision.decision,
        reason: lifecycleScopeDecision.reason,
        status: lifecycleScopeDecision.status,
        attempts: lifecycleScopeDecision.attempts,
        quiesce_confirmed: terminationConfirmed,
        reaped_observations: lifecycleScopeDecision.reaped,
        anomalies: (lifecycleScopeDecision.anomalies ?? []).map((a) => ({ class: a.class, code: a.code ?? null, path: a.path ?? null })),
      };

      if (allWritersReaped) {
        // Quiesce evidence is mandatory on the lifecycle path (A2-AC8): the writer
        // termination gates above are that evidence.
        const disengage = disengageTaskHostBoundary({
          canonicalDir: repoDir,
          casDir,
          quiesceConfirmed: true,
        });
        restoreOutcome = disengage.outcome;
        restoreReason = disengage.reason;
        restoreReport = disengage.report
          ? {
            entries_restored: disengage.report.entries_restored,
            entries_skipped: disengage.report.entries_skipped,
            mismatch_count: disengage.report.mismatches.length,
            failures: disengage.report.failures,
            fallback: disengage.report.fallback,
          }
          : null;
        // A2-AC7: the scope decision (including a rescan-budget exhaustion) is
        // recorded so a retained boundary is traceable, never a silent retry.
        scopeDecision = disengage.scope_decision
          ? {
            quiesce_confirmed: true,
            decision: disengage.scope_decision.decision,
            reason: disengage.scope_decision.reason,
            status: disengage.scope_decision.status,
            attempts: disengage.scope_decision.attempts,
            reaped_observations: disengage.scope_decision.reaped,
            anomalies: (disengage.scope_decision.anomalies ?? []).map((a) => ({ class: a.class, code: a.code ?? null, path: a.path ?? null })),
          }
          : null;

        if (!disengage.disengaged && disengage.outcome !== 'RESTORE_INCOMPLETE') {
          retentionReason = disengage.reason
            || 'Boundary release was refused; root DAC boundary retained to prevent tampering';
        }
      }

      // A1b: a retained boundary must be visible and escalating, never a silent
      // background state. Alert failures must not break the lifecycle itself.
      let boundaryAlert = null;
      let boundaryAlertError = null;
      let notifyResult = null;
      if (restoreOutcome !== 'DISENGAGED') {
        try {
          boundaryAlert = recordBoundaryAlert({
            canonicalDir: repoDir,
            casDir,
            taskId: task.task_id,
            boundaryState: restoreOutcome === 'RESTORE_INCOMPLETE' ? 'RESTORE_INCOMPLETE' : 'PROTECTION_RETAINED_PENDING_RECOVERY',
            reason: restoreOutcome === 'RESTORE_INCOMPLETE' ? restoreReason : retentionReason,
            scopeDecision,
          });
          notifyResult = await notifyBoundaryAlert({
            event: 'boundary_retained',
            alert: {
              canonical_dir: repoDir,
              cas_dir: casDir,
              task_id: task.task_id,
              alert_id: boundaryAlert.alert_id,
              occurrences: boundaryAlert.occurrences,
              severity: boundaryAlert.severity,
              boundary_state: restoreOutcome === 'RESTORE_INCOMPLETE' ? 'RESTORE_INCOMPLETE' : 'PROTECTION_RETAINED_PENDING_RECOVERY',
              reason: restoreOutcome === 'RESTORE_INCOMPLETE' ? restoreReason : retentionReason,
            },
            scopeDecision,
          });
        } catch (err) {
          boundaryAlertError = err.message;
        }
      } else {
        try {
          resolveBoundaryAlert({ canonicalDir: repoDir, taskId: task.task_id, reason: 'boundary disengaged after verified restore' });
          // Release notification is off by default (AF_BOUNDARY_NOTIFY_ON_RELEASE).
          notifyResult = await notifyBoundaryAlert({
            event: 'boundary_released',
            alert: { canonical_dir: repoDir, cas_dir: casDir, task_id: task.task_id, occurrences: 0, severity: 'warning', boundary_state: 'DISENGAGED' },
          });
        } catch (err) {
          boundaryAlertError = err.message;
        }
      }

      if (restoreOutcome === 'DISENGAGED') {
        task.trusted_import = {
          ...task.trusted_import,
          boundary_state: 'DISENGAGED',
          boundary_retained_reason: null,
          boundary_restore: restoreReport,
          boundary_scope_decision: scopeDecision,
          boundary_alert: null,
          boundary_alert_error: boundaryAlertError,
          boundary_notify: notifyResult,
        };
      } else if (restoreOutcome === 'RESTORE_INCOMPLETE') {
        // The release ran but could not be verified: ownership is neither guarded
        // nor proven restored. Never report this as a clean unlock.
        task.trusted_import = {
          ...task.trusted_import,
          boundary_state: 'RESTORE_INCOMPLETE',
          boundary_retained_reason: restoreReason,
          boundary_restore: restoreReport,
          boundary_scope_decision: scopeDecision,
          boundary_alert: boundaryAlert,
          boundary_alert_error: boundaryAlertError,
          boundary_notify: notifyResult,
        };
      } else {
        task.trusted_import = {
          ...task.trusted_import,
          boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
          boundary_retained_reason: retentionReason,
          boundary_scope_decision: scopeDecision,
          boundary_alert: boundaryAlert,
          boundary_alert_error: boundaryAlertError,
          boundary_notify: notifyResult,
        };
      }
      saveTask(task);
    }
  }
}
