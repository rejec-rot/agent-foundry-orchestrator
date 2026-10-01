import './executors-fixture.mjs';
import './runtime-state-fixture.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {newTeam,validatePlan} from '../../lib/team/model.mjs';
import {createTeamRecord,readTeam,submitTeamCommand,teamView} from '../../lib/team/store.mjs';
import {TeamController} from '../../lib/team/controller.mjs';

export const END={process_started:true,termination_confirmed:true,scope_verified:true,scope_empty:true,process_group_alive:false,scope_kind:'cgroup'};
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export function output(extra={}) {return {status:'done',summary:'done',work_items:[],messages:[],applied_message_ids:[],resolved_paths:[],retry_work_item_ids:[],...extra};}
export function fixture() {
  const root=mkdtempSync(join(tmpdir(),'af-team-'));
  const options={runtimeDir:join(root,'runtime'),tasksDir:join(root,'tasks'),locksDir:join(root,'locks')};
  const repo=join(root,'canonical');
  for(const dir of [repo,options.tasksDir,options.runtimeDir,options.locksDir,join(repo,'src'),join(repo,'tests')])mkdirSync(dir,{recursive:true});
  const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:'pipe'}).trim();
  git(['init','-b','main']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);
  for(const name of ['a','b','c'])writeFileSync(join(repo,'src',`${name}.mjs`),'export const value = 0;\n');
  writeFileSync(join(repo,'tests','gate.test.mjs'),"import {test} from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/c.mjs';test('gate',()=>assert.equal(value,3));\n");
  git(['add','.']);git(['commit','-m','baseline']);git(['update-ref','refs/afr/canonical',git(['rev-parse','HEAD'])]);
  const task={task_id:'TASK-TEAM',state:'CREATED',state_version:1,goal:'implement a+b=c',fixture_dir:repo,task_mode:'workspace',
    author_executor:'writer',reviewer_executor:'reviewer',acceptance_cmd:{command:'node',args:['--test','tests/gate.test.mjs']},runs:[],
    trusted_import:{enabled:true,phase:'CREATED',candidate_dir:join(root,'candidate'),cas_dir:join(root,'cas'),proposed_required:['src/**'],max_revisions:2,
      acceptance:{tier:'TierA',acceptance_profile_digest:'test-profile',acceptance_assets_digest:'test-assets',dependency_fixture_id:'f'},
      policy:{allowed_root:['src/**','tests/**'],forbidden:[],protected_paths:[],projection:{exclude:[]},import:{deny:[]}}}};
  const team=newTeam(task);task.team_binding={team_id:team.team_id,goal_revision:1};
  writeFileSync(join(options.tasksDir,`${task.task_id}.json`),JSON.stringify(task));
  createTeamRecord(options.runtimeDir,team);
  return {root,repo,task,team,options,git,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
export const plan=()=>['a','b','c'].map((id,i)=>({work_item_id:id,agent_id:`worker-${i+1}`,goal:`implement ${id}`,allowed_paths:[`src/${id}.mjs`],depends_on:id==='c'?['a','b']:[],output_contract:'export value'}));
export function adaptersFor(fx,{run=null,review=null}={}) {
  const pending=new Map();let concurrency=0,max=0;
  const adapter={type:'writer',run:async capsule=>{
    const context={capsule,kind:capsule.work_item_id,agent:capsule.agent_id};
    let payload;
    if(capsule.work_item_id==='plan')payload=output({work_items:plan()});
    else if(capsule.work_item_id==='coordinate')payload=output({retry_work_item_ids:['c']});
    else if(capsule.work_item_id==='integrate')payload=output({resolved_paths:[]});
    else {
      concurrency++;max=Math.max(max,concurrency);
      try {
        if(run)payload=await run(context,pending);
        if(!payload) {await delay(15);const value=capsule.work_item_id==='a'?1:capsule.work_item_id==='b'?2:3;writeFileSync(join(capsule.cwd,'src',`${capsule.work_item_id}.mjs`),`export const value = ${value};\n`);payload=output({applied_message_ids:JSON.parse(/MESSAGES: (.*)\n/.exec(capsule.prompt)[1]).map(m=>m.message_id)});}
      } finally {concurrency--;}
    }
    return {status:payload.cancelled?'cancelled':'completed',session_ref:`session-${capsule.runId}`,executor_run_id:capsule.runId,
      structured_result:{parsed:payload},writer_termination:END,exit_code:0};
  },cancel:async id=>{pending.get(id)?.(output({cancelled:true}));}};
  const reviewer={type:'reviewer',run:async capsule=>({status:'completed',session_ref:`review-${capsule.runId}`,structured_result:{result:JSON.stringify(review?review(capsule):{
    task_id:capsule.task_id,revision:Number(/REVISION UNDER REVIEW: (\d+)/.exec(capsule.prompt)[1]),decision:'PASS',summary:'verified',issues:[],required_changes:[],evidence:['src/c.mjs:1'],
  })},writer_termination:END,exit_code:0})};
  return {adapters:{writer:adapter,reviewer},select:id=>({writer:adapter,reviewer})[id],max:()=>max};
}
export async function drive(controller,predicate,{timeout=8000}={}) {
  const end=Date.now()+timeout;
  while(Date.now()<end){await controller.tick();if(predicate())return;await delay(10);}
  const team=controller.read('TEAM-TASK-TEAM');
  throw new Error(`team did not settle: ${JSON.stringify({state:team.state,reason:team.failure_reason,goal_revision:team.goal_revision,work_items:team.work_items.map(({work_item_id,status,revision})=>({work_item_id,status,revision})),recent_runs:team.runs.slice(-4).map(({kind,status,error})=>({kind,status,error}))})}`);
}
