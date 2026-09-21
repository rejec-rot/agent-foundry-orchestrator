import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnManaged, runSyncManaged } from '../lib/child-process.mjs';
import { inspectBoundaryAlerts, withBoundaryAlertLock } from '../lib/boundary-alerts.mjs';

test('alert schema: parseable invalid events remain unverifiable through the CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-alert-schema-'));
  const file = join(root, 'alerts.jsonl');
  try {
    for (const event of [null, [], {}, { event: 'boundary_retained', alert_id: 'missing-path' },
      { event: 'unknown', canonical_dir: root, alert_id: 'x', at: new Date().toISOString() },
      { event: 'boundary_retained', canonical_dir: root, alert_id: 'x', at: 'invalid-date' }]) {
      writeFileSync(file, `${JSON.stringify(event)}\n`);
      assert.equal(inspectBoundaryAlerts({ file }).ok, false);
      const cli = runSyncManaged(process.execPath, ['af-admin.mjs', 'boundary', 'alerts'], {
        env: { ...process.env, AF_BOUNDARY_ALERTS_FILE: file }, encoding: 'utf8',
      });
      assert.equal(cli.status, 3);
      assert.match(cli.stdout, /UNVERIFIABLE/);
      assert.doesNotMatch(cli.stdout, /none open/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('old live lock is not stolen; dead owner lock is safely reclaimed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'af-alert-lock-'));
  const file = join(root, 'alerts.jsonl');
  const lock = `${file}.lock`;
  const moduleURL = new URL('../lib/boundary-alerts.mjs', import.meta.url).href;
  const child = spawnManaged(process.execPath, ['--input-type=module', '-e', `
    import { withBoundaryAlertLock } from ${JSON.stringify(moduleURL)};
    withBoundaryAlertLock(${JSON.stringify(file)}, () => {
      process.stdout.write('LOCKED\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => { throw new Error('lock holder exited before acquiring'); }),
    ]);
    const owner = readFileSync(lock, 'utf8');
    const old = new Date(Date.now() - 60000);
    utimesSync(lock, old, old);
    let entered = false;
    assert.throws(() => withBoundaryAlertLock(file, () => { entered = true; }, { timeoutMs: 30, staleMs: 1 }),
      { code: 'BOUNDARY_ALERT_LOCK_TIMEOUT' });
    assert.equal(entered, false);
    assert.equal(readFileSync(lock, 'utf8'), owner);
    child.kill('SIGKILL');
    await exited;
    withBoundaryAlertLock(file, () => { entered = true; }, { timeoutMs: 500, staleMs: 1 });
    assert.equal(entered, true);
    assert.equal(existsSync(lock), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test('release does not unlink a replacement owner lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-alert-owner-'));
  const file = join(root, 'alerts.jsonl');
  const replacement = JSON.stringify({ pid: process.pid, token: 'replacement' });
  try {
    withBoundaryAlertLock(file, () => {
      rmSync(`${file}.lock`);
      writeFileSync(`${file}.lock`, replacement);
    });
    assert.equal(readFileSync(`${file}.lock`, 'utf8'), replacement);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unverifiable lock identity is never guessed dead', () => {
  const root = mkdtempSync(join(tmpdir(), 'af-alert-unknown-lock-'));
  const file = join(root, 'alerts.jsonl');
  try {
    writeFileSync(`${file}.lock`, '{incomplete');
    assert.throws(() => withBoundaryAlertLock(file, () => assert.fail('entered'), { timeoutMs: 20, staleMs: 0 }),
      { code: 'BOUNDARY_ALERT_LOCK_TIMEOUT' });
    assert.equal(readFileSync(`${file}.lock`, 'utf8'), '{incomplete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
