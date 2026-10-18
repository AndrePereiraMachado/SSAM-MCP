// Reprojection worklist of the compact tool listing (tool-listing.mjs, docs/CONTEXTO-FIXO.md), for the step after a
// merge that changed original tool texts. In-process ssam server (profile all, full listing) only: no Studio, no
// worker, no network, no tool call, nothing written to the repository.
//   node platforms/odc/scripts/tool-listing-reproject.mjs [--tool <name>] [--json <out.json>]
//        [--save <originals.json>] [--since <originals.json>] [--root <another checkout>]
// It prints
//  (a) every TOOL_LISTING tool whose sourceSha256 no longer matches its original text (it is then served whole), and
//      every projected tool serving an original text outside its projection (a new described parameter) or over its
//      computed byte limit;
//  (b) for each stale tool, what the guard (tool-listing-guard.mjs) would still ask if only the hash were refreshed, in
//      memory: every new sentence of the original description that needs a bound clause, every declared clause whose
//      sentence is gone, and every text or protected clause to review again, each WITH the current original text next
//      to the served one. The review hash printed is the one the guard computes; paste it only after reading both texts:
//      the hash says the texts were read, not that they mean the same.
// --save writes the original texts of every TOOL_LISTING tool; --since <file> diffs the current originals against such
// a file, sentence by sentence (+ new, - gone), so a later merge shows exactly which sentences changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Isolated profile: creating the server must never touch the user's own profile or stores.
const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-reproject-'));
const home = path.join(iso, 'home');
for (const d of [home, path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming'), path.join(iso, 'authority')]) fs.mkdirSync(d, { recursive: true });
Object.assign(process.env, { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  ANVIL_AUTHORITY_DIR: path.join(iso, 'authority'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_NO_WARM: '1', SSAM_APP_HOOK_TOOLS: '1' });
for (const k of ['SSAM_SC_RECEIPTS', 'SSAM_DESTRUCTIVE_ROOT', 'SSAM_MCP_PROFILE']) delete process.env[k];
process.on('exit', () => { try { fs.rmSync(iso, { recursive: true, force: true }); } catch { /* best effort */ } });

const argv = process.argv.slice(2);
const option = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
const only = option('--tool');

// --root reads another checkout (with its own platforms/odc/node_modules), e.g. to --save the originals of a branch head.
const root = path.resolve(option('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { InMemoryTransport } = await imp('platforms/odc/node_modules/@modelcontextprotocol/server/dist/index.mjs');
const { Client } = await imp('platforms/odc/node_modules/@modelcontextprotocol/client/dist/index.mjs');
const { createSsamServer } = await imp('platforms/odc/facade/ssam.mjs');
const L = await imp('platforms/odc/facade/tool-listing.mjs');
const G = await imp('platforms/odc/facade/tool-listing-guard.mjs');

async function listTools(deps) {
  const server = await createSsamServer({ profile: 'all', deps });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'reproject', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  try { return (await client.listTools()).tools; } finally { await client.close(); await server.close(); }
}
const full = new Map((await listTools({ listing: 'full' })).map(t => [t.name, t]));
const served = new Map((await listTools({})).map(t => [t.name, t]));

const originals = Object.fromEntries(Object.keys(L.TOOL_LISTING).filter(n => full.has(n)).map(n => [n, L.toolTexts(full.get(n))]));
if (option('--save')) { fs.writeFileSync(path.resolve(option('--save')), JSON.stringify(originals, null, 1) + '\n', 'utf8'); console.log('saved', Object.keys(originals).length, 'tools to', option('--save')); }
const since = option('--since') ? JSON.parse(fs.readFileSync(path.resolve(option('--since')), 'utf8').replace(/^﻿/, '')) : null;

// Problems the guard reports for a tool when its sourceSha256 is replaced, in memory, by the current one.
function problemsIfRefreshed(source, entry) {
  const fresh = L.toolSourceSha256(source, entry), was = entry.sourceSha256;
  Object.defineProperty(entry, 'sourceSha256', { value: fresh, writable: true, configurable: true });
  try { return L.projectTool(source); } finally { Object.defineProperty(entry, 'sourceSha256', { value: was, writable: true, configurable: true }); }
}
const sentenceDiff = (a, b) => { const A = G.sentencesOf(a ?? ''), B = G.sentencesOf(b ?? ''); return [...B.filter(s => !A.includes(s)).map(s => '+ ' + s), ...A.filter(s => !B.includes(s)).map(s => '- ' + s)]; };
const nodeAt = (schema, pointer) => pointer.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((n, k) => n?.[k], schema);

const report = { stale: [], unprojectedTexts: [], overLimit: [], fallback: [], tools: {} };
const out = [];
for (const [name, entry] of Object.entries(L.TOOL_LISTING)) {
  if (only && name !== only) continue;
  const source = full.get(name); if (!source) { out.push('== ' + name + ': not served by profile all'); continue; }
  const fresh = L.toolSourceSha256(source, entry), stale = fresh !== entry.sourceSha256;
  const texts = L.toolTexts(source), tool = { stale, sourceSha256: entry.sourceSha256, fresh };
  // Original texts outside the projection: served whole whatever the projection says.
  const outside = Object.keys(texts.params).filter(p => !(p in (entry.params ?? {})));
  const listed = served.get(name), bytes = listed ? L.toolListingBytes(listed) : null, limit = listed ? L.toolListingLimit(listed) : null;
  const overrun = (L.TOOL_LISTING_OVERRUN_BYTES ?? {})[name] ?? 0;
  tool.bytes = bytes; tool.limit = limit; tool.declaredOverrun = overrun;
  const lines = [];
  if (since?.[name]) {
    const was = since[name], diff = [];
    const d = sentenceDiff(was.description, texts.description); if (d.length) diff.push('  description', ...d.map(s => '    ' + s));
    for (const p of new Set([...Object.keys(was.params), ...Object.keys(texts.params)])) {
      if (was.params[p] === texts.params[p]) continue;
      diff.push('  ' + p + (p in was.params ? '' : ' (new)') + (p in texts.params ? '' : ' (gone)') + (p in (entry.params ?? {}) ? '' : ' (not projected)'), ...sentenceDiff(was.params[p], texts.params[p]).map(s => '    ' + s));
    }
    if (diff.length) lines.push(' originals changed since ' + option('--since') + ':', ...diff);
  }
  if (stale) {
    report.stale.push(name);
    const { problems } = problemsIfRefreshed(source, entry);
    tool.problemsIfRefreshed = problems;
    lines.push(' STALE sourceSha256 ' + entry.sourceSha256 + ' -> ' + fresh + ' (served whole until reprojected); guard problems if only the hash is refreshed: ' + problems.length);
    for (const p of problems) {
      let m;
      if ((m = /: tool sentence without a bound clause: "(.*)"$/.exec(p))) {
        const sentence = G.sentencesOf(texts.description).find(s => s.startsWith(JSON.parse('"' + m[1] + '"'))) ?? m[1];
        const kinds = Object.entries(G.TOOL_SENTENCE_KINDS).filter(([, k]) => k.detect.test(sentence)).map(([k]) => k);
        lines.push('  [new sentence: needs bound clauses carrying ' + kinds.join('/') + ']', '    ' + sentence);
      } else if ((m = /: stale tool sentence clause: "(.*)"$/.exec(p))) lines.push('  [gone sentence: remove its clause entry]', '    ' + m[1] + '...');
      else if ((m = /^(\S+?)(\/\S*)?: text not reviewed against the original \(review ([0-9a-f]+)\)$/.exec(p))) {
        const pointer = m[2] ?? 'description'; const original = pointer === 'description' ? texts.description : texts.params[pointer];
        const servedText = pointer === 'description' ? entry.description : entry.params?.[pointer];
        lines.push('  [review text ' + pointer + '] hash after reading: ' + m[3], '    original: ' + original, '    served:   ' + (servedText === null ? '(omitted)' : servedText));
      } else if ((m = /^(\S+?): description not reviewed against the original \(review ([0-9a-f]+)\)$/.exec(p))) {
        lines.push('  [review description] hash after reading: ' + m[2], '    original: ' + texts.description, '    served:   ' + entry.description);
      } else if ((m = /^(\S+?)(\/\S*): protected (\w+) clause not reviewed against the original sentence \(review ([0-9a-f]+)\)$/.exec(p))) {
        const pname = m[2].split('/').pop(); const original = texts.params[m[2]];
        const declared = L.PROTECTED_PARAMETER_CLAUSES[name]?.[m[2]]?.[m[3]];
        lines.push('  [review protected ' + m[3] + ' clause ' + m[2] + '] hash after reading: ' + m[4], ...G.protectedSentences(m[3], pname, original).map(s => '    sentence: ' + s), '    clause:   ' + (typeof declared === 'string' ? declared : declared?.clause));
      } else if ((m = /: tool sentence clause not reviewed against the original sentence \(review ([0-9a-f]+)\): "(.*)"$/.exec(p))) {
        lines.push('  [review tool clause] hash after reading: ' + m[1], '    sentence: ' + m[2] + '...');
      } else lines.push('  [problem] ' + p);
    }
  } else {
    const { projected, problems } = L.projectTool(source);
    if (projected && problems.length) { report.fallback.push(name); tool.problems = problems; lines.push(' FALLBACK: projection refused, original served (' + problems.length + ' problems)', ...problems.map(p => '  ' + p)); }
  }
  if (outside.length && !stale) {
    report.unprojectedTexts.push(...outside.map(p => name + p)); tool.outside = outside;
    lines.push(' original texts outside the projection (served whole):', ...outside.map(p => '  ' + p + ' (' + Buffer.byteLength(texts.params[p]) + ' B): ' + texts.params[p]));
  }
  if (listed && bytes > limit + overrun) { report.overLimit.push(name); lines.push(' OVER LIMIT: ' + bytes + ' B > ' + limit + ' + declared ' + overrun); }
  report.tools[name] = tool;
  if (lines.length) out.push('== ' + name, ...lines);
}
// Described parameters served at a pointer the projection lists but the schema no longer has would throw in projectTool:
// listed here for completeness.
for (const [name, entry] of Object.entries(L.TOOL_LISTING)) for (const p of Object.keys(entry.params ?? {})) if (full.has(name) && typeof nodeAt(full.get(name).inputSchema, p)?.description !== 'string') out.push('== ' + name + ': projected pointer gone: ' + p);
out.push('', 'SUMMARY stale: ' + report.stale.length + ' [' + report.stale.join(', ') + ']; fallback: ' + report.fallback.length + '; unprojected texts: ' + report.unprojectedTexts.length + '; over limit: ' + report.overLimit.length + ' [' + report.overLimit.join(', ') + ']');
console.log(out.join('\n'));
if (option('--json')) fs.writeFileSync(path.resolve(option('--json')), JSON.stringify(report, null, 1) + '\n', 'utf8');
process.exit(0);
