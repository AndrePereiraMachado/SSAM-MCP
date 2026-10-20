// Licenses through the image's token module (DESIGN 1.2, 2.4, 3.5, 4.1, D6). The console never reads or writes tokens.json
// itself: it imports CONSOLE_TOKEN_MODULE, calls list() (public view, no hashes) and the verbs issue, agentRotate, revoke
// and, when the module has them, renew and setLanes (capabilities by feature detection). Mutations run one at a time
// (the caller's gate: rate limit + queue); each one is recorded in console-audit.jsonl after the store call returns or
// throws. Every 5 s the public view is diffed against /state/tokens-snapshot.json: a change the console did not make
// becomes a history line with actor "externo" (a revocation undone, a record gone and a write that did not hold also
// become notices, kept 30 days in /state/license-notices.json, that the alert rules turn into event alerts).
//
// Writers (review fix, DEPLOY.md 15.4): the module of prod-20261011-ed0f94b has no lock between writers, so an ssam-admin
// writing at the same instant can drop a console change, or the console can drop the CLI's, or a torn tokens.json is
// published. The 24th image's module brings tokens.json.lock together with renew and setLanes. CONSOLE_LICENSE_WRITES:
// auto (default) writes only with a module that has renew and setLanes; on writes with any module; off never writes.
// Whatever the mode, every write is read back through a fresh store: when the change is not in the file (or the file
// does not parse) the answer is WRITE_NOT_CONFIRMED, with a history line and a critical alert, and no secret is shown.
// Backends (the image with the Postgres store, COOLIFY.md 6 and 11): the module's openTokenStore picks tokens.json or,
// with SSAM_DATABASE_URL (config.databaseUrl), Postgres. The Postgres store's writers return promises and its readers
// answer over a snapshot, so every verb is awaited here (the file store's values pass through await unchanged) and the
// read-back goes through store.refresh() + list() (the table read again) instead of a fresh file store. A database that
// cannot be reached at start leaves the console read-only (every capability off, STORE_UNREADABLE), and the store is
// opened again on the polls (reconnect, at most once every 30 s) until it answers. An older module without
// openTokenStore (the 23rd and 24th images) keeps createTokenStore(dir).
import { pathToFileURL } from 'node:url';
import { ApiError, invalidField, licenseText } from './texts.mjs';

export const TOKEN_ID = /^tok_[0-9a-f]{12}$/;
export const CUSTOMER_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
export const CUSTOMER_RULE = '1 a 64 caracteres: letras, números, espaço, ponto, hífen ou sublinhado';
export const DAYS_RULE = 'inteiro de 1 a 3650';
export const LANES_RULE = '"odc", "o11" ou os dois, sem repetir';
const LANES = ['odc', 'o11'];
const FS_CODES = new Set(['EACCES', 'ENOSPC', 'EROFS', 'EIO', 'EPERM', 'EBUSY', 'EDQUOT', 'EMFILE']);
const SNAPSHOT = 'tokens-snapshot.json';
const NOTICES = 'license-notices.json';
export const NOTICE_DAYS = 30;
const NOTICE_MAX = 200;
const DAY = 86400000;

export const lanesKey = lanes => LANES.filter(l => Array.isArray(lanes) && lanes.includes(l)).join(',');
const sameTime = (a, b) => (a == null || b == null ? a == null && b == null : Date.parse(a) === Date.parse(b));

