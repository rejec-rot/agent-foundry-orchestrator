// Controlled handoff: collaboration owns planning; Trusted Import owns delivery.
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { startOrResumeV2Task } from '../execution-manager.mjs';
import { resumeV2Workflow } from '../workflows/v2.mjs';
import { writeJsonAtomic } from '../store.mjs';
import { recordRun } from '../task-execution.mjs';
import { registerRunControl, releaseRunControl, getDurableRunTerminationEvidence } from '../adapters.mjs';
import { replaceCandidateWithSnapshot, terminationEvidenceConfirmed } from '../trusted-import/orchestrator-adapter.mjs';
import { verifySnapshotIntegrity } from '../trusted-import/snapshot.mjs';
import { casFor } from './workspace.mjs';
import { pendingCommands } from './store.mjs';
import { teamError } from './model.mjs';
import { bindPlannerReview } from './planner.mjs';

const read = (dir,id) => JSON.parse(readFileSync(join(dir,`${id}.json`),'utf8'));
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const reviewedVersions=(team,goalRevision)=>new Set(team.delivery_runs.filter(r=>(r.goal_revision??1)===goalRevision).map(r=>`${r.task_id}:${r.revision??1}`));
function prepareTask(controller, team) {
  const previous=read(controller.tasksDir,team.delivery_task_id);
  if(previous.state==='CREATED' || (team.state==='WAITING_HUMAN' && previous.state==='WAITING_HUMAN')) return previous;
  const original=read(controller.tasksDir,team.original_delivery_task_id??team.delivery_task_id);
  const remaining=(original.trusted_import.max_revisions??3)-reviewedVersions(team,team.goal_revision).size;
  if(remaining<1)throw teamError('goal delivery revision budget exhausted; replan before starting a fresh delivery','TEAM_DELIVERY_BUDGET');
  const generation=(team.delivery_generation??0)+1;
  const id=`${team.original_delivery_task_id??team.delivery_task_id}-D${generation}`;
  const root=join(dirname(original.trusted_import.candidate_dir),'delivery-generations',id);
  const task={...original,task_id:id,goal:team.goal,state:'CREATED',state_version:1,runs:[],created_at:new Date().toISOString(),
    acceptance_binding:null,author_session_ref:null,author_session_executor_type:null,last_review:null,execution:null,
    failure_reason:null,team_binding:{team_id:team.team_id,goal_revision:team.goal_revision},
    trusted_import:{enabled:true,phase:'CREATED',candidate_dir:join(root,'candidate'),cas_dir:join(root,'cas'),
      acceptance:original.trusted_import.acceptance,policy:original.trusted_import.policy,
      profile_provenance:original.trusted_import.profile_provenance,proposed_required:original.trusted_import.proposed_required,
      source_submission:original.trusted_import.source_submission,max_revisions:remaining}};
  mkdirSync(task.trusted_import.candidate_dir,{recursive:true});mkdirSync(task.trusted_import.cas_dir,{recursive:true});
  if(!writeJsonAtomic(join(controller.tasksDir,`${id}.json`),task,{noOverwrite:true})) {
    const existing=read(controller.tasksDir,id);
    if(existing.team_binding?.team_id!==team.team_id || existing.team_binding?.goal_revision!==team.goal_revision || existing.trusted_import?.candidate_dir!==task.trusted_import.candidate_dir)throw teamError('delivery generation conflicts with an existing task','TEAM_VERSION_CONFLICT');
    controller.update(team.team_id,'delivery-generation-recovered',{task_id:id},t=>{t.original_delivery_task_id??=t.delivery_task_id;t.delivery_task_id=id;t.delivery_generation=generation;});
    return existing;
  }
  controller.update(team.team_id,'delivery-generation-created',{task_id:id},t=>{t.original_delivery_task_id??=t.delivery_task_id;t.delivery_task_id=id;t.delivery_generation=generation;});
  return task;
}
export async function deliverTeam(controller,id) {
  let team=controller.read(id);
  const parked=team.state==='WAITING_HUMAN';
  if(!['READY_FOR_REVIEW','WAITING_HUMAN'].includes(team.state) || !team.integration) throw teamError('team has no integrated candidate');
  const task=prepareTask(controller,{...team,state:parked?'WAITING_HUMAN':team.state});
  controller.deliveryTaskIds.add(task.task_id);
  const goalRevision=team.goal_revision;
  let boundArtifactId=team.integration.artifact_id;
  let boundWorkRevision=team.work_revision;
  const controls=new Set();
  const assertCurrent=()=>{
    controller.lease.assertOwned();const current=controller.read(id);
    if(controller.closing || current.goal_revision!==goalRevision || !current.integration || current.integration.artifact_id!==boundArtifactId || current.work_revision!==boundWorkRevision || ['PAUSING','PAUSED','CANCELLED','RECOVERY_REQUIRED'].includes(current.state)
        || pendingCommands(controller.runtimeDir,current).some(c=>['adjust','replan','pause','cancel','retry','approve_plan'].includes(c.command.type))) {
      throw teamError('team direction changed; candidate delivery is superseded','TEAM_DELIVERY_STALE');
    }
  };
  assertCurrent();
  controller.update(id,'delivery-started',{task_id:task.task_id},t=>{t.state='DELIVERING';t.delivery_requested=false;t.delivery={task_id:task.task_id,goal_revision:goalRevision,status:'RUNNING'};});
  try {
    const result=await startOrResumeV2Task({taskId:task.task_id,tasksDir:controller.tasksDir,locksDir:controller.locksDir,runtimeDir:controller.runtimeDir,
      allowFailedReentry:true,runner:async ({task:deliveryTask})=>{
        const current=controller.read(id);
        bindPlannerReview(deliveryTask,current);
        deliveryTask.goal=current.goal;
        deliveryTask.trusted_import.baseline_oid=controller.read(id).baseline.oid;
        const producer=async(revision,{cwd})=>{
          if(revision>1) {
            controller.update(id,'review-feedback',null,t=>{
              t.state='WORKING';t.integration=null;t.review_feedback=deliveryTask.last_review;
              t.messages.push({message_id:`REVIEW-${task.task_id}-${revision}`,from_agent_id:'reviewer',to_agent_id:'lead',work_item_id:null,goal_revision:t.goal_revision,status:'queued',
                message:`Review requires fixes: ${JSON.stringify(deliveryTask.last_review)}. Select affected existing work_item_ids in retry_work_item_ids, or return a complete amended work_items plan. Unaffected accepted outputs should be preserved.`});
            });
            for(;;) {
              controller.lease.assertOwned();const current=controller.read(id);
              if(controller.closing || current.goal_revision!==goalRevision || ['BLOCKED','PAUSED','CANCELLED','RECOVERY_REQUIRED'].includes(current.state)) throw teamError('team cannot produce revised candidate');
              if(current.state==='READY_FOR_REVIEW' && current.integration) break;
              await controller.tick();await sleep(100);
            }
            controller.update(id,'revised-delivery-started',null,t=>{t.state='DELIVERING';});
            const revised=controller.read(id);boundArtifactId=revised.integration.artifact_id;boundWorkRevision=revised.work_revision;
          }
          assertCurrent();const current=controller.read(id);
          const artifact=current.artifacts.find(a=>a.artifact_id===current.integration.artifact_id);
          const all=current.runs.filter(r=>r.status!=='RUNNING');
          if(controller.running.size && [...controller.running.values()].some(e=>e.teamId===id)) throw teamError('team writers are still active');
          if([...current.runs,...current.delivery_runs].some(r=>r.status==='RUNNING'||!terminationEvidenceConfirmed(r.writer_termination))) throw teamError('all team writer scopes must have termination evidence','TEAM_WRITER_UNCONFIRMED');
          const cas=casFor(controller.runtimeDir,id);
          if(!artifact || !verifySnapshotIntegrity(artifact.snapshot,cas) || current.integration.goal_revision!==goalRevision) throw teamError('candidate provenance is stale');
          replaceCandidateWithSnapshot({candidateDir:cwd,scratchDir:join(cwd,'.af-scratch'),snapshot:artifact.snapshot,cas});
          const integrator=current.runs.find(r=>r.run_id===artifact.run_id);
          deliveryTask.team_writer_executor_types=[...new Set(current.runs.filter(r=>r.status==='COMPLETED').map(r=>r.executor_type))];
          deliveryTask.team_writer_sessions=current.runs.filter(r=>r.session_ref).map(({executor_type,session_ref})=>({executor_type,session_ref}));
          deliveryTask.team_candidate={team_id:id,goal_revision:goalRevision,artifact_id:artifact.artifact_id,
            snapshot_digest:artifact.snapshot.snapshot_digest,input_artifact_ids:current.integration.input_artifact_ids};
          deliveryTask.author_session_executor_type=integrator.executor_type;deliveryTask.author_session_ref=integrator.session_ref??null;
          const result={executor_run_id:integrator.run_id,status:'completed',session_ref:integrator.session_ref??null,
            writer_termination:artifact.writer_termination,writer_terminations:all.map(r=>r.writer_termination),exit_code:0,
            started_at:integrator.started_at,finished_at:integrator.finished_at};
          recordRun(deliveryTask,integrator.executor_type,'author',result,revision>1?'fix':'author');
          return result;
        };
        return resumeV2Workflow(deliveryTask,controller.adapters,{allowV2FailedReentry:true,deliverySource:producer,validateDelivery:assertCurrent,
          onRunSettled:(runId,result)=>{
            controller.update(id,'review-terminated',{run_id:runId},t=>{const claim=t.delivery_runs.find(r=>r.run_id===runId);claim.writer_termination=result.writer_termination;claim.status=terminationEvidenceConfirmed(result.writer_termination)?'COMPLETED':'UNCONFIRMED';});
            if(!terminationEvidenceConfirmed(result.writer_termination)) throw teamError('review scope unconfirmed','TEAM_WRITER_UNCONFIRMED');
          },
          onRunStart:(runId,metadata)=>{
            const current=controller.read(id),versions=reviewedVersions(current,goalRevision),version=`${task.task_id}:${metadata.revision}`;
            const original=read(controller.tasksDir,current.original_delivery_task_id??task.task_id);
            if(!versions.has(version)&&versions.size>=(original.trusted_import.max_revisions??3))throw teamError('goal delivery revision budget exhausted','TEAM_DELIVERY_BUDGET');
            controls.add(runId);registerRunControl(runId,{assertOwnership:assertCurrent,metadata:{team_id:id,agent_id:'reviewer',work_item_id:'review',owner_token:controller.owned.lock.owner_token,runtime_dir:controller.runtimeDir}});
            controller.update(id,'review-claimed',{run_id:runId},t=>{t.delivery_runs.push({run_id:runId,task_id:task.task_id,goal_revision:goalRevision,revision:metadata.revision,owner_token:controller.owned.lock.owner_token,status:'RUNNING'});});
          },
        });
      }});
    const final=read(controller.tasksDir,task.task_id);
    if(controller.read(id).goal_revision===goalRevision && controller.read(id).state==='DELIVERING') controller.update(id,'delivery-settled',{task_id:task.task_id},t=>{
      t.state=final.state==='COMPLETED'?'COMPLETED':final.state==='WAITING_HUMAN'?'WAITING_HUMAN':'BLOCKED';
      t.delivery={...t.delivery,status:final.state,phase:final.trusted_import.phase};t.failure_reason=result.ok?null:result.reason;
    });
    return result;
  } finally {
    const final=read(controller.tasksDir,task.task_id);
    controller.update(id,'review-scopes-recorded',null,t=>{
      for(const claim of t.delivery_runs.filter(r=>controls.has(r.run_id))) {
        const proof=getDurableRunTerminationEvidence(claim.run_id,controller.runtimeDir)?.evidence??final.runs.find(r=>r.executor_run_id===claim.run_id)?.writer_termination;
        claim.writer_termination=proof??null;claim.status=terminationEvidenceConfirmed(proof)?'COMPLETED':'UNCONFIRMED';
      }
      if(t.delivery_runs.some(r=>r.status==='UNCONFIRMED')){t.state='RECOVERY_REQUIRED';t.failure_reason='review scope termination is unconfirmed';}
    });
    for(const runId of controls) releaseRunControl(runId);
  }
}
