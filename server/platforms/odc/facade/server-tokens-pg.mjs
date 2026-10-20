// The token store over Postgres (table server_tokens, migrations/0001-server-tokens.sql): the same records, verbs,
// codes and messages as the tokens.json store of server-tokens.mjs, chosen when SSAM_DATABASE_URL is set
// (openTokenStore). The record logic (hashes, states, lanes, validations) is the one of server-tokens.mjs
// (tokenRecords); this module only keeps the records somewhere else.
//   - Readers (verify, verifyAgent, lookup, stateOf, list) stay synchronous, as the server calls them in its request
//     path: they read a snapshot of the table that is refreshed in the background once it is older than refreshMs (1 s),
//     so a revoke done by the CLI or another server is seen within about a second (the file store saw it at the next
//     request). ready() loads the first snapshot and fails when the database cannot be reached: the server does not
//     start without its tokens. A database that goes away later keeps the last snapshot (tokens-store-stale in the
//     log): the server keeps answering with what it knew.
//   - Writers (issue, agentRotate, renew, setLanes, revoke, importRecords) are asynchronous: one transaction under a
//     transaction-level advisory lock, the rows read inside it, the record logic applied, the changed rows upserted.
//     Two writers never lose each other's change, as with tokens.json.lock.
// No function returns or logs a stored secret, and the URL (with its password) is never logged.
import { tokenRecords } from './server-tokens.mjs';

export const REFRESH_MS = 1000;
// The lock every writer takes for the length of its transaction (any 64-bit constant, the same in every process).
const TOKENS_LOCK = 7310_2026_1021;
const coded = (code, message) => Object.assign(new Error(message), { code });
const unavailable = error => Object.assign(coded('STORE_UNAVAILABLE', 'Token store unavailable: ' + (error?.message ?? error)), { cause: error });
const toDate = value => (value ? new Date(value) : null);

// A record -> the parameters of the upsert, in column order.
export function rowOf(record) {
  return [record.id, record.customer, new Date(record.createdAt), toDate(record.expiresAt), toDate(record.revokedAt), record.sha256,
    record.agentSha256 ?? null, toDate(record.agentIssuedAt), Array.isArray(record.lanes) ? record.lanes : null, JSON.stringify(record)];
}
const UPSERT = `INSERT INTO server_tokens (id, customer, created_at, expires_at, revoked_at, token_sha256, agent_sha256, agent_issued_at, lanes, record, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, ARRAY['odc', 'o11']), $10::jsonb, now())
  ON CONFLICT (id) DO UPDATE SET customer = EXCLUDED.customer, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at,
    revoked_at = EXCLUDED.revoked_at, token_sha256 = EXCLUDED.token_sha256, agent_sha256 = EXCLUDED.agent_sha256,
    agent_issued_at = EXCLUDED.agent_issued_at, lanes = EXCLUDED.lanes, record = EXCLUDED.record, updated_at = now()`;
const SELECT = 'SELECT record FROM server_tokens ORDER BY created_at, id';
const recordsOf = rows => rows.map(r => (typeof r.record === 'string' ? JSON.parse(r.record) : r.record));

export function createPgTokenStore({ db, now = () => new Date(), refreshMs = REFRESH_MS, log = () => {} }) {
  const ops = tokenRecords({ now });
  let snapshot = { tokens: [], at: 0, loaded: false };
  let refreshing = null;
  let timer = null;

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try { const { rows } = await db.query(SELECT); snapshot = { tokens: recordsOf(rows), at: Date.now(), loaded: true }; }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  // Once loaded, the snapshot is refreshed every refreshMs whether or not anyone reads (a server idle for a while
  // still sees a revoke within a second); a read older than that triggers one more refresh.
  function startTimer() {
    if (timer) return;
    timer = setInterval(() => { refresh().catch(error => log({ event: 'tokens-store-stale', code: error.code ?? null, message: String(error.message ?? error).slice(0, 200) })); }, refreshMs);
    if (timer.unref) timer.unref();
  }
  // The snapshot, refreshed in the background when it is older than refreshMs; never a secret of its own.
  function load() {
    if (!snapshot.loaded) throw coded('STORE_UNAVAILABLE', 'Token store not loaded yet');
    if (Date.now() - snapshot.at > refreshMs && !refreshing) refresh().catch(error => log({ event: 'tokens-store-stale', code: error.code ?? null, message: String(error.message ?? error).slice(0, 200) }));
    return snapshot.tokens;
  }
  // fn gets private copies of the records read under the lock and returns { write, value }; the records that changed
  // (or are new) are upserted in the same transaction, and the snapshot takes the written set at once.
  async function mutate(fn) {
    try {
      return await db.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [TOKENS_LOCK]);
        const before = recordsOf((await client.query(SELECT)).rows);
        const tokens = before.map(t => ({ ...t }));
        const { write, value } = fn(tokens);
        if (write) {
          const previous = new Map(before.map(t => [t.id, JSON.stringify(t)]));
          for (const t of tokens) if (previous.get(t.id) !== JSON.stringify(t)) await client.query(UPSERT, rowOf(t));
          snapshot = { tokens, at: Date.now(), loaded: true };
        }
        return value;
      });
    } catch (error) {
      // The record logic's own refusals keep their code; a database failure is STORE_UNAVAILABLE.
      if (error?.code && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)) throw error;
      throw unavailable(error);
    }
  }

  return {
    backend: 'postgres',
    file: null,
    ready: () => refresh().then(startTimer, error => { throw unavailable(error); }),
    refresh,
    close: () => { if (timer) clearInterval(timer); timer = null; return db.close(); },
    // The writers are async throughout: a refusal of the input (INVALID_CUSTOMER, INVALID_DAYS, INVALID_LANES) is a
    // rejection too, never a synchronous throw, so a caller handles both backends the same way with await.
    async issue(options = {}) { const checked = ops.checkIssue(options); return mutate(tokens => ops.issue(tokens, checked)); },
    async agentRotate(id) { return mutate(tokens => ops.agentRotate(tokens, id)); },
    async renew(id, options = {}) { ops.checkRenew(options); return mutate(tokens => ops.renew(tokens, id, options)); },
    async setLanes(id, lanes) { const next = ops.checkLanes(lanes); return mutate(tokens => ops.setLanes(tokens, id, next)); },
    async revoke(id) { return mutate(tokens => ops.revoke(tokens, id)); },
    // Records of a tokens.json (schema ssam-server-tokens/1) copied in: a record already here with the same id is
    // replaced; the plaintext secrets are not in a record, so nothing secret moves. {imported, total}.
    async importRecords(records) {
      return mutate(tokens => {
        let imported = 0;
        for (const record of records) {
          if (!record || typeof record.id !== 'string' || typeof record.sha256 !== 'string') throw coded('STORE_INVALID', 'Invalid token record: ' + JSON.stringify(record?.id ?? record).slice(0, 80));
          const index = tokens.findIndex(t => t.id === record.id);
          if (index >= 0) tokens[index] = { ...record }; else tokens.push({ ...record });
          imported++;
        }
        return { write: imported > 0, value: { imported, total: tokens.length } };
      });
    },
    list() { return load().map(ops.publicView); },
    verify(presented) { return ops.verify(load(), presented); },
    verifyAgent(presented) { return ops.verifyAgent(load(), presented); },
    stateOf(id) { return ops.stateOfId(load(), id); },
    lookup(id) { return ops.lookup(load(), id); },
  };
}
