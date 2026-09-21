// design-feishu-card.test.mjs - guards the Feishu boundary card design assets.
//
// These files are the source of truth for the future `feishu-card` notification format, so
// they must stay (a) valid JSON in the custom-bot envelope, (b) within the provider's hard
// limits, and (c) consistent with the three-state design. The tests intentionally do not
// contact Feishu: sending is a separate, explicitly authorised step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CARD = join(process.cwd(), 'docs', 'design', 'feishu-boundary-card.example.json');
const CARD_V2 = join(process.cwd(), 'docs', 'design', 'feishu-boundary-card.example.v2.json');
const PREVIEW = join(process.cwd(), 'docs', 'design', 'feishu-boundary-preview.html');

const ALLOWED_V2_TAGS = ['div', 'hr', 'markdown', 'plain_text', 'lark_md'];
const ALLOWED_TEMPLATES = ['blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange', 'red', 'carmine', 'violet', 'purple', 'indigo', 'grey'];
// Custom-bot cards render in the Feishu client; only these read-only tags are used by the design.
const ALLOWED_TAGS = ['div', 'hr', 'note', 'markdown', 'plain_text', 'lark_md'];

test('design: the Feishu card example is a valid custom-bot interactive envelope', () => {
  const raw = readFileSync(CARD, 'utf8');
  const body = JSON.parse(raw);

  assert.equal(body.msg_type, 'interactive', 'a custom bot sends cards as msg_type=interactive');
  assert.equal(typeof body.card, 'object');
  assert.equal(body.card.header?.title?.tag, 'plain_text');
  assert.ok(body.card.header.title.content.length > 0);
  assert.ok(ALLOWED_TEMPLATES.includes(body.card.header.template), `unknown header template: ${body.card.header.template}`);
  assert.ok(Array.isArray(body.card.elements) && body.card.elements.length > 0);

  const walkElements = (nodes) => {
    for (const node of nodes) {
      assert.ok(ALLOWED_TAGS.includes(node.tag), `unexpected element tag: ${node.tag}`);
      if (Array.isArray(node.elements)) walkElements(node.elements); // e.g. a note's children
      if (node.text) assert.ok(ALLOWED_TAGS.includes(node.text.tag), `unexpected text tag: ${node.text.tag}`);
      // `fields` entries are not elements themselves: only their text node matters.
      for (const field of node.fields ?? []) {
        assert.ok(field.text && ALLOWED_TAGS.includes(field.text.tag), `unexpected field text tag: ${field.text?.tag}`);
      }
    }
  };
  walkElements(body.card.elements);

  // Provider hard limit: the request body must stay under 20 KB.
  assert.ok(Buffer.byteLength(raw, 'utf8') < 20 * 1024, 'a card request body must stay under 20 KB');
});

test('design: the card carries the agreed information hierarchy', () => {
  const body = JSON.parse(readFileSync(CARD, 'utf8'));
  const text = JSON.stringify(body);
  for (const section of ['仓库', '任务', '判定依据', 'Canonical', 'CAS', '下一步', '边界状态']) {
    assert.match(text, new RegExp(section), `the card must keep the "${section}" section`);
  }
  assert.match(text, /AF-[A-Z0-9-]+/, 'the card must carry an audit identifier');
});

test('design: the HTML preview renders all three states with the same hierarchy', () => {
  const html = readFileSync(PREVIEW, 'utf8');
  for (const state of ['warn', 'danger', 'success']) {
    assert.match(html, new RegExp(`class="card ${state}"`), `missing the ${state} state`);
  }
  assert.match(html, /示例数据/, 'the preview must be labelled as sample data');
  // One <header class="head"> per card, plus the page-level eyebrow.
  assert.equal((html.match(/<header class="head">/g) ?? []).length, 3, 'exactly three card headers');
  for (const section of ['仓库', '任务', '判定依据', 'Canonical', 'CAS', '下一步']) {
    assert.match(html, new RegExp(section), `the preview must keep the "${section}" section`);
  }
});

