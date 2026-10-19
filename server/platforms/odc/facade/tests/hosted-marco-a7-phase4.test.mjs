import './fixtures/isolated-profile.mjs';
// servidor/fase4-26 a7, phase 4: item 6 of the review no-internals-7 (C:\t\revisoes\no-internals-7\REVISAO.md), through the
// hosted gate with ws: paths (fake executor and agent, as hosted-marco-a7-phase3):
// - the INPUT_INVALID refusals a licensee gets keep the argument pointers in `error` and in violations[].path (before:
//   "<server>licationKey expected string", "<server>s expected array": a POSIX root with no end of segment);
// - a POSIX root is a server path only as a whole segment, and a path at the end of a sentence leaves its period, in the
//   rule (exposure.mjs POSIX_PATH) and in the gate's presenter alike;
// - a pointer the answer itself names in violations[].path (even one that is exactly a root of the Linux image, /app or
//   /tmp) is the name of an argument, in the rule and in the presenter alike.
// Each case runs twice: the layout of this machine, and the layout of the Linux image (docker/ssam-server/Dockerfile and the
// SSAM-MCP image: code /app, HOME and temp /tmp, the /data volumes, /studio) with path.posix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { servedBytesStore } from '../served-bytes.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-a7-p4-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { o11Lane } = await import('../workspace.mjs');
const { createSsamServer, registerServedTool } = await import('../ssam.mjs');
const policy = await import('../hosted/policy.mjs');

