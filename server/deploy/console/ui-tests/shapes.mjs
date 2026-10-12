// Shape checker for the mock fixtures: the response shapes of DESIGN.md section 4, written as specs. An object spec
// lists every key (extra or missing keys fail); opt() marks keys that may be absent (Alert.subject, History.detail).

export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TOK_RE = /^tok_[0-9a-f]{12}$/;

const T = (name, test) => ({ $t: name, test });
export const str = T('string', (v) => typeof v === 'string');
export const num = T('number', (v) => typeof v === 'number' && Number.isFinite(v));
export const int = T('integer', (v) => Number.isInteger(v));
export const bool = T('boolean', (v) => typeof v === 'boolean');
export const iso = T('ISO UTC time', (v) => typeof v === 'string' && ISO_RE.test(v));
export const day = T('YYYY-MM-DD', (v) => typeof v === 'string' && DAY_RE.test(v));
export const tok = T('token id', (v) => typeof v === 'string' && TOK_RE.test(v));
export const any = T('any', () => true);
export const enumOf = (...vals) => T(`one of ${vals.join('|')}`, (v) => vals.includes(v));
export const nul = (spec) => ({ $null: spec });
export const arr = (spec, { min, max, len } = {}) => ({ $arr: spec, min, max, len });
export const rec = (spec) => ({ $rec: spec });
export const opt = (spec) => ({ $opt: spec });
export const oneOf = (...specs) => ({ $one: specs });

/** Returns a list of `path: problem` strings (empty when the value fits). */
export function check(value, spec, at = '$') {
  const out = [];
  const walk = (v, s, p) => {
    if (s.$opt) return walk(v, s.$opt, p);
    if (s.$null) {
      if (v === null) return;
      walk(v, s.$null, p);
      return;
    }
    if (s.$t) {
      if (!s.test(v)) out.push(`${p}: expected ${s.$t}, got ${JSON.stringify(v)?.slice(0, 60)}`);
      return;
    }
    if (s.$one) {
      const fits = s.$one.some((x) => check(v, x, p).length === 0);
      if (!fits) out.push(`${p}: fits none of the alternatives (${check(v, s.$one[0], p)[0] || ''})`);
      return;
    }
    if (s.$arr) {
      if (!Array.isArray(v)) {
        out.push(`${p}: expected array`);
        return;
      }
      if (s.len != null && v.length !== s.len) out.push(`${p}: expected ${s.len} items, got ${v.length}`);
      if (s.min != null && v.length < s.min) out.push(`${p}: expected at least ${s.min} items`);
      if (s.max != null && v.length > s.max) out.push(`${p}: expected at most ${s.max} items, got ${v.length}`);
      v.forEach((x, i) => walk(x, s.$arr, `${p}[${i}]`));
      return;
    }
    if (s.$rec) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        out.push(`${p}: expected object`);
        return;
      }
      for (const [k, x] of Object.entries(v)) walk(x, s.$rec, `${p}.${k}`);
      return;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      out.push(`${p}: expected object, got ${JSON.stringify(v)?.slice(0, 60)}`);
      return;
    }
    for (const k of Object.keys(v)) if (!(k in s)) out.push(`${p}.${k}: unexpected key`);
    for (const [k, x] of Object.entries(s)) {
      if (!(k in v)) {
        if (!x.$opt) out.push(`${p}.${k}: missing`);
        continue;
      }
      walk(v[k], x, `${p}.${k}`);
    }
  };
  walk(value, spec, at);
  return out;
}

// ---------------------------------------------------------------- section 4.2 shared objects

const SEVERITY = enumOf('critical', 'warning', 'info');
const AREA = enumOf('servidor', 'licencas', 'uso', 'agentes', 'vps', 'backup', 'tls', 'seguranca', 'coletor', 'painel');
const VIEW = enumOf('visao', 'licencas', 'uso', 'agentes', 'vps', 'eventos');

export const Alert = {
  id: str, rule: str, severity: SEVERITY, area: AREA, title: str, detail: nul(str), since: iso, lastSeen: iso,
  subject: { token: opt(tok), customer: opt(str), container: opt(str), mount: opt(str), ip: opt(str), machine: opt(str) },
  view: VIEW, event: bool, acked: bool, ackedUntil: nul(iso),
};

export const Event = {
  seq: int, time: iso, level: enumOf('info', 'warning', 'error'),
  group: enumOf('sessao', 'agente', 'chamada', 'licenca', 'servidor', 'vps', 'painel'),
  token: nul(tok), customer: nul(str), text: str, code: nul(str),
};

