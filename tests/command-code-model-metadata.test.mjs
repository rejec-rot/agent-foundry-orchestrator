import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { queryCommandCodeModelMetadata } from '../lib/team/command-code-model-metadata.mjs';

function sourceFixture() {
  return String.raw`
const shortLevels=["low","max"], inheritedLevels=["medium","xhigh"];
const aliases={"legacy-model":"canonical-model"};
const fallback=new Map([["fallback-model",inheritedLevels],["dated-model-20250101",["high"]],["canonical-model",["max"]],["getter-model",["low"]],["ambiguous-model-20250101",["high"]],["ambiguous-model-20260101",["low"]]]);
const known=new Set(["explicit-model","fallback-model","none-model","dated-model-20250101","canonical-model","family-bool-model","getter-model","malformed-model","ambiguous-model-20250101","ambiguous-model-20260101"]);
const dateSuffix=/[-@]\d{8}$/;
function findKnownById(e){for(const t of known)if(t.toLowerCase()===e)return t}
function tryResolveCanonical(e){return findKnownById((aliases[e.toLowerCase()]??e).toLowerCase())}
function canonicalizeModelId(e){const{model:t}=e;if(!t)return t;const n=tryResolveCanonical(t);if(n)return n;const o=t.replace(dateSuffix,"");return o===t?t:tryResolveCanonical(o)??t}
function getSupportedEfforts(e){const t=canonicalizeModelId({model:"string"==typeof e?e:e.model});return fallback.get(t)??null}
;
const catalog={
  explicit:{id:"explicit-model",reasoningEfforts:["low","max"]},
  fallback:{id:"fallback-model"},
  none:{id:"none-model"},
  dated:{id:"dated-model-20250101"},
  alias:{id:"legacy-model"},
  familyBoolean:{id:"family-bool-model",reasoning:true},
  getter:{id:"getter-model",get reasoningEfforts(){return ["high"]}},
  malformed:{id:"malformed-model",reasoningEfforts:readEfforts()},
  ambiguousOld:{id:"ambiguous-model-20250101"},
  ambiguousNew:{id:"ambiguous-model-20260101"}
};
function getAllModelOptions(){return Object.values(catalog)}
function getModelGroupsInOrder(){return groupModelsByDisplayOrder(getAllModelOptions().filter(e=>!e.hidden))}
function buildModelGroups(e){const t=Object.values(catalog).filter(e=>!e.hidden),n=[];for(const o of Object.values(providers)){if(!( "co"===e?o.visibleInCoMode:"command-code"===o.id))continue;const r=t.filter(e=>laneSupportsModel(o.supportedModelProviders,e));r.length>0&&n.push({providerId:o.id,label:o.label,models:r})}return n}
var co=buildModelGroups("co"),normal=buildModelGroups("normal");
function buildModelPickerGroups(e){const t=e.normalModeGroups.flatMap(e=>e.models);return t}
function buildCatalogModelPickerGroups(){return[...buildModelPickerGroups({normalModeGroups:normal}),...buildCustomModelPickerGroups()]}
function usePicker(){const n=useCustomModelsReady(),o=mt(()=>buildCatalogModelPickerGroups(),[n]);return o}
function displayModelId(e){return e.replace(dateSuffix,"").toLowerCase()}
function formatModelListText(e){return e.groups.flatMap(e=>e.models.map(e=>displayModelId(e.id))).join(" ")}
function formatModelList(e={}){return formatModelListText({groups:[...getModelGroupsInOrder(),...customModelListGroups()]})}
function Picker(t){const n=t.model.reasoningEfforts??getSupportedEfforts(t.model.id);if(!c&&n&&n.length>0)return K(t),void V("effort");const e=z.model.reasoningEfforts??getSupportedEfforts(z.model.id)??[];return it.createElement(Y_,{modelLabel:z.model.label,supportedEfforts:e})}
`;
}

function makeInstalledPackage(t, { version = '1.73.0', source = sourceFixture(), name = 'command-code' } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'command-code-metadata-'));
  const root = join(temp, 'node_modules', 'command-code'), dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version, main: 'dist/cli.mjs', bin: { 'command-code': 'dist/index.mjs' } }));
  writeFileSync(join(dist, 'index.mjs'), '#!/usr/bin/env node\n// fixture entrypoint; helper must never execute this file\n');
  writeFileSync(join(dist, 'cli.mjs'), source);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return join(dist, 'index.mjs');
}

test('reads only native picker arrays and Map values; BYOK extras stay individually unknown', t => {
  const binary = makeInstalledPackage(t);
  const ids = ['explicit-model', 'fallback-model', 'none-model', 'dated-model', 'legacy-model', 'family-bool-model',
    'getter-model', 'malformed-model', 'ambiguous-model', 'custom/provider-model'];
  const result = queryCommandCodeModelMetadata({ binary, models: ids.map(id => ({ id, label: id })) });
  assert.ok(Array.isArray(result));
  const byId = new Map(result.map(model => [model.id, model]));
  assert.deepEqual(byId.get('explicit-model').reasoning_efforts, ['low', 'max']);
  assert.equal(byId.get('explicit-model').reasoning_control, 'effort');
  assert.deepEqual(byId.get('fallback-model').reasoning_efforts, ['medium', 'xhigh']);
  assert.deepEqual(byId.get('dated-model').reasoning_efforts, ['high']);
  assert.deepEqual(byId.get('legacy-model').reasoning_efforts, ['max']);
  for (const id of ['none-model', 'family-bool-model']) {
    assert.equal(byId.get(id).reasoning_status, 'verified');
    assert.deepEqual(byId.get(id).reasoning_efforts, []);
    assert.equal(byId.get(id).reasoning_control, 'none');
  }
  for (const id of ['getter-model', 'malformed-model', 'ambiguous-model', 'custom/provider-model']) {
    assert.equal(byId.get(id).reasoning_status, 'unverified');
    assert.equal(byId.get(id).reasoning_control, 'unknown');
    assert.deepEqual(byId.get(id).reasoning_efforts, []);
  }
});

test('fails closed on an unsupported package version or package identity', t => {
  const newer = makeInstalledPackage(t, { version: '1.74.0' });
  assert.equal(queryCommandCodeModelMetadata({ binary: newer, models: [{ id: 'explicit-model' }] }), null);
  const wrongName = makeInstalledPackage(t, { name: 'command-code-fork' });
  assert.equal(queryCommandCodeModelMetadata({ binary: wrongName, models: [{ id: 'explicit-model' }] }), null);
});

test('fails closed when picker default syntax no longer matches the validated picker', t => {
  const changed = sourceFixture().replace('z.model.reasoningEfforts??getSupportedEfforts(z.model.id)??[]', 'z.model.reasoningEfforts??[]');
  const binary = makeInstalledPackage(t, { source: changed });
  assert.equal(queryCommandCodeModelMetadata({ binary, models: [{ id: 'explicit-model' }] }), null);
});

test('rejects malformed model input without invoking accessors', t => {
  const binary = makeInstalledPackage(t);
  let touched = false;
  const model = Object.defineProperty({}, 'id', { get() { touched = true; return 'explicit-model'; } });
  assert.equal(queryCommandCodeModelMetadata({ binary, models: [model] }), null);
  assert.equal(touched, false);
});

test('fails closed for out-of-bounds model lists', t => {
  const binary = makeInstalledPackage(t);
  assert.equal(queryCommandCodeModelMetadata({ binary, models: Array.from({ length: 1001 }, (_, i) => ({ id: `m-${i}` })) }), null);
});
