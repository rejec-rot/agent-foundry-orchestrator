// Read the installed Cline SDK's bundled model metadata without starting Cline,
// restoring account authentication, or sending a prompt. The small child is
// isolated from provider credentials and has fetch disabled before importing
// the SDK.
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { executorEnv } from '../executor-env.mjs';
import { spawnManaged, signalTree } from '../child-process.mjs';

const MODEL_SOURCE = 'installed Cline SDK provider metadata';
const MAX_MODELS = 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_FILE_BYTES = 256 * 1024;
const MAX_SDK_ENTRY_BYTES = 64 * 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,159}$/;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const CONTROLS = new Set(['effort', 'toggle', 'budget', 'none', 'unknown']);

const safeString = value => typeof value === 'string' && value.trim().length > 0
  && value.trim().length <= 160 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;

function readPackage(file) {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_METADATA_FILE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function sdkPackageAt(directory) {
  const packageFile = join(directory, 'package.json');
  const metadata = readPackage(packageFile);
  if (metadata?.name !== '@cline/llms') return null;

  const packageRoot = resolve(directory);
  const importPath = typeof metadata.exports?.['.'] === 'object'
    ? metadata.exports['.'].import
    : metadata.module ?? metadata.main;
  if (typeof importPath !== 'string' || !importPath || importPath.includes('\0')) return null;
  const entry = resolve(packageRoot, importPath);
  if (!entry.startsWith(packageRoot + sep)) return null;
  try {
    const realRoot = realpathSync(packageRoot), realEntry = realpathSync(entry), stat = statSync(realEntry);
    if (!realEntry.startsWith(realRoot + sep) || !stat.isFile() || stat.size > MAX_SDK_ENTRY_BYTES) return null;
    return { entry: realEntry, version: safeVersion(metadata.version) };
  } catch { return null; }
}

function safeVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : null;
}

function resolveClineSdk(binary) {
  if (typeof binary !== 'string' || !binary || binary.includes('\0')) return null;
  let current;
  try {
    current = realpathSync(binary);
    if (!statSync(current).isFile()) return null;
  } catch { return null; }

  let directory = dirname(current);
  for (let depth = 0; depth < 16; depth += 1) {
    const clinePackage = readPackage(join(directory, 'package.json'));
    if (clinePackage?.name === 'cline') {
      // Follow the normal Cline dependency layouts, including an SDK nested
      // under @cline/core when the package manager does not hoist dependencies.
      const candidates = [
        join(directory, 'node_modules', '@cline', 'core', 'node_modules', '@cline', 'llms'),
        join(directory, 'node_modules', '@cline', 'node_modules', '@cline', 'llms'),
        join(directory, 'node_modules', '@cline', 'llms'),
      ];
      for (const candidate of candidates) {
        const sdk = sdkPackageAt(candidate);
        if (sdk) return { ...sdk, clientVersion: safeVersion(clinePackage.version) };
      }
      return null;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * Project Cline ModelInfo records to the small per-model contract used by the
 * team UI. Accepts either an array of records or the SDK's id-keyed model map.
 * This is deliberately pure so configured-model caches can share the same
 * control classification without turning toggles or token budgets into grades.
 */
export function normalizeClineSdkModels(records) {
  const source = 'installed Cline SDK provider metadata';
  const allowedEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,159}$/;
  const text = value => typeof value === 'string' && value.trim().length > 0
    && value.trim().length <= 160 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
  const unknown = () => ({ reasoning_efforts: [], reasoning_status: 'unverified', reasoning_control: 'unknown' });
  const entries = Array.isArray(records)
    ? records.map(record => [record?.id, record])
    : records && typeof records === 'object' ? Object.entries(records) : [];
  if (entries.length > 1000) return [];

  const occurrences = new Map();
  for (const [key, model] of entries) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
    const rawId = typeof model.id === 'string' ? model.id : key;
    const id = text(rawId);
    if (id && idPattern.test(id)) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
  }

  const models = [], emitted = new Set();
  for (const [key, model] of entries) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
    const rawId = typeof model.id === 'string' ? model.id : key;
    const id = text(rawId);
    if (!id || !idPattern.test(id)) continue;

    // An SDK catalog with duplicate ids is ambiguous. Keep the id available
    // for native-name intersection, but discard every conflicting grade,
    // including when one of the duplicated records is malformed.
    if (occurrences.get(id) > 1) {
      if (emitted.has(id)) continue;
      emitted.add(id);
      models.push({ id, label: id, ...unknown(), reasoning_source: source });
      continue;
    }
    const label = text(model.name) ?? id;
    if (!label) continue;

    const options = model.reasoningOptions;
    let reasoning;
    if (!Array.isArray(options)) reasoning = unknown();
    else if (options.length === 0) reasoning = { reasoning_efforts: [], reasoning_status: 'verified', reasoning_control: 'none' };
    else {
      let hasEffort = false, hasToggle = false, hasBudget = false, invalid = false;
      const reasoning_efforts = [];
      for (const option of options) {
        if (!option || typeof option !== 'object' || Array.isArray(option) || typeof option.type !== 'string') {
          invalid = true;
          break;
        }
        if (option.type === 'toggle') {
          hasToggle = true;
          continue;
        }
        if (option.type === 'effort') {
          hasEffort = true;
          if (!Array.isArray(option.values)) { invalid = true; break; }
          for (const value of option.values) {
            // The SDK's explicit default sentinel is not a selectable effort.
            // Any other unknown value makes the whole model unverified.
            if (value === 'default') continue;
            if (typeof value !== 'string' || !allowedEfforts.has(value)) { invalid = true; break; }
            if (!reasoning_efforts.includes(value)) reasoning_efforts.push(value);
          }
          if (invalid) break;
          continue;
        }
        if (option.type === 'budget_tokens') {
          hasBudget = true;
          if (['min', 'max'].some(name => option[name] !== undefined
            && (typeof option[name] !== 'number' || !Number.isFinite(option[name])))) invalid = true;
          if (invalid) break;
          continue;
        }
        invalid = true;
        break;
      }
      if (invalid || (hasEffort && hasBudget)) reasoning = unknown();
      else {
        // Effort is the primary control when combined with a toggle. A budget
        // remains a distinct control and never becomes a categorical level.
        const reasoning_control = hasEffort ? 'effort' : hasBudget ? 'budget' : hasToggle ? 'toggle' : 'unknown';
        reasoning = {
          reasoning_efforts,
          reasoning_status: reasoning_control === 'unknown' ? 'unverified' : 'verified',
          reasoning_control,
        };
      }
    }
    emitted.add(id);
    models.push({ id, label, ...reasoning, reasoning_source: source });
  }
  return models;
}

