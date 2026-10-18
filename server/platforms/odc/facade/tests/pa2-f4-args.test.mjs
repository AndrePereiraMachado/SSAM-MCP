// Atritos 2, lane F4: argument shapes of o11_studio (A24) and the o11_dependencies capture/inspect (A23, facade part).
// Real messages (Cardapio, 2026-10-06): `name: Invalid input: expected string, received undefined; Unrecognized key:
// "module"` (open-module {module}), `Unrecognized key: "module" allowed: ["max","since"]` (13:02:02 errors {module}),
// `ArgumentException: missing --out` (13:29:38 dependencies capture without out) and `SharpZipBaseException: Illegal rep
// length code` (13:29:47 dependencies inspect of a .avsig). Fake bridges and runners, temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
// Namespace imports: on a build without these exports the rules fail on their assertions, not on the import.
import * as studioTool from '../o11-studio.mjs';
import * as operations from '../o11-operations.mjs';
import { o11LaneOf } from '../o11-lane.mjs';

const HOST = 'dev.example.com';
// A bridge of the current Studio: tabs with keys, get_errors by module_key (C41), publish_log by module.
function studio({ open = ['Cardapio_CS', 'Cardapio_UI'], active = 'Cardapio_UI', older = false } = {}) {
  const calls = [];
  const bridge = { async ok(method, params = {}) {
    calls.push({ method, params });
    switch (method) {
      case 'list_open_modules': return { modules: open.map(name => ({ name, key: 'K' + name, hasESpace: true, hasOpenedActiveESpace: true, environment: HOST })) };
      case 'open_module': return { opened: true, name: params.name, alreadyOpen: false, elapsedMs: 5 };
      case 'get_errors': {
        const name = params.module_key ? String(params.module_key).slice(1) : active;
        if (older && name !== active) throw Object.assign(new Error('InvalidOperationException: Requested module identity is no longer active; nothing was executed'), { code: 'BRIDGE_ERROR' });
        return { isValid: false, errors: 1, warnings: 0, messages: [{ type: 'Error', text: 'in ' + name }], byType: { Error: 1 } };
      }
      case 'publish_log': return { found: false, module: params.module ?? active, reason: 'no publication' };
      default: throw new Error('unexpected bridge call ' + method);
    }
  } };
  return { run: studioTool.o11Studio({ bridge, assertSelected: async () => {}, lane: 'ss4', root: os.tmpdir(), env: process.env, inventory: async () => null }), calls };
}

test('open-module takes module as its name (the other tools say module); both with one value pass, two values are refused with the corrected call', async () => {
  const s = studio();
  const opened = await s.run({ command: 'open-module', args: { module: 'Cardapio_IS' } });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.deepEqual(s.calls.filter(c => c.method === 'open_module').map(c => c.params.name), ['Cardapio_IS']);
  assert.equal((await s.run({ command: 'open-module', args: { name: 'Cardapio_IS', module: 'Cardapio_IS' } })).ok, true);
  const two = await s.run({ command: 'open-module', args: { name: 'Cardapio_IS', module: 'Cardapio_BO' } });
  assert.equal(two.code, 'BAD_ARGS');
  assert.deepEqual(two.continuation.arguments, { command: 'open-module', args: { name: 'Cardapio_IS' } });
  // the commands that take module take name too
  assert.deepEqual(studioTool.canonicalArgs?.('snapshot', { name: 'X' }), { module: 'X' });
  assert.deepEqual(studioTool.canonicalArgs?.('errors', { name: 'X', max: 5 }), { max: 5, module: 'X' });
  assert.deepEqual(studioTool.canonicalArgs?.('status', { name: 'X' }), { name: 'X' }, 'a command without the field keeps the key (and refuses it)');
});

test('errors {module} reads the TrueChange of that open module by its key, without selecting it (the 13:02:02 case)', async () => {
  const s = studio();
  const value = await s.run({ command: 'errors', args: { module: 'Cardapio_CS', max: 10 } });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual([value.module, value.key], ['Cardapio_CS', 'KCardapio_CS']);
  assert.deepEqual(value.messages, [{ type: 'Error', text: 'in Cardapio_CS' }]);
  const read = s.calls.find(c => c.method === 'get_errors');
  assert.deepEqual(read.params, { max: 10, module_key: 'KCardapio_CS' });
  assert.equal(s.calls.find(c => c.method === 'publish_log').params.module, 'Cardapio_CS');
  assert.ok(!s.calls.some(c => c.method === 'open_module'), 'no tab is selected');
  // another case of the name reaches the open tab; without module, the active module as before
  assert.equal((await s.run({ command: 'errors', args: { module: 'cardapio_cs' } })).module, 'Cardapio_CS');
  const active = await s.run({ command: 'errors', args: {} });
  assert.equal(active.module, undefined); assert.deepEqual(active.messages, [{ type: 'Error', text: 'in Cardapio_UI' }]);
});

