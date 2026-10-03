import './helpers/executors-fixture.mjs';
import './helpers/runtime-state-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {connectInstalledAgents} from '../lib/agent-registration.mjs';
test('explicit connect matches installed adapters, preserves disabled clients and never overwrites canonical records',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'af-connect-registry-'));
  try{
    const discover=()=>['qoder','pi','kiro','codex','antigravity'].map(id=>({id,installed:true,protocol:'native-cli'}));
    const adapters=Object.fromEntries(['qoder','pi','codex','antigravity'].map(id=>[id,{health:()=>({ok:true}),supportsMcpUnattended:false,...(id==='antigravity'?{schedulable:false}:{}),...(id==='pi'?{requiresModel:true}:{})}]));
    const options={executorsDir:dir,discover,adapters,disabled:['codex'],catalog:async id=>({status:'ready',models:id==='pi'?[]:[{id:'native-model'}]})};
    const first=await connectInstalledAgents(options);
    assert.deepEqual(first.results.map(r=>r.status),['registered','registered','unsupported','disabled','disabled']);
    const qoderFile=join(dir,'qoder.json'),before=readFileSync(qoderFile,'utf8'),registration=JSON.parse(before);
    assert.equal(registration.capabilities_audit.model_turn,'UNVERIFIED');assert.equal(first.results[1].model_configuration_required,true);
    assert.deepEqual(readdirSync(dir).sort(),['pi.json','qoder.json']);
    const next=await connectInstalledAgents(options);assert.equal(next.results[0].status,'already_registered');assert.equal(readFileSync(qoderFile,'utf8'),before);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('concurrent connection cannot overwrite a registry record created during metadata discovery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'af-connect-race-'));let ready=0,release;
  const gate=new Promise(r=>release=r);
  try{
    const options={ids:['qoder'],executorsDir:dir,disabled:[],discover:()=>[{id:'qoder',protocol:'native-cli'}],adapters:{qoder:{health:()=>({ok:true})}},catalog:async()=>{if(++ready===2)release();await gate;return {status:'ready',models:[]};}};
    const results=await Promise.all([connectInstalledAgents(options),connectInstalledAgents(options)]);
    assert.deepEqual(results.map(r=>r.results[0].status).sort(),['already_registered','registered']);assert.deepEqual(readdirSync(dir),['qoder.json']);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
