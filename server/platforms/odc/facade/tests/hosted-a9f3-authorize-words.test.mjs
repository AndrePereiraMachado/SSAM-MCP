// servidor/fase4-26 a9 follow-ups, round 3 (review C:\t\revisoes\a9-followups-2\REVISAO.md, N1, the family of B), on the
// hosted session (fake executor and agent, the facade's studio_* commands over a fake ODC Studio bridge): studio_authorize
// takes the owner's words in text, a words field of the hub's one rule (destructive-operations.mjs callWordsProblems), but
// the mask of every echo knew only WORD_KEYS and the studio_command line. The gate's AGENT_RECONNECTING (W1) and
// PATH_OUTSIDE_WORKSPACE (W2) gave text back word for word, and replayed as it came the continuation recorded the
// authorization in the manifest without the owner. Now the detector and every echo read one rule: no word comes back, the
// step carries the marker in text with askOwner, replayed as it came it is WORDS_REQUIRED with no bridge call, and with the
// owner's new words it records them (as their sha256). The input layer (W3) answers as it did.
import './fixtures/isolated-profile.mjs';
import { MARKER, assertNoWords, connectedAgent, customer, downloads, markersOf, odcServer, put, reconnectingAgent, said, withWords } from './fixtures/hosted-a9f2.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { wordsSha256 } from '../destructive-operations.mjs';

const MANIFEST = 'ws:odc/manifests/shop.json';
const ASK = /the owner's own words in place of the marker$/;
// The fake ODC Studio bridge: every command it gets (studio_authorize sends authorize <manifest> <kind> sha256:<words>).
function bridge() {
  const calls = [];
  return { calls, studio: async (args, pid) => { calls.push({ args: [...args], pid }); return { ok: true, command: args[0], recorded: true }; } };
}
// An agent that is reconnecting (seen 10 s ago, back after the gate's wait) until back() is called.
function returningAgent() {
  let up = false;
  return { connected: () => up, protocolError() {}, waitConnected: async () => false, info: () => (up ? connectedAgent.info() : reconnectingAgent.info()), back() { up = true; } };
}
const manifestFile = { schemaVersion: 'synthetic', module: 'Shop' };

test('N1 W1: studio_authorize while the agent reconnects (AGENT_RECONNECTING): text never comes back; as it came WORDS_REQUIRED with no bridge call; the owner\'s new words record', async () => {
  const words = ['Synthetic owner words IOTA: I authorize publishing the Shop app'], again = 'Synthetic owner words KAPPA: yes, publish Shop now';
  const agent = returningAgent();
  const A = customer(agent), b = bridge();
  put(path.join(A.workspace, 'odc', 'manifests', 'shop.json'), JSON.stringify(manifestFile));
  const s = await odcServer(A, undefined, { studio: b.studio });
  try {
    const refused = await s.call('studio_authorize', { manifest: MANIFEST, kind: 'publish', text: words[0] });
    assert.equal(refused.body.code, 'AGENT_RECONNECTING', said(refused.body));
    assertNoWords(refused, words);
    const c = refused.body.continuation;
    assert.equal(c?.tool, 'studio_authorize', said(refused.body));
    assert.deepEqual(c.arguments, { manifest: MANIFEST, kind: 'publish', text: MARKER });
    assert.deepEqual(c.askOwner?.fields, ['text'], said(c));
    assert.match(c.why, ASK);
    assert.match(c.why, /^the SSAM agent reconnects by itself/, 'the why of the gate stays, the ask is added');
    assert.equal(b.calls.length, 0);
    agent.back();
    // replayed as it came, the agent back: the hub's rule, nothing reaches the bridge
    const asItCame = await s.call(c.tool, c.arguments);
    assert.equal(asItCame.body.code, 'WORDS_REQUIRED', said(asItCame.body));
    assert.deepEqual(asItCame.body.askOwner?.fields, ['text']);
    assert.equal(b.calls.length, 0, 'nothing recorded without the owner');
    // with the owner's new words in place of the marker: recorded, as their sha256
    const done = await s.call(c.tool, withWords(c.arguments, again));
    assert.equal(done.body.ok, true, said(done.body));
    assertNoWords(done, [again, ...words]);
    assert.equal(b.calls.length, 1);
    assert.deepEqual([b.calls[0].args[0], b.calls[0].args[2], b.calls[0].args[3]], ['authorize', 'publish', 'sha256:' + wordsSha256(again)]);
  } finally { await s.close(); }
});

