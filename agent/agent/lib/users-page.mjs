import { AgentError } from './errors.mjs';

// What the agent sends to the Users application, read from the page the agent itself fetched (fase4-28 r4, the second review, P1). The table
// below is the whole of it: for each operation the route, the control and the fields. There is no generic POST: the server names an
// operation and its ids, and the agent builds the request from the real page. A page that does not have exactly what the table expects
// is refused (USERS_PAGE_NOT_KNOWN): it may not work, but it never sends something else. delete, revoke-role and remove-group are not here.
// Pure: no file, process or network. The native core has the same rules (UsersPage.cs), and tests/native/users.test.mjs compares them.
export class PageNotKnown extends AgentError { constructor(what) { super('USERS_PAGE_NOT_KNOWN', 'This page is not the one this agent knows (' + what + '); nothing was sent.', { executed: false }); } }
const unknown = what => { throw new PageNotKnown(what); };

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = text => String(text ?? '').replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g, (_, dec, hex, name) => {
  if (name) return ENTITIES[name];
  const code = dec ? Number(dec) : parseInt(hex, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : '';
});
// A value read from a page, for a window: one line, nothing that hides or reorders text.
const HIDDEN = /[\u0000-\u001f\u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]+/g;
export const cleanText = (text, max = 120) => {
  const line = decode(String(text ?? '').replace(/<[^>]*>/g, ' ')).replace(HIDDEN, ' ').replace(/ +/g, ' ').trim();
  return line.length > max ? line.slice(0, max) + '...' : line;
};
// A value the server asks to write: exactly what will be sent and shown, so nothing may hide in it.
export const plainValue = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/.test(value) && !/^ | $| {2}/.test(value);

const TAG = /<(input|select|textarea|a|button)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const ATTR = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
function attrsOf(text) {
  const attrs = {};
  for (const m of String(text).matchAll(ATTR)) { const key = m[1].toLowerCase(); if (!Object.hasOwn(attrs, key)) attrs[key] = decode(m[2] ?? m[3] ?? m[4] ?? ''); }
  return attrs;
}
const stripped = html => String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
function controlsOf(text) {
  const list = [];
  for (const m of text.matchAll(TAG)) {
    const tag = m[1].toLowerCase(), attrs = attrsOf(m[2]);
    const after = m.index + m[0].length;
    const inner = () => { const end = text.toLowerCase().indexOf('</' + tag, after); return end < 0 ? '' : text.slice(after, end); };
    let value = attrs.value ?? '', label = '';
    if (tag === 'a' || tag === 'button') label = cleanText(inner(), 200);
    if (tag === 'textarea') value = decode(inner());
    if (tag === 'select') {
      const options = [...inner().matchAll(/<option\b((?:"[^"]*"|'[^']*'|[^'">])*)>([^<]*)/gi)].map(o => ({ attrs: attrsOf(o[1]), text: decode(o[2]).trim() }));
      const chosen = options.find(o => Object.hasOwn(o.attrs, 'selected')) ?? options[0];
      value = chosen ? chosen.attrs.value ?? chosen.text : '';
    }
    list.push({ tag, attrs, value, label, name: attrs.name ?? null, id: attrs.id ?? '', type: (attrs.type ?? (tag === 'button' ? 'submit' : tag === 'input' ? 'text' : tag)).toLowerCase() });
  }
  return list;
}
export function parsePage(html) {
  const text = stripped(html);
  const forms = [...text.matchAll(/<form\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)];
  if (forms.length !== 1) unknown('its form');
  const attrs = attrsOf(forms[0][1]);
  if ((attrs.method ?? '').toLowerCase() !== 'post') unknown('its form');
  return { action: attrs.action ?? '', text, controls: controlsOf(text) };
}
const captionOf = c => (c.attrs.value ?? '') || c.label;
const one = (list, what) => (list.length === 1 ? list[0] : unknown(what));
const byId = (page, suffix) => one(page.controls.filter(c => c.id.endsWith(suffix)), suffix);
const byCaption = (page, caption) => one(page.controls.filter(c => captionOf(c) === caption && c.type !== 'hidden' && !Object.hasOwn(c.attrs, 'disabled')), caption);

