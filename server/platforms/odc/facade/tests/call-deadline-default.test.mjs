import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';

const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

test('the default 25-second deadline serves a real-clock 60-second fake in three calls, once', { timeout: 75000 }, async t => {
  // No injected callDeadlineMs and no environment override: this measures the production default at the SDK boundary.
  const previous = process.env.SSAM_CALL_DEADLINE_MS;
  delete process.env.SSAM_CALL_DEADLINE_MS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-deadline-default-'));
  const dir = path.join(root, 'tasks');
  const identity = { root, release: { head: 'fake', facadeSha256: 'fake', catalogSha256: 'fake' } };
  let server, client, work, executions = 0;
  t.after(async () => {
    await work;
    await client?.close();
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.SSAM_CALL_DEADLINE_MS;
    else process.env.SSAM_CALL_DEADLINE_MS = previous;
  });
  server = await createSsamServer({ o11: false, odc: true, deps: {
    odcRoot: root, answersRoot: root, tasksDir: dir,
    identity: { read: () => identity },
    writeLock: async (_, fn) => fn(),
    lock: { o11Root: root, odcRoot: root, connection: () => null },
    odcFacade: async () => {
      const fake = new McpServer({ name: 'default-deadline-fake', version: '1' });
      fake.registerTool('fake_snapshot', { inputSchema: z.object({}).strict() }, async () => reply({ ok: true }));
      return fake;
    },
  } });
  const expected = reply({ ok: true, payload: 'one completed 60-second operation' });
  const tool = 'default_deadline_operation';
  server.registerTool(tool, { inputSchema: z.object({ token: z.string() }).strict(), annotations: { readOnlyHint: true } }, async () => {
    executions++;
    work = new Promise(resolve => setTimeout(resolve, 60000));
    await work;
    return expected;
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'default-deadline-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const durations = [], answers = [];
  let args = { token: 'fake' }, final;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    final = await client.callTool({ name: tool, arguments: args });
    const durationMs = performance.now() - started;
    durations.push(durationMs);
    answers.push(final);
    assert.ok(durationMs <= 25500, `call ${i + 1} took ${durationMs.toFixed(1)} ms`);
    if (i < 2) {
      assert.equal(final.structuredContent.state, 'running');
      assert.equal(final.structuredContent.continuation.tool, tool);
      assert.ok(durationMs >= 24500, 'the wait uses the 25-second production default');
      assert.ok(Buffer.byteLength(JSON.stringify(final.structuredContent)) <= 512);
      assert.equal(final.structuredContent.ok, undefined);
      args = final.structuredContent.continuation.arguments;
    }
  }
  assert.deepEqual(final, expected);
  assert.equal(executions, 1);
  assert.equal(answers.length, 3);
  assert.equal(answers[0].structuredContent.task.id, answers[1].structuredContent.task.id);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.json')), [answers[0].structuredContent.task.id + '.json']);
  t.diagnostic(JSON.stringify({ realClock: true, deadlineMs: 25000, fakeDurationMs: 60000, calls: answers.length, executions, durationsMs: durations }));
});
