// The warning about a lane's Studio (fase4-28 R1, review item F3): it changes nothing in the answer, so it goes in full
// once per MCP session and lane the tool touched, and again only when that lane's verdict changes. A version refusal is
// not a warning: it always comes whole. The session's gate (ssam.mjs hostedGate) makes one memory per MCP session; here
// the gates of one session share it (hosted/policy.mjs studioNoticeMemory) and a second session has its own. Fake link,
// context and executor: no hub, no agent, no Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as policy from '../hosted/policy.mjs';
import { compatibility } from '../agent-hub.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
// (read through the namespace, so the same file runs against a gate without the memory and shows what it repeats)
const { wrapHostedTool } = policy;
const studioNoticeMemory = () => policy.studioNoticeMemory?.() ?? null;
const BUILT = { o11: '11.55.92', odc: '1.7.28', odcBridge: 'v97', builds: { odc: '1.7.28.5000', o11: '11.55.92.6000' } };
const REFUSE = { ...BUILT, studioBuildPolicy: 'refuse' };
// Both Studios of the user (installed builds), judged against the kernel the server runs.
const studios = (odc, o11, kernel = BUILT) => {
  const installed = { odc: { installed: { version: odc } }, o11: { installed: { version: o11 } } };
  const hello = { pack: { lanes: ['odc', 'o11'], odcBridge: 'v97', o11BuiltFor: '11.55.92.6000' }, studios: installed };
  return { kernel, studios: installed, compatible: compatibility(hello, kernel, ['odc', 'o11']) };
};
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

function session(info, { lanes = ['odc', 'o11'], memory = studioNoticeMemory() } = {}) {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, info });
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }), async call() { return {}; } };
  const context = { id: 'ctx-1', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes, workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const ran = [];
  const tools = new Map();
  const call = (name, args = {}) => {
    if (!tools.has(name)) tools.set(name, wrapHostedTool(name, { inputSchema: {} }, async a => { ran.push(name); return reply({ ok: true, tool: name, args: a }); },
      { context, link, lanes, run: (ctx, fn) => fn(), studioNotices: memory }));
    return tools.get(name)(args, { requestId: 1 }).then(r => r.structuredContent);
  };
  return { link, call, ran, memory };
}
// studioWarning is the first of studioWarnings when there are several (the shape of studioVerdict).
const lanesOf = answer => (answer.studioWarnings ?? [answer.studioWarning]).filter(Boolean).map(w => w.lane);

test('the same session: the first answer of a lane carries its warning in full, the next ones do not', async () => {
  const s = session(studios('1.7.28.5023', '11.55.92.6000'));
  const first = await s.call('studio_status');
  assert.deepEqual({ code: first.studioWarning?.code, lane: first.studioWarning?.lane, installed: first.studioWarning?.installed },
    { code: 'studioBuildDiffers', lane: 'odc', installed: '1.7.28.5023' });
  assert.match(first.studioWarning.userMessage, /^Warning: /);
  for (const [name, args] of [['studio_status', {}], ['ssam_discover', { intent: 'x', lane: 'odc' }], ['studio_deliver', { module: 'M', job: { ops: [] } }]]) {
    const again = await s.call(name, args);
    assert.equal(again.ok, true, name);
    assert.equal(again.studioWarning, undefined, name + ': already shown in this session');
    assert.equal(again.studioWarnings, undefined, name);
  }
  assert.deepEqual(s.ran, ['studio_status', 'studio_status', 'ssam_discover', 'studio_deliver'], 'every call ran');
  // another MCP session of the same token has its own memory
  const other = session(studios('1.7.28.5023', '11.55.92.6000'));
  assert.equal((await other.call('studio_status')).studioWarning?.code, 'studioBuildDiffers');
});

test('a lane the tool does not touch never carries a warning; a tool of both lanes carries only the lanes not yet shown', async () => {
  const s = session(studios('1.7.28.5023', '11.55.92.6011'));
  const o11 = await s.call('ssam_discover', { intent: 'x', lane: 'o11' });
  assert.deepEqual(lanesOf(o11), ['o11'], 'an O11 tool: the Service Studio only');
  assert.deepEqual(lanesOf(await s.call('ssam_discover', { intent: 'x', lane: 'o11' })), []);
  // ssam_connect without a lane touches both: the ODC warning is new, the O11 one was shown
  const both = await s.call('ssam_connect');
  assert.deepEqual(lanesOf(both), ['odc']);
  assert.equal(both.studioWarnings, undefined, 'one warning, never repeated in studioWarnings');
  assert.deepEqual(lanesOf(await s.call('ssam_connect')), []);
});

test('the warning comes back when the verdict of the lane changes, and after the lane was served without one', async () => {
  const s = session(studios('1.7.28.5023', '11.55.92.6000'));
  assert.equal((await s.call('studio_status')).studioWarning?.installed, '1.7.28.5023');
  assert.equal((await s.call('studio_status')).studioWarning, undefined);
  // the user installed another build: a new verdict, in full again
  s.link.setInfo(studios('1.7.28.5031', '11.55.92.6000'));
  assert.equal((await s.call('studio_status')).studioWarning?.installed, '1.7.28.5031');
  assert.equal((await s.call('studio_status')).studioWarning, undefined);
  // the served build: nothing; then the other build again: in full again
  s.link.setInfo(studios('1.7.28.5000', '11.55.92.6000'));
  assert.equal((await s.call('studio_status')).studioWarning, undefined);
  s.link.setInfo(studios('1.7.28.5031', '11.55.92.6000'));
  assert.equal((await s.call('studio_status')).studioWarning?.installed, '1.7.28.5031');
});

test('a version refusal always comes whole, every time; the doctor always reports the warnings of the lanes it shows', async () => {
  const strict = session(studios('1.7.28.5023', '11.55.92.6000', REFUSE));
  for (let i = 0; i < 3; i++) {
    const refused = await strict.call('studio_status');
    assert.deepEqual({ code: refused.code, cause: refused.cause, installed: refused.installed }, { code: 'STUDIO_VERSION_MISMATCH', cause: 'STUDIO_VERSION_NOT_SERVED_YET', installed: '1.7.28.5023' }, 'call ' + i);
    assert.match(refused.userMessage, /1\.7\.28\.5023/);
  }
  // ssam_connect {}: the refused lane is skipped, said in studioSkipped every time
  for (let i = 0; i < 2; i++) assert.deepEqual((await strict.call('ssam_connect')).studioSkipped?.map(b => [b.lane, b.cause]), [['odc', 'STUDIO_VERSION_NOT_SERVED_YET']], 'call ' + i);
  const s = session(studios('1.7.28.5023', '11.55.92.6011'));
  await s.call('studio_status'); await s.call('ssam_discover', { intent: 'x', lane: 'o11' });
  for (let i = 0; i < 2; i++) assert.deepEqual(lanesOf(await s.call('ssam_doctor')).sort(), ['o11', 'odc'], 'the doctor, call ' + i);
});
