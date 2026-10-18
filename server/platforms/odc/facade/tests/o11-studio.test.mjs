import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Studio, translateDialogHint, ASK_PERSON, COMMANDS } from '../o11-studio.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { workspaceRoot } from '../workspace.mjs';
import { studioBridge } from './fixtures/o11-studio-bridge.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

// Every Studio here is the programmable fake bridge on an ephemeral loopback port; every folder is a temp folder.
const TEST_ENV = { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
const HOST = 'dev.example.com';
const WAIT_NO_DIALOGS = { tool: 'o11_studio', arguments: { command: 'wait', args: { condition: 'no-dialogs' } }, why: ASK_PERSON };
const SHELL = /python|cdp_pages|\.py\b|studio_env|credentials? file|ssam connect|odc attach|\.ps1|dotnet /i;
const noShell = value => assert.doesNotMatch(JSON.stringify(value), SHELL);

// The kernel's own dialog hints (DialogPolicy.Hint), read from the source so the tests follow the kernel.
function kernelHints() {
  const source = fs.readFileSync(path.join(workspaceRoot, 'kernel', 'src', 'Anvil.Core', 'Kernel', 'DialogPolicy.cs'), 'utf8');
  const hints = {};
  for (const m of source.slice(source.indexOf('public static string Hint')).matchAll(/(\w+|_)\s*=>\s*"((?:[^"\\]|\\.)*)"/g)) hints[m[1]] = m[2].replace(/\\"/g, '"');
  return hints;
}
const HINTS = kernelHints();

function tempFolders() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-studio-'));
  const sub = name => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); return p; };
  const env = { ...TEST_ENV, USERPROFILE: sub('home'), HOME: path.join(dir, 'home'), APPDATA: sub('appdata'), LOCALAPPDATA: sub('localappdata'), ANVIL_AUTHORITY_DIR: sub('authority') };
  return { dir, root: sub('root'), env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// A fake clock: delay() advances time at once and records each pause, so the backoff is asserted exactly.
function clock(start = Date.UTC(2026, 9, 2, 13, 4, 5)) {
  let t = start; const pauses = [];
  return { now: () => t, delay: async ms => { pauses.push(ms); t += ms; }, pauses };
}

async function harness(initial = {}, extra = {}) {
  const fake = await studioBridge(initial);
  const tmp = tempFolders(); const time = clock(); const selected = [];
  const server = new McpServer({ name: 't', version: '0' });
  registerO11Studio(server, { bridge: o11Bridge({ port: fake.port, authorization: 'K' }), assertSelected: async () => { selected.push(true); },
    lane: 'ss4', root: tmp.root, env: tmp.env, now: time.now, delay: time.delay, ...(typeof extra === 'function' ? extra({ fake, tmp }) : extra) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (command, args) => {
    const reply = await client.callTool({ name: 'o11_studio', arguments: { command, ...(args === undefined ? {} : { args }) } });
    const value = JSON.parse(reply.content[0].text);
    assert.equal(reply.isError === true, value.ok === false, JSON.stringify(value));
    assert.deepEqual(reply.structuredContent, value);
    return value;
  };
  const sent = method => fake.seen.filter(r => r.method === method);
  return { fake, state: fake.state, tmp, time, selected, call, client, sent,
    close: async () => { await client.close(); await server.close(); await fake.close(); tmp.cleanup(); } };
}

const dialog = (extra = {}) => ({ kind: 'MessageBox', type: 'MessageBoxWindow', title: 'Unsaved changes', source: 'window', contentKind: 'native',
  texts: ['Save the module?', '[Button] OK', '[Button] Cancel'], hint: HINTS._, ...extra });

test('OutSystems UI dependency is never opened, including implicit snapshot opening', async()=>{
  const h=await harness();
  try {
    for(const name of ['OutSystemsUI','OutSystems UI','outsystems_ui']) {
      const opened=await h.call('open-module',{name});
      // A29: a system module, refused with the published-OML read (ssam_map) instead of a manual download
      assert.equal(opened.code,'SYSTEM_MODULE_NOT_OPENABLE');
      assert.deepEqual([opened.continuation.tool,opened.continuation.arguments],['ssam_map',{lane:'o11',target:'OutSystemsUI'}]);
      assert.equal((await h.call('snapshot',{module:name})).code,'SYSTEM_MODULE_NOT_OPENABLE');
    }
    assert.equal(h.sent('open_module').length,0);
    assert.equal(h.sent('snapshot_module').length,0);
  } finally { await h.close(); }
});
const webDialog = { kind: 'WebDialog', type: 'DialogWindow', title: '', source: 'window', contentKind: 'web', texts: [], hint: HINTS.WebDialog };
const presenter = { kind: 'ManageDependencies', type: 'AddRemoveReferencesPresenter', source: 'presenter', hint: HINTS.ManageDependencies };
const module = (name, extra = {}) => ({ name, key: 'key-' + name, hasESpace: true, environment: HOST, isModified: false, hasOpenedActiveESpace: true, serverSilentMode: false, presenter: 'P', ...extra });

test('the tool is listed with one enum of commands, an args object, no credential field and non-destructive annotations', async () => {
  const h = await harness();
  try {
    const tool = (await h.client.listTools()).tools.find(t => t.name === 'o11_studio');
    assert.ok(tool, 'missing o11_studio');
    assert.deepEqual(tool.inputSchema.properties.command.enum, COMMANDS);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['args', 'command']);
    assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.annotations.destructiveHint, false);
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /password|secret|token|credential/i);
    const unknownCommand = await h.client.callTool({ name: 'o11_studio', arguments: { command: 'click' } }).catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(unknownCommand.isError, true);
    const extraKey = await h.client.callTool({ name: 'o11_studio', arguments: { command: 'status', password: 'x' } }).catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(extraKey.isError, true);
    assert.equal(h.fake.seen.length, 0);
  } finally { await h.close(); }
});

