// Semantic O11 operations over discovered Service Center forms, with durable receipts (port of
// kernel/scripts/service_center/client.py). The same parsers serve both page transports: direct HTTPS after the vault
// form login (Transport) and the connected Studio's own web window (StudioWebTransport). Web Forms postbacks are
// rebuilt from the page's own form state (__OSVSTATE/__VIEWSTATE/__EVENTVALIDATION); server scripts are never run.
//
// Modern Service Center pages: lists are read only from the page's content (div.sc-content-main), never from the
// sidebar's Recent Items; a module's tabs are div[data-tab] panels of the same page; anchors post back through
// __doPostBack with __EVENTTARGET/__EVENTARGUMENT added here; OsAjax replies are read only through their refreshed
// "__OSVSTATE" and the HTML they carry. Pages whose layout is only ASSUMED refuse any other layout with LAYOUT_UNKNOWN
// and the page-layout read that captures them live.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from './bridge.mjs';
import { BridgeError, LayoutError, ProtocolError, ScheduleInModule, TargetPending, connectStudio, continuation } from './errors.mjs';
import { Document, Page, button, caption, classes, confirmText, controlValue, controls, escape, formFields, isVoid, lower, postbackTarget } from './html.mjs';
import { NOT_SENT, STATE, Transport } from './http.mjs';
import { parseQs, quote, urlsplit } from './urls.mjs';
import { canonicalUuid, escapeRegExp, fingerprint, fold, rstrip, same, sha256, splitlines, strip, utc, words } from './util.mjs';
import { excelTime, xlsxRows } from './xlsx.mjs';

// The Timers log is Cyclic_Job_Logs.aspx (Monitoring > Timers, live on 11.42); Timer_Logs.aspx does not exist.
export const LOG_PAGES = { error: 'Error_Logs.aspx', general: 'General_Logs.aspx', integration: 'Integration_Logs.aspx', timer: 'Cyclic_Job_Logs.aspx' };
const EXPORTABLE = ['error', 'integration'];
// Log filters: the visible label before the control, or the name suffix of the O11 English pages (matrix L1, L6-L8).
const LOG_FILTERS = { application: [['application'], ['wtApplication_Selector']], module: [['module', 'espace'], ['wtEspace_Selector']],
  message: [['message'], ['wtInput1']], source: [['source'], ['wtInput7', 'wtSourceInput']], server: [['server'], ['wtInput4']],
  type: [['type'], ['wtTypeSelector']], action: [['action'], ['wtActionInput']], timer: [['timer', 'name'], ['wtTimerInput']],
  since: [['from', 'from date', 'start date'], ['wtFilter_FromDate']], until: [['to', 'to date', 'end date'], ['wtFilter_ToDate2']] };
// General and timer logs are ASSUMED pages: their listing must show these columns or the page is refused.
const ASSUMED_LOGS = { general: ['module', 'message'], timer: ['module', 'timer'] };
export const ACTIONS = { 'timer-run': ['Run Now', 'Run now'], 'timer-deactivate': ['Deactivate'], 'timer-activate': ['Activate'],
  'property-set': ['Apply', 'Save'], 'timer-schedule': ['Apply', 'Save'] };
export const VALUE_ACTIONS = ['property-set', 'timer-schedule'];
// The timer page's schedule editor (matrix T4, ASSUMED): label or name suffix of each control.
export const SCHEDULE = { recurrence: [['recurrence'], 'wtSchedule_Recurrence'], at: [['at'], 'wtSchedule_Time'],
  every: [['every (minutes)', 'every'], 'wtSchedule_Interval'], timeout: [['timeout (minutes)', 'timeout'], 'wtTimeout'] };
// Page writes beyond timers and properties: the target keys of their journal identity.
export const WEB_WRITES = { 'solution-create': ['solution'], 'solution-add-component': ['solution', 'component'],
  'solution-remove-component': ['solution', 'component'], 'db-connection-create': ['connection'], 'db-connection-test': ['connection'],
  'db-connection-delete': ['connection'], 'extension-db-connection': ['extensionId', 'connection'], 'integration-log-level': ['moduleId', 'integration'] };