const LANES = arr(enumOf('odc', 'o11'), { min: 1, max: 2 });

export const History = {
  time: iso,
  action: enumOf('issue', 'renew', 'lanes', 'agent-rotate', 'revoke', 'key-rotate', 'alert-ack', 'alert-unack',
    'unrevoke', 'removed', 'expiry-shortened', 'rename'),
  actor: enumOf('painel', 'externo'), token: nul(tok), customer: nul(str), result: enumOf('ok', 'error'), code: nul(str),
  detail: {
    days: opt(nul(int)), expiresAt: opt(nul(iso)), previousExpiresAt: opt(nul(iso)), lanes: opt(LANES), previousLanes: opt(LANES),
    alert: opt(str), hours: opt(nul(int)),
    previousRevokedAt: opt(iso), previousState: opt(enumOf('active', 'expired', 'revoked')), previousCustomer: opt(nul(str)),
  },
};

const ACTION = { allowed: bool, reason: nul(str) };

export const License = {
  id: tok, customer: str, state: enumOf('active', 'expired', 'revoked'), createdAt: iso, expiresAt: nul(iso), revokedAt: nul(iso),
  daysLeft: nul(num), lanes: LANES, agentCredentialIssuedAt: nul(iso),
  machine: nul({ id: str, name: str, user: str, at: iso }), accessAlerts: int,
  agent: { state: enumOf('connected', 'disconnected', 'never'), since: nul(iso), lastSignalAt: nul(iso), version: nul(str), closedReason: nul(str) },
  sessionsOpen: int, today: { calls: int, failures: int }, daily14: arr(int, { len: 14 }),
  lastActivity: nul({ at: iso, tool: nul(str), kind: enumOf('call', 'session', 'agent') }),
  workspace: nul({ bytes: int, files: int, truncated: bool, measuredAt: iso, quotaBytes: enumOf(5368709120) }),
  actions: { renew: ACTION, lanes: ACTION, agentRotate: ACTION, revoke: ACTION },
  history: arr(History, { max: 5 }),
};

const CAPS = { issue: bool, revoke: bool, agentRotate: bool, renew: bool, lanes: bool, readOnly: nul(enumOf('sem-trava', 'desligado')) };
const INDEXING = { state: enumOf('ready', 'running'), progress: num, detail: nul(str) };

// ---------------------------------------------------------------- section 4.3 endpoints

export const Meta = {
  ok: enumOf(true), console: { version: str, startedAt: iso }, now: iso, timeZone: enumOf('America/Sao_Paulo'), publicHost: str,
  publicUrl: str, serverUrl: str, capabilities: CAPS, indexing: INDEXING,
};

const SUMMARY_FACTS = {
  servidor: { since: nul(iso), pid: nul(int), imageTag: nul(str), warm: str, health: nul(str), probeMs: nul(num) },
  licencas: { active: int, expired: int, revoked: int, nextExpiry: nul({ customer: str, token: tok, expiresAt: iso }) },
  uso: { calls: int, failures: int, p90Ms: nul(num), customersActive: int },
  agentes: { connected: int, activeLicenses: int, lastSignalAt: nul(iso) },
  sessoes: { open: int, top: arr({ customer: str, client: nul(str) }, { max: 3 }) },
  vps: { cpuPct: nul(num), memUsedPct: nul(num), diskUsedPct: nul(num), rebootRequired: nul(bool), rebootSince: nul(iso) },
  containers: { running: nul(int), total: nul(int), unhealthy: arr(str), restarts24h: nul(int) },
  backup: { newestAt: nul(iso), ageH: nul(num), cron: nul(oneOf(bool, { backup: bool, rotate: bool })) },
  tls: oneOf({}, { name: str, notAfter: iso, daysLeft: num }),
  coletor: { collectedAt: nul(iso), ageS: nul(num), sectionErrors: oneOf(int, arr(str)) },
};
export const SUMMARY_ORDER = ['servidor', 'licencas', 'uso', 'agentes', 'sessoes', 'vps', 'containers', 'backup', 'tls', 'coletor'];

export function summaryRowsProblems(rows) {
  const out = [];
  if (!Array.isArray(rows)) return ['summary: expected array'];
  const areas = rows.map((r) => r.area);
  if (JSON.stringify(areas) !== JSON.stringify(SUMMARY_ORDER)) out.push(`summary: areas ${areas.join(',')}`);
  rows.forEach((r, i) => {
    out.push(...check(r, {
      area: str, state: enumOf('ok', 'warning', 'critical', 'unknown'), facts: SUMMARY_FACTS[r.area] || any, view: VIEW,
    }, `summary[${i}]`));
  });
  return out;
}

