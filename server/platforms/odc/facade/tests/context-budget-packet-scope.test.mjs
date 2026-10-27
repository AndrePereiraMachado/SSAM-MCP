// R4 (2026-10-24), the packet that is enough: ten requests of the kinds measured 11..24/10/2026 (18 reads, p50, before an
// accepted delivery), over the Pedidos module of fixtures/packet-scope. For each, the packet of ssam_discover {packet:true}
// answers "which names may I use" (scope, every name with the @key the digest gives it) and "which basedOn goes where"
// (scope.basedOn and the ready calls, with the reading's own values) without another call, within the budget; the bytes,
// needsReading and what was left in next are measured and printed as a table (t.diagnostic).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workPacket, PACKET_BUDGET, WORK_RULE } from '../work-packet.mjs';
import { packetScope, readingNeed, htmlNames, flowNames, ownerTargets, SCOPE_SCHEMA, TEXT_SHA } from '../packet-scope.mjs';
import { PACKET_DEFAULT_BYTES } from '../context-budget.mjs';
import { wellFormedDigest } from '../module-digest.mjs';
import { laneSources } from '../discovery.mjs';
import { discoverAll } from '../tool-routing.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';
import { found, digest, FILE, SOURCE_SHA, FLOW_READING, HTML_READING, ownerReader } from './fixtures/packet-scope/module.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INTENTS = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'packet-scope', 'intents.json'), 'utf8')).intents;
const bytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');

// Every name the scope answers, with the key it gives (owner, groups, names only, attributes, fields, methods, widgets).
export function scopeNames(scope) {
  const out = new Map();
  const add = (name, key) => { if (name && !out.has(name)) out.set(name, key ?? null); };
  if (!scope) return out;
  const o = scope.owner;
  if (o) {
    add(o.name, o.key);
    for (const g of ['inputs', 'locals', 'aggregates', 'actions', 'widgets']) for (const [n, v] of Object.entries(o[g] ?? {})) add(n.replace(/\?$/, ''), typeof v === 'string' ? v : v?.key ?? v?.k ?? null);
    for (const g of ['inputs', 'outputs', 'locals', 'nodes']) for (const n of Object.keys(o.flow?.[g] ?? {})) add(n.replace(/\?$/, ''));
  }
  for (const g of ['entities', 'staticEntities', 'structures', 'variables', 'exceptions', 'actions', 'screens', 'integrations', 'timers', 'roles', 'references']) {
    for (const [n, v] of Object.entries(scope[g] ?? {})) {
      add(n, typeof v === 'string' ? v.split(' ')[0] : v.key);
      for (const sub of ['attrs', 'fields', 'methods']) for (const [a, k] of Object.entries(v?.[sub] ?? {})) add(a, typeof k === 'string' && k.startsWith('@') ? k : null);
      for (const r of v?.records ?? []) add(r);
      for (const [k, list] of Object.entries(v ?? {})) if (Array.isArray(list) && k !== 'records') for (const n2 of list) add(n2);
    }
    for (const [n, k] of Object.entries(scope.namesOnly?.[g] ?? {})) add(n, k);
  }
  return out;
}
// The keys of the digest by element name (blocks and actions): a key the scope gives must be one of them.
const digestKeys = () => {
  const d = digest(); const keys = new Map();
  for (const s of d.sections) for (const b of s.blocks) keys.set(b.name, '@' + b.key);
  for (const a of d.actions) keys.set(a.name, '@' + a.key);
  return keys;
};
// The basedOn values a packet's ready calls carry for logic and html (next.deliver and text.call).
function callBasedOns(packet) {
  const out = { logic: [], html: [] };
  const deliver = packet.next?.deliver?.arguments;
  if (deliver?.part === 'logic' && deliver.basedOn != null) out.logic.push(...[].concat(deliver.basedOn));
  if (deliver?.part === 'html' && deliver.basedOn != null) out.html.push(deliver.basedOn);
  for (const op of packet.text?.call?.arguments?.job?.ops ?? []) {
    if (op.op === 'logic') for (const f of op.data?.flow ?? []) if (f && typeof f === 'object' && f.basedOn != null) out.logic.push(f.basedOn);
    if (op.op === 'html' && op.data?.basedOn) out.html.push(op.data.basedOn);
  }
  return out;
}

