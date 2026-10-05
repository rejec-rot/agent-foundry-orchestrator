// web-console-smoke.mjs - REAL-BROWSER verification of the read-only V2 workbench.
//
// Follows the project's frontend convention: start the local server, drive headless Chrome over
// CDP with Node's native WebSocket (no dependencies), screenshot each breakpoint, and assert what
// only a browser can tell us - no horizontal overflow, no console errors, and the list actually
// rendered from the API.
//
// Usage: node verification/web-console-smoke.mjs [--keep]
// Exit: 0 all checks pass / 1 otherwise.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Points the executor registry at the self-contained stand-in, so the preflight can reach a real
// verdict on a machine without the global registry (same helper the test suite uses).
import '../tests/helpers/executors-fixture.mjs';
import { startReadApi } from '../server/read-api.mjs';

const keep = process.argv.includes('--keep');
const BREAKPOINTS = [1440, 768, 390, 320];
const paletteDir = process.env.AF_WORKBENCH_PALETTE_DIR;
const checks = [];
const check = (name, ok, detail = '') => {
  const passed = Boolean(ok);
  checks.push({ name, ok: passed, ...(!passed && detail ? { detail } : {}) });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small fixture so the list has something to render. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-web-smoke-'));
  const tasks = join(root, 'tasks');
  for (const d of [tasks, join(root, 'locks'), join(root, 'runtime')]) mkdirSync(d, { recursive: true });
  const mk = (id, state, phase, boundary) => writeFileSync(join(tasks, `${id}.json`), JSON.stringify({
    task_id: id, state, state_version: 2, goal: id === 'TASK-SMOKE-1' ? '协作工作台：评审与验收成果交付' : '下一代协作 API：等待人工确认',
    author_executor: 'codex', reviewer_executor: 'claude',
    trusted_import: { enabled: true, phase, boundary_state: boundary },
  }, null, 2));
  mk('TASK-SMOKE-1', 'COMPLETED', 'PROMOTED', 'DISENGAGED');
  mk('TASK-SMOKE-2', 'WAITING_HUMAN', 'WAITING_HUMAN', 'PROTECTION_RETAINED_PENDING_RECOVERY');
  return {
    root,
    roots: { tasks, locks: join(root, 'locks'), runtime: join(root, 'runtime'), alerts: join(root, 'alerts.jsonl') },
  };
}

/** Minimal CDP client over the native WebSocket. */
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cdp connect failed')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    events.push(msg);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  return { send, events, close: () => ws.close() };
}

const fixtureData = fixture();
const api = await startReadApi({ roots: fixtureData.roots, allowedRoots: [fixtureData.root] });
const profileDir = mkdtempSync(join(tmpdir(), 'af-chrome-'));
const artifacts = paletteDir ? join(paletteDir, 'controlled-read') : join(process.cwd(), 'verification', 'artifacts', 'web-console');
mkdirSync(artifacts, { recursive: true });

