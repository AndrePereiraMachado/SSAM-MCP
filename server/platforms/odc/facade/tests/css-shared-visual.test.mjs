import './fixtures/isolated-profile.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const dumpDirectory = process.env.SSAM_CSS_SHARED_DUMP;
const viewportWidth = 1024;
const unsupportedSelector = /:hover\b|::[\w-]+|:(?:before|after|first-line|first-letter)\b/i;

function documents(job) {
  return (job.ops ?? job).filter(op => op.op === 'html').map(op => {
    const styles = [...op.data.html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)].map(match => {
      const attributes = new JSDOM(`<style ${match[1]}></style>`).window.document.querySelector('style');
      const result = { css: match[2], theme: attributes.getAttribute('scope') === 'theme', id: attributes.id };
      attributes.ownerDocument.defaultView.close();
      return result;
    });
    return { html: op.data.html, styles, css: op.data.css ?? '' };
  });
}

function theme(documents) {
  const named = new Map();
  const sheets = [];
  for (const document of documents) {
    for (const style of document.styles.filter(style => style.theme)) {
      if (!style.id) sheets.push(style.css);
      else if (named.has(style.id)) assert.equal(named.get(style.id), style.css, `Conflicting theme part ${style.id}`);
      else { named.set(style.id, style.css); sheets.push(style.css); }
    }
  }
  return sheets;
}

// Separators nested in functions, attributes or strings are not list separators.
function splitCss(text, separator = ',') {
  const result = [];
  let start = 0, depth = 0, quote = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\\') { index++; continue; }
    if (quote) { if (character === quote) quote = ''; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '(' || character === '[') depth++;
    if (character === ')' || character === ']') depth--;
    if (character === separator && depth === 0) { result.push(text.slice(start, index)); start = index + 1; }
  }
  result.push(text.slice(start));
  return result;
}

function expandFontShorthand(style, document) {
  if (!style.getPropertyValue('font')) return;
  // jsdom 30 applies the font shorthand after higher-specificity longhands. Expand only
  // this shorthand in the comparison harness, on both sides, to restore CSS cascade
  // semantics. Preserve declaration order, priority, and every other declaration.
  style.cssText = splitCss(style.cssText, ';').map(declaration => {
    if (!/^\s*font\s*:/i.test(declaration)) return declaration;
    const parsed = document.createElement('span').style;
    parsed.cssText = declaration;
    return Array.from({ length: parsed.length }, (_, index) => parsed.item(index))
      .filter(name => name !== 'font')
      .map(name => `${name}:${parsed.getPropertyValue(name)}${parsed.getPropertyPriority(name) ? ' !important' : ''}`)
      .join(';');
  }).join(';');
}

function excludeDynamicRules(container, counts, document) {
  for (let index = container.cssRules.length - 1; index >= 0; index--) {
    const rule = container.cssRules[index];
    if (rule.selectorText) {
      expandFontShorthand(rule.style, document);
      const all = splitCss(rule.selectorText);
      const supported = all.filter(selector => !unsupportedSelector.test(selector));
      if (supported.length !== all.length) {
        counts.dynamicRules++;
        if (supported.length) rule.selectorText = supported.join(',');
        else container.deleteRule(index);
      }
    } else if (rule.cssRules) {
      if (rule.type === 4) counts.mediaBlocks++;
      excludeDynamicRules(rule, counts, document);
    }
  }
}

