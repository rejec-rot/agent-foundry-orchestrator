import './helpers/executors-fixture.mjs';
import './helpers/runtime-state-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {ExecutorRuntimeGuard} from '../lib/executor-runtime-guard.mjs';
import {acquireTaskLock,releaseTaskLock} from '../lib/tasklock.mjs';
import {saveTaskWithVersion} from '../lib/store.mjs';
import {startOrResumeV2Task} from '../lib/execution-manager.mjs';
import {resolveV2HumanGate} from '../lib/trusted-import/human-gate-resume.mjs';
import {verifyPersistedHumanApproval,persistedHumanApprovalProvider} from '../lib/trusted-import/human-gate-provider.mjs';
import {isTrustedHumanApproval} from '../lib/trusted-import/human-gate.mjs';
import {parkForHumanGate} from '../lib/trusted-import/human-gate-park.mjs';
import {runAuthor,runReview} from '../lib/task-execution.mjs';
import {forgetSubmission} from '../lib/submission.mjs';
import {submissionKeyDigest} from '../lib/submission-store.mjs';
import {changeWorkbench,workbenchPrompt,readWorkbench} from '../lib/workbench.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=()=>mkdtempSync(join(tmpdir(),'af-team-foundation-'));
test('independent guards share executor slots and observe each other\'s circuit updates',async()=>{
  const root=fixture();
  try {
    const policyFile=join(root,'policy.json');writeFileSync(policyFile,JSON.stringify({codex:{max_parallel:1,min_interval_ms:0}}));
    const options={policyFile,stateFile:join(root,'state.json'),eventsLogFile:join(root,'events.jsonl')};
    const a=new ExecutorRuntimeGuard(options),b=new ExecutorRuntimeGuard(options);
    const token=await a.acquireSlot('codex');let acquired=false;
    const waiting=b.acquireSlot('codex').then(t=>{acquired=true;return t;});
    await delay(60);assert.equal(acquired,false);
    a.releaseSlot('codex',token);const next=await waiting;b.releaseSlot('codex',next);
    a.recordResult('codex',{safety_action:'OPEN_MANUAL_RESET',category:'ACCOUNT_POLICY',reason:'blocked'});
    assert.equal(b.canExecute('codex'),false);
    b.recordResult('codex',{safety_action:'COOLDOWN',category:'RATE_LIMIT',reason:'late rate-limit response'});
    assert.equal(a.getCircuitState('codex').state,'OPEN_MANUAL_RESET','a late response cannot lower an account ban');
    b.recordResult('claude',{safety_action:'COOLDOWN',category:'RATE_LIMIT',reason:'wait'});
    assert.equal(new ExecutorRuntimeGuard(options).getCircuitState('codex').state,'OPEN_MANUAL_RESET');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('separate processes serialize shared executor slots under repeated contention',async()=>{
  const root=fixture();try {
    const policyFile=join(root,'policy.json');writeFileSync(policyFile,JSON.stringify({codex:{max_parallel:1,min_interval_ms:0}}));
    const options={policyFile,stateFile:join(root,'state.json'),eventsLogFile:join(root,'events.jsonl')};
    new ExecutorRuntimeGuard(options);
    const moduleUrl=new URL('../lib/executor-runtime-guard.mjs',import.meta.url).href;
    const source=`import {ExecutorRuntimeGuard} from ${JSON.stringify(moduleUrl)};const guard=new ExecutorRuntimeGuard(JSON.parse(process.argv[1]));for(let i=0;i<12;i++){const token=await guard.acquireSlot('codex');const start=Date.now();await new Promise(r=>setTimeout(r,10));const end=Date.now();guard.releaseSlot('codex',token);console.log(JSON.stringify({pid:process.pid,start,end}));}`;
    const run=()=>new Promise((resolve,reject)=>execFile(process.execPath,['--input-type=module','-e',source,JSON.stringify(options)],{timeout:15000},(err,stdout,stderr)=>err?reject(new Error(stderr||err.message)):resolve(stdout.trim().split('\n').map(line=>JSON.parse(line)))));
    const [first,second]=await Promise.all([run(),run()]);assert.equal(first.length+second.length,24);
    for(const a of first)for(const b of second)assert.equal(a.start<b.end&&b.start<a.end,false,'only one process can use the provider slot at a time');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('cancelled tasks cannot be replaced by the old run entry',()=>{
  const root=fixture();try {
    const tasks=join(root,'tasks'),locks=join(root,'locks');mkdirSync(tasks);mkdirSync(locks);
    const task={task_id:'TASK-CANCELLED',state:'CANCELLED',state_version:99,cancel_requested_at:'kept',runs:[]};
    writeFileSync(join(tasks,`${task.task_id}.json`),JSON.stringify(task));
    const file=join(root,'definition.json');writeFileSync(file,JSON.stringify({task_id:task.task_id,goal:'do work',acceptance:'passes',fixture_dir:root,acceptance_cmd:{command:'node',args:['--test']}}));
    assert.throws(()=>execFileSync(process.execPath,['orchestrator.mjs','run','--task-file',file],{cwd:process.cwd(),env:{...process.env,AF_TASKS_DIR:tasks,AF_LOCKS_DIR:locks},stdio:'pipe'}),err=>/TASK_ALREADY_EXISTS/.test(String(err.stderr)));
    assert.deepEqual(JSON.parse(readFileSync(join(tasks,`${task.task_id}.json`),'utf8')),task);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('record and list use the same default data root when called outside the repository',()=>{
  const root=fixture();try {
    const moduleUrl=new URL('../lib/submission.mjs',import.meta.url).href;
    const source=`import {recordSubmission,listSubmissions,submissionDir,forgetSubmission} from ${JSON.stringify(moduleUrl)};import {randomUUID} from 'node:crypto';const key='outside-cwd-'+randomUUID();const spec={goal:'fixture',target_path:process.cwd(),acceptance:{command:'node',args:['--test']},idempotency_key:key};const deps={allowlist:{ok:true,configured:true,allowed:[{command:'node',args_prefix:['--test']}]},sandboxAvailable:()=>true,executorStatus:()=>({executors:[{available:true}]}),storeWritable:()=>({ok:true})};let record;try{record=recordSubmission({spec,allowedRoots:[process.cwd()],env:{},deps});const list=listSubmissions();console.log(JSON.stringify({recorded:record.ok,listed:list.ok&&list.records.some(r=>r.idempotency_key_digest===record.record?.idempotency_key_digest),sameRoot:record.record?.record_file.startsWith(submissionDir({})+'/')}));}finally{forgetSubmission({key,dir:submissionDir({})});}`;
    const env={...process.env};for(const key of ['AF_RUNTIME_DIR','AF_SUBMISSION_DIR','AF_DATA_ROOT'])delete env[key];
    const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source],{cwd:root,env,encoding:'utf8',stdio:'pipe'}));
    assert.deepEqual(result,{recorded:true,listed:true,sameRoot:true});
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('forget cannot remove a submission while its binding key is locked',()=>{
  const root=fixture(),key='binding';const digest=submissionKeyDigest(key);
  const file=join(root,`${digest}.json`);writeFileSync(file,JSON.stringify({state:'PREPARED'}));
  const lock=acquireTaskLock(root,`submission-${digest}`,{orchestratorInstanceId:'creator'});
  try {assert.equal(forgetSubmission({key,dir:root}).ok,false);assert.equal(JSON.parse(readFileSync(file)).state,'PREPARED');}
  finally{releaseTaskLock(root,`submission-${digest}`,lock.lock);rmSync(root,{recursive:true,force:true});}
});
test('fix resumes only an eligible original executor and review retries recheck session independence',async()=>{
  const task={task_id:'TASK-POLICY',goal:'goal',acceptance:'passes',fixture_dir:process.cwd(),author_role:'author',reviewer_role:'reviewer',red_lines:[],review_rules:[],runs:[],
    author_executor:'auto',reviewer_executor:'writer',author_session_executor_type:'writer',author_session_ref:'author-session'};
  let resumed=false;
  await assert.rejects(runAuthor(task,2,{writer:{type:'writer',schedulable:false,resume:async()=>{resumed=true;}}}),/not schedulable/);
  assert.equal(resumed,false);
  let n=0;
  const adapter={type:'writer',run:async()=>({status:'completed',session_ref:n++===0?'review-session':'author-session',structured_result:{result:n===1?'invalid':JSON.stringify({decision:'PASS',summary:'ok',issues:[],required_changes:[],evidence:[]})}})};
  await assert.rejects(runReview(task,1,{writer:adapter}),/session collides/);
});
test('checkpoint CLI writes to the controlled runtime supplied by its parent prompt',()=>{
  const root=fixture();try {
    const runtimeDir=join(root,"custom ' runtime");
    changeWorkbench('TASK-CTX',s=>({...s,mode:'collaborative'}),process.cwd(),{runtimeDir});
    const prompt=workbenchPrompt('TASK-CTX','RUN-CTX',process.cwd(),{runtimeDir});assert.match(prompt,/--runtime-dir/);
    execFileSync(process.execPath,['lib/workbench.mjs','checkpoint','TASK-CTX','RUN-CTX','question','artifact','instructions','--runtime-dir',runtimeDir],{cwd:process.cwd(),stdio:'pipe'});
    assert.equal(readWorkbench('TASK-CTX',process.cwd(),{runtimeDir}).checkpoints.length,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('signed persisted approvals resume through the normal manager and reject changed candidates',async()=>{
  const root=fixture(),oldKey=process.env.AF_OPERATOR_KEY;process.env.AF_OPERATOR_KEY='unit-key';
  try {
    const tasksDir=join(root,'tasks'),locksDir=join(root,'locks');mkdirSync(tasksDir);mkdirSync(locksDir);
    const task={task_id:'TASK-GATE',state:'WAITING_HUMAN',state_version:4,runs:[],trusted_import:{enabled:true,phase:'WAITING_HUMAN',baseline_oid:'a'.repeat(40),
      manifest:{manifest_digest:'manifest'},candidate_snapshot:{snapshot_digest:'snapshot'},policy:{allowed_root:['.']},acceptance:{acceptance_profile_digest:'profile'},
      pending_human_decisions:[{path:'SECURITY.md',action:'MODIFY',band:'D',decision:'WAITING_HUMAN'}],pending_human_context:{state_version:4}}};
    const result=resolveV2HumanGate({task,operatorIdentity:'operator',justification:'reviewed',
      operatorAuthenticator:({auditPayload})=>({verified:true,signature:createHmac('sha256','unit-key').update(auditPayload).digest('hex')}),saveTask:t=>saveTaskWithVersion(tasksDir,t)});
    assert.equal(result.ok,true);assert.equal(verifyPersistedHumanApproval(task),true);
    assert.equal(isTrustedHumanApproval(persistedHumanApprovalProvider()({task})),true);
    const changed=structuredClone(task);changed.trusted_import.manifest.manifest_digest='other';assert.equal(verifyPersistedHumanApproval(changed),false);
    let entered=false;
    const resumed=await startOrResumeV2Task({taskId:task.task_id,tasksDir,locksDir,runtimeDir:root,runner:async({task:current})=>{entered=true;current.state='COMPLETED';saveTaskWithVersion(tasksDir,current);return current;}});
    assert.equal(resumed.ok,true);assert.equal(entered,true);
  }finally{if(oldKey===undefined)delete process.env.AF_OPERATOR_KEY;else process.env.AF_OPERATOR_KEY=oldKey;rmSync(root,{recursive:true,force:true});}
});
test('a parked task keeps its approval version aligned through manager settlement',async()=>{
  const root=fixture();try {
    const tasksDir=join(root,'tasks'),locksDir=join(root,'locks');mkdirSync(tasksDir);mkdirSync(locksDir);
    const task={task_id:'TASK-PARK',state:'CREATED',state_version:1,runs:[],trusted_import:{enabled:true,acceptance:{acceptance_profile_digest:'profile'}}};
    writeFileSync(join(tasksDir,`${task.task_id}.json`),JSON.stringify(task));
    await startOrResumeV2Task({taskId:task.task_id,tasksDir,locksDir,runtimeDir:root,runner:async({task:t})=>{
      parkForHumanGate({task:t,closure:{needsHuman:[{path:'p',action:'MODIFY',band:'D',decision:'WAITING_HUMAN'}]},saveTask:v=>saveTaskWithVersion(tasksDir,v)});return t;
    }});
    const stored=JSON.parse(readFileSync(join(tasksDir,`${task.task_id}.json`),'utf8'));
    assert.equal(stored.trusted_import.pending_human_context.state_version,stored.state_version);
  }finally{rmSync(root,{recursive:true,force:true});}
});
