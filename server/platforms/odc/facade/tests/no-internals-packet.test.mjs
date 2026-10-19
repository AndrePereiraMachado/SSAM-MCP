import './fixtures/isolated-profile.mjs';
// Round 7b of fix/no-internals (review C:\t\revisoes\no-internals-7\REVISAO.md, MEDIUM 1): the patch of a packet part a licensee
// is served applies to the packet the licensee was served, with the client protocol of context-budget-packet.test.mjs (a
// text op checks its offset), and rebuilds exactly the licensee's view of the whole section (the owner's packet with the
// owner's patch applied, then shown to the licensee). The patch is read as a list: an op whose path passes through a field
// the licensee's packet leaves out goes with every op below it, and so does an op whose value the rule leaves out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exposedResult } from '../exposure.mjs';
import { findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll')) && fs.existsSync(path.join(kernel, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'));
const skip = !cliBuilt && 'the lane CLIs are not built in this checkout';
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const licensee = (value, args = {}) => exposedResult(result(value), { exposure: 'licensee', handleRoots: [], tool: 'ssam_discover', args }).structuredContent;
const shown = list => list.map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 120));

// The client protocol of the facade's own packet tests (context-budget-packet.test.mjs applyMissing), with the parent checked.
function applyMissing(kept, missing) {
  let value = structuredClone(kept);
  for (const change of missing) {
    const keys = change.path ? change.path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    let parent = value;
    for (const key of keys.slice(0, -1)) { if (parent == null) throw new Error('no parent for ' + change.op + ' ' + change.path); parent = parent[key]; }
    if (keys.length && (parent == null || typeof parent !== 'object')) throw new Error('no parent for ' + change.op + ' ' + change.path);
    const key = keys.at(-1);
    if (change.op === 'text') {
      const current = keys.length ? parent[key] : value;
      if (typeof current !== 'string' || current.length !== change.offset) throw new Error(`text offset ${change.offset} != current length ${current?.length} at ${change.path}`);
      if (keys.length) parent[key] += change.value; else value += change.value;
    } else if (!keys.length) value = structuredClone(change.value);
    else if (change.op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else parent[key] = structuredClone(change.value);
  }
  return value;
}
// One section: the licensee's packet with the licensee's patch, and the licensee's view of the whole section.
function rebuild(section, kept, missing) {
  const packet = { ok: true, schemaVersion: 'ssam-packet/1', lane: 'o11', intent: 'x', [section]: kept };
  const part = licensee({ ok: true, schemaVersion: 'ssam-packet-part/1', section, missing });
  const whole = licensee({ ...packet, [section]: applyMissing(kept, missing) })[section];
  const mine = applyMissing(licensee(packet)[section], part.missing);
  return { mine, whole, part };
}

test('a packet part\'s patch applies and rebuilds the licensee\'s whole section: lists of matched words (MEDIUM 1)', () => {
  // the case of every capabilities section of the review: a why list added empty, then its words
  const added = rebuild('capabilities', { items: [{ id: 'logic.server-action', title: 'Server action' }] }, [
    { op: 'add', path: '/items/0/why', value: [] }, { op: 'add', path: '/items/0/why/0', value: 'server action' }, { op: 'add', path: '/items/0/why/1', value: 'sum' },
    { op: 'add', path: '/items/1', value: {} }, { op: 'add', path: '/items/1/id', value: 'logic.assign' }]);
  assert.deepEqual(added.mine, added.whole);
  assert.equal(added.part.missing.some(m => /\/why/.test(m.path)), false, 'no op of the words list');
  // the case of the text section: a why list right under the section
  const text = rebuild('text', null, [{ op: 'replace', path: '', value: {} }, { op: 'add', path: '/why', value: [] }, { op: 'add', path: '/why/0', value: 'data action' }, { op: 'add', path: '/value', value: 'Fetch' }]);
  assert.deepEqual(text.mine, text.whole);
  // a words list the kept packet already had (the licensee's packet has none): a replace, an add and a remove under it
  const kept = rebuild('capabilities', { items: [{ id: 'a', why: ['crud'] }, { id: 'b', why: ['entity'] }] }, [
    { op: 'replace', path: '/items/1/why/0', value: 'screen' }, { op: 'add', path: '/items/1/why/1', value: 'list' }, { op: 'remove', path: '/items/0/why/0' }]);
  assert.deepEqual(kept.mine, kept.whole);
});

test('a packet part\'s patch leaves out a field the packet leaves out with every op below it, and reads code as code (MEDIUM 1)', () => {
  const doc = rebuild('rules', { items: [{ id: 'r1', rule: 'Fetch the related data at once.' }] }, [
    // internal fields of the documentation, built key by key as packetMissing builds them
    { op: 'add', path: '/items/0/proofs', value: [] }, { op: 'add', path: '/items/0/proofs/0', value: {} }, { op: 'add', path: '/items/0/proofs/0/job', value: 'tests/jobs/x.json' },
    { op: 'add', path: '/items/0/limits', value: [] }, { op: 'add', path: '/items/0/limits/0', value: {} }, { op: 'add', path: '/items/0/limits/0/origin', value: [] },
    { op: 'add', path: '/items/0/limits/0/origin/0', value: 'tests/jobs/x.json' }, { op: 'add', path: '/items/0/limits/0/text', value: 'Only in a server action.' },
    // a value the rule leaves out (an evidence summary that only counts the coverage)
    { op: 'add', path: '/items/0/summary', value: '12 historical, coverage 80%' },
    // a source of the index a guidance came from, an object the rule leaves out once it names its index
    { op: 'add', path: '/items/0/source', value: {} }, { op: 'add', path: '/items/0/source/index', value: 'o11' }, { op: 'add', path: '/items/0/source/builtAt', value: '2026-10-17T00:00:00Z' },
    // a level: the seal; a rule: prose
    { op: 'add', path: '/items/0/level', value: 'C-executed-historical' },
    { op: 'add', path: '/items/1', value: {} }, { op: 'add', path: '/items/1/rule', value: "The owner's decision (2026-10-09). Look the row up by its key." }]);
  assert.deepEqual(doc.mine, doc.whole);
  assert.deepEqual(shown(findings(doc.part)), []);
  // code below a code key reads as code: an example's ops keep their prose fields as the whole section does
  const code = rebuild('example', { id: 'jobs/x', ops: [] }, [
    { op: 'add', path: '/ops/0', value: {} }, { op: 'add', path: '/ops/0/op', value: 'create' }, { op: 'add', path: '/ops/0/description', value: 'Shown on the screen as is' },
    { op: 'add', path: '/ops/0/data', value: {} }, { op: 'add', path: '/ops/0/data/level', value: 'C-suite' }, { op: 'add', path: '/text', value: 'Name: Text' }]);
  assert.deepEqual(code.mine, code.whole);
});

test('a long text paged by character applies and names nothing internal, within one part and across parts (MEDIUM 1)', () => {
  const rule = 'Fetch the related data at once (written by an LLM in the cold session E of 2026-09-04, passed the first time). Look the row up by its key.';
  const pages = [rule.slice(0, 102), rule.slice(102)];
  const run = [{ op: 'replace', path: '/items/0/rule', value: '' }, { op: 'text', path: '/items/0/rule', offset: 0, value: pages[0] }, { op: 'text', path: '/items/0/rule', offset: 102, value: pages[1] }];
  // whole within one part (followed by another op): read as one text, exactly the whole section
  const whole = rebuild('rules', { items: [{ rule: 'x' }] }, [...run, { op: 'add', path: '/items/1', value: {} }]);
  assert.deepEqual(whole.mine, whole.whole);
  // its pages split over two parts: each part applies in turn and nothing internal is served
  const packet = licensee({ ok: true, schemaVersion: 'ssam-packet/1', rules: { items: [{ rule: 'x' }] } }).rules;
  const first = licensee({ ok: true, schemaVersion: 'ssam-packet-part/1', section: 'rules', missing: run.slice(0, 2) });
  const second = licensee({ ok: true, schemaVersion: 'ssam-packet-part/1', section: 'rules', missing: run.slice(2) });
  const rebuilt = applyMissing(applyMissing(packet, first.missing), second.missing);
  assert.deepEqual(shown(findings({ first, second, rebuilt })), []);
  assert.match(rebuilt.items[0].rule, /^Fetch the related data at once\b.*Look the row up by its key\.\s*$/s);
});

// ---- B1 of the review: the capabilities section of a packet names no CLI form and no internal origin, inline or in a patch
// (a capability's operation is the route's text of how to call it; a limit is prose, also when the packet wrote it as the
// JSON of {text, origin}: work-packet.mjs capabilitiesSection)
const flagsIn = text => [...String(text).matchAll(/(?<![\w-]|var\()--[a-z][a-z0-9-]*(?![\w-]*\s*:)/g)].map(m => m[0]);
const allStrings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) allStrings(x, out); return out; };
test('a capability\'s operation and limits in a packet name no CLI form and no internal origin, inline and in its patch (B1)', () => {
  const items = [{ id: 'ui.html-visual', title: 'Fragment', operation: '{"op":"html","parent":"<widget ref>","file":"fragment.html"}  (api --op html-visual)',
    limits: ['{"text":"The parent must be inside an IMobileScreen or IMobileBlock; the fragment never creates logic, data or variables.","origin":"kernel/src/Anvil.Core/Kernel/HtmlVisual.cs:602-628"}',
      '{"text":"A button\'s caption lives inside IContent (search looks in IContent too).","origin":"kernel/docs/NAO-DA.md \'Legenda d…(+33)',
      'odc_write is not registered while every tenant has policyFile=null; its MCP schema has no authorization field (the CLI requires --authorize); no reconciliation tool exists for a write.'] },
  { id: 'data.records', title: 'Records', operation: 'ODC: odc studio data <Module> <Entity> [--limit N]; data-insert|data-update --records-file <journal/data/requests/x.json> --authorize "<words>"; data-delete --ids ... --authorize / MCP studio_data*' }];
  const packet = licensee({ ok: true, schemaVersion: 'ssam-packet/1', capabilities: { items } });
  const part = licensee({ ok: true, schemaVersion: 'ssam-packet-part/1', section: 'capabilities', missing: [
    { op: 'add', path: '/items/2', value: {} }, { op: 'add', path: '/items/2/operation', value: items[0].operation },
    { op: 'add', path: '/items/2/limits', value: [] }, { op: 'add', path: '/items/2/limits/0', value: items[0].limits[0] }, { op: 'add', path: '/items/2/limits/1', value: items[0].limits[2] }] });
  for (const [label, value] of [['packet', packet], ['part', part]]) {
    assert.deepEqual(shown(findings(value)), [], label);
    assert.deepEqual(allStrings(value).flatMap(flagsIn), [], label);
  }
  assert.equal(packet.capabilities.items[0].limits[0], 'The parent must be inside an IMobileScreen or IMobileBlock; the fragment never creates logic, data or variables.', 'a limit reads as its text');
  assert.match(packet.capabilities.items[0].limits[1], /^A button's caption lives inside IContent \(search looks in IContent too\)\.?$/);
  assert.match(packet.capabilities.items[0].limits[2], /^odc_write is not registered while every tenant has policyFile=null; its MCP schema has no authorization field; no reconciliation tool exists for a write\.$/);
  assert.match(packet.capabilities.items[0].operation, /^\{"op":"html","parent":"<widget ref>","file":"fragment\.html"\}/, 'the op form stays');
  assert.match(packet.capabilities.items[1].operation, /MCP studio_data\*$/);
  // and the patch still rebuilds the whole section
  const whole = licensee({ ok: true, schemaVersion: 'ssam-packet/1', capabilities: { items: [...items, items[0]].map((item, i) => (i === 2 ? { operation: item.operation, limits: [item.limits[0], item.limits[2]] } : item)) } }).capabilities;
  assert.deepEqual(applyMissing(packet.capabilities, part.missing), whole);
});

// ---- live: the protocol of the review's probe (probes\packet.mjs) on intents of both lanes and three budgets
test('live: every section of a packet a licensee is served applies its parts and equals the licensee\'s whole section (MEDIUM 1)', { skip, timeout: 900000 }, async () => {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ profile: 'all', deps: { exposure: { profile: 'owner' } } });
  const client = new Client({ name: 'no-internals-packet', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => {
    let r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    for (let i = 0; i < 240 && r.structuredContent?.state === 'running'; i++) { await new Promise(z => setTimeout(z, 250)); r = await client.callTool({ name: r.structuredContent.continuation.tool, arguments: r.structuredContent.continuation.arguments }, undefined, { timeout: 600000 }); }
    return r;
  };
  const shownTo = (r, args) => exposedResult(r, { exposure: 'licensee', handleRoots: [], tool: 'ssam_discover', args }).structuredContent;
  const cases = [['o11', 'create a server action that sums two integers', [8192]], ['o11', 'create an entity Customer with name and email and its CRUD actions', [8192, 12000]],
    ['o11', 'expose a REST API', [8192]], ['odc', 'add a data action to a screen', [8192, 20000]], ['odc', 'create a reactive screen with a table of orders', [12000]],
    ['odc', 'port an approved prototype screen 1:1 with the html op and its style in the theme', [8192]]];
  const problems = []; let sections = 0;
  try {
    for (const [lane, intent, budgets] of cases) for (const budgetBytes of budgets) {
      const args = { lane, intent, packet: true, budgetBytes };
      const r = await call('ssam_discover', args); const packet = r.structuredContent;
      if (!packet || packet.ok === false || !Array.isArray(packet.cuts)) { problems.push(intent + ' ' + budgetBytes + ': no packet ' + (packet?.code ?? '')); continue; }
      const owner = {}, mine = {};
      for (const cut of packet.cuts) {
        const pr = await call('ssam_discover', cut.recover.arguments);
        assert.equal(pr.structuredContent?.ok, true, JSON.stringify(pr.structuredContent).slice(0, 200));
        (owner[cut.section] ??= []).push(...pr.structuredContent.missing);
        (mine[cut.section] ??= []).push(...(shownTo(pr, cut.recover.arguments).missing ?? []));
      }
      const view = shownTo(r, args);
      const full = structuredClone(packet); for (const [section, missing] of Object.entries(owner)) full[section] = applyMissing(packet[section], missing);
      full.cuts = [];
      const whole = shownTo(result(full), args);
      for (const section of Object.keys(owner)) {
        sections++;
        try { assert.deepEqual(applyMissing(view[section], mine[section]), whole[section]); }
        catch (error) { problems.push(lane + ' ' + intent.slice(0, 40) + ' ' + budgetBytes + ' ' + section + ': ' + String(error.message).split('\n')[0].slice(0, 200)); }
      }
    }
  } finally { await client.close(); await server.close(); }
  assert.ok(sections >= 10, 'sections read: ' + sections);
  assert.deepEqual(problems, []);
});

test('live: the packets and parts the review swept name no CLI form and no internal origin (B1)', { skip, timeout: 900000 }, async () => {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ profile: 'all', deps: { exposure: { profile: 'licensee', caller: () => 'packet-b1-' + process.pid + '-' + Date.now(), dayBytes: 500 * 1024 * 1024 } } });
  const client = new Client({ name: 'no-internals-packet-b1', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => {
    let r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    for (let i = 0; i < 240 && r.structuredContent?.state === 'running'; i++) { await new Promise(z => setTimeout(z, 250)); r = await client.callTool({ name: r.structuredContent.continuation.tool, arguments: r.structuredContent.continuation.arguments }, undefined, { timeout: 600000 }); }
    return r.structuredContent;
  };
  const problems = [];
  try {
    for (const [lane, intent] of [['o11', 'expose a REST API'], ['o11', 'create a static entity with records'], ['o11', 'add a role and check it in a screen'],
      ['odc', 'add a data action to a screen'], ['odc', 'add a server action that calls a REST API']]) {
      const packet = await call('ssam_discover', { lane, intent, limit: 8, packet: true });
      const parts = [];
      for (const cut of packet.cuts ?? []) parts.push(await call('ssam_discover', cut.recover.arguments));
      for (const [label, value] of [['packet', packet], ...parts.map((p, i) => ['part ' + i, p])]) {
        for (const f of shown(findings(value))) problems.push(intent + ' ' + label + ' ' + f);
        for (const flag of allStrings(value).flatMap(flagsIn)) problems.push(intent + ' ' + label + ' flag ' + flag);
      }
    }
  } finally { await client.close(); await server.close(); }
  assert.deepEqual(problems, []);
});