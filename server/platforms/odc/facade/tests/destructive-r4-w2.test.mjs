import './fixtures/isolated-profile.mjs';
// CX15 r4 (W-2): studio_data_insert and studio_data_update sent --authorize <the owner's words> to the bridge, which keeps
// them in journal\data\<time>-<Entity>-<op>.json and repeats them in its report (authorization) — and the answer gave them
// back. Only studio_data_delete hashed them. Same family: the prototype seed writers (odcDataWriter: data-insert
// --authorize; o11DataWriter: the --request file the kernel copies into its receipt) and a line typed through
// studio_command. Now every one sends 'sha256:<hex>' (the bridge and the kernel only require a nonempty value) and the
// answer drops what the bridge repeats. A fake bridge that does what DataCommands.cs does (Words("--authorize") = the
// tokens after it up to the next --option; the report with authorization written to journal\data and answered). Synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createFacadeServer } from '../mcp.mjs';
import { root as facadeRoot } from '../lib.mjs';
import { odcDataWriter, o11DataWriter } from '../prototype-seed.mjs';
import { MARK, ownerWords, count, inValue, filesWithMark } from './fixtures/destructive-r4-marker.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const HASHED = /^sha256:[0-9a-f]{64}$/;
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// The bridge's data commands as DataCommands.cs answers them (lines 58/78: Words; 98: the report; 101: TryWrite).
function fakeBridge(journal) {
  const lines = [];
  const call = async args => {
    const line = args.map(String).join(' '); lines.push(line);
    const tokens = line.split(' ').filter(Boolean), command = tokens[0];
    if (command === 'status') return { ok: true, value: [{ name: 'SynthOrders', key: 'synth-module-key' }] };
    const words = name => { const i = tokens.indexOf(name); if (i < 0) return null; const w = []; for (const t of tokens.slice(i + 1)) { if (t.startsWith('--')) break; w.push(t); } return w.join(' ') || null; };
    if (command === 'data') return { ok: true, module: tokens[1], entity: tokens[2], records: [{ Id: '1', Name: 'Synth 1' }], count: 1, more: false };
    // (--authorize=<value> is accepted too, so the line of that spelling can be checked as well.)
    const authorization = words('--authorize') ?? tokens.find(x => x.startsWith('--authorize='))?.slice('--authorize='.length) ?? null;
    if (!authorization) return { ok: false, error: command + ' requires --authorize' };
    const evidence = path.join(journal, Date.now() + '-' + lines.length + '-' + tokens[2] + '-' + command + '.json');
    const report = { ok: true, module: tokens[1], entity: tokens[2], operation: command, authorization, count: 1, failed: 0, reports: [{ recordId: '10', status: 'Success' }], evidence };
    fs.mkdirSync(journal, { recursive: true }); fs.writeFileSync(evidence, JSON.stringify(report, null, 2));
    return report;
  };
  return { lines, call };
}
// The records files the facade writes under its root (journal\data\requests): removed after the test.
function recordsFilesCleanup(t) {
  const dir = path.join(facadeRoot, 'journal', 'data', 'requests');
  const before = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  t.after(() => { if (!fs.existsSync(dir)) return; for (const f of fs.readdirSync(dir)) if (!before.has(f)) fs.rmSync(path.join(dir, f), { force: true }); });
}

