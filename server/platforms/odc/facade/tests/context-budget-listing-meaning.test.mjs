import './fixtures/isolated-profile.mjs';
// CX11 correção 3: the compact listing keeps the MEANING of every rule, not only a carrier word (revisão 3, N7-N9).
// Every scenario edits the reviewed tables in memory only, serves the tool through listedTool (what tools/list uses) and
// restores the tables. Synthetic values only; nothing here reads or stores a credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import * as L from '../tool-listing.mjs';
import * as G from '../tool-listing-guard.mjs';
async function listing(t, deps = {}, profile = 'all') {
 const server = await createSsamServer({ profile, deps }); const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'listing-meaning', version: '1' });
 await Promise.all([server.connect(a), client.connect(b)]); t.after(async () => { await client.close(); await server.close(); });
 return (await client.listTools()).tools;
}
const tables = name => ({ omissions: L.TOOL_PARAMETER_OMISSIONS[name] ?? {}, parameterClauses: L.PROTECTED_PARAMETER_CLAUSES[name] ?? {}, toolClauses: L.PROTECTED_TOOL_CLAUSES?.[name] ?? [], requiredToolClauses: L.REQUIRED_TOOL_CLAUSES?.[name] ?? [], shortened: L.SHORTENED_PARAMETER_EVIDENCE?.[name] ?? {}, reviews: L.TOOL_LISTING_REVIEWS?.[name] ?? {} });
const clauseText = c => typeof c === 'string' ? c : c?.clause;
const setClause = (pc, pointer, kind, text) => { pc[pointer] = { ...(pc[pointer] ?? {}) }; const old = pc[pointer][kind]; pc[pointer][kind] = old && typeof old === 'object' ? { ...old, clause: text } : text; };
// Snapshot every mutable table of one tool, apply an edit, serve it, restore.
function served(full, name, edit) {
 const entry = L.TOOL_LISTING[name], om = L.TOOL_PARAMETER_OMISSIONS[name], pcs = L.PROTECTED_PARAMETER_CLAUSES;
 const saved = { d: entry.description, p: { ...entry.params }, om: om && { ...om }, pc: pcs[name] && { ...pcs[name] } };
 try {
  const changed = edit(entry, om, pcs[name]);
  const source = full.find(t => t.name === name), out = L.listedTool(source);
  return { changed, refused: out === source, out, source };
 } finally {
  entry.description = saved.d; for (const k of Object.keys(entry.params)) entry.params[k] = saved.p[k];
  if (om) { for (const k of Object.keys(om)) delete om[k]; Object.assign(om, saved.om); }
  if (pcs[name]) { for (const k of Object.keys(pcs[name])) delete pcs[name][k]; Object.assign(pcs[name], saved.pc); }
 }
}
test('N7 a weakened or inverted protected clause is refused and the original is served (S1-S5, M1, M3)', async t => {
 const full = await listing(t, { listing: 'full' });
 const scenarios = {
  // S1: credentialTarget keeps a carrier word (its own name) but loses "never a credential".
  S1: (e, om, pc) => { const now = clauseText(pc['/properties/credentialTarget'].credential), weak = 'credentialTarget:only names, never prompts';
   e.description = e.description.replace(now, weak); om['/properties/credentialTarget'] = { reason: 'stated-in-tool-text', evidence: [weak] }; setClause(pc, '/properties/credentialTarget', 'credential', weak); return e.description.includes(weak); },
  // S2: the authorization context is said to REPLACE the words (original: words stays the exact human response).
  S2: (e, om, pc) => { e.params['/properties/authorizationContext'] = 'Absolute ssam-authorization-context/1 record for deletion; replaces words.';
   setClause(pc, '/properties/authorizationContext', 'destructive', 'for deletion'); setClause(pc, '/properties/authorizationContext', 'authorization', 'replaces words'); return true; },
  S3: (e, om, pc) => { e.params['/properties/replace'] = 'create-module: replace flag.'; setClause(pc, '/properties/replace', 'destructive', 'replace flag'); return true; },
  // S4: a default value changes (20 -> 200) while the evidence keeps "=".
  S4: (e, om) => { const weak = 'applicationLimit/moduleLimit/maxPages=200'; const before = e.description; e.description = e.description.replace('applicationLimit/moduleLimit/maxPages=20', weak);
   for (const p of ['/properties/applicationLimit', '/properties/moduleLimit', '/properties/maxPages']) om[p] = { reason: 'stated-in-tool-text', evidence: [weak] }; return e.description !== before; },
  // S5: authorize loses "absent: standing grant, else nothing runs" and says optional.
  S5: (e, om, pc) => { e.params['/properties/authorize'] = 'Verbatim user words, optional.'; setClause(pc, '/properties/authorize', 'authorization', 'Verbatim user words'); return true; },
  // M1: the credential rule of parameters is inverted.
  M1: (e, om, pc) => { const now = clauseText(pc['/properties/parameters'].credential), weak = 'parameters:form labels incl. user/password, never empty';
   e.description = e.description.replace(now, weak); om['/properties/parameters'] = { reason: 'stated-in-tool-text', evidence: [weak] }; setClause(pc, '/properties/parameters', 'credential', weak); return e.description.includes(weak); },
  // M3: credentialTarget may now carry the credential itself.
  M3: (e, om, pc) => { const now = clauseText(pc['/properties/credentialTarget'].credential), weak = 'credentialTarget:vault target name or the credential itself, only never empty';
   e.description = e.description.replace(now, weak); om['/properties/credentialTarget'] = { reason: 'stated-in-tool-text', evidence: [weak] }; setClause(pc, '/properties/credentialTarget', 'credential', weak); return e.description.includes(weak); },
 };
 const tool = { S1: 'o11_service_center_read', S2: 'o11_service_center_write', S3: 'o11_environment', S4: 'o11_service_center_read', S5: 'o11_deliver', M1: 'o11_service_center_write', M3: 'o11_service_center_read' };
 const served_ = Object.entries(scenarios).map(([id, edit]) => { const r = served(full, tool[id], edit); assert.ok(r.changed, id + ' edit applied'); return [id, r.refused]; });
 assert.deepEqual(served_.filter(([, refused]) => !refused).map(([id]) => id), [], 'weakened clauses served as projections');
 // The current tables are served as projections (no scenario leaked into them).
 for (const name of new Set(Object.values(tool))) assert.notEqual(L.listedTool(full.find(t => t.name === name)), full.find(t => t.name === name), name);
});
test('N7 tool clauses come from the sentences of the original description: removing one is refused (S6)', async t => {
 const full = await listing(t, { listing: 'full' });
 const r = served(full, 'o11_access', e => { const before = e.description; e.description = e.description.replace(/ ?Never publishes or creates accounts\./, ''); return e.description !== before; });
 assert.ok(r.changed, 'S6 edit applied'); assert.ok(r.refused, 'S6: o11_access without "Never publishes or creates accounts" must not be served');
 // The original's "never a password or hash" (users read) is served again.
 const access = L.listedTool(full.find(t => t.name === 'o11_access'));
 assert.notEqual(access, full.find(t => t.name === 'o11_access'));
 assert.match(access.description, /never a password or hash/);
 // Every original sentence with credential/secret/password, delete, authorization, never or only-when has a bound clause.
 for (const tool of full) { if (!L.TOOL_LISTING[tool.name]) continue; const { problems } = L.projectTool(tool); assert.deepEqual(problems.filter(p => /tool sentence|tool clause/.test(p)), [], tool.name); }
});
test('N8 odc_external_db_connection.credential is served with its meaning and the guard sees it', async t => {
 const full = await listing(t, { listing: 'full' }), short = await listing(t, {}, 'app');
 const f = full.find(x => x.name === 'odc_external_db_connection'), s = short.find(x => x.name === 'odc_external_db_connection');
 const text = s.inputSchema.properties.credential.description ?? '';
 assert.match(text, /SSAM\/ODC3\/<tenant>\/DB\/<credential>/); assert.match(text, /default: connection name/); assert.match(text, /never the account or password/);
 // The three mutations of revisão 3 (verify-3/n8.mjs) are problems.
 // (the served sentence is "Secrets:vault+native secretRefs" plus whatever it keeps; the mutations remove or invert it)
 const m1 = structuredClone(s); m1.description = s.description.replace(/ ?Secrets:vault\+native secretRefs[^.]*\./, ''); assert.notEqual(m1.description, s.description);
 const m2 = structuredClone(s); m2.description = s.description.replace(/Secrets:vault\+native secretRefs[^.]*\./, 'credential: the database password.'); assert.notEqual(m2.description, s.description);
 const m3 = structuredClone(s); m3.inputSchema.properties.credential.description = 'Database password typed by the user.';
 for (const [id, m] of Object.entries({ m1, m2, m3 })) assert.ok(G.projectionProblems(f, m, tables(f.name)).length > 0, id + ' must be a problem');
 // A credential-named parameter served without its own text and not named by the tool text is a problem in any tool.
 const bare = structuredClone(s); delete bare.inputSchema.properties.credential.description;
 assert.ok(G.projectionProblems(f, bare, tables(f.name)).some(p => /credential/.test(p)), 'bare credential parameter');
});
test('N9 every projected parameter text keeps the rule kinds of its original, not only omissions', async t => {
 const full = await listing(t, { listing: 'full' }), short = await listing(t);
 const byName = new Map(short.map(x => [x.name, x]));
 const p = (name, key) => byName.get(name).inputSchema.properties[key].description;
 assert.match(p('ssam_evidence', 'max'), /default 50/); assert.match(p('ssam_evidence', 'max'), /0 = only the total/);
 assert.match(p('ssam_evidence', 'budgetBytes'), /default 2000/);
 assert.match(p('o11_access', 'max'), /default 20/); assert.match(p('o11_access', 'max'), /up to 100/);
 assert.match(p('ssam_job', 'lane'), /o11 \(default\)/);
 for (const name of ['odc_deploy', 'odc_asset_delete', 'odc_write', 'odc_configurations']) { assert.match(p(name, 'auth'), /no prompt/, name); assert.match(p(name, 'auth'), /api-client: vault API Client only/, name); }
 // The guard itself judges shortened texts: dropping a default from a shortened text is a problem.
 const f = full.find(x => x.name === 'ssam_evidence'), weak = structuredClone(byName.get('ssam_evidence')); weak.inputSchema.properties.max.description = 'Maximum list items.';
 assert.ok(G.projectionProblems(f, weak, tables('ssam_evidence')).some(x => /max/.test(x)), 'shortened text losing its default');
 // And no served projected text loses a rule kind anywhere.
 const problems = []; for (const tool of short) { const o = full.find(x => x.name === tool.name); if (L.TOOL_LISTING[tool.name]) problems.push(...G.projectionProblems(o, tool, tables(tool.name))); }
 assert.deepEqual(problems, []);
});
test('N12 inverted shortened texts and swapped defaults are refused and the original is served (D1-D6)', async t => {
 const full = await listing(t, { listing: 'full' });
 const D5 = 'auto: Studio then compatible vault; missing: private prompt, no refusal; api-client: vault API Client only.';
 const cases = [
  ['D1', 'ssam_evidence', '/properties/max', 'Items per page, at most 50; 0 = only the total.'],
  ['D2', 'o11_access', '/properties/max', 'users only: at most 20; default 100.'],
  ['D3', 'o11_data', '/properties/request/anyOf/0/properties/limit', 'read-all: at most 2000 rows per call, default 50; follow continuation.offset.'],
  ['D4', 'ssam_job', '/properties/lane', 'odc (default) or o11.'],
  ...['odc_write', 'odc_deploy', 'odc_configurations', 'odc_asset_delete'].map(name => ['D5', name, '/properties/auth', D5]),
  ['D6', 'o11_service_center_read', '/properties/eventAuth', 'timer-events: Basic or vault token; only fallback to the Studio session.'],
 ];
 const leaked = [];
 for (const [id, name, pointer, text] of cases) {
  const r = served(full, name, e => { const before = e.params[pointer]; e.params[pointer] = text; return before !== text; });
  assert.ok(r.changed, id + ' ' + name + ' edit applied');
  if (!r.refused) leaked.push(id + ' ' + name);
 }
 assert.deepEqual(leaked, [], 'inverted texts served as projections');
 // A default is bound to its value: a loose "=" or the same number as a cap does not carry it.
 const original = (name, pointer) => L.toolTexts(full.find(x => x.name === name)).params[pointer];
 for (const [id, name, pointer, text] of cases.slice(0, 4)) assert.equal(G.carries('default', original(name, pointer), text, pointer.split('/').pop()), false, id + ' default carried by ' + JSON.stringify(text));
 // The served projections themselves keep their defaults (no review or default problem anywhere).
 for (const name of ['ssam_evidence', 'o11_access', 'o11_data', 'ssam_job', 'odc_write', 'o11_service_center_read']) assert.deepEqual(L.projectTool(full.find(x => x.name === name)).problems, [], name);
});
