// The console over the real Postgres token store (server/platforms/odc/facade/server-tokens-pg.mjs, through the
// module's openTokenStore with SSAM_DATABASE_URL = config.databaseUrl, COOLIFY.md 11): every action lands in the table
// server_tokens and is read back from it, the audit lines are written, no tokens.json appears; a change made by another
// store (the CLI on the VPS) becomes an "externo" history line within a second; a database that cannot be reached leaves
// the console read-only (503 on the list) instead of stopping it. Runs only with SSAM_TEST_DATABASE_URL (a throwaway
// Postgres, as facade/tests/server-tokens-pg.test.mjs: `docker run -d -e POSTGRES_PASSWORD=x -e POSTGRES_USER=ssam
// -e POSTGRES_DB=ssam -p 127.0.0.1:55432:5432 postgres:17-alpine`, SSAM_TEST_DATABASE_URL=postgres://ssam:x@127.0.0.1:55432/ssam).
// Every test works in a schema of its own, dropped at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { REAL_MODULE, SECRET, makeEnv, sleep, startConsole } from './helpers.mjs';

const BASE = process.env.SSAM_TEST_DATABASE_URL ?? null;
const skip = BASE ? false : 'SSAM_TEST_DATABASE_URL is not set';
const FACADE = path.resolve(path.dirname(REAL_MODULE));
const dbModule = () => import(pathToFileURL(path.join(FACADE, 'db.mjs')).href);
const pgModule = () => import(pathToFileURL(path.join(FACADE, 'server-tokens-pg.mjs')).href);
const auditLines = env => fs.readFileSync(path.join(env.serverDir, 'console-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

// A URL whose connections live in a fresh schema (search_path), dropped at the end of the run.
const schemas = [];
async function freshUrl() {
  const { createDb } = await dbModule();
  const schema = 'ssam_console_' + randomBytes(4).toString('hex');
  const admin = await createDb(BASE, { max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.close();
  schemas.push(schema);
  const url = new URL(BASE);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.href;
}
test.after(async () => {
  if (!BASE) return;
  const { createDb } = await dbModule();
  const admin = await createDb(BASE, { max: 1 });
  for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.close();
});
const row = async (db, id) => (await db.query('SELECT id, customer, expires_at, revoked_at, agent_issued_at, lanes FROM server_tokens WHERE id = $1', [id])).rows[0] ?? null;

test('the console over the Postgres store: auto writes, every action in server_tokens and read back from it, audited, no tokens.json', { skip }, async t => {
  const url = await freshUrl();
  const { createDb } = await dbModule();
  const db = await createDb(url, { max: 1 });
  t.after(() => db.close());
  const env = makeEnv({ licenseWrites: 'auto', databaseUrl: url });
  const c = await startConsole(env);
  t.after(() => c.close());
  assert.equal(c.app.parts.licenses.backend, 'postgres');
  assert.ok(c.logs.some(l => l.includes('"console":"token-store","event":"db-migrated","version":"0001"')), 'the migrations applied at start');
  assert.ok(c.logs.some(l => l.includes('"console":"token-store","event":"tokens-store","backend":"postgres"')));
  assert.ok(!c.logs.some(l => l.includes('127.0.0.1:55432') || l.includes('search_path')), 'the URL is never logged');
  // auto writes: the Postgres store has renew and setLanes
  assert.deepEqual((await c.get('/api/meta')).body.capabilities, { issue: true, revoke: true, agentRotate: true, renew: true, lanes: true, readOnly: null });
  assert.deepEqual((await c.get('/api/licenses')).body.licenses, []);

  let r = await c.post('/api/licenses', { customer: 'Cliente Delta', days: 30, lanes: ['odc'], confirm: 'Cliente Delta' });
  assert.equal(r.status, 201);
  assert.match(r.body.secret.token, SECRET);
  assert.match(r.body.secret.agentCredential, SECRET);
  const delta = r.body.license;
  let rec = await row(db, delta.id);
  assert.equal(rec.customer, 'Cliente Delta');
  assert.deepEqual(rec.lanes, ['odc']);
  assert.equal(new Date(rec.expires_at).toISOString(), delta.expiresAt);
  assert.equal(rec.revoked_at, null);

  r = await c.post(`/api/licenses/${delta.id}/renew`, { days: 10, confirm: 'Cliente Delta', expectExpiresAt: delta.expiresAt });
  assert.equal(r.status, 200);
  assert.equal(r.body.previousExpiresAt, delta.expiresAt);
  rec = await row(db, delta.id);
  assert.equal(new Date(rec.expires_at).toISOString(), r.body.expiresAt);
  assert.ok(Date.parse(r.body.expiresAt) > Date.parse(delta.expiresAt));

  r = await c.post(`/api/licenses/${delta.id}/lanes`, { lanes: ['odc', 'o11'], confirm: 'Cliente Delta', expectLanes: ['odc'] });
  assert.equal(r.status, 200);
  assert.deepEqual((await row(db, delta.id)).lanes, ['odc', 'o11']);
  r = await c.post(`/api/licenses/${delta.id}/lanes`, { lanes: ['odc', 'o11'], confirm: 'Cliente Delta', expectLanes: ['odc', 'o11'] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'NO_CHANGE');

  const issuedAt = (await row(db, delta.id)).agent_issued_at;
  await sleep(5);
  r = await c.post(`/api/licenses/${delta.id}/agent-rotate`, { confirm: 'Cliente Delta' });
  assert.equal(r.status, 200);
  assert.match(r.body.secret.agentCredential, SECRET);
  assert.notEqual(new Date((await row(db, delta.id)).agent_issued_at).getTime(), new Date(issuedAt).getTime());

  r = await c.post(`/api/licenses/${delta.id}/revoke`, { confirm: 'Cliente Delta' });
  assert.equal(r.status, 200);
  assert.equal(r.body.license.state, 'revoked');
  rec = await row(db, delta.id);
  assert.ok(rec.revoked_at, 'revoked in the table');
  r = await c.post(`/api/licenses/${delta.id}/revoke`, { confirm: 'Cliente Delta' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ALREADY_REVOKED');
  r = await c.post(`/api/licenses/${delta.id}/agent-rotate`, { confirm: 'Cliente Delta' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'TOKEN_NOT_ACTIVE');

  assert.deepEqual(auditLines(env).map(l => [l.action, l.result, l.code]),
    [['issue', 'ok', null], ['renew', 'ok', null], ['lanes', 'ok', null], ['lanes', 'error', 'NO_CHANGE'], ['agent-rotate', 'ok', null], ['revoke', 'ok', null],
      ['revoke', 'error', 'ALREADY_REVOKED'], ['agent-rotate', 'error', 'TOKEN_NOT_ACTIVE']]);
  assert.ok(auditLines(env).every(l => l.token === delta.id && l.customer === 'Cliente Delta'));
  assert.ok(!fs.existsSync(path.join(env.serverDir, 'tokens.json')), 'no tokens.json with the database');
  assert.ok(!fs.existsSync(path.join(env.serverDir, 'tokens.json.lock')));
  // the public view of the image's own store, as ssam-admin lists it
  const { createPgTokenStore } = await pgModule();
  const other = createPgTokenStore({ db: await createDb(url, { max: 1 }) });
  await other.ready();
  t.after(() => other.close());
  const listed = other.list().find(x => x.id === delta.id);
  assert.equal(listed.state, 'revoked');
  assert.deepEqual(listed.lanes, ['odc', 'o11']);
  // nothing secret-shaped in the state dir or the logs
  for (const l of c.logs) assert.ok(!SECRET.test(l), 'secret in a log line');
});

test('a change made by another store (the CLI on the VPS) is an "externo" history line within a second', { skip }, async t => {
  const url = await freshUrl();
  const { createDb } = await dbModule();
  const { createPgTokenStore } = await pgModule();
  const cli = createPgTokenStore({ db: await createDb(url, { max: 1 }) });
  // the CLI's store applies the migrations in production (openTokenStore); here the console does, so it starts first
  const env = makeEnv({ databaseUrl: url });
  const c = await startConsole(env);
  t.after(() => c.close());
  await c.app.tickAll();   // the first snapshot (records nothing); the changes below are compared against it
  await cli.ready();
  t.after(() => cli.close());
  const alfa = await cli.issue({ customer: 'Cliente Alfa', days: 30, lanes: ['odc', 'o11'] });
  await sleep(1200);
  await c.app.tickAll();
  let history = (await c.get('/api/history')).body.entries;
  assert.deepEqual(history.map(e => [e.action, e.actor, e.token]), [['issue', 'externo', alfa.id]]);
  await cli.revoke(alfa.id);
  await sleep(1200);
  await c.app.tickAll();
  history = (await c.get('/api/history')).body.entries;
  assert.deepEqual(history.map(e => [e.action, e.actor]), [['revoke', 'externo'], ['issue', 'externo']]);
  assert.equal((await c.get('/api/licenses')).body.licenses.find(l => l.id === alfa.id).state, 'revoked');
  // and the console's own revoke on a record the CLI revoked meanwhile is refused as such
  const r = await c.post(`/api/licenses/${alfa.id}/revoke`, { confirm: 'Cliente Alfa' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'ALREADY_REVOKED');
});

test('a database that cannot be reached: the console starts read-only (every capability off, 503 on the list) and says so in the log', { skip }, async t => {
  const url = new URL(BASE);
  url.port = '1';
  const env = makeEnv({ databaseUrl: url.href });
  const c = await startConsole(env);
  t.after(() => c.close());
  assert.equal(c.app.parts.licenses.backend, 'file', 'no store: the default word');
  // the migrations run first (a connection error keeps its own code); a store that loads no snapshot is STORE_UNAVAILABLE
  const failed = c.logs.find(l => l.includes('"console":"token-module-failed"'));
  assert.match(failed, /"code":"(ECONNREFUSED|STORE_UNAVAILABLE)"/);
  assert.deepEqual((await c.get('/api/meta')).body.capabilities, { issue: false, revoke: false, agentRotate: false, renew: false, lanes: false, readOnly: null });
  const r = await c.get('/api/licenses');
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'STORE_UNREADABLE');
  assert.match(r.body.error.message, /^O arquivo de licenças não pode ser lido agora \((ECONNREFUSED|STORE_UNAVAILABLE)\)\.$/);
  assert.equal((await c.post('/api/licenses', { customer: 'Cliente Alfa', days: 30, lanes: ['odc'], confirm: 'Cliente Alfa' })).status, 501);
  assert.ok(!fs.existsSync(path.join(env.serverDir, 'tokens.json')));
});
