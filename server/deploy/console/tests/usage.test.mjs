// DESIGN 3.4 and 7.2 "usage": the sparse log1.1 histogram gives p50/p90 within 10 % of the exact values on 1 000 random
// durations; byCode/byTool/byDay; ranges today/7d/30d/day; the token filter; empty ranges give null quantiles; lines are
// aggregated by the local day (22:30 local sits in the next UTC file); day files survive a new instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addHist, bucketOf, createUsage, quantile } from '../usage.mjs';
import { BOX_TOOLS_CATALOG, defaultToolsCatalog, loadToolNames, toolOf } from '../tool-names.mjs';
import { createMinutes } from '../recent.mjs';
import { createState } from '../state.mjs';
import { createTz } from '../tz.mjs';
import { clock, makeEnv, startConsole, tempDir } from './helpers.mjs';
import { writeAudit } from './scenario.mjs';

const A = 'tok_0000000a1fa0', B = 'tok_0000000b2fb0';
const tz = createTz('America/Sao_Paulo');

test('histogram buckets and quantiles within 10 % of exact on 1 000 random durations', () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(9.99), 0);
  assert.equal(bucketOf(10), 1);
  assert.equal(bucketOf(10.99), 1);
  assert.equal(bucketOf(11), 2);
  assert.equal(bucketOf(1e12), 160);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 5; round++) {
    const values = Array.from({ length: 1000 }, () => Math.round(10 * Math.exp(rnd() * Math.log(6000))));
    const hist = {};
    for (const v of values) addHist(hist, v);
    const sorted = [...values].sort((a, b) => a - b);
    const max = sorted[sorted.length - 1];
    for (const q of [0.5, 0.9, 0.99]) {
      const exact = sorted[Math.ceil(q * values.length) - 1];
      const estimate = quantile(hist, q, max);
      assert.ok(Math.abs(estimate - exact) / exact <= 0.1, `q${q}: estimate ${estimate}, exact ${exact}`);
    }
  }
  assert.equal(quantile({}, 0.5), null);
  assert.equal(quantile({ 5: 1 }, 0.9, 12), 12, 'never above the exact max');
});

function fill(usage) {
  const lines = [
    { time: '2026-10-12T13:00:00.000Z', token: A, tool: 'studio_inspect', ms: 900, ok: true },
    { time: '2026-10-12T13:01:00.000Z', token: A, tool: 'studio_inspect', ms: 1100, ok: true },
    { time: '2026-10-12T13:02:00.000Z', token: A, tool: 'odc_read', ms: 2100, ok: false, error: 'AGENT_NOT_CONNECTED' },
    { time: '2026-10-12T13:03:00.000Z', token: B, tool: 'odc_read', ms: 300, ok: false, error: 'AGENT_NOT_CONNECTED' },
    { time: '2026-10-12T13:04:00.000Z', token: B, tool: 'odc_read', ms: 300, ok: false },
    { time: '2026-10-12T01:30:00.000Z', token: B, tool: 'ssam_doctor', ms: 40, ok: true },     // 22:30 local on 11/10
    { time: '2026-10-08T15:00:00.000Z', token: A, tool: 'ssam_doctor', ms: 50, ok: true },
    { time: '2026-09-20T15:00:00.000Z', token: A, tool: 'ssam_doctor', ms: 50, ok: true },     // outside 7d and 30d
    { time: '2026-10-12T13:05:00.000Z', token: 'tok_bad', tool: 'x', ms: 1, ok: true },        // ignored
  ];
  for (const l of lines) usage.addCall(l);
  usage.addSessionOpened(A, '2026-10-12T12:00:00.000Z');
  usage.addAgentCall(A, '2026-10-12T12:30:00.000Z', false, 'AGENT_TIMEOUT');
  usage.addAgentCall(A, '2026-10-12T12:31:00.000Z', true, null);
}