const SKIPPED = new Set(['submit', 'button', 'image', 'reset']);
const EVENT = new Set(['__EVENTTARGET', '__EVENTARGUMENT', '__AJAX', '__AJAXEVENT']);
function fieldsOf(page, ajax) {
  const pairs = [];
  for (const c of page.controls) {
    if (!c.name || c.tag === 'a' || SKIPPED.has(c.type) || EVENT.has(c.name)) continue;
    if (c.type === 'checkbox' || c.type === 'radio') {
      if (Object.hasOwn(c.attrs, 'checked')) pairs.push([c.name, ajax && Object.hasOwn(c.attrs, 'disabled') ? 'on' : c.value || 'on']);
      else if (ajax && c.type === 'checkbox') pairs.push([c.name, 'off']);
      continue;
    }
    pairs.push([c.name, c.value]);
  }
  return pairs;
}
function eventOf(c) {
  const source = (c.attrs.href ?? '') + '\n' + (c.attrs.onclick ?? '');
  const ajax = /OsAjax\([^,]*,\s*'([^']*)'\s*,\s*'([^']*)'/.exec(source);
  if (/OsAjax/.test(source)) return ajax ? { kind: 'ajax', target: ajax[2] } : unknown('its control');
  const back = /__doPostBack\('([^']*)','([^']*)'\)/.exec(source);
  if (back) return { kind: 'postback', target: back[1], argument: back[2] };
  if (c.tag !== 'a' && (c.type === 'submit' || c.type === 'image') && c.name && !/\.submit\(/.test(source)) return { kind: 'submit' };
  return unknown('its control');
}
// The form as a browser would send it for this one control, with these fields changed: nothing else changes.
function requestFor(page, control, updates = {}) {
  const event = eventOf(control);
  const names = new Set(page.controls.map(c => c.name).filter(Boolean));
  for (const key of Object.keys(updates)) if (!names.has(key)) unknown(key);
  const pairs = fieldsOf(page, event.kind === 'ajax').filter(([k]) => !Object.hasOwn(updates, k));
  pairs.push(...Object.entries(updates));
  if (event.kind === 'submit') pairs.push([control.name, control.attrs.value ?? '']);
  else if (event.kind === 'postback') pairs.push(['__EVENTTARGET', event.target], ['__EVENTARGUMENT', event.argument]);
  else {
    const name = control.name ?? event.target;
    pairs.push(['__EVENTTARGET', name], ['__EVENTARGUMENT', ''], ['__AJAX', '1280,1024,' + (control.id || name.replaceAll('$', '_')) + ',0,0,0,0,0,0,']);
  }
  return pairs;
}
// The form's own address, which must be the route of the table. A form that names another page or another user sends nothing.
function urlFor(page, host, route) {
  const expected = `https://${host}${route}`, [path] = route.split('?');
  const action = page.action;
  const full = !action ? expected : action.startsWith('https://') ? action : action.startsWith('/') ? `https://${host}${action}` : `https://${host}/Users/${action.replace(/^\.\//, '')}`;
  if (full !== expected && full !== `https://${host}${path}`) unknown('the address of its form');
  return expected;
}
const titleOf = page => {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(page.text);
  if (h1 && cleanText(h1[1])) return cleanText(h1[1]);
  let last = '';
  for (const m of page.text.matchAll(/<div\b((?:"[^"]*"|'[^']*'|[^'">])*)>([^<]*)/gi)) { const attrs = attrsOf(m[1]); if ((attrs.id ?? '').endsWith('wtTitle') && /(?:^|\s)title(?:\s|$)/i.test(attrs.class ?? '') && cleanText(m[2])) last = cleanText(m[2]); }
  return last;
};
// The username in the details table of a user's page: never a label from a request.
function usernameOf(page) {
  const table = /<table\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/table\s*>/gi;
  for (const m of page.text.matchAll(table)) {
    if (!(attrsOf(m[1]).id ?? '').endsWith('wtUserShow')) continue;
    for (const row of m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map(c => cleanText(c[1], 256));
      if (cells.length === 2 && cells[0] === 'Username' && cells[1]) return cells[1];
    }
  }
  return unknown('the username of this user');
}
const userRoute = (page, id) => `/Users/${page}.aspx${id ? `?UserId=${id}` : ''}`;
const CHANGE_FIELD = Object.freeze({ name: 'wtUser_Name', username: 'wtUser_Username', email: 'wtUser_Email', phone: 'wtUser_Phone' });
const changesToFields = (page, changes) => Object.fromEntries(Object.entries(changes ?? {}).map(([key, value]) => [byId(page, CHANGE_FIELD[key]).name ?? unknown(key), value]));

