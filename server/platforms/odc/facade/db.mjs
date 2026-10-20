// The server's Postgres: one pool over SSAM_DATABASE_URL (postgres://user:password@host:5432/db[?sslmode=require]) and
// the migrations of ./migrations (NNNN-name.sql, applied in order, each in its own transaction, recorded in
// schema_migrations; a run takes a session advisory lock, so two servers or a server and `ssam db migrate` starting
// together never apply one twice). Only the token store uses it today (server-tokens-pg.mjs); the customers' files,
// the audit and the logs stay in the volumes. Nothing here logs the URL (it carries the password).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATABASE_URL_VAR = 'SSAM_DATABASE_URL';
export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
// One lock id for the migrations of this schema (any 64-bit constant, the same in every process).
const MIGRATION_LOCK = 7310_2026_1020;
const coded = (code, message) => Object.assign(new Error(message), { code });

// The database URL of the environment, or null; a value that is not a postgres:// URL is refused with DB_URL_INVALID.
export function databaseUrl(env = process.env) {
  const value = env[DATABASE_URL_VAR];
  if (value === undefined || value === null || String(value).trim() === '') return null;
  let url;
  try { url = new URL(String(value).trim()); } catch { throw coded('DB_URL_INVALID', DATABASE_URL_VAR + ' is not a URL'); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw coded('DB_URL_INVALID', DATABASE_URL_VAR + ' must be postgres://user:password@host:port/database');
  return url.href;
}

// The URL with its password replaced, for a log line or an error.
export const redactUrl = href => { try { const u = new URL(href); if (u.password) u.password = '***'; return u.href; } catch { return '(invalid url)'; } };

// {query, transaction, close, url} over a pg Pool. `pg` is loaded here, so a server without a database never loads it.
export async function createDb(url, { max = 4, connectionTimeoutMillis = 5000, idleTimeoutMillis = 30000, applicationName = 'ssam-server' } = {}) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max, connectionTimeoutMillis, idleTimeoutMillis, application_name: applicationName });
  // A pool error (a connection dropped while idle) is not a crash: the next query reconnects.
  pool.on('error', () => {});
  const query = (text, params = []) => pool.query(text, params);
  // fn(client) inside BEGIN/COMMIT; any throw rolls back and is rethrown.
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let value;
      try { value = await fn(client); await client.query('COMMIT'); }
      catch (error) { try { await client.query('ROLLBACK'); } catch { /* the connection is gone */ } throw error; }
      return value;
    } finally { client.release(); }
  }
  return { url, query, transaction, close: () => pool.end(), pool };
}

// The migration files of a folder, sorted: [{version, name, file}]. version is the leading number of the file name.
export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir).filter(name => /^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort()
    .map(name => ({ version: name.slice(0, 4), name: name.slice(5, -4), file: path.join(dir, name) }));
}

// Applies the migrations not yet in schema_migrations: {applied: [versions now applied], pending: []}.
export async function migrate(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const files = listMigrations(dir);
  const client = await db.pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    try {
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
      for (const m of files) {
        if (done.has(m.version)) continue;
        const sql = fs.readFileSync(m.file, 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
          await client.query('COMMIT');
        } catch (error) { try { await client.query('ROLLBACK'); } catch { /* gone */ } throw coded('DB_MIGRATION_FAILED', `migration ${m.version}-${m.name} failed: ${error.message}`); }
        applied.push(m.version);
        log({ event: 'db-migrated', version: m.version, name: m.name });
      }
    } finally { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]); }
  } finally { client.release(); }
  return { applied, pending: [] };
}

// {applied: [{version, name, appliedAt}], pending: [{version, name}]} without changing anything.
export async function migrationStatus(db, { dir = MIGRATIONS_DIR } = {}) {
  const files = listMigrations(dir);
  let rows = [];
  try { rows = (await db.query('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')).rows; }
  catch (error) { if (error.code !== '42P01') throw error; /* no table yet: nothing applied */ }
  const done = new Set(rows.map(r => r.version));
  return { applied: rows.map(r => ({ version: r.version, name: r.name, appliedAt: new Date(r.applied_at).toISOString() })),
    pending: files.filter(m => !done.has(m.version)).map(m => ({ version: m.version, name: m.name })) };
}

// `ssam db migrate | status`: the CLI over the environment's database.
export async function dbCli(args, { env = process.env } = {}) {
  const url = databaseUrl(env);
  if (!url) throw coded('DB_URL_MISSING', DATABASE_URL_VAR + ' is not set: nothing to migrate (the server keeps its tokens in tokens.json without it)');
  const [action] = args;
  if (action !== 'migrate' && action !== 'status') throw coded('USAGE', 'Usage: ssam db migrate | status');
  const db = await createDb(url, { max: 1, applicationName: 'ssam-db-cli' });
  try {
    if (action === 'migrate') { const result = await migrate(db); return { ok: true, database: redactUrl(url), appliedNow: result.applied, ...(await migrationStatus(db)) }; }
    return { ok: true, database: redactUrl(url), ...(await migrationStatus(db)) };
  } finally { await db.close(); }
}
