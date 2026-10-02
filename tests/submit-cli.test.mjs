// submit-cli.test.mjs - the stage-2 operator surface must preview/record only, never start.
//
// The CLI is the first operator entry for lib/submission.mjs. It must stay gated the same way the
// library is: a target outside the allowed roots is refused, governance/platform fields are
// refused loudly, recording is idempotent, and nothing here can start or schedule a task.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'af-admin.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-submit-cli-'));
  const target = join(root, 'target');
  const submissions = join(root, 'submissions');
  mkdirSync(target, { recursive: true });
  mkdirSync(submissions, { recursive: true });
  return { root, target, submissions };
}

const specFor = (target, extra = {}) => ({
  goal: 'add a hello module',
  target_path: target,
  acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
  idempotency_key: 'cli-key-1',
  ...extra,
});

function run(fx, spec, extraArgs = []) {
  const specFile = join(fx.root, 'spec.json');
  writeFileSync(specFile, JSON.stringify(spec, null, 2));
  return spawnSync(process.execPath, [
    CLI, 'submit', '--spec', specFile, '--root', fx.target, ...extraArgs,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AF_SUBMISSION_DIR: fx.submissions,
      AF_ACCEPTANCE_ALLOWLIST: join(ROOT, 'config', 'acceptance-allowlist.json'),
      // The executor capability truth lives in a sibling registry; point the CLI at the
      // self-contained stand-in so the availability check can be evaluated anywhere.
      AF_EXECUTORS_DIR: process.env.AF_EXECUTORS_DIR || join(ROOT, 'fixtures', 'agent-foundry-global', 'executors'),
    },
  });
}

test('SUB-CLI-1: --preview describes the pipeline, states it did not start, and writes nothing', () => {
  const fx = fixture();
  try {
    const res = run(fx, specFor(fx.target), ['--preview']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /submit preview: ok \(started=false\)/);
    assert.match(res.stdout, /nothing is scheduled or executed/i);
    assert.equal(readdirSync(fx.submissions).length, 0, 'a preview must not create a record');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('SUB-CLI-2: a target outside the allowed roots is refused', () => {
  const fx = fixture();
  try {
    const res = run(fx, specFor('/etc'), ['--preview']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /error:/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('SUB-CLI-3: forged governance fields are refused loudly', () => {
  const fx = fixture();
  try {
    const res = run(fx, specFor(fx.target, { role: 'author', model: 'gpt-x' }), ['--preview']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /PLATFORM_BOUND_FIELD_REJECTED|GOVERNANCE_FIELD_REJECTED/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('SUB-CLI-4: --record publishes once and is idempotent for the same key and capsule', () => {
  const fx = fixture();
  try {
    const first = run(fx, specFor(fx.target), ['--record']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /submit record: ok/);
    assert.match(first.stdout, /started=false/);

    const second = run(fx, specFor(fx.target), ['--record']);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /duplicate/, 'the same key + capsule must return the original record');
    assert.equal(readdirSync(fx.submissions).filter((n) => n.endsWith('.json')).length, 1, 'exactly one record');

    const stored = JSON.parse(readFileSync(join(fx.submissions, readdirSync(fx.submissions)[0]), 'utf8'));
    assert.equal(stored.state, 'PREPARED');
    assert.equal(stored.started, false, 'recording must never start anything');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('SUB-CLI-5: the same key with a DIFFERENT capsule is refused', () => {
  const fx = fixture();
  try {
    assert.equal(run(fx, specFor(fx.target), ['--record']).status, 0);
    const res = run(fx, specFor(fx.target, { goal: 'something else entirely' }), ['--record']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_SPEC/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('SUB-CLI-6: there is no start path - the CLI has no flag that could execute anything', () => {
  const src = readFileSync(CLI, 'utf8');
  assert.doesNotMatch(src, /submitTask\s*\(/, 'the operator surface must not call submitTask');
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /record never starts a task/);
});
