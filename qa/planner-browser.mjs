// Real Chromium + durable HTTP/controller workflow; model calls are controlled fixtures.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnManaged, signalTree } from '../lib/child-process.mjs';
import { plannerFixture } from '../tests/helpers/planner-team-fixture.mjs';
import { output, plan, delay } from '../tests/helpers/team-fixture.mjs';
import { readTeam, commitTeam } from '../lib/team/store.mjs';
import { TeamController } from '../lib/team/controller.mjs';
import { startReadApi } from '../server/read-api.mjs';
import { DevTools } from './browser-client.mjs';

const args=process.argv.slice(2),index=args.indexOf('--output-dir');
const outputDir=resolve(index<0?join(tmpdir(),'af-planner-browser'):args[index+1]);mkdirSync(outputDir,{recursive:true});
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
const controller=new TeamController({...fx.options,...fx.io,select:id=>fx.io.adapters[id],autoDeliver:false});
const profile=mkdtempSync(join(tmpdir(),'af-planner-chrome-'));
const server=await startReadApi({roots:{tasks:fx.options.tasksDir,locks:fx.options.locksDir,runtime:fx.options.runtimeDir,alerts:join(fx.root,'alerts.jsonl')},allowRecord:true,allowedRoots:[fx.repo],ensureController:null,
  catalogScanner:async()=>null,
  env:{...process.env,AF_WEB_TOKEN:'browser-test-token',AF_WEB_TOKEN_FILE:''}});
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
  assert.equal(await browser.evaluate("document.getElementById('agent-scan-status').textContent.includes('扫描完成')&&window.agentCatalogRequests===1"),true,'opening the workspace scans models');
  await browser.click('.topbar [data-open=token-dialog]');await browser.evaluate("document.getElementById('token').value='browser-test-token'");await browser.click('#save-token');
  assert.equal(await browser.evaluate("document.querySelector('.planner-console #console-planner-executor')!==null && !document.getElementById('console-planner-form').hidden"),true,'Planner choices are visible in the cockpit');
  await browser.evaluate("document.getElementById('console-planner-executor').value='secondary';document.getElementById('console-planner-executor').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-model-select').value='worker-no-thinking';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}))");
  assert.equal(await browser.evaluate("document.getElementById('console-planner-effort').disabled"),true,'console model choices gate reasoning effort');
  await browser.evaluate("document.getElementById('console-planner-model-select').value='worker-deep';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-effort').value='high';document.getElementById('console-planner-effort').dispatchEvent(new Event('change',{bubbles:true}))");
  assert.equal(await browser.evaluate("document.getElementById('planner-send').disabled"),true,'unsaved configuration cannot silently use the old Planner');
  await browser.click('#scan-agents');await browser.waitFor("window.agentCatalogRequests===2&&!document.getElementById('scan-agents').disabled");
  assert.equal(await browser.evaluate("document.getElementById('console-planner-model-select').value==='worker-deep'&&document.getElementById('console-planner-effort').value==='high'&&document.getElementById('planner-send').disabled"),true,'rescanning preserves an unsaved Planner profile');
  await browser.click('#save-console-planner');await browser.waitFor("document.getElementById('planner-model')?.textContent.includes('secondary / worker-deep') && !document.getElementById('propose-plan').disabled");
  assert.equal(controller.read(fx.team.team_id).planning.planner.effort,'high');
  await browser.evaluate("document.getElementById('console-planner-executor').value='writer';document.getElementById('console-planner-executor').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-model-select').value='__custom';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('console-planner-model-input').value='planning-model';document.getElementById('console-planner-model-input').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('console-planner-effort').value='high';document.getElementById('console-planner-effort').dispatchEvent(new Event('change',{bubbles:true}))");
  await browser.click('#save-console-planner');await browser.waitFor("document.getElementById('planner-model')?.textContent.includes('writer / planning-model') && !document.getElementById('propose-plan').disabled");
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
  assert.equal(fx.calls.length,0,'configuring Agents does not start Planner or Workers');
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await browser.evaluate("document.getElementById('notice').hidden=true;scrollTo({top:0,behavior:'instant'})");
  await browser.screenshot(join(outputDir,'planner-config-desktop.png'));
  await browser.click('.hero-cta');
  assert.equal(await browser.evaluate("!document.getElementById('create-settings').open&&!document.getElementById('workers')&&document.activeElement.id==='goal'"),true,'creation asks for a goal and Planner, postponing crew size');
  await browser.evaluate("document.getElementById('planner-executor').value='codex';document.getElementById('planner-executor').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('planner-model-select').value='__custom';document.getElementById('planner-model-select').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('planner-model-input').value='custom/planning-model';document.getElementById('planner-model-input').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('planner-effort').value='high'");
  assert.equal(await browser.evaluate("!document.getElementById('planner-model-input').hidden&&document.getElementById('planner-effort').value==='high'"),true);
  await browser.evaluate("document.getElementById('planner-model-input').value='unverified-planner';document.getElementById('planner-model-input').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await browser.evaluate("document.getElementById('planner-effort').disabled&&document.getElementById('planner-effort').value===''"),true,'unknown Planner models cannot inherit an executor grade');
  await browser.evaluate("document.getElementById('planner-executor').value='cline';document.getElementById('planner-executor').dispatchEvent(new Event('change',{bubbles:true}))");
  assert.equal(await browser.evaluate("document.getElementById('planner-model-input').value===''&&document.getElementById('planner-effort').value===''&&![...document.getElementById('planner-effort').options].some(o=>o.value==='max')"),true,'changing Agent clears incompatible overrides and constrains effort levels');
  await browser.evaluate("document.getElementById('planner-executor').value='codex';document.getElementById('planner-executor').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('planner-effort').value='high';document.getElementById('goal').value='设计一个能和 Planner 商讨、按计划派工的协作空间。'");
  await browser.waitFor("getComputedStyle(document.getElementById('create-dialog')).opacity==='1'");
  await browser.screenshot(join(outputDir,'planner-create-desktop.png'),{fullPage:false});
  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await browser.evaluate("document.getElementById('create-dialog').scrollWidth<=document.getElementById('create-dialog').clientWidth+2"),true);
  assert.equal(await browser.evaluate("document.getElementById('create').getBoundingClientRect().bottom<=innerHeight"),true,'the primary action remains visible on mobile');
  await browser.screenshot(join(outputDir,'planner-create-mobile.png'),{fullPage:false});
  await browser.click('#create-dialog [data-close]');
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await browser.click('[data-prompt]');assert.ok(await browser.evaluate("document.getElementById('planner-input').value.includes('边界')"));
  await browser.evaluate(`document.getElementById('planner-input').value='先分析目标与验收要求，再帮我考虑合适的分工。'`);
  await browser.click('#planner-send');await browser.waitFor("document.getElementById('planner-conversation')?.textContent.includes('建议先明确')");
  assert.equal(fx.calls.find(x=>x.work_item_id==='discuss').effort,'high');
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
  const peer=controller.read(fx.team.team_id).work_items.find(i=>i.work_item_id==='b').artifact_id;
  assert.equal(controller.read(fx.team.team_id).members.filter(m=>m.role==='worker').length,2);
  assert.equal(fx.calls.find(x=>x.work_item_id==='a').model,'worker-fast');assert.equal(fx.calls.find(x=>x.work_item_id==='b').model,'worker-deep');
  assert.equal(fx.calls.find(x=>x.work_item_id==='a').effort,'low');assert.equal(fx.calls.find(x=>x.work_item_id==='b').effort,'high');
  assert.equal(controller.read(fx.team.team_id).runs.find(r=>r.work_item_id==='b').executor_type,'secondary');
  await browser.click('[data-work=a]');await browser.evaluate("document.getElementById('direction').value='补上错误处理的具体契约，保留已经完成的界面。'");await browser.click('#adjust');
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
  report={ok:true,browser:'Chromium',model_adapters:'controlled fixtures; real HTTP and controller',checks:['persistent Planner chat','escaped chat messages','manual proposal gate','no dispatch before approval','same Planner/Reviewer model display','worker count changed after planning','distinct executor profiles','per-worker models reach capsules','explicit work assignment','scoped pause before Planner revision','dependent work held','old result discarded','Planner direction receipt','unaffected artifact preserved','conversation survives reload','320–1920px responsive layouts','mobile dispatch dialog','keyboard focus','reduced motion','compact goal creation','custom model selection','executor-specific effort choices','changing Agent clears incompatible overrides','model-specific effort gating','Planner effort reaches execution','per-worker effort reaches execution','mobile create dialog','visible cockpit Agent/model/effort controls','console model-specific effort gating','unsaved Planner configuration blocks old-model chat','live Planner configuration persists','Worker settings available before planning','explicit per-Worker model dropdowns','operator Worker presets persist','configuration does not dispatch any agents','sticky mobile Worker configuration action','visible automatic Agent/model scan','rescan preserves unsaved Planner choices','unknown Planner effort stays disabled','unknown Worker effort stays disabled'],verified_at:new Date().toISOString()};
} finally {
  clearInterval(timer);releaseRevision?.();browser?.close();
  if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timeout=setTimeout(()=>signalTree(chrome,'SIGKILL'),5000);chrome.once('close',()=>{clearTimeout(timeout);resolve();});signalTree(chrome,'SIGTERM');});
  await controller.close();await server.close();fx.cleanup();rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
writeFileSync(join(outputDir,'planner-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,output_dir:outputDir},null,2));
