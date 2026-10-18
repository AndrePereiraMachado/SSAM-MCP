import './fixtures/isolated-profile.mjs';
// English-only, the search family (review english-junction round 2, F7): every reader that compares the words of a request
// with served text that was translated searches the text that text had before the translation (one rule:
// search-aliases.mjs jobSearchText for the jobs, rulesAliasText/techInEnglish for the rules) and serves the English one.
// ssam_reference {kind:"example", query:{find}} escaped that rule: 82 of 100 Portuguese queries lost results, 68 to zero.
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSsamReference } from '../ssam-reference.mjs';
import { jobSearchAlias, JOB_SEARCH_READERS } from '../search-aliases.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const kernel = path.join(repo, 'kernel');
// The 200 example queries of the review (100 Portuguese, 100 English, both lanes) as bb12d2b3 answered them, before the
// translation: count and the ids listed.
const BB12D2B3 = JSON.parse(fs.readFileSync(new URL('./fixtures/example-find-bb12d2b3.json', import.meta.url), 'utf8'));

async function reference(t) {
  const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'example-find-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  let handler; registerSsamReference({ registerTool: (name, _s, fn) => { if (name === 'ssam_reference') handler = fn; } },
    { root: kernel, runAnvil: async () => { throw new Error('no CLI in this test'); }, outDir: out });
  return async input => { const r = await handler(input); return r.structuredContent ?? JSON.parse(r.content[0].text); };
}

test('example find: the 200 queries of the review (pt and en, both lanes) answer the count and the ids of bb12d2b3; descriptions served in English, never an alias', async t => {
  const ask = await reference(t);
  const wrong = { pt: [], en: [] };
  for (const want of BB12D2B3) {
    const a = await ask({ lane: want.lane, kind: 'example', query: { find: want.find } });
    const ids = (a.matches ?? []).map(m => m.id);
    if (a.count !== want.count || JSON.stringify(ids) !== JSON.stringify(want.ids)) wrong[want.lang].push(`${want.lane} '${want.find}': ${want.count} -> ${a.count}`);
    for (const m of a.matches ?? []) {
      const alias = jobSearchAlias(kernel, m.id.slice(0, m.id.lastIndexOf('/')), m.id.slice(m.id.lastIndexOf('/') + 1));
      if (alias?.description && m.description) assert.notEqual(m.description, alias.description, m.id + ': the alias is never served');
    }
  }
  assert.deepEqual(wrong, { pt: [], en: [] }, `pt ${wrong.pt.length}/100, en ${wrong.en.length}/100 differ:\n` + [...wrong.pt, ...wrong.en].slice(0, 40).join('\n'));
});

test('example find: the review\'s named queries keep the ids of bb12d2b3 on both lanes', async t => {
  const ask = await reference(t);
  for (const find of ['evento de bloco', 'entidade estatica', 'apagar atributo', 'bloco', 'recusa', 'tela', 'lista', 'form'])
    for (const lane of ['o11', 'odc']) {
      const want = BB12D2B3.find(r => r.lane === lane && r.find === find);
      if (!want) continue;
      const a = await ask({ lane, kind: 'example', query: { find } });
      assert.deepEqual([a.count, (a.matches ?? []).map(m => m.id)], [want.count, want.ids], `${lane} '${find}'`);
    }
});

// The readers of the family, each with the call that makes it search the old text. A reader that matches the words of a
// request with job prose (fold/normalize/tokens over a description, a note or a _why) outside these is a new reader that
// escaped the rule: the second test finds it.
const READERS = [
  { file: 'platforms/odc/facade/discovery.mjs', fn: 'scoreJob', via: 'jobSearchText' },
  { file: 'platforms/odc/facade/discovery.mjs', fn: 'relatedNotes', via: 'jobSearchText' },
  { file: 'platforms/odc/facade/discovery.mjs', fn: 'provenExample', via: 'jobSearchText' },
  { file: 'platforms/odc/facade/ssam-reference.mjs', fn: 'odcRecipe', via: 'jobSearchText' },
  { file: 'platforms/odc/facade/ssam-reference.mjs', fn: 'exampleAnswer', via: 'jobSearchText' },
  { file: 'kernel/src/Anvil.Core/Kernel/CommandSurface.cs', fn: 'Recipes', via: 'JobSearchAliases' },
  { file: 'platforms/odc/facade/ssam-reference.mjs', fn: 'rulesAnswer', via: 'alignedAliases' },
  { file: 'platforms/odc/facade/work-packet.mjs', fn: 'rulesSection', via: 'techInEnglish' },
];
// The body of a top-level function (JS `function name(` or C# `static ... Name(`), to the next top-level declaration.
function bodyOf(text, fn) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^(export )?(async )?function ${fn}\\(|^\\s{4}public static [\\w<>\\[\\], ]+ ${fn}\\(`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && (/^(export )?(async )?function |^(export )?const [A-Za-z_]+ = |^\s{4}(public|private|internal) static /.test(l)));
  if (end < 0) end = lines.length;
  // Code only: a comment that names the rule is no call to it.
  return { start, end, body: lines.slice(start, end).map(l => l.replace(/\/\/.*$/, '')).join('\n') };
}

test('search family: every reader of a request against translated text goes through the one rule', () => {
  assert.deepEqual(JOB_SEARCH_READERS.length, 6, 'the job readers declared in search-aliases.mjs');
  for (const r of READERS) {
    const found = bodyOf(fs.readFileSync(path.join(repo, r.file), 'utf8'), r.fn);
    assert.ok(found, `${r.file}: ${r.fn} is gone (update the list)`);
    assert.ok(found.body.includes(r.via), `${r.file} ${r.fn} matches without ${r.via}`);
  }
});

// A line that folds, normalizes or tokenizes a job's description, notes or _why (a note's text read from job.notes).
const JOB_PROSE_MATCH = /(fold|normalize|tokens|plainWords)\([^;]*(\b(job|j|x\.j|e)\.(description|notes|_why)\b|\bnotes\b.*\bn\.text\b)/;
test('search family: no other code folds or tokenizes job prose to match a request (a new reader would escape the rule)', () => {
  // The check sees a new reader (a planted line) and lets HTML-page text pass.
  assert.ok(JOB_PROSE_MATCH.test("const text = fold(job.name + ' ' + job.description);"));
  assert.ok(!JOB_PROSE_MATCH.test("const headers = t.all('th').map(n => fold(n.text));"));
  const dirs = ['platforms/odc/facade', 'platforms/odc/portal/runtime'];
  const files = dirs.flatMap(d => fs.readdirSync(path.join(repo, d), { recursive: true }).map(String).filter(f => f.endsWith('.mjs') && !f.includes('tests')).map(f => path.join(d, f)));
  const readers = new Set(READERS.map(r => r.file + '#' + r.fn));
  const found = [];
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(repo, rel), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!JOB_PROSE_MATCH.test(l)) return;
      // The enclosing top-level function.
      let k = i; while (k >= 0 && !/^(export )?(async )?function (\w+)\(/.test(lines[k])) k--;
      const fn = k >= 0 ? /function (\w+)\(/.exec(lines[k])[1] : '<module>';
      if (!readers.has(rel.replace(/\\/g, '/') + '#' + fn)) found.push(`${rel}:${i + 1} (${fn}) ${l.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(found, [], 'readers outside the rule:\n' + found.join('\n'));
});
