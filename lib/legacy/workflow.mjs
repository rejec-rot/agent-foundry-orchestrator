// Legacy workspace, governance and planned-step workflows. Public compatibility lives in orchestrator.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { ADAPTERS, selectExecutor } from '../adapters.mjs';
import { classifyExecutionError } from '../executor-error-classifier.mjs';
import { runAcceptance } from '../acceptance.mjs';
import { captureRestorePoint } from '../rollback.mjs';
import { GovernanceBridge, classifyPublishVerdict } from '../governance.mjs';
import { latestAuthorRun } from '../reviews.mjs';
import { authorResultPersisted, reviewResultPersisted, latestAuthoritativeAcceptance } from '../recovery.mjs';
import { WorktreeSession, buildPlanBatches } from '../worktree.mjs';
import { TASKS_DIR, MAX_REVISIONS_DEFAULT, TERMINAL_STATES, NON_REVIVABLE_STATES, saveTask, loadTask, withTaskContext, tasksDirOf } from '../task-runtime.mjs';
import { runAuthor, runReview, recordRun, extractJson } from '../task-execution.mjs';
import { prepareTaskForExecution, settleExecutionError } from '../workflow-state.mjs';

// Executes the task-defined acceptance command (trusted source only - see
// lib/acceptance.mjs). Agent output is never consulted for commands.
// An acceptance result is reused on recovery only for the EXACT author content
// it validated (content-addressed reuse). Comparing the revision alone was not
// enough: a bounded retry or an executor fallback re-runs the author WITHOUT
// bumping the revision, so a stale record could mark fresh content as verified.
// Records written before this binding existed carry no content_sha256 and are
// therefore never reused (conservative migration for historical tasks).
function authorContentSha(task) {
  const content = typeof task.last_author_content === 'string' ? task.last_author_content : '';
  return createHash('sha256').update(content).digest('hex');
}

async function acceptanceGate(task, revision) {
  const prev = latestAuthoritativeAcceptance(task);
  const currentSha = authorContentSha(task);
  if (prev && prev.content_sha256 && prev.content_sha256 === currentSha) {
    return {
      ok: prev.exit_code === 0,
      output: prev.stdout_summary,
      reused: true,
      record: prev,
    };
  }
  const acc = await runAcceptance(task);
  if (acc.record) {
    acc.record.revision = revision;
    acc.record.author_run_id = latestAuthorRun(task)?.executor_run_id ?? null;
    acc.record.content_sha256 = currentSha;
    task.acceptance_runs = task.acceptance_runs ?? [];
    task.acceptance_runs.push(acc.record);
  }

  // P7: remember the exact state that PASSED, so a later revision can be rolled
  // back to it (lib/rollback.mjs). Opt-in, because capturing brings the git index
  // in line with the working tree - a visible side effect in a workspace the
  // orchestrator may not own. A refusal is RECORDED with its reason, never
  // swallowed: a workspace that cannot hold restore points must not look like one
  // that silently did nothing.
  if (acc.ok && process.env.AF_RESTORE_POINTS === 'on') {
    const point = captureRestorePoint({
      dir: task.fixture_dir,
      taskId: task.task_id,
      revision,
      label: 'acceptance passed',
    });
    task.restore_points = task.restore_points ?? [];
    task.restore_points.push(point.ok
      ? { revision, sha: point.sha, ref: point.ref, captured_at: point.captured_at, label: point.label }
      : { revision, captured: false, reason: point.reason });
  }
  return acc;
}

// ---------------------------------------------------------------- Phase 2
// Governance Bridge flow (governed_write tasks). Coordination only:
// candidate creation, formal review evidence and the publish verdict are all
// produced by vault-mcp; this function copies verdicts into the observed
// mirror (governance_source = "vault-mcp") and maps them to Control Plane
// states. Agent-reported policy decisions are recorded as correlation data
// and NEVER trusted as the verdict.
function governanceMirror(task) {
  task.governance = task.governance ?? { governance_source: 'vault-mcp' };
  return task.governance;
}

// governed_write: the author's <PAGE> reply is staged into the workspace so
// the QA reviewer can read the exact bytes that would be published.
function stageSubmission(task) {
  const page = extractPageContent(task.last_author_content ?? '');
  if (!page) return;
  const p = join(task.fixture_dir, 'orchestrator-submission.md');
  writeFileSync(p, page);
  task.submission_path = p;
}

function extractPageContent(text) {
  const m = (text ?? '').match(/<PAGE>\s*([\s\S]*?)\s*<\/PAGE>/);
  return m ? m[1] : null;
}