function page(document, shared) {
  const console = new VirtualConsole();
  const counts = { dynamicRules: 0, mediaBlocks: 0, parseErrors: 0 };
  console.on('jsdomError', error => {
    if (error.type === 'css-parsing') counts.parseErrors++;
    else throw error;
  });
  const markup = document.html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<(\/?)\s*(?:screen|block)(?=[\s/>])/gi, '<$1div');
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${markup}</body></html>`, {
    pretendToBeVisual: true, virtualConsole: console,
  });
  Object.defineProperty(dom.window, 'innerWidth', { value: viewportWidth });
  for (const element of dom.window.document.querySelectorAll('[class]')) {
    element.setAttribute('class', element.getAttribute('class').replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) =>
      [...expression.matchAll(/(["'])(.*?)\1/g)].map(match => match[2]).join(' ')));
  }
  for (const element of dom.window.document.querySelectorAll('[style]')) expandFontShorthand(element.style, dom.window.document);
  for (const css of [...shared, ...document.styles.filter(style => !style.theme).map(style => style.css), document.css]) {
    if (!css) continue;
    const style = dom.window.document.createElement('style');
    style.textContent = css;
    dom.window.document.head.append(style);
    if (style.sheet) excludeDynamicRules(style.sheet, counts, dom.window.document);
  }
  return { dom, counts };
}

function properties(documents) {
  const names = new Set();
  const add = name => names.add(name.startsWith('--') ? name : name.toLowerCase());
  for (const document of documents) {
    for (const css of [...document.styles.map(style => style.css), document.css]) {
      // Also collect declarations in unreadable sheets: a property becoming active after a move must be compared.
      for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;{])\s*(--[\w-]+|[a-zA-Z][\w-]*)\s*:/g)) add(match[1]);
    }
    const markup = new JSDOM(document.html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ''));
    for (const element of markup.window.document.querySelectorAll('[style]')) {
      for (let index = 0; index < element.style.length; index++) add(element.style.item(index));
    }
    markup.window.close();
  }
  return [...names].sort();
}

test('shared CSS visual comparison uses a fixed viewport and documents jsdom media behavior', { skip: !dumpDirectory }, () => {
  const dom = new JSDOM('<style>.probe{color:red}@media(min-width:1px){.probe{color:blue}}</style><div class="probe"></div>', { pretendToBeVisual: true });
  assert.equal(dom.window.innerWidth, viewportWidth);
  // jsdom 30 keeps @media in CSSOM but does not evaluate it for getComputedStyle, on either side.
  assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('.probe')).color, 'rgb(255, 0, 0)');
  assert.equal(dom.window.document.styleSheets[0].cssRules[1].type, 4);
  dom.window.close();
});

test('visual harness expands font shorthand to preserve specificity and important priority', { skip: !dumpDirectory }, () => {
  const dom = new JSDOM('<style>.root{font-size:13px;line-height:1.55}.button{font-size:11px;font-weight:600;line-height:1.2}:where(.root) button{color:red;font:inherit;background:blue}</style><div class="root"><button class="button"></button></div>');
  const { document } = dom.window;
  const button = document.querySelector('button');
  // Reproduce the jsdom bug: the less-specific shorthand incorrectly wins.
  assert.equal(dom.window.getComputedStyle(button).fontSize, '13px');
  const rule = document.styleSheets[0].cssRules[2];
  expandFontShorthand(rule.style, document);
  // Invalidate jsdom's computed-style cache after the direct CSSOM change.
  const element = document.querySelector('style');
  element.textContent = [...document.styleSheets[0].cssRules].map(rule => rule.cssText).join('\n');
  const computed = dom.window.getComputedStyle(button);
  assert.equal(computed.fontSize, '11px');
  assert.equal(computed.fontWeight, '600');
  assert.equal(computed.lineHeight, '1.2');
  assert.equal(computed.color, 'rgb(255, 0, 0)');
  assert.equal(computed.backgroundColor, 'rgb(0, 0, 255)');
  const important = document.createElement('span').style;
  important.cssText = 'color:red!important;font:inherit!important;background:blue';
  expandFontShorthand(important, document);
  assert.equal(important.getPropertyValue('font-size'), 'inherit');
  assert.equal(important.getPropertyPriority('font-size'), 'important');
  assert.equal(important.getPropertyPriority('color'), 'important');
  assert.equal(important.getPropertyValue('background'), 'blue');
  dom.window.close();
});

for (const fixture of ['blocks-full', 'blocks-cut']) {
  test(`shared CSS preserves computed declarations: ${fixture}`, { skip: !dumpDirectory, timeout: 120000 }, t => {
    const before = documents(JSON.parse(fs.readFileSync(path.join(dumpDirectory, `${fixture}.before.json`), 'utf8')));
    const after = documents(JSON.parse(fs.readFileSync(path.join(dumpDirectory, `${fixture}.after.json`), 'utf8')));
    assert.equal(after.length, before.length);
    assert.ok(before.length > 0);
    const names = properties([...before, ...after]);
    assert.ok(names.length > 0);
    const beforeTheme = theme(before), afterTheme = theme(after);
    let elements = 0, comparisons = 0, differences = 0;
    const examples = [];
    for (let index = 0; index < before.length; index++) {
      const original = page(before[index], beforeTheme), normalized = page(after[index], afterTheme);
      try {
        assert.equal(normalized.dom.window.document.body.innerHTML, original.dom.window.document.body.innerHTML, `document ${index}: markup changed`);
        const oldElements = [...original.dom.window.document.body.querySelectorAll('*')];
        const newElements = [...normalized.dom.window.document.body.querySelectorAll('*')];
        elements += oldElements.length;
        for (let elementIndex = 0; elementIndex < oldElements.length; elementIndex++) {
          const oldStyle = original.dom.window.getComputedStyle(oldElements[elementIndex]);
          const newStyle = normalized.dom.window.getComputedStyle(newElements[elementIndex]);
          for (const property of names) {
            comparisons++;
            const oldValue = oldStyle.getPropertyValue(property), newValue = newStyle.getPropertyValue(property);
            if (oldValue !== newValue) {
              differences++;
              if (examples.length < 20) examples.push({ document: index, element: elementIndex, tag: oldElements[elementIndex].tagName, class: oldElements[elementIndex].className, property, before: oldValue, after: newValue });
            }
          }
        }
        t.diagnostic(JSON.stringify({ fixture, document: index, elements: oldElements.length, properties: names.length, before: original.counts, after: normalized.counts }));
      } finally { original.dom.window.close(); normalized.dom.window.close(); }
    }
    t.diagnostic(JSON.stringify({ fixture, viewportWidth, elements, properties: names.length, comparisons, differences, media: 'jsdom 30 ignores @media in computed styles; identical behavior before and after', excluded: ':hover and pseudo-element selectors' }));
    assert.equal(differences, 0, JSON.stringify(examples, null, 2));
  });
}
