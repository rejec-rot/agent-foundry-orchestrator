// executor-env.mjs - what an executor child process is allowed to see.
//
// The adapters used to hand every executor `{ ...process.env }`. Executors are
// the most capable and most injection-exposed processes in the system: they are
// LLM CLIs that run arbitrary tool commands, and one of them is explicitly
// expected to be adversarial with respect to another's output. Passing the whole
// environment meant a prompt-injected author could read every provider
// credential the operator had exported - including the keys of the executor
// that is supposed to review it.
//
// The acceptance command was already scrubbed to an allowlist (see
// acceptance.mjs); this is the same treatment for the object that needed it
// more. The rule is NOT "no credentials" - an executor needs its own auth - it
// is "only your own": a claude run gets the Anthropic key and never the OpenAI
// one, and vice versa.
//
// Policy, in order:
//   1. BASE_ENV      - a small set needed to run anything at all.
//   2. FOUNDRY_ENV   - control-plane plumbing the launcher scripts read
//                      (paths and flags; carries no secrets).
//   3. PER_EXECUTOR  - the launcher/config paths plus ONLY that executor's own
//                      provider credential and endpoint.
//   4. Never passed  - safety-critical control-plane state. An executor that can
//                      run `node orchestrator.mjs` must not inherit a pointer to
//                      the circuit-breaker state file, the runtime events log or
//                      an alternative acceptance allowlist: that would turn a
//                      shell in the workspace into a way to unban an executor or
//                      widen the command allowlist.
//   5. Opt-in        - AF_EXECUTOR_ENV_<NAME> passes <NAME> through explicitly,
//                      mirroring AF_ACCEPTANCE_ENV_<NAME>.
//
// @module executor-env

/** Environment needed to execute anything at all. */
const BASE_ENV = Object.freeze([
  'PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LANGUAGE', 'TZ',
  'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
]);

/**
 * Control-plane plumbing read by the launcher scripts and by the executor
 * CLIs' own config wiring. These are paths and flags - no credentials.
 */
const FOUNDRY_ENV = Object.freeze([
  'AGENT_FOUNDRY_GLOBAL',
  'AGENT_FOUNDRY_GLOBAL_AGENTS',
  'AGENT_FOUNDRY_GOVERNANCE_SHA256',
  'AF_EXECUTORS_DIR',
  'AF_GLOBAL_DIR',
  'AF_CANONICAL_AGENTS_MD',
  'AF_TASKS_DIR',
  'AF_VAULT_MCP_SERVER',
  'VAULT_MCP_SERVER',
  'AF_GATEWAY_DIR',
  'AF_GATEWAY_SERVER',
  'AF_EXTERNAL_ISOLATION_VERIFIED',
  'AF_REQUIRE_ISOLATION',
  'AF_CGROUP_BASE',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_PARAMETERS',
]);

/**
 * Test-instrumentation prefixes. Stub launchers record their argv and simulate
 * hangs through these; they are not part of the production surface.
 */
const PASSTHROUGH_PREFIXES = Object.freeze(['AF_STUB_', 'AF_HANG_']);

/**
 * Safety-critical state that must never reach an executor, whatever else is
 * allowlisted. Kept explicit so the intent survives future edits.
 */
const NEVER_PASSED = Object.freeze([
  'AF_SAFETY_STATE_FILE',
  'AF_RUNTIME_EVENTS_LOG',
  'AF_ACCEPTANCE_ALLOWLIST',
]);

/**
 * Per-executor launcher paths and its OWN provider credential / endpoint.
 * A missing sibling credential here is the whole point of this module.
 */
