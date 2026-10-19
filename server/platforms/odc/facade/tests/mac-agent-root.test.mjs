// An agent on macOS (agent 0.3.2 of server/agent-mac, docs/AGENTE-MAC.md) reports a POSIX folder in its Hello
// (agent.root = /Users/<user>/SSAM-Agent) and agent.platform 'darwin'. Every place of the server that names a path of
// the user's machine follows the folder the agent reported: C26 (a path under the agent folder is its agent: path; any
// other one names the exact inbox file), the hosted doctor and instructions (agent.inbox), the prototype source, the
// ssam_code plan (onMachine), the fragment preview; and the answer for an agent that is not connected names the macOS
// launcher. A Windows folder keeps every answer it had (the other tests of these modules).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentPath, outsideWorkspaceRefusal, agentJoin, isAgentMachinePath, isPosixRoot, INLINE_JOB_MARKER } from '../agent-paths.mjs';
import { wrapHostedTool, agentNotConnected, RESTART_AFTER_MS } from '../hosted/policy.mjs';
import { hostedDoctor, hostedInstructions } from '../ssam.mjs';
import { allowedSource } from '../prototype/archive.mjs';
import { hostedCode } from '../hosted/code.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const agentRoot = '/Users/ana/SSAM-Agent';

test('macOS folder: a path under it maps to agent:<rel> (case and NFC ignored, as APFS); every other path does not', () => {
  assert.equal(agentPath('/Users/ana/SSAM-Agent/inbox/job.json', { agentRoot }), 'agent:inbox/job.json');
  assert.equal(agentPath('/users/ANA/ssam-agent/Inbox/lab/02/job.json', { agentRoot }), 'agent:inbox/lab/02/job.json');
  assert.equal(agentPath('/Users/ana/SSAM-Agent/odc/snapshots/A.oml', { agentRoot: agentRoot + '/' }), 'agent:odc/snapshots/A.oml');
  assert.equal(agentPath('/Users/jo\u0061\u0303o/SSAM-Agent/o11/x.json', { agentRoot: '/Users/jo\u00e3o/SSAM-Agent' }), 'agent:o11/x.json');
  for (const outside of ['/Users/ana/SSAM-Agent/private/credential', '/Users/ana/SSAM-Agent/inbox', '/Users/ana/SSAM-Agent-2/inbox/x.json', '/Users/ana/Downloads/job.json',
    '/Users/ana/SSAM-Agent/inbox/../private/x.json', 'inbox/job.json', 'C:\\SSAM-Agent\\inbox\\x.json', '//server/share/inbox/x.json', '/Users/ana/SSAM-Agent/inbox/a\u0000b'])
    assert.equal(agentPath(outside, { agentRoot }), null, outside);
  // A Windows folder never takes a POSIX path, and the other way round.
  assert.equal(agentPath('/Users/ana/SSAM-Agent/inbox/job.json', { agentRoot: 'C:\\SSAM-Agent' }), null);
  assert.equal(agentPath('C:\\SSAM-Agent\\inbox\\job.json', { agentRoot: 'C:\\SSAM-Agent' }), 'agent:inbox/job.json');
});

test('macOS folder: the refusal names the exact inbox file with / and the same call; the helpers join by the folder style', () => {
  const temp = '/var/folders/x1/abc/T/claude/scratch/job.json';
  const refused = outsideWorkspaceRefusal(temp, { agentRoot, tool: 'studio_deliver', args: { job: temp, module: 'Shop' } });
  assert.match(refused.fix, /\/Users\/ana\/SSAM-Agent\/inbox\/job\.json with the Write tool \(UTF-8\)/);
  assert.equal(refused.inbox, '/Users/ana/SSAM-Agent/inbox');
  assert.equal(refused.agentRoot, '/Users/ana/SSAM-Agent');
  assert.deepEqual(refused.continuation.arguments, { job: INLINE_JOB_MARKER, module: 'Shop' });
  const oml = outsideWorkspaceRefusal('/Users/ana/Downloads/Quotes.oml', { agentRoot, tool: 'studio_open', args: { module: 'Quotes' }, field: 'localOml' });
  assert.match(oml.fix, /^write \/Users\/ana\/SSAM-Agent\/inbox\/Quotes\.oml with the Write tool \(UTF-8\) and pass agent:inbox\/Quotes\.oml$/);
  assert.equal(agentJoin(agentRoot, 'inbox'), '/Users/ana/SSAM-Agent/inbox');
  assert.equal(agentJoin(agentRoot, 'odc', 'lab', 'p.html'), '/Users/ana/SSAM-Agent/odc/lab/p.html');
  assert.equal(agentJoin('C:\\SSAM-Agent', 'inbox'), 'C:\\SSAM-Agent\\inbox');
  assert.equal(isPosixRoot(agentRoot), true); assert.equal(isPosixRoot('C:\\SSAM-Agent'), false); assert.equal(isPosixRoot('//server/x'), false);
  assert.equal(isAgentMachinePath('/Users/ana/SSAM-Agent/inbox/x', agentRoot), true);
  assert.equal(isAgentMachinePath('/Users/ana/SSAM-Agent/inbox/x', 'C:\\SSAM-Agent'), false, 'a POSIX path means the agent machine only with a POSIX agent folder');
  assert.equal(isAgentMachinePath('C:\\SSAM-Agent\\inbox\\x', 'C:\\SSAM-Agent'), true);
});