function lastAuthorContent(task) {
  if (task.last_author_content) return task.last_author_content;
  const authorRuns = task.runs.filter((r) => r.purpose === 'author' || r.purpose === 'fix');
  const last = authorRuns[authorRuns.length - 1] ?? null;
  return last ? (last.structured_result?.result ?? '') : '';
}

function capsuleForFormalReview(task, candidateId) {
  const c = task.candidate ?? {};
  const server = task.governance_env?.reviewer_server_name ?? 'agent-foundry-vault';
  const parts = [
    `You are acting as the formal reviewer inside the Vault Governance Plane.`,
    `TASK_ID: ${task.task_id}`,
    `CANDIDATE_ID: ${candidateId}`,
    `TARGET: ${c.target ?? 'n/a'}`,
    `CANDIDATE_CONTENT (assess this):`,
    `<<<`,
    task.last_author_content ?? '(author content unavailable)',
    `>>>`,
    `Steps (use the "${server}" MCP server tools):`,
    `1. Call ${server} agent_register with task_id="${task.task_id}", executor="${task.author_session_executor_type ?? 'executor'}", role="reviewer". Keep the returned agent_instance_id.`,
    `2. Call ${server} review_candidate with candidate_id="${candidateId}", agent_instance_id=<yours>, decision="approve" or "reject" per your independent assessment, reasons=<your reasons>.`,
    `Reply with ONLY a JSON object: {"agent_instance_id":"...","review_decision":"approve|reject","reasons":"..."}`,
  ];
  return {
    prompt: parts.join('\n'),
    task_id: task.task_id,
    runId: task.next_run_id ?? null,
    assigned_role: task.reviewer_role,
    cwd: task.fixture_dir,
    response_schema: null,
    mcpConfigPath: task.governance_env?.reviewer_mcp_config ?? null,
    allowedTools: task.governance_env?.reviewer_allowed_tools ?? null,
    model: task.reviewer_model || task.model,
    effort: task.reviewer_effort || task.effort,
    timeout_ms: task.timeout_ms ?? 600000,
    cline_fallback_model: task.cline_fallback_model || 'cline-pass/deepseek-v4-flash',
  };
}

async function runGovernance(task, adapters, bridge) {
  const mirror = governanceMirror(task);
  task.last_author_content = lastAuthorContent(task);
  const c = task.candidate ?? {};

  // 1. candidate creation THROUGH vault-mcp (candidate_id comes from vault).
  // PHASE 4 idempotency: if a previous crashed run already created the
  // candidate, its candidate_id is reused - never a second write_candidate.
  const pageContent = task.submission_path
    ? readFileSync(task.submission_path, 'utf8')
    : extractPageContent(task.last_author_content ?? '') || (task.last_author_content ?? '');
  let candidate_id = mirror.candidate_id ?? null;
  if (!candidate_id) {
    const created = await bridge.createCandidate({
      title: c.title ?? `${task.task_id}: ${task.goal.slice(0, 80)}`,
      content: pageContent,
      target: c.target,
      knowledge_class: c.knowledge_class,
      sources: c.sources,
      publish_tags: c.publish_tags,
      publish_summary: c.publish_summary,
      rationale: c.rationale ?? `Orchestrator task ${task.task_id} governed write`,
    });
    candidate_id = created.candidate_id;
    mirror.candidate_id = candidate_id;
    mirror.agent_instance_ids = {
      ...(mirror.agent_instance_ids ?? {}),
      bridge_requested: bridge.requested_instance_id ?? null, // minted locally, pre-registration
      bridge: created.agent_instance_id,                      // confirmed by vault-mcp
    };
    mirror.candidate_raw = created.raw_response.slice(0, 1000);
    saveTask(task);
  }

  // 2. formal review by an INDEPENDENT reviewer executor through vault-mcp.
  //    PHASE 4 idempotency: an approve verdict already persisted by a crashed
  //    run is REUSED (never a second formal review for the same verdict); a
  //    persisted reject keeps the task failed - no silent re-review.
  if (mirror.formal_review?.review_decision === 'approve') {
    // reused durable evidence from the Governance Plane
  } else {
    if (mirror.formal_review?.review_decision === 'reject') {
      throw new Error(`FORMAL_REVIEW_REJECTED: ${mirror.formal_review.reasons ?? '(no reasons)'}`);
    }
    const adapter = selectExecutor(task.reviewer_executor, { requiresMcp: true, adapters });
    const capsule = capsuleForFormalReview(task, candidate_id);
    let result = await adapter.run(capsule);
    recordRun(task, adapter.type, capsule.assigned_role, result, 'formal_review');
    const parsed = extractJson(result.structured_result?.result ?? '');
    if (result.status !== 'completed' || !parsed?.agent_instance_id || !parsed?.review_decision) {
      const classification = result.error_classification || classifyExecutionError(adapter.type, { exit_code: result.exit_code ?? 1, stderr: result.error || 'missing review JSON' });
      task.error_classification = classification;
      task.retryable = classification.retryable;
      const err = new Error(`formal review step failed or unparseable: ${result.error ?? 'missing review JSON'}`);
      err.error_classification = classification;
      throw err;
    }
    mirror.agent_instance_ids.reviewer = parsed.agent_instance_id;
    mirror.formal_review = { reviewer_instance_id: parsed.agent_instance_id, review_decision: parsed.review_decision, reasons: parsed.reasons ?? '' };
    saveTask(task);
    if (parsed.review_decision !== 'approve') {
      throw new Error(`FORMAL_REVIEW_REJECTED: ${parsed.reasons ?? '(no reasons)'}`);
    }
  }

  // 3. publish attempt: vault-mcp returns the authoritative verdict. A vault
  // rejection (e.g. REVIEW_STALE after candidate tampering) maps to deny -
  // the Governance Plane said no; the Orchestrator never retries or downgrades.
  let pub;
  try {
    pub = await bridge.publish(candidate_id);
  } catch (err) {
    if (err?.vault_rejected) {
      mirror.policy_decision = 'deny';
      mirror.policy_evidence = String(err.vault_response ?? err.message).slice(0, 1500);
      saveTask(task);
      return 'deny';
    }
    throw err;
  }
  mirror.policy_decision = pub.verdict?.policy_decision ?? 'unknown';
  mirror.published_flag = pub.verdict?.published === true;
  mirror.published_path = pub.verdict?.published_path ?? mirror.published_path ?? null;
  mirror.policy_evidence = pub.raw_response.slice(0, 1500);
  saveTask(task);
  return classifyPublishVerdict(pub.verdict);
}

