import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {queryNativeCatalog} from '../lib/team/native-catalog.mjs';
import {agentOptions} from '../lib/team/agent-options.mjs';
import {spawnManaged} from '../lib/child-process.mjs';
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'af-catalog-test-')),script=join(root,'client.mjs'),log=join(root,'methods.jsonl'),settings=join(root,'providers.json');
  writeFileSync(settings,JSON.stringify({lastUsedProvider:'active',providers:{active:{settings:{auth:{accessToken:'never-expose-this'}}}}}));
  writeFileSync(script,`import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
    if(process.argv.includes('--help')){console.log('--thinking <level> Set reasoning effort: none|low|medium|high');process.exit(0);}
    const send=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
    const options=(provider)=>[{id:'provider',currentValue:provider},{id:'model',options:[{value:provider+'/model',name:'Provider model'}]}];
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(process.env.CATALOG_LOG,JSON.stringify(m)+'\\n');
      if(process.env.CATALOG_HANG==='1')return;
      if(m.method==='initialize')return send(m.id,{userAgent:'agent_foundry_catalog/1.2.3 (test)',agentInfo:{version:'1.2.3'}});
      if(m.method==='initialized')return;
      if(m.method==='model/list')return send(m.id,{data:[m.params.cursor?{model:'non-reasoning',hidden:false,supportedReasoningEfforts:[]}:{model:'verified-model',displayName:'Verified',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'high',private_key:'never-expose-this'}],nextCursor:m.params.cursor?null:'page-2'});
      if(m.method==='session/new')return send(m.id,{sessionId:'metadata-only',models:{availableModels:[{modelId:'wrong-provider/model'}]},configOptions:options('wrong-provider')});
      if(m.method==='session/set_config_option')return send(m.id,{configOptions:options(m.params.value)});
      console.log(JSON.stringify({id:m.id,error:{code:-1,message:'never-expose-this'}}));
    });setInterval(()=>{},1000);`);
  return {root,log,env:{...process.env,CATALOG_LOG:log,CLINE_SETTINGS_PATH:settings},launch:(bin,args,options)=>spawnManaged(process.execPath,[script,...args],options),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('native Codex discovery paginates exact model/effort metadata and never starts a turn',async()=>{
  const fx=fixture();try{
    const result=await queryNativeCatalog('codex',fx);
    assert.equal(result.client_version,'1.2.3');assert.deepEqual(result.models[0].reasoning_efforts,['low','high']);
    assert.deepEqual(result.models[1].reasoning_efforts,[]);assert.doesNotMatch(JSON.stringify(result),/never-expose-this/);
    const methods=readFileSync(fx.log,'utf8').trim().split('\n').map(s=>JSON.parse(s).method);
    assert.deepEqual(methods,['initialize','initialized','model/list','model/list']);
  }finally{fx.cleanup();}
});
test('Cline catalog binds the configured provider and intersects model grades with the installed CLI',async()=>{
  const fx=fixture();try{
    const result=await queryNativeCatalog('cline',fx);assert.equal(result.provider,'active');assert.equal(result.models[0].id,'active/model');
    assert.equal(result.models[0].reasoning_status,'unverified','model names alone must not invent reasoning levels');
    const options=agentOptions('cline',{discovery:result,paths:{clineSettings:join(fx.root,'providers.json')},definition:{model_options:[{id:'active/model',reasoning_efforts:['low','high','xhigh','max']}]}});
    assert.deepEqual(options.models[0].reasoning_efforts,['low','high'],'client and model must both accept a grade');
    const methods=readFileSync(fx.log,'utf8').trim().split('\n').map(s=>JSON.parse(s).method);
    assert.deepEqual(methods,['initialize','session/new','session/set_config_option']);
    assert.doesNotMatch(JSON.stringify(result),/never-expose-this/);
  }finally{fx.cleanup();}
});
test('a stalled catalog client is bounded, terminated and reports no raw client output',async()=>{
  const fx=fixture();try{const start=Date.now();await assert.rejects(queryNativeCatalog('codex',{...fx,timeoutMs:200,env:{...fx.env,CATALOG_HANG:'1'}}),/CATALOG_TIMEOUT/);assert.ok(Date.now()-start<2000);}finally{fx.cleanup();}
});
test('unsupported clients never launch a process',async()=>{let calls=0;assert.equal(await queryNativeCatalog('unknown',{launch:()=>{calls++;}}),null);assert.equal(calls,0);});
