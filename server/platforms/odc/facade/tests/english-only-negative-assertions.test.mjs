import './fixtures/isolated-profile.mjs';
// English-only guard, negative assertions (review english-junction round 1, F3): a negative text assertion
// (assert.doesNotMatch(x, /re/), assert.ok(!/re/.test(x)), assert.ok(!x.includes('text'))) whose Portuguese wording the
// code no longer emits passes whatever the answer says: since 15/10/2026 every text SSAM emits is English, so a
// Portuguese-only negative pattern guards nothing (fam-deps-deliver.test.mjs:51 and pa2-f4-queue.test.mjs:105 were such).
// Rule: each Portuguese alternative of a negative pattern that matches no text of the repository (a string literal of
// the code that builds answers, of the kernel or of a shared fixture that injects it, a served data value, a line of a
// guide still in Portuguese) needs, in the same pattern, an English prose alternative of its own (two words or more).
// The Portuguese alternative may stay (the answers of older releases and the guides still in pt-BR); alone it is vacuous.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { portugueseIn, jsLiterals, csLiterals } from './fixtures/portuguese-text.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const rel = file => path.relative(root, file).replace(/\\/g, '/');
const SKIP = new Set(['node_modules', 'bin', 'obj', '.local', 'examples']);
const filesUnder = (dir, test) => { const out = []; const walk = d => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p); } else if (test(e.name)) out.push(p); } }; walk(dir); return out; };

// The test files whose negative assertions are checked.
const TEST_DIRS = ['platforms/odc/facade/tests', 'platforms/odc/portal/tests', 'platforms/odc/tests'];
export function testFiles() { return TEST_DIRS.flatMap(d => filesUnder(path.join(root, d), n => n.endsWith('.test.mjs'))); }

// Every text the repository can emit or inject: string literals of the code and of the tests and fixtures, and the
// string values of the served data and suite jobs.
let corpus = null;
export function emittedTexts() {
  if (corpus) return corpus;
  const out = [];
  // The code (never a test file: a test's own literals are what it asserts; the shared fixtures that inject text count).
  const code = n => /\.(mjs|js)$/.test(n) && !/\.test\.mjs$/.test(n);
  for (const d of ['platforms/odc/facade', 'platforms/odc/portal', 'facade', 'scripts'])
    for (const f of filesUnder(path.join(root, d), code)) { try { for (const l of jsLiterals(fs.readFileSync(f, 'utf8'))) out.push(l.text); } catch { /* not a module */ } }
  for (const doc of ['AGENTS.md', 'platforms/odc/AGENTS.md', 'kernel/AGENTS.md', 'docs/CONHECIMENTO-DO-TIME.md', 'kernel/scripts/outsystems_padroes/RULES.md', 'kernel/docs/NAO-DA.md'])
    if (fs.existsSync(path.join(root, doc))) out.push(...fs.readFileSync(path.join(root, doc), 'utf8').split(/\r?\n/));
  for (const d of ['kernel/src', 'platforms/odc/studio']) for (const f of filesUnder(path.join(root, d), n => n.endsWith('.cs'))) for (const l of csLiterals(fs.readFileSync(f, 'utf8'))) out.push(l.text);
  const strings = v => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
  for (const d of ['platforms/odc/facade', 'platforms/odc/portal/catalog'])
    // (never the search-only aliases: they are input, no answer carries them)
    for (const f of filesUnder(path.join(root, d), n => n.endsWith('.json') && !n.endsWith('-aliases.json'))) { try { out.push(...strings(JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')))); } catch { /* not JSON */ } }
  corpus = out;
  return out;
}

// Top-level alternatives of a regular expression source (outside groups and classes).
export function alternatives(source) {
  const out = []; let depth = 0, cls = false, start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { i++; continue; }
    if (cls) { if (c === ']') cls = false; continue; }
    if (c === '[') cls = true; else if (c === '(') depth++; else if (c === ')') depth--; else if (c === '|' && depth === 0) { out.push(source.slice(start, i)); start = i + 1; }
  }
  out.push(source.slice(start));
  return out;
}
// The words an alternative spells (escapes of punctuation undone; classes, groups and quantifiers become spaces).
const spelled = alt => alt.replace(/\\[dDwWsSbB]/g, ' ').replace(/\\(.)/g, '$1').replace(/\[[^\]]*\]|\{\d+(,\d*)?\}|[()?*+{}^$|.:]/g, ' ').replace(/\s+/g, ' ').trim();
// Every spelling of an alternative, its inner groups expanded ((a|b) c -> "a c", "b c"; at most 64).
export function spellings(source) {
  const groupEnd = (s, i) => { let depth = 0, cls = false; for (let k = i; k < s.length; k++) { const c = s[k]; if (c === '\\') { k++; continue; } if (cls) { if (c === ']') cls = false; continue; } if (c === '[') cls = true; else if (c === '(') depth++; else if (c === ')' && --depth === 0) return k; } return s.length - 1; };
  let out = [''];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { out = out.map(x => x + source.slice(i, i + 2)); i++; continue; }
    if (c === '(') {
      const end = groupEnd(source, i); let inner = source.slice(i + 1, end).replace(/^\?(?:[:=!]|<[=!]|<[A-Za-z_]\w*>)/, '');
      const parts = alternatives(inner).flatMap(spellings);
      out = out.flatMap(x => parts.map(p => x + ' ' + p + ' ')).slice(0, 64); i = end; continue;
    }
    out = out.map(x => x + c);
  }
  return out.map(spelled);
}
const prose = words => words.split(' ').filter(w => /\p{L}{2,}/u.test(w)).length >= 2 && !/^[A-Z0-9_ ]+$/.test(words);
const live = (re, texts) => texts.some(t => { re.lastIndex = 0; return re.test(t); });

// Negative text assertions of one test file: [{line, kind, source, flags}] (a literal search is a pattern of its own).
export function negativeAssertions(code) {
  let ast; try { ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowAwaitOutsideFunction: true, allowHashBang: true }); } catch { return []; }
  const out = [];
  const isAssert = (callee, names) => (callee?.type === 'MemberExpression' && !callee.computed && names.includes(callee.property.name) && /^(assert|t\.assert)?$/.test(callee.object.name ?? (callee.object.type === 'MemberExpression' ? 't.assert' : '')))
    || (callee?.type === 'Identifier' && names.includes(callee.name));
  const regexOf = n => (n?.type === 'Literal' && n.regex ? n.regex : null);
  const negated = n => {
    if (n?.type !== 'UnaryExpression' || n.operator !== '!') return null;
    const call = n.argument; if (call?.type !== 'CallExpression' || call.callee?.type !== 'MemberExpression') return null;
    const name = call.callee.property?.name;
    if (name === 'test' && regexOf(call.callee.object)) return { kind: 'ok(!re.test)', ...regexOf(call.callee.object) };
    if (name === 'includes' && call.arguments[0]?.type === 'Literal' && typeof call.arguments[0].value === 'string')
      return { kind: 'ok(!includes)', pattern: call.arguments[0].value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: '' };
    return null;
  };
  const visit = node => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression') {
      if (isAssert(node.callee, ['doesNotMatch']) && regexOf(node.arguments[1])) out.push({ line: node.loc.start.line, kind: 'doesNotMatch', ...regexOf(node.arguments[1]) });
      if (isAssert(node.callee, ['ok', 'assert']) || (node.callee?.type === 'Identifier' && node.callee.name === 'assert')) { const n = negated(node.arguments[0]); if (n) out.push({ line: node.loc.start.line, ...n }); }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value);
    }
  };
  visit(ast);
  return out.map(({ pattern, flags, ...rest }) => ({ ...rest, source: pattern, flags }));
}

