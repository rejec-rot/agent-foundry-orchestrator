// Shared intake/control entry for HTTP and CLI. It never runs an agent itself.
import { mkdirSync, readFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createV2Task } from '../v2-service.mjs';
import { saveTaskWithVersion } from '../store.mjs';
import { acquireTaskLock, releaseTaskLock, readLock, isLockStale } from '../tasklock.mjs';
import { spawnManaged } from '../child-process.mjs';
import { ADAPTERS, AUTO_SELECTABLE_ORDER } from '../adapters.mjs';
import { executorEligibility } from '../executor-eligibility.mjs';
import { loadCapabilityMap } from '../executor-router.mjs';
import { loadExecutorStatus } from '../executor-status.mjs';
import { runtimeGuard } from '../executor-runtime-guard.mjs';
import { disabledExecutors } from '../operator-control.mjs';
import { newTeam, teamError } from './model.mjs';
import { createTeamRecord, readTeam, submitTeamCommand } from './store.mjs';

const CLI=fileURLToPath(new URL('../../af-team.mjs',import.meta.url));
export function createCollaborationTeam({ runtimeDir, workerCount=3, ...options }={}) {
  if(!runtimeDir) return {ok:false,reason:'runtimeDir required'};
  if(!Number.isInteger(workerCount)||workerCount<1||workerCount>8) return {ok:false,reason:'workerCount must be 1..8'};
  const created=createV2Task(options);if(!created.ok) return created;
  const id=`TEAM-${created.task_id}`;
  const existing=readTeam(runtimeDir,id);
  if(existing) return existing.members.length!==workerCount+1 ? {ok:false,reason:'idempotency key already created a different team size'} : {ok:true,created:false,team_id:id,task_id:existing.delivery_task_id};
  const owned=acquireTaskLock(options.locksDir??join(runtimeDir,'locks'),created.task_id,{orchestratorInstanceId:`team-intake-${randomUUID()}`});
  try {
    const task=JSON.parse(readFileSync(join(options.tasksDir,`${created.task_id}.json`),'utf8'));
    if(task.state!=='CREATED' || task.execution?.status==='DISPATCHED') throw teamError('only a new, undispatched delivery task can create a team');
    const team=newTeam(task,{workerCount});
    const adapters=options.adapters??ADAPTERS;
    const eligibility={adapters,capabilityMap:options.capabilityMap??loadCapabilityMap(),availabilityMap:options.availabilityMap??loadExecutorStatus(),
      runtimeGuard:options.runtimeGuard??runtimeGuard,disabled:disabledExecutors(),requireHealth:true};
    const pool=[task.author_executor,...AUTO_SELECTABLE_ORDER,...Object.keys(adapters)].filter((id,i,all)=>all.indexOf(id)===i&&id!==task.reviewer_executor&&executorEligibility(id,{},eligibility).ok);
    if(!pool.length) throw teamError('no eligible team writer executor');
    team.members.filter(m=>m.role==='worker').forEach((member,i)=>{member.executor_type=pool[i%pool.length];});
    team.original_delivery_task_id=task.task_id;
    task.team_binding={team_id:id,goal_revision:1};
    saveTaskWithVersion(options.tasksDir,task);
    createTeamRecord(runtimeDir,team);
    return {ok:true,created:true,team_id:id,task_id:task.task_id};
  } catch(err) {return {ok:false,reason:err.message,code:err.code};}
  finally {releaseTaskLock(options.locksDir??join(runtimeDir,'locks'),created.task_id,owned.lock);}
}
export async function ensureTeamController({runtimeDir,tasksDir,locksDir,env=process.env,launcher=spawnManaged}={}) {
  const lock=readLock(locksDir,'team-controller');
  if(lock&&!isLockStale(lock)) return {ok:true,pid:lock.pid,already_running:true};
  mkdirSync(runtimeDir,{recursive:true});
  const fd=openSync(join(runtimeDir,'team-controller.log'),'a',0o600);
  try {
    const child=launcher(process.execPath,[CLI,'serve','--runtime-dir',runtimeDir,'--tasks-dir',tasksDir,'--locks-dir',locksDir],{
      detached:true,stdio:['ignore',fd,fd],env:{...env,AF_RUNTIME_DIR:runtimeDir,AF_TASKS_DIR:tasksDir,AF_LOCKS_DIR:locksDir},
    });
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
    return {ok:true,pid:child.pid,already_running:false};
  } finally {closeSync(fd);}
}
export async function commandTeam({runtimeDir,tasksDir,locksDir,teamId,command,commandId,actor,ensure=ensureTeamController}={}) {
  const result=submitTeamCommand({runtimeDir,teamId,command,commandId,actor});
  if(ensure) await ensure({runtimeDir,tasksDir,locksDir});
  return result;
}
