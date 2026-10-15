// The facade sends through bridge v32 only what PortalCore.cs lets through, read from its source: the public API
// families, the six read-only POST searches, the known Portal reads, the Portal writes as writes, the secretRefs the
// bridge resolves (shape, limit, roots, targets, capabilities and refusal gates), and no secret key the bridge would mask.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MAX_SECRET_REFS, PORTAL_READS, PORTAL_WRITES, SECRET_FIELDS, SECRET_KINDS, pointerValue } from '../runtime/portal-routes.mjs';
import { SEARCH_POSTS } from '../runtime/effects.mjs';
import { PUBLIC_KEYS, isSensitiveKey } from '../runtime/errors.mjs';
import { Catalog } from '../runtime/catalog.mjs';
import { OdcAccess } from '../runtime/access.mjs';
import { WriteJournal } from '../runtime/write-journal.mjs';
import { CredentialRegistry } from '../runtime/credential-registry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.join(here, '..', '..', 'studio', 'bridge');
const core = fs.readFileSync(path.join(bridgeDir, 'PortalCore.cs'), 'utf8');
// Every C# source of the bridge (not its tests): a later bridge may resolve secretRefs in a file of its own.
const sources = fs.readdirSync(bridgeDir).filter(f => f.endsWith('.cs')).map(f => fs.readFileSync(path.join(bridgeDir, f), 'utf8')).join('\n');
const catalog = JSON.parse(fs.readFileSync(path.join(here, '..', 'catalog', 'catalog.json'), 'utf8'));
const block = name => core.slice(core.indexOf(name), core.indexOf('};', core.indexOf(name)));
const basePathOf = api => new URL(api.servers[0].url.replace('ODC_PORTAL_DOMAIN', 'placeholder.invalid')).pathname.replace(/\/$/, '');

test('M2: cookie privacy agrees with the C# private transport routing allowlist', () => {
  const source = fs.readFileSync(path.join(bridgeDir, 'PortalPrivateHttp.cs'), 'utf8');
  const routing = /var publicRouting = name switch \{([\s\S]*?)\};/.exec(source)?.[1];
  assert.ok(routing, 'the bridge must declare its public routing cookie policy');
  const names = [...routing.matchAll(/"(Tenant[A-Za-z]+)"\s*=>/g)].map(match => match[1]);
  assert.deepEqual(names.sort(), ['TenantDomain', 'TenantGeo', 'TenantPortfolio', 'TenantPref', 'TenantRing']);
  assert.match(routing, /"TenantDomain" => value == host/);
  assert.match(routing, /"TenantPref" => value == host\.Split\('\.'\)\[0\]/);
  assert.match(routing, /"TenantGeo" => .*"\^\[A-Z\]\{2\}\$"/);
  assert.match(routing, /"TenantRing" => .*"\^\\\\d\{1,2\}\$"/);
  assert.match(routing, /"TenantPortfolio" => value is "0" or "1"/);
  assert.match(routing, /_ => false/);
  assert.match(source, /if \(!publicRouting\) \{\s*masks\.Add\(value\)/);
  const host = 'personal-fixture-with-long-name.outsystems.dev';
  const registry = new CredentialRegistry();
  const publicValues = { TenantDomain: host, TenantPref: host.split('.')[0], TenantGeo: 'US', TenantRing: '12', TenantPortfolio: '1' };
  for (const name of names) {
    assert.equal(registry.cookie({ key: name, value: publicValues[name] }, host), false, name);
    const invalid = crypto.randomUUID();
    assert.equal(registry.cookie({ key: name, value: invalid }, host), true, name + ' unexpected shape remains private');
    assert.equal([...registry.values()].includes(invalid), true, name);
  }
  for (const name of ['crf', 'nr1apps', 'nr2apps', 'unrecognized']) {
    const value = crypto.randomUUID();
    assert.equal(registry.cookie({ key: name, value }, host), true, name);
    assert.equal([...registry.values()].includes(value), true, name);
  }
  for (const name of ['language', 'consent']) assert.equal(registry.cookie({ key: name, value: crypto.randomUUID() }, host), false, name);
  assert.equal(registry.cookie({ key: 'unrecognized', value: '1' }, host), false);
});

test('every public API family of the catalog is a bridge base path', () => {
  const bridge = new Set([...block('BasePaths').matchAll(/"(\/api\/[^"]+)"/g)].map(m => m[1]));
  assert.deepEqual([...new Set(catalog.apis.map(basePathOf))].sort(), [...bridge].sort());
});

test('the six read-only POST searches of odc_read are the bridge read posts', () => {
  const posts = [...block('ReadPosts').matchAll(/\("(\/api\/[^"]+)", new Regex\("([^"]+)"\)\)/g)].map(m => ({ basePath: m[1], path: new RegExp(m[2]) }));
  assert.equal(posts.length, SEARCH_POSTS.size);
  for (const id of SEARCH_POSTS) {
    const [apiId, , route] = id.split(':');
    const api = catalog.apis.find(a => a.id === apiId);
    const concrete = route.replace(/\{[^}]+\}/g, 'k1');
    assert.ok(posts.some(p => p.basePath === basePathOf(api) && p.path.test(concrete)), id);
  }
});

