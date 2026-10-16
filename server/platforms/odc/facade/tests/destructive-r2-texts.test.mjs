import './fixtures/isolated-profile.mjs';
// CX15 r2, family F4 (texts and contract): T6 (the catalog of solution-delete and db-connection-delete is the two-call
// contract of the other deletes, the description of execute names them, and another operationId comes in the SAME refusal
// as every problem of checkExecute), T7 (studio_data_delete says the whole common suffix, in its order) and F4.4 (one
// source: every destructive description interpolates the texts of destructive-operations.mjs and copies none; the guides,
// which are served as text, say them exactly; no server text is a ready confirmation phrase). Offline: fake bridge, fake
// clock, synthetic names (the reviewers' text-hosted A6, A7 and A10).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as destructive from '../destructive-operations.mjs';
import { registerO11Operations } from '../o11-operations.mjs';
import { registerO11Environment } from '../o11-environment.mjs';
import { registerO11Extension } from '../o11-extension.mjs';
import { registerAccessTools } from '../odc-access.mjs';
import { registerExternalLibrary } from '../odc-external-library.mjs';
import { registerSsamTask } from '../ssam-task.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { o11DataRequestSchema } from '../ssam.mjs';
import { loadToolRoutes } from '../tool-routing.mjs';
import { Journal } from '../service-center/client.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { FakeBridge, SC, fixture, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock, noBackup } from './fixtures/destructive-flow.mjs';

const FACADE = path.join(import.meta.dirname, '..');
const { CONFIRM_MIN_AGE_MS } = destructive;
// (Read through the namespace so the suite runs, and fails on behavior, on the commit before the fix.)
const WORDS_RULE = destructive.WORDS_RULE ?? "The words are the owner's next message after the list, copied whole: never write, complete, translate or reuse words yourself "
  + '(not the request, not a template, not a reply to another list); without such a message, ask the owner and stop.';
const AFTER_INTERRUPTION = destructive.AFTER_INTERRUPTION ?? "Interrupted, CANCELLED, SC_LOCAL_FAILURE or another local failure, 'rejected' or no answer: read ssam_task {id:<operationId from the preview>} before telling the owner "
  + 'anything; never say nothing happened without it.';
const DESTRUCTIVE_SUFFIX = destructive.DESTRUCTIVE_SUFFIX ?? 'Deletes take two calls: without confirmationToken the call only previews (the exact list with its count; nothing is sent); '
  + "show the owner that EXACT list and ask; then call again with confirmationToken and the owner's reply, which states the number of items and names "
  + `the targets. ${WORDS_RULE} ${AFTER_INTERRUPTION}`;
// The sentences of the common suffix: each one is checked on its own, so a failure names the one missing.
const sentences = text => text.split(/(?<=\.)\s+(?=[A-Z])/).map(s => s.trim()).filter(Boolean);
// A ready phrase of confirmation: a yes followed by a delete verb and a number ("sim, apaga os 3 ZZ").
const READY = /\b(sim|yes|ok|pode|confirmo|confirm)\b[^"\n]{0,30}\b(apag|delet|exclu|remov|discard|undeploy)\w*[^"\n]{0,30}\b\d+\b/i;

// Every description of a destructive tool, as the model reads it (the registration, or the listing of the facade server).
async function descriptions() {
  const out = {};
  const capture = { registerTool: (name, config) => { out[name] = [config.description, JSON.stringify(config.inputSchema ?? {})].join('\n'); } };
  registerO11Operations(capture, schema => schema, {});
  registerO11Environment(capture, {});
  registerO11Extension(capture, {});
  registerAccessTools(capture, {}, fn => fn);
  registerExternalLibrary(capture, { access: {}, wrap: fn => fn });
  registerSsamTask(capture, {});
  const server = await createFacadeServer({ deps: {} });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15-r2-texts', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try { for (const tool of (await client.listTools()).tools) if (['studio_data_delete', 'studio_command'].includes(tool.name)) out[tool.name] = tool.description + '\n' + JSON.stringify(tool.inputSchema); }
  finally { await client.close(); await server.close(); }
  out.o11_data = JSON.stringify(o11DataRequestSchema);
  return out;
}
// CX15 r3 (CT-8): the catalog as it is loaded and served; its two-call texts are generated (the file holds a marker).
const catalog = () => loadToolRoutes().data.tools;