test('status joins ping, manifest, open modules, the active module with its dialogs and ui_alive in one short answer', async () => {
  const h = await harness({ active: { name: 'Orders', key: 'k1', environment: HOST, isModified: true, kind: 'Web' },
    modules: [module('Orders', { key: 'k1', isModified: true }), module('Lib')], environments: [HOST], dialogs: [dialog(), presenter] });
  try {
    const value = await h.call('status');
    assert.equal(value.ok, true); assert.equal(value.pid, 4242); assert.equal(value.version, '9.9.9.9'); assert.equal(value.protocol, 2);
    assert.equal(value.uiResponsive, true); assert.equal(value.busy, false);
    assert.deepEqual(value.activeModule, { name: 'Orders', key: 'k1', environment: HOST, modified: true });
    assert.deepEqual(value.openModules, [{ name: 'Orders', modified: true, environment: HOST }, { name: 'Lib', modified: false, environment: HOST }]);
    assert.deepEqual(value.environments, [HOST]);
    assert.equal(value.pendingDialogs.length, 2);
    assert.deepEqual(value.pendingDialogs[0].next.arguments, { command: 'dismiss-dialog', args: { title: 'Unsaved changes' } });
    assert.match(value.pendingDialogs[0].hint, /"command":"dismiss-dialog"/);
    assert.deepEqual(value.pendingDialogs[1].next, WAIT_NO_DIALOGS);
    noShell(value);
    assert.deepEqual(h.fake.methods().sort(), ['bridge_manifest', 'get_active_module', 'list_open_modules', 'ping', 'ui_alive']);
    assert.equal(h.selected.length, 0);
  } finally { await h.close(); }
});

test('status without an active module reads the dialogs from the windows: a web dialog for the person, progress skipped', async () => {
  const h = await harness({ modules: [{ name: null, hasESpace: false, hasOpenedActiveESpace: false, serverSilentMode: true }], windows: [
    { title: 'Service Studio', type: 'MainWindow', isVisible: true, isModal: false, contentKind: 'native', texts: ['Develop'] },
    { title: '', type: 'DialogWindow', isVisible: true, isModal: false, contentKind: 'web', texts: [] },
    { title: 'Progress', type: 'ProgressWindow', isVisible: true, isModal: true, contentKind: 'native', texts: ['Opening module...'] }] });
  try {
    const value = await h.call('status');
    assert.equal(value.activeModule, null); assert.equal(value.busy, true); assert.deepEqual(value.opening, [null]);
    assert.deepEqual(value.openModules, []);
    assert.equal(value.pendingDialogs.length, 1);
    assert.equal(value.pendingDialogs[0].kind, 'WebDialog'); assert.deepEqual(value.pendingDialogs[0].next, WAIT_NO_DIALOGS);
  } finally { await h.close(); }
});

test('without a bridge: O11_NOT_CONNECTED with the ssam_connect continuation; a refused key and another Studio pid too', async () => {
  const dead = await fakeBridge(() => undefined); const port = dead.port; await dead.close();
  const h = await harness({}, { bridge: o11Bridge({ port, authorization: 'K' }) });
  try {
    for (const [command, args] of [['status'], ['open-module', { name: 'Orders' }], ['wait', { condition: 'idle', timeoutSeconds: 5 }], ['windows']]) {
      const value = await h.call(command, args);
      assert.equal(value.code, 'O11_NOT_CONNECTED', command);
      assert.equal(value.continuation.tool, 'ssam_connect'); assert.deepEqual(value.continuation.arguments, { lane: 'o11' });
      noShell(value);
    }
  } finally { await h.close(); }
  const keyed = await harness({}, ({ fake }) => ({ bridge: o11Bridge({ port: fake.port, authorization: 'WRONG' }) }));
  try {
    const value = await keyed.call('status');
    assert.equal(value.code, 'O11_NOT_AUTHORIZED'); assert.equal(value.continuation.tool, 'ssam_connect');
  } finally { await keyed.close(); }
  const other = await harness({}, ({ fake }) => ({ bridge: o11Bridge({ port: fake.port, authorization: 'K', pid: 1111 }) }));
  try {
    const value = await other.call('status');
    assert.equal(value.code, 'O11_STUDIO_CHANGED'); assert.equal(value.selectedPid, 1111); assert.equal(value.continuation.tool, 'ssam_connect');
  } finally { await other.close(); }
});

