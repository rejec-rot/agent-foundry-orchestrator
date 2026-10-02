// One leased control process owns team commands, scheduling and result acceptance.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireTaskLock, maintainTaskLease, releaseTaskLock } from '../tasklock.mjs';
import { ADAPTERS, selectExecutor, cancelRun, activeRunsForTask, cancelTaskRuns, registerRunControl, releaseRunControl, getDurableRunTerminationEvidence } from '../adapters.mjs';
import { extractJson } from '../task-execution.mjs';
import { terminationEvidenceConfirmed } from '../trusted-import/orchestrator-adapter.mjs';
import { readTeam, listTeams, commitTeam, pendingCommands } from './store.mjs';
import { validatePlan, affectedItems, invalidateItems, definitionDigest, teamError, text, requireId } from './model.mjs';
import { initializeBaseline, mergeArtifacts, inputArtifacts, prepareWorkspace, captureArtifact } from './workspace.mjs';
import { deliverTeam } from './delivery.mjs';
import { reapOrphanRuns } from '../orphan-reaper.mjs';
import { writeJsonAtomic } from '../store.mjs';
import { agentProfile, workerProfiles, supportsPlanner, sameModelTeamReview } from './planner.mjs';
import { agentOptions } from './agent-options.mjs';
import { queryNativeCatalog } from './native-catalog.mjs';
import { loadCapabilityMap } from '../executor-router.mjs';

