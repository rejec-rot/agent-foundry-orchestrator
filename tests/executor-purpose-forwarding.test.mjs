// executor-purpose-forwarding.test.mjs - the writer-scope guard must not be bypassable.
//
// Found by a LIVE V2 run: the command-code adapter (and three others) mapped every purpose except
// `recovery_probe` to `production`, so a trusted-import author ran WITHOUT the cgroup/container
// writer scope execAsync requires - a real model run was spent, and the task only failed later at
// the termination-evidence check. This suite pins the behaviour that stops it.

import './helpers/executors-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADAPTERS } from '../lib/adapters.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('PURPOSE-1: a trusted-import run refuses BEFORE spawning when no writer scope is verifiable', async () => {
  // This host has no writable cgroup, which is exactly the condition the guard exists for. If a
  // future host DOES have one, the assertion below still holds except that the run would proceed -
  // so the check is written against what must never happen: an unverifiable scope + a spawn.
  const result = await ADAPTERS['command-code'].run({
    prompt: 'this prompt must never reach a model',
    task_id: 'T-PURPOSE-1',
    runId: `RUN-PURPOSE-${Date.now()}`,
    cwd: ROOT,
    purpose: 'trusted_import',
    timeout_ms: 5000,
  });
  if (result.status === 'failed') {
    assert.match(String(result.error ?? result.spawn_error ?? ''), /TRUSTED_IMPORT_WRITER_SCOPE_UNAVAILABLE/);
    assert.equal(result.writer_termination?.process_started, false, 'no process may be started');
    assert.equal(result.writer_termination?.scope_verified, false);
    assert.equal(result.error_classification?.category, 'ENVIRONMENT_FAULT', 'an environment fault, not a model failure');
  } else {
    // A host WITH a real cgroup/container scope: then the writer scope must be verified.
    assert.equal(result.writer_termination?.scope_verified, true, 'a trusted-import run may only proceed with a VERIFIED writer scope');
    assert.ok(['cgroup', 'container'].includes(result.writer_termination?.scope_kind), `scope_kind=${result.writer_termination?.scope_kind}`);
  }
});

test('PURPOSE-2: every adapter forwards the capsule purpose verbatim', () => {
  const source = readFileSync(join(ROOT, 'lib', 'adapters.mjs'), 'utf8');
  // The lossy pattern that caused the bypass must not come back.
  assert.doesNotMatch(source, /=== 'recovery_probe' \? 'recovery_probe' : 'production'/, 'the lossy purpose mapping must not return');
  // Every purpose handed to execAsync derives from the shared mapper or the capsule verbatim.
  const purposeArgs = [...source.matchAll(/purpose:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  const suspicious = purposeArgs.filter((value) => value !== 'purpose' && !value.startsWith('purposeOf(capsule)') && value !== 'purposeParam');
  assert.deepEqual(suspicious, [], `these purpose arguments need review: ${suspicious.join(' | ')}`);
  assert.ok(source.includes('function purposeOf(capsule)'), 'the shared mapper must exist');
  assert.match(source, /trusted_import' \|\| purpose === 'recovery_probe' \? purpose : 'production'/, 'the mapper keeps trusted_import and recovery_probe, and downgrades only the rest');
});

test('PURPOSE-3: the V2 author capsule actually carries trusted_import', () => {
  const orchestrator = readFileSync(join(ROOT, 'orchestrator.mjs'), 'utf8');
  assert.match(orchestrator, /purpose: task\.trusted_import\?\.enabled === true \? 'trusted_import' : undefined/,
    'the author/review capsules must announce the trusted-import purpose, or the guard has nothing to match');
});
