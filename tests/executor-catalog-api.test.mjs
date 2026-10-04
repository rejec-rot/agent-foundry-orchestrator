import './helpers/executors-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startReadApi} from '../server/read-api.mjs';
import {clineProvider} from '../lib/team/native-catalog.mjs';
const metadata=(id,grade)=>({status:'ready',checked_at:new Date().toISOString(),client_version:'test-version',provider:id==='cline'?clineProvider():null,client_reasoning_efforts:['low','high'],
  model_source:'native catalog',models:[{id:id+'/model',label:'Current model',reasoning_efforts:[grade],reasoning_status:'verified',private_key:'never-expose-this'}]});
const agentDiscoverer=()=>['codex','cline','command-code','qoder','pi','kiro','dsh','antigravity'].map(id=>({id,installed:true,protocol:id==='pi'?'rpc':'native-cli',discovery_source:'test installation'}));
test('opening the scan endpoint merges concurrent requests, rescans fresh data and never writes tasks',async()=>{
  const root=mkdtempSync(join(tmpdir(),'af-scan-api-'));let grade='high',calls=0;
  const server=await startReadApi({roots:{tasks:join(root,'tasks'),runtime:join(root,'runtime'),locks:join(root,'locks'),alerts:join(root,'alerts.jsonl')},agentDiscoverer,catalogScanner:async id=>{calls++;await new Promise(resolve=>setTimeout(resolve,30));return metadata(id,grade);}});
  try {
    const cold=await (await fetch(server.url+'/api/v2/executors')).json();
    assert.equal(calls,0,'reading the existing directory never launches native clients');
    assert.equal(cold.model.scan,null);
    const responses=await Promise.all([fetch(server.url+'/api/v2/executors?scan=1'),fetch(server.url+'/api/v2/executors?scan=1')]);
    const bodies=await Promise.all(responses.map(r=>r.json()));assert.equal(calls,5,'concurrent tabs share the same metadata queries; no query is sent to unsupported or disabled clients');
    for(const body of bodies){assert.equal(body.model.scan.status,'complete');assert.deepEqual(body.model.executors.find(e=>e.id==='codex').models.find(m=>m.id==='codex/model').reasoning_efforts,['high']);assert.deepEqual(body.model.executors.find(e=>e.id==='command-code').models.find(m=>m.id==='command-code/model').reasoning_efforts,['high']);assert.doesNotMatch(JSON.stringify(body),/never-expose-this|private_key/);}
    const installed=bodies[0].model;
    assert.equal(installed.scan.reasoning.adjustable_models,installed.executors.flatMap(e=>e.models).filter(m=>!m.configured_only&&m.reasoning_status==='verified'&&m.reasoning_efforts.length).length);
    assert.ok(installed.executors.flatMap(e=>e.models).filter(m=>!m.configured_only).every(m=>m.reasoning_control&&m.reasoning_source));
    assert.equal(installed.scan.installed_agents,8);assert.equal(installed.scan.matched_agents,7);assert.equal(installed.scan.unmatched_agents,1);
    assert.equal(installed.executors.find(e=>e.id==='qoder').supports_planner,true);
    assert.equal(installed.executors.find(e=>e.id==='pi').supports_model,true);
    assert.equal(installed.executors.find(e=>e.id==='kiro').availability,'UNSUPPORTED');
    assert.equal(installed.executors.find(e=>e.id==='dsh').supports_planner,false);
    assert.equal(installed.executors.find(e=>e.id==='antigravity').availability,'UNAVAILABLE');
    const cached=await (await fetch(server.url+'/api/v2/executors')).json();
    assert.equal(calls,5,'opening another page reuses the last native metadata');
    assert.equal(cached.model.scan,null);
    assert.deepEqual(cached.model.executors,installed.executors,'cached reads preserve exact models, grades and discovery timestamps');
    grade='low';const next=await (await fetch(server.url+'/api/v2/executors?scan=1')).json();assert.equal(calls,10);
    assert.deepEqual(next.model.executors.find(e=>e.id==='codex').models.find(m=>m.id==='codex/model').reasoning_efforts,['low']);
    assert.ok(!readdirSync(root).includes('tasks'),'discovery does not create a delivery or a team');
  }finally{await server.close();rmSync(root,{recursive:true,force:true});}
});
test('native discovery failure is explicit and leaves the existing read API usable',async()=>{
  const root=mkdtempSync(join(tmpdir(),'af-scan-unavailable-'));
  const server=await startReadApi({roots:{tasks:join(root,'tasks'),runtime:join(root,'runtime'),locks:join(root,'locks'),alerts:join(root,'alerts.jsonl')},agentDiscoverer,catalogScanner:async()=>{throw new Error('credential never-expose-this');}});
  try {const res=await fetch(server.url+'/api/v2/executors?scan=1'),body=await res.json();assert.equal(res.status,200);assert.equal(body.model.scan.status,'partial');assert.doesNotMatch(JSON.stringify(body),/never-expose-this/);assert.equal((await fetch(server.url+'/api/v2/tasks')).status,200);}finally{await server.close();rmSync(root,{recursive:true,force:true});}
});

