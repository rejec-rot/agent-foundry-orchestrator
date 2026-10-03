// Explicit operator action; discovery GETs never write the canonical registry.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_FOUNDRY_GLOBAL_DIR, EXECUTORS_DIR } from './config.mjs';
import { discoverInstalledAgents,hasNativeCatalog } from './agent-discovery.mjs';
import { ADAPTERS } from './adapters.mjs';
import { disabledExecutors } from './operator-control.mjs';
import { queryNativeCatalog } from './team/native-catalog.mjs';
import { writeJsonAtomic } from './store.mjs';

export async function connectInstalledAgents({ids=null,env=process.env,executorsDir=null,adapters=ADAPTERS,discover=discoverInstalledAgents,catalog=queryNativeCatalog,disabled=disabledExecutors()}={}) {
  const dir=executorsDir??env.AF_EXECUTORS_DIR??EXECUTORS_DIR??'';
  const destination=dir||(AGENT_FOUNDRY_GLOBAL_DIR&&existsSync(join(AGENT_FOUNDRY_GLOBAL_DIR,'AGENTS.md'))?join(AGENT_FOUNDRY_GLOBAL_DIR,'executors'):null);
  if(!destination)throw new Error('EXECUTOR_REGISTRY_MISSING: set AF_EXECUTORS_DIR or provide a governance checkout before connecting agents');
  const installed=discover({env}),selected=ids??installed.map(e=>e.id),results=[];
  for(const id of [...new Set(selected)]) {
    if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new Error('invalid executor ID');
    const client=installed.find(e=>e.id===id),adapter=adapters[id];
    if(!client){results.push({id,status:'not_installed'});continue;}
    if(!adapter){results.push({id,status:'unsupported'});continue;}
    if(disabled.includes(id)||adapter.schedulable===false){results.push({id,status:'disabled'});continue;}
    const file=join(destination,`${id}.json`);
    if(existsSync(file)) {
      let valid=false;try{const value=JSON.parse(readFileSync(file,'utf8'));valid=value.executor_id===id;}catch{}
      results.push({id,status:valid?'already_registered':'invalid_existing_registration'});continue;
    }
    const health=adapter.health?.();if(health?.ok!==true){results.push({id,status:'unhealthy',reason:'native executable or governance is unavailable'});continue;}
    let metadata=null;
    if(hasNativeCatalog(id)) {
      try{metadata=await catalog(id,{env,timeoutMs:12000});}catch{}
      if(metadata?.status!=='ready'){results.push({id,status:'catalog_unavailable'});continue;}
    }
    // Metadata proves installation, not successful inference or exact resume.
    // Those capabilities remain unverified; no synthetic PASS audit is written.
    const record={executor_id:id,platform:'local-cli',blockers:[],
      capabilities_audit:{model_turn:'UNVERIFIED',exact_resume:'UNVERIFIED',mcp_unattended:adapter.supportsMcpUnattended===false?'BLOCKED':'UNVERIFIED'},
      installation:{adapter:'bundled',protocol:client.protocol,client_version:metadata?.client_version??client.client_version??null},
      registration:{source:'af-admin executor connect',checked_at:new Date().toISOString(),catalog_status:metadata?.status??'not_supported',model_count:metadata?.models?.length??null}};
    mkdirSync(destination,{recursive:true});
    try{if(!writeJsonAtomic(file,record,{noOverwrite:true})){results.push({id,status:'already_registered'});continue;}}
    catch(err){if(err.code==='EEXIST'){results.push({id,status:'already_registered'});continue;}throw err;}
    results.push({id,status:'registered',models:metadata?.models?.length??null,model_configuration_required:adapter.requiresModel===true&&!metadata?.models?.length});
  }
  return {registry:destination,results};
}