test('the default bridge is the lane target read per call from the connection record (temp root, ephemeral port)', async () => {
  const h = await harness({ key: 'RECORDKEY' }, ({ fake, tmp }) => {
    const authority = path.join(tmp.dir, 'record-authority'); fs.mkdirSync(authority, { recursive: true });
    fs.writeFileSync(path.join(authority, 'bridge.key'), 'RECORDKEY\n');
    fs.mkdirSync(path.join(tmp.root, '.local', 'connections'), { recursive: true });
    fs.writeFileSync(path.join(tmp.root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242,
      startedUtc: '2026-10-02T00:00:00Z', studioDir: path.join(tmp.dir, 'studio'), authorityDir: authority, port: fake.port }));
    return { bridge: undefined };
  });
  try {
    const value = await h.call('status');
    assert.equal(value.ok, true); assert.equal(value.pid, 4242);
    assert.ok(h.fake.seen.filter(r => r.method === 'list_open_modules').every(r => r.authorization === 'RECORDKEY'));
  } finally { await h.close(); }
});

test('args are checked per command: unknown keys, wrong types and missing pairs are refused before anything runs', async () => {
  const h = await harness();
  try {
    const cases = [['status', { verbose: true }], ['wait', { condition: 'idle', module: 'X' }], ['wait', { condition: 'open' }], ['wait', { condition: 'signed-in' }],
      ['wait', { condition: 'no-dialogs', host: HOST }], ['wait', { condition: 'idle', timeoutSeconds: 0 }], ['wait', { condition: 'idle', timeoutSeconds: 1801 }],
      ['wait', { condition: 'published' }], ['open-module', {}], ['open-module', { name: 'A', timeoutSeconds: 301 }], ['open-module', { name: 'A', silent: false }],
      ['snapshot', { path: 'relative.oml' }], ['snapshot', { module: 'A', moduleKey: 'k' }], ['errors', { max: 0 }], ['errors', { max: 501 }], ['publish-log', { max: 0 }], ['publish-log', { module: 'A', all: true }],
      ['windows', { maxTexts: 'x' }], ['dismiss-dialog', {}], ['dismiss-dialog', { title: '   ' }], ['dismiss-dialog', { title: 'X', all: true }],
      ['login', {}], ['login', { host: HOST, password: 'p' }], ['login', { host: 'https://dev.example.com/' }], ['login', { host: HOST, credentialsFile: 'C:\\c.json' }]];
    for (const [command, args] of cases) {
      const value = await h.call(command, args);
      assert.equal(value.code, 'BAD_ARGS', command + ' ' + JSON.stringify(args));
      assert.ok(Array.isArray(value.allowed), command);
      // A24: every refusal carries the corrected call of the same command, without the refused secrets
      assert.deepEqual([value.continuation?.tool, value.continuation?.arguments?.command], ['o11_studio', command], command);
      assert.doesNotMatch(JSON.stringify(value.continuation), /"p"|c\.json|password|credentials/);
    }
    assert.match((await h.call('dismiss-dialog', {})).error, /title is required/);
    assert.deepEqual((await h.call('login', { host: HOST, password: 'p' })).allowed, ['host', 'timeoutSeconds']);
    assert.equal(h.fake.seen.length, 0); assert.equal(h.selected.length, 0);
  } finally { await h.close(); }
});

test('wait answers on the read where the condition becomes true, backing off 250 ms to 2 s, and at once when it already holds', async () => {
  let reads = 0;
  const h = await harness({ alive: false, before: (request, state) => { if (request.method === 'ui_alive' && ++reads === 7) state.alive = true; } });
  try {
    const value = await h.call('wait', { condition: 'idle' });
    assert.equal(value.ok, true); assert.equal(value.uiResponsive, true); assert.deepEqual(value.opening, []);
    assert.deepEqual(h.time.pauses, [250, 500, 1000, 2000, 2000, 2000]); assert.equal(value.waitedMs, 7750);
    const again = await h.call('wait', { condition: 'idle' });
    assert.equal(again.ok, true); assert.equal(again.waitedMs, 0); assert.equal(h.time.pauses.length, 6);
    assert.equal(h.selected.length, 0);
  } finally { await h.close(); }
  let dialogReads = 0;
  const d = await harness({ active: { name: 'Orders', key: 'k1', environment: HOST }, dialogs: [dialog()],
    before: (request, state) => { if (request.method === 'get_active_module' && ++dialogReads === 3) state.dialogs = []; } });
  try {
    const value = await d.call('wait', { condition: 'no-dialogs', timeoutSeconds: 60 });
    assert.equal(value.ok, true); assert.deepEqual(value.dialogs, []); assert.deepEqual(d.time.pauses, [250, 500]);
  } finally { await d.close(); }
});