const DATA_TOOLS = [
  ['studio_data_insert', { module: 'SynthOrders', entity: 'SynthCustomer', records: [{ Name: 'Synth 3' }, { Name: 'Synth 4' }], authorize: ownerWords('SynthCustomer', 'inserir 2'), pid: 999907 }],
  ['studio_data_update', { module: 'SynthOrders', entity: 'SynthCustomer', records: [{ Id: '1', Name: 'Synth 1b' }], authorize: ownerWords('SynthCustomer', 'atualizar 1'), pid: 999907 }],
];
const PASSTHROUGH = [
  ['studio_command', { command: 'data-insert', args: ['SynthOrders', 'SynthCustomer', '--records-file', 'r.json', '--authorize', 'sim pode', 'inserir', MARK], pid: 999907 }],
  ['studio_command', { command: 'data-update SynthOrders SynthCustomer --records-file r.json --authorize sim pode ' + MARK, pid: 999907 }],
  ['studio_command', { command: 'data-insert', args: ['SynthOrders', 'SynthCustomer', '--authorize=sim pode inserir ' + MARK, '--records-file', 'r.json'], pid: 999907 }],
];
for (const [label, calls] of [['studio_command (the passthrough of the same bridge commands)', PASSTHROUGH], ['studio_data_insert, studio_data_update', DATA_TOOLS]])
test(`W-2 (${label}): the bridge line, its journal and the answer carry no owner words`, async t => {
  recordsFilesCleanup(t);
  const dir = tmp('cx15r4-w2-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridge = fakeBridge(path.join(dir, 'journal', 'data'));
  const facade = await createFacadeServer({ deps: { studio: bridge.call, destructive: { root: path.join(dir, 'destructive') } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r4-w2', version: '1.0.0' });
  await Promise.all([facade.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await facade.close(); });
  for (const [tool, args] of calls) {
    const reply = await client.callTool({ name: tool, arguments: args });
    const text = reply.content?.[0]?.text ?? '';
    const value = reply.structuredContent ?? JSON.parse(text);
    assert.equal(value.ok, true, tool + ' ' + text.slice(0, 300));
    assert.equal(count(text), 0, tool + ': the answer text has no owner words');
    assert.equal(inValue(value), 0, tool + ': the structured answer has no owner words');
    assert.equal(Object.hasOwn(value, 'authorization'), false, tool + ': the answer drops what the bridge repeats');
  }
  const writes = bridge.lines.filter(l => /^data-(insert|update) /.test(l));
  assert.equal(writes.length, calls.length);
  for (const line of writes) {
    assert.equal(count(line), 0, 'the line that crosses the pipe has no owner words: ' + line.replace(MARK, '<MARK>'));
    const tokens = line.split(' '), i = tokens.findIndex(x => /^--authorize(=|$)/.test(x));
    const value = tokens[i] === '--authorize' ? tokens[i + 1] : tokens[i].slice('--authorize='.length);
    assert.match(value, HASHED, 'the bridge gets sha256:<hex>: ' + line.replace(MARK, '<MARK>'));
  }
  assert.deepEqual(filesWithMark([dir, process.env.USERPROFILE, path.join(facadeRoot, 'journal', 'data')]), [], 'no file keeps the owner words');
});

test('W-2 (prototype seed): odcDataWriter sends sha256:<hex> to data-insert; o11DataWriter writes it in the --request file the kernel copies to its receipt', async t => {
  const dir = tmp('cx15r4-w2-seed-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const WORDS = ownerWords('Haiku', 'semear');
  const bridge = fakeBridge(path.join(dir, 'journal', 'data'));
  const odc = odcDataWriter({ studio: bridge.call, pid: 7, dir: path.join(dir, 'odc-seed') });
  const r = await odc({ module: 'Haiku', authorization: WORDS, batch: [{ operation: 'insert', entity: 'E', records: [{ Id: 1 }] }] });
  assert.equal(r.ok, true);
  const line = bridge.lines.find(l => l.startsWith('data-insert '));
  assert.equal(count(line), 0, 'the data-insert line has no owner words');
  assert.match(line.split(' ').at(-1), HASHED);
  // The kernel (DataCommand / DataReceipt.cs:34) copies the request's authorization into its receipt: the simulated one.
  const work = path.join(dir, 'o11-work'); let receipt = null;
  const runAnvil = async argv => {
    const request = JSON.parse(fs.readFileSync(argv[argv.indexOf('--request') + 1], 'utf8'));
    receipt = { authorization: request.authorization, results: request.batch.map(() => ({ ok: true, inserted: 1 })) };
    fs.writeFileSync(path.join(work, 'receipt.json'), JSON.stringify(receipt));
    return { envelope: { ok: true, data: { results: receipt.results } } };
  };
  const o11 = o11DataWriter({ runAnvil, host: 'o11.example.test', oml: path.join(dir, 'm.oml'), work });
  const answer = await o11({ module: 'Haiku_UI', authorization: WORDS, batch: [{ operation: 'insert', entity: 'E', records: [{ Id: 1 }], operationId: 'x' }] });
  assert.equal(answer.ok, true);
  assert.match(receipt.authorization, HASHED, 'the kernel gets sha256:<hex>');
  assert.equal(inValue(answer), 0);
  assert.deepEqual(filesWithMark([dir]), [], 'neither the --request file nor the simulated receipt keeps the owner words');
});