test('errors {module} of a closed module refuses with the call that opens it; an older bridge with the call that selects it', async () => {
  const s = studio();
  const closed = await s.run({ command: 'errors', args: { module: 'Cardapio_BackOffice' } });
  assert.deepEqual([closed.ok, closed.code], [false, 'MODULE_NOT_OPEN']);
  assert.deepEqual(closed.continuation.arguments, { command: 'open-module', args: { name: 'Cardapio_BackOffice' } });
  assert.deepEqual(closed.openModules, ['Cardapio_CS', 'Cardapio_UI']);
  assert.ok(!s.calls.some(c => c.method === 'get_errors'));
  const users = await s.run({ command: 'errors', args: { module: 'Users' } });
  assert.deepEqual([users.code, users.continuation.tool], ['SYSTEM_MODULE_NOT_OPENABLE', 'ssam_map']);
  const old = studio({ older: true });
  const refused = await old.run({ command: 'errors', args: { module: 'Cardapio_CS' } });
  assert.deepEqual([refused.code, refused.continuation.arguments], ['MODULE_NOT_ACTIVE', { command: 'open-module', args: { name: 'Cardapio_CS' } }]);
});

test('every BAD_ARGS carries the corrected call: keys mapped or dropped, numbers in range, the bare host, placeholders for what cannot be derived', async () => {
  const s = studio();
  const cases = [
    ['open-module', {}, { name: '<Module>' }],
    ['open-module', { Name: 'Orders', timeoutSeconds: 900 }, { name: 'Orders', timeoutSeconds: 300 }],
    ['wait', { condition: 'idle', timeoutSeconds: 5000, module: 'X' }, { condition: 'idle', timeoutSeconds: 1800 }],
    ['wait', { condition: 'open' }, { condition: 'open', module: '<Module>' }],
    ['wait', { condition: 'Signed-In' }, { condition: 'signed-in', host: '<environment host>' }],
    ['wait', { condition: 'published' }, { condition: '<idle | no-dialogs | open | signed-in>' }],
    ['errors', { max: 0, modules: 'X' }, { max: 1 }],
    ['errors', { max: '20', verbose: true }, { max: 20 }],
    ['login', { host: 'https://dev.example.com/', password: 'p' }, { host: HOST }],
    ['snapshot', { path: 'relative.oml', module: 'A' }, { module: 'A' }],
    ['dismiss-dialog', { title: '   ', all: true }, { title: '<exact title of the dialog>' }],
    ['refresh-references', { module: 'A', producers: 'WrightFlood_Patterns' }, { module: 'A', producers: ['WrightFlood_Patterns'] }],
  ];
  for (const [command, args, corrected] of cases) {
    const value = await s.run({ command, args });
    assert.equal(value.code, 'BAD_ARGS', command + ' ' + JSON.stringify(args));
    assert.deepEqual(value.continuation, { tool: 'o11_studio', arguments: { command, args: corrected }, why: value.continuation.why }, command + ' ' + JSON.stringify(args));
    assert.match(value.continuation.why, /arguments/);
    assert.deepEqual(studioTool.correctedArgs?.(command, args), corrected);
  }
  assert.equal(JSON.stringify(await s.run({ command: 'login', args: { host: HOST, password: 'segredo' } })).includes('segredo'), false, 'a dropped value never comes back');
  // the corrected call without placeholders is accepted as it is
  const fixed = await s.run({ command: 'errors', args: { max: '20', verbose: true } });
  assert.equal((await s.run(fixed.continuation.arguments)).ok, true);
  assert.equal(s.calls.filter(c => c.method === 'open_module').length, 0);
});

test('BAD_COMMAND names the closest command as the continuation', async () => {
  const s = studio();
  const value = await s.run({ command: 'openmodule', args: { module: 'A' } });
  assert.equal(value.code, 'BAD_COMMAND');
  assert.deepEqual(value.continuation.arguments, { command: 'open-module', args: { name: 'A' } });
});

// ---- o11_dependencies
function dependencies(t, { runner } = {}) {
  // A build without these exports ignores deps.dependencies and would run the real CLI: refuse it before any call.
  assert.equal(typeof operations.inspectSignature, 'function', 'this build has no facade read of .avsig and no default capture out');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pa2-f4-deps-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'); fs.mkdirSync(root, { recursive: true });
  const env = { ...process.env, USERPROFILE: path.join(base, 'home') };
  const seen = [];
  const tools = new Map();
  operations.registerO11Operations({ registerTool: (name, config, handler) => tools.set(name, { config, handler }) }, schema => schema,
    { lane: 'ss4', root, env, dependencies: runner ?? (async argv => { seen.push(argv); return { ok: true, lane: 'o11', verb: 'dependencies', exitCode: 0, result: { ok: true, data: { producer: 'Users' } } }; }) });
  const call = async args => { const r = await tools.get('o11_dependencies').handler(args); return r.structuredContent; };
  return { base, root, env, seen, call, local: o11LaneOf('ss4', { root, env }).local };
}

