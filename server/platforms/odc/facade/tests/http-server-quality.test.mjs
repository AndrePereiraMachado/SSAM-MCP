// The quality record of the hosted HTTP server (docs/QUALIDADE.md; design ssam-quality/1 sections 2, 3.2-3.6, 7.1 step 4):
// the hooks of http-server.mjs with the recorder (quality-recorder.mjs) and the meter (quality-meter.mjs).
//   1. A fake hosted server whose tools run the way ssam.mjs `shaped` runs them (the call context, the answer noted before
//      paging): session lines; call index, gapMs and inFlight with parallel calls; agent spans fed the way the hub's
//      onCallSettled feeds them; a kernel span through kernelStart inside runWithExecutor and withCall; a relay-style span
//      (no call key) given to the call whose kernel run is in progress, `shared` only when two calls of the token run a
//      kernel at once; a parallel read beside a delivery not shared; a paged refusal recorded with scan "full"; a hostile
//      answer (names, expressions, paths, URLs, free text in every field) of which nothing reaches the file; a cancelled
//      call writes no line; every line <= 4096 bytes and unchanged by the contract's sanitizer.
//   2. An append that fails changes neither the answers nor the audit, and the audit is byte-identical to the one written
//      without a recorder.
//   3. SSAM_QUALITY=0, a hosted server without a recorder and the real `ssam serve --local-studios` write no quality file.
//   4. The real hosted server (runServed) with the real agent and a fake ODC Studio: real answers through the real shaper,
//      gate and hub, sentinels in arguments and answers, none of them in the file. A studio_command whose command is a
//      verb-shaped free word (the agent refuses it) names nothing in the quality file nor in server.log; a listed one does.
// With QUALITY_SAMPLE_OUT=<file> the lines of 1 and 4 are also copied there (the sample of the report).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startHttpServer } from '../http-server.mjs';
import { createTokenStore } from '../server-tokens.mjs';
import { createQualityRecorder } from '../quality-recorder.mjs';
import * as meter from '../quality-meter.mjs';
import { runWithExecutor } from '../executor.mjs';
import { shapeToolResult } from '../responses.mjs';
import { sanitizeQualityLine, fitLine, loadNativeIds, MAX_LINE_BYTES } from '../quality-line.mjs';
import { ODC_BRIDGE } from './fixtures/odc-bridge-version.mjs';

