// Child process used by the V2 integration test. Each invocation imports the
// orchestrator afresh and receives only the durable task JSON.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const taskPath = process.argv[2];
const mode = process.argv[3] ?? 'recover';
if (!taskPath) process.exit(2);

const task = JSON.parse(readFileSync(taskPath, 'utf8'));
Object.defineProperty(task, '__tasksDir', {
  value: process.env.AF_TASKS_DIR,
  enumerable: false,
});

const writerTermination = () => ({
  process_started: true,
  process_group_id: 22345,
  process_group_alive: false,
  termination_confirmed: true,
  termination_signal: null,
  forced: false,
  checked_at: new Date().toISOString(),
});

const author = {
  type: 'codex',
  supportsMcpUnattended: true,
  async run(capsule) {
    writeFileSync(join(capsule.cwd, 'src', 'value.mjs'), "export const value = 'v2';\n");
    return {
      executor_run_id: `RUN-${randomUUID().slice(0, 8)}`,
      executor_type: 'codex',
      assigned_role: 'author',
      status: 'completed',
      session_ref: `author-${randomUUID()}`,
      structured_result: { result: 'candidate prepared' },
      exit_code: 0,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: null,
      writer_termination: writerTermination(),
    };
  },
  async resume() { throw new Error('author was unexpectedly rerun'); },
  cancel() { return { cancelled: true }; },
};

const reviewer = {
  type: 'claude',
  supportsMcpUnattended: true,
  async run(capsule) {
    return {
      executor_run_id: `RUN-${randomUUID().slice(0, 8)}`,
      executor_type: 'claude',
      assigned_role: 'reviewer',
      status: 'completed',
      session_ref: `reviewer-${randomUUID()}`,
      structured_result: {
        result: JSON.stringify({
          task_id: capsule.task_id,
          revision: 1,
          decision: 'PASS',
          summary: 'candidate snapshot inspected',
          issues: [],
          required_changes: [],
          evidence: ['src/value.mjs:1'],
        }),
      },
      exit_code: 0,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: null,
      writer_termination: writerTermination(),
    };
  },
  cancel() { return { cancelled: true }; },
};

const { executeTask } = await import('../../orchestrator.mjs');
const adapters = { codex: author, claude: reviewer };
const result = await executeTask(task, adapters, {
  trustedImportHooks: {
    afterRefUpdate: () => {
      if (mode === 'crash') process.exit(97);
    },
  },
});
writeFileSync(join(dirname(taskPath), `${task.task_id}.worker-result.json`), JSON.stringify(result, null, 2));
