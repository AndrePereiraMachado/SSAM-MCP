// Shape checker of the API contract (DESIGN 4.2, 4.3): every endpoint's JSON is checked key by key. Objects are closed
// (a missing or an extra key is an error) unless wrapped in open(); arrays check every element.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const nullable = s => ({ $nullable: s });
export const oneOf = (...values) => ({ $enum: values });
export const arrayOf = (s, length = null) => ({ $array: s, length });
export const open = (obj = {}) => ({ $open: obj });
export const literal = v => ({ $literal: v });

export function check(value, schema, at = '$', errors = []) {
  const err = msg => errors.push(`${at}: ${msg}`);
  if (schema && typeof schema === 'object' && '$nullable' in schema) { if (value !== null) check(value, schema.$nullable, at, errors); return errors; }
  if (schema && typeof schema === 'object' && '$enum' in schema) { if (!schema.$enum.includes(value)) err(`${JSON.stringify(value)} not in ${schema.$enum.join('|')}`); return errors; }
  if (schema && typeof schema === 'object' && '$literal' in schema) { if (value !== schema.$literal) err(`expected ${JSON.stringify(schema.$literal)}`); return errors; }
  if (schema && typeof schema === 'object' && '$array' in schema) {
    if (!Array.isArray(value)) { err('expected array'); return errors; }
    if (schema.length != null && value.length !== schema.length) err(`expected ${schema.length} elements, got ${value.length}`);
    value.forEach((v, i) => check(v, schema.$array, `${at}[${i}]`, errors));
    return errors;
  }
  if (typeof schema === 'string') {
    const ok = {
      string: () => typeof value === 'string', number: () => typeof value === 'number' && Number.isFinite(value),
      int: () => Number.isInteger(value), boolean: () => typeof value === 'boolean', iso: () => typeof value === 'string' && ISO.test(value),
      day: () => typeof value === 'string' && DAY.test(value), object: () => !!value && typeof value === 'object' && !Array.isArray(value), any: () => true,
    }[schema];
    if (!ok) throw new Error('unknown schema ' + schema);
    if (!ok()) err(`expected ${schema}, got ${JSON.stringify(value)?.slice(0, 80)}`);
    return errors;
  }
  const isOpen = schema && typeof schema === 'object' && '$open' in schema;
  const fields = isOpen ? schema.$open : schema;
  if (!value || typeof value !== 'object' || Array.isArray(value)) { err('expected object'); return errors; }
  for (const [k, s] of Object.entries(fields)) {
    if (!(k in value)) err(`missing key ${k}`);
    else check(value[k], s, `${at}.${k}`, errors);
  }
  if (!isOpen) for (const k of Object.keys(value)) if (!(k in fields)) err(`unexpected key ${k}`);
  return errors;
}
export function assertShape(assert, value, schema, label = '') {
  const errors = check(value, schema);
  assert.deepEqual(errors, [], `${label} shape errors:\n${errors.slice(0, 20).join('\n')}`);
}

const S = 'string', N = 'number', I = 'int', B = 'boolean', T = 'iso';
const nS = nullable(S), nN = nullable(N), nI = nullable(I), nT = nullable(T);
const lane = oneOf('odc', 'o11');
const ok = literal(true);

export const Event = { seq: I, time: T, level: oneOf('info', 'warning', 'error'), group: oneOf('sessao', 'agente', 'chamada', 'licenca', 'servidor', 'vps', 'painel'),
  token: nS, customer: nS, text: S, code: nS };
export const History = { time: T, action: oneOf('issue', 'renew', 'lanes', 'agent-rotate', 'revoke', 'key-rotate', 'alert-ack', 'alert-unack'),
  actor: oneOf('painel', 'externo'), token: nS, customer: nS, result: oneOf('ok', 'error'), code: nS, detail: 'object' };
export const Alert = { id: S, rule: S, severity: oneOf('critical', 'warning', 'info'),
  area: oneOf('servidor', 'licencas', 'uso', 'agentes', 'vps', 'backup', 'tls', 'seguranca', 'coletor', 'painel'), title: S, detail: nS, since: T, lastSeen: T,
  subject: 'object', view: oneOf('visao', 'licencas', 'uso', 'agentes', 'vps', 'eventos'), event: B, acked: B, ackedUntil: nT };
