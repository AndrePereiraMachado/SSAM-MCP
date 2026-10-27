import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { workPacket, packetMissing, packetRecovery, nextSection, moduleSection, capabilitiesSection, exampleSection, rulesSection, TEXT_SHARE, PACKET_BUDGET } from '../work-packet.mjs';
import { PACKET_DEFAULT_BYTES } from '../context-budget.mjs';
import { createSsamServer } from '../ssam.mjs';
import { createReplay } from './answer-replay.mjs';
import { discoverAll } from '../tool-routing.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';

const bytes = v => Buffer.byteLength(JSON.stringify(v));
const decode = r => r.structuredContent ?? JSON.parse(r.content[0].text);
function applyMissing(kept, missing) {
  let value = structuredClone(kept);
  for (const change of missing) {
    const keys = change.path ? change.path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    let parent = value;
    for (const key of keys.slice(0, -1)) parent = parent[key];
    const key = keys.at(-1);
    if (change.op === 'text') {
      const current = keys.length ? parent[key] : value;
      assert.equal(current.length, change.offset);
      if (keys.length) parent[key] += change.value; else value += change.value;
    } else if (!keys.length) value = structuredClone(change.value);
    else if (change.op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else parent[key] = structuredClone(change.value);
  }
  return value;
}
const inputOf = lane => {
  const matches = Array.from({ length: 14 }, (_, i) => ({ id: 'logic.action' + i, title: 'Action ' + i, via: 'match', category: 'logic', score: 8,
    contract: ['card' + i], why: ['action'], route: { operation: 'logic' }, guidance: 'guidance '.repeat(75) }));
  const text = { schema: 'text', id: 'logic.flow', why: [], grammar: 'grammar '.repeat(1200), call: { op: 'logic' } };
  return { lane, intent: 'criar action com aggregate assign if foreach exception', basis: { index: 'stable-index' }, matches,
    categories: new Map(matches.map(m => [m.id, 'logic'])), slices: (pointers, form) => Object.fromEntries(pointers.map(p => [p,
      form === 'full' ? { names: ['one', 'two'], card: 'contract '.repeat(150) } : ['one', 'two']])),
    proven: { job: 'fixture', ops: Array.from({ length: 30 }, (_, i) => ({ op: 'set', value: 'v'.repeat(300), n: i })) },
    text: { value: text, covers: ['ssam-flow/1'], levels: [text, { schema: 'text', id: 'logic.flow', why: [], call: { op: 'logic' } }] },
    producers: { producers: Array.from({ length: 40 }, (_, i) => ({ name: 'Producer' + i, signatures: 'signature '.repeat(50) })) } };
};
function fullOf(input, budget) {
  const text = input.text.levels.find(l => bytes(l) <= budget * TEXT_SHARE) ?? null;
  const local = { ...input, textForms: text ? input.text.covers : [], textWhy: text ? input.text.value.why : [] };
  return JSON.parse(JSON.stringify({ module: moduleSection(null, input.intent, Infinity, { lane: input.lane }).value, text: input.text.value,
    environment: { ok: true, producers: input.producers }, capabilities: capabilitiesSection(local, Infinity, { lane: input.lane, screens: false }).value,
    example: exampleSection(local, Infinity, { lane: input.lane }).value, rules: rulesSection(local, Infinity, { lane: input.lane }).value }));
}
test('pure: every cut recovers exactly its missing section changes, preserves next, respects each budget and checks sources', () => {
  for (const lane of ['o11', 'odc']) for (const budgetBytes of [PACKET_DEFAULT_BYTES, 12000, PACKET_BUDGET]) {
    const input = inputOf(lane), packet = workPacket(input, { budgetBytes }), full = fullOf(input, budgetBytes);
    assert.ok(bytes(packet) <= budgetBytes, `${lane}: ${bytes(packet)}>${budgetBytes}`);
    assert.equal(packet.size.bytes, bytes(packet));
    const text = input.text.levels.find(l => bytes(l) <= budgetBytes * TEXT_SHARE) ?? null;
    assert.deepEqual(packet.next, nextSection({ ...input, textForms: text ? input.text.covers : [], textWhy: [] }));
    const bySection = {};
    for (const cut of packet.cuts) {
      const recover = packetRecovery(cut.recover.arguments.expand);
      const part = workPacket(input, { recover });
      assert.equal(part.ok, true); assert.equal(part.section, cut.section);
      assert.ok(!part.next && !part.packet && !part.capabilities);
      assert.ok(bytes(part) <= PACKET_BUDGET);
      (bySection[cut.section] ??= []).push(...part.missing);
      assert.equal(workPacket({ ...input, basis: { index: 'changed' } }, { recover }).code, 'PACKET_SOURCE_CHANGED');
    }
    for (const [section, missing] of Object.entries(bySection)) {
      assert.deepEqual(missing, packetMissing(full[section], packet[section]));
      assert.deepEqual(applyMissing(packet[section], missing), full[section]);
    }
    assert.deepEqual(workPacket(input), workPacket(input, { budgetBytes: PACKET_DEFAULT_BYTES }));
  }
});
test('pure: large missing strings and nested arrays recover losslessly in bounded section calls', () => {
  const input = inputOf('o11'); input.text.value.grammar = 'á😀"\\'.repeat(18000);
  const packet = workPacket(input), missing = [];
  assert.ok(bytes(packet) <= PACKET_DEFAULT_BYTES);
  for (const cut of packet.cuts.filter(c => c.section === 'text')) {
    const part = workPacket(input, { recover: packetRecovery(cut.recover.arguments.expand) });
    assert.ok(bytes(part) <= PACKET_BUDGET); missing.push(...part.missing);
  }
  assert.deepEqual(applyMissing(packet.text, missing), input.text.value);
});
test('pure: impossible small budgets refuse before returning a partial next or envelope', () => {
  const answer = workPacket(inputOf('odc'), { budgetBytes: 400 });
  assert.equal(answer.code, 'PACKET_BUDGET_TOO_SMALL'); assert.ok(bytes(answer) <= 400);
  assert.ok(answer.minimalBytes > 400); assert.ok(!answer.next);
  assert.ok(answer.continuation); assert.ok(answer.continuation.arguments.budgetBytes <= PACKET_BUDGET);
  const retry = workPacket(inputOf('odc'), { budgetBytes: answer.continuation.arguments.budgetBytes });
  assert.equal(retry.ok, true); assert.ok(retry.next.deliver);
  assert.equal(packetRecovery('packet:text:999999:' + 'a'.repeat(64) + ':0:1').invalid, true);
});
test('pure: an impossible maximum envelope refuses clearly without echo or looping continuation', () => {
  const answer = workPacket({ ...inputOf('o11'), intent: 'x'.repeat(PACKET_BUDGET * 2) });
  assert.equal(answer.code, 'PACKET_ENVELOPE_TOO_LARGE'); assert.ok(answer.minimalBytes > answer.maxBytes);
  assert.ok(!answer.continuation && !answer.next); assert.ok(bytes(answer) <= PACKET_DEFAULT_BYTES);
});
test('pure: recovery binds the module capture and rejects a range outside the missing section', () => {
  const module = { ok: true, file: 'fixture.oml', sourceSha256: 'a'.repeat(64), digest: { module: { name: 'Fixture', key: 'M' }, sections: [], actions: [] } };
  const input = { ...inputOf('o11'), module, app: 'fixture.oml' };
  // An explicit budget below the default (8 KB) keeps a text cut to recover; the binding holds at any budget.
  const packet = workPacket(input, { budgetBytes: 8192 }), recover = packetRecovery(packet.cuts.find(c => c.section === 'text').recover.arguments.expand);
  assert.equal(workPacket(input, { recover }).ok, true);
  assert.equal(workPacket({ ...input, module: { ...module, sourceSha256: 'b'.repeat(64) } }, { recover }).code, 'PACKET_SOURCE_CHANGED');
  assert.equal(workPacket(input, { recover: { ...recover, offset: Number.MAX_SAFE_INTEGER } }).code, 'PACKET_RECOVERY_INVALID');
});

test('R5 through MCP: both lanes default to PACKET_DEFAULT_BYTES and every recovery executes offline without a complete packet', { timeout: 900000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-budget-')); t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  // This fixture freezes release identity because these assertions concern payload
  // sizing/recovery while other CX11 work may edit the facade concurrently.
  const identity = { name: 'packet-budget', root: scratch, release: { facadeSha256: 'fixed', catalogSha256: 'fixed', launcherSha256: 'fixed' } };
  const server = await createSsamServer({ deps: { identity: { read: () => identity }, odcFacade: async () => {
    const facade = new McpServer({ name: 'offline-packet', version: '1' });
    facade.registerTool('ssam_discover', { inputSchema: z.object({ lane: z.enum(['o11', 'odc']), intent: z.string(), packet: z.boolean(),
      app: z.string().optional(), expand: z.string().optional(), budgetBytes: z.number().optional() }) }, async args => {
      const value = await discoverAll({ ...args, sources: snapshotSources(args.lane) });
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    }); return facade;
  } } });
  const client = new Client({ name: 'packet-budget', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const rows = (await createReplay({ root: scratch, includeExtended: true })).filter(r => r.source === 'R5');
  assert.equal(rows.length, 20);
  for (const row of rows) for (const budget of [undefined, 12000, PACKET_BUDGET]) {
    const args = { ...row.args, ...(budget ? { budgetBytes: budget } : {}) };
    const value = decode(await client.callTool({ name: 'ssam_discover', arguments: args }));
    assert.equal(value.ok, true, JSON.stringify(value)); assert.ok(value.next?.deliver);
    assert.ok(bytes(value) <= (budget ?? PACKET_DEFAULT_BYTES), row.id + ': ' + bytes(value));
    for (const cut of value.cuts) {
      const part = decode(await client.callTool({ name: cut.recover.tool, arguments: cut.recover.arguments }));
      const direct = await discoverAll({ ...cut.recover.arguments, sources: snapshotSources(row.args.lane) });
      assert.deepEqual(part, direct); assert.equal(part.section, cut.section); assert.ok(part.missing?.length);
      assert.ok(!part.next && !part.packet); assert.ok(bytes(part) <= PACKET_BUDGET);
    }
  }
});