// Token module error -> API error: error.code first (the 24th image sets one), else the message, per verb (4.1).
export function mapStoreError(verb, error, id = null) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const message = String(error?.message ?? '');
  const fsFailure = c => (verb === 'list' ? new ApiError('STORE_UNREADABLE', { código: c }) : new ApiError('STORE_WRITE_FAILED', { código: c }));
  switch (code) {
    case 'UNKNOWN_TOKEN': return new ApiError('UNKNOWN_TOKEN', { id });
    case 'TOKEN_REVOKED': case 'TOKEN_NOT_ACTIVE': case 'NO_EXPIRY': case 'EXPIRY_TOO_FAR': return new ApiError(code);
    case 'INVALID_DAYS': return invalidField('days', DAYS_RULE);
    case 'INVALID_LANES': return invalidField('lanes', LANES_RULE);
    case 'INVALID_CUSTOMER': return invalidField('customer', CUSTOMER_RULE);
    case 'STORE_INVALID': return new ApiError('STORE_UNREADABLE', { código: 'STORE_INVALID' });
    default: if (code && FS_CODES.has(code)) return fsFailure(code);
  }
  if (/^Unknown token id/.test(message)) return new ApiError('UNKNOWN_TOKEN', { id });
  if (verb === 'agentRotate' && /is (expired|revoked)/.test(message)) return new ApiError('TOKEN_NOT_ACTIVE');
  if ((verb === 'renew' || verb === 'setLanes') && /is revoked/.test(message)) return new ApiError('TOKEN_REVOKED');
  if (/^customer:/.test(message)) return invalidField('customer', CUSTOMER_RULE);
  if (/^days:/.test(message)) return invalidField('days', DAYS_RULE);
  if (/^lanes:/.test(message)) return invalidField('lanes', LANES_RULE);
  if (/has no expiry/.test(message)) return new ApiError('NO_EXPIRY');
  if (/at most 3650 days/.test(message)) return new ApiError('EXPIRY_TOO_FAR');
  if (/Invalid tokens file/.test(message)) return new ApiError('STORE_UNREADABLE', { código: 'STORE_INVALID' });
  if (error?.name === 'SyntaxError') return new ApiError('STORE_UNREADABLE', { código: 'PARSE' });
  if (code) return verb === 'list' ? new ApiError('STORE_UNREADABLE', { código: code }) : new ApiError('INTERNAL', { código: code });
  return new ApiError('INTERNAL', { código: String(error?.name ?? 'ERRO').slice(0, 40) });
}

export const RECONNECT_MS = 30000;

