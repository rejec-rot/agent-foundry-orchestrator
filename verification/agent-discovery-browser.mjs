// Browser-level check of local Agent discovery and profile selection. It serves the real web
// files and supplies a small in-memory API response, so it needs neither a registry nor agent CLIs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevTools } from '../qa/browser-client.mjs';

const webRoot=resolve(fileURLToPath(new URL('../web/',import.meta.url)));
const mime={'.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ttf':'font/ttf'};
const model=(id,reasoning_efforts=[],reasoning_status='unverified',default_effort=null)=>({id,label:id,reasoning_efforts,reasoning_status,default_effort});
const catalog=[
  {id:'codex',installed:true,availability:'AVAILABLE',adapter_status:'matched',protocol:'rpc',discovery_source:'Codex command found in the local executable path.',supports_planner:true,supports_model:true,default_model:'codex/default',models:[model('codex/default',['low','high'],'verified')]},
  {id:'cline',installed:false,availability:'AVAILABLE',adapter_status:'matched',protocol:'acp',discovery_source:'Registered Cline adapter.',supports_planner:true,supports_model:true,default_model:'cline/graded',models:[model('cline/graded',['low','high'],'verified'),{...model('cline/toggle',[],'verified'),reasoning_control:'toggle'},{...model('cline/budget',[],'verified'),reasoning_control:'budget'},{id:'cline/unstamped',label:'Unstamped',reasoning_efforts:['high']}]},
  {id:'command-code',installed:true,availability:'AVAILABLE',adapter_status:'matched',protocol:'native-cli',discovery_source:'Command Code executable found locally.',supports_planner:true,supports_model:true,default_model:'command/default',models:[model('command/default',['low','medium','high'],'verified')]},
  {id:'opencode',installed:false,availability:'AVAILABLE',adapter_status:'matched',protocol:'rpc',discovery_source:'Registered OpenCode adapter.',supports_planner:true,supports_model:true,models:[model('opencode/default')]},
  {id:'dsh',installed:true,availability:'AVAILABLE',adapter_status:'matched',protocol:'native-cli',discovery_source:'DSH worker command found locally.',supports_planner:false,supports_model:false,models:[]},
  {id:'qoder',installed:true,availability:'UNREGISTERED',adapter_status:'matched',protocol:'native-cli',discovery_source:'Qoder executable found on this machine.',supports_planner:true,supports_model:true,default_model:'qoder/fast',models:[model('qoder/fast',['low','medium','xhigh'],'verified','medium'),model('qoder/future',['high'])]},
  {id:'pi',installed:true,availability:'UNREGISTERED',adapter_status:'matched',protocol:'rpc',discovery_source:'Pi executable found on this machine.',supports_planner:true,supports_model:true,requires_model:true,models:[model('pi/default',['off','minimal','high'],'verified')]},
  {id:'antigravity',installed:true,availability:'UNAVAILABLE',adapter_status:'matched',protocol:'native-cli',discovery_source:'Antigravity client detected; runtime is unavailable.',supports_planner:true,supports_model:false,models:[]},
  {id:'kiro',installed:true,availability:'UNSUPPORTED',adapter_status:'unsupported',protocol:null,discovery_source:'Kiro client detected; no adapter is registered.',supports_planner:false,supports_model:false,models:[]},
];
const inventory={generated_at:new Date().toISOString(),executors:catalog,scan:{status:'complete',completed_at:new Date().toISOString(),installed_agents:7,matched_agents:8,unmatched_agents:1,available_agents:5,model_count:10}};
let showTeam=false,catalogReads=0;
const team={
  team_id:'team-discovery',task_id:'task-discovery',goal:'Browser discovery check',state:'PLAN_READY',goal_revision:1,plan_revision:1,
  team_revision:1,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),integration:null,paused_from_state:null,
  planning:{workflow:'planner',dispatch_mode:'human',planner:{executor_type:'codex',model:null,effort:null},
    eligible_executors:[{executor_type:'codex',supports_model:true,default_model:'codex/default',models:catalog[0].models},
      {executor_type:'dsh',supports_model:false,models:[]},{executor_type:'qoder',supports_model:true,default_model:'qoder/fast',models:catalog[5].models}],approved_plan_revision:null,agent_config_revision:0},
  members:[{agent_id:'lead',role:'lead',executor_type:'codex',status:'IDLE',model:null,effort:null},
    {agent_id:'worker-1',role:'worker',executor_type:'qoder',status:'IDLE',model:'qoder/fast',effort:null}],
  work_items:[{work_item_id:'work-1',goal:'Check eligible worker options',agent_id:'worker-1',status:'READY',revision:1,depends_on:[]}],
  messages:[],commands:[],runs:[],delivery_runs:[],artifacts:[],rework_requests:[],delivery:null,
};
function json(res,value){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/api/v2/capabilities')return json(res,{read:{workspace:true},write:{team_command:true}});
  if(url.pathname==='/api/v2/executors'){
    // A cold native scan can exceed the ordinary 12-second request budget.
    if(++catalogReads===1){setTimeout(()=>json(res,inventory),13000);return;}
    return json(res,inventory);
  }
  if(url.pathname==='/api/teams')return json(res,{teams:showTeam?[team]:[]});
  if(url.pathname==='/api/teams/team-discovery')return showTeam?json(res,team):json(res,{error:'not found'});
  if(url.pathname.startsWith('/api/'))return json(res,{error:'unexpected API request'});
  let local;
  try{local=resolve(webRoot,'.'+decodeURIComponent(url.pathname));}catch{return res.writeHead(400).end();}
  if(local!==webRoot&&!local.startsWith(webRoot+sep))return res.writeHead(403).end();
  if(!existsSync(local)||!statSync(local).isFile())return res.writeHead(404).end();
  res.writeHead(200,{'content-type':mime[extname(local)]??'application/octet-stream','cache-control':'no-store'});createReadStream(local).pipe(res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address(),origin=`http://127.0.0.1:${address.port}`;
const profile=mkdtempSync(join(tmpdir(),'af-agent-discovery-chrome-'));
const chrome=spawn(process.env.AF_BROWSER_BIN??'/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let chromeLog='',browser;
chrome.stderr.on('data',chunk=>{chromeLog+=chunk.toString();});
const checks=[];
const check=(name,passed)=>{assert.equal(passed,true,name);checks.push(name);console.log(`PASS ${name}`);};
try{
  const portFile=join(profile,'DevToolsActivePort'),end=Date.now()+15000;
  while(!existsSync(portFile)&&Date.now()<end&&chrome.exitCode===null)await new Promise(resolve=>setTimeout(resolve,100));
  if(!existsSync(portFile))throw new Error('Chromium failed to start: '+chromeLog.slice(-1000));
  const port=readFileSync(portFile,'utf8').split('\n')[0];
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  browser=await DevTools.connect(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
  await browser.send('Runtime.enable');await browser.send('Page.enable');
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:"try{sessionStorage.setItem('af-write-token','browser-test-token')}catch{}"});
  await browser.send('Page.navigate',{url:origin+'/teams.html'});
  try{await browser.waitFor("document.getElementById('agent-scan-status')?.textContent.includes('扫描完成')",20000);}
  catch(error){console.error('browser errors:',browser.errors);console.error('page state:',await browser.evaluate("({status:document.getElementById('agent-scan-status')?.textContent,details:document.getElementById('agent-scan-details')?.textContent,connection:document.getElementById('connection')?.textContent,html:document.body.innerText.slice(0,500)})"));throw error;}
  check('a slow native scan completes without the browser aborting and silently retrying',catalogReads===1);
  check('scan summary distinguishes installed, matched, and dispatchable counts',await browser.evaluate("document.getElementById('agent-scan-status').textContent.includes('7 个已安装客户端 / 8 个已匹配适配器 / 5 个当前可派工')"));
  check('discovery details show protocol, adapter status, and public source',await browser.evaluate("(()=>{const cards=[...document.querySelectorAll('.agent-inventory-card')];return cards.length===9&&document.querySelector('.agent-inventory-card[data-adapter=unsupported]')?.textContent.includes('Kiro client detected')&&document.querySelector('.agent-inventory-card[data-adapter=matched] .agent-inventory-heading span')?.textContent==='RPC'})()"));
  check('Planner marks DSH as Worker-only and Kiro as pending adaptation',await browser.evaluate("(()=>{const options=[...document.getElementById('planner-executor').options];return options.find(o=>o.value==='dsh')?.disabled&&options.find(o=>o.value==='dsh')?.textContent.includes('仅 Worker')&&options.find(o=>o.value==='kiro')?.disabled&&options.find(o=>o.value==='kiro')?.textContent.includes('待适配')})()"));
  check('new-team Worker options include DSH and exclude unsupported Kiro',await browser.evaluate("(()=>{document.getElementById('configure-workers').click();const options=[...document.querySelectorAll('[data-profile-executor]')[0].options];return options.some(o=>o.value==='dsh'&&!o.disabled)&&!options.some(o=>o.value==='kiro')})()"));
  await browser.evaluate("(()=>{const s=document.querySelectorAll('[data-profile-executor]')[0];s.value='dsh';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('DSH Worker selection uses the default model and effort only',await browser.evaluate("document.querySelectorAll('[data-profile-model-select]')[0].disabled&&document.querySelectorAll('[data-profile-effort]')[0].disabled"));
  await browser.evaluate("(()=>{const s=document.querySelector('[data-profile-executor]');s.value='cline';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('Cline Worker default model exposes its own verified grades',await browser.evaluate("(()=>{const e=document.querySelector('[data-profile-effort]');return !e.disabled&&[...e.options].map(o=>o.value).filter(Boolean).join(',')==='low,high'})()"));
  await browser.evaluate("(()=>{const m=document.querySelector('[data-profile-model-select]');m.value='cline/toggle';m.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('Cline toggle is explained without fabricated effort values',await browser.evaluate("(()=>{const e=document.querySelector('[data-profile-effort]');return e.disabled&&e.options.length===1&&e.title.includes('思考开关')&&e.options[0].textContent.includes('思考开关')})()"));
  await browser.evaluate("(()=>{const m=document.querySelector('[data-profile-model-select]');m.value='cline/budget';m.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('Cline budget is explained without fabricated effort values',await browser.evaluate("(()=>{const e=document.querySelector('[data-profile-effort]');return e.disabled&&e.options.length===1&&e.title.includes('思考预算')&&e.options[0].textContent.includes('思考预算')})()"));
  await browser.evaluate("(()=>{const m=document.querySelector('[data-profile-model-select]');m.value='cline/unstamped';m.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('saved model grades without a verified status remain disabled',await browser.evaluate("(()=>{const e=document.querySelector('[data-profile-effort]');return e.disabled&&e.options.length===1&&e.value===''})()"));
  await browser.evaluate("(()=>{const s=document.querySelector('[data-profile-executor]');s.value='command-code';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('cmd Worker exposes its own grades instead of Cline or Qoder grades',await browser.evaluate("(()=>{const e=document.querySelector('[data-profile-effort]');return !e.disabled&&[...e.options].map(o=>o.value).filter(Boolean).join(',')==='low,medium,high'})()"));
  await browser.evaluate("(()=>{const s=document.querySelectorAll('[data-profile-executor]')[0];s.value='qoder';s.dispatchEvent(new Event('change',{bubbles:true}));const m=document.querySelectorAll('[data-profile-model-select]')[0];m.value='qoder/fast';m.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('Qoder Worker model exposes only its verified reasoning levels and native default',await browser.evaluate("(()=>{const e=document.querySelectorAll('[data-profile-effort]')[0];return !e.disabled&&[...e.options].map(o=>o.value).filter(Boolean).join(',')==='low,medium,xhigh'&&e.options[0].textContent.includes('medium')})()"));
  await browser.evaluate("(()=>{const m=document.querySelectorAll('[data-profile-model-select]')[0];m.value='qoder/future';m.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('unverified Qoder model keeps reasoning at the default',await browser.evaluate("document.querySelectorAll('[data-profile-effort]')[0].disabled&&document.querySelectorAll('[data-profile-effort]')[0].value===''"));
  await browser.evaluate("document.getElementById('dispatch-dialog').close()");
  await browser.evaluate("(()=>{const s=document.getElementById('console-planner-executor');s.value='cline';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('Cline Planner uses the same exact grades as its Worker',await browser.evaluate("(()=>{const e=document.getElementById('console-planner-effort');return !e.disabled&&[...e.options].map(o=>o.value).filter(Boolean).join(',')==='low,high'&&!document.getElementById('planner-effort').disabled})()"));
  await browser.evaluate("(()=>{const s=document.getElementById('console-planner-executor');s.value='command-code';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('cmd Planner uses its model grades in both configuration forms',await browser.evaluate("(()=>{const e=document.getElementById('console-planner-effort');return !e.disabled&&[...e.options].map(o=>o.value).filter(Boolean).join(',')==='low,medium,high'&&!document.getElementById('planner-effort').disabled})()"));
  await browser.evaluate("(()=>{const s=document.getElementById('console-planner-executor');s.value='qoder';s.dispatchEvent(new Event('change',{bubbles:true}));const m=document.getElementById('console-planner-model-select');m.value='qoder/fast';m.dispatchEvent(new Event('change',{bubbles:true}));const e=document.getElementById('console-planner-effort');e.value='xhigh';e.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('Qoder Planner choice preserves the exact effort in the new-goal dialog',await browser.evaluate("(()=>{const e=document.getElementById('planner-effort');return !e.disabled&&e.value==='xhigh'&&[...e.options].map(o=>o.value).filter(Boolean).join(',')==='low,medium,xhigh'&&e.options[0].textContent.includes('medium')})()"));
  await browser.evaluate("(()=>{const s=document.getElementById('console-planner-executor');s.value='pi';s.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('Pi requires a provider model before saving the Planner configuration',await browser.evaluate("document.getElementById('console-planner-model-select').options[0].disabled&&document.getElementById('console-planner-model-select').options[0].textContent==='请选择模型'&&document.getElementById('save-console-planner').disabled"));
  await browser.evaluate("(()=>{const m=document.getElementById('console-planner-model-select');m.value='pi/default';m.dispatchEvent(new Event('change',{bubbles:true}))})()");
  check('Pi Planner model and verified effort levels are selectable without translating off',await browser.evaluate("(()=>{const m=document.getElementById('console-planner-model-select'),e=document.getElementById('console-planner-effort');return m.value==='pi/default'&&!e.disabled&&[...e.options].some(o=>o.value==='minimal')&&[...e.options].some(o=>o.value==='high')&&[...e.options].some(o=>o.value==='off')&&![...e.options].some(o=>o.value==='none')})()"));
  check('unregistered Planner remains configurable but cannot create a team',await browser.evaluate("document.getElementById('create').disabled&&document.getElementById('model-selection-hint').textContent.includes('注册后才能派工')"));
  showTeam=true;
  await browser.send('Page.reload');
  await browser.waitFor("document.getElementById('team-state')?.textContent==='等待确认计划'");
  await browser.click('#configure-dispatch');
  check('existing team keeps its saved eligible pool and retains Worker-only DSH',await browser.evaluate("(()=>{const options=[...document.querySelectorAll('[data-profile-executor]')[0].options];return options.map(o=>o.value).sort().join(',')==='codex,dsh,qoder'&&Boolean(options.find(o=>o.value==='dsh'&&!o.disabled))})()"));
  check('unregistered Worker can keep model settings but cannot be dispatched',await browser.evaluate("document.getElementById('approve-plan').disabled&&document.getElementById('worker-profile-hint').textContent.includes('当前不能派工')"));
  check('existing team Planner list disables DSH and excludes newly discovered Pi',await browser.evaluate("(()=>{const options=[...document.getElementById('console-planner-executor').options];return options.find(o=>o.value==='dsh')?.disabled&&options.some(o=>o.value==='qoder')&&!options.some(o=>o.value==='pi')})()"));
  assert.deepEqual(browser.errors,[]);
}finally{
  browser?.close();
  if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{chrome.once('close',resolve);chrome.kill('SIGTERM');setTimeout(()=>chrome.kill('SIGKILL'),5000).unref();});
  await new Promise(resolve=>server.close(resolve));
  rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
console.log(JSON.stringify({ok:true,browser:'Chromium',checks},null,2));
