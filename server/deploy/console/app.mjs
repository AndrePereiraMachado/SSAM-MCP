// Wiring of the console (DESIGN 1.2, 3): builds every part over CONSOLE_STATE_DIR and SSAM_SERVER_DIR, restores the
// checkpoint (or replays every retained file in the background: cold start), runs the readers and polls on their
// cadences (server.log 2 s; audit, access alerts, host.json and the token store 5 s; alerts 10 s; checkpoint 10 s when
// dirty; usage day files 30 s; workspaces 10 min) and writes the checkpoint atomically on stop. server.mjs owns the
// process (listening, signals); tests drive an instance directly with an injected clock.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createAlerts } from './alerts.mjs';
import { createAuth } from './auth.mjs';
import { createEvents } from './events.mjs';
import { createHistory } from './history.mjs';
import { createHost } from './host.mjs';
import { createGate, createHttp } from './http.mjs';
import { createLicenses } from './licenses.mjs';
import { createLive } from './live.mjs';
import { createAccessAlertsReader, createAuditReader, createServerLogReader, rotatedFiles } from './readers.mjs';
import { createMinutes } from './recent.mjs';
import { createRoutes } from './routes.mjs';
import { createSources } from './sources.mjs';
import { createState } from './state.mjs';
import { cap, eventText } from './texts.mjs';
import { createTz } from './tz.mjs';
import { createUsage } from './usage.mjs';
import { createViews } from './views.mjs';
import { createDataViews } from './views-data.mjs';
import { createWorkspaces } from './workspaces.mjs';

export const CHECKPOINT_SCHEMA = 'ssam-console-checkpoint/1';
const CHECKPOINT = 'checkpoint.json';
const iso = ms => new Date(ms).toISOString();

