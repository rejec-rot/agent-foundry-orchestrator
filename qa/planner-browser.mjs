// Real Chromium + durable HTTP/controller workflow; model calls are controlled fixtures.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnManaged, signalTree } from '../lib/child-process.mjs';
import { plannerFixture } from '../tests/helpers/planner-team-fixture.mjs';
import { output, plan, delay } from '../tests/helpers/team-fixture.mjs';
import { readTeam, commitTeam } from '../lib/team/store.mjs';
import { TeamController } from '../lib/team/controller.mjs';
import { ADAPTERS } from '../lib/adapters.mjs';
import { startReadApi } from '../server/read-api.mjs';
import { DevTools } from './browser-client.mjs';

const args=process.argv.slice(2),index=args.indexOf('--output-dir');
const outputDir=resolve(index<0?join(tmpdir(),'af-planner-browser'):args[index+1]);mkdirSync(outputDir,{recursive:true});
// Health is controlled just like model output; this browser run needs no model account.
for(const id of ['codex','cline','command-code'])mock.method(ADAPTERS[id],'health',()=>({ok:true}));
let held=false,releaseRevision;
const fx=plannerFixture({
  effort:'high',
  proposal:()=>output({summary:'建议由三位 Worker 分别明确 API、设计界面、联调验收。前两步并行，第三步等待两份成果。你可以调整数量与模型，再确认开工。',
    workers:Array.from({length:3},()=>({executor_type:'writer',model:null})),work_items:plan().map((item,i)=>({...item,goal:['明确 API 与状态契约','设计工作台与交互细节','联调依赖并完成交付验收'][i]}))}),
  run:async({capsule,kind},pending)=>kind==='a'&&!held?(held=true,new Promise(resolve=>pending.set(capsule.runId,resolve))):null,
  revise:()=>new Promise(resolve=>{releaseRevision=()=>resolve(output({summary:'已细化 API 的验收要求，保留界面成果。现在重新下达这个工作项及其依赖任务。',work_items:readTeam(fx.options.runtimeDir,fx.team.team_id).work_items.map(i=>({...i,goal:i.work_item_id==='a'?'细化 API 的错误处理与验收契约':i.goal}))}));}),
});
const initial=readTeam(fx.options.runtimeDir,fx.team.team_id);initial.goal='设计并交付下一代 Agent 协作工作台';
initial.planning.eligible_executors.push({executor_type:'secondary',supports_model:true,supports_effort:true,reasoning_efforts:['medium','high'],models:[{id:'worker-deep',label:'Worker deep',reasoning_efforts:['high'],reasoning_status:'verified'},{id:'worker-no-thinking',label:'Worker no thinking',reasoning_efforts:[],reasoning_status:'verified'}]});
commitTeam(fx.options.runtimeDir,initial,'browser-goal',null,()=>{});
fx.io.adapters.secondary={...fx.io.adapters.writer,type:'secondary'};
fx.io.adapters.codex={...fx.io.adapters.writer,type:'codex'};
const projectWorkspace=join(fx.root,'project-workspaces'),projectsFile=join(fx.root,'browser-projects.json');
mkdirSync(projectWorkspace,{recursive:true});
writeFileSync(projectsFile,JSON.stringify({schema_version:'af-project-registry-v1',projects:[{
  project_id:'browser-project',root:fx.repo,workspace_root:projectWorkspace,
  policy:{allowed_root:['src/**','tests/**'],forbidden:[],protected_paths:[],projection:{exclude:[]},import:{deny:[]}},
  acceptance_profiles:[{profile_id:'browser-acceptance',acceptance:{command:'node',args:['--test','tests/gate.test.mjs']},assets:[]}],
}]}));
const controller=new TeamController({...fx.options,...fx.io,select:id=>fx.io.adapters[id],autoDeliver:false});
const profile=mkdtempSync(join(tmpdir(),'af-planner-chrome-'));
const server=await startReadApi({roots:{tasks:fx.options.tasksDir,locks:fx.options.locksDir,runtime:fx.options.runtimeDir,alerts:join(fx.root,'alerts.jsonl')},allowRecord:true,allowedRoots:[fx.repo],ensureController:null,
  catalogScanner:async()=>null,
  env:{...process.env,AF_WEB_TOKEN:'browser-test-token',AF_WEB_TOKEN_FILE:'',AF_PROJECTS_FILE:projectsFile}});