const Action = { allowed: B, reason: nS };
export const License = { id: S, customer: S, state: oneOf('active', 'expired', 'revoked'), createdAt: T, expiresAt: nT, revokedAt: nT, daysLeft: nN,
  lanes: arrayOf(lane), agentCredentialIssuedAt: nT, machine: nullable({ id: nS, name: nS, user: nS, at: nT }), accessAlerts: I,
  agent: { state: oneOf('connected', 'disconnected', 'never'), since: nT, lastSignalAt: nT, version: nS, closedReason: nS },
  sessionsOpen: I, today: { calls: I, failures: I }, daily14: arrayOf(I, 14),
  lastActivity: nullable({ at: T, tool: nS, kind: oneOf('call', 'session', 'agent') }),
  workspace: nullable({ bytes: I, files: I, truncated: B, measuredAt: nT, quotaBytes: literal(5368709120) }),
  actions: { renew: Action, lanes: Action, agentRotate: Action, revoke: Action }, history: arrayOf(History) };
export const Indexing = { state: oneOf('ready', 'running'), progress: N, detail: nS };
const Capabilities = { issue: B, revoke: B, agentRotate: B, renew: B, lanes: B };
export const Meta = { ok, console: { version: S, startedAt: T }, now: T, timeZone: S, publicHost: nS, publicUrl: nS, serverUrl: nS,
  capabilities: Capabilities, indexing: Indexing };
const Status = {
  server: { state: oneOf('up', 'down', 'starting', 'unknown'), since: nT, pid: nI, imageTag: nS, health: nullable(oneOf('healthy', 'unhealthy', 'starting')),
    warm: oneOf('warm', 'partial', 'warming', 'cold', 'unknown'), warmDetail: nS },
  sessionsOpen: I, agentsConnected: I, licenses: { active: I, expired: I, revoked: I }, alerts: { critical: I, warning: I, info: I, acked: I },
  collector: { state: oneOf('fresh', 'stale', 'missing', 'invalid'), collectedAt: nT, ageS: nI },
  host: nullable({ cpuPct: nN, memUsedPct: nN, diskUsedPct: nN }), publicHost: nS,
};
export const SUMMARY_FACTS = {
  servidor: { since: nT, pid: nI, imageTag: nS, warm: S, health: nS, probeMs: nN },
  licencas: { active: I, expired: I, revoked: I, nextExpiry: nullable({ customer: S, token: S, expiresAt: T }) },
  uso: { calls: I, failures: I, p90Ms: nN, customersActive: I },
  agentes: { connected: I, activeLicenses: I, lastSignalAt: nT },
  sessoes: { open: I, top: arrayOf({ customer: S, client: nS }) },
  vps: { cpuPct: nN, memUsedPct: nN, diskUsedPct: nN, rebootRequired: nullable(B), rebootSince: nT },
  containers: { running: nI, total: nI, unhealthy: arrayOf(S), restarts24h: nI },
  backup: { newestAt: nT, ageH: nN, cron: nullable({ backup: B, rotate: B }) },
  tls: open({}),
  coletor: { collectedAt: nT, ageS: nI, sectionErrors: I },
};
export const SummaryRow = { area: S, state: oneOf('ok', 'warning', 'critical', 'unknown'), facts: 'object', view: S };
export const Overview = { ok, now: T, status: Status, alerts: arrayOf(Alert), acked: arrayOf(Alert), summary: arrayOf(SummaryRow, 10), recentEvents: arrayOf(Event), indexing: Indexing };
export const Licenses = { ok, now: T, capabilities: Capabilities, licenses: arrayOf(License) };
export const Usage = { ok, range: { kind: oneOf('today', '7d', '30d', 'day'), from: 'day', to: 'day', days: I, timeZone: S }, indexing: Indexing,
  totals: { calls: I, failures: I, p50Ms: nN, p90Ms: nN, maxMs: nN, customersActive: I, sessionsOpened: I, agentCalls: I, agentFailures: I },
  byCustomer: arrayOf({ token: S, customer: S, calls: I, failures: I, p50Ms: nN, p90Ms: nN, topTool: nS, sessionsOpened: I, agentCalls: I, agentFailures: I,
    lastAt: nT, workspaceBytes: nI, daily: arrayOf(I) }),
  byTool: arrayOf({ tool: S, calls: I, failures: I, p50Ms: nN, p90Ms: nN, maxMs: N, customers: I, topCode: nS }),
  byCode: arrayOf({ code: S, count: I, tools: arrayOf({ tool: S, count: I }), customers: I, lastAt: nT }),
  byDay: arrayOf({ day: 'day', calls: I, failures: I, p50Ms: nN, p90Ms: nN, customers: I }),
  denied: { available: B, since: nT, byStatus: 'object', rows: arrayOf({ ip: S, status: I, path: S, count: I, lastAt: nT }) } };
