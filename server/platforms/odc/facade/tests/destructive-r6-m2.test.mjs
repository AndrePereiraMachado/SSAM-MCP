import './fixtures/isolated-profile.mjs';
// CX15 r6 (M-2): an input refusal of studio_command echoed the owner's words in corrected and in the ready continuation
// (forEcho and the hub's mask only looked at WORD_KEYS, never at command/args), and a long refusal wrote them into
// .local\answers. Now forEcho and the hub mask, in command and in args, the places the bridge reads as words, by the rule of
// argsWithoutWords / bridgeArgsWithoutWords: the text of "authorize <manifest> <kind> <text>", the tokens after --authorize up
// to the next --option and --authorize=<words>. The forms of the review (C:\t\revisoes\cx15-5\verify-1\probe\repro-m2.mjs):
// args as a text, pid "studio", a number in args, an empty command, words in the command text, --authorize=, and the long
// refusal. Synthetic values; the fake runner never runs anything and no bridge is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { fakeBridge, delivery, BRIDGE_PID as PID } from './fixtures/destructive-r5-bridge.mjs';
import { MARK, count, filesWithMark, filesUnder } from './fixtures/destructive-r4-marker.mjs';
import { M2_CASES } from './fixtures/destructive-r5-cases.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const W = 'sim pode publicar o SynthApp ' + MARK;


test('M-2: every studio_command input refusal of the review gives no owner words back, and .local\\answers keeps none', async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r6-m2-')); t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const dataRoot = path.join(work, 'data'), answersRoot = path.join(work, 'answers'), lockRoot = path.join(work, 'lock');
  for (const d of [dataRoot, answersRoot, lockRoot]) fs.mkdirSync(d, { recursive: true });
  const runs = [];
  const hub = await createSsamServer({ o11: true, odc: true, deps: { runAnvil: async argv => { runs.push(argv[0]); return { ok: false, exitCode: 2, envelope: { ok: false, error: 'fake' } }; },
    dataRoot, answersRoot, lock: { o11Root: lockRoot, odcRoot: lockRoot } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r6-m2', version: '1.0.0' });
  await Promise.all([hub.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await hub.close(); });
  const leaks = [], refused = [], masked = [];
  for (const [name, args] of Object.entries(M2_CASES(path.join(work, 'synth', 'manifest.json'), W))) {
    const reply = await client.callTool({ name: 'studio_command', arguments: args });
    const text = (reply.content ?? []).map(c => String(c.text ?? '')).join('');
    const marks = count(text) + count(JSON.stringify(reply.structuredContent ?? null));
    if (marks) leaks.push(name + ': ' + marks);
    const value = reply.structuredContent ?? (() => { try { return JSON.parse(text); } catch { return null; } })();
    if (value?.ok === false) refused.push(name);
    if (JSON.stringify(value ?? '').includes("<the user's own words>")) masked.push(name); // the English marker since 16/10 (WORDS_ECHO)
  }
  assert.deepEqual(leaks, [], 'no answer carries the owner words');
  assert.equal(refused.length, 7, 'every form is a refusal: ' + JSON.stringify(refused));
  assert.ok(masked.length >= 5, 'the echoes keep the shape with the words marker: ' + JSON.stringify(masked));
  assert.deepEqual(runs, [], 'nothing ran');
  assert.deepEqual(filesWithMark([work, process.env.USERPROFILE]).map(f => path.basename(f)), [], '.local\\answers and the profile keep no owner words');
  assert.ok(filesUnder(path.join(answersRoot, '.local', 'answers')).length >= 1, 'the long refusal (R7) was kept by the fitter, without the words');
});

// The success path of the same tool, the forms of the review's sweep (S1-S4, sweep-r5.mjs): the pipe joins the arguments
// with spaces, so an argument that holds several tokens carries the words as well; they cross as one sha256:<hex>.
test('M-2 (the sweep forms S1-S4): an argument that holds several tokens never carries the words across the bridge', async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r6-m2-pipe-')); t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const bridge = fakeBridge();
  const facade = await createFacadeServer({ deps: { studio: bridge.studio, destructive: { root: path.join(out, 'destructive') } } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'cx15r6-m2-pipe', version: '1' });
  await Promise.all([facade.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await facade.close(); });
  const m1 = delivery(out, 's1', 'ZZS1').manifest, m2 = delivery(out, 's2', 'ZZS2').manifest;
  const forms = {
    S1_one_arg_all: { command: 'authorize', args: [`${m1} publish ${W}`] },
    S2_kind_and_words_one_arg: { command: `authorize ${m2}`, args: [`publish ${W}`] },
    S3_data_insert_natural: { command: 'data-insert ZZMod ZZEnt', args: ['--records', '[{"Name":"x"}]', '--authorize', W] },
    S4_data_insert_flag_inside_arg: { command: 'data-insert ZZMod ZZEnt', args: [`--records [{"Name":"x"}] --authorize ${W}`] },
  };
  const leaks = [];
  for (const [name, args] of Object.entries(forms)) {
    const r = await client.callTool({ name: 'studio_command', arguments: { ...args, pid: PID } });
    if (count((r.content ?? []).map(c => c.text).join('')) + count(JSON.stringify(r.structuredContent ?? null))) leaks.push(name);
  }
  assert.deepEqual(leaks, [], 'no answer carries the words');
  assert.deepEqual(bridge.lines.filter(l => count(l) > 0).map(l => l.split(' ')[0]), [], 'no line carries the words');
  assert.equal(bridge.lines.length, 4, 'every form reached the bridge');
  for (const l of bridge.lines) assert.match(l, /sha256:[0-9a-f]{64}/);
  assert.deepEqual(filesWithMark([out]).map(f => path.basename(f)), [], 'no manifest keeps the words');
});