async function completePublish(task, decision) {
  // A policy class is not a publish outcome: only a vault-confirmed published
  // verdict may complete a governed task.
  if (decision !== 'published') {
    throw new Error(`completePublish requires a published verdict, got ${decision}`);
  }
  task.state = 'PUBLISHING';
  saveTask(task);
  task.governance = task.governance ?? { governance_source: 'vault-mcp' };
  task.governance.publish_status = 'published';
  task.state = 'COMPLETED';
  task.completed_at = new Date().toISOString();
  saveTask(task);
  return task;
}

function makeBridge(task, override) {
  if (override) return override;
  const envCfg = task.governance_env ?? {};
  // Phase 2 closure: fail-closed. No governance_env.vault_root => no bridge,
  // no implicit real-vault fallback (GOVERNANCE_ENV_REQUIRED).
  return new GovernanceBridge({
    task_id: task.task_id,
    serverPath: envCfg.server_path,
    vaultRoot: envCfg.vault_root,
    stateDb: envCfg.state_db,
  });
}

// Re-query the Governance Plane for a task parked in WAITING_HUMAN. The local
// mirror (even if it claims "approved") is never trusted - the verdict comes
// from a fresh publish_candidate call against vault-mcp.
export async function resumeGovernance(taskId, { adapters = ADAPTERS, bridgeOverride = null, tasksDir = TASKS_DIR, assertOwnership = null } = {}) {
  const task = withTaskContext(loadTask(taskId, tasksDir), { tasksDir, assertOwnership });
  if (task.state !== 'WAITING_HUMAN') {
    throw new Error(`task ${taskId} is ${task.state}, not WAITING_HUMAN`);
  }
  // PHASE 3 correlation: a resume may only continue through THIS task's own
  // saved candidate_id (re-queried against vault-mcp below). Searching for a
  // "nearest" candidate/approval/WAITING_HUMAN task is forbidden.
  if (!task.governance?.candidate_id) {
    task.state = 'FAILED';
    task.failure_reason = 'GOVERNANCE_CORRELATION_REQUIRED: WAITING_HUMAN resume requires this task\'s saved governance.candidate_id; refusing to search for a nearest candidate/approval';
    saveTask(task);
    return task;
  }
  const bridge = makeBridge(task, bridgeOverride);
  try {
    // Idempotent settle: a previous resume may have already obtained a
    // published verdict - confirm it against the vault before completing.
    const settled = await settleIfPublished(task, bridge);
    if (settled === 'published') return await completePublish(task, 'published');
    const decision = await runGovernancePublishOnly(task, bridge);
    if (decision === 'human_required') {
      task.state = 'WAITING_HUMAN'; // gate still open; keep waiting
      saveTask(task);
      return task;
    }
    if (decision === 'published') return await completePublish(task, decision);
    task.state = 'FAILED';
    task.failure_reason = 'GOVERNANCE_DENIED';
    saveTask(task);
    return task;
  } finally {
    bridge.stop?.();
  }
}

