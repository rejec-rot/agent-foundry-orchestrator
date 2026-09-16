// tests/executor-env.test.mjs - credential isolation for executor children
//
// The adapters used to launch every executor with `{ ...process.env }`, so an
// executor CLI - the most capable process in the system, and the one most
// exposed to prompt injection - inherited EVERY provider credential the
// operator had exported, including the keys of the executor meant to review it.
//
// The rule asserted here is not "no credentials" (an executor needs its own
// auth) but "only your own", plus: safety-critical control-plane state never
// reaches a child at all.
//
//   EE-1  a sibling's credential is withheld
//   EE-2  each executor keeps its own credential
//   EE-3  safety-critical state is never passed, not even via the opt-in
//   EE-4  base plumbing and launcher paths are preserved
//   EE-5  AF_EXECUTOR_ENV_<NAME> opt-in works for benign variables
//   EE-6  behaviourally: a spawned child really cannot read a sibling's key
//   EE-7  no adapter path may hand a child the whole environment
//   CAP-1 captured output is capped, and the cap is self-describing

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  executorEnv,
  withheldCredentialEnv,
  EXECUTOR_ENV_POLICY,
  KNOWN_CREDENTIAL_ENV,
} from '../lib/executor-env.mjs';
import { spawnManaged, signalTree, capCapture, CAPTURE_LIMIT_BYTES } from '../lib/child-process.mjs';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// A source environment holding one credential per executor, plus unrelated
// secrets and the safety-critical control-plane pointers.
const SOURCE = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/operator',
  LANG: 'en_US.UTF-8',
  ANTHROPIC_API_KEY: 'sk-ant-OWNED-BY-CLAUDE',
  OPENAI_API_KEY: 'sk-openai-OWNED-BY-CODEX',
  VERTEX_API_KEY: 'vertex-OWNED-BY-VERTEX',
  CLINE_API_KEY: 'cline-OWNED-BY-CLINE',
  AWS_SECRET_ACCESS_KEY: 'unrelated-cloud-secret',
  DATABASE_URL: 'postgres://user:pass@host/db',
  AF_SAFETY_STATE_FILE: '/tmp/attacker-chosen-safety-state.json',
  AF_RUNTIME_EVENTS_LOG: '/tmp/attacker-chosen-events.jsonl',
  AF_ACCEPTANCE_ALLOWLIST: '/tmp/permissive-allowlist.json',
  AF_EXECUTORS_DIR: '/srv/agent-foundry-global/executors',
  AF_CANONICAL_AGENTS_MD: '/srv/agent-foundry-global/AGENTS.md',
  AF_STUB_ARGV_LOG: '/tmp/stub-argv.log',
  AF_EXECUTOR_ENV_MY_DEPLOYMENT_FLAG: 'enabled',
  CLAUDE_SETTINGS_PATH: '/home/operator/.claude/settings.json',
  CODEX_CONFIG_PATH: '/home/operator/.codex/config.toml',
});

// ------------------------------------------------------------------ EE-1
test('EE-1: a sibling executor credential is withheld', () => {
  const claude = executorEnv('claude', SOURCE);
  assert.strictEqual(claude.ANTHROPIC_API_KEY, 'sk-ant-OWNED-BY-CLAUDE', 'its own key must be present');
  assert.strictEqual(claude.OPENAI_API_KEY, undefined, 'a claude run must not receive the OpenAI key');
  assert.strictEqual(claude.VERTEX_API_KEY, undefined, 'a claude run must not receive the Vertex key');
  assert.strictEqual(claude.CLINE_API_KEY, undefined, 'a claude run must not receive the Cline key');
  assert.strictEqual(claude.DATABASE_URL, undefined, 'unrelated secrets must not be inherited');
  assert.strictEqual(claude.AWS_SECRET_ACCESS_KEY, undefined, 'unrelated cloud secrets must not be inherited');
});

// ------------------------------------------------------------------ EE-2
test('EE-2: each executor keeps its own credential and only its own', () => {
  const own = {
    claude: 'ANTHROPIC_API_KEY',
    codex: 'OPENAI_API_KEY',
    'vertex-gemini': 'VERTEX_API_KEY',
    cline: 'CLINE_API_KEY',
  };
  for (const [executor, key] of Object.entries(own)) {
    const env = executorEnv(executor, SOURCE);
    assert.strictEqual(env[key], SOURCE[key], `${executor} must receive ${key}`);
    for (const [otherExecutor, otherKey] of Object.entries(own)) {
      if (otherExecutor === executor) continue;
      assert.strictEqual(env[otherKey], undefined, `${executor} must not receive ${otherKey} (${otherExecutor}'s)`);
    }
  }
});

