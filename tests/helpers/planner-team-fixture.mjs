import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, adaptersFor, plan, output, END } from './team-fixture.mjs';
import { readTeam, commitTeam, submitTeamCommand } from '../../lib/team/store.mjs';

export function plannerFixture({dispatch='human',run,revise,proposal,effort=null}={}) {
  const fx=fixture(),io=adaptersFor(fx,{run}),calls=[];
  fx.task.reviewer_executor='writer';fx.task.author_model='planning-model';fx.task.reviewer_model='planning-model';
  fx.task.team_review_policy={mode:'planner-model-fresh-session',team_id:fx.team.team_id,executor_type:'writer',model:'planning-model'};
  if(effort){fx.task.author_effort=effort;fx.task.reviewer_effort=effort;fx.task.team_review_policy.effort=effort;}
  writeFileSync(join(fx.options.tasksDir,fx.task.task_id+'.json'),JSON.stringify(fx.task));
  const team=readTeam(fx.options.runtimeDir,fx.team.team_id);
  team.state='DISCUSSING';team.rework_requests=[];
  team.members[0].model='planning-model';
  if(effort)team.members[0].effort=effort;
  const models=['planning-model','worker-fast','worker-deep','worker-model','new-planner-model','saved-model','selected-worker','next-attempt-model','operator-model'].map(id=>({id,label:id,reasoning_efforts:['low','medium','high']}));
  team.planning={workflow:'planner',dispatch_mode:dispatch,planner:{executor_type:'writer',model:'planning-model',...(effort?{effort}:{})},eligible_executors:[{executor_type:'writer',supports_model:true,supports_effort:true,default_model:'planning-model',reasoning_efforts:['low','medium','high'],models}],approved_plan_revision:null};
  commitTeam(fx.options.runtimeDir,team,'planner-fixture',null,()=>{});
  const original=io.adapters.writer.run;io.adapters.writer.supportsModel=true;
  io.adapters.writer.supportsFreshSession=true;
  io.adapters.writer.reasoningEfforts=['low','medium','high'];
  io.adapters.writer.run=async capsule=>{
    calls.push(capsule);
    if(capsule.assigned_role==='reviewer')return io.adapters.reviewer.run(capsule);
    let payload;
    if(capsule.work_item_id==='discuss')payload=output({summary:'建议先明确目标与验收，再确定分工。'});
    if(capsule.work_item_id==='plan')payload=proposal?.(capsule)??output({summary:'建议三步协作：a 与 b 并行，c 整合。',work_items:plan(),workers:Array.from({length:3},()=>({executor_type:'writer',model:null}))});
    if(capsule.work_item_id==='revise') {
      payload=revise?await revise(capsule):output({summary:'已根据反馈重写目标，重新派发。',work_items:readTeam(fx.options.runtimeDir,fx.team.team_id).work_items.map(i=>({...i,goal:i.work_item_id==='a'?'Planner refined the interface based on operator feedback':i.goal}))});
    }
    return payload?{status:'completed',session_ref:'session-'+capsule.runId,structured_result:{parsed:payload},writer_termination:END,exit_code:0}:original(capsule);
  };
  const send=(command,commandId)=>submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command,commandId});
  return {...fx,io,calls,send};
}
