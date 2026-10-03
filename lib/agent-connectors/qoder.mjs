import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentBinary } from '../agent-discovery.mjs';
import { spawnManaged, signalTree } from '../child-process.mjs';
import { executorEnv } from '../executor-env.mjs';
import { randomUUID } from 'node:crypto';

const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 1000;
const TOKEN_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,159}$/;
const SESSION_VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const INLINE_SETTINGS = JSON.stringify({ general: { enableAutoUpdate: false } });
const AUTH_REQUIRED = /\b(?:auth(?:entication|orization)? required|unauthori[sz]ed|not logged in|please log ?in|sign in required)\b/i;

function fixedUnavailable(reason = 'Qoder model catalog is unavailable.', clientVersion = null) {
  return {
    status: 'unavailable',
    checked_at: new Date().toISOString(),
    provider: null,
    models: [],
    client_reasoning_efforts: null,
    model_source: 'Qoder native --list-models',
    client_version: clientVersion,
    reason,
  };
}

function parseModelList(output) {
  const plain = String(output ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (!plain || Buffer.byteLength(plain, 'utf8') > MAX_CATALOG_BYTES) return null;
  const lines = plain.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== 'MODEL') return null;
  const ids = lines.slice(1);
  if (!ids.length || ids.length > MAX_MODELS || ids.some(id => !TOKEN_VALUE.test(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return ids.map(id => ({
    id,
    label: id,
    reasoning_efforts: [],
    reasoning_status: 'unverified',
  }));
}

function installedVersion(binary) {
  let current;
  try { current = realpathSync(binary); } catch { current = binary; }
  let dir = current;
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      if (statSync(dir).isFile()) dir = join(dir, '..');
    } catch { /* the following bounded metadata reads simply fail */ }
    for (const filename of ['version.txt', 'package.json']) {
      const file = join(dir, filename);
      try {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > 256 * 1024) continue;
        const data = readFileSync(file, 'utf8').trim();
        let candidate = data;
        if (filename === 'package.json') {
          const pkg = JSON.parse(data);
          if (!['@qoder-ai/qodercli', '@qoder-ai/qoder-cli', 'qodercli'].includes(pkg.name)) continue;
          candidate = pkg.version;
        }
        const match = typeof candidate === 'string' && candidate.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
        if (match) return match[1];
      } catch { /* absent or non-metadata file */ }
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function unavailableReason(output) {
  const text = String(output ?? '');
  if (AUTH_REQUIRED.test(text)) {
    return 'Qoder model listing requires an authenticated local CLI session.';
  }
  return 'Qoder could not list available models.';
}

/**
 * Read Qoder's own model list. This invokes only --list-models, disables
 * automatic updates through an inline, process-local setting, and never sends
 * a prompt or stdin. stderr is retained only long enough to classify a fixed
 * public error reason. The metadata child receives only Qoder's own approved
 * environment; credentials for sibling executors are withheld.
 */
export async function queryQoderCatalog({ env = process.env, timeoutMs = 8000, launch = spawnManaged } = {}) {
  const bin = resolveAgentBinary('qoder', { env });
  if (!bin) return fixedUnavailable('Qoder CLI executable was not found.');
  const clientVersion = installedVersion(bin);

  const cwd = mkdtempSync(join(tmpdir(), 'af-qoder-catalog-'));
  const safeEnv = { ...executorEnv('qoder', env), NO_COLOR: '1', FORCE_COLOR: '0' };
  const timeout = Number.isFinite(timeoutMs) ? Math.min(15000, Math.max(250, timeoutMs)) : 8000;
  const args = ['--settings', INLINE_SETTINGS, '--list-models'];

  try {
    const output = await new Promise((resolve, reject) => {
      let child;
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let failure = null;
      let killTimer = null;
      let settleTimer = null;
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(settleTimer);
        error ? reject(error) : resolve(value);
      };
      const abort = code => {
        if (failure) return;
        failure = code;
        signalTree(child, 'SIGTERM');
        killTimer = setTimeout(() => {
          signalTree(child, 'SIGKILL');
          settleTimer = setTimeout(() => finish(new Error(failure)), 1000);
        }, 500);
      };
      timer = setTimeout(() => abort('CATALOG_TIMEOUT'), timeout);
      try {
        child = launch(bin, args, {
          cwd,
          env: safeEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        finish(new Error('CLIENT_UNAVAILABLE'));
        return;
      }
      if (!child || typeof child.once !== 'function') {
        finish(new Error('CLIENT_UNAVAILABLE'));
        return;
      }
      child.stdout?.on('data', chunk => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > MAX_CATALOG_BYTES) abort('CATALOG_TOO_LARGE');
        else stdout += chunk.toString();
      });
      child.stderr?.on('data', chunk => {
        if (stderr.length < 32 * 1024) stderr += chunk.toString().slice(0, 32 * 1024 - stderr.length);
      });
      child.once('error', () => finish(new Error(failure ?? 'CLIENT_UNAVAILABLE')));
      child.once('close', code => {
        if (failure) {
          finish(new Error(failure));
        } else if (code === 0) {
          finish(null, { stdout, stderr });
        } else {
          finish(Object.assign(new Error('CATALOG_UNAVAILABLE'), { catalogOutput: `${stdout}\n${stderr}` }));
        }
      });
    });

    const models = parseModelList(output.stdout);
    if (!models) return fixedUnavailable(AUTH_REQUIRED.test(`${output.stdout}\n${output.stderr}`)
      ? 'Qoder model listing requires an authenticated local CLI session.'
      : 'Qoder returned an unsupported model catalog format.', clientVersion);
    return {
      status: 'ready',
      checked_at: new Date().toISOString(),
      provider: null,
      models,
      client_reasoning_efforts: null,
      model_source: 'Qoder native --list-models',
      client_version: clientVersion,
    };
  } catch (error) {
    return fixedUnavailable(unavailableReason(error?.catalogOutput ?? ''), clientVersion);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function requireText(value, field, maxBytes = 128 * 1024) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`QODER_INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function optionalToken(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !TOKEN_VALUE.test(value)) throw new Error(`QODER_INVALID_${field.toUpperCase()}`);
  return value;
}

/** Build only the verified local CLI surface; no shell command string is used. */
export function buildQoderInvocation(capsule, { binary, sessionRef = null, systemPrompt, configDir = null } = {}) {
  if (typeof binary !== 'string' || !binary || binary.includes('\0')) throw new Error('QODER_INVALID_BINARY');
  const prompt = requireText(capsule?.prompt, 'prompt');
  const model = optionalToken(capsule.model, 'model');
  const effort = optionalToken(capsule.effort ?? capsule.reasoning_effort, 'effort');
  if (effort && Array.isArray(capsule.supported_reasoning_efforts)
      && !capsule.supported_reasoning_efforts.includes(effort)) {
    throw new Error('QODER_UNSUPPORTED_REASONING_EFFORT');
  }
  const exactSession = sessionRef == null || sessionRef === '' ? null : sessionRef;
  if (exactSession !== null && (typeof exactSession !== 'string' || !SESSION_VALUE.test(exactSession))) {
    throw new Error('QODER_INVALID_SESSION_REF');
  }
  const system = systemPrompt == null || systemPrompt === '' ? null : requireText(systemPrompt, 'system_prompt');

  const args = [];
  const freshSession=exactSession?null:randomUUID();
  if (exactSession) args.push('--resume', exactSession);
  else args.push('--session-id',freshSession);
  args.push('--print', '--output-format', 'json', '--settings', INLINE_SETTINGS);
  if (configDir != null) args.push('--config-dir', requireText(configDir, 'config_dir', 4096));
  args.push('--permission-mode', capsule.acceptEdits === true ? 'accept_edits' : 'default');
  if (model) args.push('--model', model);
  // The local CLI supports this flag. Per-model accepted levels are not exposed
  // by --list-models; the adapter must verify a model-specific level before
  // invoking this builder. Never translate it into another client's wire value.
  if (effort) args.push('--reasoning-effort', effort);
  if (system) args.push('--append-system-prompt', system);
  args.push('--strict-mcp-config');
  if (Array.isArray(capsule.tools)) {
    const tools = capsule.tools.map(tool => {
      if (typeof tool !== 'string' || !TOKEN_VALUE.test(tool)) throw new Error('QODER_INVALID_TOOLS');
      return tool;
    });
    args.push('--tools', ...(tools.length ? tools : ['']), '--');
  } else {
    // This terminator keeps leading dashes and option-like text in the prompt
    // from being reinterpreted as Qoder CLI flags.
    args.push('--', prompt);
  }
  if (Array.isArray(capsule.tools)) args.push(prompt);

  return {
    argv: [binary, ...args],
    expectedSession:exactSession??freshSession,
  };
}

function cleanSession(value) {
  return typeof value === 'string' && SESSION_VALUE.test(value) ? value : null;
}

/** Parse Qoder's single-result JSON envelope using a small field whitelist. */
export function parseQoderOutput(stdout, { expectedSession = null } = {}) {
  const raw = String(stdout ?? '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_OUTPUT_BYTES) {
    return { text: '', sessionRef: null, structured: null, error: 'QODER_OUTPUT_TOO_LARGE' };
  }

  let envelope;
  try {
    envelope = JSON.parse(raw.trim());
  } catch {
    return { text: '', sessionRef: null, structured: null, error: 'QODER_INVALID_JSON_OUTPUT' };
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.type !== 'result') {
    return { text: '', sessionRef: null, structured: null, error: 'QODER_UNSUPPORTED_OUTPUT_ENVELOPE' };
  }

  const sessionRef = cleanSession(envelope.session_id ?? envelope.sessionId ?? envelope.metadata?.session_id ?? null);
  const text = typeof envelope.result === 'string' ? envelope.result : '';
  const structured = {
    result: text,
    type: 'result',
    ...(typeof envelope.subtype === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(envelope.subtype)
      ? { subtype: envelope.subtype }
      : {}),
    ...(typeof envelope.is_error === 'boolean' ? { is_error: envelope.is_error } : {}),
    ...(Number.isInteger(envelope.error_code) ? { error_code: envelope.error_code } : {}),
  };

  if (expectedSession != null && sessionRef !== expectedSession) {
    return { text, sessionRef, structured, error: 'QODER_SESSION_MISMATCH' };
  }
  if (typeof envelope.is_error !== 'boolean' || typeof envelope.subtype !== 'string') {
    return { text, sessionRef, structured, error: 'QODER_INCOMPLETE_RESULT_ENVELOPE' };
  }
  if (envelope.is_error || envelope.subtype !== 'success' || typeof envelope.result !== 'string') {
    return { text, sessionRef, structured, error: 'QODER_RESULT_ERROR' };
  }
  return { text, sessionRef, structured };
}

export const qoderConnector = Object.freeze({
  protocol: 'native-cli',
  queryCatalog: queryQoderCatalog,
  buildInvocation: buildQoderInvocation,
  parseOutput: parseQoderOutput,
});