export const Overview = {
  ok: enumOf(true), now: iso,
  status: {
    server: {
      state: enumOf('up', 'down', 'starting', 'unknown'), since: nul(iso), pid: nul(int), imageTag: nul(str),
      health: nul(enumOf('healthy', 'unhealthy', 'starting')), warm: enumOf('warm', 'partial', 'warming', 'cold', 'unknown'), warmDetail: nul(str),
    },
    sessionsOpen: int, agentsConnected: int, licenses: { active: int, expired: int, revoked: int },
    alerts: { critical: int, warning: int, info: int, acked: int },
    collector: { state: enumOf('fresh', 'stale', 'missing', 'invalid'), collectedAt: nul(iso), ageS: nul(num) },
    host: nul({ cpuPct: num, memUsedPct: num, diskUsedPct: num }), publicHost: nul(str),
  },
  alerts: arr(Alert), acked: arr(Alert), summary: any, recentEvents: arr(Event, { max: 10 }), indexing: INDEXING,
};

export const Licenses = { ok: enumOf(true), now: iso, capabilities: CAPS, licenses: arr(License) };

const Q = nul(num);
export const Usage = {
  ok: enumOf(true),
  range: { kind: enumOf('today', '7d', '30d', 'day'), from: day, to: day, days: int, timeZone: enumOf('America/Sao_Paulo') },
  indexing: INDEXING,
  totals: { calls: int, failures: int, p50Ms: Q, p90Ms: Q, maxMs: Q, customersActive: int, sessionsOpened: int, agentCalls: int, agentFailures: int },
  byCustomer: arr({
    token: tok, customer: str, calls: int, failures: int, p50Ms: Q, p90Ms: Q, topTool: nul(str), sessionsOpened: int,
    agentCalls: int, agentFailures: int, lastAt: nul(iso), workspaceBytes: nul(int), daily: arr(int),
  }),
  byTool: arr({ tool: str, calls: int, failures: int, p50Ms: Q, p90Ms: Q, maxMs: Q, customers: int, topCode: nul(str) }),
  byCode: arr({ code: str, count: int, tools: arr({ tool: str, count: int }, { max: 3 }), customers: int, lastAt: nul(iso) }),
  byDay: arr({ day, calls: int, failures: int, p50Ms: Q, p90Ms: Q, customers: int }),
  denied: {
    available: bool, since: nul(iso), byStatus: rec(int),
    rows: arr({ ip: str, status: enumOf(401, 403, 429), path: str, count: int, lastAt: iso }, { max: 50 }),
  },
};

export const Live = {
  ok: enumOf(true), now: iso,
  server: nul({ since: iso, pid: int, mode: str, ratePerMinute: int, maxSessionsPerToken: int, publicHosts: arr(str) }),
  sessions: arr({
    session: T('8 chars', (v) => typeof v === 'string' && v.length === 8), token: tok, customer: str, client: nul(str), ip: str, ua: str,
    openedAt: iso, lastAt: iso, calls: int, lastTool: nul(str), bytes: int,
  }),
  agents: arr({
    token: tok, customer: str, state: enumOf('connected', 'disconnected'), since: nul(iso), lastSignalAt: nul(iso), version: nul(str),
    pack: nul({ id: str, odcBridge: str, o11BuiltFor: str }), studioO11: nul({ version: str, port: int, pid: int }), ip: nul(str),
    machine: nul({ name: str, user: str }), calls1h: int, failures1h: int, lastCode: nul(str), closedReason: nul(str), closedAt: nul(iso),
  }),
  workers: {
    available: bool,
    rows: arr({
      kind: enumOf('server', 'odc-worker', 'o11-worker', 'builder', 'other'), token: nul(tok), customer: nul(str), port: nul(int),
      rssB: int, cpuPct: num, elapsedS: int,
    }),
  },
  closedToday: arr({
    reason: enumOf('client-delete', 'transport-closed', 'idle', 'replaced', 'token-revoked', 'token-expired', 'token-unknown', 'server-stop'),
    count: int,
  }),
};

