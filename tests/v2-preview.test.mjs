// v2-preview.test.mjs - the running-result preview is OFF by default and refuses every way in.
//
// The feature's whole value is that it cannot start anything by accident: the default is `off`, a
// non-allowlisted command is refused, a missing port range is refused, an unconfirmed start is
// refused, and a stop either verifies termination or reports that it could not.

import './helpers/executors-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { previewConfig, planPreview, startPreview, stopPreview, listPreviews, parsePortRange } from '../lib/preview.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-preview-'));
  const workspace = join(root, 'workspace');
  const dir = join(root, 'previews');
  const allowlist = join(root, 'preview-allowlist.json');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(allowlist, JSON.stringify({ allowed: [{ command: process.execPath, args_prefix: ['-e'] }] }));
  return {
    root, workspace, dir, allowlist,
    task: { task_id: 'T-PREVIEW', state: 'COMPLETED', trusted_import: { enabled: true } },
    env: { AF_PREVIEW_MODE: 'live', AF_PREVIEW_ALLOWLIST: allowlist, AF_PREVIEW_PORT_RANGE: '43100-43110', AF_PREVIEW_DIR: dir },
  };
}

test('PREV-1: the default is off, and off means nothing is executable', () => {
  const fx = fixture();
  try {
    const config = previewConfig({});
    assert.equal(config.mode, 'off');
    assert.equal(config.enabled, false);
    const plan = planPreview({ task: fx.task, config });
    assert.equal(plan.ok, true);
    assert.equal(plan.executable, false, 'an off preview is a no-op, not an implicit yes');
    assert.match(plan.reason, /previews are off/);

    const garbage = previewConfig({ AF_PREVIEW_MODE: 'whatever' });
    assert.equal(garbage.mode, null);
    assert.equal(planPreview({ task: fx.task, config: garbage }).ok, false, 'an unknown mode is refused, not treated as off');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('PREV-2: static mode never executes - it points at the snapshot content endpoint', () => {
  const plan = planPreview({ task: { task_id: 'T-1' }, config: previewConfig({ AF_PREVIEW_MODE: 'static' }) });
  assert.equal(plan.ok, true);
  assert.equal(plan.executable, false);
  assert.equal(plan.plan.kind, 'static');
  assert.match(plan.reason, /nothing is executed/);
});

test('PREV-3: a live preview refuses a non-allowlisted command, a missing range and a bad workspace', () => {
  const config = previewConfig({ AF_PREVIEW_MODE: 'live', AF_PREVIEW_ALLOWLIST: join(ROOT, 'config', 'acceptance-allowlist.json'), AF_PREVIEW_PORT_RANGE: '43100-43110' });
  const notAllowed = planPreview({ task: { task_id: 'T-1' }, config, command: '/bin/rm', args: ['-rf', '/'], workspace: ROOT });
  assert.equal(notAllowed.ok, false);
  assert.match(notAllowed.reason, /not on the allowlist/);

  const noRange = previewConfig({ AF_PREVIEW_MODE: 'live', AF_PREVIEW_ALLOWLIST: join(ROOT, 'config', 'acceptance-allowlist.json') });
  const noPort = planPreview({ task: { task_id: 'T-1' }, config: noRange, command: 'node', args: ['--test'], workspace: ROOT });
  assert.equal(noPort.ok, false);
  assert.match(noPort.reason, /no preview port range/);

  assert.equal(parsePortRange('43100-43110').size, 11);
  assert.equal(parsePortRange('80-90'), null, 'a privileged range is not a valid preview range');
  assert.equal(parsePortRange('nonsense'), null);
});

test('PREV-4: starting requires an explicit confirmation and a real allowlisted command', async () => {
  const fx = fixture();
  try {
    const config = previewConfig(fx.env);
    assert.equal(config.mode, 'live');
    assert.equal(config.allowlist.ok, true);

    const unconfirmed = await startPreview({ task: fx.task, config, command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], workspace: fx.workspace, confirm: false });
    assert.equal(unconfirmed.ok, false);
    assert.match(unconfirmed.reason, /explicit operator action/);

    const notAllowed = await startPreview({ task: fx.task, config, command: '/bin/sleep', args: ['30'], workspace: fx.workspace, confirm: true });
    assert.equal(notAllowed.ok, false);
    assert.match(notAllowed.reason, /not on the allowlist/);

    const started = await startPreview({
      task: fx.task,
      config,
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 60000)'],
      workspace: fx.workspace,
      confirm: true,
    });
    assert.equal(started.ok, true, started.reason ?? '');
    assert.ok(started.record.pid > 0);
    assert.equal(started.record.status, 'running');
    assert.ok(started.record.port >= 43100 && started.record.port <= 43110, `port=${started.record.port}`);

    const again = await startPreview({ task: fx.task, config, command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], workspace: fx.workspace, confirm: true });
    assert.equal(again.ok, false);
    assert.match(again.reason, /already running/);

    const stopped = await stopPreview({ taskId: fx.task.task_id, config });
    assert.equal(stopped.ok, true, stopped.reason ?? '');
    assert.equal(stopped.record.status, 'stopped');
    assert.equal(stopped.record.termination.verified, true, 'a stop must verify termination, not assume it');

    const list = listPreviews({ config });
    assert.equal(list.previews.length, 1);
    assert.equal(list.previews[0].alive, false);

    // the port is remembered, so a new preview does not silently reuse a port it once bound
    const second = await startPreview({ task: fx.task, config, command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], workspace: fx.workspace, confirm: true });
    assert.equal(second.ok, true);
    assert.notEqual(second.record.port, started.record.port, 'a previously used port is not immediately reused');
    await stopPreview({ taskId: fx.task.task_id, config });
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('PREV-5: stopping is idempotent about what it can prove', async () => {
  const fx = fixture();
  try {
    const config = previewConfig(fx.env);
    const nothing = await stopPreview({ taskId: 'T-NONE', config });
    assert.equal(nothing.ok, false);
    assert.match(nothing.reason, /no preview record/);

    const started = await startPreview({ task: fx.task, config, command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'], workspace: fx.workspace, confirm: true });
    assert.equal(started.ok, true);
    assert.equal((await stopPreview({ taskId: fx.task.task_id, config })).ok, true);
    const twice = await stopPreview({ taskId: fx.task.task_id, config });
    assert.equal(twice.ok, true, 'stopping an already-stopped preview reports the truth instead of failing');
    assert.equal(twice.record.termination.alive_before, false);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test('PREV-6: the module cannot start anything without the word live', () => {
  const source = readFileSync(join(ROOT, 'lib', 'preview.mjs'), 'utf8');
  assert.match(source, /PREVIEW_MODES\.includes\(rawMode\)/, 'an unknown mode is refused rather than coerced');
  assert.match(source, /confirm !== true/, 'every start demands an explicit confirmation');
  assert.doesNotMatch(source, /spawnManaged\([^)]*\)\s*;?\s*$/m, 'spawnManaged is only reached through the guarded path');
});
