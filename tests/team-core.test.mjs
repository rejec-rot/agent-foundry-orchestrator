import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {validatePlan} from '../lib/team/model.mjs';
import {readTeam,submitTeamCommand,teamView} from '../lib/team/store.mjs';
import {TeamController} from '../lib/team/controller.mjs';
import {fixture,adaptersFor,plan,output,drive,END,delay} from './helpers/team-fixture.mjs';

test('team plans reject unknown identities, cycles and duplicate work items',()=>{
  const fx=fixture();try {assert.equal(validatePlan({work_items:plan()},fx.team).length,3);
    assert.throws(()=>validatePlan({work_items:[...plan(),plan()[0]]},fx.team),/duplicate/);
    const cyclic=plan();cyclic[0].depends_on=['c'];assert.throws(()=>validatePlan({work_items:cyclic},fx.team),/cycle/);
    const forged=plan();forged[0].agent_id='intruder';assert.throws(()=>validatePlan({work_items:forged},fx.team),/unknown/);
  }finally{fx.cleanup();}
});
test('a lead and three managed workers execute concurrently, release dependencies and complete trusted delivery',async()=>{
  const fx=fixture(),io=adaptersFor(fx),controller=new TeamController({...fx.options,...io});
  try {
    submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command:{type:'start'}});
    await drive(controller,()=>controller.read(fx.team.team_id).state==='COMPLETED');
    const team=controller.read(fx.team.team_id);
    assert.ok(io.max()>=2,'independent work items really overlap');
    assert.equal(team.members.length,4);assert.ok(team.work_items.every(i=>i.status==='DONE'));
    const c=team.runs.find(r=>r.work_item_id==='c');assert.equal(c.input_artifact_ids.length,2);
    assert.equal(team.delivery.phase,'PROMOTED');assert.match(fx.git(['show','refs/afr/canonical:src/c.mjs']),/value = 3/);
    assert.notEqual(fx.git(['rev-parse','refs/afr/canonical']),team.baseline.oid);
  }finally{await controller.close();fx.cleanup();}
});
test('adjusting one worker discards its old attempt and preserves unrelated accepted work',async()=>{
  const fx=fixture();let held=false;
  const io=adaptersFor(fx,{run:async({capsule,kind},pending)=>{
    if(kind==='a' && !held){held=true;return new Promise(resolve=>pending.set(capsule.runId,resolve));}
    return null;
  }});const controller=new TeamController({...fx.options,...io,autoDeliver:false});
  try {
    submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command:{type:'start'}});
    await drive(controller,()=>held&&controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b')?.status==='DONE');
    const original=controller.read(fx.team.team_id),b=original.work_items.find(i=>i.work_item_id==='b').artifact_id;
    const cmd={runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,commandId:'CMD-adjust',command:{type:'adjust',work_item_id:'a',expected_revision:1,message:'implement a with new direction'}};
    submitTeamCommand(cmd);submitTeamCommand(cmd);
    await drive(controller,()=>controller.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const team=controller.read(fx.team.team_id);
    assert.equal(team.work_items.find(i=>i.work_item_id==='a').revision,2);
    assert.equal(team.work_items.find(i=>i.work_item_id==='b').artifact_id,b);
    assert.equal(team.commands['CMD-adjust'].status,'applied');
    assert.ok(team.runs.some(r=>r.work_item_id==='a'&&r.status==='DISCARDED'));
    assert.throws(()=>submitTeamCommand({...cmd,command:{...cmd.command,message:'different'}}),/reused/);
    submitTeamCommand({...cmd,commandId:'CMD-stale'});await controller.tick();
    assert.equal(controller.read(fx.team.team_id).commands['CMD-stale'].status,'rejected');
  }finally{await controller.close();fx.cleanup();}
});
test('member requests reach another worker and replies wake a blocked work item',async()=>{
  const fx=fixture();let asked=false;
  const io=adaptersFor(fx,{run:async({capsule,kind})=>{
    const messages=JSON.parse(/MESSAGES: (.*)\n/.exec(capsule.prompt)[1]);
    if(kind==='a'&&!asked){asked=true;return output({status:'blocked',summary:'waiting for b interface',messages:[{to_agent_id:'worker-2',work_item_id:'b',message:'provide your API',reply_to:null}]});}
    if(kind==='b'&&messages.length)return output({messages:[{to_agent_id:'worker-1',work_item_id:'a',message:'export value from src/b.mjs',reply_to:messages[0].message_id}],applied_message_ids:messages.map(m=>m.message_id)});
    return null;
  }});const controller=new TeamController({...fx.options,...io,autoDeliver:false});
  try {
    submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command:{type:'start'}});
    await drive(controller,()=>controller.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const view=teamView(fx.options.runtimeDir,fx.team.team_id);
    assert.ok(view.messages.some(m=>m.reply_to&&m.from_agent_id==='worker-2'&&m.to_agent_id==='worker-1'));
    assert.ok(view.runs.filter(r=>r.work_item_id==='a').length>=2);
  }finally{await controller.close();fx.cleanup();}
});
test('team journal rejects tampering and competing controllers cannot acquire ownership',async()=>{
  const fx=fixture(),io=adaptersFor(fx),controller=new TeamController({...fx.options,...io,autoDeliver:false});
  try {
    assert.throws(()=>new TeamController({...fx.options,...io}),/TASK_ALREADY_RUNNING/);
    const file=join(fx.options.runtimeDir,'teams',fx.team.team_id,'journal','0000000001.json');
    const record=JSON.parse(readFileSync(file,'utf8'));record.state.goal='changed';writeFileSync(file,JSON.stringify(record));
    assert.throws(()=>readTeam(fx.options.runtimeDir,fx.team.team_id),/unverifiable/);
  }finally{await controller.close();fx.cleanup();}
});
test('review feedback reruns the selected work item while preserving unrelated worker outputs',async()=>{
  const fx=fixture();let reviews=0;
  const io=adaptersFor(fx,{review:capsule=>({task_id:capsule.task_id,revision:Number(/REVISION UNDER REVIEW: (\d+)/.exec(capsule.prompt)[1]),decision:reviews++===0?'NEEDS_FIX':'PASS',summary:'check c',issues:[],required_changes:['review and improve src/c.mjs'],evidence:['src/c.mjs:1']})});
  const controller=new TeamController({...fx.options,...io});
  try {
    submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command:{type:'start'}});
    await drive(controller,()=>controller.read(fx.team.team_id).state==='COMPLETED');
    const team=controller.read(fx.team.team_id);
    assert.equal(team.runs.filter(r=>r.kind==='worker'&&r.work_item_id==='a').length,1);
    assert.equal(team.runs.filter(r=>r.kind==='worker'&&r.work_item_id==='b').length,1);
    assert.equal(team.runs.filter(r=>r.kind==='worker'&&r.work_item_id==='c').length,2);
    assert.equal(team.delivery_runs.length,2);assert.ok(team.delivery_runs.every(r=>r.status==='COMPLETED'));
  }finally{await controller.close();fx.cleanup();}
});