// Page writes whose form carries the database login: it goes only as sc_web secretRefs, filled inside the Studio.
export const SECRET_WRITES = ['db-connection-create', 'db-connection-test'];
const INTEGRATION_LINKS = [['consumed-rest', /eSpace_RestWebReference_Edit\.aspx\?[^#]*?RestWebreferenceId=(\d+)/i],
  ['exposed-rest', /eSpace_RestExpose_Edit\.aspx\?[^#]*?RestExposeId=(\d+)/i], ['consumed-soap', /eSpace_SoapConsume_Edit\.aspx\?[^#]*?SoapConsumeId=(\d+)/i],
  ['consumed-soap', /eSpace_WebReference_Edit\.aspx\?[^#]*?WebreferenceId=(\d+)/i], ['exposed-soap', /eSpace_SoapExpose_Edit\.aspx\?[^#]*?SoapExposeId=(\d+)/i],
  ['exposed-soap', /eSpace_WebService_Edit\.aspx\?[^#]*?WebServiceId=(\d+)/i]];
// A module page's tabs: the div[data-tab] panel of the modern page; older versions link one page per tab.
const TABS = { timers: ['tab-Timers', ['timers']], 'site-properties': ['tab-SiteProperties', ['site properties', 'siteproperties']], integrations: ['tab-Integrations', ['integrations']] };
const EMPTY = /\bno (?:\w+ ){0,2}(?:were )?(?:found|to show|available)\b/i;
const PAGE_PATH = /^[A-Za-z][A-Za-z0-9_]{0,80}\.aspx(?:\?[A-Za-z0-9_.=&%-]{0,500})?$/;
// States after which the target lock is released: done, or never sent, or definitely refused by the server.
const RELEASED = ['confirmed', 'accepted', 'refused', 'rejected'];
// P6 (friction c8b1090d, 2026-10-08): an uncertain receipt closes only by a reading that proves its outcome, or by the
// user's explicit discard. Closed states of a resolution: confirmed (the effect is observed), not-executed (long after the
// attempt nothing ran), obsolete (the target no longer exists), discarded (the user's words). Each one frees the target.
export const UNSURE = ['uncertain', 'accepted-unverified'];
export const RESOLVED = ['confirmed', 'not-executed', 'obsolete', 'discarded'];
// Run Now puts the timer on the scheduler at once; a run still absent this long after the attempt did not come from it.
export const TIMER_RUN_GRACE_MS = 15 * 60 * 1000;
// A 'sending' receipt this old has no live sender left (every call ends within minutes): a resolution may close it.
export const STALE_SENDING_MS = 30 * 60 * 1000;
// The text of a local failure for a receipt: our own refusal texts, never the text of a foreign error (it may carry a value).
const localReason = error => (error instanceof ProtocolError ? error.message : String(error?.name ?? 'Error')).slice(0, 300);
const NEVER = /^(?:never|-|—|n\/a|none|not run yet|)$/i;

// repr() of a short text, as the Python messages quote names.
export const repr = text => { const s = String(text); const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(q === "'" ? /'/g : /"/g, '\\' + q).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + q; };
const pyStr = value => (value === null || value === undefined ? 'None' : String(value));
const typeOf = (node, fallback = '') => lower(node.attr('type', fallback));

// A control lookup on an ASSUMED page: a missing or ambiguous control means an unknown layout.
export async function assumed(page, what, find) {
  try { return await find(); } catch (error) {
    if (error instanceof BridgeError || !(error instanceof ProtocolError)) throw error;
    throw new LayoutError(page.url, what, error.message.replace(/\.+$/, ''));
  }
}

export const observedValue = field => (typeOf(field) === 'checkbox' ? (field.has('checked') ? 'true' : 'false') : controlValue(field));
// What the page shows in a control: a select's chosen option text, else its value.
export const shown = field => (field.tag === 'select' ? selectedText(field) : observedValue(field));
export function expectedValue(field, value) {
  if (typeOf(field) !== 'checkbox') return value;
  if (!['true', 'false'].includes(value.toLowerCase())) throw new ProtocolError('Boolean properties require true or false');
  return value.toLowerCase();
}

export const content = page => page.doc.content();
export function heading(page) {
  const found = content(page).all('div', 'h1', 'h2').filter(n => n.tag === 'h1' || n.tag === 'h2' || classes(n).includes('heading2')).map(n => n.text);
  return found[0] ?? '';
}
export const errors = page => page.doc.all().filter(n => n.text && /(?:Feedback_Message_Error|ValidationMessage|ErrorMessage)/i.test(n.attr('class', '') ?? ''));
export const acknowledged = (page, pattern) => page.doc.all().some(n => new RegExp(pattern, 'i').test(n.text) && /Feedback_Message_Success/i.test(n.attr('class', '') ?? ''));

export function checked(page) {
  // An expired session answers with the login page at the asked URL: its form posts to Login.aspx.
  const loginForm = page.doc.all('form').some(f => /^_?login(?:sso)?\.aspx$/i.test(urlsplit(f.attr('action', '') || '').path.split('/').pop()));
  if (urlsplit(page.url).path.toLowerCase().endsWith('/login.aspx') || loginForm) throw new ProtocolError('Service Center login required or session expired');
  // Feedback may echo a password/property value. Never return raw server feedback.
  if (errors(page).length) throw new ProtocolError('Service Center reported a validation/permission error');
  return page;
}

const cellsOf = row => row.children.filter(c => c?.tag === 'th' || c?.tag === 'td');
// Header-keyed rows of the listings inside root (default: the page content, never the sidebar).
export function tables(page, redactValues = false, root = null) {
  const result = [];
  for (const table of (root ?? content(page)).all('table')) {
    if (inside(table, /RecentItems|sc-content-left/i)) continue;
    const rows = table.all('tr').filter(r => r.ancestor('table') === table);
    let headers = [];
    for (const row of rows) {
      const cells = cellsOf(row);
      if (!cells.length) continue;
      if (cells.some(c => c.tag === 'th')) { headers = cells.map((c, i) => c.text || `column${i + 1}`); continue; }
      if (!headers.length) continue; // Ignore layout tables rather than inventing record schemas.
      if (cells.length === 1 && headers.length > 1 && EMPTY.test(cells[0].text)) continue; // the listing's own "No items to show..." row
      const values = {};
      cells.forEach((c, i) => { const key = i < headers.length ? headers[i] : `column${i + 1}`; values[key] = redactValues && /value|valor/i.test(key) ? '<redacted>' : c.text; });
      const links = cells.flatMap((c, i) => (redactValues && (i >= headers.length || /value|valor/i.test(headers[i])) ? []
        : c.all('a').filter(a => a.attr('href')).map(a => ({ name: a.text, href: a.attr('href') }))));
      result.push({ fields: values, links });
    }
  }
  return result;
}

// Label/value rows of header-less detail tables (BPT process, instance and activity pages).
export function summary(page) {
  const found = {};
  for (const table of content(page).all('table')) {
    const rows = table.all('tr').filter(r => r.ancestor('table') === table);
    if (rows.some(r => r.children.some(c => c?.tag === 'th'))) continue; // a listing, not a detail table
    for (const row of rows) {
      const texts = row.children.filter(c => c?.tag === 'td' && c.text).map(c => c.text);
      if (texts.length >= 2 && texts[0].length <= 60) { const key = strip(texts[0], ' :'); if (!Object.hasOwn(found, key)) found[key] = texts.at(-1); }
    }
  }
  return found;
}

export function nextLink(page) {
  const links = content(page).all('a').filter(a => (['next', 'next ›', '›', '>', 'próxima', 'seguinte'].includes(fold(a.text)) || a.attr('rel') === 'next')
    && !a.has('disabled') && !lower(a.attr('class', '')).includes('disabled') && (a.attr('href') || a.attr('onclick')));
  return links.length === 1 ? links[0] : null;
}

export function inside(node, pattern) {
  for (let n = node.parent; n; n = n.parent) if (pattern.test((n.attr('id', '') ?? '') + ' ' + (n.attr('class', '') ?? ''))) return true;
  return false;
}

// Fillable controls of a form with their visible label: <label for>, aria-label/title, else the text right before the
// control (Service Center renders labels with for='' and per-DBMS parameters as text before a generated name).
export function labels(page, form) {
  const found = new Map(); let last = '';
  const walk = node => {
    for (const c of node.children) {
      if (typeof c === 'string') { const text = words(c).join(' '); if (text.length > 1) last = text; }
      else if (c.tag === 'script' || c.tag === 'style') continue;
      else if (['input', 'select', 'textarea'].includes(c.tag)) {
        const kind = typeOf(c, 'text');
        if (c.attr('name') && !c.has('disabled') && !['hidden', 'submit', 'button', 'image', 'reset'].includes(kind)) {
          found.set(c.attr('name'), [fold(strip(page.doc.label(c) || last, ' :*')), c]);
          last = '';
        }
      } else walk(c);
    }
  };
  walk(form);
  return found;
}
// labels() of one form's controls inside the page content. The modern form wraps the whole page: walking it from the
// top would give the hidden telemetry fields (*wtButtonNameField) the sidebar's last text as their label.
export const formLabels = (page, form) => new Map([...labels(page, content(page))].filter(([, [, n]]) => n.ancestor('form') === form));
const entries = map => [...map].map(([name, [label, n]]) => ({ name, label, n }));

export function one(items, what) {
  if (items.length !== 1) throw new ProtocolError(`Expected exactly one ${what}; found ${items.length}`);
  return items[0];
}

// ---- the timer page as Service Center serves it (C40)
// Label/value rows of a timer page, by their visible labels: a two-part row (label, value) of the modern page's columns,
// or a header-less detail table. A part with form controls is an editor, never a value.
const TIMER_FIELDS = { module: ['module', 'espace'], action: ['action'], status: ['status', 'state'], schedule: ['schedule'],
  effectiveSchedule: ['effective schedule'], defaultSchedule: ['default schedule'], lastRun: ['last run'], nextRun: ['next run'],
  timeout: ['timeout', 'timeout (minutes)', 'timeout in minutes'], priority: ['priority'] };
const TIMER_LABELS = new Map(Object.entries(TIMER_FIELDS).flatMap(([key, names]) => names.map(n => [n, key])));
export function timerFields(page) {
  const found = {};
  const add = (label, value) => {
    const key = TIMER_LABELS.get(fold(strip(String(label ?? ''), ' :')));
    if (key && !Object.hasOwn(found, key) && typeof value === 'string') found[key] = value;
  };
  for (const node of content(page).all()) {
    if (['table', 'tr', 'script', 'style', 'select'].includes(node.tag)) continue;
    const parts = node.children.filter(c => typeof c !== 'string' && !['script', 'style'].includes(c.tag));
    if (parts.length === 2 && parts[0].text && !parts[1].all('input', 'select', 'textarea', 'button').length
      && !['input', 'select', 'textarea', 'button'].includes(parts[1].tag)) add(parts[0].text, parts[1].text);
  }
  for (const [label, value] of Object.entries(summary(page))) add(label, value);
  return found;
}

// Whether the page carries the schedule editor SSAM writes through: every control of SCHEDULE identified exactly once
// (by its label or name suffix). The live 11.42 timer page had none (session dd2b79c0, 2026-10-05 01:06: "Expected exactly
// one timer schedule recurrence control; found 0").
export function scheduleEditor(page, form) {
  const found = entries(formLabels(page, form));
  return Object.values(SCHEDULE).every(([names, suffix]) => found.filter(({ name, label }) => name.endsWith(suffix) || names.includes(label)).length === 1);
}

// The refusal of timer-schedule on a page without that editor: the module change, with what the page shows now.
export function scheduleInModule(page, name, requested = null) {
  const fields = timerFields(page);
  return new ScheduleInModule({ timer: name, module: fields.module ?? null, schedule: moduleSchedule(requested),
    current: Object.fromEntries(['schedule', 'effectiveSchedule', 'defaultSchedule', 'nextRun'].filter(k => Object.hasOwn(fields, k)).map(k => [k, fields[k]])) });
}

// The schedule as the timer's Schedule property in the module takes it (the texts the Studio accepted in session
// dd2b79c0: "Every 60 minutes", "Every day at 00:00", "Every Monday at 00:05"); null when the request names no interval
// or daily time.
export function moduleSchedule(value) {
  if (!value || typeof value !== 'object') return null;
  const recurrence = fold(String(value.recurrence ?? '')), every = String(value.every ?? '').trim(), at = String(value.at ?? '').trim();
  const interval = /^(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i.exec(every);
  const minutes = interval ? Number(interval[1]) * (/^h/i.test(interval[2] ?? '') ? 60 : 1) : null;
  if (minutes && (!recurrence || /every|minute|hour|interval|n minutes/.test(recurrence))) return `Every ${minutes} minutes`;
  const time = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (time && Number(time[1]) < 24 && Number(time[2]) < 60 && (!recurrence || /daily|day/.test(recurrence))) return `Every day at ${time[1].padStart(2, '0')}:${time[2]}`;
  return null;
}
export function selectedText(select) {
  const options = select.all('option');
  const chosen = options.find(o => o.has('selected')) ?? options[0] ?? null;
  return chosen ? chosen.text : '';
}
const optionValue = o => o.attr('value', o.text);
const bySuffix = (form, suffix, what) => one(controls(form).filter(n => n.attr('name').endsWith(suffix)), what);

// The div[data-tab] content panel of a tab of the modern page (all tabs are rendered inline), or null when the page has
// no such tab markup.
export function tabPanel(page, tab) {
  const marked = content(page).all('div').filter(n => n.attr('data-tab') === tab);
  const panels = marked.filter(n => !classes(n).includes('tabs-header-item'));
  if (!marked.length) return null;
  if (panels.length !== 1) throw new LayoutError(page.url, 'Module page', `the ${tab} tab has ${panels.length} content panels`);
  return panels[0];
}

// The refreshed __OSVSTATE of an OsAjax reply: the "__OSVSTATE","<state>" pair is its only evidenced token.
export const ajaxState = reply => /"__OSVSTATE"\s*[,:]\s*"([A-Za-z0-9+/=_.:-]+)"/.exec(reply)?.[1] ?? null;
// The HTML an OsAjax reply carries in its string literals (the widgets it replaces); the envelope is not parsed.
export function ajaxMarkup(reply) {
  const found = [];
  for (const [, literal] of reply.matchAll(/"((?:[^"\\]|\\.)*)"/gs)) {
    let text;
    try { text = JSON.parse('"' + literal + '"'); } catch { continue; }
    if (/<(?:table|tr|td|a|div|span|select|input)\b/i.test(text)) found.push(text);
  }
  return found;
}
// A page rebuilt from an OsAjax reply: the original form's fields with the refreshed state, around the replaced
// markup, so the next postback (Next, Export) carries that state as the browser's form would.
export function ajaxPage(page, reply) {
  const state = ajaxState(reply); const fragments = ajaxMarkup(reply); const form = page.doc.first('form');
  if (state === null || !fragments.length || !form) throw new LayoutError(page.url, 'OsAjax reply', 'it carries no refreshed form state or no list markup');
  const hidden = formFields(form).map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(k.endsWith('__OSVSTATE') ? state : v)}">`).join('');
  return new Page(page.url, new Document(`<form method="post" action="${escape(form.attr('action') || '')}">${hidden}<div class="sc-content-main">${fragments.join('')}</div></form>`));
}

// A linked page and its query parameter names, never their values.
export function pageName(href) {
  const parts = urlsplit(href);
  const names = Object.keys(parseQs(parts.query, true)).sort();
  return parts.path.split('/').at(-1) + (names.length ? '?' + names.map(n => n + '=').join('&') : '');
}

// Markup for calibration: scripts dropped, input values and text areas emptied (button captions and option values
// kept), so no field value is stored.
export function skeleton(node) {
  if (typeof node === 'string') return escape(node, false);
  if (node.tag === 'script' || node.tag === 'style') return '';
  const attrs = new Map(node.attrs);
  if (node.tag === 'input' && !['submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(lower(attrs.has('type') ? attrs.get('type') : 'text'))) attrs.delete('value');
  const inner = node.tag === 'textarea' ? '' : node.children.map(skeleton).join('');
  if (node.tag === 'document') return inner;
  const rendered = [...attrs].map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${escape(v)}"`)).join('');
  return isVoid(node.tag) ? `<${node.tag}${rendered}>` : `<${node.tag}${rendered}>${inner}</${node.tag}>`;
}

// Names only: controls with their labels, buttons, tabs, table headers, postback targets and linked pages.
export function describe(page, root) {
  const form = page.doc.first('form');
  const buttons = root.all('input', 'button').filter(n => ['submit', 'button'].includes(typeOf(n, n.tag === 'button' ? 'submit' : '')));
  const sorted = values => [...new Set(values)].sort();
  return {
    title: heading(page),
    tabs: sorted(root.all('div').filter(n => n.attr('data-tab')).map(n => n.attr('data-tab'))),
    formState: (form ? form.all('input') : []).filter(n => typeOf(n) === 'hidden' && n.attr('name')).map(n => n.attr('name')).sort(),
    controls: entries(labels(page, root)).map(({ name, label, n }) => ({ name, tag: n.tag, type: lower(n.attr('type', n.tag)), label,
      ...(n.tag === 'select' ? { options: n.all('option').map(o => o.text).slice(0, 50) } : {}) })),
    buttons: buttons.map(n => ({ name: n.attr('name', null), caption: (n.attr('value') || n.text).slice(0, 80), scripted: Boolean(n.attr('onclick')) })),
    postbacks: root.all('a').filter(a => postbackTarget(a)).map(a => ({ text: a.text.slice(0, 80), ...postbackTarget(a) })),
    tables: root.all('table').map(t => ({ id: t.attr('id', null), headers: t.all('th').map(c => c.text) })),
    links: sorted(root.all('a').filter(a => a.attr('href') && !/^(?:javascript:|#)/.test(a.attr('href'))).map(a => pageName(a.attr('href')))),
    feedback: sorted(root.all().flatMap(n => (n.text ? classes(n).filter(c => c.startsWith('Feedback_Message_')) : []))),
  };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export class Client {
  constructor(vault, transport = null, exports = null) {
    this.vault = vault;
    this.http = transport ?? new Transport(vault.host);
    this.authenticated = false;
    this.exports = exports ? String(exports) : null;
  }

  async login() {
    if (this.authenticated || this.http.preauthenticated) return;
    const page = await this.http.request('Login.aspx');
    // SSO/captcha/identity-provider flows need their own supported protocol.
    if (!page.doc.login()) throw new ProtocolError('No Service Center password form; SSO login variant is unsupported by this adapter');
    const passwords = page.doc.all('input').filter(n => typeOf(n) === 'password');
    if (passwords.length !== 1) throw new ProtocolError('Ambiguous login form');
    const form = passwords[0].ancestor('form');
    if (!form) throw new Error('password outside a form');
    const users = controls(form).filter(n => ['text', 'email'].includes(typeOf(n, 'text')));
    if (users.length !== 1) throw new ProtocolError('Ambiguous login username field');
    const click = button(page, ['Log in', 'Login', 'Log In', 'Sign in']);
    if (click.ancestor('form') !== form) throw new ProtocolError('Login controls do not belong to the same form');
    const response = await this.http.vaultLogin(page, click, users[0].attr('name'), passwords[0].attr('name'), this.vault);
    checked(response);
    if (response.doc.login()) throw new ProtocolError('Service Center did not accept the vault login; no automatic retry');
    if (!response.doc.all('a', 'input', 'button').some(a => lower((a.attr('href', '') ?? '') + a.text).includes('logout') || lower(a.text).includes('log out')))
      throw new ProtocolError('Could not confirm an authenticated Service Center session');
    this.authenticated = true;
  }

  async get(url) { await this.login(); return checked(await this.http.request(url)); }

  async follow(page, link) {
    const href = link.attr('href', '') ?? '';
    if (/^(?:javascript:|#)/.test(href) || link.attr('onclick')) throw new ProtocolError('Scripted navigation variant unsupported; no JavaScript is executed');
    return this.get(this.http.url(href, page.url));
  }

  // A read postback whose answer is a page, or an OsAjax reply read through its state and markup.
  async readPostback(page, url, fields) {
    const [final, text] = await this.http.reply(url, fields);
    if (/<form\b/i.test(text)) return checked(new Page(final, new Document(text)));
    return ajaxPage(page, text);
  }

  // A read click on a submit control: a plain form post, or the OsAjax request its onclick sends (L7 Filter).
  async click(page, control, updates = null) {
    if (/OsAjax/.test(control.attr('onclick', '') ?? '')) return this.readPostback(page, ...this.http.ajaxPost(page, control, updates));
    return checked(await this.http.submit(page, control, updates));
  }

  // A Web Forms pager (__doPostBack or OsAjax) is replayed as the page's own form post, never as script.
  async nextPage(page, link) {
    if (postbackTarget(link)) return this.readPostback(page, ...this.http.eventPost(page, link));
    return this.follow(page, link);
  }

  // Links that leave the Service Center (an integration endpoint, LifeTime) are data, never followed.
  absolute(rows, page) {
    for (const row of rows) {
      const links = [];
      for (const a of row.links) {
        if (/^(?:javascript:|#)/.test(a.href)) continue;
        try { links.push({ ...a, href: this.http.url(a.href, page.url) }); } catch (error) { if (!(error instanceof ProtocolError)) throw error; }
      }
      row.links = links;
    }
    return rows;
  }

  async pages(page, limit = 100, redact = false, maxPages = 20) {
    if (!(limit >= 1 && limit <= 5000)) throw new ProtocolError('limit must be between 1 and 5000');
    if (!(maxPages >= 1 && maxPages <= 100)) throw new ProtocolError('maxPages must be between 1 and 100');
    const rows = []; const seen = new Set();
    for (let n = 0; n < maxPages; n++) {
      if (!content(page).all('th').length && !EMPTY.test(content(page).text)) throw new ProtocolError('Unrecognized listing schema; refusing to report an empty result');
      const batch = tables(page, redact);
      const marker = fingerprint(batch);
      if (seen.has(marker)) throw new ProtocolError('Service Center pagination did not advance');
      seen.add(marker);
      rows.push(...this.absolute(batch, page));
      const next = nextLink(page);
      if (rows.length >= limit || next === null)
        return { rows: rows.slice(0, limit), truncated: rows.length > limit || next !== null, source: page.url, observedAt: utc() };
      try { page = await this.nextPage(page, next); }
      catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        return { rows, truncated: true, source: page.url, paginationUnsupported: true, paginationError: error.message.slice(0, 500), observedAt: utc() };
      }
    }
    return { rows: rows.slice(0, limit), truncated: true, pageLimit: maxPages, observedAt: utc() };
  }

  async modules(limit = 100) { return this.pages(await this.get('eSpaces_List.aspx'), limit); }

  async modulePage(moduleId) {
    if (!/^[1-9][0-9]*$/.test(String(moduleId))) throw new ProtocolError('module-id must be the numeric ID from the live module listing');
    return this.get(`eSpace_Edit.aspx?EspaceId=${moduleId}`);
  }

  // [page, panel] of a module tab: the inline div[data-tab] panel of the modern page, or (on older pages) the page its
  // tab link leads to, with panel null.
  async resourcePage(moduleId, resource) {
    if (!Object.hasOwn(TABS, resource)) throw new ProtocolError('Unknown module resource');
    const [tab, names] = TABS[resource];
    const page = await this.modulePage(moduleId);
    const panel = tabPanel(page, tab);
    if (panel) return [page, panel];
    const links = content(page).all('a').filter(a => names.includes(fold(a.text)));
    if (links.length !== 1) throw new ProtocolError("Could not identify the module's " + resource + ' tab');
    return [await this.follow(page, links[0]), null];
  }

  async resourceListing(moduleId, resource, limit = 1000) {
    const [page, panel] = await this.resourcePage(moduleId, resource);
    const redact = resource === 'site-properties';
    if (!panel) return this.pages(page, limit, redact);
    if (!panel.all('th').length && !EMPTY.test(panel.text)) throw new LayoutError(page.url, 'Module page', `the ${TABS[resource][0]} panel has no listing`);
    const rows = this.absolute(tables(page, redact, panel), page);
    return { rows: rows.slice(0, limit), truncated: rows.length > limit, source: page.url, tab: TABS[resource][0], observedAt: utc() };
  }

  resources(moduleId, resource, limit = 100) { return this.resourceListing(moduleId, resource, limit); }

  async detail(moduleId, resource, name) {
    const listing = await this.resourceListing(moduleId, resource);
    const matches = listing.rows.flatMap(r => r.links).filter(a => a.name === name);
    // Same name across tenants or pages must never silently choose the first.
    if (matches.length !== 1 || listing.truncated) throw new ProtocolError('Target must have one exact name in a complete module listing');
    const page = await this.get(matches[0].href);
    const title = heading(page);
    if (title && !fold(title).includes(fold(name))) throw new LayoutError(page.url, `The ${resource} detail page`, `its heading does not name ${name}`);
    return page;
  }

  logFilters(kind, page, filters, stackContains = null) {
    const click = button(page, ['Filter', 'Search']);
    const form = click.ancestor('form');
    const updates = {};
    if (stackContains !== null && stackContains !== undefined) {
      if (kind !== 'error' || Object.hasOwn(filters, 'message')) throw new ProtocolError('stackContains searches error-log stack traces and replaces the message filter');
      filters = { ...filters, message: stackContains };
    }
    const found = entries(formLabels(page, form));
    for (let [key, value] of Object.entries(filters)) {
      if (!Object.hasOwn(LOG_FILTERS, key)) throw new ProtocolError('Unknown log filter: ' + key);
      const [names, suffixes] = LOG_FILTERS[key];
      const matches = found.filter(({ name, label }) => names.includes(label) || suffixes.some(s => name.endsWith(s))).map(e => e.n);
      if (matches.length !== 1) throw new ProtocolError('This log page does not expose an unambiguous ' + key + ' filter');
      const n = matches[0];
      if (n.tag === 'select') {
        const options = n.all('option').filter(o => o.text === value || o.attr('value') === value);
        if (options.length !== 1) throw new ProtocolError('Log filter does not identify one option: ' + key);
        value = optionValue(options[0]);
      }
      updates[n.attr('name')] = value;
    }
    if (stackContains !== null && stackContains !== undefined) {
      // The page's own "search in stack trace" option widens the message filter to the stack.
      const box = one(controls(form).filter(n => typeOf(n) === 'checkbox' && /SearchStackTrace|StackTrace/i.test(n.attr('name'))), 'stack-trace search option');
      updates[box.attr('name')] = controlValue(box);
    }
    return [click, updates];
  }

  logSchema(kind, page) {
    // General and timer logs are ASSUMED pages: only the listing they are modeled on is read.
    if (!Object.hasOwn(ASSUMED_LOGS, kind)) return;
    const headers = content(page).all('table').flatMap(t => t.all('th').map(c => fold(c.text)));
    const missing = ASSUMED_LOGS[kind].filter(c => !headers.some(h => h.includes(c)));
    if (missing.length) throw new LayoutError(page.url, `The ${kind} log page`, 'no listing with the columns ' + missing.join(', '));
  }

  async logs(kind = 'error', limit = 100, filters = null, { stackContains = null, exportAll = false, maxPages = 20 } = {}) {
    if (!Object.hasOwn(LOG_PAGES, kind)) throw new ProtocolError('Unknown log kind');
    if (exportAll && !EXPORTABLE.includes(kind)) throw new ProtocolError('Service Center exports error and integration logs only');
    const original = await this.get(LOG_PAGES[kind]);
    let page = original;
    this.logSchema(kind, page);
    filters = filters ?? {};
    let updates = {};
    const hasStack = stackContains !== null && stackContains !== undefined;
    if (Object.keys(filters).length || hasStack) {
      const find = () => this.logFilters(kind, page, filters, stackContains);
      let click;
      [click, updates] = Object.hasOwn(ASSUMED_LOGS, kind) ? await assumed(page, `The ${kind} log page`, find) : find();
      // The Integration log's Filter is an OsAjax submit: its reply refreshes the state and the list only.
      page = await this.click(page, click, updates);
    }
    const result = exportAll ? await this.exportLogs(kind, original, page, updates, limit) : await this.pages(page, limit, false, maxPages);
    return Object.assign(result, { kind, filters, timezone: 'Service Center display timezone', ...(hasStack ? { stackContains } : {}) });
  }

  async exportLogs(kind, original, page, updates, limit) {
    if (this.exports === null) throw new ProtocolError('Exports need a local export folder');
    let body;
    try { body = await this.http.export(page, button(page, ['Export to excel'])); }
    catch (error) {
      if (!(error instanceof ProtocolError) || page === original) throw error;
      // An AJAX Filter answers with a fragment that carries only the refreshed form state: export from the original
      // form with that state, never reading a missing Export control as zero rows.
      const state = Object.fromEntries(page.doc.all('input').filter(n => STATE.test(n.attr('name', '') ?? '')).map(n => [n.attr('name'), controlValue(n)]));
      if (!Object.keys(state).length) throw new ProtocolError('The filtered page has neither the Export control nor refreshed form state');
      body = await this.http.export(original, button(original, ['Export to excel']), { ...updates, ...state });
    }
    const rows = xlsxRows(body);
    const header = rows[0] ?? [];
    const records = rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h || `column${i + 1}`, h.toUpperCase() === 'INSTANT' ? excelTime(r[i] ?? '') : (r[i] ?? '')])));
    const saved = this.save(`${kind}-log`, 'xlsx', body);
    return { export: saved, columns: header, rowCount: records.length, rows: records.slice(0, limit), truncated: records.length > limit, observedAt: utc() };
  }

  save(stem, extension, body) {
    fs.mkdirSync(this.exports, { recursive: true });
    const file = path.resolve(this.exports, `${stem}-${stamp()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}.${extension}`);
    fs.writeFileSync(file, body, { flag: 'wx' });
    return { file, size: body.length, sha256: sha256(body) };
  }

  async errorDetail(errorId) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(errorId)) throw new ProtocolError('Invalid error ID');
    const page = await this.get('Show_Error.aspx?Error_Id=' + errorId);
    // Visible diagnostics of the page content, never the sidebar, cookies, hidden form state, input values or scripts.
    let root = content(page);
    if (root === page.doc.root) root = page.doc.first('main') ?? page.doc.first('body') ?? page.doc.root;
    else if (!root.all('pre').length && !fold(heading(page)).includes('error')) throw new LayoutError(page.url, 'The error detail page', 'no stack block and no error heading');
    const text = splitlines(root.readable).filter(line => strip(line)).map(rstrip).join('\n');
    return { errorId, detail: text.slice(0, 64000), truncated: text.length > 64000, source: page.url, observedAt: utc() };
  }

  async trace(requestKey, limit = 100) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) throw new ProtocolError('Invalid request/correlation key');
    // Correlate only exact occurrences; this is log correlation, not a distributed tracing service.
    const logs = await this.logs('error', limit, { message: requestKey });
    return { requestKey, kind: 'log-correlation', logs };
  }

  // A live capture of one page for calibrating the parsers: GET only; names, never field values, come back, and the
  // content's markup (input values emptied, scripts dropped) is kept locally with its sha256.
  async pageLayout(pagePath) {
    if (!PAGE_PATH.test(pagePath ?? '')) throw new ProtocolError('path is a Service Center page under /ServiceCenter/, e.g. eSpace_Timer_Edit.aspx?EspaceKey=<key>&Cyclic_Job_Key=<key>');
    if (this.exports === null) throw new ProtocolError('Captures need a local export folder');
    const page = await this.get(pagePath);
    const root = content(page);
    const base = pagePath.split('?')[0]; const dot = base.lastIndexOf('.');
    const stem = 'page-' + (dot >= 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60);
    const saved = this.save(stem, 'html', Buffer.from(skeleton(root), 'utf8'));
    return { path: pagePath, source: page.url, scope: root !== page.doc.root ? 'sc-content-main' : 'document', ...describe(page, root), capture: saved,
      observedAt: utc(), note: 'Names and captions only; the saved markup has no input values. Hand it over to calibrate the parser.' };
  }

  // ---- site properties and timers
  valueField(action, page, form = null) {
    const forms = form ? [form] : page.doc.all('form');
    const candidates = forms.flatMap(f => controls(f)).filter(n => (['value', 'valor'].includes(fold(strip(page.doc.label(n), ': ')))
      || /(?:Input_?Value|PropertyValue|SiteProperty_Value)$/i.test(n.attr('name'))) && !['hidden', 'submit', 'button'].includes(typeOf(n)));
    if (candidates.length !== 1) throw new ProtocolError('Could not identify one site-property value field');
    return candidates[0];
  }

  scheduleControls(page, form) {
    const found = entries(formLabels(page, form));
    return Object.fromEntries(Object.entries(SCHEDULE).map(([key, [names, suffix]]) =>
      [key, one(found.filter(({ name, label }) => name.endsWith(suffix) || names.includes(label)).map(e => e.n), `timer schedule ${key} control`)]));
  }

  // One timer as its page shows it (C40): the label/value rows and the actions the page offers, read by labels and
  // captions only. The live 11.42 page names its controls generically (wtButton4) and has no schedule editor SSAM can
  // identify; both are a known layout here, never LAYOUT_UNKNOWN.
  async timer(moduleId, name) {
    const page = await this.detail(moduleId, 'timers', name);
    const form = page.doc.first('form');
    const actions = [...new Set(content(page).all('input', 'button').filter(n => ['submit', 'button'].includes(typeOf(n, n.tag === 'button' ? 'submit' : ''))
      && !n.has('disabled')).map(n => strip(caption(n))).filter(Boolean))];
    return { moduleId: String(moduleId), name, ...timerFields(page), actions,
      scheduleEditor: form && scheduleEditor(page, form) ? 'identified' : 'not-on-page', source: page.url, observedAt: utc() };
  }

  // The requested schedule by control (recurrence by its option text), checked against the page's controls.
  scheduleRequest(controlsByKey, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || !Object.keys(value).every(k => Object.hasOwn(SCHEDULE, k)))
      throw new ProtocolError('timer-schedule takes recurrence, at, every and/or timeout');
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
      const node = controlsByKey[key]; const text = strip(String(raw));
      if (node.tag === 'select') result[key] = one(node.all('option').filter(o => fold(o.text) === fold(text) || o.attr('value') === text), `${key} option ${repr(text)}`).text;
      else if (/^[0-9A-Za-z :.,-]{0,40}$/.test(text)) result[key] = text;
      else throw new ProtocolError(`Schedule ${key} must be short plain text (as Service Center shows it)`);
    }
    return result;
  }

  // One named site property. The value stays redacted unless the user asked for it (reveal); a masked (password)
  // property is never revealed.
  async propertyValue(moduleId, name, reveal = false) {
    const page = await this.detail(moduleId, 'site-properties', name);
    const field = await assumed(page, 'The site property page', () => this.valueField('property-set', page));
    const secret = typeOf(field) === 'password';
    const result = { moduleId: String(moduleId), name, valueType: field.attr('type', field.tag), secret, value: '<redacted>', revealed: false, source: page.url, observedAt: utc() };
    if (reveal && !secret) Object.assign(result, { value: observedValue(field), revealed: true });
    return result;
  }

  async verify(receipt, journal, value = null) {
    const identity = receipt.identity;
    if (identity.host !== this.vault.host) throw new ProtocolError('Receipt belongs to another host');
    const action = identity.action;
    let confirmed;
    if (Object.hasOwn(WEB_WRITES, action)) confirmed = await this.observe(action, identity, receipt.plan ?? null);
    else if (action === 'timer-run') return this.resolveTimerRun(receipt, journal);
    else if (action === 'timer-schedule') {
      const requested = receipt.plan?.schedule;
      if (!requested || !Object.keys(requested).length) throw new ProtocolError('This receipt keeps no requested schedule to compare');
      const [, , , schedule] = await this.prepare(action, identity.moduleId, identity.name);
      confirmed = Object.entries(requested).every(([k, v]) => fold(shown(schedule[k])) === fold(v));
    } else if (action === 'property-set') {
      if (value === null || value === undefined) throw new ProtocolError('Verification requires the expected value (--value-file); a vault value is never read back');
      const [, , , field] = await this.prepare(action, identity.moduleId, identity.name);
      confirmed = typeOf(field) !== 'password' && observedValue(field) === expectedValue(field, value);
    } else {
      const fresh = await this.detail(identity.moduleId, 'timers', identity.name);
      const expected = ACTIONS[action === 'timer-activate' ? 'timer-deactivate' : 'timer-activate'];
      try { button(fresh, expected); confirmed = true; } catch (error) { if (!(error instanceof ProtocolError)) throw error; confirmed = false; }
    }
    if (confirmed) journal.reconcile(receipt);
    return { ...receipt, observedDesiredState: confirmed, replayed: false };
  }

  // verify of a Run Now (P6, friction c8b1090d): the receipt of a timer-run used to stay uncertain forever, even after the
  // timer was deleted, and its lock refused every later Run Now of that timer. Reads only, then resolves when the reading
  // proves the outcome: the timer absent from the module's complete timer listing -> obsolete; its Last Run changed from
  // the one the plan saw before the send -> confirmed; long after the attempt (TIMER_RUN_GRACE_MS) Last Run unchanged (or
  // still "never" for an older receipt without it) and the timer not running -> not-executed. Anything else stays
  // uncertain with what was seen and when to look again; the user may still discard it.
  async resolveTimerRun(receipt, journal, now = Date.now()) {
    const { moduleId, name } = receipt.identity;
    const out = extra => ({ ...receipt, ...extra, replayed: false });
    if (!UNSURE.includes(receipt.state)) return out({ verification: `This receipt is ${receipt.state}; nothing to resolve` });
    const listing = await this.resourceListing(moduleId, 'timers');
    const names = listing.rows.flatMap(r => r.links).map(a => a.name);
    const count = names.filter(n => n === name).length;
    if (count === 0 && !listing.truncated) {
      const resolved = journal.resolve(receipt, 'obsolete', `the timer ${name} is not in the complete timer listing of module ${moduleId} (deleted or renamed): this Run Now has nothing left to run`,
        { observed: { timers: names.length, source: listing.source ?? null } });
      return out({ ...resolved, observedDesiredState: false });
    }
    if (count !== 1) return out({ verification: `The timer listing of module ${moduleId} is ${listing.truncated ? 'truncated' : 'ambiguous'} for ${name}; nothing was resolved` });
    const fields = timerFields(await this.detail(moduleId, 'timers', name));
    const observed = { lastRun: fields.lastRun ?? null, status: fields.status ?? null, nextRun: fields.nextRun ?? null };
    const before = Object.hasOwn(receipt.plan ?? {}, 'lastRunBefore') ? receipt.plan.lastRunBefore : undefined;
    const lastRun = strip(observed.lastRun ?? '');
    const age = now - Date.parse(receipt.createdAt);
    const running = /\b(?:running|executing|in progress)\b/i.test(observed.status ?? '');
    if (before !== undefined && lastRun && !NEVER.test(lastRun) && fold(lastRun) !== fold(strip(before ?? ''))) {
      const resolved = journal.resolve(receipt, 'confirmed', `Last Run of ${name} moved from ${repr(before ?? 'never')} to ${repr(lastRun)} after the attempt`, { observed });
      return out({ ...resolved, observed, observedDesiredState: true });
    }
    const unchanged = before !== undefined ? fold(lastRun) === fold(strip(before ?? '')) : NEVER.test(lastRun);
    if (unchanged && !running && age >= TIMER_RUN_GRACE_MS) {
      const resolved = journal.resolve(receipt, 'not-executed', `${Math.round(age / 60000)} min after the attempt Last Run of ${name} is still ${repr(lastRun || 'never')}`
        + `${before !== undefined ? ' as before the send' : ''} and the timer is not running: the Run Now did not run; one new Run Now may be sent`, { observed });
      return out({ ...resolved, observed, observedDesiredState: false });
    }
    const recheckAt = new Date(Date.parse(receipt.createdAt) + TIMER_RUN_GRACE_MS).toISOString();
    return out({ observed, observedDesiredState: null, recheckAfter: unchanged && !running ? recheckAt : null,
      verification: unchanged && !running ? `Last Run unchanged so far; the scheduler may still pick it up: verify again after ${recheckAt}`
        : running ? 'The timer is running now: verify again when it finishes'
          : 'Last Run is a date and this older receipt kept no Last Run from before the send, so the reading cannot tell whether this Run Now caused it; '
            + 'the user may discard the receipt (action discard, words naming the timer)' });
  }

  // [plan, page, control, target]: the target is the value field (property-set), the schedule controls
  // (timer-schedule) or null. Timer and site property pages are ASSUMED: a missing control is an unknown layout.
  // requested (timer-schedule): the schedule asked, for the module route of a page without the schedule editor.
  async prepare(action, moduleId, name, requested = null) {
    if (!Object.hasOwn(ACTIONS, action)) throw new ProtocolError('Unknown Service Center write operation');
    const resource = action === 'property-set' ? 'site-properties' : 'timers';
    const page = await this.detail(moduleId, resource, name);
    const what = action === 'property-set' ? 'The site property page' : 'The timer page';
    // The live timer page has no schedule editor SSAM can write through: the schedule goes through the module (the
    // timer's Schedule property), refused here before anything is reserved or sent, with that exact change (C40).
    const pageForm = page.doc.first('form');
    if (action === 'timer-schedule' && (!pageForm || !scheduleEditor(page, pageForm))) throw scheduleInModule(page, name, requested);
    const click = await assumed(page, what, () => button(page, ACTIONS[action]));
    const form = click.ancestor('form');
    const plan = { host: this.vault.host, action, moduleId: String(moduleId), name, target: page.url, control: click.attr('name', null), execute: false };
    // Run Now: the Last Run seen before the send, the reference a later verify compares with (P6).
    if (action === 'timer-run') { const fields = timerFields(page); plan.lastRunBefore = fields.lastRun ?? null; plan.statusBefore = fields.status ?? null; }
    let target = null;
    if (action === 'property-set') {
      target = await assumed(page, what, () => this.valueField(action, page, form));
      Object.assign(plan, { value: '<redacted>', valueType: target.attr('type', target.tag), secret: typeOf(target) === 'password' });
    } else if (action === 'timer-schedule') {
      target = await assumed(page, what, () => this.scheduleControls(page, form));
      plan.currentSchedule = Object.fromEntries(Object.entries(target).map(([k, n]) => [k, shown(n)]));
    }
    return [plan, page, click, target];
  }

  // A secret field takes its value only from the vault (secretRefs); a vault value fits a text or password field.
  propertySource(field, value, secret) {
    const kind = lower(field.attr('type', field.tag));
    if (secret !== null && secret !== undefined) {
      if (!['password', 'text'].includes(kind) && field.tag !== 'textarea') throw new ProtocolError('A vault value fits a text or password site property only');
      if (!new RegExp(`^SSAM/O11/${escapeRegExp(this.vault.host)}/SiteProperty/[A-Za-z0-9_.-]{1,100}$`).test(secret))
        throw new ProtocolError('--value-vault must be SSAM/O11/<this host>/SiteProperty/<name>');
    } else if (value !== null && value !== undefined && kind === 'password') {
      throw new ProtocolError('This site property is secret (masked field): its value comes only from --value-vault '
        + 'SSAM/O11/<host>/SiteProperty/<name>, filled inside the Studio, never through this tool');
    }
  }

  secretRefusal() {
    if (this.http.source === 'studio-web')
      return new BridgeError('STUDIO_BRIDGE_OUTDATED', 'The loaded bridge does not fill secret fields from the vault (sc_web:secretRefs); '
        + 'nothing was reserved or sent. Reconnect a new bridge version.', { continuation: connectStudio('reconnect after the Studio loads a bridge with sc_web:secretRefs') });
    return new BridgeError('STUDIO_REQUIRED', "A secret value (database login, secret site property) goes only through the "
      + "connected Studio's web window, which reads it from the vault inside the Studio; this path never holds it. Open and "
      + 'connect the Studio (ssam_connect lane o11), or set it in Service Center yourself.', { continuation: connectStudio('secret values travel only through the connected Studio') });
  }

  // value: the new non-secret value (property-set) or the schedule {recurrence, at, every, timeout} (timer-schedule).
  // secret: the SiteProperty vault target of a secret value, filled inside the Studio.
  async mutate(action, moduleId, name, { value = null, secret = null, execute = false, words: userWords = null, operationId = null, journal = null } = {}) {
    const identity = { host: this.vault.host, action, moduleId: String(moduleId), name };
    if (execute) {
      if (!userWords || !strip(userWords) || !operationId || !journal) throw new ProtocolError("Execution requires the user's words, operation-id and a durable journal");
      const existing = journal.lookup(operationId, identity);
      if (existing) return { ...existing, replayed: false, existingReceipt: true };
    }
    const [plan, page, click, target] = await this.prepare(action, moduleId, name, action === 'timer-schedule' ? value : null);
    if (action === 'timer-schedule' && value !== null && value !== undefined) plan.schedule = this.scheduleRequest(target, value);
    if (action === 'property-set') {
      this.propertySource(target, value, secret);
      if (secret !== null && secret !== undefined) Object.assign(plan, { valueSource: 'vault', valueTarget: secret, secretRefsSupported: await this.http.secretsSupported() });
    }
    if (!execute) return plan;
    const updates = {}; let secrets = null;
    if (action === 'property-set') {
      if (secret !== null && secret !== undefined) {
        if (!await this.http.secretsSupported()) throw this.secretRefusal();
        secrets = { [target.attr('name')]: { target: secret, field: 'password' } };
      } else if (value === null || value === undefined) throw new ProtocolError('property-set requires its value');
      else {
        if (target.tag === 'select' && !target.all('option').map(optionValue).includes(value)) throw new ProtocolError("Value is not one of the field's accepted options");
        value = expectedValue(target, value);
        if (typeOf(target) === 'radio') throw new ProtocolError('Radio-group property protocol variant unsupported');
        updates[target.attr('name')] = typeOf(target) === 'checkbox' ? (value === 'true' ? target.attr('value', 'on') : null) : value;
      }
    } else if (action === 'timer-schedule') {
      if (!plan.schedule || !Object.keys(plan.schedule).length) throw new ProtocolError('timer-schedule requires the new schedule');
      for (const [key, text] of Object.entries(plan.schedule)) {
        const node = target[key];
        updates[node.attr('name')] = node.tag === 'select' ? one(node.all('option').filter(o => o.text === text), `${key} option`).attr('value', text) : text;
      }
    }
    return journal.reserve(operationId, identity, userWords, plan, null, async receipt => {
      let tracker = {};
      // Plans carry no secret; the receipt keeps the one it executed so a later verify knows what to expect.
      receipt.plan = plan;
      try {
        // The durable 'sending' receipt exists BEFORE the request. Any interruption stays uncertain.
        let response;
        await this.http.authorizing(receipt.operationId, receipt.authorization.wordsSha256, async t => {
          tracker = t;
          response = checked(secrets ? await this.http.submit(page, click, updates, secrets) : await this.http.submit(page, click, updates));
        });
        if (action === 'property-set') {
          const [, , , fresh] = await this.prepare(action, moduleId, name);
          if (secrets || typeOf(fresh) === 'password') {
            // A vault value is never known here, so it is never compared.
            receipt.state = acknowledged(response, 'saved|updated|applied|changed') ? 'accepted' : 'accepted-unverified';
            receipt.valueVerified = false;
          } else receipt.state = observedValue(fresh) !== value ? 'accepted-unverified' : 'confirmed';
        } else if (action === 'timer-schedule') {
          const [, , , schedule] = await this.prepare(action, moduleId, name);
          const now = Object.fromEntries(Object.keys(plan.schedule).map(k => [k, shown(schedule[k])]));
          receipt.observedSchedule = now;
          receipt.state = Object.entries(plan.schedule).every(([k, v]) => fold(now[k]) === fold(v)) ? 'confirmed' : 'accepted-unverified';
        } else if (action === 'timer-activate' || action === 'timer-deactivate') {
          const fresh = await this.detail(moduleId, 'timers', name);
          button(fresh, ACTIONS[action === 'timer-activate' ? 'timer-deactivate' : 'timer-activate']);
          receipt.state = 'confirmed';
        } else {
          // HTTP 200 alone is not a scheduling receipt.
          receipt.state = acknowledged(response, 'timer|schedul|queued|execut') ? 'accepted' : 'accepted-unverified';
          receipt.executionCompleted = false;
        }
        receipt.ok = ['accepted', 'confirmed'].includes(receipt.state);
      } catch (error) {
        if (error instanceof BridgeError) Object.assign(receipt, bridgeFailure(error, tracker, identity));
        // A local refusal before the POST went out (the form could not be posted as planned): nothing was sent, the
        // target stays free and the receipt says why. 2026-10-08 12:36:15 (c8b1090d): uncertain in 4 ms, no cause kept.
        else if (tracker.sent === false && tracker.attempted !== true)
          Object.assign(receipt, { state: 'refused', ok: false, code: 'NOT_SENT', error: 'Nothing was sent: ' + localReason(error) });
        else Object.assign(receipt, { state: 'uncertain', ok: false, cause: localReason(error),
          error: 'Response or readback was not confirmed; verify reads the live state before any new operation' });
      } finally { for (const k of Object.keys(updates)) delete updates[k]; }
      receipt.updatedAt = utc();
      return receipt;
    });
  }

  // ---- BPT (Monitoring > Processes)
  async bptProcesses(module = null, process = null, limit = 100, maxPages = 20) {
    let page = await this.get('Process_Monitoring.aspx?Index=0');
    if (module !== null || process !== null) {
      const click = button(page, ['Filter', 'Search']);
      const fields = entries(formLabels(page, click.ancestor('form'))); const updates = {};
      if (module !== null) {
        const select = one(fields.filter(({ name, label, n }) => n.tag === 'select' && (/Espace_Selector/i.test(name) || ['module', 'espace'].includes(label))).map(e => e.n), 'module filter');
        updates[select.attr('name')] = one(select.all('option').filter(o => o.text === module).map(optionValue), 'module option');
      }
      if (process !== null) {
        const box = one(fields.filter(({ name, label, n }) => n.tag === 'input' && (['process', 'process name'].includes(label) || /Process/i.test(name))).map(e => e.n), 'process filter');
        updates[box.attr('name')] = process;
      }
      page = await this.click(page, click, updates);
    }
    const result = await this.pages(page, limit, false, maxPages);
    for (const row of result.rows) for (const link of row.links) {
      const query = parseQs(urlsplit(link.href).query);
      if (link.href.includes('Process_Details.aspx')) Object.assign(row, { processKey: query.ProcessKey?.[0] ?? '', moduleKey: query.ModuleKey?.[0] ?? '' });
    }
    return { ...result, filters: { module, process } };
  }

  async bptProcess(processKey, moduleKey, limit = 100, maxPages = 20) {
    for (const value of [processKey, moduleKey]) if (!/^[A-Za-z0-9*_-]{1,100}$/.test(value ?? '')) throw new ProtocolError('processKey and moduleKey come from bpt-processes');
    const page = await this.get(`Process_Details.aspx?ProcessKey=${quote(processKey)}&ModuleKey=${quote(moduleKey)}&Index=0`);
    return { processKey, moduleKey, summary: summary(page), instances: await this.pages(page, limit, false, maxPages) };
  }

  async bptInstance(processId) {
    if (!/^[1-9][0-9]*$/.test(String(processId))) throw new ProtocolError('processId must be the numeric instance ID');
    const page = await this.get(`Process_Instance_Detail.aspx?ProcessId=${processId}`);
    const activities = tables(page).flatMap(r => r.links.slice(0, 1).filter(l => l.href.includes('Process_Activity_Detail.aspx'))
      .map(l => ({ ...r, activityId: parseQs(urlsplit(l.href).query).ActivityId?.[0] ?? '' })));
    return { processId: String(processId), title: heading(page), summary: summary(page), activities, source: page.url, observedAt: utc() };
  }

  async bptActivity(activityId) {
    if (!/^[1-9][0-9]*$/.test(String(activityId))) throw new ProtocolError('activityId must be the numeric activity ID');
    const page = await this.get(`Process_Activity_Detail.aspx?ActivityId=${activityId}`);
    return { activityId: String(activityId), title: heading(page), summary: summary(page), source: page.url, observedAt: utc() };
  }

  // ---- integrations (module detail) and their logging level
  async integrations(moduleId) {
    let page = await this.modulePage(moduleId);
    const panel = tabPanel(page, TABS.integrations[0]);
    let found = this.integrationLinks(page, panel);
    if (!found.length && !panel) {
      const tabs = content(page).all('a').filter(a => fold(a.text) === 'integrations');
      if (tabs.length === 1) { page = await this.follow(page, tabs[0]); found = this.integrationLinks(page); }
    }
    return { moduleId: String(moduleId), integrations: found, source: page.url, observedAt: utc() };
  }

  integrationLinks(page, root = null) {
    const found = []; const seen = new Set();
    for (const a of (root ?? content(page)).all('a')) {
      const href = a.attr('href', '') ?? '';
      if (!a.text || inside(a, /RecentItems|sc-content-left/i)) continue;
      for (const [kind, pattern] of INTEGRATION_LINKS) {
        const match = pattern.exec(href);
        if (match && !seen.has(kind + '\n' + match[1])) {
          seen.add(kind + '\n' + match[1]);
          found.push({ kind, id: match[1], name: a.text, href: this.http.url(href, page.url) });
          break;
        }
      }
    }
    return found;
  }

  async integrationPage(moduleId, name, kind = null) {
    const matches = (await this.integrations(moduleId)).integrations.filter(i => i.name === name && (kind === null || kind === undefined || i.kind === kind));
    const target = one(matches, `integration named ${repr(name)} in module ${moduleId}`);
    const page = await this.get(target.href);
    const combo = one(entries(labels(page, content(page))).filter(({ name: n, label, n: c }) => c.tag === 'select'
      && (/HttpTracingCombo|Logging/i.test(n) || ['logging level', 'log level', 'logging'].includes(label))).map(e => e.n), 'logging-level selector');
    return [target, page, combo];
  }

  // ---- database connections (Administration)
  async dbConnections() {
    const listing = await this.pages(await this.get('DatabaseConnections_List.aspx'), 1000);
    const connections = [];
    for (const row of listing.rows) for (const link of row.links) {
      const match = /DBConnectionId=(\d+)/.exec(link.href);
      if (match) { connections.push({ id: match[1], name: link.name, href: link.href, fields: row.fields }); break; }
    }
    return { connections, truncated: listing.truncated, source: listing.source ?? null, observedAt: utc() };
  }

  async dbConnection(name) {
    const listing = await this.dbConnections();
    if (listing.truncated) throw new ProtocolError('Database connection listing is incomplete; refusing to resolve a target by name');
    return one(listing.connections.filter(c => c.name === name), `database connection named ${repr(name)}`);
  }

  async extensionId(name) {
    const listing = await this.pages(await this.get('Extensions_List.aspx'), 5000);
    const ids = listing.rows.flatMap(r => r.links).filter(l => l.name === name && /ExtensionId=(\d+)/.test(l.href)).map(l => /ExtensionId=(\d+)/.exec(l.href)[1]);
    if (listing.truncated) throw new ProtocolError('Extension listing is incomplete; refusing to resolve a target by name');
    return one([...new Set(ids)].sort(), `extension named ${repr(name)}`);
  }

  // ---- solutions (Factory; every solution page is ASSUMED)
  solutionsPage() { return this.get('Solutions_List.aspx'); }

  async solutions(limit = 1000) {
    const page = await this.solutionsPage();
    const listing = await assumed(page, 'The solutions list', () => this.pages(page, limit));
    const found = listing.rows.flatMap(r => r.links.slice(0, 1).filter(l => /SolutionId=(\d+)/.test(l.href))
      .map(l => ({ name: l.name, id: /SolutionId=(\d+)/.exec(l.href)[1], href: l.href, fields: r.fields })));
    if (listing.rows.length && !found.length) throw new LayoutError(page.url, 'The solutions list', 'its rows link no Solution_Edit.aspx?SolutionId= page');
    return { solutions: found, truncated: listing.truncated, source: listing.source ?? null, observedAt: utc() };
  }

  async solutionPage(name) {
    const listing = await this.solutions();
    if (listing.truncated) throw new ProtocolError('Solution listing is incomplete; refusing to resolve a target by name');
    return this.get(one(listing.solutions.filter(s => s.name === name), `solution named ${repr(name)}`).href);
  }

  async solutionDownload(name) {
    if (this.exports === null) throw new ProtocolError('Downloads need a local export folder');
    const page = await this.solutionPage(name);
    let click = null;
    try { click = button(page, ['Download']); } catch (error) { if (!(error instanceof ProtocolError)) throw error; }
    let body;
    if (click) body = await this.http.export(page, click, null, 'binary');
    else {
      const links = content(page).all('a').filter(a => fold(a.text) === 'download' && a.attr('href') && !/^(?:javascript:|#)/.test(a.attr('href')) && !postbackTarget(a));
      const link = await assumed(page, 'The solution page', () => one(links, 'solution Download control'));
      body = await this.http.download(this.http.url(link.attr('href'), page.url));
    }
    // The content type of the .osp answer is not trusted: only the package's ZIP signature is.
    if (!body.subarray(0, 2).equals(Buffer.from('PK'))) throw new ProtocolError('Solution download is not an OSP package');
    const stem = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
    return { solution: name, ...this.save(stem, 'osp', body), observedAt: utc() };
  }

  // Component names of a solution page's listing (its Name column).
  components(page) {
    return new Set(tables(page).map(r => r.fields.Name || r.fields.Component).filter(v => v !== null && v !== undefined && v !== ''));
  }

  // ---- generic page writes: prepare reads, send posts inside the reservation, observe re-reads
  async webWrite(action, args, { execute = false, words: userWords = null, operationId = null, journal = null, approve = null } = {}) {
    const identity = { host: this.vault.host, action, ...Object.fromEntries(WEB_WRITES[action].map(k => [k, pyStr(args[k])])) };
    const [prepare, send] = WEB_HANDLERS[action];
    const run = async (plan, state, receipt) => {
      // Plans carry no secret; the receipt keeps the one it executed so a later verify knows what to expect.
      receipt.plan = plan;
      const outcome = await send.call(this, plan, state);
      if (!Object.hasOwn(outcome, 'state')) outcome.state = await this.observe(action, identity, plan) ? 'confirmed' : 'accepted-unverified';
      return outcome;
    };
    const gate = async plan => {
      // Before the reservation: a write with a secret needs the Studio window that fills it from the vault.
      if (SECRET_WRITES.includes(action) && !await this.http.secretsSupported()) throw this.secretRefusal();
      if (approve) await approve(plan);
    };
    return runWrite(identity, () => prepare.call(this, args), run, { execute, words: userWords, operationId, journal,
      authorizing: (id, sha, fn) => this.http.authorizing(id, sha, fn), approve: gate });
  }

  async observe(action, identity, plan = null) {
    if (action === 'integration-log-level') {
      const [, , combo] = await this.integrationPage(identity.moduleId, identity.integration, plan?.kind ?? null);
      return plan !== null && fold(selectedText(combo)) === fold(plan.level);
    }
    if (action === 'solution-create') return (await this.solutions()).solutions.some(s => s.name === identity.solution);
    if (action === 'solution-add-component' || action === 'solution-remove-component') {
      const present = this.components(await this.solutionPage(identity.solution)).has(identity.component);
      return action === 'solution-add-component' ? present : !present;
    }
    if (action === 'db-connection-create') return (await this.dbConnections()).connections.some(c => c.name === identity.connection);
    if (action === 'db-connection-delete') return !(await this.dbConnections()).connections.some(c => c.name === identity.connection);
    if (action === 'db-connection-test') return false; // a test's outcome is its own reply; nothing to re-read
    if (action === 'extension-db-connection') {
      const page = await this.get(`Extension_Edit.aspx?ExtensionId=${await this.extensionRef(identity.extensionId)}`);
      const connection = (await this.dbConnection(identity.connection)).id;
      const combos = this.connectionCombos(page, connection);
      return combos.length > 0 && combos.every(c => controlValue(c) === connection);
    }
    throw new ProtocolError('Unknown page write');
  }

  // The solution page's Associate Component area: the autocomplete input, its hidden value/aux fields, the
  // include-references option and Associate (matrix P3, ASSUMED).
  async componentControls(a) {
    const page = await this.solutionPage(a.solution);
    const what = 'The solution page';
    const click = await assumed(page, what, () => button(page, ['Associate']));
    const form = click.ancestor('form');
    const found = {};
    for (const [key, suffix] of [['box', 'wtComponentInput'], ['value', 'wttxtAutoCompleteValue'], ['aux', 'wttxtAutoCompleteAux']])
      found[key] = await assumed(page, what, () => bySuffix(form, suffix, key));
    const refs = controls(form).filter(n => n.attr('name').endsWith('wtIncludeReferences'));
    return [page, click, found, refs.length === 1 ? refs[0] : null];
  }

  // The autocomplete's own lookup (OsAjax Notify, a read): 'label<TAB>key' lines for the typed name; exactly one label
  // must be the component (optionally followed by its kind).
  async componentLookup(page, box, value, component) {
    const name = value.attr('name');
    const widget = (name.includes('$') ? name.slice(0, name.lastIndexOf('$')) : name).replaceAll('$', '_');
    const [url, posted] = this.http.ajaxPost(page, box, { [box.attr('name')]: component }, 'Notify', '1024,768,,0,0,0,0,0,0,' + component + '%');
    const fields = posted.map(([k, v]) => [k, k === '__EVENTTARGET' ? widget : v]);
    const [, reply] = await this.http.reply(url + (url.includes('?') ? '&' : '?') + '_ts=0', fields);
    const inputId = box.attr('id') || box.attr('name').replaceAll('$', '_');
    const match = new RegExp('RichWidgets_Input_AutoComplete_setListFor' + escapeRegExp(inputId) + `['"]?\\]?\\s*\\(\\s*'((?:\\\\.|[^'\\\\])*)'`).exec(reply);
    if (!match) throw new LayoutError(page.url, 'The solution component lookup', 'its reply has no autocomplete list for the component input');
    const escapes = { t: '\t', n: '\n', r: '', "'": "'", '\\': '\\' };
    const lines = match[1].replace(/\\(.)/g, (m, c) => escapes[c] ?? c).split('\n');
    const pairs = lines.filter(line => line.includes('\t')).map(line => [line.slice(0, line.indexOf('\t')), line.slice(line.indexOf('\t') + 1)]);
    const [label, key] = one(pairs.filter(p => p[0] === component || p[0].startsWith(component + ' (')), `component named ${repr(component)} in the lookup`);
    return { label, key, state: ajaxState(reply) };
  }

  // The username and password fields of a database connection form (text before each generated name).
  async connectionForm(page, click, what) {
    const fields = entries(formLabels(page, click.ancestor('form')));
    const user = await assumed(page, what, () => one(fields.filter(({ label, n }) => ['username', 'user name', 'user', 'login'].includes(label) && typeOf(n, 'text') === 'text').map(e => e.name), 'username field'));
    const password = await assumed(page, what, () => one(fields.filter(({ n }) => typeOf(n) === 'password').map(e => e.name), 'password field'));
    return [fields, user, password];
  }

  loginRefs(plan, s) {
    return { [s.user]: { target: plan.loginTarget, field: 'username' }, [s.password]: { target: plan.loginTarget, field: 'password' } };
  }

  connectionCombos(page, connectionId) {
    return content(page).all('select').filter(s => /DBConnectionCombo/i.test(s.attr('name', '') ?? '') && s.all('option').map(optionValue).includes(connectionId));
  }

  // The numeric extension ID, given either that ID or the extension's exact name.
  async extensionRef(value) { return /^[1-9][0-9]*$/.test(String(value)) ? String(value) : this.extensionId(String(value)); }
}

const sendPostback = async function (plan, s) {
  if (s.control.tag === 'a') checked(await this.http.postback(s.page, s.control));
  else checked(await this.http.submit(s.page, s.control));
  return {};
};

// action -> [prepare(args), send(plan, state)], called with the Client as this.
const WEB_HANDLERS = {
  'solution-create': [async function (a) {
    if (!/^[A-Za-z0-9 _.-]{1,100}$/.test(a.solution)) throw new ProtocolError('Solution name must be plain text (letters, digits, space, _ . -)');
    if ((await this.solutions()).solutions.some(s => s.name === a.solution)) throw new ProtocolError('A solution with this name already exists');
    const listing = await this.solutionsPage();
    const link = await assumed(listing, 'The solutions list', () => one(content(listing).all('a').filter(l => ['new solution', 'create solution', 'new'].includes(fold(l.text))), 'New Solution link'));
    const page = await this.follow(listing, link);
    const what = 'The new solution form';
    const click = await assumed(page, what, () => button(page, ['Create', 'Save']));
    const fields = entries(formLabels(page, click.ancestor('form')));
    const name = await assumed(page, what, () => one(fields.filter(({ name: n, label, n: c }) => c.tag === 'input' && (/Solution_?Name$/.test(n) || ['name', 'solution name'].includes(label))).map(e => e.name), 'solution name field'));
    const plan = { host: this.vault.host, action: 'solution-create', solution: a.solution, target: page.url, execute: false };
    const updates = { [name]: a.solution };
    if (a.description !== null && a.description !== undefined) {
      updates[await assumed(page, what, () => one(fields.filter(({ name: n, label }) => label === 'description' || /Description$/.test(n)).map(e => e.name), 'solution description field'))] = a.description;
      plan.description = a.description;
    }
    return [plan, { page, click, updates }];
  }, async function (plan, s) { checked(await this.http.submit(s.page, s.click, s.updates)); return {}; }],

  'solution-add-component': [async function (a) {
    const [page, click, found, refs] = await this.componentControls(a);
    const present = this.components(page).has(a.component);
    if (a.includeReferences && !refs) throw new LayoutError(page.url, 'The solution page', 'it has no include-references option');
    const plan = { host: this.vault.host, action: 'solution-add-component', solution: a.solution, component: a.component,
      alreadyPresent: present, includeReferences: Boolean(a.includeReferences), target: page.url, execute: false };
    const state = { page, click, refs, ...found };
    if (!present) {
      const lookup = await this.componentLookup(page, found.box, found.value, a.component);
      Object.assign(plan, { componentLabel: lookup.label, componentKey: lookup.key });
      state.lookupState = lookup.state;
    }
    return [plan, state];
  }, async function (plan, s) {
    if (plan.alreadyPresent) return { state: 'confirmed', noChange: true };
    const updates = { [s.box.attr('name')]: plan.componentLabel, [s.value.attr('name')]: plan.componentKey, [s.aux.attr('name')]: 'isVisible' };
    if (plan.includeReferences) updates[s.refs.attr('name')] = controlValue(s.refs);
    if (s.lookupState) {
      // Associate goes with the state the lookup refreshed, as the page's form does after the autocomplete.
      updates[one(controls(s.click.ancestor('form')).map(n => n.attr('name')).filter(n => n.endsWith('__OSVSTATE')), 'form state field')] = s.lookupState;
    }
    checked(await this.http.submit(s.page, s.click, updates));
    return {};
  }],

  'solution-remove-component': [async function (a) {
    const page = await this.solutionPage(a.solution);
    const rows = content(page).all('table').flatMap(t => t.all('tr')).filter(r => r.children.some(c => c?.tag === 'td' && c.text === a.component));
    const row = one(rows, `component row ${repr(a.component)}`);
    const candidates = row.all('a', 'input').filter(n => ['remove', 'delete', 'disassociate'].includes(fold(strip(caption(n)))));
    const control = await assumed(page, 'The solution page', () => one(candidates, 'remove control in the component row'));
    if (control.tag === 'a' && !postbackTarget(control)) throw new ProtocolError('The remove control is not a recognized postback; no request sent');
    const plan = { host: this.vault.host, action: 'solution-remove-component', solution: a.solution, component: a.component,
      confirm: redactText(confirmText(control)).slice(0, 300), target: page.url, execute: false };
    return [plan, { page, control }];
  }, sendPostback],

  'db-connection-create': [async function (a) {
    const name = a.connection;
    const target = this.vault.secretTarget('DatabaseConnection', name);
    if ((await this.dbConnections()).connections.some(c => c.name === name)) throw new ProtocolError('A database connection with this name already exists');
    const page = await this.get('DatabaseConnection_Edit.aspx');
    const what = 'The new database connection form';
    const click = await assumed(page, what, () => button(page, ['Create', 'Save']));
    const [fields, user, password] = await this.connectionForm(page, click, what);
    const field = (label, test) => one(fields.filter(test).map(e => e.name), label);
    const nameField = field('connection name field', ({ name: n, label }) => /Connection_?Name/i.test(n) || ['name', 'connection name', 'logical name'].includes(label));
    const dbms = fields.filter(({ name: n, label, n: c }) => c.tag === 'select' && (/DBMS/i.test(n) || label === 'dbms')).map(e => e.n);
    const current = dbms.length ? selectedText(dbms[0]) : null;
    if (a.dbms && dbms.length && ![fold(current), fold(controlValue(dbms[0]))].includes(fold(a.dbms)))
      throw new ProtocolError(`Only the form's default DBMS (${current}) is supported; another DBMS needs a per-DBMS postback not implemented`);
    const parameters = { server: a.server ?? null, database: a.database ?? null, ...(a.parameters ?? {}) };
    const updates = { [nameField]: name };
    for (const [label, value] of Object.entries(parameters)) {
      if (value === null || value === undefined) continue;
      if (/pass|secret|token|key|user|login/i.test(label)) throw new ProtocolError('Secrets never travel as parameters; the login comes from ' + target);
      updates[field(`${repr(label)} field`, e => e.label === fold(label))] = value;
    }
    const plan = { host: this.vault.host, action: 'db-connection-create', connection: name, dbms: current,
      parameters: Object.fromEntries(Object.entries(parameters).filter(([, v]) => v !== null && v !== undefined)), loginTarget: target,
      loginStored: Boolean(await this.vault.present(target)), secretRefsSupported: await this.http.secretsSupported(),
      login: 'username and password from ' + target + ', filled inside the Studio (sc_web secretRefs)', target: page.url, execute: false };
    return [plan, { page, click, updates, user, password }];
  }, async function (plan, s) { checked(await this.http.submit(s.page, s.click, s.updates, this.loginRefs(plan, s))); return {}; }],

  'db-connection-test': [async function (a) {
    const connection = await this.dbConnection(a.connection);
    const target = this.vault.secretTarget('DatabaseConnection', a.connection);
    const page = await this.get(connection.href);
    const what = 'The database connection page';
    const click = await assumed(page, what, () => button(page, ['Test Connection', 'Test']));
    const [, user, password] = await this.connectionForm(page, click, what);
    const plan = { host: this.vault.host, action: 'db-connection-test', connection: a.connection, connectionId: connection.id,
      loginTarget: target, loginStored: Boolean(await this.vault.present(target)), secretRefsSupported: await this.http.secretsSupported(),
      target: page.url, execute: false };
    return [plan, { page, click, user, password }];
  }, async function (plan, s) {
    const response = await this.http.submit(s.page, s.click, null, this.loginRefs(plan, s));
    if (urlsplit(response.url).path.toLowerCase().endsWith('/login.aspx')) throw new ProtocolError('Service Center login required or session expired');
    const good = response.doc.all().filter(n => n.text && /Feedback_Message_Success/i.test(n.attr('class', '') ?? ''));
    const bad = errors(response);
    if (!good.length && !bad.length && !response.doc.all().some(n => n.text))
      // The bridge dropped the whole reply (htmlOmitted): it echoed the login in a form it cannot mask.
      return { state: 'accepted-unverified', testPassed: null, feedback: 'withheld by the Studio (the reply echoed the login); open the connection page to see the result' };
    if (!good.length && !bad.length) throw new LayoutError(response.url, 'The connection test reply', 'it shows no success or error feedback');
    // The test changes nothing; its reply is the result. The server's text can echo the login, so only the outcome
    // comes back.
    return { state: 'confirmed', testPassed: good.length > 0 && !bad.length, feedback: good.length && !bad.length ? 'success' : 'error (server text withheld: it can echo the login)' };
  }],

  'db-connection-delete': [async function (a) {
    const connection = await this.dbConnection(a.connection);
    const page = await this.get(connection.href);
    const control = one(content(page).all('a', 'input').filter(n => fold(strip(caption(n))) === 'delete' && (n.tag === 'input' || postbackTarget(n))), 'Delete control');
    // Extensions that use the connection must be named by the user's words too (matrix D4).
    const used = [...new Set(tables(page).map(r => r.fields.Extension).filter(Boolean))].sort();
    const plan = { host: this.vault.host, action: 'db-connection-delete', connection: a.connection, connectionId: connection.id, usedBy: used,
      namedTargets: [a.connection, ...used], confirm: redactText(confirmText(control)).slice(0, 300), target: page.url, destructive: true, execute: false };
    return [plan, { page, control }];
  }, sendPostback],

  'extension-db-connection': [async function (a) {
    const extensionId = await this.extensionRef(a.extensionId);
    const connection = await this.dbConnection(a.connection);
    const page = await this.get(`Extension_Edit.aspx?ExtensionId=${extensionId}`);
    const combos = this.connectionCombos(page, connection.id);
    if (!combos.length) throw new ProtocolError('No database-connection selector of this extension offers that connection');
    const pending = combos.filter(c => controlValue(c) !== connection.id);
    const plan = { host: this.vault.host, action: 'extension-db-connection', extensionId, connection: a.connection, connectionId: connection.id,
      selectors: combos.length, pending: pending.length, target: page.url, execute: false };
    return [plan, { url: page.url }];
  }, async function (plan, s) {
    // One OsAjax Change (a read that stages the value) -> Apply (the write) for one selector. The bridge accepts each
    // operationId once, so a second selector is a new call with its own operationId, after this one's re-read.
    const page = await this.get(s.url);
    const pending = this.connectionCombos(page, plan.connectionId).filter(c => controlValue(c) !== plan.connectionId);
    if (!pending.length) return { state: 'confirmed', noChange: true };
    const combo = pending[0];
    const name = combo.attr('name');
    const reply = await this.http.text(...this.http.ajaxPost(page, combo, { [name]: plan.connectionId }, 'Change'));
    const state = ajaxState(reply);
    if (!state) throw new LayoutError(page.url, "The extension's OsAjax 'Change' reply", 'it carries no refreshed form state');
    const osv = one(controls(combo.ancestor('form')).map(n => n.attr('name')).filter(n => n.endsWith('__OSVSTATE')), 'form state field');
    checked(await this.http.submit(page, button(page, ['Apply']), { [name]: plan.connectionId, [osv]: state }));
    const left = this.connectionCombos(await this.get(s.url), plan.connectionId).filter(c => controlValue(c) !== plan.connectionId);
    if (!left.length) return { state: 'confirmed' };
    if (left.length < pending.length) {
      // This Apply landed; the remaining selectors need their own operation (a new operationId each).
      return { state: 'accepted', remainingSelectors: left.length, continuation: continuation('o11_service_center_write',
        { action: 'extension-db-connection', host: plan.host, extensionId: plan.extensionId, connection: plan.connection, execute: true },
        'repeat with a new operationId (and the user words) for the next selector') };
    }
    return { state: 'accepted-unverified' };
  }],

  'integration-log-level': [async function (a) {
    const [target, page, combo] = await this.integrationPage(a.moduleId, a.integration, a.kind ?? null);
    const options = new Map(combo.all('option').map(o => [fold(o.text), optionValue(o)]));
    if (!options.has(fold(a.level))) throw new ProtocolError('Logging level unavailable; options: ' + combo.all('option').map(o => o.text).join(', '));
    const click = button(page, ['Apply', 'Save']);
    const plan = { host: this.vault.host, action: 'integration-log-level', moduleId: String(a.moduleId), integration: a.integration, kind: target.kind,
      integrationId: target.id, currentLevel: selectedText(combo), level: a.level, changed: fold(selectedText(combo)) !== fold(a.level), target: page.url, execute: false };
    return [plan, { page, click, combo: combo.attr('name'), value: options.get(fold(a.level)) }];
  }, async function (plan, s) {
    if (!plan.changed) return { state: 'confirmed', noChange: true };
    checked(await this.http.submit(s.page, s.click, { [s.combo]: s.value }));
    const [, , combo] = await this.integrationPage(plan.moduleId, plan.integration, plan.kind);
    const level = selectedText(combo);
    return { state: fold(level) === fold(plan.level) ? 'confirmed' : 'accepted-unverified', observedLevel: level };
  }],
};

// Refused only when the bridge turned down the write request itself and no earlier step of it went out; rejected when
// Service Center answered the write with a definite error; anything else stays uncertain.
export function bridgeFailure(error, tracker = {}, identity = null) {
  const own = error.extra.write === true && !error.extra.sent && !tracker?.sent;
  const refused = own && (NOT_SENT.has(error.code) || error.extra.executed === false);
  const rejected = error.extra.write === true && error.code === 'REMOTE_ERROR' && !error.extra.signInRequired;
  const state = refused ? 'refused' : rejected ? 'rejected' : 'uncertain';
  const failure = { state, ok: false, code: error.code,
    error: state !== 'uncertain' ? error.message : 'Sent but not confirmed (' + error.code + '); reconcile by a read, never repeat it' };
  if (error.code === 'SECRET_NOT_FOUND' && refused) {
    // The Studio found no vault entry (or not the part) a secretRefs entry named; nothing was sent. The next call with a
    // new operationId opens the private prompt for that entry when it is absent.
    Object.assign(failure, { target: error.extra.target ?? null, part: error.extra.part ?? null,
      continuation: continuation('o11_service_center_write', { ...(identity ? { action: identity.action, host: identity.host } : {}), execute: true },
        'the next call with a new operationId opens the private prompt for this vault entry when it is absent; repeat with a new operationId after it is stored') });
  }
  return failure;
}

// Prepare by default. Execute: the user's words, an operationId UUID, the durable reservation before anything is sent,
// and no replay: the same operationId returns its receipt; a failure after sending stays uncertain. approve(plan)
// checks the words against the resolved target before the reservation.
export async function runWrite(identity, prepare, send, { execute, words: userWords, operationId, journal, authorizing = null, lock = null, approve = null }) {
  if (execute) {
    if (!userWords || !strip(userWords) || !operationId || !journal) throw new ProtocolError("Execution requires the user's words, operation-id and a durable journal");
    const existing = journal.lookup(operationId, identity);
    if (existing) return { ...existing, replayed: false, existingReceipt: true };
  }
  const [plan, state] = await prepare();
  if (!execute) return plan;
  if (approve) await approve(plan);
  return journal.reserve(operationId, identity, userWords, plan, lock ? lock(plan) : null, async receipt => {
    let tracker = {};
    try {
      const body = async t => { tracker = t; Object.assign(receipt, await send(plan, state, receipt)); };
      if (authorizing) await authorizing(receipt.operationId, receipt.authorization.wordsSha256, body);
      else await body({});
      receipt.ok = ['accepted', 'confirmed'].includes(receipt.state);
    } catch (error) {
      if (error instanceof BridgeError) Object.assign(receipt, bridgeFailure(error, tracker, identity));
      else Object.assign(receipt, { state: 'uncertain', ok: false, error: 'Response or readback was not confirmed; inspect this receipt and live state before any new operation' });
    }
    receipt.updatedAt = utc();
    return receipt;
  });
}

// Exclusive durable operation IDs; a crash or lost response is never retried. The files are the Python adapter's
// (same folder, names, lock fingerprints and JSON fields), so its receipts keep answering.
export class Journal {
  constructor(root, legacy = null) { this.root = String(root); this.legacy = legacy ? String(legacy) : null; }

  path(operationId) {
    const canonical = canonicalUuid(operationId);
    if (!canonical) throw new ProtocolError('operation-id must be a UUID');
    return path.join(this.root, canonical + '.json');
  }

  lookup(operationId, identity = null) {
    let file = this.path(operationId);
    // Receipts written before the journal moved out of %LOCALAPPDATA% still answer for their IDs.
    if (!fs.existsSync(file) && this.legacy && fs.existsSync(path.join(this.legacy, path.basename(file)))) file = path.join(this.legacy, path.basename(file));
    if (!fs.existsSync(file)) return null;
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (identity && !same(result.identity, identity)) throw new ProtocolError('operation-id already belongs to a different target or operation');
    if (result.state === 'sending') Object.assign(result, { state: 'uncertain', ok: false });
    return result;
  }

  lockFile(target) { return path.join(this.root, fingerprint(target) + '.lock'); }
  static targetOf(identity) { return Object.fromEntries(Object.entries(identity).filter(([k]) => k !== 'action')); }
  // The operationId that holds a target lock, or null when the target is free.
  holder(lockTarget) {
    try { return fs.readFileSync(this.lockFile(lockTarget), 'utf8').trim() || null; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  // The state as written (lookup reads 'sending' as uncertain: a sender may still be active).
  rawState(operationId) {
    const file = this.path(operationId);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).state ?? null : null;
  }

  static writeDurable(file, text, flag) {
    const fd = fs.openSync(file, flag);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  // A receipt without a target lock (the parent of a delete: each child locks its own target), created exclusively.
  create(operationId, identity, userWords, plan) {
    fs.mkdirSync(this.root, { recursive: true });
    const file = this.path(operationId);
    const receipt = { schema: 'ssam-service-center/1', operationId: canonicalUuid(operationId), identity,
      authorization: { wordsSha256: sha256(Buffer.from(userWords, 'utf8')), planSha256: fingerprint(plan) },
      state: 'sending', ok: false, createdAt: utc(), receipt: path.resolve(file), plan };
    Journal.writeDurable(file, JSON.stringify(receipt, null, 2), 'wx');
    return receipt;
  }
  rewrite(receipt) {
    const file = this.path(receipt.operationId);
    const temporary = file.replace(/\.json$/, '.tmp');
    Journal.writeDurable(temporary, JSON.stringify(receipt, null, 2), 'w');
    fs.renameSync(temporary, file);
  }
  // An uncertain write whose target the next call read as still there, unchanged: it is closed as superseded (its lock
  // released) so that exactly one new send replaces it. A 'sending' receipt may have a live sender: never superseded.
  supersede(receipt, byOperationId) {
    if (this.rawState(receipt.operationId) === 'sending') throw new ProtocolError('Sender may still be active; a sending receipt is never superseded');
    if (!['uncertain', 'accepted-unverified'].includes(receipt.state)) throw new ProtocolError('Only an uncertain receipt is superseded');
    Object.assign(receipt, { state: 'superseded', ok: false, supersededBy: canonicalUuid(byOperationId), updatedAt: utc(),
      verification: 'The target was read again, unchanged, after this uncertain send; one new send replaces it' });
    this.rewrite(receipt);
    const lock = this.lockFile(receipt.lock ?? Journal.targetOf(receipt.identity));
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === receipt.operationId) fs.unlinkSync(lock);
  }
  // Closes an uncertain receipt with the outcome a reading proved, or with the user's discard (P6): the state (RESOLVED),
  // the reason and what was observed go into the receipt (resolution + the resolutions history) and into resolutions.jsonl
  // of the journal, and the target lock this receipt holds is released. A 'sending' receipt may have a live sender: only
  // one older than STALE_SENDING_MS is resolved. Nothing is ever sent from here.
  resolve(receipt, state, reason, extra = {}, now = Date.now()) {
    if (!RESOLVED.includes(state)) throw new ProtocolError('A receipt resolves only as ' + RESOLVED.join(', '));
    const raw = this.rawState(receipt.operationId);
    if (raw === 'sending' && !(now - Date.parse(receipt.createdAt) >= STALE_SENDING_MS))
      throw new ProtocolError('Sender may still be active; a sending receipt younger than 30 min is never resolved');
    const current = raw === 'sending' ? 'uncertain' : raw;
    if (!UNSURE.includes(current)) throw new ProtocolError(`Only an uncertain receipt is resolved; this one is ${current ?? 'missing'}`);
    const entry = { at: utc(), from: current, to: state, reason, ...extra };
    Object.assign(receipt, { state, ok: state === 'confirmed', resolvedAt: entry.at, resolution: entry,
      resolutions: [...(Array.isArray(receipt.resolutions) ? receipt.resolutions : []), entry], updatedAt: entry.at });
    if (state === 'confirmed') receipt.verification = 'Desired state observed; this does not prove which writer established it';
    this.rewrite(receipt);
    fs.appendFileSync(path.join(this.root, 'resolutions.jsonl'), JSON.stringify({ operationId: receipt.operationId, identity: receipt.identity, ...entry }) + '\n');
    const lock = this.lockFile(receipt.lock ?? Journal.targetOf(receipt.identity));
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8').trim() === receipt.operationId) fs.unlinkSync(lock);
    return receipt;
  }

  // The user's explicit discard of an uncertain receipt: their words (only the sha256 is kept) close it as discarded.
  discard(receipt, userWords, now = Date.now()) {
    if (!userWords || !strip(userWords)) throw new ProtocolError("discard needs the user's own words");
    return this.resolve(receipt, 'discarded', 'discarded by the user; the outcome of the send stays unknown and nothing was sent again',
      { authorization: { wordsSha256: sha256(Buffer.from(userWords, 'utf8')) } }, now);
  }

  // The last receipt that wrote a target, by a reference to it (host, kind, folded name or key): a repeated delete whose
  // target is gone answers from it without any send.
  pointerFile(ref) { return path.join(this.root, 'targets', fingerprint(ref) + '.txt'); }
  point(ref, operationId) {
    const file = this.pointerFile(ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    Journal.writeDurable(file, canonicalUuid(operationId), 'w');
  }
  pointed(ref) {
    try { return canonicalUuid(fs.readFileSync(this.pointerFile(ref), 'utf8').trim()); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  reconcile(receipt) {
    if (['confirmed', 'accepted'].includes(receipt.state)) return;
    if (JSON.parse(fs.readFileSync(this.path(receipt.operationId), 'utf8')).state === 'sending')
      throw new ProtocolError('Sender may still be active; a sending receipt cannot be automatically reconciled');
    const lock = this.lockFile(receipt.lock ?? Journal.targetOf(receipt.identity));
    if (!fs.existsSync(lock) || fs.readFileSync(lock, 'utf8') !== receipt.operationId) throw new ProtocolError('Pending target lock no longer belongs to this receipt');
    Object.assign(receipt, { state: 'confirmed', ok: true, reconciledAt: utc(), verification: 'Desired state observed; this does not prove which writer established it' });
    const file = this.path(receipt.operationId);
    const temporary = file.replace(/\.json$/, '.tmp');
    Journal.writeDurable(temporary, JSON.stringify(receipt, null, 2), 'wx');
    fs.renameSync(temporary, file);
    fs.unlinkSync(lock);
  }

  // Reserve the operation (target lock + 'sending' receipt, both durable, before anything is sent), run fn(receipt),
  // then persist the receipt as fn left it. Uncertain writes keep their target lock: a read can reconcile, never replay.
  async reserve(operationId, identity, userWords, plan, lockTarget, fn) {
    fs.mkdirSync(this.root, { recursive: true });
    const file = this.path(operationId);
    // Also exclude concurrent writes with different IDs to the same runtime target.
    const lock = this.lockFile(lockTarget ?? Journal.targetOf(identity));
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') {
        // The holder by name and the ways out (P6): verify reads and resolves, discard takes the user's words.
        const holder = this.holder(lockTarget ?? Journal.targetOf(identity));
        let receipt = null;
        try { receipt = holder ? this.lookup(holder) : null; } catch { receipt = null; }
        throw new TargetPending({ holder, receipt, host: identity.host });
      }
      throw error;
    }
    const receipt = { schema: 'ssam-service-center/1', operationId: canonicalUuid(operationId), identity,
      authorization: { wordsSha256: sha256(Buffer.from(userWords, 'utf8')), planSha256: fingerprint(plan) },
      state: 'sending', ok: false, createdAt: utc(), receipt: path.resolve(file), ...(lockTarget ? { lock: lockTarget } : {}) };
    try {
      try { fs.writeSync(fd, receipt.operationId); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // No replacement: even a concurrent same-ID caller cannot repeat the POST.
      Journal.writeDurable(file, JSON.stringify(receipt, null, 2), 'wx');
    } catch (error) {
      fs.rmSync(lock, { force: true });
      throw error;
    }
    try { return await fn(receipt); }
    finally {
      const temporary = file.replace(/\.json$/, '.tmp');
      Journal.writeDurable(temporary, JSON.stringify(receipt, null, 2), 'w');
      fs.renameSync(temporary, file);
      if (RELEASED.includes(receipt.state)) fs.rmSync(lock, { force: true });
    }
  }
}
