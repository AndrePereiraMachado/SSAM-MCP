// A20 contract (package of 2026-10-06, lane F7a): every tool the ssam server registers (createSsamServer) answers a refusal
// with an UPPER_SNAKE code. Each tool is called once with arguments its own listed schema refuses (an unknown field, the
// required fields left out, or a value of the wrong type), so no handler ever runs: before the central input layer the SDK
// refused them with a code-less text ("Input validation error: ..."); with relaxTool wired into ssam.mjs (F7b, I1) each one
// is INPUT_INVALID with its violations and corrected arguments. Green only after the merge with F7b (contract section 6).
// In-process server, no Studio, no tool runs.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';

const CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
process.env.SSAM_APP_HOOK_TOOLS = '1';

// Arguments the schema refuses, or null when it accepts anything (such a tool is reported, never called).
export function refusedArguments(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.additionalProperties === false) return { __pa2_contract_probe__: true };
  if (Array.isArray(schema.required) && schema.required.length) return {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const types = [].concat(property?.type ?? []);
    if (types.length && !types.includes('string')) return { [key]: '__not_a_' + types[0] + '__' };
    if (types.length === 1 && types[0] === 'string') return { [key]: { not: 'a string' } };
    if (Array.isArray(property?.enum)) return { [key]: '__not_in_enum__' };
  }
  return null;
}

test('every refusal of every tool of createSsamServer carries an UPPER_SNAKE code (input violations included)', async t => {
  const server = await createSsamServer({ deps: { relayTimeoutMs: 5000 } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f7a-codes-contract', version: '1.0.0' });
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
    if (result.isError !== true) problems.push(`${tool.name}: refused arguments ${JSON.stringify(args)} were accepted`);
    else if (!CODE.test(value?.code ?? '')) problems.push(`${tool.name}: refusal without an UPPER_SNAKE code: ${JSON.stringify(value).slice(0, 160)}`);
    else if (value.code === 'INPUT_INVALID' && !(Array.isArray(value.violations) && value.violations.length && value.corrected)) problems.push(`${tool.name}: INPUT_INVALID without violations and corrected`);
  }
  t.diagnostic(`${tools.length} tools probed; accepting any arguments (not called): ${open.join(', ') || 'none'}`);
  assert.deepEqual(problems, []);
});
