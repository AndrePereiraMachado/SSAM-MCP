// The one switch of ssam_code on a hosted server (the class of ssam_code in hosted/tools.json, hosted/served.mjs) and the
// no-internals rule of the hosted catalog's reasons (review of feat/ssam-code-hosted, M1). Off, the session reads what it
// read before ssam_code was served hosted, word for word (tests/fixtures/hosted-code-off.mjs): the paragraph and the rules
// leave ssam_code out, and the refusal keeps its cause and its ssam_map continuation. No reason or refusal of the gate
// names a release, a line, a branch or a section of SSAM's own documents. A fake link, context and run: no hub, no agent.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { wrapHostedTool, hostedTools } from '../hosted/policy.mjs';
import { codeServedHosted, overrideCodeServed } from '../hosted/served.mjs';
import { createSsamServer, hostedInstructions, HOSTED_INSTRUCTIONS, HOSTED_RULES } from '../ssam.mjs';
import { runWithExecutor } from '../executor.mjs';
import { findings } from './fixtures/internal-text.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';
import { OFF_HOSTED_INSTRUCTIONS, OFF_HOSTED_RULES, OFF_CAUSE, OFF_CONTINUATION } from './fixtures/hosted-code-off.mjs';

test.after(cleanupHostedDirs);
// The names of the owner's releases, lines and branches, a section of a project document "(4.5)", a function of the
// server's code, a review label: none tells a licensee anything he can use (independent of the rule's own patterns).
const RELEASE = /\bmarco-a\d+\b|\bservidor\/|\bfase\d+(?:-\d+)?\b|(?<![\w./:-])(?:fix|feat|integracao)\/[\w.-]+|\(\d+\.\d+\)|\bresolvePublic\(|\b(?:a[1-9]|CX\d+)\b/;
const strings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, out));
  return out;
};
const internal = value => [...findings(value).map(f => f.family + ' at ' + f.at + ': ' + f.sample), ...strings(value).filter(s => RELEASE.test(s)).map(s => 'release name: ' + s.match(RELEASE)[0] + ' in ' + s.slice(0, 160))];

function harness() {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot });
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }), async call() { return {}; } };
  const context = { id: 'ctx-switch', hosted: true, tokenId: 'tok_switch', customer: 'Switch', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const runs = [];
  const run = (ctx, fn) => { runs.push(ctx.id); return fn(); };
  const gate = (name, tools) => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, async () => { runs.push('handler ' + name); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; },
      { context, link, lanes: context.lanes, run, ...(tools ? { tools } : {}) });
    return (args = {}) => wrapped(args, { requestId: 1 });
  };
  return { ...dirs, link, context, runs, run, gate };
}

test('M1: switch off (ssam_code unavailable in the catalog the gate reads), the hosted paragraph and rules are the ones before ssam_code was served, word for word', () => {
  const context = { agent: { info: () => ({ agentRoot: 'C:\\Users\\someone\\SSAM-agent' }) } };
  const inbox = ' The agent inbox folder of this account is C:\\Users\\someone\\SSAM-agent\\inbox.';
  assert.equal(codeServedHosted(), true, 'as shipped, hosted/tools.json serves ssam_code');
  assert.equal(hostedInstructions({ context }), HOSTED_INSTRUCTIONS + ' ' + HOSTED_RULES + inbox);
  assert.match(HOSTED_INSTRUCTIONS, /ssam_code reads and writes the module as code here too/);
  const restore = overrideCodeServed(false);
  try {
    assert.equal(hostedTools().ssam_code.class, 'unavailable', 'the switch is the class of the one catalog: the gate reads the same one');
    assert.equal(codeServedHosted(), false);
    assert.equal(hostedInstructions({ context }), OFF_HOSTED_INSTRUCTIONS + ' ' + OFF_HOSTED_RULES + inbox);
    assert.equal(hostedInstructions({}), OFF_HOSTED_INSTRUCTIONS + ' ' + OFF_HOSTED_RULES + ' ssam_doctor shows the agent inbox folder (agent.inbox).');
  } finally { restore(); }
  assert.equal(hostedTools().ssam_code.class, 'server', 'restored');
  assert.equal(hostedInstructions({ context }), HOSTED_INSTRUCTIONS + ' ' + HOSTED_RULES + inbox);
});

test('M1: switch off, ssam_code is refused before anything runs, with the cause and the ssam_map continuation it had, and no internal name', async () => {
  const restore = overrideCodeServed(false);
  try {
    const h = harness();
    for (const args of [{ lane: 'odc', action: 'read', part: 'logic', target: 'Orders' }, { lane: 'o11', action: 'plan', module: 'Orders', items: [] }, { lane: 'odc', action: 'write', module: 'Orders', text: 'x' }]) {
      const result = await h.gate('ssam_code')(args);
      const value = result.structuredContent;
      assert.equal(result.isError, true);
      assert.equal(value.code, 'HOSTED_UNAVAILABLE');
      assert.equal(value.cause, OFF_CAUSE);
      assert.deepEqual(value.continuation, OFF_CONTINUATION);
      assert.match(value.error, /^ssam_code is not available on a hosted SSAM server: /);
      assert.match(value.error, /ssam_map/);
      assert.deepEqual(internal(value), []);
    }
    assert.deepEqual(h.runs, [], 'nothing ran: no context, no handler');
  } finally { restore(); }
});

