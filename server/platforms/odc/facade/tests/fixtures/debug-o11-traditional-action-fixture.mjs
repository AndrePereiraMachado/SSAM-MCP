// Synthetic Traditional screen-action source on top of the native ContactsWeb capture
// (debug-o11-traditional-native-reading.json). Widget, event and block shapes follow the
// native readings: ButtonWidget > BuiltinEvent (Destination), LinkWidget > LinkOnClick
// (Destination, Method), WebBlockInstanceWidget.SourceBlock, '<block>.#Preparation'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appUserBinding } from '../../debug-app-user.mjs';

export const native = JSON.parse(fs.readFileSync(new URL('./debug-o11-traditional-native-reading.json', import.meta.url), 'utf8'));
export const k = id => id.padEnd(22, 'x');
const M = native.contract.binding.moduleKey;
export function node(kind, name, key, path, properties = {}, children = [], propertyReferences = {}) {
  return { kind, name, key, path, properties: { GlobalKey: M + '*' + key, ...properties }, propertyReferences,
    propertyReferenceCollections: {}, children, childrenTotal: children.length, childrenOmitted: 0,
    propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [] };
}
export function event(kind, widgetKey, destination, { method, path } = {}) {
  return node(kind, '', widgetKey + '.#OnClick', null, { Destination: 'ScreenAction:' + destination.name, Arguments: '[]', ...(method ? { Method: method } : {}) }, [],
    { Destination: { kind: 'ScreenAction', name: destination.name, key: destination.key, path: path ?? destination.path } });
}
export function button(screen, action, { id = 'SaveBtn', name = 'SaveButton', label = '"Save"', method = 'Submit', path, owner = screen } = {}) {
  const key = k(id);
  return node('ButtonWidget', name ?? label, key, screen.path + '/ButtonWidget:' + (name ?? label), { Label: label, ...(name ? { Name: name } : {}), OnClick: 'BuiltinEvent:' },
    [event('BuiltinEvent', key, action, { method, path })], { Owner: { kind: owner.kind, name: owner.name, key: owner.key, path: owner.path } });
}
export function link(screen, action, { id = 'SaveLink', name = 'SaveLink', method = 'Submit', owner = screen } = {}) {
  const key = k(id);
  return node('LinkWidget', name, key, screen.path + '/LinkWidget:' + name, { Name: name, OnClick: 'LinkOnClick:' },
    [event('LinkOnClick', key, action, { method })], { Owner: { kind: owner.kind, name: owner.name, key: owner.key, path: owner.path } });
}
export function block(screen, { id = 'Header', owner = screen } = {}) {
  const blockKey = k(id + 'Blk'), path = 'WebFlow:Common/WebBlock:' + id;
  const instance = node('WebBlockInstanceWidget', '', k(id + 'Inst'), screen.path + '/WebBlockInstanceWidget:', {}, [],
    { SourceBlock: { kind: 'WebBlock', name: id, key: blockKey, path }, Owner: { kind: owner.kind, name: owner.name, key: owner.key, path: owner.path } });
  const definition = node('WebBlock', id, blockKey, path, {}, [node('InputParameter', 'Title', k(id + 'In'), path + '/InputParameter:Title', { DataType: 'Text' }),
    node('LocalVariable', 'Expanded', k(id + 'Loc'), path + '/LocalVariable:Expanded', { DataType: 'Boolean' })],
    { Preparation: { kind: 'Preparation', key: blockKey + '.#Preparation', path: path + '/Preparation:' } });
  const preparation = node('Preparation', '', blockKey + '.#Preparation', path + '/Preparation:', {},
    [node('StartNode', '', k(id + 'Start'), path + '/Preparation:/StartNode:'), node('AggregateNode', 'GetItems', k(id + 'Agg'), path + '/Preparation:/AggregateNode:GetItems', { Name: 'GetItems' })]);
  return { instance, block: definition, preparation };
}
// One ScreenAction 'Save' on ContactsWeb, one Submit button and one block (Header).
export function actionContract({ method = 'Submit', ajax, widgets, blocks, destinationPath } = {}) {
  const contract = structuredClone(native.contract), screen = contract.screen;
  const action = node('ScreenAction', 'Save', k('SaveAction'), screen.path + '/ScreenAction:Save',
    { IsCalledByAjax: ajax ?? (method === 'Ajax' ? 'True' : 'False') },
    [node('StartNode', '', k('SaveStart'), screen.path + '/ScreenAction:Save/StartNode:'),
      node('AggregateNode', 'GetContact', k('SaveAgg'), screen.path + '/ScreenAction:Save/AggregateNode:GetContact', { Name: 'GetContact' })]);
  return { ...contract, schema: 'ssam-o11-traditional-action-source/1', action,
    actionWidgets: widgets ? widgets(screen, action) : [button(screen, action, { method, path: destinationPath })],
    blocks: blocks ? blocks(screen) : [block(screen)] };
}
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
// Rendered ContactsWeb page: original state, one rendered text value, a checked and an unchecked
// checkbox, the Save button (wt..._wtSaveButton) and an unrelated submit button. An Ajax Submit
// button renders the runtime's OsAjax call (shape of the live Service Center pages).
export function screenPage({ state = true, action = 'ContactsWeb.aspx?_ts=1', extra = '', ajax = false, ajaxFields = '__OSVSTATE,', ajaxTarget = 'wt9$wtSaveButton' } = {}) {
  const onclick = ajax ? ' onclick="OsAjax(arguments[0] || window.event,\'wt9_wtSaveButton\',\'' + ajaxTarget + '\',\'\',\'' + ajaxFields + '\',\'\'); return false;"' : '';
  return '<html><body><form method="post" action="' + escape(action) + '">' +
    (state ? '<input type="hidden" name="__OSVSTATE" id="__OSVSTATE" value="osv-rendered">' : '') +
    '<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="">' +
    '<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="C2EE9ABB">' +
    '<input type="text" name="wt5$wtSearch" id="wt5_wtSearch" value="rendered search">' +
    '<input type="checkbox" name="wt6$wtActive" id="wt6_wtActive" checked>' +
    '<input type="checkbox" name="wt7$wtArchived" id="wt7_wtArchived">' +
    '<input type="submit" name="wt9$wtSaveButton" id="wt9_wtSaveButton" value="Save"' + onclick + '>' +
    '<input type="submit" name="wt10" id="wt10" value="Other">' + extra + '</form></body></html>';
}