export async function createConsole({ config, now = Date.now, log = () => {}, workspaceEntries } = {}) {
  const state = createState(config.stateDir);
  state.ensureDir();
  const tz = createTz(config.timeZone);
  const startedAt = iso(now());
  const events = createEvents();
  let replay = null;                       // separate rings while a cold start replays the logs
  const emitMain = e => events.emit(e);
  const emitLog = e => (replay ? replay.log.emit(e) : events.emit(e));
  const emitAudit = e => (replay ? replay.audit.emit(e) : events.emit(e));
  const gate = createGate({ now });
  const history = createHistory({ serverDir: config.serverDir, log });
  const usage = createUsage({ tz, state, now });
  const licenses = await createLicenses({ config, state, history, tz, now, log, emit: emitMain, gate });
  const sources = createSources({ serverDir: config.serverDir, now });
  const live = createLive({ tz, now, nameOf: licenses.nameOf, emit: emitLog, usage });
  const host = createHost({ file: config.hostJson, state, tz, now, emit: emitMain, usage });
  const workspaces = createWorkspaces({ serverDir: config.serverDir, state, now, ...(workspaceEntries ? { maxEntries: workspaceEntries } : {}) });
  const alerts = createAlerts({ state, now, emit: emitMain });
  const auth = createAuth({ state, now });
  const auditMinutes = createMinutes({ keepMinutes: 20 });
  const readProblems = {};
  let lossAt = null;
  const progress = { total: 0, done: 0, file: null };
  let indexing = 'ready';

  // ---- readers
  function problem(file, code) {
    if (readProblems[file] === code) return;
    readProblems[file] = code;
    log({ console: 'reader-problem', file: cap(file, 80), code: cap(code, 20) });
  }
  function ok(name) {
    for (const k of Object.keys(readProblems)) if (k === name || (name === 'audit' && k.startsWith('audit')) || (name === 'server.log' && k.startsWith('server.log'))) delete readProblems[k];
  }
  function onLoss() {
    lossAt = iso(now());
    emitMain({ time: lossAt, level: 'warning', group: 'painel', text: eventText.rotatedLost() });
    log({ console: 'reader-loss', file: 'server.log' });
  }
  const nameOf = token => licenses.nameOf(token) ?? live.logNames[token] ?? null;
  function onAudit(line) {
    const r = usage.addCall(line);
    if (!r) return;
    live.noteCall(r.token, line.time, r.tool, typeof line.customer === 'string' ? line.customer : null);
    auditMinutes.add(line.time, r.ok, r.code, r.tool);
    const name = nameOf(r.token) ?? cap(line.customer ?? null, 64);
    const c = name ?? r.token;
    emitAudit({ time: line.time, level: r.ok ? 'info' : 'warning', group: 'chamada', token: r.token, customer: name,
      text: r.ok ? eventText.callOk(c, r.tool, r.ms) : eventText.callFailed(c, r.tool, r.code, r.ms), code: r.code });
  }
  const dir = config.serverDir;
  const serverLog = createServerLogReader({ dir, onRecord: e => live.apply(e), onLoss, onProblem: problem, onOk: ok, progress });
  const audit = createAuditReader({ dir, onRecord: onAudit, onProblem: problem, onOk: ok, now, progress });
  const access = createAccessAlertsReader({ dir, onRecord: l => sources.addAccess(l), onReset: () => sources.resetAccess(), onProblem: problem, progress });

  // ---- checkpoint
  const value = () => ({ schema: CHECKPOINT_SCHEMA,
    readers: { serverLog: serverLog.checkpoint(), audit: audit.checkpoint(), access: access.checkpoint() },
    live: live.toJSON(), events: events.toJSON(), host: host.toJSON(), sources: sources.toJSON(), auditMinutes: auditMinutes.toJSON(),
    usagePending: usage.pending(), lossAt });
  let written = null;
  function writeCheckpoint(force = false) {
    if (indexing === 'running') return false;
    const v = value();
    const text = JSON.stringify(v);
    if (!force && text === written) return false;
    state.writeText(CHECKPOINT, JSON.stringify({ ...v, savedAt: iso(now()) }));
    written = text;
    return true;
  }
  function flushDays() { if (indexing !== 'running') { usage.flushDays(); writeCheckpoint(); } }

  const saved = state.readJson(CHECKPOINT);
  const validSaved = saved && saved.schema === CHECKPOINT_SCHEMA;
  const cold = !validSaved || !state.exists('agg');
  state.ensureDir('agg');
  state.ensureDir('series');
  if (validSaved) host.restore(saved.host);
  if (!cold) {
    serverLog.restore(saved.readers?.serverLog);
    audit.restore(saved.readers?.audit);
    access.restore(saved.readers?.access);
    live.restore(saved.live);
    events.restore(saved.events);
    sources.restore(saved.sources);
    auditMinutes.restore(saved.auditMinutes);
    usage.restorePending(saved.usagePending);
    lossAt = saved.lossAt ?? null;
  }

  function retainedBytes() {
    let total = 0;
    const size = name => { try { return fs.statSync(path.join(dir, name)).size; } catch { return 0; } };
    for (const r of rotatedFiles(dir)) total += size(r.name);
    total += size('server.log') + size('access-alerts.jsonl');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* none */ }
    for (const n of names) if (/^audit-\d{8}\.jsonl(\.gz)?$/.test(n)) total += size(n);
    return total;
  }
  async function untilCaughtUp(tick) {
    for (let i = 0; i < 1000000; i++) {
      const before = progress.done;
      if (await tick()) return;
      if (progress.done === before) return;
    }
  }
  // Cold start (3.2): every retained file through the same dispatchers, in the background, views answer meanwhile.
  async function coldStart() {
    indexing = 'running';
    progress.total = retainedBytes(); progress.done = 0; progress.file = null;
    usage.beginRebuild();
    replay = { log: createEvents(), audit: createEvents() };
    // Each phase on its own: a file that cannot be read in one never skips the replay of the others.
    const phase = async (name, fn) => {
      try { await fn(); } catch (error) { log({ console: 'cold-start-error', phase: name, code: cap(error?.code ?? error?.name ?? 'ERRO', 40) }); }
    };
    try {
      await phase('server.log', () => serverLog.coldStart());
      progress.file = 'auditoria';
      await phase('audit', () => untilCaughtUp(() => audit.tick()));
      progress.file = 'access-alerts.jsonl';
      await phase('access-alerts', () => untilCaughtUp(() => access.tick()));
    } finally {
      usage.endRebuild();
      events.adopt(replay.log.ring, replay.audit.ring);
      replay = null;
      indexing = 'ready';
      progress.file = null;
      usage.flushDays();
      writeCheckpoint(true);
    }
  }
  const indexingView = () => (indexing === 'running'
    ? { state: 'running', progress: progress.total ? Math.min(0.99, Math.round((progress.done / progress.total) * 100) / 100) : 0, detail: progress.file }
    : { state: 'ready', progress: 1, detail: null });

  // ---- alert context (section 5)
  function activityBetween(token, from, to) {
    const la = live.lastActivity[token];
    if (la && Date.parse(la.at) >= from && Date.parse(la.at) <= to) return true;
    for (let d = tz.day(from), end = tz.day(to), i = 0; d <= end && i < 40; d = tz.addDays(d, 1), i++) {
      const t = usage.get(d).byToken[token];
      if (t && (t.calls || t.sessionsOpened || t.agentCalls)) return true;
    }
    return false;
  }
  function alertContext() {
    const t = now();
    const { tokens, error } = licenses.tryList();
    const sessionsByToken = {};
    for (const s of live.sessions.values()) sessionsByToken[s.token] = (sessionsByToken[s.token] ?? 0) + 1;
    const restarts24h = {};
    for (const key of Object.keys(host.facts.restarts ?? {})) restarts24h[key] = host.restarts24h(key);
    const c = host.collector();
    return {
      tz, licenses: tokens, licensesError: error ? (licenses.listError?.code ?? error.apiCode) : null, tokensUnreadableAt: live.tokensUnreadableAt,
      licenseNotices: licenses.notices(),
      nameOf, sessionsByToken, maxSessions: live.server?.maxSessionsPerToken ?? 8,
      calls15: auditMinutes.window(t, 15),
      agentFailures15: live.agentTokens().map(token => ({ token, ...live.agentWindow(token, 15) })).filter(a => a.failures > 0),
      serverErrors: live.serverErrors(), serverLogB: sources.statFiles().serverLogB,
      hostStatus: c.state === 'missing' ? 'missing' : c.state === 'invalid' ? 'invalid' : 'ok', hostSchema: c.schema,
      doc: host.doc, facts: host.facts, failedSections: host.failedSections(), restarts24h,
      kernelFile: sources.kernel(), workspaces: { ...(workspaces.all.byToken ?? {}) }, access: sources.access(),
      activityBetween, readProblems: { ...readProblems }, lossAt,
    };
  }

  // ---- ticks
  const safe = (name, fn) => async () => {
    try { await fn(); } catch (error) { log({ console: 'tick-error', tick: name, code: cap(error?.code ?? error?.name ?? 'ERRO', 40) }); }
  };
  const tickLog = safe('server.log', async () => { if (indexing !== 'running') await serverLog.tick(); });
  const tickFiles = safe('files', async () => {
    if (indexing !== 'running') { await audit.tick(); await access.tick(); }
    host.poll();
    licenses.detectExternal();
  });
  const tickAlerts = safe('alerts', () => alerts.evaluate(alertContext()));
  const tickCheckpoint = safe('checkpoint', () => writeCheckpoint());
  const tickDays = safe('days', () => flushDays());
  const tickWorkspaces = safe('workspaces', async () => { if (workspaces.due()) await workspaces.run(); });

  // ---- HTTP
  const views = createViews({ config, tz, now, startedAt, licenses, live, usage, host, sources, workspaces, history, events, alerts, indexing: indexingView });
  const data = createDataViews({ tz, now, licenses, live, usage, host, sources, workspaces, indexing: indexingView });
  const routes = createRoutes({ views, data, licenses, live, alerts, auth, history, gate, log, now });
  const server = http.createServer(createHttp({ auth, routes, publicDir: config.publicDir, log, now }));
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;

  let timers = [];
  let indexed = Promise.resolve();
  // First pass: cold start in the background (or resume), host.json, licenses snapshot, workspaces, alerts.
  function begin() {
    try { licenses.tryList(); } catch { /* reported by the alerts */ }
    host.poll();
    sources.statFiles(true);
    indexed = cold ? coldStart() : Promise.resolve();
    indexed.then(() => tickAlerts());
    return indexed;
  }
  function startTimers() {
    const every = (ms, fn) => { const h = setInterval(fn, ms); timers.push(h); };
    every(2000, tickLog);
    every(5000, tickFiles);
    every(10000, tickAlerts);
    every(10000, tickCheckpoint);
    every(30000, tickDays);
    every(60000, tickWorkspaces);
    tickWorkspaces();
  }
  function stop() {
    for (const h of timers) clearInterval(h);
    timers = [];
    try { if (indexing !== 'running') { usage.flushDays(); writeCheckpoint(true); } } catch (error) { log({ console: 'checkpoint-failed', code: cap(error?.code ?? 'ERRO', 20) }); }
  }
  // Runs every reader and poll once, in order (tests and the first pass).
  async function tickAll() { await tickLog(); await tickFiles(); await tickAlerts(); }

  return {
    server, auth, begin, startTimers, stop, tickAll, tickAlerts, writeCheckpoint, flushDays, alertContext,
    get indexed() { return indexed; }, get cold() { return cold; },
    capabilities: licenses.caps, startedAt,
    parts: { state, tz, events, history, usage, licenses, sources, live, host, workspaces, alerts, serverLog, audit, access, auditMinutes, gate, views, data, readProblems },
  };
}
