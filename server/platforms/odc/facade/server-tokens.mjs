// Access tokens of the served MCP (docs/SERVIDOR-LOCAL.md, docs/FASE2-AGENTE.md 2.2): the license and the kill switch.
// A token is 32 random bytes in base64url behind the "ssam_" prefix, shown ONCE when issued; the store keeps only its
// SHA-256, with {id, customer, createdAt, revokedAt?, expiresAt?}. Phase 2 adds to the SAME record the credential of
// the customer's agent ("ssam_agent_" + 32 random bytes, also shown once, also kept only as SHA-256) and the lanes the
// token may use: {agentSha256?, agentIssuedAt?, lanes?}. The schema stays ssam-server-tokens/1 (the new fields are
// optional; phase-1 records stay valid). One never works in place of the other: verify() refuses agent credentials and
// verifyAgent() accepts only them.
// Two stores keep the records, with the same verbs, codes and messages:
//   - tokens.json under <workspace>/.local/server (outside git), createTokenStore: the default. Every writer takes
//     tokens.json.lock (exclusive create; a lock older than 30 s is removed once), re-reads the file inside the lock and
//     replaces it atomically (tokens.json.<pid>.<hex>.tmp, fsync, rename), so the CLI and the console never lose each
//     other's change. Readers (the server) stay lock-free and only ever see a whole file;
//   - Postgres (server-tokens-pg.mjs), when SSAM_DATABASE_URL is set: openTokenStore picks it, applies the migrations
//     and loads the first snapshot. Its writers are asynchronous (one transaction under an advisory lock); its readers
//     stay synchronous over a snapshot refreshed every second.
// The record logic (hashes, states, lanes, validations) is tokenRecords, shared by both.
// Writers: the local CLI (`ssam server-token issue|agent-rotate|renew|lanes|revoke|list|import`) and the owner console
// (SSAM-MCP server/deploy/console, reachable only through the owner's SSH tunnel; tokens.json only), both through this
// module; the server itself never writes. Nothing in this module listens on a network, and no function returns or
// logs a stored secret. Every error thrown here carries error.code (UNKNOWN_TOKEN, TOKEN_REVOKED, TOKEN_NOT_ACTIVE,
// NO_EXPIRY, INVALID_DAYS, EXPIRY_TOO_FAR, INVALID_LANES, INVALID_CUSTOMER, STORE_INVALID, STORE_LOCKED,
// STORE_UNAVAILABLE, USAGE; file-system errors keep their own code); the messages are the ones older images used, so
// a caller may still match on them.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIX = 'ssam_';
export const AGENT_PREFIX = 'ssam_agent_';
export const TOKEN_LANES = Object.freeze(['odc', 'o11']);
export const TOKENS_SCHEMA = 'ssam-server-tokens/1';
const DAY_MS = 86400000;
const MAX_DAYS = 3650;
const DAYS_MESSAGE = 'days: an integer from 1 to ' + MAX_DAYS;
const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 30000;
const sha256 = text => createHash('sha256').update(text, 'utf8').digest();
const customerPattern = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
// Phase-1 records have no lanes field: they keep the default of a new token.
const lanesOf = t => Array.isArray(t.lanes) ? t.lanes.filter(l => TOKEN_LANES.includes(l)) : [...TOKEN_LANES];
const coded = (code, message) => Object.assign(new Error(message), { code });
const validDays = days => Number.isInteger(days) && days >= 1 && days <= MAX_DAYS;
// The writers are synchronous (the CLI and the console's one-at-a-time queue); waiting for the lock blocks this thread.
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The folder of the served mode: SSAM_SERVER_DIR (tests, another clone) or <root>/.local/server.
export const serverDir = (root, env = process.env) => env.SSAM_SERVER_DIR ? path.resolve(env.SSAM_SERVER_DIR) : path.join(root, '.local', 'server');

