// typesafe-probe.test.mjs - the live probe must stay gated and secret-free.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join(ROOT, 'verification', 'typesafe-decision-probe.mjs');
const cli = (args, env = {}) => spawnSync(process.execPath, [PROBE, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('TP-1: the probe source is gated and carries no secret', () => {
  const src = readFileSync(PROBE, 'utf8');
  assert.match(src, /--confirm/, 'the probe must require explicit --confirm');
  assert.doesNotMatch(src, /apikey_[0-9a-f]/i, 'no hardcoded API key');
  assert.doesNotMatch(src, /AF_TYPESAFE_API_KEY\s*=\s*['"][^'"]+['"]/, 'the key must come from env, never a literal');
});

test('TP-2: without --confirm the probe makes no call and exits 0', () => {
  const res = cli([]);
  assert.strictEqual(res.status, 0);
  assert.match(res.stdout, /gated probe/);
});

test('TP-3: with --confirm but unconfigured the probe refuses (exit 2, no call)', () => {
  const res = cli(['--confirm'], { AF_DECISION_MODEL: 'off', AF_TYPESAFE_API_KEY: '' });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /no call made/);
});