test('design: the A1a design keeps the required deliverables and the no-bypass rules', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'design', 'A1A-AUTO-RECOVERY-DESIGN.md'), 'utf8');
  for (const section of ['状态转换表', '配置说明', '故障验收矩阵', '停用与回滚流程', '职责隔离', '成功标准']) {
    assert.match(doc, new RegExp(section), `the design must keep the "${section}" section`);
  }
  // Fail-closed rules that must never be relaxed by an implementation.
  for (const rule of ['RESTORE_INCOMPLETE', 'acknowledgeLiveScopes', 'allowGuessedModes', 'force', 'AF_A1A_MODE', 'dry-run']) {
    assert.match(doc, new RegExp(rule), `the design must state the ${rule} rule`);
  }
  assert.match(doc, /不实现、不启用/, 'the design must record that it is design-only');
  assert.match(doc, /两个独立调度职责/, 'the design must state that recovery and notify-flush are independent duties');

  // v2 safety-boundary revisions required by review.
  for (const rule of [
    '绝不因超时被接管',            // R1: no TTL preemption of a live holder
    '不可确认',                    // R1/R2: unconfirmable identity -> refuse
    'MUTATION_STARTED',            // R3: mutation phase evidence
    'RECONCILE_REQUIRED',          // R3: modified / unconfirmable -> manual
    'RECONCILE_RECORD',            // R3: physical restore done, records pending
    '禁止再次执行权限释放',         // R3: never release again in the record state
    'withAssetLockSet',            // R2: shared asset mutual-exclusion protocol
    'A1a 不得',                    // R2: hard gating before the protocol exists
    '预期保护元数据',              // clarification: expectation, not the raw snapshot
    '任务处于终态',                // clarification: task terminal state, not just process exit
    'RESULT 审计',                 // R4: ordering
  ]) {
    assert.match(doc, new RegExp(rule), `the design must record the v2 rule: ${rule}`);
  }
  // Every open question must now carry a decision.
  assert.match(doc, /六个开放问题的首版决定|本轮决定/);
  assert.doesNotMatch(doc, /## 10\. 待评审确认的开放问题/, 'open questions must have been decided');
});

test('design: the run console is read-only and keeps its required deliverables', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'design', 'TASK-RUN-CONSOLE-DESIGN.md'), 'utf8');
  for (const section of ['数据源清单', '只读保证', '关联键与图谱', '时间线模型', '视图与字段',
    '不可核验、新鲜度与一致性', '失败验收矩阵', '安全与出口', '与 A1a、通知的关系', '测试计划']) {
    assert.match(doc, new RegExp(section), `the console design must keep the "${section}" section`);
  }
  // Read-only invariants and the no-guess / no-merge rules must stay stated.
  for (const rule of ['只读', '不导入任何写 API', '不获取任何锁', '不调用有副作用的命令',
    '未关联', '绝不猜测', 'UNVERIFIABLE', '合成单一', 'order_basis', 'as_of']) {
    assert.match(doc, new RegExp(rule), `the console design must state: ${rule}`);
  }
  // Grounded in the real artifacts rather than invented ones.
  for (const source of ['tasks', 'tasklock', 'scheduler.json', 'executor-runtime-events.jsonl',
    'operator-activity', 'boundary-alerts.jsonl', 'notify-pending.json', 'inspectBoundaryAlerts', 'inspectPendingNotifications']) {
    assert.match(doc, new RegExp(source), `the console design must reference the real source ${source}`);
  }
});

test('design: the next-step architecture contract keeps its required deliverables', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'design', 'SYSTEM-ARCHITECTURE-NEXT.md'), 'utf8');
  for (const section of ['模块图', '权威数据源表', '状态字典', '证据关联规范', '接口契约', '版本与兼容规则',
    '缺失 / 损坏 / 陈旧 / 不可读 的统一行为']) {
    assert.match(doc, new RegExp(section), `the architecture doc must keep "${section}"`);
  }
  for (const rule of ['单一写者', '派生索引', '不可核验', '未关联', 'state_version',
    'PROTECTION_RETAINED_PENDING_RECOVERY', 'RESTORE_INCOMPLETE', 'unverifiable']) {
    assert.match(doc, new RegExp(rule), `the architecture doc must state "${rule}"`);
  }
  // Authority must point at the real artifacts, not invented ones.
  for (const real of ['saveTaskWithVersion', 'boundary-alerts.jsonl', 'notify-pending.json',
    'tasklock', 'scheduler.json', 'acceptance_evidence_id', 'refs/afr/canonical']) {
    assert.match(doc, new RegExp(real), `the architecture doc must reference ${real}`);
  }
});

