import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TeamController } from '../lib/team/controller.mjs';
import { sameModelTeamReview } from '../lib/team/planner.mjs';
import { plannerFixture } from './helpers/planner-team-fixture.mjs';
import { drive, output, plan } from './helpers/team-fixture.mjs';

const settings = (c, fx, extra = {}) => {
  const t=c.read(fx.team.team_id);
  return {type:'configure_agents',expected_goal_revision:t.goal_revision,expected_plan_revision:t.plan_revision,
    expected_agent_config_revision:t.planning.agent_config_revision??0,...extra};
};
const confirm = (c,fx) => {const t=c.read(fx.team.team_id);fx.send({type:'approve_plan',expected_goal_revision:t.goal_revision,expected_plan_revision:t.plan_revision,expected_agent_config_revision:t.planning.agent_config_revision??0});};
const controller = fx => new TeamController({...fx.options,...fx.io,select:id=>fx.io.adapters[id]});

test('saved Planner/Worker choices reach execution, and the latest Planner configuration binds the fresh Reviewer',async()=>{
  const fx=plannerFixture({effort:'low'}),c=controller(fx);
  fx.io.adapters.secondary={...fx.io.adapters.writer,type:'secondary'};
  c.update(fx.team.team_id,'test-catalog',null,t=>t.planning.eligible_executors.push({...t.planning.eligible_executors[0],executor_type:'secondary'}));
  try {
    fx.send(settings(c,fx,{planner:{executor_type:'secondary',model:'new-planner-model',effort:'high'},workers:[
      {executor_type:'writer',model:'worker-fast',effort:'low'},{executor_type:'secondary',model:'worker-deep',effort:'high'},{executor_type:'writer',model:null,effort:'medium'}]}),'CMD-config');
    await c.tick();assert.equal(c.read(fx.team.team_id).commands['CMD-config'].status,'applied');
    assert.equal(fx.calls.length,0,'saving configuration must not start any agent');
    fx.send({type:'message',agent_id:'lead',message:'商讨后再制定计划'},'CMD-chat');
    await drive(c,()=>c.read(fx.team.team_id).commands['CMD-chat']?.status==='applied');
    assert.equal(fx.calls.find(r=>r.work_item_id==='discuss').model,'new-planner-model');
    assert.equal(fx.calls.find(r=>r.work_item_id==='discuss').effort,'high');
    fx.send({type:'propose_plan'});await drive(c,()=>c.read(fx.team.team_id).state==='PLAN_READY');
    assert.equal(fx.calls.filter(r=>['a','b','c'].includes(r.work_item_id)).length,0);
    confirm(c,fx);await drive(c,()=>c.read(fx.team.team_id).state==='COMPLETED');
    assert.equal(fx.calls.find(r=>r.work_item_id==='a').model,'worker-fast');
    assert.equal(fx.calls.find(r=>r.work_item_id==='b').model,'worker-deep');
    assert.equal(fx.calls.find(r=>r.work_item_id==='b').effort,'high');
    const t=c.read(fx.team.team_id),task=JSON.parse(readFileSync(join(fx.options.tasksDir,t.delivery_task_id+'.json')));
    const review=fx.calls.find(r=>r.assigned_role==='reviewer');
    assert.equal(review.model,'new-planner-model');assert.equal(review.effort,'high');
    assert.equal(task.reviewer_executor,'secondary');assert.equal(sameModelTeamReview(task),true);
    assert.ok(!t.runs.some(r=>r.session_ref==='review-'+review.runId));
  }finally{await c.close();fx.cleanup();}
});

