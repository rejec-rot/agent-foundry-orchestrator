// Installation discovery is read-only. Matching a bundled adapter never admits
// an executor to the canonical registry or overrides operator restrictions.
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';

export const AGENT_CLIENTS = Object.freeze({
  codex: { names:['codex'], packages:['@openai/codex'], protocol:'native-cli', catalog:true, override:'CODEX_BIN' },
  claude: { names:['claude'], packages:['@anthropic-ai/claude-code'], protocol:'native-cli', catalog:false, override:'CLAUDE_BIN' },
  cline: { names:['cline'], packages:['cline'], protocol:'acp', catalog:true, override:'CLINE_BIN' },
  'command-code': { names:['command-code','cmd','cmdc','commandcode'], packages:['command-code'], protocol:'native-cli', catalog:true, override:'COMMAND_CODE_BIN' },
  qoder: { names:['qodercli'], packages:['@qoder-ai/qodercli','@qoder-ai/qoder-cli'], protocol:'native-cli', catalog:true, override:'QODER_BIN' },
  pi: { names:['pi'], packages:['@earendil-works/pi-coding-agent','@mariozechner/pi-coding-agent'], protocol:'rpc', catalog:true, override:'PI_BIN' },
  dsh: { names:['dsh'], packages:['@deepseek-ai/dsh'], protocol:'native-cli', catalog:false, override:'DSH_BIN' },
  antigravity: { names:['agy'], packages:[], protocol:'native-cli', catalog:false, override:'AGY_BIN' },
  kiro: { names:['kiro-cli'], packages:[], protocol:'acp', catalog:false, override:'KIRO_BIN' },
  opencode: { names:['opencode'], packages:['opencode-ai'], protocol:null, catalog:false },
  gemini: { names:['gemini'], packages:['@google/gemini-cli'], protocol:null, catalog:false },
  'qwen-code': { names:['qwen'], packages:['@qwen-code/qwen-code'], protocol:null, catalog:false },
  aider: { names:['aider'], packages:[], protocol:null, catalog:false },
  goose: { names:['goose'], packages:[], protocol:null, catalog:false },
  copilot: { names:['copilot'], packages:['@github/copilot'], protocol:null, catalog:false },
});
const executable = file => { try { accessSync(file,constants.X_OK); return statSync(file).isFile(); } catch { return false; } };
const children = dir => { try { return readdirSync(dir,{withFileTypes:true}); } catch { return []; } };
const identity = file => { try { return realpathSync(file); } catch { return file; } };
const safeId = name => String(name).replace(/^@/,'').replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,80);
const readPackage = file => { try { const s=statSync(file);if(s.size>256*1024)return null;return JSON.parse(readFileSync(file,'utf8')); } catch { return null; } };

function installationDirs(env) {
  const home=env.HOME??env.USERPROFILE??'',path=String(env.PATH??'').split(process.platform==='win32'?';':':').filter(Boolean);
  const dirs=[...path];
  if(home)dirs.push(join(home,'.local/bin'),join(home,'bin'),join(home,'.npm-global/bin'),join(home,'.bun/bin'),join(home,'.yarn/bin'));
  for(const key of ['PNPM_HOME','NPM_CONFIG_PREFIX','npm_config_prefix'])if(env[key])dirs.push(key==='PNPM_HOME'?env[key]:join(env[key],'bin'));
  const versions=home?join(home,'.nvm/versions/node'):'';
  for(const entry of children(versions).slice(0,32))if(entry.isDirectory())dirs.push(join(versions,entry.name,'bin'));
  return [...new Set(dirs)];
}

function installedPackages(env,dirs) {
  const home=env.HOME??env.USERPROFILE??'';
  const roots=dirs.filter(d=>d.endsWith('/bin')).map(d=>join(dirname(d),'lib/node_modules'));
  if(home)roots.push(join(home,'.npm-global/lib/node_modules'),join(home,'.bun/install/global/node_modules'),join(home,'.config/yarn/global/node_modules'));
  const records=[];
  for(const root of [...new Set(roots)]) {
    for(const entry of children(root).slice(0,300)) {
      if(entry.name.startsWith('.')||(!entry.isDirectory()&&!entry.isSymbolicLink()))continue;
      const paths=entry.name.startsWith('@')?children(join(root,entry.name)).slice(0,100).map(c=>join(root,entry.name,c.name)): [join(root,entry.name)];
      for(const dir of paths) {const pkg=readPackage(join(dir,'package.json'));if(pkg?.name&&pkg.bin)records.push({dir,pkg});}
    }
  }
  return records;
}

export function resolveAgentBinary(id,{env=process.env}={}) {
  const spec=AGENT_CLIENTS[id];if(!spec)return null;
  const override=spec.override&&env[spec.override];
  const names=override?[override]:spec.names,dirs=installationDirs(env);
  for(const name of names) {
    const candidates=isAbsolute(name)||name.includes('/')||name.includes('\\')?[name]:dirs.map(dir=>join(dir,name));
    for(const file of candidates)if(executable(file))return file;
  }
  // Package bin metadata covers installations outside the active Node PATH.
  if(override)return null;
  for(const {dir,pkg} of installedPackages(env,dirs))if(spec.packages.includes(pkg.name)) {
    for(const bin of Object.values(typeof pkg.bin==='string'?{default:pkg.bin}:pkg.bin)) {
      const file=join(dir,bin);if(executable(file))return file;
    }
  }
  return null;
}

export function hasNativeCatalog(id) { return AGENT_CLIENTS[id]?.catalog===true; }

export function discoverInstalledAgents({env=process.env}={}) {
  const records=new Map(),dirs=installationDirs(env),packages=installedPackages(env,dirs),seen=new Set();
  for(const [id,spec] of Object.entries(AGENT_CLIENTS)) {
    const binary=resolveAgentBinary(id,{env});if(!binary)continue;
    const key=identity(binary);seen.add(key);
    const pkg=packages.find(p=>spec.packages.includes(p.pkg.name))?.pkg;
    records.set(id,{id,installed:true,binary,protocol:spec.protocol,client_version:pkg?.version??null,discovery_source:pkg?'installed package and executable':'local executable'});
  }
  for(const {dir,pkg} of packages) {
    if(Object.values(AGENT_CLIENTS).some(s=>s.packages.includes(pkg.name)))continue;
    const keywords=Array.isArray(pkg.keywords)?pkg.keywords:[];
    const isAgent=pkg.agentFoundry?.agent===true||keywords.some(k=>['coding-agent','ai-agent','agent-client-protocol'].includes(k))||/\b(?:coding|code|terminal|cli)\b.{0,80}\bagent\b|\bagent\b.{0,80}\b(?:coding|code|terminal|cli)\b/i.test(pkg.description??'');
    if(!isAgent)continue;
    for(const bin of Object.values(typeof pkg.bin==='string'?{default:pkg.bin}:pkg.bin)) {
      if(typeof bin!=='string')continue;
      const file=join(dir,bin),key=identity(file);if(!executable(file)||seen.has(key))continue;
      seen.add(key);const id=safeId(pkg.name);if(!id||records.has(id))continue;
      records.set(id,{id,installed:true,binary:file,protocol:null,client_version:typeof pkg.version==='string'?pkg.version:null,discovery_source:'installed agent package; adapter not matched'});
    }
  }
  return [...records.values()];
}
