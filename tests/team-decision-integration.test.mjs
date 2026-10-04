import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plannerFixture} from './helpers/planner-team-fixture.mjs';
import {drive,delay,output,plan} from './helpers/team-fixture.mjs';
import {TeamController} from '../lib/team/controller.mjs';
import {proposePlannerDecision} from '../lib/team/decision-advisor.mjs';
import {teamView} from '../lib/team/store.mjs';
import {startReadApi} from '../server/read-api.mjs';

const KEY='test-jev-private-key';
const ENV={AF_DECISION_MODEL:'jev',AF_TYPESAFE_API_KEY:KEY};
function response({questions},confidence=.93) {
  return {ok:true,provider:'jev',model:'untrusted-provider-model',answers:Object.fromEntries(Object.entries(questions).map(([name,q])=>{
    let choice=Object.keys(q.criteria)[0];
    if(name==='worker_count')choice='count_3';
    if(name.startsWith('worker_')&&Object.keys(q.criteria).length>1){
      const i=Number(name.slice(7));
      const model=i===1?'worker-fast':i===2?'worker-deep':'worker-model',effort=i===1?'low':i===2?'high':'medium';
      choice=Object.entries(q.criteria).find(([,label])=>label===`writer; model=${model}; effort=${effort}`)?.[0]??choice;
    }
    if(name.startsWith('retry_'))choice=name==='retry_c'?'yes':'no';
    return [name,{type:'choice',choice,confidence}];
  }))};
}
function advisor(decideImpl=response) {return options=>proposePlannerDecision({...options,decideImpl});}
function controller(fx,extra={}) {return new TeamController({...fx.options,...fx.io,autoDeliver:false,decisionEnv:ENV,decisionAdvisor:advisor(),...extra});}
async function propose(fx,c){fx.send({type:'propose_plan'});await drive(c,()=>c.read(fx.team.team_id).state==='PLAN_READY');}
function approve(fx,c){const t=c.read(fx.team.team_id);fx.send({type:'approve_plan',expected_plan_revision:t.plan_revision,expected_goal_revision:t.goal_revision});}