test('invalid model/effort/Agent changes are rejected without replacing the saved configuration',async()=>{
  const fx=plannerFixture(),c=controller(fx);
  try {
    for(const [n,planner] of [
      {executor_type:'missing',model:null},{executor_type:'writer',model:'bad\nmodel'},
      {executor_type:'writer',model:'model',effort:'ultra'}].entries()) {
      fx.send(settings(c,fx,{planner}),'CMD-invalid-'+n);await c.tick();
      assert.equal(c.read(fx.team.team_id).commands['CMD-invalid-'+n].status,'rejected');
    }
    assert.equal(c.read(fx.team.team_id).planning.planner.model,'planning-model');
    assert.equal(c.read(fx.team.team_id).planning.agent_config_revision??0,0);
    assert.equal(fx.calls.length,0);
  }finally{await c.close();fx.cleanup();}
});

test('saving uses fresh native model grades and a later incompatible grade blocks planning before any run',async()=>{
  const fx=plannerFixture();fx.io.adapters.codex={...fx.io.adapters.writer,type:'codex'};let grades=['low'];
  const c=new TeamController({...fx.options,...fx.io,select:id=>fx.io.adapters[id],autoDeliver:false,discoverCatalog:async()=>({status:'ready',model_source:'native model/list',checked_at:new Date().toISOString(),client_version:'test',models:[{id:'new-model',label:'New model',reasoning_efforts:grades,reasoning_status:'verified'}]})});
  try {
    c.update(fx.team.team_id,'test-catalog',null,t=>t.planning.eligible_executors.push({executor_type:'codex',supports_model:true,models:[{id:'new-model',reasoning_efforts:['high']}]}));
    fx.send(settings(c,fx,{planner:{executor_type:'codex',model:'new-model',effort:'low'}}),'CMD-fresh');await c.tick();
    assert.equal(c.read(fx.team.team_id).commands['CMD-fresh'].status,'applied');assert.equal(fx.calls.length,0);
    grades=['high'];fx.send({type:'propose_plan'},'CMD-incompatible');await c.tick();
    const rejected=c.read(fx.team.team_id);assert.equal(rejected.commands['CMD-incompatible'].status,'rejected');assert.match(rejected.commands['CMD-incompatible'].reason,/reasoning effort low/);
    assert.equal(rejected.state,'DISCUSSING');assert.equal(fx.calls.length,0);
    fx.send(settings(c,fx,{planner:{executor_type:'codex',model:'new-model',effort:'high'}}),'CMD-reselected');await c.tick();
    fx.send({type:'message',agent_id:'lead',message:'按确认后的强度商讨'},'CMD-verified-chat');
    await drive(c,()=>c.read(fx.team.team_id).commands['CMD-verified-chat']?.status==='applied');
    assert.equal(fx.calls[0].model,'new-model');assert.equal(fx.calls[0].effort,'high');
  }finally{await c.close();fx.cleanup();}
});

test('configuration uses version checks, survives restart, and duplicate commands do not apply twice',async()=>{
  const fx=plannerFixture();let c=controller(fx);
  try {
    const change=settings(c,fx,{planner:{executor_type:'writer',model:'saved-model',effort:'medium'}});
    fx.send(change,'CMD-save');await c.tick();
    fx.send({...change,planner:{executor_type:'writer',model:'stale-model'}},'CMD-stale');await c.tick();
    assert.equal(c.read(fx.team.team_id).commands['CMD-stale'].code,'TEAM_VERSION_CONFLICT');
    fx.send(change,'CMD-save');await c.tick();assert.equal(c.read(fx.team.team_id).planning.agent_config_revision,1);
    await c.close();c=controller(fx);await c.recover();
    assert.equal(c.read(fx.team.team_id).planning.planner.model,'saved-model');
    fx.send({type:'message',agent_id:'lead',message:'恢复后继续商讨'},'CMD-after-restart');
    await drive(c,()=>c.read(fx.team.team_id).commands['CMD-after-restart']?.status==='applied');
    assert.equal(fx.calls.find(r=>r.work_item_id==='discuss').model,'saved-model');
  }finally{await c.close();fx.cleanup();}
});

