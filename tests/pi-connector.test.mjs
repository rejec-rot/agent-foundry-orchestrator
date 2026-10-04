import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { spawnManaged } from '../lib/child-process.mjs';
import {
  buildPiInvocation,
  normalizePiModels,
  parsePiOutput,
  queryPiCatalog,
} from '../lib/agent-connectors/pi.mjs';

test('Pi refuses ambiguous full model identities instead of choosing the last reasoning record', () => {
  const model = { id: 'shared', provider: 'sample', reasoning: true };
  const getSupportedThinkingLevels = metadata => metadata.api === 'responses' ? ['low'] : ['high'];
  assert.throws(() => normalizePiModels([
    { ...model, api: 'responses' }, { ...model, api: 'chat' },
  ], { getSupportedThinkingLevels }), /CATALOG_UNAVAILABLE/);
  assert.throws(() => normalizePiModels([model, model]), /CATALOG_UNAVAILABLE/);
  const distinct = normalizePiModels([
    { ...model, api: 'responses' }, { ...model, provider: 'other', api: 'chat' },
  ], { getSupportedThinkingLevels });
  assert.deepEqual(distinct.map(m => [m.id, m.reasoning_efforts]), [
    ['sample/shared', ['low']], ['other/shared', ['high']],
  ]);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-pi-connector-'));
  const script = join(root, 'pi-rpc-fixture.mjs');
  const log = join(root, 'rpc-records.jsonl');
  writeFileSync(script, `
    import { appendFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const send = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
    createInterface({ input: process.stdin }).on('line', (line) => {
      appendFileSync(process.env.PI_FIXTURE_LOG, line + '\\n');
      if (process.env.PI_FIXTURE_HANG === '1') return;
      const request = JSON.parse(line);
      if (request.type !== 'get_available_models') {
        send({ id: request.id, type: 'response', command: request.type, success: false, error: 'unexpected request' });
        return;
      }
      const secret = 'never-expose-this';
      send({ id: request.id, type: 'response', command: request.type, success: true, data: { models: [
        { id: 'reasoning-model', provider: 'sample', name: 'Reasoning model', api: 'responses', reasoning: true, thinkingLevelMap: { high: 'high', xhigh: null }, baseUrl: secret, apiKey: secret, headers: { Authorization: secret } },
        { id: 'plain-model', provider: 'sample', name: 'Plain model', api: 'chat', reasoning: false, baseUrl: secret },
        { id: 'unknown-model', provider: 'vendor', name: 'Unknown model', api: 'chat', baseUrl: secret },
      ] } });
    });
    process.stdin.on('end', () => process.exit(0));
  `, 'utf8');
  chmodSync(script, 0o755);
  return { root, script, log, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function fixtureLauncher(fx, observed) {
  return (binary, args, options) => {
    observed.binary = binary;
    observed.args = args;
    observed.cwd = options.cwd;
    observed.env = options.env;
    return spawnManaged(process.execPath, [fx.script], {
      ...options,
      env: { ...options.env, PI_FIXTURE_LOG: fx.log },
    });
  };
}

test('Pi catalog uses one offline metadata RPC, isolates cwd/resources, and exposes only allowlisted models', async () => {
  const fx = fixture();
  const observed = {};
  const helperInputs = [];
  try {
    const result = await queryPiCatalog({
      binary: '/fixture/pi',
      env: { HOME: fx.root, PATH: '/usr/bin', EXAMPLE_API_KEY: 'never-copy-this' },
      launch: fixtureLauncher(fx, observed),
      getSupportedThinkingLevels(model) {
        helperInputs.push(model);
        if (model.reasoning === false) return ['off'];
        return ['off', 'low', 'high', 'xhigh'];
      },
    });

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.models.map(({ id }) => id), [
      'sample/reasoning-model', 'sample/plain-model', 'vendor/unknown-model',
    ]);
    assert.deepEqual(result.models[0].reasoning_efforts, ['off', 'low', 'high', 'xhigh']);
    assert.equal(result.models[0].reasoning_status, 'verified');
    assert.deepEqual(result.models[1].reasoning_efforts, ['off']);
    assert.equal(result.models[1].reasoning_status, 'verified');
    assert.deepEqual(result.models[2].reasoning_efforts, []);
    assert.equal(result.models[2].reasoning_status, 'unverified');
    assert.ok(helperInputs.every((model) => !('apiKey' in model) && !('headers' in model) && !('baseUrl' in model)));
    assert.doesNotMatch(JSON.stringify(result), /never-expose-this|EXAMPLE_API_KEY/);

    assert.deepEqual(JSON.parse(readFileSync(fx.log, 'utf8').trim()), {
      id: 'agent-foundry-pi-catalog-1', type: 'get_available_models',
    });
    assert.deepEqual(observed.args, [
      '--mode', 'rpc', '--offline', '--no-session', '--no-extensions', '--no-skills',
      '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools',
    ]);
    assert.notEqual(observed.cwd, fx.root);
    assert.equal(observed.env.PI_OFFLINE, '1');
    assert.equal(observed.env.PI_CODING_AGENT_DIR, join(observed.cwd, '..', 'agent'));
    assert.equal(Object.hasOwn(observed.env, 'EXAMPLE_API_KEY'), false);
  } finally {
    fx.cleanup();
  }
});

test('Pi catalog timeout terminates its child and never leaks raw client errors', async () => {
  const fx = fixture();
  let child;
  try {
    await assert.rejects(queryPiCatalog({
      binary: '/fixture/pi',
      env: { HOME: fx.root, PATH: '/usr/bin' },
      timeoutMs: 100,
      launch: (binary, args, options) => {
        child = spawnManaged(process.execPath, [fx.script], {
          ...options,
          env: { ...options.env, PI_FIXTURE_LOG: fx.log, PI_FIXTURE_HANG: '1' },
        });
        return child;
      },
      getSupportedThinkingLevels: () => [],
    }), (error) => error.message === 'CATALOG_TIMEOUT');
    assert.ok(child, 'the metadata process was started');
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'the timed out child has exited');
  } finally {
    fx.cleanup();
  }
});

test('Pi metadata helper marks missing per-model capability fields unknown', () => {
  const models = normalizePiModels([
    { id: 'a', provider: 'one', reasoning: true, thinkingLevelMap: { high: 'high' }, apiKey: 'secret' },
    { id: 'b', provider: 'two', reasoning: true },
    { id: 'c', provider: 'three', reasoning: false },
  ], {
    getSupportedThinkingLevels(model) {
      assert.equal('apiKey' in model, false);
      return model.reasoning ? ['off', 'high'] : ['off'];
    },
  });
  assert.deepEqual(models.map(({ reasoning_efforts, reasoning_status }) => [reasoning_efforts, reasoning_status]), [
    [['off', 'high'], 'verified'], [['off', 'high'], 'verified'], [['off'], 'verified'],
  ]);
  const unknown = normalizePiModels([{ id: 'missing-flag', provider: 'four' }], {
    getSupportedThinkingLevels: () => ['high'],
  });
  assert.deepEqual(unknown[0].reasoning_efforts, []);
  assert.equal(unknown[0].reasoning_status, 'unverified');
});

test('Pi invocation pins provider, exact effort and a scratch session path', () => {
  const invocation = buildPiInvocation({
    prompt: 'Do the task',
    model: 'openrouter/anthropic/claude-3.7',
    effort: 'high',
    supported_reasoning_efforts: ['low', 'high'],
    session_dir: '/scratch/run-1',
    session_file: '/scratch/run-1/pi-run.jsonl',
  }, { binary: '/usr/local/bin/pi', systemPrompt: 'Canonical governance.' });
  const args = invocation.argv;
  assert.equal(args[0], '/usr/local/bin/pi');
  assert.equal(args[args.indexOf('--provider') + 1], 'openrouter');
  assert.equal(args[args.indexOf('--model') + 1], 'anthropic/claude-3.7');
  assert.equal(args[args.indexOf('--thinking') + 1], 'high');
  assert.equal(args[args.indexOf('--session') + 1], '/scratch/run-1/pi-run.jsonl');
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], 'Canonical governance.');
  assert.equal(invocation.stdin, 'Do the task');
  assert.equal(invocation.expectedSession, '/scratch/run-1/pi-run.jsonl');
  assert.equal(args.some((arg) => ['--continue', '--resume', '--latest'].includes(arg)), false);
});

