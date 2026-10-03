import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareCommandCodeScanEnvironment} from '../lib/team/command-code-scan-environment.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-command-code-env-test-'));
  const sourceHome = join(root, 'source-home');
  const configDir = join(sourceHome, '.commandcode');
  const cwd = join(root, 'scan-cwd');
  mkdirSync(configDir, {recursive:true, mode:0o700});
  mkdirSync(cwd, {mode:0o700});
  const providerFile = join(configDir, 'providers.json');
  const content = JSON.stringify({provider:{
    'team-gateway':{
      name:'Team gateway',enabled:true,disabled:false,api:'anthropic-messages',
      baseURL:'https://private-endpoint.invalid/v1',apiKey:'fixture-secret-key',
      headers:{authorization:'fixture-secret-header'},
      models:{
        'deepseek/deepseek-v4.1-flash':{
          name:'DeepSeek V4.1 Flash',reasoningEfforts:['low','high','max'],reasoning:true,
          baseURL:'https://model-endpoint.invalid',options:{apiKey:'fixture-model-secret'},
        },
        'bool-only':{name:'Boolean reasoning only',reasoning:true},
        'invalid-grades':{name:'Invalid grades',reasoningEfforts:['low','secret'],reasoning:true},
        'bad model id':{name:'Unsafe ID',reasoningEfforts:['high']},
      },
    },
    'disabled-provider':{name:'Disabled',disabled:true,models:{'hidden-model':{name:'Hidden'}}},
  }});
  writeFileSync(providerFile, content, {mode:0o600});
  return {root,sourceHome,cwd,providerFile,content,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('Command Code scan environment uses a private home and copies only safe BYOK display metadata',()=>{
  const fx=fixture();
  try {
    const result=prepareCommandCodeScanEnvironment({cwd:fx.cwd,env:{
      HOME:fx.sourceHome,USERPROFILE:'/source/profile',PATH:'/safe/bin',LANG:'en_US.UTF-8',
      OPENAI_API_KEY:'fixture-openai-secret',COMMAND_CODE_CONFIG_PATH:'/private/config.json',
      HTTP_PROXY:'http://proxy.invalid',NODE_OPTIONS:'--require /private/hook.mjs',
      AF_EXECUTOR_ENV_OPENAI_API_KEY:'indirect-secret',
    }});
    assert.notEqual(result.HOME,fx.sourceHome);
    assert.equal(result.HOME,result.USERPROFILE);
    assert.ok(result.HOME.startsWith(fx.cwd));
    assert.equal(result.PATH,'/safe/bin');
    assert.equal(result.CI,'1');
    assert.equal(result.DO_NOT_TRACK,'1');
    assert.equal(result.NODE_ENV,'production');
    for(const key of ['OPENAI_API_KEY','COMMAND_CODE_CONFIG_PATH','HTTP_PROXY','NODE_OPTIONS','AF_EXECUTOR_ENV_OPENAI_API_KEY'])assert.equal(result[key],undefined);
    for(const key of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','TMPDIR','TEMP','TMP','APPDATA','LOCALAPPDATA']) {
      assert.ok(result[key].startsWith(result.HOME),`${key} must stay inside the disposable home`);
    }
    assert.equal(statSync(result.HOME).mode & 0o777,0o700);

    const copied=JSON.parse(readFileSync(join(result.HOME,'.commandcode','providers.json'),'utf8'));
    assert.deepEqual(copied,{provider:{
      'team-gateway':{
        name:'Team gateway',disabled:false,enabled:true,baseURL:'https://catalog.invalid',apiKey:false,
        models:{
          'deepseek/deepseek-v4.1-flash':{name:'DeepSeek V4.1 Flash',reasoningEfforts:['low','high','max']},
          'bool-only':{name:'Boolean reasoning only'},
          'invalid-grades':{name:'Invalid grades'},
        },
      },
      'disabled-provider':{
        name:'Disabled',disabled:true,baseURL:'https://catalog.invalid',apiKey:false,
        models:{'hidden-model':{name:'Hidden'}},
      },
    }});
    assert.doesNotMatch(JSON.stringify(copied),/fixture-secret|private-endpoint|model-endpoint|authorization|headers|baseURL.*private/);
    assert.equal(readFileSync(fx.providerFile,'utf8'),fx.content,'the real providers file is only read');
  } finally {fx.cleanup();}
});

test('missing or malformed provider files cannot leak source settings into the child home',()=>{
  const fx=fixture();
  try {
    writeFileSync(fx.providerFile,'{malformed', {mode:0o600});
    const result=prepareCommandCodeScanEnvironment({cwd:fx.cwd,env:{HOME:fx.sourceHome,PATH:'/safe/bin',ANTHROPIC_API_KEY:'fixture-secret'}});
    assert.equal(result.ANTHROPIC_API_KEY,undefined);
    assert.equal(result.HOME===fx.sourceHome,false);
    assert.equal(statSync(result.HOME).mode & 0o777,0o700);
    assert.throws(()=>readFileSync(join(result.HOME,'.commandcode','providers.json'),'utf8'),/ENOENT/);
  } finally {fx.cleanup();}
});

test('scan cwd must be a disposable operating-system temp directory',()=>{
  assert.throws(()=>prepareCommandCodeScanEnvironment({cwd:process.cwd(),env:{}}),/temp directory/);
  assert.throws(()=>prepareCommandCodeScanEnvironment({cwd:'relative-path',env:{}}),/absolute path/);
});
