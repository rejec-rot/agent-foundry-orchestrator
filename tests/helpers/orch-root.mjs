// orch-root.mjs - hermetic root for scheduler/orchestrator tests.
//
// The scheduler and orchestrator resolve their directories at MODULE LOAD time, so this
// helper must be imported FIRST in a test file: it creates a private temp root and points
// AF_TASKS_DIR / AF_LOCKS_DIR / AF_RUNTIME_DIR at it before those modules are evaluated.
// Without it, parallel test files share `runtime/scheduler.json` in the repository, clobber
// each other's records, and leave production-looking state behind.

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ORCH_ROOT = mkdtempSync(join(tmpdir(), 'af-orch-root-'));

process.env.AF_TASKS_DIR = join(ORCH_ROOT, 'tasks');
process.env.AF_LOCKS_DIR = join(ORCH_ROOT, 'locks');
process.env.AF_RUNTIME_DIR = join(ORCH_ROOT, 'runtime');

for (const dir of [process.env.AF_TASKS_DIR, process.env.AF_LOCKS_DIR, process.env.AF_RUNTIME_DIR]) {
  mkdirSync(dir, { recursive: true });
}
