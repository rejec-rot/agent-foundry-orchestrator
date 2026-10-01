// V2 contract: lifecycle is task.state; phase and fix budget belong to trusted_import.
export const V2_TASK_SCHEMA = 'af-v2-task-v1';
export const V2_TERMINAL_STATES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED']);

export function normalizeV2Task(task) {
  if (task.trusted_import?.enabled !== true) throw new Error('not a V2 trusted-import task');
  const config = task.trusted_import;
  const budget = config.max_revisions ?? task.max_revisions ?? 3;
  if (!Number.isInteger(budget) || budget < 0) throw new Error('V2 max_revisions must be a non-negative integer');
  config.max_revisions = budget;
  config.revisions_used ??= 0; // number of fix attempts; top-level revisions_used is the author revision.
  if (!Number.isInteger(config.revisions_used) || config.revisions_used < 0) throw new Error('V2 revisions_used must be a non-negative integer');
  config.phase ??= 'CREATED';
  task.max_revisions = budget; // compatibility projection for existing consumers.
  return task;
}
