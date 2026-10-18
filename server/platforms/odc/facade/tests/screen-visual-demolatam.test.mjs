import './fixtures/isolated-profile.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

// CX17 W8: the DOM the runtime will publish for the owner's DemoLATAM pages (predicted by the kernel, DemoLatamVisualTests, before
// and after; dumps outside the repository in SSAM_DEMOLATAM_DUMP, skipped without them), styled by OutSystems UI (the fixture's
// theme, outsystems-ui.css in the dump folder), the module theme of each module (theme.css of each side: the after side carries
// the native layout block, never the owner's final theme) and an approximation of the runtime's own classes. Every element is
// paired with its twin (the sentinels of the virtualization left out) and every property the CSS names is compared; each
// difference is given to a family (F1 rows, F2 classes, F3 gutter, F6 layout) and none may be left without one. jsdom 30 does
// not lay out nor evaluate @media (the same on both sides); the width on a phone is measured by the Edge captures.
const dump = process.env.SSAM_DEMOLATAM_DUMP;
const runtime = '.OSFillParent{display:block;width:100%;box-sizing:border-box}\n.ThemeGrid_MarginGutter{margin-left:20px}\n';
const unsupported = /:hover\b|:focus\b|:active\b|::[\w-]+|:(?:before|after|first-line|first-letter)\b/i;

function splitList(text) {
  const out = []; let start = 0, depth = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

function prune(container) {
  for (let i = container.cssRules.length - 1; i >= 0; i--) {
    const rule = container.cssRules[i];
    if (rule.selectorText) {
      const all = splitList(rule.selectorText);
      const kept = all.filter(s => !unsupported.test(s));
      if (!kept.length) container.deleteRule(i); else if (kept.length !== all.length) rule.selectorText = kept.join(',');
    } else if (rule.cssRules) prune(rule);
  }
}

function page(html, sheets) {
  const console = new VirtualConsole();
  console.on('jsdomError', error => { if (error.type !== 'css-parsing') throw error; });
  const dom = new JSDOM(`<!doctype html><html><head></head><body class="desktop"><div id="reactContainer"><div class="screen-container">${html}</div></div></body></html>`, { virtualConsole: console });
  for (const css of sheets) {
    const style = dom.window.document.createElement('style');
    style.textContent = css;
    dom.window.document.head.append(style);
    if (style.sheet) prune(style.sheet);
  }
  return dom;
}

const names = css => [...new Set([...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;{])\s*([a-zA-Z][\w-]*)\s*:/g)].map(m => m[1].toLowerCase()))];
const classesOf = e => (e.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).sort().join(' ');

// The family of a difference: the runtime's gutter (F3), the layout chain (F6), the box of a List (F1), else the class a widget
// was born with (F2, on the element or inherited from an ancestor whose class changed).
function family(before, after, property) {
  if (/\bThemeGrid_MarginGutter\b/.test(before.getAttribute('class') ?? '') && (property === 'margin-left' || property === 'margin')) return 'F3';
  if (property === 'min-width' && before.matches('.layout .main, .layout .content, .layout .main-content')) return 'F6';
  if (before.hasAttribute('data-list') && ['display', 'width', 'position', 'overflow-x'].includes(property)) return 'F1';
  for (let b = before, a = after; b && a && b.nodeType === 1; b = b.parentElement, a = a.parentElement)
    if (classesOf(b) !== classesOf(a)) return b === before ? 'F2' : 'F2 (inherited)';
  return 'other';
}

test('DemoLATAM: every computed difference before/after belongs to a family (F1-F6), none to anything else', { skip: !dump, timeout: 900000 }, t => {
  const osuiPath = path.join(dump, 'outsystems-ui.css');
  assert.ok(fs.existsSync(osuiPath), 'outsystems-ui.css (the fixture theme, read headless) in the dump folder');
  const osui = fs.readFileSync(osuiPath, 'utf8').replace(/@import[^;]*;/g, '');
  const themeBefore = fs.readFileSync(path.join(dump, 'antes', 'theme.css'), 'utf8').replace(/@import[^;]*;/g, '');
  const themeAfter = fs.readFileSync(path.join(dump, 'depois', 'theme.css'), 'utf8').replace(/@import[^;]*;/g, '');
  assert.ok(themeAfter.includes('/* ssam:native-layout */') && !themeBefore.includes('/* ssam:native-layout */'), 'the native layout block is the after side\'s');
  const props = [...new Set([...names(themeBefore), ...names(themeAfter), 'display', 'width', 'min-width', 'margin-left', 'position', 'height', 'padding-top', 'border-top-width', 'background-color', 'color', 'overflow-x'])].sort();
  const roots = fs.readdirSync(path.join(dump, 'antes')).filter(f => f.endsWith('.html') && fs.existsSync(path.join(dump, 'depois', f)));
  assert.ok(roots.length > 0);
  const totals = { elements: 0, comparisons: 0, F1: 0, F2: 0, 'F2 (inherited)': 0, F3: 0, F6: 0, other: 0, unpaired: 0 };
  const others = [];
  for (const file of roots) {
    const before = page(fs.readFileSync(path.join(dump, 'antes', file), 'utf8'), [runtime, osui, themeBefore]);
    const after = page(fs.readFileSync(path.join(dump, 'depois', file), 'utf8'), [runtime, osui, themeAfter]);
    try {
      const list = d => [...d.window.document.querySelectorAll('.screen-container *')].filter(e => e.tagName !== 'SCRIPT');
      const b = list(before), a = list(after);
      if (b.length !== a.length || b.some((e, i) => e.tagName !== a[i].tagName)) { totals.unpaired++; t.diagnostic(`${file}: ${b.length} vs ${a.length} elements, not paired`); continue; }
      totals.elements += b.length;
      const local = { F1: 0, F2: 0, 'F2 (inherited)': 0, F3: 0, F6: 0, other: 0 };
      for (let i = 0; i < b.length; i++) {
        const sb = before.window.getComputedStyle(b[i]), sa = after.window.getComputedStyle(a[i]);
        for (const p of props) {
          totals.comparisons++;
          const vb = sb.getPropertyValue(p), va = sa.getPropertyValue(p);
          if (vb === va) continue;
          const f = family(b[i], a[i], p);
          totals[f]++; local[f]++;
          if (f === 'other' && others.length < 20) others.push({ file, tag: b[i].tagName, class: b[i].getAttribute('class'), property: p, before: vb, after: va });
        }
      }
      t.diagnostic(`${file}: ${b.length} elements ${JSON.stringify(local)}`);
    } finally { before.window.close(); after.window.close(); }
  }
  t.diagnostic(JSON.stringify(totals));
  fs.writeFileSync(path.join(dump, 'jsdom-families.json'), JSON.stringify({ totals, others }, null, 1));
  assert.equal(totals.other, 0, JSON.stringify(others, null, 1));
  assert.ok(totals.F2 > 0 && totals.F1 > 0 && totals.F3 > 0, 'the families the compile fixed show in the computed styles');
});