// ---- shared worker harness (offline: synthetic source, lock, vault and fetch) ----
const sha = value => createHash('sha256').update(value).digest('hex');
export const loginForm = () => '<form method="post" action="Login.aspx">' +
  '<input type="hidden" name="__OSVSTATE" id="__OSVSTATE" value="login-state"><input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="">' +
  '<input type="text" id="x_wtUserNameInput" name="x$wtUserNameInput"><input type="password" id="x_wtPasswordInput" name="x$wtPasswordInput">' +
  '<input type="submit" id="x_wt13" name="x$wt13" value="Log In"></form>';
export const html = body => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
export function workerFixture(t, contract = actionContract()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-traditional-action-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '.local/debugger/operation'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'model.oml'); fs.writeFileSync(file, 'synthetic Traditional action source');
  contract.binding.sourceSha256 = sha(fs.readFileSync(file)); contract.sourceContract = { path: file, sha256: contract.binding.sourceSha256 };
  const operationId = randomUUID(), sessionId = 'a'.repeat(32), binding = appUserBinding(contract.binding, sessionId);
  const lock = path.join(root, '.local/debugger/native-runs/o11', contract.binding.host, contract.binding.moduleKey + '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, JSON.stringify({ operationId }));
  const descriptor = { credentialRef: randomUUID(), binding, expiresAt: new Date(Date.now() + 600000).toISOString(), state: 'credentials-entered' };
  const input = { root, directory, contract, operationId, scenarioId: 'scenario-0', timeoutSeconds: 5, context: 'app-user', descriptor, inputs: {} };
  const vault = async () => ({ ok: true, kind: 'credentials', binding, expiresAt: descriptor.expiresAt, username: 'fixture-user', password: 'fixture-password' });
  return { input, vault, contract };
}
// Login page, login POST (302), original screen GET, then whatever `rest` answers.
export const original = (requests, rest, page = screenPage()) => async (url, options) => {
  requests.push({ url, method: options.method, body: options.body ?? null, redirect: options.redirect, headers: options.headers });
  if (options.redirect !== 'manual') throw Error('redirects must not be followed');
  if (requests.length === 1) return html(loginForm());
  if (requests.length === 2) return new Response('', { status: 302, headers: { Location: '/HeadlessTrad_UI/', 'Set-Cookie': 'OSAUTH=fixture; Secure; HttpOnly; Path=/HeadlessTrad_UI/' } });
  if (requests.length === 3) return html(page);
  return rest(url, options);
};
export const timersFake = () => { let id = 0; const pending = new Map();
  return { pending, setTimeout: (fn, ms) => { pending.set(++id, { fn, ms }); return id; }, clearTimeout: handle => { pending.delete(handle); },
    fire: ms => { for (const [handle, timer] of [...pending]) if (timer.ms === ms) { pending.delete(handle); timer.fn(); } } }; };
export const inspectionFake = () => { const listeners = new Set();
  return { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, emit: event => { for (const l of [...listeners]) l(event); }, listeners }; };
