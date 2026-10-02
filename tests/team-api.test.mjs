import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,adaptersFor,drive} from './helpers/team-fixture.mjs';
import {startReadApi} from '../server/read-api.mjs';
import {TeamController} from '../lib/team/controller.mjs';
import {PROJECT_REGISTRY_SCHEMA} from '../lib/projects.mjs';
import {pendingCommands,readTeam} from '../lib/team/store.mjs';
import {Scheduler} from '../lib/scheduler.mjs';
import {ADAPTERS} from '../lib/adapters.mjs';

// Team execution already uses adaptersFor(); admission must also be independent
// of installed model accounts while retaining the real routing policy.
for(const id of ['codex','cline','command-code'])mock.method(ADAPTERS[id],'health',()=>({ok:true}));

const TOKEN='team-test-token';
const AUTH={authorization:`Bearer ${TOKEN}`,'x-af-csrf':'1'};
const post=(url,path,body,headers=AUTH)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
async function serve(fx,options={}) {
  const registryFile=join(fx.root,'projects.json'),workspace=join(fx.root,'workspaces');mkdirSync(workspace,{recursive:true});
  writeFileSync(registryFile,JSON.stringify({schema_version:PROJECT_REGISTRY_SCHEMA,projects:[{
    project_id:'team-api',root:fx.repo,workspace_root:workspace,
    policy:{allowed_root:['src/**','tests/**'],forbidden:[],protected_paths:[],projection:{exclude:[]},import:{deny:[]}},
    acceptance_profiles:[{profile_id:'default',acceptance:{command:'node',args:['--test','tests/gate.test.mjs']},assets:[]}],
  }]}));
  return startReadApi({roots:{tasks:fx.options.tasksDir,locks:fx.options.locksDir,runtime:fx.options.runtimeDir,alerts:join(fx.root,'alerts.jsonl')},
    allowRecord:true,allowedRoots:[fx.repo],ensureController:null,redact:false,
    env:{...process.env,AF_WEB_TOKEN:TOKEN,AF_WEB_TOKEN_FILE:'',AF_PROJECTS_FILE:registryFile,AF_SUBMISSION_DIR:join(fx.options.runtimeDir,'submissions')},...options});
}

test('team commands use the existing write token, CSRF and origin controls',async()=>{
  const fx=fixture(),server=await serve(fx);
  try {
    const path=`/api/teams/${fx.team.team_id}/commands`,payload={command:{type:'start'}};
    assert.equal((await post(server.url,path,payload,{})).status,401);
    assert.equal((await post(server.url,path,payload,{authorization:`Bearer ${TOKEN}`})).status,403);
    assert.equal((await post(server.url,path,payload,{...AUTH,origin:'http://evil.example'})).status,403);
    assert.equal(pendingCommands(fx.options.runtimeDir,fx.team).length,0);
    const caps=(await (await fetch(server.url+'/api/v2/capabilities')).json()).model;
    assert.equal(caps.write.team_command,true);assert.equal(caps.write.approve_human_gate,false);
  }finally{await server.close();fx.cleanup();}
});

test('authenticated team commands are durable and duplicate operation IDs do not repeat effects',async()=>{
  const fx=fixture(),io=adaptersFor(fx),controller=new TeamController({...fx.options,...io,autoDeliver:false}),server=await serve(fx);
  try {
    const path=`/api/teams/${fx.team.team_id}/commands`,payload={command:{type:'start'},command_id:'CMD-http'};
    assert.equal((await post(server.url,path,payload)).status,202);assert.equal((await post(server.url,path,payload)).status,202);
    const different=await post(server.url,path,{...payload,command:{type:'pause'}});assert.equal(different.status,409);
    await drive(controller,()=>controller.read(fx.team.team_id).state==='READY_FOR_REVIEW');
    const detail=(await (await fetch(server.url+`/api/teams/${fx.team.team_id}`)).json()).model;
    assert.equal(detail.members.length,4);assert.equal(detail.commands.find(c=>c.command_id==='CMD-http').status,'applied');
    assert.ok(detail.runs.every(r=>!Object.hasOwn(r,'workspace_dir')&&!Object.hasOwn(r,'owner_token')));
    assert.ok(detail.work_items.every(i=>i.status==='DONE'));
    const listing=(await (await fetch(server.url+'/api/teams')).json()).model;assert.equal(listing.teams[0].team_id,fx.team.team_id);
  }finally{await server.close();await controller.close();fx.cleanup();}
});

test('legacy V2 start, messages and cancellation route to the team controller',async()=>{
  const fx=fixture();let ensured=0;
  const server=await serve(fx,{ensureController:async()=>{ensured++;},spawnWorker:()=>{throw new Error('legacy worker must not own a team');}});
  try {
    const prefix=`/api/v2/tasks/${fx.task.task_id}`;
    assert.equal((await post(server.url,prefix+'/start',{})).status,202);
    assert.equal((await post(server.url,prefix+'/messages',{message:'question for the lead'})).status,202);
    assert.equal((await post(server.url,prefix+'/cancel',{reason:'stop all members'})).status,202);
    const commands=pendingCommands(fx.options.runtimeDir,fx.team);assert.deepEqual(commands.map(c=>c.command.type),['start','message','cancel']);
    assert.equal(ensured,3);assert.equal(JSON.parse(readFileSync(join(fx.options.tasksDir,`${fx.task.task_id}.json`),'utf8')).state,'CREATED');
    assert.equal(readdirSync(fx.options.tasksDir).some(n=>n.endsWith('.cancel.json')),false);
  }finally{await server.close();fx.cleanup();}
});

test('team creation binds a registered delivery profile and returns one team for the same key',async()=>{
  const fx=fixture(),server=await serve(fx);
  const spec={goal:'collaborate on a+b=c',target_path:fx.repo,idempotency_key:'team-api-create',acceptance:{command:'node',args:['--test','tests/gate.test.mjs']}};
  try {
    const response=await post(server.url,'/api/teams',{spec,worker_count:3});assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
    const created=(await response.json()).model;assert.equal(readTeam(fx.options.runtimeDir,created.team_id).members.length,4);
    const again=await post(server.url,'/api/teams',{spec,worker_count:3});assert.equal(again.status,200);assert.equal((await again.json()).model.team_id,created.team_id);
    assert.equal((await post(server.url,'/api/teams',{spec,worker_count:2})).status,422);
    assert.equal((await post(server.url,'/api/teams',{spec:{...spec,idempotency_key:'forged',target_path:fx.root},worker_count:3})).status,422);
  }finally{await server.close();fx.cleanup();}
});

test('the legacy scheduler cannot enqueue, start or cancel a team delivery task',()=>{
  const fx=fixture(),scheduler=new Scheduler({tasksDir:fx.options.tasksDir,locksDir:fx.options.locksDir,runtimeDir:fx.options.runtimeDir});
  try {
    assert.throws(()=>scheduler.enqueue(fx.task),/TEAM_CONTROLLER_REQUIRED/);
    assert.throws(()=>scheduler.runTask(fx.task.task_id),/TEAM_CONTROLLER_REQUIRED/);
    assert.throws(()=>scheduler.cancelTask(fx.task.task_id),/TEAM_CONTROLLER_REQUIRED/);
    assert.equal(JSON.parse(readFileSync(join(fx.options.tasksDir,`${fx.task.task_id}.json`),'utf8')).state_version,1);
  }finally{fx.cleanup();}
});
