// Executor capsules and result binding, shared by V2 and legacy workflows.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { selectExecutor, getRunTerminationEvidence } from './adapters.mjs';
import { classifyExecutionError } from './executor-error-classifier.mjs';
import { bindReviewResult, latestAuthorRun } from './reviews.mjs';

export function recordRun(task, executorType, assignedRole, result, purpose) {
  // Phase 1.1 reviewer independence: a run id must never be reused, and a
  // review run must never collide with the author/fix session it reviews.
  if (task.runs.some((r) => r.executor_run_id === result.executor_run_id)) {
    throw new Error(`executor_run_id reused: ${result.executor_run_id}`);
  }
  task.runs.push({
    executor_run_id: result.executor_run_id,
    executor_type: executorType,
    assigned_role: assignedRole,
    purpose,                       // author | fix | review
    status: result.status,
    session_ref: result.session_ref,
    exit_code: result.exit_code,
    started_at: result.started_at,
    finished_at: result.finished_at,
    error: result.error,
    writer_termination: result.writer_termination ?? null,
  });
}

export function capsuleForAuthor(task, revision, { cwd = task.fixture_dir } = {}) {
  const parts = [
    `You are acting as the ${task.author_role} in a task workflow (executor identity does not determine your role).`,
    `TASK_ID: ${task.task_id}`,
    `REVISION: ${revision}`,
    `GOAL: ${task.goal}`,
    `ACCEPTANCE: ${task.acceptance}`,
    `RED_LINES: ${task.red_lines.join('; ')}`,
    `Working directory: ${cwd}`,
    `Do the work in that directory. Keep changes minimal and runnable.`,
    `When done, reply with a short summary of what you changed.`,
  ];
  if (task.task_mode === 'governed_write') {
    const c = task.candidate ?? {};
    parts.push(
      `GOVERNED WRITE: the text between <PAGE> and </PAGE> markers in your reply will be submitted VERBATIM as a formal candidate for publication to target: ${c.target ?? 'n/a'}.`,
      `Format rules: wrap ONLY the final page between <PAGE> and </PAGE>; the page body must NOT include YAML frontmatter, title headings, status notes, or any process narration (publish metadata like tags/summary is passed separately by the orchestrator).`,
      `Anything outside the markers is treated as process narration and discarded.`,
      `IMPORTANT: do NOT create candidate files yourself and do NOT write into any 收件箱/写回候选 directory - the orchestrator submits the candidate through vault-mcp on your behalf. Your job is only the <PAGE> reply.`,
    );
  }
  if (revision > 1 && task.last_review) {
    parts.push(`REVIEW_FEEDBACK (from reviewer, address every required change):`);
    for (const [i, rc] of (task.last_review.required_changes ?? []).entries()) {
      parts.push(`  ${i + 1}. ${rc}`);
    }
    if (task.last_review.issues?.length) {
      parts.push(`ISSUES: ${task.last_review.issues.join('; ')}`);
    }
  }
  if (revision > 1 && task.last_acceptance_failure) {
    const f = task.last_acceptance_failure;
    parts.push(`ACCEPTANCE_FAILURE (deterministic verification failed; fix the code so this command passes):`);
    parts.push(`  command: ${f.command} ${JSON.stringify(f.args ?? '')}`);
    parts.push(`  exit_code: ${f.exit_code}`);
    parts.push(`  stdout: ${f.stdout_summary}`);
    parts.push(`  stderr: ${f.stderr_summary}`);
    parts.push(`  failure_reason: ${f.failure_reason}`);
  }
  return {
    prompt: parts.join('\n'),
    task_id: task.task_id,
    runtime_dir: task.__runtimeDir,
    runId: task.next_run_id ?? null,
    assigned_role: task.author_role,
    cwd,
    acceptEdits: true,
    model: task.author_model || task.model,
    effort: task.author_effort || task.effort,
    timeout_ms: task.timeout_ms ?? 600000,
    protect_active_process: task.protect_active_process !== false,
    idle_timeout_ms: task.idle_timeout_ms ?? 900000,
    purpose: task.trusted_import?.enabled === true ? 'trusted_import' : undefined,
  };
}