test('Portal reads are known reads of the bridge and Portal writes are not', () => {
  const known = new Set([...block('KnownWebReads').matchAll(/"([A-Za-z0-9_/]+)"/g)].map(m => m[1]));
  for (const [id, route] of Object.entries(PORTAL_READS)) assert.ok(known.has(route[2]), id);
  for (const [id, { route }] of Object.entries(PORTAL_WRITES)) assert.ok(!known.has(route[2]), id);
});

test('the module version token reaches portal-metadata.mjs unmasked', () => {
  assert.match(core, /PublicKeys = new\(StringComparer\.Ordinal\) \{ "versionToken" \}/);
  assert.deepEqual([...PUBLIC_KEYS], ['versionToken']);
});

// Every key the bridge masks, the facade masks too (it redacts the answers of the vault paths, which never pass the
// bridge): the property names of the 14 pinned contracts plus the secret keys the fixtures of the integrator name.
test('the facade redaction covers every key the bridge redaction masks', () => {
  const bridgeRule = new RegExp(/SensitiveKey = new\(@"([^"]+)", RegexOptions\.IgnoreCase\)/.exec(core)[1], 'i');
  const names = new Set(['authToken', 'activationCode', 'x-csrftoken', 'csrfToken', 'gatewayToken', 'AccessToken', 'IdToken', 'RefreshToken', 'ConnectionPassword',
    'ConnectionString', 'ClientSecret', 'APIKeySecret', 'privateKey', 'cookie', 'Authorization', 'versionToken', 'tokenValidUntil', 'assetKey']);
  const visit = value => { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    if (key === 'properties' && entry && typeof entry === 'object') Object.keys(entry).forEach(n => names.add(n));
    visit(entry);
  } };
  visit(catalog);
  const bridgeMasks = key => key !== 'isSecret' && key !== 'versionToken' && bridgeRule.test(key);
  const missing = [...names].filter(key => bridgeMasks(key) && !isSensitiveKey(key));
  assert.deepEqual(missing, []);
  for (const key of ['authToken', 'activationCode']) assert.equal(isSensitiveKey(key), true, key);
  assert.equal(isSensitiveKey('versionToken'), false);
});

// secretRefs (CONTRATO.md, pending item 1 of wave 2): the facade sends {pointer, target, field} with an empty
// placeholder at the pointer of the request file body, the bridge reads the vault entry inside the Studio.
async function dbCreateRequests() {
  const host = 'personal-test.outsystems.dev', dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-agreement-'));
  const files = new Map();
  const studio = { running: async () => true, call: async args => {
    if (args[0] === 'auth-status') return { ok: true, bridge: 'headless-fixture', capabilities: ['portal-session:headless'], sessions: [{ host, loggedIn: true, user: 'dev@example.test' }], portalWindows: [] };
    if (args[1] !== 'fetch') return { ok: true, host, signedIn: true };
    const request = files.get(args[2]);
    const data = request.path.endsWith('DataActionGetFilter_Stages') ? { EnvironmentList: [{ Key: 'dev', Name: 'Development', Purpose: 'Development' }] }
      : request.path.endsWith('DataActionGetStatus') ? { Status: { Results: { List: [{ StageKey: 'dev', Status: 'Success' }] } } }
      : request.path.endsWith('DataActionGetConnections') ? { Connections: [{ ConnectionId: 'c-1', Name: 'SalesDb' }] }
      : request.path.includes('Test_Wrapper') ? { Out_ConnectionId: 'c-1' } : {};
    return { ok: true, status: 200, host, body: { data } };
  } };
  let n = 0;
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: host, tenants: { [host]: { class: 'personal' } } }, studio,
    vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: true }), bridge: async () => { throw new Error('no vault bridge'); } },
    prompt: {}, portalBroker: () => { throw new Error('no vault broker on the Studio path'); }, receipts: new WriteJournal(path.join(dir, 'receipts')),
    requestFile: json => { const f = 'req-' + (++n); files.set(f, structuredClone(json)); return f; }, sleep: async () => {} });
  access.studioBroker(host).metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
  const created = await access.externalDbConnection({ action: 'create', name: 'SalesDb', providerId: 'mssql', server: 'db.test', port: 1433, database: 'sales',
    authorize: 'yes, create SalesDb on the personal tenant', operationUuid: crypto.randomUUID() });
  assert.equal(created.ok, true, JSON.stringify(created));
  return { host, writes: [...files.values()].filter(r => r.write) };
}