test('wait with a short deadline returns WAIT_TIMEOUT with the last state and the MCP continuation', async () => {
  const h = await harness({ active: { name: 'Orders', key: 'k1', environment: HOST }, dialogs: [webDialog], alive: false });
  try {
    const value = await h.call('wait', { condition: 'no-dialogs', timeoutSeconds: 1 });
    assert.equal(value.code, 'WAIT_TIMEOUT'); assert.equal(value.waitedMs, 1000); assert.deepEqual(h.time.pauses, [250, 500, 250]);
    assert.equal(value.last.dialogs[0].kind, 'WebDialog'); assert.deepEqual(value.continuation, WAIT_NO_DIALOGS);
    noShell(value);
    const idle = await h.call('wait', { condition: 'idle', timeoutSeconds: 2 });
    assert.equal(idle.code, 'WAIT_TIMEOUT'); assert.equal(idle.last.uiResponsive, false);
    assert.deepEqual(idle.continuation.arguments, { command: 'status' });
  } finally { await h.close(); }
});

test('wait in real time returns as soon as the Studio state changes, with no fixed sleep', async () => {
  const h = await harness({ active: { name: 'Orders', key: 'k1', environment: HOST }, dialogs: [dialog()] }, { now: Date.now, delay: undefined });
  try {
    setTimeout(() => { h.state.dialogs = []; }, 300);
    const started = Date.now();
    const value = await h.call('wait', { condition: 'no-dialogs', timeoutSeconds: 30 });
    const elapsed = Date.now() - started;
    assert.equal(value.ok, true);
    assert.ok(elapsed >= 250 && elapsed < 1500, 'answered after ' + elapsed + ' ms');
  } finally { await h.close(); }
});

test('wait signed-in polls sc_session until the Studio reports the host; wait open is one blocking open_module', async () => {
  let sessions = 0;
  const h = await harness({ before: (request, state) => { if (request.method === 'sc_session' && ++sessions === 3) state.sessions[HOST] = { user: 'dev@example.com' }; } });
  try {
    const value = await h.call('wait', { condition: 'signed-in', host: 'DEV.example.com' });
    assert.deepEqual(value, { ok: true, condition: 'signed-in', waitedMs: 750, host: HOST, signedIn: true, user: 'dev@example.com', loginType: 'token' });
    assert.deepEqual(h.time.pauses, [250, 500]); assert.equal(h.selected.length, 0);
    const open = await h.call('wait', { condition: 'open', module: 'Orders', host: HOST, timeoutSeconds: 900 });
    assert.equal(open.ok, true); assert.equal(open.opened, true);
    assert.deepEqual(h.state.opened, [{ name: 'Orders', environment: HOST, timeout: 300, silent: true }]);
    assert.equal(h.sent('open_module').length, 1); assert.equal(h.selected.length, 1);
  } finally { await h.close(); }
});

test('open-module relays the native open in silent mode and answers short', async () => {
  const h = await harness();
  try {
    const value = await h.call('open-module', { name: 'Orders', app: 'Shop', environment: 'Dev.Example.com', moduleKey: 'k1', timeoutSeconds: 60 });
    assert.deepEqual(value, { ok: true, name: 'Orders', opened: true, alreadyOpen: false, elapsedMs: 12 });
    assert.deepEqual(h.state.opened, [{ name: 'Orders', app: 'Shop', environment: HOST, module_key: 'k1', timeout: 60, silent: true }]);
    assert.equal(h.selected.length, 1);
    await h.call('open-module', { name: 'Lib' });
    assert.deepEqual(h.state.opened[1], { name: 'Lib', timeout: 120, silent: true });
  } finally { await h.close(); }
});

test('open-module blocked by a dialog returns it with the continuation: dismiss by title for an owned window, else the person', async () => {
  let blockedBy = [dialog()];
  const h = await harness({ replies: { open_module: p => ({ success: true, error: null, data: { name: p.name, opened: false, blockedBy, serverSilentMode: false,
    elapsedMs: 4500, hint: blockedBy[0].hint + '; then call open_module again' } }) } });
  try {
    const owned = await h.call('open-module', { name: 'Orders' });
    assert.equal(owned.code, 'DIALOG_BLOCKING'); assert.equal(owned.dialogs[0].title, 'Unsaved changes');
    assert.equal(owned.continuation.tool, 'o11_studio');
    assert.deepEqual(owned.continuation.arguments, { command: 'dismiss-dialog', args: { title: 'Unsaved changes' } });
    noShell(owned);
    blockedBy = [webDialog];
    const web = await h.call('open-module', { name: 'Orders' });
    assert.equal(web.code, 'DIALOG_BLOCKING'); assert.deepEqual(web.continuation, WAIT_NO_DIALOGS);
    noShell(web);
    blockedBy = [presenter];
    const references = await h.call('open-module', { name: 'Orders' });
    assert.deepEqual(references.continuation, WAIT_NO_DIALOGS); assert.match(references.dialogs[0].hint, /ask the person to choose in the Studio/);
    noShell(references);
  } finally { await h.close(); }
});

test('open-module failures name the MCP next step, never a credential file', async () => {
  let error = 'InvalidOperationException: not logged in: use login with a credentials file';
  const h = await harness({ replies: { open_module: () => ({ success: false, data: null, error }) } });
  try {
    const signedOut = await h.call('open-module', { name: 'Orders', environment: HOST });
    assert.equal(signedOut.code, 'STUDIO_NOT_SIGNED_IN');
    assert.deepEqual(signedOut.continuation.arguments, { command: 'login', args: { host: HOST } });
    noShell(signedOut);
    error = "open_module: 'Orders' did not become active in 120 s and no dialog was detected (check windows and ui_alive); temporary silent mode reset";
    const slow = await h.call('open-module', { name: 'Orders' });
    assert.equal(slow.code, 'OPEN_TIMEOUT'); assert.deepEqual(slow.continuation.arguments, { command: 'status' });
  } finally { await h.close(); }
});

