import './fixtures/isolated-profile.mjs';
// CX15 r7 (M-3, before r5): server templates counted as the owner's words in gates that did not use wordsGiven. The review's
// repros (C:\t\revisoes\cx15-6\review\repros): SC-1 the CREDENTIAL_PROMPT_PENDING continuation of o11_service_center_write
// (sameCall: words = "<the user's own words>") replayed sent the write once; CA-1 the WORDS_MUST_NAME_APP continuation of
// studio_create_app ("<the user's words naming X>" names X) replayed created the app; SA-1 studio_authorize recorded a
// server text (only min(8)) and studio_publish {manifest} without words then published. Now each gate decides with the one
// predicate (wordsGiven): WORDS_REQUIRED (or the gate's own refusal) and nothing sent. Fakes only, synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client as McpClient } from '@modelcontextprotocol/client';
import { sameCall } from '../service-center/index.mjs';
import { serviceCenterArguments } from '../o11-operations.mjs';
import { Transport } from '../service-center/http.mjs';
import { Client, Journal } from '../service-center/client.mjs';
import { Document, Page } from '../service-center/html.mjs';
import { temp, uuid } from './fixtures/sc-fake-bridge.mjs';
import { createStudioCreateApp } from '../studio-create-app.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { fakeBridge, delivery, BRIDGE_PID as PID, BRIDGE_HOST as HOST } from './fixtures/destructive-r5-bridge.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const SERVER_TEXTS = { marker: "<the user's own words>", legacyMarker: '<palavras do usuário>' /* input alias of the releases before 16/10 */, ownerReply: "<the owner's next message after the list, verbatim>", scTemplate: "<the user's own words>", hash: 'sha256:' + 'a'.repeat(64), punctuation: '!!! ... ???' };
const host = 'test.example.com', url = `https://${host}/ServiceCenter/eSpace_SiteProperty_Edit.aspx?SitePropertyId=7.8`;
const script = "OsAjax(arguments[0] || window.event,'apply','form$apply','','__OSVSTATE,',''); return false;";
const page = (onclick = script) => new Page(url, new Document(`<form method="post"><div class="sc-content-main"><input type="hidden" name="__OSVSTATE" value="state"><label for="value">Effective Value</label><input id="value" name="propertyValue" type="text" value="7"><input type="submit" id="apply" name="form$apply" value="Apply" onclick="${onclick}"></div></form>`));