function capsuleForReview(task, revision, { cwd = task.fixture_dir } = {}) {
  const reviewSchema = {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['PASS', 'NEEDS_FIX'] },
      // PHASE 3 anti-cross-talk echo: reviewer repeats task_id/revision so a
      // stale/misrouted result is detectable (optional for legacy reviewers).
      task_id: { type: 'string' },
      revision: { type: 'number' },
      summary: { type: 'string' },
      issues: { type: 'array', items: { type: 'string' } },
      required_changes: { type: 'array', items: { type: 'string' } },
      evidence: { type: 'array', items: { type: 'string' } },
    },
    required: ['decision', 'summary', 'issues', 'required_changes', 'evidence'],
    additionalProperties: false,
  };
  const parts = [
    `You are acting as the reviewer in a task workflow. Your review must be independent and evidence-based.`,
    `TASK_ID: ${task.task_id}`,
    `REVISION UNDER REVIEW: ${revision}`,
    `ORIGINAL GOAL: ${task.goal}`,
    `ACCEPTANCE: ${task.acceptance}`,
    `REVIEW_SCOPE_RULES: ${task.review_rules.join('; ')}`,
    ...(task.task_mode === 'governed_write'
      ? [`The author's submission is at ${join(cwd, 'orchestrator-submission.md')} - review THAT file (it is the exact content that would be published).`]
      : [`Working directory: ${cwd} - inspect the files yourself. Cite file:line evidence.`]),
    `Respond with ONLY a JSON object of exactly this shape (no markdown fences, no extra text):`,
    JSON.stringify({ decision: 'PASS | NEEDS_FIX', summary: 'one paragraph', issues: ['...'], required_changes: ['...'], evidence: ['file:line or command output'] }),
    `Include "task_id" and "revision" in the JSON, echoing the TASK_ID and REVISION UNDER REVIEW above exactly (anti cross-talk binding).`,
    `decision must be PASS only if every REVIEW_SCOPE_RULES item holds; otherwise NEEDS_FIX with concrete required_changes.`,
  ];
  return {
    prompt: parts.join('\n'),
    task_id: task.task_id,
    runtime_dir: task.__runtimeDir,
    runId: task.next_run_id ?? null,
    assigned_role: task.reviewer_role,
    cwd,
    response_schema: reviewSchema,
    model: task.reviewer_model || task.model,
    effort: task.reviewer_effort || task.effort || (task.reviewer_executor === 'cline' ? 'xhigh' : undefined),
    // The review leg gets its own bound: a review must be able to time out
    // independently of a long author run (falls back to the task timeout).
    timeout_ms: task.reviewer_timeout_ms ?? task.timeout_ms ?? 600000,
    protect_active_process: task.protect_active_process !== false,
    idle_timeout_ms: task.idle_timeout_ms ?? 900000,
    purpose: task.trusted_import?.enabled === true ? 'trusted_import' : undefined,
    cline_fallback_model: task.cline_fallback_model || 'cline-pass/deepseek-v4-flash',
    cline_fallback_effort: task.cline_fallback_effort || 'xhigh',
  };
}

export function parseReviewerResult(executorType, structured) {
  // Schema-aware adapters (AGY and Cline) may return the parsed object in
  // `parsed`; text-envelope adapters return the JSON inside `result`. Prefer
  // the structured object whenever it is present, then fall back to bounded
  // JSON extraction from text. Never string-match on "PASS".
  let raw = structured?.parsed;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { /* best effort */ }
  }
  if (!raw || !raw.decision) {
    raw = extractJson(structured?.result ?? '');
  }
  if (!raw || !raw.decision) return { ok: false, review: null, raw: null };
  if (raw.decision !== 'PASS' && raw.decision !== 'NEEDS_FIX') return { ok: false, review: raw, raw };
  return {
    ok: true,
    review: {
      decision: raw.decision,
      summary: raw.summary ?? '',
      issues: raw.issues ?? [],
      required_changes: raw.required_changes ?? [],
      evidence: raw.evidence ?? [],
    },
    raw,
  };
}

export function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

export async function runAuthor(task, revision, adapters, opts = {}) {
  task.__assertOwnership?.();
  const purpose = revision === 1 ? 'author' : 'fix';
  const executor = purpose === 'fix' ? task.author_session_executor_type : task.author_executor;
  if (purpose === 'fix' && !executor) throw new Error('original author executor is required to resume a fix');
  const adapter = selectExecutor(executor, { requiresMcp: !!task.requires_mcp, adapters });
  const runId = `RUN-${randomUUID().slice(0, 8)}`;
  task.next_run_id = runId;
  opts.onRunStart?.(runId, adapter.type);
  const capsule = capsuleForAuthor(task, revision, opts);
  const result = purpose === 'fix'
    ? await adapter.resume(task.author_session_ref, capsule)
    : await adapter.run(capsule);
  task.__assertOwnership?.();
  result.executor_run_id = runId; // stable identity for precise cancellation
  result.writer_termination = result.writer_termination ?? getRunTerminationEvidence(runId);
  recordRun(task, adapter.type, capsule.assigned_role, result, purpose);
  if (result.status === 'cancelled') {
    const err = new Error('author run cancelled by operator');
    err.code = 'RUN_CANCELLED';
    throw err;
  }
  if (result.status !== 'completed') {
    const classification = result.error_classification || classifyExecutionError(adapter.type, { exit_code: result.exit_code ?? 1, stderr: result.error || 'run failed' });
    task.error_classification = classification;
    task.retryable = classification.retryable;
    const err = new Error(`author run failed: ${result.error}`);
    err.error_classification = classification;
    throw err;
  }
  task.last_author_content = result.structured_result?.result ?? null;
  // Record WHICH revision produced the staged content. Without it a crash
  // during a fix left the previous revision's content looking like a durable
  // result for the new revision, so recovery skipped the fix and reviewed stale
  // content.
  task.author_content_revision = revision;
  if (purpose === 'author') {
    task.author_session_ref = result.session_ref;
    task.author_session_executor_type = adapter.type;
  }
  return result;
}