const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--user-data-dir=${profileDir}`, '--remote-debugging-port=9333', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeLog = '';
chrome.stderr.on('data', (d) => { chromeLog += d.toString(); });

try {
  // Wait for the DevTools endpoint, then attach to the page target.
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      target = list.find((t) => t.type === 'page') ?? null;
    } catch { /* not up yet */ }
  }
  check('chrome devtools endpoint reachable', Boolean(target), target ? target.url : chromeLog.slice(-200));
  if (!target) throw new Error('no chrome page target');

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: api.url + '/workbench.html' });
  await sleep(2500); // load + first polls

  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) console.log('      [page exception]', res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result?.value;
  };

  const title = await evaluate('document.title');
  check('page loaded the workbench', /V2/.test(String(title)), `title=${title}`);
  await evaluate('document.fonts.ready');
  check('delivery uses the same locally loaded fonts as collaboration', await evaluate('document.fonts.check(\'800 24px "Foundry Display"\') && document.fonts.check(\'400 24px "Foundry Poster CN"\', "交付工作台") && document.fonts.check(\'400 14px "Foundry Sans"\')'));
  check('delivery poster and action use the shared cut design', await evaluate("document.querySelector('.handoff-poster h2')?.textContent.includes('GREAT FINISH.') && getComputedStyle(document.querySelector('.handoff-cta'), '::before').clipPath !== 'none'"));
  const point = await evaluate("(() => {const r=document.querySelector('.handoff-cta').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', {type, ...point, button: 'left', clickCount: 1});
  check('the delivery CTA focuses the real submission field', await evaluate("document.activeElement.id==='s-goal'"));
  check('a fresh submission has an automatically generated identity', await evaluate("/^delivery-.+/.test(document.getElementById('s-key').value)"));
  const identities = await evaluate(`(() => {
    const goal = document.getElementById('s-goal'), key = document.getElementById('s-key'), before = key.value;
    goal.value = 'new delivery draft'; goal.dispatchEvent(new Event('input', {bubbles: true}));
    const generated = key.value;
    key.value = 'operator-defined-key'; goal.value = 'edited draft'; goal.dispatchEvent(new Event('input', {bubbles: true}));
    const manual = key.value;
    goal.value = ''; key.value = generated;
    return {before, generated, manual};
  })()`);
  check('a changed draft gets a fresh generated identity', identities?.before !== identities?.generated);
  check('an explicitly chosen identity survives draft edits', identities?.manual === 'operator-defined-key');
  await evaluate("document.activeElement.blur();scrollTo({top:0,behavior:'instant'})");

  const rows = await evaluate("document.querySelectorAll('#tasks .row').length");
  check('the task list rendered from the API', Number(rows) === 2, `rows=${rows}`);

  const badge = await evaluate("document.querySelector('.badge.readonly')?.textContent ?? null");
  check('the read-only badge is visible', badge === '只读', `badge=${badge}`);

  const palette = await evaluate(`(()=>{
    const rgb=value=>{const m=/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(value);return m?[+m[1],+m[2],+m[3]]:null};
    const luminance=value=>{const c=rgb(value);if(!c)return 0;const f=v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4};return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2])};
    const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
    const rail=document.querySelector('.rail'),badge=document.getElementById('mode-badge'),conn=document.getElementById('conn');
    const complete=document.querySelector('.tag.state-COMPLETED');
    const bs=getComputedStyle(badge),cs=getComputedStyle(conn),rs=getComputedStyle(rail),ps=getComputedStyle(conn.querySelector('.pip'));
    const rgbBadge=rgb(bs.color),rgbPaper=rgb(getComputedStyle(document.body).backgroundColor),rgbRed=rgb(getComputedStyle(document.querySelector('.handoff-poster h2 > span')).backgroundColor),rgbComplete=rgb(getComputedStyle(complete).color);
    return { badgeContrast:contrast(bs.color,bs.backgroundColor),connContrast:contrast(cs.color,rs.backgroundColor),pipContrast:contrast(ps.backgroundColor,rs.backgroundColor),live:conn.classList.contains('live')&&conn.textContent.trim()==='已连接',paper:rgbPaper?.[0]>220&&rgbPaper?.[1]>215&&rgbPaper?.[2]>200,ink:luminance(rs.backgroundColor)<.03,red:rgbRed?.[0]>180&&rgbRed?.[1]<80&&rgbRed?.[2]<100,noMintStatus:rgbComplete?.[1]<=rgbComplete?.[0]+30&&rgbComplete?.[1]<=rgbComplete?.[2]+30};
  })()`);
  check('the paper/ink/red palette and connected badge/status colors remain readable', palette?.paper===true&&palette?.ink===true&&palette?.red===true&&palette?.live===true&&palette?.badgeContrast>=4.5&&palette?.connContrast>=4.5&&palette?.pipContrast>=3&&palette?.noMintStatus===true, JSON.stringify(palette));

  const caps = await evaluate("document.getElementById('capabilities')?.textContent ?? ''");
  check('the footer states there are no write actions', /写操作：无/.test(caps), caps);

  // Selecting a task must render the stage strip and the evidence panel.
  await evaluate("document.querySelector('#tasks .row').click()");
  await sleep(1200);
  const detail = await evaluate("({ stages: document.querySelectorAll('#detail .stage').length, evidence: Boolean(document.querySelector('#detail pre.evidence')) })");
  check('task detail renders the stage strip and evidence', detail?.stages === 8 && detail?.evidence === true, JSON.stringify(detail));

  // The layout is a constructed grid, so it can be measured rather than admired: every region edge
  // lands on the 8pt unit, the panes span 3/6/3 of twelve columns, and the display face is real.
  const grid = await evaluate(`(() => {
    const shell = document.querySelector('.shell');
    const shellX = shell.getBoundingClientRect().x;
    const gutter = parseFloat(getComputedStyle(shell).columnGap);
    const panes = [...document.querySelectorAll('.pane')].map((el) => {
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width) };
    });
    const edges = panes.flatMap((p) => [p.x, p.right]);
    const towardShell = edges.map((x) => Math.abs(((x - shellX) % 8 + 8) % 8));
    const heading = document.querySelector('.work-head h3');
    return {
      gutter,
      panes,
      maxEdgeOffGrid: Math.max(...towardShell),
      displayFont: heading ? getComputedStyle(heading).fontFamily : '',
      stageWidths: [...document.querySelectorAll('.runway .stage')].map((el) => Math.round(el.getBoundingClientRect().width)),
    };
  })()`);
  check('the column gutter is a scale step (24px)', grid?.gutter === 24, `gutter=${grid?.gutter}`);
  check('every pane edge sits on the 8pt unit', grid?.maxEdgeOffGrid === 0, `worst offset=${grid?.maxEdgeOffGrid}px`);
  check('the panes span 3/6/3 of twelve columns', (() => {
    const [lane, work, side] = grid?.panes ?? [];
    if (!lane || !work || !side) return false;
    // a span-N item is N columns plus N-1 gutters, so the column resolves from the lane
    const column = (lane.w - 2 * grid.gutter) / 3;
    return Math.abs(work.w - (column * 6 + 5 * grid.gutter)) <= 1 && Math.abs(side.w - lane.w) <= 1;
  })(), JSON.stringify((grid?.panes ?? []).map((p) => p.w)));
  check('the eight runway steps are equal', new Set(grid?.stageWidths ?? []).size === 1, JSON.stringify(grid?.stageWidths));
  check('the task title uses the Chinese poster face', /Foundry Poster CN/.test(String(grid?.displayFont)), String(grid?.displayFont).slice(0, 80));

  for (const width of BREAKPOINTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 480 });
    await sleep(400);
    const overflow = await evaluate('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })');
    check(`no horizontal overflow at ${width}px`, overflow.sw <= overflow.cw + 1, `scrollWidth=${overflow.sw} clientWidth=${overflow.cw}`);
    const tagsContained = await evaluate("[...document.querySelectorAll('.row .tag')].every(tag => tag.getBoundingClientRect().right <= tag.closest('.row').getBoundingClientRect().right + 1 && tag.scrollWidth <= tag.clientWidth + 1)");
    check(`long task statuses stay inside their cards at ${width}px`, tagsContained);
    const {cssContentSize} = await cdp.send('Page.getLayoutMetrics');
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: {x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1} });
    const file = join(artifacts, `workbench-${width}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`      screenshot: ${file}`);
  }

  const invalidAdvanced = await evaluate(`(async () => {
    const candidate='browser-readonly-invalid-fixture-token';
    document.getElementById('token-input').value=candidate;
    document.getElementById('token-save').click();
    for(let i=0;i<30;i+=1){
      await new Promise(r=>setTimeout(r,100));
      const feedback=document.getElementById('access-feedback');
      if(!feedback.hidden)return {candidate,feedback:feedback.textContent,stored:sessionStorage.getItem('af-write-token')};
    }
    return {candidate,feedback:document.getElementById('access-feedback').textContent,stored:sessionStorage.getItem('af-write-token')};
  })()`);
  const serverReadOnly = await evaluate("(()=>{const b=document.getElementById('mode-badge');return {readonly:b.classList.contains('readonly'),write:b.classList.contains('write'),text:b.textContent.trim(),createDisabled:document.getElementById('s-create').disabled,recordsDisabled:document.getElementById('s-record').disabled}})()");
  check('the read-only server rejects the invalid advanced token',/操作令牌无效/.test(String(invalidAdvanced?.feedback)),String(invalidAdvanced?.feedback));
  check('the rejected candidate is not stored in the browser session',invalidAdvanced?.stored===null&&invalidAdvanced?.stored!==invalidAdvanced?.candidate,JSON.stringify({stored:invalidAdvanced?.stored}));
  check('an advanced token cannot enable writes on a read-only server',serverReadOnly?.readonly===true&&serverReadOnly?.write===false&&serverReadOnly?.text==='只读'&&serverReadOnly?.createDisabled===true&&serverReadOnly?.recordsDisabled===true,JSON.stringify(serverReadOnly));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(()=>{const original=window.fetch;let fail=true;window.fetch=(...args)=>{if(fail&&String(args[0])==='/api/v2/tasks'){fail=false;window.fetch=original;return Promise.reject(new TypeError('controlled disconnect'));}return original(...args);};})()`);
  let disconnected = null;
  for (let attempt = 0; attempt < 75; attempt += 1) {
    disconnected = await evaluate("(()=>{const e=document.getElementById('conn'),s=getComputedStyle(e),rail=getComputedStyle(document.querySelector('.rail')),pip=getComputedStyle(e.querySelector('.pip'));const rgb=v=>{const m=/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(v);return m?[+m[1],+m[2],+m[3]]:null};const lum=v=>{const c=rgb(v);if(!c)return 0;const f=x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4};return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2])};const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};return {dead:e.classList.contains('dead'),label:e.textContent.trim(),textContrast:ratio(s.color,rail.backgroundColor),pipContrast:ratio(pip.backgroundColor,rail.backgroundColor),shape:pip.borderRadius}})()");
    if (disconnected?.dead) break;
    await sleep(100);
  }
  check('a lost read request shows an explicit interruption label with a visible status mark',disconnected?.dead===true&&disconnected?.label.includes('连接中断：controlled disconnect')&&disconnected?.textContrast>=4.5&&disconnected?.pipContrast>=3&&disconnected?.shape==='0px',JSON.stringify(disconnected));

  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
  const forced = await evaluate("(()=>{const b=getComputedStyle(document.getElementById('mode-badge')),c=getComputedStyle(document.getElementById('conn')),p=getComputedStyle(document.getElementById('conn').querySelector('.pip'));const probe=document.createElement('span');probe.style.cssText='position:fixed;top:-1000px;color:CanvasText;background:Canvas;border-color:CanvasText';document.body.append(probe);const q=getComputedStyle(probe);const result={active:matchMedia('(forced-colors: active)').matches,badgeColor:b.color===q.color,badgeBackground:b.backgroundColor===q.backgroundColor,badgeBorder:b.borderColor===q.borderColor,pipColor:p.backgroundColor===q.color,shadow:b.boxShadow==='none'&&b.textShadow==='none',connColor:c.color===q.color};probe.remove();return result})()");
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'none'}]});
  check('forced-colors keeps the badge and connection readable with system colors',forced?.active===true&&forced?.badgeColor===true&&forced?.badgeBackground===true&&forced?.badgeBorder===true&&forced?.pipColor===true&&forced?.shadow===true&&forced?.connColor===true,JSON.stringify(forced));

  const errors = cdp.events
    .filter((e) => (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error')
      || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))
    .map((e) => e.params?.entry?.text ?? e.params?.args?.map((a) => a.value ?? a.description).join(' '));
  const failedResources = cdp.events
    .filter((e) => e.method === 'Network.responseReceived' && e.params?.response?.status >= 400)
    .map((e) => `${e.params.response.status} ${e.params.response.url}`);
  check('no console errors', errors.length === 0, [...errors.slice(0, 3), ...failedResources].join(' | '));

  // P3: the recovery plan is read-only and renders into the panel.
  const plan = await evaluate(`(async () => {
    document.getElementById('recovery-plan-btn').click();
    await new Promise((r) => setTimeout(r, 1500));
    return document.getElementById('recovery-plan').textContent;
  })()`);
  check('the read-only recovery plan renders', /恢复分类/.test(String(plan)) && /可执行/.test(String(plan)), String(plan).slice(0, 120));

  // P2: the preflight form is wired end-to-end (the server has no --allow-write here, so a record
  // button must stay disabled while the read-only preflight still answers).
  const submit = await evaluate(`(async () => {
    try {
      document.getElementById('s-goal').value = 'smoke goal';
      document.getElementById('s-target').value = ${JSON.stringify(fixtureData.root)};
      document.getElementById('s-key').value = '';
      document.getElementById('s-preview').click();
      if (!document.querySelector('.submission-settings').open) throw new Error('invalid advanced settings must be revealed');
      document.getElementById('s-key').value = 'smoke-key-1';
      document.getElementById('s-preview').click();
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        const t = document.getElementById('submit-result').textContent;
        if (t && !/正在请求/.test(t)) return { text: t, recordDisabled: document.getElementById('s-record').disabled };
      }
      return { text: document.getElementById('submit-result').textContent, recordDisabled: document.getElementById('s-record').disabled };
    } catch (err) { return { text: 'EXCEPTION: ' + err.message, recordDisabled: null }; }
  })()`);
  check('the submit form reaches a PASSING preflight in the browser', /"ok": true/.test(String(submit?.text)) && /"checks"/.test(String(submit?.text)), String(submit?.text).slice(0, 160));
  check('the record button is disabled on a read-only server', submit?.recordDisabled === true, `disabled=${submit?.recordDisabled}`);

  // The API must refuse a write even when asked from the page.
  const writeStatus = await evaluate("fetch('/api/v2/tasks', { method: 'POST', body: '{}' }).then(r => r.status)");
  check('a write attempt from the page is refused with 405', Number(writeStatus) === 405, `status=${writeStatus}`);

  cdp.close();
} catch (err) {
  check('browser smoke completed without an unexpected error', false, err.message);
} finally {
  chrome.kill('SIGKILL');
  await api.close();
  if (!keep) { rmSync(profileDir, { recursive: true, force: true }); rmSync(fixtureData.root, { recursive: true, force: true }); }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(', ')}` : ''}`);
if (paletteDir) {
  const report = { ok: failed.length === 0, browser: 'Chromium', mode: 'controlled fixture; read-only HTTP; no prompt or native scan', checks, verified_at: new Date().toISOString(), screenshots: BREAKPOINTS.map((width) => join(artifacts, `workbench-${width}.png`)) };
  writeFileSync(join(paletteDir, 'read-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
