// Real Chromium + HTTP/controller checks; model outputs use controlled adapters.
// Run: node qa/team-browser.mjs [--output-dir <directory>]
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnManaged,signalTree} from '../lib/child-process.mjs';
import {fixture,adaptersFor,output,delay,plan} from '../tests/helpers/team-fixture.mjs';
import {ADAPTERS} from '../lib/adapters.mjs';
import {commitTeam,readTeam} from '../lib/team/store.mjs';
import {TeamController} from '../lib/team/controller.mjs';
import {startReadApi} from '../server/read-api.mjs';
import {PROJECT_REGISTRY_SCHEMA} from '../lib/projects.mjs';

import { DevTools } from './browser-client.mjs';

const args=process.argv.slice(2),index=args.indexOf('--output-dir');
const outputDir=resolve(index<0?join(tmpdir(),'af-team-browser'):args[index+1]);mkdirSync(outputDir,{recursive:true});
const fx=fixture(),profile=mkdtempSync(join(tmpdir(),'af-team-chrome-'));let held=false;
// Health is controlled just like model output; this browser run needs no model account.
for(const id of ['codex','cline','command-code'])mock.method(ADAPTERS[id],'health',()=>({ok:true}));
commitTeam(fx.options.runtimeDir,{...readTeam(fx.options.runtimeDir,fx.team.team_id),goal:'设计并交付下一代 Agent 协作工作台'},'browser-fixture',null,()=>{});
const io=adaptersFor(fx,{run:async({capsule,kind},pending)=>kind==='a'&&!held?(held=true,new Promise(resolve=>pending.set(capsule.runId,resolve))):null});
const run=io.adapters.writer.run;
io.adapters.writer.run=async capsule=>{
  const result=await run(capsule);
  if(capsule.work_item_id==='plan')result.structured_result.parsed=output({work_items:plan().map((item,i)=>({...item,goal:['定义 API 与状态契约','设计工作台与交互细节','联调依赖并完成交付验收'][i]}))});
  return result;
};
const controller=new TeamController({...fx.options,...io,autoDeliver:false});
const registryFile=join(fx.root,'projects.json'),workspace=join(fx.root,'workspaces');mkdirSync(workspace,{recursive:true});
writeFileSync(registryFile,JSON.stringify({schema_version:PROJECT_REGISTRY_SCHEMA,projects:[{project_id:'browser-team',root:fx.repo,workspace_root:workspace,
  policy:{allowed_root:['src/**','tests/**'],forbidden:[],protected_paths:[],projection:{exclude:[]},import:{deny:[]}},
  acceptance_profiles:[{profile_id:'default',acceptance:{command:'node',args:['--test','tests/gate.test.mjs']},assets:[]}]}]}));
const server=await startReadApi({roots:{tasks:fx.options.tasksDir,locks:fx.options.locksDir,runtime:fx.options.runtimeDir,alerts:join(fx.root,'alerts.jsonl')},allowRecord:true,allowedRoots:[fx.repo],ensureController:null,
  env:{...process.env,AF_WEB_TOKEN:'browser-test-token',AF_WEB_TOKEN_FILE:'',AF_PROJECTS_FILE:registryFile,AF_SUBMISSION_DIR:join(fx.options.runtimeDir,'submissions')}});
