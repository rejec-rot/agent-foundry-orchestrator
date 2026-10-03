import { mkdtempSync,mkdirSync,rmSync,readFileSync,existsSync,realpathSync,openSync,closeSync,fstatSync,readSync,writeFileSync,constants } from 'node:fs';
import { join,dirname,resolve,isAbsolute,relative,sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveAgentBinary } from '../agent-discovery.mjs';
import { spawnManaged,signalTree } from '../child-process.mjs';
import { executorEnv } from '../executor-env.mjs';

const LEVELS=new Set(['off','minimal','low','medium','high','xhigh','max']);
const TOKEN=/^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,159}$/;
const PACKAGE_NAMES=['@earendil-works/pi-coding-agent','@mariozechner/pi-coding-agent'];
function publicPackage(dir) {try{const value=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));return PACKAGE_NAMES.includes(value.name)?{dir,...value}:null;}catch{return null;}}
function installedPackage(binary) {
  let file;try{file=realpathSync(binary);}catch{return null;}
  let dir=dirname(file);
  for(let n=0;n<8;n++){const pkg=publicPackage(dir);if(pkg)return pkg;const parent=dirname(dir);if(parent===dir)break;dir=parent;}
  const agent=dirname(dirname(file));
  try{
    const version=readFileSync(join(agent,'install/current-version'),'utf8').trim();
    if(!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version))return null;
    for(const name of PACKAGE_NAMES){const pkg=publicPackage(join(agent,'install/releases',version,'node_modules',name));if(pkg)return pkg;}
  }catch{}
  return null;
}
async function thinkingHelper(pkg) {
  if(!pkg)return null;
  try {
    const require=createRequire(join(pkg.dir,'package.json'));
    for(const name of ['@earendil-works/pi-ai','@mariozechner/pi-ai']) {
      try{const api=await import(pathToFileURL(require.resolve(name)).href);if(typeof api.getSupportedThinkingLevels==='function')return api.getSupportedThinkingLevels;}catch{}
    }
  }catch{}
  return null;
}
export function normalizePiModels(models,{getSupportedThinkingLevels=null}={}) {
  if(!Array.isArray(models)||models.length>1000)throw new Error('CATALOG_UNAVAILABLE');
  const result=[];
  for(const m of models) {
    if(!m||!TOKEN.test(m.id??'')||!TOKEN.test(m.provider??''))continue;
    const metadata={id:m.id,provider:m.provider,...(typeof m.api==='string'?{api:m.api}:{})};
    if(typeof m.reasoning==='boolean')metadata.reasoning=m.reasoning;
    if(m.thinkingLevelMap&&typeof m.thinkingLevelMap==='object')metadata.thinkingLevelMap=Object.fromEntries(Object.entries(m.thinkingLevelMap).filter(([k,v])=>LEVELS.has(k)&&(typeof v==='string'||v===null)));
    let levels=[],verified=false;
    if(typeof metadata.reasoning==='boolean'&&getSupportedThinkingLevels) {
      try{const raw=getSupportedThinkingLevels(metadata);if(Array.isArray(raw)){levels=[...new Set(raw.filter(v=>LEVELS.has(v)))];verified=true;}}catch{}
    }
    const id=`${m.provider}/${m.id}`;
    if(id.length>160)continue;
    result.push({id,label:typeof m.name==='string'?m.name.slice(0,160):id,reasoning_efforts:levels,reasoning_status:verified?'verified':'unverified'});
  }
  return [...new Map(result.map(m=>[m.id,m])).values()];
}
export async function queryPiCatalog({env=process.env,timeoutMs=12000,launch=spawnManaged,binary=null,getSupportedThinkingLevels=null}={}) {
  const bin=binary??resolveAgentBinary('pi',{env});if(!bin)throw new Error('CLIENT_UNAVAILABLE');
  const pkg=installedPackage(bin),helper=getSupportedThinkingLevels??await thinkingHelper(pkg);
  const scratch=mkdtempSync(join(tmpdir(),'af-pi-catalog-')),cwd=join(scratch,'cwd');mkdirSync(cwd);
  const configured=env.PI_CODING_AGENT_DIR??(env.HOME?join(env.HOME,'.pi/agent'):null);
  const agentDir=configured&&existsSync(configured)?configured:join(scratch,'agent');if(!existsSync(agentDir))mkdirSync(agentDir);
  const childEnv={...executorEnv('pi',env),PATH:[env.PATH,dirname(process.execPath)].filter(Boolean).join(process.platform==='win32'?';':':'),PI_OFFLINE:'1',PI_CODING_AGENT_DIR:agentDir};
  const args=['--mode','rpc','--offline','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-tools'];
  let child,closed=false;
  try {
    const models=await new Promise((accept,reject)=>{
      let buffer='',bytes=0,settled=false;
      const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(new Error(err)):accept(value);};
      const timer=setTimeout(()=>finish('CATALOG_TIMEOUT'),Math.max(1,Math.min(20000,timeoutMs)));
      try{child=launch(bin,args,{cwd,env:childEnv,stdio:['pipe','pipe','ignore']});}catch{finish('CLIENT_UNAVAILABLE');return;}
      child.once('error',()=>finish('CLIENT_UNAVAILABLE'));child.once('close',()=>{closed=true;finish('CATALOG_UNAVAILABLE');});
      child.stdin.on('error',()=>finish('CATALOG_UNAVAILABLE'));
      child.stdout.on('data',chunk=>{
        bytes+=chunk.length;if(bytes>8*1024*1024){finish('CATALOG_TOO_LARGE');return;}
        buffer+=chunk.toString();let end;
        while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let msg;
          try{msg=JSON.parse(line);}catch{continue;}
          if(msg.id!=='agent-foundry-pi-catalog-1')continue;
          if(msg.type!=='response'||msg.command!=='get_available_models'||msg.success!==true||!Array.isArray(msg.data?.models)){finish('CATALOG_UNAVAILABLE');return;}
          finish(null,msg.data.models);
        }
      });
      child.stdin.write(JSON.stringify({id:'agent-foundry-pi-catalog-1',type:'get_available_models'})+'\n');
    });
    const normalized=normalizePiModels(models,{getSupportedThinkingLevels:helper});
    return {status:'ready',checked_at:new Date().toISOString(),provider:null,models:normalized,client_version:pkg?.version??null,model_source:'Pi native offline get_available_models and installed SDK capabilities',
      ...(normalized.length===0?{reason:'Pi has no configured provider models.'}:{})};
  } finally {
    if(child&&!closed){child.stdin.end();signalTree(child,'SIGTERM');await new Promise(done=>{const timer=setTimeout(()=>{signalTree(child,'SIGKILL');},500);child.once('close',()=>{clearTimeout(timer);done();});});}
    rmSync(scratch,{recursive:true,force:true});
  }
}
function sessionPath(file,dir) {
  if(typeof file!=='string'||!isAbsolute(file)||file.includes('\0')||!file.endsWith('.jsonl'))throw new Error('PI_SESSION_OUTSIDE_SCRATCH');
  if(dir){const rel=relative(resolve(dir),resolve(file));if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('PI_SESSION_OUTSIDE_SCRATCH');}
  return file;
}
// Each run receives only its own scratch mount. Copy the exact previous native
// session into that mount rather than granting access to other runs' directories.
export function stagePiSession(sessionRef,{sessionDir,sessionFile}) {
  const source=sessionPath(sessionRef,join(tmpdir(),'af-executor-scratch'));
  sessionPath(sessionFile,sessionDir);
  sessionPath(realpathSync(source),realpathSync(join(tmpdir(),'af-executor-scratch')));
  const fd=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.size===0||stat.size>64*1024*1024)throw new Error('PI_SESSION_INVALID');
    const data=Buffer.alloc(stat.size);let offset=0;
    while(offset<data.length){const count=readSync(fd,data,offset,data.length-offset,offset);if(!count)throw new Error('PI_SESSION_INVALID');offset+=count;}
    writeFileSync(sessionFile,data,{flag:'wx',mode:0o600});
    return sessionFile;
  } finally {closeSync(fd);}
}
export function buildPiInvocation(capsule,{binary,sessionRef=null,systemPrompt}={}) {
  if(typeof binary!=='string'||!binary||binary.includes('\0'))throw new Error('PI_BINARY_INVALID');
  if(typeof capsule.prompt!=='string'||!capsule.prompt.trim()||capsule.prompt.includes('\0')||Buffer.byteLength(capsule.prompt)>512*1024)throw new Error('PI_PROMPT_INVALID');
  const model=capsule.model;
  if(typeof model!=='string'||!TOKEN.test(model)||!model.includes('/'))throw new Error('PI_MODEL_PROVIDER_REQUIRED');
  const slash=model.indexOf('/'),provider=model.slice(0,slash),modelId=model.slice(slash+1);
  if(!modelId)throw new Error('PI_MODEL_PROVIDER_REQUIRED');
  const effort=capsule.effort??capsule.reasoning_effort;
  if(effort&&(!LEVELS.has(effort)||(Array.isArray(capsule.supported_reasoning_efforts)&&!capsule.supported_reasoning_efforts.includes(effort))))throw new Error('PI_EFFORT_UNSUPPORTED');
  const session=sessionPath(sessionRef??capsule.session_file,capsule.session_dir);
  const argv=[binary,'--mode','json','--print','--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--provider',provider,'--model',modelId,'--session',session];
  if(effort)argv.push('--thinking',effort);
  if(systemPrompt)argv.push('--append-system-prompt',systemPrompt);
  if(capsule.assigned_role==='reviewer')argv.push('--tools','read,grep,find,ls');
  return {argv,stdin:capsule.prompt,expectedSession:session};
}
export function parsePiOutput(stdout,{expectedSession=null}={}) {
  const lines=String(stdout??'').split('\n').filter(l=>l.trim());let header=null,message=null;
  try {for(const line of lines){const event=JSON.parse(line);if(event.type==='session')header=event;if(event.type==='message_end'&&event.message?.role==='assistant')message=event.message;}}
  catch{return {text:'',sessionRef:null,structured:null,error:'PI_JSON_OUTPUT_INVALID'};}
  if(!header||!message)return {text:'',sessionRef:null,structured:null,error:'PI_JSON_OUTPUT_INVALID'};
  if(expectedSession&&!isAbsolute(expectedSession)&&header.id!==expectedSession)return {text:'',sessionRef:null,structured:null,error:'PI_SESSION_MISMATCH'};
  const text=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(p=>p.type==='text'&&typeof p.text==='string').map(p=>p.text).join(''):'';
  const error=['error','aborted'].includes(message.stopReason)?'PI_MODEL_RUN_FAILED':null;
  return {text,sessionRef:expectedSession&&isAbsolute(expectedSession)?expectedSession:header.id,structured:{result:text},...(error?{error}:{} )};
}
export const piConnector=Object.freeze({protocol:'rpc',queryCatalog:queryPiCatalog,buildInvocation:buildPiInvocation,parseOutput:parsePiOutput});
