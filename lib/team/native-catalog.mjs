// Metadata-only native protocols: never start a turn, send a prompt, or run tools.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnManaged, signalTree } from '../child-process.mjs';
import { CLINE_SETTINGS_PATH } from '../config.mjs';
import { resolveAgentBinary } from '../agent-discovery.mjs';
import { prepareCommandCodeScanEnvironment } from './command-code-scan-environment.mjs';

const clientBinary=(id,env=process.env)=>resolveAgentBinary(id,{env});
export function isClientInstalled(id,env=process.env) {return clientBinary(id,env)!==null;}

function parseCommandCodeModels(output) {
  const plain=output.replace(/\u001b\[[0-9;]*m/g,''),header=plain.match(/^Available models\s*[·•]\s*(\d+) models\s*$/m);
  if(!header||!/^Docs:\s+https:\/\/commandcode\.ai\/docs\//m.test(plain))throw new Error('CATALOG_UNAVAILABLE');
  const count=Number(header[1]);if(count>1000)throw new Error('CATALOG_TOO_LARGE');
  const table=plain.slice(plain.indexOf(header[0])+header[0].length).split(/^Pass the full id[^\n]*$/m)[0];
  const models=table.split('\n').flatMap(line=>{
    const row=line.match(/^([a-zA-Z0-9][a-zA-Z0-9._:/@+~-]{0,159})[ \t]{2,}(\S.*)$/);
    return row?[{id:row[1],label:row[1],reasoning_efforts:[],reasoning_status:'unverified',...(row[2].includes('(default)')?{catalog_default:true}:{})}]:[];
  });
  if(models.length!==count||new Set(models.map(m=>m.id)).size!==count)throw new Error('CATALOG_UNAVAILABLE');
  return {models:models.map(({catalog_default,...m})=>m),default_model:models.find(m=>m.catalog_default)?.id??null};
}

async function commandCodeCatalog({env,timeoutMs,launch}) {
  const bin=clientBinary('command-code',env);if(!bin)throw new Error('CLIENT_UNAVAILABLE');
  const cwd=mkdtempSync(join(tmpdir(),'af-model-catalog-'));
  // CLI startup can migrate config before listing. Keep those writes in a
  // disposable home and disable IDE installation before any IDE detection.
  let metadataEnv;const deadline=Date.now()+timeoutMs;
  const run=(args)=>new Promise((resolve,reject)=>{
    let child,output='',bytes=0,failure=null,timer;
    try{child=launch(bin,args,{cwd,env:metadataEnv,stdio:['ignore','pipe','ignore']});}catch{return reject(new Error('CLIENT_UNAVAILABLE'));}
    const abort=code=>{if(failure)return;failure=code;clearTimeout(timer);signalTree(child,'SIGKILL');};
    timer=setTimeout(()=>abort('CATALOG_TIMEOUT'),Math.max(1,deadline-Date.now()));
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024)abort('CATALOG_TOO_LARGE');else output+=chunk;});
    child.once('error',()=>abort('CLIENT_UNAVAILABLE'));
    child.once('close',code=>{clearTimeout(timer);failure?reject(new Error(failure)):code===0?resolve(output):reject(new Error('CATALOG_UNAVAILABLE'));});
  });
  try {
    metadataEnv=prepareCommandCodeScanEnvironment({env,cwd});
    const output=await run(['--no-auto-update','--list-models']),catalog=parseCommandCodeModels(output);
    // 1.73's text listing omits effort. Read only the installed picker data,
    // never evaluate the CLI bundle or infer grades from a model family/name.
    try {
      const {queryCommandCodeModelMetadata}=await import('./command-code-model-metadata.mjs');
      const metadata=await queryCommandCodeModelMetadata({binary:bin,models:catalog.models});
      if(Array.isArray(metadata))catalog.models=catalog.models.map(model=>{
        const matches=metadata.filter(m=>m.id===model.id);
        return matches.length===1?{...model,reasoning_efforts:matches[0].reasoning_efforts,
          reasoning_status:matches[0].reasoning_status,reasoning_control:matches[0].reasoning_control,
          reasoning_source:matches[0].reasoning_source}:model;
      });
    } catch { /* Unknown bundle versions keep their real names with unknown levels. */ }
    // Version is optional metadata; absence cannot hide a successfully read list.
    const version=await run(['--no-auto-update','--version']).catch(()=>null);
    return {status:'ready',checked_at:new Date().toISOString(),provider:null,...catalog,
      model_source:'Command Code native --list-models',client_version:version?.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)\b/)?.[1]??null};
  } finally {rmSync(cwd,{recursive:true,force:true});}
}