test('adjusting a completed goal creates a new revision from the promoted canonical baseline',async()=>{
  const fx=fixture(),io=adaptersFor(fx,{run:async({capsule,kind})=>{
    if(kind==='a'&&capsule.prompt.includes('second version')) {writeFileSync(join(capsule.cwd,'src/a.mjs'),'export const value = 4;\n');return output();}
    return null;
  }}),controller=new TeamController({...fx.options,...io});
  try {
    submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command:{type:'start'}});
    await drive(controller,()=>controller.read(fx.team.team_id).state==='COMPLETED');
    const canonical=fx.git(['rev-parse','refs/afr/canonical']);
    submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,commandId:'CMD-next-goal',command:{type:'adjust',work_item_id:'a',expected_revision:1,message:'second version: set a to 4'}});
    await drive(controller,()=>controller.read(fx.team.team_id).state==='COMPLETED'&&controller.read(fx.team.team_id).goal_revision===2);
    const team=controller.read(fx.team.team_id);assert.equal(team.baseline.oid,canonical);
    assert.match(fx.git(['show','refs/afr/canonical:src/a.mjs']),/value = 4/);
    assert.notEqual(team.delivery_task_id,fx.task.task_id);
    assert.equal(JSON.parse(readFileSync(join(fx.options.tasksDir,`${fx.task.task_id}.json`),'utf8')).state,'COMPLETED');
  }finally{await controller.close();fx.cleanup();}
});

test('a fresh delivery generation cannot replenish the current goal review budget',async()=>{
  const fx=fixture();let reviews=0;
  const io=adaptersFor(fx,{review:capsule=>({task_id:capsule.task_id,revision:Number(/REVISION UNDER REVIEW: (\d+)/.exec(capsule.prompt)[1]),decision:'NEEDS_FIX',summary:'still needs work',issues:[],required_changes:['fix c'],evidence:['src/c.mjs:1']})});
  const original=io.adapters.reviewer.run;io.adapters.reviewer.run=async capsule=>{reviews++;return original(capsule);};
  const controller=new TeamController({...fx.options,...io});
  try {
    submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command:{type:'start'}});
    await drive(controller,()=>controller.read(fx.team.team_id).state==='BLOCKED');assert.equal(reviews,2);
    submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command:{type:'deliver'}});
    await drive(controller,()=>controller.read(fx.team.team_id).failure_reason?.includes('budget exhausted'));
    assert.equal(reviews,2);assert.equal(readdirSync(fx.options.tasksDir).filter(n=>n.endsWith('.json')).length,1);
  }finally{await controller.close();fx.cleanup();}
});

test('continuing an unapproved Human Gate keeps the same task and does not poll or dispatch again',async()=>{
  const fx=fixture(),io=adaptersFor(fx),controller=new TeamController({...fx.options,...io,autoDeliver:false});
  try {
    submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command:{type:'start'}});
    await drive(controller,()=>controller.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const task=JSON.parse(readFileSync(join(fx.options.tasksDir,`${fx.task.task_id}.json`),'utf8'));task.state='WAITING_HUMAN';task.trusted_import.phase='WAITING_HUMAN';
    writeFileSync(join(fx.options.tasksDir,`${fx.task.task_id}.json`),JSON.stringify(task));
    controller.update(fx.team.team_id,'parked-fixture',null,t=>{t.state='WAITING_HUMAN';});controller.autoDeliver=true;
    submitTeamCommand({runtimeDir:fx.options.runtimeDir,teamId:fx.team.team_id,command:{type:'deliver'}});
    await drive(controller,()=>controller.read(fx.team.team_id).state==='WAITING_HUMAN'&&controller.read(fx.team.team_id).delivery?.status==='WAITING_HUMAN');
    const team=controller.read(fx.team.team_id);assert.equal(team.delivery_task_id,fx.task.task_id);assert.equal(team.delivery_requested,false);
    const count=team.sequence;await controller.tick();await delay(20);await controller.tick();assert.equal(controller.read(fx.team.team_id).sequence,count);
    assert.equal(readdirSync(fx.options.tasksDir).filter(n=>n.endsWith('.json')).length,1);
  }finally{await controller.close();fx.cleanup();}
});