export async function createLicenses({ config, state, history, tz, now = Date.now, log = () => {}, emit = () => {}, gate }) {
  let store = null;
  let createStore = null;
  let openStore = null;
  let loadError = null;
  const fn = f => typeof f === 'function';
  const writes = config.licenseWrites ?? 'auto';
  // The capabilities object is shared (views, the listening log line): it is updated in place when the store opens.
  const caps = { issue: false, revoke: false, agentRotate: false, renew: false, lanes: false, readOnly: null };
  function setCaps() {
    const verbs = { issue: fn(store?.issue), revoke: fn(store?.revoke), agentRotate: fn(store?.agentRotate), renew: fn(store?.renew), lanes: fn(store?.setLanes) };
    // renew and setLanes arrived with tokens.json.lock (the 24th image's module): their presence is the sign of the lock.
    // The Postgres store has them too (one transaction under an advisory lock).
    const locked = verbs.renew && verbs.lanes;
    const readOnly = !store ? null : writes === 'off' ? 'desligado' : writes === 'auto' && !locked ? 'sem-trava' : null;
    Object.assign(caps, readOnly ? { issue: false, revoke: false, agentRotate: false, renew: false, lanes: false, readOnly } : { ...verbs, readOnly: null });
    if (readOnly) log({ console: 'license-writes-off', reason: readOnly });
  }
  // The store's own log lines (db-migrated, tokens-store, tokens-store-stale): event and codes only, never the URL.
  const storeLog = line => log({ console: 'token-store', event: String(line?.event ?? 'log').slice(0, 40),
    ...(line?.backend ? { backend: String(line.backend).slice(0, 20) } : {}), ...(line?.version ? { version: String(line.version).slice(0, 10) } : {}),
    ...(line?.code ? { code: String(line.code).slice(0, 40) } : {}) });
  const storeEnv = () => (config.databaseUrl ? { SSAM_DATABASE_URL: config.databaseUrl } : {});
  async function attach() {
    try {
      store = openStore ? await openStore({ dir: config.serverDir, env: storeEnv(), log: storeLog }) : createStore(config.serverDir);
      loadError = null;
    } catch (error) {
      store = null;
      loadError = error;
      log({ console: 'token-module-failed', code: error.code ?? error.name ?? 'IMPORT' });
    }
    setCaps();
  }
  try {
    const mod = await import(pathToFileURL(config.tokenModule).href);
    createStore = mod.createTokenStore;
    openStore = fn(mod.openTokenStore) ? mod.openTokenStore : null;
    await attach();
  } catch (error) {
    loadError = error;
    log({ console: 'token-module-failed', code: error.code ?? error.name ?? 'IMPORT' });
    setCaps();
  }
  const backend = () => store?.backend ?? 'file';
  let reconnecting = null;
  let reconnectAt = 0;
  // A store that could not be opened (the database unreachable at start) is opened again on the polls, at most once
  // every RECONNECT_MS; a module that could not be imported is not retried.
  function reconnect() {
    if (store || !openStore || reconnecting || now() - reconnectAt < RECONNECT_MS) return reconnecting ?? Promise.resolve();
    reconnectAt = now();
    reconnecting = attach().then(() => { if (store) log({ console: 'token-store-reconnected', backend: backend() }); }).finally(() => { reconnecting = null; });
    return reconnecting;
  }
  const names = new Map();
  let listError = null;
  let snapshot = state.readJson(SNAPSHOT);

  // ---- notices: external un-revocations, removed records and writes that did not hold (alert rules, 30 days)
  const noticeOk = n => n && typeof n === 'object' && ['unrevoke', 'removed', 'unconfirmed'].includes(n.kind) && TOKEN_ID.test(String(n.token))
    && typeof n.at === 'string' && !Number.isNaN(Date.parse(n.at));
  let notices = (state.readJson(NOTICES)?.notices ?? []).filter(noticeOk);
  function addNotice(n) {
    const floor = now() - (NOTICE_DAYS + 1) * DAY;
    notices = [...notices.filter(x => Date.parse(x.at) >= floor), { ...n, at: new Date(now()).toISOString() }].slice(-NOTICE_MAX);
    try { state.writeJson(NOTICES, { schema: 'ssam-console-license-notices/1', notices }); } catch { /* kept in memory until the next one */ }
  }

  const stateOf = v => (v.revokedAt ? 'revoked' : v.expiresAt && Date.parse(v.expiresAt) <= now() ? 'expired' : 'active');
  function normalize(v) {
    const view = { id: String(v.id), customer: String(v.customer ?? ''), createdAt: v.createdAt ?? null, expiresAt: v.expiresAt ?? null,
      revokedAt: v.revokedAt ?? null, lanes: LANES.filter(l => Array.isArray(v.lanes) && v.lanes.includes(l)),
      agentIssuedAt: v.agent?.issuedAt ?? null };
    view.state = stateOf(view);
    return view;
  }
  function list() {
    if (!store) { listError = { code: loadError?.code ?? 'MODULE', at: now() }; throw new ApiError('STORE_UNREADABLE', { código: listError.code }); }
    let raw;
    try { raw = store.list(); } catch (error) {
      const message = String(error?.message ?? '');
      const code = error?.code === 'STORE_INVALID' || /Invalid tokens file/.test(message) ? 'STORE_INVALID'
        : error?.name === 'SyntaxError' ? 'PARSE' : String(error?.code ?? error?.name ?? 'ERRO').slice(0, 40);
      listError = { code, at: now() };
      throw mapStoreError('list', error);
    }
    listError = null;
    const tokens = (Array.isArray(raw) ? raw : []).map(normalize);
    for (const t of tokens) names.set(t.id, t.customer);
    return tokens;
  }
  const tryList = () => { try { return { tokens: list(), error: null }; } catch (error) { return { tokens: null, error }; } };
  function find(id) {
    const t = TOKEN_ID.test(String(id)) ? list().find(x => x.id === id) : null;
    if (!t) throw new ApiError('UNKNOWN_TOKEN', { id: String(id).slice(0, 40) });
    return t;
  }

  // ---- history + events + log of one action
  function record({ action, token = null, customer = null, result = 'ok', code = null, detail = {}, actor = 'painel', level = 'info' }) {
    const time = new Date(now()).toISOString();
    const audit = history.append({ time, action, actor, token, customer, result, code, detail });
    emit({ time, level: result === 'error' ? 'error' : level, group: 'licenca', token, customer,
      text: licenseText({ action, customer, result, code, detail, external: actor === 'externo' }, tz.dmy), code });
    if (actor === 'painel') log({ console: 'action', action, token, ok: result === 'ok', ...(code ? { code } : {}) });
    else log({ console: 'external-change', action, token });
    return audit;
  }

  // ---- external changes (3.5)
  const snapOf = tokens => ({ schema: 'ssam-console-tokens-snapshot/1', at: new Date(now()).toISOString(),
    tokens: tokens.map(t => ({ id: t.id, customer: t.customer, createdAt: t.createdAt, expiresAt: t.expiresAt, revokedAt: t.revokedAt, lanes: t.lanes, agentIssuedAt: t.agentIssuedAt })) });
  function saveSnapshot(tokens) { snapshot = snapOf(tokens); try { state.writeJson(SNAPSHOT, snapshot); } catch { /* retried at the next poll */ } }
  function detectExternal() {
    const { tokens } = tryList();
    if (!tokens) return 0;
    if (!snapshot || !Array.isArray(snapshot.tokens)) { saveSnapshot(tokens); return 0; }
    const before = new Map(snapshot.tokens.filter(t => t && typeof t.id === 'string').map(t => [t.id, t]));
    let changes = 0;
    for (const t of tokens) {
      const p = before.get(t.id);
      const base = { token: t.id, customer: t.customer, actor: 'externo' };
      if (!p) { record({ ...base, action: 'issue', detail: { expiresAt: t.expiresAt, lanes: t.lanes } }); changes++; continue; }
      if (String(p.customer ?? '') !== t.customer) { record({ ...base, action: 'rename', detail: { previousCustomer: p.customer ?? null } }); changes++; }
      if (!p.revokedAt && t.revokedAt) { record({ ...base, action: 'revoke' }); changes++; }
      // a revocation undone (restore of an older backup, a hand edit): the token and the agent credential work again
      if (p.revokedAt && !t.revokedAt) {
        record({ ...base, action: 'unrevoke', level: 'error', detail: { previousRevokedAt: p.revokedAt } });
        addNotice({ kind: 'unrevoke', token: t.id, customer: t.customer, previousRevokedAt: p.revokedAt });
        changes++;
      }
      if (!sameTime(p.expiresAt ?? null, t.expiresAt)) {
        const shortened = t.expiresAt != null && (p.expiresAt == null || Date.parse(t.expiresAt) < Date.parse(p.expiresAt));
        record({ ...base, action: shortened ? 'expiry-shortened' : 'renew', level: shortened ? 'warning' : 'info',
          detail: { previousExpiresAt: p.expiresAt ?? null, expiresAt: t.expiresAt } });
        changes++;
      }
      if (lanesKey(p.lanes) !== lanesKey(t.lanes)) { record({ ...base, action: 'lanes', detail: { previousLanes: p.lanes ?? [], lanes: t.lanes } }); changes++; }
      if ((p.agentIssuedAt ?? null) !== (t.agentIssuedAt ?? null)) { record({ ...base, action: 'agent-rotate' }); changes++; }
    }
    // a record gone from the file: its token and agent credential stopped working
    const ids = new Set(tokens.map(t => t.id));
    for (const p of before.values()) {
      if (ids.has(p.id)) continue;
      const customer = String(p.customer ?? '') || null;
      record({ token: p.id, customer, actor: 'externo', action: 'removed', level: 'warning', detail: { previousState: stateOf({ revokedAt: p.revokedAt ?? null, expiresAt: p.expiresAt ?? null }) } });
      if (TOKEN_ID.test(p.id)) addNotice({ kind: 'removed', token: p.id, customer });
      changes++;
    }
    if (changes || JSON.stringify(snapOf(tokens).tokens) !== JSON.stringify(snapshot.tokens)) saveSnapshot(tokens);
    return changes;
  }

  // ---- mutations: pre-checks here, the store call inside the gate (one at a time, re-checked)
  const notSupported = cap => {
    if (caps.readOnly) throw new ApiError(caps.readOnly === 'desligado' ? 'WRITES_OFF' : 'WRITES_UNLOCKED');
    if (!caps[cap]) throw new ApiError('NOT_SUPPORTED');
  };
  const confirmOf = (customer, confirm) => { if (String(confirm ?? '').trim() !== customer) throw new ApiError('CONFIRM_MISMATCH'); };
  // The verb is awaited: the Postgres store answers with a promise, the file store with a value (a synchronous throw of
  // the file store lands in the same catch).
  async function call(verb, action, target, detail, run) {
    try { return await run(); } catch (error) {
      const api = mapStoreError(verb, error, target.id);
      record({ action, token: target.id, customer: target.customer, result: 'error', code: api.apiCode, detail });
      throw api;
    }
  }
  const afterWrite = () => { const { tokens } = tryList(); if (tokens) saveSnapshot(tokens); };
  // The records as the backend holds them now, outside any cache: the table read again (refresh) on Postgres, a fresh
  // store over the file (no cache) on tokens.json.
  async function readBack() {
    if (backend() === 'postgres') { await store.refresh(); return store.list(); }
    return createStore(config.serverDir).list();
  }
  // Read-back after every write: the record must be in the backend with the change (and, on tokens.json, the file must
  // parse). Otherwise another writer dropped the change or tore the file: history line, notice (critical alert), log
  // line and WRITE_NOT_CONFIRMED; the caller never returns a secret for it.
  async function confirmWrite(action, target, detail, holds) {
    let rec = null;
    try { rec = ((await readBack()) ?? []).map(normalize).find(x => x.id === target.id) ?? null; } catch { rec = null; }
    if (rec && holds(rec)) { afterWrite(); return; }
    afterWrite();
    record({ action, token: target.id, customer: target.customer, result: 'error', code: 'WRITE_NOT_CONFIRMED', detail });
    if (target.id && TOKEN_ID.test(target.id)) addNotice({ kind: 'unconfirmed', token: target.id, customer: target.customer, action });
    log({ console: 'write-not-confirmed', action, token: target.id });
    throw new ApiError('WRITE_NOT_CONFIRMED');
  }
  // A refusal found inside the gate is recorded like a refusal of the store (the 24th image refuses the same cases).
  const refuse = (action, cur, code, detail = {}) => { record({ action, token: cur.id, customer: cur.customer, result: 'error', code, detail }); return new ApiError(code); };

  async function issue({ customer, days, lanes, confirm }) {
    notSupported('issue');
    const name = customer.trim();
    confirmOf(name, confirm);
    return gate.run(async () => {
      detectExternal();
      const current = tryList().tokens ?? [];
      const duplicates = current.filter(t => t.state === 'active' && t.customer.toLowerCase() === name.toLowerCase()).map(t => t.id);
      const issued = await call('issue', 'issue', { id: null, customer: name }, { days: days ?? null, lanes },
        () => store.issue({ customer: name, ...(days ? { days } : {}), lanes }));
      const { token, agentCredential, ...rest } = issued;
      const view = normalize(rest);
      await confirmWrite('issue', { id: view.id, customer: view.customer }, { days: days ?? null, lanes },
        r => r.customer === view.customer && lanesKey(r.lanes) === lanesKey(view.lanes) && sameTime(r.expiresAt, view.expiresAt) && !r.revokedAt);
      const audit = record({ action: 'issue', token: view.id, customer: view.customer, detail: { days: days ?? null, expiresAt: view.expiresAt, lanes: view.lanes } });   // null days = sem validade
      return { view, secret: { token, agentCredential }, duplicates, audit };
    });
  }
  async function renew(id, { days, confirm, expectExpiresAt }) {
    notSupported('renew');
    const seen = find(id);
    confirmOf(seen.customer, confirm);
    if (!sameTime(expectExpiresAt, seen.expiresAt)) throw new ApiError('STALE');
    return gate.run(async () => {
      detectExternal();
      const cur = find(id);
      const detail = { days, previousExpiresAt: cur.expiresAt };
      if (!sameTime(expectExpiresAt, cur.expiresAt)) throw refuse('renew', cur, 'STALE', detail);
      if (cur.state === 'revoked') throw refuse('renew', cur, 'TOKEN_REVOKED', detail);
      if (!cur.expiresAt) throw refuse('renew', cur, 'NO_EXPIRY', detail);
      const result = await call('renew', 'renew', cur, { days, previousExpiresAt: cur.expiresAt }, () => store.renew(id, { days }));
      const view = normalize(result);
      await confirmWrite('renew', cur, detail, r => sameTime(r.expiresAt, view.expiresAt) && !r.revokedAt);
      const previousExpiresAt = result.previousExpiresAt ?? cur.expiresAt;
      const audit = record({ action: 'renew', token: id, customer: cur.customer, detail: { days, previousExpiresAt, expiresAt: view.expiresAt } });
      return { view, previousExpiresAt, expiresAt: view.expiresAt, audit };
    });
  }
  async function setLanes(id, { lanes, confirm, expectLanes }) {
    notSupported('lanes');
    const seen = find(id);
    confirmOf(seen.customer, confirm);
    if (lanesKey(expectLanes) !== lanesKey(seen.lanes)) throw new ApiError('STALE');
    return gate.run(async () => {
      detectExternal();
      const cur = find(id);
      const detail = { lanes, previousLanes: cur.lanes };
      if (lanesKey(expectLanes) !== lanesKey(cur.lanes)) throw refuse('lanes', cur, 'STALE', detail);
      if (cur.state === 'revoked') throw refuse('lanes', cur, 'TOKEN_REVOKED', detail);
      if (lanesKey(lanes) === lanesKey(cur.lanes)) throw refuse('lanes', cur, 'NO_CHANGE', detail);
      const result = await call('setLanes', 'lanes', cur, { lanes, previousLanes: cur.lanes }, () => store.setLanes(id, lanes));
      const view = normalize(result);
      await confirmWrite('lanes', cur, detail, r => lanesKey(r.lanes) === lanesKey(view.lanes));
      const audit = record({ action: 'lanes', token: id, customer: cur.customer, detail: { previousLanes: cur.lanes, lanes: view.lanes } });
      return { view, previousLanes: cur.lanes, audit };
    });
  }
  async function agentRotate(id, { confirm }) {
    notSupported('agentRotate');
    const seen = find(id);
    confirmOf(seen.customer, confirm);
    return gate.run(async () => {
      detectExternal();
      const cur = find(id);
      if (cur.state !== 'active') throw refuse('agent-rotate', cur, 'TOKEN_NOT_ACTIVE');
      const result = await call('agentRotate', 'agent-rotate', cur, {}, () => store.agentRotate(id));
      const { agentCredential, ...rest } = result;
      const view = normalize(rest);
      await confirmWrite('agent-rotate', cur, {}, r => r.agentIssuedAt === view.agentIssuedAt && r.state === 'active');
      const audit = record({ action: 'agent-rotate', token: id, customer: cur.customer });
      return { view, secret: { agentCredential }, audit };
    });
  }
  async function revoke(id, { confirm }) {
    notSupported('revoke');
    const seen = find(id);
    confirmOf(seen.customer, confirm);
    return gate.run(async () => {
      detectExternal();
      const cur = find(id);
      if (cur.state === 'revoked') throw refuse('revoke', cur, 'ALREADY_REVOKED');
      const result = await call('revoke', 'revoke', cur, {}, () => store.revoke(id));
      const view = normalize(result);
      await confirmWrite('revoke', cur, {}, r => !!r.revokedAt);
      const audit = record({ action: 'revoke', token: id, customer: cur.customer });
      return { view, audit };
    });
  }

  // The pool of the Postgres store is closed on stop (the file store's close is a no-op).
  const close = () => Promise.resolve(store?.close?.()).catch(() => {});
  return {
    caps, names, list, tryList, find, detectExternal, record, reconnect, close,
    get backend() { return backend(); },
    // notices of the last NOTICE_DAYS days, oldest first (alert-rules.mjs)
    notices: () => { const floor = now() - NOTICE_DAYS * DAY; return notices.filter(n => Date.parse(n.at) >= floor); },
    nameOf: token => names.get(token) ?? null,
    get listError() { return listError; },
    issue, renew, setLanes, agentRotate, revoke,
  };
}
