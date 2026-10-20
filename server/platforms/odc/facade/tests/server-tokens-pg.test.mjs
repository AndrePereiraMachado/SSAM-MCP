// The token store over Postgres (server-tokens-pg.mjs, db.mjs, migrations/): the same verbs, views, codes and
// messages as the tokens.json store; the migrations applied once and only once (two runners at the same time); a
// revoke done by another store (another process) seen by the snapshot within a second; two writers never losing each
// other's change; the import of a tokens.json; the CLI over SSAM_DATABASE_URL; the served HTTP endpoint authenticating
// against the database; a database that cannot be reached refused at start. Runs only with SSAM_TEST_DATABASE_URL
// (a throwaway Postgres: `docker run -d -e POSTGRES_PASSWORD=x -e POSTGRES_USER=ssam -e POSTGRES_DB=ssam -p 127.0.0.1:55432:5432 postgres:17-alpine`
// and SSAM_TEST_DATABASE_URL=postgres://ssam:x@127.0.0.1:55432/ssam). Every test works in a schema of its own.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createDb, migrate, migrationStatus, listMigrations, databaseUrl, redactUrl, dbCli } from '../db.mjs';
import { createPgTokenStore, rowOf } from '../server-tokens-pg.mjs';
import { createTokenStore, openTokenStore, runTokenCli, tokenCli, AGENT_PREFIX, TOKEN_PREFIX } from '../server-tokens.mjs';
import { startHttpServer } from '../http-server.mjs';