// "odc,o11" -> ['odc', 'o11'] (each known, repeats folded, at least one).
export function parseLanes(value) {
  if (Array.isArray(value)) value = value.join(',');
  const lanes = [...new Set(String(value ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!lanes.length || lanes.some(l => !TOKEN_LANES.includes(l))) throw coded('INVALID_LANES', 'lanes: odc, o11 or odc,o11');
  return TOKEN_LANES.filter(l => lanes.includes(l));
}

// The record logic over an array of records (the tokens of the store, private copies inside a writer's lock). The
// check* functions validate the input BEFORE any lock is taken; the verbs return { write, value } for the store's
// mutate; the readers answer over the records they are given.
export function tokenRecords({ now = () => new Date() } = {}) {
  const entryOf = (tokens, id) => {
    const entry = tokens.find(t => t.id === id);
    if (!entry) throw coded('UNKNOWN_TOKEN', 'Unknown token id: ' + id);
    return entry;
  };
  const notRevoked = (entry, id) => { if (entry.revokedAt) throw coded('TOKEN_REVOKED', 'Token ' + id + ' is revoked; issue a new one instead.'); };
  const stateOf = t => t.revokedAt ? 'revoked' : t.expiresAt && Date.parse(t.expiresAt) <= now().getTime() ? 'expired' : 'active';
  const publicView = t => ({ id: t.id, customer: t.customer, createdAt: t.createdAt, ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
    ...(t.revokedAt ? { revokedAt: t.revokedAt } : {}), state: stateOf(t), lanes: lanesOf(t),
    agent: t.agentSha256 ? { issuedAt: t.agentIssuedAt ?? null } : null });
  const newAgentCredential = () => AGENT_PREFIX + randomBytes(32).toString('base64url');
  // Every stored hash of the field is compared in constant time, with no early exit.
  function find(tokens, field, presented) {
    const digest = sha256(presented);
    let found = null;
    for (const t of tokens) {
      const stored = Buffer.from(String(t[field] ?? ''), 'hex');
      if (stored.length === digest.length && timingSafeEqual(stored, digest) && !found) found = t;
    }
    return found;
  }
  return {
    stateOf, publicView, lanesOf,
    checkIssue({ customer, days, lanes = TOKEN_LANES } = {}) {
      if (typeof customer !== 'string' || !customerPattern.test(customer.trim())) throw coded('INVALID_CUSTOMER', 'customer: 1-64 letters, digits, space, dot, dash or underscore');
      if (days !== undefined && !validDays(days)) throw coded('INVALID_DAYS', DAYS_MESSAGE);
      return { customer: customer.trim(), days, lanes: parseLanes(lanes) };
    },
    // Issue: both plaintexts (MCP token and agent credential) come back here once and are never written anywhere.
    issue(tokens, { customer, days, lanes }) {
      const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
      const agentCredential = newAgentCredential();
      const created = now();
      const entry = { id: 'tok_' + randomBytes(6).toString('hex'), customer, createdAt: created.toISOString(),
        ...(days ? { expiresAt: new Date(created.getTime() + days * DAY_MS).toISOString() } : {}),
        sha256: sha256(token).toString('hex'), agentSha256: sha256(agentCredential).toString('hex'), agentIssuedAt: created.toISOString(),
        lanes };
      tokens.push(entry);
      return { write: true, value: { token, agentCredential, ...publicView(entry) } };
    },
    // A new agent credential for the same record; the old one stops at once (401) and its open channel is closed
    // by the server within a second (Close rotated).
    agentRotate(tokens, id) {
      const entry = entryOf(tokens, id);
      if (stateOf(entry) !== 'active') throw coded('TOKEN_NOT_ACTIVE', 'Token ' + id + ' is ' + stateOf(entry) + '; issue a new one instead.');
      const agentCredential = newAgentCredential();
      entry.agentSha256 = sha256(agentCredential).toString('hex');
      entry.agentIssuedAt = now().toISOString();
      return { write: true, value: { agentCredential, ...publicView(entry) } };
    },
    checkRenew({ days } = {}) { if (!validDays(days)) throw coded('INVALID_DAYS', DAYS_MESSAGE); return { days }; },
    // A later expiry: max(now, current expiry) + days, at most 3650 days from now. An expired token is active again at
    // once (its agent reconnects by itself; the customer opens new sessions). Revoked tokens and tokens with no expiry
    // are refused.
    renew(tokens, id, { days }) {
      const entry = entryOf(tokens, id);
      notRevoked(entry, id);
      if (!entry.expiresAt) throw coded('NO_EXPIRY', 'Token ' + id + ' has no expiry; nothing to renew.');
      const nowMs = now().getTime();
      const current = Date.parse(entry.expiresAt);
      const next = Math.max(nowMs, Number.isFinite(current) ? current : nowMs) + days * DAY_MS;
      if (next > nowMs + MAX_DAYS * DAY_MS) throw coded('EXPIRY_TOO_FAR', 'expiry: at most ' + MAX_DAYS + ' days from now');
      const previousExpiresAt = entry.expiresAt;
      entry.expiresAt = new Date(next).toISOString();
      return { write: true, value: { previousExpiresAt, ...publicView(entry) } };
    },
    checkLanes(lanes) { return parseLanes(lanes); },
    // The lanes of a token (active or expired; never revoked). verify() answers with them at once; sessions already open
    // keep the lanes they were opened with. The same set writes nothing.
    setLanes(tokens, id, next) {
      const entry = entryOf(tokens, id);
      notRevoked(entry, id);
      const previousLanes = lanesOf(entry);
      if (previousLanes.length === next.length && previousLanes.every((l, i) => l === next[i])) return { write: false, value: { previousLanes, ...publicView(entry) } };
      entry.lanes = next;
      return { write: true, value: { previousLanes, ...publicView(entry) } };
    },
    // Revoking the record kills both secrets: the MCP token and the agent credential.
    revoke(tokens, id) {
      const entry = entryOf(tokens, id);
      if (entry.revokedAt) return { write: false, value: publicView(entry) };
      entry.revokedAt = now().toISOString();
      return { write: true, value: publicView(entry) };
    },
    // Verify a presented MCP bearer token (never an agent credential).
    verify(tokens, presented) {
      if (typeof presented !== 'string' || !presented.startsWith(TOKEN_PREFIX) || presented.startsWith(AGENT_PREFIX) || presented.length > 256) return { status: 'unknown' };
      const found = find(tokens, 'sha256', presented);
      if (!found) return { status: 'unknown' };
      const state = stateOf(found);
      return { status: state === 'active' ? 'ok' : state, id: found.id, customer: found.customer, lanes: lanesOf(found) };
    },
    // Verify a presented agent credential. agentSha256 is the stored hash the channel keeps to notice an agent-rotate.
    verifyAgent(tokens, presented) {
      if (typeof presented !== 'string' || !presented.startsWith(AGENT_PREFIX) || presented.length > 256) return { status: 'unknown' };
      const found = find(tokens, 'agentSha256', presented);
      if (!found) return { status: 'unknown' };
      const state = stateOf(found);
      return { status: state === 'active' ? 'ok' : state, id: found.id, customer: found.customer, lanes: lanesOf(found), agentSha256: found.agentSha256 };
    },
    // The state of a token id now (sessions of a revoked or expired token are closed by the server).
    stateOfId(tokens, id) { const t = tokens.find(x => x.id === id); return t ? stateOf(t) : 'unknown'; },
    // What the server needs about a record, with no secret: state, lanes, whether it has an agent credential, and the
    // hash of that credential (to close a channel opened with a rotated one). null for an unknown id.
    lookup(tokens, id) {
      const t = tokens.find(x => x.id === id);
      return t ? { id: t.id, customer: t.customer, state: stateOf(t), lanes: lanesOf(t), credential: !!t.agentSha256, agentSha256: t.agentSha256 ?? null } : null;
    },
  };
}

// The records of a tokens.json file (schema checked), for an import into another store.
export function readTokensFile(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) error.code = 'STORE_INVALID'; throw error; }
  if (parsed?.schema !== TOKENS_SCHEMA || !Array.isArray(parsed.tokens)) throw coded('STORE_INVALID', 'Invalid tokens file: ' + file);
  return parsed.tokens;
}

