import './fixtures/isolated-profile.mjs';
// CX15 r5 (N-1): validation refusals rebuilt corrected and continuation.arguments from the input and gave the owner's words
// back: tool-input.mjs forEcho masked only authorize/words at the top and request.authorization (not
// request.batch[].authorization, ownerRequest at any level, reconcile.authorize), and o11_environment and studio_create_app
// spread the input into their continuations (authorize, ownerRequest). Above the refusal budget the fitter kept the whole
// answer, words included, in .local\answers. Now every corrected and every step {tool, arguments} of an answer masks
// authorize, authorization, words and ownerRequest at any depth (the hub point, ssam.mjs, plus the local helpers). The cases
// are those of the reviewer's probe (C:\t\revisoes\cx15-4\verify-0\probe-v0.mjs): C1-C4, E1-E6, D1-D3. Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { WORDS_MARKER } from '../tool-input.mjs';
import * as ops from '../destructive-operations.mjs'; // a namespace: at the base each test fails on its own rule, not at import
import { MARK, count, filesWithMark, filesUnder } from './fixtures/destructive-r4-marker.mjs';
import { N1_CASES } from './fixtures/destructive-r5-cases.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const W = 'sim pode seguir com ZZApp ' + MARK;


test('N-1: every validation refusal of the probe (C1-C4, E1-E6, D1-D3) gives no owner words back, and .local\\answers keeps none', async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r5-n1-')); t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const dataRoot = path.join(work, 'data'), answersRoot = path.join(work, 'answers'), lockRoot = path.join(work, 'lock');
  for (const d of [dataRoot, answersRoot, lockRoot]) fs.mkdirSync(d, { recursive: true });
  const runs = [];
  const runAnvil = async argv => { runs.push(argv.slice(0, 3).join(' ')); return { ok: false, exitCode: 2, envelope: { ok: false, error: 'fake runner' } }; };
  const hub = await createSsamServer({ o11: true, odc: true, deps: { runAnvil, dataRoot, answersRoot, lock: { o11Root: lockRoot, odcRoot: lockRoot } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r5-n1', version: '1.0.0' });
  await Promise.all([hub.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await hub.close(); });
  const leaks = [], refused = [];
  for (const [name, [tool, args]] of Object.entries(N1_CASES(path.join(work, 'x.oml'), W))) {
    const reply = await client.callTool({ name: tool, arguments: args });
    const text = (reply.content ?? []).map(c => String(c.text ?? '')).join('');
    const marks = count(text) + count(JSON.stringify(reply.structuredContent ?? null));
    if (marks) leaks.push(name + ': ' + marks);
    const value = reply.structuredContent ?? JSON.parse(text);
    if (value?.ok === false) refused.push(name);
  }
  assert.deepEqual(leaks, [], 'no answer carries the owner words');
  assert.equal(refused.length, Object.keys(N1_CASES('x', W)).length, 'every case is a refusal: ' + JSON.stringify(refused));
  assert.deepEqual(runs, [], 'nothing ran');
  assert.ok(filesUnder(path.join(answersRoot, '.local', 'answers')).length >= 1, 'the fitter kept at least one long refusal (D3)');
  assert.deepEqual(filesWithMark([work, process.env.USERPROFILE]), [], '.local\\answers and the profile keep no owner words');
});

test('N-1: the mask keeps placeholders and hashes, and its marker is the one the answers use', () => {
  const { OWNER_REPLY, WORDS_ECHO, withoutWordEchoes } = ops;
  assert.equal(WORDS_ECHO, WORDS_MARKER);
  const value = withoutWordEchoes({ corrected: { authorize: W, request: { batch: [{ authorization: W }], ownerRequest: W } },
    continuation: { tool: 'x', arguments: { authorize: OWNER_REPLY, words: 'sha256:' + 'a'.repeat(64), nested: { ownerRequest: W } } },
    continuations: [{ tool: 'y', arguments: { authorization: W } }], error: 'unchanged' });
  assert.equal(count(JSON.stringify(value)), 0);
  assert.equal(value.continuation.arguments.authorize, OWNER_REPLY, 'a placeholder stays');
  assert.equal(value.continuation.arguments.words, 'sha256:' + 'a'.repeat(64), 'a hash stays');
  assert.equal(value.corrected.request.batch[0].authorization, WORDS_MARKER);
  assert.equal(value.error, 'unchanged');
});