test('snapshot selects the named module, pins its key and writes under the lane folder by default', async () => {
  const h = await harness({ active: { name: 'Lib', key: 'key-Lib', environment: HOST } });
  try {
    const value = await h.call('snapshot', { module: 'Orders' });
    const expected = path.join(h.tmp.root, '.local', 'snapshots', 'Orders-20261002130405.oml');
    assert.deepEqual(value, { ok: true, path: expected, sha256: 'ab'.repeat(32), module: 'Orders', key: 'key-Orders', environment: HOST, snapshotId: 'snap-1' });
    assert.deepEqual(h.sent('snapshot_module')[0].params, { path: expected, module_key: 'key-Orders' });
    assert.equal(h.sent('open_module').length, 1); assert.equal(h.selected.length, 1);
    const explicit = path.join(h.tmp.dir, 'base.oml');
    const given = await h.call('snapshot', { path: explicit });
    assert.equal(given.path, explicit); assert.equal(h.sent('open_module').length, 1);
    h.state.replies.open_module = () => ({ success: true, error: null, data: { name: 'Billing', opened: true, alreadyOpen: true } });
    const mismatch = await h.call('snapshot', { module: 'Billing' });
    assert.equal(mismatch.code, 'MODULE_NOT_ACTIVE'); assert.equal(mismatch.active, 'Orders');
  } finally { await h.close(); }
});

test('errors returns the short TrueChange view, capped at max, without the raw messages', async () => {
  const h = await harness({ errors: p => ({ rawMessages: Array.from({ length: 50 }, (_, i) => ({ i })), isValid: false, errors: 2, warnings: 1, total: 3,
    byType: { Error: 2, Warning: 1 }, messages: [{ m: 1 }, { m: 2 }, { m: 3 }], verifyMs: 5,
    ...(p.since ? { snapshot_id: p.since, new: [{ n: 1 }, { n: 2 }], fixed: [], preexisting: [], newErrors: 2 } : {}) }) });
  try {
    assert.deepEqual(await h.call('errors', { max: 2 }), { ok: true, isValid: false, errors: 2, warnings: 1, messages: [{ m: 1 }, { m: 2 }], byType: { Error: 2, Warning: 1 },
      lastPublish: { available: false, reason: 'this Studio bridge has no publish_log yet' } });
    const delta = await h.call('errors', { since: 'snap-1', max: 1 });
    assert.equal(delta.newErrors, 2); assert.deepEqual(delta.new, [{ n: 1 }]); assert.equal(delta.rawMessages, undefined);
    await h.call('errors');
    assert.deepEqual(h.sent('get_errors').map(r => r.params), [{ max: 2 }, { max: 1, since: 'snap-1' }, { max: 60 }]);
    assert.equal(h.selected.length, 0);
  } finally { await h.close(); }
});

// The bridge's publish_log data as PublishLog.Project builds it from the Studio's 1-Click Publish tab (kernel tests
// PublishLogTests build it from native MessageDefinition rows).
const HORSIE_LOG = {
  found: true, module: 'Horsie_CS', moduleKey: 'k-horsie', environment: 'personal-2qqw9srv.outsystemscloud.com', serverOperationId: 7,
  operation: 'Publish', status: 'failed', state: 'CompletedWithFailure', stage: 'compile', failedStage: 'compile',
  startedAt: '13:00:01', endedAt: '13:00:09', lastUploadDateTime: '2026-10-04T13:00:02', triggeredBy: 'studio', errors: 1, warnings: 1,
  steps: [{ stage: 'save', text: 'Saving Horsie_CS', shownAt: '13:00:01' }, { stage: 'upload', text: 'Uploading', shownAt: '13:00:02' },
    { stage: 'compile', text: 'Compiling Horsie_CS', shownAt: '13:00:05' }],
  messages: [
    { type: 'Error', stage: 'compile', text: "Invalid SQL in 'GetInbox'", detail: "Incorrect syntax near the keyword 'Match'.", id: 'SQLInvalid', shownAt: '13:00:09',
      element: { name: 'GetInbox', key: 'act-1', kind: 'ServerAction', path: 'GetInbox (ServerAction)', source: 'model' } },
    { type: 'Warning', stage: 'compile', text: 'Deprecated function used', id: 'Deprecated', shownAt: '13:00:09' }],
  omitted: 0,
};

