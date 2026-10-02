import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, output, drive, END } from './helpers/team-fixture.mjs';
import { plannerFixture } from './helpers/planner-team-fixture.mjs';
import { readTeam, teamView } from '../lib/team/store.mjs';
import { TeamController } from '../lib/team/controller.mjs';
import { agentProfile, workerProfiles } from '../lib/team/planner.mjs';
import { runReview } from '../lib/task-execution.mjs';
import { invalidateItems } from '../lib/team/model.mjs';

async function propose(fx,c) {fx.send({type:'propose_plan'});await drive(c,()=>c.read(fx.team.team_id).state==='PLAN_READY');}
function approve(fx,c,extra={}) {
  const team=c.read(fx.team.team_id);
  fx.send({type:'approve_plan',expected_plan_revision:team.plan_revision,expected_goal_revision:team.goal_revision,...extra});
}

test('Planner chat and plan proposals never dispatch workers before human confirmation; mixed models reach real capsules',async()=>{
  const fx=plannerFixture(),c=new TeamController({...fx.options,...fx.io,autoDeliver:false});
  try {
    fx.send({type:'message',agent_id:'lead',message:'讨论目标与约束'},'CMD-chat');
    await drive(c,()=>c.read(fx.team.team_id).commands['CMD-chat']?.status==='applied');
    assert.equal(c.read(fx.team.team_id).state,'DISCUSSING');
    assert.ok(c.read(fx.team.team_id).messages.some(m=>m.to_agent_id==='operator'&&m.from_run_id&&m.message.includes('建议')));
    await propose(fx,c);for(let i=0;i<3;i++)await c.tick();
    assert.equal(fx.calls.filter(x=>['a','b','c'].includes(x.work_item_id)).length,0);
    fx.send({type:'start'},'CMD-no-bypass');await c.tick();assert.equal(c.read(fx.team.team_id).commands['CMD-no-bypass'].status,'rejected');
    fx.send({type:'approve_plan',expected_plan_revision:0,expected_goal_revision:1},'CMD-stale');await c.tick();assert.equal(c.read(fx.team.team_id).commands['CMD-stale'].code,'TEAM_VERSION_CONFLICT');
    approve(fx,c,{workers:[{executor_type:'writer',model:'worker-fast'},{executor_type:'writer',model:'worker-deep'}],assignments:{a:'worker-1',b:'worker-2',c:'worker-2'}});
    await drive(c,()=>c.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    assert.equal(fx.calls.find(x=>x.work_item_id==='discuss').model,'planning-model');
    assert.equal(fx.calls.find(x=>x.work_item_id==='a').model,'worker-fast');
    assert.equal(fx.calls.find(x=>x.work_item_id==='c').model,'worker-deep');
    assert.equal(teamView(fx.options.runtimeDir,fx.team.team_id).planning.approved_plan_revision,1);
  } finally {await c.close();fx.cleanup();}
});

test('Planner can recommend worker count and dispatch automatically, then the same model reviews in a fresh session',async()=>{
  const fx=plannerFixture({dispatch:'planner',proposal:()=>output({summary:'由一位 Worker 顺序完成。',workers:[{executor_type:'writer',model:'worker-model'}],work_items:plan().map(i=>({...i,agent_id:'worker-1'}))})});
  const c=new TeamController({...fx.options,...fx.io});
  try {
    fx.send({type:'propose_plan'});await drive(c,()=>c.read(fx.team.team_id).state==='COMPLETED');
    const team=c.read(fx.team.team_id);
    assert.equal(team.members.filter(m=>m.role==='worker').length,1);assert.equal(team.delivery.phase,'PROMOTED');
    const review=fx.calls.find(x=>x.assigned_role==='reviewer');assert.equal(review.model,'planning-model');
    assert.ok(!team.runs.some(r=>r.session_ref==='review-'+review.runId));
  }finally{await c.close();fx.cleanup();}
});

test('changing active work stops the old attempt and holds its dependents until Planner issues a new direction',async()=>{
  let held=false,releaseRevision;
  const fx=plannerFixture({run:async({capsule,kind},pending)=>kind==='a'&&!held?(held=true,new Promise(resolve=>pending.set(capsule.runId,resolve))):null,
    revise:capsule=>new Promise(resolve=>{releaseRevision=()=>resolve(output({summary:'新的 API 方向已下达。',work_items:readTeam(fx.options.runtimeDir,fx.team.team_id).work_items.map(i=>({...i,goal:i.work_item_id==='a'?'Planner issued a new API direction':i.goal}))}));})});
  const c=new TeamController({...fx.options,...fx.io,autoDeliver:false});
  try {
    await propose(fx,c);approve(fx,c);
    await drive(c,()=>held&&c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b')?.status==='DONE');
    const peer=c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id;
    fx.send({type:'adjust',work_item_id:'a',expected_revision:1,message:'细化接口目标'},'CMD-refine');
    await drive(c,()=>Boolean(releaseRevision));
    assert.equal(c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='a').status,'HELD');
    assert.equal(c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='c').status,'HELD');
    assert.equal(fx.calls.filter(x=>x.work_item_id==='a').length,1);
    assert.equal(c.read(fx.team.team_id).commands['CMD-refine'].status,'received');
    releaseRevision();await drive(c,()=>c.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const team=c.read(fx.team.team_id);
    assert.equal(team.work_items.find(i=>i.work_item_id==='b').artifact_id,peer);
    assert.equal(team.work_items.find(i=>i.work_item_id==='a').goal,'Planner issued a new API direction');
    assert.ok(team.runs.some(r=>r.work_item_id==='a'&&r.status==='DISCARDED'));
    assert.ok(team.commands['CMD-refine'].evidence.planner_run_id);
    assert.equal(team.rework_requests[0].status,'applied');
  }finally{releaseRevision?.();await c.close();fx.cleanup();}
});

test('review rejects missing session identity or reuse of any earlier Planner/Worker session',async()=>{
  const fx=plannerFixture();
  try {
    fx.task.red_lines=[];fx.task.review_rules=[];fx.task.team_writer_sessions=[{executor_type:'writer',session_ref:'old-planner-session'}];
    for(const session_ref of [null,'old-planner-session']) {
      await assert.rejects(runReview(fx.task,1,{writer:{type:'writer',run:async()=>({status:'completed',session_ref,structured_result:{result:'{}'},writer_termination:END})}},{requireIndependentExecutor:true}),/fresh session/);
    }
  }finally{fx.cleanup();}
});

test('agent configuration rejects unavailable executors, unsupported overrides and malformed models',()=>{
  assert.throws(()=>agentProfile({executor_type:'unknown'},{allowed:['codex']}),/not available/);
  assert.throws(()=>agentProfile({executor_type:'dsh',model:'pretend-model'},{allowed:['dsh']}),/does not support/);
  assert.throws(()=>agentProfile({executor_type:'codex',model:'bad\nmodel'},{allowed:['codex']}),/control characters/);
  assert.throws(()=>workerProfiles(Array.from({length:9},()=>({executor_type:'codex'}))),/1..8/);
});

test('restart preserves an unapproved plan and resuming a paused proposal cannot dispatch it',async()=>{
  const fx=plannerFixture();let c=new TeamController({...fx.options,...fx.io,autoDeliver:false});
  try {
    await propose(fx,c);fx.send({type:'pause'});await c.tick();assert.equal(c.read(fx.team.team_id).state,'PAUSED');
    await c.close();c=new TeamController({...fx.options,...fx.io,autoDeliver:false});await c.recover();
    fx.send({type:'resume'});await c.tick();assert.equal(c.read(fx.team.team_id).state,'PLAN_READY');
    assert.equal(fx.calls.filter(x=>['a','b','c'].includes(x.work_item_id)).length,0);
    approve(fx,c);await drive(c,()=>c.read(fx.team.team_id).state==='READY_FOR_REVIEW');
  }finally{await c.close();fx.cleanup();}
});

test('an interrupted plan proposal keeps its planning gate across controller recovery',async()=>{
  const fx=plannerFixture();let c=new TeamController({...fx.options,...fx.io,autoDeliver:false});
  try {
    await propose(fx,c);
    c.update(fx.team.team_id,'interrupted-proposal',null,t=>{t.state='PLANNING';t.runs.push({run_id:'RUN-interrupted-plan',agent_id:'lead',work_item_id:'plan',kind:'plan',status:'RUNNING',owner_token:'old-owner',writer_termination:END});t.members[0].status='RUNNING';});
    await c.close();c=new TeamController({...fx.options,...fx.io,autoDeliver:false});await c.recover();
    assert.equal(c.read(fx.team.team_id).state,'PLANNING');
    await drive(c,()=>c.read(fx.team.team_id).state==='PLAN_READY');
    assert.equal(fx.calls.filter(x=>['a','b','c'].includes(x.work_item_id)).length,0);
  }finally{await c.close();fx.cleanup();}
});

test('a partially persisted change request resumes through Planner once after restart',async()=>{
  const fx=plannerFixture();let c=new TeamController({...fx.options,...fx.io,autoDeliver:false});
  try {
    await propose(fx,c);approve(fx,c);await drive(c,()=>c.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const peer=c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id;
    fx.send({type:'adjust',work_item_id:'a',expected_revision:1,message:'new direction'},'CMD-partial-planner');
    c.update(fx.team.team_id,'crash-before-notification',null,t=>{
      invalidateItems(t,['a','c']);for(const wi of t.work_items)if(['a','c'].includes(wi.work_item_id))wi.status='HELD';
      t.rework_requests.push({request_id:'CMD-partial-planner',work_item_id:'a',work_item_revision:2,affected_items:['a','c'],feedback:'new direction',agent_id:'worker-1',status:'queued'});
      t.commands['CMD-partial-planner']={type:'adjust',status:'received',effect_committed:true,effect_revision:2,affected_items:['a','c']};
    });
    await c.close();c=new TeamController({...fx.options,...fx.io,autoDeliver:false});await c.recover();
    await drive(c,()=>c.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const team=c.read(fx.team.team_id);assert.equal(team.work_items.find(i=>i.work_item_id==='a').revision,2);
    assert.equal(team.work_items.find(i=>i.work_item_id==='b').artifact_id,peer);
    assert.equal(team.runs.filter(r=>r.kind==='revise').length,1);assert.equal(team.commands['CMD-partial-planner'].status,'applied');
  }finally{await c.close();fx.cleanup();}
});

test('Planner cannot change an unrelated accepted definition during local revision',async()=>{
  const fx=plannerFixture({revise:()=>output({summary:'bad revision',work_items:readTeam(fx.options.runtimeDir,fx.team.team_id).work_items.map(i=>({...i,goal:i.work_item_id==='b'?'unrequested change':i.goal}))})});
  const c=new TeamController({...fx.options,...fx.io,autoDeliver:false});
  try {
    await propose(fx,c);approve(fx,c);await drive(c,()=>c.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    fx.send({type:'adjust',work_item_id:'a',expected_revision:1,message:'refine a'});
    await drive(c,()=>c.read(fx.team.team_id).state==='BLOCKED');
    assert.equal(c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='a').status,'HELD');
    assert.equal(c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').goal,'implement b');
  }finally{await c.close();fx.cleanup();}
});
