// executor-router.mjs - PHASE 6-C Multi Executor Routing
//
// Responsibilities:
//   Pure deterministic funnel function for multi-executor selection and fallback ordering.
//
// Funnel stages:
//   Step 1: Capability Filter (requires_mcp, enterprise compliance, etc.)
//   Step 2: Availability Filter (UNAVAILABLE, ACCOUNT_DISABLED blockers)
//   Step 3: Runtime Filter (OPEN_MANUAL_RESET, PROBING, active cooldown)
//   Step 4: Priority Sort (default: vertex-gemini -> claude -> codex -> antigravity)
//
// Invariants (Strict):
//   - Pure function: NO state persistence, NO spawn, NO network calls, NO task mutations.
//   - ROLE != PLATFORM: never statically binds roles to platforms.

import { executorEligibility } from './executor-eligibility.mjs';
import { disabledExecutors } from './operator-control.mjs';
import { loadExecutorStatus, EXECUTORS_DIR } from './executor-status.mjs';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PRIORITY_ORDER = Object.freeze([
  'vertex-gemini',
  'claude',
  'codex',
  'antigravity',
]);

/**
 * Load capability facts from executors directory into Map<id, json>
 */
export function loadCapabilityMap(dir = EXECUTORS_DIR) {
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'contract.json') continue;
    try {
      const json = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const id = json.executor_id || f.replace(/\.json$/, '');
      map.set(id, json);
    } catch { /* skip invalid */ }
  }
  return map;
}

/**
 * Deterministic router function
 *
 * @param {Object} taskCapsule - Task definition capsule
 * @param {Object} [options]
 * @param {string} [options.role] - 'author' | 'reviewer' | null
 * @param {Map} [options.capabilityMap] - Map of executor capabilities
 * @param {Map} [options.availabilityMap] - Map of executor availability
 * @param {Object} [options.runtimeGuard] - RuntimeGuard instance or { getCircuitState(id) }
 * @param {string[]} [options.priorityOrder] - Priority ordering list
 * @param {Object} [options.adapters] - Optional adapters map to restrict candidates
 * @returns {{ primary: string | null, fallbacks: string[] }}
 */
export function resolveExecutorRoute(taskCapsule = {}, {
  role = null,
  capabilityMap = null,
  availabilityMap = null,
  runtimeGuard = null,
  priorityOrder = null,
  // Adapter map. Pass it when routing real work: adapter-level flags such as
  // `schedulable: false` and `stub: true` are consulted ONLY through this map, so a
  // caller that omits it can select an executor the adapter has explicitly excluded.
  // The scheduler (the production caller) always passes it; a caller that injects
  // only a capability or availability map must do the same.
  adapters = null,
  disabled = disabledExecutors(),
} = {}) {
  const caps = capabilityMap || loadCapabilityMap();
  const avails = availabilityMap || loadExecutorStatus();

  // Fail closed when nothing was injected AND the global registry resolved to
  // nothing: without capability truth and without an availability projection
  // there is no evidence to route on, and silently picking the priority order
  // would dispatch work to executors whose state is simply unknown.
  if (!capabilityMap && !availabilityMap && caps.size === 0 && avails.size === 0) {
    return {
      primary: null,
      fallbacks: [],
      reason: 'EXECUTOR_REGISTRY_MISSING: no executor capability truth resolved (set AF_EXECUTORS_DIR or AF_GLOBAL_DIR)',
    };
  }
  const rawPriority = (Array.isArray(priorityOrder) && priorityOrder.length ? priorityOrder : null)
    || (Array.isArray(taskCapsule?.priority_order) && taskCapsule.priority_order.length ? taskCapsule.priority_order : null)
    || (process.env.AF_EXECUTOR_PRIORITY ? process.env.AF_EXECUTOR_PRIORITY.split(',').map((s) => s.trim()) : null)
    || DEFAULT_PRIORITY_ORDER;
  const priorities = rawPriority;

  // Determine preference
  const rawPref = role === 'reviewer'
    ? (taskCapsule.reviewer_executor || taskCapsule.executor)
    : (taskCapsule.author_executor || taskCapsule.executor);
  const preference = rawPref && rawPref !== 'auto' ? rawPref : null;

  // Candidate pool: active priorities + explicit preference (if specified)
  const pool = new Set([...priorities]);
  if (preference) pool.add(preference);

  const eligible = [];

  for (const id of pool) {
    if (!executorEligibility(id, taskCapsule, { adapters, capabilityMap: caps, availabilityMap: avails, runtimeGuard, disabled }).ok) continue;

    eligible.push(id);
  }

  // Step 4: Priority Sort
  eligible.sort((a, b) => {
    const idxA = priorities.indexOf(a);
    const idxB = priorities.indexOf(b);
    const rankA = idxA === -1 ? 999 : idxA;
    const rankB = idxB === -1 ? 999 : idxB;
    return rankA - rankB;
  });

  if (preference) {
    if (eligible.includes(preference)) {
      return {
        primary: preference,
        fallbacks: eligible.filter((id) => id !== preference),
      };
    } else {
      // Explicit preference requested but ineligible
      return {
        primary: null,
        fallbacks: eligible,
      };
    }
  }

  return {
    primary: eligible[0] || null,
    fallbacks: eligible.slice(1),
  };
}
