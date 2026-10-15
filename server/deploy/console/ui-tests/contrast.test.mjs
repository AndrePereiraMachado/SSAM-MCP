// Color tokens of SPEC painel v2 1.1 (the v2 dark-by-default palette): app.css carries exactly the table's values in both
// themes, and every text token reads on every surface it sits on: >= 4.5:1, body text (ink, ink-2) >= 7:1, status words on
// their soft backgrounds >= 4.5:1, button text >= 4.5:1, control borders and meter fills >= 3:1, the labels inside the
// 100 % bars on their series color >= 4.5:1, in light and dark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublic } from './helpers.mjs';

const SPEC = {
  bg: ['#f3f5f8', '#0b0e14'],
  side: ['#eef1f5', '#0e1219'],
  surface: ['#ffffff', '#141922'],
  'surface-2': ['#f7f8fa', '#1a202b'],
  'surface-3': ['#eef1f6', '#212835'],
  'row-new': ['#fff5d9', '#2a2416'],
  line: ['#e3e7ed', '#252c39'],
  'line-strong': ['#cdd3dc', '#323b4b'],
  'ctl-border': ['#848d9b', '#66728a'],
  track: ['#e5e9ef', '#262e3c'],
  grid: ['#edf0f4', '#222936'],
  axis: ['#c5ccd6', '#3a4456'],
  ink: ['#0f1724', '#e8ecf2'],
  'ink-2': ['#3b4555', '#b5becc'],
  muted: ['#5c6677', '#8892a4'],
  accent: ['#1a5fd0', '#6ea6ff'],
  'accent-soft': ['#e6eefc', '#16264a'],
  'accent-ink': ['#12459a', '#a9c8ff'],
  primary: ['#1a5fd0', '#2f6fe4'],
  'primary-hover': ['#154fb0', '#2860c9'],
  'on-primary': ['#ffffff', '#ffffff'],
  ok: ['#0d7446', '#3dd68c'],
  'ok-soft': ['#e3f4ec', '#0f2a1f'],
  warn: ['#995700', '#f5b945'],
  'warn-soft': ['#fdf0d9', '#2e2512'],
  bad: ['#c5262f', '#ff7070'],
  'bad-soft': ['#fde9ea', '#361b1f'],
  info: ['#2462a8', '#7ab8ff'],
  'info-soft': ['#e6eff9', '#132a42'],
  'warn-line': ['#ecc77f', '#5c4718'],
  'bad-line': ['#f0b4b8', '#6b2a31'],
  'bad-fill': ['#c5262f', '#d63a3a'],
  'on-bad': ['#ffffff', '#ffffff'],
  focus: ['#1a5fd0', '#6ea6ff'],
  spark: ['#3b4555', '#b5becc'],
  'series-1': ['#2a78d6', '#3987e5'],
  'series-2': ['#eb6834', '#d95926'],
  'series-3': ['#1baf7a', '#199e70'],
  'series-4': ['#eda100', '#c98500'],
  'series-5': ['#e87ba4', '#d55181'],
  'series-6': ['#008300', '#008300'],
  'series-7': ['#4a3aa7', '#9085e9'],
  'series-other': ['#b4bcc8', '#4b5568'],
  'on-series-1': ['#000000', '#000000'],
  'on-series-2': ['#000000', '#000000'],
  'on-series-3': ['#000000', '#000000'],
  'on-series-4': ['#000000', '#000000'],
  'on-series-5': ['#000000', '#000000'],
  'on-series-6': ['#ffffff', '#ffffff'],
  'on-series-7': ['#ffffff', '#000000'],
  'on-series-other': ['#000000', '#ffffff'],
};
const SERIES = ['1', '2', '3', '4', '5', '6', '7', 'other'];

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

const TEXT = ['ink', 'ink-2', 'muted', 'ok', 'warn', 'bad', 'info', 'accent', 'spark', 'focus'];
const SURFACES = ['surface', 'surface-2', 'surface-3', 'bg', 'side', 'row-new'];

for (const [theme, t] of [['claro', light], ['escuro', darkExplicit]]) {
  test(`contrast, tema ${theme}: text tokens >= 4.5:1 on every surface, body text >= 7:1, pills, buttons, borders, meters`, () => {
    const fails = [];
    const need = (fg, bg, min, what) => {
      const c = contrast(t[fg], t[bg]);
      if (c < min) fails.push(`${what || `--${fg} on --${bg}`}: ${c.toFixed(2)} (< ${min})`);
    };
    for (const fg of TEXT) for (const bg of SURFACES) need(fg, bg, 4.5);
    for (const fg of ['ink', 'ink-2']) for (const bg of SURFACES) need(fg, bg, 7, `body --${fg} on --${bg}`);
    // status words on their soft backgrounds (pills, icon chips), and primary text on every soft background
    for (const lv of ['ok', 'warn', 'bad', 'info']) {
      need(lv, `${lv}-soft`, 4.5);
      need('ink', `${lv}-soft`, 7);
    }
    need('accent-ink', 'accent-soft', 7);
    need('ink', 'accent-soft', 7);
    // buttons
    need('on-primary', 'primary', 4.5);
    need('on-primary', 'primary-hover', 4.5);
    need('on-bad', 'bad-fill', 4.5);
    // non-text: control borders, focus ring, meter fills on their track (WCAG 1.4.11)
    for (const bg of ['surface', 'surface-2', 'bg']) need('ctl-border', bg, 3);
    for (const bg of ['surface', 'surface-2', 'bg', 'accent-soft']) need('focus', bg, 3);
    for (const fill of ['ok', 'warn', 'bad', 'info', 'accent']) need(fill, 'track', 3);
    assert.deepEqual(fails, []);
  });
}

test('contrast: the percent labels inside the 100 % bars read >= 4.5:1 on their series color, light and dark', () => {
  const fails = [];
  for (const [theme, t] of [['claro', light], ['escuro', darkExplicit], ['escuro (sistema)', darkMedia]]) {
    for (const n of SERIES) {
      const c = contrast(t[`on-series-${n}`], t[`series-${n}`]);
      if (!(c >= 4.5)) fails.push(`${theme}: --on-series-${n} on --series-${n}: ${c.toFixed(2)}`);
    }
  }
  assert.deepEqual(fails, []);
  // every series class hands its text color to the label, and the label reads it
  for (const n of SERIES) {
    const cls = n === 'other' ? 'c-other' : `c-s${n}`;
    assert.match(css, new RegExp(`\\.${cls}\\s*\\{[^}]*--on-c:\\s*var\\(--on-series-${n}\\)`), cls);
  }
  assert.match(css, /\.sk-lab\s*\{[^}]*color:\s*var\(--on-c\b/);
});

test('the contrast function matches the WCAG reference values', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.ok(Math.abs(contrast('#767676', '#ffffff') - 4.54) < 0.01);
});
