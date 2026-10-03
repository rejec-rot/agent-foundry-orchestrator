import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { normalizeClineSdkModels, queryClineSdkCatalog } from '../lib/team/cline-sdk-catalog.mjs';

const SDK_SOURCE = 'installed Cline SDK provider metadata';

function clineFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'af-cline-sdk-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clineRoot = join(root, 'cline');
  const bin = join(clineRoot, 'bin');
  const sdkRoot = join(clineRoot, 'node_modules', '@cline', 'llms');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(sdkRoot, 'dist'), { recursive: true });
  writeFileSync(join(clineRoot, 'package.json'), JSON.stringify({ name: 'cline', version: '3.0.68' }));
  const binary = join(bin, 'cline.js');
  writeFileSync(binary, '#!/usr/bin/env node\n');
  chmodSync(binary, 0o755);
  writeFileSync(join(sdkRoot, 'package.json'), JSON.stringify({
    name: '@cline/llms', version: '0.0.90', exports: { '.': { import: './dist/index.js' } },
  }));
  const sdkEntry = join(sdkRoot, 'dist', 'index.js');
  writeFileSync(sdkEntry, 'export async function getModelsForProvider() { return {}; }\n');
  return { root, binary, sdkEntry };
}

function fakeChild({ output = '', code = 0, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  if (!hang) {
    setImmediate(() => {
      child.stdout.end(output);
      child.stdout.once('end', () => {
        child.exitCode = code;
        child.emit('close', code, null);
      });
    });
  }
  return child;
}

test('Cline SDK metadata normalization keeps control types distinct and fails closed', () => {
  const models = normalizeClineSdkModels([
    { id: 'provider/mixed', name: 'Mixed', reasoningOptions: [
      { type: 'toggle' }, { type: 'effort', values: ['default', 'low', 'high', 'low'] },
    ] },
    { id: 'provider/toggle', name: 'Toggle', reasoningOptions: [{ type: 'toggle' }] },
    { id: 'provider/budget', name: 'Budget', reasoningOptions: [
      { type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 8192 },
    ] },
    { id: 'provider/none', name: 'No control', reasoningOptions: [] },
    { id: 'provider/missing', name: 'Missing' },
    { id: 'provider/new-value', name: 'New value', reasoningOptions: [
      { type: 'effort', values: ['low', 'unclassified'] },
    ] },
    { id: 'provider/new-control', name: 'New control', reasoningOptions: [{ type: 'adaptive' }] },
    { id: 'provider/bad-budget', name: 'Bad budget', reasoningOptions: [
      { type: 'budget_tokens', min: 'large' },
    ] },
  ]);
  const byId = Object.fromEntries(models.map(model => [model.id, model]));

  assert.deepEqual(byId['provider/mixed'], {
    id: 'provider/mixed', label: 'Mixed', reasoning_efforts: ['low', 'high'],
    reasoning_status: 'verified', reasoning_control: 'effort', reasoning_source: SDK_SOURCE,
  });
  assert.deepEqual(byId['provider/toggle'], {
    id: 'provider/toggle', label: 'Toggle', reasoning_efforts: [],
    reasoning_status: 'verified', reasoning_control: 'toggle', reasoning_source: SDK_SOURCE,
  });
  assert.equal(byId['provider/budget'].reasoning_control, 'budget');
  assert.deepEqual(byId['provider/budget'].reasoning_efforts, []);
  assert.equal(byId['provider/none'].reasoning_status, 'verified');
  assert.equal(byId['provider/none'].reasoning_control, 'none');
  assert.deepEqual(byId['provider/missing'], {
    id: 'provider/missing', label: 'Missing', reasoning_efforts: [],
    reasoning_status: 'unverified', reasoning_control: 'unknown', reasoning_source: SDK_SOURCE,
  });
  for (const id of ['provider/new-value', 'provider/new-control', 'provider/bad-budget']) {
    assert.deepEqual(byId[id].reasoning_efforts, [], `${id} must not expose guessed levels`);
    assert.equal(byId[id].reasoning_status, 'unverified');
    assert.equal(byId[id].reasoning_control, 'unknown');
  }
});

test('duplicate Cline SDK ids lose their reasoning grade', () => {
  const models = normalizeClineSdkModels([
    { id: 'provider/ambiguous', name: 'Graded', reasoningOptions: [{ type: 'effort', values: ['high'] }] },
    { id: 'provider/ambiguous', name: '', reasoningOptions: [] },
  ]);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], {
    id: 'provider/ambiguous', label: 'provider/ambiguous', reasoning_efforts: [],
    reasoning_status: 'unverified', reasoning_control: 'unknown', reasoning_source: SDK_SOURCE,
  });
});