test('secretRefs: the facade sends only vault entry names at empty placeholders, in the shape the bridge reads', async () => {
  const { host, writes } = await dbCreateRequests();
  assert.equal(writes.length, 2);
  for (const request of writes) {
    assert.ok(request.secretRefs.length > 0);
    for (const ref of request.secretRefs) {
      assert.deepEqual(Object.keys(ref).sort(), ['field', 'pointer', 'target']);
      assert.match(ref.target, new RegExp('^SSAM/ODC3/' + host.replace(/\./g, '\\.') + '/DB/[A-Za-z0-9_.-]{1,64}$'));
      assert.ok(SECRET_FIELDS.includes(ref.field));
      assert.match(ref.pointer, /^\/(?:inputParameters|screenData\/variables|clientVariables)\//, 'a pointer into the wire body of the request file');
      assert.equal(pointerValue(request.body, ref.pointer), '', ref.pointer);
    }
  }
  // Bridge side (PortalCore.cs, wave 2): it takes exactly these keys and fields, under the facade's limit, at the roots
  // the facade's wire pointers start in, and accepts the facade's targets (never a sign-in entry).
  for (const word of ['"pointer"', '"target"', '"field"', '"password"', '"username"']) assert.ok(core.includes(word), 'bridge source names ' + word);
  assert.equal(Number(/MaxSecretRefs = (\d+);/.exec(core)[1]), MAX_SECRET_REFS);
  const roots = [...block('WebSecretRoots').matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(roots, ['/inputParameters/', '/screenData/variables/', '/clientVariables/']);
  const bridgeTarget = new RegExp(/SecretTarget = new\(@"([^"]+)"/.exec(core)[1], 'i');
  const signIn = [...block('SignInKinds').matchAll(/"([^"]+)"/g)].map(m => m[1]);
  for (const request of writes) for (const ref of request.secretRefs) {
    const match = bridgeTarget.exec(ref.target);
    assert.ok(match && match[1].toLowerCase() === host && !signIn.includes(match[2]), ref.target);
    assert.ok(roots.some(root => ref.pointer.startsWith(root)), ref.pointer);
  }
  for (const kind of Object.keys(SECRET_KINDS)) assert.ok(bridgeTarget.test('SSAM/ODC3/' + host + '/' + kind + '/Name') && !signIn.includes(kind), kind);
  assert.deepEqual(signIn, ['APIClient', 'Portal']);
});

test('secretRefs: the bridge announces them and refuses with the gates the facade explains', () => {
  const commands = fs.readFileSync(path.join(bridgeDir, 'PortalCommands.cs'), 'utf8');
  assert.ok(commands.includes('"portal-call:secretRefs"'));
  assert.equal(commands.includes('"portal-session:secretRefs"'), false, 'disabled window transport must not advertise internal secretRefs');
  assert.ok(core.includes('HEADLESS_AUTH_UNAVAILABLE'));
  assert.ok(commands.includes('PortalCore.HeadlessSession(action, words.Length, tenant)'));
  assert.doesNotMatch(commands, /WebViewControl\.|Xilium\.|EvaluateScript|\.Show\(|\.LoadUrl\(|DeleteCookies/,
    'Portal bridge commands cannot retain a browser transport or modify browser cookies');
  assert.doesNotMatch(commands, /portal:signin-recheck|sign in again|restart it|signs in.*window/);
  const access = fs.readFileSync(path.join(here, '..', 'runtime', 'access.mjs'), 'utf8');
  for (const gate of ['secret_ref_missing', 'secret_ref_vault']) {
    assert.ok(core.includes('"' + gate + '"'), 'bridge gate ' + gate);
    assert.ok(access.includes("failure.gate === '" + gate + "'"), 'facade hint for ' + gate);
  }
  // The first v32 (still loaded in a Studio that has not restarted) refused every secretRefs request with this gate.
  assert.ok(access.includes("failure.gate === 'secret_refs_unsupported'"));
});

// portal-upload (lane extlib): the request file the facade writes is exactly what PortalUpload.cs reads, the capability
// the deployer checks is the one auth-status announces, and an older bridge's reference refusal is the text the
// delivery turns into BRIDGE_UPGRADE_REQUIRED.
test('portal-upload: the request keys, the uploads folder, the capabilities and the external library reference agree with the bridge', async () => {
  const upload = fs.readFileSync(path.join(bridgeDir, 'PortalUpload.cs'), 'utf8');
  const commands = fs.readFileSync(path.join(bridgeDir, 'PortalCommands.cs'), 'utf8');
  const hook = fs.readFileSync(path.join(bridgeDir, 'StartupHook.cs'), 'utf8');
  const reference = fs.readFileSync(path.join(bridgeDir, 'ReferenceCommands.cs'), 'utf8');
  const keys = /key is not \(([^)]+)\)/.exec(upload)[1].match(/"([A-Za-z0-9]+)"/g).map(k => k.replace(/"/g, '')).sort();
  const { bridgeUploader, stageUpload } = await import('../runtime/external-library-upload.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-agreement-upload-'));
  const file = path.join(dir, 'Lib-0123456789abcdef.zip'); fs.writeFileSync(file, 'PK');
  let request;
  await bridgeUploader({ studio: { call: async () => ({ ok: true, operationKey: 'k' }) }, requestFile: json => { request = json; return 'r'; }, stage: stageUpload(path.join(dir, 'journal', 'portal', 'uploads')) })
    .upload({ host: 'personal-test.outsystems.dev', file, sha256: crypto.createHash('sha256').update('PK').digest('hex'), fileName: 'Lib-0123456789abcdef.zip', operationUuid: crypto.randomUUID(), authorizeSha256: 'a'.repeat(64) });
  assert.deepEqual(Object.keys(request).sort(), keys);
  assert.match(commands, /Path\.Combine\(PortalDir, "uploads"\)/);
  assert.match(request.file.replace(/\\/g, '/'), /\/journal\/portal\/uploads\/[^/]+$/);
  for (const capability of ['portal-upload', 'reference-snapshot:external-library']) assert.ok(commands.includes('"' + capability + '"'), capability);
  const deployer = fs.readFileSync(path.join(here, '..', 'runtime', 'external-library.mjs'), 'utf8');
  assert.match(deployer, /includes\('portal-upload'\)/);
  assert.match(hook, /"portal-upload" => await PortalUploadCommand\(argument, context\)/);
  assert.match(hook, /or "portal-upload" or "publish-log" \? Task\.CompletedTask/, 'portal-upload opens no Studio dialog: the watchdog leaves it alone');
  assert.match(reference, /kind is "eSpace" or "ExternalLibrary"/);
  assert.doesNotMatch(reference, /not extensions or external libraries"/, 'the old refusal text belongs to bridges before the capability');
  assert.equal(Number(/MaxPackageBytes = (\d+)L \* 1024 \* 1024/.exec(upload)[1]), 90);
});

test('secretRefs: the secret setting PATCH names a Setting entry at /settings/<i>/value with an empty placeholder', async () => {
  const host = 'personal-test.outsystems.dev', dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-agreement-'));
  const files = new Map();
  const settings = [{ key: 's-1', name: 'ApiPassword', isSecret: true, value: '********' }];
  const studio = { running: async () => true, call: async args => {
    if (args[0] === 'auth-status') return { ok: true, bridge: 'headless-fixture', capabilities: ['portal-session:headless'], sessions: [{ host, loggedIn: true, user: 'dev@example.test' }], portalWindows: [] };
    const request = files.get(args[1]);
    return { ok: true, status: 200, host, contentType: 'application/json', body: request.method === 'PATCH' ? {} : { key: 'app-1', settings } };
  } };
  let n = 0;
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: host, tenants: { [host]: { class: 'personal' } } }, studio,
    vault: { apiClient: async () => ({ available: false }), portal: async (h, database, setting) => ({ available: setting === 'ApiPassword' }), bridge: async () => { throw new Error('no vault bridge'); } },
    prompt: {}, portalBroker: () => { throw new Error('no vault broker'); }, receipts: new WriteJournal(path.join(dir, 'receipts')),
    requestFile: json => { const f = 'req-' + (++n); files.set(f, structuredClone(json)); return f; }, sleep: async () => {} });
  const out = await access.configurations({ action: 'set', environmentKey: 'e-1', assetKey: 'app-1', vaultSettings: { ApiPassword: 'ApiPassword' },
    authorize: 'yes, set the secret on the personal tenant', operationUuid: crypto.randomUUID() });
  assert.equal(out.ok, true, JSON.stringify(out));
  const patch = [...files.values()].find(r => r.method === 'PATCH');
  assert.equal(patch.write, true); assert.match(patch.path, /\/configurations$/);
  const bridgeTarget = new RegExp(/SecretTarget = new\(@"([^"]+)"/.exec(core)[1], 'i');
  for (const ref of patch.secretRefs) {
    assert.deepEqual(Object.keys(ref).sort(), ['field', 'pointer', 'target']);
    assert.ok(bridgeTarget.test(ref.target), ref.target); assert.equal(ref.field, 'password');
    assert.match(ref.pointer, /^\/settings\/\d+\/value$/); assert.equal(pointerValue(patch.body, ref.pointer), '');
  }
});
