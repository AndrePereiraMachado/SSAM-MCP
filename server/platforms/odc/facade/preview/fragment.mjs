// The fragment preview of a delivery (C04 of the atritos 3 package, servidor/fase4). The html ops of a job are the markup the
// kernel turns into widgets; this file renders that same markup, with the job's own CSS (the <style> of each fragment and
// every StyleSheet the job sets), as one static HTML page the user opens in a browser before or after the merge, so what
// was approved is what gets delivered. Pure and fast (a tag scanner, no DOM library): no Studio, no network, and no script
// runs (script elements and on* handlers are dropped). It is a structural preview, never the runtime: OutSystems
// expressions show as their text ({{ X }} -> a marked "X"), a block instance is a labelled frame with its slots, a list
// shows its row once, an if shows its true branch (an else is hidden), images of the module show as named boxes, and the
// OutSystems UI theme of the app is not applied (the page says so).
//   renderFragmentPreview({job, jobPath, root, op}) -> {ok:true, html, fragments:[{index, parent, bytes}], notes} |
//                                                      {ok:false, code:'PREVIEW_NO_FRAGMENT', error}
import fs from 'node:fs';
import path from 'node:path';

const BASE_CSS = `body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:16px;color:#1f2933;background:#f5f7fa}
.ssam-banner{font-size:12px;color:#52606d;margin:0 0 12px}.ssam-fragment{background:#fff;border:1px solid #d9e2ec;border-radius:6px;margin:0 0 16px;padding:12px}
.ssam-parent{font:600 12px/1.4 monospace;color:#486581;margin:0 0 8px}.ssam-expr{background:#fff3c4;border-radius:3px;padding:0 3px;font-family:monospace;font-size:.9em}
.ssam-icon{display:inline-block;min-width:1em;text-align:center;color:#627d98}.ssam-block{border:1px dashed #829ab1;border-radius:4px;padding:6px;margin:4px 0}
.ssam-block-label,.ssam-slot-label,.ssam-list-label,.ssam-if-label{font:11px/1.4 monospace;color:#829ab1}.ssam-slot{border-left:2px solid #bcccdc;padding-left:6px;margin:4px 0}
.ssam-image{display:inline-block;border:1px solid #bcccdc;background:#f0f4f8;color:#627d98;font:11px monospace;padding:12px}.ssam-else{display:none}`;

const escapeText = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = text => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const ops = document => (Array.isArray(document) ? document : Array.isArray(document?.ops) ? document.ops : []);
const EXPR = /\{\{([\s\S]*?)\}\}/g;
const TOKEN = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[A-Za-z][^>]*>/gi;
const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/g;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

