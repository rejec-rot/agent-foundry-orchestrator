// Real Chromium + canonical directory/registration API. No Agent runs or native scans.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createReadApi } from '../server/read-api.mjs';
import { spawnManaged, signalTree } from '../lib/child-process.mjs';
import { DevTools } from './browser-client.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const base=mkdtempSync(join(tmpdir(),'af-project-picker-'));
const browse=join(base,'projects'),reference=join(browse,'reference'),fresh=join(browse,'new-project'),incompatible=join(browse,'incompatible');
const roots={tasks:join(base,'tasks'),runtime:join(base,'runtime'),locks:join(base,'locks'),alerts:join(base,'alerts.jsonl')};
for(const path of [reference,fresh,incompatible,...Object.values(roots).slice(0,3)])mkdirSync(path,{recursive:true});
const gate='import {test} from "node:test"; test("gate",()=>{});\n';
for(const path of [reference,fresh]){mkdirSync(join(path,'tests'));writeFileSync(join(path,'tests','gate.test.mjs'),gate);}
mkdirSync(join(browse,'<img onerror=alert(1)>'));
symlinkSync(tmpdir(),join(browse,'outside-link'));
const registryFile=join(base,'projects.json'),profile='unit-tests';
const asset={asset_id:'tests/gate.test.mjs',digest:createHash('sha256').update(gate).digest('hex')};
writeFileSync(registryFile,JSON.stringify({schema_version:'af-project-registry-v1',projects:[{project_id:'reference',root:reference,workspace_root:join(base,'workspaces'),acceptance_profiles:[{profile_id:profile,acceptance:{command:'node',args:['--test','tests/gate.test.mjs']},assets:[asset]}]}]}));
const testToken='project-picker-browser-token';
const env={...process.env,AF_PROJECTS_FILE:registryFile,AF_PROJECT_BROWSE_ROOT:browse,AF_WEB_TOKEN_FILE:'',AF_WEB_TOKEN:testToken};
const api=createReadApi({roots,env,allowRecord:true,allowedRoots:[reference],ensureController:null});
let scans=0,registrations=0,loseRegistration=false;
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/v2/executors'){
    if(url.searchParams.has('scan'))scans++;
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:{executors:[{id:'fixture',name:'fixture',adapter_status:'matched',availability:'AVAILABLE',installed:true,supports_planner:true,supports_model:true,models:[],reasoning_efforts:[]}],scan:{status:'cached'}}}));return;
  }
  if(req.method==='POST'&&url.pathname==='/api/v2/projects/register'){
    registrations++;
    if(loseRegistration){
      let status,headers;
      // Drop the transport response only after the real API commits the canonical registry.
      api(req,{writeHead:(s,h)=>{status=s;headers=h;},end:body=>{if(status===201||status===200)res.destroy();else{res.writeHead(status,headers);res.end(body);}}}).catch(e=>res.destroy(e));return;
    }
  }
  api(req,res).catch(e=>res.destroy(e));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}`;
const chromeProfile=join(base,'chrome');mkdirSync(chromeProfile);
const chrome=spawnManaged(process.env.AF_BROWSER_BIN??'/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--remote-debugging-port=0',`--user-data-dir=${chromeProfile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let chromeLog='',browser;chrome.stderr.on('data',c=>chromeLog+=c);
const checks=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const outputArg=process.argv.indexOf('--output-dir');
const output=resolve(outputArg<0?join(tmpdir(),'af-project-picker-browser'):process.argv[outputArg+1]);mkdirSync(output,{recursive:true});
try{
  const portFile=join(chromeProfile,'DevToolsActivePort'),deadline=Date.now()+15000;
  while(!existsSync(portFile)&&Date.now()<deadline&&chrome.exitCode===null)await delay(100);
  if(!existsSync(portFile))throw new Error(chromeLog.slice(-1000));
  const port=readFileSync(portFile,'utf8').split('\n')[0];
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  browser=await DevTools.connect(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await browser.send('Runtime.enable');await browser.send('Page.enable');
  await browser.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1080,deviceScaleFactor:1,mobile:false});
  await browser.send('Page.navigate',{url:url+'/teams.html'});
  await browser.waitFor("document.getElementById('connection')?.dataset.status==='connected'");
  check('empty workspace has one creation surface and no empty work/delivery/history board',await browser.evaluate("!document.getElementById('create-dialog')&&document.getElementById('work-area').hidden&&document.getElementById('delivery-strip').hidden&&document.querySelector('.signal-shelf').hidden"));
  await browser.click('#browse-projects');
  check('directory browsing asks for operator access before sending a filesystem request',await browser.evaluate("document.getElementById('token-dialog').open&&!document.getElementById('project-dialog').open"));
  await browser.click('#access-panel-action');await browser.waitFor("document.getElementById('access-label').textContent==='取消授权'");
  if(await browser.evaluate("document.getElementById('token-dialog').open"))await browser.click('#token-dialog [data-close]');
  await browser.waitFor("!document.getElementById('token-dialog').open");await delay(300);
  await browser.click('#browse-projects');
  await browser.waitFor("document.querySelectorAll('[data-directory]').length===4&&!document.getElementById('project-name').disabled");
  check('picker starts at the configured host root',await browser.evaluate(`document.getElementById('directory-path').textContent===${JSON.stringify(browse)}`));
  check('host root itself cannot be registered',await browser.evaluate("document.getElementById('select-directory').disabled&&document.getElementById('directory-status').textContent.includes('项目文件夹')"));
  check('outside symlinks are hidden and directory names are escaped',await browser.evaluate("!document.getElementById('directory-list').textContent.includes('outside-link')&&!document.querySelector('#directory-list img')&&document.getElementById('directory-list').textContent.includes('<img onerror=alert(1)>')"));
  await browser.click(`[data-directory=${JSON.stringify(reference)}]`);
  await browser.waitFor("document.getElementById('project-register-fields').hidden&&!document.getElementById('select-directory').disabled");
  check('registered directory offers selection without repeating profile registration',await browser.evaluate("document.getElementById('directory-status').textContent.includes('已接入为 reference')"));
  await browser.click('#select-directory');
  await browser.waitFor("!document.getElementById('project-dialog').open&&!document.getElementById('browse-projects').disabled");
  check('selecting an existing project performs no registration',registrations===0);
  check('existing project and acceptance remain selected in the Planner',await browser.evaluate("document.getElementById('console-project').value==='reference'&&document.getElementById('console-acceptance').value==='unit-tests'"));
  await browser.click('#browse-projects');await browser.waitFor("document.querySelectorAll('[data-directory]').length===4&&!document.getElementById('project-name').disabled");
  await browser.click(`[data-directory=${JSON.stringify(incompatible)}]`);
  await browser.waitFor("!document.getElementById('project-register-fields').hidden&&!document.getElementById('project-name').disabled");
  await browser.evaluate("document.getElementById('project-template').selectedIndex=1;document.getElementById('project-template').dispatchEvent(new Event('change',{bubbles:true}))");
  await browser.click('#select-directory');
  await browser.waitFor("document.querySelector('#project-dialog .dialog-feedback')?.textContent.length>0");
  check('incompatible acceptance template is refused without adding a project',JSON.parse(readFileSync(registryFile)).projects.length===1);
  check('refused registration keeps the selected folder and editable settings',await browser.evaluate(`document.getElementById('directory-path').textContent===${JSON.stringify(incompatible)}&&!document.getElementById('project-name').disabled`));
  await browser.click('#directory-up');await browser.waitFor("document.querySelectorAll('[data-directory]').length===4&&!document.getElementById('project-name').disabled");
  await browser.click(`[data-directory=${JSON.stringify(fresh)}]`);
  await browser.waitFor(`document.getElementById('directory-path').textContent===${JSON.stringify(fresh)}&&!document.getElementById('project-name').disabled`);
  await browser.evaluate("document.getElementById('project-template').selectedIndex=1;document.getElementById('project-template').dispatchEvent(new Event('change',{bubbles:true}))");
  check('new project requires an explicit trusted template rather than a free command',await browser.evaluate("document.getElementById('project-template').value!==''&&!document.getElementById('command')&&!document.getElementById('args')&&!document.getElementById('key')"));
  await browser.screenshot(join(output,'project-picker-desktop.png'),{fullPage:false});
  await browser.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  check('directory picker fits mobile and keeps its selection action visible',await browser.evaluate("document.getElementById('project-dialog').scrollWidth<=document.getElementById('project-dialog').clientWidth+2&&document.getElementById('select-directory').getBoundingClientRect().bottom<=innerHeight"));
  await browser.screenshot(join(output,'project-picker-mobile.png'),{fullPage:false});
  loseRegistration=true;await browser.click('#select-directory');
  await browser.waitFor("document.getElementById('select-directory').textContent.includes('确认接入结果')&&!document.getElementById('select-directory').disabled");
  check('lost registration response preserves a committed project and freezes the original selection',JSON.parse(readFileSync(registryFile)).projects.length===2&&await browser.evaluate("document.getElementById('project-name').disabled&&document.getElementById('project-template').disabled&&document.getElementById('planner-send').disabled"));
  loseRegistration=false;
  const postCount=registrations;
  await browser.click('#project-dialog [data-close]');await browser.click('#browse-projects');
  await browser.waitFor("document.getElementById('select-directory').textContent.includes('确认接入结果')&&!document.getElementById('select-directory').disabled");
  check('closing an uncertain picker leaves a visible recovery entrance',await browser.evaluate("document.getElementById('browse-projects').textContent.includes('确认项目接入')"));
  await browser.click('#select-directory');await browser.waitFor("!document.getElementById('project-dialog').open&&!document.getElementById('browse-projects').disabled");
  check('retry confirms the durable registration without a duplicate write',registrations===postCount+1&&JSON.parse(readFileSync(registryFile)).projects.length===2);
  check('new project and its trusted acceptance become the Planner selection',await browser.evaluate("document.getElementById('console-project').value==='new-project'&&document.getElementById('console-acceptance').value==='unit-tests'&&!document.getElementById('planner-send').disabled"));
  const saved=JSON.parse(readFileSync(registryFile)).projects.find(p=>p.project_id==='new-project');
  check('registration binds the selected canonical path and exact acceptance assets',saved.root===fresh&&JSON.stringify(saved.acceptance_profiles[0].assets)===JSON.stringify([asset]));
  check('ordinary navigation and directory registration never trigger an Agent scan',scans===0);
  check('no frontend JavaScript errors',browser.errors.length===0);
  console.log(JSON.stringify({ok:true,browser:'Chromium',checks,check_count:checks.length,verified_at:new Date().toISOString()},null,2));
}catch(error){
  if(browser)console.error(await browser.evaluate("({hint:document.getElementById('directory-status').textContent,buttonDisabled:document.getElementById('select-directory').disabled,dialogOpen:document.getElementById('project-dialog').open,path:document.getElementById('directory-path').textContent,project:document.getElementById('project-name').value,template:document.getElementById('project-template').value,notice:document.getElementById('notice').textContent,errors:document.querySelector('#project-dialog .dialog-feedback')?.textContent})"));
  throw error;
}finally{
  browser?.close();signalTree(chrome,'SIGTERM');await delay(200);if(chrome.exitCode===null)signalTree(chrome,'SIGKILL');
  await new Promise(r=>server.close(r));rmSync(base,{recursive:true,force:true});
}
