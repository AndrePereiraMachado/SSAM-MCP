// Color tokens of DESIGN.md 6.7: app.css carries exactly the table's values in both themes, and every text token
// reads on every surface it sits on: >= 4.5:1, body text (ink, ink-2) >= 7:1, in light and dark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublic } from './helpers.mjs';

const SPEC = {
  bg: ['#f7f7f5', '#121211'],
  surface: ['#ffffff', '#1a1a18'],
  ink: ['#1c1c1a', '#ecebe6'],
  'ink-2': ['#45453f', '#c9c8c2'],
  muted: ['#696963', '#9d9c96'],
  line: ['#e6e5e1', '#2a2a27'],
  'line-strong': ['#cfcec9', '#3a3a36'],
  'row-hover': ['#f2f1ed', '#212120'],
  'row-new': ['#fbf3dc', '#2e2818'],
  ok: ['#1f7a4d', '#5cc28d'],
  warn: ['#9a6200', '#e3b25a'],
  bad: ['#b42318', '#f08a7e'],
  accent: ['#2f5bd3', '#8fabff'],
  focus: ['#2f5bd3', '#8fabff'],
  spark: ['#45453f', '#c9c8c2'],
};

const css = readPublic('app.css');

/** Tokens of the first rule whose selector text is exactly `selector`. */
function block(selector) {
  const re = new RegExp(`(^|[\\s}])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  assert.ok(m, `rule ${selector} exists`);
  const out = {};
  for (const d of m[2].matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out[d[1]] = d[2].toLowerCase();
  return out;
}

const light = block(':root');
const darkExplicit = block(':root[data-theme="dark"]');
const darkMedia = block(':root:not([data-theme="light"])');

test('app.css has every token of the table with its exact light and dark value', () => {
  for (const [name, [l, d]] of Object.entries(SPEC)) {
    assert.equal(light[name], l, `--${name} light`);
    assert.equal(darkExplicit[name], d, `--${name} dark (data-theme)`);
    assert.equal(darkMedia[name], d, `--${name} dark (prefers-color-scheme)`);
  }
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(css, /\bbody\s*\{[^}]*\bbackground\s*:/, 'body has an explicit background');
});

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT = ['ink', 'ink-2', 'muted', 'ok', 'warn', 'bad', 'accent', 'spark', 'focus'];
const SURFACES = ['surface', 'bg', 'row-hover', 'row-new'];

for (const [theme, t] of [['claro', light], ['escuro', darkExplicit]]) {
  test(`contrast, tema ${theme}: text tokens >= 4.5:1 on every surface, body text >= 7:1`, () => {
    const fails = [];
    for (const fg of TEXT) {
      for (const bg of SURFACES) {
        const c = contrast(t[fg], t[bg]);
        if (c < 4.5) fails.push(`--${fg} on --${bg}: ${c.toFixed(2)}`);
      }
    }
    for (const fg of ['ink', 'ink-2']) {
      for (const bg of SURFACES) {
        const c = contrast(t[fg], t[bg]);
        if (c < 7) fails.push(`body --${fg} on --${bg}: ${c.toFixed(2)} (< 7)`);
      }
    }
    // Buttons: primary (surface on ink), disabled primary (ink-2 on line-strong), filled danger (surface on bad).
    for (const [fg, bg, min] of [['surface', 'ink', 7], ['ink-2', 'line-strong', 4.5], ['surface', 'bad', 4.5], ['surface', 'ink-2', 4.5]]) {
      const c = contrast(t[fg], t[bg]);
      if (c < min) fails.push(`--${fg} on --${bg}: ${c.toFixed(2)} (< ${min})`);
    }
    assert.deepEqual(fails, []);
  });
}

test('the contrast function matches the WCAG reference values', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.ok(Math.abs(contrast('#767676', '#ffffff') - 4.54) < 0.01);
});
