// web-style-scale.test.mjs - the alignment guard.
//
// The complaint that started this was "不整齐" (not tidy). The cause was measurable: the stylesheet
// carried fifteen different pixel values, several of them one or two pixels off the scale, and that
// is exactly the "almost aligned" drift that reads as sloppiness.
//
// So the rule is a test rather than a habit: every SPACING value in web/styles.css must be a step on
// the 8pt scale (4 as the half-step), plus the two hairline widths and the off-canvas skip distance.
// Font sizes are deliberately exempt - type follows its own scale, and the 8pt grid governs spacing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'web', 'styles.css'), 'utf8');

/** Spacing properties: where an off-scale number becomes visible misalignment. */
const SPACING_PROPS = /^(padding|padding-[a-z]+|margin|margin-[a-z]+|gap|row-gap|column-gap|inset|inset-[a-z]+|top|right|bottom|left|border-radius|outline-offset|min-height|min-width|max-height|max-width|width|height)$/;
/** Allowed: the 8pt steps, the 4pt half-step, hairlines, and the off-canvas skip distance. */
const ALLOWED = new Set([0, 1, 2, 4, 8, 16, 24, 32, 40, 48, 56, 64, 96, 999]);

function declarations(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]/g)].map(([, prop, value]) => ({ prop, value }));
}

test('SCALE-1: every spacing value in the stylesheet is on the 8pt scale', () => {
  const offenders = [];
  for (const { prop, value } of declarations(CSS)) {
    if (!SPACING_PROPS.test(prop)) continue;
    // Tokens resolve to scale steps by construction, so only literal pixels are audited here.
    for (const match of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) {
      const px = Math.abs(Number(match[1]));
      if (ALLOWED.has(px)) continue;
      // a negative offset that mirrors an allowed step is the same step
      if (ALLOWED.has(Math.abs(px))) continue;
      offenders.push(`${prop}: ${value.trim()} → ${match[1]}px`);
    }
  }
  assert.deepEqual(offenders, [], `off-scale spacing found:\n  ${offenders.join('\n  ')}`);
});

test('SCALE-2: the spacing tokens exist and are what the rest of the file assumes', () => {
  assert.match(CSS, /--u:\s*8px/, 'the unit must be 8px');
  const steps = { '--s-half': '4px', '--s1': '8px', '--s2': '16px', '--s3': '24px', '--s4': '32px', '--s6': '48px', '--s8': '64px' };
  for (const [token, value] of Object.entries(steps)) {
    assert.match(CSS, new RegExp(`${token}:\\s*${value}`), `${token} must be ${value} (a step, not a number)`);
  }
  assert.match(CSS, /--baseline:\s*24px/, 'the baseline must be 24px: it is the body line-height and the fact-row height');
  assert.match(CSS, /body\s*\{[^}]*line-height:\s*var\(--baseline\)/s, 'body text must sit on the baseline');
});

test('SCALE-3: the layout is a real 12-column grid, and the column is a whole number of steps', () => {
  assert.match(CSS, /\.shell\s*\{[^}]*grid-template-columns:\s*repeat\(12,\s*var\(--col\)\)/s, 'the shell must be 12 columns of the constructed width');
  assert.match(CSS, /--col:\s*min\([^;]*round\(down,\s*calc\([^;]*100vw[^;]*, 8px\)/, 'the column must be snapped to whole 8px steps against the viewport, or the column edges land on fractions');
  assert.match(CSS, /margin-inline-start:\s*round\(down,\s*calc\(\(100vw - var\(--shell-width\)\) \/ 2\), 8px\)/, 'the outer margin must be snapped too, or the whole grid sits on a fraction');
  assert.match(CSS, /\.shell\s*\{[^}]*gap:\s*var\(--gutter\)/s, 'the gutter is a token');
  assert.match(CSS, /--gutter:\s*var\(--s3\)/, 'and that token must be a scale step (24px)');
  assert.match(CSS, /\.pane\.work\s*\{\s*grid-column:\s*span 6/, 'the working field spans 6 of 12');
  assert.match(CSS, /\.pane\.side\s*\{\s*grid-column:\s*span 3/, 'the command pane spans 3 of 12');
});

test('SCALE-4: grid breaks stay rare - three, and each is named', () => {
  // "Half the design is the breaks; half is everything else staying in place." The comment markers
  // are the contract: if a fourth break appears, it has to be argued for in the review.
  const breaks = [...CSS.matchAll(/break \d:/g)].map((m) => m[0]);
  assert.equal(breaks.length, 3, `expected exactly three declared grid breaks, found ${breaks.length}`);
  assert.match(CSS, /break 1: full bleed/, 'the rail is the full-bleed break');
  assert.match(CSS, /break 2: the goal/, 'the goal heading is the wide-measure break');
  assert.match(CSS, /break 3: the current step/, 'the current phase is the scaled break');
});

test('SCALE-5: no external asset and no library - the page stays offline and fast', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const remote = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]).filter((v) => /^https?:\/\//i.test(v));
  assert.deepEqual(remote, [], 'no remote asset may be referenced');
  assert.doesNotMatch(CSS, /@import|url\(\s*['"]?https?:/i, 'the stylesheet must not pull anything in');
  // motion is cheap: transform and opacity only
  const animated = [...CSS.matchAll(/transition:\s*([^;]+)/g)].map((m) => m[1]).join(' ');
  assert.doesNotMatch(animated, /\b(width|height|top|left|right|bottom|margin|padding)\b/, 'transitions must not animate layout properties');
});
