// r40 integration: the two agent capabilities of r40 are chosen by the Hello's kinds, never by the app version, and each one
// alone keeps its own gate. credential.session (r40a: agent 0.3.11 / 0.4.8-native, app 0.2.3) and document.fetch (r40: agent
// 0.3.12 / 0.4.9-native, app 0.2.4, which lists both). The apps 0.2.1/0.2.2 list neither and keep the refusals of before, with
// the fix that names the update; an r40a agent gets the private credential path and still the document refusal, whose fix names
// the versions that download. Fakes only: no hub, agent, Studio or network.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { CredentialAgent, CREDENTIAL_KIND } from '../hosted/credential-agent.mjs';
import { wrapHostedTool, privateCredentialPath } from '../hosted/policy.mjs';
import { CALL_KINDS, HELLO_ONLY_KINDS } from '../call-kinds.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
// The Hello kinds of each agent (agent/lib/kinds.mjs helloKinds with a renderer and the XIF engine host).
const OLD = ['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected', 'file.put', 'file.get', 'file.list',
  'file.sync', 'net.probe', 'file.upload', 'o11.users', 'screen.render', 'o11.xif'];
const HELLOS = {
  'app 0.2.2 (agent 0.3.10)': OLD,
  'app 0.2.3 (r40a, agent 0.3.11)': [...OLD, 'credential.session'],
  'app 0.2.4 (r40, agent 0.3.12)': [...OLD, 'document.fetch', 'credential.session'],
};
// The hub's supports() over a Hello (agent-hub.mjs): the kinds it lists.
const supportsOf = kinds => kind => kinds.includes(kind);

test('both r40 kinds are in the closed lists, sent only to an agent whose Hello lists them', () => {
  assert.deepEqual(CALL_KINDS.slice(-2), ['credential.session', 'document.fetch']);
  for (const kind of ['credential.session', 'document.fetch']) assert.ok(HELLO_ONLY_KINDS.has(kind), kind);
  assert.equal(CREDENTIAL_KIND, 'credential.session');
});

for (const [label, kinds] of Object.entries(HELLOS)) {
  const fetches = kinds.includes('document.fetch'), credentials = kinds.includes('credential.session');

  test(`${label}: the document state and the private credential path follow the Hello's kinds`, () => {
    const dirs = hostedDirs(os.tmpdir());
    const link = { tokenId: 'tok_r40', connected: () => true, supports: supportsOf(kinds), info: () => ({}), call: async () => assert.fail('nothing is called') };
    assert.equal(new AgentExecutor({ link, workspace: dirs.workspace }).documentFetchState(), fetches ? 'ready' : 'update');
    assert.equal(new CredentialAgent({ agent: link }).supported, credentials);
    const entry = { class: 'tenant-agent', lane: 'o11' };
    assert.equal(privateCredentialPath('o11_service_center_read', entry, { session: 'vault' }, supportsOf(kinds)), credentials);
    assert.equal(privateCredentialPath('o11_service_center_read', entry, { session: 'studio' }, supportsOf(kinds)), false, 'an explicit Studio session never goes private');
    assert.equal(privateCredentialPath('odc_portal_read', { class: 'tenant-agent', lane: 'odc' }, { auth: 'portal-credential' }, supportsOf(kinds)), credentials);
  });

  test(`${label}: without credential.session the private call is refused with the update link and nothing is sent`, async () => {
    const calls = [];
    const agent = { supports: supportsOf(kinds), call: async (kind, args) => { calls.push(kind); return { available: false, authenticated: false, profiles: [] }; } };
    const credential = new CredentialAgent({ hosted: true, lanes: ['o11', 'odc'], agent });
    if (credentials) {
      await credential.call('example.outsystemscloud.com', 'service-center', 'status');
      assert.deepEqual(calls, ['credential.session']);
      return;
    }
    await assert.rejects(credential.call('example.outsystemscloud.com', 'service-center', 'status'),
      e => e.code === 'HOSTED_STUDIO_SESSION_ONLY' && /Update the SSAM Agent from https:\/\/dist\.ssam\.pro\/u\/ssam-agent/.test(e.message));
    await assert.rejects(credential.call('example.outsystems.dev', 'odc-portal', 'prompt'), e => e.code === 'HOSTED_PROMPT_UNAVAILABLE');
    assert.deepEqual(calls, []);
  });

  test(`${label}: an unsampled rest-consume passes the gate only with document.fetch; otherwise the refusal names 0.3.12 / 0.4.9-native / app 0.2.4`, async () => {
    const dirs = hostedDirs(os.tmpdir());
    const link = fakeAgentLink({ agentRoot: dirs.agentRoot, fetches });
    const listed = supportsOf(kinds);
    link.supports = listed;
    const executor = { id: 'fake', hosted: true, quota: { full: () => false }, o11Connection: () => ({ pid: 6001 }), async call(kind) { throw Object.assign(new Error(kind), { code: 'KIND_NOT_ALLOWED', executed: false }); } };
    const context = { id: 'ctx-r40-' + label, hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
    const handled = [];
    const wrapped = wrapHostedTool('ssam_job', { inputSchema: {} }, async args => { handled.push(args); return { content: [], structuredContent: { ok: true } }; },
      { context, link, lanes: context.lanes, run: (ctx, fn) => fn(), waitMs: 10 });
    const value = (await wrapped({ lane: 'o11', job: { ops: [{ op: 'rest-consume', data: { name: 'N', methods: [{ name: 'A', url: 'https://api.example.test/a' }] } }] } }, { requestId: 1 })).structuredContent;
    if (fetches) { assert.equal(handled.length, 1, JSON.stringify(value).slice(0, 300)); return; }
    assert.equal(value.code, 'DOCUMENT_FETCH_HOSTED_REFUSED');
    assert.equal(handled.length, 0);
    assert.match(value.fix, /the SSAM Agent 0\.3\.12 \/ 0\.4\.9-native, the SSAM Agent app 0\.2\.4 or later/);
  });
}