function workerScript() {
  // Keep the child output to the fields needed by Agent Foundry. No raw SDK
  // model records, errors, auth data, or provider settings cross stdout.
  return `
globalThis.fetch = async () => { throw new Error('metadata fetch disabled'); };
const normalizeClineSdkModels = ${normalizeClineSdkModels.toString()};
try {
  const [sdkEntry, provider] = process.argv.slice(1);
  const sdk = await import((await import('node:url')).pathToFileURL(sdkEntry).href);
  if (typeof sdk.getModelsForProvider !== 'function') process.exit(2);
  const catalog = await sdk.getModelsForProvider(provider, { filter: 'chat' });
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || Object.keys(catalog).length > ${MAX_MODELS}) process.exit(3);
  const models = normalizeClineSdkModels(catalog);
  process.stdout.write(JSON.stringify({ models }));
} catch {
  process.exitCode = 1;
}
`;
}

function safeChildEnv(source) {
  // Start with the executor's allowlisted environment, then retain only the
  // non-secret runtime basics needed to launch a local Node metadata reader.
  const approved = executorEnv('cline', source);
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP'];
  const result = {};
  for (const key of keys) {
    const value = approved[key];
    if (typeof value === 'string' && value.length <= 8192 && !/[\x00]/.test(value)) result[key] = value;
  }
  for (const key of ['SystemRoot', 'WINDIR']) {
    const value = source?.[key];
    if (typeof value === 'string' && value.length <= 8192 && !/[\x00]/.test(value)) result[key] = value;
  }
  return result;
}

