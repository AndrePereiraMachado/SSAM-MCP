import './fixtures/isolated-profile.mjs';
// Round 3d (re-review M3, Integradora, 2026-10-18): ssam_code write {files} is in the run-to-end family by the delivery it
// runs (nesting), and it decides its replay and its live join by the CONTENT of the files it reads, the same rule as every
// other delivery: a file rewritten after a client timeout is delivered; a repeat while it runs with a rewritten file is the
// "changed" refusal, never a blind join; the same content joins or gets its answer, one delivery.
// Times are scaled: the server's deadline (200 ms) stands for the 25 s of CALL_DEADLINE_MS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const value = result => result?.structuredContent ?? JSON.parse(result.content[0].text);
const DEADLINE = 200;
const deliverSchema = z.object({ feature: z.string().optional(), module: z.string().optional(), job: z.string().optional(), owners: z.array(z.string()).optional(),
  changes: z.array(z.string()).optional(), until: z.string().optional(), publish: z.boolean().optional(), authorize: z.string().optional() }).strict();

// The ssam server with a fake ODC lane whose studio_deliver records the job it delivers (ssam_code write goes through it).
async function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-code-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const delivered = [];
  const server = await createSsamServer({ o11: false, odc: true, deps: { answersRoot: root, callDeadlineMs: DEADLINE,
    identity: { read: () => ({ root, release: { head: 'a', facadeSha256: 'a', catalogSha256: 'a' } }) },
    writeLock: async (_, fn) => fn(), lock: { o11Root: root, odcRoot: root, connection: () => null }, odcRoot: root,
    odcFacade: async () => {
      const facade = new McpServer({ name: 'fake-odc', version: '1' });
      facade.registerTool('studio_deliver', { inputSchema: deliverSchema }, async args => {
        const job = typeof args.job === 'string' && fs.existsSync(args.job) ? fs.readFileSync(args.job, 'utf8') : String(args.job ?? '');
        delivered.push(/entity (\w+)/.exec(job)?.[1] ?? job.slice(0, 40));
        await sleep(DEADLINE * 5);
        return reply({ ok: true, result: 'delivered', run: delivered.length });
      });
      return facade;
    } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'replay-code', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const file = path.join(root, 'entities.ddl');
  const write = entity => fs.writeFileSync(file, 'create entity ' + entity + ' (Id Long Integer identifier auto required);\n');
  return { delivered, write, args: { lane: 'odc', action: 'write', module: 'Codes', files: [file] },
    call: (args, options) => client.callTool({ name: 'ssam_code', arguments: args }, options).then(value) };
}

test('M3: ssam_code write {files}, a client timeout past the deadline, the file rewritten: the identical call delivers the new code; the same content, one delivery', async t => {
  const h = await harness(t);
  h.write('A');
  const gaveUp = await h.call(h.args, { timeout: DEADLINE * 2 }).then(() => null, error => error);
  assert.match(String(gaveUp?.message), /timed out/i);
  await sleep(DEADLINE * 6); // the first delivery ends in the server
  assert.deepEqual(h.delivered, ['A']);
  h.write('B'); // the model writes new code in the same file
  const second = await h.call(h.args);
  assert.deepEqual(h.delivered, ['A', 'B'], 'the rewritten file is delivered'); assert.equal(second.ok, true, JSON.stringify(second).slice(0, 300));
  const third = await h.call(h.args); // the same content again: its answer, no new delivery
  assert.deepEqual(h.delivered, ['A', 'B'], JSON.stringify(third).slice(0, 300));
});

test('M3: a repeat of ssam_code write {files} while it runs: a rewritten file is the "changed" refusal; the same content joins', async t => {
  const h = await harness(t);
  h.write('A');
  const first = h.call(h.args);
  await sleep(DEADLINE * 1.5);
  const joined = await h.call(h.args);
  assert.equal(joined.joined, true, JSON.stringify(joined).slice(0, 300));
  await first;
  h.write('C');
  const second = h.call(h.args);
  await sleep(DEADLINE * 1.5);
  h.write('D');
  const refused = await h.call(h.args);
  assert.equal(refused.code, 'DELIVERY_STILL_RUNNING', JSON.stringify(refused).slice(0, 300)); assert.match(refused.error, /changed/);
  await second;
  assert.deepEqual(h.delivered, ['A', 'C'], 'the joined and the refused repeats delivered nothing');
});