test('M-3 (o11_service_center_write, SC-1): the CREDENTIAL_PROMPT_PENDING continuation replayed as it is is refused by the facade gate; the client never sends a server text', async () => {
  const operationId = uuid();
  const step = sameCall(['property-set', '--host=' + host, '--module-id=7', '--name=Test', '--value=9', '--execute', '--operation-id=' + operationId, '--words=sim pode ZZSC1']);
  assert.equal(step.arguments.words, "<the user's own words>");
  assert.throws(() => serviceCenterArguments(step.arguments, 'write'), /authorization words/, 'the facade gate refuses the template');
  for (const [kind, words] of Object.entries(SERVER_TEXTS)) assert.throws(() => serviceCenterArguments({ ...step.arguments, words }, 'write'), /authorization words/, kind);
  for (const [kind, words] of Object.entries(SERVER_TEXTS)) {
    let sent = 0;
    const journal = new Journal(temp()), id = uuid();
    const http = new Transport(host, { send: async () => { sent++; return { status: 200, body: Buffer.from(JSON.stringify('<div class="Feedback_Message_Success">Saved</div>')), contentType: 'text/javascript' }; } });
    const client = new Client({ host }, http);
    client.detail = async () => page("if (OsPage_ClientValidate('apply')) " + script);
    await assert.rejects(() => client.mutate('property-set', '7', 'Test', { execute: true, value: '9', words, operationId: id, journal }), /user's words/, 'client ' + kind);
    assert.equal(sent, 0, 'client ' + kind + ': nothing sent');
  }
  // The owner's words still pass the facade gate.
  assert.ok(serviceCenterArguments({ ...step.arguments, words: 'sim pode mudar Test para 9' }, 'write').some(a => a.startsWith('--words=')));
});

test('M-3 (studio_create_app, CA-1): the WORDS_MUST_NAME_APP continuation replayed as it is is WORDS_REQUIRED: no kernel, no create-app', async t => {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r7-ca1-')); t.after(() => fs.rmSync(lab, { recursive: true, force: true }));
  const bridge = fakeBridge();
  const cli = path.join(lab, 'cli', 'anvil-odc.dll'); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '');
  const kernel = [];
  const runAnvil = async argv => {
    kernel.push(argv[0]);
    const outDir = argv[argv.indexOf('--out') + 1] ?? path.join(lab, 'create-out'), manifest = path.join(outDir, 'manifest.json');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', module: 'ZZLibCA', moduleKey: 'zz-libkey', tenant: HOST, author: 'zz-dev', create: true, evidenceDir: path.join(outDir, 'evidence') }));
    return { envelope: { ok: true, data: { ok: true, manifest, moduleKey: 'zz-libkey', content: {} } }, stderr: [] };
  };
  const create = createStudioCreateApp({ root: path.join(lab, 'kernel-root'), cli, runAnvil, studio: bridge.studio, tenants: async () => ({ tenants: {} }), appUrl: async () => ({ appUrl: 'https://zz' }) });
  const first = await create({ action: 'create', kind: 'library', name: 'ZZLibCA', authorize: 'pode criar a biblioteca', pid: PID });
  assert.equal(first.code, 'WORDS_MUST_NAME_APP');
  const replay = await create(structuredClone(first.continuation.arguments));
  assert.equal(replay.code, 'WORDS_REQUIRED', JSON.stringify(replay).slice(0, 300));
  for (const [kind, authorize] of Object.entries(SERVER_TEXTS)) assert.equal((await create({ action: 'create', kind: 'library', name: 'ZZLibCA', authorize, pid: PID })).code, 'WORDS_REQUIRED', kind);
  assert.deepEqual(kernel, [], 'no kernel run'); assert.equal(bridge.lines.some(l => l.startsWith('create-app')), false, 'no create-app crossed the bridge');
  const done = await create({ action: 'create', kind: 'library', name: 'ZZLibCA', authorize: 'pode criar a biblioteca ZZLibCA', pid: PID });
  assert.notEqual(done.code, 'WORDS_REQUIRED'); assert.ok(kernel.length >= 1, 'the owner\'s words that name it create');
});

test('M-3 (studio_authorize, SA-1): a server text is never recorded, and studio_publish {manifest} without words then publishes nothing', async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r7-sa1-')); t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const bridge = fakeBridge();
  const facade = await createFacadeServer({ deps: { studio: bridge.studio, destructive: { root: path.join(out, 'destructive') } } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new McpClient({ name: 'cx15r7-sa1', version: '1' });
  await Promise.all([facade.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await facade.close(); });
  const call = async (tool, args) => { const r = await client.callTool({ name: tool, arguments: args }); try { return r.structuredContent ?? JSON.parse(r.content[0].text); } catch { return { ok: false, text: r.content?.[0]?.text }; } };
  for (const [kind, text] of Object.entries({ ...SERVER_TEXTS, punctuation: '!!!!!!!! ????' })) {
    const D = delivery(out, 'p-' + kind, 'ZZApp' + kind);
    const recorded = await call('studio_authorize', { manifest: D.manifest, kind: 'publish', text, pid: PID });
    assert.equal(recorded.code, 'WORDS_REQUIRED', kind + ' ' + JSON.stringify(recorded).slice(0, 200));
    const published = await call('studio_publish', { manifest: D.manifest, wait: true, minutes: 1, pid: PID });
    assert.equal(published.ok, false, kind + ': no publication without words');
    assert.equal(fs.existsSync(path.join(D.evidence, 'publish-started.json')), false, kind);
  }
  assert.deepEqual(bridge.lines.filter(l => /^(authorize|publish) /.test(l)), [], 'neither authorize nor publish crossed the bridge');
});
