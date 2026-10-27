import './fixtures/isolated-profile.mjs';
// A delivery of 3 minutes over a real stdio MCP process, with the real call deadline of 25 s (owner decision 2026-10-18:
// deliveries and creations have no time limit). The local channel is stdio: no idle timer can end it. Two deliveries run at
// once, both synthetic (fixtures/long-delivery-server.mjs):
//   - "Long": a client that waits (a long request timeout, as Claude Code): ONE call answers the final result after 3 minutes;
//   - "GiveUp": a client with the SDK's default request timeout (60 s) gives up in the middle and sends
//     notifications/cancelled; the work goes on in the server, ssam_task shows it running, and the identical repeat joins
//     it and gets the final answer of the same task;
//   - "Silent" (its own process): a client that gives up at 60 s WITHOUT a cancellation (the server cannot know) and repeats
//     the identical call after the work ended gets the kept final answer (resumedFrom), never a second run.
// Each delivery runs once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { WRITE_DEADLINE_MS } from '../call-deadline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, 'fixtures', 'long-delivery-server.mjs');
const DELIVERY_MS = 180000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const value = result => result?.structuredContent ?? JSON.parse(result.content[0].text);

test('a 3-minute delivery over stdio: one call past the 25 s deadline; a client timeout in the middle leaves it running and the repeat joins it', { timeout: 600000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, SSAM_TEST_ROOT: root, SSAM_TEST_DELIVERY_MS: String(DELIVERY_MS), SSAM_NO_WARM: '1', ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  delete env.SSAM_CALL_DEADLINE_MS;
  const client = new Client({ name: 'delivery-process', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: 'ignore' }));
  t.after(() => client.close());
  // "Silent": its own server process, and a client whose timeout sends no notifications/cancelled
  const silentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-process-silent-'));
  t.after(() => fs.rmSync(silentRoot, { recursive: true, force: true }));
  const silentTransport = new StdioClientTransport({ command: process.execPath, args: [server], env: { ...env, SSAM_TEST_ROOT: silentRoot }, stderr: 'ignore' });
  const silent = new Client({ name: 'delivery-process-silent', version: '1' });
  await silent.connect(silentTransport);
  t.after(() => silent.close());
  const sendSilently = silentTransport.send.bind(silentTransport);
  silentTransport.send = (message, options) => (message?.method === 'notifications/cancelled' ? Promise.resolve() : sendSilently(message, options));
  const started = Date.now();
  const silentCall = silent.callTool({ name: 'o11_deliver', arguments: { module: 'Silent' } }).then(() => ({ answered: true }), error => ({ error, at: Date.now() - started }));
  const long = client.callTool({ name: 'o11_deliver', arguments: { module: 'Long' } }, { timeout: 2 * DELIVERY_MS }).then(result => ({ result, at: Date.now() - started }));
  const givenUp = client.callTool({ name: 'o11_deliver', arguments: { module: 'GiveUp' } }).then(() => ({ answered: true }), error => ({ error, at: Date.now() - started }));

  // Past the server's deadline of a delivery, neither call has answered and ssam_task lists both as running. A delivery
  // waits WRITE_DEADLINE_MS (50 s, the per-tool deadline of the merged proto line, 92dc826d/bc9f8fb3) before it is kept as a
  // task that runs to its end; the SDK's default timeout (60 s) is later.
  await sleep(WRITE_DEADLINE_MS + 5000);
  const listed = value(await client.callTool({ name: 'ssam_task', arguments: {} }));
  const running = listed.tasks.filter(task => task.tool === 'o11_deliver' && task.state === 'running');
  assert.equal(running.length, 2, JSON.stringify(listed.tasks).slice(0, 600));

  // the SDK's own timeout (60 s) gives up on GiveUp; its work goes on in the server
  const gaveUp = await givenUp;
  assert.match(String(gaveUp.error?.message), /timed out/i, JSON.stringify(gaveUp).slice(0, 300));
  assert.ok(gaveUp.at < DELIVERY_MS);
  const repeat = await client.callTool({ name: 'o11_deliver', arguments: { module: 'GiveUp' } }, { timeout: 2 * DELIVERY_MS });
  const repeated = value(repeat);
  assert.deepEqual({ ok: repeated.ok, result: repeated.result, module: repeated.module, runs: repeated.runs, joined: repeated.joined },
    { ok: true, result: 'delivered', module: 'GiveUp', runs: 1, joined: true });

  // ONE call of Long answers its final result when the work ends, 3 minutes after the start
  const { result, at } = await long;
  const final = value(result);
  assert.equal(final.state, undefined, JSON.stringify(final).slice(0, 300));
  assert.deepEqual({ ok: final.ok, result: final.result, module: final.module, runs: final.runs }, { ok: true, result: 'delivered', module: 'Long', runs: 1 });
  assert.ok(at >= DELIVERY_MS, 'the call waited for the work: ' + at + ' ms');

  // ssam_task reads both tasks as ended, each delivered once to whoever waited
  const ended = value(await client.callTool({ name: 'ssam_task', arguments: {} })).tasks.filter(task => task.tool === 'o11_deliver');
  assert.deepEqual(ended.map(task => task.state).sort(), ['ok', 'ok']);

  // "Silent" gave up at 60 s without a word; after the work ended its identical repeat gets the kept answer, one run only
  const quiet = await silentCall;
  assert.match(String(quiet.error?.message), /timed out/i, JSON.stringify(quiet).slice(0, 300));
  await sleep(Math.max(0, DELIVERY_MS + 3000 - (Date.now() - started)));
  const replay = value(await silent.callTool({ name: 'o11_deliver', arguments: { module: 'Silent' } }, { timeout: 60000 }));
  assert.deepEqual({ ok: replay.ok, result: replay.result, module: replay.module, runs: replay.runs }, { ok: true, result: 'delivered', module: 'Silent', runs: 1 });
  assert.match(String(replay.resumedFrom), /^[0-9a-f-]{36}$/, JSON.stringify(replay).slice(0, 300));
});
