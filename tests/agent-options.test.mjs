import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentOptions } from '../lib/team/agent-options.mjs';
import { agentProfile, sameModelTeamReview } from '../lib/team/planner.mjs';

test('model catalogs expose supported levels and defaults without provider secrets or hidden models', () => {
  const root=mkdtempSync(join(tmpdir(),'af-model-options-'));
  try {
    const paths={codexConfig:join(root,'config.toml'),codexModels:join(root,'models_cache.json'),clineSettings:join(root,'providers.json')};
    writeFileSync(paths.codexConfig,'model = "visible-model"\nmodel_reasoning_effort = "high"\n[provider]\napi_key = "never-expose-this"\n');
    writeFileSync(paths.codexModels,JSON.stringify({identity:'private-account',models:[
      {slug:'visible-model',display_name:'Visible model',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]},
      {slug:'hidden-model',visibility:'hide',supported_reasoning_levels:[{effort:'max'}]},
      {slug:'missing-levels',visibility:'list'},
      {slug:'bad\nmodel',visibility:'list'},
    ]}));
    const options=agentOptions('codex',{paths});
    assert.equal(options.default_model,'visible-model');assert.equal(options.default_effort,'high');
    assert.equal(options.models.length,2);assert.equal(options.models[0].id,'visible-model');assert.deepEqual(options.models[0].reasoning_efforts,['low','high']);
    assert.equal(options.models[1].reasoning_status,'unverified');assert.deepEqual(options.models[1].reasoning_efforts,[]);
    const catalog=[{id:'codex',...options}];
    assert.deepEqual(agentProfile({executor_type:'codex',model:'visible-model',effort:'high'},{catalog}),{executor_type:'codex',model:'visible-model',effort:'high'});
    assert.throws(()=>agentProfile({executor_type:'codex',model:'visible-model',effort:'max'},{catalog}),/does not support reasoning effort/);
    assert.throws(()=>agentProfile({executor_type:'codex',effort:'max'},{catalog}),/does not support reasoning effort/);
    writeFileSync(paths.clineSettings,JSON.stringify({lastUsedProvider:'active',providers:{active:{apiKey:'never-expose-this',settings:{model:'provider/model',reasoning:{enabled:true,effort:'xhigh'},apiKey:'never-expose-this'}},other:{settings:{model:'second/model'}}}}));
    const cline=agentOptions('cline',{paths});assert.equal(cline.default_model,'provider/model');assert.equal(cline.default_effort,null);assert.equal(cline.default_effort_status,'unverified');
    assert.equal(cline.models.length,1);assert.ok(!JSON.stringify(cline).includes('second/model'),'models from a different provider are not executable with a model-only override');assert.ok(!JSON.stringify([options,cline]).includes('never-expose-this'));assert.ok(!JSON.stringify(options).includes('private-account'));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('unknown models never inherit another model or executor reasoning levels',()=>{
  const options=agentOptions('custom',{definition:{default_model:'known',reasoning_efforts:['low','high'],model_options:[{id:'known',reasoning_efforts:['high']},'unverified']}});
  const catalog=[{executor_type:'custom',...options}],adapters={custom:{supportsModel:true,reasoningEfforts:['low','high']}};
  for(const model of ['unknown','unverified'])assert.throws(()=>agentProfile({executor_type:'custom',model,effort:'high'},{catalog,adapters}),/does not support reasoning effort/);
  assert.equal(agentProfile({executor_type:'custom',model:'unknown',effort:null},{catalog,adapters}).model,'unknown');
  assert.equal(agentProfile({executor_type:'custom',model:'known',effort:'high'},{catalog,adapters}).effort,'high');
});

test('registry strings and unspecified model levels do not invent capabilities',()=>{
  const options=agentOptions('codex',{definition:{default_model:'unverified',default_effort:'ultra',reasoning_efforts:['ultra'],model_options:['unverified',{id:'missing-levels'}]}});
  assert.equal(options.supports_effort,false);assert.equal(options.default_effort,null);
  assert.ok(options.models.every(m=>m.reasoning_status==='unverified'&&m.reasoning_efforts.length===0));
});

test('native models retain exact per-model levels and registry cannot resurrect a missing provider model',()=>{
  const discovery={status:'ready',checked_at:'2026-10-02T00:00:00Z',model_source:'native client',client_version:'1.0',models:[{id:'available',label:'Available',reasoning_efforts:['low','high'],reasoning_status:'verified'}]};
  const options=agentOptions('custom',{discovery,definition:{model_options:[{id:'available',reasoning_efforts:['ultra']},{id:'another-provider',reasoning_efforts:['high']}]}});
  assert.equal(options.models.length,1);assert.deepEqual(options.models[0].reasoning_efforts,['low','high']);assert.equal(options.client_version,'1.0');
});

test('Cline toggle/budget controls do not masquerade as effort grades',()=>{
  const root=mkdtempSync(join(tmpdir(),'af-cline-models-'));
  try {
    const paths={clineSettings:join(root,'providers.json'),clineModels:join(root,'models.json')};
    writeFileSync(paths.clineSettings,JSON.stringify({lastUsedProvider:'active',providers:{active:{settings:{model:'graded'}}}}));
    writeFileSync(paths.clineModels,JSON.stringify({providers:{active:{models:{
      graded:{reasoningOptions:[{type:'effort',values:['low','high','default']}]},
      toggle:{reasoningOptions:[{type:'toggle'}]},budget:{reasoningOptions:[{type:'budget_tokens',min:1024,max:8192}]}
    }}}}));
    const options=agentOptions('cline',{paths,discovery:null}),catalog=[{id:'cline',...options}];
    assert.equal(agentProfile({executor_type:'cline',model:'graded',effort:'high'},{catalog}).effort,'high');
    for(const model of ['toggle','budget'])assert.throws(()=>agentProfile({executor_type:'cline',model,effort:'high'},{catalog}),/does not support reasoning effort/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Command Code reads the current model and exact BYOK grades without exposing provider secrets',()=>{
  const root=mkdtempSync(join(tmpdir(),'af-cmd-options-'));
  try {
    const paths={commandCodeConfig:join(root,'config.json'),commandCodeSettings:join(root,'settings.json'),commandCodeProviders:join(root,'providers.json')};
    writeFileSync(paths.commandCodeConfig,JSON.stringify({model:'vendor/previous',reasoningEffort:{'custom/vendor:model':'high'},private_key:'never-expose-this'}));
    writeFileSync(paths.commandCodeSettings,JSON.stringify({model:'custom/vendor:model'}));
    writeFileSync(paths.commandCodeProviders,JSON.stringify({provider:{custom:{baseURL:'https://private-endpoint.example',apiKey:'never-expose-this',headers:{authorization:'secret'},models:{'vendor:model':{name:'Private gateway model',reasoningEfforts:['low','high','ultra']},unverified:{reasoning:true}}},disabled:{disabled:true,models:{removed:{reasoningEfforts:['high']}}}}}));
    const discovery={status:'ready',model_source:'Command Code native --list-models',default_model:'vendor/default',models:[{id:'custom/vendor:model',reasoning_efforts:[],reasoning_status:'unverified'},{id:'custom/unverified',reasoning_efforts:[],reasoning_status:'unverified'},{id:'vendor/default',reasoning_efforts:[],reasoning_status:'unverified'}]};
    const options=agentOptions('command-code',{paths,discovery}),catalog=[{id:'command-code',...options}];
    assert.equal(options.default_model,'custom/vendor:model');assert.equal(options.default_effort,'high');
    assert.deepEqual(options.models[0].reasoning_efforts,['low','high']);
    assert.equal(agentProfile({executor_type:'command-code',effort:'high'},{catalog}).effort,'high');
    for(const model of ['custom/unverified','vendor/default'])assert.throws(()=>agentProfile({executor_type:'command-code',model,effort:'high'},{catalog}),/does not support reasoning effort/);
    assert.doesNotMatch(JSON.stringify(options),/never-expose-this|private-endpoint|authorization|disabled\/removed|vendor\/previous/);
    const fallback=agentOptions('command-code',{paths:{commandCodeConfig:join(root,'absent','config.json')},discovery});
    assert.equal(fallback.default_model,'vendor/default');assert.equal(fallback.supports_effort,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('unsupported reasoning controls reject overrides and registry metadata constrains known models', () => {
  assert.throws(()=>agentProfile({executor_type:'dsh',effort:'high'}),/does not support reasoning effort/);
  assert.throws(()=>agentProfile({executor_type:'cline',effort:'max'}),/does not support reasoning effort/);
  assert.throws(()=>agentProfile({executor_type:'codex',effort:'HIGH'}),/does not support reasoning effort/);
  const options=agentOptions('custom',{adapters:{custom:{reasoningEfforts:['low','high']}},definition:{model_options:[{id:'basic',reasoning_efforts:[]},{id:'deep',reasoning_efforts:['high']}]}});
  const controls={allowed:['custom'],adapters:{custom:{supportsModel:true}},catalog:[{executor_type:'custom',...options}]};
  assert.throws(()=>agentProfile({executor_type:'custom',model:'basic',effort:'low'},controls),/does not support reasoning effort/);
  assert.equal(agentProfile({executor_type:'custom',model:'deep',effort:'high'},controls).effort,'high');
  assert.equal(agentProfile({executor_type:'codex',effort:null}).effort,undefined,'omitted defaults preserve prior submission identity');
});

test('same-model review policy also binds the selected reasoning effort', () => {
  const task={team_binding:{team_id:'TEAM-a'},author_executor:'codex',reviewer_executor:'codex',author_model:'m',reviewer_model:'m',author_effort:'high',reviewer_effort:'high',team_review_policy:{mode:'planner-model-fresh-session',team_id:'TEAM-a',executor_type:'codex',model:'m',effort:'high'}};
  assert.equal(sameModelTeamReview(task),true);
  assert.equal(sameModelTeamReview({...task,reviewer_effort:'low'}),false);
});
