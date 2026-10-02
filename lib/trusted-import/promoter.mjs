// lib/trusted-import/promoter.mjs
//
// End-to-end Hard G Promotion Orchestrator (§10.1, §10.2).
// Bridges Target Canonical Tree construction, Git object creation,
// atomic CAS update-ref, and Worktree Materialization.

import { execFileSync } from 'node:child_process';
import { AfrError, CANONICAL_REF } from './common.mjs';
import { computeManifestDigest } from './manifest.mjs';
import { isTrustedAuthorizationClosure } from './ledger.mjs';
import { assertPromotionEvidence } from './evidence-record.mjs';
import { buildTargetCanonicalTree } from './target-tree.mjs';
import { writeGitTree, createGitCommit, promoteCanonicalRef } from './git-promoter.mjs';
import { materializeWorktree } from './materializer.mjs';

/**
 * Execute a complete Hard G Promotion.
 *
 * @param {object} options
 * @param {string} options.repoDir - Git repository path
 * @param {string} options.baselineOid - Current baseline Commit OID
 * @param {Array<object>} options.authorizedChanges - Changes approved by Gate / Ledger
 * @param {object} options.authorizationClosure - Trusted cumulative closure minted by AuthorizationLedger
 * @param {object} options.acceptanceEvidence - PASS Evidence Record for this exact candidate
 * @param {object} options.acceptanceContext - Full Evidence Binding context plus patchDigest
 * @param {import('./cas.mjs').TrustedCAS} options.cas - CAS holding candidate raw blobs
 * @param {string} [options.message='AFR Trusted Promotion']
 * @param {string|null} [options.materializeDir=null] - Host worktree directory to update
 * @param {(plan: object) => void|null} [options.beforeRefUpdate=null] - Durable transaction hook
 * @param {(plan: object) => void|null} [options.afterRefUpdate=null] - Fault-injection / audit hook after CAS update
 * @returns {object} Promotion result
 */
