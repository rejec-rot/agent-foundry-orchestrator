import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,chmodSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {queryNativeCatalog,isClientInstalled} from '../lib/team/native-catalog.mjs';
import {agentOptions} from '../lib/team/agent-options.mjs';
import {spawnManaged} from '../lib/child-process.mjs';
function fixture({simulateStartup=false}={}) {
  const root=mkdtempSync(join(tmpdir(),'af-catalog-test-')),script=join(root,'client.mjs'),log=join(root,'methods.jsonl'),settings=join(root,'providers.json');
  writeFileSync(settings,JSON.stringify({lastUsedProvider:'active',providers:{active:{settings:{auth:{accessToken:'never-expose-this'}}}}}));
  writeFileSync(script,`#!${process.execPath}\nimport {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {createInterface} from 'node:readline';
    if(${simulateStartup}&&(process.argv.includes('--list-models')||process.argv.includes('--version'))){
      const dir=join(process.env.HOME,'.commandcode');mkdirSync(dir,{recursive:true});
      writeFileSync(join(dir,'config.json'),'startup migration');
      if(!process.env.CI)writeFileSync(join(process.env.HOME,'ide-installed.marker'),'startup IDE install');
    }
    if(process.argv.includes('--help')){console.log('--thinking <level> Set reasoning effort: none|low|medium|high');process.exit(0);}
    if(process.argv.includes('--version')){console.log('Command Code v1.73.0');process.exit(0);}
    if(process.argv.includes('--list-models')&&process.env.CATALOG_HANG!=='1'){
      appendFileSync(process.env.CATALOG_LOG,JSON.stringify({args:process.argv.slice(2),telemetry:process.env.DO_NOT_TRACK})+'\\n');
      console.log('Available models  ·  2 models\\n\\nOpen Source\\n\\nvendor/fast-model  reasoning (default)'+(process.env.CATALOG_BAD==='1'?'':'\\ncustom/vendor:local  public description never-expose-this')+'\\n\\nPass the full id, or just the short name after the last "/":\\ncmd --model vendor/fast-model\\n\\nDocs:  https://commandcode.ai/docs/reference/cli/models\\n\\nDecision models (headless only)\\ntypesafe/jev  decision endpoint');process.exit(0);
    }
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
  chmodSync(script,0o755);
  return {root,log,env:{...process.env,CATALOG_LOG:log,CODEX_BIN:script,CLINE_BIN:script,CLINE_SETTINGS_PATH:settings,COMMAND_CODE_BIN:script},launch:(bin,args,options)=>spawnManaged(process.execPath,[script,...args],{...options,env:{...options.env,CATALOG_LOG:log}}),cleanup:()=>rmSync(root,{recursive:true,force:true})};
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

test('Cline native discovery joins offline SDK grades to the exact configured-provider ACP names',async()=>{
  const fx=fixture();try{
    writeFileSync(join(fx.root,'package.json'),JSON.stringify({name:'cline',version:'3.0.68'}));
    const sdk=join(fx.root,'node_modules','@cline','llms');mkdirSync(sdk,{recursive:true});
    writeFileSync(join(sdk,'package.json'),JSON.stringify({name:'@cline/llms',version:'0.0.90',exports:{'.':{import:'./index.mjs'}}}));
    writeFileSync(join(sdk,'index.mjs'),`export function getModelsForProvider(provider,{filter}) {
      if(provider!=='active'||filter!=='chat')throw new Error('wrong catalog');
      return {'active/model':{id:'active/model',name:'Exact model',reasoningOptions:[{type:'toggle'},{type:'effort',values:['low','max']}],apiKey:'never-expose-this'},
        'other/model':{id:'other/model',name:'Other provider model',reasoningOptions:[{type:'effort',values:['high']}]}};
    }`);
    const result=await queryNativeCatalog('cline',{...fx,launch:spawnManaged});
    assert.equal(result.models.length,1);
    assert.equal(result.models[0].id,'active/model');
    assert.equal(result.models[0].reasoning_control,'effort');
    assert.equal(result.models[0].reasoning_source,'installed Cline SDK provider metadata');
    assert.deepEqual(result.models[0].reasoning_efforts,['low','max']);
    const options=agentOptions('cline',{discovery:result,paths:{clineSettings:join(fx.root,'providers.json')}});
    assert.deepEqual(options.models[0].reasoning_efforts,['low']);
    assert.doesNotMatch(JSON.stringify(result),/never-expose-this|other\/model|apiKey/);
    const methods=readFileSync(fx.log,'utf8').trim().split('\n').map(s=>JSON.parse(s).method);
    assert.deepEqual(methods,['initialize','session/new','session/set_config_option']);
  }finally{fx.cleanup();}
});
test('a stalled catalog client is bounded, terminated and reports no raw client output',async()=>{
  const fx=fixture();try{const start=Date.now();await assert.rejects(queryNativeCatalog('codex',{...fx,timeoutMs:200,env:{...fx.env,CATALOG_HANG:'1'}}),/CATALOG_TIMEOUT/);assert.ok(Date.now()-start<2000);}finally{fx.cleanup();}
});
test('Command Code lists native models without inference and does not invent effort grades',async()=>{
  const fx=fixture();try{
    const result=await queryNativeCatalog('command-code',fx);
    assert.equal(result.client_version,'1.73.0');assert.equal(result.default_model,'vendor/fast-model');
    assert.deepEqual(result.models.map(m=>m.id),['vendor/fast-model','custom/vendor:local']);
    assert.ok(result.models.every(m=>m.reasoning_status==='unverified'&&m.reasoning_efforts.length===0));
    assert.doesNotMatch(JSON.stringify(result),/never-expose-this|typesafe\/jev/);
    const call=JSON.parse(readFileSync(fx.log,'utf8').trim());
    assert.deepEqual(call.args,['--no-auto-update','--list-models']);assert.equal(call.telemetry,'1');
  }finally{fx.cleanup();}
});
test('Command Code refuses incomplete listings and terminates stalled metadata processes',async()=>{
  const fx=fixture();try{
    const flags=extra=>(bin,args,options)=>fx.launch(bin,args,{...options,env:{...options.env,...extra}});
    await assert.rejects(queryNativeCatalog('command-code',{...fx,launch:flags({CATALOG_BAD:'1'})}),/CATALOG_UNAVAILABLE/);
    const start=Date.now();await assert.rejects(queryNativeCatalog('command-code',{...fx,timeoutMs:200,launch:flags({CATALOG_HANG:'1'})}),/CATALOG_TIMEOUT/);assert.ok(Date.now()-start<2000);
  }finally{fx.cleanup();}
});
test('Command Code startup migrations stay isolated and IDE installation is disabled during catalog scans',async()=>{
  const fx=fixture({simulateStartup:true});try{
    const home=join(fx.root,'operator-home'),configDir=join(home,'.commandcode');mkdirSync(configDir,{recursive:true});
    const config=join(configDir,'config.json'),auth=join(configDir,'auth.json');
    writeFileSync(config,'operator configuration');writeFileSync(auth,'operator credentials');
    const launches=[];
    const result=await queryNativeCatalog('command-code',{...fx,env:{...fx.env,HOME:home,USERPROFILE:home,COMMAND_CODE_API_KEY:'never-expose-this',OPENAI_API_KEY:'never-expose-this',NODE_OPTIONS:'--require /missing-preload.cjs',VSCODE_PID:'12345'},launch:(bin,args,options)=>{launches.push(options);return fx.launch(bin,args,options);}});
    assert.equal(result.models.length,2);assert.equal(launches.length,2);
    for(const options of launches){
      assert.notEqual(options.env.HOME,home);assert.equal(options.env.USERPROFILE,options.env.HOME);
      assert.equal(options.env.CI,'1');assert.equal(options.env.DO_NOT_TRACK,'1');
      for(const key of ['COMMAND_CODE_API_KEY','OPENAI_API_KEY','NODE_OPTIONS','VSCODE_PID'])assert.equal(options.env[key],undefined);
      assert.equal(existsSync(options.cwd),false,'temporary metadata files are removed');
    }
    assert.equal(readFileSync(config,'utf8'),'operator configuration');assert.equal(readFileSync(auth,'utf8'),'operator credentials');
    assert.equal(existsSync(join(home,'ide-installed.marker')),false);
  }finally{fx.cleanup();}
});
test('Command Code installation detection respects cmd aliases and explicit overrides',()=>{
  const fx=fixture();try{
    const cmd=join(fx.root,'cmd');writeFileSync(cmd,'#!/bin/sh\nexit 0\n');chmodSync(cmd,0o755);
    assert.equal(isClientInstalled('command-code',{PATH:fx.root}),true);
    assert.equal(isClientInstalled('command-code',{PATH:fx.root,COMMAND_CODE_BIN:'cmd'}),true);
    assert.equal(isClientInstalled('command-code',{PATH:fx.root,COMMAND_CODE_BIN:join(fx.root,'missing')}),false);
  }finally{fx.cleanup();}
});
test('unsupported clients never launch a process',async()=>{let calls=0;assert.equal(await queryNativeCatalog('unknown',{launch:()=>{calls++;}}),null);assert.equal(calls,0);});
