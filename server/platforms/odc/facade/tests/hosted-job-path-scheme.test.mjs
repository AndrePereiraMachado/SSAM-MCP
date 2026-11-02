// fase4-28 r4-rest-hosted (the blind test of the hosted generators, C:\t\r4\tmp-rest-blind): two holes of the hosted job-path
// confinement, for every tool and op, not one op.
//   - A URL of any scheme at a path argument (file:///..., file:C:\..., http://...) was taken as a relative name under the
//     workspace (a file: URL became ws:o11/file:/C:/...): nothing leaked, but it is no path of this account. Now
//     PATH_OUTSIDE_WORKSPACE, like any other path outside; ws:, agent: and local: keep their meaning, a drive letter is a path.
//   - A composite part reached through a junction that leads out stays refused before the handler. It is answered as an
//     unreadable prototype (HOSTED_UNAVAILABLE, PROTOTYPE_IMPORT_DISABLED): D2 of fase4-25 asks the prototype first, before the
//     paths, and a part the gate could not read may hold one (hosted-job-paths.test.mjs, hosted-prototype.test.mjs); kept.
// Fakes only: no hub, agent or Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const TOOLS = ['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job'];
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; };
const PLAIN = { ops: [{ op: 'entity', data: { name: 'Order', attributes: [{ name: 'Title', type: 'Text' }] } }] };

function harness() {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot });
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }),
    async call(kind) { throw Object.assign(new Error('no machine call: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); },
    async pullFile() { throw Object.assign(new Error('nothing to bring'), { code: 'FILE_NOT_FOUND' }); } };
  const context = { id: 'ctx-scheme', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const gate = name => {
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, async args => { calls.push({ name, args }); return { content: [], structuredContent: { ok: true } }; },
      { context, link, lanes: context.lanes, run: (ctx, fn) => fn(), waitMs: 10 });
    return args => wrapped(args, { requestId: 1 });
  };
  const lane = name => (name === 'studio_deliver' ? { feature: 'F', module: 'M' } : name === 'ssam_job' ? { lane: 'o11' } : { module: 'M' });
  return { ...dirs, calls, gate, lane, ws: (...p) => path.join(dirs.workspace, ...p) };
}

test('a URL of any scheme at the job argument is PATH_OUTSIDE_WORKSPACE in the four job tools; ws:, a relative name and an inside absolute path still run', async () => {
  const h = harness();
  const outside = write(path.join(h.root, 'outside', 'job.json'), PLAIN);
  write(h.ws('o11', 'jobs', 'plain.json'), PLAIN);
  write(h.ws('odc', 'jobs', 'plain.json'), PLAIN);
  const urls = ['file:///' + outside.replace(/\\/g, '/'), 'file:' + outside, 'FILE://localhost/' + outside.replace(/\\/g, '/'), 'http://127.0.0.1:9/job.json', 'https://example.com/job.json', 'ftp://host/job.json'];
  for (const name of TOOLS) {
    for (const job of urls) {
      const result = await h.gate(name)({ ...h.lane(name), job });
      assert.equal(result.isError, true, name + ' ' + job);
      assert.equal(result.structuredContent.code, 'PATH_OUTSIDE_WORKSPACE', name + ' ' + job + ': ' + JSON.stringify(result.structuredContent).slice(0, 300));
    }
  }
  assert.deepEqual(h.calls, [], 'no handler ran');
  for (const name of ['o11_deliver', 'o11_job']) {
    for (const job of ['ws:o11/jobs/plain.json', 'jobs/plain.json', h.ws('o11', 'jobs', 'plain.json')]) {
      const result = await h.gate(name)({ ...h.lane(name), job });
      assert.notEqual(result.isError, true, name + ' ' + job + ': ' + JSON.stringify(result.structuredContent).slice(0, 300));
    }
  }
});

test('a composite part reached through a junction that leads out is refused before the handler (D2: the prototype rule answers first)', async () => {
  const h = harness();
  write(path.join(h.root, 'outside', 'part.json'), PLAIN);
  fs.mkdirSync(h.ws('inbox'), { recursive: true });
  fs.symlinkSync(path.join(h.root, 'outside'), h.ws('inbox', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  write(h.ws('odc', 'lab', 'composite.json'), { jobs: ['../../inbox/link/part.json'] });
  for (const name of TOOLS) {
    const value = (await h.gate(name)({ ...h.lane(name), job: 'ws:odc/lab/composite.json' })).structuredContent;
    assert.equal(value.ok, false, name);
    assert.ok(value.code === 'PATH_OUTSIDE_WORKSPACE' || (value.code === 'HOSTED_UNAVAILABLE' && value.cause === 'PROTOTYPE_IMPORT_DISABLED'), name + ': ' + JSON.stringify(value).slice(0, 300));
    assert.equal(value.outcome ?? 'not-sent', 'not-sent', name);
  }
  assert.deepEqual(h.calls, []);
});