export function executeHardGPromotion({
  repoDir,
  baselineOid,
  authorizedChanges = [],
  authorizationClosure = null,
  acceptanceEvidence = null,
  acceptanceContext = null,
  cas,
  message = 'AFR Trusted Promotion',
  materializeDir = null,
  beforeRefUpdate = null,
  afterRefUpdate = null,
}) {
  if (!repoDir || !baselineOid || !cas) {
    throw new AfrError('repoDir, baselineOid, and cas are required for promotion', 'INVALID_ARGUMENT');
  }

  if (!isTrustedAuthorizationClosure(authorizationClosure) || authorizationClosure.satisfied !== true) {
    throw new AfrError(
      'Promotion requires a satisfied AuthorizationLedger closure',
      'PROMOTION_AUTHORIZATION_REQUIRED'
    );
  }

  if (authorizationClosure.baseline_oid !== baselineOid) {
    throw new AfrError(
      'Authorization closure baseline does not match promotion baseline',
      'PROMOTION_AUTHORIZATION_MISMATCH',
      { closureBaselineOid: authorizationClosure.baseline_oid, baselineOid }
    );
  }

  const patchDigest = computeManifestDigest(authorizedChanges);
  if (authorizationClosure.cumulative_manifest_digest !== patchDigest) {
    throw new AfrError(
      'Authorization closure does not cover the supplied promotion patch',
      'PROMOTION_AUTHORIZATION_MISMATCH',
      {
        closureManifestDigest: authorizationClosure.cumulative_manifest_digest,
        patchDigest,
      }
    );
  }

  if (!acceptanceEvidence || !acceptanceContext) {
    throw new AfrError(
      'Promotion requires a PASS acceptance evidence record and its complete binding context',
      'PROMOTION_ACCEPTANCE_REQUIRED'
    );
  }
  if (acceptanceContext.patchDigest !== patchDigest) {
    throw new AfrError(
      'Acceptance evidence context does not cover the supplied promotion patch',
      'PROMOTION_ACCEPTANCE_MISMATCH',
      { contextPatchDigest: acceptanceContext.patchDigest, patchDigest }
    );
  }
  assertPromotionEvidence(acceptanceEvidence, acceptanceContext);

  // 1. Fetch full baseline canonical entries
  const lsTreeOutput = execFileSync('git', ['ls-tree', '-r', '-z', baselineOid], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const baselineEntries = [];
  const rawEntries = lsTreeOutput ? lsTreeOutput.split('\0').filter(Boolean) : [];
  for (const line of rawEntries) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;
    const meta = line.slice(0, tabIdx);
    const path = line.slice(tabIdx + 1);
    const [modeStr, type, oid] = meta.split(' ');
    if (type === 'blob') {
      baselineEntries.push({ path, mode: modeStr, type: 'blob', oid });
    }
  }

  // 2. Construct Target Canonical Tree (Formula: Target = Baseline + Authorized Patch, TI-25)
  const { targetEntries } = buildTargetCanonicalTree({
    baselineCanonicalEntries: baselineEntries,
    authorizedChanges,
    cas,
    repoDir,
  });

  // 3. Write Git Tree Object directly in Git DB
  const treeOid = writeGitTree({
    repoDir,
    targetEntries,
  });

  // 4. Create Git Commit Object
  const newCommitOid = createGitCommit({
    repoDir,
    treeOid,
    parentOid: baselineOid,
    message,
  });

  // Final Revalidation: all security-critical inputs are checked again after
  // object construction and immediately before the CAS update-ref. This
  // catches a concurrent canonical advance and prevents a stale acceptance or
  // authorization closure from being used at the commit boundary.
  const currentCanonicalOid = execFileSync('git', ['rev-parse', CANONICAL_REF], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (currentCanonicalOid !== baselineOid) {
    throw new AfrError(
      'Canonical baseline changed during promotion; refusing stale finalization',
      'PROMOTION_BASELINE_STALE',
      { expected: baselineOid, actual: currentCanonicalOid }
    );
  }
  if (!isTrustedAuthorizationClosure(authorizationClosure)
      || authorizationClosure.satisfied !== true
      || authorizationClosure.baseline_oid !== baselineOid
      || authorizationClosure.cumulative_manifest_digest !== patchDigest) {
    throw new AfrError('Authorization closure failed final revalidation', 'PROMOTION_AUTHORIZATION_INVALID');
  }
  assertPromotionEvidence(acceptanceEvidence, acceptanceContext);

  const promotionPlan = Object.freeze({
    baseline_oid: baselineOid,
    new_commit_oid: newCommitOid,
    tree_oid: treeOid,
    patch_digest: patchDigest,
    acceptance_evidence_id: acceptanceEvidence.evidence_id,
  });
  // The caller must durably record this plan before update-ref. If the control
  // plane dies after the CAS write, the next process can prove whether the
  // exact transaction committed and finish it without replaying the patch.
  beforeRefUpdate?.(promotionPlan);

  // 5. Atomic CAS update-ref (TI-13)
  const refResult = promoteCanonicalRef({
    repoDir,
    newCommitOid,
    expectedOldOid: baselineOid,
  });
  afterRefUpdate?.(promotionPlan);

  // 6. Materialize host worktree cache if directory specified (TI-12, TI-14)
  let materializationResult = null;
  if (materializeDir) {
    materializationResult = materializeWorktree({
      repoDir,
      canonicalOid: newCommitOid,
      destinationDir: materializeDir,
      cleanExisting: true,
      verifyHash: true,
    });
  }

  return Object.freeze({
    status: 'PROMOTED',
    canonical_ref: CANONICAL_REF,
    canonical_oid: newCommitOid,
    tree_oid: treeOid,
    previous_oid: baselineOid,
    target_entries_count: targetEntries.length,
    materialization: materializationResult,
    acceptance_evidence_id: acceptanceEvidence.evidence_id,
    promoted_at: new Date().toISOString(),
  });
}

/**
 * Verify the Git objects left by a promotion transaction after a process crash.
 * The promoted commit OID, its parent and its tree are all checked against the
 * durable intent before the task can be marked completed. Recovery may also
 * accept a later canonical commit when the promoted commit is an ancestor of
 * the current ref; that proves another task advanced canonical after this
 * transaction and avoids treating an already successful task as unfinished.
 */
export function verifyPromotedCommit({ repoDir, canonicalOid, intent, allowDescendant = false }) {
  if (!repoDir || !canonicalOid || !intent) {
    throw new AfrError('repoDir, canonicalOid, and intent are required for promotion recovery', 'INVALID_ARGUMENT');
  }
  const actualOid = execFileSync('git', ['rev-parse', CANONICAL_REF], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const promotedOid = intent.new_commit_oid;
  const treeOid = execFileSync('git', ['rev-parse', `${promotedOid}^{tree}`], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const parentOid = execFileSync('git', ['rev-parse', `${promotedOid}^`], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  let promotedIsCanonical = actualOid === promotedOid;
  let promotedIsAncestor = promotedIsCanonical;
  if (!promotedIsCanonical && allowDescendant) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', promotedOid, actualOid], {
        cwd: repoDir,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      promotedIsAncestor = true;
    } catch {
      promotedIsAncestor = false;
    }
  }
  if (!promotedIsAncestor
      || treeOid !== intent.tree_oid
      || parentOid !== intent.baseline_oid) {
    throw new AfrError(
      'Promotion intent does not match the current canonical commit; refusing recovery finalization',
      'PROMOTION_RECOVERY_MISMATCH',
      {
        actualOid,
        expectedOid: promotedOid,
        allowDescendant,
        promotedIsAncestor,
        treeOid,
        expectedTreeOid: intent.tree_oid,
        parentOid,
        expectedParentOid: intent.baseline_oid,
      },
    );
  }
  return Object.freeze({
    canonical_oid: actualOid,
    promoted_oid: promotedOid,
    tree_oid: treeOid,
    parent_oid: parentOid,
    promoted_is_ancestor: promotedIsAncestor,
  });
}