test('summaries: byCode, byTool, byDay, ranges and the token filter', () => {
  const state = createState(tempDir('us'));
  const now = clock('2026-10-12T15:00:00Z');
  const usage = createUsage({ tz, state, now });
  fill(usage);
  const today = tz.day(now());
  assert.equal(today, '2026-10-12');
  const day = usage.get('2026-10-11');
  assert.equal(day.total.calls, 1, '01:30Z lands in the local 11/10');
  assert.equal(day.hours[22], 1);
  const s = usage.summarize(tz.days(today, 7), { nameOf: t => ({ [A]: 'Cliente Alfa', [B]: 'Cliente Beta' })[t] });
  assert.equal(s.totals.calls, 7);
  assert.equal(s.totals.failures, 3);
  assert.equal(s.totals.customersActive, 2);
  assert.equal(s.totals.sessionsOpened, 1);
  assert.equal(s.totals.agentCalls, 2);
  assert.equal(s.totals.agentFailures, 1);
  assert.equal(s.totals.maxMs, 2100);
  assert.deepEqual(s.byCode.map(c => [c.code, c.count, c.customers]), [['AGENT_NOT_CONNECTED', 2, 2], ['TOOL_ERROR', 1, 1]]);
  assert.deepEqual(s.byCode[0].tools, [{ tool: 'odc_read', count: 2 }]);
  assert.equal(s.byCode[0].lastAt, '2026-10-12T13:03:00.000Z');
  assert.deepEqual(s.byTool.map(t => [t.tool, t.calls, t.failures, t.customers, t.topCode]),
    [['odc_read', 3, 3, 2, 'AGENT_NOT_CONNECTED'], ['ssam_doctor', 2, 0, 2, null], ['studio_inspect', 2, 0, 1, null]]);
  assert.deepEqual(s.byDay.map(d => [d.day, d.calls]), [['2026-10-12', 5], ['2026-10-11', 1], ['2026-10-10', 0], ['2026-10-09', 0],
    ['2026-10-08', 1], ['2026-10-07', 0], ['2026-10-06', 0]]);
  assert.equal(s.byDay[2].p50Ms, null);
  const alfa = s.byCustomer.find(c => c.token === A);
  assert.equal(alfa.customer, 'Cliente Alfa');
  assert.equal(alfa.topTool, 'studio_inspect');
  assert.deepEqual(alfa.daily, [0, 0, 1, 0, 0, 0, 3]);
  assert.equal(s.byCustomer[0].token, A, 'calls desc');
  const t = usage.summarize([today], { token: B });
  assert.equal(t.totals.calls, 2);
  assert.deepEqual(t.byCustomer.map(c => c.token), [B]);
  assert.deepEqual(t.byTool.map(x => x.tool), ['odc_read']);
  assert.deepEqual(t.byCode.map(c => [c.code, c.count]), [['AGENT_NOT_CONNECTED', 1], ['TOOL_ERROR', 1]]);
  const m = usage.summarize(tz.days(today, 30));
  assert.equal(m.totals.calls, 8, '30 days from 13/09 include 20/09');
  assert.equal(m.byDay.length, 30);
  const empty = usage.summarize(['2026-01-01']);
  assert.deepEqual([empty.totals.calls, empty.totals.p50Ms, empty.totals.p90Ms, empty.totals.maxMs], [0, null, null, null]);
  // day files are written atomically and read back by a new instance
  usage.flushDays();
  assert.ok(fs.existsSync(path.join(state.root, 'agg', 'usage-2026-10-12.json')));
  const saved = JSON.parse(fs.readFileSync(path.join(state.root, 'agg', 'usage-2026-10-12.json'), 'utf8'));
  assert.equal(saved.schema, 'ssam-console-usage/1');
  assert.equal(saved.day, '2026-10-12');
  const again = createUsage({ tz, state, now });
  assert.equal(again.summarize(tz.days(today, 7)).totals.calls, 7);
});

test('Caddy denials: each host.json window counted once, by ip|status|path', () => {
  const usage = createUsage({ tz, state: createState(tempDir('us')), now: clock('2026-10-12T15:00:00Z') });
  usage.addDenied({ to: '2026-10-12T14:00:00Z', denied: [{ ip: '203.0.113.9', status: 401, path: '/mcp', count: 3 }, { ip: '203.0.113.9', status: 200, path: '/', count: 9 }] });
  usage.addDenied({ to: '2026-10-12T14:00:30Z', denied: [{ ip: '203.0.113.9', status: 401, path: '/mcp', count: 2 }, { ip: '198.51.100.7', status: 429, path: '/mcp', count: 1 }] });
  const s = usage.summarize(['2026-10-12']);
  assert.deepEqual(s.denied.byStatus, { 401: 5, 429: 1 });
  assert.deepEqual(s.denied.rows.get('203.0.113.9|401|/mcp'), { count: 5, lastAt: '2026-10-12T14:00:30Z' });
});