// ---- T6
const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
function connection() {
  const s = { dir: temp(), clock: fakeClock(), ids: 0, posts: [] };
  s.root = path.join(s.dir, 'destructive');
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.bridge = new FakeBridge({ pages: {
    [`GET ${SC}DatabaseConnections_List.aspx`]: () => (s.posts.length ? '<table><tr><th>Name</th></tr></table><p>No connections found</p>' : fixture('db-connections.html')),
    [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: fixture('db-connection-edit.html'),
    [`POST ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: f => { s.posts.push(f.__EVENTTARGET); return fixture('db-connections.html'); } } });
  const deps = { journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false, opener: () => assert.fail('no prompt'),
    exports: s.dir, registry: REGISTRY, sleep: async () => {}, clock: s.clock, destructiveRoot: s.root,
    previewUuid: () => `00000000-0000-4000-8000-${String(++s.ids).padStart(12, '0')}`, backup: noBackup };
  s.run = (...argv) => runServiceCenter(['db-connection-delete', '--host', PERSONAL, '--connection', 'LegacyERP', ...argv], deps)
    .catch(error => ({ ok: false, code: error.code, error: error.message, problems: error.problems ?? [] }));
  return s;
}
const codes = answer => (answer.problems ?? []).map(p => p.code).sort();

test('T6: a page delete confirmed with another operationId is ONE refusal with every problem of checkExecute (with or without words); nothing posted', async () => {
  const s = connection();
  const preview = await s.run();
  assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 300));
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const other = '11111111-2222-4333-8444-555555555555';
  const vague = await s.run('--confirmation-token', preview.confirmationToken, '--operation-id', other, '--words', 'vai la deleta');
  assert.equal(vague.code, 'DELETE_REFUSED', JSON.stringify(vague).slice(0, 400));
  assert.deepEqual(codes(vague), ['CONFIRMATION_COUNT_MISMATCH', 'PREVIEW_OTHER_TARGET', 'WORDS_MUST_NAME']);
  assert.match(vague.problems.find(p => p.code === 'PREVIEW_OTHER_TARGET').fix, /operationId/);
  // Without words: the same one refusal, never a refusal of one field and then another.
  const bare = await s.run('--confirmation-token', preview.confirmationToken, '--operation-id', other);
  assert.equal(bare.code, 'DELETE_REFUSED', JSON.stringify(bare).slice(0, 400));
  assert.deepEqual(codes(bare), ['CONFIRMATION_COUNT_MISMATCH', 'PREVIEW_OTHER_TARGET', 'WORDS_MUST_NAME']);
  assert.deepEqual(s.posts, [], 'nothing posted');
  // The owner's reply, with the preview's own operationId, executes.
  const done = await s.run('--confirmation-token', preview.confirmationToken, '--operation-id', preview.operationId, '--words', 'pode apagar a 1 LegacyERP');
  assert.deepEqual([done.state, done.operationId, s.posts.length], ['confirmed', preview.operationId, 1], JSON.stringify(done).slice(0, 400));
});

// The stale contract of a delete: execute and a new operationId, prepare-then-execute, the words before the list.
const STALE = /execute once|execute:\s*true|new UUID|a NEW operationUuid|<user's own words>|prepares\/simulates by default|prepare first/i;
const PREVIEW_ONLY = /^(words|authorize|authorization|operationUuid|operationId|execute|confirmationToken)$/;

test('T6: the catalog routes of solution-delete and db-connection-delete are the two calls of the other deletes; execute names them', () => {
  const verbs = catalog().o11_service_center_write.verbs;
  const common = verbs.delete.next.slice(0, verbs.delete.next.indexOf('before telling the owner anything'));
  for (const verb of ['solution-delete', 'db-connection-delete']) {
    const v = verbs[verb];
    const text = [v.when, ...(v.preconditions ?? []), v.next].join('\n');
    assert.ok(v.next.startsWith(common), `${verb}: the next of every delete (${v.next.slice(0, 80)}...)`);
    assert.doesNotMatch(text, STALE, verb);
    assert.deepEqual(Object.keys(v.args).filter(k => PREVIEW_ONLY.test(k)), [], `${verb}: the template is the preview`);
  }
  const schema = {};
  registerO11Operations({ registerTool: (name, config) => { schema[name] = config.inputSchema; } }, s => s, {});
  const execute = schema.o11_service_center_write.properties.execute.description;
  for (const verb of ['solution-delete', 'db-connection-delete']) assert.match(execute, new RegExp(verb), 'the description of execute names ' + verb);
  assert.match(execute, /confirmationToken/);
});

// ---- T7
// A call with the token: an argument object that carries it, or "with confirmationToken".
const TOKEN_CALL = /\{[^{}]*confirmationToken[^{}]*\}|\bwith confirmationToken\b/g;
const tokenCallsBeforeShow = text => { const show = text.indexOf('show the owner'); return show < 0 ? ['no "show the owner"'] : [...text.matchAll(TOKEN_CALL)].filter(m => m.index < show).map(m => m[0]); };

test('T7: studio_data_delete says the whole common suffix in its order: the preview, show the owner, then the call with the token', async () => {
  const d = (await descriptions()).studio_data_delete.split('\n')[0];
  for (const sentence of sentences(DESTRUCTIVE_SUFFIX)) assert.ok(d.includes(sentence), 'missing: ' + sentence);
  assert.ok([...d.matchAll(TOKEN_CALL)].length > 0, d);
  assert.deepEqual(tokenCallsBeforeShow(d), [], 'every call with the token comes after "show the owner": ' + d);
});

test('T7, the family: no destructive description shows the call with the token before "show the owner"', async () => {
  const texts = await descriptions();
  const found = [];
  for (const entry of destructive.DESTRUCTIVE_TOOLS) {
    if (entry.refuse || entry.tool === 'o11_data') continue; // studio_command refuses; o11_data says it in its schema (checked by destructive-texts)
    const before = tokenCallsBeforeShow(texts[entry.tool].split('\n')[0]);
    if (before.length) found.push(`${entry.tool}: ${before.join(' | ')}`);
  }
  assert.deepEqual(found, []);
});

// ---- F4.4
const DESCRIPTION_FILES = ['odc-access.mjs', 'o11-operations.mjs', 'o11-environment.mjs', 'o11-extension.mjs', 'odc-external-library.mjs', 'mcp.mjs', 'ssam.mjs', 'ssam-task.mjs'];
// The pieces of the common texts a hand copy would carry (between ; : and parentheses, long enough to be distinctive).
const pieces = [...new Set([DESTRUCTIVE_SUFFIX].flatMap(t => t.split(/[;:()]|\. /)).map(s => s.trim()).filter(s => s.length >= 30))];

test('F4.4: one source: the description files interpolate the texts of destructive-operations.mjs and copy none of them', () => {
  assert.ok(pieces.length >= 6, pieces.join(' | '));
  const copies = [];
  for (const file of DESCRIPTION_FILES) {
    const source = fs.readFileSync(path.join(FACADE, file), 'utf8').replace(/\\'/g, "'");
    for (const piece of pieces) if (source.includes(piece)) copies.push(`${file}: "${piece}"`);
  }
  assert.deepEqual(copies, []);
});

test('F4.4: the guides (served as text) say the rule of the words and the step after an interruption exactly as the tools', () => {
  for (const guide of ['o11.md', 'odc.md']) {
    const text = fs.readFileSync(path.join(FACADE, 'guides', guide), 'utf8');
    for (const sentence of [WORDS_RULE, AFTER_INTERRUPTION]) assert.ok(text.includes(sentence), `${guide}: ${sentence.slice(0, 60)}...`);
  }
});

test('F4.4: no server text is a ready confirmation phrase: the descriptions, the guides and the catalog routes of every delete', async () => {
  const found = [];
  for (const [name, text] of Object.entries(await descriptions())) if (READY.test(text)) found.push(`${name}: ${READY.exec(text)[0]}`);
  for (const guide of ['o11.md', 'odc.md', 'lifecycle.md']) { const text = fs.readFileSync(path.join(FACADE, 'guides', guide), 'utf8'); if (READY.test(text)) found.push(`${guide}: ${READY.exec(text)[0]}`); }
  const tools = catalog();
  for (const entry of destructive.DESTRUCTIVE_TOOLS) {
    const text = JSON.stringify(tools[entry.tool]);
    if (READY.test(text)) found.push(`catalog ${entry.tool}: ${READY.exec(text)[0]}`);
  }
  assert.deepEqual(found, []);
});
