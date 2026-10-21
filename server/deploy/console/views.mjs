// Payloads of the read endpoints (DESIGN 4.2, 4.3): /api/meta, /api/overview, /api/licenses (and the License object the
// mutations return), /api/live, /api/events, /api/history. /api/usage and /api/vps are in views-data.mjs.
import { licenseCounts, publicHostOf, serverStatusOf, urlsOf, warmOf } from './derive.mjs';
import { diskUsedPct, memUsedPct, serverContainer } from './host.mjs';
import { EVENT_GROUPS, EVENT_LEVELS } from './events.mjs';
import { invalidField, sessionReason } from './texts.mjs';
import { CONSOLE_VERSION } from './config.mjs';
import { HISTORY_ACTIONS as HISTORY_ACTION_LIST } from './history.mjs';

const DAY = 86400000;
const TOKEN = /^tok_[0-9a-f]{12}$/;
const NOT_IN_IMAGE = 'Indisponível nesta imagem (chega com o 24º envio).';
// capabilities.readOnly (licenses.mjs, CONSOLE_LICENSE_WRITES): why every license action is off
const READ_ONLY = Object.freeze({ __proto__: null,
  'sem-trava': 'Desligado: esta imagem não trava o tokens.json entre o painel e o ssam-admin (DEPLOY.md 15.4).',
  desligado: 'Desligado neste painel (CONSOLE_LICENSE_WRITES=off).' });
const HISTORY_ACTIONS = new Set(HISTORY_ACTION_LIST);
const SUMMARY_OF = { servidor: 'servidor', licencas: 'licencas', uso: 'uso', agentes: 'agentes', vps: 'vps', seguranca: 'vps', backup: 'backup', tls: 'tls', coletor: 'coletor', painel: 'coletor' };
const CONTAINER_RULES = new Set(['container-reiniciou', 'container-oom', 'caddy-fora', 'coolify-rodando']);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function intParam(query, name, { min, max, fallback }) {
  const raw = query.get(name);
  if (raw === null || raw === '') return fallback;
  if (!/^\d{1,9}$/.test(raw)) throw invalidField(name, `inteiro de ${min} a ${max}`);
  const n = Number(raw);
  if (n < min || n > max) throw invalidField(name, `inteiro de ${min} a ${max}`);
  return n;
}
export function tokenParam(query) {
  const raw = query.get('token');
  if (raw === null || raw === '') return null;
  if (!TOKEN.test(raw)) throw invalidField('token', 'tok_ seguido de 12 hexadecimais');
  return raw;
}
function listParam(query, name, allowed) {
  const raw = query.get(name);
  if (raw === null || raw === '') return null;
  const values = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (!values.length || values.some(v => !allowed.has(v))) throw invalidField(name, [...allowed].join(', '));
  return new Set(values);
}