// The table. Each entry: the pages the agent reads, and from them what it will send and what the person sees.
export const ACTIONS = Object.freeze({
  activate: { read: p => [userRoute('User_Show', p.userId)], text: 'Activate this user' },
  deactivate: { read: p => [userRoute('User_Show', p.userId)], text: 'Deactivate this user: the user loses access' },
  'grant-role': { read: p => [userRoute('User_Show', p.userId), `/Users/Role_Show.aspx?RoleId=${p.targetId}`], text: 'Give this role to this user' },
  'add-group': { read: p => [userRoute('User_Show', p.userId), `/Users/Group_Show.aspx?GroupId=${p.targetId}`], text: 'Add this user to this group: the user gets its roles' },
  update: { read: p => [userRoute('User_Edit', p.userId), userRoute('User_Show', p.userId)], text: 'Change the details of this user' },
  create: { read: () => [userRoute('User_Edit')], text: 'Create this user' },
  'set-password': { read: p => [userRoute('User_Show', p.userId)], text: 'Set a new password for this user' },
});
const SHOW = { activate: 'Set as Active', deactivate: 'Set as Inactive' };
const MEMBERSHIP = { 'grant-role': { input: 'wtNewRole', label: 'Role' }, 'add-group': { input: 'wtNewGroupInput', label: 'Group' } };

