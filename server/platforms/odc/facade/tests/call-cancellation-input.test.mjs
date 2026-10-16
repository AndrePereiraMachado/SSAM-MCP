import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCallDeadline } from '../call-deadline.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const answer = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
function setup(t, timeoutMs = 30) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-n1-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createCallDeadline({ root, timeoutMs });
}

test('N1 input-capable exempt tool cancels only its original waiter and joins its active handler', async t => {
  const deadline = setup(t, 200);
  let finish, calls = 0, active = 0, peak = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const run = deadline.wrap('propose', async () => {
    calls++; active++; peak = Math.max(peak, active);
    await gate; active--;
    return answer({ ok: true, accepted: 'synthetic input', version: 7 });
  }, { exempt: true, annotations: { readOnlyHint: false } });
  const abort = new AbortController();
  let originalSettled = false;
  const original = run({ task: 'synthetic' }, { mcpReq: { signal: abort.signal } })
    .then(result => ({ result }), error => ({ error }))
    .then(result => { originalSettled = true; return result; });
  await sleep(20); abort.abort('synthetic user cancellation');
  await sleep(30);
  const settledAfterCancellation = originalSettled;
  const joined = run({ task: 'synthetic' });
  await sleep(10); finish();
  const [first, second] = await Promise.all([original, joined]);
  assert.equal(calls, 1, 'Identical repeat must join exempt tool rather than start a second handler');
  assert.equal(peak, 1);
  assert.equal(settledAfterCancellation, true, 'Original waiter must end while its handler remains alive');
  assert.equal(first.error?.code, 'CANCELLED');
  assert.equal(second.structuredContent.ok, true);
  assert.equal(second.structuredContent.version, 7);
  assert.equal(second.structuredContent.joined, true);
});

test('N1 input-capable exempt original remains open past deadline for the eventual elicitation response', async t => {
  const deadline = setup(t, 20);
  let finish, settled = false, calls = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const expected = answer({ resultType: 'input_required', choices: ['synthetic'] });
  const run = deadline.wrap('propose', async () => { calls++; await gate; return expected; }, { exempt: true, annotations: { readOnlyHint: false } });
  const result = run({ task: 'synthetic-input' }).then(value => { settled = true; return value; });
  await sleep(80);
  const prematurelySettled = settled;
  const detached = deadline.runningCount();
  finish();
  assert.deepEqual(await result, expected);
  assert.equal(prematurelySettled, false, 'An original elicitation request must stay open after its ordinary deadline');
  assert.equal(detached, 0);
  assert.equal(calls, 1);
});