// publish-only path for resume (candidate + formal review already exist)
async function runGovernancePublishOnly(task, bridge) {
  const mirror = governanceMirror(task);
  let pub;
  try {
    pub = await bridge.publish(mirror.candidate_id);
  } catch (err) {
    if (err?.vault_rejected) {
      mirror.policy_decision = 'deny';
      mirror.policy_evidence = String(err.vault_response ?? err.message).slice(0, 1500);
      saveTask(task);
      return 'deny';
    }
    throw err;
  }
  mirror.policy_decision = pub.verdict?.policy_decision ?? 'unknown';
  mirror.published_flag = pub.verdict?.published === true;
  mirror.published_path = pub.verdict?.published_path ?? mirror.published_path ?? null;
  mirror.policy_evidence = pub.raw_response.slice(0, 1500);
  saveTask(task);
  return classifyPublishVerdict(pub.verdict);
}

// Idempotent settle for a task whose previous resume already obtained a
// published verdict: confirm the published file against the vault (truth)
// via a read-only vault_read before completing. A forged published_path
// fails the read and falls through to the normal publish flow.
async function settleIfPublished(task, bridge) {
  const mirror = governanceMirror(task);
  if (!mirror.published_flag || !mirror.published_path) return null;
  try {
    await bridge.client.call('vault_read', { path: mirror.published_path });
    return 'published'; // vault-confirmed: the file is really there
  } catch (err) {
    // Only a vault-level rejection ("that file is not there") downgrades the
    // claim. Any other failure (bridge misconfigured, client undefined, timeout)
    // must propagate: silently clearing the flag would republish a page that may
    // already be live.
    if (!err?.vault_rejected) throw err;
    mirror.published_flag = false; // claim not confirmed by vault; republish
    saveTask(task);
    return null;
  }
}

async function executeSingleStep(step, task, adapters, { lastAuthorExecutorType, onRunStart, cwd }) {
  const plan = task.planner_result.plan;
  let executorId = step.executor || task.step_executors?.[step.step];
  if (!executorId) {
    if (step.role === 'researcher') {
      executorId = task.researcher_executor || (adapters.claude ? 'claude' : 'codex');
    } else if (step.role === 'reviewer' || step.role === 'verifier') {
      executorId = task.reviewer_executor || (lastAuthorExecutorType === 'codex' && adapters.cline ? 'cline' : 'cline');
    } else {
      executorId = task.author_executor || 'codex';
    }
  }

  const adapter = selectExecutor(executorId, { requiresMcp: !!task.requires_mcp, adapters });
  const runId = `RUN-S${step.step}-${randomUUID().slice(0, 8)}`;
  task.next_run_id = runId;
  onRunStart?.(runId, adapter.type);

  const priorSummary = (task.plan_execution || [])
    .map((pe) => `- Step ${pe.step} [${pe.role}] by ${pe.executor}: ${pe.summary || 'done'}`)
    .join('\n');

  const stepCwd = cwd || task.fixture_dir;

  const promptParts = [
    `You are acting as the ${step.role} in Step ${step.step} of ${plan.length} for task ${task.task_id}.`,
    `OVERALL GOAL: ${task.goal}`,
    `CURRENT STEP GOAL: ${step.goal}`,
    `CURRENT STEP SPECIFICATION: ${step.description}`,
    `WORKING DIRECTORY: ${stepCwd}`,
    `RED LINES: ${task.red_lines.join('; ')}`,
    priorSummary ? `PRIOR COMPLETED STEPS:\n${priorSummary}` : '',
    `Perform the necessary work directly in the working directory. Ensure modularity, clean code, and runnable tests.`,
    `When finished, output a concise 1-2 sentence summary of what was accomplished and files created/updated.`,
  ].filter(Boolean);

  const capsule = {
    prompt: promptParts.join('\n\n'),
    task_id: `${task.task_id}-S${step.step}`,
    runId,
    assigned_role: step.role,
    cwd: stepCwd,
    acceptEdits: step.role !== 'reviewer',
    model: executorId === 'codex' ? (task.author_model || 'gpt-5.6-luna') : (executorId === 'cline' ? (task.cline_model || task.reviewer_model) : undefined),
    effort: executorId === 'codex' ? (task.author_effort || 'max') : (executorId === 'cline' ? (task.cline_effort || task.reviewer_effort || 'xhigh') : undefined),
    timeout_ms: task.timeout_ms ?? 900000,
    protect_active_process: task.protect_active_process !== false,
    idle_timeout_ms: task.idle_timeout_ms ?? 900000,
    cline_fallback_model: task.cline_fallback_model || 'cline-pass/deepseek-v4-flash',
    cline_fallback_effort: task.cline_fallback_effort || 'xhigh',
  };

  const result = await adapter.run(capsule);
  result.executor_run_id = runId;
  recordRun(task, adapter.type, step.role, result, `step_${step.step}`);

  if (result.status === 'cancelled') {
    const err = new Error(`step ${step.step} cancelled by operator`);
    err.code = 'RUN_CANCELLED';
    throw err;
  }

  if (result.status !== 'completed') {
    const classification = result.error_classification || classifyExecutionError(adapter.type, { exit_code: result.exit_code ?? 1, stderr: result.error || 'run failed' });
    task.error_classification = classification;
    task.retryable = classification.retryable;
    const err = new Error(`step ${step.step} failed: ${result.error}`);
    err.error_classification = classification;
    throw err;
  }

  const summaryText = result.structured_result?.result || (result.stdout ? result.stdout.slice(0, 300) : 'Step completed successfully');
  task.plan_execution.push({
    step: step.step,
    goal: step.goal,
    role: step.role,
    executor: adapter.type,
    status: 'completed',
    summary: summaryText,
    finished_at: new Date().toISOString(),
  });

  return { runId, executorType: adapter.type, summaryText };
}

