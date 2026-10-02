// V2 intake: validate the submission, bind a trusted project profile and publish one task.
// Execution ownership lives in execution-manager.mjs; no legacy planning is consulted.

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { planPreview, submissionDir } from './submission.mjs';
import { withSubmissionRecord, submissionKeyDigest, submissionRequestMetadata } from './submission-store.mjs';
import { capsuleDigest } from './json-identity.mjs';
import { executorEligibility } from './executor-eligibility.mjs';
import { loadCapabilityMap } from './executor-router.mjs';
import { loadExecutorStatus } from './executor-status.mjs';
import { runtimeGuard as defaultRuntimeGuard } from './executor-runtime-guard.mjs';
import { canonicalize } from './data-roots.mjs';
import { assignProjectDirs, resolveAcceptanceProfile, resolveProject } from './projects.mjs';
import { disabledExecutors } from './operator-control.mjs';
import { ADAPTERS, AUTO_SELECTABLE_ORDER } from './adapters.mjs';
import { saveTaskAtomic } from './store.mjs';

import { V2_TASK_SCHEMA } from './v2-task.mjs';
export { V2_TASK_SCHEMA, V2_TERMINAL_STATES } from './v2-task.mjs';
export const V2_RESUMABLE_STATES = Object.freeze(['TRUSTED_IMPORT_RUNNING', 'AUTHOR_RUNNING', 'REVIEW_RUNNING']);

/**
 * Create (or return the already-created) V2 task for a submission.
 *
 * @returns {{ ok: boolean, created?: boolean, task_id?: string, operation_id?: string,
 *   task?: object, reason?: string, first_failure?: string }}
 */
