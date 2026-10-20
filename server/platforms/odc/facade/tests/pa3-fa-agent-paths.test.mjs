// Atritos 3, lane fa, C26: the agent's inbox is said before it is needed. A path under the agent root in inbox/, odc/ or
// o11/ becomes agent:<rel>; any other path is refused with the exact place to copy the file into as it is (the inbox; a9
// follow-up M2: never rewritten with the Write tool) and the same call with agent:inbox/<name>. Pure; the hosted server binds it (server line).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentPath, outsideWorkspaceRefusal, PATH_OUTSIDE_WORKSPACE, INLINE_JOB_MARKER } from '../agent-paths.mjs';

const agentRoot = 'C:\\SSAM-Agent';

test('C26: a path under the agent root maps to agent:<rel> (case and separators ignored)', () => {
  assert.equal(agentPath('C:\\SSAM-Agent\\inbox\\job.json', { agentRoot }), 'agent:inbox/job.json');
  assert.equal(agentPath('c:/ssam-agent/Inbox/lab/02/job.json', { agentRoot }), 'agent:inbox/lab/02/job.json');
  assert.equal(agentPath('C:\\SSAM-Agent\\odc\\snapshots\\A.oml', { agentRoot: 'C:\\SSAM-Agent\\' }), 'agent:odc/snapshots/A.oml');
  assert.equal(agentPath('C:\\SSAM-Agent\\o11\\x.json', { agentRoot }), 'agent:o11/x.json');
  for (const outside of ['C:\\SSAM-Agent\\secrets\\x.json', 'C:\\SSAM-Agent\\inbox', 'C:\\SSAM-Agent-2\\inbox\\x.json', 'C:\\Users\\a\\AppData\\Local\\Temp\\job.json',
    'C:\\SSAM-Agent\\inbox\\..\\vault\\x.json', 'inbox\\job.json'])
    assert.equal(agentPath(outside, { agentRoot }), null, outside);
  assert.equal(agentPath('C:\\SSAM-Agent\\inbox\\job.json', {}), null);
});

test('C26: a path outside is refused with the exact inbox path, copied as it is, and the same call with agent:inbox/<name>', () => {
  const temp = 'C:\\Users\\a\\AppData\\Local\\Temp\\claude\\scratch\\job.json';
  const refused = outsideWorkspaceRefusal(temp, { agentRoot, tool: 'studio_deliver', args: { job: temp, module: 'Shop' } });
  assert.equal(refused.code, PATH_OUTSIDE_WORKSPACE);
  assert.match(refused.fix, /C:\\SSAM-Agent\\inbox\\job\.json/);
  assert.match(refused.fix, /copy job\.json as it is into C:\\SSAM-Agent\\inbox\\job\.json \(Copy-Item; never rewrite/);
  assert.doesNotMatch(refused.fix, /Write tool/);
  assert.match(refused.fix, /agent:inbox\/job\.json/);
  assert.equal(refused.inbox, 'C:\\SSAM-Agent\\inbox');
  assert.equal(refused.continuation.tool, 'studio_deliver');
  assert.equal(outsideWorkspaceRefusal(temp, {}).continuation.tool, 'ssam_doctor', 'without a tool, the doctor shows the folder');
  // fase4-24: a job goes inline (one request straight to the server): the fix says so first, the continuation carries the marker.
  assert.match(refused.fix, /^send the job itself inline in job \(its JSON, compact\) in the same call/);
  assert.deepEqual(refused.continuation.arguments, { job: INLINE_JOB_MARKER, module: 'Shop' });
  // Any other file of the user (an OML) still goes to the inbox.
  const oml = 'C:\\Users\\a\\Downloads\\Quotes.oml';
  const file = outsideWorkspaceRefusal(oml, { agentRoot, tool: 'studio_open', args: { module: 'Quotes', localOml: oml }, field: 'localOml' });
  assert.match(file.fix, /^copy Quotes\.oml as it is into C:\\SSAM-Agent\\inbox\\Quotes\.oml \(Copy-Item; never rewrite its content: a rewritten file can come back cut or changed\) and pass agent:inbox\/Quotes\.oml$/);
  assert.deepEqual(file.continuation.arguments, { module: 'Quotes', localOml: 'agent:inbox/Quotes.oml' });
});