// The markup of one html op: inline html, or its file relative to the job's folder, then to the root.
function markupOf(op, { jobPath, root }) {
  if (typeof op.html === 'string') return op.html;
  if (typeof op.file !== 'string' || !op.file) return null;
  for (const base of [jobPath ? path.dirname(jobPath) : null, root].filter(Boolean)) {
    const file = path.resolve(base, op.file);
    try { if (fs.statSync(file).isFile()) return fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { /* the next base */ }
  }
  return null;
}

// Text with {{ expr }} as marked spans (the expression shown as written, escaped).
const textWithExpressions = text => text.split(EXPR).map((part, i) => (i % 2 ? '<span class="ssam-expr" title="OutSystems expression">' + escapeText(part.trim()) + '</span>' : part)).join('');

function attributesOf(source) {
  const list = [];
  for (const match of source.matchAll(ATTRIBUTE)) {
    let value = match[2];
    if (value !== undefined && /^["']/.test(value)) value = value.slice(1, -1);
    list.push([match[1], value]);
  }
  return list;
}
// One start tag, rewritten: handlers and OutSystems bindings dropped, navigation to '#', expressions out of attributes.
function startTag(name, attributes, { extraClass = null, selfClosing = false } = {}) {
  const out = [];
  let classSeen = false;
  for (const [key, value] of attributes) {
    const lower = key.toLowerCase();
    if (lower.startsWith('on') || key.startsWith('@') || key.startsWith(':')) continue;
    if (lower === 'href') { out.push('href="#"'); continue; }
    if (value === undefined) { out.push(key); continue; }
    if (lower === 'class') {
      classSeen = true;
      const fixed = value.replace(EXPR, ' ').replace(/\s+/g, ' ').trim();
      out.push('class="' + escapeAttribute([fixed, extraClass].filter(Boolean).join(' ')) + '"');
      continue;
    }
    out.push(key + '="' + escapeAttribute(value.replace(EXPR, (m, expr) => expr.trim())) + '"');
  }
  if (!classSeen && extraClass) out.push('class="' + extraClass + '"');
  return '<' + name + (out.length ? ' ' + out.join(' ') : '') + (selfClosing ? ' />' : '>');
}
const valueOf = (attributes, name) => attributes.find(([key]) => key.toLowerCase() === name)?.[1];
const label = (className, text) => '<div class="' + className + '">' + escapeText(text) + '</div>';

function transform(markup, styles, notes) {
  let out = '', last = 0;
  // Custom elements of the html-visual syntax (Block, slot, ButtonGroup...) become divs: their end tags follow the same map.
  const stack = [];
  let iconEnds = 0; // the </i> of an icon (<i icon>), which became a span with no children
  for (const match of markup.matchAll(TOKEN)) {
    out += textWithExpressions(markup.slice(last, match.index));
    last = match.index + match[0].length;
    const token = match[0];
    if (token.startsWith('<!--')) continue;
    if (match[1]) {
      if (match[1].toLowerCase() === 'style') styles.push(token.replace(/^<style\b[^>]*>/i, '').replace(/<\/style\s*>$/i, ''));
      else notes.add('script removed');
      continue;
    }
    const closing = token.startsWith('</');
    const body = token.slice(closing ? 2 : 1, -1).replace(/\/\s*$/, '');
    const name = /^[A-Za-z][\w:-]*/.exec(body)[0];
    const tag = name.toLowerCase();
    if (closing) {
      if (VOID.has(tag)) { notes.add('</' + tag + '> ignored'); continue; }
      if (tag === 'i' && iconEnds > 0 && stack.at(-1) !== 'i') { iconEnds--; continue; }
      const open = stack.lastIndexOf(tag);
      // An end tag closes its element and every element still open inside it (as a browser does).
      if (open >= 0) for (const inner of stack.splice(open).reverse()) out += '</' + (closer[inner] ?? inner) + '>';
      continue;
    }
    const attributes = attributesOf(body.slice(name.length));
    const selfClosing = /\/\s*>$/.test(token);
    const push = () => { if (!selfClosing && !VOID.has(tag)) stack.push(tag); };
    if (tag === 'block') {
      out += startTag('div', [], { extraClass: 'ssam-block', selfClosing: false }) + label('ssam-block-label', 'Block ' + (valueOf(attributes, 'name') ?? '?'));
      if (selfClosing) out += '</div>'; else push();
    } else if (tag === 'slot') {
      out += startTag('div', [], { extraClass: 'ssam-slot' }) + label('ssam-slot-label', 'slot ' + (valueOf(attributes, 'name') ?? ''));
      if (selfClosing) out += '</div>'; else push();
    } else if (tag === 'buttongroup' || tag === 'buttongroupitem') {
      out += startTag(tag === 'buttongroup' ? 'div' : 'button', attributes, { selfClosing });
      push();
    } else if (tag === 'i' && valueOf(attributes, 'icon') !== undefined) {
      out += '<span class="' + escapeAttribute(['ssam-icon', valueOf(attributes, 'class')].filter(Boolean).join(' ')) + '" title="icon ' + escapeAttribute(valueOf(attributes, 'icon')) + '">◆</span>';
      if (!selfClosing) iconEnds++;
    } else if (tag === 'img' && valueOf(attributes, 'src') !== undefined && !/^(https?:|data:)/i.test(valueOf(attributes, 'src'))) {
      out += '<span class="' + escapeAttribute(['ssam-image', valueOf(attributes, 'class')].filter(Boolean).join(' ')) + '">image ' + escapeText(valueOf(attributes, 'src')) + '</span>';
    } else {
      const extra = valueOf(attributes, 'else') !== undefined || attributes.some(([key]) => key.toLowerCase() === 'else') ? 'ssam-else' : null;
      if (extra) notes.add('else branches are not shown');
      out += startTag(tag, attributes, { extraClass: extra, selfClosing });
      if (valueOf(attributes, 'list') !== undefined) out += label('ssam-list-label', 'list ' + valueOf(attributes, 'list') + ' as ' + (valueOf(attributes, 'as') ?? '?') + ' (one row shown)');
      if (valueOf(attributes, 'if') !== undefined) out += label('ssam-if-label', 'if ' + valueOf(attributes, 'if') + ' (true branch shown)');
      push();
    }
  }
  out += textWithExpressions(markup.slice(last));
  while (stack.length) out += '</' + (closer[stack.pop()] ?? 'div') + '>';
  return out;
}
// The element a custom start tag became, for its end tag.
const closer = { block: 'div', slot: 'div', buttongroup: 'div', buttongroupitem: 'button' };

// The StyleSheet values the job sets (theme CSS), in job order.
function styleSheetsOf(document) {
  const found = [];
  for (const op of ops(document)) {
    if (!op || typeof op !== 'object') continue;
    const property = String(op.property ?? op.name ?? '');
    if (/^style\s*sheet$/i.test(property) && typeof op.value === 'string') found.push(op.value);
  }
  return found;
}

export async function renderFragmentPreview({ job, jobPath = null, root = process.cwd(), op = null } = {}) {
  const document = typeof job === 'string' ? JSON.parse(fs.readFileSync(job, 'utf8').replace(/^﻿/, '')) : job;
  const file = typeof job === 'string' ? job : jobPath;
  const fragments = [];
  for (const [index, o] of ops(document).entries()) {
    if (o?.op !== 'html' || (op != null && index !== op)) continue;
    const markup = markupOf(o, { jobPath: file, root });
    if (typeof markup === 'string' && markup.trim()) fragments.push({ index, parent: typeof o.parent === 'string' ? o.parent : typeof o.screen === 'string' ? o.screen : null, markup });
  }
  if (!fragments.length) return { ok: false, code: 'PREVIEW_NO_FRAGMENT', error: 'The job has no html op with markup' + (op != null ? ' at index ' + op : '') + '; nothing to render.' };
  const styles = [...styleSheetsOf(document)];
  const notes = new Set();
  const sections = fragments.map(fragment => '<section class="ssam-fragment">' + label('ssam-parent', 'op ' + fragment.index + (fragment.parent ? ' -> ' + fragment.parent : ''))
    + '<div>' + transform(fragment.markup, styles, notes) + '</div></section>');
  const html = '<!doctype html>\n<html><head><meta charset="utf-8"><title>SSAM preview</title><style>' + BASE_CSS + '</style><style>' + styles.join('\n').replace(/<\/style/gi, '<\\/style')
    + '</style></head><body><p class="ssam-banner">SSAM: structural preview of the html of this job, with its own CSS; expressions are shown as written and the OutSystems UI theme of the app is not applied.</p>'
    + sections.join('\n') + '</body></html>\n';
  return { ok: true, html, fragments: fragments.map(({ index, parent, markup }) => ({ index, parent, bytes: Buffer.byteLength(markup) })), notes: [...notes] };
}
