// af-exec-provision.test.mjs - the root-only provisioning assets must stay gated and secret-free.
//
// Nothing here needs root: the scripts are asserted statically AND executed as the current
// (non-root) user, where they must refuse and change nothing.

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROVISION = join(ROOT, 'deploy', 'af-exec', 'provision.sh');
const LAUNCHER = join(ROOT, 'deploy', 'af-exec', 'af-exec-run.sh');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('AFP-1: the template protects the claim (root:0600) and the launcher (root:0755)', () => {
  const src = readFileSync(PROVISION, 'utf8');
  assert.match(src, /chmod 0600 "\$CLAIM_FILE"/, 'the claim must be 0600');
  assert.match(src, /chown root:root "\$CLAIM_FILE"/, 'the claim must be root-owned');
  assert.match(src, /install -o root -g root -m 0755 "[^"]*af-exec-run\.sh"/, 'the launcher must be installed root:0755');
  assert.match(src, /af-exec-isolation-claim-v1/, 'the claim records the handshake schema');
});

test('AFP-2: the template is dry-run by default and mutates only with --apply', () => {
  const src = readFileSync(PROVISION, 'utf8');
  assert.match(src, /APPLY=0/, 'mutation must be opt-in');
  assert.match(src, /--apply\) APPLY=1/, 'the operator must pass --apply explicitly');
  for (const cmd of ['useradd', 'chown -R root:root', 'chmod -R go-w', 'install -o root -g root -m 0755']) {
    const line = src.split('\n').find((l) => l.includes(cmd) && l.includes('"$APPLY" -eq 1'));
    assert.ok(line, `expected an APPLY-guarded "${cmd}" action in the template`);
  }
  assert.match(src, /if \[ "\$APPLY" -eq 1 \]; then[\s\S]*af-exec-isolation-claim-v1[\s\S]*\nfi/, 'the claim write must live inside the apply block');
});

test('AFP-3: the privileged launcher refuses non-root callers and a root target', () => {
  const src = readFileSync(LAUNCHER, 'utf8');
  assert.match(src, /id -u/, 'the launcher must check its own caller');
  assert.match(src, /exit 3/, 'a non-root caller must be refused');
  assert.match(src, /exit 4/, 'a uid=0 target must be refused');
  assert.match(src, /setpriv --reuid/, 'the identity drop must be explicit');
});

test('AFP-4: running the provision template as non-root refuses (exit 3) and creates nothing', () => {
  if (isRoot) return; // this assertion is about the non-root path
  const claim = '/etc/af-exec/claim.json';
  assert.strictEqual(existsSync(claim), false, 'precondition: no claim before the run');
  const res = spawnSync('sh', [PROVISION], { encoding: 'utf8' });
  assert.strictEqual(res.status, 3, `expected a root refusal, got ${res.status}`);
  assert.match(res.stderr, /requires root/);
  assert.match(res.stderr, /Nothing was changed/);
  assert.strictEqual(existsSync(claim), false, 'a refused run must not create the claim');
});

test('AFP-5: the launcher refuses when invoked as non-root', () => {
  if (isRoot) return;
  const res = spawnSync('sh', [LAUNCHER, '--uid', '900', '--gid', '900', '--', 'true'], { encoding: 'utf8' });
  assert.strictEqual(res.status, 3, `expected a caller refusal, got ${res.status}`);
  assert.match(res.stderr, /must be executed by root/);
});