const facade = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repo = path.resolve(facade, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-http-quality-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => { const d = path.join(tmp, 'dir' + (++n)); fs.mkdirSync(d); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (check, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await check(); if (v) return v; await sleep(50); } return null; };
const KERNEL = { o11: '11.55.91', odc: '1.7.27', odcBridge: ODC_BRIDGE };
const catalog = JSON.parse(fs.readFileSync(path.join(facade, 'hosted', 'tools.json'), 'utf8')).tools;
const tools = new Set(Object.keys(catalog));
const lanes = Object.fromEntries(Object.entries(catalog).map(([k, v]) => [k, v.lane]));
const nativeIds = loadNativeIds(path.join(repo, 'kernel', 'catalog'), { readDir: fs.readdirSync, readFile: fs.readFileSync, join: path.join });
process.env.SSAM_FRICTION_DIR = path.join(tmp, 'friction');

// Sentinels: what a customer's work carries. Every one contains "sntl"; none may reach a quality file.
const S = { module: 'SntlModuloQx7', screen: 'SntlTelaQx7', action: 'GetSntlColaboradorQx7', entity: 'SntlEntidadeQx7', attr: 'sntlAtributoQx7',
  expr: 'sntl_expr_qx7 + SntlFn(1)', path: 'C:\\sntl\\cliente\\Qx7.oml', url: 'https://sntl-tenant-qx7.outsystemscloud.com/app', key: 'sntlkey-qx7-deadbeef',
  msg: 'sntl texto do cliente Qx7', job: 'ws:odc/jobs/sntl-job-qx7.json', tenant: 'sntl-tenant-qx7.outsystems.dev' };
const SENTINEL = /sntl/i;

const qualityFiles = dir => fs.readdirSync(dir).filter(f => /^quality-\d{8}\.jsonl$/.test(f)).sort();
const qualityText = dir => qualityFiles(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
const linesOf = dir => qualityText(dir).split('\n').filter(Boolean);
// Every line: within 4096 bytes, exactly what the contract keeps, and the text fitLine writes for it.
function contractHolds(raw) {
  for (const text of raw) {
    assert.ok(Buffer.byteLength(text, 'utf8') + 1 <= MAX_LINE_BYTES, 'line size ' + Buffer.byteLength(text));
    const value = JSON.parse(text);
    assert.deepEqual(sanitizeQualityLine(value, { nativeIds, tools }), value);
    assert.equal(fitLine(value), text);
  }
}
function noContent(text, extra = []) {
  assert.equal(SENTINEL.test(text), false, 'a sentinel reached the quality file: ' + text.split('\n').filter(l => SENTINEL.test(l)).join('\n').slice(0, 800));
  for (const word of ['outsystemscloud', 'outsystems.dev', 'C:\\\\', 'ws:', 'agent:', 'http', ...extra]) assert.equal(text.includes(word), false, word + ' in the quality file');
}
const sample = [];

// ---- the fake hosted server: tools run as ssam.mjs `shaped` runs them (call context, answer noted before paging).
let pageAnswer = null;
async function shapedLike(name, handler, answersDir, maxBytes = 4096) {
  pageAnswer ??= (await import('../ssam.mjs')).pageAnswer;
  return async (args, ctx) => {
    const key = typeof ctx?.sessionId === 'string' && ctx.mcpReq?.id !== undefined ? ctx.sessionId + '\u0000' + JSON.stringify(ctx.mcpReq.id) : null;
    const body = async () => {
      const result = await handler(args ?? {}, ctx);
      const answer = shapeToolResult(name, args ?? {}, result, { lane: 'odc' });
      if (key) meter.noteAnswer(key, name, args, answer);
      return pageAnswer(answer, { directory: answersDir, maxBytes });
    };
    return key ? meter.withCall(key, body) : body();
  };
}
const mcp = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
// A refusal with content in every text field (names, paths, expressions, URLs, free text, codes that are names).
const hostileRefusal = (count = 6) => ({ ok: false, outcome: S.msg, code: S.action, stage: S.msg, result: S.msg, error: S.msg + ' ' + S.path + ' ' + S.url,
  problems: Array.from({ length: count }, (_, i) => ({ phase: i % 2 ? 'preflight' : 'verify', op: i, pointer: '/ops/' + i + '/' + S.attr,
    code: ['EXPR_UNKNOWN_IDENTIFIER', 'ExpressionUnknownObject', S.action, S.msg][i % 4], severity: i % 5 === 4 ? 'warning' : 'error', message: S.msg + ' ' + S.expr,
    fix: 'use ' + S.expr + ' at ' + S.url, element: S.module + '.' + S.screen, key: S.key, patch: i % 3 ? [{ op: 'replace', path: '/ops/' + i + '/' + S.attr, value: S.expr }] : [] })),
  normalizations: { total: 3, byRule: { SORT_KEYS_SPLIT: 2, [S.msg]: 1 }, items: [{ rule: 'SORT_KEYS_SPLIT', path: S.path, from: S.expr, to: S.attr }] },
  warnings: [{ id: S.action, detail: S.msg, path: S.path }], highWarnings: [{ id: 'QUERY_IN_LOOP', detail: S.expr }],
  refusalLines: [S.msg, S.path], messages: [S.expr], failures: [{ stage: S.msg, error: S.url }], job: { ops: [{ op: 'set', target: S.entity, value: S.expr }] },
  nextBasedOn: { job: S.job, sha256: 'ab'.repeat(32) }, continuation: { tool: 'o11_deliver', arguments: { module: S.module, job: S.path, tenant: S.tenant }, why: S.msg },
  evidence: S.path, appLinks: [{ url: S.url }], [S.module]: S.msg });

function fakeServerFactory({ quality, answersDir, maxBytes = 4096 }) {
  return async session => {
    const server = new McpServer({ name: 'fake-hosted', version: '1.0.0' }, { instructions: 'fake' });
    const any = fromJsonSchema({ type: 'object', additionalProperties: true });
    const register = async (name, handler) => server.registerTool(name, { description: name, inputSchema: any }, await shapedLike(name, handler, answersDir, maxBytes));
    // ssam_doctor: a quick read.
    await register('ssam_doctor', async () => mcp({ ok: true, agent: { connected: false, root: S.path }, lanes: { odc: { tenant: S.tenant } } }));
    // ssam_map: a read that moves a file through the agent (the span the hub reports, with the call that made it).
    await register('ssam_map', async args => {
      const startMs = Date.now();
      await sleep(Number(args.waitMs) || 0);
      quality?.agentSpan({ tokenId: session.tokenId, kind: 'file.get', verb: null, startMs, ms: Date.now() - startMs, ok: true, code: null, bytes: 999, callKey: meter.currentCall() });
      return mcp({ ok: true, elements: [{ name: S.entity, path: S.path, key: S.key }], next: { tool: 'ssam_map', arguments: { target: S.path } } });
    });
    // studio_deliver: a kernel run at its leaf (hosted context + call context); optionally a span of the O11 relay (no key)
    // while it runs; a refusal (paged) or "entregue" with normalizations.
    await register('studio_deliver', async args => {
      const kernelMs = Number(args.kernelMs) || 200;
      await runWithExecutor({ hosted: true, tokenId: session.tokenId, workspace: session.workspace, executor: { call: async () => null } }, async () => {
        const end = meter.kernelStart({ lane: 'odc', via: 'cold' });
        try {
          await sleep(Math.floor(kernelMs / 2));
          if (args.relay) {
            const startMs = Date.now();
            await sleep(40);
            // As the hub settles a call that came through the relay socket: no call key.
            quality?.agentSpan({ tokenId: session.tokenId, kind: 'o11.bridge', verb: 'merge_from_oml', startMs, ms: Date.now() - startMs, ok: true, code: null, callKey: null });
          }
          await sleep(Math.max(0, kernelMs - Math.floor(kernelMs / 2) - (args.relay ? 40 : 0)));
        } finally { end(); }
      });
      if (args.refuse) return mcp({ ...hostileRefusal(40), code: 'PREFLIGHT_REFUSED', stage: 'preflight', outcome: 'refused', refusalLines: Array.from({ length: 80 }, () => S.msg + ' ' + S.path) });
      return mcp({ ok: true, merged: true, strictlyEqual: true, result: 'entregue', module: S.module, manifest: S.path,
        normalizations: { total: 2, byRule: { NULL_FUNCTION_REWRITTEN: 2 }, items: [{ rule: 'NULL_FUNCTION_REWRITTEN', path: S.path, from: 'NullDate()', to: S.expr }] },
        phases: { buildMs: 10, queuedMs: 25, applyMs: 30 }, summary: { actions: [{ name: S.action }] } });
    });
    // o11_deliver: the hostile refusal, not paged.
    await register('o11_deliver', async () => mcp(hostileRefusal(6)));
    // A tool the hosted catalog does not know: its name never reaches a line.
    await register('sntl_private_tool', async () => mcp({ ok: true, value: S.msg }));
    return server;
  };
}
async function connect(url, token, name = 'codex-mcp-client') {
  const client = new Client({ name, version: '0.47.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } });
  await client.connect(transport);
  return { client, transport };
}

test('hosted: session lines, sequence, spans and attribution, a paged refusal, a hostile answer and a cancelled call', { timeout: 60000 }, async () => {
  const dir = freshDir();
  const events = [];
  const quality = createQualityRecorder({ dir, log: e => events.push(e), nativeIds, tools, lanes });
  const handle = await startHttpServer({ createServer: fakeServerFactory({ quality, answersDir: path.join(dir, 'answers') }), dir, port: 0, sweepMs: 50,
    agents: { kernel: KERNEL }, quality, log: e => events.push(e) });
  const issued = createTokenStore(dir).issue({ customer: 'Cliente Alfa' });
  try {
    const { client, transport } = await connect(handle.url, issued.token);
    const call = (name, args = {}, options) => client.callTool({ name, arguments: args }, options);
    assert.equal((await call('ssam_doctor')).isError, undefined);
    const [deliver, read] = await Promise.all([
      call('studio_deliver', { module: S.module, job: S.job, kernelMs: 400, relay: true }),
      call('ssam_map', { target: S.path, view: 'search', text: S.expr, waitMs: 100 })]);
    assert.equal(deliver.structuredContent.result, 'entregue');
    assert.equal(read.structuredContent.ok, true);
    await sleep(1100);
    const hostile = await call('o11_deliver', { module: S.module, job: { ops: [{ op: 'set', target: S.entity, value: S.expr }] }, authorize: S.msg,
      basedOn: { job: S.path, sha256: 'ab'.repeat(32) }, patch: [{ op: 'replace', path: S.path, value: S.expr }], closePrevious: 'a'.repeat(32), tenant: S.tenant });
    assert.equal(hostile.isError, true);
    const paged = await call('studio_deliver', { module: S.module, job: { ops: [] }, refuse: true, kernelMs: 50, until: 'merge' });
    assert.ok(paged.structuredContent.paged, 'the refusal was paged');
    assert.equal(paged.structuredContent.problems, undefined, 'its problems left the wire');
    await Promise.all([call('studio_deliver', { module: S.module, kernelMs: 400, relay: true }), call('studio_deliver', { module: S.module, kernelMs: 400 })]);
    const abort = new AbortController();
    const cancelled = call('ssam_map', { target: S.path, waitMs: 1500 }, { signal: abort.signal }).then(() => 'answered', () => 'cancelled');
    await sleep(150); abort.abort();
    assert.equal(await cancelled, 'cancelled');
    const unknown = await call('sntl_private_tool', { value: S.msg }).then(r => r, e => ({ rejected: e }));
    assert.ok(unknown, 'answered or refused');
    await sleep(50);
    await call('ssam_doctor');
    await transport.terminateSession();
    await client.close();
    assert.ok(await waitFor(() => linesOf(dir).some(l => l.includes('"event":"closed"')), 3000), 'closed line');
    await sleep(1600); // the cancelled handler ends; its late span is dropped and writes nothing
  } finally { await handle.close(); }

  const raw = linesOf(dir);
  contractHolds(raw);
  const text = qualityText(dir);
  noContent(text, [issued.token]);
  const lines = raw.map(l => JSON.parse(l));
  sample.push(...raw);
  const [opened, ...rest] = lines;
  const closed = rest.pop();
  assert.deepEqual({ ...opened, time: 'x', session: 'x' }, { schema: 'ssam-quality/1', kind: 'session', time: 'x', token: issued.id, customer: 'Cliente Alfa', session: 'x', event: 'opened', client: 'codex' });
  assert.equal(closed.event, 'closed'); assert.ok(['client-delete', 'transport-closed'].includes(closed.reason), closed.reason); assert.equal(closed.calls, 10); assert.ok(closed.openMs > 1000);
  assert.ok(lines.every(l => l.session === opened.session && l.token === issued.id), 'one session, its hash, never the session id');
  assert.ok(!events.some(e => e.event === 'session-opened' && text.includes(e.session)), 'the session id itself is not in the file');
  const calls = rest;
  // Lines are written when the answers leave (a parallel pair in any order); the numbers are those of the arrivals.
  assert.deepEqual(calls.map(l => l.call).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 9, 10], 'call numbers by arrival; the cancelled call 8 wrote no line');
  const byCall = Object.fromEntries(calls.map(l => [l.call, l]));
  assert.deepEqual([byCall[1].gapMs, byCall[1].inFlight, byCall[1].tool, byCall[1].ok, byCall[1].class], [null, 0, 'ssam_doctor', true, 'ok']);
  // The parallel pair: one arrived while the other was in flight; the read is not charged with the delivery's spans.
  const pair = [byCall[2], byCall[3]];
  assert.deepEqual(pair.map(l => l.inFlight).sort(), [0, 1]);
  const d = pair.find(l => l.tool === 'studio_deliver'), r = pair.find(l => l.tool === 'ssam_map');
  assert.equal(d.deliv, 'entregue'); assert.equal(d.class, 'delivered'); assert.deepEqual(d.norm, { n: 2, byRule: { NULL_FUNCTION_REWRITTEN: 2 } });
  assert.equal(d.args.job, 'ws'); assert.ok(d.args.bytes > 0); assert.equal(d.lane, 'odc');
  assert.deepEqual([d.kernel.runs, d.kernel.cold, d.kernel.worker], [1, 1, 0]);
  assert.ok(d.kernel.ms >= 350 && d.kernel.ms <= d.ms, 'the kernel run: ' + JSON.stringify(d));
  assert.equal(d.agent.shared, false); assert.equal(d.agent.n, 1);
  assert.equal(d.agent.top[0][0], 'o11.bridge:merge_from_oml');
  assert.ok(d.t.studio >= 30 && d.t.kernelOwn === d.t.kernel - d.t.studio, 'the relay call inside the kernel run is Studio time: ' + JSON.stringify(d.t));
  assert.equal(d.t.queue, 25, 'the queue from phases.queuedMs');
  assert.equal(r.op, 'search'); assert.equal(r.kernel, undefined); assert.equal(r.agent.shared, false);
  assert.deepEqual(r.agent.top.map(e => e[0]), ['file.get']); assert.equal(r.agent.bytes, 999); assert.ok(r.t.transfer >= 90);
  // The gap: the model's turn after the last answer left.
  assert.ok(byCall[4].gapMs >= 1000 && byCall[4].gapMs < 10000, 'gap ' + byCall[4].gapMs); assert.equal(byCall[4].inFlight, 0);
  // The hostile refusal: codes and counts only.
  const h = byCall[4];
  assert.deepEqual([h.tool, h.ok, h.code, h.class, h.step, h.deliv, h.lane], ['o11_deliver', false, 'TOOL_ERROR', 'refused', null, null, 'o11']);
  assert.deepEqual(h.problems.byCode, { EXPR_UNKNOWN_IDENTIFIER: 2, ExpressionUnknownObject: 2, NATIVE_UNLISTED: 1, PROBLEM_UNCODED: 1 });
  assert.equal(h.problems.n, 6); assert.equal(h.problems.warn, 1);
  // the free-text rule key is counted as RULE_UNLISTED, never written (privacy review of 2026-10-12)
  assert.deepEqual(h.norm, { n: 3, byRule: { SORT_KEYS_SPLIT: 2, RULE_UNLISTED: 1 } });
  assert.deepEqual(h.warn, { n: 1, high: 1 });
  assert.deepEqual(h.args, { job: 'inline', basedOn: true, closePrevious: true, patch: 1, bytes: h.args.bytes });
  assert.ok(h.args.bytes > 200, 'the POST body size');
  assert.equal(h.answer.scan, 'full');
  // The paged refusal: every problem counted from the answer before paging.
  const p = byCall[5];
  assert.deepEqual([p.class, p.code, p.step, p.answer.paged, p.answer.scan], ['refused', 'PREFLIGHT_REFUSED', 'preflight', true, 'full']);
  assert.equal(p.problems.n, 40); assert.equal(p.problems.byCode.EXPR_UNKNOWN_IDENTIFIER, 10);
  assert.ok(p.answer.chars > 0 && p.answer.chars < 8000, 'the client read the small page');
  assert.deepEqual(p.args, { job: 'inline', until: 'merge', bytes: p.args.bytes });
  // Two deliveries of the token running their kernels at once: the relay span goes to both, each marked shared.
  assert.equal(byCall[6].agent.shared, true); assert.equal(byCall[7].agent.shared, true);
  assert.ok([byCall[6], byCall[7]].every(l => l.agent.top[0][0] === 'o11.bridge:merge_from_oml'));
  // The unknown tool: no name; a protocol error or a tool error, recorded either way.
  assert.equal(byCall[9].tool, '?');
  assert.ok(['protocol', 'ok', 'failed'].includes(byCall[9].class));
  assert.equal(byCall[10].inFlight, 0, 'the cancelled call is not in flight');
  assert.equal(events.filter(e => e.event === 'quality-failed').length, 0);
  assert.deepEqual(meter.sizes().calls, 0, 'every call closed in the meter');
});

test('an append that fails changes neither the answers nor the audit; the audit is byte-identical without a recorder', { timeout: 60000 }, async () => {
  const fixed = new Date('2026-10-12T18:00:00.000Z');
  const tokensFrom = freshDir();
  const issued = createTokenStore(tokensFrom).issue({ customer: 'Cliente Beta' });
  const realNow = performance.now;
  async function run({ recorder, blocked }) {
    const dir = freshDir();
    fs.copyFileSync(path.join(tokensFrom, 'tokens.json'), path.join(dir, 'tokens.json'));
    if (blocked) fs.mkdirSync(path.join(dir, 'quality-20261012.jsonl'));
    const events = [];
    const quality = recorder ? createQualityRecorder({ dir, log: e => events.push(e), nativeIds, tools, lanes, now: () => fixed }) : null;
    const handle = await startHttpServer({ createServer: fakeServerFactory({ quality, answersDir: path.join(dir, 'answers'), maxBytes: 1 << 20 }), dir, port: 0, sweepMs: 50,
      agents: { kernel: KERNEL }, quality, now: () => fixed, log: e => events.push(e) });
    const answers = [];
    try {
      const { client, transport } = await connect(handle.url, issued.token);
      performance.now = () => 1000;
      try {
        for (const [name, args] of [['ssam_doctor', {}], ['o11_deliver', { module: S.module, job: S.path }], ['ssam_map', { target: S.path }],
          ['studio_deliver', { module: S.module, kernelMs: 20 }], ['o11_deliver', { module: S.module }]])
          answers.push(JSON.stringify(await client.callTool({ name, arguments: args })));
      } finally { performance.now = realNow; }
      await transport.terminateSession();
      await client.close();
    } finally { performance.now = realNow; await handle.close(); }
    const audit = fs.readdirSync(dir).filter(f => /^audit-\d{8}\.jsonl$/.test(f)).map(f => fs.readFileSync(path.join(dir, f)));
    return { dir, events, answers, audit: Buffer.concat(audit) };
  }
  const plain = await run({ recorder: false });
  const failing = await run({ recorder: true, blocked: true });
  const recorded = await run({ recorder: true, blocked: false });
  assert.ok(plain.audit.length > 0);
  assert.equal(failing.audit.equals(plain.audit), true, 'the audit with a failing recorder is byte-identical');
  assert.equal(recorded.audit.equals(plain.audit), true, 'the audit with a working recorder is byte-identical');
  assert.deepEqual(failing.answers, plain.answers, 'the answers are the same');
  assert.deepEqual(recorded.answers, plain.answers);
  const failures = failing.events.filter(e => e.event === 'quality-failed');
  assert.equal(failures.length, 1, 'at most one line a minute per stage: ' + JSON.stringify(failures));
  assert.equal(failures[0].stage, 'write'); assert.match(failures[0].error, /^[A-Z][A-Z0-9_]+$/);
  assert.equal(qualityFiles(plain.dir).length, 0, 'no recorder, no file');
  const lines = linesOf(recorded.dir);
  contractHolds(lines);
  assert.equal(lines.length, 7, 'opened, five calls, closed');
  assert.ok(lines.every(l => JSON.parse(l).time === fixed.toISOString()), 'the audit\'s instant');
  const auditTimes = plain.audit.toString('utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => JSON.parse(l)).filter(l => l.kind === 'call').map(l => [l.tool, l.ms, l.ok, l.code ?? undefined]),
    auditTimes.map(a => [a.tool, a.ms, a.ok, a.error]), 'the same tool, ms and outcome as the audit');
});

test('SSAM_QUALITY=0, a hosted server without a recorder and the real --local-studios mode write no quality file', { timeout: 240000 }, async () => {
  const ssam = await import('../ssam.mjs');
  const off = freshDir(); const logged = [];
  assert.equal(await ssam.qualityRecorder({ dir: off, log: e => logged.push(e), env: { SSAM_QUALITY: '0' } }), null);
  assert.deepEqual(logged, [{ event: 'quality', on: false, nativeIds: 0 }]);
  const on = await ssam.qualityRecorder({ dir: off, log: e => logged.push(e), env: {} });
  assert.equal(typeof on.callAnswered, 'function');
  assert.equal(logged[1].event, 'quality'); assert.equal(logged[1].on, true); assert.ok(logged[1].nativeIds > 100, 'the kernel catalogs: ' + logged[1].nativeIds);

  // Hosted without a recorder (what runServed passes with SSAM_QUALITY=0).
  const dir = freshDir();
  const handle = await startHttpServer({ createServer: fakeServerFactory({ quality: null, answersDir: path.join(dir, 'answers') }), dir, port: 0, agents: { kernel: KERNEL } });
  try {
    const { client } = await connect(handle.url, createTokenStore(dir).issue({ customer: 'Desligado' }).token);
    await client.callTool({ name: 'o11_deliver', arguments: { module: S.module } });
    await client.callTool({ name: 'studio_deliver', arguments: { kernelMs: 10 } });
    await client.close();
  } finally { await handle.close(); }
  assert.deepEqual(qualityFiles(dir), []);

  // The real owner-only mode, in this process: runServed --local-studios (the tools of `ssam mcp`).
  const local = freshDir();
  const saved = process.env.SSAM_SERVER_DIR;
  process.env.SSAM_SERVER_DIR = local;
  let served = null;
  try {
    served = await ssam.runServed(['--local-studios', '--port', '0']);
    const { client, transport } = await connect(served.url, createTokenStore(local).issue({ customer: 'Dono' }).token, 'claude-code');
    const friction = await client.callTool({ name: 'ssam_friction', arguments: { view: 'issues' } });
    assert.ok(friction.content?.length, 'answered');
    await transport.terminateSession();
    await client.close();
  } finally {
    await served?.close();
    if (saved === undefined) delete process.env.SSAM_SERVER_DIR; else process.env.SSAM_SERVER_DIR = saved;
  }
  assert.ok(fs.readdirSync(local).some(f => /^audit-\d{8}\.jsonl$/.test(f)), 'the local mode audits');
  assert.deepEqual(qualityFiles(local), [], 'and records no quality line');
});

// ---- 4. the real hosted server with the real agent and a fake ODC Studio.
async function fakeOdcPipe(pid, handler) {
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk.toString('utf8'); const i = buffer.indexOf('\n'); if (i < 0) return;
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      socket.write(JSON.stringify(await handler(line)) + '\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(`\\\\.\\pipe\\ODC3-Bridge-${ODC_BRIDGE}-${pid}`, resolve));
  return { close: () => new Promise(resolve => server.close(resolve)) };
}
async function freePort() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = 7400 + Math.floor(Math.random() * 100);
    const free = await new Promise(resolve => { const s = net.createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
    if (free) return port;
  }
  throw new Error('no free port in 7400-7499');
}

test('the real hosted server: real answers through the shaper, gate and hub; spans with their call; no sentinel in the file', { timeout: 240000 }, async t => {
  const ssam = await import('../ssam.mjs');
  const { fakeBridge } = await import('./fixtures/fake-o11-bridge.mjs');
  const { createAgent } = await import(pathToFileURL(path.join(repo, 'agent', 'ssam-agent.mjs')).href);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-quality-hosted-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'server');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify(KERNEL));
  const saved = Object.fromEntries(['SSAM_SERVER_DIR', 'SSAM_MODULE_INDEX_ROOT', 'SSAM_READER_CACHE_ROOT', 'SSAM_QUALITY', 'SSAM_MAX_ANSWER_BYTES'].map(k => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  Object.assign(process.env, { SSAM_SERVER_DIR: dir, SSAM_MODULE_INDEX_ROOT: path.join(base, 'module-index'), SSAM_READER_CACHE_ROOT: path.join(base, 'readers'), SSAM_MAX_ANSWER_BYTES: '4096' });
  delete process.env.SSAM_QUALITY;
  process.env.SSAM_NO_WARM = '1';
  const port = await freePort();
  const logFile = path.join(dir, 'server.log');
  const handle = await ssam.runServed(['--port', String(port), '--log-file', logFile]);
  t.after(() => handle.close());
  const store = createTokenStore(dir);
  const issued = store.issue({ customer: 'Cliente Gama' });

  // The customer's machine: a fake ODC Studio pipe (an unlikely pid), a fake O11 bridge, the real agent.
  const odcPid = 900000 + Math.floor(Math.random() * 90000), o11Pid = odcPid + 1;
  const agentRoot = path.join(base, 'SSAM-Agent');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const pipeSeen = [];
  const pipe = await fakeOdcPipe(odcPid, line => {
    const [command, ...args] = line.split(' ');
    pipeSeen.push(command);
    if (command === 'status') return { ok: true, bridge: ODC_BRIDGE, busy: null, modules: Array.from({ length: 60 }, (_, i) => ({ name: S.module + i, path: S.path, key: S.key + i })) };
    if (command === 'snapshot') {
      const bytes = Buffer.from('fake capture of ' + args[0] + ' ' + S.expr);
      const hash = sha(bytes).toUpperCase();
      const file = path.join(agentRoot, 'odc', 'snapshots', args[0] + '-' + hash + '.oml');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
      fs.writeFileSync(file + '.json', JSON.stringify({ ok: true, module: args[0], sha256: hash, path: file }));
      return { ok: true, module: args[0], sha256: hash, path: file, host: S.tenant };
    }
    return { ok: false, error: 'fake bridge: ' + command + ' ' + S.msg };
  });
  t.after(() => pipe.close());
  const bridge = await fakeBridge(request => request.method === 'ping' ? { success: true, data: { bridge: 'anvil', flavor: 'thin', pid: o11Pid, version: '11.55.91.65012' } }
    : request.method === 'bridge_manifest' ? { success: true, data: { bridge: 'anvil', flavor: 'thin', protocolVersion: 2, authentication: true } }
    : { success: true, data: { method: request.method, modules: [], active: null, errors: [], windows: [] } });
  t.after(() => bridge.close());
  for (const d of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private/authority']) fs.mkdirSync(path.join(agentRoot, d), { recursive: true });
  fs.writeFileSync(path.join(agentRoot, 'pack.json'), JSON.stringify({ id: 'pack-quality', lanes: ['odc', 'o11'], odcBridge: ODC_BRIDGE, o11BuiltFor: '11.55.91', files: [] }));
  fs.writeFileSync(path.join(agentRoot, 'private', 'credential'), issued.agentCredential);
  fs.writeFileSync(path.join(agentRoot, 'private', 'authority', 'bridge.key'), randomBytes(32).toString('base64url'));
  const config = { server: `http://127.0.0.1:${port}`, o11Port: bridge.port };
  fs.writeFileSync(path.join(agentRoot, 'private', 'config.json'), JSON.stringify(config));
  const versions = { 'ODCStudio.exe': '1.7.27.4021', 'ServiceStudio.exe': '11.55.91.65012' };
  const agent = await createAgent({ root: agentRoot, config, log: () => {}, deps: {
    processes: async image => image === 'ODCStudio.exe' ? [{ pid: odcPid, path: 'C:\\Fake\\ODC Studio\\ODCStudio.exe', version: versions['ODCStudio.exe'] }]
      : [{ pid: o11Pid, path: 'C:\\Fake\\Service Studio\\ServiceStudio.exe', version: versions['ServiceStudio.exe'] }],
    locate: async kind => (kind === 'odc' ? 'C:\\Fake\\ODC Studio' : 'C:\\Fake\\Service Studio'),
    fileVersion: async exe => versions[path.basename(exe)] ?? null,
    describe: async pid => ({ pid: Number(pid), startedUtc: '2026-10-04T10:00:00Z', version: '11.55.91.65012', diagnosticsAvailable: true, bridgePath: null, corePath: null }),
    attachOdc: async ({ pid }) => ({ ok: true, attached: true, pid, version: ODC_BRIDGE, note: 'fake' }),
    attachO11: async () => { throw new Error('no attach expected'); },
    icacls: async () => ({ ok: true }),
  } });
  const running = Promise.resolve((agent.run ?? agent.start).call(agent));
  t.after(async () => { await (agent.stop ?? agent.close)?.call(agent); await running.catch(() => {}); });

  const { client, transport } = await connect(`http://127.0.0.1:${port}/mcp`, issued.token, 'claude-code');
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const doctor = await waitFor(async () => { const d = (await call('ssam_doctor')).structuredContent; return d?.agent?.connected ? d : null; }, 15000);
  assert.ok(doctor, 'the agent connected');
  const status = await call('studio_status', {});
  assert.notEqual(status.isError, true, JSON.stringify(status).slice(0, 400));
  const snapshot = await call('studio_snapshot', { module: S.module });
  assert.notEqual(snapshot.isError, true, JSON.stringify(snapshot).slice(0, 400));
  const outside = await call('studio_open', { module: S.module, localOml: 'C:\\Windows\\win.ini' });
  assert.equal(outside.structuredContent?.code, 'PATH_OUTSIDE_WORKSPACE');
  const o11 = await call('o11_studio', { command: 'status' });
  assert.equal(o11.structuredContent?.code, 'O11_NOT_CONNECTED');
  const job = await call('o11_deliver', { module: S.module, job: { ops: [{ op: 'set', target: S.entity, value: S.expr }] }, authorize: S.msg });
  assert.equal(job.isError, true);
  // The model's own text as the command (privacy finding of 2026-10-12): verb-shaped, refused by the agent before the pipe.
  const free = await call('studio_command', { command: 'sntl-cmd', args: [] });
  assert.equal(free.structuredContent?.code, 'COMMAND_NOT_ALLOWED', JSON.stringify(free).slice(0, 400));
  const listed = await call('studio_command', { command: 'module-info', args: [S.module] });
  assert.equal(listed.isError, true, JSON.stringify(listed).slice(0, 400));
  assert.ok(!pipeSeen.includes('sntl-cmd') && pipeSeen.includes('module-info'), 'the agent refused the free word before the pipe: ' + pipeSeen.join(','));
  await transport.terminateSession();
  await client.close();
  assert.ok(await waitFor(() => linesOf(dir).some(l => l.includes('"event":"closed"')), 5000), 'the closed line');

  const raw = linesOf(dir);
  contractHolds(raw);
  noContent(qualityText(dir), [issued.token, issued.agentCredential]);
  sample.push(...raw);
  const lines = raw.map(l => JSON.parse(l));
  assert.equal(lines[0].event, 'opened'); assert.equal(lines[0].client, 'claude-code'); assert.equal(lines[0].customer, 'Cliente Gama');
  // DELETE closes the transport first: transport-closed or client-delete, whichever hook runs first.
  assert.equal(lines.at(-1).event, 'closed'); assert.ok(['client-delete', 'transport-closed'].includes(lines.at(-1).reason), lines.at(-1).reason);
  const of = name => lines.filter(l => l.tool === name);
  // The pipe call of studio_status carries the tool call that made it: through the real gate, executor and hub.
  const st = of('studio_status').at(-1);
  assert.ok(st.agent?.top?.some(([label]) => label === 'odc.pipe:status'), 'the pipe status span: ' + JSON.stringify(st));
  assert.equal(st.agent.shared, false); assert.ok(st.t.studio > 0, JSON.stringify(st.t));
  const snap = of('studio_snapshot').at(-1);
  assert.ok(snap.agent?.top?.some(([label]) => label === 'odc.pipe:snapshot'), 'the capture span: ' + JSON.stringify(snap));
  assert.ok(snap.t.capture > 0 && snap.agent.shared === false, JSON.stringify(snap));
  assert.ok(snap.t.transfer > 0 && snap.agent.bytes > 0, 'the capture came back through file.get: ' + JSON.stringify(snap));
  const ref = of('studio_open').at(-1);
  assert.deepEqual([ref.ok, ref.code, ref.answer.scan], [false, 'PATH_OUTSIDE_WORKSPACE', 'wire']);
  assert.equal(of('o11_studio').at(-1).code, 'O11_NOT_CONNECTED'); assert.equal(of('o11_studio').at(-1).op, 'status');
  const deliver = of('o11_deliver').at(-1);
  assert.deepEqual([deliver.ok, deliver.args.job, deliver.lane], [false, 'inline', 'o11']);
  const doctors = of('ssam_doctor');
  assert.ok(doctors.length >= 1 && doctors[0].call === 1 && doctors[0].gapMs === null);
  assert.ok(lines.filter(l => l.kind === 'call').every((l, i, all) => i === 0 || l.call > all[i - 1].call), 'call numbers grow');
  const [freeLine, listedLine] = of('studio_command');
  assert.deepEqual([freeLine.ok, freeLine.code, listedLine.ok], [false, 'COMMAND_NOT_ALLOWED', false]);
  assert.deepEqual(freeLine.agent?.top?.map(([label]) => label).filter(label => label.startsWith('odc.pipe')), ['odc.pipe'], 'the refused pipe call keeps only its kind: ' + JSON.stringify(freeLine.agent));
  assert.ok(listedLine.agent?.top?.some(([label]) => label === 'odc.pipe:module-info'), 'a listed command is still named: ' + JSON.stringify(listedLine.agent));
  // server.log: the agent-call lines name listed commands only; no sentinel of any argument or answer anywhere in the log.
  const log = fs.readFileSync(logFile, 'utf8');
  const calls = log.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.event === 'agent-call');
  assert.ok(calls.some(e => e.kind === 'odc.pipe' && e.code === 'COMMAND_NOT_ALLOWED' && !Object.hasOwn(e, 'command')), 'the refused call is logged without its command');
  assert.ok(calls.some(e => e.kind === 'odc.pipe' && e.command === 'module-info'), 'a listed command is logged');
  assert.equal(SENTINEL.test(log), false, 'a sentinel reached server.log: ' + log.split('\n').filter(l => SENTINEL.test(l)).join('\n').slice(0, 800));
});

test.after(() => {
  const out = process.env.QUALITY_SAMPLE_OUT;
  if (out && sample.length) fs.writeFileSync(out, sample.join('\n') + '\n', 'utf8');
});