test('changing a proposal configuration invalidates earlier approval snapshots',async()=>{
  const fx=plannerFixture(),c=new TeamController({...fx.options,...fx.io,autoDeliver:false});
  try {
    fx.send({type:'propose_plan'});await drive(c,()=>c.read(fx.team.team_id).state==='PLAN_READY');
    const old=c.read(fx.team.team_id);
    fx.send(settings(c,fx,{workers:[{executor_type:'writer',model:'selected-worker',effort:'high'}]}));await c.tick();
    fx.send({type:'approve_plan',expected_goal_revision:old.goal_revision,expected_plan_revision:old.plan_revision},'CMD-old-plan');await c.tick();
    assert.equal(c.read(fx.team.team_id).commands['CMD-old-plan'].code,'TEAM_VERSION_CONFLICT');
    assert.equal(fx.calls.filter(r=>['a','b','c'].includes(r.work_item_id)).length,0);
    confirm(c,fx);await drive(c,()=>c.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    assert.ok(fx.calls.filter(r=>['a','b','c'].includes(r.work_item_id)).every(r=>r.model==='selected-worker'&&r.effort==='high'));
  }finally{await c.close();fx.cleanup();}
});

test('active Workers must stop before reconfiguration; paused changes apply only to later attempts and preserve peers',async()=>{
  let held=false;
  const fx=plannerFixture({run:async({capsule,kind},pending)=>kind==='a'&&!held?(held=true,new Promise(resolve=>pending.set(capsule.runId,resolve))):null});
  const c=new TeamController({...fx.options,...fx.io,autoDeliver:false});
  try {
    fx.send({type:'propose_plan'});await drive(c,()=>c.read(fx.team.team_id).state==='PLAN_READY');confirm(c,fx);
    await drive(c,()=>held&&c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b')?.status==='DONE');
    const peer=c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id;
    fx.send(settings(c,fx,{planner:{executor_type:'writer',model:'too-early'}}),'CMD-running');await c.tick();
    assert.equal(c.read(fx.team.team_id).commands['CMD-running'].status,'rejected');
    fx.send({type:'pause'});await c.tick();assert.equal(c.read(fx.team.team_id).state,'PAUSED');
    fx.send(settings(c,fx,{workers:[{executor_type:'writer',model:'wrong-count'}]}),'CMD-count');await c.tick();
    assert.equal(c.read(fx.team.team_id).commands['CMD-count'].status,'rejected');
    const workers=c.read(fx.team.team_id).members.filter(m=>m.role==='worker').map(m=>({...m,model:'next-attempt-model',effort:'high'}));
    fx.send(settings(c,fx,{workers}),'CMD-paused');await c.tick();assert.equal(c.read(fx.team.team_id).commands['CMD-paused'].status,'applied');
    fx.send({type:'resume'});await drive(c,()=>c.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    assert.equal(fx.calls.filter(r=>r.work_item_id==='a').at(-1).model,'next-attempt-model');
    assert.equal(c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id,peer);
    assert.ok(c.read(fx.team.team_id).runs.some(r=>r.work_item_id==='a'&&r.status==='DISCARDED'));
  }finally{await c.close();fx.cleanup();}
});

test('operator Worker presets constrain automatic Planner dispatch rather than being silently replaced',async()=>{
  const fx=plannerFixture({dispatch:'planner',proposal:()=>output({workers:[{executor_type:'writer',model:'ignored'}],work_items:plan().map(i=>({...i,agent_id:'worker-1'}))})}),c=controller(fx);
  try {
    fx.send(settings(c,fx,{workers:Array.from({length:2},()=>({executor_type:'writer',model:'operator-model',effort:'high'}))}));await c.tick();
    fx.send({type:'propose_plan'});await drive(c,()=>c.read(fx.team.team_id).state==='BLOCKED');
    assert.match(c.read(fx.team.team_id).failure_reason,/operator-selected Worker count/);
    assert.equal(fx.calls.filter(r=>['a','b','c'].includes(r.work_item_id)).length,0);
  }finally{await c.close();fx.cleanup();}
});
