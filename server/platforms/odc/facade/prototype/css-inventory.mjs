// CSS inventory (docs/PROTOTIPO-NATIVO.md 2.9): every sheet (<link rel=stylesheet> and <style>, in document order)
// with sha256, the rule count of the jsdom parser, its @imports (found by tokenization, never by line regex) and its
// url(...) references; plus the <style> elements created by scripts (e.g. Tailwind from the CDN), united over every
// explored state in order of first appearance, with origin "runtime". A sheet used by one page only (multi-page) is
// marked page:<key>.
import path from 'node:path';
import { sha256 } from './ir.mjs';

// Top-level statements of a CSS text by a small tokenizer that skips comments, strings and blocks.
export function cssImports(text) {
  const out = [];
  let i = 0, depth = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (ch === '"' || ch === "'") { i = skipString(text, i); continue; }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && ch === '@' && /^@import\b/i.test(text.slice(i, i + 8))) {
      let j = i + 7;
      while (j < n && text[j] !== ';') { if (text[j] === '"' || text[j] === "'") j = skipString(text, j); else if (text[j] === '(') { const close = text.indexOf(')', j); j = close < 0 ? n : close + 1; } else j++; }
      out.push(text.slice(i + 7, j).trim());
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) { if (text[i] === '\\') i++; i++; }
  return i + 1;
}

// url(...) references outside @import statements.
export function cssUrls(text) {
  const imports = cssImports(text);
  const out = [];
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g;
  let match;
  while ((match = pattern.exec(text))) {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    if (imports.some(statement => statement.includes(match[0]))) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

export function localReference(raw, sheetPath) {
  if (!raw || /^(data:|https?:|\/\/|#)/i.test(raw)) return null;
  const clean = raw.split(/[?#]/)[0];
  const base = sheetPath ? path.posix.dirname(sheetPath) : '.';
  const resolved = path.posix.normalize(path.posix.join(base === '.' ? '' : base, clean));
  return resolved.startsWith('..') ? null : resolved;
}

// sheets: [{order, href, runtime, text, rules}] from the child; files: SourceFiles-like reader (bytes/text of source).
// page: null (theme), a 'page:<key>' marker, or a function of the sheet returning one of them (multi-page).
export function inventory({ sheets, runtimeStyles = [], readText, page = null }) {
  const out = [];
  let order = 0;
  const pageOf = typeof page === 'function' ? page : () => page;
  for (const sheet of sheets) {
    const page = pageOf(sheet);
    if (sheet.external) { out.push({ path: null, url: sheet.external, order: order++, origin: 'external', page, bytes: null, sha256: null, rules: null, imports: [], urls: [] }); continue; }
    const text = sheet.href ? readText(sheet.href) : sheet.text ?? '';
    if (text == null) continue;
    const hash = sha256(Buffer.from(text, 'utf8'));
    out.push({
      path: sheet.href ?? null, bundle: 'sheets/' + hash + '.css', order: order++, origin: sheet.href ? 'file' : 'inline', page,
      bytes: Buffer.byteLength(text, 'utf8'), sha256: hash, rules: sheet.rules ?? null,
      imports: cssImports(text),
      urls: cssUrls(text).map(raw => ({ raw, asset: localReference(raw, sheet.href ?? null) })),
      text
    });
  }
  for (const text of runtimeStyles) {
    const hash = sha256(Buffer.from(text, 'utf8'));
    if (out.some(sheet => sheet.sha256 === hash)) continue;
    out.push({ path: null, bundle: 'sheets/' + hash + '.css', order: order++, origin: 'runtime', page, bytes: Buffer.byteLength(text, 'utf8'), sha256: hash, rules: null, imports: cssImports(text), urls: cssUrls(text).map(raw => ({ raw, asset: localReference(raw, null) })), text });
  }
  return out;
}
