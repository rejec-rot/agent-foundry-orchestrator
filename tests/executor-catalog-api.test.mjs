import './helpers/executors-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startReadApi} from '../server/read-api.mjs';
const metadata=(id,grade)=>({status:'ready',checked_at:new Date().toISOString(),client_version:'test-version',provider:id==='cline'?'active':null,client_reasoning_efforts:['low','high'],
  model_source:'native catalog',models:[{id:id+'/model',label:'Current model',reasoning_efforts:[grade],reasoning_status:'verified',private_key:'never-expose-this'}]});
test('opening the scan endpoint merges concurrent requests, rescans fresh data and never writes tasks',async()=>{
  const root=mkdtempSync(join(tmpdir(),'af-scan-api-'));let grade='high',calls=0;
  const server=await startReadApi({roots:{tasks:join(root,'tasks'),runtime:join(root,'runtime'),locks:join(root,'locks'),alerts:join(root,'alerts.jsonl')},catalogScanner:async id=>{calls++;await new Promise(resolve=>setTimeout(resolve,30));return metadata(id,grade);}});
  try {
    const responses=await Promise.all([fetch(server.url+'/api/v2/executors?scan=1'),fetch(server.url+'/api/v2/executors?scan=1')]);
    const bodies=await Promise.all(responses.map(r=>r.json()));assert.equal(calls,3,'concurrent tabs share the same metadata queries');
    for(const body of bodies){assert.equal(body.model.scan.status,'complete');assert.deepEqual(body.model.executors.find(e=>e.id==='codex').models.find(m=>m.id==='codex/model').reasoning_efforts,['high']);assert.deepEqual(body.model.executors.find(e=>e.id==='command-code').models.find(m=>m.id==='command-code/model').reasoning_efforts,['high']);assert.doesNotMatch(JSON.stringify(body),/never-expose-this|private_key/);}
    grade='low';const next=await (await fetch(server.url+'/api/v2/executors?scan=1')).json();assert.equal(calls,6);
    assert.deepEqual(next.model.executors.find(e=>e.id==='codex').models.find(m=>m.id==='codex/model').reasoning_efforts,['low']);
    assert.ok(!readdirSync(root).includes('tasks'),'discovery does not create a delivery or a team');
  }finally{await server.close();rmSync(root,{recursive:true,force:true});}
});
test('native discovery failure is explicit and leaves the existing read API usable',async()=>{
  const root=mkdtempSync(join(tmpdir(),'af-scan-unavailable-'));
  const server=await startReadApi({roots:{tasks:join(root,'tasks'),runtime:join(root,'runtime'),locks:join(root,'locks'),alerts:join(root,'alerts.jsonl')},catalogScanner:async()=>{throw new Error('credential never-expose-this');}});
  try {const res=await fetch(server.url+'/api/v2/executors?scan=1'),body=await res.json();assert.equal(res.status,200);assert.equal(body.model.scan.status,'partial');assert.doesNotMatch(JSON.stringify(body),/never-expose-this/);assert.equal((await fetch(server.url+'/api/v2/tasks')).status,200);}finally{await server.close();rmSync(root,{recursive:true,force:true});}
});