async function executePlannedSteps(task, adapters, { governanceBridge = null, targetCoordination = null, onRunStart = null } = {}) {
  task.plan_execution = task.plan_execution ?? [];
  const plan = task.planner_result.plan;
  const batches = buildPlanBatches(plan);

  console.log(`[orchestrator] Executing multi-step plan for task ${task.task_id} (${plan.length} steps in ${batches.length} batches)`);

  let lastAuthorRunId = null;
  let lastAuthorExecutorType = null;

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx];
    const pendingSteps = batch.filter((step) =>
      !task.plan_execution.some((p) => p.step === step.step && p.status === 'completed')
    );
    if (pendingSteps.length === 0) {
      console.log(`[orchestrator] Batch ${bIdx + 1}/${batches.length} already completed, skipping`);
      continue;
    }

    const useWorktree = (pendingSteps.length > 1 || pendingSteps.some((s) => s.isolation === 'worktree')) && task.enable_worktree !== false;

    if (!useWorktree) {
      // Sequential single-writer execution
      for (const step of pendingSteps) {
        console.log(`[orchestrator] >>> Step ${step.step}/${plan.length} [${step.role}]: ${step.goal}`);
        task.current_step = step.step;
        task.current_step_goal = step.goal;
        task.current_step_role = step.role;
        task.state = `${step.role.toUpperCase()}_RUNNING`;
        saveTask(task);

        const stepExecRes = await executeSingleStep(step, task, adapters, {
          lastAuthorExecutorType,
          onRunStart,
          cwd: task.fixture_dir,
        });

        if (step.role === 'author' || step.role === 'worker') {
          lastAuthorRunId = stepExecRes.runId;
          lastAuthorExecutorType = stepExecRes.executorType;
        }
        saveTask(task);
      }
    } else {
      // Parallel execution with Git Worktree Isolation
      console.log(`[orchestrator] >>> Parallel Batch ${bIdx + 1}/${batches.length}: Running ${pendingSteps.length} steps concurrently in isolated Git worktrees`);
      task.state = 'PARALLEL_RUNNING';
      saveTask(task);

      const session = new WorktreeSession({ repoDir: task.fixture_dir, taskId: task.task_id });
      session.init();

      try {
        await Promise.all(pendingSteps.map(async (step) => {
          console.log(`[orchestrator] [Worktree] Initializing isolated worktree for Step ${step.step} [${step.role}]: ${step.goal}`);
          const wt = session.createStepWorktree(step.step);

          const stepExecRes = await executeSingleStep(step, task, adapters, {
            lastAuthorExecutorType,
            onRunStart,
            cwd: wt.worktreeDir,
          });

          if (step.role === 'author' || step.role === 'worker') {
            lastAuthorRunId = stepExecRes.runId;
            lastAuthorExecutorType = stepExecRes.executorType;
          }

          // Auto-commit changes in worktree
          session.commitStep(step.step, `feat(step-${step.step}): ${step.goal}`);
        }));

        // Sequentially merge all completed step branches into main
        for (const step of pendingSteps) {
          console.log(`[orchestrator] [Worktree] Merging step ${step.step} branch into main...`);
          const mergeRes = session.mergeStep(step.step);
          if (!mergeRes.success) {
            const err = new Error(`Merge conflict in parallel step ${step.step} (${step.goal}): ${mergeRes.conflictingFiles?.join(', ') || mergeRes.error}`);
            err.code = 'MERGE_CONFLICT';
            throw err;
          }
        }
        saveTask(task);
      } finally {
        // A failed step must not leave its siblings running while the worktrees
        // they are writing into are torn down. Terminate every active run of
        // this task first, then clean up.
        try {
          const { cancelTaskRuns } = await import('./lib/adapters.mjs');
          await cancelTaskRuns(task.task_id);
        } catch { /* best effort: cleanup must still happen */ }
        session.cleanupAll();
      }
    }
  }

  // Final verification & acceptance
  console.log('[orchestrator] All plan steps completed, running final acceptance gate...');
  const acc = await acceptanceGate(task, 1);
  if (!acc.ok) {
    throw new Error(`Final acceptance test failed: ${acc.record?.failure_reason || acc.output}`);
  }

  task.state = 'COMPLETED';
  task.completed_at = new Date().toISOString();
  saveTask(task);
  console.log(`[orchestrator] Multi-step task ${task.task_id} successfully COMPLETED!`);
  return task;
}


