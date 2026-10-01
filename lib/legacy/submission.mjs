// Compatibility entry for legacy planning and intent alignment.
import { randomUUID } from 'node:crypto';
import { TASKS_DIR, loadTask } from '../task-runtime.mjs';

// PHASE 9-A / 9-C / 9-D: Gateway submission, Planner integration, and Human Intent Alignment Gate
// Connects Gateway -> Planner Layer -> Human Intent Alignment Gate -> Orchestrator -> Scheduler
export async function submitTask(taskCapsule, {
  scheduler = null,
  autoRun = false,
  tasksDir = null,
  withPlan = true,
  withIntentGate = true,
} = {}) {
  if (!taskCapsule || typeof taskCapsule !== 'object') {
    throw new Error('submitTask requires a valid taskCapsule object');
  }

  const dir = tasksDir || TASKS_DIR;

  if (!taskCapsule.task_id) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    taskCapsule.task_id = `TASK-${today}-${randomUUID().slice(0, 8).toUpperCase()}`;
  }

  // PHASE 9-C: If task has goal and no planner_result, invoke Planner Layer
  if (withPlan && !taskCapsule.planner_result && taskCapsule.goal) {
    try {
      const { planTask } = await import('../../planner/planner.mjs');
      const plan = await planTask(taskCapsule);
      taskCapsule.planner_result = plan;
    } catch {
      // Continue fail-safe if planning error or custom testing hook
    }
  }

  // PHASE 9-D: Human Intent Alignment Gate
  if (withIntentGate) {
    const { alignTaskIntent } = await import('../../approval/intent-gate.mjs');
    const alignment = alignTaskIntent(taskCapsule, taskCapsule.planner_result, { tasksDir: dir });
    if (alignment.required) {
      return {
        task_id: taskCapsule.task_id,
        status: 'WAITING_HUMAN',
        intent_alignment: taskCapsule.intent_alignment,
        planner_result: taskCapsule.planner_result ?? null,
        scheduler: scheduler || null,
      };
    }
  }

  const { Scheduler } = await import('../scheduler.mjs');
  const sched = scheduler || new Scheduler({ tasksDir: dir });
  const taskId = sched.enqueue(taskCapsule);
  if (autoRun) {
    sched.runNext();
  }
  return {
    task_id: taskId,
    status: 'ACCEPTED',
    scheduler: sched,
    intent_alignment: taskCapsule.intent_alignment ?? null,
    planner_result: taskCapsule.planner_result ?? null,
  };
}

export async function approveTaskIntent(taskId, {
  reason = '确认执行该方案',
  approvedBy = 'user',
  tasksDir = null,
  scheduler = null,
  autoRun = false,
} = {}) {
  if (!taskId) throw new Error('approveTaskIntent requires taskId');
  const dir = tasksDir || TASKS_DIR;
  const { approveIntent } = await import('../../approval/intent-gate.mjs');
  const res = approveIntent(taskId, { reason, approvedBy, tasksDir: dir });

  // Task is now APPROVED. Enqueue into Scheduler
  const { Scheduler } = await import('../scheduler.mjs');
  const sched = scheduler || new Scheduler({ tasksDir: dir });
  const task = loadTask(taskId, dir);
  sched.enqueue(task);
  if (autoRun) {
    sched.runNext();
  }

  return {
    task_id: taskId,
    status: 'APPROVED',
    message: reason,
    scheduler: sched,
    task,
  };
}

export async function rejectTaskIntent(taskId, {
  reason = '方向不符合要求',
  rejectedBy = 'user',
  tasksDir = null,
} = {}) {
  if (!taskId) throw new Error('rejectTaskIntent requires taskId');
  const dir = tasksDir || TASKS_DIR;
  const { rejectIntent } = await import('../../approval/intent-gate.mjs');
  const res = rejectIntent(taskId, { reason, rejectedBy, tasksDir: dir });

  return {
    task_id: taskId,
    status: 'CANCELLED',
    message: reason,
    task: res.task,
  };
}