test('N1 W2: studio_authorize with a manifest outside the agent folders (PATH_OUTSIDE_WORKSPACE): the continuation asks the owner; as it came nothing is recorded', async () => {
  const words = ['Synthetic owner words LAMBDA: I authorize publishing the Shop app'], again = 'Synthetic owner words MU: yes, publish Shop now';
  const A = customer(), b = bridge();
  const s = await odcServer(A, undefined, { studio: b.studio });
  try {
    const refused = await s.call('studio_authorize', { manifest: downloads('shop.json'), kind: 'publish', text: words[0] });
    assert.equal(refused.body.code, 'PATH_OUTSIDE_WORKSPACE', said(refused.body));
    assertNoWords(refused, words);
    const c = refused.body.continuation;
    assert.equal(c?.tool, 'studio_authorize', said(refused.body));
    assert.deepEqual(c.arguments, { manifest: 'agent:inbox/shop.json', kind: 'publish', text: MARKER });
    assert.deepEqual(markersOf(c.arguments), ['text']);
    assert.deepEqual(c.askOwner?.fields, ['text'], said(c));
    assert.match(c.why, ASK);
    // the owner's file copied as the fix says, then the continuation as it came: the hub's rule, nothing recorded
    put(path.join(A.agentDir, 'inbox', 'shop.json'), JSON.stringify(manifestFile));
    const asItCame = await s.call(c.tool, c.arguments);
    assert.equal(asItCame.body.code, 'WORDS_REQUIRED', said(asItCame.body));
    assert.equal(b.calls.length, 0, 'nothing recorded without the owner');
    const done = await s.call(c.tool, withWords(c.arguments, again));
    assert.equal(done.body.ok, true, said(done.body));
    assertNoWords(done, [again, ...words]);
    assert.equal(b.calls.length, 1);
    assert.deepEqual([b.calls[0].args[0], b.calls[0].args[2], b.calls[0].args[3]], ['authorize', 'publish', 'sha256:' + wordsSha256(again)]);
  } finally { await s.close(); }
});

test('N1 W3 (control): the input layer answers studio_authorize as before: corrected and the step hold the marker in text, no word, nothing sent', async () => {
  const words = ['Synthetic owner words NU: I authorize publishing the Shop app'];
  const A = customer(), b = bridge();
  put(path.join(A.agentDir, 'inbox', 'shop.json'), JSON.stringify(manifestFile));
  const s = await odcServer(A, undefined, { studio: b.studio });
  try {
    for (const args of [{ manifest: 'agent:inbox/shop.json', kind: 'PUBLISH', text: words[0] }, { manifest: 'agent:inbox/shop.json', kind: 'publish', text: words[0], note: 'x' },
      { manifest: 'agent:inbox/shop.json', kind: 'publish', authorization: words[0] }]) {
      const r = await s.call('studio_authorize', args);
      assert.equal(r.body.code, 'INPUT_INVALID', said(r.body));
      assertNoWords(r, words);
      assert.deepEqual(Object.keys(r.body), ['ok', 'code', 'error', 'violations', 'corrected', 'continuation'], said(r.body));
      assert.equal(r.body.corrected.text, MARKER);
      assert.equal(r.body.continuation.arguments.text, MARKER);
      assert.equal(r.body.continuation.askOwner, undefined, 'the input layer\'s own step, as before');
    }
    assert.equal(b.calls.length, 0);
  } finally { await s.close(); }
});