// -> {url, fields, secretFields, rows, username}: what goes out and what the window says. pages: the html of ACTIONS[action].read, in order.
export function planWrite({ action, host, userId, targetId, changes }, pages) {
  const rule = ACTIONS[action] ?? unknown('its operation');
  const page = parsePage(pages[0]);
  const rows = [{ label: 'What will happen', value: rule.text }];
  const user = username => { rows.push({ label: 'User id', value: userId }, { label: 'Username', value: username, data: true }); const name = titleOf(page); if (name) rows.push({ label: 'Name', value: name, data: true }); };
  if (SHOW[action]) {
    const username = usernameOf(page);
    user(username);
    const link = byId(page, 'wtEnableDisableLink');
    if (captionOf(link) !== SHOW[action]) unknown('its status');
    return { url: urlFor(page, host, userRoute('User_Show', userId)), fields: requestFor(page, link), secretFields: [], rows, username };
  }
  if (MEMBERSHIP[action]) {
    const username = usernameOf(page);
    user(username);
    const { input: suffix, label } = MEMBERSHIP[action];
    const target = parsePage(pages[1]), targetName = titleOf(target);
    if (!targetName) unknown('the name of this ' + label.toLowerCase());
    rows.push({ label: label + ' id', value: targetId }, { label: label, value: targetName, data: true });
    // Only what stands between this input and the next block's: the Add of the group is never the Add of the role.
    const input = byId(page, suffix), at = page.controls.indexOf(input), rest = page.controls.slice(at + 1);
    const next = rest.findIndex(c => /(?:wtNewRole|wtNewGroupInput)$/.test(c.id)), after = next < 0 ? rest : rest.slice(0, next);
    const auto = after.find(c => c.id.endsWith('wttxtAutoCompleteValue')) ?? unknown('its autocomplete');
    const add = after.find(c => captionOf(c) === 'Add' && c.type !== 'hidden') ?? unknown('its Add');
    if (!input.name || !auto.name) unknown('its fields');
    return { url: urlFor(page, host, userRoute('User_Show', userId)), fields: requestFor(page, add, { [input.name]: targetName, [auto.name]: targetId }), secretFields: [], rows, username };
  }
  if (action === 'update') {
    const username = usernameOf(parsePage(pages[1]));
    rows.push({ label: 'User id', value: userId }, { label: 'Username now', value: username, data: true });
    for (const [key, value] of Object.entries(changes)) rows.push({ label: 'New ' + key, value });
    return { url: urlFor(page, host, userRoute('User_Edit', userId)), fields: requestFor(page, byCaption(page, 'Save'), changesToFields(page, changes)), secretFields: [], rows, username };
  }
  if (action === 'create') {
    const secretFields = ['wtPasswordInput', 'wtConfirmPasswordInput'].map(suffix => { const c = byId(page, suffix); if (c.type !== 'password' || !c.name) unknown(suffix); return c.name; });
    const save = byCaption(page, 'Save');
    const fields = requestFor(page, save, changesToFields(page, changes)).filter(([k]) => !secretFields.includes(k));
    return { url: urlFor(page, host, userRoute('User_Edit')), fields, secretFields, rows, username: changes.username };
  }
  // set-password has two steps: the button that shows the form, then its Save with the new password (planSavePassword).
  const username = usernameOf(page);
  user(username);
  const button = byCaption(page, 'Set Password');
  return { url: urlFor(page, host, userRoute('User_Show', userId)), fields: requestFor(page, button), secretFields: [], rows, username };
}
// The answer of the Set Password button, a whole page or an OsAjax reply, gives the form of the second step.
export function planSavePassword({ host, userId }, firstHtml, reply) {
  const route = userRoute('User_Show', userId), first = parsePage(firstHtml);
  let page;
  if (/^\s*(?:<!doctype|<html)/i.test(reply)) page = parsePage(reply);
  else {
    const state = /"__OSVSTATE"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(reply);
    if (!state) unknown('the password form');
    const markup = [...reply.matchAll(/"((?:[^"\\]|\\.)*)"/gs)].map(m => { try { return JSON.parse('"' + m[1] + '"'); } catch { return ''; } }).filter(text => /<input\b/i.test(text)).join('');
    const refreshed = controlsOf(stripped(markup)), names = new Set(refreshed.map(c => c.name).filter(Boolean));
    const retained = first.controls.filter(c => c.name && !names.has(c.name) && !SKIPPED.has(c.type) && c.tag !== 'a').map(c => (c.name.endsWith('__OSVSTATE') ? { ...c, value: JSON.parse('"' + state[1] + '"'), attrs: { ...c.attrs } } : c));
    page = { action: first.action, text: stripped(markup), controls: [...retained, ...refreshed] };
  }
  const secretFields = ['wtNewPasswordInput', 'wtConfirmPasswordInput'].map(suffix => { const c = byId(page, suffix); if (c.type !== 'password' || !c.name) unknown(suffix); return c.name; });
  const save = byCaption(page, 'Save');
  const fields = requestFor(page, save).filter(([k]) => !secretFields.includes(k));
  return { url: urlFor(page, host, route), fields, secretFields };
}
// A search of the two lists: the one POST that changes nothing, built here too.
export function planSearch({ host, inactive, text }, html) {
  const page = parsePage(html), route = `/Users/${inactive ? 'Inactive_Users' : 'User_List'}.aspx`;
  const input = byId(page, 'wtSearchInput');
  if (!input.name) unknown('its search');
  return { url: urlFor(page, host, route), fields: requestFor(page, byCaption(page, 'Search'), { [input.name]: text }), route };
}
// A page that asks to sign in again: the session is gone.
export const isLoginPage = html => /<form\b[^>]*\baction\s*=\s*["'][^"']*Login\.aspx/i.test(String(html));
export const userPage = (id) => userRoute('User_Show', id);
