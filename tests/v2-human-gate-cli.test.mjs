// v2-human-gate-cli.test.mjs - the operator entry for a parked V2 Human Gate item is gated:
// a signed approval requires --confirm AND a configured operator key; without the key it refuses
// and writes nothing.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'af-admin.mjs');

const parkedTask = () => ({
  task_id: 'T-HG-CLI',
  state: 'WAITING_HUMAN',
  state_version: 4,
  trusted_import: {
    enabled: true,
    phase: 'WAITING_HUMAN',
    pending_human_decisions: [{ path: 'SECURITY.md', action: 'MODIFY', band: 'D', decision: 'WAITING_HUMAN' }],
    pending_human_context: { state_version: 4, cumulative_manifest_digest: 'd', baseline_oid: 'a'.repeat(40) },
  },
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'af-v2hg-'));
  writeFileSync(join(dir, 'T-HG-CLI.json'), JSON.stringify(parkedTask(), null, 2));
  return dir;
}

const run = (dir, extraEnv = {}, extraArgs = []) => spawnSync(process.execPath, [
  CLI, 'v2', 'gate-resume', '--task', 'T-HG-CLI', '--reason', 'operator reviewed the protected edit',
  '--operator', 'alice', '--tasks-dir', dir, ...extraArgs,
], { encoding: 'utf8', env: { ...process.env, AF_OPERATOR_KEY: '', ...extraEnv } });

test('V2HG-1: without --confirm the CLI refuses and writes nothing', () => {
  const dir = fixture();
  try {
    const before = readFileSync(join(dir, 'T-HG-CLI.json'), 'utf8');
    const res = run(dir, { AF_OPERATOR_KEY: 'k' });
    assert.strictEqual(res.status, 2);
    assert.match(res.stderr, /--confirm/);
    assert.strictEqual(readFileSync(join(dir, 'T-HG-CLI.json'), 'utf8'), before, 'nothing may be written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('V2HG-2: with --confirm but no operator key the approval is refused (fail-closed)', () => {
  const dir = fixture();
  try {
    const before = readFileSync(join(dir, 'T-HG-CLI.json'), 'utf8');
    const res = run(dir, { AF_OPERATOR_KEY: '' }, ['--confirm']);
    assert.strictEqual(res.status, 3);
    assert.match(res.stderr, /unsigned approval must never exist/);
    assert.strictEqual(readFileSync(join(dir, 'T-HG-CLI.json'), 'utf8'), before, 'a refused approval must not touch the task');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('V2HG-3: a signed approval records the evidence and consumes the pending decisions', () => {
  const dir = fixture();
  try {
    const res = run(dir, { AF_OPERATOR_KEY: 'test-key' }, ['--confirm']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /paths=SECURITY\.md/);
    const task = JSON.parse(readFileSync(join(dir, 'T-HG-CLI.json'), 'utf8'));
    assert.strictEqual(task.trusted_import.pending_human_decisions, null);
    assert.strictEqual(task.trusted_import.pending_human_context, null);
    const evidence = task.trusted_import.human_approval.approval_evidence;
    assert.strictEqual(evidence.operator, 'alice');
    assert.deepStrictEqual(evidence.approved_paths, ['SECURITY.md']);
    assert.ok(evidence.signature && evidence.audit_digest, 'the approval must carry a signature and an audit digest');
    assert.ok(task.state_version > 4, 'the task version must advance so a stale approval cannot be reused');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('V2HG-4: a task that is not parked cannot be approved', () => {
  const dir = fixture();
  try {
    const notParked = { ...parkedTask(), state: 'FAILED' };
    writeFileSync(join(dir, 'T-HG-CLI.json'), JSON.stringify(notParked, null, 2));
    const res = run(dir, { AF_OPERATOR_KEY: 'test-key' }, ['--confirm']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /NOT_PARKED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
