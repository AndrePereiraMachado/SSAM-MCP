// Package 3, lane mb, C25: studio_create_app publishes only when asked, reuses a template the facade already holds when the
// tenant's revision is the same (template-download --have), and builds the model on the resident ODC worker when it can.
// Fake bridge, fake kernel, fake worker: no Studio, no tenant, no process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerStudioCreateApp, APP_TEMPLATES, cachedTemplate, odcWorkerFirst } from '../studio-create-app.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';

const TENANT = 'personal-test.outsystems.dev';
const WORDS = 'pode criar o app ZZ Criar Web';
const TEMPLATE = Buffer.from('OML template bytes, revision 21');
const SHA = createHash('sha256').update(TEMPLATE).digest('hex').toUpperCase();

// The bridge: a template-download that writes the template where the bridge keeps it, and answers cached:true to a --have
// of the same revision (a capable bridge); status brief names the bridge's capabilities.
function fakeBridge(root, { capabilities = ['merge:normalized', 'template-download:have'] } = {}) {
  const calls = [];
  const kept = path.join(root, 'bridge-templates', 'web.oml');
  async function studio(args) {
    calls.push([...args]);
    switch (args[0]) {
      case 'auth-status': return { ok: true, sessions: [{ host: TENANT, loggedIn: true, user: 'dev@example.com' }] };
      case 'status': return { ok: true, bridge: 'v39', capabilities };
      case 'template-download': {
        const have = args.indexOf('--have') >= 0 ? args[args.indexOf('--have') + 1] : null;
        if (have === '21-' + SHA.slice(0, 12)) return { ok: true, cached: true, key: args[1], name: 'Template Web App', revision: 21, sha256: SHA, path: kept };
        fs.mkdirSync(path.dirname(kept), { recursive: true }); fs.writeFileSync(kept, TEMPLATE);
        return { ok: true, cached: false, key: args[1], name: 'Template Web App', revision: 21, sha256: SHA, path: kept };
      }
      case 'create-app': return { ok: true, created: true, assetKey: 'KEY1', assetName: 'ZZ Criar Web', appName: 'ZZ Criar Web', revision: 1 };
      case 'open': return { ok: true, opened: true, key: 'KEY1', developerId: 'dev@example.com' };
      case 'publish': return { ok: true, completed: true, published: { revision: 1 } };
      default: throw new Error('unexpected bridge command ' + args[0]);
    }
  }
  studio.calls = calls;
  return studio;
}
const kernel = () => fakeAnvil({
  'create-app': args => {
    const out = args[args.indexOf('--out') + 1];
    fs.mkdirSync(out, { recursive: true });
    const manifest = path.join(out, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', module: 'ZZCriarWeb', moduleKey: 'KEY1', appName: 'ZZ Criar Web', tenant: TENANT, author: 'dev@example.com', create: true }));
    return { ok: true, command: 'create-app', data: { ok: true, module: 'ZZCriarWeb', moduleKey: 'KEY1', manifest } };
  },
});

async function harness(t, options = {}) {
  const k = tempKernel({});
  let tick = 0;
  const deps = { root: k.root, env: k.env, studio: fakeBridge(k.root, options), runAnvil: kernel(), now: () => new Date(Date.UTC(2026, 9, 7, 12, 0, tick++)),
    uuid: () => '00000000-0000-4000-8000-000000000002', tenants: async () => ({ tenants: { [TENANT]: { class: 'personal' } } }),
    appUrl: async () => ({}), templateCache: path.join(k.root, 'templates') };
  const mcp = await linked(registerStudioCreateApp, deps);
  t.after(async () => { await mcp.close(); k.cleanup(); });
  return { ...mcp, deps };
}

test('create without publish never publishes and answers right after opening', async t => {
  const h = await harness(t);
  const v = await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', authorize: WORDS });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(h.deps.studio.calls.map(c => c[0]), ['auth-status', 'template-download', 'create-app', 'open']);
  assert.deepEqual(v.publish, { requested: false });
  assert.equal(v.published, false);
  const manifest = JSON.parse(fs.readFileSync(v.manifest, 'utf8'));
  assert.ok(manifest.createAuthorization); assert.equal(manifest.publishAuthorization, undefined);
});

test('a template of the same revision is not downloaded again', async t => {
  const h = await harness(t);
  const first = await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', authorize: WORDS });
  assert.equal(first.ok, true, JSON.stringify(first));
  const held = cachedTemplate(h.deps.templateCache, APP_TEMPLATES.web.key);
  assert.equal(held.revision, '21'); assert.equal(held.sha12, SHA.slice(0, 12));
  const second = await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', authorize: WORDS });
  assert.equal(second.ok, true, JSON.stringify(second));
  const downloads = h.deps.studio.calls.filter(c => c[0] === 'template-download');
  assert.deepEqual(downloads[1].slice(-2), ['--have', '21-' + SHA.slice(0, 12)]);
  assert.equal(second.template.cached, true);
  const argv = h.deps.runAnvil.calls[1].args;
  assert.equal(argv[argv.indexOf('--template-oml') + 1], held.file);   // the kernel clones the facade's own copy
});

test('a bridge without template-download:have is never sent --have', async t => {
  const h = await harness(t, { capabilities: [] });
  await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', authorize: WORDS });
  await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', authorize: WORDS });
  assert.ok(h.deps.studio.calls.filter(c => c[0] === 'template-download').every(c => !c.includes('--have')));
});

test('the model step runs on a capable ODC worker, else cold', async () => {
  const envelope = { ok: true, command: 'create-app', data: { ok: true } };
  const worker = capabilities => ({ runs: [], ensure: async () => ({ status: { capabilities } }), async run(argv) { this.runs.push(argv); return { used: true, envelope }; } });
  let cold = 0;
  const coldRunner = async () => { cold++; return { ok: true, exitCode: 0, envelope }; };
  const capable = worker(['apply:developer-id']);
  const r = await odcWorkerFirst(coldRunner, capable)(['create-app', '--author', 'dev@example.com']);
  assert.equal(r.via, 'worker'); assert.equal(capable.runs.length, 1); assert.equal(cold, 0);
  const old = worker([]);
  const c = await odcWorkerFirst(coldRunner, old)(['create-app']);
  assert.equal(cold, 1); assert.equal(old.runs.length, 0); assert.match(c.workerNote, /apply:developer-id/);
  await odcWorkerFirst(coldRunner, null)(['create-app']);
  assert.equal(cold, 2);
});
