// A22 part (package of 2026-10-06, lane F7a, interface I10): the four tools of the controlled app profile (context,
// propose, continue, status) answer only with the client hook of that profile. On the general ssam server (surface
// 'ssam') they are listed only with SSAM_APP_HOOK_TOOLS=1; the app profile server (surface 'ssam_hybrid', the default)
// always lists them. Real case: a Codex session called status and got "The trusted client hook did not authorize this
// exact tool call". In-process servers, no host call.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11AppSession, appSessionToolsServed, APP_SESSION_TOOLS } from '../o11-app-session.mjs';

const neverRun = async () => { throw new Error('the host must not run'); };
async function listed(deps) {
  const server = new McpServer({ name: 'pa2-f7a-hooks', version: '1.0.0' });
  const session = registerO11AppSession(server, { runAnvil: neverRun, bridgeFor: neverRun, ...deps });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f7a-hooks-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try { return { names: (await client.listTools()).tools.map(t => t.name).sort(), session }; } finally { await client.close(); await server.close(); }
}

test('surface ssam hides the hook tools unless SSAM_APP_HOOK_TOOLS=1', async () => {
  assert.deepEqual([...APP_SESSION_TOOLS].sort(), ['context', 'continue', 'propose', 'status']);
  const hidden = await listed({ surface: 'ssam', env: {} });
  assert.deepEqual(hidden.names, []);
  assert.equal(typeof hidden.session.call, 'function', 'the session object is still returned');
  assert.deepEqual((await listed({ surface: 'ssam', env: { SSAM_APP_HOOK_TOOLS: '0' } })).names, []);
  assert.deepEqual((await listed({ surface: 'ssam', env: { SSAM_APP_HOOK_TOOLS: '1' } })).names, ['context', 'continue', 'propose', 'status']);
});

test('surface ssam_hybrid (the default: the controlled app profile) always shows them', async () => {
  assert.deepEqual((await listed({ env: {} })).names, ['context', 'continue', 'propose', 'status']);
  assert.deepEqual((await listed({ surface: 'ssam_hybrid', env: {} })).names, ['context', 'continue', 'propose', 'status']);
  assert.equal(appSessionToolsServed({ surface: 'ssam', env: {} }), false);
  assert.equal(appSessionToolsServed({ surface: 'ssam', env: { SSAM_APP_HOOK_TOOLS: '1' } }), true);
  assert.equal(appSessionToolsServed({}), true);
});
