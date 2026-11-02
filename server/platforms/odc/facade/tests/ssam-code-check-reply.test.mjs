import './fixtures/isolated-profile.mjs';
// Wave 2 of the proto (C-33, F-FT-11; ported from proto 965f4cc5): every successful ssam_code check answered "Invalid tools/call result ... expected string, received
// symbol" (7 + 4 calls): the answer keeps the candidate of the check under a symbol key for the next write
// (code-check.mjs CHECK_CANDIDATE), and that key reached structuredContent. Through a real MCP client and server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport, McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerSsamCode } from '../ssam-code.mjs';
import { CHECK_CANDIDATE } from '../code-check.mjs';

test('C-33: a successful check answers through MCP; the candidate symbol stays inside the server', async t => {
  const server = new McpServer({ name: 'c33-check', version: '1' });
  const answer = { ok: true, lane: 'o11', module: 'Fitmaker', action: 'check', valid: true, verifyRan: true, job: 'C:/t/job.json', jobSha256: 'a'.repeat(64) };
  answer[CHECK_CANDIDATE] = { path: 'C:/t/candidate.oml', sha256: 'b'.repeat(64) };
  registerSsamCode(server, { fromJsonSchema, map: async () => { throw Error('unexpected read'); }, deliver: async () => { throw Error('unexpected delivery'); }, check: async () => answer });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c33-client', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'ssam_code', arguments: { lane: 'o11', action: 'check', module: 'Fitmaker', part: 'logic', text: 'server action A\n  end\n' } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.valid, true);
  assert.deepEqual(Object.getOwnPropertySymbols(result.structuredContent), []);
  // The server keeps it for the write that follows (code-draft.mjs reads it before the answer is shaped).
  assert.equal(answer[CHECK_CANDIDATE].path, 'C:/t/candidate.oml');
});