// The tokens.json store. lockWaitMs exists for tests only; the contract is 3 s.
export function createTokenStore(dir, { now = () => new Date(), lockWaitMs = LOCK_WAIT_MS } = {}) {
  const file = path.join(dir, 'tokens.json');
  const lockFile = file + '.lock';
  const ops = tokenRecords({ now });
  let cache = { stamp: null, tokens: [] };

  // The inode is part of the stamp: every write replaces the file (rename), even one that keeps its size.
  const stampOf = () => { try { const s = fs.statSync(file); return s.ino + ':' + s.mtimeMs + ':' + s.size; } catch { return 'missing'; } };
  const read = () => readTokensFile(file);
  // The file is re-read only when it changed (inode + mtime + size), so a revoke from the CLI or the console is seen at
  // the next request.
  function load() {
    const stamp = stampOf();
    if (stamp === cache.stamp) return cache.tokens;
    const tokens = stamp === 'missing' ? [] : read();
    cache = { stamp, tokens };
    return tokens;
  }
  // Inside the lock: the file as it is now, whatever the cache holds (another process may have written since). Only a
  // file that does not exist counts as empty; any other failure stops the writer before it could drop records.
  const fresh = () => { try { return read(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  function save(tokens) {
    const temp = file + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp';
    let fd = fs.openSync(temp, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify({ schema: TOKENS_SCHEMA, tokens }, null, 2) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      fs.renameSync(temp, file);
    } catch (error) {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* already failing */ }
      try { fs.unlinkSync(temp); } catch { /* already failing */ }
      throw error;
    } finally { cache = { stamp: null, tokens: [] }; }
    // The rename itself survives a power cut only once the folder is flushed (not possible on Windows: best effort).
    try { const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* best effort */ }
  }
  function lock() {
    fs.mkdirSync(dir, { recursive: true });
    const deadline = Date.now() + lockWaitMs;
    let brokeStale = false;
    for (;;) {
      let failure;
      try { return fs.openSync(lockFile, 'wx'); } catch (error) { failure = error; }
      // On Windows a lock file being deleted while another process looks at it answers EPERM for a moment.
      if (failure.code !== 'EEXIST' && !(process.platform === 'win32' && failure.code === 'EPERM')) throw failure;
      if (failure.code === 'EEXIST' && !brokeStale) {
        let age;
        // Gone between the open and the stat: released just now, so try again at once (within the deadline).
        try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch (error) { if (error.code !== 'ENOENT') throw error; if (Date.now() < deadline) continue; age = 0; }
        // A writer holds the lock for milliseconds; one older than 30 s belongs to a writer that died. Removed once.
        if (age > LOCK_STALE_MS) { brokeStale = true; try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; } continue; }
      }
      if (Date.now() >= deadline) {
        if (failure.code === 'EPERM') throw failure;
        throw coded('STORE_LOCKED', 'Tokens file is locked by another writer (' + lockFile + '); try again.');
      }
      pause(LOCK_RETRY_MS);
    }
  }
  // fn gets a private copy of the records read inside the lock and returns { write, value }.
  function mutate(fn) {
    const fd = lock();
    try {
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n'); } catch { /* informative only */ }
      const tokens = fresh().map(t => ({ ...t }));
      const { write, value } = fn(tokens);
      if (write) save(tokens);
      return value;
    } finally {
      try { fs.closeSync(fd); } catch { /* released below anyway */ }
      try { fs.unlinkSync(lockFile); } catch { /* a later writer breaks it after 30 s */ }
    }
  }

  return {
    backend: 'file',
    file,
    ready: async () => {},
    close: async () => {},
    issue(options = {}) { const checked = ops.checkIssue(options); return mutate(tokens => ops.issue(tokens, checked)); },
    agentRotate(id) { return mutate(tokens => ops.agentRotate(tokens, id)); },
    renew(id, options = {}) { ops.checkRenew(options); return mutate(tokens => ops.renew(tokens, id, options)); },
    setLanes(id, lanes) { const next = ops.checkLanes(lanes); return mutate(tokens => ops.setLanes(tokens, id, next)); },
    revoke(id) { return mutate(tokens => ops.revoke(tokens, id)); },
    list() { return load().map(ops.publicView); },
    verify(presented) { return ops.verify(load(), presented); },
    verifyAgent(presented) { return ops.verifyAgent(load(), presented); },
    stateOf(id) { return ops.stateOfId(load(), id); },
    lookup(id) { return ops.lookup(load(), id); },
  };
}

// The store of this environment: Postgres when SSAM_DATABASE_URL is set (its migrations applied first, unless
// SSAM_DB_AUTOMIGRATE=0, and its first snapshot loaded: a database that cannot be reached fails here, before the server
// listens), else tokens.json in dir. The result's `backend` says which.
export async function openTokenStore({ dir, env = process.env, now = () => new Date(), log = () => {} } = {}) {
  const { databaseUrl, createDb, migrate, redactUrl } = await import('./db.mjs');
  const url = databaseUrl(env);
  if (!url) return createTokenStore(dir, { now });
  const { createPgTokenStore } = await import('./server-tokens-pg.mjs');
  const db = await createDb(url);
  try {
    if (env.SSAM_DB_AUTOMIGRATE !== '0') await migrate(db, { log });
    const store = createPgTokenStore({ db, now, log });
    await store.ready();
    log({ event: 'tokens-store', backend: 'postgres', database: redactUrl(url) });
    return store;
  } catch (error) { await db.close().catch(() => {}); throw error; }
}

const USAGE = 'Usage: ssam server-token issue --customer <name> [--days N] [--lanes odc,o11] | agent-rotate --id <id> | renew --id <id> --days N | lanes --id <id> --lanes odc,o11 | revoke --id <id> | list';
const usage = message => coded('USAGE', message);
// fn over a value that may be a promise (the Postgres store) or not (the file store), without turning the file store's
// answers into promises.
const chain = (value, fn) => (value && typeof value.then === 'function' ? value.then(fn) : fn(value));

// The verbs of `ssam server-token` over a store (either backend): the CLI's answers.
export function tokenActions(store, args) {
  const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const [action] = args;
  if (action === 'issue') {
    const days = value('--days');
    const lanes = value('--lanes');
    if (args.includes('--lanes') && lanes === undefined) throw usage(USAGE);
    return chain(store.issue({ customer: value('--customer'), ...(days !== undefined ? { days: Number(days) } : {}), ...(lanes !== undefined ? { lanes } : {}) }), issued => ({ ok: true, ...issued,
      note: 'The token and the agent credential are shown only now. The token goes in the MCP client configuration; the credential goes in the agent setup. The server keeps only the SHA-256 hash of each.' }));
  }
  if (action === 'agent-rotate') {
    const id = value('--id');
    if (!id) throw usage('Usage: ssam server-token agent-rotate --id <id>');
    return chain(store.agentRotate(id), rotated => {
      const { agentCredential, ...view } = rotated;
      return { ok: true, agentCredential, rotated: view,
        note: 'The new credential is shown only now. The previous one no longer holds and the agent channel opened with it closes within 1 s; run the agent setup with the new one.' };
    });
  }
  if (action === 'renew') {
    const id = value('--id');
    const days = value('--days');
    if (!id || days === undefined) throw usage('Usage: ssam server-token renew --id <id> --days N');
    return chain(store.renew(id, { days: Number(days) }), ({ previousExpiresAt, ...renewed }) => ({ ok: true, renewed, previousExpiresAt,
      note: 'The new expiry holds now. An expired license holds again: the agent reconnects by itself and the client opens new sessions.' }));
  }
  if (action === 'lanes') {
    const id = value('--id');
    const lanes = value('--lanes');
    if (!id || lanes === undefined) throw usage('Usage: ssam server-token lanes --id <id> --lanes odc,o11');
    return chain(store.setLanes(id, lanes), ({ previousLanes, ...changed }) => ({ ok: true, changed, previousLanes,
      note: 'It holds for new sessions; the open ones keep the old lanes until they close (60 min unused or a client reconnection).' }));
  }
  if (action === 'revoke') {
    const id = value('--id');
    if (!id) throw usage('Usage: ssam server-token revoke --id <id>');
    return chain(store.revoke(id), revoked => ({ ok: true, revoked, note: 'It holds now for the token and the agent credential: new requests get 403, the open sessions and the agent channel of this token are closed.' }));
  }
  if (action === 'list') {
    const listed = () => ({ ok: true, ...(store.backend === 'postgres' ? { database: true } : { file: store.file }), tokens: store.list() });
    return store.backend === 'postgres' ? store.refresh().then(listed) : listed();
  }
  if (action === 'import') {
    // import --from <tokens.json>: the records of a tokens.json copied into the Postgres store (the move from a volume
    // to the database; the file is not changed). Refused on the file store.
    const from = value('--from');
    if (!from) throw usage('Usage: ssam server-token import --from <tokens.json>');
    if (store.backend !== 'postgres') throw coded('USAGE', 'import copies a tokens.json into the Postgres store: set SSAM_DATABASE_URL first');
    const records = readTokensFile(from);
    return chain(store.importRecords(records), result => ({ ok: true, ...result, from, note: 'The records are in the database now (only hashes travel; no secret is in a tokens.json). Keep the file as a backup or delete it.' }));
  }
  throw usage(USAGE);
}

// `ssam server-token ...` over the tokens.json of the workspace (synchronous: the file store), as older images ran it.
export function tokenCli(args, { root, env = process.env } = {}) {
  return tokenActions(createTokenStore(serverDir(root, env)), args);
}

// `ssam server-token ...` over the store of the environment (tokens.json, or Postgres with SSAM_DATABASE_URL).
export async function runTokenCli(args, { root, env = process.env } = {}) {
  const store = await openTokenStore({ dir: serverDir(root, env), env });
  try { return await tokenActions(store, args); }
  finally { await store.close(); }
}