test('the fixture module is a well-formed digest; its scope names every element with the digest key, the owner from its reading', () => {
  assert.equal(wellFormedDigest(digest(), 'o11'), true);
  const rank = new Map([['Pedido_Create', 100], ['Pedido_Validate', 50], ['PedidoDados', 50]]);
  const scope = packetScope(found(), { lane: 'o11', rank, readings: [FLOW_READING], forms: ['ssam-flow/1'], creating: false });
  assert.equal(scope.schema, SCOPE_SCHEMA); assert.equal(scope.sourceSha256, SOURCE_SHA);
  assert.equal(scope.owner.name, 'Pedido_Create'); assert.equal(scope.owner.key, '@A1');
  assert.equal(scope.owner.flow.textSha, FLOW_READING.textSha); assert.equal(scope.owner.flow.text, FLOW_READING.text);
  assert.deepEqual(Object.keys(scope.owner.flow.nodes), ['Pedido_Validate', 'CreatePedido']);
  assert.deepEqual(scope.entities.Pedido, { key: '@E1', attrs: { Id: 'Long Integer', ClienteId: 'Cliente Identifier', StatusPedidoId: 'StatusPedido Identifier', Total: 'Decimal(18,2)', CriadoEm: 'Date Time' } });
  assert.deepEqual(scope.staticEntities.StatusPedido.records, ['Aberto', 'Cancelado', 'Fechado']);
  assert.deepEqual(scope.variables.MaxItensPorPedido, { key: '@V1', kind: 'site property', type: 'Integer' });
  assert.deepEqual(scope.integrations.ViaCep.methods, { ConsultarCep: '@I1a' });
  const keys = digestKeys();
  for (const g of ['entities', 'staticEntities', 'structures', 'variables', 'exceptions', 'actions', 'integrations', 'timers', 'roles'])
    for (const [n, v] of Object.entries(scope[g] ?? {})) assert.equal(typeof v === 'string' ? v.split(' ')[0] : v.key, keys.get(n), g + ' ' + n);
  // The flow basedOn is the textSha (16 hex) in its field, never the capture sha256.
  const flow = scope.basedOn.find(b => b.form === 'ssam-flow/1');
  assert.equal(flow.value, FLOW_READING.textSha); assert.match(flow.value, TEXT_SHA); assert.match(flow.rule, /never the capture sourceSha256/);
  assert.deepEqual(readingNeed(scope, { forms: ['ssam-flow/1'], creating: false }).needsReading, false);
  // Without the reading the text is one read away, named in next, and needsReading says so.
  const bare = packetScope(found(), { lane: 'o11', rank, forms: ['ssam-flow/1'], creating: false });
  assert.equal(bare.basedOn.find(b => b.form === 'ssam-flow/1').value, null);
  assert.deepEqual(bare.next[0].call, { tool: 'ssam_map', arguments: { lane: 'o11', target: FILE, expectedSourceSha256: SOURCE_SHA, view: 'flow', element: 'Pedido_Create' } });
  assert.equal(readingNeed(bare, { forms: ['ssam-flow/1'], creating: false }).needsReading, true);
  // The html reading: every element with its k, and its {capture, html}.
  const names = htmlNames(HTML_READING.html);
  assert.deepEqual(names.widgets.BuscarButton, { k: 'w6', tag: 'button' });
  assert.deepEqual(names.locals.SearchText, { k: 'w1', type: 'Text' }); assert.deepEqual(names.aggregates.GetPedidos, { k: 'w3', from: 'Pedido' });
  assert.deepEqual(flowNames(FLOW_READING.text).inputs, { Pedido: 'PedidoDados' });
  assert.deepEqual(ownerTargets(found(), new Map([['PedidoLista', 100]]), { forms: ['ssam-html/1'], screenEdit: true }), [{ kind: 'html', name: 'PedidoLista', key: 'S1' }]);
});

test('a small cap keeps the owner and the named first, the rest by name only, and next labels what is left with its call', () => {
  const rank = new Map([['Pedido', 100], ['Cliente', 50]]);
  const scope = packetScope(found(), { lane: 'o11', rank, forms: ['ssam-flow/1'], creating: true }, 1600);
  assert.ok(bytes(scope) <= 1600, String(bytes(scope)));
  assert.ok(scope.entities?.Pedido, 'the entity the intent names');
  const named = scopeNames(scope);
  const left = (scope.next ?? []).map(n => n.label).join('; ');
  assert.ok(named.size > 5, 'names only fill the room');
  assert.ok(!scope.next || scope.next.every(n => (n.call ?? scope.map).tool === 'ssam_map' && (n.call ?? scope.map).arguments.expectedSourceSha256 === SOURCE_SHA), left);
  // Everything is either named or counted in next: nothing is dropped in silence.
  const d = digest(); const total = d.sections.filter(s => !['module', 'coverage'].includes(s.id)).reduce((n, s) => n + (s.id === 'actions' ? 0 : s.blocks.length), 0) + d.actions.length
    + d.sections[0].blocks.filter(b => b.kind === 'Reference').length;
  const counted = (scope.next ?? []).reduce((n, x) => n + [...x.label.matchAll(/(\d+) [a-zA-Z]+/g)].reduce((m, y) => m + Number(y[1]), 0), 0);
  const groups = ['entities', 'staticEntities', 'structures', 'variables', 'exceptions', 'actions', 'screens', 'integrations', 'timers', 'roles', 'references'];
  const shown = groups.reduce((n, g) => n + Object.keys(scope[g] ?? {}).length + Object.keys(scope.namesOnly?.[g] ?? {}).length, 0);
  assert.equal(shown + counted, total, 'shown ' + shown + ' + left ' + counted);
});

