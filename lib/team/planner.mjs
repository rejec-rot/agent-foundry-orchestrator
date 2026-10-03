// Planner teams may share a model, but every reviewer must open a fresh session.
import { teamError, text, requireId } from './model.mjs';
import { effortOptions } from './agent-options.mjs';

const MODEL_EXECUTORS = new Set(['codex', 'claude', 'cline', 'command-code']);
export const supportsModel = (id, adapters = {}) => MODEL_EXECUTORS.has(id) || adapters[id]?.supportsModel === true;
export const supportsPlanner = (id, adapters = {}) => MODEL_EXECUTORS.has(id) || adapters[id]?.supportsFreshSession === true;
export function agentProfile(raw, { allowed, adapters = {}, catalog = [] } = {}) {
  if (!raw || typeof raw !== 'object') throw teamError('agent profile required');
  const executor_type = requireId(raw.executor_type);
  if (allowed && !allowed.includes(executor_type)) throw teamError(`executor ${executor_type} is not available to this team`);
  let model = raw.model == null || raw.model === '' ? null : text(raw.model, 'model', 160);
  if (adapters[executor_type]?.requiresModel === true) {
    const entry = catalog.find(e => (e.executor_type ?? e.id) === executor_type);
    model ??= entry?.default_model ?? null;
    if (!model) throw teamError(`${executor_type} requires an explicitly configured provider model`);
    if (entry?.discovery_status === 'ready' && !entry.models?.some(m => m.id === model && !m.configured_only)) {
      throw teamError(`${executor_type} model ${model} is not available in the current native catalog`);
    }
  }
  if (model && /[\x00-\x1f\x7f]/.test(model)) throw teamError('model contains control characters');
  if (model && !supportsModel(executor_type, adapters)) throw teamError(`${executor_type} does not support model selection`);
  const effort = raw.effort == null || raw.effort === '' ? null : text(raw.effort, 'effort', 16);
  if (effort && !effortOptions(executor_type, model, { adapters, catalog }).includes(effort)) throw teamError(`${executor_type} / ${model ?? 'default model'} does not support reasoning effort ${effort}`);
  return { executor_type, model, ...(effort ? { effort } : {}) };
}
export function workerProfiles(raw, options) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) throw teamError('choose 1..8 workers');
  return raw.map((profile, index) => ({ agent_id: `worker-${index + 1}`, role: 'worker', ...agentProfile(profile, options), status: 'IDLE', session_ref: null }));
}
export function bindPlannerReview(task, team) {
  if (!team.planning) return;
  const planner = team.planning.planner;
  task.author_executor = planner.executor_type; task.reviewer_executor = planner.executor_type;
  task.author_model = planner.model ?? null; task.reviewer_model = planner.model ?? null;
  delete task.author_effort; delete task.reviewer_effort;
  if (planner.effort) { task.author_effort = planner.effort; task.reviewer_effort = planner.effort; }
  task.team_review_policy = { mode: 'planner-model-fresh-session', team_id: team.team_id, ...planner };
}
export function sameModelTeamReview(task) {
  const policy = task.team_review_policy;
  return policy?.mode === 'planner-model-fresh-session'
    && task.team_binding?.team_id === policy.team_id
    && task.author_executor === task.reviewer_executor
    && policy.executor_type === task.reviewer_executor
    && (policy.model ?? null) === (task.reviewer_model ?? null)
    && (task.author_model ?? null) === (task.reviewer_model ?? null)
    && (policy.effort ?? null) === (task.reviewer_effort ?? null)
    && (task.author_effort ?? null) === (task.reviewer_effort ?? null);
}
