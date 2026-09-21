// feishu-card-states.mjs - four-state dry-run deliverable for the Feishu card format.
//
// Renders the four designed boundary states through the REAL notifier (mode=dry-run, so no
// network I/O), verifies the Card JSON 2.0 invariants on the FINAL signed body, writes the
// four card JSON files plus a browser preview, and reports a PASS/FAIL summary.
//
// Usage: node verification/feishu-card-states.mjs [--evidence-dir <dir>]

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FEISHU_CARD_MAX_ELEMENTS,
  FEISHU_CARD_TAGS,
  buildNotifyPayload,
  inspectPendingNotifications,
  notifyBoundaryAlert,
  notifyMaxBodyBytes,
  readNotifyEvents,
} from '../lib/boundary-notify.mjs';

const argv = process.argv.slice(2);
const evidenceArg = argv.indexOf('--evidence-dir') >= 0 ? argv[argv.indexOf('--evidence-dir') + 1] : null;
const live = argv.includes('--live');
const confirmed = argv.includes('--confirm');
const webhook = process.env.AF_BOUNDARY_NOTIFY_WEBHOOK || null;
if (live && !confirmed) {
  console.error('error: --live sends real cards; re-run with --confirm after reviewing the dry-run output');
  process.exit(2);
}
if (live && !webhook) {
  console.error('error: --live requires AF_BOUNDARY_NOTIFY_WEBHOOK (passed only via the environment)');
  process.exit(2);
}
const mode = live ? 'live' : 'dry-run';
const onlyArg = argv.indexOf('--only') >= 0 ? argv[argv.indexOf('--only') + 1] : null;
const only = onlyArg ? new Set(onlyArg.split(',')) : null;
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
const evidenceDir = evidenceArg ?? join(process.cwd(), '..', 'real-smoke-evidence', `feishu-card-states-${revision.slice(0, 7)}`);
const previewDir = join(process.cwd(), 'docs', 'design', 'generated');
const root = mkdtempSync(join(tmpdir(), 'af-card-states-'));
const alertsFile = join(root, 'boundary-alerts.jsonl');

mkdirSync(evidenceDir, { recursive: true });
mkdirSync(previewDir, { recursive: true });

process.env.AF_BOUNDARY_ALERTS_FILE = alertsFile;
process.env.AF_BOUNDARY_NOTIFY_MODE = mode;
process.env.AF_BOUNDARY_NOTIFY_FORMAT = 'feishu-card';
process.env.AF_BOUNDARY_NOTIFY_ON_RELEASE = '1';
// Acceptance run: exactly one attempt per card (no retry can produce a second message) and a
// long cooldown (no repeat delivery for the same path+kind).
process.env.AF_BOUNDARY_NOTIFY_COOLDOWN_MS = live ? String(24 * 60 * 60 * 1000) : '0';
if (live) process.env.AF_BOUNDARY_NOTIFY_MAX_ATTEMPTS = '1';