// host.json sections (DESIGN.md 3.6) as the VPS view receives them
const SECTION_FAIL = { ok: enumOf(false), error: str, at: iso };
const section = (spec) => oneOf({ ok: enumOf(true), at: iso, ...spec }, SECTION_FAIL);
export const HostSection = section({
  hostname: str, os: str, kernel: str, nproc: int, uptimeS: int, bootAt: iso, load: arr(num, { len: 3 }),
  cpu: { pct: nul(num), iowaitPct: nul(num), stealPct: nul(num), windowS: int },
  mem: { totalB: int, availableB: int, swapTotalB: int, swapUsedB: int },
  psi: { cpuSome10: num, memSome10: num, ioSome10: num },
  disks: arr({ mount: str, fs: str, sizeB: int, usedB: int, availB: int, usedPct: num, inodesPct: num }, { min: 1 }),
  net: { iface: str, rxB: int, txB: int, rxBps: nul(num), txBps: nul(num) },
  time: { ntpSynced: bool, tz: str }, failedUnits: int,
});
export const UpdatesSection = section({
  upgradable: int, security: int, packages: arr(str, { max: 40 }), rebootRequired: bool, rebootSince: nul(iso), rebootPkgs: arr(str),
  unattended: { enabled: bool, lastRunAt: nul(iso), lastSuccessAt: nul(iso) },
});
export const SecuritySection = section({
  ufw: { active: bool, defaultIncoming: str, defaultOutgoing: str, defaultRouted: str, allowIn: arr(str), rules: arr(str, { max: 30 }) },
  ssh: { passwordAuth: bool, permitRootLogin: str, port: opt(nul(int)), fail2ban: str, failures24h: int, topSources: arr({ ip: str, count: int }, { max: 5 }) },
});
export const BackupsSection = section({
  dir: str, exists: bool, count: int, totalB: int,
  newest: nul({ name: str, sizeB: int, mtime: iso, sha256File: bool, infoFile: bool, image: nul(str), revision: nul(str), mode: nul(str), ageH: num }),
  cron: { backup: bool, rotate: bool }, cronLogTail: arr(str, { max: 10 }),
});
const KERNEL = { o11: nul(str), odc: nul(str), odcBridge: nul(str), o11Hook: nul(str), odcBridgeAccepted: arr(str) };
export const Container = {
  name: str, service: str, project: str, image: str, imageId: str, state: str, health: nul(enumOf('healthy', 'unhealthy', 'starting')),
  failingStreak: int, lastHealth: arr({ at: iso, exit: int }, { max: 5 }), startedAt: iso, restartCount: int, oomKilled: bool,
  restartPolicy: str, cpuPct: num, memB: int, memLimitB: int, netRxB: int, netTxB: int, blkReadB: int, blkWriteB: int, pids: int,
  sinceS: nul(int),
};
const SERIES_POINT = { t: iso, cpuPct: Q, memUsedPct: Q, load1: Q, rxBps: Q, txBps: Q, srvCpuPct: Q, srvMemB: Q };
export const Vps = {
  ok: enumOf(true), now: iso,
  collector: { state: enumOf('fresh', 'stale', 'missing', 'invalid'), collectedAt: nul(iso), ageS: nul(num), durationMs: nul(int), errors: arr(str), version: nul(str) },
  host: nul(HostSection), updates: nul(UpdatesSection), security: nul(SecuritySection),
  tls: nul({ certs: arr({ name: str, notBefore: iso, notAfter: iso, daysLeft: num, issuer: str }) }),
  backups: nul(BackupsSection), containers: nul(arr(Container)), volumes: nul(arr({ name: str, sizeB: int })),
  systemDf: nul({ imagesB: int, imagesReclaimableB: int, volumesB: int, buildCacheB: int }),
  server: {
    health: nul({
      docker: nul(enumOf('healthy', 'unhealthy', 'starting')),
      probe: { available: bool, ok: bool, pid: nul(int), ms: nul(num), error: nul(str) },
    }),
    image: nul({ tag: str, version: nul(str), revision: nul(str), created: nul(iso) }),
    kernel: { running: nul(KERNEL), file: nul(KERNEL), drift: bool, driftFields: arr(str) },
    warm: nul({
      state: enumOf('warm', 'partial', 'warming', 'cold', 'unknown'), time: nul(iso),
      indexes: nul({ ok: bool, lanes: rec({ ok: bool, cache: str, ms: int }) }),
      delivery: nul({ builder: nul({ ok: bool, pid: nul(int) }), worker: nul({ ok: bool, note: nul(str) }) }),
      ms: nul(int), workerRunning: bool,
    }),
    logs: { serverLogB: int, rotatedCount: int, rotatedB: int, auditFiles: int, auditB: int, qualityFiles: int, qualityB: int, consoleAuditB: int },
  },
  coolify: nul(arr({ name: str, state: str, restartPolicy: str })),
  series: nul({ stepS: enumOf(900), points: arr(SERIES_POINT, { len: 96 }) }),
};