test('queryClineSdkCatalog launches a credential-free child and projects only model metadata', async t => {
  const fixture = clineFixture(t);
  const secret = 'do-not-forward-this-test-secret';
  const callerFetch = globalThis.fetch;
  let launchArgs, launchOptions, childCwd;
  const sdkOutput = JSON.stringify({ models: [
    {
      id: 'cline-free/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash',
      reasoning_efforts: ['low', 'high', 'max'], reasoning_status: 'verified',
      reasoning_control: 'effort', apiKey: secret,
    },
    {
      id: 'provider/toggle', label: 'Toggle model', reasoning_efforts: [],
      reasoning_status: 'verified', reasoning_control: 'toggle',
    },
  ], privateRawCatalog: secret });

  const result = await queryClineSdkCatalog({
    binary: fixture.binary,
    provider: 'cline-pass',
    env: {
      PATH: '/usr/bin', HOME: '/tmp/test-home', LANG: 'C.UTF-8',
      CLINE_API_KEY: secret, CLINE_SETTINGS_PATH: '/private/cline-settings.json',
      HTTPS_PROXY: 'http://proxy.invalid', AF_EXECUTOR_ENV_TEST_SECRET: secret,
      NODE_OPTIONS: '--require /tmp/untrusted-preload.cjs', SystemRoot: '/windows',
    },
    launch(command, args, options) {
      launchArgs = [command, ...args];
      launchOptions = options;
      childCwd = options.cwd;
      return fakeChild({ output: sdkOutput });
    },
  });

  assert.equal(globalThis.fetch, callerFetch, 'the server process fetch must remain untouched');
  assert.ok(result);
  assert.equal(result.provider, 'cline-pass');
  assert.equal(result.model_source, SDK_SOURCE);
  assert.equal(result.client_version, '3.0.68');
  assert.equal(result.sdk_version, '0.0.90');
  assert.deepEqual(result.models.map(({ id, reasoning_control, reasoning_efforts }) => ({ id, reasoning_control, reasoning_efforts })), [
    { id: 'cline-free/deepseek-v4.1-flash', reasoning_control: 'effort', reasoning_efforts: ['low', 'high', 'max'] },
    { id: 'provider/toggle', reasoning_control: 'toggle', reasoning_efforts: [] },
  ]);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('privateRawCatalog'), false);
  assert.equal(launchArgs[0], process.execPath);
  assert.ok(launchArgs.includes(fixture.sdkEntry));
  assert.equal(launchArgs.at(-1), 'cline-pass');
  const script = launchArgs[launchArgs.indexOf('-e') + 1];
  assert.match(script, /globalThis\.fetch = async/);
  assert.match(script, /JSON\.stringify\(\{ models \}\)/);
  assert.doesNotMatch(script, /JSON\.stringify\(catalog\)/);
  assert.equal(launchOptions.env.PATH, '/usr/bin');
  assert.equal(launchOptions.env.HOME, '/tmp/test-home');
  for (const key of ['CLINE_API_KEY', 'CLINE_SETTINGS_PATH', 'HTTPS_PROXY', 'AF_EXECUTOR_ENV_TEST_SECRET', 'NODE_OPTIONS']) {
    assert.equal(Object.hasOwn(launchOptions.env, key), false, `${key} must not enter the child`);
  }
  assert.equal(launchOptions.env.SystemRoot, '/windows');
  assert.equal(existsSync(childCwd), false, 'the isolated temporary working directory is removed');
});

test('queryClineSdkCatalog treats duplicate child records as unknown', async t => {
  const fixture = clineFixture(t);
  const output = JSON.stringify({ models: [
    { id: 'provider/duplicate', label: 'First', reasoning_efforts: ['high'], reasoning_status: 'verified', reasoning_control: 'effort' },
    { id: 'provider/duplicate', label: 'Second', reasoning_efforts: 'malformed', reasoning_status: 'verified', reasoning_control: 'none' },
  ] });
  const result = await queryClineSdkCatalog({
    binary: fixture.binary, provider: 'cline-pass', env: {},
    launch: () => fakeChild({ output }),
  });
  assert.equal(result.models.length, 1);
  assert.deepEqual(result.models[0], {
    id: 'provider/duplicate', label: 'provider/duplicate', reasoning_efforts: [],
    reasoning_status: 'unverified', reasoning_control: 'unknown', reasoning_source: SDK_SOURCE,
  });
});

test('queryClineSdkCatalog returns unavailable for missing packages and timed-out children', async t => {
  const fixture = clineFixture(t);
  assert.equal(await queryClineSdkCatalog({ binary: join(fixture.root, 'missing-cline'), provider: 'cline-pass' }), null);

  let childCwd;
  const result = await queryClineSdkCatalog({
    binary: fixture.binary, provider: 'cline-pass', env: {}, timeoutMs: 100,
    launch(_command, _args, options) {
      childCwd = options.cwd;
      return fakeChild({ hang: true });
    },
  });
  assert.equal(result, null);
  assert.equal(existsSync(childCwd), false, 'the temporary working directory is removed after timeout');
});
