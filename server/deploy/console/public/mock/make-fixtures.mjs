#!/usr/bin/env node
// Writes the mock fixtures of the owner console (DESIGN.md 6.12): public/mock/<scenario>/<name>.json, one per GET
// endpoint plus the mutation answers and the error answers, in the shapes of DESIGN.md section 4.
//
//   node server/deploy/console/public/mock/make-fixtures.mjs           rewrites every fixture
//   node server/deploy/console/public/mock/make-fixtures.mjs --check   exits 1 when a committed fixture differs
//
// Dev only: the console API never serves public/mock/ (DESIGN.md 2.2). Every value is neutral: customers Cliente Alfa,
// Beta, Gama, Delta (and more Greek letters), documentation IP ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24),
// machines PC-TESTE-NN with user teste, the domain ssam.example.com, fake secrets ssam_EXEMPLO_NAO_E_UM_TOKEN_...
// The clock is frozen at NOW (12/10/2026 23:51:08 in America/Sao_Paulo, 02:51:08 UTC of the next day), so the
// local day and the UTC day differ on purpose.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The Qualidade payloads (DESIGN-QUALIDADE 4.6) are computed by the console's own aggregation over the design's fixture
// day (tests/fixtures/quality), so the mock answers have the exact shapes and numbers of the real API.
import { sanitizeQualityLine } from '../../quality-line.mjs';
import { createQualityEngine, emptyQualityDay, summarizeQuality } from '../../quality.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const NOW = '2026-10-13T02:51:08Z';
export const SCENARIOS = ['normal', 'vazio', 'problemas', 'sem-coletor', 'sem-renovar'];
const NOW_MS = Date.parse(NOW);
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const QUOTA = 5368709120;
const LOCAL_OFFSET = -3 * H; // America/Sao_Paulo, no DST since 2019

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const ago = (ms) => iso(NOW_MS - ms);
const ahead = (ms) => iso(NOW_MS + ms);
const daysLeft = (expiresAt) => (expiresAt == null ? null : Math.round(((Date.parse(expiresAt) - NOW_MS) / D) * 10000) / 10000);

export const HOST = 'ssam.example.com';
const PUBLIC_URL = `https://${HOST}/mcp`;
const SERVER_URL = `https://${HOST}`;
const TZ = 'America/Sao_Paulo';
const IMAGE_TAG = 'prod-20261011-ed0f94b';
const IMAGE = `ssam-server:${IMAGE_TAG}`;
const REVISION = 'ed0f94ba986867ae132dc72ca97c84e7cb2c4d78';
const KERNEL = { o11: '11.55.91', odc: '1.7.27', odcBridge: 'v48', o11Hook: null, odcBridgeAccepted: ['v45'] };

const TOK = {
  alfa: 'tok_0000000a1fa0',
  beta: 'tok_00000000be7a',
  gama: 'tok_000000006a3a',
  delta: 'tok_00000000de17',
  gamaOld: 'tok_00000006a3a0',
  zeta: 'tok_000000002e7a',
  eta: 'tok_0000000000e7',
};

// Local calendar days (America/Sao_Paulo), oldest first, ending today (12/10/2026).
function localToday() {
  const d = new Date(NOW_MS + LOCAL_OFFSET);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function localDays(n) {
  const today = localToday();
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(new Date(today - i * D).toISOString().slice(0, 10));
  return out;
}
const TODAY = localDays(1)[0];

// Deterministic pseudo-random numbers (mulberry32), so --check is stable.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Splits `total` by integer weights (largest remainder), keys in weight order.
function split(total, weights) {
  const entries = Object.entries(weights);
  const sum = entries.reduce((s, [, w]) => s + w, 0);
  if (!total || !sum) return Object.fromEntries(entries.map(([k]) => [k, 0]));
  const raw = entries.map(([k, w]) => ({ k, exact: (total * w) / sum }));
  for (const r of raw) r.n = Math.floor(r.exact);
  let left = total - raw.reduce((s, r) => s + r.n, 0);
  for (const r of [...raw].sort((a, b) => (b.exact - b.n) - (a.exact - a.n) || a.k.localeCompare(b.k))) {
    if (left <= 0) break;
    r.n += 1;
    left -= 1;
  }
  return Object.fromEntries(raw.map((r) => [r.k, r.n]));
}

const ok = (o) => ({ ok: true, ...o });
const err = (code, message, field) => ({ ok: false, error: field ? { code, message, field } : { code, message } });

// ---------------------------------------------------------------------------------------------------------------- data

const TOOL_MS = {
  studio_inspect: { p50: 640, p90: 1900, max: 2100 },
  odc_read: { p50: 380, p90: 1200, max: 1500 },
  ssam_doctor: { p50: 120, p90: 300, max: 410 },
  ssam_map: { p50: 900, p90: 2100, max: 2300 },
  studio_build: { p50: 18500, p90: 42000, max: 61000 },
  ssam_job: { p50: 7400, p90: 21000, max: 38000 },
  o11_job: { p50: 9200, p90: 26000, max: 44000 },
  ssam_discover: { p50: 520, p90: 1400, max: 1900 },
  odc_write: { p50: 2600, p90: 7400, max: 9900 },
};

/**
 * One customer's usage profile: calls per local day (30 days, oldest first), failures per day, tool weights, failure
 * mix [{tool, code, w}], last activity, agent calls ratio.
 */
function profile(p) {
  return { agentRatio: 0.4, agentFailRatio: 0, sessionsPer: 6, ...p };
}

function seriesFrom(seed, n, { base, spread, zeroEvery = 0, from = 0 }) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (i < from) {
      out.push(0);
      continue;
    }
    const v = Math.max(0, Math.round(base + (r() - 0.5) * 2 * spread));
    out.push(zeroEvery && i % zeroEvery === zeroEvery - 1 ? 0 : v);
  }
  return out;
}

function withToday(series, today) {
  const s = series.slice();
  s[s.length - 1] = today;
  return s;
}

function scenarioUsage(name) {
  if (name === 'vazio') return [];
  if (name === 'problemas') {
    return [
      profile({
        token: TOK.alfa, customer: 'Cliente Alfa',
        daily: withToday(seriesFrom(11, 30, { base: 900, spread: 500 }), 1234),
        fails: withToday(seriesFrom(12, 30, { base: 20, spread: 18 }), 41),
        tools: { studio_inspect: 9, ssam_map: 6, ssam_job: 4, odc_read: 5, studio_build: 2, ssam_doctor: 1 },
        failMix: [{ tool: 'ssam_job', code: 'JOB_REFUSED', w: 3 }, { tool: 'studio_build', code: 'BUILD_FAILED', w: 1 }],
        lastAt: ago(40 * S), lastTool: 'ssam_map', p50: 1100, p90: 9800, workspace: 1.7 * GIB,
      }),
      profile({
        token: TOK.beta, customer: 'Cliente Beta Engenharia de Software e Integrações Corporativas',
        daily: withToday(seriesFrom(21, 30, { base: 120, spread: 90 }), 63),
        fails: withToday(seriesFrom(22, 30, { base: 6, spread: 6 }), 41),
        tools: { odc_read: 6, odc_write: 3, studio_inspect: 2 },
        failMix: [{ tool: 'odc_read', code: 'AGENT_NOT_CONNECTED', w: 5 }, { tool: 'odc_write', code: 'WORKSPACE_FULL', w: 2 }],
        lastAt: ago(8 * S), lastTool: 'odc_read', p50: 450, p90: 3100, workspace: 0.96 * QUOTA, agentFailRatio: 0.3,
      }),
      profile({
        token: TOK.gama, customer: 'Cliente Gama',
        daily: seriesFrom(31, 30, { base: 60, spread: 40, zeroEvery: 7 }).map((v, i) => (i >= 27 ? 0 : v)),
        fails: seriesFrom(32, 30, { base: 2, spread: 2 }).map((v, i) => (i >= 27 ? 0 : v)),
        tools: { o11_job: 4, studio_inspect: 3, ssam_discover: 2 },
        failMix: [{ tool: 'o11_job', code: 'O11_WORKER_BUSY', w: 1 }],
        lastAt: '2026-10-09T14:10:00Z', lastTool: 'o11_job', p50: 3200, p90: 19000, workspace: 0.4 * GIB,
      }),
      profile({
        token: TOK.delta, customer: 'Cliente Delta',
        daily: withToday(seriesFrom(41, 30, { base: 40, spread: 30 }), 22),
        fails: withToday(seriesFrom(42, 30, { base: 1, spread: 1 }), 4),
        tools: { odc_read: 3, ssam_doctor: 1 },
        failMix: [{ tool: 'odc_read', code: 'AGENT_TIMEOUT', w: 1 }],
        lastAt: ago(2 * H + 5 * M), lastTool: 'odc_read', p50: 700, p90: 15000, workspace: 0.2 * GIB, agentFailRatio: 0.6,
      }),
      profile({
        token: TOK.eta, customer: 'Cliente Eta com nome comprido para testar reticências na tabela',
        daily: withToday(seriesFrom(51, 30, { base: 15, spread: 15, from: 10 }), 3),
        fails: withToday(seriesFrom(52, 30, { base: 0, spread: 1, from: 10 }), 0),
        tools: { studio_inspect: 2, ssam_map: 1 },
        failMix: [{ tool: 'ssam_map', code: 'TOOL_ERROR', w: 1 }],
        lastAt: ago(5 * H), lastTool: 'studio_inspect', p50: 800, p90: 2400, workspace: 0.85 * QUOTA,
      }),
    ];
  }
  // normal, sem-coletor, sem-renovar: today's production facts, neutral names (14 calls today, 1 failure).
  return [
    profile({
      token: TOK.alfa, customer: 'Cliente Alfa',
      daily: withToday([0, 0, 0, 6, 11, 0, 4, 9, 0, 0, 13, 7, 0, 0, 5, 8, 12, 0, 3, 0, 9, 21, 6, 0, 2, 10, 0, 0, 7, 0], 14),
      fails: withToday([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], 1),
      tools: { studio_inspect: 5, odc_read: 4, ssam_doctor: 3, ssam_map: 2 },
      failMix: [{ tool: 'odc_read', code: 'AGENT_NOT_CONNECTED', w: 1 }],
      lastAt: ago(3 * M), lastTool: 'studio_inspect', p50: 520, p90: 2100, workspace: 1153434,
    }),
    profile({
      token: TOK.beta, customer: 'Cliente Beta',
      daily: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 4, 0, 1, 0, 0, 0],
      fails: Array(30).fill(0),
      tools: { odc_read: 3, ssam_doctor: 1 },
      failMix: [{ tool: 'odc_read', code: 'AGENT_NOT_CONNECTED', w: 1 }],
      lastAt: '2026-10-09T22:20:00Z', lastTool: 'odc_read', p50: 300, p90: 900, workspace: 220160,
    }),
    profile({
      token: TOK.gama, customer: 'Cliente Gama',
      daily: [3, 5, 2, 0, 0, 4, 1, 0, 6, 2, 0, 3, 0, 1, 0, 0, 2, 4, 0, 0, 1, 3, 0, 2, 0, 0, 0, 0, 0, 0],
      fails: [0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      tools: { studio_inspect: 2, ssam_doctor: 1 },
      failMix: [{ tool: 'studio_inspect', code: 'TOOL_ERROR', w: 1 }],
      lastAt: '2026-10-07T18:40:00Z', lastTool: 'studio_inspect', p50: 610, p90: 1700, workspace: 482304,
    }),
  ];
}

// ---------------------------------------------------------------------------------------------------------------- usage

function q(v) {
  return v == null ? null : Math.round(v);
}

