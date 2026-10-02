import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,adaptersFor,plan,output,drive,END,delay} from './helpers/team-fixture.mjs';
import {TeamController} from '../lib/team/controller.mjs';
import {submitTeamCommand,pendingCommands} from '../lib/team/store.mjs';
import {invalidateItems} from '../lib/team/model.mjs';
import {reapOrphanRuns} from '../lib/orphan-reaper.mjs';

const submit=(fx,command,commandId)=>submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command,commandId});

test('restart retries an interrupted scope with journaled termination and preserves accepted peers',async()=>{
  const fx=fixture();let held=false;
  const io=adaptersFor(fx,{run:async({capsule,kind},pending)=>kind==='a'&&!held?(held=true,new Promise(resolve=>pending.set(capsule.runId,resolve))):null});
  let controller=new TeamController({...fx.options,...io,autoDeliver:false});
  try {
    submit(fx,{type:'start'});await drive(controller,()=>held&&controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b')?.status==='DONE');
    const artifact=controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id;
    await controller.close();controller=new TeamController({...fx.options,...io,autoDeliver:false});await controller.recover();
    assert.equal(controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id,artifact);
    await drive(controller,()=>controller.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const team=controller.read(fx.team.team_id);
    assert.equal(team.runs.filter(r=>r.work_item_id==='b'&&r.kind==='worker').length,1);
    assert.ok(team.runs.some(r=>r.work_item_id==='a'&&r.status==='INTERRUPTED'));
  }finally{await controller.close();fx.cleanup();}
});

test('pause and resume invalidate active work but retain completed peer artifacts',async()=>{
  const fx=fixture();let held=false;
  const io=adaptersFor(fx,{run:async({capsule,kind},pending)=>kind==='a'&&!held?(held=true,new Promise(resolve=>pending.set(capsule.runId,resolve))):null});
  const controller=new TeamController({...fx.options,...io,autoDeliver:false});
  try {
    submit(fx,{type:'start'});await drive(controller,()=>held&&controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b')?.status==='DONE');
    const artifact=controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id;
    submit(fx,{type:'pause'},'CMD-pause');await controller.tick();assert.equal(controller.read(fx.team.team_id).state,'PAUSED');
    assert.equal(controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id,artifact);
    submit(fx,{type:'resume'});await drive(controller,()=>controller.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    assert.equal(controller.read(fx.team.team_id).runs.filter(r=>r.kind==='worker'&&r.work_item_id==='b').length,1);
  }finally{await controller.close();fx.cleanup();}
});

test('a partially committed adjustment resumes once after a controller restart',async()=>{
  const fx=fixture(),io=adaptersFor(fx);let controller=new TeamController({...fx.options,...io,autoDeliver:false});
  try {
    submit(fx,{type:'start'});await drive(controller,()=>controller.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    submit(fx,{type:'adjust',work_item_id:'a',expected_revision:1,message:'new direction'},'CMD-partial');
    controller.update(fx.team.team_id,'simulated-crash-boundary',null,t=>{
      invalidateItems(t,['a','c']);t.work_items.find(i=>i.work_item_id==='a').goal='new direction';
      t.commands['CMD-partial']={type:'adjust',status:'received',effect_committed:true,effect_revision:2,affected_items:['a','c']};
    });
    await controller.close();controller=new TeamController({...fx.options,...io,autoDeliver:false});await controller.recover();
    await drive(controller,()=>controller.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const team=controller.read(fx.team.team_id);assert.equal(team.commands['CMD-partial'].status,'applied');
    assert.equal(team.work_items.find(i=>i.work_item_id==='a').revision,2);
    assert.equal(team.runs.filter(r=>r.kind==='worker'&&r.work_item_id==='b').length,1);
  }finally{await controller.close();fx.cleanup();}
});

test('unconfirmed writers block restart and cannot be resumed or promoted',async()=>{
  const fx=fixture(),io=adaptersFor(fx);const original=io.adapters.writer.run;
  io.adapters.writer.run=async capsule=>({...await original(capsule),writer_termination:{process_started:true,termination_confirmed:false,scope_verified:false}});
  let controller=new TeamController({...fx.options,...io});
  try {
    submit(fx,{type:'start'});await drive(controller,()=>controller.read(fx.team.team_id).state==='RECOVERY_REQUIRED');
    await controller.close();controller=new TeamController({...fx.options,...io});await controller.recover();
    submit(fx,{type:'resume'},'CMD-unsafe');await controller.tick();
    assert.equal(controller.read(fx.team.team_id).state,'RECOVERY_REQUIRED');
    assert.equal(controller.read(fx.team.team_id).commands['CMD-unsafe'].status,'rejected');
    assert.equal(fx.git(['rev-parse','refs/afr/canonical']),fx.git(['rev-parse','HEAD']));
  }finally{await controller.close();fx.cleanup();}
});

test('plan replacement is fenced if the goal changes while old writers stop',async()=>{
  const fx=fixture(),io=adaptersFor(fx),controller=new TeamController({...fx.options,...io,autoDeliver:false});
  try {
    controller.update(fx.team.team_id,'planned',null,t=>{t.work_items=plan().map(i=>({...i,revision:1,status:'READY'}));t.state='WORKING';});
    let release;controller.stopItems=()=>new Promise(resolve=>{release=resolve;});
    const next=plan();next[0].goal='stale amendment';const accepting=controller.acceptPlan(fx.team.team_id,{work_items:next});
    await delay(1);controller.update(fx.team.team_id,'operator-new-goal',null,t=>{t.goal='operator goal';t.goal_revision++;t.state='PLANNING';});release();
    await assert.rejects(accepting,/superseded/);assert.equal(controller.read(fx.team.team_id).goal,'operator goal');
    assert.equal(controller.read(fx.team.team_id).state,'PLANNING');
  }finally{await controller.close();fx.cleanup();}
});

test('orphan scope verification persists a completion witness before removing its handle',async()=>{
  const fx=fixture(),runsDir=join(fx.options.runtimeDir,'runs');mkdirSync(runsDir,{recursive:true});
  const owner=987654,path=`/sys/fs/cgroup/af-writer-${owner}-test`;
  const handle={run_id:'RUN-orphan',team_id:fx.team.team_id,owner_token:'old-owner',pid:987655,owner_pid:owner,pgid:987655,
    writer_scope:{kind:'cgroup',path,owner_pid:owner,attached:true,verified:true}};
  const file=join(runsDir,'RUN-orphan.json');writeFileSync(file,JSON.stringify(handle));let witnessed=false;
  try {
    await reapOrphanRuns({runsDir,isAlive:()=>false,scopeReap:async()=>END,acceptHandle:h=>h.owner_token==='old-owner',
      onVerifiedTermination:async(h,evidence)=>{assert.ok(existsSync(file));assert.equal(h.run_id,handle.run_id);assert.equal(evidence.scope_empty,true);witnessed=true;}});
    assert.ok(witnessed);assert.equal(existsSync(file),false);
  }finally{fx.cleanup();}
});

test('modified inbox payloads are rejected before command execution',()=>{
  const fx=fixture();try {
    submit(fx,{type:'start'},'CMD-inbox');const file=join(fx.options.runtimeDir,'teams',fx.team.team_id,'inbox','CMD-inbox.json');
    const c=JSON.parse(readFileSync(file,'utf8'));c.command={type:'cancel'};writeFileSync(file,JSON.stringify(c));
    assert.throws(()=>pendingCommands(fx.options.runtimeDir,fx.team),/unverifiable/);
  }finally{fx.cleanup();}
});

test('late peer replies cannot revive a question from an invalidated work item',async()=>{
  const fx=fixture();let asked=false,releaseReply,controller;
  const io=adaptersFor(fx,{run:async({capsule,kind})=>{
    if(kind==='a'&&!asked) {
      asked=true;while(controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').status!=='DONE')await delay(10);
      return output({status:'blocked',messages:[{to_agent_id:'worker-2',work_item_id:'b',message:'old API request',reply_to:null}]});
    }
    const messages=JSON.parse(/MESSAGES: (.*)\n/.exec(capsule.prompt)[1]);
    if(kind==='b'&&messages.length)return new Promise(resolve=>{releaseReply=()=>resolve(output({messages:[{to_agent_id:'worker-1',work_item_id:'a',message:'obsolete API reply',reply_to:messages[0].message_id}],applied_message_ids:messages.map(m=>m.message_id)}));});
    return null;
  }});controller=new TeamController({...fx.options,...io,autoDeliver:false});
  try {
    submit(fx,{type:'start'});await drive(controller,()=>Boolean(releaseReply));
    const artifact=controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id;
    submit(fx,{type:'adjust',work_item_id:'a',expected_revision:1,message:'new interface contract'});await controller.tick();
    assert.equal(controller.read(fx.team.team_id).messages.find(m=>m.message==='old API request').status,'superseded');
    releaseReply();await drive(controller,()=>controller.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const team=controller.read(fx.team.team_id);assert.equal(team.messages.some(m=>m.message==='obsolete API reply'),false);
    assert.equal(team.work_items.find(i=>i.work_item_id==='b').artifact_id,artifact);
  }finally{releaseReply?.();await controller.close();fx.cleanup();}
});

for(const resolve of [false,true])test(`overlapping edits ${resolve?'are explicitly resolved by the lead':'cannot pass integration without a resolution receipt'}`,async()=>{
  const fx=fixture(),io=adaptersFor(fx),original=io.adapters.writer.run;
  io.adapters.writer.run=async capsule=>{
    if(capsule.work_item_id==='plan') {const p=plan();p[1].allowed_paths=['src/a.mjs'];p[2].depends_on=['a'];return {status:'completed',session_ref:capsule.runId,writer_termination:END,structured_result:{parsed:output({work_items:p})}};}
    if(capsule.work_item_id==='b') {writeFileSync(join(capsule.cwd,'src/a.mjs'),'export const value = 2;\n');return {status:'completed',session_ref:capsule.runId,writer_termination:END,structured_result:{parsed:output()}};}
    if(capsule.work_item_id==='integrate'&&resolve){writeFileSync(join(capsule.cwd,'src/a.mjs'),'export const value = 3;\n');return {status:'completed',session_ref:capsule.runId,writer_termination:END,structured_result:{parsed:output({resolved_paths:['src/a.mjs']})}};}
    return original(capsule);
  };
  const controller=new TeamController({...fx.options,...io,autoDeliver:false});
  try {
    submit(fx,{type:'start'});await drive(controller,()=>controller.read(fx.team.team_id).state===(resolve?'READY_FOR_REVIEW':'BLOCKED'));
    const team=controller.read(fx.team.team_id);
    if(resolve)assert.equal(team.integration.conflicts[0].path,'src/a.mjs');else assert.match(team.failure_reason,/resolve every/);
  }finally{await controller.close();fx.cleanup();}
});