const tickErrors=[],timer=setInterval(()=>controller.tick().catch(e=>tickErrors.push(e.message)),30);
const chrome=spawnManaged(process.env.AF_BROWSER_BIN??'/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let chromeLog='';chrome.stderr.on('data',chunk=>{chromeLog+=chunk.toString();});let browser,report;
try {
  const portFile=join(profile,'DevToolsActivePort'),end=Date.now()+15000;
  while(!existsSync(portFile)&&Date.now()<end&&chrome.exitCode===null)await delay(100);
  if(!existsSync(portFile))throw new Error('Chromium failed: '+chromeLog.slice(-1000));
  const port=readFileSync(portFile,'utf8').split('\n')[0];const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  browser=await DevTools.connect(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await browser.send('Runtime.enable');await browser.send('Page.enable');
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:"window.agentCatalogRequests=0;const nativeFetch=window.fetch;window.fetch=(url,...args)=>{if(String(url).includes('/api/v2/executors?scan=1'))window.agentCatalogRequests++;return nativeFetch(url,...args);}"});
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await browser.send('Page.navigate',{url:server.url+'/teams.html'});await browser.waitFor("document.getElementById('team-state')?.textContent==='与 Planner 商讨'");
  await browser.evaluate('document.fonts.ready');
  assert.equal(await browser.evaluate("document.getElementById('agent-scan-status').textContent.includes('已加载目录')&&window.agentCatalogRequests===0"),true,'opening the workspace reads metadata without scanning');
  await browser.click('.topbar [data-open=token-dialog]');await browser.evaluate("document.getElementById('token').value='browser-test-token'");await browser.click('#save-token');
  assert.equal(await browser.evaluate("document.querySelector('.planner-console #console-planner-executor')!==null && !document.getElementById('console-planner-form').hidden"),true,'Planner choices are visible in the cockpit');

  const removedCreateIds=['create-dialog','create-form','planner-executor','planner-model-select','planner-model-input','planner-effort','goal','target','command','args','key','create'];
  assert.equal(await browser.evaluate(`(()=>{const removed=${JSON.stringify(removedCreateIds)};return removed.every(id=>!document.getElementById(id))&&document.querySelectorAll('#console-planner-form').length===1&&Boolean(document.getElementById('console-project'))&&Boolean(document.getElementById('console-acceptance'))&&Boolean(document.getElementById('console-dispatch-mode'))})()`),true,'the old create modal and manual command/JSON/key inputs are removed in favor of one workspace configuration');
  await browser.click('.hero-cta');
  assert.equal(await browser.evaluate("!document.querySelector('dialog[open]')&&document.getElementById('work-area').hidden&&document.getElementById('show-worker-tasks').hidden&&document.activeElement.id==='planner-input'"),true,'the hero entry opens one blank full-row Planner session');
  assert.equal(await browser.evaluate("Math.abs(document.querySelector('.planner-console').getBoundingClientRect().width-document.querySelector('.board-columns').getBoundingClientRect().width)<2"),true,'the new Planner composer spans the workspace row');
  assert.equal(await browser.evaluate("document.getElementById('console-dispatch-mode').value==='human'&&document.getElementById('console-project').value==='browser-project'&&document.getElementById('console-acceptance').value==='browser-acceptance'"),true,'the registered local project and acceptance profile load with human approval as the default');
  await browser.evaluate("document.getElementById('console-planner-executor').value='codex';document.getElementById('console-planner-executor').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-model-select').value='__custom';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-model-input').value='custom/planning-model';document.getElementById('console-planner-model-input').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('console-planner-effort').value='high';document.getElementById('console-planner-effort').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-dispatch-mode').value='planner';document.getElementById('console-dispatch-mode').dispatchEvent(new Event('change',{bubbles:true}))");
  const newProfileState=await browser.evaluate("JSON.stringify({executor:document.getElementById('console-planner-executor').value,modelSelect:document.getElementById('console-planner-model-select').value,inputHidden:document.getElementById('console-planner-model-input').hidden,inputValue:document.getElementById('console-planner-model-input').value,effort:document.getElementById('console-planner-effort').value,effortDisabled:document.getElementById('console-planner-effort').disabled,sendDisabled:document.getElementById('planner-send').disabled,hint:document.getElementById('planner-chat-hint').textContent})");
  assert.equal(await browser.evaluate("document.getElementById('console-planner-model-select').value==='custom/planning-model'&&document.getElementById('console-planner-model-input').value==='custom/planning-model'&&document.getElementById('console-planner-effort').value==='high'&&!document.getElementById('planner-send').disabled"),true,'a manually entered catalog model keeps its exact verified effort: '+JSON.stringify(newProfileState));
  assert.equal(await browser.evaluate("[...document.getElementById('console-planner-effort').options].map(o=>o.value).filter(Boolean).join(',')==='low,high'"),true,'custom model effort choices match its catalog metadata');
  const taskCountBeforeCreate=readdirSync(fx.options.tasksDir).filter(name=>name.endsWith('.json')).length;
  const plansBeforeCreate=fx.calls.filter(call=>call.work_item_id==='plan').length;
  await browser.evaluate(`(()=>{window.nativeFetchBeforeCreate=window.fetch;window.createBodies=[];window.failCreateOnce=true;window.fetch=async(url,...options)=>{const opts=options[0]??{};if(String(url).endsWith('/api/teams')&&opts.method==='POST'){window.createBodies.push(JSON.parse(opts.body));if(window.failCreateOnce){window.failCreateOnce=false;throw new TypeError('controlled connection loss before create POST');}}return window.nativeFetchBeforeCreate(url,...options);};document.getElementById('planner-input').value='设计一个能和 Planner 商讨、按项目验收标准派工的协作空间。';const form=document.getElementById('planner-chat-form');for(let i=0;i<2;i++)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));})()`);
  await browser.waitFor("document.getElementById('planner-chat-hint').textContent.includes('目标创建回执未确认')&&!document.getElementById('planner-send').disabled");
  assert.equal(await browser.evaluate("document.getElementById('planner-input').value==='设计一个能和 Planner 商讨、按项目验收标准派工的协作空间。'&&[...document.querySelectorAll('[data-new-goal]')].every(button=>button.disabled)&&window.createBodies.length===1"),true,'an uncertain first create preserves the message, locks new-goal entries, and ignores duplicate submits');
  assert.equal(readdirSync(fx.options.tasksDir).filter(name=>name.endsWith('.json')).length,taskCountBeforeCreate,'a failed pre-POST create leaves no duplicate task or empty plan');
  assert.equal(fx.calls.filter(call=>call.work_item_id==='plan').length,plansBeforeCreate,'starting a chat does not create an empty plan');
  await browser.click('#planner-send');
  await browser.waitFor("document.getElementById('planner-conversation').textContent.includes('建议先明确')&&!document.getElementById('planner-input').value");
  const createdTeamId=await browser.evaluate("document.querySelector('#team-goal')?.textContent&&document.querySelector('#team-meta')?.title");
  assert.ok(createdTeamId?.startsWith('TEAM-'),'the first Planner message creates and selects a team');
  assert.equal(await browser.evaluate("window.createBodies.length===2&&window.createBodies[0].spec.idempotency_key===window.createBodies[1].spec.idempotency_key&&window.createBodies[1].project_id==='browser-project'&&window.createBodies[1].profile_id==='browser-acceptance'&&window.createBodies[1].planning.dispatch_mode==='planner'"),true,'retry reuses one create key and submits the selected project, acceptance profile, and dispatch mode');
  const createdTeam=controller.read(createdTeamId),createdTask=JSON.parse(readFileSync(join(fx.options.tasksDir,createdTeam.delivery_task_id+'.json'),'utf8'));
  assert.equal(createdTeam.planning.dispatch_mode,'planner','the selected dispatch mode is stored with the new team');
  assert.deepEqual(createdTeam.planning.planner,{executor_type:'codex',model:'custom/planning-model',effort:'high'},'the custom Planner profile and exact effort are stored with the new team');
  assert.equal(createdTask.fixture_dir,fx.repo,'the team uses the registered local project directory');
  assert.deepEqual(createdTask.acceptance_cmd,{command:'node',args:['--test','tests/gate.test.mjs']},'the registered acceptance profile supplies the trusted command');
  assert.equal(createdTeam.work_items.length,0,'a new discussion contains no placeholder Worker tasks');
  assert.equal(fx.calls.filter(call=>call.work_item_id==='plan').length,plansBeforeCreate,'a first message does not trigger a plan');
  assert.equal(fx.calls.find(call=>call.team_id===createdTeamId&&call.work_item_id==='discuss')?.model,'custom/planning-model','the selected Planner model reaches the controlled discussion adapter');
  assert.equal(fx.calls.find(call=>call.team_id===createdTeamId&&call.work_item_id==='discuss')?.effort,'high','the exact effort reaches the controlled discussion adapter');
  await browser.evaluate('window.fetch=window.nativeFetchBeforeCreate');
  await browser.click('.team-list-heading [data-new-goal]');
  await browser.click('#refresh');await browser.waitFor("!document.getElementById('refresh').hasAttribute('aria-busy')");
  assert.equal(await browser.evaluate("document.getElementById('team-state').hidden&&document.getElementById('work-area').hidden&&![...document.querySelectorAll('[data-team]')].some(button=>button.getAttribute('aria-current')==='true')"),true,'refresh preserves a blank new-goal workspace instead of reselecting an older team');
  assert.equal(readdirSync(fx.options.tasksDir).filter(name=>name.endsWith('.json')).length,taskCountBeforeCreate+1,'reentering a new-goal workspace does not create another target');
  await browser.click(`#teams [data-team="${fx.team.team_id}"]`);
  await browser.waitFor(`document.getElementById('team-meta').title===${JSON.stringify(fx.team.team_id)}&&document.getElementById('team-state')?.textContent==='与 Planner 商讨'`);
  const restoredProfile=await browser.evaluate("JSON.stringify({teamId:document.getElementById('team-meta').title,executor:document.getElementById('console-planner-executor').value,model:document.getElementById('console-planner-model-input').value,dispatchMode:document.getElementById('console-dispatch-mode').value})");
  assert.equal(await browser.evaluate(`document.getElementById('team-meta').title===${JSON.stringify(fx.team.team_id)}&&document.getElementById('console-planner-executor').value==='writer'`),true,'restoring the fixture is explicit and retains its original team profile: '+restoredProfile);

  await browser.evaluate("document.getElementById('console-planner-executor').value='secondary';document.getElementById('console-planner-executor').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-model-select').value='worker-no-thinking';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}))");
  assert.equal(await browser.evaluate("document.getElementById('console-planner-effort').disabled"),true,'console model choices gate reasoning effort');
  await browser.evaluate("document.getElementById('console-planner-model-select').value='worker-deep';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-effort').value='high';document.getElementById('console-planner-effort').dispatchEvent(new Event('change',{bubbles:true}))");
  assert.equal(await browser.evaluate("document.getElementById('planner-send').disabled"),false,'sending can automatically apply a new Planner profile');
  await browser.click('#scan-agents');await browser.waitFor("window.agentCatalogRequests===1&&!document.getElementById('scan-agents').disabled");
  assert.equal(await browser.evaluate("document.getElementById('console-planner-model-select').value==='worker-deep'&&document.getElementById('console-planner-effort').value==='high'&&!document.getElementById('planner-send').disabled"),true,'rescanning preserves an unsaved Planner profile');
  await browser.evaluate(`(()=>{
    const nativeFetch=window.fetch;window.configRequests=[];window.failConfiguration=true;window.failTeamRead=false;
    window.fetch=async(url,...options)=>{
      const body=options[0]?.body?JSON.parse(options[0].body):null;
      if(body?.command?.type==='configure_agents') {
        window.configRequests.push(body.command_id);
        if(window.failConfiguration){window.failTeamRead=true;throw new TypeError('controlled connection loss before POST');}
        if(window.configRequests.length===2)return new Response(JSON.stringify({model:{reason:'controlled temporary authentication failure'}}),{status:401,headers:{'content-type':'application/json'}});
        const response=await nativeFetch(url,...options);
        if(window.configRequests.length===3)throw new TypeError('controlled response loss after POST');
        return response;
      }
      if(window.failTeamRead&&String(url).includes('/api/teams/')){window.failTeamRead=false;throw new TypeError('controlled receipt connection loss');}
      return nativeFetch(url,...options);
    };
  })()`);
  const callsBeforeOldChat=fx.calls.length;
  await browser.evaluate("document.getElementById('planner-input').value='先商讨模型选择，暂不规划。'");
  await browser.click('#planner-send');await browser.waitFor("document.getElementById('console-profile-hint').textContent.includes('回执未确认')&&!document.getElementById('planner-send').disabled");
  assert.equal(fx.calls.length,callsBeforeOldChat,'uncertain configuration does not send the chat to the old model');
  assert.equal(await browser.evaluate("document.getElementById('planner-input').value==='先商讨模型选择，暂不规划。'&&document.getElementById('console-planner-executor').disabled"),true,'uncertain configuration keeps the message and frozen profile');
  await browser.evaluate('window.failConfiguration=false');
  await browser.click('#planner-send');await browser.waitFor("document.getElementById('notice').textContent.includes('controlled temporary authentication failure')&&!document.getElementById('planner-send').disabled");
  assert.equal(await browser.evaluate("document.getElementById('console-profile-hint').textContent.includes('回执未确认')&&document.getElementById('planner-input').value==='先商讨模型选择，暂不规划。'"),true,'an authentication failure on retry cannot discard an earlier uncertain configuration');
  await browser.click('#planner-send');await browser.waitFor("document.getElementById('planner-model')?.textContent.includes('secondary / worker-deep') && document.getElementById('planner-conversation').textContent.includes('建议先明确') && !document.getElementById('propose-plan').disabled");
  assert.equal(await browser.evaluate('window.configRequests.length===3&&new Set(window.configRequests).size===1'),true,'an explicit retry reuses the exact configuration command ID');
  assert.equal(controller.read(fx.team.team_id).planning.agent_config_revision,1,'a lost response cannot configure twice');
  assert.equal(fx.calls.find(call=>call.team_id===fx.team.team_id&&call.work_item_id==='discuss').model,'worker-deep','direct sending uses the newly selected model');
  assert.equal(fx.calls.find(call=>call.team_id===fx.team.team_id&&call.work_item_id==='discuss').effort,'high','direct sending uses the newly selected reasoning grade');
  assert.equal(fx.calls.filter(x=>['a','b','c'].includes(x.work_item_id)).length,0,'direct discussion does not dispatch Workers');
  let callsAfterChat=fx.calls.length;
  assert.equal(await browser.evaluate("Math.abs(document.querySelector('.planner-console').getBoundingClientRect().width-document.querySelector('.board-columns').getBoundingClientRect().width)<2&&document.getElementById('work-area').hidden"),true,'Planner occupies a whole row while an empty Worker task area stays hidden');
  assert.equal(controller.read(fx.team.team_id).planning.planner.effort,'high');
  await browser.evaluate("document.getElementById('console-planner-executor').value='writer';document.getElementById('console-planner-executor').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-model-select').value='__custom';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-model-input').value='planning-model';document.getElementById('console-planner-model-input').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('console-planner-effort').value='high';document.getElementById('console-planner-effort').dispatchEvent(new Event('change',{bubbles:true}))");
  await browser.click('#save-console-planner');await browser.waitFor("document.getElementById('planner-model')?.textContent.includes('writer / planning-model') && !document.getElementById('propose-plan').disabled");
  await browser.evaluate("document.getElementById('console-planner-model-select').value='saved-model';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-effort').value='low';document.getElementById('console-planner-effort').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('planner-input').value='版本变动后请保留这条消息。'");
  controller.update(fx.team.team_id,'controlled-concurrent-configuration',null,t=>t.planning.agent_config_revision++);
  await browser.click('#planner-send');await browser.waitFor("document.getElementById('notice').textContent.includes('agent configuration changed')&&!document.getElementById('planner-send').disabled");
  assert.equal(await browser.evaluate("document.getElementById('planner-input').value==='版本变动后请保留这条消息。'&&document.getElementById('console-planner-model-select').value==='saved-model'"),true,'a version conflict preserves the input and intended profile');
  assert.equal(fx.calls.length,callsAfterChat,'a rejected configuration cannot chat through the old model');
  await browser.click('#planner-send');await browser.waitFor("document.getElementById('planner-model').textContent.includes('writer / saved-model')&&!document.getElementById('planner-input').value&&!document.getElementById('propose-plan').disabled");
  assert.equal(fx.calls.at(-1).model,'saved-model','an explicit retry uses a fresh revision and the intended model');
  callsAfterChat=fx.calls.length;
  await browser.evaluate("document.getElementById('console-planner-model-select').value='planning-model';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-effort').value='high';document.getElementById('console-planner-effort').dispatchEvent(new Event('change',{bubbles:true}))");
  await browser.click('#save-console-planner');await browser.waitFor("document.getElementById('planner-model').textContent.includes('writer / planning-model')&&!document.getElementById('propose-plan').disabled");
  await browser.click('#configure-workers');
  assert.equal(await browser.evaluate("document.getElementById('assignment-heading').hidden && document.getElementById('approve-plan').textContent.includes('保存 Worker')"),true,'Worker configuration opens before a plan exists');
  await browser.evaluate("document.querySelector('[data-profile-model-select=\"0\"]').value='__custom';document.querySelector('[data-profile-model-select=\"0\"]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-profile-model=\"0\"]').value='unverified-worker';document.querySelector('[data-profile-model=\"0\"]').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await browser.evaluate("document.querySelector('[data-profile-effort=\"0\"]').disabled&&document.querySelector('[data-profile-effort=\"0\"]').value===''"),true,'unknown Worker models cannot inherit an executor grade');
  await browser.evaluate("document.querySelector('[data-profile-model-select=\"0\"]').value='__custom';document.querySelector('[data-profile-model-select=\"0\"]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-profile-model=\"0\"]').value='worker-fast';document.querySelector('[data-profile-model=\"0\"]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-profile-effort=\"0\"]').value='low';document.querySelector('[data-profile-executor=\"1\"]').value='secondary';document.querySelector('[data-profile-executor=\"1\"]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-profile-model-select=\"1\"]').value='worker-deep';document.querySelector('[data-profile-model-select=\"1\"]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-profile-effort=\"1\"]').value='high'");
  await browser.waitFor("getComputedStyle(document.getElementById('dispatch-dialog')).opacity==='1'");
  await browser.screenshot(join(outputDir,'worker-config-desktop.png'),{fullPage:false});
  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await browser.evaluate("document.getElementById('approve-plan').getBoundingClientRect().bottom<=innerHeight && document.getElementById('dispatch-dialog').scrollWidth<=document.getElementById('dispatch-dialog').clientWidth+2"),true,'Worker configuration action stays visible on mobile');
  await browser.screenshot(join(outputDir,'worker-config-mobile.png'),{fullPage:false});
  await browser.click('#approve-plan');await browser.waitFor("document.getElementById('members')?.textContent.includes('worker-fast') && !document.getElementById('propose-plan').disabled");
  assert.equal(controller.read(fx.team.team_id).planning.worker_preferences[1].model,'worker-deep');
  assert.equal(fx.calls.length,callsAfterChat,'configuring Agents does not start Planner or Workers');
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await browser.evaluate("document.getElementById('notice').hidden=true;scrollTo({top:0,behavior:'instant'})");
  await browser.screenshot(join(outputDir,'planner-config-desktop.png'));
  await browser.click('.team-list-heading [data-new-goal]');
  assert.equal(await browser.evaluate("!document.querySelector('dialog[open]')&&document.getElementById('work-area').hidden&&document.getElementById('show-worker-tasks').hidden&&document.getElementById('console-dispatch-mode').value==='human'"),true,'the sidebar entry starts a fresh human-gated Planner workspace');
  await browser.click('#refresh');await browser.waitFor("!document.getElementById('refresh').hasAttribute('aria-busy')");
  assert.equal(await browser.evaluate("document.getElementById('team-state').hidden&&document.getElementById('work-area').hidden&&![...document.querySelectorAll('[data-team]')].some(button=>button.getAttribute('aria-current')==='true')"),true,'ordinary refresh leaves the new workspace unselected');
  await browser.screenshot(join(outputDir,'planner-new-session-desktop.png'),{fullPage:false});
  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await browser.evaluate("document.getElementById('planner-input').scrollIntoView({block:'center',behavior:'instant'})");
  assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth+2&&[...document.querySelectorAll('#console-project,#console-acceptance,#console-dispatch-mode,#planner-send')].every(e=>e.getBoundingClientRect().right<=innerWidth+2)&&document.getElementById('planner-send').getBoundingClientRect().bottom<=innerHeight"),true,'the unified Planner, project, acceptance, and dispatch controls fit the mobile viewport');
  await browser.screenshot(join(outputDir,'planner-new-session-mobile.png'),{fullPage:false});
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await browser.click(`#teams [data-team="${fx.team.team_id}"]`);
  await browser.waitFor(`document.getElementById('team-meta').title===${JSON.stringify(fx.team.team_id)}&&document.getElementById('team-state')?.textContent==='与 Planner 商讨'`);
  await browser.click('[data-prompt]');assert.ok(await browser.evaluate("document.getElementById('planner-input').value.includes('边界')"));
  await browser.evaluate(`document.getElementById('planner-input').value='先分析目标与验收要求，再帮我考虑合适的分工。'`);
  await browser.click('#planner-send');await browser.waitFor("!document.getElementById('propose-plan').disabled");
  assert.ok(fx.calls.some(x=>x.work_item_id==='discuss'&&x.model==='planning-model'),'the restored Planner receives subsequent chat');
  assert.equal(fx.calls.find(x=>x.team_id===fx.team.team_id&&x.work_item_id==='discuss').effort,'high');
  assert.equal(await browser.evaluate("Boolean(window.hacked||document.querySelector('#planner-conversation img'))"),false);
  assert.equal(fx.calls.filter(x=>['a','b','c'].includes(x.work_item_id)).length,0);
  await browser.click('#propose-plan');await browser.waitFor("document.getElementById('team-state')?.textContent==='等待确认计划'&&!document.getElementById('configure-dispatch')?.disabled");
  assert.equal(fx.calls.filter(x=>['a','b','c'].includes(x.work_item_id)).length,0);
  assert.equal(await browser.evaluate("document.querySelector('.reviewer').textContent.includes('planning-model')"),true);
  await browser.evaluate("document.getElementById('notice').hidden=true;scrollTo({top:0,behavior:'instant'})");
  await browser.screenshot(join(outputDir,'planner-desktop.png'));
  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await browser.waitFor("document.getElementById('sidebar').getBoundingClientRect().right<=1");await delay(350);await browser.evaluate("scrollTo({top:0,behavior:'instant'})");await browser.screenshot(join(outputDir,'planner-mobile.png'));
  await browser.click('#configure-dispatch');assert.equal(await browser.evaluate("document.activeElement.id==='dispatch-workers'"),true);
  await browser.evaluate("document.getElementById('dispatch-workers').value='2';document.getElementById('dispatch-workers').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await browser.evaluate("document.querySelectorAll('.worker-profile').length"),2);
  await browser.evaluate(`const first=document.querySelector('[data-profile-model="0"]');first.value='worker-fast';first.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-profile-effort="0"]').value='low';const s=document.querySelector('[data-profile-executor="1"]');s.value='secondary';s.dispatchEvent(new Event('change',{bubbles:true}));const second=document.querySelector('[data-profile-model="1"]');second.value='worker-no-thinking';second.dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.equal(await browser.evaluate("document.querySelector('[data-profile-effort=\"1\"]').disabled"),true,'models without reasoning cannot receive an effort override');
  await browser.evaluate(`(()=>{const second=document.querySelector('[data-profile-model="1"]');second.value='worker-deep';second.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-profile-effort="1"]').value='high';document.querySelector('[data-assignment="c"]').value='worker-2';})()`);
  await browser.waitFor("getComputedStyle(document.getElementById('dispatch-dialog')).opacity==='1'");
  await browser.screenshot(join(outputDir,'planner-dispatch-mobile.png'),{fullPage:false});
  await browser.click('#approve-plan');await browser.waitFor("document.querySelector('[data-work=b]')?.textContent.includes('产物已接受')");
  assert.equal(await browser.evaluate("!document.getElementById('work-area').hidden&&!document.getElementById('show-worker-tasks').hidden&&document.getElementById('worker-task-hint').textContent.includes('暂停旧尝试')&&document.querySelector('[data-work=a] .work-adjust-cta')?.textContent.includes('通过 Planner 调整')"),true,'Worker tasks expose the explicit Planner adjustment action and lifecycle hint');
  await browser.click('#show-worker-tasks');
  assert.equal(await browser.evaluate("document.activeElement?.dataset.work==='a'"),true,'the Worker task navigation focuses the assigned task card');
  const peer=controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id;
  assert.equal(controller.read(fx.team.team_id).members.filter(m=>m.role==='worker').length,2);
  assert.equal(fx.calls.find(x=>x.work_item_id==='a').model,'worker-fast');assert.equal(fx.calls.find(x=>x.work_item_id==='b').model,'worker-deep');
  assert.equal(fx.calls.find(x=>x.work_item_id==='a').effort,'low');assert.equal(fx.calls.find(x=>x.work_item_id==='b').effort,'high');
  assert.equal(controller.read(fx.team.team_id).runs.find(r=>r.work_item_id==='b').executor_type,'secondary');
  await browser.click('[data-work=a]');assert.equal(await browser.evaluate("document.getElementById('work-dialog').open"),true,'clicking the task card opens its adjustment details');await browser.evaluate("document.getElementById('direction').value='补上错误处理的具体契约，保留已经完成的界面。'");await browser.click('#adjust');
  await browser.waitFor("document.querySelector('[data-work=a]')?.textContent.includes('Planner 改向')&&!document.getElementById('rework-status').hidden");
  assert.equal(fx.calls.filter(x=>x.work_item_id==='a').length,1);
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await browser.evaluate("document.getElementById('notice').hidden=true;scrollTo({top:0,behavior:'instant'})");await browser.screenshot(join(outputDir,'planner-rework-desktop.png'));
  await browser.evaluate(`document.getElementById('planner-input').value='<img src=x onerror="window.hacked=1"> 请确认验收要求。'`);await browser.click('#planner-send');
  releaseRevision();await browser.waitFor("document.getElementById('team-state')?.textContent==='候选待交付'");
  assert.equal(controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id,peer);
  assert.equal(controller.read(fx.team.team_id).rework_requests[0].status,'applied');
  assert.equal(await browser.evaluate("Boolean(window.hacked||document.querySelector('#planner-conversation img'))"),false);
  assert.ok(controller.read(fx.team.team_id).runs.some(r=>r.work_item_id==='a'&&r.status==='DISCARDED'));
  await browser.send('Page.reload');await browser.waitFor("document.getElementById('planner-conversation')?.textContent.includes('已细化 API')");
  for(const width of [320,360,768,1024,1920]) {
    await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<=720});
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),true,'no overflow at '+width);
  }
  await browser.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.member-card')).transitionDuration==='0s'"),true);
  assert.deepEqual(browser.errors,[]);assert.deepEqual(tickErrors,[]);
  report={ok:true,browser:'Chromium',model_adapters:'controlled fixtures; real HTTP and controller',checks:['persistent Planner chat','escaped chat messages','manual proposal gate','no dispatch before approval','same Planner/Reviewer model display','worker count changed after planning','distinct executor profiles','per-worker models reach capsules','explicit work assignment','scoped pause before Planner revision','dependent work held','old result discarded','Planner direction receipt','unaffected artifact preserved','conversation survives reload','320–1920px responsive layouts','mobile dispatch dialog','keyboard focus','reduced motion','full-row new-goal navigation','one Planner configuration form','legacy command/JSON/key fields removed','registered local project and acceptance profile selected','custom model and exact effort persisted','dispatch mode persisted with the team','uncertain create retry reuses its key','duplicate submit does not create a second target','new discussion has no placeholder tasks or empty plan','refresh preserves the blank new-goal workspace','explicit existing-team restoration by ID','mobile unified session configuration','visible cockpit Agent/model/effort controls','console model-specific effort gating','direct chat automatically saves the selected Planner before messaging','selected model and reasoning grade reach the direct chat capsule','direct chat never dispatches Workers','full-row Planner layout','uncertain configuration preserves the message and frozen profile','uncertain configuration never sends to the old model','explicit configuration retry keeps its command ID','authentication failure on retry preserves an uncertain configuration','lost configuration response cannot apply twice','version conflicts preserve message and profile','rejected configuration never chats through an old model','explicit conflict retry uses a fresh revision and intended model','live Planner configuration persists','Worker settings available before planning','explicit per-Worker model dropdowns','operator Worker presets persist','configuration does not dispatch any agents','sticky mobile Worker configuration action','Worker task card shows explicit Planner adjustment','Worker task navigation focuses the task','visible cached Agent/model catalog with explicit rescan','rescan preserves unsaved Planner choices','unknown Planner effort stays disabled','unknown Worker effort stays disabled'],verified_at:new Date().toISOString()};
} finally {
  clearInterval(timer);releaseRevision?.();browser?.close();
  if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timeout=setTimeout(()=>signalTree(chrome,'SIGKILL'),5000);chrome.once('close',()=>{clearTimeout(timeout);resolve();});signalTree(chrome,'SIGTERM');});
  await controller.close();await server.close();fx.cleanup();rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  mock.restoreAll();
}
writeFileSync(join(outputDir,'planner-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,output_dir:outputDir},null,2));