const OUTPUT_SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['done','blocked'] }, summary: { type: 'string' },
  work_items: { type: 'array', items: { type: 'object', properties: {
    work_item_id: { type: 'string' }, agent_id: { type: 'string' }, goal: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } }, allowed_paths: { type: 'array', items: { type: 'string' } }, output_contract: { type: 'string' },
  }, required: ['work_item_id','agent_id','goal','depends_on','allowed_paths','output_contract'], additionalProperties: false } },
  messages: { type: 'array', items: { type: 'object', properties: {
    to_agent_id: { type: 'string' }, work_item_id: { type: ['string','null'] }, message: { type: 'string' }, reply_to: { type: ['string','null'] },
  }, required: ['to_agent_id','work_item_id','message','reply_to'], additionalProperties: false } },
  applied_message_ids: { type: 'array', items: { type: 'string' } }, resolved_paths: { type: 'array', items: { type: 'string' } },
  retry_work_item_ids: { type: 'array', items: { type: 'string' } },
}, required: ['status','summary','work_items','messages','applied_message_ids','resolved_paths','retry_work_item_ids'], additionalProperties: false };
const PLANNER_SCHEMA = { ...OUTPUT_SCHEMA, properties: { ...OUTPUT_SCHEMA.properties,
  workers: { type:'array', maxItems:8, items:{type:'object',properties:{executor_type:{type:'string'},model:{type:['string','null']},effort:{type:['string','null']}},required:['executor_type','model','effort'],additionalProperties:false} },
}, required:[...OUTPUT_SCHEMA.required,'workers'] };
function outputOf(result) {
  const sr = result.structured_result;
  const output = sr?.parsed ?? extractJson(sr?.result ?? sr?.summary ?? '') ?? (sr?.status ? sr : null);
  if (!output || !['done','blocked'].includes(output.status) || typeof output.summary !== 'string') throw teamError('agent response does not match team protocol');
  return output;
}
export class TeamController {
  constructor({ runtimeDir, tasksDir, locksDir, adapters = ADAPTERS, select = null, delivery = deliverTeam, autoDeliver = true, leaseMs = 60000, reap = reapOrphanRuns, discoverCatalog = queryNativeCatalog } = {}) {
    if (!runtimeDir || !tasksDir || !locksDir) throw teamError('runtimeDir, tasksDir and locksDir required');
    Object.assign(this, { runtimeDir, tasksDir, locksDir, adapters, delivery, autoDeliver, leaseMs, reap, discoverCatalog });
    this.select = select ?? (id => selectExecutor(id,{ adapters }));
    this.running = new Map(); this.deliveries = new Map(); this.deliveryTaskIds = new Set(); this.ticking = false; this.closing = false;
    this.owned = acquireTaskLock(locksDir,'team-controller',{ orchestratorInstanceId: `team-controller-${randomUUID()}`, leaseMs });
    this.lease = maintainTaskLease(locksDir,'team-controller',this.owned.lock,{ leaseMs, onLost: () => {
      this.closing = true;
      for (const [id,entry] of this.running) void this.cancel(id,entry).catch(()=>{});
    } });
  }
  read(id) { return readTeam(this.runtimeDir,id); }
  update(id,type,detail,fn) {
    this.lease.assertOwned();
    const team = this.read(id);
    fn(team);
    return commitTeam(this.runtimeDir,team,type,detail,this.lease.assertOwned);
  }
  task(team) { return JSON.parse(readFileSync(join(this.tasksDir,`${team.delivery_task_id}.json`),'utf8')); }
  async recover() {
    for (const team of listTeams(this.runtimeDir)) {
      const unknown = [...team.runs,...team.delivery_runs].filter(r=>['RUNNING','UNCONFIRMED'].includes(r.status));
      if (!unknown.length && team.state !== 'DELIVERING') continue;
      await this.reap({runsDir:join(this.runtimeDir,'runs'),apply:true,
        acceptHandle:handle=>unknown.some(r=>r.run_id===handle.run_id && r.owner_token===handle.owner_token && handle.team_id===team.team_id),
        onVerifiedTermination:(handle,evidence)=>{
          this.lease.assertOwned();const dir=join(this.runtimeDir,'runs','finished');mkdirSync(dir,{recursive:true});
          writeJsonAtomic(join(dir,`${handle.run_id}.json`),{run_id:handle.run_id,owner_token:handle.owner_token,team_id:team.team_id,evidence});
        }});
      this.update(team.team_id,'recovery-inspected',null,current => {
        let uncertain = false;
        for (const run of [...current.runs,...current.delivery_runs].filter(r=>['RUNNING','UNCONFIRMED'].includes(r.status))) {
          const proof = getDurableRunTerminationEvidence(run.run_id,this.runtimeDir);
          const evidence=proof?.owner_token===run.owner_token?proof.evidence:run.writer_termination;
          if (!terminationEvidenceConfirmed(evidence)) { uncertain = true; continue; }
          run.status = 'INTERRUPTED'; run.writer_termination = evidence;run.process_state='EXITED';
          const item = current.work_items.find(i=>i.work_item_id===run.work_item_id);
          if (item) { item.revision++; item.status=current.rework_requests?.some(q=>q.status==='queued'&&q.affected_items.includes(item.work_item_id))?'HELD':'READY'; item.active_run_id=null; }
          for(const message of current.messages) if(message.status==='received'&&message.received_by===run.run_id)message.status='queued';
        }
        for (const member of current.members) member.status='IDLE';
        if (uncertain) { current.state='RECOVERY_REQUIRED'; current.failure_reason='an interrupted run has no verified durable termination proof; inspect/reap its scope before retry'; }
        else if (current.state==='DELIVERING') {
          const task = this.task(current);
          current.state = task.state==='COMPLETED' ? 'COMPLETED' : task.state==='WAITING_HUMAN' ? 'WAITING_HUMAN' : 'READY_FOR_REVIEW';
        } else if(!['PAUSED','CANCELLED','PAUSING','COMPLETED','DISCUSSING','PLAN_READY','PLANNING'].includes(current.state)) {current.state=current.work_items.length ? 'WORKING':'PLANNING';current.failure_reason=null;}
      });
    }
  }
  async cancel(id,entry=this.running.get(id)) {
    if (!entry) return;
    await (typeof entry.adapter.cancel==='function' ? entry.adapter.cancel(id) : cancelRun(id));
    // Adapter completion includes the full writer-scope witness. A signal alone
    // cannot authorize a retry/capture. Bound cancellation, then fail closed.
    let timer;
    try { await Promise.race([entry.promise, new Promise((_,reject)=>{ timer=setTimeout(()=>reject(teamError('run did not settle after cancellation','TEAM_WRITER_UNCONFIRMED')),12000); })]); }
    finally { clearTimeout(timer); }
  }
  async stopItems(id,ids,{ all = false }={}) {
    const runs=[...this.running.entries()].filter(([,e])=>e.teamId===id && (all || ids.includes(e.itemId) || e.kind==='integrate'));
    for (const [runId,entry] of runs) await this.cancel(runId,entry);
    const deliveryTeam=this.read(id);
    const deliveryRuns=activeRunsForTask(deliveryTeam.delivery_task_id);
    if(deliveryRuns.length) {
      await cancelTaskRuns(deliveryTeam.delivery_task_id);
      let timer;
      try {await Promise.race([this.deliveries.get(id),new Promise((_,reject)=>{timer=setTimeout(()=>reject(teamError('delivery scope did not stop','TEAM_WRITER_UNCONFIRMED')),12000);})]);}
      finally {clearTimeout(timer);}
    }
    const team=this.read(id);
    if (team.runs.some(r=>r.status==='RUNNING' && (all || ids.includes(r.work_item_id))) || [...team.runs,...team.delivery_runs].some(r=>r.status==='UNCONFIRMED')) throw teamError('writer termination unresolved','TEAM_WRITER_UNCONFIRMED');
  }
  async command(id,record) {
    const c=record.command, commandId=record.command_id;
    let team=this.read(id);
    const previous=team.commands[commandId];
    const receipt = (status,extra={}) => this.update(id,'command-'+status,{command_id:commandId},t=> {
      t.commands[commandId]={ ...t.commands[commandId], type:c.type, message:c.message??c.goal??null, target_agent_id:c.agent_id??null,
        work_item_id:c.work_item_id??null, status, at:new Date().toISOString(), ...extra };
    });
    try {
      if (['CANCELLED','RECOVERY_REQUIRED'].includes(team.state)) throw teamError(`team is ${team.state}`);
      const deliveryTask=this.task(team);
      const delivered=team.state==='COMPLETED' || (team.delivery?.goal_revision===team.goal_revision && deliveryTask.trusted_import?.phase==='PROMOTED');
      if(delivered && !['adjust','replan'].includes(c.type)) throw teamError('goal is completed; adjust a work item or replan to begin a new goal revision');
      if(team.delivery?.goal_revision===team.goal_revision && deliveryTask.trusted_import?.promotion_started_at && !delivered
        && ['cancel','pause','adjust','retry','replan'].includes(c.type)) throw teamError('delivery promotion has already started; this direction change is too late');
      if (c.type==='message') {
        const agentId=c.agent_id??'lead';
        if (!team.members.some(m=>m.agent_id===agentId)) throw teamError('unknown member');
        if (c.work_item_id && !team.work_items.some(i=>i.work_item_id===c.work_item_id && i.agent_id===agentId)) throw teamError('work item is not assigned to target member');
        this.update(id,'message-queued',{command_id:commandId},t=>{
          t.commands[commandId]={type:c.type,status:'queued',target_agent_id:agentId,work_item_id:c.work_item_id??null};
          if (!t.messages.some(m=>m.message_id===commandId)) t.messages.push({message_id:commandId,from_agent_id:'operator',to_agent_id:agentId,work_item_id:c.work_item_id??null,
            goal_revision:t.goal_revision,work_item_revision:t.work_items.find(i=>i.work_item_id===c.work_item_id)?.revision??null,message:text(c.message,'message'),status:'queued'});
          for (const item of t.work_items) if(item.agent_id===agentId && (!c.work_item_id || item.work_item_id===c.work_item_id) && item.status==='BLOCKED') { item.status='READY';item.blocked_reason=null; }
          if(t.planning&&agentId==='lead'&&t.state==='BLOCKED'){t.state=t.planning.approved_plan_revision===null?(t.work_items.length?'PLAN_READY':'DISCUSSING'):'WORKING';t.failure_reason=null;}
        });
        return;
      }
      receipt('received');
      if (c.type==='start' || c.type==='resume') {
        if (team.state==='COMPLETED' || team.state==='DELIVERING') throw teamError(`team is ${team.state}`);
        if(team.planning && team.state==='PLAN_READY') throw teamError('confirm the plan and worker assignments before dispatch');
        this.update(id,'started',null,t=>{if(t.state==='WAITING_HUMAN'){t.delivery_requested=true;return;}
          const prior=t.state==='PAUSED'?t.paused_from_state:t.state;
          t.state=t.planning&&['DISCUSSING','PLAN_READY'].includes(prior)?prior:t.planning&&t.planning.approved_plan_revision===null?(t.work_items.length?'PLAN_READY':'DISCUSSING'):t.work_items.length?(t.integration?'READY_FOR_REVIEW':'WORKING'):'PLANNING';t.paused_from_state=null;t.failure_reason=null;});
      } else if(c.type==='configure_agents') {
        if(!team.planning) throw teamError('agent configuration requires a Planner team');
        if(!previous?.effect_committed) {
          if(c.expected_goal_revision!==team.goal_revision || c.expected_agent_config_revision!==(team.planning.agent_config_revision??0)
            || c.expected_plan_revision!==team.plan_revision) throw teamError('agent configuration changed; reload before saving','TEAM_VERSION_CONFLICT');
          const editable=['DISCUSSING','PLAN_READY'].includes(team.state) || (team.state==='PAUSED' && ['DISCUSSING','PLAN_READY','PLANNING','WORKING','BLOCKED'].includes(team.paused_from_state));
          if(!editable) throw teamError('pause the team before changing agent configuration');
          if([...team.runs,...team.delivery_runs].some(r=>['RUNNING','UNCONFIRMED'].includes(r.status))
            || [...this.running.values()].some(r=>r.teamId===id) || this.deliveries.has(id)) throw teamError('wait for all agent scopes to stop before changing configuration');
          if(!c.planner && !c.workers) throw teamError('choose a Planner or Worker configuration');
          const options=await this.currentProfileOptions(team,[c.planner??team.planning.planner,...(c.workers??team.members.filter(m=>m.role==='worker'))]);
          const planner=agentProfile(c.planner??team.planning.planner,options);
          if(!supportsPlanner(planner.executor_type,this.adapters) || !this.select(planner.executor_type)) throw teamError('Planner executor must be available and support independent review sessions');
          const workers=workerProfiles(c.workers??team.members.filter(m=>m.role==='worker'),options);
          for(const worker of workers)if(!this.select(worker.executor_type))throw teamError('worker executor unavailable');
          if(team.planning.approved_plan_revision!==null && workers.length!==team.members.length-1) throw teamError('keep the dispatched Worker count; change its profiles after pausing');
          this.update(id,'agents-configured',{command_id:commandId},t=>{
            const oldLead=t.members.find(m=>m.role==='lead');
            t.members=[{...oldLead,...planner,effort:planner.effort??null,status:'IDLE',session_ref:null},...workers.map(w=>({...w,status:'IDLE',session_ref:null}))];
            t.planning.planner=planner;t.planning.agent_config_revision=(t.planning.agent_config_revision??0)+1;
            t.planning.eligible_executors=options.catalog;
            if(c.workers)t.planning.worker_preferences=workers.map(({executor_type,model,effort})=>({executor_type,model,...(effort?{effort}:{})}));
            if(t.planning.approved_plan_revision===null && t.work_items.length) {
              for(const item of t.work_items)if(!workers.some(w=>w.agent_id===item.agent_id))item.agent_id=workers[0].agent_id;
              t.plan_revision++;t.work_revision++;
            }
            Object.assign(t.commands[commandId],{effect_committed:true,effect_agent_config_revision:t.planning.agent_config_revision});
          });
        }
      } else if(c.type==='propose_plan') {
        if(!team.planning || !['DISCUSSING','PLAN_READY'].includes(team.state)) throw teamError('plan proposals are available before dispatch');
        const options=await this.currentProfileOptions(team,team.members);agentProfile(team.planning.planner,options);
        this.update(id,'plan-requested',null,t=>{t.state='PLANNING';t.plan_attempts=0;t.work_revision++;t.planning.approved_plan_revision=null;t.planning.eligible_executors=options.catalog;});
      } else if(c.type==='approve_plan') {
        if(!team.planning || team.state!=='PLAN_READY' || c.expected_plan_revision!==team.plan_revision || c.expected_goal_revision!==team.goal_revision) throw teamError('plan revision changed; reload the proposal','TEAM_VERSION_CONFLICT');
        if(team.members.find(m=>m.agent_id==='lead').status==='RUNNING' || team.messages.some(m=>m.to_agent_id==='lead'&&['queued','received'].includes(m.status))) throw teamError('wait for Planner to finish the current discussion');
        if(((team.planning.agent_config_revision??0)>0 || c.expected_agent_config_revision!==undefined) && c.expected_agent_config_revision!==(team.planning.agent_config_revision??0)) throw teamError('agent configuration changed; reload the proposal','TEAM_VERSION_CONFLICT');
        const options=await this.currentProfileOptions(team,[team.planning.planner,...(c.workers??team.members.filter(m=>m.role==='worker'))]);
        agentProfile(team.planning.planner,options);
        const workers=workerProfiles(c.workers??team.members.filter(m=>m.role==='worker'),options);
        for(const worker of workers)if(!this.select(worker.executor_type))throw teamError('worker executor unavailable');
        const assignments=c.assignments??Object.fromEntries(team.work_items.map(i=>[i.work_item_id,i.agent_id]));
        if(Object.keys(assignments).length!==team.work_items.length || Object.keys(assignments).some(key=>!team.work_items.some(i=>i.work_item_id===key)))throw teamError('assign every work item exactly once');
        const items=validatePlan({work_items:team.work_items.map(i=>({...i,agent_id:assignments[i.work_item_id]}))},{...team,members:[team.members[0],...workers]});
        this.update(id,'plan-dispatched',{plan_revision:team.plan_revision},t=>{t.members=[t.members.find(m=>m.role==='lead'),...workers];t.work_items=items;t.work_revision++;t.planning.approved_plan_revision=t.plan_revision;
          if(c.workers)t.planning.worker_preferences=workers.map(({executor_type,model,effort})=>({executor_type,model,...(effort?{effort}:{})}));t.planning.eligible_executors=options.catalog;t.state='WORKING';});
      } else if (c.type==='adjust' || c.type==='retry') {
        const item=team.work_items.find(i=>i.work_item_id===c.work_item_id);
        if (!item || (previous?.effect_committed ? item.revision!==previous.effect_revision : c.expected_revision!==undefined && item.revision!==c.expected_revision)) throw teamError('work item revision changed','TEAM_VERSION_CONFLICT');
        if(c.type==='adjust' && !Number.isInteger(c.expected_revision)) throw teamError('expected_revision required');
        if(c.agent_id && !team.members.some(m=>m.agent_id===c.agent_id && m.role==='worker')) throw teamError('unknown worker');
        const ids=previous?.affected_items??(delivered?team.work_items.map(i=>i.work_item_id):affectedItems(team,[item.work_item_id]));
        if(team.planning) {
          if(!['WORKING','INTEGRATING','READY_FOR_REVIEW','DELIVERING','BLOCKED','COMPLETED'].includes(team.state))throw teamError('dispatch the plan before changing active work');
          if(!previous?.effect_committed && team.rework_requests.some(q=>q.status==='queued'&&q.affected_items.some(w=>ids.includes(w))))throw teamError('Planner is already revising this work and its dependents');
          if(!previous?.effect_committed)this.update(id,'work-held-for-planner',{work_items:ids},t=>{
            if(delivered){t.goal_revision++;t.baseline=null;for(const wi of t.work_items)wi.total_attempts=0;}
            invalidateItems(t,ids);for(const wi of t.work_items)if(ids.includes(wi.work_item_id))wi.status='HELD';
            const target=t.work_items.find(i=>i.work_item_id===c.work_item_id);
            t.rework_requests.push({request_id:commandId,work_item_id:c.work_item_id,work_item_revision:target.revision,
              affected_items:ids,feedback:c.type==='adjust'?text(c.message,'direction'):'Review the failed attempt and issue a corrected retry.',agent_id:c.agent_id??target.agent_id,status:'queued',created_at:new Date().toISOString()});
            Object.assign(t.commands[commandId],{effect_committed:true,effect_revision:target.revision,affected_items:ids});
          });
          await this.stopItems(id,ids);
          this.update(id,'planner-change-notified',{command_id:commandId},t=>{
            const request=t.rework_requests.find(q=>q.request_id===commandId);
            if(!t.messages.some(m=>m.message_id===commandId))t.messages.push({message_id:commandId,from_agent_id:'operator',to_agent_id:'lead',work_item_id:null,goal_revision:t.goal_revision,
              rework_request_id:commandId,message:request.feedback,status:'queued'});
            t.commands[commandId].status='queued';
          });
          return;
        }
        if(!previous?.effect_committed)this.update(id,'direction-invalidated',{work_items:ids},t=>{
          if(delivered){t.goal_revision++;t.baseline=null;for(const wi of t.work_items)wi.total_attempts=0;}
          invalidateItems(t,ids);const target=t.work_items.find(i=>i.work_item_id===c.work_item_id);
          if(c.type==='adjust')target.goal=text(c.message,'direction');if(c.agent_id)target.agent_id=c.agent_id;
          Object.assign(t.commands[commandId],{effect_committed:true,effect_revision:target.revision,affected_items:ids});
        });
        await this.stopItems(id,ids);
        this.update(id,'direction-adjusted',{command_id:commandId},t=>{
          const target=t.work_items.find(i=>i.work_item_id===c.work_item_id);
          if(c.type==='adjust') target.goal=text(c.message,'direction');
          if(c.agent_id) target.agent_id=c.agent_id;
        });
      } else if(c.type==='replan') {
        if (!previous?.effect_committed && c.expected_goal_revision!==team.goal_revision) throw teamError('goal revision changed','TEAM_VERSION_CONFLICT');
        if(!previous?.effect_committed)this.update(id,'goal-invalidated',null,t=>{t.goal_revision++;t.goal=text(c.goal??c.message,'goal');if(delivered)t.baseline=null;invalidateItems(t,t.work_items.map(i=>i.work_item_id));t.state='PLANNING';Object.assign(t.commands[commandId],{effect_committed:true,effect_goal_revision:t.goal_revision});});
        await this.stopItems(id,[],{all:true});
        this.update(id,'replanning',null,t=>{t.work_items=[];t.plan_attempts=0;if(t.planning){t.rework_requests=[];t.planning.approved_plan_revision=null;}});
      } else if(c.type==='pause' || c.type==='cancel') {
        if(!previous?.effect_committed)this.update(id,'stopping',null,t=>{
          if(c.type==='cancel'){t.goal_revision++;invalidateItems(t,t.work_items.map(i=>i.work_item_id));for(const q of t.rework_requests??[])if(q.status==='queued')q.status='superseded';}
          else {t.paused_from_state=t.state;const saved=t.integration;const ids=affectedItems(t,t.work_items.filter(i=>i.status==='RUNNING').map(i=>i.work_item_id));invalidateItems(t,ids);for(const wi of t.work_items)if(t.rework_requests?.some(q=>q.status==='queued'&&q.affected_items.includes(wi.work_item_id)))wi.status='HELD';if(!ids.length&&saved)t.integration={...saved,work_revision:t.work_revision};}
          t.state='PAUSING';Object.assign(t.commands[commandId],{effect_committed:true,effect_goal_revision:t.goal_revision});
        });
        await this.stopItems(id,[],{all:true});
        this.update(id,c.type==='pause'?'paused':'cancelled',null,t=>{t.state=c.type==='pause'?'PAUSED':'CANCELLED';});
      } else if(c.type==='deliver') {
        if(!team.integration) throw teamError('no integrated candidate');
        this.update(id,'delivery-requested',null,t=>{if(t.state!=='WAITING_HUMAN')t.state='READY_FOR_REVIEW';t.delivery_requested=true;});
      }
      receipt('applied',{evidence:{sequence:this.read(id).sequence,goal_revision:this.read(id).goal_revision,work_item_revision:this.read(id).work_items.find(i=>i.work_item_id===c.work_item_id)?.revision??null}});
    } catch(err) {
      if(err.code==='TEAM_WRITER_UNCONFIRMED') this.update(id,'scope-unconfirmed',null,t=>{t.state='RECOVERY_REQUIRED';t.failure_reason=err.message;});
      receipt('rejected',{reason:err.message,code:err.code??'TEAM_INVALID'});
    }
  }
  profileOptions(team) {return {allowed:team.planning.eligible_executors.map(e=>e.executor_type),adapters:this.adapters,catalog:team.planning.eligible_executors};}
  async currentProfileOptions(team,profiles) {
    const options=this.profileOptions(team),definitions=loadCapabilityMap();
    const ids=[...new Set(profiles.map(p=>p?.executor_type))].filter(id=>options.allowed.includes(id)&&['codex','cline','claude','command-code'].includes(id));
    const current=await Promise.all(ids.map(async id=>{
      let discovery;
      try{discovery=['codex','cline'].includes(id)?await this.discoverCatalog(id,{timeoutMs:8000}):null;}catch{throw teamError(`cannot verify ${id} model capabilities; scan again before saving or dispatching`);}
      return {executor_type:id,supports_model:true,...agentOptions(id,{adapters:this.adapters,definition:definitions.get(id)??{},discovery})};
    }));
    return {...options,catalog:options.catalog.map(old=>current.find(e=>e.executor_type===old.executor_type)??old)};
  }
  async acceptPlan(id,raw) {
    const before=this.read(id);
    if(before.planning&&before.state==='PLANNING'&&(!Array.isArray(raw.workers)||!raw.workers.length))throw teamError('Planner must recommend 1..8 worker profiles');
    if(before.planning?.worker_preferences && before.state==='PLANNING' && raw.workers.length!==before.planning.worker_preferences.length)throw teamError('Planner must keep the operator-selected Worker count');
    const options=before.planning && raw.workers?.length && before.state==='PLANNING'?await this.currentProfileOptions(before,[before.planning.planner,...(before.planning.worker_preferences??raw.workers)]):null;
    if(options)agentProfile(before.planning.planner,options);
    const workers=options?workerProfiles(before.planning.worker_preferences??raw.workers,options):null;
    if(workers)for(const worker of workers)if(!this.select(worker.executor_type))throw teamError('recommended worker executor unavailable');
    const next=validatePlan(raw,workers?{...before,members:[before.members[0],...workers]}:before);
    const changed=before.work_items.filter(old=>!next.some(n=>n.work_item_id===old.work_item_id && definitionDigest(n)===definitionDigest(old))).map(i=>i.work_item_id);
    const ids=affectedItems(before,changed);
    let expectedWorkRevision=before.work_revision;
    if(ids.length) { expectedWorkRevision=this.update(id,'plan-invalidated',{work_items:ids},t=>invalidateItems(t,ids)).work_revision;await this.stopItems(id,ids); }
    const current=this.read(id);
    if(current.goal_revision!==before.goal_revision || current.work_revision!==expectedWorkRevision) throw teamError('plan superseded while writers were stopping','TEAM_STALE_RESULT');
    return this.update(id,'plan-accepted',null,t=>{
      t.work_items=next.map(n=>{const old=t.work_items.find(i=>i.work_item_id===n.work_item_id);return old && !ids.includes(n.work_item_id) && definitionDigest(old)===definitionDigest(n)?old:{...n,revision:old?.revision??1,total_attempts:old?.total_attempts??0};});
      if(workers)t.members=[t.members.find(m=>m.role==='lead'),...workers];
      if(options)t.planning.eligible_executors=options.catalog;
      t.plan_revision++;t.work_revision++;t.state=t.planning&&before.state==='PLANNING'&&t.planning.dispatch_mode==='human'?'PLAN_READY':'WORKING';t.failure_reason=null;
      if(t.state==='PLAN_READY')for(const item of t.work_items)item.status='DRAFT';
      else if(t.planning)t.planning.approved_plan_revision=t.plan_revision;
    });
  }
  receiveOutput(team,run,output) {
    if(output.status!=='done' && output.applied_message_ids?.length) throw teamError('blocked work cannot claim an applied-message receipt');
    for(const message of output.messages??[]) {
      const target=team.members.find(m=>m.agent_id===message.to_agent_id);
      if(!target) throw teamError('agent message targets an unknown member');
      if(message.work_item_id && !team.work_items.some(i=>i.work_item_id===message.work_item_id && i.agent_id===target.agent_id)) throw teamError('message work item belongs to another member');
      if(message.reply_to && !team.messages.some(m=>m.message_id===message.reply_to && m.to_agent_id===run.agent_id)) throw teamError('reply does not belong to this member');
      if(message.reply_to && team.messages.find(m=>m.message_id===message.reply_to).status==='superseded')continue;
      team.messages.push({message_id:`MSG-${randomUUID()}`,from_agent_id:run.agent_id,to_agent_id:target.agent_id,
        from_run_id:run.run_id,source_work_item_id:team.work_items.some(i=>i.work_item_id===run.work_item_id)?run.work_item_id:null,source_work_item_revision:run.work_item_revision,
        work_item_id:message.work_item_id??null,goal_revision:team.goal_revision,
        work_item_revision:team.work_items.find(i=>i.work_item_id===message.work_item_id)?.revision??null,
        message:text(message.message,'agent message',4000),reply_to:message.reply_to??null,status:'queued'});
      for(const item of team.work_items) if(item.agent_id===target.agent_id && (!message.work_item_id || item.work_item_id===message.work_item_id) && item.status==='BLOCKED') {item.status='READY';item.blocked_reason=null;}
    }
    for(const id of output.applied_message_ids??[]) {
      if(!run.message_ids.includes(id)) throw teamError('applied message was not delivered to this run');
      const m=team.messages.find(m=>m.message_id===id);if(m?.status==='superseded')continue;if(m) {m.status='applied';m.applied_by=run.run_id;}
      if(team.commands[id]) team.commands[id]={...team.commands[id],status:'applied',evidence:{run_id:run.run_id,artifact_id:`ART-${run.run_id}`}};
    }
  }
  async launch(id,kind,item=null) {
    let team=this.read(id); const member=team.members.find(m=>m.agent_id===(item?.agent_id??'lead'));
    if(kind==='discuss' ? !['DISCUSSING','PLAN_READY','WORKING'].includes(team.state) : team.state!==(kind==='plan'?'PLANNING':'WORKING')) return;
    const liveItem=item?team.work_items.find(i=>i.work_item_id===item.work_item_id):null;
    if(item && (!liveItem || liveItem.revision!==item.revision || liveItem.agent_id!==item.agent_id || liveItem.status!==(kind==='reply'?'DONE':'READY'))) return;
    if(team.runs.filter(r=>r.goal_revision===team.goal_revision).length>=100) {this.update(id,'budget-exhausted',null,t=>{t.state='BLOCKED';t.failure_reason='goal execution budget exhausted';});return;}
    if(this.running.size>=16 || member.status==='RUNNING') return;
    let adapter;
    try {adapter=this.select(member.executor_type);if(!adapter || (adapter.type===this.task(team).reviewer_executor&&!sameModelTeamReview(this.task(team)))) throw teamError('team writer executor is unavailable or reserved for review');}
    catch(err) {this.update(id,'executor-unavailable',{agent_id:member.agent_id},t=>{t.state='BLOCKED';t.failure_reason=err.message;});return;}
    const runId=`RUN-${randomUUID()}`;
    const artifacts=kind==='worker'?inputArtifacts(team,item):kind==='reply'?[...inputArtifacts(team,item),team.artifacts.find(a=>a.artifact_id===item.artifact_id)].filter(Boolean):kind==='integrate'?this.orderedArtifacts(team):[];
    let snapshot,conflicts,cwd;
    try {({snapshot,conflicts}=mergeArtifacts(team,artifacts,{strict:kind==='worker'}));cwd=prepareWorkspace(this.runtimeDir,team,runId,snapshot,conflicts);}
    catch(err) {this.update(id,'input-blocked',{work_item_id:item?.work_item_id??kind},t=>{t.state='BLOCKED';t.failure_reason=err.message;if(item){const wi=t.work_items.find(i=>i.work_item_id===item.work_item_id);wi.status='BLOCKED';wi.blocked_reason=err.message;}});return;}
    const change=kind==='revise'?team.rework_requests.find(q=>q.status==='queued'):null;
    const messages=team.messages.filter(m=>m.to_agent_id===member.agent_id && (!m.work_item_id || m.work_item_id===item?.work_item_id) && m.status==='queued'
      && (kind==='revise'?m.rework_request_id===change?.request_id:kind==='discuss'?m.from_agent_id==='operator'&&!m.rework_request_id:!m.rework_request_id));
    const run={run_id:runId,agent_id:member.agent_id,work_item_id:item?.work_item_id??kind,kind,
      work_item_revision:item?.revision??team.plan_revision+1,goal_revision:team.goal_revision,work_graph_revision:team.work_revision,
      executor_type:adapter.type,model:member.model??null,effort:member.effort??null,rework_request_id:change?.request_id??null,status:'RUNNING',process_state:'QUEUED',owner_token:this.owned.lock.owner_token,
      workspace_dir:cwd,input_snapshot:snapshot,input_artifact_ids:artifacts.map(a=>a.artifact_id),message_ids:messages.map(m=>m.message_id),conflicts,
      started_at:new Date().toISOString()};
    this.update(id,'run-claimed',{run_id:runId},t=>{
      t.runs.push(run);t.members.find(m=>m.agent_id===member.agent_id).status='RUNNING';
      if(item && kind==='worker') {const current=t.work_items.find(i=>i.work_item_id===item.work_item_id);current.status='RUNNING';current.active_run_id=runId;current.attempts++;current.total_attempts++;}
      if(kind==='plan') t.plan_attempts++;
      if(kind==='integrate') t.state='INTEGRATING';
      for(const message of t.messages.filter(m=>run.message_ids.includes(m.message_id))) {message.status='received';message.received_by=runId;if(t.commands[message.message_id]) t.commands[message.message_id].status='received';}
    });
    const instructions=kind==='discuss'?`Discuss the operator's goal. Ask useful questions, explain tradeoffs, and write your reply in summary in the operator's language. Do not dispatch work, return work_items/retry_work_item_ids, or change files.`:
      kind==='revise'?`Rewrite the held work in CHANGE_REQUEST after reading the operator's feedback. Return the COMPLETE amended work_items graph. Keep every work item id, dependencies and allowed_paths unchanged. Preserve definitions of unaffected items exactly. Assign the target to the requested agent_id. Improve its goal and output_contract into actionable instructions. Do not change files. Summary explains the new direction in the operator's language. A done result reissues the affected work; a blocked result keeps it held.`:
      kind==='plan'?`Produce a dependency graph of work_items and explain it in summary in the operator's language. For Planner teams, recommend 1..8 workers in workers using ONLY eligible executor profiles. If PLANNING.worker_preferences is present, use exactly that Worker count and those executor/model/effort choices; these are the operator's selections. Otherwise choose each worker's model and reasoning effort from the provided catalog to fit its work; null keeps executor defaults. Explain your choices in summary. Repeated executor/model choices are allowed. Their agent_ids are worker-1 through worker-N in array order. The operator will confirm the proposal if dispatch_mode is human. Do not change files or run child agents yourself.`:
      kind==='coordinate'?`Coordinate requests and replies without changing files. Return work_items only to replace the complete current plan; preserve completed work that need not change.`:
      kind==='integrate'?`Integrate the supplied artifacts. Resolve every conflict explicitly; alternative bytes are in .af-scratch/conflict-N. Report each resolved path in resolved_paths.`:
      kind==='reply'?`Reply to the queued requests about your accepted work item using messages and reply_to. Do not change files during this communication turn.`:
      `Complete only your work item. Input artifacts are already materialized. Request missing interfaces from another registered member using messages; if waiting, return blocked and release the execution slot.`;
    const capsule={task_id:team.delivery_task_id,team_id:id,agent_id:member.agent_id,work_item_id:run.work_item_id,runId,
      runtime_dir:this.runtimeDir,cwd,assigned_role:kind==='integrate'?'author':kind==='worker'?'worker':'planner',purpose:'trusted_import',
      model:member.model??undefined,effort:member.effort??undefined,allow_model_fallback:!team.planning,acceptEdits:true,response_schema:team.planning?PLANNER_SCHEMA:OUTPUT_SCHEMA,timeout_ms:600000,protect_active_process:true,
      prompt:`You are the ${member.role} (${member.agent_id}) of a managed collaboration team.\nGOAL: ${team.goal}\nGOAL_REVISION: ${team.goal_revision}\n${instructions}\nWork only in ${cwd}; never edit platform state or canonical repositories.\nWORK_ITEM: ${JSON.stringify(item)}\nMEMBERS: ${JSON.stringify(team.members.map(({agent_id,role,executor_type,model,effort})=>({agent_id,role,executor_type,model,effort})))}\nPLANNING: ${JSON.stringify(team.planning??null)}\nCHANGE_REQUEST: ${JSON.stringify(change)}\nCONVERSATION: ${JSON.stringify(team.planning?team.messages.filter(m=>(m.to_agent_id==='lead'||m.from_agent_id==='lead')&&m.goal_revision===team.goal_revision).slice(-24):[])}\nPLAN: ${JSON.stringify(team.work_items)}\nINPUT_ARTIFACTS: ${JSON.stringify(artifacts.map(a=>({artifact_id:a.artifact_id,work_item_id:a.work_item_id,revision:a.revision,summary:a.summary})))}\nCONFLICTS: ${JSON.stringify(conflicts)}\nMESSAGES: ${JSON.stringify(messages)}\nREVIEW_FEEDBACK: ${JSON.stringify(team.review_feedback??null)}\nReturn ONLY JSON matching ${JSON.stringify(team.planning?PLANNER_SCHEMA:OUTPUT_SCHEMA)}. Use empty arrays for unused fields. Message/application receipts require completed work; do not invent identities.`};
    // All these isolated runs use the adapter's author filesystem capability;
    // the logical lead/worker role remains in the team identity and prompt.
    capsule.assigned_role='author';
    registerRunControl(runId,{assertOwnership:this.lease.assertOwned,onStarted:({pid})=>this.update(id,'process-started',{run_id:runId},t=>{const r=t.runs.find(r=>r.run_id===runId);r.process_state='RUNNING';r.pid=pid;}),metadata:{team_id:id,agent_id:member.agent_id,work_item_id:run.work_item_id,owner_token:run.owner_token,runtime_dir:this.runtimeDir}});
    const entry={teamId:id,itemId:item?.work_item_id??kind,kind,adapter,promise:null};
    this.running.set(runId,entry);
    entry.promise=Promise.resolve().then(()=>{this.lease.assertOwned();return adapter.run(capsule);})
      .then(result=>this.finish(id,run,result,item)).catch(err=>{
        if(this.closing) return;
        if(err.code==='TEAM_STALE_RESULT') {this.discard(id,run);return;}
        this.update(id,'run-failed',{run_id:runId},t=>{
          const r=t.runs.find(r=>r.run_id===runId);r.status=err.code==='TEAM_WRITER_UNCONFIRMED'?'UNCONFIRMED':'FAILED';r.error=err.message;
          t.members.find(m=>m.agent_id===run.agent_id).status='IDLE';
          const current=t.work_items.find(i=>i.work_item_id===run.work_item_id);
          if(current?.active_run_id===runId) {current.status='FAILED';current.active_run_id=null;current.blocked_reason=err.message;
            if(current.total_attempts<t.max_attempts)t.messages.push({message_id:`FAIL-${runId}`,from_agent_id:'platform',to_agent_id:'lead',work_item_id:null,goal_revision:t.goal_revision,status:'queued',message:`Work item ${current.work_item_id} failed: ${err.message}. Reassign or select retry_work_item_ids within the attempt budget.`});}
          if(err.code==='TEAM_WRITER_UNCONFIRMED') t.state='RECOVERY_REQUIRED';
          else if(['integrate','plan','coordinate','discuss','revise'].includes(kind)) {t.state='BLOCKED';t.failure_reason=err.message;}
          for(const message of t.messages) if(run.message_ids.includes(message.message_id)&&message.status==='received')message.status='queued';
        });
      }).finally(()=>{releaseRunControl(runId);this.running.delete(runId);});
  }
  discard(id,run) {
    this.update(id,'stale-result-rejected',{run_id:run.run_id},t=>{t.runs.find(r=>r.run_id===run.run_id).status='DISCARDED';t.members.find(m=>m.agent_id===run.agent_id).status='IDLE';
      for(const message of t.messages)if(message.status==='received'&&message.received_by===run.run_id)message.status='queued';});
  }
  async finish(id,run,result,item) {
    this.lease.assertOwned();
    if(result.writer_termination?.process_started===false) result.writer_termination={...result.writer_termination,termination_confirmed:true,process_group_alive:false,scope_verified:true,scope_empty:true,scope_kind:'none'};
    if(!terminationEvidenceConfirmed(result.writer_termination)) throw teamError('run completed without writer termination','TEAM_WRITER_UNCONFIRMED');
    this.update(id,'run-terminated',{run_id:run.run_id},t=>{
      const current=t.runs.find(r=>r.run_id===run.run_id);current.writer_termination=result.writer_termination;
      current.session_ref=result.session_ref??null;
      current.process_state='EXITED';
      current.finished_at=new Date().toISOString();t.members.find(m=>m.agent_id===run.agent_id).status='IDLE';
    });
    let team=this.read(id), current=team.work_items.find(i=>i.work_item_id===run.work_item_id);
    if(team.goal_revision!==run.goal_revision || (!item && team.work_revision!==run.work_graph_revision) || (item && (current?.revision!==run.work_item_revision || (run.kind==='worker' && current?.active_run_id!==run.run_id)))) {
      this.discard(id,run);return;
    }
    if(result.status!=='completed') throw teamError(result.error??'agent execution failed');
    const output=outputOf(result);
    const artifact=await captureArtifact(this.runtimeDir,team,run,{...result,summary:output.summary},item);
    if(['reply','plan','coordinate','discuss','revise'].includes(run.kind) && artifact.manifest.changes.length) throw teamError('planning and communication turns may not change accepted work');
    if(run.kind==='discuss' && (output.work_items?.length || output.retry_work_item_ids?.length || output.messages?.length))throw teamError('discussion cannot dispatch work or amend the plan');
    team=this.read(id);current=team.work_items.find(i=>i.work_item_id===run.work_item_id);
    if(team.goal_revision!==run.goal_revision || (!item && team.work_revision!==run.work_graph_revision) || (item && current?.revision!==run.work_item_revision)) {
      this.discard(id,run);return;
    }
    if(run.kind==='integrate' && run.conflicts.some(c=>!(output.resolved_paths??[]).includes(c.path))) throw teamError('integrator did not resolve every reported conflict','TEAM_INTEGRATION_CONFLICT');
    if(run.kind==='revise' && output.status==='done') {
      const request=team.rework_requests.find(q=>q.request_id===run.rework_request_id&&q.status==='queued');
      if(!request)throw teamError('change request superseded','TEAM_STALE_RESULT');
      const amended=validatePlan(output,team);
      if(amended.length!==team.work_items.length || amended.some(next=>{
        const old=team.work_items.find(i=>i.work_item_id===next.work_item_id);
        return !old || JSON.stringify(old.depends_on)!==JSON.stringify(next.depends_on) || JSON.stringify(old.allowed_paths)!==JSON.stringify(next.allowed_paths)
          || (!request.affected_items.includes(next.work_item_id)&&definitionDigest(old)!==definitionDigest(next));
      }) || amended.find(i=>i.work_item_id===request.work_item_id)?.agent_id!==request.agent_id)throw teamError('Planner revision must preserve unrelated work, dependencies and scopes');
      this.update(id,'planner-direction-issued',{request_id:request.request_id,run_id:run.run_id},t=>{
        for(const next of amended)if(request.affected_items.includes(next.work_item_id)) {
          const wi=t.work_items.find(i=>i.work_item_id===next.work_item_id);Object.assign(wi,{goal:next.goal,agent_id:next.agent_id,output_contract:next.output_contract,status:'READY'});
        }
        const q=t.rework_requests.find(q=>q.request_id===request.request_id);q.status='applied';q.planner_run_id=run.run_id;q.direction=amended.find(i=>i.work_item_id===q.work_item_id).goal;
        t.work_revision++;t.commands[q.request_id]={...t.commands[q.request_id],status:'applied',evidence:{planner_run_id:run.run_id,work_item_revision:q.work_item_revision}};
        const msg=t.messages.find(m=>m.message_id===q.request_id);if(msg){msg.status='applied';msg.applied_by=run.run_id;}
      });
    }
    if((run.kind==='plan'||run.kind==='coordinate') && output.status==='done' && output.work_items?.length) {
      const accepted=await this.acceptPlan(id,output),latest=this.read(id);
      if(latest.goal_revision!==accepted.goal_revision || latest.work_revision!==accepted.work_revision) throw teamError('accepted plan has been superseded','TEAM_STALE_RESULT');
    }
    if(run.kind==='coordinate' && output.retry_work_item_ids?.length) {
      const currentTeam=this.read(id);
      if(output.retry_work_item_ids.some(id=>!currentTeam.work_items.some(i=>i.work_item_id===id))) throw teamError('retry names unknown work items');
      const affected=affectedItems(currentTeam,output.retry_work_item_ids);
      const expected=this.update(id,'review-work-selected',{work_items:affected},t=>invalidateItems(t,affected));
      await this.stopItems(id,affected);
      const latest=this.read(id);
      if(latest.goal_revision!==expected.goal_revision || latest.work_revision!==expected.work_revision) throw teamError('retry selection superseded while writers were stopping','TEAM_STALE_RESULT');
    }
    if(run.kind==='plan' && output.status==='done' && !output.work_items?.length) throw teamError('lead returned no work plan');
    this.update(id,'output-accepted',{run_id:run.run_id,artifact_id:artifact.artifact_id},t=>{
      t.runs.find(r=>r.run_id===run.run_id).status='COMPLETED';t.artifacts.push(artifact);
      t.members.find(m=>m.agent_id===run.agent_id).session_ref=result.session_ref??null;
      this.receiveOutput(t,run,output);
      if(t.planning && ['discuss','plan','revise','coordinate'].includes(run.kind)) {
        t.messages.push({message_id:`REPLY-${run.run_id}`,from_agent_id:'lead',to_agent_id:'operator',work_item_id:null,goal_revision:t.goal_revision,
          from_run_id:run.run_id,message:text(output.summary,'Planner reply'),status:'delivered',created_at:new Date().toISOString()});
        for(const msg of t.messages)if(run.message_ids.includes(msg.message_id)&&msg.status==='received'&&output.status==='done'){msg.status='applied';msg.applied_by=run.run_id;if(t.commands[msg.message_id])t.commands[msg.message_id]={...t.commands[msg.message_id],status:'applied',evidence:{run_id:run.run_id}};}
        if(output.status==='blocked'){t.state='BLOCKED';t.failure_reason=output.summary;for(const msg of t.messages)if(run.message_ids.includes(msg.message_id)&&msg.status==='received')msg.status='queued';}
      }
      const wi=t.work_items.find(i=>i.work_item_id===run.work_item_id);
      if(item && run.kind==='worker') {wi.status=output.status==='blocked'?'BLOCKED':'DONE';wi.blocked_reason=output.status==='blocked'?output.summary:null;wi.active_run_id=null;wi.artifact_id=output.status==='done'?artifact.artifact_id:null;}
      if(run.kind==='integrate') {
        if(output.status!=='done') {t.state='BLOCKED';t.failure_reason=output.summary;}
        else {t.integration={artifact_id:artifact.artifact_id,conflicts:run.conflicts,goal_revision:t.goal_revision,work_revision:t.work_revision,input_artifact_ids:run.input_artifact_ids};t.state='READY_FOR_REVIEW';}
      }
    });
  }
  orderedArtifacts(team) {
    const ids=new Set(),out=[];
    while(ids.size<team.work_items.length) {
      const ready=team.work_items.filter(i=>!ids.has(i.work_item_id) && i.depends_on.every(d=>ids.has(d)));
      if(!ready.length) throw teamError('dependency graph cannot close');
      for(const item of ready) {ids.add(item.work_item_id);const a=team.artifacts.find(a=>a.artifact_id===item.artifact_id);if(!a) throw teamError('work item has no artifact');out.push(a);}
    }
    return out;
  }
  async tick() {
    if(this.ticking||this.closing) return;
    this.ticking=true;
    try {
      this.lease.assertOwned();
      for(const initial of listTeams(this.runtimeDir)) {
        for(const c of pendingCommands(this.runtimeDir,this.read(initial.team_id))) {
          if(c.command.type==='message' && this.read(initial.team_id).messages.some(m=>m.message_id===c.command_id)) continue;
          if(this.read(initial.team_id).rework_requests?.some(q=>q.request_id===c.command_id&&q.status==='queued')&&this.read(initial.team_id).messages.some(m=>m.message_id===c.command_id))continue;
          await this.command(initial.team_id,c);
        }
        let team=this.read(initial.team_id);
        if(!['DISCUSSING','PLAN_READY','PLANNING','WORKING','INTEGRATING','READY_FOR_REVIEW','WAITING_HUMAN'].includes(team.state)) continue;
        if(!team.baseline) { const baseline=initializeBaseline(this.runtimeDir,team,this.task(team));this.update(team.team_id,'baseline-bound',null,t=>{t.baseline=baseline;});team=this.read(team.team_id); }
        if(team.state==='PLANNING') {
          if(team.plan_attempts<team.max_plan_attempts)await this.launch(team.team_id,'plan');
          else this.update(team.team_id,'planning-budget-exhausted',null,t=>{t.state='BLOCKED';t.failure_reason='planning attempt budget exhausted; replan with a new goal revision';});
        }
        if(['DISCUSSING','PLAN_READY'].includes(team.state) && team.messages.some(m=>m.to_agent_id==='lead'&&m.status==='queued'))await this.launch(team.team_id,'discuss');
        if(team.state==='WORKING') {
          if(team.work_items.some(i=>i.status==='READY'&&i.total_attempts>=team.max_attempts)) {this.update(team.team_id,'work-budget-exhausted',null,t=>{t.state='BLOCKED';t.failure_reason='work item attempt budget exhausted; replan with a new goal revision';});continue;}
          if(team.rework_requests?.some(q=>q.status==='queued'))await this.launch(team.team_id,'revise');
          else if(team.messages.some(m=>m.to_agent_id==='lead'&&m.status==='queued')) await this.launch(team.team_id,team.planning&&team.messages.filter(m=>m.to_agent_id==='lead'&&m.status==='queued').every(m=>m.from_agent_id==='operator')?'discuss':'coordinate');
          for(const item of team.work_items) if(item.status==='READY' && item.total_attempts<team.max_attempts && item.depends_on.every(id=>team.work_items.find(i=>i.work_item_id===id)?.status==='DONE')) await this.launch(team.team_id,'worker',item);
          for(const item of team.work_items) if(item.status==='DONE' && team.messages.some(m=>m.status==='queued'&&m.to_agent_id===item.agent_id&&(!m.work_item_id||m.work_item_id===item.work_item_id))) await this.launch(team.team_id,'reply',item);
          team=this.read(team.team_id);
          if(team.work_items.length && team.work_items.every(i=>i.status==='DONE') && !team.messages.some(m=>m.status==='queued') && ![...this.running.values()].some(e=>e.teamId===team.team_id)) await this.launch(team.team_id,'integrate');
        }
        if((team.state==='READY_FOR_REVIEW'||(team.state==='WAITING_HUMAN'&&team.delivery_requested)) && this.autoDeliver && !this.deliveries.has(team.team_id)) {
          const p=Promise.resolve().then(()=>this.delivery(this,team.team_id)).catch(err=>{if(!this.closing)this.update(team.team_id,'delivery-failed',null,t=>{if(t.state==='DELIVERING'||(err.code==='TEAM_DELIVERY_BUDGET'&&t.state==='READY_FOR_REVIEW')){t.state='BLOCKED';t.failure_reason=err.message;}});}).finally(()=>this.deliveries.delete(team.team_id));
          this.deliveries.set(team.team_id,p);
        }
      }
    } finally {this.ticking=false;}
  }
  async close() {
    this.closing=true;
    try {await Promise.allSettled([...this.running.entries()].map(([id,e])=>this.cancel(id,e)));await Promise.allSettled([...this.deliveryTaskIds].map(id=>cancelTaskRuns(id)));await Promise.allSettled([...this.deliveries.values()]);}
    finally {this.lease.stop();releaseTaskLock(this.locksDir,'team-controller',this.owned.lock);}
  }
}
