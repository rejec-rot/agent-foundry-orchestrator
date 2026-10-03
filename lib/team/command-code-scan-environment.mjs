// Run Command Code's metadata-only list command under a disposable home.
// Its startup path migrates user config and schedules IDE installation before
// parsing --list-models, so the real user home must never reach that process.
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_PROVIDER_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDERS = 256;
const MAX_MODELS = 2000;
const MAX_ID_LENGTH = 500;
const MAX_TEXT_LENGTH = 240;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, limit = MAX_TEXT_LENGTH) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
    && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

function safeId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    && value.trim() === value && !/[\s\x00-\x1f\x7f]/u.test(value) ? value : null;
}

function scratchRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd)) throw new TypeError('temporary Command Code cwd must be an absolute path');
  let root, temp;
  try {
    root = realpathSync(cwd);
    temp = realpathSync(tmpdir());
    if (!statSync(root).isDirectory()) throw new Error();
  } catch {
    throw new TypeError('temporary Command Code cwd must be an existing directory');
  }
  const fromTemp = relative(temp, root);
  if (!fromTemp || fromTemp === '..' || fromTemp.startsWith(`..${sep}`) || isAbsolute(fromTemp)) {
    throw new TypeError('temporary Command Code cwd must be inside the operating-system temp directory');
  }
  return root;
}

function readProviderConfig(sourceHome) {
  const home = safeText(sourceHome, 4096);
  if (!home) return null;
  const appDir = join(resolve(home), '.commandcode');
  const file = join(appDir, 'providers.json');
  try {
    const appStat = lstatSync(appDir);
    if (!appStat.isDirectory() || appStat.isSymbolicLink()) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROVIDER_CONFIG_BYTES) return null;
    const bytes = readFileSync(file);
    if (bytes.length > MAX_PROVIDER_CONFIG_BYTES) return null;
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!plainObject(parsed)) return null;
    // This mirrors the installed CLI's root selection (`provider ?? providers`).
    const providers = parsed.provider ?? parsed.providers;
    if (!plainObject(providers) || Object.keys(providers).length > MAX_PROVIDERS) return null;

    const projected = Object.create(null);
    let totalModels = 0;
    for (const [providerId, provider] of Object.entries(providers)) {
      if (!safeId(providerId) || !plainObject(provider)) continue;
      if (!plainObject(provider.models)) continue;
      const models = Object.create(null);
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (++totalModels > MAX_MODELS) return null;
        if (!safeId(modelId) || !plainObject(model)) continue;
        const output = Object.create(null);
        const name = safeText(model.name);
        if (name) output.name = name;
        if (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length <= EFFORTS.size
          && model.reasoningEfforts.every(value => typeof value === 'string' && EFFORTS.has(value))
          && new Set(model.reasoningEfforts).size === model.reasoningEfforts.length) {
          output.reasoningEfforts = [...model.reasoningEfforts];
        }
        models[modelId] = output;
      }
      if (!Object.keys(models).length) continue;
      const output = Object.create(null);
      const name = safeText(provider.name);
      if (name) output.name = name;
      if (typeof provider.disabled === 'boolean') output.disabled = provider.disabled;
      if (typeof provider.enabled === 'boolean') output.enabled = provider.enabled;
      // The local parser requires a baseURL. This inert URL keeps display/model
      // discovery intact without carrying the user's actual network endpoint.
      output.baseURL = 'https://catalog.invalid';
      // Explicit keyless mode prevents the parser from resolving any auth data.
      output.apiKey = false;
      output.models = models;
      projected[providerId] = output;
    }
    return Object.keys(projected).length ? { provider: projected } : null;
  } catch {
    return null;
  }
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/**
 * Prepare a child-only environment for `cmd --no-auto-update --list-models`.
 * The real installation home is read only for a bounded, credential-free
 * projection of BYOK provider/model IDs; all CLI writes land under `cwd`.
 * Returns the environment object directly for child_process.spawn.
 */
export function prepareCommandCodeScanEnvironment({ env = process.env, cwd } = {}) {
  const root = scratchRoot(cwd);
  const source = plainObject(env) ? env : {};
  const home = mkdtempSync(join(root, 'command-code-home-'));
  chmodSync(home, 0o700);
  const tmp = ensurePrivateDirectory(join(home, 'tmp'));
  const config = ensurePrivateDirectory(join(home, '.config'));
  const data = ensurePrivateDirectory(join(home, '.local', 'share'));
  const cache = ensurePrivateDirectory(join(home, '.cache'));
  const state = ensurePrivateDirectory(join(home, '.local', 'state'));
  const runtime = ensurePrivateDirectory(join(home, '.runtime'));

  const sourceHome = source.HOME ?? source.USERPROFILE ?? null;
  const safeProviders = readProviderConfig(sourceHome);
  if (safeProviders) {
    const appDir = ensurePrivateDirectory(join(home, '.commandcode'));
    writeFileSync(join(appDir, 'providers.json'), JSON.stringify(safeProviders), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }

  const result = Object.create(null);
  const copy = (key, limit = 8192) => {
    const value = source[key];
    if (typeof value === 'string' && value.length <= limit && !/[\x00]/.test(value)) result[key] = value;
  };
  copy('PATH');
  copy('LANG'); copy('LC_ALL'); copy('LANGUAGE'); copy('TZ'); copy('TERM');
  copy('NO_COLOR'); copy('FORCE_COLOR');
  // Windows process startup needs these host paths; they contain no auth data.
  copy('SystemRoot'); copy('WINDIR'); copy('ComSpec'); copy('COMSPEC'); copy('PATHEXT');
  result.HOME = home;
  result.USERPROFILE = home;
  result.XDG_CONFIG_HOME = config;
  result.XDG_DATA_HOME = data;
  result.XDG_CACHE_HOME = cache;
  result.XDG_STATE_HOME = state;
  result.XDG_RUNTIME_DIR = runtime;
  result.TMPDIR = tmp;
  result.TEMP = tmp;
  result.TMP = tmp;
  result.APPDATA = config;
  result.LOCALAPPDATA = data;
  // 1.73.0 checks CI before IDE detection/install. The caller also passes the
  // explicit --no-auto-update flag; neither behavior can reach the real profile.
  result.CI = '1';
  result.DO_NOT_TRACK = '1';
  result.NODE_ENV = 'production';
  return result;
}
