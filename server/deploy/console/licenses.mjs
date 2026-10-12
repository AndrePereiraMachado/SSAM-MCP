// Licenses through the image's token module (DESIGN 1.2, 2.4, 3.5, 4.1, D6). The console never reads or writes tokens.json
// itself: it imports CONSOLE_TOKEN_MODULE, calls list() (public view, no hashes) and the verbs issue, agentRotate, revoke
// and, when the module has them, renew and setLanes (capabilities by feature detection). Mutations run one at a time
// (the caller's gate: rate limit + queue); each one is recorded in console-audit.jsonl after the store call returns or
// throws. Every 5 s the public view is diffed against /state/tokens-snapshot.json: a change the console did not make
// becomes a history line with actor "externo".
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

export async function createLicenses({ config, state, history, tz, now = Date.now, log = () => {}, emit = () => {}, gate }) {
  let store = null;
  let loadError = null;
  try {
    const mod = await import(pathToFileURL(config.tokenModule).href);
    store = mod.createTokenStore(config.serverDir);
  } catch (error) {
    loadError = error;
    log({ console: 'token-module-failed', code: error.code ?? error.name ?? 'IMPORT' });
  }
  const fn = f => typeof f === 'function';
  const caps = { issue: fn(store?.issue), revoke: fn(store?.revoke), agentRotate: fn(store?.agentRotate), renew: fn(store?.renew), lanes: fn(store?.setLanes) };
  const names = new Map();
  let listError = null;
  let snapshot = state.readJson(SNAPSHOT);

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
  function record({ action, token = null, customer = null, result = 'ok', code = null, detail = {}, actor = 'painel' }) {
    const time = new Date(now()).toISOString();
    const audit = history.append({ time, action, actor, token, customer, result, code, detail });
    emit({ time, level: result === 'error' ? 'error' : 'info', group: 'licenca', token, customer,
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
    const before = new Map(snapshot.tokens.map(t => [t.id, t]));
    let changes = 0;
    for (const t of tokens) {
      const p = before.get(t.id);
      const base = { token: t.id, customer: t.customer, actor: 'externo' };
      if (!p) { record({ ...base, action: 'issue', detail: { expiresAt: t.expiresAt, lanes: t.lanes } }); changes++; continue; }
      if (!p.revokedAt && t.revokedAt) { record({ ...base, action: 'revoke' }); changes++; }
      if (!sameTime(p.expiresAt ?? null, t.expiresAt)) { record({ ...base, action: 'renew', detail: { previousExpiresAt: p.expiresAt ?? null, expiresAt: t.expiresAt } }); changes++; }
      if (lanesKey(p.lanes) !== lanesKey(t.lanes)) { record({ ...base, action: 'lanes', detail: { previousLanes: p.lanes ?? [], lanes: t.lanes } }); changes++; }
      if ((p.agentIssuedAt ?? null) !== (t.agentIssuedAt ?? null)) { record({ ...base, action: 'agent-rotate' }); changes++; }
    }
    if (changes || JSON.stringify(snapOf(tokens).tokens) !== JSON.stringify(snapshot.tokens)) saveSnapshot(tokens);
    return changes;
  }

  // ---- mutations: pre-checks here, the store call inside the gate (one at a time, re-checked)
  const notSupported = cap => { if (!caps[cap]) throw new ApiError('NOT_SUPPORTED'); };
  const confirmOf = (customer, confirm) => { if (String(confirm ?? '').trim() !== customer) throw new ApiError('CONFIRM_MISMATCH'); };
  function call(verb, action, target, detail, run) {
    try { return run(); } catch (error) {
      const api = mapStoreError(verb, error, target.id);
      record({ action, token: target.id, customer: target.customer, result: 'error', code: api.apiCode, detail });
      throw api;
    }
  }
  const afterWrite = () => { const { tokens } = tryList(); if (tokens) saveSnapshot(tokens); };
  // A refusal found inside the gate is recorded like a refusal of the store (the 24th image refuses the same cases).
  const refuse = (action, cur, code, detail = {}) => { record({ action, token: cur.id, customer: cur.customer, result: 'error', code, detail }); return new ApiError(code); };

  async function issue({ customer, days, lanes, confirm }) {
    notSupported('issue');
    const name = customer.trim();
    confirmOf(name, confirm);
    return gate.run(() => {
      detectExternal();
      const current = tryList().tokens ?? [];
      const duplicates = current.filter(t => t.state === 'active' && t.customer.toLowerCase() === name.toLowerCase()).map(t => t.id);
      const issued = call('issue', 'issue', { id: null, customer: name }, { days: days ?? null, lanes },
        () => store.issue({ customer: name, ...(days ? { days } : {}), lanes }));
      const { token, agentCredential, ...rest } = issued;
      afterWrite();
      const view = normalize(rest);
      const audit = record({ action: 'issue', token: view.id, customer: view.customer, detail: { days: days ?? null, expiresAt: view.expiresAt, lanes: view.lanes } });   // null days = sem validade
      return { view, secret: { token, agentCredential }, duplicates, audit };
    });
  }
  async function renew(id, { days, confirm, expectExpiresAt }) {
    notSupported('renew');
    const seen = find(id);
    confirmOf(seen.customer, confirm);
    if (!sameTime(expectExpiresAt, seen.expiresAt)) throw new ApiError('STALE');
    return gate.run(() => {
      detectExternal();
      const cur = find(id);
      const detail = { days, previousExpiresAt: cur.expiresAt };
      if (!sameTime(expectExpiresAt, cur.expiresAt)) throw refuse('renew', cur, 'STALE', detail);
      if (cur.state === 'revoked') throw refuse('renew', cur, 'TOKEN_REVOKED', detail);
      if (!cur.expiresAt) throw refuse('renew', cur, 'NO_EXPIRY', detail);
      const result = call('renew', 'renew', cur, { days, previousExpiresAt: cur.expiresAt }, () => store.renew(id, { days }));
      afterWrite();
      const view = normalize(result);
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
    return gate.run(() => {
      detectExternal();
      const cur = find(id);
      const detail = { lanes, previousLanes: cur.lanes };
      if (lanesKey(expectLanes) !== lanesKey(cur.lanes)) throw refuse('lanes', cur, 'STALE', detail);
      if (cur.state === 'revoked') throw refuse('lanes', cur, 'TOKEN_REVOKED', detail);
      if (lanesKey(lanes) === lanesKey(cur.lanes)) throw refuse('lanes', cur, 'NO_CHANGE', detail);
      const result = call('setLanes', 'lanes', cur, { lanes, previousLanes: cur.lanes }, () => store.setLanes(id, lanes));
      afterWrite();
      const view = normalize(result);
      const audit = record({ action: 'lanes', token: id, customer: cur.customer, detail: { previousLanes: cur.lanes, lanes: view.lanes } });
      return { view, previousLanes: cur.lanes, audit };
    });
  }
  async function agentRotate(id, { confirm }) {
    notSupported('agentRotate');
    const seen = find(id);
    confirmOf(seen.customer, confirm);
    return gate.run(() => {
      detectExternal();
      const cur = find(id);
      if (cur.state !== 'active') throw refuse('agent-rotate', cur, 'TOKEN_NOT_ACTIVE');
      const result = call('agentRotate', 'agent-rotate', cur, {}, () => store.agentRotate(id));
      const { agentCredential, ...rest } = result;
      afterWrite();
      const view = normalize(rest);
      const audit = record({ action: 'agent-rotate', token: id, customer: cur.customer });
      return { view, secret: { agentCredential }, audit };
    });
  }
  async function revoke(id, { confirm }) {
    notSupported('revoke');
    const seen = find(id);
    confirmOf(seen.customer, confirm);
    return gate.run(() => {
      detectExternal();
      const cur = find(id);
      if (cur.state === 'revoked') throw refuse('revoke', cur, 'ALREADY_REVOKED');
      const result = call('revoke', 'revoke', cur, {}, () => store.revoke(id));
      afterWrite();
      const view = normalize(result);
      const audit = record({ action: 'revoke', token: id, customer: cur.customer });
      return { view, audit };
    });
  }

  return {
    caps, names, list, tryList, find, detectExternal, record,
    nameOf: token => names.get(token) ?? null,
    get listError() { return listError; },
    issue, renew, setLanes, agentRotate, revoke,
  };
}
