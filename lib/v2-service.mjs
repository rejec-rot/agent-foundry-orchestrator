// v2-service.mjs - the dedicated V2 submission and EXECUTION OWNERSHIP service (§6 G2).
//
// Why this exists: the legacy `submitTask` defaults to `withPlan=true`/`withIntentGate=true`, so a
// V2 task submitted through it can wander into the legacy planning/approval path, and an HTTP handler
// that calls `executeTask` directly ties the run's lifetime to the request. This module replaces
// both: it validates, resolves trusted configuration, assigns the control-plane-owned workspace
// paths, persists the task record, and hands the run to a SINGLE lock-guarded owner.
//
// Guarantees:
//   * the submitter never chooses executors, roles, limits or paths (platform-bound), and the
//     created record carries `multi_step_dispatch: false` with no plan attached - the legacy
//     planning path is never consulted here (asserted by a static guard in the tests);
//   * creation is IDEMPOTENT per idempotency key: the first writer binds the key to a task and any
//     retry returns that same task instead of creating a second one;
//   * starting is owned by exactly one process at a time via the existing task lock, and a second
//     start is refused rather than racing; a restart RESUMES from the durable phase machine, so the
//     author is never re-run;
//   * terminal tasks are refused; a FAILED V2 task needs the explicit re-entry authorisation.

import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { planPreview } from './submission.mjs';
import { resolveAcceptanceProfile, resolveProject } from './projects.mjs';
import { disabledExecutors } from './operator-control.mjs';
import { ADAPTERS, AUTO_SELECTABLE_ORDER } from './adapters.mjs';
import { saveTaskAtomic } from './store.mjs';
import { acquireTaskLock, releaseTaskLock } from './tasklock.mjs';

export const V2_TASK_SCHEMA = 'af-v2-task-v1';
export const V2_TERMINAL_STATES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED']);
export const V2_RESUMABLE_STATES = Object.freeze(['TRUSTED_IMPORT_RUNNING', 'AUTHOR_RUNNING', 'REVIEW_RUNNING']);