// ------------------------------------------------------------------ EE-3
test('EE-3: safety-critical control-plane state is never passed to an executor', () => {
  for (const executor of Object.keys(EXECUTOR_ENV_POLICY.perExecutor)) {
    const env = executorEnv(executor, SOURCE);
    for (const forbidden of EXECUTOR_ENV_POLICY.neverPassed) {
      assert.strictEqual(env[forbidden], undefined, `${executor} must not receive ${forbidden}`);
    }
  }

  // The opt-in passthrough must not be a way to smuggle them back in: a
  // compromised workspace could otherwise point the breaker state file at a
  // fresh path and unban an executor.
  const smuggled = executorEnv('claude', {
    ...SOURCE,
    AF_EXECUTOR_ENV_AF_SAFETY_STATE_FILE: '/tmp/evil.json',
    AF_EXECUTOR_ENV_AF_ACCEPTANCE_ALLOWLIST: '/tmp/evil-allowlist.json',
  });
  assert.strictEqual(smuggled.AF_SAFETY_STATE_FILE, undefined, 'the opt-in must not bypass the never-passed list');
  assert.strictEqual(smuggled.AF_ACCEPTANCE_ALLOWLIST, undefined, 'the opt-in must not bypass the never-passed list');
});

// ------------------------------------------------------------------ EE-4
test('EE-4: base plumbing and launcher configuration are preserved', () => {
  const env = executorEnv('claude', SOURCE);
  for (const key of ['PATH', 'HOME', 'LANG']) {
    assert.strictEqual(env[key], SOURCE[key], `${key} must be preserved so the launcher can run`);
  }
  assert.strictEqual(env.CLAUDE_SETTINGS_PATH, SOURCE.CLAUDE_SETTINGS_PATH, 'its own config path must survive');
  assert.strictEqual(env.CODEX_CONFIG_PATH, undefined, "another executor's config path must not");
  assert.strictEqual(env.AF_EXECUTORS_DIR, SOURCE.AF_EXECUTORS_DIR, 'control-plane plumbing must survive');
  assert.strictEqual(env.AF_STUB_ARGV_LOG, SOURCE.AF_STUB_ARGV_LOG, 'test instrumentation must survive');
});

// ------------------------------------------------------------------ EE-5
test('EE-5: AF_EXECUTOR_ENV_<NAME> opt-in passes a benign variable through', () => {
  const env = executorEnv('codex', SOURCE);
  assert.strictEqual(env.MY_DEPLOYMENT_FLAG, 'enabled', 'an explicit opt-in must reach the child');
  assert.strictEqual(env.AF_EXECUTOR_ENV_MY_DEPLOYMENT_FLAG, undefined, 'the wrapper name itself is not exported');
});

// ------------------------------------------------------------------ EE-6
test('EE-6: a spawned executor child cannot read a sibling credential', { skip: process.platform === 'win32' }, async () => {
  const child = spawnManaged(process.execPath, [
    '-e',
    "process.stdout.write(JSON.stringify({ openai: process.env.OPENAI_API_KEY ?? null, db: process.env.DATABASE_URL ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null }));",
  ], { env: executorEnv('claude', SOURCE) });
  try {
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    await new Promise((resolve) => child.once('close', resolve));
    const seen = JSON.parse(out);
    assert.strictEqual(seen.anthropic, 'sk-ant-OWNED-BY-CLAUDE', 'its own key must be visible');
    assert.strictEqual(seen.openai, null, "a sibling's key must not be visible to the child process");
    assert.strictEqual(seen.db, null, 'unrelated secrets must not be visible to the child process');
  } finally {
    signalTree(child, 'SIGKILL');
  }
});

// ------------------------------------------------------------------ EE-7
test('EE-7: no adapter path hands a child the whole environment', () => {
  const source = readFileSync(join(ROOT_DIR, 'lib', 'adapters.mjs'), 'utf8');
  assert.ok(
    !/env:\s*\{\s*\.\.\.\s*process\.env\s*\}/.test(source),
    'adapters.mjs must build the child environment through executorEnv(), not spread process.env'
  );
  assert.ok(/executorEnv\(/.test(source), 'adapters.mjs must use executorEnv()');
});

// ------------------------------------------------------------------ CAP-1
test('CAP-1: captured output is capped and the truncation is self-describing', () => {
  let captured = '';
  const chunk = 'x'.repeat(4096);
  for (let i = 0; i < 100; i += 1) captured = capCapture(captured, chunk, 10_000);
  assert.ok(captured.length <= 10_000 + 64, 'the capture must stop at the cap');
  assert.match(captured, /output truncated at 10000 bytes/, 'the record must say it was truncated');

  // Once capped, further chunks are dropped rather than appended.
  const after = capCapture(captured, 'y'.repeat(4096), 10_000);
  assert.strictEqual(after, captured, 'a capped capture must not keep growing');

  assert.ok(CAPTURE_LIMIT_BYTES >= 1024 * 1024, 'the production cap must be generous enough for real payloads');
  assert.ok(KNOWN_CREDENTIAL_ENV.size > 0, 'the credential inventory must not be empty');
  // The audit must report both a sibling executor's key and unrelated secrets
  // (the connection string is as leakable as a provider key).
  assert.deepStrictEqual(
    withheldCredentialEnv('claude', SOURCE),
    ['AWS_SECRET_ACCESS_KEY', 'CLINE_API_KEY', 'DATABASE_URL', 'OPENAI_API_KEY', 'VERTEX_API_KEY'],
    'the withheld set must be auditable per executor'
  );
});
