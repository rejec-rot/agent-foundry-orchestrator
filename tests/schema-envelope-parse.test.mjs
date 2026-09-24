// schema-envelope-parse.test.mjs - a review must not be called "unparseable" when it is merely
// wrapped in a sentence.
//
// Measured cost of the removed defect: two live promotions each spent an extra reviewer call
// (~26s) because a schema-mode envelope only accepted pure JSON or a fenced block.

import './helpers/executors-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSchemaEnvelope } from '../lib/adapters.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('ENV-1: pure JSON, fenced JSON and prose-wrapped JSON all parse', () => {
  assert.deepEqual(parseSchemaEnvelope('{"decision":"PASS"}').parsed, { decision: 'PASS' });
  assert.deepEqual(parseSchemaEnvelope('```json\n{"decision":"PASS"}\n```').parsed, { decision: 'PASS' });
  assert.deepEqual(parseSchemaEnvelope('```\n{"decision":"NEEDS_FIX"}\n```\n').parsed, { decision: 'NEEDS_FIX' });

  // the regression: plain JSON inside a sentence, with no fence at all
  const wrapped = parseSchemaEnvelope('Here is my review.\n{"decision":"PASS","summary":"ok"}\nLet me know.');
  assert.deepEqual(wrapped.parsed, { decision: 'PASS', summary: 'ok' });

  // and a JSON object with trailing commentary after the closing brace
  const trailing = parseSchemaEnvelope('{"decision":"PASS"}\n\nHope that helps!');
  assert.deepEqual(trailing.parsed, { decision: 'PASS' });
});

test('ENV-2: text without a usable object stays unparsed - no guessing', () => {
  assert.equal(parseSchemaEnvelope('I could not review anything.').parsed, null);
  assert.equal(parseSchemaEnvelope('').parsed, null);
  assert.equal(parseSchemaEnvelope(undefined).parsed, null);
  assert.equal(parseSchemaEnvelope('{"decision":').parsed, null, 'truncated JSON is not a decision');
  assert.equal(parseSchemaEnvelope('[1,2,3]').parsed, null, 'an array is not a decision envelope');
  assert.equal(parseSchemaEnvelope('the decision is PASS and I am confident').parsed, null, 'prose is never parsed into a decision');
});

test('ENV-3: every schema-mode envelope also carries the raw result text', () => {
  const source = readFileSync(join(ROOT, 'lib', 'adapters.mjs'), 'utf8');
  const blocks = [...source.matchAll(/if \(capsule\.response_schema\) \{[\s\S]*?\n  \} else \{/g)].map((m) => m[0]);
  assert.ok(blocks.length >= 2, `expected the schema-mode branches, found ${blocks.length}`);
  const missing = blocks.filter((block) => !/\bresult:/.test(block));
  assert.deepEqual(missing.length, 0, 'a schema-mode envelope without `result` makes the orchestrator see an unparseable review', missing.length);
  assert.match(source, /export function parseSchemaEnvelope/, 'the shared extraction must stay exported and tested');
});