/** Path containment without following the last component; both sides are resolved first. */
function isInside(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

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
} = {}) {
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
    if (submitted !== trusted) {
      return { ok: false, reason: `the submitted acceptance ("${submitted}") is not the registered profile's acceptance ("${trusted}")` };
    }
  }

  const key = String(spec.idempotency_key).trim();
  const digest = keyDigest(key);
  // The task id is derived here because the workspace assignment below is named after it.
  const taskId = `TASK-V2-${digest.slice(0, 8)}-${now().getTime().toString(36)}`;

  // Platform-bound configuration: the control plane assigns the workspace, never the submitter.
  const targetPath = spec.target_path;
  const root = workspaceRoot || env.AF_V2_WORKSPACE_ROOT || join(tasksDir, '..', 'v2-workspaces');
  const candidateDir = join(root, taskId, 'candidate');
  const casDir = join(root, taskId, 'cas');

  if (isInside(targetPath, candidateDir) || isInside(candidateDir, targetPath)) {
    return { ok: false, reason: 'the assigned candidate directory must not overlap the target repository' };
  }
  if (isInside(targetPath, casDir) || isInside(casDir, targetPath)) {
    return { ok: false, reason: 'the assigned CAS directory must not overlap the target repository' };
  }
  if (resolve(candidateDir) === resolve(casDir)) return { ok: false, reason: 'the candidate and CAS directories must be distinct' };
  // A task whose executor the operator disabled would be created and then fail at run time; refuse
  // it at creation, naming the executor, instead of producing a task that can never run.
  const disabled = new Set(disabledExecutors());
  for (const role of ['author', 'reviewer']) {
    const chosen = role === 'author' ? authorExecutor : reviewerExecutor;
    if (chosen && disabled.has(chosen)) return { ok: false, reason: `the ${role} executor "${chosen}" is disabled by the operator (config/operator-executors.json)` };
  }
  // Health, not just the disable list: a name in the preference order is not evidence that the CLI
  // is installed on THIS host. Binding `claude` where its launcher is missing would create a task
  // that cannot run, which is exactly the guess this system forbids.
  const candidateIds = [...AUTO_SELECTABLE_ORDER, ...Object.keys(ADAPTERS).filter((id) => !AUTO_SELECTABLE_ORDER.includes(id))];
  const usable = candidateIds.filter((id) => {
    if (disabled.has(id)) return false;
    const adapter = ADAPTERS[id];
    if (!adapter) return false;
    try { return adapter.health?.().ok === true; } catch { return false; }
  });
  const boundAuthor = authorExecutor ?? usable[0] ?? null;
  const boundReviewer = reviewerExecutor ?? usable.find((id) => id !== boundAuthor) ?? null;
  if (!boundAuthor || !boundReviewer) {
    return { ok: false, reason: `no usable executors are available to bind (disabled: ${[...disabled].join(', ') || 'none'}); set AF_V2_AUTHOR_EXECUTOR / AF_V2_REVIEWER_EXECUTOR explicitly` };
  }
  if (boundAuthor === boundReviewer) {
    return { ok: false, reason: 'the platform must bind two DIFFERENT executors for the author and the independent reviewer' };
  }


  const dir = submissionsDir || join(tasksDir, '..', 'submissions');
  mkdirSync(dir, { recursive: true });
  const bindingPath = join(dir, `${digest}.task.json`);
  const binding = { schema_version: V2_TASK_SCHEMA, key_digest: digest, task_id: taskId, created_at: now().toISOString() };
  const tmp = `${bindingPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
  let created = true;
  try {
    linkSync(tmp, bindingPath);
  } catch (err) {
    if (err?.code !== 'EEXIST') { rmSync(tmp, { force: true }); return { ok: false, reason: `the submission binding could not be published: ${err.message}` }; }
    created = false;
  } finally {
    rmSync(tmp, { force: true });
  }
  if (!created) {
    const existing = JSON.parse(readFileSync(bindingPath, 'utf8'));
    const existingTask = readTaskFile(tasksDir, existing.task_id);
    if (!existingTask) {
      // A binding whose task never landed must never masquerade as an existing task.
      return { ok: false, reason: `the idempotency key ${key} is bound to ${existing.task_id}, but that task record does not exist; remove the binding to retry` };
    }
    return { ok: true, created: false, task_id: existing.task_id, task: existingTask, reason: 'this idempotency key already created a task (the original is returned)' };
  }

  // Only now that this submission owns the key do we create its workspace.
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
    fixture_dir: targetPath,
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
      phase: null,
      candidate_dir: candidateDir,
      cas_dir: casDir,
      proposed_required: Array.isArray(spec.proposed_required) && spec.proposed_required.length > 0 ? spec.proposed_required : ['.'],
      source_submission: { key_digest: digest },
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

  return {
    ok: true,
    created: true,
    task_id: taskId,
    operation_id: `op-${digest.slice(0, 12)}`,
    task,
    reason: null,
  };
}

/** Same derivation as lib/submission.mjs (sha256 of the trimmed key, first 16 hex chars) so a
 *  submission record and this binding always agree on which task a key maps to. */
function keyDigest(key) {
  return createHash('sha256').update(String(key).trim()).digest('hex').slice(0, 16);
}

function readTaskFile(tasksDir, taskId) {
  try {
    return JSON.parse(readFileSync(join(tasksDir, `${taskId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Take execution ownership and hand the run to `runner`. Exactly one owner at a time (task lock);
 * a second concurrent start is refused, and a restart resumes instead of re-running the author.
 *
 * @returns {{ ok: boolean, outcome: 'started'|'resumed'|'refused'|'already_running', task_id: string,
 *   mode?: 'start'|'resume', reason?: string| null, holder?: object }}
 */
export async function startOrResumeV2Task({
  taskId,
  tasksDir,
  locksDir,
  runner,
  orchestratorInstanceId = `v2-service-${process.pid}`,
  allowFailedReentry = false,
  leaseMs = 15 * 60_000,
} = {}) {
  if (!taskId || !tasksDir) return { ok: false, outcome: 'refused', task_id: taskId ?? null, reason: 'taskId and tasksDir are required' };
  if (typeof runner !== 'function') return { ok: false, outcome: 'refused', task_id: taskId, reason: 'a runner is required' };

  const task = readTaskFile(tasksDir, taskId);
  if (!task) return { ok: false, outcome: 'refused', task_id: taskId, reason: 'no such task' };
  if (task.trusted_import?.enabled !== true) return { ok: false, outcome: 'refused', task_id: taskId, reason: 'not a V2 trusted-import task' };
  if (!task.trusted_import.acceptance?.acceptance_profile_digest) {
    return { ok: false, outcome: 'refused', task_id: taskId, reason: 'no trusted acceptance profile is bound to this task; create it through a registered project profile' };
  }
  if (task.state === 'WAITING_HUMAN') return { ok: false, outcome: 'refused', task_id: taskId, reason: 'the task is parked at the Human Gate; resolve it first' };
  if (V2_TERMINAL_STATES.includes(task.state) && !(task.state === 'FAILED' && allowFailedReentry === true)) {
    return { ok: false, outcome: 'refused', task_id: taskId, reason: `task is ${task.state}; a terminal task is not started by this service` };
  }

  let lock;
  try {
    lock = acquireTaskLock(locksDir, taskId, { orchestratorInstanceId, leaseMs });
  } catch (err) {
    // The lock module reports contention by THROWING; that is a refusal here, never a race.
    if (err?.code === 'TASK_ALREADY_RUNNING') {
      return { ok: false, outcome: 'already_running', task_id: taskId, reason: 'another owner holds the task lock', holder: err.lock ?? null };
    }
    throw err;
  }
  const mode = task.state === 'CREATED' ? 'start' : 'resume';
  try {
    await runner({ task, mode });
    return { ok: true, outcome: mode === 'start' ? 'started' : 'resumed', mode, task_id: taskId, reason: null };
  } finally {
    releaseTaskLock(locksDir, taskId, lock.lock);
  }
}