const tickErrors=[],timer=setInterval(()=>controller.tick().catch(err=>tickErrors.push(err.message)),30);
const chrome=spawnManaged(process.env.AF_BROWSER_BIN??'/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let chromeLog='';chrome.stderr.on('data',chunk=>{chromeLog+=chunk.toString();});chrome.on('error',err=>{chromeLog+=err.message;});let browser,report;
try {
  const portFile=join(profile,'DevToolsActivePort'),end=Date.now()+15000;
  while(!existsSync(portFile)&&Date.now()<end&&chrome.exitCode===null)await delay(100);
  if(!existsSync(portFile))throw new Error(`Chromium could not start: ${chromeLog.slice(-2000)}`);
  const port=readFileSync(portFile,'utf8').split('\n')[0];const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  browser=await DevTools.connect(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
  await browser.send('Runtime.enable');await browser.send('Page.enable');
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await browser.send('Page.navigate',{url:server.url+'/'});
  await browser.waitFor("document.querySelectorAll('[data-member]').length===4");
  assert.equal(await browser.evaluate("location.pathname"),'/teams.html','the default entry opens the collaboration workspace');
  await browser.evaluate('document.fonts.ready');
  assert.equal(await browser.evaluate('document.fonts.check(\'800 20px "Foundry Display"\')'),true,'local display font loads');
  assert.equal(await browser.evaluate('document.fonts.check(\'400 24px "Foundry Poster CN"\', "协作目标") && document.fonts.check(\'400 14px "Foundry Sans"\')'),true,'Chinese headings and body fonts load locally');
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.hero-cta'),'::before').clipPath!=='none' && Boolean(document.querySelector('.hero-cta .cta-arrow'))"),true,'the primary action has a cut silhouette and separate arrow plate');
  assert.equal(await browser.evaluate("document.getElementById('start')?.disabled"),true);
  await browser.click('.topbar [data-open=token-dialog]');
  assert.equal(await browser.evaluate("document.activeElement.id==='token'"),true);
  await browser.evaluate("document.getElementById('token').value='browser-test-token'");await browser.click('#save-token');await browser.click('#start');
  await browser.waitFor("document.querySelector('[data-work=b]')?.textContent.includes('产物已接受')");
  const initial=controller.read(fx.team.team_id),bArtifact=initial.work_items.find(i=>i.work_item_id==='b').artifact_id;
  assert.equal(initial.work_items.find(i=>i.work_item_id==='a').status,'RUNNING');
  await browser.click('[data-member=worker-2]');
  assert.equal(await browser.evaluate("document.getElementById('message-dialog').open&&document.activeElement.id==='message'"),true);
  await browser.evaluate("document.getElementById('message').value='<img src=x onerror=\"window.hacked=1\"> explain your API'");await browser.click('#send-message');
  await browser.waitFor("document.getElementById('messages')?.textContent.includes('explain your API')&&document.getElementById('receipts')?.textContent.includes('已落实')");
  assert.equal(await browser.evaluate("Boolean(window.hacked||document.querySelector('#messages img'))"),false);
  await browser.click('[data-work=a]');
  assert.equal(await browser.evaluate("document.getElementById('work-dialog').open&&document.activeElement.id==='direction'"),true);
  await browser.evaluate("document.getElementById('direction').value='按新接口整合工作台，保留独立的视觉设计成果。'");await browser.click('#adjust');
  await browser.waitFor("document.getElementById('team-state')?.textContent==='候选待交付'&&document.getElementById('receipts')?.textContent.includes('调整工作项 · 已落实')");
  const adjusted=controller.read(fx.team.team_id);assert.equal(adjusted.work_items.find(i=>i.work_item_id==='a').revision,2);
  assert.equal(adjusted.work_items.find(i=>i.work_item_id==='b').artifact_id,bArtifact);
  assert.ok(adjusted.runs.some(r=>r.work_item_id==='a'&&r.status==='DISCARDED'));
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),true);
  assert.equal(await browser.evaluate("(()=>{const side=document.querySelector('.sidebar').getBoundingClientRect(),work=document.querySelector('.workspace').getBoundingClientRect(),plan=document.querySelector('.work-area').getBoundingClientRect(),planner=document.querySelector('.planner-console').getBoundingClientRect();return side.right<=work.left+1&&planner.right<plan.left&&Math.abs(plan.top-planner.top)<3;})()"),true,'desktop keeps Planner chat and the plan aligned beside a fixed navigation');
  await browser.evaluate("document.getElementById('messages-tab').focus()");await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});
  assert.equal(await browser.evaluate("document.getElementById('receipts-tab').getAttribute('aria-selected')==='true'&&!document.getElementById('receipts').hidden&&document.activeElement.id==='receipts-tab'"),true,'keyboard switches activity tabs');
  await browser.waitFor("document.getElementById('notice').hidden",9000);
  await browser.evaluate('document.activeElement.blur()');
  await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:250,y:32});
  await delay(300);
  await browser.evaluate("scrollTo({top:0,behavior:'instant'})");
  await browser.screenshot(join(outputDir,'team-desktop.png'));
  await browser.send('Page.reload');await browser.waitFor("document.getElementById('team-state')?.textContent==='候选待交付'");
  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),true);
  await browser.click('#menu-toggle');
  assert.equal(await browser.evaluate("document.getElementById('sidebar').dataset.open==='true'&&document.getElementById('workspace').inert"),true,'mobile navigation excludes background controls');
  await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  assert.equal(await browser.evaluate("document.getElementById('sidebar').inert&&!document.getElementById('workspace').inert&&document.activeElement.id==='menu-toggle'"),true,'Escape closes the navigation and restores focus');
  await browser.waitFor("document.getElementById('sidebar').getBoundingClientRect().right<=1");
  await browser.click('#receipts-tab');
  await browser.evaluate('document.activeElement.blur()');
  await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:220,y:32});
  await browser.evaluate("scrollTo({top:0,behavior:'instant'})");
  await browser.screenshot(join(outputDir,'team-mobile.png'));
  await browser.click('.hero-cta');
  assert.equal(await browser.evaluate("document.getElementById('create-dialog').open&&document.activeElement.id==='goal'"),true);
  await browser.evaluate(`document.getElementById('goal').value='browser-created team';document.getElementById('target').value=${JSON.stringify(fx.repo)};document.getElementById('key').value='browser-create';document.getElementById('args').value='not-json';document.getElementById('create-form').requestSubmit()`);
  await browser.waitFor("document.querySelector('#create-dialog .dialog-feedback')?.textContent.includes('JSON')&&!document.getElementById('create')?.disabled");
  assert.equal(await browser.evaluate("document.getElementById('create-dialog').open&&document.getElementById('goal').value==='browser-created team'"),true,'invalid input keeps the dialog and user draft');
  await browser.evaluate('document.getElementById("args").value=JSON.stringify(["--test","tests/gate.test.mjs"])');
  await browser.evaluate("document.getElementById('planner-executor').value='codex';document.getElementById('planner-executor').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('planner-model-select').value='__custom';document.getElementById('planner-model-select').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('planner-model-input').value='selected/planner-model';document.getElementById('planner-model-input').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('planner-effort').value='high'");
  await browser.click('#create');
  await browser.waitFor("document.getElementById('team-goal')?.textContent==='browser-created team'");
  assert.equal(await browser.evaluate("document.getElementById('create-dialog').open"),false,'successful creation closes the dialog');
  assert.equal(await browser.evaluate("document.querySelectorAll('[data-member]').length"),4);
  const created=readTeam(fx.options.runtimeDir,await browser.evaluate("document.getElementById('team-meta').title"));
  assert.deepEqual(created.planning.planner,{executor_type:'codex',model:'selected/planner-model',effort:'high'});
  const deliveryTask=JSON.parse(readFileSync(join(fx.options.tasksDir,created.delivery_task_id+'.json'),'utf8'));
  assert.equal(deliveryTask.reviewer_model,'selected/planner-model');assert.equal(deliveryTask.reviewer_effort,'high');
  for(const width of [360,768,1024,1920]){await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<720});assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),true,`no overflow at ${width}px`);}
  await browser.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('.member-card')).transitionDuration==='0s'"),true,'reduced motion is honored');
  await browser.send('Page.navigate',{url:server.url+'/#'+fx.task.task_id});
  await browser.waitFor("location.pathname==='/workbench.html'&&document.title.includes('V2')");
  await browser.waitFor("document.querySelectorAll('#tasks .row').length>=2");
  assert.equal(await browser.evaluate('location.hash'),'#'+fx.task.task_id,'historical task bookmarks retain their task identity');
  assert.deepEqual(browser.errors,[]);assert.deepEqual(tickErrors,[]);
  report={ok:true,browser:'Chromium',model_adapters:'controlled test adapters',checks:['default collaboration entry','historical task bookmark compatibility','authenticated pointer actions','four registered members','dependency graph','member message receipt','message escaping','scoped adjustment','unchanged peer artifact','old result discarded','reload persistence','aligned desktop Planner and plan','mobile navigation and focus restoration','registered-profile creation dialog','inline error feedback preserves user draft','keyboard activity tabs','self-hosted display font','local Chinese heading and body typography','cut action and arrow plate','360–1920px responsive layouts','reduced motion','Planner model and effort persist through browser creation','Reviewer receives the selected configuration'],desktop:'team-desktop.png',mobile:'team-mobile.png',verified_at:new Date().toISOString()};
} finally {
  clearInterval(timer);browser?.close();
  if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{
    const timer=setTimeout(()=>{signalTree(chrome,'SIGKILL');},5000);chrome.once('close',()=>{clearTimeout(timer);resolve();});signalTree(chrome,'SIGTERM');
  });
  await controller.close();await server.close();fx.cleanup();rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
writeFileSync(join(outputDir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,output_dir:outputDir},null,2));
