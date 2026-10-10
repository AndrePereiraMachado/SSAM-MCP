// A15 over the whole server (package of 2026-10-06, lane F7a): relaxTool applied to every registration, as F7b wires it
// into ssam.mjs (I1), simulated here by wrapping McpServer.prototype.registerTool in this test process only (the ODC
// facade server behind the proxies included). Every tool of createSsamServer, called with arguments its own schema
// refuses, answers INPUT_INVALID with its violations and corrected arguments, and no handler runs. This proves the layer
// reads every real schema of the server (zod and fromJsonSchema); pa2-f7a-codes-contract.test.mjs proves the wiring.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { relaxTool } from '../tool-input.mjs';
import { createSsamServer } from '../ssam.mjs';

const register = McpServer.prototype.registerTool;
McpServer.prototype.registerTool = function (name, config, handler) { const relaxed = relaxTool(name, config, handler); return register.call(this, name, relaxed.config, relaxed.handler); };
process.env.SSAM_APP_HOOK_TOOLS = '1';

// Arguments the schema refuses, or null when it accepts anything (such a tool is reported, never called).
function refusedArguments(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.additionalProperties === false) return { __pa2_probe__: true };
  if (Array.isArray(schema.required) && schema.required.length) return {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const types = [].concat(property?.type ?? []);
    if (types.length && !types.includes('string')) return { [key]: '__not_a_' + types[0] + '__' };
    if (types.length === 1 && types[0] === 'string') return { [key]: { not: 'a string' } };
    if (Array.isArray(property?.enum)) return { [key]: '__not_in_enum__' };
  }
  return null;
}

test('with relaxTool on every registration, every tool of createSsamServer answers a refused input with INPUT_INVALID', async t => {
  const server = await createSsamServer({ deps: { relayTimeoutMs: 5000 } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f7a-input-all', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.ok(tools.length > 50, 'the whole server is registered');
  const problems = []; const open = [];
  for (const tool of tools) {
    const args = refusedArguments(tool.inputSchema);
    if (!args) { open.push(tool.name); continue; }
    const result = await client.callTool({ name: tool.name, arguments: args }).catch(error => ({ isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] }));
    let value = result.structuredContent;
    if (value === undefined) { try { value = JSON.parse(result.content?.[0]?.text ?? ''); } catch { value = { text: result.content?.[0]?.text }; } }
    if (result.isError !== true || value?.code !== 'INPUT_INVALID') problems.push(`${tool.name}: ${JSON.stringify(value).slice(0, 200)}`);
    else if (!(Array.isArray(value.violations) && value.violations.length && value.corrected && typeof value.corrected === 'object')) problems.push(`${tool.name}: INPUT_INVALID without violations and corrected`);
  }
  t.diagnostic(`${tools.length} tools probed; accepting any arguments (not called): ${open.join(', ') || 'none'}`);
  assert.deepEqual(problems, []);
  // the listing is the tool's own: the limits stay visible as guidance
  const discover = tools.find(x => x.name === 'ssam_discover');
  assert.equal(discover.inputSchema.properties.budgetBytes.minimum, 4096);
});