const cliSkip = !fs.existsSync(laneSources('o11').cli) && 'the o11 CLI is not built';
let sources = null;
const sourcesOf = () => (sources ??= snapshotSources('o11', { cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'packet-scope-')) }));
test('ten real requests: the packet names what each may use and puts every basedOn in its place, within the budget (the R4 table)', { skip: cliSkip, timeout: 900000 }, async t => {
  const keys = digestKeys();
  const rows = [];
  // 8 KB (the default until 24/10/2026, still a budget an agent may ask), the default and the ceiling.
  for (const row of INTENTS) for (const budgetBytes of [...new Set([8192, PACKET_DEFAULT_BYTES, PACKET_BUDGET])]) {
    const calls = [];
    const packet = await discoverAll({ lane: 'o11', intent: row.intent, app: FILE, packet: true, budgetBytes, sources: sourcesOf(), digest: async () => found(), owner: ownerReader(calls), producerCache: null });
    assert.equal(packet.ok, true, row.id + ': ' + JSON.stringify(packet).slice(0, 400));
    assert.ok(bytes(packet) <= budgetBytes, row.id + ' ' + bytes(packet) + ' > ' + budgetBytes);
    assert.equal(packet.next.work, WORK_RULE, 'the rounds line');
    assert.equal(typeof packet.needsReading, 'boolean', row.id);
    if (packet.needsReading) assert.ok(packet.readingWhy && packet.read?.tool, row.id + ': a read with its why');
    // "Which names may I use": every name the change uses is in the scope (or the owner), with the digest's key.
    const names = scopeNames(packet.scope);
    const missing = row.names.filter(n => !names.has(n));
    assert.deepEqual(missing, [], row.id + ' at ' + budgetBytes + ': names not in the scope (left: ' + (packet.scope?.next ?? []).map(n => n.label).join('; ') + ')');
    for (const [n, k] of names) if (k && keys.has(n) && String(k).startsWith('@')) assert.equal(k, keys.get(n), row.id + ': the key of ' + n);
    // "Which basedOn goes where": the reading's own value, in the scope and in the ready calls; a flow basedOn never 64 hex.
    const based = callBasedOns(packet);
    for (const v of based.logic) assert.ok(TEXT_SHA.test(v) || /^<action\.textSha/.test(v), row.id + ': flow basedOn ' + v);
    for (const e of row.edits) {
      assert.ok(calls.some(c => c.targets.some(x => x.kind === e.kind && x.name === e.name)), row.id + ': the packet read ' + e.name);
      const entry = packet.scope.basedOn.find(b => b.form === (e.kind === 'flow' ? 'ssam-flow/1' : 'ssam-html/1') && b.for === e.name);
      assert.ok(entry, row.id + ': basedOn of ' + e.name + ' in scope');
      // A ready call that writes the form carries the value; otherwise (an exception op without text route, a data route that
      // also shows the attribute on a screen) the scope names the field it goes in.
      const writes = part => packet.next.deliver.arguments?.part === part || (packet.text?.call?.arguments?.job?.ops ?? []).some(op => op.op === (part === 'logic' ? 'logic' : 'html'));
      if (e.kind === 'flow') { assert.equal(entry.value, FLOW_READING.textSha); if (writes('logic')) assert.ok(based.logic.includes(FLOW_READING.textSha), row.id + ': textSha in the call'); else assert.ok(entry.field.includes('job.ops[logic].data.flow[i].basedOn'), entry.field); }
      else { assert.deepEqual(entry.value, HTML_READING.basedOn); if (writes('html')) assert.ok(based.html.some(b => JSON.stringify(b) === JSON.stringify(HTML_READING.basedOn)), row.id + ': {capture, html} in the call'); else assert.ok(entry.field.includes('job.ops[html].data.basedOn'), entry.field); }
    }
    if (budgetBytes === PACKET_BUDGET) assert.equal(packet.needsReading, false, row.id + ' at the ceiling needs no read: ' + packet.readingWhy);
    rows.push({ id: row.id, budget: budgetBytes, bytes: packet.size.bytes, scope: bytes(packet.scope), needsReading: packet.needsReading,
      owner: packet.scope?.owner ? packet.scope.owner.name + (packet.scope.owner.flow?.text || packet.scope.owner.html?.text ? ' (text)' : '') : '-',
      next: (packet.scope?.next ?? []).map(n => n.label).join('; ') || '-', why: packet.readingWhy });
  }
  t.diagnostic('R4 table\n' + ['id | budget | bytes | scope bytes | needsReading | owner | scope.next', ...rows.map(r => [r.id, r.budget, r.bytes, r.scope, r.needsReading, r.owner, r.next].join(' | '))].join('\n'));
  fs.writeFileSync(path.join(os.tmpdir(), 'ssam-r4-packet-table.json'), JSON.stringify(rows, null, 1));
});
