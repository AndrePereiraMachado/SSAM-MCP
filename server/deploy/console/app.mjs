import {versionReader} from './version-reader.mjs';
// Wiring of the console (DESIGN 1.2, 3): builds every part over CONSOLE_STATE_DIR and SSAM_SERVER_DIR, restores the
// checkpoint (or replays every retained file in the background: cold start), runs the readers and polls on their
// cadences (server.log 2 s; audit, access alerts, host.json and the token store 5 s; alerts 10 s; checkpoint 10 s when
// dirty; usage day files 30 s; workspaces 10 min) and writes the checkpoint atomically on stop. server.mjs owns the
// process (listening, signals); tests drive an instance directly with an injected clock.
// The quality records (DESIGN-QUALIDADE 4.1) have their own reader (quality-YYYYMMDD.jsonl, with the audit every 5 s),
// their own day files (/state/agg-quality) and their own cold start: an older checkpoint without them, or a missing
// agg-quality folder, replays only the quality files and never rebuilds the usage.
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
import { loadNativeIds, MAX_LINE_BYTES as QUALITY_LINE_BYTES } from './quality-line.mjs';
import { createQuality, QUALITY_DIR } from './quality.mjs';
import { createAccessAlertsReader, createAuditReader, createDailyReader, createServerLogReader, rotatedFiles } from './readers.mjs';
import { createMinutes } from './recent.mjs';
import { createRoutes } from './routes.mjs';
import { createSources } from './sources.mjs';
import { createState } from './state.mjs';
import { cap, eventText } from './texts.mjs';
import { createTz } from './tz.mjs';
import { createUsage } from './usage.mjs';
import { createViews } from './views.mjs';
import { createDataViews } from './views-data.mjs';
import { createQualityViews } from './views-quality.mjs';
import { createWorkspaces } from './workspaces.mjs';
import { defaultToolsCatalog, loadToolNames } from './tool-names.mjs';
import { DEFAULT_KERNEL_CATALOG } from './config.mjs';

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
  // The tool names the console may show: the image's hosted catalog (CONSOLE_TOOLS_CATALOG); another name is '?'.
  const toolNames = loadToolNames(config.toolsCatalog ?? defaultToolsCatalog());
  const usage = createUsage({ tz, state, now, tools: toolNames });
  const licenses = await createLicenses({ config, state, history, tz, now, log, emit: emitMain, gate });
  const sources = createSources({ serverDir: config.serverDir, now });
  const live = createLive({ tz, now, nameOf: licenses.nameOf, emit: emitLog, usage, tools: toolNames });
  const host = createHost({ file: config.hostJson, state, tz, now, emit: emitMain, usage });
  const workspaces = createWorkspaces({ serverDir: config.serverDir, state, now, ...(workspaceEntries ? { maxEntries: workspaceEntries } : {}) });
  const alerts = createAlerts({ state, now, emit: emitMain });
  // The access key (the SSH tunnel) or the GitHub sign-in (the Coolify mode), by the configuration.
  const auth = createAuth({ config, state, history, now, log, emit: emitMain });
  const auditMinutes = createMinutes({ keepMinutes: 20 });
  const readProblems = {};
  let lossAt = null;
  const progress = { total: 0, done: 0, file: null };
  let indexing = 'ready';
  // Quality records: the native verification ids of the image's kernel catalogs (fail closed: none -> NATIVE_UNLISTED),
  // the aggregates and their own progress while their cold start replays.
  const nativeIds = loadNativeIds(config.kernelCatalog ?? DEFAULT_KERNEL_CATALOG, { readDir: fs.readdirSync, readFile: fs.readFileSync, join: path.join });
  const quality = createQuality({ tz, state, now, nativeIds });
  const qProgress = { total: 0, done: 0, file: null };
  let qIndexing = 'ready';

  // ---- readers
  function problem(file, code) {
    if (readProblems[file] === code) return;
    readProblems[file] = code;
    log({ console: 'reader-problem', file: cap(file, 80), code: cap(code, 20) });
  }
  function ok(name) {
    const family = name === 'audit' || name === 'quality' || name === 'server.log';
    for (const k of Object.keys(readProblems)) if (k === name || (family && k.startsWith(name))) delete readProblems[k];
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
  const serverLog = versionReader(createServerLogReader, { dir, onRecord: e => live.apply(e), onLoss, onProblem: problem, onOk: ok, progress });
  const audit = versionReader(createAuditReader, { dir, onRecord: onAudit, onProblem: problem, onOk: ok, now, progress });
  const access = versionReader(createAccessAlertsReader, { dir, onRecord: l => sources.addAccess(l), onReset: () => sources.resetAccess(), onProblem: problem, progress });
  // quality-YYYYMMDD.jsonl: lines above 4096 bytes are skipped before any parse; every parsed line goes through the
  // contract (quality.addRecord: sanitizeQualityLine with the native ids; what returns null is dropped and counted).
  const qualityReader = versionReader(createDailyReader, { dir, prefix: 'quality', maxLineBytes: QUALITY_LINE_BYTES, onRecord: r => quality.addRecord(r),
    onProblem: problem, onOk: ok, now, progress: qProgress });

  // ---- checkpoint
  // The quality part (its reader's files, the open chains and the dirty quality days) is left out while its cold start
  // replays: a restart in the middle replays it again instead of resuming from half a rebuild.
  const qualityReady = () => qIndexing !== 'running';
  const value = () => ({ schema: CHECKPOINT_SCHEMA,
    readers: { serverLog: serverLog.checkpoint(), audit: audit.checkpoint(), access: access.checkpoint(), ...(qualityReady() ? { quality: qualityReader.checkpoint() } : {}) },
    live: live.toJSON(), events: events.toJSON(), host: host.toJSON(), sources: sources.toJSON(), auditMinutes: auditMinutes.toJSON(),
    usagePending: usage.pending(), ...(qualityReady() ? { quality: quality.toJSON() } : {}), lossAt });
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
  // Day files and the checkpoint go together, so the positions in the checkpoint always match what the day files hold.
  function flushDays() {
    if (indexing === 'running') return;
    usage.flushDays();
    if (qualityReady()) quality.flushDays();
    writeCheckpoint();
  }

  const saved = state.readJson(CHECKPOINT);
  const validSaved = saved && saved.schema === CHECKPOINT_SCHEMA;
  const cold = !validSaved || !state.exists('agg');
  const qualityCold = !validSaved || !saved.readers?.quality || !saved.quality || !state.exists(QUALITY_DIR);
  state.ensureDir('agg');
  state.ensureDir(QUALITY_DIR);
  state.ensureDir('series');
  if (validSaved) host.restore(saved.host);
  if (!qualityCold) {
    qualityReader.restore(saved.readers.quality);
    quality.restore(saved.quality);
  }
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
  async function untilCaughtUp(tick, prog = progress) {
    for (let i = 0; i < 1000000; i++) {
      const before = prog.done;
      if (await tick()) return;
      if (prog.done === before) return;
    }
  }
  // Each phase on its own: a file that cannot be read in one never skips the replay of the others.
  const phase = async (name, fn) => {
    try { await fn(); } catch (error) { log({ console: 'cold-start-error', phase: name, code: cap(error?.code ?? error?.name ?? 'ERRO', 40) }); }
  };
  // Cold start (3.2): every retained file through the same dispatchers, in the background, views answer meanwhile.
  async function coldStart() {
    indexing = 'running';
    progress.total = retainedBytes(); progress.done = 0; progress.file = null;
    usage.beginRebuild();
    replay = { log: createEvents(), audit: createEvents() };
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
      if (qualityReady()) quality.flushDays();
      writeCheckpoint(true);
    }
  }
  const indexingView = () => (indexing === 'running'
    ? { state: 'running', progress: progress.total ? Math.min(0.99, Math.round((progress.done / progress.total) * 100) / 100) : 0, detail: progress.file }
    : { state: 'ready', progress: 1, detail: null });

  // ---- quality (DESIGN-QUALIDADE 4.1, 4.2)
  const qualityFiles = () => { let names = []; try { names = fs.readdirSync(dir); } catch { /* none */ } return names.filter(n => /^quality-\d{8}\.jsonl(\.gz)?$/.test(n)); };
  const qualityBytes = () => qualityFiles().reduce((s, n) => { try { return s + fs.statSync(path.join(dir, n)).size; } catch { return s; } }, 0);
  // The idle close needs a clock: the console's own once the reader is at the end of every file, else the newest line
  // read (a backlog never closes a session whose next lines are still unread), and never ahead of the console's clock.
  const sweepClock = caughtUp => (caughtUp ? now() : Math.min(quality.lineClock, now()));
  async function tickQuality() {
    if (!qualityReady()) return;
    const caughtUp = await qualityReader.tick();
    quality.sweep(sweepClock(caughtUp));
  }
  // The quality cold start: every retained quality-* file replayed as its own phase; each day is emptied the first time
  // a line reaches it; the usage is not touched.
  async function coldStartQuality() {
    qIndexing = 'running';
    qProgress.total = qualityBytes(); qProgress.done = 0; qProgress.file = 'registros de qualidade';
    quality.beginRebuild();
    qualityReader.restore(null);
    try {
      await phase('quality', () => untilCaughtUp(async () => {
        const caughtUp = await qualityReader.tick();
        quality.sweep(Math.min(quality.lineClock, now()));
        return caughtUp;
      }, qProgress));
    } finally {
      quality.endRebuild();
      qIndexing = 'ready';
      qProgress.file = null;
      quality.sweep(now());
      if (indexing !== 'running') { quality.flushDays(); writeCheckpoint(true); }
    }
  }
  const qualityIndexingView = () => (qIndexing === 'running'
    ? { state: 'running', progress: qProgress.total ? Math.min(0.99, Math.round((qProgress.done / qProgress.total) * 100) / 100) : 0, detail: qProgress.file }
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
    await tickQuality();
    host.poll();
    await licenses.reconnect();
    licenses.detectExternal();
  });
  const tickAlerts = safe('alerts', () => alerts.evaluate(alertContext()));
  const tickCheckpoint = safe('checkpoint', () => writeCheckpoint());
  const tickDays = safe('days', () => flushDays());
  const tickWorkspaces = safe('workspaces', async () => { if (workspaces.due()) await workspaces.run(); });

  // ---- HTTP
  const views = createViews({ config, tz, now, startedAt, licenses, live, usage, host, sources, workspaces, history, events, alerts, indexing: indexingView });
  const data = createDataViews({ tz, now, licenses, live, usage, host, sources, workspaces, indexing: indexingView });
  const qualityViews = createQualityViews({ tz, now, quality, serverDir: dir, nativeIds, nameOf, indexing: qualityIndexingView,
    qualityFileCount: () => sources.statFiles().qualityFiles });
  const routes = createRoutes({ views, data, quality: qualityViews, licenses, live, alerts, auth, history, gate, log, now });
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
    // The quality cold start runs after the main one (when there is one); its reader waits from now on.
    if (qualityCold) qIndexing = 'running';
    indexed = (cold ? coldStart() : Promise.resolve()).then(() => (qualityCold ? coldStartQuality() : undefined));
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
    try {
      if (indexing !== 'running') { usage.flushDays(); if (qualityReady()) quality.flushDays(); writeCheckpoint(true); }
    } catch (error) { log({ console: 'checkpoint-failed', code: cap(error?.code ?? 'ERRO', 20) }); }
    licenses.close();
  }
  // Runs every reader and poll once, in order (tests and the first pass).
  async function tickAll() { await tickLog(); await tickFiles(); await tickAlerts(); }

  return {
    server, auth, begin, startTimers, stop, tickAll, tickAlerts, writeCheckpoint, flushDays, alertContext,
    get indexed() { return indexed; }, get cold() { return cold; }, get qualityCold() { return qualityCold; },
    capabilities: licenses.caps, startedAt,
    parts: { state, tz, events, history, usage, licenses, sources, live, host, workspaces, alerts, serverLog, audit, access, auditMinutes, gate, views, data,
      readProblems, quality, qualityReader, qualityViews, nativeIds },
  };
}