test('design: the operations console keeps the six pages and the read-only rules', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'design', 'OPERATIONS-CONSOLE-DESIGN.md'), 'utf8');
  for (const page of ['总览', '任务列表', '任务详情', '结果与证据', '异常中心', '审计详情']) {
    assert.match(doc, new RegExp(page), `the console doc must define the "${page}" page`);
  }
  for (const rule of ['只读', '不因查询失败把列表显示为"没有异常"', '缓存状态', '最近核验状态',
    '脱敏', '不可信文本', '127.0.0.1', '无写能力', 'order_basis', 'as_of']) {
    assert.match(doc, new RegExp(rule.replace(/"/g, '"')), `the console doc must state "${rule}"`);
  }
});

test('design: the earlier console v1 is marked superseded but keeps its data sources', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'design', 'TASK-RUN-CONSOLE-DESIGN.md'), 'utf8');
  assert.match(doc, /已被取代/, 'the v1 console design must point at its successor');
  assert.match(doc, /OPERATIONS-CONSOLE-DESIGN\.md/);
  assert.match(doc, /RO1–RO7/, 'the read-only invariants must remain in the record');
});

test('design: A1a is frozen as an implementation baseline with its three hard constraints', () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'design', 'A1A-AUTO-RECOVERY-DESIGN.md'), 'utf8');
  assert.match(doc, /冻结记录/, 'the A1a design must record the freeze');
  for (const rule of ['H1', 'H2', 'H3', '持久化', '单调序号', '并发竞态']) {
    assert.match(doc, new RegExp(rule), `the freeze must record the hard constraint ${rule}`);
  }
});

test('design: the integration notes record the provider constraints and the open version question', () => {
  const notes = readFileSync(join(process.cwd(), 'docs', 'design', 'FEISHU-CARD-INTEGRATION-NOTES.md'), 'utf8');
  for (const fact of ['20 KB', '100 次/分钟', '11232', '自定义关键词', 'schema: "2.0"', 'feishu-card']) {
    assert.match(notes, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the notes must record "${fact}"`);
  }
});

test('design: the v2 example is Card JSON 2.0 with only 2.0-compatible components', () => {
  const raw = readFileSync(CARD_V2, 'utf8');
  const body = JSON.parse(raw);
  assert.equal(body.msg_type, 'interactive');
  assert.equal(body.card.schema, '2.0', '2.0 must be declared explicitly');
  assert.equal(body.card.elements, undefined, 'v1 keeps elements at the top level; 2.0 nests them under body');
  assert.ok(Array.isArray(body.card.body?.elements));
  assert.equal(body.card.config.update_multi, true, 'Card JSON 2.0 only supports shared cards');

  // `note` is not part of the 2.0 component set, and no interactive component is used.
  let count = 0;
  const walk = (nodes) => {
    for (const node of nodes) {
      count += 1;
      assert.ok(ALLOWED_V2_TAGS.includes(node.tag), `unexpected 2.0 tag: ${node.tag}`);
      assert.notEqual(node.tag, 'note');
      assert.notEqual(node.tag, 'button');
      if (node.text) assert.equal(node.text.tag, 'plain_text');
      if (Array.isArray(node.elements)) walk(node.elements);
    }
  };
  walk(body.card.body.elements);
  assert.ok(count <= 200, 'Card JSON 2.0 allows at most 200 elements/components');
  assert.ok(Buffer.byteLength(raw, 'utf8') < 20 * 1024, 'the custom-bot body limit is 20 KB');
  // The v1 example stays available for reference.
  assert.ok(readFileSync(CARD, 'utf8').includes('wide_screen_mode'), 'the v1 reference must be kept');
});

test('design: the generated four-state preview is present and matches the manifest', () => {
  const dir = join(process.cwd(), 'docs', 'design', 'generated');
  const html = readFileSync(join(dir, 'feishu-card-four-states.html'), 'utf8');
  for (const needle of ['边界保护已保留', '持续保留，告警已升级', '恢复未完成，保护完整性不可确认', '边界已恢复']) {
    assert.match(html, new RegExp(needle), `the preview must render the "${needle}" state`);
  }
  assert.match(html, /dry-run/, 'the preview must state that nothing was sent');
  assert.match(html, /plain_text|不含任何可改变边界状态的操作组件/);
  const png = readFileSync(join(dir, 'feishu-card-four-states.render.png'));
  assert.ok(png.length > 20_000, 'the rendered screenshot must not be empty');
});
