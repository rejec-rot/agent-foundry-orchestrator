// Logical members and work items are independent of executor sessions/processes.
import { randomUUID } from 'node:crypto';
import { capsuleDigest } from '../json-identity.mjs';
import { validateRawPath } from '../trusted-import/common.mjs';

export const TEAM_SCHEMA = 'af-team-v1';
export function teamError(message, code = 'TEAM_INVALID') { return Object.assign(new Error(message), { code }); }
export function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id); }
export function requireId(id) { if (!validId(id)) throw teamError('invalid identifier'); return id; }
export function text(value, label, max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw teamError(`${label} must be nonempty text up to ${max} characters`);
  return value.trim();
}
export function newTeam(task, { workerCount = 3 } = {}) {
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8) throw teamError('workerCount must be 1..8');
  const teamId = `TEAM-${requireId(task.task_id)}`;
  const members = [{ agent_id: 'lead', role: 'lead', executor_type: task.author_executor, status: 'IDLE', session_ref: null }];
  for (let i = 1; i <= workerCount; i++) members.push({ agent_id: `worker-${i}`, role: 'worker', executor_type: task.author_executor, status: 'IDLE', session_ref: null });
  return {
    schema_version: TEAM_SCHEMA, team_id: teamId, goal_id: `GOAL-${randomUUID()}`, goal: task.goal,
    goal_revision: 1, sequence: 0, state: 'CREATED', created_at: new Date().toISOString(),
    delivery_task_id: task.task_id, project_id: task.trusted_import?.profile_provenance?.project_id ?? null,
    members, work_items: [], runs: [], delivery_runs: [], artifacts: [], messages: [], commands: {},
    plan_revision: 0, work_revision: 1, plan_attempts: 0, max_plan_attempts: 3, max_attempts: 6,
    baseline: null, integration: null, delivery: null, failure_reason: null,
  };
}
export function validatePlan(raw, team) {
  if (!Array.isArray(raw?.work_items) || !raw.work_items.length || raw.work_items.length > 32) throw teamError('plan needs 1..32 work_items');
  const ids = new Set();
  const members = new Set(team.members.filter(m => m.role === 'worker').map(m => m.agent_id));
  const items = raw.work_items.map(item => {
    const id = requireId(item.work_item_id);
    if (ids.has(id)) throw teamError(`duplicate work item ${id}`);
    ids.add(id);
    if (!members.has(item.agent_id)) throw teamError(`unknown worker ${item.agent_id}`);
    const deps = item.depends_on ?? [];
    if (!Array.isArray(deps) || deps.some(d => !validId(d)) || new Set(deps).size !== deps.length) throw teamError('invalid dependencies');
    const paths = item.allowed_paths ?? ['.'];
    if (!Array.isArray(paths) || !paths.length || paths.length > 32) throw teamError('allowed_paths required');
    for (const path of paths) if (path !== '.') validateRawPath(path.replace(/\/\*\*$/, '').replace(/\*$/,'scope'));
    return { work_item_id: id, agent_id: item.agent_id, goal: text(item.goal, 'work item goal'),
      depends_on: deps, allowed_paths: paths, output_contract: text(item.output_contract ?? 'Deliver working files and a concise summary.', 'output contract'),
      revision: 1, status: 'READY', attempts: 0, total_attempts: 0, artifact_id: null, active_run_id: null, blocked_reason: null };
  });
  const done = new Set();
  while (done.size < items.length) {
    const ready = items.filter(i => !done.has(i.work_item_id) && i.depends_on.every(d => done.has(d)));
    if (!ready.length) throw teamError('plan has a dependency cycle or missing work item');
    for (const item of ready) done.add(item.work_item_id);
  }
  return items;
}
export function affectedItems(team, ids) {
  const affected = new Set(ids);
  for (;;) {
    const before = affected.size;
    for (const item of team.work_items) if (item.depends_on.some(d => affected.has(d))) affected.add(item.work_item_id);
    if (affected.size === before) return [...affected];
  }
}
export function invalidateItems(team, ids) {
  team.work_revision++;
  for (const item of team.work_items) if (ids.includes(item.work_item_id)) {
    item.revision++; item.status = 'READY'; item.artifact_id = null;
    item.active_run_id = null; item.attempts = 0; item.blocked_reason = null;
  }
  team.integration = null; team.delivery = null; team.state = 'WORKING';
  for(const message of team.messages) if((ids.includes(message.work_item_id)||ids.includes(message.source_work_item_id)||(message.goal_revision!==undefined&&message.goal_revision!==team.goal_revision))&&['queued','received'].includes(message.status)) {
    message.status='superseded';
    if(team.commands[message.message_id]) team.commands[message.message_id]={...team.commands[message.message_id],status:'rejected',reason:'work item direction changed'};
  }
}
export function definitionDigest(item) {
  return capsuleDigest({ goal: item.goal, depends_on: item.depends_on, agent_id: item.agent_id, allowed_paths: item.allowed_paths, output_contract: item.output_contract });
}