function validateChildModels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.models) || value.models.length > MAX_MODELS) return null;
  const occurrences = new Map();
  for (const candidate of value.models) {
    const id = safeString(candidate?.id);
    if (id && MODEL_ID.test(id)) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
  }

  const models = [], emitted = new Set();
  for (const candidate of value.models) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const id = safeString(candidate.id);
    if (!id || !MODEL_ID.test(id)) continue;
    if (occurrences.get(id) > 1) {
      if (!emitted.has(id)) models.push({
        id, label: id, reasoning_efforts: [], reasoning_status: 'unverified',
        reasoning_control: 'unknown', reasoning_source: MODEL_SOURCE,
      });
      emitted.add(id);
      continue;
    }
    const label = safeString(candidate.label);
    if (!label) continue;
    if (!Array.isArray(candidate.reasoning_efforts)
      || !candidate.reasoning_efforts.every(effort => typeof effort === 'string' && EFFORTS.has(effort))
      || !['verified', 'unverified'].includes(candidate.reasoning_status)
      || !CONTROLS.has(candidate.reasoning_control)) continue;

    let reasoning_status = candidate.reasoning_status;
    let reasoning_control = candidate.reasoning_control;
    let reasoning_efforts = [...new Set(candidate.reasoning_efforts)];
    if (reasoning_status !== 'verified' || reasoning_control === 'unknown') {
      reasoning_status = 'unverified';
      reasoning_control = 'unknown';
      reasoning_efforts = [];
    }
    if (reasoning_control !== 'effort' && reasoning_efforts.length) continue;
    emitted.add(id);
    models.push({ id, label, reasoning_efforts, reasoning_status, reasoning_control, reasoning_source: MODEL_SOURCE });
  }
  return models;
}

function childClosed(child) {
  return Boolean(child && (child.exitCode != null || child.signalCode != null));
}

function waitForClose(child, timeoutMs) {
  if (!child || childClosed(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let done = false;
    const finish = closed => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener?.('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
}

async function stopChild(child, closed) {
  if (!child || closed || childClosed(child) || typeof child.pid !== 'number') return;
  signalTree(child, 'SIGTERM');
  if (!await waitForClose(child, 300)) {
    signalTree(child, 'SIGKILL');
    await waitForClose(child, 500);
  }
}

/**
 * Read model-specific reasoning metadata from the installed Cline SDK catalog.
 * A missing SDK, unavailable export, malformed response, or failed child returns
 * null so the caller can retain its native model-name catalog as unverified.
 */
export async function queryClineSdkCatalog({ binary, provider, env = process.env, timeoutMs = 8000, launch = spawnManaged } = {}) {
  if (typeof provider !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(provider)) return null;
  const installation = resolveClineSdk(binary);
  if (!installation) return null;

  const timeout = Number.isFinite(timeoutMs) ? Math.min(15000, Math.max(100, Math.floor(timeoutMs))) : 8000;
  const cwd = mkdtempSync(join(tmpdir(), 'af-cline-sdk-catalog-'));
  let child, closed = false, stdout = '', bytes = 0, failure = null;
  try {
    const output = await new Promise(resolveOutput => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveOutput(value);
      };
      const kill = () => { if (child && typeof child.pid === 'number') signalTree(child, 'SIGKILL'); };
      let timer;
      try {
        child = launch(process.execPath, ['--input-type=module', '-e', workerScript(), installation.entry, provider], {
          cwd,
          env: safeChildEnv(env),
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        failure = 'spawn';
        finish(null);
        return;
      }
      if (!child?.stdout || typeof child.once !== 'function') {
        failure = 'child';
        kill();
        finish(null);
        return;
      }
      timer = setTimeout(() => {
        failure = 'timeout';
        kill();
        finish(null);
      }, timeout);
      child.once('error', () => { failure = 'child'; finish(null); });
      child.once('close', code => {
        closed = true;
        finish(failure || code !== 0 ? null : stdout);
      });
      child.stdout.on('data', chunk => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          failure = 'output_limit';
          kill();
          finish(null);
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.stdout.on('error', () => { failure = 'child'; finish(null); });
    });

    if (!output || failure) return null;
    let parsed;
    try { parsed = JSON.parse(output); } catch { return null; }
    const models = validateChildModels(parsed);
    if (!models?.length) return null;
    return {
      status: 'ready',
      checked_at: new Date().toISOString(),
      provider,
      models,
      model_source: MODEL_SOURCE,
      client_version: installation.clientVersion,
      sdk_version: installation.version,
    };
  } finally {
    await stopChild(child, closed);
    rmSync(cwd, { recursive: true, force: true });
  }
}