export function createViews(app) {
  const { config, tz, now, licenses, live, usage, host, sources, workspaces, history, events, alerts } = app;

  const nameOf = token => licenses.nameOf(token) ?? live.logNames[token] ?? null;
  const urls = () => urlsOf(publicHostOf(live, config.domain));
  const capabilities = () => ({ ...licenses.caps });

  function actionsOf(t) {
    const revoked = t.state === 'revoked';
    const off = READ_ONLY[licenses.caps.readOnly] ?? null;
    if (off) return Object.fromEntries(['renew', 'lanes', 'agentRotate', 'revoke'].map(k => [k, { allowed: false, reason: off }]));
    const reasons = {
      renew: !licenses.caps.renew ? NOT_IN_IMAGE : revoked ? 'Licença revogada.' : !t.expiresAt ? 'Licença sem validade: não há o que renovar.' : null,
      lanes: !licenses.caps.lanes ? NOT_IN_IMAGE : revoked ? 'Licença revogada.' : null,
      agentRotate: !licenses.caps.agentRotate ? NOT_IN_IMAGE : revoked ? 'Licença revogada.' : t.state !== 'active' ? 'Só para licença ativa.' : null,
      revoke: !licenses.caps.revoke ? NOT_IN_IMAGE : revoked ? 'Licença revogada.' : null,
    };
    return Object.fromEntries(Object.entries(reasons).map(([k, reason]) => [k, { allowed: reason === null, reason }]));
  }
  // Shared per-request context of the License objects.
  function licenseContext() {
    const t = now();
    const days14 = tz.days(tz.day(t), 14);
    const byToken = new Map();
    for (const e of history.query({ limit: 100000 })) {
      if (!e.token) continue;
      const list = byToken.get(e.token) ?? [];
      if (list.length < 5) list.push(e);
      byToken.set(e.token, list);
    }
    return { t, aggs: days14.map(d => usage.get(d)), pins: sources.pins() ?? {}, historyByToken: byToken };
  }
  function license(view, c = licenseContext()) {
    const exp = view.expiresAt ? Date.parse(view.expiresAt) : null;
    const a = live.agentKnown(view.id);
    const connected = a?.state === 'connected';
    const today = c.aggs[c.aggs.length - 1].byToken[view.id];
    return {
      id: view.id, customer: view.customer, state: view.state, createdAt: view.createdAt, expiresAt: view.expiresAt, revokedAt: view.revokedAt,
      daysLeft: exp == null ? null : Math.round(((exp - c.t) / DAY) * 10000) / 10000,
      lanes: view.lanes, agentCredentialIssuedAt: view.agentIssuedAt,
      machine: c.pins[view.id] ?? null, accessAlerts: sources.accessCount(view.id),
      agent: a ? { state: connected ? 'connected' : 'disconnected', since: connected ? a.since : a.closedAt, lastSignalAt: a.lastSignalAt ?? null,
        version: a.version ?? null, closedReason: connected ? null : a.closedReason ?? null }
        : { state: 'never', since: null, lastSignalAt: null, version: null, closedReason: null },
      sessionsOpen: live.sessionsOf(view.id),
      today: { calls: today?.calls ?? 0, failures: today?.failures ?? 0 },
      daily14: c.aggs.map(agg => agg.byToken[view.id]?.calls ?? 0),
      lastActivity: live.lastActivity[view.id] ?? null,
      workspace: workspaces.get(view.id),
      actions: actionsOf(view),
      history: c.historyByToken.get(view.id) ?? [],
    };
  }

  function indexing() { return app.indexing(); }

  function meta() {
    return { ok: true, console: { version: CONSOLE_VERSION, startedAt: app.startedAt }, now: new Date(now()).toISOString(), timeZone: tz.timeZone,
      ...urls(), capabilities: capabilities(), indexing: indexing() };
  }

  function licensesPayload() {
    const tokens = licenses.list();
    const c = licenseContext();
    return { ok: true, now: new Date(c.t).toISOString(), capabilities: capabilities(), licenses: tokens.map(t => license(t, c)) };
  }

  function summaryRows(tokens, st, alertList) {
    const t = now();
    const worst = {};
    for (const a of alertList) {
      let area = SUMMARY_OF[a.area];
      if (a.rule === 'sessoes-limite') area = 'sessoes';
      else if (CONTAINER_RULES.has(a.rule)) area = 'containers';
      if (!area) continue;
      const level = a.severity === 'critical' ? 2 : a.severity === 'warning' ? 1 : 0;
      worst[area] = Math.max(worst[area] ?? 0, level);
    }
    const stateOf = (area, known) => (worst[area] === 2 ? 'critical' : worst[area] === 1 ? 'warning' : known ? 'ok' : 'unknown');
    const hostSec = host.sec('host'), docker = host.sec('docker'), server = host.sec('server'), backups = host.sec('backups');
    const tls = host.sec('tls'), updates = host.sec('updates');
    const collector = host.collector();
    const counts = licenseCounts(tokens);
    const next = (tokens ?? []).filter(x => x.state === 'active' && x.expiresAt && Date.parse(x.expiresAt) - t <= 30 * DAY)
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))[0] ?? null;
    const today = usage.summarize([tz.day(t)]);
    const agents = [...live.agents.values()];
    const lastSignal = agents.map(a => a.lastSignalAt).filter(Boolean).sort().pop() ?? null;
    const sessions = [...live.sessions.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    const containers = Array.isArray(docker?.containers) ? docker.containers : null;
    const probe = server?.health?.probe;
    const newest = backups?.newest ?? null;
    const certs = Array.isArray(tls?.certs) ? [...tls.certs].sort((a, b) => Date.parse(a.notAfter) - Date.parse(b.notAfter)) : [];
    const cert = certs[0];
    const restarts = containers ? containers.reduce((s, c) => s + host.restarts24h(String(c.service || c.name || '?').slice(0, 64)), 0) : null;
    return [
      { area: 'servidor', state: stateOf('servidor', st.state !== 'unknown'), view: 'vps',
        facts: { since: st.since, pid: st.pid, imageTag: st.imageTag, warm: st.warm, health: st.health, probeMs: probe?.ok ? num(probe.ms) : null } },
      { area: 'licencas', state: stateOf('licencas', !!tokens), view: 'licencas',
        facts: { ...counts, nextExpiry: next ? { customer: next.customer, token: next.id, expiresAt: next.expiresAt } : null } },
      { area: 'uso', state: stateOf('uso', true), view: 'uso',
        facts: { calls: today.totals.calls, failures: today.totals.failures, p90Ms: today.totals.p90Ms, customersActive: today.totals.customersActive } },
      { area: 'agentes', state: stateOf('agentes', true), view: 'agentes',
        facts: { connected: agents.filter(a => a.state === 'connected').length, activeLicenses: counts.active, lastSignalAt: lastSignal } },
      { area: 'sessoes', state: stateOf('sessoes', true), view: 'agentes',
        facts: { open: live.sessions.size, top: sessions.slice(0, 3).map(s => ({ customer: nameOf(s.token) ?? s.token, client: s.client })) } },
      { area: 'vps', state: stateOf('vps', !!hostSec), view: 'vps',
        facts: { cpuPct: num(hostSec?.cpu?.pct), memUsedPct: memUsedPct(hostSec), diskUsedPct: diskUsedPct(hostSec),
          rebootRequired: updates ? !!updates.rebootRequired : null, rebootSince: updates?.rebootSince ?? null } },
      { area: 'containers', state: stateOf('containers', !!containers), view: 'vps',
        facts: containers ? { running: containers.filter(c => c.state === 'running').length, total: containers.length,
          unhealthy: containers.filter(c => c.health === 'unhealthy').map(c => String(c.service || c.name)), restarts24h: restarts }
          : { running: null, total: null, unhealthy: [], restarts24h: null } },
      { area: 'backup', state: stateOf('backup', !!backups), view: 'vps',
        facts: { newestAt: newest?.mtime ?? null, ageH: newest ? Math.round(((t - Date.parse(newest.mtime)) / 3600000) * 10) / 10 : null,
          cron: backups?.cron ? { backup: !!backups.cron.backup, rotate: !!backups.cron.rotate } : null } },
      { area: 'tls', state: stateOf('tls', !!tls), view: 'vps',
        facts: cert ? { name: cert.name ?? null, notAfter: cert.notAfter ?? null, daysLeft: Math.round(((Date.parse(cert.notAfter) - t) / DAY) * 100) / 100, issuer: cert.issuer ?? null } : {} },
      { area: 'coletor', state: stateOf('coletor', collector.state === 'fresh'), view: 'vps',
        facts: { collectedAt: collector.collectedAt, ageS: collector.ageS, sectionErrors: host.failedSections().length } },
    ];
  }

  function overview() {
    const t = now();
    const { tokens } = licenses.tryList();
    const st = serverStatusOf(host, live, t);
    const { alerts: active, acked } = alerts.list();
    const collector = host.collector();
    const hostSec = host.sec('host');
    return {
      ok: true, now: new Date(t).toISOString(),
      status: {
        server: st, sessionsOpen: live.sessions.size, agentsConnected: [...live.agents.values()].filter(a => a.state === 'connected').length,
        licenses: licenseCounts(tokens), alerts: alerts.counts(),
        collector: { state: collector.state, collectedAt: collector.collectedAt, ageS: collector.ageS },
        host: hostSec ? { cpuPct: num(hostSec.cpu?.pct), memUsedPct: memUsedPct(hostSec), diskUsedPct: diskUsedPct(hostSec) } : null,
        publicHost: urls().publicHost,
      },
      studioVersions: sources.studioVersions(), alerts: active, acked, summary: summaryRows(tokens, st, active), recentEvents: events.recent(10), indexing: indexing(),
    };
  }

  function livePayload() {
    const t = now();
    const server = host.sec('server');
    const processes = Array.isArray(server?.processes) ? server.processes : null;
    const closed = live.closedToday();
    return {
      ok: true, now: new Date(t).toISOString(),
      server: live.server ? { since: live.server.since, pid: live.server.pid, mode: live.server.mode, ratePerMinute: live.server.ratePerMinute,
        maxSessionsPerToken: live.server.maxSessionsPerToken, publicHosts: live.server.publicHosts } : null,
      sessions: [...live.sessions.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)).map(s => ({
        session: s.session.slice(0, 8), token: s.token, customer: nameOf(s.token), client: s.client ?? null, ip: s.ip, ua: s.ua,
        openedAt: s.openedAt, lastAt: s.lastAt, calls: s.calls, lastTool: s.lastTool ?? null, bytes: s.bytes })),
      agents: [...live.agents.values()].map(a => {
        const w = live.agentWindow(a.token, 60);
        const connected = a.state === 'connected';
        return { token: a.token, customer: nameOf(a.token), state: connected ? 'connected' : 'disconnected', since: connected ? a.since : a.closedAt ?? null,
          lastSignalAt: a.lastSignalAt ?? null, version: a.version ?? null, pack: a.pack ?? null, studioO11: a.o11 ?? null, ip: a.ip ?? null,
          machine: a.machine ?? null, calls1h: w.calls, failures1h: w.failures, lastCode: a.lastCode ?? null,
          closedReason: connected ? null : a.closedReason ?? null, closedAt: connected ? null : a.closedAt ?? null };
      }).sort((a, b) => (a.state === b.state ? String(b.lastSignalAt ?? '').localeCompare(String(a.lastSignalAt ?? '')) : a.state === 'connected' ? -1 : 1)),
      workers: { available: !!processes, rows: (processes ?? []).map(p => ({ kind: String(p.kind ?? 'other').slice(0, 20),
        token: typeof p.token === 'string' && TOKEN.test(p.token) ? p.token : null,
        customer: typeof p.token === 'string' && TOKEN.test(p.token) ? nameOf(p.token) : null,
        port: num(p.port), rssB: num(p.rssB), cpuPct: num(p.cpuPct), elapsedS: num(p.elapsedS) })) },
      closedToday: Object.entries(closed).map(([reason, count]) => ({ reason: sessionReason(reason), count })).sort((a, b) => b.count - a.count),
    };
  }

  function eventsPayload(query) {
    const after = query.has('after') ? intParam(query, 'after', { min: 0, max: 999999999, fallback: null }) : null;
    const before = query.has('before') ? intParam(query, 'before', { min: 0, max: 999999999, fallback: null }) : null;
    const limit = intParam(query, 'limit', { min: 1, max: 500, fallback: 200 });
    const groups = listParam(query, 'group', EVENT_GROUPS);
    const levels = listParam(query, 'level', EVENT_LEVELS);
    const token = tokenParam(query);
    const r = events.query({ after, before, limit, groups, levels, token });
    return { ok: true, lastSeq: r.lastSeq, events: r.events };
  }

  function historyPayload(query) {
    const limit = intParam(query, 'limit', { min: 1, max: 500, fallback: 200 });
    const rawBefore = query.get('before');
    let before = null;
    if (rawBefore) {
      const ms = Date.parse(rawBefore);
      if (Number.isNaN(ms)) throw invalidField('before', 'data ISO 8601');
      before = new Date(ms).toISOString();
    }
    const action = query.get('action') || null;
    if (action && !HISTORY_ACTIONS.has(action)) throw invalidField('action', [...HISTORY_ACTIONS].join(', '));
    return { ok: true, entries: history.query({ limit, before, token: tokenParam(query), action }) };
  }

  return { meta, overview, licensesPayload, license, licenseContext, livePayload, eventsPayload, historyPayload, nameOf, urls, warm: () => warmOf(host, now()),
    serverContainer: () => serverContainer(host.sec('docker')) };
}