test('Jev suggestions reach Planner, remain current after proposal acceptance and cannot bypass confirmation',async()=>{
  let advice;
  const fx=plannerFixture({proposal:capsule=>{
    advice=JSON.parse(/JEV_ADVISORY: (.*)\n/.exec(capsule.prompt)[1]);
    return output({work_items:plan(),workers:advice.recommendation.workers});
  }}),c=controller(fx);
  try {
    fx.send({type:'message',message:'先商讨目标'});await drive(c,()=>fx.calls.some(x=>x.work_item_id==='discuss')&&c.running.size===0);
    assert.equal(c.read(fx.team.team_id).planner_decisions,undefined,'ordinary discussion makes no decision request');
    await propose(fx,c);
    const t=teamView(fx.options.runtimeDir,fx.team.team_id),d=t.planner_decisions.at(-1);
    assert.equal(advice.status,'suggested');assert.equal(d.confidence,.93);assert.equal(d.model,'jev-latest');
    assert.equal(d.work_revision,t.work_revision);assert.ok(d.context_work_revision<d.work_revision);
    assert.deepEqual(t.members.filter(m=>m.role==='worker').map(m=>[m.model,m.effort]),[['worker-fast','low'],['worker-deep','high'],['worker-model','medium']]);
    assert.equal(fx.calls.filter(x=>['a','b','c'].includes(x.work_item_id)).length,0);
    assert.ok(!JSON.stringify(t.planner_decisions).includes(KEY));
    approve(fx,c);await drive(c,()=>c.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    assert.equal(fx.calls.find(x=>x.work_item_id==='a').model,'worker-fast');
  }finally{await c.close();fx.cleanup();}
});

for(const [label,decideImpl,status] of [
  ['low-confidence',x=>response(x,.4),'low_confidence'],
  ['provider failure',async()=>{throw new Error(KEY);},'unavailable'],
  ['malformed choice',x=>{const r=response(x);r.answers.worker_count.choice='count_900';return r;},'invalid'],
])test(`${label} keeps normal Planner behavior and the human confirmation gate`,async()=>{
  const fx=plannerFixture(),c=controller(fx,{decisionAdvisor:advisor(decideImpl)});
  try{await propose(fx,c);const t=c.read(fx.team.team_id);assert.equal(t.planner_decisions.at(-1).status,status);assert.equal(t.state,'PLAN_READY');assert.equal(t.members.length,4);assert.ok(!JSON.stringify(t.planner_decisions).includes(KEY));assert.ok(!fx.calls.some(x=>x.work_item_id==='a'));}
  finally{await c.close();fx.cleanup();}
});

test('pausing during Jev consultation aborts it without starting or signalling an Agent, and ignores late answers',async()=>{
  const fx=plannerFixture();let release,signal,cancels=0;
  const oldCancel=fx.io.adapters.writer.cancel;fx.io.adapters.writer.cancel=async id=>{cancels++;await oldCancel(id);};
  const c=controller(fx,{decisionAdvisor:advisor(input=>{signal=input.signal;return new Promise(done=>{release=()=>done(response(input));});})});
  try{
    fx.send({type:'propose_plan'});await drive(c,()=>Boolean(release));
    assert.equal(c.read(fx.team.team_id).planner_decisions.at(-1).status,'consulting');
    fx.send({type:'pause'},'CMD-pause-consult');await c.tick();
    let t=c.read(fx.team.team_id);
    assert.equal(t.state,'PAUSED');assert.equal(signal.aborted,true);assert.equal(cancels,0);assert.equal(fx.calls.length,0);
    assert.equal(t.runs.at(-1).status,'DISCARDED');assert.equal(t.runs.at(-1).writer_termination.scope_kind,'none');
    assert.equal(t.runs.at(-1).writer_termination.process_started,false);assert.equal(t.planner_decisions.at(-1).status,'superseded');
    const sequence=t.sequence;release();await delay(20);t=c.read(fx.team.team_id);assert.equal(t.sequence,sequence);assert.equal(fx.calls.length,0);
    c.decisionAdvisor=advisor();fx.send({type:'resume'});await c.tick();assert.equal(c.read(fx.team.team_id).state,'DISCUSSING');await propose(fx,c);
    assert.equal(c.read(fx.team.team_id).planner_decisions.at(-1).status,'suggested');
  }finally{release?.();await c.close();fx.cleanup();}
});

test('new Planner input supersedes an in-flight advisory and is included in the next proposal',async()=>{
  const fx=plannerFixture();let release,requests=0;
  const c=controller(fx,{decisionAdvisor:advisor(input=>{requests++;if(requests>1)return response(input);return new Promise(done=>{release=()=>done(response(input));});})});
  try{
    fx.send({type:'propose_plan'});await drive(c,()=>Boolean(release));
    fx.send({type:'message',agent_id:'lead',message:'新增约束：保留现有接口'},'CMD-new-constraint');await c.tick();
    release();await drive(c,()=>c.read(fx.team.team_id).state==='PLAN_READY');
    const t=c.read(fx.team.team_id);assert.equal(t.planner_decisions[0].status,'superseded');assert.equal(t.planner_decisions.at(-1).status,'suggested');
    assert.equal(fx.calls.filter(x=>x.work_item_id==='plan').length,1);assert.match(fx.calls.find(x=>x.work_item_id==='plan').prompt,/新增约束/);
  }finally{release?.();await c.close();fx.cleanup();}
});

test('operator revision reaches Jev after the old Worker stops and retains unrelated accepted work',async()=>{
  let held=false,reviseState;
  const fx=plannerFixture({run:async({capsule,kind},pending)=>{if(kind==='a'&&!held){held=true;return new Promise(done=>pending.set(capsule.runId,done));}}});
  const c=controller(fx,{decisionAdvisor:advisor(input=>{if(input.state.operation==='revise')reviseState=input.state;return response(input);})});
  try{
    await propose(fx,c);approve(fx,c);await drive(c,()=>held&&c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b')?.status==='DONE');
    const peer=c.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id;
    fx.send({type:'adjust',work_item_id:'a',expected_revision:1,message:'拒绝非有限数值'},'CMD-revise-jev');
    await drive(c,()=>c.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const t=c.read(fx.team.team_id);assert.ok(t.runs.some(r=>r.work_item_id==='a'&&r.status==='DISCARDED'));
    assert.equal(reviseState.rework_request.feedback,'拒绝非有限数值');assert.deepEqual(reviseState.rework_request.affected_items,['a','c']);
    assert.equal(t.work_items.find(i=>i.work_item_id==='b').artifact_id,peer);assert.equal(t.planner_decisions.at(-1).kind,'revise');
    assert.equal(t.planner_decisions.at(-1).work_revision,t.work_revision);
  }finally{await c.close();fx.cleanup();}
});

test('capabilities expose only configuration status, perform no scan, and pass private env to the existing controller launcher',async()=>{
  const fx=plannerFixture();let launchEnv,scans=0;
  const env={...ENV,AF_WEB_TOKEN:'test-write-token',AF_WEB_TOKEN_FILE:''};
  const server=await startReadApi({roots:{tasks:fx.options.tasksDir,locks:fx.options.locksDir,runtime:fx.options.runtimeDir},env,allowRecord:true,redact:false,
    ensureController:async input=>{launchEnv=input.env;},agentDiscoverer:()=>[],catalogScanner:async()=>{scans++;throw new Error('forbidden scan');}});
  try{
    const packet=await (await fetch(server.url+'/api/v2/capabilities')).json();assert.equal(packet.model.planner_decision.available,true);assert.equal(scans,0);
    assert.ok(!JSON.stringify(packet).includes(KEY));assert.ok(!JSON.stringify(packet.model.planner_decision).includes('endpoint'));
    const res=await fetch(server.url+`/api/teams/${fx.team.team_id}/commands`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer test-write-token','x-af-csrf':'1'},body:JSON.stringify({command:{type:'message',message:'讨论'},command_id:'CMD-private-env'})});
    assert.equal(res.status,202);assert.equal(launchEnv.AF_TYPESAFE_API_KEY,KEY);assert.equal(scans,0);
  }finally{await server.close();fx.cleanup();}
});