test('capture without out writes to <lane .local>/dependencies/<producer>-<sha8>.avsig (the 13:29:38 case)', async t => {
  const d = dependencies(t);
  const elements = ['IServerActionSignature:User_Login', 'IServerActionSignature:User_Logout'];
  const value = await d.call({ action: 'capture', producer: 'Users', elements, expectedSignatureHash: '1db8bb04-3fc9-66b8-25d1-e58dc40f5542' });
  const sha8 = createHash('sha256').update([...elements].sort().join(',')).digest('hex').slice(0, 8);
  const out = path.join(d.local, 'dependencies', 'Users-' + sha8 + '.avsig');
  assert.equal(value.ok, true); assert.equal(value.out, out);
  assert.deepEqual(d.seen[0], ['capture', '--producer', 'Users', '--elements', elements.join(','), '--out', out, '--expected-signature-hash', '1db8bb04-3fc9-66b8-25d1-e58dc40f5542']);
  assert.ok(fs.existsSync(path.dirname(out)), 'the folder exists before the CLI writes');
  // the same set in another order is the same file; another set is another one; a given out is kept as it is
  assert.equal(operations.defaultSignatureOut?.({ producer: 'Users', elements: [...elements].reverse() }, { local: d.local }), out);
  assert.notEqual(operations.defaultSignatureOut?.({ producer: 'Users', elements: elements.slice(0, 1) }, { local: d.local }), out);
  const given = path.join(d.base, 'bo-users.avsig');
  const kept = await d.call({ action: 'capture', producer: 'Users', elements, out: given });
  assert.equal(kept.out, undefined); assert.equal(d.seen[1][d.seen[1].indexOf('--out') + 1], given);
  // list never takes out
  await d.call({ action: 'list', producer: 'Users' });
  assert.equal(d.seen[2].includes('--out'), false);
});

const envelope = () => ({ FormatVersion: 2, Environment: 'personal-2qqw9srv.outsystemscloud.com', ModuleKey: 'WWAQZTkE5UuwES8B+6Svpg', ApplicationKey: 'app-key',
  ModuleKind: 'eSpace', ModuleType: 'Default', Name: 'Users', Description: '', Icon: '', JQueryVersion: '', ExtensibilityConfigurations: '', DatabaseName: '',
  SignatureHash: '1db8bb04-3fc9-66b8-25d1-e58dc40f5542', Digest: '', Revision: '', Version: '', SignatureBinary: 'AAEC',
  Elements: [{ Kind: 'action', Name: 'User_Login', Key: 'a1' }, { Kind: 'action', Name: 'User_Logout', Key: 'a2', Requires: ['s1'] }, { Kind: 'structure', Name: 'UserInfo', Key: 's1' }],
  Attestation: { Source: 'server-signature', VersionId: 77, IsSystem: false, IsActive: true, Guard: 'module-version', CapturedAtUtc: '2026-10-06T16:29:45Z', Tool: 'anvil signature' } });

test('inspect of a .avsig reads the JSON envelope without the CLI: producer, kind, key and elements (the 13:29:47 case)', async t => {
  const d = dependencies(t, { runner: async () => assert.fail('the CLI must not open a .avsig') });
  const file = path.join(d.base, 'bo-users.avsig');
  fs.writeFileSync(file, '﻿' + JSON.stringify(envelope(), null, 2));
  const value = await d.call({ action: 'inspect', oml: file });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual([value.producer, value.kind, value.key, value.environment, value.formatVersion, value.answeredBy], ['Users', 'eSpace', 'WWAQZTkE5UuwES8B+6Svpg',
    'personal-2qqw9srv.outsystemscloud.com', 2, 'facade']);
  assert.deepEqual(value.attestation, { source: 'server-signature', guard: 'module-version', versionId: 77, isSystem: false, capturedAtUtc: '2026-10-06T16:29:45Z' });
  assert.equal(value.elementsTotal, 3);
  assert.deepEqual(value.elements[1], { kind: 'action', name: 'User_Logout', key: 'a2', requires: ['s1'] });
  assert.equal(JSON.stringify(value).includes('AAEC'), false, 'the signature bytes stay in the file');
  const page = await d.call({ action: 'inspect', oml: file, offset: 1, limit: 1 });
  assert.deepEqual([page.offset, page.returned, page.nextOffset, page.elements[0].name], [1, 1, 2, 'User_Logout']);
  // not an envelope: refused with a code and the capture continuation, still without the CLI
  const broken = path.join(d.base, 'broken.avsig'); fs.writeFileSync(broken, '{"Name": "Users"}');
  const refused = await d.call({ action: 'inspect', oml: broken });
  assert.deepEqual([refused.ok, refused.code, refused.continuation.tool], [false, 'SIGNATURE_INVALID', 'o11_dependencies']);
  assert.equal((await d.call({ action: 'inspect', oml: path.join(d.base, 'missing.avsig') })).code, 'SIGNATURE_NOT_FOUND');
  // inspectSignature is pure over the file
  assert.equal(operations.inspectSignature?.(file)?.producer, 'Users');
});

test('inspect of an OML still goes to the CLI', async t => {
  const d = dependencies(t);
  const oml = path.join(d.base, 'Consumer.oml'); fs.writeFileSync(oml, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
  await d.call({ action: 'inspect', oml });
  assert.deepEqual(d.seen[0], ['inspect', '--oml', oml]);
});