const PER_EXECUTOR_ENV = Object.freeze({
  claude: Object.freeze([
    'CLAUDE_LAUNCHER', 'CLAUDE_SETTINGS_PATH',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  ]),
  codex: Object.freeze([
    'CODEX_CONFIG_PATH',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT',
  ]),
  cline: Object.freeze([
    'CLINE_LAUNCHER', 'CLINE_SETTINGS_PATH', 'CLINE_API_KEY',
  ]),
  qoder: Object.freeze(['QODER_BIN','QODER_PERSONAL_ACCESS_TOKEN','QODER_CONFIG_DIR']),
  pi: Object.freeze(['PI_BIN','PI_CODING_AGENT_DIR','PI_OFFLINE']),
  'vertex-gemini': Object.freeze([
    'VERTEX_LAUNCHER', 'VERTEX_GEMINI_LAUNCHER',
    'VERTEX_API_KEY', 'VERTEX_AI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
  ]),
  antigravity: Object.freeze([
    'AGY_BIN', 'AGY_LAUNCHER', 'AGY_MODEL', 'AGY_API_KEY',
    'DBUS_SESSION_BUS_ADDRESS',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  ]),
});

/** Every credential var this module knows about, for auditing and tests. */
export const KNOWN_CREDENTIAL_ENV = Object.freeze(
  Object.entries(PER_EXECUTOR_ENV).reduce((acc, [, keys]) => {
    for (const key of keys) {
      if (/_API_KEY$|_AUTH_TOKEN$|_API_KEY$|APPLICATION_CREDENTIALS$/.test(key)) acc.add(key);
    }
    return acc;
  }, new Set())
);

export const EXECUTOR_ENV_POLICY = Object.freeze({
  base: BASE_ENV,
  foundry: FOUNDRY_ENV,
  perExecutor: PER_EXECUTOR_ENV,
  neverPassed: NEVER_PASSED,
  passthroughPrefixes: PASSTHROUGH_PREFIXES,
});

/**
 * Build the environment for one executor child process.
 *
 * @param {string|null} executorType - claude | codex | cline | vertex-gemini | antigravity.
 * @param {object} [source] - environment to read from (defaults to process.env).
 * @param {object} [extra] - extra NAME: value pairs the caller explicitly needs.
 * @returns {Record<string, string>} the scrubbed environment.
 */
export function executorEnv(executorType, source = process.env, extra = {}) {
  const allowed = new Set([...BASE_ENV, ...FOUNDRY_ENV, ...(PER_EXECUTOR_ENV[executorType] ?? [])]);
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (NEVER_PASSED.includes(key)) continue;
    if (allowed.has(key) || PASSTHROUGH_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  // Explicit opt-in passthrough, for anything a deployment genuinely needs.
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('AF_EXECUTOR_ENV_') || value === undefined) continue;
    const target = key.slice('AF_EXECUTOR_ENV_'.length);
    if (target && !NEVER_PASSED.includes(target)) env[target] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!NEVER_PASSED.includes(key)) env[key] = value;
  }
  return env;
}

/**
 * Broad heuristic used ONLY for auditing. Enforcement below is a strict
 * allowlist; this never decides what is passed, it only decides what an
 * operator inspecting the policy is told is being withheld - so it is
 * deliberately over-inclusive (an unrelated DATABASE_URL is as leakable as a
 * provider key).
 */
const SECRET_LIKE = /(SECRET|_API_KEY|_AUTH_TOKEN|_TOKEN|_PASSWORD|_CREDENTIALS?|_URL|_KEY$)/i;

/**
 * Which credential-like variables an executor is NOT given. Used by tests and by
 * startup diagnostics to make the isolation auditable.
 *
 * @param {string} executorType - the executor being launched.
 * @param {object} [source] - environment to inspect.
 * @returns {string[]} withheld credential-like variable names, sorted.
 */
export function withheldCredentialEnv(executorType, source = process.env) {
  const granted = new Set(PER_EXECUTOR_ENV[executorType] ?? []);
  const withheld = [];
  for (const key of Object.keys(source)) {
    if (!KNOWN_CREDENTIAL_ENV.has(key) && !SECRET_LIKE.test(key)) continue;
    if (!granted.has(key)) withheld.push(key);
  }
  return withheld.sort();
}