export async function executeLegacyTask(task, adapters = ADAPTERS, { governanceBridge = null, targetCoordination = null, onRunStart = null, isShutdownRequested = null, shutdownMode = null } = {}) {
  const cancelled = prepareTaskForExecution(task);
  if (cancelled) return cancelled;
  task.state = 'AUTHOR_RUNNING';
  saveTask(task);
  try {
    if (task.multi_step_dispatch && Array.isArray(task.planner_result?.plan) && task.planner_result.plan.length > 1) {
      return await executePlannedSteps(task, adapters, { governanceBridge, targetCoordination, onRunStart });
    }
    await runAuthor(task, 1, adapters, { onRunStart });
    if (task.task_mode === 'governed_write') stageSubmission(task);
    return await runLoopFromReview(task, 1, adapters, { governanceBridge, targetCoordination, onRunStart });
  } catch (err) {
    return settleExecutionError(task, err, { isShutdownRequested, shutdownMode });
  }
}

// The review→acceptance→governance loop, re-entrant from any revision.
// Extracted in PHASE 4 so continueTask can resume an interrupted task from
// its durable state without re-running stages whose results are already
// persisted.
async function runLoopFromReview(task, revision, adapters, { governanceBridge = null, targetCoordination = null, reuseReview = false, onRunStart = null } = {}) {
  const maxRevisions = task.max_revisions ?? MAX_REVISIONS_DEFAULT;
  try {
    for (;;) {
      task.state = 'REVIEW_RUNNING';
      task.review_revision = revision;
      saveTask(task);
      let review;
      if (reuseReview && reviewResultPersisted(task) && Number(task.last_review?.revision ?? -1) === Number(revision)) {
        // PHASE 4: crash happened AFTER the reviewer finished but BEFORE its
        // decision was applied - reuse the persisted result, never re-call the
        // reviewer for a decision that already exists.
        review = task.last_review;
      } else {
        review = await runReview(task, revision, adapters, { onRunStart });
      }
      if (review.decision === 'PASS') {
        // Deterministic acceptance gate. A failure here consumes the SAME
        // revision budget as a reviewer NEEDS_FIX (Phase 1.1).
        const acc = await acceptanceGate(task, revision);
        if (acc.ok) {
          if (task.task_mode !== 'governed_write') {
            task.state = 'COMPLETED';
            task.completed_at = new Date().toISOString();
            task.final_review = review;
            saveTask(task);
            return task;
          }
          // Phase 2: QA PASS is NOT the end for governed_write - hand over to
          // the existing Governance Plane and map its verdict back.
          task.state = 'GOVERNANCE_PENDING';
          saveTask(task);
          // PHASE 3 target coordination (Control Plane optimization ONLY):
          // two active tasks must not enter the publish-sensitive stage on
          // the same candidate target. This is coordination, NOT enforcement:
          // the formal writer conflict decision stays with vault-mcp's writer
          // lock - never a silent last-write-wins.
          if (targetCoordination && task.candidate?.target && !targetCoordination.acquire(task)) {
            task.state = 'FAILED';
            task.failure_reason = 'WRITE_CONFLICT';
            task.failure_detail = `target ${JSON.stringify(task.candidate.target)} is already held in the publish-sensitive stage by another active task (control-plane coordination; formal enforcement remains the vault-mcp writer lock)`;
            saveTask(task);
            return task;
          }
          const bridge = makeBridge(task, governanceBridge);
          let decision;
          try {
            decision = await runGovernance(task, adapters, bridge);
          } finally {
            bridge.stop?.();
          }
          if (decision === 'published') return await completePublish(task, decision);
          if (decision === 'human_required') {
            task.state = 'WAITING_HUMAN';
            saveTask(task);
            return task; // parked; user completes the real Human Gate, then resume
          }
          task.state = 'FAILED';
          task.failure_reason = decision === 'deny' ? 'GOVERNANCE_DENIED' : `GOVERNANCE_UNKNOWN_${String(decision).toUpperCase()}`;
          saveTask(task);
          return task;
        }
        task.last_acceptance_failure = acc.record;
        review = {
          decision: 'NEEDS_FIX',
          summary: 'reviewer PASSed but the deterministic acceptance command failed',
          issues: [...(review.issues ?? []), 'acceptance command failed'],
          required_changes: [...(review.required_changes ?? []),
            `Make this command pass: ${JSON.stringify(task.acceptance_cmd)}\nexit_code: ${acc.record.exit_code}\nstdout: ${acc.record.stdout_summary}\nstderr: ${acc.record.stderr_summary}`],
          evidence: [...(review.evidence ?? []), 'orchestrator acceptance run'],
        };
      }
      if (revision >= maxRevisions) {
        task.state = 'FAILED';
        task.failure_reason = 'MAX_REVISIONS_EXCEEDED';
        saveTask(task);
        return task;
      }
      revision += 1;
      task.revisions_used = revision;
      task.state = 'NEEDS_FIX';
      saveTask(task);
      // A distinct state: the fix resumes the ORIGINAL author session with the
      // persisted feedback, so a crash here is safe to re-run. A crash during
      // an AUTHOR_RUNNING run has an UNKNOWN outcome and must not be.
      task.state = 'FIX_RUNNING';
      saveTask(task);
      await runAuthor(task, revision, adapters, { onRunStart }); // resume original author session
      if (task.task_mode === 'governed_write') stageSubmission(task);
    }
  } catch (err) {
    // A non-revivable state already on disk wins: an operator cancellation that
    // landed while this run was unwinding must not be overwritten with FAILED.
    try {
      const onDisk = loadTask(task.task_id, tasksDirOf(task));
      if (NON_REVIVABLE_STATES.has(onDisk.state)) return onDisk;
    } catch { /* ignore */ }
    task.state = 'FAILED';
    task.failure_reason = String(err?.message ?? err);
    if (err?.error_classification) {
      task.error_classification = err.error_classification;
      task.retryable = err.error_classification.retryable;
    } else {
      const classification = classifyExecutionError(task.reviewer_executor || 'executor', {
        exit_code: 1,
        stderr: task.failure_reason,
      });
      task.error_classification = classification;
      task.retryable = classification.retryable;
    }
    saveTask(task);
    return task;
  }
}