const BASE = process.env.SSAM_TEST_DATABASE_URL ?? null;
const skip = BASE ? false : 'SSAM_TEST_DATABASE_URL is not set';
const hex = text => createHash('sha256').update(text).digest('hex');
const T0 = new Date('2026-10-20T12:00:00.000Z');
const clockAt = start => { let t = start.getTime(); return { now: () => new Date(t), advance: ms => { t += ms; } }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const VIEW_KEYS = ['agent', 'createdAt', 'customer', 'expiresAt', 'id', 'lanes', 'state'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-tokens-pg-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A URL whose connections live in a fresh schema (search_path), dropped at the end of the test.
const schemas = [];
async function freshUrl() {
  const schema = 'ssam_test_' + randomBytes(4).toString('hex');
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
  const admin = await createDb(BASE, { max: 1 });
  for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.close();
});
const refuses = (fn, code, message) => assert.rejects(fn, error => { assert.equal(error.code, code); if (message) assert.equal(error.message, message); return true; });

test('databaseUrl: unset is null; a postgres URL passes; anything else is DB_URL_INVALID; redactUrl hides the password', () => {
  assert.equal(databaseUrl({}), null);
  assert.equal(databaseUrl({ SSAM_DATABASE_URL: '  ' }), null);
  assert.equal(databaseUrl({ SSAM_DATABASE_URL: 'postgres://u:p@h:5432/d' }), 'postgres://u:p@h:5432/d');
  assert.equal(databaseUrl({ SSAM_DATABASE_URL: 'postgresql://u:p@h/d?sslmode=require' }), 'postgresql://u:p@h/d?sslmode=require');
  assert.throws(() => databaseUrl({ SSAM_DATABASE_URL: 'mysql://x' }), error => error.code === 'DB_URL_INVALID');
  assert.throws(() => databaseUrl({ SSAM_DATABASE_URL: 'not a url' }), error => error.code === 'DB_URL_INVALID');
  assert.equal(redactUrl('postgres://ssam:secret@postgres:5432/ssam'), 'postgres://ssam:***@postgres:5432/ssam');
  assert.equal(listMigrations()[0].version, '0001');
  assert.equal(listMigrations()[0].name, 'server-tokens');
  const row = rowOf({ id: 'tok_1', customer: 'C', createdAt: T0.toISOString(), sha256: 'ab', lanes: ['odc'] });
  assert.equal(row[0], 'tok_1'); assert.equal(row[3], null); assert.deepEqual(row[8], ['odc']); assert.equal(JSON.parse(row[9]).id, 'tok_1');
});

test('migrate applies each file once, records it, and two runners at once still apply it once', { skip }, async () => {
  const url = await freshUrl();
  const a = await createDb(url, { max: 2 }); const b = await createDb(url, { max: 2 });
  try {
    const before = await migrationStatus(a);
    assert.deepEqual(before.applied, []);
    assert.deepEqual(before.pending.map(m => m.version), ['0001']);
    const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
    assert.deepEqual([...ra.applied, ...rb.applied], ['0001']);
    const after = await migrationStatus(a);
    assert.deepEqual(after.applied.map(m => m.version), ['0001']);
    assert.deepEqual(after.pending, []);
    assert.deepEqual((await migrate(a)).applied, []);
    const columns = (await a.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'server_tokens' ORDER BY ordinal_position")).rows.map(r => r.column_name);
    assert.deepEqual(columns, ['id', 'customer', 'created_at', 'expires_at', 'revoked_at', 'token_sha256', 'agent_sha256', 'agent_issued_at', 'lanes', 'record', 'updated_at']);
  } finally { await a.close(); await b.close(); }
});

test('the Postgres store: issue, verify, verifyAgent, agent-rotate, renew, lanes, revoke, with the file store\'s views, codes and messages', { skip }, async () => {
  const url = await freshUrl();
  const db = await createDb(url); await migrate(db);
  const clock = clockAt(T0);
  const store = createPgTokenStore({ db, now: clock.now, refreshMs: 50 });
  try {
    await store.ready();
    assert.equal(store.backend, 'postgres');
    assert.deepEqual(store.list(), []);
    const issued = await store.issue({ customer: ' Cliente Um ', days: 30, lanes: 'odc' });
    assert.ok(issued.token.startsWith(TOKEN_PREFIX) && !issued.token.startsWith(AGENT_PREFIX));
    assert.ok(issued.agentCredential.startsWith(AGENT_PREFIX));
    assert.equal(issued.customer, 'Cliente Um');
    assert.deepEqual(issued.lanes, ['odc']);
    assert.equal(issued.expiresAt, new Date(T0.getTime() + 30 * 86400000).toISOString());
    assert.deepEqual(Object.keys(issued).filter(k => k !== 'token' && k !== 'agentCredential').sort(), VIEW_KEYS);
    // Only hashes in the table.
    const row = (await db.query('SELECT token_sha256, agent_sha256, record FROM server_tokens')).rows[0];
    assert.equal(row.token_sha256, hex(issued.token));
    assert.equal(row.agent_sha256, hex(issued.agentCredential));
    assert.equal(JSON.stringify(row.record).includes(issued.token), false);
    assert.equal(row.record.sha256, hex(issued.token));
    // Readers over the snapshot the write left.
    assert.deepEqual(store.verify(issued.token), { status: 'ok', id: issued.id, customer: 'Cliente Um', lanes: ['odc'] });
    assert.deepEqual(store.verify(issued.agentCredential), { status: 'unknown' });
    assert.equal(store.verifyAgent(issued.agentCredential).status, 'ok');
    assert.equal(store.verifyAgent(issued.agentCredential).agentSha256, hex(issued.agentCredential));
    assert.equal(store.verifyAgent(issued.token).status, 'unknown');
    assert.equal(store.stateOf(issued.id), 'active');
    assert.equal(store.stateOf('tok_nope'), 'unknown');
    assert.deepEqual(store.lookup(issued.id), { id: issued.id, customer: 'Cliente Um', state: 'active', lanes: ['odc'], credential: true, agentSha256: hex(issued.agentCredential) });
    assert.equal(store.lookup('tok_nope'), null);
    // Refusals before any transaction: the file store's codes and messages.
    await refuses(() => store.issue({ customer: '' }), 'INVALID_CUSTOMER', 'customer: 1-64 letters, digits, space, dot, dash or underscore');
    await refuses(() => store.issue({ customer: 'X', days: 0 }), 'INVALID_DAYS', 'days: an integer from 1 to 3650');
    await refuses(() => store.issue({ customer: 'X', lanes: 'web' }), 'INVALID_LANES', 'lanes: odc, o11 or odc,o11');
    await refuses(() => store.revoke('tok_nope'), 'UNKNOWN_TOKEN', 'Unknown token id: tok_nope');
    // agent-rotate: the old credential stops, the new one holds.
    const rotated = await store.agentRotate(issued.id);
    assert.equal(store.verifyAgent(issued.agentCredential).status, 'unknown');
    assert.equal(store.verifyAgent(rotated.agentCredential).status, 'ok');
    assert.equal(store.verify(issued.token).status, 'ok');
    // renew and lanes.
    const renewed = await store.renew(issued.id, { days: 10 });
    assert.equal(renewed.previousExpiresAt, issued.expiresAt);
    assert.equal(renewed.expiresAt, new Date(T0.getTime() + 40 * 86400000).toISOString());
    await refuses(() => store.renew(issued.id, { days: 4000 }), 'INVALID_DAYS');
    const lanes = await store.setLanes(issued.id, 'odc,o11');
    assert.deepEqual(lanes.previousLanes, ['odc']);
    assert.deepEqual(store.verify(issued.token).lanes, ['odc', 'o11']);
    const same = await store.setLanes(issued.id, 'o11,odc');
    assert.deepEqual(same.lanes, ['odc', 'o11']);
    // expiry by the clock, then revoke kills both secrets; a second revoke changes nothing.
    clock.advance(41 * 86400000);
    assert.equal(store.verify(issued.token).status, 'expired');
    await refuses(() => store.agentRotate(issued.id), 'TOKEN_NOT_ACTIVE', 'Token ' + issued.id + ' is expired; issue a new one instead.');
    const revoked = await store.revoke(issued.id);
    assert.equal(revoked.state, 'revoked');
    assert.equal(store.verify(issued.token).status, 'revoked');
    assert.equal(store.verifyAgent(rotated.agentCredential).status, 'revoked');
    assert.equal((await store.revoke(issued.id)).revokedAt, revoked.revokedAt);
    await refuses(() => store.renew(issued.id, { days: 1 }), 'TOKEN_REVOKED', 'Token ' + issued.id + ' is revoked; issue a new one instead.');
    await refuses(() => store.setLanes(issued.id, 'odc'), 'TOKEN_REVOKED');
    assert.equal(store.list().length, 1);
    assert.deepEqual(Object.keys(store.list()[0]).sort(), [...VIEW_KEYS, 'revokedAt'].sort());
  } finally { await store.close(); }
});

test('another process\'s revoke is seen by the snapshot within refreshMs; two writers at once lose nothing', { skip }, async () => {
  const url = await freshUrl();
  const dbA = await createDb(url); await migrate(dbA);
  const dbB = await createDb(url);
  const a = createPgTokenStore({ db: dbA, refreshMs: 100 });
  const b = createPgTokenStore({ db: dbB, refreshMs: 100 });
  try {
    await a.ready(); await b.ready();
    const one = await a.issue({ customer: 'One' });
    // b has not seen it yet: a read older than refreshMs triggers a refresh in the background, and the next read sees it.
    const until = async (store, status) => { const deadline = Date.now() + 1500; while (Date.now() < deadline) { if (store.verify(one.token).status === status) return true; await sleep(50); } return false; };
    assert.equal(await until(b, 'ok'), true, 'b sees the token issued by a');
    await b.revoke(one.id);
    assert.equal(a.verify(one.token).status, 'ok', 'a still answers from its snapshot');
    assert.equal(await until(a, 'revoked'), true, 'the revoke is seen within about a second');
    // Two writers at once: every record survives.
    const results = await Promise.all([a.issue({ customer: 'Two' }), b.issue({ customer: 'Three' }), a.issue({ customer: 'Four' }), b.issue({ customer: 'Five' })]);
    await a.refresh();
    assert.deepEqual(a.list().map(t => t.customer).sort(), ['Five', 'Four', 'One', 'Three', 'Two']);
    for (const r of results) assert.equal(a.verify(r.token).status, 'ok');
  } finally { await a.close(); await b.close(); }
});

test('import copies a tokens.json into the database, idempotently; the CLI runs over SSAM_DATABASE_URL; db migrate|status', { skip }, async () => {
  const url = await freshUrl();
  const dir = path.join(tmp, 'import'); fs.mkdirSync(dir);
  const file = createTokenStore(dir);
  const x = file.issue({ customer: 'From File', days: 5 });
  const y = file.issue({ customer: 'Phase One' });
  file.revoke(y.id);
  const env = { SSAM_SERVER_DIR: dir, SSAM_DATABASE_URL: url };
  // The CLI refuses import without the database, and migrates by itself with it.
  assert.throws(() => tokenCli(['import', '--from', file.file], { root: dir, env: { SSAM_SERVER_DIR: dir } }), error => error.code === 'USAGE');
  const imported = await runTokenCli(['import', '--from', file.file], { root: dir, env });
  assert.equal(imported.ok, true); assert.equal(imported.imported, 2); assert.equal(imported.total, 2);
  const again = await runTokenCli(['import', '--from', file.file], { root: dir, env });
  assert.equal(again.total, 2);
  const listed = await runTokenCli(['list'], { root: dir, env });
  assert.equal(listed.database, true);
  assert.deepEqual(listed.tokens.map(t => [t.customer, t.state]).sort(), [['From File', 'active'], ['Phase One', 'revoked']]);
  // The imported hashes verify in the database store.
  const store = await openTokenStore({ dir, env });
  try {
    assert.equal(store.backend, 'postgres');
    assert.equal(store.verify(x.token).status, 'ok');
    assert.equal(store.verifyAgent(x.agentCredential).status, 'ok');
    assert.equal(store.verify(y.token).status, 'revoked');
  } finally { await store.close(); }
  const issued = await runTokenCli(['issue', '--customer', 'Via CLI', '--lanes', 'o11'], { root: dir, env });
  assert.ok(issued.token.startsWith(TOKEN_PREFIX));
  assert.equal(JSON.stringify(await runTokenCli(['list'], { root: dir, env })).includes(issued.token), false);
  const revoked = await runTokenCli(['revoke', '--id', issued.id], { root: dir, env });
  assert.equal(revoked.revoked.state, 'revoked');
  await refuses(() => runTokenCli(['revoke', '--id', 'tok_nope'], { root: dir, env }), 'UNKNOWN_TOKEN');
  // The file was not changed by the import.
  assert.equal(JSON.parse(fs.readFileSync(file.file, 'utf8')).tokens.length, 2);
  const status = await dbCli(['status'], { env });
  assert.deepEqual(status.applied.map(m => m.version), ['0001']);
  assert.equal(status.database.includes('***') || !/:[^:@/]+@/.test(status.database), true);
  assert.deepEqual((await dbCli(['migrate'], { env })).appliedNow, []);
  await refuses(() => dbCli(['status'], { env: {} }), 'DB_URL_MISSING');
});

test('the served endpoint authenticates against the database, sees a revoke from the CLI, and refuses to start without the database', { skip }, async () => {
  const url = await freshUrl();
  const dir = path.join(tmp, 'served'); fs.mkdirSync(dir);
  const env = { SSAM_SERVER_DIR: dir, SSAM_DATABASE_URL: url };
  const log = [];
  const server = await startHttpServer({ createServer: () => { throw new Error('no session in this test'); }, dir, port: 0, env, log: e => log.push(e) });
  try {
    assert.ok(log.some(e => e.event === 'tokens-store' && e.backend === 'postgres' && !String(e.database).includes('@127') || String(e.database ?? '').includes('***')), 'the store is logged without its password');
    const base = `http://127.0.0.1:${server.port}`;
    const ask = (token, body = { jsonrpc: '2.0', id: 1, method: 'ping' }) => new Promise((resolve, reject) => {
      const req = http.request(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    assert.equal(await ask('ssam_unknown'), 401);
    const issued = await runTokenCli(['issue', '--customer', 'Served'], { root: dir, env });
    await sleep(1200);
    assert.notEqual(await ask(issued.token), 401, 'a token issued by another process is accepted within a second');
    await runTokenCli(['revoke', '--id', issued.id], { root: dir, env });
    await sleep(1200);
    assert.equal(await ask(issued.token), 403);
  } finally { await server.close(); }
  const bad = { ...env, SSAM_DATABASE_URL: 'postgres://ssam:x@127.0.0.1:1/ssam' };
  await assert.rejects(() => startHttpServer({ createServer: () => {}, dir, port: 0, env: bad }), error => /ECONNREFUSED|connect|timeout/i.test(String(error.message)) || error.code === 'STORE_UNAVAILABLE');
});
