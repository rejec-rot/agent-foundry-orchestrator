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
