// Read-only model metadata. Never copy provider credentials or probe a paid model.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CODEX_CONFIG_PATH, CLAUDE_SETTINGS_PATH, CLINE_SETTINGS_PATH } from '../config.mjs';

const LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const EXECUTOR_LEVELS = {
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high'],
  cline: ['none', 'low', 'medium', 'high', 'xhigh'],
  'command-code': ['low', 'medium', 'high'],
};
const clean = value => typeof value === 'string' && value.trim().length <= 160 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
const levels = values => Array.isArray(values) ? [...new Set(values.map(v => typeof v === 'object' ? v?.effort : v).filter(v => LEVELS.has(v)))] : [];
function readJSON(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function readTOML(file, key) {
  try { return clean(readFileSync(file, 'utf8').split(/^\s*\[/m)[0].match(new RegExp('^' + key + '\\s*=\\s*["\']([^"\']+)["\']', 'm'))?.[1]); }
  catch { return null; }
}
export function agentOptions(id, { adapters = {}, definition = {}, paths = {} } = {}) {
  const codexConfig = paths.codexConfig ?? CODEX_CONFIG_PATH;
  const reasoning_efforts = levels(definition.reasoning_efforts ?? adapters[id]?.reasoningEfforts ?? EXECUTOR_LEVELS[id]);
  let default_model = null, default_effort = null, model_source = 'executor configuration', models = [];
  if (id === 'codex') {
    default_model = readTOML(codexConfig, 'model'); default_effort = readTOML(codexConfig, 'model_reasoning_effort');
    const cache = readJSON(paths.codexModels ?? join(dirname(codexConfig), 'models_cache.json'));
    models = (Array.isArray(cache?.models) ? cache.models : []).filter(m => m.visibility === 'list').map(m => ({
      id: clean(m.slug), label: clean(m.display_name) ?? clean(m.slug), reasoning_efforts: levels(m.supported_reasoning_levels),
    }));
    model_source = 'Codex local model catalog';
  } else if (id === 'claude') {
    default_model = clean(readJSON(paths.claudeSettings ?? CLAUDE_SETTINGS_PATH)?.model);
  } else if (id === 'cline') {
    const data = readJSON(paths.clineSettings ?? CLINE_SETTINGS_PATH);
    const settings = data?.providers?.[data?.lastUsedProvider ?? 'cline']?.settings;
    default_model = clean(settings?.model);
    default_effort = settings?.reasoning?.enabled ? clean(settings.reasoning.effort) : null;
    // -m changes the model, not the active provider/account.
    models = default_model ? [{ id: default_model, label: default_model, reasoning_efforts }] : [];
    model_source = 'Cline configured provider models';
  }
  // Optional metadata belongs to the canonical executor registry, not a second registry.
  if (Array.isArray(definition.model_options)) {
    models = definition.model_options.map(m => typeof m === 'string'
      ? { id: clean(m), label: clean(m), reasoning_efforts }
      : { id: clean(m?.id), label: clean(m?.label) ?? clean(m?.id), reasoning_efforts: levels(m?.reasoning_efforts ?? reasoning_efforts) });
    model_source = 'executor registry model options';
  }
  default_model = clean(definition.default_model) ?? default_model;
  default_effort = clean(definition.default_effort) ?? default_effort;
  if (default_model && !models.some(m => m.id === default_model)) models.unshift({ id: default_model, label: default_model, reasoning_efforts });
  models = [...new Map(models.filter(m => m.id && !m.id.startsWith('-')).map(m => [m.id, m])).values()].slice(0, 100);
  return { supports_effort: reasoning_efforts.length > 0, reasoning_efforts, models, default_model,
    default_effort: LEVELS.has(default_effort) ? default_effort : null, model_source };
}
export function effortOptions(id, model, { adapters = {}, catalog = [] } = {}) {
  const entry = catalog.find(e => (e.executor_type ?? e.id) === id) ?? agentOptions(id, { adapters });
  const selected = entry.models?.find(m => m.id === (model ?? entry.default_model));
  return selected?.reasoning_efforts ?? entry.reasoning_efforts ?? agentOptions(id, { adapters }).reasoning_efforts;
}