function buildUsage(name, kind) {
  const profiles = scenarioUsage(name);
  const n = kind === 'today' ? 1 : kind === '7d' ? 7 : 30;
  const days = localDays(n);
  const off = 30 - n;
  const byTool = new Map();
  const byCode = new Map();
  const byDay = days.map((day) => ({ day, calls: 0, failures: 0, p50Ms: null, p90Ms: null, customers: 0 }));
  const byCustomer = [];
  let sessionsOpened = 0;
  let agentCalls = 0;
  let agentFailures = 0;
  let maxMs = 0;
  for (const p of profiles) {
    const daily = p.daily.slice(off);
    const fails = p.fails.slice(off);
    const calls = daily.reduce((s, v) => s + v, 0);
    const failures = daily.reduce((s, v, i) => s + Math.min(v, fails[i]), 0);
    daily.forEach((v, i) => {
      byDay[i].calls += v;
      byDay[i].failures += Math.min(v, fails[i]);
      if (v > 0) byDay[i].customers += 1;
    });
    if (!calls) continue;
    const toolCalls = split(calls, p.tools);
    const failSplit = split(failures, Object.fromEntries(p.failMix.map((f) => [`${f.tool}|${f.code}`, f.w])));
    let top = null;
    for (const [tool, c] of Object.entries(toolCalls)) {
      if (!c) continue;
      if (!top || c > toolCalls[top]) top = tool;
      const t = byTool.get(tool) || { tool, calls: 0, failures: 0, customers: new Set(), codes: {} };
      t.calls += c;
      t.customers.add(p.token);
      byTool.set(tool, t);
    }
    for (const [key, f] of Object.entries(failSplit)) {
      if (!f) continue;
      const [tool, code] = key.split('|');
      const t = byTool.get(tool);
      if (t) {
        t.failures += f;
        t.codes[code] = (t.codes[code] || 0) + f;
      }
      const c = byCode.get(code) || { code, count: 0, tools: {}, customers: new Set(), lastAt: null };
      c.count += f;
      c.tools[tool] = (c.tools[tool] || 0) + f;
      c.customers.add(p.token);
      if (!c.lastAt || p.lastAt > c.lastAt) c.lastAt = p.lastAt;
      byCode.set(code, c);
    }
    const sess = Math.max(1, Math.ceil(calls / p.sessionsPer));
    const ac = Math.round(calls * p.agentRatio);
    const af = Math.round(ac * p.agentFailRatio);
    sessionsOpened += sess;
    agentCalls += ac;
    agentFailures += af;
    const toolMax = Math.max(...Object.keys(toolCalls).filter((t) => toolCalls[t]).map((t) => TOOL_MS[t]?.max ?? 1000));
    maxMs = Math.max(maxMs, toolMax);
    byCustomer.push({
      token: p.token,
      customer: p.customer,
      calls,
      failures,
      p50Ms: q(p.p50),
      p90Ms: q(p.p90),
      topTool: top,
      sessionsOpened: sess,
      agentCalls: ac,
      agentFailures: af,
      lastAt: p.lastAt,
      workspaceBytes: Math.round(p.workspace),
      daily,
    });
  }
  for (const d of byDay) {
    if (!d.calls) continue;
    const active = profiles.filter((p) => p.daily[off + byDay.indexOf(d)] > 0);
    const w = active.reduce((s, p) => s + p.daily[off + byDay.indexOf(d)], 0);
    d.p50Ms = q(active.reduce((s, p) => s + p.p50 * p.daily[off + byDay.indexOf(d)], 0) / w);
    d.p90Ms = q(Math.max(...active.map((p) => p.p90)));
  }
  const tools = [...byTool.values()].map((t) => {
    const ms = TOOL_MS[t.tool] || { p50: 500, p90: 1500, max: 2000 };
    const codes = Object.entries(t.codes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      tool: t.tool, calls: t.calls, failures: t.failures, p50Ms: ms.p50, p90Ms: ms.p90, maxMs: ms.max,
      customers: t.customers.size, topCode: codes.length ? codes[0][0] : null,
    };
  }).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  const codes = [...byCode.values()].map((c) => ({
    code: c.code,
    count: c.count,
    tools: Object.entries(c.tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([tool, count]) => ({ tool, count })),
    customers: c.customers.size,
    lastAt: c.lastAt,
  })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  byCustomer.sort((a, b) => b.calls - a.calls || a.customer.localeCompare(b.customer));
  const calls = byCustomer.reduce((s, c) => s + c.calls, 0);
  const failures = byCustomer.reduce((s, c) => s + c.failures, 0);
  const wsum = byCustomer.reduce((s, c) => s + c.calls, 0);
  return ok({
    range: { kind, from: days[0], to: days[days.length - 1], days: n, timeZone: TZ },
    indexing: indexing(name),
    totals: {
      calls,
      failures,
      p50Ms: calls ? q(byCustomer.reduce((s, c) => s + c.p50Ms * c.calls, 0) / wsum) : null,
      p90Ms: calls ? Math.max(...byCustomer.map((c) => c.p90Ms)) : null,
      maxMs: calls ? maxMs : null,
      customersActive: byCustomer.length,
      sessionsOpened,
      agentCalls,
      agentFailures,
    },
    byCustomer,
    byTool: tools,
    byCode: codes,
    byDay: byDay.slice().reverse(),
    denied: denied(name),
  });
}

function denied(name) {
  if (name === 'sem-coletor') return { available: false, since: null, byStatus: {}, rows: [] };
  const since = consoleStartedAt(name);
  if (name === 'vazio') return { available: true, since, byStatus: {}, rows: [] };
  if (name === 'problemas') {
    const rows = [];
    const r = rng(77);
    const nets = ['192.0.2', '198.51.100', '203.0.113'];
    const paths = ['/mcp', '/agent/v1/hello', '/agent/v1/stream', '/mcp?session=abc', '/.env', '/wp-login.php', '/agent/v1/blob/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/parte-muito-longa-para-testar-reticencias'];
    for (let i = 0; i < 50; i += 1) {
      const status = i % 9 === 0 ? 429 : i % 4 === 0 ? 403 : 401;
      rows.push({
        ip: `${nets[i % 3]}.${10 + i}`,
        status,
        path: paths[i % paths.length].slice(0, 120),
        count: i === 0 ? 312 : Math.max(1, Math.round(200 * r() * r())),
        lastAt: ago(Math.round(r() * 20 * H)),
      });
    }
    rows.sort((a, b) => b.count - a.count || a.ip.localeCompare(b.ip));
    const byStatus = {};
    for (const x of rows) byStatus[String(x.status)] = (byStatus[String(x.status)] || 0) + x.count;
    return { available: true, since, byStatus, rows };
  }
  return {
    available: true,
    since,
    byStatus: { 401: 5 },
    rows: [{ ip: '203.0.113.9', status: 401, path: '/mcp', count: 5, lastAt: ago(47 * M) }],
  };
}

// ---------------------------------------------------------------------------------------------------------------- meta

function consoleStartedAt(name) {
  return name === 'vazio' ? ago(18 * M) : ago(5 * H + 11 * M);
}

function indexing(name) {
  if (name === 'problemas') return { state: 'running', progress: 0.42, detail: 'server.log.20261005T041500Z.gz' };
  return { state: 'ready', progress: 1, detail: null };
}

function capabilities(name) {
  const full = name !== 'sem-renovar';
  return { issue: true, revoke: true, agentRotate: true, renew: full, lanes: full, readOnly: null };
}

function buildMeta(name) {
  return ok({
    console: { version: '1', startedAt: consoleStartedAt(name) },
    now: NOW,
    timeZone: TZ,
    publicHost: HOST,
    publicUrl: PUBLIC_URL,
    serverUrl: SERVER_URL,
    capabilities: capabilities(name),
    indexing: indexing(name),
  });
}

// ---------------------------------------------------------------------------------------------------------------- licenses

const R_IMAGE = 'Indisponível nesta imagem (chega com o 24º envio).';
const R_REVOKED = 'Licença revogada.';
const R_NO_EXPIRY = 'Licença sem validade: não há o que renovar.';
const R_ACTIVE = 'Só para licença ativa.';

function actionsFor(lic, caps) {
  const allow = { allowed: true, reason: null };
  const deny = (reason) => ({ allowed: false, reason });
  if (lic.state === 'revoked') {
    return { renew: deny(R_REVOKED), lanes: deny(R_REVOKED), agentRotate: deny(R_REVOKED), revoke: deny(R_REVOKED) };
  }
  return {
    renew: !caps.renew ? deny(R_IMAGE) : lic.expiresAt == null ? deny(R_NO_EXPIRY) : allow,
    lanes: !caps.lanes ? deny(R_IMAGE) : allow,
    agentRotate: lic.state === 'active' ? allow : deny(R_ACTIVE),
    revoke: allow,
  };
}

function hist(time, action, actor, token, customer, detail = {}, result = 'ok', code = null) {
  return { time, action, actor, token, customer, result, code, detail };
}

function licenseList(name) {
  if (name === 'vazio') return [];
  const caps = capabilities(name);
  const usage = new Map(scenarioUsage(name).map((p) => [p.token, p]));
  const daily14 = (tok) => (usage.get(tok)?.daily || Array(30).fill(0)).slice(16);
  const today = (tok) => {
    const p = usage.get(tok);
    return { calls: p ? p.daily[29] : 0, failures: p ? Math.min(p.daily[29], p.fails[29]) : 0 };
  };
  const ws = (tok, files, truncated = false) => {
    const p = usage.get(tok);
    return p ? { bytes: Math.round(p.workspace), files, truncated, measuredAt: ago(4 * M), quotaBytes: QUOTA } : null;
  };
  const make = (l) => {
    const lic = {
      id: l.id,
      customer: l.customer,
      state: l.state,
      createdAt: l.createdAt,
      expiresAt: l.expiresAt,
      revokedAt: l.revokedAt ?? null,
      daysLeft: daysLeft(l.expiresAt),
      lanes: l.lanes,
      agentCredentialIssuedAt: l.agentCredentialIssuedAt ?? l.createdAt,
      machine: l.machine ?? null,
      accessAlerts: l.accessAlerts ?? 0,
      agent: l.agent ?? { state: 'never', since: null, lastSignalAt: null, version: null, closedReason: null },
      sessionsOpen: l.sessionsOpen ?? 0,
      today: today(l.id),
      daily14: daily14(l.id),
      lastActivity: l.lastActivity ?? null,
      workspace: l.workspace === undefined ? ws(l.id, 40) : l.workspace,
      actions: null,
      history: l.history ?? [],
    };
    lic.actions = actionsFor(lic, caps);
    return lic;
  };

  if (name === 'problemas') {
    const beta = 'Cliente Beta Engenharia de Software e Integrações Corporativas';
    const eta = 'Cliente Eta com nome comprido para testar reticências na tabela';
    return [
      make({
        id: TOK.alfa, customer: 'Cliente Alfa', state: 'active', createdAt: '2026-07-14T03:00:00Z', expiresAt: '2026-10-13T02:58:00Z',
        lanes: ['odc', 'o11'], machine: { id: 'm-3f2a9c', name: 'PC-TESTE-01', user: 'teste', at: '2026-07-14T12:00:00Z' },
        agent: { state: 'connected', since: ago(9 * H), lastSignalAt: ago(4 * S), version: '0.4.2', closedReason: null },
        sessionsOpen: 2, lastActivity: { at: ago(40 * S), tool: 'ssam_map', kind: 'call' }, workspace: ws(TOK.alfa, 18342),
        history: [hist('2026-07-14T03:00:00Z', 'issue', 'externo', TOK.alfa, 'Cliente Alfa', { days: 91, lanes: ['odc', 'o11'], expiresAt: '2026-10-13T02:58:00Z' })],
      }),
      make({
        id: TOK.beta, customer: beta, state: 'active', createdAt: '2026-09-14T20:00:00Z', expiresAt: '2026-10-14T20:00:00Z',
        lanes: ['odc'], machine: { id: 'm-77aa01', name: 'PC-TESTE-01', user: 'teste', at: '2026-09-15T13:02:00Z' }, accessAlerts: 2,
        agent: { state: 'connected', since: ago(1 * H + 37 * M), lastSignalAt: ago(2 * S), version: '0.4.1', closedReason: null },
        sessionsOpen: 8, lastActivity: { at: ago(8 * S), tool: 'odc_read', kind: 'call' }, workspace: ws(TOK.beta, 412004, true),
        history: [
          hist(ago(26 * H), 'agent-rotate', 'painel', TOK.beta, beta, {}, 'error', 'STORE_WRITE_FAILED'),
          hist('2026-09-14T20:00:00Z', 'issue', 'painel', TOK.beta, beta, { days: 30, lanes: ['odc'], expiresAt: '2026-10-14T20:00:00Z' }),
        ],
      }),
      make({
        id: TOK.gama, customer: 'Cliente Gama', state: 'expired', createdAt: '2026-09-09T15:00:00Z', expiresAt: '2026-10-09T15:00:00Z',
        lanes: ['odc', 'o11'], machine: { id: 'm-0c11aa', name: 'PC-TESTE-03', user: 'teste', at: '2026-09-09T18:00:00Z' },
        agent: { state: 'disconnected', since: '2026-10-09T15:00:01Z', lastSignalAt: '2026-10-09T14:59:40Z', version: '0.4.0', closedReason: 'expired' },
        lastActivity: { at: '2026-10-09T14:10:00Z', tool: 'o11_job', kind: 'call' }, workspace: ws(TOK.gama, 9120),
        history: [hist('2026-09-09T15:00:00Z', 'issue', 'painel', TOK.gama, 'Cliente Gama', { days: 30, lanes: ['odc', 'o11'], expiresAt: '2026-10-09T15:00:00Z' })],
      }),
      make({
        id: TOK.delta, customer: 'Cliente Delta', state: 'active', createdAt: '2026-09-17T21:00:00Z', expiresAt: '2026-10-17T21:00:00Z',
        lanes: ['odc'], machine: { id: 'm-9d00e1', name: 'PC-TESTE-04', user: 'teste', at: '2026-09-18T11:30:00Z' }, accessAlerts: 1,
        agent: { state: 'disconnected', since: ago(3 * H), lastSignalAt: ago(3 * H + 45 * S), version: '0.4.2', closedReason: 'sem sinal' },
        lastActivity: { at: ago(2 * H + 5 * M), tool: 'odc_read', kind: 'call' }, workspace: ws(TOK.delta, 2210),
        history: [
          hist('2026-10-02T13:20:00Z', 'lanes', 'painel', TOK.delta, 'Cliente Delta', { previousLanes: ['odc', 'o11'], lanes: ['odc'] }),
          hist('2026-09-17T21:00:00Z', 'issue', 'painel', TOK.delta, 'Cliente Delta', { days: 30, lanes: ['odc', 'o11'], expiresAt: '2026-10-17T21:00:00Z' }),
        ],
      }),
      make({
        id: TOK.gamaOld, customer: 'Cliente Gama', state: 'revoked', createdAt: '2026-06-01T12:00:00Z', expiresAt: '2026-08-30T12:00:00Z',
        revokedAt: '2026-08-01T16:45:00Z', lanes: ['odc'], machine: null, workspace: null,
        agent: { state: 'disconnected', since: '2026-08-01T16:45:01Z', lastSignalAt: '2026-08-01T16:44:30Z', version: '0.3.9', closedReason: 'revoked' },
        lastActivity: { at: '2026-08-01T16:40:00Z', tool: null, kind: 'session' },
        history: [hist('2026-08-01T16:45:00Z', 'revoke', 'externo', TOK.gamaOld, 'Cliente Gama')],
      }),
      make({
        id: TOK.zeta, customer: 'Cliente Zeta', state: 'active', createdAt: '2026-05-02T10:00:00Z', expiresAt: null,
        lanes: ['o11'], machine: null, workspace: { bytes: 0, files: 0, truncated: false, measuredAt: ago(4 * M), quotaBytes: QUOTA },
        history: [hist('2026-05-02T10:00:00Z', 'issue', 'externo', TOK.zeta, 'Cliente Zeta', { days: null, lanes: ['o11'] })],
      }),
      make({
        id: TOK.eta, customer: eta, state: 'active', createdAt: '2026-09-22T12:00:00Z', expiresAt: '2027-09-22T12:00:00Z',
        lanes: ['odc', 'o11'], machine: { id: 'm-<img>', name: '<img src=x onerror=alert(1)>', user: 'teste<script>alert(2)</script>', at: '2026-09-23T09:00:00Z' },
        agent: { state: 'connected', since: ago(26 * H), lastSignalAt: ago(9 * S), version: '0.4.2', closedReason: null },
        sessionsOpen: 1, lastActivity: { at: ago(5 * H), tool: 'studio_inspect', kind: 'call' }, workspace: ws(TOK.eta, 51870),
        history: [hist('2026-09-22T12:00:00Z', 'issue', 'painel', TOK.eta, eta, { days: 365, lanes: ['odc', 'o11'], expiresAt: '2027-09-22T12:00:00Z' })],
      }),
    ];
  }

  return [
    make({
      id: TOK.alfa, customer: 'Cliente Alfa', state: 'active', createdAt: '2026-09-12T21:00:00Z', expiresAt: '2026-11-11T21:00:00Z',
      lanes: ['odc', 'o11'], agentCredentialIssuedAt: '2026-10-12T05:30:00Z',
      machine: { id: 'm-3f2a9c', name: 'PC-TESTE-01', user: 'teste', at: '2026-10-12T05:35:00Z' },
      agent: { state: 'connected', since: ago(3 * H + 12 * M), lastSignalAt: ago(12 * S), version: '0.4.2', closedReason: null },
      sessionsOpen: 1, lastActivity: { at: ago(3 * M), tool: 'studio_inspect', kind: 'call' }, workspace: ws(TOK.alfa, 214),
      history: [
        hist('2026-10-12T05:30:00Z', 'agent-rotate', 'painel', TOK.alfa, 'Cliente Alfa'),
        hist('2026-09-12T21:00:00Z', 'issue', 'externo', TOK.alfa, 'Cliente Alfa', { days: 60, lanes: ['odc', 'o11'], expiresAt: '2026-11-11T21:00:00Z' }),
      ],
    }),
    make({
      id: TOK.beta, customer: 'Cliente Beta', state: 'active', createdAt: '2026-10-05T02:58:00Z', expiresAt: '2026-10-15T02:58:00Z',
      lanes: ['odc'], lastActivity: { at: '2026-10-09T22:20:00Z', tool: 'odc_read', kind: 'call' }, workspace: ws(TOK.beta, 31),
      history: [hist('2026-10-05T02:58:00Z', 'issue', 'externo', TOK.beta, 'Cliente Beta', { days: 10, lanes: ['odc'], expiresAt: '2026-10-15T02:58:00Z' })],
    }),
    make({
      id: TOK.gama, customer: 'Cliente Gama', state: 'revoked', createdAt: '2026-09-20T15:00:00Z', expiresAt: '2026-10-20T15:00:00Z',
      revokedAt: '2026-10-11T14:12:00Z', lanes: ['odc'], machine: { id: 'm-0c11aa', name: 'PC-TESTE-03', user: 'teste', at: '2026-09-21T12:00:00Z' },
      agent: { state: 'disconnected', since: '2026-10-11T14:12:01Z', lastSignalAt: '2026-10-11T14:11:50Z', version: '0.4.1', closedReason: 'revoked' },
      lastActivity: { at: '2026-10-07T18:40:00Z', tool: 'studio_inspect', kind: 'call' }, workspace: ws(TOK.gama, 66),
      history: [
        hist('2026-10-11T14:12:00Z', 'revoke', 'painel', TOK.gama, 'Cliente Gama'),
        hist('2026-09-20T15:00:00Z', 'issue', 'externo', TOK.gama, 'Cliente Gama', { days: 30, lanes: ['odc'], expiresAt: '2026-10-20T15:00:00Z' }),
      ],
    }),
  ];
}

function buildLicenses(name) {
  return ok({ now: NOW, capabilities: capabilities(name), licenses: licenseList(name) });
}

// ---------------------------------------------------------------------------------------------------------------- alerts

function alert(rule, subjectKey, severity, area, title, detail, view, since, extra = {}) {
  return {
    id: `${rule}:${subjectKey}`,
    rule,
    severity,
    area,
    title,
    detail: detail ?? null,
    since,
    lastSeen: ago(6 * S),
    subject: extra.subject ?? {},
    view,
    event: extra.event ?? false,
    acked: extra.acked ?? false,
    ackedUntil: extra.ackedUntil ?? null,
  };
}

const D_RENOVE = 'Renove em Licenças. Ao vencer, as sessões e o canal do agente dele são fechados.';
const D_SSH = 'Com acesso só por chave: PasswordAuthentication no e PermitRootLogin prohibit-password.';
const D_BACKUP = 'DEPLOY.md seção 9; o cron diário instala com host/install.sh --with-crons.';
const D_REBOOT = 'Reiniciar derruba sessões e chamadas em curso: escolha uma janela.';

function normalHostAlerts(since) {
  return [
    alert('backup-ausente', 'host', 'critical', 'backup', 'Nenhum backup do estado em /var/backups/ssam-server.', D_BACKUP, 'vps', since),
    alert('backup-sem-cron', 'host', 'warning', 'backup', 'O backup diário não está agendado (falta /etc/cron.d/ssam-backup).', null, 'vps', since),
    alert('rotacao-sem-cron', 'host', 'warning', 'backup', 'A rotação de logs não está agendada: o server.log tem 7,2 KiB e só cresce.', null, 'vps', since),
    alert('reinicio-pendente', 'host', 'warning', 'vps', 'Reinício da VPS pendente desde 07/10/2026 (linux-image-7.0.0-38-generic, linux-base).', D_REBOOT, 'vps', since),
    alert('ssh-senha', 'host', 'warning', 'seguranca', 'SSH aceita login por senha e root com senha; 40 tentativas falhas em 24 h, sem fail2ban.', D_SSH, 'vps', since),
    alert('aquecimento-parcial', 'ssam-server', 'info', 'servidor', 'O worker ODC falhou no aquecimento, mas está rodando agora (subiu sob demanda).', null, 'vps', since),
  ];
}

function betaAlert(since) {
  return alert('licenca-vence', TOK.beta, 'warning', 'licencas', 'Licença de Cliente Beta vence em 2 dias (14/10/2026).', D_RENOVE, 'licencas', since,
    { subject: { token: TOK.beta, customer: 'Cliente Beta' } });
}

function problemAlerts() {
  const beta = 'Cliente Beta Engenharia de Software e Integrações Corporativas';
  const eta = 'Cliente Eta com nome comprido para testar reticências na tabela';
  const s = (h) => ago(h * H);
  return [
    alert('licenca-vence', TOK.alfa, 'critical', 'licencas', 'Licença de Cliente Alfa vence hoje às 23:58.', D_RENOVE, 'licencas', s(46), { subject: { token: TOK.alfa, customer: 'Cliente Alfa' } }),
    alert('licenca-vence', TOK.beta, 'critical', 'licencas', `Licença de ${beta} vence em 1 dia (14/10/2026).`, D_RENOVE, 'licencas', s(120), { subject: { token: TOK.beta, customer: beta } }),
    alert('licenca-vence', TOK.delta, 'warning', 'licencas', 'Licença de Cliente Delta vence em 5 dias (17/10/2026).', D_RENOVE, 'licencas', s(50), { subject: { token: TOK.delta, customer: 'Cliente Delta' } }),
    alert('licenca-venceu', TOK.gama, 'warning', 'licencas', 'Licença de Cliente Gama venceu em 09/10/2026 e ele usou o SSAM nos 14 dias anteriores.', 'Renove se o contrato continua.', 'licencas', s(83), { subject: { token: TOK.gama, customer: 'Cliente Gama' } }),
    alert('licencas-ilegiveis', 'tokens', 'critical', 'licencas', 'O arquivo de licenças (tokens.json) não pode ser lido: o servidor responde 500 e fecha as sessões abertas.', 'EACCES', 'licencas', ago(4 * M)),
    alert('acesso-outra-maquina', `${TOK.beta}:m-77aa02`, 'critical', 'licencas', `Credencial do agente de ${beta} usada em outra máquina: PC-TESTE-02 (teste) em vez de PC-TESTE-01 (teste), IP 198.51.100.44, 12/10/2026 21:14.`, 'Se não foi o cliente, troque a credencial do agente ou revogue a licença.', 'licencas', '2026-10-13T00:14:00Z', { subject: { token: TOK.beta, customer: beta, machine: 'PC-TESTE-02 (teste)', ip: '198.51.100.44' }, event: true }),
    alert('espaco-cliente', TOK.beta, 'critical', 'licencas', `Espaço de trabalho de ${beta} em 96% da cota de 5 GiB (4,8 GiB).`, 'Acima da cota as chamadas recebem WORKSPACE_FULL.', 'licencas', s(30), { subject: { token: TOK.beta, customer: beta } }),
    alert('espaco-cliente', TOK.eta, 'warning', 'licencas', `Espaço de trabalho de ${eta} em 85% da cota de 5 GiB (4,3 GiB).`, 'Acima da cota as chamadas recebem WORKSPACE_FULL.', 'licencas', s(70), { subject: { token: TOK.eta, customer: eta } }),
    alert('sessoes-limite', TOK.beta, 'info', 'agentes', `${beta} está no limite de 8 sessões MCP abertas.`, 'A próxima sessão substitui a mais antiga sem fluxo aberto.', 'agentes', ago(25 * M), { subject: { token: TOK.beta, customer: beta } }),
    alert('pico-falhas', 'global', 'critical', 'uso', 'Pico de falhas: 41 de 63 chamadas falharam nos últimos 15 min (mais comum: AGENT_NOT_CONNECTED em odc_read).', null, 'uso', ago(11 * M)),
    alert('falhas-agente', TOK.delta, 'warning', 'agentes', '12 chamadas ao agente de Cliente Delta falharam nos últimos 15 min (mais comum: AGENT_TIMEOUT).', null, 'agentes', ago(13 * M), { subject: { token: TOK.delta, customer: 'Cliente Delta' } }),
    alert('erro-servidor', 'ssam-server', 'warning', 'servidor', 'O servidor registrou 3 erro(s) interno(s) na última hora (request-failed: ECONNRESET).', null, 'eventos', ago(38 * M)),
    alert('servidor-fora', 'ssam-server', 'critical', 'servidor', 'O container ssam-server está reiniciando.', null, 'vps', ago(3 * M), { subject: { container: 'ssam-prod-ssam-server-1' } }),
    alert('caddy-fora', 'caddy', 'critical', 'servidor', 'O Caddy está parado: ninguém de fora alcança o servidor.', null, 'vps', ago(7 * M), { subject: { container: 'ssam-prod-caddy-1' } }),
    alert('container-reiniciou', 'ssam-server', 'warning', 'servidor', 'ssam-server reiniciou 4 vez(es) nas últimas 24 h.', null, 'vps', s(9), { subject: { container: 'ssam-prod-ssam-server-1' } }),
    alert('container-oom', 'ssam-server', 'critical', 'servidor', 'ssam-server foi encerrado por falta de memória (OOM).', 'Suba SSAM_MEMORY ou baixe SSAM_BUILD_WORKERS (DEPLOY.md seção 10).', 'vps', ago(3 * M), { subject: { container: 'ssam-prod-ssam-server-1' } }),
    alert('nao-aquecido', 'ssam-server', 'warning', 'servidor', 'Aquecimento: o índice O11 falhou (EACCES ao abrir o cache do índice).', null, 'vps', ago(52 * M)),
    alert('aquecimento-parcial', 'ssam-server', 'info', 'servidor', 'O worker ODC falhou no aquecimento, mas está rodando agora (subiu sob demanda).', null, 'vps', ago(52 * M)),
    alert('kernel-ausente', 'ssam-server', 'critical', 'servidor', 'O servidor partiu sem kernel.json válido (o11 ou odcBridge nulos): as faixas hospedadas recusam chamadas.', 'DEPLOY.md seção 7.1.', 'vps', ago(58 * M)),
    alert('kernel-mudou', 'ssam-server', 'warning', 'servidor', 'kernel.json mudou depois da partida (odcBridge: nulo → v49); só vale depois de reiniciar o ssam-server.', null, 'vps', ago(31 * M)),
    alert('certificado', HOST, 'critical', 'tls', `Certificado TLS de ${HOST} vence em 5 dias (18/10/2026); o Caddy renova com 30 dias, veja o log dele.`, null, 'vps', s(400)),
    alert('certificado-ausente', 'caddy', 'critical', 'tls', 'Nenhum certificado TLS encontrado no volume do Caddy.', null, 'vps', ago(7 * M)),
    alert('disco', '/', 'critical', 'vps', 'Disco / em 92% (86 GiB de 94 GiB).', null, 'vps', s(14), { subject: { mount: '/' } }),
    alert('disco', '/var/lib/docker', 'warning', 'vps', 'Inodes de /var/lib/docker em 81%.', null, 'vps', s(20), { subject: { mount: '/var/lib/docker' } }),
    alert('memoria', 'host', 'critical', 'vps', 'Memória disponível da VPS em 5% (397 MiB); sem swap, um pico pode derrubar o servidor.', null, 'vps', ago(9 * M)),
    alert('memoria-container', 'ssam-server', 'critical', 'vps', 'ssam-server usa 96% do limite de memória (5,8 GiB de 6 GiB).', null, 'vps', ago(9 * M), { subject: { container: 'ssam-prod-ssam-server-1' } }),
    alert('carga', 'host', 'warning', 'vps', 'Carga da VPS em 4,8 com 2 vCPU há 5 min.', null, 'vps', ago(6 * M)),
    alert('backup-ausente', 'host', 'critical', 'backup', 'Nenhum backup do estado em /var/backups/ssam-server.', D_BACKUP, 'vps', s(2)),
    alert('backup-velho', 'host', 'critical', 'backup', 'O último backup tem 40 h (limite 26 h): ssam-state-20261011T103000Z.tar.gz.', null, 'vps', s(14)),
    alert('backup-falhou', 'host', 'critical', 'backup', 'O último backup falhou: backup: FAILED 2026-10-12T06:30:02Z tar: /data/server: Cannot open: Permission denied.', null, 'vps', s(20)),
    alert('backup-sem-cron', 'host', 'warning', 'backup', 'O backup diário não está agendado (falta /etc/cron.d/ssam-backup).', null, 'vps', s(2)),
    alert('rotacao-sem-cron', 'host', 'warning', 'backup', 'A rotação de logs não está agendada: o server.log tem 620 MiB e só cresce.', null, 'vps', s(400)),
    alert('log-grande', 'ssam-server', 'warning', 'servidor', 'server.log com 620 MiB: rode a rotação (DEPLOY.md seção 10).', null, 'vps', s(72)),
    alert('reinicio-pendente', 'host', 'warning', 'vps', 'Reinício da VPS pendente desde 07/10/2026 (linux-image-7.0.0-38-generic, linux-base, libc6, systemd, openssl, docker-ce).', D_REBOOT, 'vps', s(108)),
    alert('atualizacoes-seguranca', 'host', 'warning', 'vps', '7 atualização(ões) de segurança pendente(s) há 3 dias.', null, 'vps', s(72)),
    alert('ssh-senha', 'host', 'warning', 'seguranca', 'SSH aceita login por senha e root com senha; 1.284 tentativas falhas em 24 h, sem fail2ban.', D_SSH, 'vps', s(400)),
    alert('firewall', 'host', 'warning', 'seguranca', 'Firewall libera portas além de 22, 80 e 443: 3000/tcp, 8080/tcp.', null, 'vps', s(28)),
    alert('coolify-rodando', 'coolify-proxy', 'warning', 'servidor', 'Container do Coolify coolify-proxy está rodando (foi parado de propósito; o coolify-proxy disputa as portas 80 e 443).', null, 'vps', ago(7 * M), { subject: { container: 'coolify-proxy' } }),
    alert('recusas-acesso', '203.0.113.10', 'warning', 'seguranca', '312 acessos recusados (401/403) vindos de 203.0.113.10 nos últimos 15 min.', 'O servidor não registra 401/403; o dado vem do log do Caddy, só por IP.', 'uso', ago(12 * M), { subject: { ip: '203.0.113.10' } }),
    alert('limite-taxa', 'global', 'info', 'uso', '17 resposta(s) 429 (limite de taxa) nos últimos 15 min.', null, 'uso', ago(10 * M)),
    alert('relogio', 'host', 'warning', 'vps', 'O relógio da VPS não está sincronizado (NTP).', null, 'vps', s(5)),
    alert('unidades-falhas', 'host', 'warning', 'vps', '2 unidade(s) do systemd com falha.', null, 'vps', s(5)),
    alert('coletor', 'host', 'warning', 'coletor', 'O coletor da VPS parou: últimos dados às 23:45 (há 5 min 40 s).', null, 'vps', ago(4 * M)),
    alert('coleta-parcial', 'host', 'info', 'coletor', 'Coleta parcial: updates, tls falharam (TIMEOUT).', null, 'vps', ago(30 * M)),
    alert('painel-leitura', 'audit', 'critical', 'painel', 'O painel não consegue ler audit-20261013.jsonl (EIO).', null, 'eventos', ago(2 * M)),
    alert('eventos-perdidos', 'server.log', 'info', 'painel', 'Parte do server.log girado não pôde ser lida; a contagem desse trecho pode faltar.', null, 'eventos', s(3)),
  ];
}

function problemAcked() {
  return [
    alert('acesso-outra-maquina', `${TOK.delta}:m-9d00e2`, 'critical', 'licencas', 'Credencial do agente de Cliente Delta usada em outra máquina: PC-TESTE-05 (teste) em vez de PC-TESTE-04 (teste), IP 192.0.2.61, 10/10/2026 09:12.', 'Se não foi o cliente, troque a credencial do agente ou revogue a licença.', 'licencas', '2026-10-10T12:12:00Z',
      { subject: { token: TOK.delta, customer: 'Cliente Delta', machine: 'PC-TESTE-05 (teste)', ip: '192.0.2.61' }, event: true, acked: true, ackedUntil: null }),
    alert('container-reiniciou', 'caddy', 'warning', 'servidor', 'caddy reiniciou 1 vez(es) nas últimas 24 h.', null, 'vps', ago(20 * H), { subject: { container: 'ssam-prod-caddy-1' }, acked: true, ackedUntil: ahead(5 * D + 3 * H) }),
  ];
}

function scenarioAlerts(name) {
  const since = ago(5 * H + 10 * M);
  if (name === 'vazio') return { alerts: [], acked: [] };
  if (name === 'problemas') return { alerts: problemAlerts(), acked: problemAcked() };
  if (name === 'sem-coletor') {
    return {
      alerts: [
        alert('coletor', 'host', 'critical', 'coletor', 'O coletor da VPS não está instalado ou nunca rodou (host/install.sh).', null, 'vps', since),
        betaAlert(since),
      ],
      acked: [],
    };
  }
  return { alerts: [...normalHostAlerts(since), betaAlert(since)], acked: [] };
}

const SEV = { critical: 0, warning: 1, info: 2 };
function sortAlerts(list) {
  return list.slice().sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------------------------- events

function ev(seq, time, level, group, token, customer, text, code = null) {
  return { seq, time, level, group, token, customer, text, code };
}

function normalEvents() {
  const since = ago(5 * H + 12 * M);
  const list = [];
  const add = (time, level, group, token, customer, text, code) => list.push({ time, level, group, token, customer, text, code: code ?? null });
  add(since, 'info', 'servidor', null, null, 'Servidor iniciado (pid 7, modo hosted).');
  add(ago(5 * H + 9 * M), 'info', 'painel', null, null, 'Resolvido: O coletor da VPS não está instalado ou nunca rodou (host/install.sh).');
  add(ago(3 * H + 12 * M), 'info', 'agente', TOK.alfa, 'Cliente Alfa', 'Agente de Cliente Alfa conectou (versão 0.4.2, PC-TESTE-01, IP 198.51.100.23).');
  add(ago(2 * H + 41 * M), 'info', 'sessao', TOK.alfa, 'Cliente Alfa', 'Cliente Alfa abriu sessão MCP (claude-code 2.1.281, IP 203.0.113.24).');
  add(ago(2 * H + 40 * M), 'info', 'chamada', TOK.alfa, 'Cliente Alfa', 'Cliente Alfa chamou ssam_doctor: ok em 120 ms.');
  add(ago(2 * H + 38 * M), 'warning', 'chamada', TOK.alfa, 'Cliente Alfa', 'Cliente Alfa chamou odc_read: falhou com AGENT_NOT_CONNECTED em 41 ms.', 'AGENT_NOT_CONNECTED');
  add(ago(2 * H + 30 * M), 'info', 'sessao', TOK.alfa, 'Cliente Alfa', 'Cliente Alfa: sessão MCP encerrada (o cliente encerrou).');
  add(ago(1 * H + 50 * M), 'info', 'sessao', TOK.alfa, 'Cliente Alfa', 'Cliente Alfa abriu sessão MCP (claude-code 2.1.281, IP 203.0.113.24).');
  const tools = ['studio_inspect', 'odc_read', 'ssam_doctor', 'studio_inspect', 'ssam_map', 'odc_read', 'studio_inspect', 'ssam_doctor', 'odc_read', 'studio_inspect', 'ssam_map', 'studio_inspect'];
  const durs = ['850 ms', '1,2 s', '120 ms', '640 ms', '2,1 s', '380 ms', '1,9 s', '300 ms', '410 ms', '700 ms', '900 ms', '850 ms'];
  tools.forEach((tool, i) => add(ago(1 * H + 45 * M - i * 8 * M), 'info', 'chamada', TOK.alfa, 'Cliente Alfa', `Cliente Alfa chamou ${tool}: ok em ${durs[i]}.`));
  add(ago(47 * M), 'info', 'vps', null, null, 'Saúde do ssam-server: iniciando → saudável.');
  add(ago(3 * M), 'info', 'chamada', TOK.alfa, 'Cliente Alfa', 'Cliente Alfa chamou studio_inspect: ok em 850 ms.');
  list.sort((a, b) => a.time.localeCompare(b.time));
  // Older entries of the ring (yesterday and before), so the Quando column shows both formats.
  const older = [
    ev(0, '2026-10-11T14:12:00Z', 'info', 'licenca', TOK.gama, 'Cliente Gama', 'Licença de Cliente Gama revogada.'),
    ev(0, '2026-10-11T14:12:01Z', 'info', 'agente', TOK.gama, 'Cliente Gama', 'Agente de Cliente Gama desconectou (licença revogada).'),
    ev(0, '2026-10-12T05:30:00Z', 'info', 'licenca', TOK.alfa, 'Cliente Alfa', 'Credencial do agente de Cliente Alfa trocada.'),
    ev(0, '2026-10-12T05:35:00Z', 'info', 'agente', TOK.alfa, 'Cliente Alfa', 'Máquina registrada para Cliente Alfa: PC-TESTE-01 (teste).'),
  ];
  const all = [...older, ...list.map((e) => ev(0, e.time, e.level, e.group, e.token, e.customer, e.text, e.code))];
  all.sort((a, b) => a.time.localeCompare(b.time));
  return all.map((e, i) => ({ ...e, seq: 101 + i }));
}

function problemEvents() {
  const r = rng(99);
  const beta = 'Cliente Beta Engenharia de Software e Integrações Corporativas';
  const eta = 'Cliente Eta com nome comprido para testar reticências na tabela';
  const who = [[TOK.alfa, 'Cliente Alfa'], [TOK.beta, beta], [TOK.delta, 'Cliente Delta'], [TOK.eta, eta], [TOK.gama, 'Cliente Gama']];
  const templates = [
    (c) => ['info', 'chamada', `${c} chamou studio_inspect: ok em 850 ms.`, null],
    (c) => ['warning', 'chamada', `${c} chamou odc_read: falhou com AGENT_NOT_CONNECTED em 41 ms.`, 'AGENT_NOT_CONNECTED'],
    (c) => ['info', 'sessao', `${c} abriu sessão MCP (<img src=x onerror=alert(1)>, IP 203.0.113.77).`, null],
    (c) => ['info', 'sessao', `${c}: sessão MCP encerrada (substituída (limite de 8 sessões)).`, null],
    (c) => ['warning', 'agente', `Agente de ${c} ficou 45 s sem sinal.`, null],
    (c) => ['error', 'agente', `Credencial do agente de ${c} usada em outra máquina: PC-TESTE-02 (teste).`, null],
    (c) => ['warning', 'agente', `Chamada blob-get ao agente de ${c} falhou: AGENT_TIMEOUT.`, 'AGENT_TIMEOUT'],
    (c) => ['warning', 'agente', `O agente de ${c} não aceitou studio-open em 15 s.`, null],
    () => ['error', 'servidor', 'Erro interno do servidor (request-failed: ECONNRESET).', 'ECONNRESET'],
    () => ['warning', 'vps', 'ssam-server reiniciou.', null],
    () => ['info', 'vps', 'Saúde do ssam-server: saudável → com falha.', null],
    () => ['warning', 'vps', 'Coletor da VPS parou.', null],
    (c) => ['info', 'licenca', `Faixas de ${c}: ODC, O11 → ODC (fora do painel).`, null],
    () => ['info', 'painel', 'Resolvido: Carga da VPS em 2,4 com 2 vCPU há 5 min.', null],
    (c) => ['warning', 'chamada', `${c} chamou ssam_job: falhou com JOB_REFUSED em 7,4 s. Esta descrição é longa de propósito para mostrar as reticências na coluna e o texto inteiro no título da célula.`, 'JOB_REFUSED'],
  ];
  const out = [];
  let t = NOW_MS - 30 * H;
  for (let i = 0; i < 200; i += 1) {
    t += Math.round((30 * H) / 200 * (0.4 + r() * 1.2));
    const [tok, name] = who[Math.floor(r() * who.length)];
    const tpl = templates[Math.floor(r() * templates.length)];
    const [level, group, text, code] = tpl(name);
    const personal = group === 'chamada' || group === 'sessao' || group === 'agente' || group === 'licenca';
    out.push(ev(5001 + i, iso(Math.min(t, NOW_MS - 1000)), level, group, personal ? tok : null, personal ? name : null, text, code));
  }
  out.sort((a, b) => a.time.localeCompare(b.time));
  return out.map((e, i) => ({ ...e, seq: 5001 + i }));
}

function semColetorEvents() {
  return normalEvents().map((e) => (e.group === 'vps' ? { ...e, text: 'Coletor da VPS parou.', level: 'warning' } : e));
}

function scenarioEvents(name) {
  if (name === 'vazio') return [];
  if (name === 'problemas') return problemEvents();
  if (name === 'sem-coletor') return semColetorEvents();
  return normalEvents();
}

function buildEvents(name) {
  const events = scenarioEvents(name);
  return ok({ lastSeq: events.length ? events[events.length - 1].seq : 0, events });
}

// ---------------------------------------------------------------------------------------------------------------- history

function buildHistory(name) {
  if (name === 'vazio') return ok({ entries: [] });
  const fromLicenses = licenseList(name).flatMap((l) => l.history);
  const extra = name === 'problemas'
    ? [
      hist(ago(40 * M), 'alert-ack', 'painel', null, null, { alert: 'container-reiniciou:caddy', hours: 168 }),
      hist(ago(2 * H), 'alert-ack', 'painel', TOK.delta, 'Cliente Delta', { alert: `acesso-outra-maquina:${TOK.delta}:m-9d00e2`, hours: null }),
      hist(ago(3 * H), 'alert-unack', 'painel', null, null, { alert: 'disco:/' }),
      hist(ago(5 * H + 11 * M), 'key-rotate', 'painel', null, null),
      hist('2026-10-11T09:00:00Z', 'renew', 'externo', TOK.eta, 'Cliente Eta com nome comprido para testar reticências na tabela', { days: 30, previousExpiresAt: '2027-08-23T12:00:00Z', expiresAt: '2027-09-22T12:00:00Z' }),
      // changes seen outside the console (restore of an older backup): a revocation undone, a record gone, an earlier expiry
      hist(ago(6 * H), 'unrevoke', 'externo', TOK.gamaOld, 'Cliente Gama', { previousRevokedAt: '2026-10-01T15:00:00Z' }),
      hist(ago(6 * H), 'removed', 'externo', TOK.zeta, 'Cliente Zeta', { previousState: 'active' }),
      hist(ago(6 * H), 'expiry-shortened', 'externo', TOK.alfa, 'Cliente Alfa', { previousExpiresAt: '2027-01-10T12:00:00Z', expiresAt: '2026-12-10T12:00:00Z' }),
      hist(ago(6 * H), 'rename', 'externo', TOK.alfa, 'Cliente Alfa', { previousCustomer: 'Cliente Alfa Ltda' }),
    ]
    : [
      hist(ago(5 * H + 11 * M), 'key-rotate', 'painel', null, null),
      hist('2026-10-11T20:00:00Z', 'alert-ack', 'painel', null, null, { alert: 'reinicio-pendente:host', hours: 24 }),
      hist('2026-10-11T14:05:00Z', 'key-rotate', 'painel', null, null),
    ];
  const entries = [...fromLicenses, ...extra].sort((a, b) => b.time.localeCompare(a.time));
  return ok({ entries });
}

// ---------------------------------------------------------------------------------------------------------------- live

function buildLive(name) {
  const since = ago(5 * H + 12 * M);
  const server = name === 'vazio'
    ? { since: ago(19 * M), pid: 7, mode: 'hosted', ratePerMinute: 120, maxSessionsPerToken: 8, publicHosts: [HOST] }
    : { since, pid: 7, mode: 'hosted', ratePerMinute: 120, maxSessionsPerToken: 8, publicHosts: [HOST] };
  const baseWorkers = [
    { kind: 'server', token: null, customer: null, port: 7310, rssB: 174000000, cpuPct: 0.1, elapsedS: 18720 },
    { kind: 'odc-worker', token: null, customer: null, port: 18547, rssB: 368000000, cpuPct: 0.1, elapsedS: 17710 },
  ];
  if (name === 'vazio') {
    return ok({
      now: NOW, server, sessions: [], agents: [],
      workers: { available: true, rows: baseWorkers.map((w) => ({ ...w, elapsedS: 1140 })) },
      closedToday: [],
    });
  }
  if (name === 'problemas') {
    const beta = 'Cliente Beta Engenharia de Software e Integrações Corporativas';
    const eta = 'Cliente Eta com nome comprido para testar reticências na tabela';
    const clients = ['claude-code 2.1.281', 'codex 0.48.0', '<img src=x onerror=alert(1)>', 'cursor 1.9.2', null, 'claude-code 2.1.270 com um nome de cliente MCP enorme para testar'];
    const sessions = [];
    for (let i = 0; i < 8; i += 1) {
      sessions.push({
        session: `b${i}7e4c2${i}`.slice(0, 8),
        token: TOK.beta,
        customer: beta,
        client: clients[i % clients.length],
        ip: `198.51.100.${40 + i}`,
        ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) cliente-mcp/${i}.0 <script>alert(${i})</script> uma string de user agent bem longa para o limite`.slice(0, 120),
        openedAt: ago((i + 1) * 47 * M),
        lastAt: ago(i * 6 * M + 8 * S),
        calls: 63 - i * 7,
        lastTool: i % 2 ? 'odc_write' : 'odc_read',
        bytes: 1200000 - i * 100000,
      });
    }
    sessions.push(
      { session: 'a1f00c3d', token: TOK.alfa, customer: 'Cliente Alfa', client: 'claude-code 2.1.281', ip: '203.0.113.24', ua: 'claude-code/2.1.281 (Windows)', openedAt: ago(4 * H), lastAt: ago(40 * S), calls: 812, lastTool: 'ssam_map', bytes: 48200000 },
      { session: 'a1f00c3e', token: TOK.alfa, customer: 'Cliente Alfa', client: 'codex 0.48.0', ip: '203.0.113.25', ua: 'codex/0.48.0', openedAt: ago(58 * M), lastAt: ago(57 * M), calls: 2, lastTool: 'ssam_doctor', bytes: 12000 },
      { session: 'e7a0b1c2', token: TOK.eta, customer: eta, client: 'claude-code 2.1.281', ip: '192.0.2.150', ua: 'claude-code/2.1.281 (Windows)', openedAt: ago(5 * H + 2 * M), lastAt: ago(5 * H), calls: 3, lastTool: 'studio_inspect', bytes: 38000 },
    );
    return ok({
      now: NOW,
      server,
      sessions,
      agents: [
        { token: TOK.beta, customer: beta, state: 'connected', since: ago(1 * H + 37 * M), lastSignalAt: ago(2 * S), version: '0.4.1', pack: { id: 'pack-20261009-odc-v48', odcBridge: 'v48', o11BuiltFor: '11.55.91' }, studioO11: null, ip: '198.51.100.44', machine: { name: 'PC-TESTE-02', user: 'teste' }, calls1h: 238, failures1h: 71, lastCode: 'AGENT_NOT_CONNECTED', closedReason: null, closedAt: null },
        { token: TOK.alfa, customer: 'Cliente Alfa', state: 'connected', since: ago(9 * H), lastSignalAt: ago(4 * S), version: '0.4.2', pack: null, studioO11: { version: '11.55.91', port: 50123, pid: 18244 }, ip: '198.51.100.23', machine: { name: 'PC-TESTE-01', user: 'teste' }, calls1h: 96, failures1h: 2, lastCode: 'TOOL_ERROR', closedReason: null, closedAt: null },
        { token: TOK.eta, customer: eta, state: 'connected', since: ago(26 * H), lastSignalAt: ago(9 * S), version: '0.4.2', pack: null, studioO11: { version: '11.55.91', port: 50140, pid: 9932 }, ip: '192.0.2.150', machine: { name: '<img src=x onerror=alert(1)>', user: 'teste<script>alert(2)</script>' }, calls1h: 0, failures1h: 0, lastCode: null, closedReason: null, closedAt: null },
        { token: TOK.delta, customer: 'Cliente Delta', state: 'disconnected', since: ago(9 * H), lastSignalAt: ago(3 * H + 45 * S), version: '0.4.2', pack: null, studioO11: null, ip: '192.0.2.61', machine: { name: 'PC-TESTE-04', user: 'teste' }, calls1h: 12, failures1h: 12, lastCode: 'AGENT_TIMEOUT', closedReason: 'sem sinal', closedAt: ago(3 * H) },
        { token: TOK.gama, customer: 'Cliente Gama', state: 'disconnected', since: '2026-10-08T10:00:00Z', lastSignalAt: '2026-10-09T14:59:40Z', version: '0.4.0', pack: null, studioO11: null, ip: '203.0.113.90', machine: { name: 'PC-TESTE-03', user: 'teste' }, calls1h: 0, failures1h: 0, lastCode: null, closedReason: 'expired', closedAt: '2026-10-09T15:00:01Z' },
        { token: TOK.gamaOld, customer: 'Cliente Gama', state: 'disconnected', since: '2026-07-30T10:00:00Z', lastSignalAt: '2026-08-01T16:44:30Z', version: '0.3.9', pack: null, studioO11: null, ip: '203.0.113.91', machine: null, calls1h: 0, failures1h: 0, lastCode: null, closedReason: 'chamada não aceita', closedAt: '2026-08-01T16:45:01Z' },
      ],
      workers: {
        available: true,
        rows: [
          ...baseWorkers,
          { kind: 'o11-worker', token: TOK.alfa, customer: 'Cliente Alfa', port: 18611, rssB: 812000000, cpuPct: 48.2, elapsedS: 3720 },
          { kind: 'o11-worker', token: TOK.eta, customer: eta, port: 18612, rssB: 655000000, cpuPct: 0.4, elapsedS: 18100 },
          { kind: 'builder', token: null, customer: null, port: null, rssB: 1420000000, cpuPct: 97.5, elapsedS: 95 },
          { kind: 'other', token: null, customer: null, port: null, rssB: 21000000, cpuPct: 0, elapsedS: 18700 },
        ],
      },
      closedToday: [
        { reason: 'replaced', count: 37 }, { reason: 'idle', count: 12 }, { reason: 'client-delete', count: 9 }, { reason: 'transport-closed', count: 6 },
        { reason: 'token-expired', count: 3 }, { reason: 'server-stop', count: 2 }, { reason: 'token-revoked', count: 1 }, { reason: 'token-unknown', count: 1 },
      ],
    });
  }
  const live = {
    now: NOW,
    server,
    sessions: [{
      session: '3f9c2a1b', token: TOK.alfa, customer: 'Cliente Alfa', client: 'claude-code 2.1.281', ip: '203.0.113.24',
      ua: 'claude-code/2.1.281 (Windows)', openedAt: ago(1 * H + 50 * M), lastAt: ago(3 * M), calls: 13, lastTool: 'studio_inspect', bytes: 482000,
    }],
    agents: [
      { token: TOK.alfa, customer: 'Cliente Alfa', state: 'connected', since: ago(3 * H + 12 * M), lastSignalAt: ago(12 * S), version: '0.4.2', pack: null, studioO11: { version: '11.55.91', port: 50123, pid: 18244 }, ip: '198.51.100.23', machine: { name: 'PC-TESTE-01', user: 'teste' }, calls1h: 6, failures1h: 0, lastCode: null, closedReason: null, closedAt: null },
      { token: TOK.gama, customer: 'Cliente Gama', state: 'disconnected', since: '2026-10-11T09:00:00Z', lastSignalAt: '2026-10-11T14:11:50Z', version: '0.4.1', pack: null, studioO11: null, ip: '198.51.100.31', machine: { name: 'PC-TESTE-03', user: 'teste' }, calls1h: 0, failures1h: 0, lastCode: null, closedReason: 'revoked', closedAt: '2026-10-11T14:12:01Z' },
    ],
    workers: name === 'sem-coletor' ? { available: false, rows: [] } : { available: true, rows: baseWorkers },
    closedToday: [{ reason: 'client-delete', count: 1 }],
  };
  return ok(live);
}

// ---------------------------------------------------------------------------------------------------------------- vps

function seriesPoints(name) {
  const pts = [];
  const r = rng(name === 'problemas' ? 5 : 3);
  for (let i = 0; i < 96; i += 1) {
    const t = iso(NOW_MS - (95 - i) * 15 * M);
    const wave = Math.sin((i / 96) * Math.PI * 2);
    if (name === 'problemas') {
      const rise = i / 95;
      pts.push({
        t,
        cpuPct: Math.round((20 + 70 * rise + r() * 8) * 10) / 10,
        memUsedPct: Math.round((60 + 35 * rise) * 10) / 10,
        load1: Math.round((0.6 + 4.2 * rise + r() * 0.3) * 100) / 100,
        rxBps: Math.round(20000 + 180000 * rise * r()),
        txBps: Math.round(5000 + 60000 * rise * r()),
        srvCpuPct: Math.round((10 + 80 * rise) * 10) / 10,
        srvMemB: Math.round(GIB * (2 + 3.8 * rise)),
      });
    } else if (name === 'vazio' && i < 94) {
      pts.push({ t, cpuPct: null, memUsedPct: null, load1: null, rxBps: null, txBps: null, srvCpuPct: null, srvMemB: null });
    } else {
      pts.push({
        t,
        cpuPct: Math.round((1.2 + wave * 0.6 + r() * 0.8 + (i === 62 ? 6 : 0)) * 10) / 10,
        memUsedPct: Math.round((12.6 + wave * 0.3) * 10) / 10,
        load1: Math.round((0.08 + Math.max(0, wave) * 0.1 + r() * 0.05) * 100) / 100,
        rxBps: Math.round(1500 + r() * 900 + (i === 62 ? 40000 : 0)),
        txBps: Math.round(380 + r() * 120),
        srvCpuPct: Math.round((0.06 + r() * 0.2) * 100) / 100,
        srvMemB: Math.round(390000000 + wave * 6000000),
      });
    }
  }
  return pts;
}

function container(c) {
  return {
    name: c.name, service: c.service, project: 'ssam-prod', image: c.image ?? IMAGE, imageId: c.imageId ?? 'sha256:232e6a22dec2a1f0b5c7d9e8f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6',
    state: c.state ?? 'running', health: c.health ?? null, failingStreak: c.failingStreak ?? 0, lastHealth: c.lastHealth ?? [],
    startedAt: c.startedAt, restartCount: c.restartCount ?? 0, oomKilled: c.oomKilled ?? false, restartPolicy: 'unless-stopped',
    cpuPct: c.cpuPct ?? 0, memB: c.memB ?? 0, memLimitB: c.memLimitB ?? 0, netRxB: c.netRxB ?? 0, netTxB: c.netTxB ?? 0,
    blkReadB: c.blkReadB ?? 0, blkWriteB: c.blkWriteB ?? 0, pids: c.pids ?? 0,
    sinceS: c.state && c.state !== 'running' ? null : Math.round((NOW_MS - Date.parse(c.startedAt)) / 1000),
  };
}

function buildVps(name) {
  if (name === 'sem-coletor') return null;
  const at = ago(12 * S);
  const problems = name === 'problemas';
  const fresh = name === 'vazio';
  const srvStart = fresh ? ago(19 * M) : ago(5 * H + 12 * M);
  const health = [{ at: ago(30 * S), exit: 0 }, { at: ago(60 * S), exit: 0 }, { at: ago(90 * S), exit: 0 }];
  const host = {
    ok: true, at, hostname: 'vps-exemplo', os: 'Ubuntu 26.04.1 LTS', kernel: '7.0.0-34-generic', nproc: 2,
    uptimeS: Math.round((NOW_MS - Date.parse('2026-10-07T15:41:50Z')) / 1000), bootAt: '2026-10-07T15:41:50Z',
    load: problems ? [4.82, 3.9, 2.71] : [0.09, 0.04, 0.01],
    cpu: problems ? { pct: 91.4, iowaitPct: 12.5, stealPct: 3.1, windowS: 30 } : { pct: 1.2, iowaitPct: 0, stealPct: 0.5, windowS: 30 },
    mem: problems
      ? { totalB: 8320450560, availableB: 416000000, swapTotalB: 0, swapUsedB: 0 }
      : { totalB: 8320450560, availableB: 7257169920, swapTotalB: 0, swapUsedB: 0 },
    psi: problems ? { cpuSome10: 38.2, memSome10: 12.7, ioSome10: 21.4 } : { cpuSome10: 0, memSome10: 0, ioSome10: 0 },
    disks: problems
      ? [
        { mount: '/', fs: 'ext4', sizeB: 101000000000, usedB: 92900000000, availB: 8100000000, usedPct: 92, inodesPct: 34 },
        { mount: '/var/lib/docker', fs: 'xfs', sizeB: 214000000000, usedB: 96000000000, availB: 118000000000, usedPct: 45, inodesPct: 81 },
        { mount: '/boot', fs: 'ext4', sizeB: 1020000000, usedB: 310000000, availB: 710000000, usedPct: 30, inodesPct: 1 },
      ]
      : [{ mount: '/', fs: 'ext4', sizeB: 101000000000, usedB: fresh ? 4100000000 : 5900000000, availB: fresh ? 96900000000 : 95100000000, usedPct: fresh ? 4 : 6, inodesPct: 1 }],
    net: problems
      ? { iface: 'eth0', rxB: 98600000000, txB: 12100000000, rxBps: 186000, txBps: 61200 }
      : { iface: 'eth0', rxB: 1860000000, txB: 86000000, rxBps: 1830, txBps: 410 },
    time: { ntpSynced: !problems, tz: 'Etc/UTC' },
    failedUnits: problems ? 2 : 0,
  };
  const updates = problems
    ? {
      ok: true, at, upgradable: 31, security: 7,
      packages: ['containerd.io', 'docker-ce', 'docker-ce-cli', 'libc6', 'libssl3t64', 'openssl', 'openssh-server', 'systemd', 'linux-image-7.0.0-38-generic', 'linux-base', 'python3.14', 'curl'],
      rebootRequired: true, rebootSince: '2026-10-07T15:50:20Z',
      rebootPkgs: ['linux-image-7.0.0-38-generic', 'linux-base', 'libc6', 'systemd', 'openssl', 'docker-ce'],
      unattended: { enabled: false, lastRunAt: '2026-09-30T06:30:00Z', lastSuccessAt: '2026-09-28T04:00:00Z' },
    }
    : fresh
      ? { ok: true, at, upgradable: 0, security: 0, packages: [], rebootRequired: false, rebootSince: null, rebootPkgs: [], unattended: { enabled: true, lastRunAt: '2026-10-12T09:30:00Z', lastSuccessAt: '2026-10-12T09:30:00Z' } }
      : {
        ok: true, at, upgradable: 10, security: 0,
        packages: ['containerd.io', 'docker-ce', 'docker-ce-cli', 'docker-compose-plugin', 'docker-buildx-plugin', 'curl', 'libcurl4t64', 'python3-urllib3', 'tzdata', 'ubuntu-pro-client'],
        rebootRequired: true, rebootSince: '2026-10-07T15:50:20Z', rebootPkgs: ['linux-image-7.0.0-38-generic', 'linux-base'],
        unattended: { enabled: true, lastRunAt: '2026-10-11T06:30:00Z', lastSuccessAt: '2026-10-11T04:00:00Z' },
      };
  const security = {
    ok: true, at,
    ufw: problems
      ? { active: true, defaultIncoming: 'deny', defaultOutgoing: 'allow', defaultRouted: 'deny', allowIn: ['22/tcp', '80/tcp', '443/tcp', '3000/tcp', '8080/tcp'], rules: ['22/tcp ALLOW IN Anywhere', '80/tcp ALLOW IN Anywhere', '443/tcp ALLOW IN Anywhere', '3000/tcp ALLOW IN Anywhere', '8080/tcp ALLOW IN Anywhere'] }
      : { active: true, defaultIncoming: 'deny', defaultOutgoing: 'allow', defaultRouted: 'deny', allowIn: ['22/tcp', '80/tcp', '443/tcp'], rules: ['22/tcp ALLOW IN Anywhere', '80/tcp ALLOW IN Anywhere', '443/tcp ALLOW IN Anywhere', '22/tcp (v6) ALLOW IN Anywhere (v6)', '80/tcp (v6) ALLOW IN Anywhere (v6)', '443/tcp (v6) ALLOW IN Anywhere (v6)'] },
    ssh: fresh
      ? { passwordAuth: false, permitRootLogin: 'prohibit-password', port: 22, fail2ban: 'active', failures24h: 3, topSources: [{ ip: '198.51.100.7', count: 3 }] }
      : problems
        ? { passwordAuth: true, permitRootLogin: 'yes', port: 22, fail2ban: 'absent', failures24h: 1284, topSources: [{ ip: '198.51.100.7', count: 512 }, { ip: '203.0.113.50', count: 301 }, { ip: '192.0.2.77', count: 220 }, { ip: '198.51.100.201', count: 140 }, { ip: '203.0.113.199', count: 111 }] }
        : { passwordAuth: true, permitRootLogin: 'yes', port: 22, fail2ban: 'absent', failures24h: 40, topSources: [{ ip: '198.51.100.7', count: 12 }, { ip: '203.0.113.50', count: 9 }, { ip: '192.0.2.77', count: 6 }] },
  };
  const tls = {
    certs: problems
      ? [{ name: HOST, notBefore: '2026-07-20T21:49:59Z', notAfter: '2026-10-18T21:49:58Z', daysLeft: daysLeft('2026-10-18T21:49:58Z'), issuer: "Let's Encrypt YE2" }]
      : [{ name: HOST, notBefore: '2026-10-11T21:49:59Z', notAfter: '2027-01-09T21:49:58Z', daysLeft: daysLeft('2027-01-09T21:49:58Z'), issuer: "Let's Encrypt YE2" }],
  };
  const backups = problems
    ? {
      ok: true, at, dir: '/var/backups/ssam-server', exists: true, count: 3, totalB: 37748736,
      newest: { name: 'ssam-state-20261011T103000Z.tar.gz', sizeB: 12582912, mtime: '2026-10-11T10:30:41Z', sha256File: true, infoFile: false, image: IMAGE_TAG, revision: REVISION, mode: 'online', ageH: 40.3 },
      cron: { backup: true, rotate: false },
      cronLogTail: [
        'backup: ok 2026-10-10T06:30:44Z ssam-state-20261010T063000Z.tar.gz 12 MiB',
        'backup: ok 2026-10-11T10:30:41Z ssam-state-20261011T103000Z.tar.gz 12 MiB',
        'backup: FAILED 2026-10-12T06:30:02Z tar: /data/server: Cannot open: Permission denied',
      ],
    }
    : fresh
      ? {
        ok: true, at, dir: '/var/backups/ssam-server', exists: true, count: 1, totalB: 921600,
        newest: { name: 'ssam-state-20261012T234500Z.tar.gz', sizeB: 921600, mtime: '2026-10-12T23:45:20Z', sha256File: true, infoFile: true, image: IMAGE_TAG, revision: REVISION, mode: 'online', ageH: 3.1 },
        cron: { backup: true, rotate: true },
        cronLogTail: ['backup: ok 2026-10-12T23:45:20Z ssam-state-20261012T234500Z.tar.gz 900 KiB'],
      }
      : { ok: true, at, dir: '/var/backups/ssam-server', exists: true, count: 0, totalB: 0, newest: null, cron: { backup: false, rotate: false }, cronLogTail: [] };
  const srvContainer = problems
    ? container({
      name: 'ssam-prod-ssam-server-1', service: 'ssam-server', state: 'restarting', health: 'unhealthy', failingStreak: 5,
      lastHealth: [{ at: ago(30 * S), exit: 1 }, { at: ago(60 * S), exit: 1 }, { at: ago(90 * S), exit: 1 }], startedAt: ago(3 * M),
      restartCount: 4, oomKilled: true, cpuPct: 187.4, memB: 6227702579, memLimitB: 6442450944, netRxB: 812000000, netTxB: 2410000000,
      blkReadB: 1200000000, blkWriteB: 9800000000, pids: 212,
    })
    : container({
      name: 'ssam-prod-ssam-server-1', service: 'ssam-server', health: 'healthy', lastHealth: health, startedAt: srvStart,
      cpuPct: 0.06, memB: 394543104, memLimitB: 6442450944, netRxB: 126000, netTxB: 1260000, blkWriteB: 6680000, pids: 18,
    });
  const containers = [
    srvContainer,
    problems
      ? container({ name: 'ssam-prod-caddy-1', service: 'caddy', image: 'caddy:2.10.2-alpine', imageId: 'sha256:5b1e8f0c6d7a9b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0', state: 'exited', startedAt: '2026-10-11T22:30:00Z', restartCount: 1 })
      : container({ name: 'ssam-prod-caddy-1', service: 'caddy', image: 'caddy:2.10.2-alpine', imageId: 'sha256:5b1e8f0c6d7a9b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0', startedAt: fresh ? ago(20 * M) : '2026-10-11T22:30:00Z', cpuPct: 0.01, memB: 31457280, memLimitB: 268435456, netRxB: 2100000, netTxB: 2600000, pids: 9 }),
  ];
  if (problems) {
    containers.push(container({ name: 'ssam-prod-ssam-console-1', service: 'ssam-console', health: 'healthy', lastHealth: health, startedAt: ago(5 * H + 11 * M), cpuPct: 0.4, memB: 88080384, memLimitB: 268435456, pids: 11 }));
  }
  const kernelFile = problems ? { ...KERNEL, odcBridge: 'v49' } : KERNEL;
  const server = {
    health: { docker: problems ? 'unhealthy' : 'healthy', probe: problems ? { available: true, ok: false, pid: null, ms: null, error: 'ECONNREFUSED' } : { available: true, ok: true, pid: 7, ms: 3, error: null } },
    image: { tag: IMAGE_TAG, version: IMAGE_TAG, revision: REVISION, created: '2026-10-11T21:17:53Z' },
    kernel: problems
      ? { running: { ...KERNEL, o11: null, odcBridge: null }, file: kernelFile, drift: true, driftFields: ['o11', 'odcBridge'] }
      : { running: KERNEL, file: KERNEL, drift: false, driftFields: [] },
    warm: problems
      ? {
        state: 'cold', time: ago(50 * M),
        indexes: { ok: false, lanes: { odc: { ok: true, cache: 'hit', ms: 900 }, o11: { ok: false, cache: 'built', ms: 4000 } } },
        delivery: { builder: { ok: false, pid: null }, worker: { ok: false, note: 'o worker ODC não respondeu em 120 s' } }, ms: 241000, workerRunning: false,
      }
      : {
        state: 'warm', time: fresh ? ago(16 * M) : ago(5 * H + 9 * M),
        indexes: { ok: true, lanes: { odc: { ok: true, cache: 'hit', ms: 900 }, o11: { ok: true, cache: 'built', ms: 4000 } } },
        delivery: { builder: { ok: true, pid: 41 }, worker: fresh ? { ok: true, note: null } : { ok: false, note: 'o worker ODC não respondeu no aquecimento' } },
        ms: 148000, workerRunning: true,
      },
    logs: problems
      ? { serverLogB: 650117120, rotatedCount: 0, rotatedB: 0, auditFiles: 31, auditB: 48234496, qualityFiles: 31, qualityB: 9437184, consoleAuditB: 18432 }
      : fresh
        ? { serverLogB: 1843, rotatedCount: 0, rotatedB: 0, auditFiles: 0, auditB: 0, qualityFiles: 0, qualityB: 0, consoleAuditB: 0 }
        : { serverLogB: 7372, rotatedCount: 0, rotatedB: 0, auditFiles: 1, auditB: 2150, qualityFiles: 7, qualityB: 41216, consoleAuditB: 1240 },
  };
  const coolifyNames = ['coolify', 'coolify-db', 'coolify-proxy', 'coolify-realtime', 'coolify-redis'];
  const coolify = coolifyNames.map((n) => ({ name: n, state: problems && n === 'coolify-proxy' ? 'running' : 'exited', restartPolicy: 'no' }));
  return ok({
    now: NOW,
    collector: problems
      ? { state: 'stale', collectedAt: ago(340 * S), ageS: 340, durationMs: 24800, errors: ['updates: TIMEOUT', 'tls: TIMEOUT'], version: '1' }
      : { state: 'fresh', collectedAt: at, ageS: 12, durationMs: 2400, errors: [], version: '1' },
    host,
    updates: problems ? { ok: false, error: 'TIMEOUT', at: ago(31 * M) } : updates,
    security,
    tls,
    backups,
    containers,
    volumes: [
      { name: 'ssam-prod_caddy-config', sizeB: 12288 },
      { name: 'ssam-prod_caddy-data', sizeB: 61440 },
      { name: 'ssam-prod_cache', sizeB: problems ? 2400000000 : 72000000 },
      { name: 'ssam-prod_friction', sizeB: 4096 },
      { name: 'ssam-prod_odc-features', sizeB: 180000 },
      { name: 'ssam-prod_server-state', sizeB: problems ? 61000000000 : fresh ? 81920 : 1700000 },
    ],
    systemDf: { imagesB: 3489000000, imagesReclaimableB: 651600000, volumesB: problems ? 63500000000 : 74040000, buildCacheB: problems ? 1200000000 : 0 },
    server,
    coolify,
    series: { stepS: 900, points: seriesPoints(name) },
  });
}

function buildVpsMissing() {
  return ok({
    now: NOW,
    collector: { state: 'missing', collectedAt: null, ageS: null, durationMs: null, errors: [], version: null },
    host: null,
    updates: null,
    security: null,
    tls: null,
    backups: null,
    containers: null,
    volumes: null,
    systemDf: null,
    server: {
      health: null,
      image: null,
      kernel: { running: null, file: KERNEL, drift: false, driftFields: [] },
      warm: null,
      logs: { serverLogB: 7372, rotatedCount: 0, rotatedB: 0, auditFiles: 1, auditB: 2150, qualityFiles: 7, qualityB: 41216, consoleAuditB: 1240 },
    },
    coolify: null,
    series: null,
  });
}

// ---------------------------------------------------------------------------------------------------------------- overview

function buildOverview(name) {
  const { alerts, acked } = scenarioAlerts(name);
  const sorted = sortAlerts(alerts);
  const count = (sev) => alerts.filter((a) => a.severity === sev).length;
  const lic = licenseList(name);
  const live = buildLive(name);
  const vps = buildVps(name);
  const usage = buildUsage(name, 'today');
  const events = scenarioEvents(name);
  const worst = (areas) => {
    const list = alerts.filter((a) => areas.includes(a.area));
    if (list.some((a) => a.severity === 'critical')) return 'critical';
    if (list.some((a) => a.severity === 'warning')) return 'warning';
    return 'ok';
  };
  const active = lic.filter((l) => l.state === 'active');
  const next = active.filter((l) => l.expiresAt).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0];
  const missing = name === 'sem-coletor';
  const problems = name === 'problemas';
  const srvSince = name === 'vazio' ? ago(19 * M) : ago(5 * H + 12 * M);
  const status = {
    server: missing
      ? { state: 'unknown', since: srvSince, pid: 7, imageTag: null, health: null, warm: 'unknown', warmDetail: null }
      : problems
        ? { state: 'down', since: null, pid: null, imageTag: IMAGE_TAG, health: 'unhealthy', warm: 'cold', warmDetail: 'Aquecimento: o índice O11 falhou (EACCES ao abrir o cache do índice).' }
        : { state: 'up', since: srvSince, pid: 7, imageTag: IMAGE_TAG, health: 'healthy', warm: 'warm', warmDetail: name === 'vazio' ? null : 'O worker ODC falhou no aquecimento e subiu sob demanda.' },
    sessionsOpen: live.sessions.length,
    agentsConnected: live.agents.filter((a) => a.state === 'connected').length,
    licenses: {
      active: active.length,
      expired: lic.filter((l) => l.state === 'expired').length,
      revoked: lic.filter((l) => l.state === 'revoked').length,
    },
    alerts: { critical: count('critical'), warning: count('warning'), info: count('info'), acked: acked.length },
    collector: missing
      ? { state: 'missing', collectedAt: null, ageS: null }
      : { state: vps.collector.state, collectedAt: vps.collector.collectedAt, ageS: vps.collector.ageS },
    host: missing ? null : {
      cpuPct: vps.host.cpu.pct,
      memUsedPct: Math.round((1 - vps.host.mem.availableB / vps.host.mem.totalB) * 1000) / 10,
      diskUsedPct: vps.host.disks[0].usedPct,
    },
    publicHost: HOST,
  };
  const srvContainer = vps ? vps.containers.find((c) => c.service === 'ssam-server') : null;
  const summary = [
    {
      area: 'servidor',
      state: missing ? 'unknown' : worst(['servidor']),
      facts: {
        since: status.server.since, pid: status.server.pid, imageTag: status.server.imageTag, warm: status.server.warm,
        health: status.server.health, probeMs: vps && vps.server.health.probe.ok ? vps.server.health.probe.ms : null,
      },
      view: 'vps',
    },
    {
      area: 'licencas',
      state: worst(['licencas']),
      facts: {
        active: status.licenses.active, expired: status.licenses.expired, revoked: status.licenses.revoked,
        nextExpiry: next ? { customer: next.customer, token: next.id, expiresAt: next.expiresAt } : null,
      },
      view: 'licencas',
    },
    {
      area: 'uso',
      state: worst(['uso']),
      facts: { calls: usage.totals.calls, failures: usage.totals.failures, p90Ms: usage.totals.p90Ms, customersActive: usage.totals.customersActive },
      view: 'uso',
    },
    {
      area: 'agentes',
      state: worst(['agentes']),
      facts: {
        connected: status.agentsConnected,
        activeLicenses: status.licenses.active,
        lastSignalAt: live.agents.map((a) => a.lastSignalAt).filter(Boolean).sort().pop() ?? null,
      },
      view: 'agentes',
    },
    {
      area: 'sessoes',
      state: 'ok',
      facts: {
        open: live.sessions.length,
        top: live.sessions.slice().sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 3).map((s) => ({ customer: s.customer, client: s.client })),
      },
      view: 'agentes',
    },
    {
      area: 'vps',
      state: missing ? 'unknown' : worst(['vps', 'seguranca']),
      facts: missing
        ? { cpuPct: null, memUsedPct: null, diskUsedPct: null, rebootRequired: null, rebootSince: null }
        : {
          cpuPct: status.host.cpuPct, memUsedPct: status.host.memUsedPct, diskUsedPct: status.host.diskUsedPct,
          rebootRequired: vps.updates.ok === false ? null : vps.updates.rebootRequired,
          rebootSince: vps.updates.ok === false ? null : vps.updates.rebootSince,
        },
      view: 'vps',
    },
    {
      area: 'containers',
      state: missing ? 'unknown' : problems ? 'critical' : 'ok',
      facts: missing
        ? { running: null, total: null, unhealthy: [], restarts24h: null }
        : {
          running: vps.containers.filter((c) => c.state === 'running').length,
          total: vps.containers.length,
          unhealthy: vps.containers.filter((c) => c.health === 'unhealthy').map((c) => c.service),
          restarts24h: vps.containers.reduce((s, c) => s + c.restartCount, 0),
        },
      view: 'vps',
    },
    {
      area: 'backup',
      state: missing ? 'unknown' : worst(['backup']),
      facts: missing
        ? { newestAt: null, ageH: null, cron: null }
        : { newestAt: vps.backups.newest ? vps.backups.newest.mtime : null, ageH: vps.backups.newest ? vps.backups.newest.ageH : null, cron: vps.backups.cron },
      view: 'vps',
    },
    {
      area: 'tls',
      state: missing ? 'unknown' : worst(['tls']),
      facts: missing || !vps.tls.certs.length ? {} : { name: vps.tls.certs[0].name, notAfter: vps.tls.certs[0].notAfter, daysLeft: vps.tls.certs[0].daysLeft },
      view: 'vps',
    },
    {
      area: 'coletor',
      state: worst(['coletor']),
      facts: missing
        ? { collectedAt: null, ageS: null, sectionErrors: [] }
        : { collectedAt: vps.collector.collectedAt, ageS: vps.collector.ageS, sectionErrors: vps.collector.errors },
      view: 'vps',
    },
  ];
  if (srvContainer && problems) summary[0].facts.health = srvContainer.health;
  return ok({
    now: NOW,
    status,
    alerts: sorted,
    acked,
    summary,
    recentEvents: events.slice(-10).reverse(),
    indexing: indexing(name),
  });
}

// ---------------------------------------------------------------------------------------------------------------- mutations

function secretToken(suffix) {
  return `ssam_EXEMPLO_NAO_E_UM_TOKEN_${suffix}`;
}
function secretAgent(suffix) {
  return `ssam_agent_EXEMPLO_NAO_E_UMA_CREDENCIAL_${suffix}`;
}

function newLicense(name, { id, customer, days, lanes }) {
  const createdAt = NOW;
  const expiresAt = days == null ? null : iso(NOW_MS + days * D);
  const lic = {
    id, customer, state: 'active', createdAt, expiresAt, revokedAt: null, daysLeft: daysLeft(expiresAt), lanes,
    agentCredentialIssuedAt: createdAt, machine: null, accessAlerts: 0,
    agent: { state: 'never', since: null, lastSignalAt: null, version: null, closedReason: null },
    sessionsOpen: 0, today: { calls: 0, failures: 0 }, daily14: Array(14).fill(0), lastActivity: null,
    workspace: null, actions: null,
    history: [hist(NOW, 'issue', 'painel', id, customer, { days, lanes, expiresAt })],
  };
  lic.actions = actionsFor(lic, capabilities(name));
  return lic;
}

function buildMutations(name) {
  const caps = capabilities(name);
  const list = licenseList(name);
  const pick = (tok) => list.find((l) => l.id === tok) || newLicense(name, { id: tok, customer: 'Cliente Beta', days: 10, lanes: ['odc'] });
  const out = {};
  out.issue = ok({
    license: newLicense(name, { id: TOK.delta, customer: 'Cliente Delta', days: 30, lanes: ['odc', 'o11'] }),
    secret: { token: secretToken('DELTA_0001'), agentCredential: secretAgent('DELTA_0001') },
    publicUrl: PUBLIC_URL,
    serverUrl: SERVER_URL,
    duplicates: [],
    audit: { written: true },
  });
  const beta = pick(TOK.beta);
  const renewed = { ...beta, expiresAt: iso(Date.parse(beta.expiresAt ?? NOW) + 30 * D) };
  renewed.daysLeft = daysLeft(renewed.expiresAt);
  renewed.history = [hist(NOW, 'renew', 'painel', beta.id, beta.customer, { days: 30, previousExpiresAt: beta.expiresAt, expiresAt: renewed.expiresAt }), ...beta.history].slice(0, 5);
  out.renew = ok({ license: renewed, previousExpiresAt: beta.expiresAt, expiresAt: renewed.expiresAt, audit: { written: true } });
  const alfa = pick(TOK.alfa);
  const laned = { ...alfa, lanes: ['odc'] };
  laned.actions = actionsFor(laned, caps);
  laned.history = [hist(NOW, 'lanes', 'painel', alfa.id, alfa.customer, { previousLanes: alfa.lanes, lanes: ['odc'] }), ...alfa.history].slice(0, 5);
  out.lanes = ok({ license: laned, previousLanes: alfa.lanes, openSessions: alfa.sessionsOpen, audit: { written: true } });
  const rotated = {
    ...alfa,
    agentCredentialIssuedAt: NOW,
    agent: { ...alfa.agent, state: 'disconnected', since: NOW, closedReason: 'rotated' },
    history: [hist(NOW, 'agent-rotate', 'painel', alfa.id, alfa.customer), ...alfa.history].slice(0, 5),
  };
  out['agent-rotate'] = ok({ license: rotated, secret: { agentCredential: secretAgent('ALFA_0002') }, serverUrl: SERVER_URL, audit: { written: true } });
  const target = list.find((l) => l.state !== 'revoked' && l.id !== TOK.alfa) || alfa;
  const revoked = { ...target, state: 'revoked', revokedAt: NOW, sessionsOpen: 0 };
  revoked.actions = actionsFor(revoked, caps);
  revoked.history = [hist(NOW, 'revoke', 'painel', target.id, target.customer), ...target.history].slice(0, 5);
  out.revoke = ok({ license: revoked, openSessions: target.sessionsOpen ?? 0, agentConnected: target.agent?.state === 'connected', audit: { written: true } });
  return out;
}

const ERRORS = {
  'error-bad-json': err('BAD_JSON', 'Corpo da requisição não é JSON válido.'),
  'error-invalid-field': err('INVALID_FIELD', 'Campo inválido: customer (1 a 64 caracteres: letras, números, espaço, ponto, hífen ou sublinhado).', 'customer'),
  'error-confirm-mismatch': err('CONFIRM_MISMATCH', 'A confirmação não confere: digite exatamente o nome do cliente.'),
  'error-no-change': err('NO_CHANGE', 'Nada mudou: as faixas escolhidas são as atuais.'),
  'error-key-required': err('KEY_REQUIRED', 'Falta a chave de acesso. Abra o painel pelo painel-ssam.ps1.'),
  'error-key-invalid': err('KEY_INVALID', 'Chave de acesso inválida ou trocada. Rode painel-ssam.ps1 de novo.'),
  'error-not-found': err('NOT_FOUND', 'Não encontrado.'),
  'error-unknown-token': err('UNKNOWN_TOKEN', 'Licença tok_ffffffffffff não existe.'),
  'error-method-not-allowed': err('METHOD_NOT_ALLOWED', 'Método não permitido.'),
  'error-stale': err('STALE', 'A licença mudou desde que a página foi carregada. Recarregue e confira.'),
  'error-token-revoked': err('TOKEN_REVOKED', 'A licença está revogada; emita uma nova.'),
  'error-already-revoked': err('ALREADY_REVOKED', 'A licença já estava revogada.'),
  'error-token-not-active': err('TOKEN_NOT_ACTIVE', 'Só uma licença ativa pode trocar a credencial do agente.'),
  'error-rate-limited': err('RATE_LIMITED', 'Muitas ações seguidas. Tente de novo em 42 s.'),
  'error-not-supported': err('NOT_SUPPORTED', 'Indisponível nesta imagem do servidor (chega com o 24º envio).'),
  'error-store-unreadable': err('STORE_UNREADABLE', 'O arquivo de licenças não pode ser lido agora (EACCES).'),
};

// ---------------------------------------------------------------------------------------------------------------- quality

// The fixture day of DESIGN-QUALIDADE (2026-10-12 local, 63 lines) with the mock's tokens.
const QUALITY_DAY = path.join(here, '..', '..', 'tests', 'fixtures', 'quality', 'server-dir', 'quality-20261012.jsonl');
const QUALITY_TOKENS = { tok_0000000a1fa0: TOK.alfa, tok_0000000b2fb1: TOK.beta, tok_0000000c3fc2: TOK.gama };
const localDayOf = (iso) => new Date(Date.parse(iso) + LOCAL_OFFSET).toISOString().slice(0, 10);
const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0');

function qualityDay() {
  return fs.readFileSync(QUALITY_DAY, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// normal: the fixture day today and, on each of the 6 days before, the same day with some of its sessions.
function normalQualityLines() {
  const day = qualityDay();
  const sessions = [...new Set(day.map((l) => l.session))];
  const out = [];
  for (let k = 6; k >= 0; k -= 1) {
    for (const l of day) {
      const si = sessions.indexOf(l.session);
      if (k > 0 && (si + k) % 3 === 0) continue;
      out.push({ ...l, time: new Date(Date.parse(l.time) - k * D).toISOString(), token: QUALITY_TOKENS[l.token] ?? l.token,
        session: hex2(k) + l.session.slice(2) });
    }
  }
  return out;
}

// problemas: on top of normal, three customers with many refusals before each delivery, pauses above 10 min, a code that
// is not in the catalog (NATIVE_UNLISTED), a code outside the registry (CODE_UNLISTED), codes folded by the writer
// (OTHER_CODES), parallel calls, failures. Every other code is in the contract's registry (CODES).
function problemQualityLines() {
  const r = rng(4242);
  const out = normalQualityLines();
  const codes = ['EXPR_UNKNOWN_IDENTIFIER', 'EXPRESSION_SYNTAX', 'FUNCTION_UNKNOWN', 'FIELD_UNKNOWN', 'INPUT_TYPE_MISMATCH', 'NATIVE_UNLISTED',
    'OTHER_CODES', 'CODE_UNLISTED', 'ExpressionUnknownObject'];
  const people = [[TOK.delta, 'codex'], [TOK.zeta, 'claude-code'], [TOK.eta, 'cursor']];
  let n = 0;
  for (let k = 6; k >= 0; k -= 1) {
    for (const [token, client] of people) {
      n += 1;
      const session = `${hex2(0x80 + n)}000000${hex2(k)}${hex2(n)}`;
      const t = Date.parse(`${localDays(7)[6 - k]}T12:00:00.000Z`) + Math.floor(r() * 6 * H);
      out.push({ schema: 'ssam-quality/1', kind: 'session', time: new Date(t).toISOString(), token, session, event: 'opened', client });
      let call = 0;
      let last = null;
      const add = (ms, fields, gap = 4000 + Math.floor(r() * 30000), inFlight = 0) => {
        call += 1;
        const arrival = last === null ? t : inFlight ? last - 500 : last + gap;
        const end = arrival + ms;
        out.push({
          schema: 'ssam-quality/1', kind: 'call', time: new Date(end).toISOString(), token, session, call, tool: fields.tool, op: fields.op ?? null,
          lane: fields.lane ?? 'o11', ms, gapMs: last === null || inFlight ? null : arrival - last, inFlight, ok: fields.ok, code: fields.ok ? null : fields.code,
          class: fields.class, step: fields.step ?? null, deliv: fields.deliv ?? null,
          ...(fields.problems ? { problems: fields.problems } : {}), ...(fields.norm ? { norm: fields.norm } : {}),
          t: fields.t, agent: { n: 4, failed: 0, bytes: 120000, shared: false },
          ...(fields.t.kernelOwn ? { kernel: { runs: 1, cold: k % 2, worker: 1 - (k % 2), ms: fields.t.kernelOwn } } : {}),
        });
        last = Math.max(last ?? 0, end);
      };
      const tool = client === 'claude-code' ? 'studio_deliver' : 'o11_deliver';
      const lane = tool === 'studio_deliver' ? 'odc' : 'o11';
      add(900, { tool: 'ssam_map', op: 'digest', lane, ok: true, class: 'ok', t: { capture: 600, transfer: 200, rest: 100 } });
      const refusals = 2 + Math.floor(r() * 4);
      for (let i = 0; i < refusals; i += 1) {
        const a = codes[Math.floor(r() * codes.length)];
        const b = codes[Math.floor(r() * codes.length)];
        const byCode = a === b ? { [a]: 4 } : { [a]: 3, [b]: 1 };
        add(6000 + Math.floor(r() * 50000), {
          tool, lane, ok: false, code: 'PREFLIGHT_REFUSED', class: 'refused', step: 'preflight',
          problems: { n: 4, err: 4, warn: 0, byCode, withPatch: { [a]: 2 }, byPhase: { preflight: 3, verify: 1 }, cut: false },
          norm: i % 2 ? { n: 2, byRule: { SORT_KEYS_SPLIT: 1, LIST_ENTITY_SEGMENT_DROPPED: 1 } } : null,
          t: { capture: 1500, transfer: 9000, kernelOwn: 7000, studio: 2500, rest: 400 },
        }, i === 1 ? 900000 + Math.floor(r() * 600000) : undefined);
        if (i === 0) add(300, { tool: 'ssam_discover', lane, ok: true, class: 'ok', t: { rest: 300 } }, 0, 1);
      }
      add(30000 + Math.floor(r() * 40000), {
        tool, lane, ok: true, class: 'delivered', deliv: 'entregue', norm: { n: 1, byRule: { NULL_FUNCTION_REWRITTEN: 1 } },
        t: { capture: 2000, transfer: 6000, kernelOwn: 9000, studio: 12000, verify: 2400, rest: 600 },
      });
      if (k % 3 === 0) add(2000, { tool: 'o11_studio', op: 'open-module', lane: 'o11', ok: false, code: 'AGENT_NOT_CONNECTED', class: 'failed', t: { rest: 2000 } }, 2400000);
      if (k % 2 === 0) {
        out.push({ schema: 'ssam-quality/1', kind: 'session', time: new Date(last + 30000).toISOString(), token, session, event: 'closed', client,
          reason: 'client-delete', calls: call, openMs: last + 30000 - t });
      }
    }
  }
  return out;
}

function qualityLines(name) {
  if (name === 'vazio') return [];
  return name === 'problemas' ? problemQualityLines() : normalQualityLines();
}

const QUALITY_NATIVE = new Set(['ExpressionUnknownObject']);
// The day aggregates of a scenario: every line through the contract and the console's engine, the idle close at NOW.
function qualityDays(name) {
  const days = new Map();
  const engine = createQualityEngine({
    dayOf: localDayOf,
    dayAgg: (d) => {
      if (!days.has(d)) days.set(d, emptyQualityDay(d));
      return days.get(d);
    },
  });
  const lines = qualityLines(name).map((l) => sanitizeQualityLine(l, { nativeIds: QUALITY_NATIVE })).filter(Boolean)
    .sort((a, b) => a.time.localeCompare(b.time) || (a.kind === 'session' && a.event === 'opened' ? -1 : 0));
  for (const l of lines) engine.apply(l);
  engine.sweep(NOW_MS);
  return days;
}

function buildQuality(name, kind) {
  const days = kind === 'today' ? localDays(1) : kind === '7d' ? localDays(7) : localDays(30);
  const all = qualityDays(name);
  const names = new Map(licenseList(name).map((l) => [l.id, l.customer]));
  const summary = summarizeQuality(days.map((d) => all.get(d) ?? emptyQualityDay(d)), { nameOf: (t) => names.get(t) ?? t });
  const known = [...all.keys()].sort();
  return ok({
    now: NOW,
    range: { kind, from: days[0], to: days[days.length - 1], days: days.length, timeZone: TZ },
    indexing: name === 'problemas' ? { state: 'running', progress: 0.42, detail: 'registros de qualidade' } : { state: 'ready', progress: 1, detail: null },
    available: true,
    firstDay: known[0] ?? null,
    ...summary,
  });
}

// vazio, 30 dias: an image that does not record yet (the notice of the view).
function buildQualityUnavailable() {
  const days = localDays(30);
  return ok({
    now: NOW,
    range: { kind: '30d', from: days[0], to: days[days.length - 1], days: days.length, timeZone: TZ },
    indexing: { state: 'ready', progress: 1, detail: null },
    available: false,
    firstDay: null,
    ...summarizeQuality([]),
  });
}

// ---------------------------------------------------------------------------------------------------------------- write

export function buildScenario(name) {
  const files = {
    meta: buildMeta(name),
    overview: buildOverview(name),
    licenses: buildLicenses(name),
    'usage-today': buildUsage(name, 'today'),
    'usage-7d': buildUsage(name, '7d'),
    'usage-30d': buildUsage(name, '30d'),
    'quality-today': buildQuality(name, 'today'),
    'quality-7d': buildQuality(name, '7d'),
    'quality-30d': buildQuality(name, '30d'),
    live: buildLive(name),
    events: buildEvents(name),
    history: buildHistory(name),
    ...buildMutations(name),
    ...ERRORS,
  };
  if (name === 'vazio') files['quality-unavailable'] = buildQualityUnavailable();
  const vps = buildVps(name);
  if (vps) files.vps = vps;
  else files['vps-missing'] = buildVpsMissing();
  return files;
}

export function allFixtures() {
  const out = {};
  for (const s of SCENARIOS) for (const [n, v] of Object.entries(buildScenario(s))) out[`${s}/${n}.json`] = `${JSON.stringify(v, null, 2)}\n`;
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const files = allFixtures();
  const diffs = [];
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(here, ...rel.split('/'));
    let cur = null;
    try {
      cur = fs.readFileSync(full, 'utf8');
    } catch {
      cur = null;
    }
    if (cur === text) continue;
    diffs.push(rel);
    if (!check) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
    }
  }
  const expected = new Set(Object.keys(files));
  for (const s of SCENARIOS) {
    const dir = path.join(here, s);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const rel = `${s}/${f}`;
      if (f.endsWith('.json') && !expected.has(rel)) {
        diffs.push(`${rel} (sobra)`);
        if (!check) fs.unlinkSync(path.join(dir, f));
      }
    }
  }
  if (check) {
    if (diffs.length) {
      console.error(`Fixtures desatualizadas: ${diffs.join(', ')}`);
      process.exit(1);
    }
    console.log(`Fixtures em dia (${Object.keys(files).length} arquivos).`);
  } else {
    console.log(`${diffs.length} de ${Object.keys(files).length} arquivos regravados.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