export const Live = { ok, now: T,
  server: nullable({ since: T, pid: nI, mode: nS, ratePerMinute: nI, maxSessionsPerToken: nI, publicHosts: arrayOf(S) }),
  sessions: arrayOf({ session: S, token: S, customer: nS, client: nS, ip: nS, ua: nS, openedAt: T, lastAt: T, calls: I, lastTool: nS, bytes: I }),
  agents: arrayOf({ token: S, customer: nS, state: oneOf('connected', 'disconnected'), since: nT, lastSignalAt: nT, version: nS,
    pack: nullable({ id: nS, odcBridge: nS, o11BuiltFor: nS }), studioO11: nullable({ version: nS, port: nI, pid: nI }), ip: nS,
    machine: nullable({ name: nS, user: nS }), calls1h: I, failures1h: I, lastCode: nS, closedReason: nS, closedAt: nT }),
  workers: { available: B, rows: arrayOf({ kind: S, token: nS, customer: nS, port: nI, rssB: nI, cpuPct: nN, elapsedS: nI }) },
  closedToday: arrayOf({ reason: S, count: I }) };
const Point = { t: T, cpuPct: nN, memUsedPct: nN, load1: nN, rxBps: nN, txBps: nN, srvCpuPct: nN, srvMemB: nN };
export const Vps = { ok, now: T,
  collector: { state: oneOf('fresh', 'stale', 'missing', 'invalid'), collectedAt: nT, ageS: nI, durationMs: nN, errors: arrayOf(S), version: nS },
  host: nullable(open({ ok: B })), updates: nullable(open({ ok: B })), security: nullable(open({ ok: B })),
  tls: nullable({ certs: arrayOf({ name: nS, notBefore: nT, notAfter: nT, daysLeft: nN, issuer: nS }) }),
  backups: nullable(open({ ok: B, newest: nullable(open({ ageH: N })) })),
  containers: nullable(arrayOf(open({ sinceS: nI }))), volumes: nullable(arrayOf('object')), systemDf: nullable('object'),
  server: { health: nullable({ docker: nS, probe: nullable('object') }), image: nullable('object'),
    kernel: { running: nullable('object'), file: nullable('object'), drift: B, driftFields: arrayOf(S) },
    warm: nullable({ state: oneOf('warm', 'partial', 'warming', 'cold', 'unknown'), time: nT, indexes: nullable('object'), delivery: nullable('object'), ms: nN, workerRunning: nullable(B) }),
    logs: { serverLogB: I, rotatedCount: I, rotatedB: I, auditFiles: I, auditB: I, consoleAuditB: I } },
  coolify: nullable(arrayOf({ name: nS, state: nS, restartPolicy: nS })),
  series: nullable({ stepS: literal(900), points: arrayOf(Point, 96) }) };
export const Events = { ok, lastSeq: I, events: arrayOf(Event) };
export const HistoryList = { ok, entries: arrayOf(History) };
const Audit = { written: B };
export const IssueAnswer = { ok, license: License, secret: { token: S, agentCredential: S }, publicUrl: nS, serverUrl: nS, duplicates: arrayOf(S), audit: Audit };
export const RenewAnswer = { ok, license: License, previousExpiresAt: nT, expiresAt: nT, audit: Audit };
export const LanesAnswer = { ok, license: License, previousLanes: arrayOf(lane), openSessions: I, audit: Audit };
export const RotateAnswer = { ok, license: License, secret: { agentCredential: S }, serverUrl: nS, audit: Audit };
export const RevokeAnswer = { ok, license: License, openSessions: I, agentConnected: B, audit: Audit };
export const AckAnswer = { ok, id: S, until: nT };
export const UnackAnswer = { ok, id: S };
export const KeyAnswer = { ok, key: S };
export const ErrorAnswer = { ok: literal(false), error: open({ code: S, message: S }) };