test('Pi invocation resumes only the supplied scratch session and refuses unsupported parameters', () => {
  const resumed = buildPiInvocation({
    prompt: 'Continue', model: 'provider/model', session_dir: '/scratch/run-2',
    session_file: '/scratch/run-2/new.jsonl',
  }, { binary: '/usr/local/bin/pi', sessionRef: '/scratch/run-2/previous.jsonl' });
  assert.equal(resumed.argv[resumed.argv.indexOf('--session') + 1], '/scratch/run-2/previous.jsonl');
  assert.equal(resumed.expectedSession, '/scratch/run-2/previous.jsonl');
  assert.throws(() => buildPiInvocation({ prompt: 'task', model: 'provider/model', effort: 'high', supported_reasoning_efforts: [] }, { binary: 'pi' }), /PI_EFFORT_UNSUPPORTED/);
  assert.throws(() => buildPiInvocation({ prompt: 'task', model: 'provider/model', effort: 'none' }, { binary: 'pi' }), /PI_EFFORT_UNSUPPORTED/);
  assert.throws(() => buildPiInvocation({ prompt: 'task', model: 'bare-model' }, { binary: 'pi' }), /PI_MODEL_PROVIDER_REQUIRED/);
  assert.throws(() => buildPiInvocation({ prompt: 'task', model: 'provider/model', session_dir: '/scratch/run-2', session_file: '/tmp/outside.jsonl' }, { binary: 'pi' }), /PI_SESSION_OUTSIDE_SCRATCH/);
});

test('Pi JSON output extracts assistant text and keeps resume paths under control-plane input', () => {
  const output = [
    JSON.stringify({ type: 'session', id: 'pi-session-1', cwd: '/work' }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Result ' }, { type: 'text', text: 'text' }] } }),
  ].join('\n');
  const parsed = parsePiOutput(output, { expectedSession: '/scratch/run/pi.jsonl' });
  assert.equal(parsed.text, 'Result text');
  assert.equal(parsed.sessionRef, '/scratch/run/pi.jsonl');
  assert.deepEqual(parsed.structured, { result: 'Result text' });
  assert.equal(parsePiOutput(output, { expectedSession: 'expected-id' }).error, 'PI_SESSION_MISMATCH');
  assert.equal(parsePiOutput('not json', {}).error, 'PI_JSON_OUTPUT_INVALID');
});
