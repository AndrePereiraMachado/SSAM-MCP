import './fixtures/isolated-profile.mjs';
// CX15 r5 (N-2): the ODC publication and creation sent the owner's words in clear through the bridge's authorize command
// (studio_authorize, studio_publish {authorize}, the standing grant of publishWithGrant, studio_deliver publish:true via
// publishDelivered) and studio_create_app wrote them in the manifest itself (createAuthorization, publishAuthorization);
// the bridge keeps them in manifest.json, publish-started.json / create-started.json and answers them in text. Now every
// path sends 'sha256:<hex>' as one token (also at the one point every bridge command crosses, lib.mjs client()), and the
// manifest gets the same in both fields. A fake bridge behind the real client() (fixtures/destructive-r5-bridge.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createFacadeServer } from '../mcp.mjs';
import { publishWithGrant } from '../studio-publish-log.mjs';
import { publishDelivered } from '../kernel-delivery.mjs';
import { createStudioCreateApp } from '../studio-create-app.mjs';
import { client } from '../lib.mjs';
import { fakeBridge, delivery, BRIDGE_PID as PID, BRIDGE_HOST as HOST } from './fixtures/destructive-r5-bridge.mjs';
import { MARK, count, filesWithMark } from './fixtures/destructive-r4-marker.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const HASHED = /sha256:[0-9a-f]{64}/;

test('N-2: studio_authorize, studio_publish, the standing grant, publishDelivered and studio_create_app send and keep sha256:<hex>, never the words', async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r5-n2-')); t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const bridge = fakeBridge();
  const answers = {};
  const facade = await createFacadeServer({ deps: { studio: bridge.studio, destructive: { root: path.join(out, 'destructive') } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'cx15r5-n2', version: '1.0.0' });
  await Promise.all([facade.connect(a), mcp.connect(b)]);
  t.after(async () => { await mcp.close(); await facade.close(); });
  const callTool = async (tool, args) => { const r = await mcp.callTool({ name: tool, arguments: args }); return { text: (r.content ?? []).map(c => c.text).join('\n'), value: r.structuredContent ?? JSON.parse(r.content[0].text) }; };
  // A. studio_authorize {kind:'publish'}
  const A = delivery(out, 'a-authorize', 'ZZAppA');
  answers.A = await callTool('studio_authorize', { manifest: A.manifest, kind: 'publish', text: 'pode publicar o ZZAppA agora ' + MARK, pid: PID });
  // B. studio_publish {manifest, authorize}
  const B = delivery(out, 'b-publish', 'ZZAppB');
  answers.B = await callTool('studio_publish', { manifest: B.manifest, authorize: 'pode publicar o ZZAppB agora ' + MARK, wait: true, minutes: 1, pid: PID });
  // C. the standing grant (publishWithGrant with a fake grant store)
  const C = delivery(out, 'c-grant', 'ZZAppC');
  answers.C = { value: await publishWithGrant({ manifest: C.manifest, wait: true, minutes: 1, pid: PID }, { studio: bridge.studio, readManifest: f => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')),
    lab: path.join(out, 'lab'), root: path.join(out, 'grant-root'), catalog: () => null, grants: { findGrant: async () => ({ grantId: 'zz-grant-1', words: 'pode publicar sempre o ZZAppC ' + MARK }) } }) };
  // D. studio_create_app {kind:'library', publish:true} (fake kernel run)
  const cli = path.join(out, 'cli', 'anvil-odc.dll'); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '');
  const runAnvil = async argv => {
    const outDir = argv[argv.indexOf('--out') + 1] ?? path.join(out, 'create-out'), manifest = path.join(outDir, 'manifest.json');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', module: 'ZZLibN2', moduleKey: 'zz-libkey', tenant: HOST, author: 'zz-dev', create: true, evidenceDir: path.join(outDir, 'evidence') }));
    return { envelope: { ok: true, data: { ok: true, manifest, moduleKey: 'zz-libkey', content: {} } }, stderr: [] };
  };
  const createApp = createStudioCreateApp({ root: path.join(out, 'kernel-root'), cli, runAnvil, studio: bridge.studio, tenants: async () => ({ tenants: {} }), appUrl: async () => ({ appUrl: 'https://zz' }) });
  answers.D = { value: await createApp({ action: 'create', kind: 'library', name: 'ZZLibN2', authorize: 'pode criar e publicar a ZZLibN2 ' + MARK, publish: true, pid: PID }) };
  // E. studio_deliver publish:true after a clean merge: publishDelivered
  const E = delivery(out, 'e-deliver', 'ZZAppE');
  answers.E = { value: await publishDelivered({ manifest: E.manifest, module: 'ZZAppE', words: 'pode entregar e publicar o ZZAppE ' + MARK, pid: PID, minutes: 1 }, { studio: bridge.studio }) };

  // The words first (so an older tree fails on them), then that every path ran.
  assert.deepEqual(bridge.lines.filter(l => count(l) > 0).map(l => l.split(' ')[0]), [], 'no line carries the owner words');
  assert.deepEqual(filesWithMark([out, process.env.USERPROFILE]).map(f => path.basename(f)), [], 'no manifest, evidence (publish-started, create-started) or other file keeps the words');
  assert.deepEqual(Object.entries(answers).filter(([, v]) => count(v.text ?? '') + count(JSON.stringify(v.value ?? null)) > 0).map(([k]) => k), [], 'no answer has the owner words');
  for (const [k, v] of Object.entries(answers)) assert.notEqual(v.value?.ok, false, k + ' ran: ' + JSON.stringify(v.value).slice(0, 300).split(MARK).join('<MARK>'));
  const authorizeLines = bridge.lines.filter(l => l.startsWith('authorize '));
  assert.ok(authorizeLines.length >= 4, 'the authorize lines crossed the fake pipe: ' + authorizeLines.length);
  for (const l of authorizeLines) assert.match(l, HASHED);
  assert.equal(bridge.direct(), 0, 'every command went through the real client()');
  for (const m of [A.manifest, B.manifest, C.manifest, E.manifest]) assert.match(JSON.parse(fs.readFileSync(m, 'utf8')).publishAuthorization, HASHED);
});

test('N-2: lib.mjs client() hashes the words of any line it sends (authorize text, --authorize), whoever called it', async () => {
  const lines = [];
  const call = async (pid, version, args) => { lines.push(args.map(String).join(' ')); return JSON.stringify({ ok: true }); };
  const words = 'sim, pode publicar o ZZAppF ' + MARK;
  let seam = true;
  for (const args of [['authorize', 'C:/zz/manifest.json', 'publish', ...words.split(' ')], ['authorize', 'C:/zz/manifest.json', 'create', words],
    ['data-insert', 'M', 'E', '--records-file', 'r.json', '--authorize', words]]) {
    try { await client(PID, args, { call, version: 'v99' }); } catch { seam = false; }
  }
  assert.ok(seam, 'client() takes the pipe call and the protocol version');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.filter(l => count(l) > 0), []);
  for (const l of lines) assert.match(l, HASHED);
  assert.match(lines[0], /^authorize C:\/zz\/manifest\.json publish sha256:[0-9a-f]{64}$/, 'one token after the kind');
});