function harness(info) {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, info });
  const pulls = [];
  const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const executor = { id: 'fake', hosted: true, quota: { full: () => false }, o11Connection: () => null,
    async call(kind, params) { return kind === 'studio.processes' ? { processes: [{ pid: 4120, path: '/Applications/ODC Studio.app/Contents/MacOS/ODC Studio', version: '1.7.28.10873' }] } : {}; },
    async pullFile(value) { pulls.push(value); return write(path.join(dirs.workspace, ...value.slice(6).split('/')), '{"ops":[{"op":"find","name":"x"}]}'); } };
  const context = { id: 'ctx', hosted: true, tokenId: 'tok_mac', customer: 'Mac', lanes: ['odc'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const gate = name => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, async args => { calls.push({ name, args }); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; },
      { context, link, lanes: ['odc'], run: (ctx, fn) => fn() });
    return (args = {}) => wrapped(args, { requestId: 1 });
  };
  return { ...dirs, link, context, calls, pulls, gate };
}

test('C26 on a Mac: the gate brings a path under the agent folder as its agent: path, and names the exact inbox file for any other one', async () => {
  const h = harness({ agentRoot, agentPlatform: 'darwin' });
  const deliver = h.gate('studio_deliver');
  await deliver({ job: '/Users/ana/SSAM-Agent/inbox/cart.json', module: 'Shop', feature: 'cart', owners: ['a'], changes: ['b'] });
  assert.deepEqual(h.pulls, ['agent:inbox/cart.json']);
  assert.equal(h.calls[0].args.job, path.join(h.workspace, 'inbox', 'cart.json'));
  const outside = (await deliver({ job: '/Users/ana/Library/Caches/claude/job.json', module: 'Shop' })).structuredContent;
  assert.equal(outside.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.match(outside.fix, /\/Users\/ana\/SSAM-Agent\/inbox\/job\.json/);
  assert.equal(outside.inbox, '/Users/ana/SSAM-Agent/inbox');
  assert.equal(h.calls.length, 1, 'the refused call never ran');
});

test('the hosted doctor and instructions name the macOS inbox; the prototype source and the ssam_code plan name macOS paths', async () => {
  const h = harness({ agentRoot, agentPlatform: 'darwin' });
  const report = await hostedDoctor(null, { context: h.context, session: { agent: h.link } });
  assert.equal(report.agent.root, agentRoot);
  assert.equal(report.agent.inbox, '/Users/ana/SSAM-Agent/inbox');
  assert.match(hostedInstructions({ context: { agent: { info: () => ({ agentRoot }) } } }), / The agent inbox folder of this account is \/Users\/ana\/SSAM-Agent\/inbox\.$/);
  assert.deepEqual(allowedSource('agent:inbox/proto.zip', { agentRoot }), { ok: true, path: '/Users/ana/SSAM-Agent/inbox/proto.zip' });
  const refused = allowedSource('/Users/ana/Downloads/proto.zip', { agentRoot });
  assert.equal(refused.ok, false);
  assert.match(refused.fix, /into \/Users\/ana\/SSAM-Agent\/inbox and give data\.source as agent:inbox/);
  const code = hostedCode({ workspace: h.workspace, agent: { info: () => ({ agentRoot }) } });
  assert.equal(code.place.input(path.join(h.workspace, 'odc', 'lab', 'plan', 'prompt.md')), '/Users/ana/SSAM-Agent/odc/lab/plan/prompt.md');
});

test('an agent of a Mac that is not connected or reconnects: the answer names agent/ssam-agent.sh and the macOS guide (Windows unchanged)', () => {
  const now = Date.parse('2026-10-19T12:00:00.000Z');
  const never = agentNotConnected({ agentPlatform: 'darwin' }, { now });
  assert.match(never.continuation.why, /~\/SSAM-Agent\/agent\/ssam-agent\.sh start, see docs\/AGENTE-MAC\.md/);
  const quiet = agentNotConnected({ agentPlatform: 'darwin', instance: 'i', lastSeenAt: new Date(now - RESTART_AFTER_MS - 1000).toISOString() }, { now });
  assert.match(quiet.continuation.why, /agent\/ssam-agent\.sh status/);
  const windows = agentNotConnected({ agentPlatform: 'win32' }, { now });
  assert.match(windows.continuation.why, /agent\\ssam-agent\.ps1 start, see docs\/AGENTE-CLIENTE\.md/);
  assert.equal(agentNotConnected(null, { now }).continuation.why, windows.continuation.why, 'an agent never seen keeps the Windows answer');
});
