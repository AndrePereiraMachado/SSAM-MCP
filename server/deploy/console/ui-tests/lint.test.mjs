// Static lint of public/ (DESIGN.md 6.1, 2.3; SPEC painel v2 8.2): CSP-clean pages (no HTML parsing of data, no inline style
// or script), SVG built only from geometry, the v2 visual rules in the CSS (text up to 32 px, radii up to 12 px, pills and
// dots the only round shapes, shadows only through the two shadow tokens, no gradient, no web font, no url()), no
// external URL, no emoji, browser storage only inside try/catch, the files of 6.1 and of the v2 components.
// The DESIGN.md 6.0 "tables only" rules (no cards, gauges, pills; text up to 16 px; no shadow) were superseded by the
// owner on 15/10 ("na verdade eu queria cards, icones, medidores").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC, publicFiles, readPublic } from './helpers.mjs';

const files = publicFiles();
const code = files.filter((f) => /\.(html|css|js|mjs|svg)$/.test(f));
const scripts = files.filter((f) => /\.(js|mjs)$/.test(f));
const read = (f) => readPublic(f);

/** Text without comments, so a rule never matches its own documentation. */
function stripJs(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}
function stripCss(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the files of DESIGN.md 6.1 exist', () => {
  const need = [
    'index.html', 'app.css', 'favicon.svg', 'js/main.js', 'js/api.js', 'js/format.js', 'js/table.js', 'js/sparkline.js',
    'js/dialogs.js', 'js/secret.js', 'js/views/visao.js', 'js/views/licencas.js', 'js/views/uso.js', 'js/views/agentes.js',
    'js/views/vps.js', 'js/views/eventos.js', 'js/views/historico.js', 'js/views/qualidade.js', 'mock/dev-server.mjs',
    'js/icons.js', 'js/charts.js', 'js/cards.js', 'js/dom.js', 'js/views/common.js',
  ];
  for (const f of need) assert.ok(files.includes(f), f);
  for (const s of ['normal', 'vazio', 'problemas', 'sem-coletor', 'sem-renovar']) {
    assert.ok(fs.existsSync(path.join(PUBLIC, 'mock', s, 'meta.json')), `mock/${s}`);
  }
});