const STATES = [
  {
    key: 'retained',
    label: '黄色 · 保护保留',
    expectTemplate: 'orange',
    expectTitle: /边界保护已保留/,
    expectText: [/需要核查/, /未执行解锁/],
    event: 'boundary_retained',
    alert: {
      canonical_dir: '/srv/fixture-retained', cas_dir: '/srv/trusted-cas-retained', task_id: 'TASK-CARD-ACCEPT-1', alert_id: 'AF-ACCEPT-0001',
      occurrences: 1, severity: 'warning', boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
      reason: '【验收测试·非真实故障】卡片通道验收 1/4：保护保留态',
    },
    scopeDecision: { decision: 'RETAIN', reason: 'scope-anomaly', attempts: 1, quiesce_confirmed: true, anomalies: [{ class: 'broken-scope', code: 'ENOENT' }] },
  },
  {
    key: 'escalated',
    label: '红色 · 持续保留，告警升级',
    expectTemplate: 'red',
    expectTitle: /持续保留，告警已升级/,
    expectText: [/优先处理/, /人工排查/],
    event: 'boundary_retained',
    alert: {
      canonical_dir: '/srv/fixture-escalated', cas_dir: '/srv/trusted-cas-escalated', task_id: 'TASK-CARD-ACCEPT-2', alert_id: 'AF-ACCEPT-0002',
      occurrences: 3, severity: 'escalated', boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
      reason: '【验收测试·非真实故障】卡片通道验收 2/4：告警升级态',
    },
    scopeDecision: { decision: 'RETAIN', reason: 'rescan-budget-exhausted', attempts: 4, quiesce_confirmed: true, anomalies: [] },
  },
  {
    key: 'restore-incomplete',
    label: '红色 · 恢复未完成',
    expectTemplate: 'red',
    expectTitle: /恢复未完成，保护完整性不可确认/,
    expectText: [/保护完整性不可确认/, /不得假定已解锁/],
    event: 'boundary_retained',
    alert: {
      canonical_dir: '/srv/fixture-restore-incomplete', cas_dir: '/srv/trusted-cas-restore', task_id: 'TASK-CARD-ACCEPT-3', alert_id: 'AF-ACCEPT-0003',
      occurrences: 1, severity: 'warning', boundary_state: 'RESTORE_INCOMPLETE',
      reason: '【验收测试·非真实故障】卡片通道验收 3/4：恢复未完成态（release could not be verified: ownership mismatch）',
    },
    scopeDecision: null,
  },
  {
    key: 'recovered',
    label: '绿色 · 已验证恢复',
    expectTemplate: 'green',
    expectTitle: /边界已恢复/,
    expectText: [/恢复已验证/, /告警已关闭/],
    event: 'boundary_released',
    alert: {
      canonical_dir: '/srv/fixture-recovered', cas_dir: '/srv/trusted-cas-recovered', task_id: 'TASK-CARD-ACCEPT-4', alert_id: 'AF-ACCEPT-0004',
      occurrences: 0, severity: 'warning', boundary_state: 'DISENGAGED',
      reason: '【验收测试·非真实故障】卡片通道验收 4/4：已验证恢复态',
    },
    scopeDecision: null,
  },
];

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// --- render each state through the real notifier (dry-run) ------------------------
const selected = only ? STATES.filter((s) => only.has(s.key)) : STATES;
if (only && selected.length !== only.size) {
  console.error(`error: --only matched ${selected.length} of ${only.size} states`);
  process.exit(2);
}
const rendered = [];
for (const state of selected) {
  const result = await notifyBoundaryAlert({ event: state.event, alert: state.alert, scopeDecision: state.scopeDecision });
  const expected = live ? 'sent' : 'would-notify';
  check(`${state.label}：${live ? '实发' : 'dry-run 渲染'}`, result.status === expected, `status=${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  if (live) {
    check(`${state.label}：单次尝试，无重试`, result.attempts === 1, `attempts=${result.attempts}/${result.max_attempts}`);
    check(`${state.label}：provider 回执确认`, result.provider_code === null || result.provider_code === 0, `http=${result.http_status} code=${result.provider_code ?? 'none'}`);
    check(`${state.label}：结清成功`, result.settled === true, `settled=${result.settled}`);
  }
  rendered.push({ ...state, result });
}
if (live) {
  const pendingAfter = inspectPendingNotifications({ file: alertsFile });
  check('实发后重试队列为空（无待重试/无耗尽）', pendingAfter.ok === true && pendingAfter.pending.length === 0, `pending=${pendingAfter.pending.length}`);
  const sentEvents = readNotifyEvents({ file: alertsFile }).filter((r) => r.status === 'sent');
  check(`投递日志记录 ${selected.length} 次 sent`, sentEvents.length === selected.length, `sent=${sentEvents.length}`);
}

const records = readNotifyEvents({ file: alertsFile });
const limit = notifyMaxBodyBytes();
const cards = [];
for (const state of rendered) {
  // Key on (event, alert_id): the green card closes the same alert as the retention card,
  // so matching on the alert id alone would pick up the earlier record.
  const record = records.find((r) => r.format === 'feishu-card'
    && r.payload?.event === state.event
    && r.payload?.alert_id === state.alert.alert_id);
  check(`${state.label}：${live ? '投递' : 'dry-run'}记录`, Boolean(record) && (!live || record.status === 'sent'), record ? `${record.status}` : 'missing');
  if (!record) continue;
  const body = JSON.parse(record.request_body);
  const card = body.card;
  writeFileSync(join(evidenceDir, `card-${state.key}.json`), `${JSON.stringify(body, null, 2)}\n`);

  const text = JSON.stringify(card);
  check(`${state.label}：信封为 interactive + schema 2.0`, body.msg_type === 'interactive' && card.schema === '2.0');
  check(`${state.label}：header 配色 ${state.expectTemplate}`, card.header.template === state.expectTemplate, `got ${card.header.template}`);
  check(`${state.label}：标题匹配`, state.expectTitle.test(card.header.title.content), card.header.title.content);
  for (const pattern of state.expectText) {
    check(`${state.label}：正文含 ${pattern}`, pattern.test(text));
  }

  // Card JSON 2.0 invariants, checked on the artifact that would be posted.
  let dynamicPlain = true;
  let badTag = null;
  let elementCount = 0;
  const walk = (nodes) => {
    for (const node of nodes) {
      elementCount += 1;
      if (!FEISHU_CARD_TAGS.includes(node.tag)) badTag = node.tag;
      if (['button', 'action', 'input', 'overflow'].includes(node.tag)) badTag = node.tag;
      if (node.text && node.text.tag !== 'plain_text') dynamicPlain = false;
      if (Array.isArray(node.elements)) walk(node.elements);
    }
  };
  walk(card.body.elements);

  check(`${state.label}：动态字段均为纯文本`, dynamicPlain);
  check(`${state.label}：无非法/可交互组件`, badTag === null, badTag ? `tag=${badTag}` : '');
  check(`${state.label}：元素数 ≤ ${FEISHU_CARD_MAX_ELEMENTS}`, elementCount <= FEISHU_CARD_MAX_ELEMENTS, `elements=${elementCount}`);
  const recordBytes = record.bytes ?? Buffer.byteLength(record.request_body ?? '', 'utf8');
  check(`${state.label}：签名后请求体 ≤ ${limit} 字节`, recordBytes <= limit, `${recordBytes} bytes`);
  check(`${state.label}：无 [object Object]`, !text.includes('[object Object]'));
  check(`${state.label}：无外部按钮/恢复操作`, !/recover-boundary|取消保护|直接解锁|force/.test(text));

  cards.push({ key: state.key, label: state.label, body, bytes: record.bytes, elements: elementCount, template: card.header.template, title: card.header.title.content });
}

// --- browser preview (approximates the client rendering) --------------------------
const TEMPLATE_COLOURS = {
  orange: { accent: '#a8620a', tint: '#fff7e8' },
  red: { accent: '#bb283b', tint: '#fff0f1' },
  green: { accent: '#13785a', tint: '#eaf8f1' },
  yellow: { accent: '#99620b', tint: '#fff8e7' },
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const renderCard = ({ label, body, bytes, elements }) => {
  const colours = TEMPLATE_COLOURS[body.card.header.template] ?? TEMPLATE_COLOURS.orange;
  const inner = body.card.body.elements.map((el) => (el.tag === 'hr'
    ? '<hr>'
    : `<p>${esc(el.text?.content ?? '')}</p>`)).join('\n');
  return `<article class="card" style="--accent:${colours.accent};--tint:${colours.tint}">
  <header><span class="eyebrow">${esc(label)}</span><h2>${esc(body.card.header.title.content)}</h2></header>
  <div class="body">${inner}</div>
  <footer>schema ${esc(body.card.schema)} · ${esc(body.card.header.template)} · ${bytes} bytes · ${elements} elements</footer>
</article>`;
};
const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Foundry · 飞书边界卡片（四态，由真实 dry-run 输出生成）</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#eef1f6;color:#1d2939;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:auto;padding:40px 20px}.page-eyebrow{font-size:11px;letter-spacing:2px;font-weight:750;color:#667085;margin:0}
h1{font-size:27px;letter-spacing:-1px;margin:8px 0}.sub{color:#667085;margin:0 0 26px;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}
.card{background:#fff;border:1px solid #dce2eb;border-radius:14px;overflow:hidden}
.card header{padding:18px 20px;border-top:4px solid var(--accent);background:var(--tint)}
.card .eyebrow{font-size:11px;letter-spacing:1.5px;font-weight:750;color:var(--accent)}
.card h2{font-size:18px;margin:6px 0 0}.card .body{padding:18px 20px}
.card p{margin:0 0 12px;font-size:13.5px;white-space:pre-line;overflow-wrap:anywhere}
.card hr{border:0;border-top:1px solid #eaecf0;margin:14px 0}
.card footer{padding:10px 20px;border-top:1px solid #eef1f6;font-size:11px;color:#667085}
.note{margin-top:26px;font-size:12px;color:#667085}
</style>
<main>
<p class="page-eyebrow">AGENT FOUNDRY / OPERATIONS</p>
<h1>飞书边界卡片 · 四态（Card JSON 2.0）</h1>
<p class="sub">本页由 <code>verification/feishu-card-states.mjs</code> 在 dry-run 下生成：未发送任何消息。客户端渲染与浏览器不完全一致。</p>
<section class="grid">
${cards.map(renderCard).join('\n')}
</section>
<p class="note">布局：状态标题 → 仓库与任务 → 异常依据 → 资产路径 → 处理建议 → 审计标识。全部动态字段为 plain_text，卡片不含任何可改变边界状态的操作组件。</p>
</main>
</html>
`;
const previewPath = join(previewDir, 'feishu-card-four-states.html');
writeFileSync(previewPath, html);
check('生成四态渲染预览 HTML', html.includes('schema 2.0') || cards.length === 4, previewPath);

// Screenshot with the local Chrome (rendering evidence).
let screenshot = null;
try {
  screenshot = join(previewDir, 'feishu-card-four-states.render.png');
  execFileSync('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,1100', `--screenshot=${screenshot}`, `file://${previewPath}`], { stdio: 'pipe', timeout: 90000 });
  check('用本机 Chrome 渲染预览并截图', true, screenshot);
} catch (err) {
  check('用本机 Chrome 渲染预览并截图', false, String(err.message).slice(0, 120));
}

// --- summary + evidence ----------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
writeFileSync(join(evidenceDir, 'card-states-manifest.json'), `${JSON.stringify({
  schema: 'af-feishu-card-states-v1',
  revision,
  mode,
  generated_at: new Date().toISOString(),
  limit_bytes: limit,
  states: selected.map((s) => s.key),
  cards: cards.map((c) => ({ key: c.key, label: c.label, template: c.template, title: c.title, bytes: c.bytes, elements: c.elements })),
  deliveries: rendered.map((r) => ({ key: r.key, alert_id: r.alert.alert_id, task_id: r.alert.task_id, status: r.result.status, attempts: r.result.attempts ?? null, settled: r.result.settled ?? null, http_status: r.result.http_status ?? null, provider_code: r.result.provider_code ?? null })),
  preview: { html: previewPath, screenshot },
  checks,
  passed: failed.length === 0,
}, null, 2)}\n`);

console.log(`mode: ${mode}`);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — FAILED: ${failed.map((c) => c.name).join('; ')}` : ''}`);
console.log(`evidence: ${evidenceDir}`);
console.log(`preview : ${previewPath}`);
rmSync(root, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
