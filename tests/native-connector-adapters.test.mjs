import './helpers/executors-fixture.mjs';
import './helpers/runtime-state-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,readFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ADAPTERS,QoderAdapter,PiAdapter,activeRunsForTask} from '../lib/adapters.mjs';
import {supportsPlanner} from '../lib/team/planner.mjs';
const root=mkdtempSync(join(tmpdir(),'af-native-adapters-')),canonical=join(root,'AGENTS.md'),log=join(root,'argv.json'),stub=join(root,'agent');
writeFileSync(canonical,'Canonical governance for this isolated test.\n');
writeFileSync(stub,`#!${process.execPath}\nimport {writeFileSync,readFileSync,existsSync} from 'node:fs';
const args=process.argv.slice(2);writeFileSync(process.env.AF_STUB_NATIVE_ARGV_LOG,JSON.stringify(args));
if(process.env.AF_STUB_NATIVE_HANG==='1'){setInterval(()=>{},1000);}
else if(args.includes('--output-format')){const flag=args.includes('--resume')?'--resume':'--session-id';console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:args[args.indexOf(flag)+1],result:JSON.stringify({status:'done',summary:'Qoder result',work_items:[],messages:[]})}));}
else{const file=args[args.indexOf('--session')+1];const header=existsSync(file)?JSON.parse(readFileSync(file,'utf8').split('\\n')[0]):{type:'session',id:'pi-session-fixture'};if(!existsSync(file))writeFileSync(file,JSON.stringify(header)+'\\n');console.log(JSON.stringify(header));console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({status:'done',summary:'Pi result',work_items:[],messages:[]})}]}}));}
`);chmodSync(stub,0o755);
async function environment(values,fn) {
  const prior={};for(const [key,value]of Object.entries(values)){prior[key]=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}
  try{return await fn();}finally{for(const key of Object.keys(values)){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}}
}
const env={QODER_BIN:stub,PI_BIN:stub,AF_CANONICAL_AGENTS_MD:canonical,AF_STUB_NATIVE_ARGV_LOG:log};
test('bundled Qoder and Pi adapters support independent Planner/reviewer sessions',()=>{
  for(const id of ['qoder','pi']){assert.equal(ADAPTERS[id].type,id);assert.equal(supportsPlanner(id,ADAPTERS),true);for(const method of ['run','resume','cancel','health'])assert.equal(typeof ADAPTERS[id][method],'function');}
});
test('Qoder executes through the supervised adapter and forwards an exact session, model and verified effort',async()=>environment(env,async()=>{
  const result=await QoderAdapter.resume('explicit-session',{task_id:'native-qoder',prompt:'Return the required JSON.',model:'Qwen3.8-Max',effort:'xhigh',supported_reasoning_efforts:['low','medium','xhigh'],cwd:root,response_schema:{},timeout_ms:10000});
  assert.equal(result.status,'completed',result.error);assert.equal(result.session_ref,'explicit-session');assert.equal(result.writer_termination?.process_started,true);assert.equal(typeof result.writer_termination?.termination_confirmed,'boolean');
  assert.equal(JSON.parse(result.structured_result.result).summary,'Qoder result');
  const args=JSON.parse(readFileSync(log));assert.equal(args[args.indexOf('--resume')+1],'explicit-session');assert.equal(args[args.indexOf('--model')+1],'Qwen3.8-Max');assert.equal(args[args.indexOf('--reasoning-effort')+1],'xhigh');assert.ok(args.includes('--append-system-prompt'));
}));
test('Pi forwards provider/model and verified effort while using a fresh scratch session',async()=>environment(env,async()=>{
  const result=await PiAdapter.run({task_id:'native-pi',prompt:'Return JSON.',model:'provider/nested/model',effort:'off',supported_reasoning_efforts:['off'],cwd:root,response_schema:{},timeout_ms:10000});
  assert.equal(result.status,'completed',result.error);assert.match(result.session_ref,/af-executor-scratch.*pi-.*\.jsonl$/);assert.equal(result.writer_termination?.process_started,true);assert.equal(typeof result.writer_termination?.termination_confirmed,'boolean');
  const args=JSON.parse(readFileSync(log));assert.equal(args[args.indexOf('--provider')+1],'provider');assert.equal(args[args.indexOf('--model')+1],'nested/model');assert.equal(args[args.indexOf('--thinking')+1],'off');assert.ok(!args.includes('--continue'));
}));
test('unverified reasoning is rejected before either native client starts',async()=>environment(env,async()=>{
  for(const adapter of [QoderAdapter,PiAdapter]){const result=await adapter.run({prompt:'Do something.',model:'provider/model',effort:'high',supported_reasoning_efforts:[],cwd:root});assert.equal(result.status,'failed');assert.match(result.error,/not verified/);}
}));
test('Pi resumes the exact previous session inside the new isolated run scratch directory',async()=>environment(env,async()=>{
  const suffix=randomUUID(),firstId=`RUN-pi-first-${suffix}`,nextId=`RUN-pi-next-${suffix}`;
  let first,next;
  try {
    first=await PiAdapter.run({runId:firstId,task_id:'native-pi-resume',prompt:'First fixture turn.',model:'provider/model',cwd:root,timeout_ms:10000});
    assert.equal(first.status,'completed',first.error);const original=readFileSync(first.session_ref,'utf8');
    next=await PiAdapter.resume(first.session_ref,{runId:nextId,task_id:'native-pi-resume',prompt:'Continue the exact fixture session.',model:'provider/model',cwd:root,timeout_ms:10000});
    assert.equal(next.status,'completed',next.error);assert.notEqual(next.session_ref,first.session_ref);assert.equal(next.session_ref.includes(nextId),true);
    assert.equal(readFileSync(next.session_ref,'utf8'),original);assert.equal(readFileSync(first.session_ref,'utf8'),original);
    const args=JSON.parse(readFileSync(log));assert.equal(args[args.indexOf('--session')+1],next.session_ref);
  }finally{for(const result of [first,next])if(result?.session_ref)rmSync(join(result.session_ref,'..'),{recursive:true,force:true});}
}));
test('a Qoder reviewer starts a fresh explicit session with the same requested model and effort',async()=>environment(env,async()=>{
  const result=await QoderAdapter.run({task_id:'native-qoder-review',assigned_role:'reviewer',prompt:'Return the required review JSON.',model:'Qwen3.8-Max',effort:'xhigh',supported_reasoning_efforts:['low','medium','xhigh'],cwd:root,response_schema:{},timeout_ms:10000});
  assert.equal(result.status,'completed',result.error);const args=JSON.parse(readFileSync(log));assert.equal(args[args.indexOf('--session-id')+1],result.session_ref);assert.equal(args.includes('--resume'),false);assert.equal(args[args.indexOf('--model')+1],'Qwen3.8-Max');assert.equal(args[args.indexOf('--reasoning-effort')+1],'xhigh');
}));
test('Qoder cancellation stops the exact supervised process',async()=>environment({...env,AF_STUB_NATIVE_HANG:'1'},async()=>{
  const runId='RUN-native-connector-cancel',taskId='native-cancel';
  const pending=QoderAdapter.run({task_id:taskId,runId,prompt:'Controlled fixture.',cwd:root,timeout_ms:10000});
  const deadline=Date.now()+5000;while(!activeRunsForTask(taskId).length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert.equal(activeRunsForTask(taskId).length,1);await QoderAdapter.cancel(runId);const result=await pending;assert.equal(result.status,'cancelled');assert.equal(activeRunsForTask(taskId).length,0);
}));
test.after(()=>rmSync(root,{recursive:true,force:true}));
