// Lane D1 of the 2026-10-05 session package: standing grants (contract I6) and the ssam_grant tool registered with
// o11_publish. Temporary files only; no Studio (the publication runs against a fake bridge client).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { GRANTS_SCHEMA, grantsFile, addGrant, findGrant, revokeGrant, listGrants, namesApp, wordsFor } from '../standing-grants.mjs';
import { registerO11Publish, createO11Publish } from '../o11-publish.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacote-d1-grants-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('a grant is written, found, listed without its words and revoked', t => {
  const file = path.join(temp(t), 'grants', 'standing-grants.json');
  const words = 'pode entregar e publicar o OfficePet sempre que precisar';
  const added = addGrant({ lane: 'o11', app: 'OfficePet', words }, { file, now: () => new Date('2026-10-05T10:00:00Z') });
  assert.equal(added.ok, true);
  assert.deepEqual(added.grant.verbs, ['deliver', 'publish']); assert.equal(added.grant.modules, '*');
  assert.equal(added.grant.words, undefined); assert.equal(added.grant.wordsSha256, sha256(words));
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.schema, GRANTS_SCHEMA);
  // By app (any module of it), by the verb; never another lane or verb.
  assert.equal(findGrant({ lane: 'o11', app: 'officepet', module: 'OfficePetMobile', verb: 'publish' }, { file }).grantId, added.grant.grantId);
  assert.equal(findGrant({ lane: 'odc', app: 'OfficePet', verb: 'publish' }, { file }), null);
  assert.equal(findGrant({ lane: 'o11', module: 'OfficePetMobile', verb: 'deliver' }, { file }), null, 'no app known and the module is not listed');
  const modules = addGrant({ lane: 'o11', app: 'GameStore', modules: ['GameStore_CS'], verbs: ['deliver'], words: 'pode entregar no GameStore' }, { file, now: () => new Date('2026-10-05T11:00:00Z') });
  assert.equal(findGrant({ lane: 'o11', module: 'GameStore CS', verb: 'deliver' }, { file }).grantId, modules.grant.grantId, 'a listed module by its letters and digits');
  assert.equal(findGrant({ lane: 'o11', module: 'GameStore_CS', verb: 'publish' }, { file }), null);
  const listed = listGrants({ lane: 'o11' }, { file });
  assert.equal(listed.grants.length, 2); assert.equal(listed.grants[0].grantId, modules.grant.grantId, 'newest first');
  assert.ok(!JSON.stringify(listed).includes(words), 'a listing never shows the words');
  assert.deepEqual(revokeGrant({ grantId: modules.grant.grantId }, { file }), { ok: true, revoked: 1 });
  assert.deepEqual(revokeGrant({ lane: 'o11', app: 'OfficePet' }, { file }), { ok: true, revoked: 1 });
  assert.deepEqual(listGrants({}, { file }).grants, []);
  assert.equal(revokeGrant({}, { file }).code, 'GRANT_INVALID');
  assert.match(grantsFile('C:\\ws'), /[\\/]\.local[\\/]grants[\\/]standing-grants\.json$/);
});

test('the words must name the app as written; a placeholder or a bad request writes nothing', t => {
  const file = path.join(temp(t), 'standing-grants.json');
  assert.equal(addGrant({ lane: 'o11', app: 'QuizLive Core', words: 'pode criar o QuizLive' }, { file }).code, 'GRANT_WORDS_MUST_NAME_APP');
  assert.equal(addGrant({ lane: 'o11', app: 'QuizLive', words: "<the user's own words>" }, { file }).code, 'GRANT_INVALID');
  assert.equal(addGrant({ lane: 'o12', app: 'QuizLive', words: 'pode publicar o QuizLive' }, { file }).code, 'GRANT_INVALID');
  assert.equal(addGrant({ lane: 'o11', app: 'QuizLive', verbs: ['delete'], words: 'pode publicar o QuizLive' }, { file }).code, 'GRANT_INVALID');
  assert.equal(fs.existsSync(file), false);
  assert.equal(namesApp('pode publicar o quizlive core agora', 'QuizLive Core'), true);
  assert.equal(namesApp('pode publicar o QuizLiveCore', 'QuizLive'), false, 'whole words');
  assert.deepEqual(wordsFor({ authorize: 'minhas palavras', lane: 'o11', module: 'M', verb: 'publish' }, { findGrant: () => { throw new Error('not asked'); } }), { words: 'minhas palavras' });
});

test('ssam_grant is served with o11_publish; o11_publish without authorize uses the grant and names it', async t => {
  const dir = temp(t);
  const file = path.join(dir, 'grants.json');
  const server = new McpServer({ name: 'pacote-d1-grants', version: '1.0.0' });
  const events = [];
  const bridge = { async ok(method) { events.push(method);
    if (method === 'open_module') return { name: 'Orders', opened: true, alreadyOpen: true, selected: true };
    if (method === 'get_active_module') return { name: 'Orders', key: 'k', environment: 'h.example', pendingDialogs: [] };
    if (method === 'get_errors') return { isValid: true, errors: 0, rawMessages: [] };
    if (method === 'publish') return { module: 'Orders', published: true };
    throw new Error('unexpected ' + method); } };
  registerO11Publish(server, { root: dir, env: { ANVIL_LANE: 'ss4' }, lane: 'ss4', bridge, assertSelected: async () => {}, grantsFile: file, tasksDir: path.join(dir, 'tasks'),
    journal: (local, entry) => events.push(entry), inventory: () => ({ modules: [{ name: 'Orders', app: 'Orders App' }] }) });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pacote-d1-grants-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = Object.fromEntries((await client.listTools()).tools.map(x => [x.name, x]));
  assert.ok(tools.ssam_grant, 'ssam_grant is registered with o11_publish');
  assert.deepEqual(tools.ssam_grant.inputSchema.properties.action.enum, ['grant', 'revoke', 'list']);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const refused = await call('o11_publish', { module: 'Orders' });
  assert.equal(refused.code, 'WORDS_REQUIRED'); assert.ok(!events.includes('publish'));
  const words = 'pode publicar o Orders App sempre';
  const granted = await call('ssam_grant', { action: 'grant', lane: 'o11', app: 'Orders App', verbs: ['publish'], words });
  assert.equal(granted.ok, true); assert.equal(granted.grant.words, undefined);
  const bad = await call('ssam_grant', { action: 'grant', lane: 'o11', app: 'Billing', words: 'pode publicar tudo' });
  assert.equal(bad.code, 'GRANT_WORDS_MUST_NAME_APP'); assert.equal(bad.continuation.tool, 'ssam_grant');
  const published = await call('o11_publish', { module: 'Orders' });
  assert.equal(published.ok, true, JSON.stringify(published)); assert.equal(published.result, 'published');
  assert.deepEqual(published.authorization, { source: 'standing-grant', grantId: granted.grant.grantId });
  const start = events.find(e => e?.event === 'start');
  assert.equal(start.wordsSha256, sha256(words)); assert.equal(start.grantId, granted.grant.grantId);
  const list = await call('ssam_grant', { action: 'list' });
  assert.equal(list.grants.length, 1); assert.ok(!JSON.stringify(list).includes(words));
  assert.equal((await call('ssam_grant', { action: 'revoke', grantId: granted.grant.grantId })).revoked, 1);
  assert.equal((await call('o11_publish', { module: 'Orders' })).code, 'WORDS_REQUIRED');
  assert.equal(typeof createO11Publish, 'function');
});