// PHASE 4: resume an interrupted task from its durable state. The switch
// below maps each persisted state onto the smallest safe continuation - it
// never re-runs stages whose results are already persisted, never fakes
// outcomes, and defers all governance truth to vault-mcp.
export async function continueLegacyTask(taskId, adapters = ADAPTERS, { governanceBridge = null, targetCoordination = null, tasksDir = TASKS_DIR, assertOwnership = null } = {}) {
  const task = withTaskContext(loadTask(taskId, tasksDir), { tasksDir, assertOwnership });
  task.runs = task.runs ?? [];
  task.revisions_used = task.revisions_used ?? 1;
  task.author_role = task.author_role ?? 'author';
  task.reviewer_role = task.reviewer_role ?? 'reviewer';
  if (task.task_mode === 'governed_write') task.requires_mcp = true;

  if (TERMINAL_STATES.has(task.state)) {
    throw Object.assign(new Error(`TASK_TERMINAL: task ${taskId} is ${task.state} - recovery refused`), { code: 'TASK_TERMINAL' });
  }

  if (task.state === 'WAITING_HUMAN') {
    // durable park: re-query the vault truth by THIS task's candidate_id only
    return await resumeGovernance(taskId, { adapters, bridgeOverride: governanceBridge, tasksDir, assertOwnership });
  }

  if (task.state === 'PUBLISHING') {
    if (!task.governance?.candidate_id) {
      throw Object.assign(new Error('UNSAFE_TO_AUTO_RESUME: PUBLISHING without candidate_id - publish outcome cannot be correlated'), { code: 'UNSAFE_TO_AUTO_RESUME' });
    }
    const bridge = makeBridge(task, governanceBridge);
    try {
      const settled = await settleIfPublished(task, bridge); // vault truth first
      if (settled === 'published') return await completePublish(task, 'published');
      const decision = await runGovernancePublishOnly(task, bridge);
      if (decision === 'published') return await completePublish(task, decision);
      if (decision === 'human_required') { task.state = 'WAITING_HUMAN'; saveTask(task); return task; }
      task.state = 'FAILED';
      task.failure_reason = decision === 'deny' ? 'GOVERNANCE_DENIED' : `GOVERNANCE_UNKNOWN_${String(decision).toUpperCase()}`;
      saveTask(task);
      return task;
    } finally {
      bridge.stop?.();
    }
  }

  if (task.state === 'GOVERNANCE_PENDING') {
    // author content is durable; governance resumes idempotently (existing
    // candidate_id / approve verdict are reused, never rebuilt)
    const bridge = makeBridge(task, governanceBridge);
    try {
      const decision = await runGovernance(task, adapters, bridge);
      if (decision === 'published') return await completePublish(task, decision);
      if (decision === 'human_required') { task.state = 'WAITING_HUMAN'; saveTask(task); return task; }
      task.state = 'FAILED';
      task.failure_reason = decision === 'deny' ? 'GOVERNANCE_DENIED' : `GOVERNANCE_UNKNOWN_${String(decision).toUpperCase()}`;
      saveTask(task);
      return task;
    } finally {
      bridge.stop?.();
    }
  }

  if (task.state === 'AUTHOR_RUNNING' && !authorResultPersisted(task, task.revisions_used ?? 1)) {
    // the author run died mid-flight: record the interrupted run explicitly
    // (UNKNOWN_OUTCOME) - never a fake FAILED/PASS - and refuse auto-continuation
    markInterruptedRun(task, 'author');
    throw Object.assign(new Error('INTERRUPTED: author run has no durable result (UNKNOWN_OUTCOME) - manual decision required (re-run author from scratch or discard)'), { code: 'AUTHOR_INTERRUPTED' });
  }

  if (task.state === 'NEEDS_FIX' || task.state === 'FIX_RUNNING') {
    // durable review feedback + original author session -> exact resume fix.
    // FIX_RUNNING means the fix was interrupted before producing anything, which
    // is safe to re-run; NEEDS_FIX means the fix has not started either.
    task.state = 'AUTHOR_RUNNING';
    saveTask(task);
    const revision = task.revisions_used ?? 1;
    await runAuthor(task, revision, adapters);
    if (task.task_mode === 'governed_write') stageSubmission(task);
    return await runLoopFromReview(task, revision, adapters, { governanceBridge, targetCoordination });
  }

  // REVIEW_RUNNING, or AUTHOR_RUNNING with a fully persisted author result:
  // the author is NOT re-run; only the remaining stages execute. If the
  // reviewer already finished (result persisted, revision matches) its
  // decision is reused instead of re-calling the reviewer.
  const revision = task.review_revision ?? task.revisions_used ?? 1;
  const reuseReview = task.state === 'REVIEW_RUNNING'
    && reviewResultPersisted(task)
    && Number(task.last_review?.revision ?? -1) === Number(revision);
  return await runLoopFromReview(task, revision, adapters, { governanceBridge, targetCoordination, reuseReview });
}

// records an interrupted run placeholder: UNKNOWN_OUTCOME, never FAILED/PASS
function markInterruptedRun(task, purpose) {
  task.runs = task.runs ?? [];
  const id = `RUN-INT-${randomUUID().slice(0, 8)}`;
  task.runs.push({
    executor_run_id: id,
    executor_type: task.author_session_executor_type ?? 'unknown',
    assigned_role: purpose === 'review' ? (task.reviewer_role ?? 'reviewer') : (task.author_role ?? 'author'),
    purpose,
    status: 'interrupted',
    execution_outcome: 'interrupted',
    session_ref: null,
    exit_code: null,
    started_at: null,
    finished_at: null,
    error: 'UNKNOWN_OUTCOME: orchestrator process died before this run finished',
  });
  saveTask(task);
  return id;
}
