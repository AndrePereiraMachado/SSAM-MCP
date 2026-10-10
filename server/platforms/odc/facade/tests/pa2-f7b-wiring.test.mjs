// Atritos 2, lane F7b: the wirings ssam.mjs owes the other lanes. I1: every tool registered on the ssam server passes through
// relaxTool of the input layer (tool-input.mjs of F7a; here a fake injected as deps.toolInput), and the relaxed handler is
// the one that answers. I10: registerO11AppSession receives surface 'ssam' (the four hook tools are registered only with
// SSAM_APP_HOOK_TOOLS=1, decided by F7a). Fakes only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as m_ssam from '../ssam.mjs';

async function connect(t, server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f7b-wiring', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('I1: every tool goes through deps.toolInput.relaxTool, and the relaxed handler answers', async t => {
  const relaxed = [];
  const toolInput = { relaxTool: (name, config, handler) => {
    relaxed.push(name);
    return { config, handler: async (...params) => {
      const result = await handler(...params);
      const value = { ...(result?.structuredContent ?? {}), inputAdjusted: [{ path: 'budgetBytes', from: 1000, to: 4096, rule: 'clamp' }] };
      return { ...result, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
    } };
  } };
  let ran = 0;
  const server = await m_ssam.createSsamServer({ o11: false, odc: false, deps: { toolInput, jobTool: async () => { ran++; return { ok: true, job: 'x' }; } } });
  const client = await connect(t, server);
  const listed = (await client.listTools()).tools.map(x => x.name);
  for (const name of ['ssam_doctor', 'ssam_job', 'o11_job', 'ssam_evidence', 'ssam_reference']) assert.ok(relaxed.includes(name), name + ' passed through relaxTool');
  assert.deepEqual(listed.filter(n => !relaxed.includes(n)), [], 'no tool of the server bypasses the input layer');
  const reply = await client.callTool({ name: 'ssam_job', arguments: { job: { ops: [] } } });
  assert.equal(ran, 1);
  assert.deepEqual(reply.structuredContent.inputAdjusted, [{ path: 'budgetBytes', from: 1000, to: 4096, rule: 'clamp' }]);
});

test('I1: without tool-input.mjs (or without relaxTool) the registrations are unchanged', async t => {
  const server = await m_ssam.createSsamServer({ o11: false, odc: false, deps: { toolInput: {}, jobTool: async () => ({ ok: true, job: 'y' }) } });
  const client = await connect(t, server);
  const reply = await client.callTool({ name: 'ssam_job', arguments: { job: { ops: [] } } });
  assert.notEqual(reply.isError, true);
  assert.equal(reply.structuredContent.inputAdjusted, undefined);
});

test('I10: registerO11AppSession receives surface "ssam" on the ssam server', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa2-f7b-wire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seen = [];
  const server = await m_ssam.createSsamServer({ odc: false, deps: {
    registerAppSession: (target, options) => { seen.push({ target, options }); },
    cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil: async () => { throw new Error('no kernel'); }, assertSelected: async () => {}, tasksDir: path.join(root, 'tasks') },
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  await connect(t, server);
  assert.equal(seen.length, 1, 'the app session is registered once, through the injected function');
  assert.equal(seen[0].options.surface, 'ssam');
  assert.equal(seen[0].options.descriptionPrefix, '[o11] ');
  assert.equal(typeof seen[0].options.gate, 'function');
});