// The vacuous ones: a Portuguese alternative that matches no text, without a live English prose alternative of its own.
export function vacuous(code, texts = emittedTexts()) {
  const found = [];
  const asserted = negativeAssertions(code);
  // The test's own inputs count too (the owner's words a leak check feeds in), never the literal of an assertion itself.
  const lines = new Set(asserted.map(a => a.line));
  let own = []; try { own = jsLiterals(code).filter(l => !lines.has(l.line)).map(l => l.text); } catch { /* not a module */ }
  texts = texts.concat(own);
  for (const a of asserted) {
    const alts = alternatives(a.source).map(s => { let re = null; try { re = new RegExp(s, a.flags.replace('g', '')); } catch { /* not alone */ } return { s, re }; });
    // Portuguese: every spelling of the alternative reads as Portuguese. English twin: a spelling that is English prose.
    const portuguese = x => spellings(x.s).every(w => portugueseIn(w));
    const dead = alts.filter(x => x.re && portuguese(x) && !live(x.re, texts));
    if (!dead.length) continue;
    const twins = alts.filter(x => !portuguese(x) && spellings(x.s).some(w => prose(w) && !portugueseIn(w))).length;
    if (twins < dead.length) found.push({ line: a.line, kind: a.kind, pattern: '/' + a.source + '/' + a.flags, dead: dead.map(x => x.s), englishTwins: twins });
  }
  return found;
}

test('english-only: no negative text assertion of the facade tests targets only Portuguese the code no longer emits', () => {
  const texts = emittedTexts();
  const found = [];
  for (const file of testFiles()) for (const v of vacuous(fs.readFileSync(file, 'utf8'), texts)) found.push(rel(file) + ':' + v.line + ' ' + v.kind + ' ' + v.pattern + ' (dead: ' + v.dead.join(' | ') + '; live English twins: ' + v.englishTwins + ')');
  assert.deepEqual(found, [], found.length + ' vacuous negative assertions:\n' + found.join('\n'));
});

test('english-only: the negative-assertion check sees the two vacuous forms the review found and passes their fixes', () => {
  const texts = ['a write is already running in this Studio: wait for its answer and repeat this call; this read shows the Studio state', 'STUDIO_WRITE_BUSY',
    'The same job would roll back the same way. Follow the fix in the error: deliver with these producers as OML (producers). ', '. Deliver the same job again as a new delivery. ',
    'The job is right (SSAM defect, reported).'];
  const before = [
    "assert.doesNotMatch(why, /mesmo job de novo|O job está certo/);",
    "assert.doesNotMatch(out, /STUDIO_WRITE_BUSY|espere a resposta dela e repita/);",
    "assert.ok(!why.includes('espere a resposta dela'));",
  ];
  for (const code of before) assert.equal(vacuous(code, texts).length, 1, 'not seen as vacuous: ' + code);
  const after = [
    "assert.doesNotMatch(why, /same job again|The job is right|mesmo job de novo|O job está certo/);",
    "assert.doesNotMatch(out, /STUDIO_WRITE_BUSY|wait for its answer and repeat|espere a resposta dela e repita/);",
    "assert.doesNotMatch(out, /hunter2|sha256:[0-9a-f]{64}/);", // an English or code pattern is never judged here
  ];
  for (const code of after) assert.deepEqual(vacuous(code, texts), [], 'seen as vacuous: ' + code);
});