test('API: /api/usage ranges in the display time zone; an audit line at 22:30 local is counted on its local day', async t => {
  const env = makeEnv();
  writeAudit(env.serverDir, [
    { time: '2026-10-12T01:30:00.000Z', token: A, customer: 'Cliente Alfa', tool: 'ssam_doctor', ms: 40, ok: true },
    { time: '2026-10-12T13:00:00.000Z', token: A, customer: 'Cliente Alfa', tool: 'ssam_doctor', ms: 60, ok: true },
  ]);
  const c = await startConsole(env, { now: clock('2026-10-12T15:00:00Z') });
  t.after(() => c.close());
  const day = (await c.get('/api/usage?range=day&day=2026-10-11')).body;
  assert.deepEqual(day.range, { kind: 'day', from: '2026-10-11', to: '2026-10-11', days: 1, timeZone: 'America/Sao_Paulo' });
  assert.equal(day.totals.calls, 1);
  const today = (await c.get('/api/usage?range=today')).body;
  assert.equal(today.totals.calls, 1);
  assert.equal(today.byCustomer[0].customer, 'Cliente Alfa', 'log name used for a token missing from the store');
  const week = (await c.get('/api/usage?range=7d')).body;
  assert.deepEqual([week.range.from, week.range.to, week.totals.calls], ['2026-10-06', '2026-10-12', 2]);
  assert.equal((await c.get('/api/usage?range=year')).body.error.field, 'range');
  assert.equal((await c.get('/api/usage?range=day&day=2026-13-01')).body.error.field, 'day');
  assert.equal((await c.get('/api/usage?range=7d&token=tok_xyz')).body.error.field, 'token');
});

// Review fix: tool names and error codes come from customers (the server audits every tools/call, even an unknown tool
// named "__proto__"). As map keys they must stay plain keys: no throw, Object.prototype untouched, counted, and the same
// after the day file is read back.
const PROTO_KEYS = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
const prototypeNames = () => Object.getOwnPropertyNames(Object.prototype).sort();
function cleanPrototype(before) {
  for (const k of Object.getOwnPropertyNames(Object.prototype)) if (!before.includes(k)) delete Object.prototype[k];
}

// The names come from a catalog that holds them (a hostile catalog); an error word that is no product code is TOOL_ERROR.
test('usage: tools and codes named __proto__, constructor, toString... are plain keys (counted, saved, read back)', () => {
  const before = prototypeNames();
  try {
    const state = createState(tempDir('us'));
    const now = clock('2026-10-12T15:00:00Z');
    const tools = new Set(PROTO_KEYS);
    const usage = createUsage({ tz, state, now, tools });
    PROTO_KEYS.forEach((tool, i) => {
      usage.addCall({ time: `2026-10-12T13:0${i}:00.000Z`, token: A, tool, ms: 100, ok: false, error: PROTO_KEYS[(i + 1) % PROTO_KEYS.length] });
      usage.addCall({ time: `2026-10-12T13:0${i}:30.000Z`, token: A, tool, ms: 50, ok: true });
    });
    usage.addAgentCall(A, '2026-10-12T13:10:00.000Z', false, '__proto__');
    usage.addAgentCall(A, '2026-10-12T13:11:00.000Z', false, 'constructor');
    assert.deepEqual(prototypeNames(), before, 'Object.prototype unchanged');
    assert.equal(({}).calls, undefined);
    const expectTools = PROTO_KEYS.map(n => [n, 2, 1]).sort();
    const expectCodes = [['TOOL_ERROR', 5]];
    const check = u => {
      const s = u.summarize(['2026-10-12']);
      assert.equal(s.totals.calls, 10);
      assert.equal(s.totals.failures, 5);
      assert.deepEqual(s.byTool.map(t => [t.tool, t.calls, t.failures]).sort(), expectTools);
      assert.deepEqual(s.byCode.map(c => [c.code, c.count]).sort(), expectCodes);
      assert.deepEqual(s.byCode.find(c => c.code === 'TOOL_ERROR').tools.map(t => t.tool).length, 3, 'the top three tools of the code');
      assert.equal(s.byCustomer[0].agentFailures, 2);
      const one = u.summarize(['2026-10-12'], { token: A });
      assert.deepEqual(one.byTool.map(t => [t.tool, t.calls, t.failures]).sort(), expectTools);
      assert.deepEqual(one.byCode.map(c => [c.code, c.count]).sort(), expectCodes);
      assert.equal(one.byCode.find(c => c.code === 'TOOL_ERROR').lastAt, '2026-10-12T13:04:00.000Z');
      assert.ok(PROTO_KEYS.includes(one.byCustomer[0].topTool));
    };
    check(usage);
    usage.flushDays();
    const again = createUsage({ tz, state, now, tools });
    check(again);
    // objects parsed back from the day file keep working as maps
    again.addCall({ time: '2026-10-12T14:00:00.000Z', token: A, tool: 'constructor', ms: 10, ok: false, error: '__proto__' });
    const s = again.summarize(['2026-10-12']);
    assert.deepEqual(s.byTool.find(t => t.tool === 'constructor').calls, 3);
    assert.deepEqual(s.byCode.find(c => c.code === 'TOOL_ERROR').count, 6);
    assert.deepEqual(prototypeNames(), before, 'Object.prototype unchanged');
  } finally { cleanPrototype(before); }
});