test('publish-log returns the last 1-Click Publish as the Studio shows it: status, stage, messages with element, and what to fix', async () => {
  const h = await harness({ publishLog: () => HORSIE_LOG });
  try {
    const value = await h.call('publish-log', { module: 'Horsie_CS' });
    assert.equal(value.ok, true); assert.equal(value.found, true);
    assert.equal(value.status, 'failed'); assert.equal(value.failedStage, 'compile'); assert.equal(value.triggeredBy, 'studio');
    assert.deepEqual(value.steps.map(s => s.stage), ['save', 'upload', 'compile']);
    assert.deepEqual(value.messages[0], { type: 'Error', stage: 'compile', text: "Invalid SQL in 'GetInbox'", detail: "Incorrect syntax near the keyword 'Match'.",
      element: { name: 'GetInbox', key: 'act-1', kind: 'ServerAction', path: 'GetInbox (ServerAction)' }, id: 'SQLInvalid', shownAt: '13:00:09' });
    assert.deepEqual(value.continuation.arguments, { lane: 'o11', target: 'Horsie_CS', name: 'GetInbox' });
    assert.equal(value.continuation.tool, 'ssam_map');
    assert.match(value.continuation.why, /failed at stage compile: Invalid SQL in 'GetInbox'.*Fix it in GetInbox.*o11_publish with the user's words/);
    noShell(value);
    assert.deepEqual(h.sent('publish_log').map(r => r.params), [{ max: 60, module: 'Horsie_CS' }]);
    await h.call('publish-log', { max: 5 });
    assert.deepEqual(h.sent('publish_log')[1].params, { max: 5 });
    assert.equal(h.selected.length, 0, 'a read: the selection check of the writes does not run');
  } finally { await h.close(); }
});

test('publish-log without an error points at the full log; without a publication it says why; an old bridge and a closed module refuse', async () => {
  const noElement = { ...HORSIE_LOG, failedStage: 'deploy', messages: [{ type: 'Error', stage: 'deploy', text: 'Database upgrade failed', extraInfo: 'table OSUSR_X_MATCH' }] };
  const h = await harness({ publishLog: p => (p.module === 'Lib' ? { found: false, module: 'Lib', reason: 'no 1-Click Publish messages tab is open for this module in the Studio' } : noElement) });
  try {
    const failed = await h.call('publish-log');
    assert.deepEqual(failed.continuation.arguments, { command: 'publish-log', args: { module: 'Horsie_CS' } });
    assert.match(failed.continuation.why, /stage deploy: Database upgrade failed/);
    assert.equal(failed.messages[0].extraInfo, 'table OSUSR_X_MATCH');
    const none = await h.call('publish-log', { module: 'Lib' });
    const { observes, elsewhere, ...rest } = none;
    assert.deepEqual(rest, { ok: true, found: false, module: 'Lib', moduleKey: null, environment: null, reason: 'no 1-Click Publish messages tab is open for this module in the Studio' });
    // What it observes, and where the publications made elsewhere are (atritos-a-refresh.test.mjs).
    assert.match(observes, /1-Click Publish tabs of this Service Studio/);
    assert.deepEqual(elsewhere.arguments, { action: 'versions', module: 'Lib' });
    h.state.publishLog = null;
    const old = await h.call('publish-log');
    assert.equal(old.code, 'BRIDGE_OUTDATED'); assert.equal(old.continuation.tool, 'ssam_doctor');
    h.state.replies.publish_log = () => ({ success: false, data: null, error: "InvalidOperationException: module 'Nope' is not open in the Studio (open: Horsie_CS)" });
    const closed = await h.call('publish-log', { module: 'Nope' });
    assert.equal(closed.code, 'MODULE_NOT_OPEN'); assert.match(closed.error, /^module 'Nope' is not open/); assert.equal(closed.continuation.arguments.command, 'status');
    noShell([failed, none, old, closed]);
  } finally { await h.close(); }
});

test('errors adds lastPublish: the short result of the last 1-Click Publish, with its first errors and the call for all of them', async () => {
  const h = await harness({ errors: () => ({ isValid: true, errors: 0, warnings: 0, total: 0, byType: {}, messages: [] }), publishLog: () => HORSIE_LOG });
  try {
    const value = await h.call('errors');
    assert.equal(value.isValid, true);
    assert.deepEqual(value.lastPublish, { found: true, status: 'failed', failedStage: 'compile', at: '13:00:09', triggeredBy: 'studio', errors: 1, warnings: 1,
      firstErrors: [{ stage: 'compile', text: "Invalid SQL in 'GetInbox'", detail: "Incorrect syntax near the keyword 'Match'.",
        element: { name: 'GetInbox', key: 'act-1', kind: 'ServerAction', path: 'GetInbox (ServerAction)' } }],
      next: { tool: 'o11_studio', arguments: { command: 'publish-log', args: { module: 'Horsie_CS' } }, why: 'every message of the last publication, with stage and element' } });
    assert.deepEqual(h.sent('publish_log').map(r => r.params), [{ max: 20 }]);
    h.state.publishLog = () => ({ found: false, module: 'Horsie_CS', reason: 'none yet' });
    assert.deepEqual((await h.call('errors')).lastPublish, { found: false, reason: 'none yet' });
  } finally { await h.close(); }
});

test('windows relays max_texts and drops the geometry', async () => {
  const h = await harness({ windows: [{ title: 'Service Studio', type: 'MainWindow', isVisible: true, isModal: false, contentKind: 'native', texts: ['a', 'b', 'c'] }] });
  try {
    const value = await h.call('windows', { maxTexts: 1 });
    assert.deepEqual(value, { ok: true, count: 1, windows: [{ title: 'Service Studio', type: 'MainWindow', isVisible: true, isActive: false, isModal: false, contentKind: 'native', texts: ['a'] }] });
    assert.deepEqual(h.sent('windows')[0].params, { max_texts: 1 });
  } finally { await h.close(); }
});

test('dismiss-dialog closes an owned window by its exact title; refuses a web dialog without owner, a blank title and an unknown one', async () => {
  const h = await harness({ windows: [
    { title: 'Service Studio', type: 'MainWindow', isVisible: true, isModal: false, contentKind: 'native' },
    { title: 'Unsaved changes', type: 'MessageBoxWindow', isVisible: true, isModal: true, contentKind: 'native', texts: ['[Button] Cancel'] },
    { title: 'Recover', type: 'DialogWindow', isVisible: true, isModal: false, contentKind: 'web' }] });
  try {
    assert.deepEqual(await h.call('dismiss-dialog', { title: 'unsaved changes' }), { ok: true, closed: ['MessageBoxWindow:Unsaved changes'] });
    const web = await h.call('dismiss-dialog', { title: 'Recover' });
    assert.equal(web.code, 'WEB_DIALOG'); assert.deepEqual(web.continuation, WAIT_NO_DIALOGS);
    assert.equal((await h.call('dismiss-dialog', { title: 'Nope' })).code, 'DIALOG_NOT_FOUND');
    assert.equal((await h.call('dismiss-dialog', { title: 'Service Studio' })).code, 'NOT_A_DIALOG');
    assert.equal((await h.call('dismiss-dialog', { title: '' })).code, 'BAD_ARGS');
    assert.deepEqual(h.sent('close_dialog').map(r => r.params), [{ title: 'unsaved changes' }]);
    assert.ok(h.sent('close_dialog').every(r => typeof r.params.title === 'string' && r.params.title.trim()));
    assert.equal(h.selected.length, 4); // the refused blank title never reached the check
  } finally { await h.close(); }
});

test('close-module closes the tab of a module in any window; a tab with unsaved changes is refused with the publish continuation', async () => {
  // 2026-10-07 (DCIPS): ten or more tabs moved some into a second Studio window and there was no O11 command to close a tab.
  const tabs = { Saved: { name: 'Saved', closed: true }, Gone: { name: 'Gone', closed: true, alreadyClosed: true } };
  const h = await harness({ replies: { close_module: p => (tabs[p.name] ? { success: true, data: tabs[p.name], error: null }
    : p.name === 'Twin' ? { success: false, data: null, error: 'InvalidOperationException: close_module: multiple matching tabs; choose in Studio' }
      : { success: false, data: null, error: 'InvalidOperationException: close_module: tab has unsaved changes, is opening, or has a pending operation; save or resolve it in Studio first' }) } });
  try {
    assert.deepEqual(await h.call('close-module', { name: 'Saved' }), { ok: true, module: 'Saved', closed: true });
    assert.deepEqual(await h.call('close-module', { module: 'Gone' }), { ok: true, module: 'Gone', closed: true, alreadyClosed: true });
    const dirty = await h.call('close-module', { name: 'Dirty' });
    assert.equal(dirty.code, 'MODULE_TAB_NOT_CLOSABLE'); assert.equal(dirty.executed, false);
    assert.deepEqual(dirty.continuation.arguments, { module: 'Dirty' }); assert.equal(dirty.continuation.tool, 'o11_publish');
    assert.equal((await h.call('close-module', { name: 'Twin' })).code, 'MODULE_TAB_AMBIGUOUS');
    assert.equal((await h.call('close-module', {})).code, 'BAD_ARGS');
    assert.deepEqual(h.sent('close_module').map(r => r.params), [{ name: 'Saved' }, { name: 'Gone' }, { name: 'Dirty' }, { name: 'Twin' }]);
    assert.equal(h.selected.length, 4); // a write: the selected-Studio check runs before each sent call
    assert.ok(COMMANDS.includes('close-module'));
  } finally { await h.close(); }
});

test('login opens the Studio own sign-in, never sends a credential and returns once sc_session reports the host', async () => {
  let sessions = 0;
  const h = await harness({ before: (request, state) => { if (request.method === 'sc_session' && ++sessions === 3) state.sessions[HOST] = { user: 'dev@example.com' }; } });
  try {
    const value = await h.call('login', { host: HOST });
    assert.deepEqual(value, { ok: true, host: HOST, signedIn: true, user: 'dev@example.com', loginType: 'token', waitedMs: 750 });
    assert.deepEqual(h.sent('studio_login').map(r => r.params), [{ host: HOST, waitMs: 5000 }]);
    assert.deepEqual(h.time.pauses, [250, 500]);
    const again = await h.call('login', { host: HOST });
    assert.equal(again.ok, true); assert.equal(again.dialogOpened, false); assert.equal(h.time.pauses.length, 2);
    assert.equal(h.fake.methods().includes('login'), false);
    assert.ok(h.fake.seen.every(r => !/password|credential|secret|token/i.test(JSON.stringify(r.params ?? {}))));
    assert.equal(h.selected.length, 2);
  } finally { await h.close(); }
  const cancelled = await harness({ before: (request, state) => { if (request.method === 'sc_session') state.loginPending[HOST] = false; } });
  try {
    const value = await cancelled.call('login', { host: HOST });
    assert.equal(value.code, 'LOGIN_NOT_COMPLETED'); assert.deepEqual(value.continuation.arguments, { command: 'login', args: { host: HOST } });
  } finally { await cancelled.close(); }
  const slow = await harness();
  try {
    const value = await slow.call('login', { host: HOST, timeoutSeconds: 2 });
    assert.equal(value.code, 'WAIT_TIMEOUT'); assert.equal(value.last.loginPending, true);
    assert.deepEqual(value.continuation.arguments, { command: 'wait', args: { condition: 'signed-in', host: HOST } });
    noShell(value);
  } finally { await slow.close(); }
});

test('assertSelected runs only before the commands that change the Studio, and its refusal stops the call', async () => {
  const h = await harness({ active: { name: 'Orders', key: 'key-Orders', environment: HOST }, sessions: { [HOST]: { user: 'u' } },
    errors: () => ({ isValid: true, errors: 0, warnings: 0, byType: {}, messages: [] }), publishLog: () => ({ found: false, module: 'Orders', reason: 'none' }),
    windows: [{ title: 'Note', type: 'MessageBoxWindow', isVisible: true, isModal: true, contentKind: 'native', texts: [] }] });
  try {
    for (const [command, args] of [['status'], ['errors'], ['publish-log'], ['windows'], ['wait', { condition: 'idle' }], ['wait', { condition: 'no-dialogs' }], ['wait', { condition: 'signed-in', host: HOST }]])
      assert.equal((await h.call(command, args)).ok, true, command);
    assert.equal(h.selected.length, 0);
    for (const [command, args] of [['open-module', { name: 'Orders' }], ['snapshot', {}], ['dismiss-dialog', { title: 'Note' }], ['login', { host: HOST }], ['wait', { condition: 'open', module: 'Orders' }]])
      assert.equal((await h.call(command, args)).ok, true, command);
    assert.equal(h.selected.length, 5);
  } finally { await h.close(); }
  const refused = await harness({}, { assertSelected: async () => { throw new Error('The selected Studio session is no longer connected. Run ssam connect --lane o11 to select the current Studio.'); } });
  try {
    const value = await refused.call('open-module', { name: 'Orders' });
    assert.equal(value.code, 'O11_NOT_SELECTED'); assert.equal(value.continuation.tool, 'ssam_connect');
    assert.equal(value.error, 'The selected Studio session is no longer connected.');
    noShell(value); assert.equal(refused.fake.seen.length, 0);
  } finally { await refused.close(); }
});

test('translateDialogHint turns every DialogPolicy hint and the bridge dialog refusals into the MCP form', () => {
  assert.deepEqual(Object.keys(HINTS).sort(), ['ManageDependencies', 'MergeEditor', 'Recovery', 'WebDialog', '_']);
  for (const [kind, hint] of Object.entries(HINTS)) {
    const out = translateDialogHint(hint);
    assert.doesNotMatch(out, /python|cdp_pages|--click|\.py\b/, kind);
    if (/cdp_pages/.test(hint)) assert.notEqual(out, hint, kind);
  }
  assert.match(translateDialogHint(HINTS.Recovery), /ask the person to choose Discard or Open in the Studio, then o11_studio \{"command":"wait","args":\{"condition":"no-dialogs"\}\}/);
  assert.match(translateDialogHint(HINTS.WebDialog), /ask the person to answer it in the Studio/);
  assert.match(translateDialogHint(HINTS._, { title: 'Save', closable: true }), /o11_studio \{"command":"dismiss-dialog","args":\{"title":"Save"\}\}/);
  assert.doesNotMatch(translateDialogHint(HINTS._, { title: 'Save', closable: false }), /dismiss-dialog/);
  assert.match(translateDialogHint(HINTS._ + '; then call open_module again'), /call o11_studio \{"command":"open-module"\} again$/);
  const merge = "merge_from_oml: 'M' has a dialog or merge editor pending in the Studio (WebDialog): apply or close it in the Studio (see `windows` / `python scripts/cdp_pages.py`) and retry; never restart the Studio for this";
  assert.equal(translateDialogHint(merge), "merge_from_oml: 'M' has a dialog or merge editor pending in the Studio (WebDialog): apply or close it in the Studio (see o11_studio {\"command\":\"windows\"}) and retry; never restart the Studio for this");
  assert.equal(translateDialogHint('run `python scripts/cdp_pages.py --click "Keep Local"` now'), 'run ask the person to click Keep Local in the Studio now');
  assert.equal(translateDialogHint('`python scripts\\cdp_pages.py --click Cancel`', { title: 'Merge', closable: true }), 'o11_studio {"command":"dismiss-dialog","args":{"title":"Merge"}}');
  assert.equal(translateDialogHint('python scripts/cdp_pages.py --list'), 'o11_studio {"command":"windows"}');
  assert.equal(translateDialogHint('nothing to change'), 'nothing to change');
  assert.equal(translateDialogHint(undefined), undefined);
});
