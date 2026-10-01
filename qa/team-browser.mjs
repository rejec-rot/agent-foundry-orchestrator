// Real Chromium + HTTP/controller checks; model outputs use controlled adapters.
// Run: node qa/team-browser.mjs [--output-dir <directory>]
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnManaged,signalTree} from '../lib/child-process.mjs';
import {fixture,adaptersFor,output,delay} from '../tests/helpers/team-fixture.mjs';
import {TeamController} from '../lib/team/controller.mjs';
import {startReadApi} from '../server/read-api.mjs';
import {PROJECT_REGISTRY_SCHEMA} from '../lib/projects.mjs';

class DevTools {
  constructor(ws){this.ws=ws;this.sequence=0;this.pending=new Map();this.errors=[];
    ws.addEventListener('message',event=>{const message=JSON.parse(event.data);const pending=this.pending.get(message.id);
      if(pending){this.pending.delete(message.id);clearTimeout(pending.timer);message.error?pending.reject(new Error(message.error.message)):pending.resolve(message.result);}
      if(message.method==='Runtime.exceptionThrown')this.errors.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);
    });
  }
  static async connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});return new DevTools(ws);}
  send(method,params={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`DevTools timeout: ${method}`));},15000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const result=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;}
  async waitFor(expression,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await this.evaluate(expression))return;await delay(100);}throw new Error(`browser state timeout: ${expression}`);}
  async screenshot(path){const result=await this.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});writeFileSync(path,Buffer.from(result.data,'base64'));}
  close(){this.ws.close();}
}

const args=process.argv.slice(2),index=args.indexOf('--output-dir');
const outputDir=resolve(index<0?join(tmpdir(),'af-team-browser'):args[index+1]);mkdirSync(outputDir,{recursive:true});
const fx=fixture(),profile=mkdtempSync(join(tmpdir(),'af-team-chrome-'));let held=false;
const io=adaptersFor(fx,{run:async({capsule,kind},pending)=>kind==='a'&&!held?(held=true,new Promise(resolve=>pending.set(capsule.runId,resolve))):null});
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
  await browser.send('Page.navigate',{url:server.url+'/teams.html'});
  await browser.waitFor("document.querySelectorAll('[data-member]').length===4");
  assert.equal(await browser.evaluate("document.getElementById('start').disabled"),true);
  await browser.evaluate("document.getElementById('token').closest('details').open=true;document.getElementById('token').value='browser-test-token';document.getElementById('save-token').click();document.getElementById('start').click()");
  await browser.waitFor("document.querySelector('[data-work=b]')?.textContent.includes('产物已接受')");
  const initial=controller.read(fx.team.team_id),bArtifact=initial.work_items.find(i=>i.work_item_id==='b').artifact_id;
  assert.equal(initial.work_items.find(i=>i.work_item_id==='a').status,'RUNNING');
  await browser.evaluate("document.querySelector('[data-member=worker-2]').click();document.getElementById('message').value='<img src=x onerror=\"window.hacked=1\"> explain your API';document.getElementById('send-message').click()");
  await browser.waitFor("document.getElementById('messages').textContent.includes('explain your API')&&document.getElementById('receipts').textContent.includes('已落实')");
  assert.equal(await browser.evaluate("Boolean(window.hacked||document.querySelector('#messages img'))"),false);
  await browser.evaluate("document.querySelector('[data-work=a]').click();document.getElementById('direction').value='use the updated interface';document.getElementById('adjust').click()");
  await browser.waitFor("document.getElementById('team-state').textContent==='候选待交付'&&document.getElementById('receipts').textContent.includes('adjust · 已落实')");
  const adjusted=controller.read(fx.team.team_id);assert.equal(adjusted.work_items.find(i=>i.work_item_id==='a').revision,2);
  assert.equal(adjusted.work_items.find(i=>i.work_item_id==='b').artifact_id,bArtifact);
  assert.ok(adjusted.runs.some(r=>r.work_item_id==='a'&&r.status==='DISCARDED'));
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),true);
  assert.equal(await browser.evaluate("(()=>{const panes=[...document.querySelectorAll('.team-shell>.pane')].map(e=>e.getBoundingClientRect());return panes[0].x<panes[1].x&&panes[1].x<panes[2].x&&Math.abs(panes[0].y-panes[1].y)<2;})()"),true,'desktop presents three adjacent panes');
  await browser.screenshot(join(outputDir,'team-desktop.png'));
  await browser.send('Page.reload');await browser.waitFor("document.getElementById('team-state').textContent==='候选待交付'");
  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),true);
  await browser.screenshot(join(outputDir,'team-mobile.png'));
  await browser.evaluate(`document.getElementById('goal').value='browser-created team';document.getElementById('target').value=${JSON.stringify(fx.repo)};document.getElementById('key').value='browser-create';document.getElementById('create-form').requestSubmit()`);
  await browser.waitFor("document.getElementById('team-goal').textContent==='browser-created team'");
  assert.equal(await browser.evaluate("document.querySelectorAll('[data-member]').length"),4);
  assert.deepEqual(browser.errors,[]);assert.deepEqual(tickErrors,[]);
  report={ok:true,browser:'Chromium',model_adapters:'controlled test adapters',checks:['authenticated browser actions','four registered members','dependency graph','member message receipt','message escaping','scoped adjustment','unchanged peer artifact','old result discarded','reload persistence','desktop three-column layout','mobile layout','registered-profile creation'],desktop:'team-desktop.png',mobile:'team-mobile.png',verified_at:new Date().toISOString()};
} finally {
  clearInterval(timer);browser?.close();
  if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{
    const timer=setTimeout(()=>{signalTree(chrome,'SIGKILL');},5000);chrome.once('close',()=>{clearTimeout(timer);resolve();});signalTree(chrome,'SIGTERM');
  });
  await controller.close();await server.close();fx.cleanup();rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
writeFileSync(join(outputDir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,output_dir:outputDir},null,2));