export function createV2Task({
  spec,
  allowedRoots = [],
  tasksDir,
  submissionsDir = null,
  workspaceRoot = null,
  // The platform binds the executors (the submitter never chooses them). Null means "pick from the
  // executors that are actually usable": the fixed preference order minus anything the operator
  // disabled, with the reviewer always a DIFFERENT executor. Hardcoding `codex` here would bind a
  // task to whatever happens to be out of quota today.
  authorExecutor = process.env.AF_V2_AUTHOR_EXECUTOR || null,
  reviewerExecutor = process.env.AF_V2_REVIEWER_EXECUTOR || null,
  // Control-plane-only option used by team intake; the HTTP submission spec cannot set it.
  teamReviewMode = false,
  profileId = null,
  // The §6 G6 registry: when one is configured it is the ONLY source of the acceptance identity
  // and the change policy. A target that is not a registered project is refused rather than
  // defaulted, because the acceptance digests are what the promotion is bound to.
  projectRegistry = null,
  registryFile = null,
  registryDigest = null,
  allowlist = null,
  acceptanceCommandAllowed = null,
  maxRevisions = 3,
  env = process.env,
  now = () => new Date(),
  adapters = ADAPTERS,
  capabilityMap = loadCapabilityMap(),
  availabilityMap = loadExecutorStatus(),
  runtimeGuard = defaultRuntimeGuard,
} = {}) {
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0) return { ok: false, reason: 'maxRevisions must be a non-negative integer' };
  if (!tasksDir) return { ok: false, reason: 'tasksDir is required' };
  const preflight = planPreview({ spec, allowedRoots, env });
  if (!preflight.ok) return { ok: false, reason: preflight.reason, first_failure: preflight.first_failure };

  if (!projectRegistry) {
    return { ok: false, reason: 'no project registry is configured, so no trusted acceptance profile can be bound; configure config/projects.json (or AF_PROJECTS_FILE) first' };
  }
  let project = null;
  let profile = null;
  {
    const resolvedProject = resolveProject({ registry: projectRegistry, targetRoot: spec.target_path });
    if (!resolvedProject.ok) return { ok: false, reason: resolvedProject.reason };
    project = resolvedProject.project;
    const resolvedProfile = resolveAcceptanceProfile({
      registry: projectRegistry,
      registryFile,
      registryDigest,
      projectId: project.project_id,
      profileId: profileId ?? spec.profile_id ?? null,
      allowlist,
      acceptanceCommandAllowed,
    });
    if (!resolvedProfile.ok) return { ok: false, reason: resolvedProfile.reason };
    profile = resolvedProfile;
    // The submitted acceptance must BE the profile's acceptance: a task whose acceptance command
    // drifted from the trusted profile is refused, never silently rewritten.
    const submitted = `${spec.acceptance.command} ${(spec.acceptance.args ?? []).join(' ')}`.trim();
    const trusted = `${profile.identity.acceptance.command} ${profile.identity.acceptance.args.join(' ')}`.trim();
    if (capsuleDigest({ command: spec.acceptance.command, args: spec.acceptance.args ?? [] }) !== capsuleDigest(profile.identity.acceptance)) {
      return { ok: false, reason: `the submitted acceptance ("${submitted}") is not the registered profile's acceptance ("${trusted}")` };
    }
  }

  const digest = submissionKeyDigest(spec.idempotency_key);
  const dir = submissionsDir || submissionDir(env);
  const creationDigest = capsuleDigest({ project_id: project.project_id, profile_digest: profile.profile_digest, profile_id: profileId ?? spec.profile_id ?? null, tasks_dir: canonicalize(tasksDir) });
  const result = withSubmissionRecord({ dir, spec, capsule: preflight.capsule, stripped: preflight.stripped_fields, now: now().getTime() }, ({ record, persist }) => {
    // Compatibility: older releases kept a separate key-to-task binding. Read it once, then
    // continue in the canonical ledger; no new .task.json file is created.
    let legacy = null;
    if (!record.task_id) {
      const legacyDirs = new Set([dir, join(tasksDir, '..', 'submissions')]);
      for (const legacyDir of legacyDirs) {
        try { legacy = JSON.parse(readFileSync(join(legacyDir, `${digest}.task.json`), 'utf8')); break; }
        catch (err) { if (err.code !== 'ENOENT') return { ok: false, reason: `legacy submission binding unreadable: ${err.message}` }; }
      }
    }
    const taskId = record.task_id ?? legacy?.task_id ?? `TASK-V2-${digest}`;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) return { ok: false, reason: 'invalid task id in submission binding' };
    if (record.creation_digest && record.creation_digest !== creationDigest) return { ok: false, reason: 'the idempotency key is already bound to a different trusted project/profile' };
    const existingTask = readTaskFile(tasksDir, taskId);
    if (existingTask) {
      {
        const original = { goal: existingTask.goal, target_path: existingTask.fixture_dir, acceptance: existingTask.acceptance_cmd };
        if (existingTask.context !== undefined) original.context = existingTask.context;
        if (existingTask.source_agent !== undefined) original.source_agent = existingTask.source_agent;
        const originalDigest = existingTask.trusted_import?.source_submission?.spec_digest ?? capsuleDigest(original);
        if (originalDigest !== record.spec_digest || capsuleDigest(existingTask.trusted_import?.proposed_required ?? ['.']) !== capsuleDigest(submissionRequestMetadata(spec).proposed_required)) {
          return { ok: false, reason: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_SPEC: the legacy task has a different submission' };
        }
        if (existingTask.trusted_import?.acceptance?.acceptance_profile_digest !== profile.profile_digest) return { ok: false, reason: 'the original task is bound to a different trusted acceptance profile' };
      }
      record.task_id = taskId;
      record.creation_digest = creationDigest;
      record.state = 'TASK_CREATED';
      persist();
      return { ok: true, created: false, task_id: taskId, task: existingTask, reason: 'this idempotency key already created a task (the original is returned)' };
    }
    const assigned = assignProjectDirs({ project, taskId, workspaceRoot: workspaceRoot || env.AF_V2_WORKSPACE_ROOT || project.workspace_root || join(tasksDir, '..', 'v2-workspaces') });
    if (!assigned.ok) return { ok: false, reason: assigned.reason.replace('overlaps the project root', 'must not overlap the target repository') };
    const candidateDir = assigned.candidate_dir;
    const casDir = assigned.cas_dir;
    const disabled = disabledExecutors();
    const eligibility = { adapters, capabilityMap, availabilityMap, runtimeGuard, disabled, requireHealth: true };
    const ids = [...AUTO_SELECTABLE_ORDER, ...Object.keys(adapters).filter((id) => !AUTO_SELECTABLE_ORDER.includes(id))];
    const usable = ids.filter((id) => executorEligibility(id, {}, eligibility).ok);
    const boundAuthor = authorExecutor ?? usable[0] ?? null;
    const boundReviewer = teamReviewMode ? boundAuthor : reviewerExecutor ?? usable.find((id) => id !== boundAuthor) ?? null;
    for (const [role, id] of [['author', boundAuthor], ['reviewer', boundReviewer]]) {
      if (!id) return { ok: false, reason: `no usable executor is available for ${role}` };
      const check = executorEligibility(id, {}, eligibility);
      if (!check.ok) return { ok: false, reason: disabled.includes(id) ? `the ${role} executor "${id}" is disabled by the operator` : `the ${role} ${check.reason}` };
    }
    if (boundAuthor === boundReviewer && !teamReviewMode) return { ok: false, reason: 'the platform must bind two DIFFERENT executors for the author and the independent reviewer' };
    record.task_id = taskId;
    record.creation_digest = creationDigest;
    record.state = 'CREATING';
    persist();
    mkdirSync(tasksDir, { recursive: true });
    mkdirSync(candidateDir, { recursive: true });
    mkdirSync(casDir, { recursive: true });
    const task = {
      task_id: taskId,
      schema_version: V2_TASK_SCHEMA,
      task_mode: 'workspace',
      state: 'CREATED',
      state_version: 1,
      created_at: now().toISOString(),
      goal: spec.goal,
      context: spec.context,
      source_agent: spec.source_agent,
      fixture_dir: spec.target_path,
      acceptance_cmd: { command: spec.acceptance.command, args: spec.acceptance.args ?? [] },
      // The author capsule reads `acceptance` and `red_lines` directly, so they must exist.
      acceptance: `the acceptance command passes in the workspace: ${spec.acceptance.command} ${(spec.acceptance.args ?? []).join(' ')}`.trim(),
      red_lines: [],
      max_revisions: maxRevisions,
      acceptance_binding: null,
      // The legacy multi-step planning path is deliberately not part of this service: dispatch stays
      // single-flow and no plan is ever attached to the record.
      multi_step_dispatch: false,
      requires_mcp: false,
      author_executor: boundAuthor,
      reviewer_executor: boundReviewer,
      author_role: 'author',
      reviewer_role: 'reviewer',
      runs: [],
      trusted_import: {
        enabled: true,
        phase: 'CREATED',
        max_revisions: maxRevisions,
        revisions_used: 0,
        candidate_dir: candidateDir,
        cas_dir: casDir,
        proposed_required: submissionRequestMetadata(spec).proposed_required,
        source_submission: { key_digest: digest, spec_digest: record.spec_digest },
        // Trusted-import acceptance identity: only from the control-plane profile (§6 G6).
        acceptance: profile
          ? {
            tier: project.tier ?? 'TierA',
            acceptance_profile_digest: profile.profile_digest,
            acceptance_assets_digest: profile.assets_digest,
            dependency_fixture_id: profile.identity.project_id,
          }
          : null,
        policy: project?.policy ?? null,
        profile_provenance: profile?.provenance ?? null,
      },
    };
    saveTaskAtomic(join(tasksDir, `${taskId}.json`), task);
    record.state = 'TASK_CREATED';
    record.task_created_at = now().toISOString();
    persist();
    return { ok: true, created: true, task_id: taskId, operation_id: `op-${digest.slice(0, 12)}`, task, reason: null };
  });
  return result;
}

function readTaskFile(tasksDir, taskId) {
  try { return JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

// Compatibility exports; ownership is implemented in one manager.
export { startOrResumeV2Task, dispatchV2Task } from './execution-manager.mjs';
