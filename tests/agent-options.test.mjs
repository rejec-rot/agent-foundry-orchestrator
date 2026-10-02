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
      {slug:'bad\nmodel',visibility:'list'},
    ]}));
    const options=agentOptions('codex',{paths});
    assert.equal(options.default_model,'visible-model');assert.equal(options.default_effort,'high');
    assert.deepEqual(options.models,[{id:'visible-model',label:'Visible model',reasoning_efforts:['low','high']}]);
    const catalog=[{id:'codex',...options}];
    assert.deepEqual(agentProfile({executor_type:'codex',model:'visible-model',effort:'high'},{catalog}),{executor_type:'codex',model:'visible-model',effort:'high'});
    assert.throws(()=>agentProfile({executor_type:'codex',model:'visible-model',effort:'max'},{catalog}),/does not support reasoning effort/);
    assert.throws(()=>agentProfile({executor_type:'codex',effort:'max'},{catalog}),/does not support reasoning effort/);
    writeFileSync(paths.clineSettings,JSON.stringify({lastUsedProvider:'active',providers:{active:{apiKey:'never-expose-this',settings:{model:'provider/model',reasoning:{enabled:true,effort:'xhigh'},apiKey:'never-expose-this'}},other:{settings:{model:'second/model'}}}}));
    const cline=agentOptions('cline',{paths});assert.equal(cline.default_model,'provider/model');assert.equal(cline.default_effort,'xhigh');
    assert.equal(cline.models.length,1);assert.ok(!JSON.stringify(cline).includes('second/model'),'models from a different provider are not executable with a model-only override');assert.ok(!JSON.stringify([options,cline]).includes('never-expose-this'));assert.ok(!JSON.stringify(options).includes('private-account'));
  } finally {rmSync(root,{recursive:true,force:true});}
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