test('M1: switch off, a hosted session announces the old paragraph and refuses ssam_code through the server', async t => {
  const restore = overrideCodeServed(false);
  t.after(restore);
  const h = harness();
  const session = { tokenId: 'tok_switch', customer: 'Switch', lanes: ['odc', 'o11'], workspace: h.workspace, agent: h.link };
  const server = await runWithExecutor(h.context, () => createSsamServer({ o11: false, odc: false, hosted: { context: h.context, session, run: h.run } }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-code-switch', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const said = client.getInstructions();
  assert.ok(said.includes(OFF_HOSTED_INSTRUCTIONS + ' ' + OFF_HOSTED_RULES), 'the paragraph and the rules of the session before ssam_code was served');
  assert.doesNotMatch(said, /ssam_code reads and writes|code files of ssam_code subagents/);
  const refused = await client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'read', part: 'logic', target: 'Orders' } });
  assert.equal(refused.structuredContent?.code, 'HOSTED_UNAVAILABLE', JSON.stringify(refused).slice(0, 600));
  assert.equal(refused.structuredContent.cause, OFF_CAUSE);
  assert.deepEqual(refused.structuredContent.continuation, OFF_CONTINUATION);
  assert.deepEqual(internal(refused.structuredContent), []);
});

test('M1: every reason of the hosted catalog, as the refusal of its tool, names nothing internal (no release, line, branch or section)', async () => {
  const h = harness();
  const tools = hostedTools();
  const leaks = [];
  for (const [name, entry] of Object.entries(tools)) {
    // what the entry itself says, and what a licensee reads when the tool is (or is switched) unavailable
    for (const text of strings({ reason: entry.reason, off: entry.off, continuation: entry.continuation })) if (RELEASE.test(text)) leaks.push(name + ' (catalog): ' + text.match(RELEASE)[0]);
    const value = (await h.gate(name, { [name]: { ...entry, class: 'unavailable' } })({})).structuredContent;
    assert.equal(value.code, 'HOSTED_UNAVAILABLE', name);
    for (const leak of internal(value)) leaks.push(name + ': ' + leak);
  }
  assert.deepEqual(leaks, []);
  assert.deepEqual(h.runs, []);
});

test('M1: the gate passes a reason through the no-internals rule: a release name written in a reason never reaches the licensee', async () => {
  const h = harness();
  const tools = { zz_tool: { class: 'unavailable', lane: 'none', agent: 'never', paths: { in: [], out: [] }, cause: 'ZZ_PENDING',
    reason: 'Not served here yet (marco-a5): the release servidor/fase4-26 a8 and the branch fix/system-reference (a7) bring it; see fase4-24.',
    continuation: { tool: 'ssam_map', arguments: { view: 'flow' }, why: 'Reads the module as text (marco-a5) as integracao/marco-a5 does.' } } };
  const value = (await h.gate('zz_tool', tools)({})).structuredContent;
  assert.equal(value.code, 'HOSTED_UNAVAILABLE');
  assert.equal(value.cause, 'ZZ_PENDING');
  assert.deepEqual(internal(value), []);
  assert.match(value.error, /^zz_tool is not available on a hosted SSAM server: Not served here yet/);
  assert.match(value.continuation.why, /^Reads the module as text/);
  assert.deepEqual(value.continuation.arguments, { view: 'flow' }, 'the call itself is never rewritten');
  // the rule's own family leaves alone what only looks like one: a URL path, a word, a cell, a version
  const { scrubText } = await import('../exposure.mjs');
  for (const text of ['Open https://host.example/fix/abc and the phase list.', 'The cells a5 to a9 of the sheet (A1) stay.', 'Version 11.55.92 (4.5 MB).'])
    assert.equal(scrubText(text), text);
  assert.equal(scrubText('Views ddl and html (marco-a5) read it; see fix/system-reference.'), 'Views ddl and html read it; see.');
});

test('M1: served, the catalog keeps ssam_code a server tool whose off state is written beside it (one switch: the class)', () => {
  const entry = hostedTools().ssam_code;
  assert.equal(entry.class, 'server');
  assert.equal(entry.off?.cause, OFF_CAUSE);
  assert.deepEqual(entry.off?.continuation, OFF_CONTINUATION);
  assert.match(entry.off?.reason ?? '', /ssam_map/);
  assert.equal(entry.cause, undefined, 'the cause and continuation of the refusal live in off, read only while the class is unavailable');
  assert.equal(entry.continuation, undefined);
});