test('per-minute windows: codes and tools named __proto__ or constructor are plain keys, also after a restore', () => {
  const before = prototypeNames();
  try {
    const m = createMinutes();
    const at = '2026-10-12T13:00:10.000Z';
    m.add(at, false, '__proto__', 'constructor');
    m.add(at, false, '__proto__', 'constructor');
    m.add(at, false, 'constructor', '__proto__');
    assert.deepEqual(m.window(Date.parse(at), 15), { calls: 3, failures: 3, topCode: '__proto__', topTool: 'constructor' });
    const again = createMinutes();
    again.restore(JSON.parse(JSON.stringify(m.toJSON())));
    again.add(at, false, 'constructor', 'toString');
    again.add(at, false, 'constructor', 'toString');
    assert.deepEqual(again.window(Date.parse(at), 15), { calls: 5, failures: 5, topCode: 'constructor', topTool: 'toString' });
    assert.deepEqual(prototypeNames(), before, 'Object.prototype unchanged');
  } finally { cleanPrototype(before); }
});

test('usage: only tools of the hosted catalog keep their name; an audit error outside the registry is CODE_UNLISTED', () => {
  const catalog = loadToolNames(BOX_TOOLS_CATALOG);
  assert.ok(catalog.has('ssam_doctor') && catalog.has('o11_deliver'), 'the box catalog (server/platforms/odc/facade/hosted/tools.json)');
  assert.equal(defaultToolsCatalog(f => f === BOX_TOOLS_CATALOG), BOX_TOOLS_CATALOG);
  assert.equal(toolOf('GetFolhaPagamentoQz9', catalog), '?');
  assert.equal(toolOf('ssam_doctor', catalog), 'ssam_doctor');
  assert.equal(toolOf('ssam_doctor', new Set()), '?', 'an unreadable catalog keeps no name');
  assert.equal(loadToolNames(path.join(tempDir('cat'), 'missing.json')).size, 0);
  const usage = createUsage({ tz, state: createState(tempDir('us')), now: clock('2026-10-12T15:00:00Z'), tools: catalog });
  usage.addCall({ time: '2026-10-12T13:00:00.000Z', token: A, tool: 'GetFolhaPagamentoQz9', ms: 10, ok: false, error: 'FOLHA_PAGAMENTO_QZ9' });
  usage.addCall({ time: '2026-10-12T13:00:01.000Z', token: A, tool: 'ssam_doctor', ms: 10, ok: false, error: 'AGENT_NOT_CONNECTED' });
  const s = usage.summarize(['2026-10-12']);
  assert.deepEqual(s.byTool.map(t => t.tool).sort(), ['?', 'ssam_doctor']);
  assert.deepEqual(s.byCode.map(c => c.code).sort(), ['AGENT_NOT_CONNECTED', 'CODE_UNLISTED']);
  assert.equal(JSON.stringify(s).includes('Qz9') || JSON.stringify(s).includes('QZ9'), false);
});
