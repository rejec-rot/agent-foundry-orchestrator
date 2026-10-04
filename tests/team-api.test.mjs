import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,adaptersFor,drive} from './helpers/team-fixture.mjs';
import {startReadApi} from '../server/read-api.mjs';
import {TeamController} from '../lib/team/controller.mjs';
import {PROJECT_REGISTRY_SCHEMA} from '../lib/projects.mjs';
import {pendingCommands,readTeam} from '../lib/team/store.mjs';
import {Scheduler} from '../lib/scheduler.mjs';
import {ADAPTERS} from '../lib/adapters.mjs';
import {createCollaborationTeam} from '../lib/team/service.mjs';
import {setDiscoveredModels} from '../lib/team/agent-options.mjs';
import {clineProvider} from '../lib/team/native-catalog.mjs';

// Team execution already uses adaptersFor(); admission must also be independent
// of installed model accounts while retaining the real routing policy.
for(const id of ['codex','cline','command-code'])mock.method(ADAPTERS[id],'health',()=>({ok:true}));

const TOKEN='team-test-token';

test('an installed but unregistered Planner cannot create a team even with a healthy adapter',()=>{
  const fx=fixture();
  try {
    const result=createCollaborationTeam({...fx.options,adapters:{codex:{health:()=>({ok:true})}},capabilityMap:new Map(),availabilityMap:new Map(),planning:{planner:{executor_type:'codex',model:'any-model',effort:'high'}}});
    assert.equal(result.ok,false);assert.match(result.reason,/not available/);
    assert.deepEqual(readdirSync(fx.options.tasksDir),[fx.task.task_id+'.json']);
  }finally{fx.cleanup();}
});
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

test('project listing returns only canonical IDs, is read-only, and reports an absent registry',async()=>{
  const fx=fixture(),server=await serve(fx,{redact:true}),registryFile=join(fx.root,'projects.json');
  try {
    const original=readFileSync(registryFile,'utf8'),tasksBefore=readdirSync(fx.options.tasksDir).sort(),runtimeBefore=readdirSync(fx.options.runtimeDir).sort();
    const response=await fetch(server.url+'/api/v2/projects');assert.equal(response.status,200);
    const body=await response.json();assert.equal(body.model.schema,'af-v2-projects-v1');assert.equal(body.model.configured,true);
    assert.deepEqual(body.model.projects,[{project_id:'team-api',profiles:[{profile_id:'default'}]}]);
    assert.equal(body.paths_redacted,true);assert.equal(body.path_mode,'hash');
    assert.doesNotMatch(JSON.stringify(body),/canonical|workspaces|gate\.test\.mjs|acceptance\.command/);
    assert.deepEqual(readdirSync(fx.options.tasksDir).sort(),tasksBefore,'GET must not create tasks');
    assert.deepEqual(readdirSync(fx.options.runtimeDir).sort(),runtimeBefore,'GET must not create runtime state');
    assert.equal(readFileSync(registryFile,'utf8'),original,'GET must not rewrite the canonical registry');

    rmSync(registryFile);
    const missing=await fetch(server.url+'/api/v2/projects');assert.equal(missing.status,200);
    const missingBody=await missing.json();assert.equal(missingBody.model.schema,'af-v2-projects-v1');
    assert.equal(missingBody.model.configured,false);assert.deepEqual(missingBody.model.projects,[]);
  }finally{await server.close();fx.cleanup();}
});

test('registry-scoped team creation uses the selected trusted profile and is idempotent',async()=>{
  const fx=fixture(),server=await serve(fx);
  const request={project_id:'team-api',profile_id:'default',spec:{goal:'create from the planner chat',idempotency_key:'project-scoped-team-api'}};
  try {
    const before=readdirSync(fx.options.tasksDir).sort();
    assert.equal((await post(server.url,'/api/teams',request,{})).status,401,'project-scoped creation remains authenticated');
    assert.deepEqual(readdirSync(fx.options.tasksDir).sort(),before);

    const response=await post(server.url,'/api/teams',request);assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
    const created=(await response.json()).model,team=readTeam(fx.options.runtimeDir,created.team_id);
    const task=JSON.parse(readFileSync(join(fx.options.tasksDir,`${created.task_id}.json`),'utf8'));
    assert.equal(task.fixture_dir,fx.repo,'target path comes from the registered project');
    assert.deepEqual(task.acceptance_cmd,{command:'node',args:['--test','tests/gate.test.mjs']});
    assert.equal(task.trusted_import.acceptance.dependency_fixture_id,'team-api');
    assert.ok(task.trusted_import.acceptance.acceptance_profile_digest,'V2 task binds the resolved trusted profile');

    const afterFirst=readdirSync(fx.options.tasksDir).sort();
    const again=await post(server.url,'/api/teams',request);assert.equal(again.status,200);
    assert.equal((await again.json()).model.team_id,created.team_id);
    assert.deepEqual(readdirSync(fx.options.tasksDir).sort(),afterFirst,'an idempotent retry must not create another task');
  }finally{await server.close();fx.cleanup();}
});

