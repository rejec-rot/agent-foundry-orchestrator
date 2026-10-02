#!/usr/bin/env node
// Collaboration CLI. All execution is delegated to the same leased controller.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveDataRoots } from './lib/data-roots.mjs';
import { loadProjectRegistry } from './lib/projects.mjs';
import { loadAcceptanceAllowlist, acceptanceAllowlistFile, acceptanceCommandAllowed } from './lib/submission.mjs';
import { TeamController } from './lib/team/controller.mjs';
import { listTeams, teamView } from './lib/team/store.mjs';
import { createCollaborationTeam, commandTeam } from './lib/team/service.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
export async function runTeamCli(args=process.argv.slice(2)) {
  const value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  const roots=resolveDataRoots(process.env,ROOT);
  const options={runtimeDir:value('--runtime-dir')??roots.runtime,tasksDir:value('--tasks-dir')??roots.tasks,locksDir:value('--locks-dir')??roots.locks};
  const cmd=args[0];
  if(cmd==='serve') {
    const controller=new TeamController(options);await controller.recover();
    let stopping=false;
    const timer=setInterval(()=>controller.tick().catch(err=>console.error(JSON.stringify({error:err.code??'TEAM_CONTROLLER_FAILED',reason:err.message}))),200);
    await controller.tick();
    const stop=async()=>{if(stopping)return;stopping=true;clearInterval(timer);await controller.close();};
    for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{void stop().then(()=>process.exit(0));});
    return {ok:true,controller_pid:process.pid};
  }
  if(cmd==='create') {
    const file=value('--spec');if(!file) throw new Error('--spec required');
    const spec=JSON.parse(readFileSync(file,'utf8'));
    const registryFile=process.env.AF_PROJECTS_FILE??join(ROOT,'config','projects.json');
    const loaded=loadProjectRegistry({file:registryFile});if(!loaded.ok) throw new Error(loaded.reason);
    const allowedRoots=[];args.forEach((arg,i)=>{if(arg==='--root'&&args[i+1])allowedRoots.push(args[i+1]);});
    return createCollaborationTeam({...options,spec,allowedRoots,workerCount:Number(value('--workers')??3),
      projectRegistry:loaded.registry,registryFile,registryDigest:loaded.digest,
      allowlist:loadAcceptanceAllowlist({file:acceptanceAllowlistFile(process.env)}),acceptanceCommandAllowed});
  }
  if(cmd==='list') return {ok:true,teams:listTeams(options.runtimeDir).map(t=>teamView(options.runtimeDir,t.team_id))};
  const teamId=value('--team');if(!teamId) throw new Error('--team required');
  if(cmd==='show') return teamView(options.runtimeDir,teamId)??{ok:false,reason:'no such team'};
  const command=cmd==='command'?JSON.parse(readFileSync(value('--file'),'utf8')):{type:cmd};
  if(cmd==='message'||cmd==='adjust') {command.message=value('--message');command.agent_id=value('--agent')??undefined;command.work_item_id=value('--work-item')??undefined;}
  if(cmd==='adjust'||cmd==='retry') {command.work_item_id=value('--work-item');if(value('--expected-revision'))command.expected_revision=Number(value('--expected-revision'));}
  if(cmd==='replan') {command.goal=value('--goal');command.expected_goal_revision=Number(value('--expected-goal-revision'));}
  return commandTeam({...options,teamId,command,commandId:value('--operation-id')??undefined});
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url) {
  runTeamCli().then(result=>{console.log(JSON.stringify(result,null,2));if(result?.ok===false)process.exitCode=1;}).catch(err=>{console.error(JSON.stringify({ok:false,code:err.code,reason:err.message}));process.exitCode=1;});
}