// /api/quality (DESIGN-QUALIDADE 4.4); token only in a one-license answer
const Q2 = { p50: nul(num), p90: nul(num) };
const QPHASES = ['queue', 'capture', 'compile', 'studio', 'verify', 'publish', 'environment', 'transfer', 'rest'];
const CODE_RE = /^[A-Z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;
const code = T('code', (v) => typeof v === 'string' && CODE_RE.test(v) && v.length <= 64);
const toolName = T('tool', (v) => typeof v === 'string' && (v === '?' || /^[a-z][a-z0-9_]{0,63}$/.test(v)));
const QTOOLS3 = arr({ tool: toolName, count: int }, { max: 3 });
export const Quality = {
  ok: enumOf(true), now: iso,
  range: { kind: enumOf('today', '7d', '30d', 'day'), from: day, to: day, days: int, timeZone: enumOf('America/Sao_Paulo') },
  indexing: INDEXING, available: bool, firstDay: nul(day), token: opt(tok),
  totals: {
    calls: int, failures: int, refusals: int, delivered: int, uncertain: int, problems: int, withPatch: int,
    problemPhases: rec(int), normalizations: int, normalizedCalls: int, sharedCalls: int, chains: int, chainsOpen: int,
    turnsPerChainP50: nul(int), turnsPerChainP90: nul(int), callsPerChainP50: nul(int), callsPerChainP90: nul(int),
    refusalsBeforeP50: nul(int), refusalsBeforeMax: nul(int), wallP50Ms: nul(num), wallP90Ms: nul(num), idlePct: nul(num),
    gapP50Ms: nul(num), gapP90Ms: nul(num), gaps: int, longGaps: int,
  },
  errors: arr({ code, count: int, pctOfFailures: nul(num), tools: QTOOLS3, customers: int, lastAt: nul(iso) }),
  problems: arr({ code, count: int, refusals: int, withPatch: int, tools: QTOOLS3, customers: int }),
  rules: arr({ rule: code, count: int, calls: int, tools: QTOOLS3, customers: int }),
  phases: arr({ tool: toolName, calls: int, shared: int, total: Q2, ...Object.fromEntries(QPHASES.map((c) => [c, Q2])), transferBytesAvg: nul(int), kernelRuns: int, kernelCold: int }),
  timeShare: arr({ tool: toolName, sumMs: int, ...Object.fromEntries(QPHASES.map((c) => [`${c}Pct`, nul(num)])) }),
  rounds: arr({
    token: tok, customer: str, chains: int, open: int, turnsP50: nul(int), turnsP90: nul(int), callsP50: nul(int), callsP90: nul(int),
    refusalsBeforeP50: nul(int), refusalsBeforeMax: nul(int), wallP50Ms: nul(num), wallP90Ms: nul(num), gapP50Ms: nul(num), gapP90Ms: nul(num), idlePct: nul(num),
  }),
  causes: arr({ code, refusals: int, chains: int, extraCallsSum: int, extraCallsP50: nul(int), extraMsP50: nul(num) }),
  byCustomer: arr({
    token: tok, customer: str, calls: int, failures: int, refusals: int, delivered: int, topError: nul(code), topProblem: nul(code), topRule: nul(code),
    slowestPhase: nul(enumOf(...QPHASES)),
  }),
  byClient: arr({
    client: enumOf('claude-code', 'claude-ai', 'claude-desktop', 'codex', 'cursor', 'vscode', 'windsurf', 'other', 'unknown'),
    sessions: int, chains: int, turnsP50: nul(int), callsP50: nul(int), refusalsBeforeAvg: nul(num), gapP50Ms: nul(num),
  }),
};

export const Events = { ok: enumOf(true), lastSeq: int, events: arr(Event) };
export const HistoryResponse = { ok: enumOf(true), entries: arr(History) };

const AUDIT = { written: bool };
export const IssueAnswer = {
  ok: enumOf(true), license: License, secret: { token: str, agentCredential: str }, publicUrl: str, serverUrl: str,
  duplicates: arr(tok), audit: AUDIT,
};
export const RenewAnswer = { ok: enumOf(true), license: License, previousExpiresAt: nul(iso), expiresAt: iso, audit: AUDIT };
export const LanesAnswer = { ok: enumOf(true), license: License, previousLanes: LANES, openSessions: int, audit: AUDIT };
export const RotateAnswer = { ok: enumOf(true), license: License, secret: { agentCredential: str }, serverUrl: str, audit: AUDIT };
export const RevokeAnswer = { ok: enumOf(true), license: License, openSessions: int, agentConnected: bool, audit: AUDIT };
export const ErrorAnswer = { ok: enumOf(false), error: { code: str, message: str, field: opt(str) } };