export function clineProvider(file=CLINE_SETTINGS_PATH) {
  try {const data=JSON.parse(readFileSync(file,'utf8')),id=data.lastUsedProvider??'cline';
    return /^[a-z0-9_-]{1,80}$/.test(id)&&data.providers?.[id] ? id : 'cline';
  } catch {return 'cline';}
}
function clientHelp(bin,env,cwd,timeoutMs,launch) {
  return new Promise(resolve=>{
    let text='',child;
    try{child=launch(bin,['--help'],{cwd,env,stdio:['ignore','pipe','ignore']});}catch{return resolve('');}
    const timer=setTimeout(()=>{signalTree(child,'SIGKILL');},timeoutMs);
    child.stdout.on('data',chunk=>{if(text.length<100000)text+=chunk;else signalTree(child,'SIGKILL');});
    child.once('error',()=>{clearTimeout(timer);resolve('');});
    child.once('close',code=>{clearTimeout(timer);resolve(code===0?text:'');});
  });
}
export async function queryNativeCatalog(id,{env=process.env,timeoutMs=12000,launch=spawnManaged}={}) {
  if(id==='qoder') {const {queryQoderCatalog}=await import('../agent-connectors/qoder.mjs');return queryQoderCatalog({env,timeoutMs,launch});}
  if(id==='pi') {const {queryPiCatalog}=await import('../agent-connectors/pi.mjs');return queryPiCatalog({env,timeoutMs,launch});}
  if(id==='command-code')return commandCodeCatalog({env,timeoutMs,launch});
  if(!['codex','cline'].includes(id))return null;
  const root=mkdtempSync(join(tmpdir(),'af-model-catalog-'));
  const provider=id==='cline'?clineProvider(env.CLINE_SETTINGS_PATH):null;
  const bin=clientBinary(id,env);if(!bin){rmSync(root,{recursive:true,force:true});throw new Error('CLIENT_UNAVAILABLE');}
  let child;
  try{child=launch(bin,id==='codex'?['app-server','--stdio']:['--acp','--provider',provider],{cwd:root,env,stdio:['pipe','pipe','ignore']});}
  catch(err){rmSync(root,{recursive:true,force:true});throw new Error('CLIENT_UNAVAILABLE');}
  let buffer='',bytes=0,sequence=0,closed=false;
  const pending=new Map(),deadline=Date.now()+timeoutMs;
  const fail=code=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(code));}pending.clear();};
  child.on('error',()=>{closed=true;fail('CLIENT_UNAVAILABLE');});
  child.on('close',()=>{closed=true;fail('CATALOG_UNAVAILABLE');});
  const request=(method,params)=>new Promise((resolve,reject)=>{
    if(closed)return reject(new Error('CLIENT_UNAVAILABLE'));
    const key=++sequence,timer=setTimeout(()=>{pending.delete(key);reject(new Error('CATALOG_TIMEOUT'));},Math.max(1,deadline-Date.now()));
    pending.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');
  });
  child.stdin.on('error',()=>fail('CATALOG_UNAVAILABLE'));
  child.stdout.on('data',chunk=>{
    bytes+=chunk.length;if(bytes>8*1024*1024){fail('CATALOG_TOO_LARGE');signalTree(child,'SIGTERM');return;}
    buffer+=chunk;let end;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let message;
      try{message=JSON.parse(line);}catch{continue;}
      const p=pending.get(message.id);if(p){pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(new Error('CATALOG_UNAVAILABLE')):p.resolve(message.result);}
      else if(message.method && message.id!==undefined)child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'catalog discovery does not execute client actions'}})+'\n');
    }
  });
  try {
    const init=await request('initialize',id==='codex'?{clientInfo:{name:'agent_foundry_catalog',version:'2.0.0'}}:{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agent-foundry-catalog',version:'2.0.0'}});
    let models=[],client_reasoning_efforts=null;
    if(id==='codex') {
      child.stdin.write(JSON.stringify({method:'initialized'})+'\n');let cursor=null;
      do {const page=await request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
        if(!Array.isArray(page.data))throw new Error('CATALOG_UNAVAILABLE');
        models.push(...page.data.filter(m=>m.hidden!==true).map(m=>({id:m.model,label:m.displayName??m.model,
          reasoning_efforts:Array.isArray(m.supportedReasoningEfforts)?m.supportedReasoningEfforts.map(e=>e.reasoningEffort):[],
          reasoning_status:Array.isArray(m.supportedReasoningEfforts)?'verified':'unverified',default_effort:m.defaultReasoningEffort??null})));
        cursor=page.nextCursor;
      }while(cursor&&models.length<1000);
    } else {
      // ACP metadata sessions stay empty: no session/prompt is ever sent.
      const session=await request('session/new',{cwd:root,mcpServers:[]});
      let config=session.configOptions;
      if(config?.find(o=>o.id==='provider')?.currentValue!==provider) {
        const selected=await request('session/set_config_option',{sessionId:session.sessionId,configId:'provider',value:provider});
        config=selected.configOptions;
      }
      if(config?.find(o=>o.id==='provider')?.currentValue!==provider)throw new Error('PROVIDER_MISMATCH');
      if(!Array.isArray(session.models?.availableModels))throw new Error('CATALOG_UNAVAILABLE');
      const choices=config.find(o=>o.id==='model')?.options;
      if(!Array.isArray(choices))throw new Error('CATALOG_UNAVAILABLE');
      models=choices.map(m=>({id:m.value,label:m.name??m.value,reasoning_efforts:[],reasoning_status:'unverified'}));
      const help=await clientHelp(bin,env,root,Math.max(1,deadline-Date.now()),launch);
      const spec=help.slice(help.indexOf('--thinking'),help.indexOf('--thinking')+300).match(/(?:none|minimal|low|medium|high|xhigh|max|ultra)(?:\|(?:none|minimal|low|medium|high|xhigh|max|ultra))+/)?.[0];
      client_reasoning_efforts=spec?.split('|')??[];
      // ACP lists IDs only. The installed Cline SDK owns the exact provider's
      // per-model controls; query it offline without importing it in the server.
      try {
        const {queryClineSdkCatalog}=await import('./cline-sdk-catalog.mjs');
        const sdk=await queryClineSdkCatalog({binary:bin,provider,env,timeoutMs:Math.max(1,deadline-Date.now()),launch});
        if(sdk?.models)models=models.map(model=>{
          const matches=sdk.models.filter(m=>m.id===model.id);
          if(matches.length!==1)return model;
          const exact=matches[0];
          return {...model,reasoning_efforts:exact.reasoning_efforts,reasoning_status:exact.reasoning_status,
            reasoning_control:exact.reasoning_control,reasoning_source:exact.reasoning_source};
        });
      } catch { /* Native names survive if the installed SDK interface is absent. */ }
    }
    return {status:'ready',checked_at:new Date().toISOString(),provider,models,client_reasoning_efforts,
      model_source:id==='codex'?'Codex native model/list':'Cline native ACP provider catalog',
      client_version:id==='cline'?init.agentInfo?.version??null:init.userAgent?.match(/agent_foundry_catalog\/([^ ]+)/)?.[1]??null};
  } finally {
    fail('CATALOG_CLOSED');child.stdin.end();
    if(!closed){signalTree(child,'SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{signalTree(child,'SIGKILL');resolve();},1000);child.once('close',()=>{clearTimeout(timer);resolve();});});}
    rmSync(root,{recursive:true,force:true});
  }
}
