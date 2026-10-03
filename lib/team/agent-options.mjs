// Read-only model metadata. Never copy provider credentials or probe a paid model.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CODEX_CONFIG_PATH, CLAUDE_SETTINGS_PATH, CLINE_SETTINGS_PATH, COMMAND_CODE_CONFIG_PATH } from '../config.mjs';
import { normalizeClineSdkModels } from './cline-sdk-catalog.mjs';

const LEVELS = new Set(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CONTROLS = new Set(['effort', 'toggle', 'budget', 'none', 'unknown']);
// A CLI accepting a flag does not prove that a particular model accepts it.
// Native discovery is a short-lived projection, never an executor registry.
const discovered = new Map();
export function setDiscoveredModels(id, options) { discovered.set(id, structuredClone(options)); }
const clean = value => typeof value === 'string' && value.trim().length <= 160 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
const levels = values => Array.isArray(values) ? [...new Set(values.map(v => typeof v === 'object' ? v?.effort : v).filter(v => LEVELS.has(v)))] : [];
function readJSON(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function readTOML(file, key) {
  try { return clean(readFileSync(file, 'utf8').split(/^\s*\[/m)[0].match(new RegExp('^' + key + '\\s*=\\s*["\']([^"\']+)["\']', 'm'))?.[1]); }
  catch { return null; }
}
export function reasoningSummary(models = []) {
  const listed = models.filter(m => !m.configured_only);
  return {
    verified_models: listed.filter(m => m.reasoning_status === 'verified').length,
    adjustable_models: listed.filter(m => m.reasoning_status === 'verified' && m.reasoning_efforts?.length).length,
    unverified_models: listed.filter(m => m.reasoning_status !== 'verified').length,
  };
}
export function agentOptions(id, { adapters = {}, definition = {}, paths = {}, discovery = discovered.get(id) } = {}) {
  const codexConfig = paths.codexConfig ?? CODEX_CONFIG_PATH;
  let default_model = null, default_effort = null, model_source = 'executor configuration', models = [], activeProvider = null;
  if (id === 'codex') {
    default_model = readTOML(codexConfig, 'model'); default_effort = readTOML(codexConfig, 'model_reasoning_effort');
    const cache = readJSON(paths.codexModels ?? join(dirname(codexConfig), 'models_cache.json'));
    models = (Array.isArray(cache?.models) ? cache.models : []).filter(m => m.visibility === 'list').map(m => ({
      id: clean(m.slug), label: clean(m.display_name) ?? clean(m.slug), reasoning_efforts: levels(m.supported_reasoning_levels),
      reasoning_status:Array.isArray(m.supported_reasoning_levels)?'verified':'unverified',
    }));
    model_source = 'Codex local model catalog';
  } else if (id === 'claude') {
    default_model = clean(readJSON(paths.claudeSettings ?? CLAUDE_SETTINGS_PATH)?.model);
  } else if (id === 'cline') {
    const data = readJSON(paths.clineSettings ?? CLINE_SETTINGS_PATH);
    const provider = data?.lastUsedProvider ?? 'cline';
    activeProvider = provider;
    const settings = data?.providers?.[provider]?.settings;
    default_model = clean(settings?.model);
    default_effort = settings?.reasoning?.enabled ? clean(settings.reasoning.effort) : null;
    // -m changes the model, not the active provider/account.
    const cached = readJSON(paths.clineModels ?? join(dirname(paths.clineSettings ?? CLINE_SETTINGS_PATH), 'models.json'));
    const known = cached?.providers?.[provider]?.models ?? data?.providers?.[provider]?.knownModels ?? {};
    models = normalizeClineSdkModels(known);
    model_source = 'Cline configured provider models';
  } else if (id === 'command-code') {
    const configFile=paths.commandCodeConfig??COMMAND_CODE_CONFIG_PATH;
    const config=readJSON(configFile)??{},settings=readJSON(paths.commandCodeSettings??join(dirname(configFile),'settings.json'))??{};
    default_model=clean(settings.model)??clean(config.model);
    default_effort=clean(settings.reasoningEffort?.[default_model])??clean(config.reasoningEffort?.[default_model])??clean(settings.effort)??clean(config.effort);
    const providers=readJSON(paths.commandCodeProviders??join(dirname(configFile),'providers.json'))?.provider??{};
    // BYOK ids are provider-qualified; never copy credentials, endpoints or headers.
    models=Object.entries(providers).filter(([,p])=>p&&p.disabled!==true&&p.enabled!==false).flatMap(([provider,p])=>
      Object.entries(p.models??{}).map(([model,m])=>({id:clean(provider+'/'+model),label:clean(m?.name)??clean(provider+'/'+model),
        reasoning_efforts:levels(m?.reasoningEfforts),reasoning_status:Array.isArray(m?.reasoningEfforts)?'verified':'unverified'})));
    model_source='Command Code user configuration';
  }
  if(id==='cline'&&discovery&&discovery.provider!==activeProvider)discovery={...discovery,status:'unavailable',models:[],reason:'Cline provider changed or is unconfirmed; rescan required'};
  models=models.map(m=>({...m,reasoning_source:model_source}));
  if (discovery?.models) {
    const local=models;
    models=discovery.models.map(m=>{const cached=local.find(c=>c.id===m.id);return m.reasoning_status==='unverified'&&cached?.reasoning_status==='verified'?{...m,reasoning_efforts:cached.reasoning_efforts,reasoning_status:'verified',reasoning_control:cached.reasoning_control,reasoning_source:cached.reasoning_source}:{...m,reasoning_source:m.reasoning_source??discovery.model_source};});
    model_source=discovery.model_source;
  }
  default_model=default_model??clean(discovery?.default_model);
  default_effort=default_effort??clean(discovery?.default_effort);
  if(discovery?.status==='unavailable')models=models.map(m=>({...m,reasoning_efforts:[],reasoning_status:'unverified'}));
  // Optional, model-specific metadata belongs to the canonical executor registry.
  if (Array.isArray(definition.model_options)) {
    const registered = definition.model_options.map(m => typeof m === 'string'
      ? { id: clean(m), label: clean(m), reasoning_efforts:[], reasoning_status:'unverified' }
      : { id: clean(m?.id), label: clean(m?.label) ?? clean(m?.id), reasoning_efforts: levels(m?.reasoning_efforts),
        reasoning_status:Array.isArray(m?.reasoning_efforts)?'verified':'unverified',reasoning_source:'executor registry model metadata' });
    // A live catalog controls which provider models are listed. Registry options
    // may annotate matching entries, but must not resurrect unavailable models.
    models=discovery?.models?models.map(m=>{const r=registered.find(r=>r.id===m.id);return m.reasoning_status==='unverified'&&r?.reasoning_status==='verified'?{...m,...r}:m;}):registered;
    model_source = discovery?.models?discovery.model_source+' + registry model metadata':'executor registry model options';
  }
  default_model = clean(definition.default_model) ?? default_model;
  default_effort = clean(definition.default_effort) ?? default_effort;
  if (default_model && !models.some(m => m.id === default_model)) models.unshift({ id: default_model, label: default_model, reasoning_efforts:[], reasoning_status:'unverified', configured_only:true });
  models = [...new Map(models.map(m=>{
    const verified=(!discovery||discovery.status==='ready')&&m.reasoning_status==='verified'&&Array.isArray(m.reasoning_efforts);
    const efforts=verified?levels(m.reasoning_efforts):[];
    return {id:clean(m.id),label:clean(m.label)??clean(m.id),reasoning_efforts:efforts,reasoning_status:verified?'verified':'unverified',
      reasoning_control:verified?(CONTROLS.has(m.reasoning_control)?m.reasoning_control:efforts.length?'effort':'none'):'unknown',
      reasoning_source:clean(m.reasoning_source)??model_source,
      ...(verified&&efforts.includes(m.default_effort)?{default_effort:m.default_effort}:{}),...(m.configured_only===true?{configured_only:true}:{})};
  }).filter(m => m.id && !m.id.startsWith('-')).map(m => [m.id,m])).values()].slice(0, 1000);
  if(id==='cline')for(const m of models){
    if(m.reasoning_efforts.length&&!(discovery?.status==='ready'&&discovery.provider===activeProvider&&discovery.client_reasoning_efforts?.length)){m.reasoning_efforts=[];m.reasoning_status='unverified';m.reasoning_control='unknown';delete m.default_effort;}
    else m.reasoning_efforts=m.reasoning_efforts.filter(e=>discovery?.client_reasoning_efforts?.includes(e));
  }
  // These are the client's wire values, not permission for any individual model.
  if(id==='command-code')for(const m of models)m.reasoning_efforts=m.reasoning_efforts.filter(e=>['low','medium','high','xhigh','max'].includes(e));
  const reasoning_efforts=levels(models.flatMap(m=>m.reasoning_efforts));
  const selected=models.find(m=>m.id===default_model),verified_default=selected?.reasoning_efforts.includes(default_effort);
  return { supports_effort: reasoning_efforts.length > 0, reasoning_efforts, models, default_model,reasoning_summary:reasoningSummary(models),
    default_effort:verified_default?default_effort:null, default_effort_status:default_effort?(verified_default?'verified':'unverified'):'default', model_source,
    ...(discovery?{discovery_status:clean(discovery.status)??'unavailable',discovered_at:clean(discovery.checked_at),client_version:clean(discovery.client_version),provider:discovery.provider??null,
      ...(typeof discovery.reason==='string'?{discovery_reason:clean(discovery.reason)}:{})}:{}) };
}
export function effortOptions(id, model, { adapters = {}, catalog = [] } = {}) {
  const entry = catalog.find(e => (e.executor_type ?? e.id) === id) ?? agentOptions(id, { adapters });
  const selected = entry.models?.find(m => m.id === (model ?? entry.default_model));
  // Missing model metadata is not permission to use another model's levels.
  return selected?.reasoning_status==='verified'?selected.reasoning_efforts??[]:[];
}
