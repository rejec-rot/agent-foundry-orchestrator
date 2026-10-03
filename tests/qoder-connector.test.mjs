import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  buildQoderInvocation,
  parseQoderOutput,
  qoderConnector,
  queryQoderCatalog,
} from '../lib/agent-connectors/qoder.mjs';

function fixtureLaunch({ output = '', stderr = '', code = 0 } = {}) {
  let call = null;
  const launch = (binary, args, options) => {
    call = { binary, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    queueMicrotask(() => {
      child.stdout.end(output);
      child.stderr.end(stderr);
      child.emit('close', code, null);
    });
    return child;
  };
  return { launch, getCall: () => call };
}

test('Qoder catalog parses native model IDs without inventing effort metadata', async () => {
  const fixture = fixtureLaunch({ output: 'MODEL\nQwen3.8-Max\nQwen3.8-Flash\n' });
  const catalog = await queryQoderCatalog({
    env: {
      ...process.env,
      QODER_BIN: process.execPath,
      QODER_PERSONAL_ACCESS_TOKEN: 'qoder-owned-auth-marker',
      ANTHROPIC_API_KEY: 'sibling-secret-marker',
    },
    timeoutMs: 1000,
    launch: fixture.launch,
  });

  assert.equal(catalog.status, 'ready');
  assert.equal(catalog.model_source, 'Qoder native --list-models');
  assert.deepEqual(catalog.models.map(model => model.id), ['Qwen3.8-Max', 'Qwen3.8-Flash']);
  assert.ok(catalog.models.every(model => model.reasoning_status === 'unverified' && model.reasoning_efforts.length === 0));
  const call = fixture.getCall();
  assert.deepEqual(call.args, ['--settings', '{"general":{"enableAutoUpdate":false}}', '--list-models']);
  assert.equal(call.options.stdio[0], 'ignore');
  assert.equal(call.options.stdio[2], 'pipe');
  assert.equal(call.options.env.QODER_PERSONAL_ACCESS_TOKEN, 'qoder-owned-auth-marker');
  assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
});

test('Qoder catalog gets its version from adjacent installation metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-metadata-fixture-'));
  try {
    const binary = join(dir, 'qodercli');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o755);
    writeFileSync(join(dir, 'version.txt'), '1.9.42\n');
    const fixture = fixtureLaunch({ output: 'MODEL\nQwen3.8-Max\n' });
    const catalog = await queryQoderCatalog({
      env: { ...process.env, QODER_BIN: binary },
      launch: fixture.launch,
    });
    assert.equal(catalog.client_version, '1.9.42');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Qoder catalog returns a fixed authentication reason without exposing CLI text', async () => {
  const fixture = fixtureLaunch({ stderr: 'Unauthorized account@example.invalid token=do-not-return', code: 1 });
  const catalog = await queryQoderCatalog({
    env: { ...process.env, QODER_BIN: process.execPath },
    launch: fixture.launch,
  });
  assert.equal(catalog.status, 'unavailable');
  assert.equal(catalog.reason, 'Qoder model listing requires an authenticated local CLI session.');
  assert.doesNotMatch(JSON.stringify(catalog), /account@example|do-not-return/);
});

test('Qoder catalog rejects an unknown or malformed native list', async () => {
  const fixture = fixtureLaunch({ output: 'AVAILABLE MODELS\nQwen3.8-Max\n' });
  const catalog = await queryQoderCatalog({
    env: { ...process.env, QODER_BIN: process.execPath },
    launch: fixture.launch,
  });
  assert.equal(catalog.status, 'unavailable');
  assert.equal(catalog.reason, 'Qoder returned an unsupported model catalog format.');
});

test('Qoder invocation uses the verified headless CLI and an explicit resume ID only', () => {
  const built = buildQoderInvocation({
    prompt: '--model injected\nDo the task',
    model: 'Qwen3.8-Max',
    effort: 'high',
    acceptEdits: true,
    tools: ['Read', 'Edit'],
  }, {
    binary: '/opt/qodercli',
    sessionRef: 'session_123-abc',
    systemPrompt: 'Follow repository instructions.',
    configDir: '/run/qoder-session-data',
  });

  assert.equal(built.argv[0], '/opt/qodercli');
  assert.deepEqual(built.argv.slice(1), [
    '--resume', 'session_123-abc',
    '--print', '--output-format', 'json', '--settings', '{"general":{"enableAutoUpdate":false}}',
    '--config-dir', '/run/qoder-session-data',
    '--permission-mode', 'accept_edits',
    '--model', 'Qwen3.8-Max', '--reasoning-effort', 'high',
    '--append-system-prompt', 'Follow repository instructions.',
    '--strict-mcp-config', '--tools', 'Read', 'Edit', '--', '--model injected\nDo the task',
  ]);
  assert.equal(built.expectedSession, 'session_123-abc');
});

test('Qoder refuses an effort not in the model-specific verified list', () => {
  assert.throws(() => buildQoderInvocation({
    prompt: 'task', model: 'Qwen3.8-Max', effort: 'high', supported_reasoning_efforts: ['low'],
  }, { binary: 'qodercli' }), /QODER_UNSUPPORTED_REASONING_EFFORT/);
});

test('Qoder invocation keeps a leading-dash prompt positional and never resumes latest implicitly', () => {
  const built = buildQoderInvocation({ prompt: '--continue and do not parse as an option' }, { binary: 'qodercli' });
  assert.equal(built.argv.at(-2), '--');
  assert.equal(built.argv.at(-1), '--continue and do not parse as an option');
  assert.equal(built.expectedSession,built.argv[built.argv.indexOf('--session-id')+1]);
  assert.match(built.expectedSession,/^[0-9a-f-]{36}$/);
  assert.equal(built.argv.includes('--resume'), false);
  assert.equal(built.argv.includes('--continue'), false);
});

test('Qoder result parser whitelists public result fields and checks the exact session', () => {
  const output = JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: 'session_123-abc',
    is_error: false,
    result: 'task complete',
    usage: { credits: 999 },
    apiKey: 'do-not-return',
  });
  const parsed = parseQoderOutput(output, { expectedSession: 'session_123-abc' });
  assert.deepEqual(parsed, {
    text: 'task complete',
    sessionRef: 'session_123-abc',
    structured: { result: 'task complete', type: 'result', subtype: 'success', is_error: false },
  });
  assert.doesNotMatch(JSON.stringify(parsed), /do-not-return|credits/);

  const mismatch = parseQoderOutput(output, { expectedSession: 'another-session' });
  assert.equal(mismatch.error, 'QODER_SESSION_MISMATCH');
});

test('Qoder result parser fails closed on unsupported and error envelopes', () => {
  assert.equal(parseQoderOutput('not json').error, 'QODER_INVALID_JSON_OUTPUT');
  assert.equal(parseQoderOutput(JSON.stringify({ type: 'system', session_id: 's' })).error, 'QODER_UNSUPPORTED_OUTPUT_ENVELOPE');
  assert.equal(parseQoderOutput(JSON.stringify({
    type: 'result', subtype: 'error_during_execution', session_id: 's', is_error: true, errors: ['secret details'],
  })).error, 'QODER_RESULT_ERROR');
  assert.equal(qoderConnector.protocol, 'native-cli');
});