test('registry-scoped team creation fails closed for unknown or ambiguous IDs and caller-supplied trust fields',async()=>{
  const fx=fixture(),server=await serve(fx),registryFile=join(fx.root,'projects.json');
  try {
    const beforeTasks=readdirSync(fx.options.tasksDir).sort(),beforeRuntime=readdirSync(fx.options.runtimeDir).sort();
    const cases=[
      {project_id:'missing-project',profile_id:'default',spec:{goal:'x',idempotency_key:'unknown-project'}},
      {project_id:'team-api',profile_id:'missing-profile',spec:{goal:'x',idempotency_key:'unknown-profile'}},
      {project_id:'team-api',profile_id:'default',spec:{goal:'x',idempotency_key:'caller-path',target_path:fx.root}},
      {project_id:'team-api',profile_id:'default',spec:{goal:'x',idempotency_key:'caller-acceptance',acceptance:{command:'sh',args:['-c','echo untrusted']}}},
      {project_id:'team-api',profile_id:'default',target_path:fx.root,spec:{goal:'x',idempotency_key:'top-level-path'}},
    ];
    for(const request of cases) {
      const response=await post(server.url,'/api/teams',request);assert.equal(response.status,422,JSON.stringify(await response.clone().json()));
      assert.deepEqual(readdirSync(fx.options.tasksDir).sort(),beforeTasks);
      assert.deepEqual(readdirSync(fx.options.runtimeDir).sort(),beforeRuntime);
    }

    const registry=JSON.parse(readFileSync(registryFile,'utf8'));
    registry.projects[0].acceptance_profiles.push({...registry.projects[0].acceptance_profiles[0]});
    writeFileSync(registryFile,JSON.stringify(registry));
    const ambiguous=await post(server.url,'/api/teams',{project_id:'team-api',profile_id:'default',spec:{goal:'x',idempotency_key:'ambiguous-profile'}});
    assert.equal(ambiguous.status,422);assert.match((await ambiguous.json()).model.reason,/ambiguous/);
    assert.deepEqual(readdirSync(fx.options.tasksDir).sort(),beforeTasks);
    assert.deepEqual(readdirSync(fx.options.runtimeDir).sort(),beforeRuntime);
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

test('Planner intake binds the selected model to an independent Reviewer session and rejects changed configurations',async()=>{
  const fx=fixture(),server=await serve(fx);
  const spec={goal:'discuss then dispatch',target_path:fx.repo,idempotency_key:'planner-api-create',acceptance:{command:'node',args:['--test','tests/gate.test.mjs']}};
  const planning={dispatch_mode:'human',planner:{executor_type:'codex',model:'operator-selected-model',effort:'high'},workers:[{executor_type:'codex',model:'worker-model',effort:'low'},{executor_type:'cline',model:null,effort:'xhigh'}]};
  try {
    setDiscoveredModels('cline',undefined);
    const cold=await post(server.url,'/api/teams',{spec,planning});assert.equal(cold.status,422,'Cline cached grades cannot bypass the missing CLI acceptance scan');
    setDiscoveredModels('cline',{status:'ready',provider:clineProvider(),model_source:'test-only native catalog',client_reasoning_efforts:['none','low','medium','high','xhigh'],models:[{id:'fixture-cline-model',reasoning_efforts:['low','medium','high','xhigh'],reasoning_status:'verified'}]});
    const response=await post(server.url,'/api/teams',{spec,planning});assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
    const id=(await response.json()).model.team_id,team=readTeam(fx.options.runtimeDir,id);
    assert.equal(team.state,'DISCUSSING');assert.equal(team.members[0].model,'operator-selected-model');
    assert.equal(team.members[0].effort,'high');assert.equal(team.planning.planner.effort,'high');
    assert.deepEqual(team.members.filter(m=>m.role==='worker').map(m=>m.executor_type),['codex','cline']);
    const task=JSON.parse(readFileSync(join(fx.options.tasksDir,team.delivery_task_id+'.json'),'utf8'));
    assert.equal(task.reviewer_executor,task.author_executor);assert.equal(task.reviewer_model,task.author_model);
    assert.equal(task.author_effort,'high');assert.equal(task.reviewer_effort,'high');assert.equal(task.team_review_policy.effort,'high');
    assert.equal(task.team_review_policy.team_id,id);
    assert.equal((await post(server.url,'/api/teams',{spec,planning})).status,200);
    const health=ADAPTERS.codex.health;
    try {ADAPTERS.codex.health=()=>({ok:false});assert.equal((await post(server.url,'/api/teams',{spec,planning})).status,200,'an executor becoming unhealthy does not change an existing submission identity');}
    finally {ADAPTERS.codex.health=health;}
    assert.equal((await post(server.url,'/api/teams',{spec,planning:{...planning,planner:{executor_type:'codex',model:'different-model'}}})).status,422);
    assert.equal((await post(server.url,'/api/teams',{spec,planning:{...planning,planner:{...planning.planner,effort:'low'}}})).status,422);
    assert.equal((await post(server.url,'/api/teams',{spec:{...spec,idempotency_key:'invalid-effort'},planning:{...planning,planner:{...planning.planner,effort:'high"; unsafe'}}})).status,422);
    assert.equal((await post(server.url,'/api/teams',{spec:{...spec,idempotency_key:'wrong-executor-effort'},planning:{...planning,planner:{executor_type:'cline',effort:'max'}}})).status,422);
    assert.equal((await post(server.url,'/api/teams',{spec:{...spec,idempotency_key:'invalid-profile'},planning:{...planning,planner:{executor_type:'unknown'}}})).status,422);
    assert.equal((await post(server.url,'/api/teams',{spec:{...spec,idempotency_key:'invalid-planning'},planning:'bad'})).status,422);
  }finally{setDiscoveredModels('cline',undefined);await server.close();fx.cleanup();}
});