class FakeExecutor {
  constructor() { this.id = 'fake-' + randomUUID(); this.hosted = true; this.calls = []; }
  relayPort() { return 41997; }
  o11Connection() { return null; }
  async close() {}
  async call(kind) { this.calls.push(kind); if (kind === 'studio.processes') return { processes: [] }; throw Object.assign(new Error('unexpected ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); }
}
const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, agentVersion: '0.3.1',
  kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' }, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function hostedContext() {
  const tokenId = 'tok_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const ws = path.join(fs.mkdtempSync(path.join(tmp, 'ws-')), 'customers', tokenId);
  prepareWorkspace(ws);
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Synthetic ' + tokenId, lanes: ['odc', 'o11'], workspace: ws, agent, executor: new FakeExecutor(), o11: { lane: o11Lane.lane }, close: async () => {} };
}

// The layout of the Linux image, as the presenter of the hosted server sees it there.
const IMAGE_ENV = { SSAM_SERVER_DIR: '/data/server', SSAM_FRICTION_DIR: '/data/friction', ANVIL_STUDIO_DIR: '/studio/o11', ANVIL_ODC_STUDIO_DIR: '/studio/odc',
  ANVIL_ODC_FEATURES_DIR: '/data/odc-features', SSAM_MODULE_INDEX_ROOT: '/data/cache/module-index', SSAM_READER_CACHE_ROOT: '/data/cache/readers' };
const IMAGE_WS = '/data/server/customers/tok_aaaaaaaaaaaa';
const imageLayout = () => ({ workspace: IMAGE_WS, pathApi: path.posix,
  serverRoots: [...policy.serverRoots({ env: IMAGE_ENV, code: '/app', home: '/tmp', tmp: '/tmp' }), '/home'] });
const LAYOUTS = { 'this machine': () => null, 'the Linux image': imageLayout };

// A synthetic server tool registered the way the served mode registers its own (registerServedTool: the licensee's rule,
// then the gate), so a text reaches the client exactly as a hosted answer does.
const SYNTHETIC = 'zz_item6_text';
const syntheticTools = () => ({ ...policy.hostedTools(), [SYNTHETIC]: { class: 'server', lane: 'none', agent: 'never', paths: { in: [], out: [] }, reason: 'test only' } });
async function session({ presentation = null, synthetic = null } = {}) {
  const context = hostedContext();
  const store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) });
  const hosted = { context, session: { agent, lanes: context.lanes }, exposure: { store }, ...(presentation ? { presentation } : {}), ...(synthetic ? { tools: syntheticTools() } : {}) };
  const server = await runWithExecutor(context, () => createSsamServer({ hosted }));
  if (synthetic) registerServedTool(server, SYNTHETIC, { description: 'Synthetic answer text (test only).' }, async () => ({ content: [{ type: 'text', text: JSON.stringify(synthetic) }], structuredContent: synthetic, isError: true }));
  const client = new Client({ name: 'hosted-a7-p4', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const raw = async (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  const once = async (name, args) => { const r = await raw(name, args); return { body: r.structuredContent ?? JSON.parse(r.content[0].text), text: r.content?.[0]?.text ?? '' }; };
  return { context, once, close: async () => { await client.close(); await server.close(); } };
}
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The real refusals of item 6 a hosted licensee can reach (the O11 tools with an action that needs no Studio, so the call
// gets to the input check), each with the pointers it names.
const REFUSALS = [
  ['o11_environment', { action: 'references', apps: 'x' }, ['/apps']],
  ['o11_environment', { action: 'references', apps: 'x', app: 5 }, ['/apps', '/app']],
  ['o11_service_center_read', { action: 'capabilities', applications: 'x', applicationLimit: 'y' }, ['/applications', '/applicationLimit']],
  ['ssam_discover', { app: { a: 1 } }, ['/app']],
  ['ssam_grant', { app: 5 }, ['/app', '/action']],
];

for (const [layout, presentation] of Object.entries(LAYOUTS)) {
  test(`item 6 (${layout}): the INPUT_INVALID refusals keep their argument pointers in error and violations[].path, through the gate`, async () => {
    // The layout in force: a whole value that is exactly a root of the image is withheld there, and stays on this machine.
    const s = await session({ presentation: presentation(), synthetic: { ok: true, value: '/app' } });
    try {
      assert.equal((await s.once(SYNTHETIC, {})).body.value, presentation() ? '<server>' : '/app', 'the presenter sees the layout of ' + layout);
      for (const [name, args, pointers] of REFUSALS) {
        const { body, text } = await s.once(name, args);
        const said = name + ' ' + JSON.stringify(args) + ': ' + JSON.stringify(body).slice(0, 600);
        assert.equal(body.code, 'INPUT_INVALID', said);
        assert.deepEqual(body.violations.map(v => v.path), pointers, said);
        for (const pointer of pointers) assert.match(body.error, new RegExp('(?:^|[\\s:;])' + escape(pointer) + ' (?:expected|is required)'), said);
        assert.doesNotMatch(body.error, /<server>/, said);
        assert.doesNotMatch(text, /<server>/, 'the text of the answer too: ' + said);
      }
      // ssam_debug_run (applicationKey) is not served hosted: its refusal comes before the input check and breaks no pointer.
      const { body: debug, text } = await s.once('ssam_debug_run', { applicationKey: 5 });
      assert.equal(debug.code, 'HOSTED_UNAVAILABLE', JSON.stringify(debug));
      assert.doesNotMatch(text, /<server>(?:licationKey|s expected|lication)/, text);
    } finally { await s.close(); }
  });

  test(`item 6 (${layout}): through the rule and the gate, a POSIX root is a server path only as a whole segment; a pointer is no path`, async () => {
    const withheld = { '/opt/ssam/x.json': '<server>', '/data/server/state/day.json': '<server>', '/tmp/a.json.': '<server>.' };
    const kept = ['/options/0', '/applicationKey', '/apps', '/variables/0', '/tmpl/x', '/data/serverName'];
    const value = { ok: false, code: 'SYNTHETIC',
      error: 'could not read /opt/ssam/x.json for the call; the day is in /data/server/state/day.json; it wrote /tmp/a.json.',
      message: kept.map(p => p + ' expected string').join('; '),
      fix: '/app expected string, received integer; /tmp is required',
      violations: [{ path: '/app', message: 'expected string, received integer' }, { path: '/tmp', message: 'is required' }],
      details: { note: '/app expected string (the pointer of this answer); /app/kernel/.local/cli/anvil.dll is a server file' },
      day: '/data/server/state/day.json', pointers: kept };
    const s = await session({ presentation: presentation(), synthetic: value });
    try {
      const { body, text } = await s.once(SYNTHETIC, {});
      const said = JSON.stringify(body);
      assert.equal(body.error, 'could not read <server> for the call; the day is in <server>; it wrote <server>.', said);
      assert.equal(body.message, value.message, 'every pointer that only starts like a root stays: ' + said);
      assert.equal(body.fix, value.fix, 'a pointer the answer names in violations[].path stays, even a root of the image: ' + said);
      assert.deepEqual(body.violations.map(v => v.path), ['/app', '/tmp'], said);
      assert.equal(body.details.note, '/app expected string (the pointer of this answer); <server> is a server file', 'the pointers reach every text below the answer; a real path beside them goes: ' + said);
      // a whole value in a field that is no prose: withheld by the presenter where it is a folder of the server (the image), and
      // since a9 (the marco-a6 path family of the rule: a whole server path that is no handle and not the caller's) on this
      // machine too
      assert.equal(body.day, withheld['/data/server/state/day.json'], said);
      assert.deepEqual(body.pointers, kept, said);
      assert.equal(text, JSON.stringify(body), 'the text answer is the structured one');
    } finally { await s.close(); }
  });
}

test('item 6, the presenter alone (image layout): end of segment, the period left out, the pointers of the answer held', () => {
  const present = policy.presenter(imageLayout());
  // (a whole value that starts at a root is withheld whole; inside a text the period that ends the sentence stays)
  for (const [given, shown] of [['/tmp/a.json.', '<server>'], ['it wrote /tmp/a.json.', 'it wrote <server>.'], ['/data/server/state/day.json', '<server>'],
    ['in /tmp.', 'in <server>.'], ['disk full under /data/server: no room', 'disk full under <server>: no room'], ['/app/kernel/x', '<server>'], [IMAGE_WS + '/o11/answers/a.json.', 'ws:o11/answers/a.json.']])
    assert.equal(present.string(given), shown, given);
  for (const same of ['/options/0', '/applicationKey', '/apps expected array', '/variables/0', '/tmpl/x', '/data/serverName', '/homepage', '/application/x'])
    assert.equal(present.string(same), same, same);
  const answer = { ok: false, code: 'INPUT_INVALID', error: '2 argument problem(s): /app expected string; /tmp is required; /app/kernel/x is not a pointer',
    violations: [{ path: '/app', message: 'expected string' }, { path: '/tmp', message: 'is required' }] };
  const out = present.result({ content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer }).structuredContent;
  assert.equal(out.error, '2 argument problem(s): /app expected string; /tmp is required; <server> is not a pointer');
  assert.deepEqual(out.violations.map(v => v.path), ['/app', '/tmp']);
  // Without the answer naming them, a root is a root (a value of the server, never a pointer by guess).
  assert.equal(present.string('see /app expected string'), 'see <server> expected string');
  assert.equal(present.string('/app expected string'), '<server>', 'a whole value that starts at a root is withheld whole, as before');
});
