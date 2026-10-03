import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,existsSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverInstalledAgents,resolveAgentBinary } from '../lib/agent-discovery.mjs';
function executable(file,content='#!/bin/sh\nexit 0\n'){mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,content);chmodSync(file,0o755);}
test('discovery finds managed Qoder/Pi installations and deduplicates Command Code aliases without launching them',()=>{
  const root=mkdtempSync(join(tmpdir(),'af-agent-discovery-')),bin=join(root,'.local/bin'),marker=join(root,'must-not-run');
  try{
    const exe=join(bin,'command-code');executable(exe,`#!/bin/sh\ntouch '${marker}'\n`);
    for(const alias of ['cmd','cmdc','commandcode'])symlinkSync(exe,join(bin,alias));
    executable(join(bin,'qodercli'));executable(join(bin,'pi'));executable(join(bin,'kiro-cli'));
    const list=discoverInstalledAgents({env:{HOME:root,PATH:''}});
    assert.deepEqual(list.map(e=>e.id).sort(),['command-code','kiro','pi','qoder']);
    assert.equal(list.filter(e=>e.id==='command-code').length,1);
    assert.equal(existsSync(marker),false,'installation discovery must not start any executable');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('discovery enumerates another Node installation and reports unfamiliar agent packages',()=>{
  const root=mkdtempSync(join(tmpdir(),'af-agent-packages-'));
  try{
    const modules=join(root,'.nvm/versions/node/v99.0.0/lib/node_modules');
    const qoder=join(modules,'@qoder-ai/qodercli');mkdirSync(qoder,{recursive:true});
    writeFileSync(join(qoder,'package.json'),JSON.stringify({name:'@qoder-ai/qodercli',version:'1.2.3',bin:{qoder:'dist/cli.js'}}));executable(join(qoder,'dist/cli.js'));
    const unknown=join(modules,'new-coding-agent');mkdirSync(unknown,{recursive:true});
    writeFileSync(join(unknown,'package.json'),JSON.stringify({name:'new-coding-agent',version:'1.0.0',description:'A terminal coding agent',bin:{newagent:'cli.js'}}));executable(join(unknown,'cli.js'));
    const list=discoverInstalledAgents({env:{HOME:root,PATH:''}});
    assert.equal(list.find(e=>e.id==='qoder').client_version,'1.2.3');
    assert.equal(list.find(e=>e.id==='new-coding-agent').protocol,null);
    assert.equal(resolveAgentBinary('qoder',{env:{HOME:root,PATH:''}}),join(qoder,'dist/cli.js'));
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('an explicit missing binary override cannot silently choose another installation',()=>{
  const root=mkdtempSync(join(tmpdir(),'af-agent-override-'));
  try{executable(join(root,'.local/bin/pi'));assert.equal(resolveAgentBinary('pi',{env:{HOME:root,PATH:'',PI_BIN:join(root,'missing')}}),null);}
  finally{rmSync(root,{recursive:true,force:true});}
});