test('removing a client clears its native model cache on explicit rescan without querying the missing client',async()=>{
  const root=mkdtempSync(join(tmpdir(),'af-scan-removed-'));let installed=true,calls=0;
  const server=await startReadApi({roots:{tasks:join(root,'tasks'),runtime:join(root,'runtime'),locks:join(root,'locks'),alerts:join(root,'alerts.jsonl')},
    agentDiscoverer:()=>installed?[{id:'pi',installed:true,protocol:'rpc'}]:[],
    catalogScanner:async id=>{calls++;return metadata(id,'high');}});
  try {
    const first=(await(await fetch(server.url+'/api/v2/executors?scan=1')).json()).model.executors.find(e=>e.id==='pi');
    assert.equal(first.installed,true);assert.equal(first.discovery_status,'ready');
    assert.ok(first.models.some(m=>m.id==='pi/model'&&m.reasoning_status==='verified'));
    installed=false;
    const cached=(await(await fetch(server.url+'/api/v2/executors')).json()).model.executors.find(e=>e.id==='pi');
    assert.equal(cached.installed,false,'cached metadata cannot prove that a removed binary is installed');
    assert.equal(calls,1,'a cached read launches no native clients');
    const rescanBody=(await(await fetch(server.url+'/api/v2/executors?scan=1')).json()).model;
    assert.equal(rescanBody.scan.status,'complete','removed clients are not failed queries of installed clients');
    const rescanned=rescanBody.executors.find(e=>e.id==='pi');
    assert.equal(rescanned.installed,false);assert.equal(rescanned.discovery_status,'unavailable');
    assert.ok(!rescanned.models.some(m=>m.id==='pi/model'));
    assert.equal(rescanned.supports_effort,false);assert.equal(calls,1,'the removed client is never queried');
    const after=(await(await fetch(server.url+'/api/v2/executors')).json()).model.executors.find(e=>e.id==='pi');
    assert.deepEqual(after,rescanned,'the invalidated cache remains invalidated on later page openings');
    assert.equal(calls,1);
    installed=true;
    const restored=(await(await fetch(server.url+'/api/v2/executors?scan=1')).json()).model.executors.find(e=>e.id==='pi');
    assert.equal(restored.installed,true);assert.equal(restored.discovery_status,'ready');assert.equal(calls,2);
    assert.deepEqual(restored.models.find(m=>m.id==='pi/model').reasoning_efforts,['high']);
  }finally{await server.close();rmSync(root,{recursive:true,force:true});}
});

test('a concurrent scan that observes removal invalidates metadata after the shared native query finishes',async()=>{
  const root=mkdtempSync(join(tmpdir(),'af-scan-removal-race-'));let installed=true,calls=0,release,markStarted;
  const started=new Promise(resolve=>{markStarted=resolve;});
  const ready=new Promise(resolve=>{release=resolve;});
  const server=await startReadApi({roots:{tasks:join(root,'tasks'),runtime:join(root,'runtime'),locks:join(root,'locks'),alerts:join(root,'alerts.jsonl')},
    agentDiscoverer:()=>{if(!installed)release();return installed?[{id:'pi',installed:true,protocol:'rpc'}]:[];},
    catalogScanner:async id=>{calls++;markStarted();await ready;return metadata(id,'high');}});
  try {
    const first=fetch(server.url+'/api/v2/executors?scan=1');await started;
    installed=false;
    const removed=fetch(server.url+'/api/v2/executors?scan=1');
    const responses=await Promise.all([first,removed]);const body=(await responses[1].json()).model;
    assert.equal(calls,1,'concurrent requests still share the native query');
    const entry=body.executors.find(e=>e.id==='pi');
    assert.equal(entry.installed,false);assert.equal(entry.discovery_status,'unavailable');
    assert.ok(!entry.models.some(m=>m.id==='pi/model'));assert.equal(body.scan.status,'complete');
    const cached=(await(await fetch(server.url+'/api/v2/executors')).json()).model.executors.find(e=>e.id==='pi');
    assert.deepEqual(cached,entry,'the late native result cannot revive the removed client');
  }finally{release();await server.close();rmSync(root,{recursive:true,force:true});}
});