test('no HTML parsing of data, no eval, no inline style or event handler from script', () => {
  const rules = [
    [/\binnerHTML\b/, 'innerHTML'], [/\bouterHTML\b/, 'outerHTML'], [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
    [/\bdocument\.write\b/, 'document.write'], [/\beval\s*\(/, 'eval'], [/\bnew\s+Function\b/, 'new Function'],
    [/setAttribute\(\s*['"]style['"]/, 'setAttribute style'], [/\.style\.cssText\b/, 'style.cssText'],
    [/setAttribute\(\s*['"]on[a-z]+['"]/, 'setAttribute on*'], [/\bcreateContextualFragment\b/, 'createContextualFragment'],
    [/\bDOMParser\b/, 'DOMParser'], [/\bsrcdoc\b/, 'srcdoc'], [/style\s*=\s*["']/, 'style= in markup'],
  ];
  const hits = [];
  for (const f of scripts) {
    const src = stripJs(read(f));
    for (const [re, name] of rules) if (re.test(src)) hits.push(`${f}: ${name}`);
  }
  assert.deepEqual(hits, []);
});

test('index.html: no inline script or style, no event attributes, the tabs of 6.2', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'style attribute');
  assert.doesNotMatch(html, /<style[\s>]/i, '<style> element');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'event handler attribute');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /\bsrc\s*=/, 'every script has src');
    assert.equal(m[2].trim(), '', 'no inline script body');
  }
  const labels = [...html.matchAll(/<span class="tlabel">([^<]+)<\/span>/g)].map((m) => m[1]);
  // Qualidade after Uso (DESIGN-QUALIDADE 4.5): shortcut 4, the later tabs 5-8
  assert.deepEqual(labels, ['Visão geral', 'Licenças', 'Uso', 'Qualidade', 'Agentes e sessões', 'VPS', 'Eventos', 'Histórico']);
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 8);
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 8);
  assert.match(html, /<dialog id="dlg"/);
  assert.match(html, /<html lang="pt-BR">/);
  assert.match(read('js/main.js'), /e\.key >= '1' && e\.key <= '8'/);
});

// Charts stay SVG and plain elements: no <canvas>, no drawing context, no <progress>/<meter> elements (meters are
// role="meter" with aria values). The Qualidade view still builds its tables with createTable and its Resumo as the
// two-column key-value table, every value as text.
test('charts: no canvas or drawing context; Qualidade keeps its tables and puts every value in as text', () => {
  const hits = [];
  for (const f of scripts.filter((x) => x.startsWith('js/'))) {
    const src = stripJs(read(f));
    for (const m of src.matchAll(/\bh\(\s*'([a-z0-9]+)'/g)) if (['canvas', 'progress', 'meter'].includes(m[1])) hits.push(`${f}: <${m[1]}>`);
    if (/createElement\(\s*'(canvas|progress|meter)'/.test(src)) hits.push(`${f}: createElement chart element`);
    if (/getContext\(/.test(src)) hits.push(`${f}: canvas drawing`);
  }
  const html = read('index.html');
  if (/<(canvas|progress|meter)\b/i.test(html)) hits.push('index.html: chart element');
  assert.deepEqual(hits, []);
  const q = stripJs(read('js/views/qualidade.js'));
  assert.match(q, /createTable\(/);
  assert.match(q, /class: 'kv kv-keep'/);
  assert.doesNotMatch(q, /innerHTML|insertAdjacent/);
});

// SVG of icons and charts: only createElementNS, and only geometry, class and accessibility attributes (no style, no
// event attribute, no href); the charts' svgEl helper refuses any other name at run time.
const SVG_GEOMETRY = ['d', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx', 'viewBox', 'transform', 'stroke-dasharray', 'class', 'role', 'points'];
test('icons and charts build SVG from geometry only', () => {
  const hits = [];
  for (const f of ['js/icons.js', 'js/charts.js']) {
    const src = stripJs(read(f));
    if (/document\.createElement\(\s*'(svg|path|circle|rect|g|text|line|polyline)'/.test(src)) hits.push(`${f}: SVG element without its namespace`);
    for (const m of src.matchAll(/setAttribute\(\s*'([^']+)'/g)) {
      if (!SVG_GEOMETRY.includes(m[1]) && !/^aria-[a-z]+$/.test(m[1])) hits.push(`${f}: setAttribute ${m[1]}`);
    }
    for (const m of src.matchAll(/setAttribute\(\s*([^'\s)][^,]*),/g)) {
      if (f === 'js/charts.js' && m[1].trim() === 'k') continue;
      hits.push(`${f}: setAttribute with a computed name (${m[1].trim()})`);
    }
  }
  const charts = stripJs(read('js/charts.js'));
  const allowed = /const SVG_ATTRS = new Set\(\[([^\]]+)\]\)/.exec(charts);
  assert.ok(allowed, 'charts.js keeps its SVG attribute list');
  for (const m of allowed[1].matchAll(/'([^']+)'/g)) {
    if (!SVG_GEOMETRY.includes(m[1]) && !/^aria-[a-z]+$/.test(m[1])) hits.push(`charts.js SVG_ATTRS: ${m[1]}`);
  }
  assert.match(charts, /if \(!SVG_ATTRS\.has\(k\)\) throw/);
  assert.deepEqual(hits, []);
});

test('CSS: text up to 32 px, radii up to 12 px (999px only for pills and counts, 50% only for dots), shadows only by token, no gradients, web fonts or imports', () => {
  const src = stripCss(read('app.css'));
  const hits = [];
  for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1].trim();
    const body = m[2];
    for (const r of body.matchAll(/box-shadow\s*:\s*([^;}]+)/g)) {
      const v = r[1].trim();
      if (!['none', 'var(--shadow-card)', 'var(--shadow-pop)'].includes(v)) hits.push(`box-shadow: ${v} in ${selector}`);
    }
    if (/border-radius\s*:\s*50%/.test(body) && !/dot/.test(selector)) hits.push(`border-radius: 50% in ${selector}`);
    for (const r of body.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
      for (const px of r[1].matchAll(/(\d+)px/g)) {
        const n = Number(px[1]);
        if (n === 999 && /pill|tcount/.test(selector)) continue;
        if (n > 12) hits.push(`border-radius ${n}px in ${selector}`);
      }
    }
  }
  if (/text-shadow\s*:/.test(src)) hits.push('text-shadow');
  if (/drop-shadow\s*\(/.test(src)) hits.push('drop-shadow');
  if (/gradient\s*\(/.test(src)) hits.push('gradient');
  if (/@import\b/.test(src)) hits.push('@import');
  if (/@font-face\b/.test(src)) hits.push('@font-face');
  if (/url\(/.test(src)) hits.push('url()');
  for (const m of src.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
    const v = m[1].trim();
    const px = /^(\d+(?:\.\d+)?)px$/.exec(v);
    if (px ? Number(px[1]) > 32 : !/^(0|inherit|initial|unset|100%|1em|1rem|smaller)$/.test(v)) hits.push(`font-size: ${v}`);
  }
  for (const m of src.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}]+)/g)) {
    for (const s2 of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) if (Number(s2[1]) > 32) hits.push(`font: ${m[1].trim()}`);
  }
  assert.deepEqual(hits, []);
  assert.match(src, /\.dot\s*\{[^}]*width:\s*8px;[^}]*height:\s*8px;/, 'the status dot is 8 px');
  assert.match(src, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus\);\s*outline-offset:\s*2px;/, 'focus ring of 6.8');
  assert.match(src, /prefers-reduced-motion:\s*reduce/, 'no animation under reduced motion');
  assert.match(src, /\.table-wrap\s*\{[^}]*overflow-x:\s*auto/, 'tables scroll inside .table-wrap');
});

test('no external URL in public/ (the SVG namespace and the example domain of the fixtures are not fetches)', () => {
  const hits = [];
  for (const f of files) {
    if (!/\.(html|css|js|mjs|svg|json)$/.test(f)) continue;
    const src = read(f);
    for (const m of src.matchAll(/https?:\/\/[^\s'"`)<>]*/g)) {
      const url = m[0];
      if (url === 'http://www.w3.org/2000/svg') continue;
      if (f.startsWith('mock/') && f.endsWith('.json') && /^https:\/\/ssam\.example\.com(\/mcp)?$/.test(url)) continue;
      // The fixture generator builds those same example URLs from HOST = 'ssam.example.com'.
      if (f === 'mock/make-fixtures.mjs' && /^https:\/\/\$\{HOST\}(\/mcp)?$/.test(url) && /export const HOST = 'ssam\.example\.com';/.test(src)) continue;
      hits.push(`${f}: ${url}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('no emoji anywhere in public/', () => {
  const hits = [];
  for (const f of files) {
    if (!/\.(html|css|js|mjs|svg|json)$/.test(f)) continue;
    const src = read(f);
    const m = /\p{Extended_Pictographic}/u.exec(src);
    if (m) hits.push(`${f}: U+${m[0].codePointAt(0).toString(16)}`);
  }
  assert.deepEqual(hits, []);
});

test('browser storage is only touched inside try blocks', () => {
  const hits = [];
  for (const f of scripts) {
    const lines = stripJs(read(f)).split('\n');
    lines.forEach((line, i) => {
      if (!/\b(localStorage|sessionStorage)\b/.test(line)) return;
      const before = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (!/\btry\s*\{/.test(before)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the theme toggle and the key handling follow 6.3 and 2.3', () => {
  const main = read('js/main.js');
  const api = read('js/api.js');
  assert.match(main, /'automático'/);
  assert.match(main, /'claro'/);
  assert.match(main, /'escuro'/);
  assert.match(main, /setAttribute\('data-theme'/);
  assert.match(api, /X-SSAM-Console-Key/);
  assert.match(api, /sessionStorage\.setItem/);
  assert.match(api, /history\.replaceState\(null, '', `\$\{location\.pathname\}\$\{location\.search\}#\/visao`\)/);
  assert.match(api, /X-Mock-Scenario/);
  assert.doesNotMatch(api, /localStorage/, 'the key never goes to localStorage');
});

test('every module the pages import exists (relative ES module imports only)', () => {
  const missing = [];
  for (const f of scripts.filter((s) => s.startsWith('js/'))) {
    for (const m of read(f).matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        missing.push(`${f}: bare import ${spec}`);
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      if (!files.includes(target)) missing.push(`${f}: ${spec}`);
    }
  }
  assert.deepEqual(missing, []);
});