export async function runReview(task, revision, adapters, opts = {}) {
  task.__assertOwnership?.();
  const adapter = selectExecutor(task.reviewer_executor, { requiresMcp: !!task.requires_mcp, adapters });
  if (opts.requireIndependentExecutor === true
      && (adapter.type === task.author_session_executor_type || task.team_writer_executor_types?.includes(adapter.type))) {
    throw new Error(`Trusted Import reviewer executor ${adapter.type} is the same as the author executor`);
  }
  const runId = `RUN-${randomUUID().slice(0, 8)}`;
  task.next_run_id = runId;
  opts.onRunStart?.(runId, adapter.type, {role:'reviewer',revision});
  const capsule = capsuleForReview(task, revision, opts);
  let result = await adapter.run(capsule);
  task.__assertOwnership?.();
  result.executor_run_id = runId;
  result.writer_termination = result.writer_termination ?? getRunTerminationEvidence(runId);
  task.last_review_run_id = runId;
  task.last_review_termination_evidence = result.writer_termination;
  recordRun(task, adapter.type, capsule.assigned_role, result, 'review');
  opts.onRunSettled?.(runId,result);
  if (result.status === 'cancelled') {
    const err = new Error('review run cancelled by operator');
    err.code = 'RUN_CANCELLED';
    throw err;
  }
  // Phase 1.1 independence: a reviewer on the same platform must still use a
  // different session than the author/fix session it reviews. Different
  // executor types are naturally independent; same type is checked strictly.
  if (adapter.type === task.author_session_executor_type
      && result.session_ref
      && result.session_ref === task.author_session_ref) {
    throw new Error('reviewer session collides with author session (independence violation)');
  }
  let { ok, review, raw } = parseReviewerResult(adapter.type, result.structured_result);
  if (!ok && result.status === 'completed') {
    // One structured-output retry before failing the review leg. The retry is a NEW run: the verdict
    // must name the run that actually produced it, and the discarded attempt stays in the trail.
    // (Measured on two live promotions: `last_review_run_id` pointed at the unparseable first
    // attempt while the recorded verdict and termination evidence came from the retry.)
    const firstRunId = runId;
    const retryRunId = `RUN-${randomUUID().slice(0, 8)}`;
    task.next_run_id = retryRunId;
    opts.onRunStart?.(retryRunId, adapter.type, {role:'reviewer',revision});
    capsule.runId = retryRunId;
    task.__assertOwnership?.();
    result = await adapter.run(capsule);
    task.__assertOwnership?.();
    result.executor_run_id = retryRunId;
    result.writer_termination = result.writer_termination ?? getRunTerminationEvidence(retryRunId);
    task.last_review_run_id = retryRunId;
    task.last_review_termination_evidence = result.writer_termination;
    task.review_retry = {
      first_run_id: firstRunId,
      retried_run_id: retryRunId,
      reason: 'the first review output did not parse into a decision',
      at: new Date().toISOString(),
    };
    recordRun(task, adapter.type, capsule.assigned_role, result, 'review');
    opts.onRunSettled?.(retryRunId,result);
    if (result.status === 'cancelled') throw Object.assign(new Error('review run cancelled by operator'), { code: 'RUN_CANCELLED' });
    if (adapter.type === task.author_session_executor_type && result.session_ref && result.session_ref === task.author_session_ref) {
      throw new Error('reviewer session collides with author session (independence violation)');
    }
    ({ ok, review, raw } = parseReviewerResult(adapter.type, result.structured_result));
  }
  if (result.status !== 'completed' || !ok) {
    const classification = result.error_classification || classifyExecutionError(adapter.type, { exit_code: result.exit_code ?? 1, stderr: result.error || 'no decision JSON' });
    task.error_classification = classification;
    task.retryable = classification.retryable;
    const err = new Error(`review run failed or unparseable: ${result.error ?? 'no decision JSON'}`);
    err.error_classification = classification;
    throw err;
  }
  // PHASE 3 anti-cross-talk: bind this reviewer result to THIS task, the
  // current revision and the exact author/fix run under review. A result that
  // carries a disagreeing task_id/revision echo (e.g. TASK-A's review routed
  // at TASK-B) is rejected here and never enters the fix loop.
  review = bindReviewResult(task, revision, latestAuthorRun(task), review, {
    task_id: raw?.task_id ?? null,
    revision: raw?.revision ?? null,
  });
  task.last_review = review;
  return review;
}
