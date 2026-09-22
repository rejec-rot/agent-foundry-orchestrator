// deployment-templates.test.mjs - U4 deployment preparation guard.
//
// The U4 deliverable is TEMPLATES ONLY. These are static assertions (no service is installed or
// started by the suite): the two schedulers stay independent, nothing is enabled by the templates
// themselves, `live` is never baked in, the a1a sweep is never auto-confirmed, and no real
// credential, token or webhook URL appears anywhere under deploy/.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = join(ROOT, 'deploy');

const read = (rel) => readFileSync(join(DEPLOY, rel), 'utf8');
const listFiles = (rel) => readdirSync(join(DEPLOY, rel)).map((name) => join(rel, name));

test('U4-1: the expected template files exist', () => {
  for (const rel of [
    'README.md',
    'systemd/af-a1a-recovery.service',
    'systemd/af-a1a-recovery.timer',
    'systemd/af-boundary-notify.service',
    'systemd/af-boundary-notify.timer',
    'env/a1a.env.example',
    'env/notify.env.example',
  ]) {
    assert.ok(existsSync(join(DEPLOY, rel)), `missing template: deploy/${rel}`);
  }
});

test('U4-2: services are one-shot templates that are never enabled by their own file', () => {
  for (const rel of ['systemd/af-a1a-recovery.service', 'systemd/af-boundary-notify.service']) {
    const unit = read(rel);
    assert.match(unit, /^\[Unit\]/m, `${rel} must have a [Unit] section`);
    assert.match(unit, /^\[Service\]/m, `${rel} must have a [Service] section`);
    assert.match(unit, /Type=oneshot/, `${rel} must be a one-shot pass`);
    assert.doesNotMatch(unit, /^\[Install\]/m, `${rel} must not carry an [Install] section (only timers are enabled)`);
    assert.doesNotMatch(unit, /WantedBy=/, `${rel} must not be enable-able on its own`);
    assert.match(unit, /__AF_ROOT__/, `${rel} must use the __AF_ROOT__ placeholder`);
    assert.match(unit, /__AF_CONFIG_DIR__/, `${rel} must use the __AF_CONFIG_DIR__ placeholder`);
  }
  for (const rel of ['systemd/af-a1a-recovery.timer', 'systemd/af-boundary-notify.timer']) {
    const unit = read(rel);
    assert.match(unit, /^\[Timer\]/m, `${rel} must have a [Timer] section`);
    assert.match(unit, /^\[Install\]/m, `${rel} must expose enabling only through systemctl`);
  }
});

test('U4-3: the two schedulers are independent (no shared command, config or success)', () => {
  const a1a = read('systemd/af-a1a-recovery.service');
  const notify = read('systemd/af-boundary-notify.service');
  assert.match(a1a, /af-admin\.mjs a1a sweep/, 'the recovery unit runs the a1a sweep');
  assert.match(notify, /af-admin\.mjs boundary notify-flush/, 'the notify unit runs notify-flush');
  assert.doesNotMatch(a1a, /notify-flush/, 'the recovery unit must not run the notification flush');
  assert.doesNotMatch(notify, /a1a sweep/, 'the notification unit must not run recovery');
  assert.notStrictEqual(
    /EnvironmentFile=(\S+)/.exec(a1a)[1],
    /EnvironmentFile=(\S+)/.exec(notify)[1],
    'each scheduler must read its own private config file',
  );
  assert.match(a1a, /EnvironmentFile=-__AF_CONFIG_DIR__\/a1a\.env/);
  assert.match(notify, /EnvironmentFile=-__AF_CONFIG_DIR__\/notify\.env/);
});

test('U4-4: live is never baked in, and the a1a sweep is never auto-confirmed', () => {
  const a1aService = read('systemd/af-a1a-recovery.service');
  const exec = /^ExecStart=(.+)$/m.exec(a1aService)[1];
  assert.doesNotMatch(exec, /--confirm/, 'the a1a ExecStart must NOT auto-confirm: live is a deliberate, separate edit');
  for (const rel of ['env/a1a.env.example', 'env/notify.env.example']) {
    assert.match(read(rel), /^(AF_A1A_MODE|AF_BOUNDARY_NOTIFY_MODE)=off$/m, `${rel} must default to off`);
  }
  for (const rel of listFiles('systemd').concat(listFiles('env'))) {
    // Ignore comment lines: prose may legitimately mention what live means.
    const active = read(rel).split('\n').filter((line) => !/^\s*[;#]/.test(line)).join('\n');
    assert.doesNotMatch(active, /MODE=live/, `${rel} must not ship a live mode`);
  }
});

test('U4-5: no real credential, token or webhook URL appears under deploy/', () => {
  const files = ['README.md', ...listFiles('systemd'), ...listFiles('env')];
  for (const rel of files) {
    const text = read(rel);
    assert.doesNotMatch(text, /https?:\/\//, `${rel} must not contain a URL`);
    assert.doesNotMatch(text, /\/home\/reject/, `${rel} must not contain a real home path`);
    assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]+/, `${rel} must not contain a bearer token`);
  }
  // Any credential assignment in the examples must point at the private file, never a value.
  for (const rel of ['env/a1a.env.example', 'env/notify.env.example']) {
    for (const line of read(rel).split('\n')) {
      const m = /^AF_[A-Z_]*(TOKEN|SECRET|WEBHOOK|PASSWORD)=(.+)$/.exec(line);
      if (m) assert.strictEqual(m[2].trim(), '__SET_IN_THE_PRIVATE_FILE__', `${rel}: ${m[1]} must be a placeholder, not a value`);
    }
  }
});

test('U4-6: the README states the templates are inert and the schedulers are independent', () => {
  const readme = read('README.md');
  assert.match(readme, /not deployed|not installed/i);
  assert.match(readme, /independent/i);
  assert.match(readme, /neither one's outcome|Neither unit's success/i);
});

test('DEPLOY-7: the ExecStart uses an absolute node placeholder, never a PATH lookup', () => {
  // A systemd unit does not inherit the operator's PATH: on a host whose node comes from nvm the
  // bare `node` form fails with 203/EXEC. The templates must force an explicit absolute path.
  for (const rel of ['systemd/af-a1a-recovery.service', 'systemd/af-boundary-notify.service']) {
    const unit = read(rel);
    const exec = unit.split('\n').find((line) => line.startsWith('ExecStart=')) ?? '';
    assert.match(exec, /^ExecStart=__AF_NODE__ /, `${rel} must run node through the __AF_NODE__ placeholder`);
    assert.doesNotMatch(exec, /env node|^\S+=\/usr\/bin\/node/, `${rel} must not rely on a PATH lookup`);
    assert.doesNotMatch(unit, /ExecStart=node /, `${rel} must not call a bare node`);
  }
  const readme = read('README.md');
  assert.match(readme, /__AF_NODE__/, 'the README must document __AF_NODE__');
  assert.match(readme, /203\/EXEC|PATH/, 'the README must explain why an absolute path is required');
});
