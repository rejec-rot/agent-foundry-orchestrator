// Shared, read-only resolution of deployment data paths.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const DATA_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve the configured data roots once, with symlinks collapsed. */
export function resolveDataRoots(env = process.env, cwd = DATA_ROOT) {
  const candidates = {
    tasks: env.AF_TASKS_DIR || join(cwd, 'tasks'),
    locks: env.AF_LOCKS_DIR || join(cwd, 'locks'),
    runtime: env.AF_RUNTIME_DIR || join(cwd, 'runtime'),
    audit: env.AF_BOUNDARY_AUDIT_DIR || null,
    snapshots: env.AF_BOUNDARY_SNAPSHOT_DIR || null,
    alerts: env.AF_BOUNDARY_ALERTS_FILE || join(env.AF_RUNTIME_DIR || join(cwd, 'runtime'), 'boundary-alerts.jsonl'),
    // The phase-event projection. Resolved through the SAME helper the adapter writes with, so a
    // reader can never look in a different place than the writer wrote to (that mismatch made a
    // finished task show "no event history" in the workbench while its events sat on disk).
    events: env.AF_V2_EVENTS_DIR || join(env.AF_TASKS_DIR || join(cwd, 'tasks'), 'events'),
  };
  const roots = {};
  for (const [key, value] of Object.entries(candidates)) {
    if (!value) continue;
    roots[key] = canonicalize(value);
  }
  return roots;
}

/** Best-effort realpath: non-existent paths are canonicalised textually (no creation). */
export function canonicalize(target) {
  const absolute = resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    // Not created yet: canonicalise the deepest existing ancestor instead.
    let head = absolute;
    const tail = [];
    for (;;) {
      try {
        const real = realpathSync(head);
        return tail.length ? join(real, ...tail.reverse()) : real;
      } catch {
        const parent = resolve(head, '..');
        if (parent === head) return absolute;
        tail.push(basename(head));
        head = parent;
      }
    }
  }
}
