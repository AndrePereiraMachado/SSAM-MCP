#!/usr/bin/env node
// Mock server of the owner console (DESIGN.md 6.12), dev only; the console API never serves public/mock/.
//
//   node server/deploy/console/public/mock/dev-server.mjs [--port 7399]
//
// Serves public/ on 127.0.0.1 only, with the response headers of the real console (CSP included, so a page that
// breaks the CSP fails here too), and answers /api/* from public/mock/<scenario>/<name>.json. The scenario comes from
// the X-Mock-Scenario header that the page sends when opened with ?mock=<scenario> (normal by default). Any access key
// is accepted; a request without one gets 401 KEY_REQUIRED, as in production. Two extra names exist only here, for the
// status line states: sem-conexao (the connection is dropped) and chave-invalida (401 KEY_INVALID).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The quality exports are built from the fixture payloads with the console's own CSV rules (DESIGN-QUALIDADE 4.4).
import { TABLES, csvText, totalsRows } from '../../views-quality.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, '..');
export const SCENARIOS = ['normal', 'vazio', 'problemas', 'sem-coletor', 'sem-renovar'];
const SPECIAL = ['sem-conexao', 'chave-invalida'];
const NAME_RE = /^[\p{L}\p{N} ._-]{1,64}$/u;
const TOKEN_RE = /^tok_[0-9a-f]{12}$/;

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const COMMON = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function readFixture(scenario, name) {
  const file = path.join(here, scenario, `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function send(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...COMMON, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function sendError(res, status, scenario, name, fallback) {
  send(res, status, readFixture(scenario, name) || readFixture('normal', name) || fallback);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    rel = '';
  }
  const ext = path.extname(rel).toLowerCase();
  const full = path.resolve(PUBLIC, `.${rel}`);
  const inside = full.startsWith(PUBLIC + path.sep);
  // Same rule as the console: only .html .css .js .svg inside public/, never /mock/*.
  if (!rel || !TYPES[ext] || !inside || full.startsWith(here + path.sep) || full === here) {
    send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Não encontrado.' } });
    return;
  }
  fs.readFile(full, (e, data) => {
    if (e) {
      send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Não encontrado.' } });
      return;
    }
    const headers = { ...COMMON, 'Content-Type': TYPES[ext], 'Content-Length': data.length };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= 8192) chunks.push(c);
    });
    req.on('end', () => resolve({ size, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ size: 0, text: '' }));
  });
}

// Synthetic live events: one new event every 2 s after the page loaded the ring (a request without `after` restarts
// the count for that scenario), so Eventos shows new rows and the paused state counts them ("Pausado · 12 novos").
const liveStart = new Map();
function liveEvents(scenario, base, after, limit) {
  const last = base.events.length ? base.events[base.events.length - 1] : null;
  if (!last) return [];
  const n = Math.min(300, Math.floor((Date.now() - (liveStart.get(scenario) ?? Date.now())) / 2000));
  const tools = ['studio_inspect', 'ssam_doctor', 'odc_read', 'ssam_map'];
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    const seq = base.lastSeq + i;
    if (seq <= after) continue;
    const tool = tools[i % tools.length];
    const failed = i % 5 === 0;
    out.push({
      seq,
      time: base.now || last.time,
      level: failed ? 'warning' : 'info',
      group: 'chamada',
      token: 'tok_0000000a1fa0',
      customer: 'Cliente Alfa',
      text: failed ? `Cliente Alfa chamou ${tool}: falhou com AGENT_NOT_CONNECTED em 41 ms.` : `Cliente Alfa chamou ${tool}: ok em 850 ms.`,
      code: failed ? 'AGENT_NOT_CONNECTED' : null,
    });
  }
  return out.slice(0, limit);
}

// /api/quality (DESIGN-QUALIDADE 4.6): quality-today/7d/30d.json of the scenario; vazio answers 30 dias with
// quality-unavailable.json (the notice); one day reuses today's file with that day as the range; one license keeps the
// rows of that license in the per-customer tables.
function qualityFixture(scenario, sp) {
  const range = sp.get('range') || '7d';
  const file = range === 'today' || range === 'day' ? 'quality-today' : range === '30d' ? 'quality-30d' : 'quality-7d';
  const q = (scenario === 'vazio' && range === '30d' && readFixture(scenario, 'quality-unavailable')) || readFixture(scenario, file);
  if (range === 'day') {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.get('day') || '') ? sp.get('day') : q.range.to;
    q.range = { ...q.range, kind: 'day', from: day, to: day, days: 1 };
  }
  const token = sp.get('token');
  if (token && TOKEN_RE.test(token)) {
    q.token = token;
    q.byCustomer = q.byCustomer.filter((r) => r.token === token);
    q.rounds = q.rounds.filter((r) => r.token === token);
  }
  return q;
}

const EXPORT_TYPES = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8', jsonl: 'application/x-ndjson; charset=utf-8' };
function qualityExport(res, scenario, sp) {
  const table = sp.get('table') || '';
  if (!Object.hasOwn(TABLES, table)) {
    send(res, 400, { ok: false, error: { code: 'INVALID_FIELD', message: 'Campo inválido: table (tabela da Qualidade).', field: 'table' } });
    return;
  }
  const format = sp.get('format') || (table === 'tudo' ? 'json' : table === 'linhas' ? 'jsonl' : 'csv');
  if (table === 'linhas' && sp.get('range') === '30d') {
    send(res, 400, { ok: false, error: { code: 'INVALID_FIELD', message: 'Campo inválido: range (linhas: até 7 dias).', field: 'range' } });
    return;
  }
  const q = qualityFixture(scenario, sp);
  const token = sp.get('token');
  const name = `ssam-qualidade-${table}-${q.range.from}-${q.range.to}${token && TOKEN_RE.test(token) ? `-${token}` : ''}.${format}`;
  let text;
  if (table === 'tudo') text = `${JSON.stringify(q, null, 2)}\n`;
  else if (table === 'linhas') text = '';      // the mock has no lines: an empty JSONL file
  else {
    const rows = table === 'resumo' ? totalsRows(q.totals) : q[TABLES[table].key] || [];
    if (format === 'json') text = `${JSON.stringify(rows, null, 2)}\n`;
    else if (table === 'resumo') text = csvText(['Campo', 'Valor'], rows.map((r) => [r.campo, r.valor]));
    else text = csvText(TABLES[table].columns.map((c) => c[0]), rows.map((r) => TABLES[table].columns.map((c) => c[1](r))));
  }
  const body = Buffer.from(text, 'utf8');
  res.writeHead(200, { ...COMMON, 'Content-Security-Policy': CSP, 'Content-Type': EXPORT_TYPES[format] || EXPORT_TYPES.json,
    'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': body.length });
  res.end(body);
}

function intParam(sp, name, def, min, max) {
  const v = sp.get(name);
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : def;
}

async function handleApi(req, res, url, scenario) {
  const p = url.pathname;
  const sp = url.searchParams;
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendError(res, 405, scenario, 'error-method-not-allowed', { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' } });
    return;
  }
  if (req.method === 'GET') {
    const simple = { '/api/meta': 'meta', '/api/overview': 'overview', '/api/licenses': 'licenses', '/api/live': 'live' };
    if (simple[p]) {
      send(res, 200, readFixture(scenario, simple[p]));
      return;
    }
    if (p === '/api/vps') {
      send(res, 200, readFixture(scenario, 'vps') || readFixture(scenario, 'vps-missing'));
      return;
    }
    if (p === '/api/usage') {
      const range = sp.get('range') || '7d';
      const file = range === 'today' || range === 'day' ? 'usage-today' : range === '30d' ? 'usage-30d' : 'usage-7d';
      const u = readFixture(scenario, file);
      if (range === 'day') {
        const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.get('day') || '') ? sp.get('day') : u.range.to;
        u.range = { ...u.range, kind: 'day', from: day, to: day, days: 1 };
        if (day !== readFixture(scenario, 'usage-today').range.to) {
          // Another day: show the matching row of the 30-day file only.
          const month = readFixture(scenario, 'usage-30d');
          const row = month.byDay.find((d) => d.day === day) || { day, calls: 0, failures: 0, p50Ms: null, p90Ms: null, customers: 0 };
          u.byDay = [row];
          if (!row.calls) Object.assign(u, { byCustomer: [], byTool: [], byCode: [] });
        }
      }
      const token = sp.get('token');
      if (token) {
        const row = u.byCustomer.find((c) => c.token === token);
        u.byCustomer = row ? [row] : [];
        if (!row) {
          u.byTool = [];
          u.byCode = [];
          u.byDay = u.byDay.map((d) => ({ ...d, calls: 0, failures: 0, p50Ms: null, p90Ms: null, customers: 0 }));
          u.totals = { ...u.totals, calls: 0, failures: 0, p50Ms: null, p90Ms: null, maxMs: null, customersActive: 0, sessionsOpened: 0, agentCalls: 0, agentFailures: 0 };
        } else {
          u.totals = { ...u.totals, calls: row.calls, failures: row.failures, p50Ms: row.p50Ms, p90Ms: row.p90Ms, customersActive: 1, sessionsOpened: row.sessionsOpened, agentCalls: row.agentCalls, agentFailures: row.agentFailures };
        }
      }
      send(res, 200, u);
      return;
    }
    if (p === '/api/quality') {
      send(res, 200, qualityFixture(scenario, sp));
      return;
    }
    if (p === '/api/quality/export') {
      qualityExport(res, scenario, sp);
      return;
    }
    if (p === '/api/events') {
      const base = readFixture(scenario, 'events');
      const meta = readFixture(scenario, 'meta');
      base.now = meta?.now;
      const limit = intParam(sp, 'limit', 200, 1, 500);
      const after = sp.has('after') ? intParam(sp, 'after', 0, 0, Number.MAX_SAFE_INTEGER) : null;
      if (after == null) liveStart.set(scenario, Date.now());
      const live = scenario === 'vazio' ? [] : liveEvents(scenario, base, after ?? 0, 500);
      let all = [...base.events.map((e) => e), ...live];
      const group = sp.get('group');
      const token = sp.get('token');
      const level = sp.get('level');
      if (group) all = all.filter((e) => e.group === group);
      if (token) all = all.filter((e) => e.token === token);
      if (level) all = all.filter((e) => e.level === level);
      const lastSeq = live.length ? live[live.length - 1].seq : base.lastSeq;
      const events = after != null ? all.filter((e) => e.seq > after).slice(0, limit) : all.slice(-limit);
      send(res, 200, { ok: true, lastSeq: Math.max(lastSeq, ...events.map((e) => e.seq), 0), events });
      return;
    }
    if (p === '/api/history') {
      const h = readFixture(scenario, 'history');
      const limit = intParam(sp, 'limit', 200, 1, 500);
      let entries = h.entries;
      if (sp.get('token')) entries = entries.filter((e) => e.token === sp.get('token'));
      if (sp.get('before')) entries = entries.filter((e) => e.time < sp.get('before'));
      send(res, 200, { ok: true, entries: entries.slice(0, limit) });
      return;
    }
    sendError(res, 404, scenario, 'error-not-found', { ok: false, error: { code: 'NOT_FOUND', message: 'Não encontrado.' } });
    return;
  }

  // POST: same checks as the console (content type, size, JSON object, confirmation), answers from the fixtures.
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    send(res, 415, { ok: false, error: { code: 'CONTENT_TYPE', message: 'Use Content-Type: application/json.' } });
    return;
  }
  const { size, text } = await readBody(req);
  if (size > 8192) {
    send(res, 413, { ok: false, error: { code: 'BODY_TOO_LARGE', message: 'Requisição grande demais.' } });
    return;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 400, scenario, 'error-bad-json', { ok: false, error: { code: 'BAD_JSON', message: 'Corpo da requisição não é JSON válido.' } });
    return;
  }
  if (p === '/api/key/rotate') {
    send(res, 200, { ok: true, key: 'mock' });
    return;
  }
  if (p === '/api/alerts/ack') {
    const hours = body.hours === undefined ? 24 : body.hours;
    const until = hours == null ? null : new Date(Date.parse(readFixture(scenario, 'meta').now) + hours * 3600000).toISOString().replace('.000Z', 'Z');
    send(res, 200, { ok: true, id: String(body.id || ''), until });
    return;
  }
  if (p === '/api/alerts/unack') {
    send(res, 200, { ok: true, id: String(body.id || '') });
    return;
  }
  const confirmMismatch = () => sendError(res, 400, scenario, 'error-confirm-mismatch', { ok: false, error: { code: 'CONFIRM_MISMATCH', message: 'A confirmação não confere.' } });
  if (p === '/api/licenses') {
    const customer = String(body.customer ?? '').trim();
    if (!NAME_RE.test(customer)) {
      sendError(res, 400, scenario, 'error-invalid-field', { ok: false, error: { code: 'INVALID_FIELD', message: 'Campo inválido: customer.', field: 'customer' } });
      return;
    }
    if (String(body.confirm ?? '').trim() !== customer) {
      confirmMismatch();
      return;
    }
    const answer = readFixture(scenario, 'issue');
    const days = body.days ?? null;
    const lanes = Array.isArray(body.lanes) && body.lanes.length ? body.lanes : answer.license.lanes;
    const now = Date.parse(answer.license.createdAt);
    answer.license.customer = customer;
    answer.license.lanes = ['odc', 'o11'].filter((l) => lanes.includes(l));
    answer.license.expiresAt = days == null ? null : new Date(now + days * 86400000).toISOString().replace('.000Z', 'Z');
    answer.license.daysLeft = days == null ? null : days;
    if (answer.license.expiresAt == null) answer.license.actions.renew = { allowed: false, reason: 'Licença sem validade: não há o que renovar.' };
    answer.license.history = answer.license.history.map((hh) => ({ ...hh, customer, detail: { days, lanes: answer.license.lanes, expiresAt: answer.license.expiresAt } }));
    const licenses = readFixture(scenario, 'licenses').licenses;
    answer.duplicates = licenses.filter((l) => l.state === 'active' && l.customer === customer).map((l) => l.id);
    send(res, 201, answer);
    return;
  }
  const m = /^\/api\/licenses\/([^/]+)\/(renew|lanes|agent-rotate|revoke)$/.exec(p);
  if (!m) {
    sendError(res, 404, scenario, 'error-not-found', { ok: false, error: { code: 'NOT_FOUND', message: 'Não encontrado.' } });
    return;
  }
  const [, id, verb] = m;
  const lic = TOKEN_RE.test(id) ? readFixture(scenario, 'licenses').licenses.find((l) => l.id === id) : null;
  if (!lic) {
    send(res, 404, { ok: false, error: { code: 'UNKNOWN_TOKEN', message: `Licença ${TOKEN_RE.test(id) ? id : 'desconhecida'} não existe.` } });
    return;
  }
  if ((verb === 'renew' || verb === 'lanes') && scenario === 'sem-renovar') {
    sendError(res, 501, scenario, 'error-not-supported', { ok: false, error: { code: 'NOT_SUPPORTED', message: 'Indisponível nesta imagem do servidor.' } });
    return;
  }
  if (String(body.confirm ?? '').trim() !== lic.customer.trim()) {
    confirmMismatch();
    return;
  }
  if (verb === 'revoke' && lic.state === 'revoked') {
    sendError(res, 409, scenario, 'error-already-revoked', { ok: false, error: { code: 'ALREADY_REVOKED', message: 'A licença já estava revogada.' } });
    return;
  }
  if (verb === 'agent-rotate' && lic.state !== 'active') {
    sendError(res, 409, scenario, 'error-token-not-active', { ok: false, error: { code: 'TOKEN_NOT_ACTIVE', message: 'Só uma licença ativa pode trocar a credencial do agente.' } });
    return;
  }
  const answer = readFixture(scenario, verb);
  const now = Date.parse(readFixture(scenario, 'meta').now);
  answer.license = { ...lic, history: lic.history };
  if (verb === 'renew') {
    const days = Number(body.days) || 30;
    const base = Math.max(now, Date.parse(lic.expiresAt) || now);
    const next = new Date(base + days * 86400000).toISOString().replace('.000Z', 'Z');
    answer.previousExpiresAt = lic.expiresAt;
    answer.expiresAt = next;
    answer.license = { ...lic, state: 'active', expiresAt: next, daysLeft: (Date.parse(next) - now) / 86400000 };
  } else if (verb === 'lanes') {
    const lanes = Array.isArray(body.lanes) ? ['odc', 'o11'].filter((l) => body.lanes.includes(l)) : lic.lanes;
    answer.previousLanes = lic.lanes;
    answer.openSessions = lic.sessionsOpen;
    answer.license = { ...lic, lanes };
  } else if (verb === 'revoke') {
    answer.openSessions = lic.sessionsOpen;
    answer.agentConnected = lic.agent?.state === 'connected';
    answer.license = { ...lic, state: 'revoked', revokedAt: new Date(now).toISOString().replace('.000Z', 'Z') };
  }
  send(res, 200, answer);
}

export function createDevServer() {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'mock://local');
    } catch {
      send(res, 400, { ok: false, error: { code: 'NOT_FOUND', message: 'Não encontrado.' } });
      return;
    }
    if (url.pathname === '/healthz') {
      send(res, 200, { ok: true });
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' } });
        return;
      }
      serveStatic(req, res, url.pathname);
      return;
    }
    const asked = String(req.headers['x-mock-scenario'] || 'normal');
    if (asked === 'sem-conexao') {
      req.socket.destroy();
      return;
    }
    if (!req.headers['x-ssam-console-key']) {
      sendError(res, 401, 'normal', 'error-key-required', { ok: false, error: { code: 'KEY_REQUIRED', message: 'Falta a chave de acesso.' } });
      return;
    }
    if (asked === 'chave-invalida') {
      sendError(res, 401, 'normal', 'error-key-invalid', { ok: false, error: { code: 'KEY_INVALID', message: 'Chave de acesso inválida.' } });
      return;
    }
    const scenario = SCENARIOS.includes(asked) ? asked : 'normal';
    try {
      await handleApi(req, res, url, scenario);
    } catch (e) {
      send(res, 500, { ok: false, error: { code: 'INTERNAL', message: `Erro interno do painel (${e?.code || 'mock'}).` } });
    }
  });
}

function main() {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 7399;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Porta inválida.');
    process.exit(2);
  }
  const server = createDevServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Painel SSAM (mock) em 127.0.0.1:${port} - cenários: ${SCENARIOS.join(', ')} (?mock=<cenário>); extras: ${SPECIAL.join(', ')}.`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
