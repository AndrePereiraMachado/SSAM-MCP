// Semantic O11 operations over discovered Service Center forms, with durable receipts (port of
// kernel/scripts/service_center/client.py). The same parsers serve both page transports: direct HTTPS after the vault
// form login (Transport) and the connected Studio's headless HTTP transport (StudioWebTransport). Web Forms postbacks are
// rebuilt from the page's own form state (__OSVSTATE/__VIEWSTATE/__EVENTVALIDATION); server scripts are never run.
//
// Modern Service Center pages: lists are read only from the page's content (div.sc-content-main), never from the
// sidebar's Recent Items; a module's tabs are div[data-tab] panels of the same page; anchors post back through
// __doPostBack with __EVENTTARGET/__EVENTARGUMENT added here; OsAjax replies are read only through their refreshed
// "__OSVSTATE" and the HTML they carry. Pages whose layout is only ASSUMED refuse any other layout with LAYOUT_UNKNOWN
// and the page-layout read that captures them live.
import { wordsGiven } from '../destructive-operations.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readCheckpoint } from '../read-budget.mjs';
import path from 'node:path';
import { redactText } from './bridge.mjs';
import { BridgeError, LayoutError, ProtocolError, ScheduleInModule, TargetPending, connectStudio, continuation } from './errors.mjs';
import { Document, Page, button, caption, classes, confirmText, controlValue, controls, escape, formFields, isVoid, lower, postbackTarget, secretRefs as toSecretRefs } from './html.mjs';
import { NOT_SENT, STATE, Transport, decode } from './http.mjs';
import { parseQs, quote, urlsplit } from './urls.mjs';
import { canonicalUuid, escapeRegExp, fingerprint, fold, rstrip, same, sha256, splitlines, strip, utc, words } from './util.mjs';
import { excelTime, xlsxRows } from './xlsx.mjs';
import { asyncStatusArguments, parseAsyncStatus } from './async-status.mjs';
import { solutionDownload, solutionDownloadAbandon, solutionDownloadStatus } from './solution-download.mjs';
import { timerLogSnapshot, compareTimerLogs, observeTimerErrors } from './timer-observation.mjs';
import { selectIntegrationRecord, exactIntegrationRow, integrationPayloadControl, integrationPayloadPage, payloadFailure } from './integration-payload.mjs';
import { OwnerSelectionStore } from './owner-selection.mjs';

// The Timers log is Cyclic_Job_Logs.aspx (Monitoring > Timers, live on 11.42); Timer_Logs.aspx does not exist.
export const LOG_PAGES = { error: 'Error_Logs.aspx', general: 'General_Logs.aspx', integration: 'Integration_Logs.aspx', timer: 'Cyclic_Job_Logs.aspx' };
const EXPORTABLE = ['error', 'integration'];
// Log filters: the visible label before the control, or the name suffix of the O11 English pages (matrix L1, L6-L8).
const LOG_FILTERS = { application: [['application'], ['wtApplication_Selector']], module: [['module', 'espace'], ['wtEspace_Selector']],
  message: [['message'], ['wtInput1']], source: [['source'], ['wtInput7', 'wtSourceInput']], server: [['server'], ['wtInput4']],
  type: [['type'], ['wtTypeSelector']], action: [['action'], ['wtActionInput']], timer: [['timer', 'name'], ['wtTimerInput']],
  since: [['from', 'from date', 'start date'], ['wtFilter_FromDate']], until: [['to', 'to date', 'end date'], ['wtFilter_ToDate2']] };
// Control suffixes are reused across log pages (Integration Action and Timer Name
// both use wtInput1). A suffix alone must never enable another kind's filter.
export const LOG_KIND_FILTERS = {
  error: ['application', 'module', 'message', 'source', 'server', 'since', 'until'],
  general: ['application', 'module', 'message', 'source', 'server', 'since', 'until'],
  integration: ['application', 'module', 'type', 'action', 'server', 'since', 'until'],
  timer: ['application', 'module', 'timer', 'server', 'since', 'until']
};
// General and timer logs are ASSUMED pages: their listing must show these columns or the page is refused.
const ASSUMED_LOGS = { general: ['module', 'message'], timer: ['module', 'timer'] };
export const ACTIONS = { 'timer-run': ['Run Now', 'Run now'], 'timer-deactivate': ['Deactivate'], 'timer-activate': ['Activate'],
  'property-set': ['Apply', 'Save'], 'timer-schedule': ['Apply', 'Save'] };
export const VALUE_ACTIONS = ['property-set', 'timer-schedule'];
// The timer page's schedule editor (matrix T4, ASSUMED): label or name suffix of each control.
export const SCHEDULE = { recurrence: [['recurrence'], 'wtSchedule_Recurrence'], at: [['at'], 'wtSchedule_Time'],
  every: [['every (minutes)', 'every'], 'wtSchedule_Interval'], timeout: [['timeout (minutes)', 'timeout'], 'wtTimeout'] };
// Page writes beyond timers and properties: the target keys of their journal identity.
export const WEB_WRITES = { 'application-timeout-set': ['application'], 'solution-create': ['solution'], 'solution-delete': ['solution'], 'solution-add-component': ['solution', 'component'],
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

// Stable public result for Run Now: transport receipt, execution evidence and
// attribution are separate facts. HTTP 200 alone is never reported as success.
export function timerRunOutcome(receipt) {
  const observed=receipt.observed ?? receipt.resolution?.observed;
  const before=receipt.plan?.lastRunBefore, after=observed?.lastRun;
  const moved=before!==undefined && typeof after==='string' && !NEVER.test(after.trim()) && fold(after)!==fold(String(before ?? ''));
  const executed=receipt.executionObserved===true || moved || (receipt.resolution?.observed?.newRuns?.length??0)>0;
  const failed=receipt.failedAttemptObserved===true;
  const acknowledged=receipt.schedulerResponse?.schedulingAcknowledged===true || receipt.state==='accepted';
  const notSent=['refused','rejected'].includes(receipt.state);
  const outcome=failed?'execution-failed':executed?'execution-observed':notSent?'not-sent'
    :receipt.state==='obsolete'?'timer-absent':receipt.state==='not-executed'?'not-executed':acknowledged?'scheduled':'unknown';
  const result={...receipt, outcome, ok:['scheduled','execution-observed'].includes(outcome),
    requestStatus:notSent?'not-sent':acknowledged?'accepted':'unconfirmed',
    executionObserved:executed, executionCompleted:executed?null:false, attributedToRequest:false,
    evidence:{basis:executed?(moved?'last-run-changed':'new-exact-timer-log-rows'):acknowledged?'scheduler-acknowledgment':'no-confirmation',
      lastRunBefore:before??null,lastRunAfter:after??null,status:observed?.status??null},replayed:false};
  if(!result.ok)result.code=outcome==='unknown'?'TIMER_RUN_OUTCOME_UNKNOWN':outcome==='execution-failed'?'TIMER_EXECUTION_FAILED':receipt.code??'TIMER_RUN_NOT_EXECUTED';
  else {delete result.code;delete result.error;}
  if(['unknown','scheduled'].includes(outcome))result.continuation={tool:'o11_service_center_write',
    arguments:{action:'verify',host:receipt.identity.host,operationId:receipt.operationId},
    why:'Read this receipt and timer execution evidence without sending Run Now again.'};
  return result;
}

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
export const secretPresence = field => {
  if (typeOf(field) !== 'password') return null;
  const placeholder = field.attr('placeholder', '') ?? '';
  return /^•{3,}$/.test(placeholder) ? true : placeholder === 'No value set' ? false : null;
};
// What the page shows in a control: a select's chosen option text, else its value.
export const shown = field => (field.tag === 'select' ? selectedText(field) : observedValue(field));
export function expectedValue(field, value) {
  if (typeOf(field) !== 'checkbox') return value;
  if (!['true', 'false'].includes(value.toLowerCase())) throw new ProtocolError('Boolean properties require true or false');
  return value.toLowerCase();
}

export const content = page => page.doc.content();
export function heading(page) {
  const found = content(page).all('div', 'span', 'h1', 'h2').filter(n => n.tag === 'h1' || n.tag === 'h2' || classes(n).includes('heading2')).map(n => n.text);
  return found[0] ?? '';
}
function bptDetailIdentity(page, kind, id) {
  const title = heading(page) || page.doc.all('title')[0]?.text || '', detail = summary(page);
  const prefix = kind === 'process' ? 'Process' : 'Activity';
  const pattern = new RegExp('^' + prefix + '\\b[\\s\\S]*\\bInstance\\s+(?:no|nr)\\.?\\s*' + escapeRegExp(String(id)) + '(?![0-9])', 'i');
  if (!pattern.test(title) || typeof detail.Status !== 'string' || !detail.Status.trim())
    throw new ProtocolError('The BPT detail did not prove the requested ' + kind + ' instance identity; no detail returned', 'SC_RESOURCE_IDENTITY_UNVERIFIED');
  return {title, detail};
}
export const errors = page => page.doc.all().filter(n => n.text && /(?:Feedback_Message_Error|ValidationMessage|ErrorMessage)/i.test(n.attr('class', '') ?? ''));
export const acknowledged = (page, pattern) => page.doc.all().some(n => new RegExp(pattern, 'i').test(n.text) && /Feedback_Message_Success/i.test(n.attr('class', '') ?? ''));

export function connectionTestOutcome(page) {
  const inFeedback = node => {
    for (let current=node; current; current=current.parent)
      if (/(?:^|_)wtFeedback(?:_|$)/.test(current.attr?.('id','') ?? '')) return true;
    return false;
  };
  const nodes = page.doc.all().filter(node => node.text);
  const good = nodes.filter(node => /Feedback_Message_Success/i.test(node.attr('class','') ?? '')
    || (classes(node).includes('alert-success') && inFeedback(node)));
  const bad = [...errors(page), ...nodes.filter(node => classes(node).includes('alert-danger') && inFeedback(node))];
  if (!good.length && !bad.length) return null;
  return { testPassed:good.length > 0 && !bad.length,
    feedback:good.length && !bad.length ? 'success' : 'error (server text withheld: it can echo the login)' };
}

export function checked(page) {
  // An expired session answers with the login page at the asked URL: its form posts to Login.aspx.
  const loginForm = page.doc.all('form').some(f => /^_?login(?:sso)?\.aspx$/i.test(urlsplit(f.attr('action', '') || '').path.split('/').pop()));
  if (urlsplit(page.url).path.toLowerCase().endsWith('/login.aspx') || loginForm) throw new ProtocolError('Service Center login required or session expired', 'SC_AUTH_EXPIRED');
  if (['permission denied', 'access denied'].includes(fold(heading(page))))
    throw new ProtocolError('Service Center denied access to this resource; no identity or permissions were changed.', 'SC_PERMISSION_DENIED');
  // Feedback may echo a password/property value. Never return raw server feedback.
  if (errors(page).length) throw new ProtocolError('Service Center reported a validation/permission error');
  return page;
}

const cellsOf = row => row.children.filter(c => c?.tag === 'th' || c?.tag === 'td');
// Header-keyed rows of the listings inside root (default: the page content, never the sidebar).
export function tables(page, redactValues = false, root = null) {
  const result = [];
  for (const table of root?.tag === 'table' ? [root] : (root ?? content(page)).all('table')) {
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
export function moduleRows(page) {
  return factoryRows(page, 'module');
}
export function applicationRows(page) {
  return factoryRows(page, 'application');
}
function factoryRows(page, kind) {
  const isApp = kind === 'application', route = isApp ? /\/Application_Edit\.aspx$/i : /\/eSpace_Edit\.aspx$/i;
  const idField = isApp ? 'ApplicationId' : 'EspaceId';
  const control = isApp ? /_wtListApplications_ctl[0-9]+_wtEspaceLink$/ : /_wtListEspaces_ctl[0-9]+_wtESpaceLink$/;
  const parsed = tables(page), known = new Map();
  for (const row of parsed) for (const link of row.links) if (route.test(new URL(link.href, page.url).pathname))
    known.set(new URL(link.href, page.url).href, row);
  const rows = [], seen = new Map();
  for (const anchor of content(page).all('a')) {
    if (inside(anchor, /RecentItems|sc-content-left/i)) continue;
    const href = anchor.attr('href'); if (!href || /^(?:javascript:|#)/i.test(href)) continue;
    const url = new URL(href, page.url); if (!route.test(url.pathname)) continue;
    const name = anchor.text.trim(), id = url.searchParams.get(idField);
    if (isApp && !name) continue; // application icon link accompanies the named link
    if (url.origin !== new URL(page.url).origin || !/^[1-9][0-9]*$/.test(id ?? '') || !name)
      throw new ProtocolError('Unverified module listing link');
    const row = known.get(url.href);
    if (!row && !control.test(anchor.attr('id', '') ?? ''))
      throw new ProtocolError('Module link outside recognized listing row');
    if (seen.has(id)) { if (seen.get(id) !== name) throw new ProtocolError('Conflicting module listing names'); continue; }
    seen.set(id, name);
    // Malformed description HTML may close the table before subsequent rows.
    // The generated listing link still proves module identity; do not invent missing cells.
    rows.push(row ?? { fields: { Name: name }, links: [{ name, href: url.href }], partialFields: true });
  }
  if (parsed.length && !rows.length) throw new ProtocolError('Module listing has rows but no module identities');
  return rows;
}

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

export function nextLink(page, scope = content(page)) {
  const links = scope.all('a').filter(a => (['next', 'next ›', '›', '>', 'próxima', 'seguinte'].includes(fold(a.text)) || a.attr('rel') === 'next')
    && !a.has('disabled') && a.attr('aria-disabled') !== 'true' && !lower(a.attr('class', '')).includes('disabled') && (a.attr('href') || a.attr('onclick')));
  if (links.length <= 1) return links[0] ?? null;
  // Live SC repeats the pager above and below the same listing. Their generated
  // event names differ, but the enclosing component and explicit slots agree.
  const slots = links.map(a => /^(.*)_wt(Top|Bottom)LinksPlaceholderRight_/.exec(a.attr('id','')));
  const destinations = links.map(a => {
    if (a.attr('onclick') || !a.attr('href') || /^(?:javascript:|#)/i.test(a.attr('href'))) return null;
    try { const url = new URL(a.attr('href'), page.url); url.searchParams.sort(); return url.href; }
    catch { return null; }
  });
  const sameNavigation = destinations[0] && destinations.every(url => url === destinations[0]);
  if (links.length === 2 && slots.every(Boolean) && slots[0][1] === slots[1][1]
      && slots[0][2] !== slots[1][2] && (sameNavigation || links.every(a => postbackTarget(a)?.kind === 'osajax')))
    return links[slots.findIndex(s => s[2] === 'Top')];
  throw new ProtocolError('Ambiguous Next controls; cannot claim the listing is complete');
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
  if (nativeScheduleControls(page, form)) return true;
  const found = entries(formLabels(page, form));
  return Object.values(SCHEDULE).every(([names, suffix]) => found.filter(({ name, label }) => name.endsWith(suffix) || names.includes(label)).length === 1);
}

// Observed 11.42 editor: Generate is client-only; Save commits the explicit times.
export function nativeScheduleControls(page, form) {
  const found = entries(formLabels(page, form));
  const take = suffix => found.filter(e => e.name.endsWith(suffix)).map(e => e.n);
  const at = take('$wtInputTimerTimes'), recurrence = take('$wtSelectScheduleType');
  if (at.length !== 1 || recurrence.length !== 1 || at[0].tag !== 'input' || recurrence[0].tag !== 'select') return null;
  return { at: at[0], recurrence: recurrence[0] };
}
export function nativeScheduleRequest(target, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length
    || Object.keys(value).some(k => !['at', 'every', 'recurrence'].includes(k)))
    throw new ProtocolError('This timer editor supports at/every with Daily occurrence; timeout and other occurrence editors are not mapped');
  if (value.at !== undefined && value.every !== undefined) throw new ProtocolError('Specify at or every, not both');
  const occurrence = String(value.recurrence ?? shown(target.recurrence));
  if (fold(occurrence) !== 'daily') throw new ProtocolError('This timer schedule contract supports Daily occurrence only');
  let at = value.at;
  if (value.every !== undefined) {
    const match = /^(\d{1,2})(?:\s*(?:m|min|mins|minutes))?$/i.exec(String(value.every).trim());
    const n = match ? Number(match[1]) : 0;
    if (n < 1 || n > 60 || 60 % n) throw new ProtocolError('Schedule every must be an integer divisor of 60 minutes');
    at = Array.from({ length: 1440 / n }, (_, i) => String(Math.floor(i * n / 60)).padStart(2, '0') + ':' + String(i * n % 60).padStart(2, '0')).join(' ');
  }
  if (at === undefined) throw new ProtocolError('Daily schedule requires at or every');
  at = String(at).trim();
  if (at && at.split(/\s+/).some(t => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)))
    throw new ProtocolError('Schedule at requires native HH:mm times separated by spaces');
  const maximum = Number(target.at.attr('maxlength'));
  if (!Number.isSafeInteger(maximum) || maximum < 1 || at.length > maximum)
    throw new ProtocolError('Schedule exceeds the live time field length limit; no truncation or write is allowed');
  return { recurrence: one(target.recurrence.all('option').filter(o => fold(o.text) === 'daily'), 'Daily occurrence').text, at };
}

// The refusal of timer-schedule on a page without that editor: the module change, with what the page shows now.
export function scheduleInModule(page, name, requested = null) {
  const fields = timerFields(page);
  return new ScheduleInModule({ timer: name, module: fields.module ?? null, schedule: moduleSchedule(requested),
    current: Object.fromEntries(['schedule', 'effectiveSchedule', 'defaultSchedule', 'nextRun'].filter(k => Object.hasOwn(fields, k)).map(k => [k, fields[k]])) });
}

// Return native daily occurrences. A string accepted by the generic model setter
// is not proof that the platform interprets it as a schedule.
export function moduleSchedule(value) {
  if (!value || typeof value !== 'object') return null;
  const recurrence = fold(String(value.recurrence ?? '')), every = String(value.every ?? '').trim(), at = String(value.at ?? '').trim();
  const interval = /^(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i.exec(every);
  const minutes = interval ? Number(interval[1]) * (/^h/i.test(interval[2] ?? '') ? 60 : 1) : null;
  if (minutes && !at && minutes <= 60 && 60 % minutes === 0 && (!recurrence || /^(every|every n minutes|interval|daily)$/.test(recurrence)))
    return Array.from({ length: 1440 / minutes }, (_, i) => `${String(Math.floor(i * minutes / 60)).padStart(2, '0')}:${String(i * minutes % 60).padStart(2, '0')}`).join(' ');
  const time = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!every && time && Number(time[1]) < 24 && Number(time[2]) < 60 && (!recurrence || /^(daily|day)$/.test(recurrence))) return `${time[1].padStart(2, '0')}:${time[2]}`;
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

// Native OsJSONUpdate applies hidden fields in response order. A later state
// supersedes an earlier one, including an invalid/empty final state: never fall
// back to an older token when the final update cannot be used.
export const ajaxState = reply => {
  const states = [...reply.matchAll(/"__OSVSTATE"\s*[,:]\s*"([^"\r\n]*)"/g)];
  const state = states.at(-1)?.[1];
  return state && /^[A-Za-z0-9+/=_.:-]+$/.test(state) ? state : null;
};
// A live pager asks its parent to refresh the list, optionally updating its
// state first. Interpret the bound notification; never evaluate server JS.
export function pagerNotify(reply, expectedTarget, { allowUnchangedState = false } = {}) {
  const commands = [];
  let commandsOnly = true;
  for (const match of reply.matchAll(/OsJSONUpdate\((\{[^\r\n]*\})\)/g)) {
    let data; try { data = JSON.parse(match[1]); } catch { throw new ProtocolError('Invalid pager response'); }
    commandsOnly &&= Object.keys(data).every(key => key === 'js');
    if (data.js !== undefined) {
      if (!Array.isArray(data.js) || data.js.some(x => typeof x !== 'string')) throw new ProtocolError('Invalid pager commands');
      commands.push(...data.js);
    }
  }
  const notifications = [];
  for (const command of commands) {
    const match = /^OsNotifyWidget\('([A-Za-z0-9_]+)', ''\);$/.exec(command);
    if (match) notifications.push(match[1]);
    else if (command !== 'OsEndRequest()' && !/^OsSetRequestInfo\('[a-f0-9-]{36}','List_Navigation\.Next','[a-f0-9-]{36}'\)$/.test(command))
      throw new ProtocolError('Unsupported pager continuation; no script was executed');
  }
  const unchanged = allowUnchangedState && commandsOnly && commands.includes('OsEndRequest()');
  if (notifications.length !== 1 || notifications[0] !== expectedTarget || !ajaxState(reply) && !unchanged)
    throw new ProtocolError('Pager continuation does not match its current Next control');
  return notifications[0];
}
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
export function ajaxPage(page, reply, submittedFields = null) {
  const state = ajaxState(reply); const fragments = ajaxMarkup(reply); const form = page.doc.first('form');
  if (state === null || !fragments.length || !form) throw new LayoutError(page.url, 'OsAjax reply', 'it carries no refreshed form state or no list markup');
  const retainedNames = new Set(controls(form).filter(n => !['submit','button','image','reset'].includes(typeOf(n))).map(n => n.attr('name')));
  // Updated filter widgets carry their own controls. Retaining their previous
  // values as hidden inputs duplicates names on the next postback (e.g. 0,0
  // instead of 0), changing the search rather than navigating its next page.
  const refreshedNames = new Set(new Document(fragments.join('')).all('input', 'select', 'textarea', 'button').map(n => n.attr('name')).filter(Boolean));
  const retained = (submittedFields ? submittedFields.filter(([k]) => retainedNames.has(k)) : formFields(form))
    .filter(([k]) => !refreshedNames.has(k));
  const hidden = retained.map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(k.endsWith('__OSVSTATE') ? state : v)}">`).join('');
  return new Page(page.url, new Document(`<form method="post" action="${escape(form.attr('action') || '')}">${hidden}<div class="sc-content-main">${fragments.join('')}</div></form>`));
}

export function unchangedReadTab(page, reply) {
  const state = ajaxState(reply); let ended = false, envelopes = 0;
  for (const match of reply.matchAll(/OsJSONUpdate\((\{[^\n]*\})\)/g)) {
    let data; try { data = JSON.parse(match[1]); } catch { throw new ProtocolError('Invalid tab acknowledgement'); }
    envelopes++;
    if (Object.keys(data).some(k => !['hidden','js'].includes(k)) || data.hidden && Object.keys(data.hidden).some(k => k !== '__OSVSTATE')
      || data.js !== undefined && !Array.isArray(data.js)) throw new ProtocolError('Unsupported tab acknowledgement');
    for (const command of data.js ?? []) {
      if (command === 'OsEndRequest()') ended = true;
      else if (typeof command !== 'string' || !/^OsSetRequestInfo\('[a-f0-9-]{36}','[A-Za-z0-9_.]+','[a-f0-9-]{36}'\)$/.test(command))
        throw new ProtocolError('Unsupported tab continuation; no script executed');
    }
  }
  const fields = page.doc.all('input').filter(n => n.attr('name') === '__OSVSTATE');
  if (!envelopes || !ended || !state || fields.length !== 1 || ajaxMarkup(reply).length) throw new ProtocolError('Tab acknowledgement is incomplete');
  fields[0].attrs.set('value',state);
  return page;
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
  const inner = privateDiagnosticValue(node) ? '[redacted]' : node.tag === 'textarea' ? '' : node.children.map(skeleton).join('');
  if (node.tag === 'document') return inner;
  const rendered = [...attrs].map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${escape(v)}"`)).join('');
  return isVoid(node.tag) ? `<${node.tag}${rendered}>` : `<${node.tag}${rendered}>${inner}</${node.tag}>`;
}

// The live diagnostic view renders Session Id as ordinary text, not an input.
// Unexpected-error pages also embed license/activation diagnostics in a pre
// block. Preserve layout, never persist that report as calibration markup.
function privateDiagnosticValue(node) {
  if(node.tag==='pre'&&/\b(?:InstallerId|License\s*(?:Edition|Key)|Activation\s*Code|Serial(?:\s*Number)?)\s*:/i.test(node.text))return true;
  if (node.tag !== 'div' || !classes(node).includes('columns-item') || node.all('label').length) return false;
  const siblings = node.parent?.children.filter(n => typeof n !== 'string') ?? [];
  return siblings.length === 2 && siblings[1] === node && siblings[0].all('label').some(n => /^session\s*id$/i.test(strip(n.text)));
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

export function applicationOwner(page) {
    // Only the semantic owner link in the module header proves ownership. Recent items and reference rows do not.
    const owners = page.doc.all('a').filter(a => a.attr('data-name') === 'applicationedit'
      && (/(?:^|_)wtContentTop(?:_|$)/.test(a.attr('id', '') ?? '') || inside(a, /(?:^|_)wtContentTop(?:_|\s|$)/)))
      .map(a => ({ name: a.text.trim(), url: new URL(a.attr('href', '') ?? '', page.url) }));
    const owner = owners.length === 1 && owners[0].name && owners[0].url.origin === new URL(page.url).origin
      && /\/Application_Edit\.aspx$/i.test(owners[0].url.pathname)
      && /^[1-9][0-9]*$/.test(owners[0].url.searchParams.get('ApplicationId') ?? '') ? owners[0] : null;
    return owner;
}

export class Client {
  constructor(vault, transport = null, exports = null) {
    this.vault = vault;
    this.http = transport ?? new Transport(vault.host);
    this.authenticated = false;
    this.exports = exports ? String(exports) : null;
  }

  async login() {
    if (this.authenticated || this.http.preauthenticated) return;
    let page;
    try { page = await this.http.request('Login.aspx'); }
    catch(error) {
      if(error.code !== 'SC_SSO_REQUIRED' || !this.http.authenticateSso) throw error;
      await this.http.authenticateSso(); this.authenticated = true; return;
    }
    if (!page.doc.login() && this.http.authenticateSso && page.doc.all('input','button').some(n => /log ?in with|single sign/i.test(n.attr('value','') || n.text))) {
      await this.http.authenticateSso(); this.authenticated = true; return;
    }
    // SSO/captcha/identity-provider flows need their own supported protocol.
    if (!page.doc.login()) throw new ProtocolError('No Service Center password form; SSO login variant is unsupported by this adapter');
    const passwords = page.doc.all('input').filter(n => typeOf(n) === 'password');
    if (passwords.length !== 1) throw new ProtocolError('Ambiguous login form');
    const form = passwords[0].ancestor('form');
    if (!form) throw new Error('password outside a form');
    // Current SC places telemetry text fields outside its explicit login-form
    // container. Scope credential discovery to that container, never to a
    // guessed generated field name or the first text input on the page.
    const containers = form.all().filter(n => classes(n).includes('login-form'));
    if (containers.length > 1) throw new ProtocolError('Ambiguous login container');
    const scope = containers[0] ?? form;
    if (!scope.all('input').includes(passwords[0])) throw new ProtocolError('Password outside login container');
    const users = controls(scope).filter(n => n.tag === 'input' && ['text', 'email'].includes(typeOf(n, 'text')));
    if (users.length !== 1) throw new ProtocolError('Ambiguous login username field');
    const click = button(page, ['Log in', 'Login', 'Log In', 'Sign in']);
    if (click.ancestor('form') !== form) throw new ProtocolError('Login controls do not belong to the same form');
    if (!scope.all('input', 'button').includes(click)) throw new ProtocolError('Submit outside login container');
    const response = await this.http.vaultLogin(page, click, users[0].attr('name'), passwords[0].attr('name'), this.vault);
    checked(response);
    if (response.doc.login()) throw new ProtocolError('Service Center did not accept the vault login; no automatic retry');
    if (!response.doc.all('a', 'input', 'button').some(a => lower((a.attr('href', '') ?? '') + a.text).includes('logout') || lower(a.text).includes('log out')))
      throw new ProtocolError('Could not confirm an authenticated Service Center session');
    this.authenticated = true;
  }

  async get(url) {
    await this.login();
    const authenticationGeneration = this.authenticationRecoveries ?? 0;
    try { return checked(await this.http.request(url)); }
    catch(error) {
      const expired=['SC_AUTH_EXPIRED','SC_SSO_REQUIRED','WEB_SIGN_IN_REQUIRED'].includes(error.code)
        || error instanceof ProtocolError && error.message==='Service Center returned HTTP 401';
      if(!expired || authenticationGeneration > 0 || this.http.authorized || typeof this.http.authenticateSso!=='function')throw error;
      readCheckpoint('authentication-recovery');
      // This callback is bound to the already selected host/principal/profile.
      // Concurrent GETs started before expiry share one recovery, including
      // late responses received after it completes. A later expiry still fails.
      // Never retry postbacks, change identity or reset the read budget.
      if(!this.authenticationRecoveryPromise){
        this.authenticationRecoveries=1;
        this.authenticationRecoveryPromise=Promise.resolve().then(async()=>{await this.http.authenticateSso();this.authenticated=true;});
      }
      await this.authenticationRecoveryPromise;
      readCheckpoint('authentication-recovered-read');
      return checked(await this.http.request(url));
    }
  }

  async follow(page, link) {
    const href = link.attr('href', '') ?? '';
    if (/^(?:javascript:|#)/.test(href) || link.attr('onclick')) throw new ProtocolError('Scripted navigation variant unsupported; no JavaScript is executed');
    return this.get(this.http.url(href, page.url));
  }

  // A read postback whose answer is a page, or an OsAjax reply read through its state and markup.
  async readPostback(page, url, fields, allowUnchangedTab = false) {
    const [final, text] = await this.http.reply(url, fields);
    if (/<form\b/i.test(text)) return checked(new Page(final, new Document(text)));
    if (allowUnchangedTab && !ajaxMarkup(text).length) return unchangedReadTab(page,text);
    return ajaxPage(page, text, fields);
  }

  // A read click on a submit control: a plain form post, or the OsAjax request its onclick sends (L7 Filter).
  async click(page, control, updates = null, allowUnchangedTab = false) {
    if (/OsAjax/.test(control.attr('onclick', '') ?? '')) return this.readPostback(page, ...this.http.ajaxPost(page, control, updates), allowUnchangedTab);
    return checked(await this.http.submit(page, control, updates));
  }

  // A Web Forms pager (__doPostBack or OsAjax) is replayed as the page's own form post, never as script.
  async nextPage(page, link) {
    const event = postbackTarget(link);
    if (event?.kind === 'osajax') {
      const [url, fields] = this.http.ajaxPost(page, link);
      const [final, reply] = await this.http.reply(url, fields);
      if (/<form\b/i.test(reply)) return checked(new Page(final, new Document(reply)));
      if (ajaxMarkup(reply).length) return ajaxPage(page, reply, fields);
      const id = link.attr('id','');
      let target;
      const currentStates = fields.filter(([key]) => key === '__OSVSTATE');
      const currentState = currentStates.length === 1 && typeof currentStates[0][1] === 'string'
        && /^[A-Za-z0-9+/=_.:-]+$/.test(currentStates[0][1]) ? currentStates[0][1] : null;
      try { target = pagerNotify(reply, id.slice(0, id.lastIndexOf('_')), {allowUnchangedState:currentState !== null}); }
      catch (error) { if (!(error instanceof ProtocolError)) throw error; throw new LayoutError(page.url, 'OsAjax pager', error.message); }
      return this.readPostback(page, ...this.http.notifyPost(page, target, fields, ajaxState(reply) ?? currentState));
    }
    if (event) return this.readPostback(page, ...this.http.eventPost(page, link));
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

  async pages(page, limit = 100, redact = false, maxPages = 20, validatePage = null, readRows = tables) {
    if (!(limit >= 1 && limit <= 5000)) throw new ProtocolError('limit must be between 1 and 5000');
    if (!(maxPages >= 1 && maxPages <= 100)) throw new ProtocolError('maxPages must be between 1 and 100');
    const rows = []; const seen = new Set();
    for (let n = 0; n < maxPages; n++) {
      if (validatePage) validatePage(page);
      if (!content(page).all('th').length && !EMPTY.test(content(page).text)) throw new ProtocolError('Unrecognized listing schema; refusing to report an empty result');
      const batch = readRows(page, redact);
      const marker = fingerprint(batch);
      if (seen.has(marker)) throw new ProtocolError('Service Center pagination did not advance');
      seen.add(marker);
      rows.push(...this.absolute(batch, page));
      const next = nextLink(page);
      if (rows.length >= limit || next === null)
        return { rows: rows.slice(0, limit), truncated: rows.length > limit || next !== null, source: page.url, observedAt: utc() };
      if (n + 1 === maxPages)
        return { rows, truncated: true, pageLimit: maxPages, source: page.url, observedAt: utc() };
      try { page = await this.nextPage(page, next); }
      catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        return { rows, truncated: true, source: page.url, paginationUnsupported: true, paginationError: error.message.slice(0, 500), observedAt: utc() };
      }
    }
    return { rows: rows.slice(0, limit), truncated: true, pageLimit: maxPages, observedAt: utc() };
  }

  async modules(limit = 100, maxPages = 20) { return this.pages(await this.get('eSpaces_List.aspx'), limit, false, maxPages, null, moduleRows); }

  async moduleDependencies({ moduleId, module, limit = 100, moduleLimit = 20, maxPages = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000 || !Number.isInteger(moduleLimit) || moduleLimit < 1 || moduleLimit > 2000)
      throw new ProtocolError('limit must be 1..5000 and module-limit 1..2000');
    if (moduleId && module) throw new ProtocolError('Choose module-id or exact module name, not both');
    if (module !== undefined && module !== null && (typeof module !== 'string' || !module.trim())) throw new ProtocolError('module must be an exact nonempty name');
    let selected, selectionTruncated = false;
    if (moduleId) selected = [{ id: String(moduleId), name: null }];
    else {
      const listing = await this.modules(moduleLimit, maxPages);
      const seen = new Map();
      for (const row of listing.rows) for (const link of row.links) {
        const url = new URL(link.href, listing.source);
        if (!/\/eSpace_Edit\.aspx$/i.test(url.pathname)) continue;
        const id = url.searchParams.get('EspaceId');
        if (url.origin !== new URL(listing.source).origin || !/^[1-9][0-9]*$/.test(id ?? '') || !link.name)
          throw new ProtocolError('Module listing identity is not verified');
        if (seen.has(id) && seen.get(id).name !== link.name) throw new ProtocolError('Conflicting names for one module ID');
        seen.set(id, { id, name: link.name });
      }
      if (listing.rows.length && !seen.size) throw new ProtocolError('Module listing has no recognized module identities');
      selected = [...seen.values()]; selectionTruncated = listing.truncated;
      if (module) {
        if (selectionTruncated) throw new ProtocolError('Exact module-name selection needs a complete listing; raise module-limit/max-pages', 'SC_MODULE_SELECTION_INCOMPLETE');
        selected = selected.filter(item => fold(item.name) === fold(module));
        if (selected.length !== 1) throw new ProtocolError('Exact module name is absent or ambiguous');
      }
    }
    const rows = [], scanned = []; let referencesTruncated = false;
    for (const item of selected) {
      if (rows.length >= limit) break;
      const result = await this.moduleReferences(item.id, limit - rows.length, maxPages);
      scanned.push(item); referencesTruncated ||= result.truncated;
      rows.push(...result.rows.map(row => ({ ...row, consumerModuleName: item.name })));
    }
    return { rows, direction: 'consumer-to-producer', modulesScanned: scanned, modulesSelected: selected.length,
      selectionTruncated, referencesTruncated, truncated: selectionTruncated || referencesTruncated || scanned.length < selected.length,
      observedAt: utc() };
  }

  async applicationOwners({moduleLimit = 2000, maxPages = 100, moduleOffset = 0, moduleBatchSize = 10, expectedModuleSelectionSha256 = null, ownerParallelism = 1, captureModuleSelection = false, moduleSelectionId = null} = {}) {
    if (!Number.isInteger(moduleLimit) || moduleLimit < 1 || moduleLimit > 2000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100)
      throw new ProtocolError('moduleLimit must be 1..2000 and maxPages 1..100');
    if (!Number.isInteger(moduleOffset) || moduleOffset < 0 || !Number.isInteger(moduleBatchSize) || moduleBatchSize < 1 || moduleBatchSize > 2000)
      throw new ProtocolError('moduleOffset must be nonnegative and moduleBatchSize 1..2000');
    if (!Number.isInteger(ownerParallelism) || ownerParallelism < 1 || ownerParallelism > 8) throw new ProtocolError('ownerParallelism must be 1..8');
    if (expectedModuleSelectionSha256 !== null && !/^[a-f0-9]{64}$/.test(expectedModuleSelectionSha256) || moduleOffset > 0 && expectedModuleSelectionSha256 === null)
      throw new ProtocolError('Resuming owners requires the previous module selection SHA256');
    if(typeof captureModuleSelection!=='boolean' || captureModuleSelection && (moduleSelectionId!==null || moduleOffset!==0))throw new ProtocolError('Capture selection once before resuming owner details');
    if(moduleSelectionId!==null && expectedModuleSelectionSha256===null)throw new ProtocolError('Owner selection capture requires its module hash');
    const store = captureModuleSelection || moduleSelectionId!==null ? new OwnerSelectionStore(this.exports,this.ownerSelectionIdentity) : null;
    const capture = moduleSelectionId!==null ? store.read(moduleSelectionId) : null;
    const modules = capture?.modules ?? await this.modules(moduleLimit,maxPages), indexed = new Map();
    for (const row of modules.rows) {
      const links = row.links.map(link => ({...link,url:new URL(link.href,modules.source)})).filter(link => /\/eSpace_Edit\.aspx$/i.test(link.url.pathname));
      if (links.length !== 1) throw new ProtocolError('Module owner discovery requires one module per row');
      const link = links[0], id = link.url.searchParams.get('EspaceId');
      if (link.url.origin !== new URL(modules.source).origin || !/^[1-9][0-9]*$/.test(id ?? '')) throw new ProtocolError('Unverified module owner discovery identity');
      if (indexed.has(id) && indexed.get(id).link.name !== link.name) throw new ProtocolError('Conflicting module names during owner discovery');
      indexed.set(id,{id,link});
    }
    const selection = [...indexed.values()];
    const moduleSelectionSha256 = fingerprint({host:this.vault.host,modules:selection.map(({id,link})=>({id,name:link.name})),listingTruncated:modules.truncated});
    if (expectedModuleSelectionSha256 !== null && expectedModuleSelectionSha256 !== moduleSelectionSha256)
      throw new ProtocolError('Module selection changed; do not combine inventories','SC_SELECTION_CHANGED');
    if (moduleOffset > selection.length) throw new ProtocolError('Module offset exceeds inventory');
    if(captureModuleSelection){
      const saved=store.save({source:modules.source,truncated:modules.truncated,rows:selection.map(({link})=>({links:[{name:link.name,href:link.url.href}]}))});
      return {phase:'selection-captured',rows:[],applications:[],unresolvedModules:[],moduleOffset:0,moduleBatchSize,ownerParallelism,modulesSelected:selection.length,moduleSelectionSha256,
        moduleSelectionId:saved.id,selectionCapturedAt:saved.capturedAt,listingTruncated:modules.truncated,truncated:true,snapshotAtomic:false,
        continuation:{tool:'o11_service_center_read',arguments:{action:'application-owners',host:this.vault.host,moduleLimit,maxPages,moduleOffset:0,moduleBatchSize,ownerParallelism,moduleSelectionId:saved.id,expectedModuleSelectionSha256:moduleSelectionSha256}}};
    }
    const batch = selection.slice(moduleOffset,moduleOffset+moduleBatchSize), results = new Array(batch.length), failures = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < batch.length && failures.length === 0) {
        const index = cursor++, {id,link} = batch[index];
        try {
          const detail = await this.modulePage(id), url = new URL(detail.url);
          if (url.origin !== link.url.origin || url.pathname !== link.url.pathname || url.searchParams.get('EspaceId') !== id)
            throw new ProtocolError('Module identity changed during application owner discovery');
          const owner = applicationOwner(detail);
          results[index] = {moduleId:id,moduleName:link.name,applicationId:owner?.url.searchParams.get('ApplicationId')??null,applicationName:owner?.name??null,source:detail.url};
        } catch (error) { failures.push({index,error}); }
      }
    };
    await Promise.all(Array.from({length:Math.min(ownerParallelism,batch.length)},worker));
    if (failures.length) throw failures.sort((a,b)=>a.index-b.index)[0].error;
    const applications = new Map();
    for (const row of results) if (row.applicationId !== null) {
      if (applications.has(row.applicationId) && applications.get(row.applicationId).name !== row.applicationName) throw new ProtocolError('Conflicting application owners');
      applications.set(row.applicationId,{id:row.applicationId,name:row.applicationName});
    }
    const unresolvedModules = results.filter(row=>row.applicationId===null).map(row=>({id:row.moduleId,name:row.moduleName}));
    const nextOffset = moduleOffset + batch.length;
    return {phase:'owner-details',rows:results,applications:[...applications.values()],unresolvedModules,moduleOffset,moduleBatchSize,ownerParallelism,
      moduleSelectionId,selectionCapturedAt:capture?.capturedAt??null,selectionSource:capture?'immutable-capture':'live-listing',
      modulesSelected:selection.length,moduleSelectionSha256,listingTruncated:modules.truncated,
      truncated:modules.truncated || unresolvedModules.length>0 || nextOffset<selection.length,
      scope:'applications-with-visible-modules',snapshotAtomic:false,observedAt:utc(),
      continuation:nextOffset<selection.length ? {tool:'o11_service_center_read',arguments:{action:'application-owners',host:this.vault.host,moduleLimit,maxPages,moduleOffset:nextOffset,moduleBatchSize,ownerParallelism,...(moduleSelectionId ? {moduleSelectionId} : {}),expectedModuleSelectionSha256:moduleSelectionSha256}} : null};
  }

  async applicationRelationships({ applicationId = null, application = null, applications = [], applicationSource = 'auto', applicationLimit = 20, moduleLimit = 20, limit = 100, maxPages = 20, includeSystem = false, applicationOffset = 0, applicationBatchSize = 3, expectedSelectionSha256 = null, ownerParallelism = 1 } = {}) {
    if (!Number.isInteger(ownerParallelism) || ownerParallelism < 1 || ownerParallelism > 8) throw new ProtocolError('ownerParallelism must be 1..8');
    if (!Number.isInteger(applicationOffset) || applicationOffset < 0 || !Number.isInteger(applicationBatchSize) || applicationBatchSize < 1 || applicationBatchSize > 20)
      throw new ProtocolError('applicationOffset must be nonnegative and applicationBatchSize 1..20');
    if (expectedSelectionSha256 !== null && !/^[a-f0-9]{64}$/.test(expectedSelectionSha256) || applicationOffset > 0 && expectedSelectionSha256 === null)
      throw new ProtocolError('Resuming application relationships requires the previous selection SHA256');
    if (!['auto','modules'].includes(applicationSource) || applicationId && applicationSource !== 'auto') throw new ProtocolError('applicationSource must be auto or modules; applicationId uses auto');
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new ProtocolError('maxPages must be between 1 and 100');
    if (!Number.isInteger(applicationLimit) || applicationLimit < 1 || applicationLimit > 2000 || !Number.isInteger(limit) || limit < 1 || limit > 5000)
      throw new ProtocolError('applicationLimit must be 1..2000 and limit 1..5000');
    if (application !== null && (typeof application !== 'string' || !application.trim())) throw new ProtocolError('application must be an exact name');
    if (!Array.isArray(applications) || applications.length > 100 || applications.some(n => typeof n !== 'string' || !n.trim())) throw new ProtocolError('applications must contain exact names');
    if (application && applications.length || applicationId && (application || applications.length)) throw new ProtocolError('Choose applicationId, application or applications');
    if (typeof includeSystem !== 'boolean') throw new ProtocolError('includeSystem must be boolean');
    if (!Number.isInteger(moduleLimit) || moduleLimit < 1 || moduleLimit > 2000) throw new ProtocolError('moduleLimit must be 1..2000');
    let selected, selectionTruncated = false, selectionSource = applicationId ? 'application-id' : 'applications-list';
    const unresolvedSelectionModules = [];
    if (applicationId) {
      if (!/^[1-9][0-9]*$/.test(String(applicationId))) throw new ProtocolError('applicationId must be numeric');
      selected = [{id:String(applicationId), name:null}];
    } else {
      const listing = applicationSource === 'modules' ? {rows:[],truncated:false} : await this.pages(await this.get('Applications_List.aspx'), applicationLimit, false, maxPages, null, applicationRows);
      const found = new Map();
      for (const row of listing.rows) for (const link of row.links) {
        const url = new URL(link.href, listing.source); if (!/\/Application_Edit\.aspx$/i.test(url.pathname) || !link.name) continue;
        const id = url.searchParams.get('ApplicationId');
        if (url.origin !== new URL(listing.source).origin || !/^[1-9][0-9]*$/.test(id ?? '')) throw new ProtocolError('Unverified application listing identity');
        if (found.has(id) && found.get(id).name !== link.name) throw new ProtocolError('Conflicting application names');
        found.set(id,{id,name:link.name});
      }
      selected = [...found.values()]; selectionTruncated = listing.truncated;
      const names = new Set((application ? [application] : applications).map(fold));
      if (!selectionTruncated && (!selected.length || names.size && !selected.some(a => names.has(fold(a.name))))) {
        const discovery = await this.applicationOwners({moduleLimit,maxPages,moduleBatchSize:moduleLimit,ownerParallelism});
        unresolvedSelectionModules.push(...discovery.unresolvedModules);
        selected = discovery.applications;
        selectionSource = 'module-detail-owners';
        selectionTruncated = discovery.truncated || selected.length > applicationLimit;
        selected = selected.slice(0,applicationLimit);
      }
      if (names.size) {
        if (selectionTruncated) throw new ProtocolError('Exact application selection requires a complete listing');
        selected = selected.filter(a => names.has(fold(a.name)));
        if (selected.length !== names.size) throw new ProtocolError('Application selection is absent or ambiguous');
      }
    }
    if (!includeSystem) selected = selected.filter(app => app.name === null || fold(app.name) !== 'system');
    const selectionSha256 = fingerprint({host:this.vault.host, selected, selectionSource, selectionTruncated, includeSystem});
    if (expectedSelectionSha256 !== null && expectedSelectionSha256 !== selectionSha256)
      throw new ProtocolError('Application selection changed; restart the read without combining different inventories', 'SC_SELECTION_CHANGED');
    if (applicationOffset > selected.length) throw new ProtocolError('Application offset exceeds the selected inventory');
    const batch = selected.slice(applicationOffset, applicationOffset + applicationBatchSize);
    const rows = [], scanned = []; let referencesTruncated = false;
    for (const app of batch) {
      if (rows.length >= limit) break;
      let page = await this.get(`Application_Edit.aspx?ApplicationId=${app.id}`);
      const applicationUrl = new URL(page.url);
      const title = heading(page);
      if (!title.startsWith('Application ') || app.name && title !== `Application ${app.name}`) throw new ProtocolError('Application detail identity changed');
      const name = title.slice('Application '.length);
      if (!includeSystem && fold(name) === 'system') {
        scanned.push({id:app.id,name,pagesRead:0,excluded:'system-filter'});
        continue;
      }
      page = await this.loadReadTab(page, 'Dependencies');
      const seen = new Map(), pageMarkers = new Set();
      let pagesRead = 0;
      for (let n = 0; n < maxPages; n++) {
        const currentUrl = new URL(page.url);
        if (currentUrl.origin !== applicationUrl.origin || currentUrl.pathname !== applicationUrl.pathname
          || currentUrl.searchParams.get('ApplicationId') !== app.id) throw new ProtocolError('Application pagination changed identity');
        const candidates = content(page).all('table').filter(t => /(?:^|_)wtListApplicationDependencies$/.test(t.attr('id','') ?? ''));
        const table = one(candidates, 'application dependencies table');
        if (!table.all('th').some(n => n.text === 'Name')) throw new ProtocolError('Application dependencies Name column missing');
        const panel = tabPanel(page, 'tab-Dependencies');
        if (panel && !panel.all('table').includes(table)) throw new ProtocolError('Application dependencies table is outside its tab');
        const parsedRows = tables(page, false, table), marker = fingerprint(parsedRows);
        if (pageMarkers.has(marker)) throw new ProtocolError('Application dependency pagination did not advance');
        pageMarkers.add(marker); pagesRead++;
        for (const row of parsedRows) {
          const producers = row.links.filter(l => l.name && /\/Application_Edit\.aspx$/i.test(new URL(l.href,page.url).pathname));
          if (!producers.length) throw new ProtocolError('Application dependency row has no verified producer');
          for (const producer of producers) {
            const url = new URL(producer.href,page.url), id = url.searchParams.get('ApplicationId');
            if (url.origin !== new URL(page.url).origin || !/^[1-9][0-9]*$/.test(id ?? '')) throw new ProtocolError('Unverified producer application');
            if (seen.has(id) && seen.get(id) !== producer.name) throw new ProtocolError('Producer application name changed during pagination');
            if (id === app.id || fold(producer.name) === fold(name) || !includeSystem && fold(producer.name) === 'system' || seen.has(id)) continue;
            seen.set(id,producer.name);rows.push({consumerApplication:name,consumerApplicationId:app.id,producerApplication:producer.name,producerApplicationId:id,referenceDetailUrl:url.href,sourceTable:'wtListApplicationDependencies'});
          }
        }
        const next = panel ? nextLink(page, panel) : null;
        if (!next || rows.length >= limit || n + 1 === maxPages) {
          referencesTruncated ||= Boolean(next) || !panel && nextLink(page) !== null;
          break;
        }
        page = await this.nextPage(page, next);
      }
      scanned.push({id:app.id,name,pagesRead});
    }
    const nextOffset = applicationOffset + scanned.length;
    const continuation = !referencesTruncated && rows.length <= limit && scanned.length > 0 && nextOffset < selected.length
      ? {tool:'o11_service_center_read',arguments:{action:'application-relationships',host:this.vault.host,
        ...(applicationId ? {applicationId} : application ? {application} : applications.length ? {applications} : {}),
        applicationSource,applicationLimit,moduleLimit,limit,maxPages,includeSystem,applicationBatchSize,ownerParallelism,
        applicationOffset:nextOffset,expectedSelectionSha256:selectionSha256}} : null;
    return {rows:rows.slice(0,limit),applicationsScanned:scanned,applicationsSelected:selected.length,selectionSource,
      applicationOffset,applicationBatchSize,selectionSha256,continuation,ownerParallelism,
      selectionScope:selectionSource==='module-detail-owners'?'applications-with-visible-modules':'application-inventory',unresolvedSelectionModules,selectionTruncated,referencesTruncated,
      truncated:selectionTruncated||referencesTruncated||rows.length>limit||nextOffset<selected.length,systemIncluded:includeSystem,
      direction:'consumer-to-producer',detailLevel:'application',readMode:'native-tab-event',observedAt:utc()};
  }

  async loadReadTab(page, name) {
    const panel = tabPanel(page, 'tab-'+name);
    if (!panel) throw new ProtocolError('Requested read tab is missing');
    const code = page.doc.all('script').map(n => n.children.filter(c => typeof c === 'string').join('')).join('\n');
    const bindings = [...code.matchAll(/\btabs\.init\('([A-Za-z0-9_]+)',\s*'([A-Za-z0-9_]+)'\);/g)]
      .filter(m => { for(let n=panel.parent;n;n=n.parent)if(n.attr('id')===m[1])return true;return false; });
    if (bindings.length !== 1 || bindings[0][2] !== bindings[0][1]+'_wtOnTabChange') throw new ProtocolError('Tab event binding is unverified');
    const event = bindings[0][2], blocks = page.doc.all('span').filter(n => n.attr('id')===event);
    const inputs = blocks.flatMap(n => n.all('input').filter(c => c.attr('data-p')==='1' && typeOf(c)==='hidden'));
    const buttons = blocks.flatMap(n => n.all('input').filter(c => c.attr('data-p')==='btn' && typeOf(c)==='submit'));
    if (blocks.length!==1 || inputs.length!==1 || buttons.length!==1 || !inputs[0].attr('name')
      || buttons[0].attr('id')!==event+'_wtTriggerEvent' || postbackTarget(buttons[0])?.kind!=='osajax'
      || postbackTarget(buttons[0])?.target!==buttons[0].attr('name')) throw new ProtocolError('Tab event controls are unverified');
    return this.click(page, buttons[0], {[inputs[0].attr('name')]:name}, true);
  }

  async applicationDependencyGraph({ application = null, applications = [], includeSystem = false, ...options } = {}) {
    if (application !== null && (typeof application !== 'string' || !application.trim())) throw new ProtocolError('application must be an exact nonempty name');
    if (!Array.isArray(applications) || applications.length > 100 || applications.some(a => typeof a !== 'string' || !a.trim())) throw new ProtocolError('applications must contain up to 100 exact nonempty names');
    if (application && applications.length) throw new ProtocolError('Choose application or applications, not both');
    const selectedApplications = [...new Set((application ? [application] : applications).map(fold))];
    if (typeof includeSystem !== 'boolean') throw new ProtocolError('includeSystem must be boolean');
    const result = await this.moduleDependencies(options);
    const edges = [], unresolvedDependencies = [], seen = new Set(), producerOwners = new Map();
    let intraApplicationReferences = 0, filteredReferences = 0;
    for (let row of result.rows) {
      if ((selectedApplications.length && row.consumerApplication && !selectedApplications.includes(fold(row.consumerApplication)))
        || (!includeSystem && fold(row.producerApplication ?? '') === 'system')) { filteredReferences++; continue; }
      if (!row.producerApplication && row.producerDetailUrl && row.consumerApplication) {
        const producerUrl = new URL(row.producerDetailUrl), referenceUrl = new URL(row.referenceDetailUrl);
        if (producerUrl.origin !== referenceUrl.origin || !/\/(?:eSpace|Extension)_Edit_Proxy\.aspx$/i.test(producerUrl.pathname)
          || producerUrl.searchParams.get('SSKey') !== row.producerKey) throw new ProtocolError('Unverified producer owner URL');
        if (!producerOwners.has(producerUrl.href)) {
          const producerPage = await this.get(producerUrl.href);
          if (new URL(producerPage.url).origin !== producerUrl.origin) throw new ProtocolError('Producer owner left the selected origin');
          producerOwners.set(producerUrl.href, applicationOwner(producerPage));
        }
        const producerOwner = producerOwners.get(producerUrl.href);
        if (producerOwner) row = { ...row, producerApplication: producerOwner.name,
          producerApplicationId: producerOwner.url.searchParams.get('ApplicationId'), producerOwnerSource: producerOwner.url.href };
      }
      if (!includeSystem && fold(row.producerApplication ?? '') === 'system') { filteredReferences++; continue; }
      if (!row.consumerApplication || !row.producerApplication) {
        unresolvedDependencies.push(row); continue;
      }
      if (fold(row.consumerApplication) === fold(row.producerApplication)) { intraApplicationReferences++; continue; }
      const key = JSON.stringify([row.consumerApplicationId, row.producerApplication, row.consumerKey, row.producerKey, row.referenceDetailUrl]);
      if (!seen.has(key)) { seen.add(key); edges.push(row); }
    }
    return { ...result, rows: edges, unresolvedDependencies, intraApplicationReferences,
      systemIncluded: includeSystem, applicationFilter: application, applicationsFilter: selectedApplications, filteredReferences,
      ownershipComplete: unresolvedDependencies.length === 0 };
  }

  async moduleReferences(moduleId, limit = 100, maxPages = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new ProtocolError('limit must be between 1 and 5000');
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new ProtocolError('maxPages must be between 1 and 100');
    let page = await this.modulePage(moduleId);
    const rows = [], seen = new Set();
    let consumerKey = null;
    for (let n = 0; n < maxPages; n++) {
      const parsed = this.moduleReferencePage(page, moduleId);
      const marker = fingerprint(parsed.rows);
      if (seen.has(marker)) throw new ProtocolError('Module reference pagination did not advance');
      seen.add(marker);
      for (const row of parsed.rows) {
        if (consumerKey && row.consumerKey !== consumerKey) throw new ProtocolError('Consumer identity changed during reference pagination');
        consumerKey = row.consumerKey;
      }
      rows.push(...parsed.rows);
      const { next, ...metadata } = parsed;
      if (!next || rows.length >= limit || n + 1 === maxPages) return { ...metadata, rows: rows.slice(0, limit),
        truncated: rows.length > limit || Boolean(next) || parsed.paginationUnverified, pagesRead: n + 1 };
      page = await this.nextPage(page, next);
    }
  }

  moduleReferencePage(page, moduleId) {
    const owner = applicationOwner(page);
    const candidates = content(page).all('table').filter(t => /(?:^|_)wtTableReferences$/.test(t.attr('id', '') ?? ''));
    if (candidates.length !== 1) throw new LayoutError(page.url, 'module references', 'Expected exactly one wtTableReferences table');
    const table = candidates[0];
    if (!table.all('th').some(t => t.text === 'Name')) throw new LayoutError(page.url, 'module references', 'Missing Name column');
    const rows = tables(page, false, table).map(row => {
      const links = row.links.map(link => ({ ...link, url: new URL(link.href, page.url) }));
      const details = links.filter(link => /\/eSpace_Reference_Show\.aspx$/i.test(link.url.pathname));
      const producers = links.filter(link => /\/(?:eSpace|Extension)_Edit_Proxy\.aspx$/i.test(link.url.pathname));
      const system = row.fields.Name === '(System)' || row.fields.Name === 'System';
      if (details.length !== 1 || producers.length !== (system ? 0 : 1))
        throw new ProtocolError('Unrecognized module reference row; refusing incomplete dependencies');
      const detail = details[0].url, producer = producers[0];
      const producerKey = detail.searchParams.get('ProducerKey'), consumerKey = detail.searchParams.get('ConsumerKey');
      if (detail.origin !== new URL(page.url).origin || detail.searchParams.get('ReturnToESpaceId') !== String(moduleId)
          || !producerKey || !consumerKey || (producer && (producer.url.origin !== detail.origin || producer.url.searchParams.get('SSKey') !== producerKey)))
        throw new ProtocolError('Module reference identity does not match the requested module', 'SC_RESOURCE_IDENTITY_UNVERIFIED');
      const name = system ? '(System)' : producer.name;
      const suffix = row.fields.Name?.slice(name.length).trim();
      return { consumerModuleId: String(moduleId), consumerKey, producerKey, producerName: name,
        consumerApplication: owner?.name ?? null, consumerApplicationId: owner?.url.searchParams.get('ApplicationId') ?? null,
        consumerOwnerSource: owner?.url.href ?? null,
        producerKind: system ? 'system' : /\/Extension_/i.test(producer.url.pathname) ? 'extension' : 'module',
        producerApplication: system ? 'System' : suffix?.startsWith('(') && suffix.endsWith(')') ? suffix.slice(1, -1) : null,
        producerDetailUrl: producer?.url.href ?? null, referenceDetailUrl: detail.href, sourceTable: 'wtTableReferences' };
    });
    if (new Set(rows.map(row => row.consumerKey)).size > 1) throw new ProtocolError('Conflicting consumer identities in reference table');
    let scope = table.parent;
    while (scope && !/(?:^|_)wtReferencesContainer$/.test(scope.attr('id', '') ?? '')) scope = scope.parent;
    if (scope && scope.all('table').filter(t => /(?:^|_)wtTableReferences$/.test(t.attr('id', '') ?? '')).length !== 1)
      throw new ProtocolError('Ambiguous reference pagination scope');
    // A pager outside the proven reference container belongs to another panel.
    // Older/unknown layouts retain the conservative incomplete-result marker.
    const next = scope ? nextLink(page, scope) : null;
    const paginationUnverified = !scope && nextLink(page) !== null;
    return { rows, next, direction: 'consumer-to-producer', paginationUnverified,
      paginationScope: scope ? 'wtReferencesContainer' : null, source: page.url, observedAt: utc() };
  }

  async modulePage(moduleId) {
    if (!/^[1-9][0-9]*$/.test(String(moduleId))) throw new ProtocolError('module-id must be the numeric ID from the live module listing');
    return this.get(`eSpace_Edit.aspx?EspaceId=${moduleId}`);
  }

  // [page, panel] of a module tab: the inline div[data-tab] panel of the modern page, or (on older pages) the page its
  // tab link leads to, with panel null.
  async resourcePage(moduleId, resource) {
    if (!Object.hasOwn(TABS, resource)) throw new ProtocolError('Unknown module resource');
    const [tab, names] = TABS[resource];
    let page = await this.modulePage(moduleId);
    let panel = tabPanel(page, tab);
    if (panel) {
      if (resource === 'site-properties' && /^Loading Site Properties$/i.test(strip(panel.text))) {
        // Current Tabs calls TriggerEvents(changeId, 'SiteProperties'); that
        // helper sets data-p=1 and clicks its data-p=btn control. Bind both IDs
        // to this panel's ancestor and the declarations in the current page.
        const code = page.doc.all('script').map(n => n.children.filter(c => typeof c === 'string').join('')).join('\n');
        const bindings = [...code.matchAll(/\btabs\.init\('([A-Za-z0-9_]+)',\s*'([A-Za-z0-9_]+)'\);/g)]
          .filter(m => { for (let n=panel.parent;n;n=n.parent) if (n.attr('id')===m[1]) return true; return false; });
        if (bindings.length !== 1 || bindings[0][2] !== bindings[0][1] + '_wtOnTabChange')
          throw new LayoutError(page.url, 'Site properties tab', 'no unique declared headless tab event');
        const changeId = bindings[0][2];
        const blocks = page.doc.all('span').filter(n => n.attr('id') === changeId);
        const inputs = blocks.flatMap(n => n.all('input').filter(c => c.attr('data-p') === '1' && typeOf(c) === 'hidden'));
        const triggers = blocks.flatMap(n => n.all('input').filter(c => c.attr('data-p') === 'btn' && typeOf(c) === 'submit'));
        if (blocks.length !== 1 || inputs.length !== 1 || triggers.length !== 1
            || triggers[0].attr('id') !== changeId + '_wtTriggerEvent'
            || postbackTarget(triggers[0])?.kind !== 'osajax'
            || postbackTarget(triggers[0])?.target !== triggers[0].attr('name') || !inputs[0].attr('name'))
          throw new LayoutError(page.url, 'Site properties tab', 'tab event controls do not match their declaration');
        page = await this.click(page, triggers[0], { [inputs[0].attr('name')]: 'SiteProperties' });
        panel = tabPanel(page, tab);
        if (panel && /^Loading Site Properties$/i.test(strip(panel.text)))
          throw new LayoutError(page.url, 'Site properties tab', 'tab event did not return its listing');
      }
      return [page, panel];
    }
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
    // A persisted empty timer filter removes the table (including its headers)
    // from the next GET. Accept only the native empty-list container observed live.
    if (kind === 'timer' && headers.length === 0 && /\/Cyclic_Job_Logs\.aspx$/i.test(new URL(page.url).pathname)
        && heading(page) === 'Timer Log') {
      const empty = content(page).all('span','div').filter(n => /(?:^|_)wtContentMain_wtList$/.test(n.attr('id','') ?? ''));
      if (empty.length === 1 && /^No Logs to show$/i.test(empty[0].text.trim())) return;
    }
    const missing = ASSUMED_LOGS[kind].filter(c => !headers.some(h => h.includes(c)));
    if (missing.length) throw new LayoutError(page.url, `The ${kind} log page`, 'no listing with the columns ' + missing.join(', '));
  }

  async logs(kind = 'error', limit = 100, filters = null, { stackContains = null, exportAll = false, maxPages = 20 } = {}) {
    if (!Object.hasOwn(LOG_PAGES, kind)) throw new ProtocolError('Unknown log kind');
    if (exportAll && !EXPORTABLE.includes(kind)) throw new ProtocolError('Service Center exports error and integration logs only');
    filters = filters ?? {};
    for (const key of Object.keys(filters)) {
      if (!LOG_KIND_FILTERS[kind].includes(key)) throw new ProtocolError(`Unsupported ${kind} log filter: ${key}`, 'SC_LOG_FILTER_UNSUPPORTED');
    }
    if (stackContains !== null && stackContains !== undefined && (kind !== 'error' || Object.hasOwn(filters, 'message'))) {
      throw new ProtocolError('stackContains requires error logs and replaces the message filter', 'SC_LOG_FILTER_UNSUPPORTED');
    }
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
    let result;
    if (exportAll) {
      try { result = await this.exportLogs(kind, original, page, updates, limit); }
      catch (error) {
        if (error.code !== 'SC_EXPORT_UNAVAILABLE') throw error;
        result = { ...await this.pages(page, limit, false, maxPages), export: { available: false, code: error.code },
          note: 'This page has no supported Excel export control. Returned rows use its normal pagination; no export file was produced.' };
      }
    } else result = await this.pages(page, limit, false, maxPages);
    // A successful empty page is scoped evidence, not proof that the application has no errors.
    const effectiveFilters = {};
    const observedLabels = entries(labels(original, content(original)));
    for (const key of LOG_KIND_FILTERS[kind]) {
      const [names, suffixes] = LOG_FILTERS[key];
      const found = observedLabels.filter(({ name, label }) => names.includes(label) || suffixes.some(s => name.endsWith(s)));
      if (found.length === 1) effectiveFilters[key] = key === 'message' && hasStack ? stackContains
        : Object.hasOwn(filters, key) ? filters[key] : controlValue(found[0].n);
    }
    return Object.assign(result, { kind, filters, effectiveFilters, complete: result.truncated !== true,
      ...(result.rows?.length === 0 ? { emptyScope: 'No matching rows in the displayed filters; this does not prove absence outside that scope.' } : {}),
      timezone: 'Service Center display timezone', ...(hasStack ? { stackContains } : {}) });
  }

  async exportLogs(kind, original, page, updates, limit) {
    if (this.exports === null) throw new ProtocolError('Exports need a local export folder');
    let body;
    const exportControl = source => {
      try { return button(source, ['Export to excel']); }
      catch (error) { if (!(error instanceof ProtocolError)) throw error;
        throw new BridgeError('SC_EXPORT_UNAVAILABLE', 'The page has no unambiguous supported Excel export control.'); }
    };
    try { body = await this.http.export(page, exportControl(page)); }
    catch (error) {
      if ((!(error instanceof ProtocolError) && error.code !== 'SC_EXPORT_UNAVAILABLE') || page === original) throw error;
      // An AJAX Filter answers with a fragment that carries only the refreshed form state: export from the original
      // form with that state, never reading a missing Export control as zero rows.
      const control = exportControl(original);
      const state = Object.fromEntries(page.doc.all('input').filter(n => STATE.test(n.attr('name', '') ?? '')).map(n => [n.attr('name'), controlValue(n)]));
      if (!Object.keys(state).length) throw new ProtocolError('The filtered page has neither the Export control nor refreshed form state');
      body = await this.http.export(original, control, { ...updates, ...state });
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

  async integrationLogDetail({ requestKey, action, moduleId = null }) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey ?? '') || typeof action !== 'string' || !action.trim() || action.length > 200
        || /[\r\n]/.test(action) || moduleId !== null && !/^[1-9][0-9]*$/.test(String(moduleId)))
      throw new ProtocolError('integration-log-detail requires requestKey, exact logAction and an optional numeric moduleId.');
    let event = { requestKey, action, ...(moduleId !== null ? { moduleId: String(moduleId) } : {}) };
    try {
      const trace = await this.trace(requestKey, 5000);
      if (!trace.logs.complete) return payloadFailure('SC_INTEGRATION_EVENT_INCOMPLETE', 'incomplete-list', event, 'The request-event listing is incomplete.');
      const events = trace.logs.rows.filter(r => r.fields.Element === action && /^(REST|SOAP) \((Consume|Expose)\)$/.test(r.fields['Event Type'])
        && (moduleId === null || !r.links.length || r.links.some(l => new URL(l.href, trace.logs.source).searchParams.get('EspaceId') === String(moduleId))));
      if (!events.length) return payloadFailure('SC_INTEGRATION_EVENT_NOT_FOUND', 'event-not-found', event, 'The request log contains no matching integration action.');
      const instant = events.map(r => r.fields['Time of Event']).sort().at(-1);
      const filters = { application: '__ossli_all', module: '__ossli_all', type: '__ossli_all', server: '', action, since: instant, until: instant };
      const listing = await this.logs('integration', 5000, filters, { exportAll: true });
      if (!listing.export?.file || listing.truncated) return payloadFailure('SC_INTEGRATION_EVENT_INCOMPLETE', 'incomplete-list', event,
        'The complete native export is required to bind this row to the request key.');
      const selected = selectIntegrationRecord(listing.rows, { requestKey, action, moduleId, instant });
      if (selected.ok === false) return selected;
      event = selected;
      // Session filters are mutable. Reapply every selector immediately before
      // reading the native row; never trust a prior call's persisted filter.
      const original = await this.get(LOG_PAGES.integration);
      const [filter, updates] = this.logFilters('integration', original, filters);
      const page = await this.click(original, filter, updates);
      const matched = exactIntegrationRow(page, event);
      if (matched.ok === false) return matched;
      const control = integrationPayloadControl(page, matched.row, event);
      if (control.ok === false) return control;
      return { ...integrationPayloadPage(await this.get(control.url), event), observedAt: utc() };
    } catch (error) {
      if (error.code === 'SC_PERMISSION_DENIED') return payloadFailure('SC_PERMISSION_DENIED', 'permission-denied', event,
        'The authenticated principal was denied access to the native resource. No permissions or identity were changed.');
      throw error;
    }
  }

  async errorDetail(errorId) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(errorId)) throw new ProtocolError('Invalid error ID');
    const page = await this.get('Show_Error.aspx?Error_Id=' + errorId);
    if (fold(heading(page)) === 'permission denied')
      throw new ProtocolError('Service Center denied access to this error detail; no permissions were changed.', 'SC_PERMISSION_DENIED');
    // Visible diagnostics of the page content, never the sidebar, cookies, hidden form state, input values or scripts.
    let root = content(page);
    if (root === page.doc.root) root = page.doc.first('main') ?? page.doc.first('body') ?? page.doc.root;
    else if (!root.all('pre').length && !fold(heading(page)).includes('error')) throw new LayoutError(page.url, 'The error detail page', 'no stack block and no error heading');
    for (const node of root.all('div')) if (privateDiagnosticValue(node)) node.children = ['[redacted]'];
    const text = redactText(splitlines(root.readable).filter(line => strip(line)).map(rstrip).join('\n'));
    return { errorId, detail: text.slice(0, 64000), truncated: text.length > 64000, source: page.url, observedAt: utc() };
  }

  async trace(requestKey, limit = 100, maxPages = 20) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestKey)) throw new ProtocolError('Invalid request/correlation key');
    // The SC request log binds RequestKey server-side. Searching error messages
    // for the key misses events whose message does not include that identifier.
    let page = await this.get('GroupedRequest_Logs.aspx?RequestKey=' + requestKey);
    await assumed(page, 'The request log page', () => {
      const url = new URL(page.url);
      if (!url.pathname.endsWith('/GroupedRequest_Logs.aspx') || url.searchParams.get('RequestKey') !== requestKey
          || fold(heading(page)) !== 'request log') throw new ProtocolError('request scope or heading does not match');
    });
    if (/\bLoading records\b/i.test(content(page).text)) {
      const loader = await assumed(page, 'The request log loader', () => {
        const control = one(content(page).all('input').filter(n => typeOf(n) === 'submit' && !n.has('disabled')
          && n.attr('name', '').endsWith('$wtGetRecordsButton')), 'Get Records control');
        const event = postbackTarget(control);
        if (event?.kind !== 'osajax' || event.target !== control.attr('name')
            || control.attr('id') !== control.attr('name').replaceAll('$', '_'))
          throw new ProtocolError('loader does not match its declared read event');
        return control;
      });
      page = await this.click(page, loader);
    }
    await assumed(page, 'The request log listing', () => {
      const matching = content(page).all('table').filter(t => {
        const headers = t.all('th').map(n => fold(n.text));
        return ['time of event', 'event type', 'module / extension', 'element', 'message'].every(h => headers.includes(h));
      });
      if (/\bLoading records\b/i.test(content(page).text) || matching.length !== 1)
        throw new ProtocolError('no unique loaded request-event listing');
    });
    const logs = await this.pages(page, limit, false, maxPages);
      // The current grouped-request page silently caps its table at 50 events
      // and exposes no pager. Its own export includes the remaining events.
      if (logs.rows.length >= 50 && !logs.paginationUnsupported) {
        try {
          const bytes = await this.http.export(page, button(page, ['Export to excel']));
          const [header, ...records] = xlsxRows(bytes);
          const expected = ['Id', 'Instant', 'Type', 'Application Name', 'Module Name', 'Element Name', 'Message'];
          if (JSON.stringify(header) !== JSON.stringify(expected) || records.length < logs.rows.length)
            throw new ProtocolError('Request export schema or count does not match the loaded listing');
          const rows = records.map(r => ({ fields: {
            'Time of Event': excelTime(r[1] ?? ''), 'Event Type': r[2] ?? '',
            'Module / Extension': `${r[4] ?? ''}${r[3] ? ' (' + r[3] + ')' : ''}`,
            Element: r[5] ?? '', Message: r[6] ?? '', 'Event Id': r[0] ?? ''
          }, links: [] }));
          const identity = row => JSON.stringify(['Time of Event', 'Event Type', 'Module / Extension', 'Element', 'Message'].map(k => fold(row.fields[k] ?? '')));
          const counts = new Map();
          for (const row of rows) counts.set(identity(row), (counts.get(identity(row)) ?? 0) + 1);
          for (const row of logs.rows) {
            const key = identity(row), count = counts.get(key) ?? 0;
            if (!count) throw new ProtocolError('Request export does not contain the displayed events with their multiplicity');
            counts.set(key, count - 1);
          }
          Object.assign(logs, { rows: rows.slice(0, limit), rowCount: rows.length, truncated: rows.length > limit,
            sourceKind: 'request-bound-xlsx', displayLimit: 50,
            ...(this.exports !== null ? { export: this.save('request-log', 'xlsx', bytes) } : {}) });
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          Object.assign(logs, { truncated: true, displayLimit: 50, completenessUnknown: true,
            exportError: { code: error.code, message: error.message.slice(0, 500) } });
        }
      }
    logs.complete = !logs.truncated;
    return { requestKey, kind: 'log-correlation', correlation: 'Service Center RequestKey', logs,
      note: 'Events grouped by the Service Center request key; not a distributed span tree or proof of user-context propagation.' };
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
      ...(this.http.privateSessionObservation ? {privateSessionObservation:this.http.privateSessionObservation} : {}),
      observedAt: utc(), note: 'Names and captions only; the saved markup has no input values. Hand it over to calibrate the parser.' };
  }

  // ---- site properties and timers
  valueField(action, page, form = null) {
    const forms = form ? [form] : page.doc.all('form');
    const candidates = forms.flatMap(f => entries(labels(page, f))).filter(({ name, label, n }) =>
      !n.has('readonly') && (['value', 'valor', 'effective value'].includes(label)
        || /(?:Input_?Value|PropertyValue|SiteProperty_Value)$/i.test(name))).map(e => e.n);
    if (candidates.length !== 1) throw new ProtocolError('Could not identify one site-property value field');
    return candidates[0];
  }

  scheduleControls(page, form) {
    const native = nativeScheduleControls(page, form);
    if (native) return native;
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
    if (controlsByKey.at?.attr('name')?.endsWith('$wtInputTimerTimes')) return nativeScheduleRequest(controlsByKey, value);
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
    if (secret) result.configured = secretPresence(field);
    if (reveal && !secret) Object.assign(result, { value: observedValue(field), revealed: true });
    return result;
  }

  async verify(receipt, journal, value = null) {
    const result = await this.verifyState(receipt, journal, value);
    return receipt.identity?.action === 'timer-run' ? timerRunOutcome(result) : result;
  }

  async verifyState(receipt, journal, value = null) {
    const identity = receipt.identity;
    if (identity.host !== this.vault.host) throw new ProtocolError('Receipt belongs to another host');
    const action = identity.action;
    let confirmed;
    if (action === 'db-connection-test' && receipt.responseEvidence) {
      const evidence=receipt.responseEvidence, root=path.resolve(this.exports ?? ''), file=path.resolve(evidence.file ?? '');
      if (!this.exports || !path.basename(file).startsWith('db-test-reply-')
        || path.dirname(file).toLowerCase() !== root.toLowerCase() || evidence.size > 8 * 1024 * 1024)
        throw new ProtocolError('Invalid private connection-test evidence location');
      const body=fs.readFileSync(file);
      if (body.length !== evidence.size || sha256(body) !== evidence.sha256) throw new ProtocolError('Connection-test evidence changed');
      const text=body.toString('utf8'), outcome=connectionTestOutcome(new Page(receipt.plan.target,
        new Document(/<form\b/i.test(text) ? text : ajaxMarkup(text).join(''))));
      if (!outcome) return {...receipt,replayed:false,observedDesiredState:false};
      Object.assign(receipt,outcome,{responseVerification:'original-reply-sha256',replayed:false});
      delete receipt.code; delete receipt.error;
      journal.reconcile(receipt);
      return {...receipt,observedDesiredState:true,replayed:false};
    }
    if (Object.hasOwn(WEB_WRITES, action)) confirmed = await this.observe(action, identity, receipt.plan ?? null);
    else if (action === 'timer-run') {
      // A receipt without the SC line's complete pre-send log baseline (every receipt written before it) resolves by the
      // timer's real state (P6, resolveTimerRun); one with the baseline records the log observation, never a replay.
      if (!receipt.plan?.timerLogBaseline?.available) return this.resolveTimerRun(receipt, journal);
      const after = timerLogSnapshot(await this.logs('timer', 1000, { timer: identity.name }), identity, receipt.plan.target);
      const comparison = compareTimerLogs(receipt.plan.timerLogBaseline, after);
      const errors = await observeTimerErrors(comparison, identity, id => this.errorDetail(id));
      const observation = { ...comparison, ...errors };
      const persisted = journal.recordTimerObservation(receipt, observation);
      if (comparison.executionObserved === true && UNSURE.includes(receipt.state) && journal.rawState(receipt.operationId) !== 'sending')
        journal.resolve(receipt, 'confirmed', 'A new execution of this exact timer was observed after the baseline; the triggering writer is not identified.',
          { observed: { newRuns: comparison.newRuns } });
      return { ...receipt, ...observation, timerObservation: persisted, replayed: false };
    }
    else if (action === 'timer-schedule') {
      const requested = receipt.plan?.schedule;
      if (!requested || !Object.keys(requested).length) throw new ProtocolError('This receipt keeps no requested schedule to compare');
      const [, , , schedule] = await this.prepare(action, identity.moduleId, identity.name);
      confirmed = Object.entries(requested).every(([k, v]) => fold(shown(schedule[k])) === fold(v));
    } else if (action === 'property-set') {
      if (receipt.plan?.secret === true && value === null) {
        const fresh = await this.propertyValue(identity.moduleId, identity.name);
        receipt.secretValuePresent = fresh.configured;
        receipt.valueVerified = false;
        if (fresh.configured === true && receipt.state === 'accepted-unverified') journal.acceptMaskedSecret(receipt);
        return { ...receipt, observedDesiredState: null, verificationScope: 'masked-presence-only', replayed: false };
      }
      if (value === null || value === undefined) throw new ProtocolError('Verification requires the expected value (--value-file); a vault value is never read back');
      const [, , , field] = await this.prepare(action, identity.moduleId, identity.name);
      confirmed = typeOf(field) !== 'password' && observedValue(field) === expectedValue(field, value);
    } else {
      const fresh = await this.detail(identity.moduleId, 'timers', identity.name);
      const expected = ACTIONS[action === 'timer-activate' ? 'timer-deactivate' : 'timer-activate'];
      try { button(fresh, expected); confirmed = true; } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        confirmed = false;
        // A completed synchronous toggle can be reconciled from the exact opposite state. Never release an in-flight send.
        const opposite = ACTIONS[action];
        if (opposite && receipt.cause === 'Expected one available control: ' + expected.join('/')) {
          button(fresh, opposite);
          if (journal.rawState(receipt.operationId) !== 'sending' && UNSURE.includes(receipt.state)) {
            journal.resolve(receipt, 'not-executed', 'The completed toggle did not establish its desired state; the opposite action is still available',
              { observed: { availableAction: opposite[0] } });
          }
        }
      }
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
    if (!UNSURE.includes(receipt.state) && receipt.state !== 'accepted') return out({ verification: `This receipt is ${receipt.state}; nothing to resolve` });
    const listing = await this.resourceListing(moduleId, 'timers');
    const names = listing.rows.flatMap(r => r.links).map(a => a.name);
    const count = names.filter(n => n === name).length;
    if (count === 0 && !listing.truncated && UNSURE.includes(receipt.state)) {
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
      const resolved = UNSURE.includes(receipt.state) ? journal.resolve(receipt, 'confirmed', `Last Run of ${name} moved from ${repr(before ?? 'never')} to ${repr(lastRun)} after the attempt`, { observed }) : receipt;
      return out({ ...resolved, observed, observedDesiredState: true, executionObserved: true, attributedToRequest: false, executionCompleted: null });
    }
    const unchanged = before !== undefined ? fold(lastRun) === fold(strip(before ?? '')) : NEVER.test(lastRun);
    if (unchanged && !running && age >= TIMER_RUN_GRACE_MS && UNSURE.includes(receipt.state)) {
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
    if (action === 'timer-activate') {
      const native = nativeScheduleControls(page, form);
      const at = native ? shown(native.at).trim() : null;
      if (at && at.split(/\s+/).some(time => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
        const module = timerFields(page).module ?? '<module>';
        throw new BridgeError('TIMER_SCHEDULE_INVALID', `The native schedule of ${name} contains invalid times; activation would report success without scheduling it. Nothing was sent.`, {
          executed: false, timer: name, currentSchedule: { at, recurrence: shown(native.recurrence) },
          continuation: { tool: 'ssam_map', arguments: { lane: 'o11', target: module, view: 'ddl', element: name },
            why: 'Correct the timer Schedule to native HH:mm times in the module and publish before activating it.' },
        });
      }
    }
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
      + "connected Studio's headless HTTP transport, which reads it from the vault inside the Studio; this path never holds it. Attach and "
      + 'connect the Studio (ssam_connect lane o11), or set it in Service Center yourself.', { continuation: connectStudio('secret values travel only through the connected Studio') });
  }

  // value: the new non-secret value (property-set) or the schedule {recurrence, at, every, timeout} (timer-schedule).
  // secret: the SiteProperty vault target of a secret value, filled inside the Studio.
  async mutate(action, moduleId, name, { value = null, secret = null, execute = false, words: userWords = null, operationId = null, journal = null } = {}) {
    const identity = { host: this.vault.host, action, moduleId: String(moduleId), name };
    if (execute) {
      if (!wordsGiven(userWords) || !strip(userWords) || !operationId || !journal) throw new ProtocolError("Execution requires the user's words, operation-id and a durable journal"); // CX15 r7
      const existing = journal.lookup(operationId, identity);
      if (existing) {
        if (action === 'timer-run') return journal.rawState(operationId) === 'sending'
          ? timerRunOutcome({ ...existing, existingReceipt: true, readback: { status: 'sender-active' } })
          : { ...await this.verify(existing, journal), existingReceipt: true };
        return { ...existing, replayed: false, existingReceipt: true };
      }
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
    const ajaxRun = action === 'timer-run' ? this.http.timerRunPost(page, click, updates)
      : action === 'property-set' ? this.http.scriptedAjaxPost(page, click, updates, secrets, { clientValidation: true }) : null;
    if (!ajaxRun) this.http.formPost(page, click, updates); // reject unsupported scripts before reserving
    if (action === 'timer-run') {
      const targetCheck = timerLogSnapshot({ complete: true, rows: [] }, identity, plan.target);
      try { plan.timerLogBaseline = targetCheck.available
        ? timerLogSnapshot(await this.logs('timer', 1000, { timer: name }), identity, plan.target) : targetCheck; }
      catch (error) { plan.timerLogBaseline = { available: false, reason: error.code ?? 'log-read-failed' }; }
    }
    const result = await journal.reserve(operationId, identity, userWords, plan, null, async receipt => {
      let tracker = {};
      // Plans carry no secret; the receipt keeps the one it executed so a later verify knows what to expect.
      receipt.plan = plan;
      try {
        // The durable 'sending' receipt exists BEFORE the request. Any interruption stays uncertain.
        let response;
        await this.http.authorizing(receipt.operationId, receipt.authorization.wordsSha256, async t => {
          tracker = t;
          if (ajaxRun) {
            const [url, body] = await this.http.reply(ajaxRun[0], ajaxRun[1], true, ajaxRun[2] ?? null);
            const fullForm = /<form\b/i.test(body);
            if (action === 'timer-run') receipt.schedulerResponse = {
              received: true, bytes: Buffer.byteLength(body, 'utf8'), sha256: sha256(body),
              representation: fullForm ? 'html-form' : 'ajax-fragments',
              schedulingAcknowledged: false,
            };
            const markup = fullForm ? body : ajaxMarkup(body).join('');
            if (receipt.schedulerResponse) Object.assign(receipt.schedulerResponse, {
              markupBytes: Buffer.byteLength(markup, 'utf8'), markupSha256: sha256(markup),
            });
            response = checked(new Page(url, new Document(markup)));
          } else response = checked(secrets ? await this.http.submit(page, click, updates, secrets) : await this.http.submit(page, click, updates));
        });
        if (action === 'property-set') {
          const [, , , fresh] = await this.prepare(action, moduleId, name);
          if (secrets || typeOf(fresh) === 'password') {
            // A vault value is never known here, so it is never compared.
            receipt.secretValuePresent = secretPresence(fresh);
            receipt.state = receipt.secretValuePresent === true || acknowledged(response, 'saved|updated|applied|changed') ? 'accepted' : 'accepted-unverified';
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
          const schedulingAcknowledged = acknowledged(response, 'timer|schedul|queued|execut');
          if (receipt.schedulerResponse) receipt.schedulerResponse.schedulingAcknowledged = schedulingAcknowledged;
          receipt.state = schedulingAcknowledged ? 'accepted' : 'accepted-unverified';
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
    if (action !== 'timer-run') return result;
    if (['accepted', 'accepted-unverified', 'uncertain'].includes(result.state)) {
      try { return await this.verify(result, journal); }
      catch (error) { return timerRunOutcome({ ...result, readback: { status: 'unavailable', code: error.code ?? 'READBACK_FAILED' } }); }
    }
    return timerRunOutcome(result);
  }

  // ---- BPT (Monitoring > Processes)
  async bptProcesses(module = null, process = null, limit = 100, maxPages = 20) {
    let page = await this.get('Process_Monitoring.aspx?Index=0');
    if (module !== null || process !== null) {
      const click = button(page, ['Filter', 'Search']);
      const fields = entries(formLabels(page, click.ancestor('form'))); const updates = {};
      if (module !== null) {
        const select = one(fields.filter(({ name, label, n }) => n.tag === 'select' && (/Espace_Selector$/i.test(name) || ['module', 'espace'].includes(label))).map(e => e.n), 'module filter');
        updates[select.attr('name')] = one(select.all('option').filter(o => o.text === module).map(optionValue), 'module option');
      }
      if (process !== null) {
        const box = one(fields.filter(({ name, label, n }) => n.tag === 'input' && (['name', 'process', 'process name'].includes(label) || /Process/i.test(name))).map(e => e.n), 'process filter');
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
    const detail = summary(page);
    const counters = ['Active Instances', 'Active Instances with Errors', 'Suspended Instances', 'Closed Instances'];
    if (!detail.Label || !detail.Status || counters.some(key => !/^[0-9]+$/.test(detail[key] ?? '')))
      throw new ProtocolError('The BPT process page did not return its detail summary; no unrelated process listing returned', 'SC_RESOURCE_IDENTITY_UNVERIFIED');
    const instances = await this.pages(page, limit, false, maxPages);
    if (instances.rows.some(row => !/^[1-9][0-9]*$/.test(row.fields?.['Instance Id'] ?? '')
        || !row.links.some(link => link.href.includes('Process_Instance_Detail.aspx')
          && parseQs(urlsplit(link.href).query).ProcessId?.[0] === row.fields['Instance Id'])))
      throw new ProtocolError('The BPT instance listing did not match its instance-ID contract; no rows returned', 'SC_RESOURCE_IDENTITY_UNVERIFIED');
    return { processKey, moduleKey, summary: detail, instances };
  }

  async bptInstance(processId, limit = 100, maxPages = 20) {
    if (!/^[1-9][0-9]*$/.test(String(processId))) throw new ProtocolError('processId must be the numeric instance ID');
    const page = await this.get(`Process_Instance_Detail.aspx?ProcessId=${processId}`);
    const identity = bptDetailIdentity(page, 'process', processId);
    const listing = await this.pages(page, limit, false, maxPages,
      current => bptDetailIdentity(current, 'process', processId));
    const activities = listing.rows.flatMap(r => r.links.slice(0, 1).filter(l => l.href.includes('Process_Activity_Detail.aspx'))
      .map(l => ({ ...r, activityId: parseQs(urlsplit(l.href).query).ActivityId?.[0] ?? '' })));
    if (activities.length !== listing.rows.length || activities.some(a => !/^[1-9][0-9]*$/.test(a.activityId)))
      throw new ProtocolError('The BPT activities did not match their activity-ID contract', 'SC_RESOURCE_IDENTITY_UNVERIFIED');
    const { rows, ...pagination } = listing;
    return { processId: String(processId), title: identity.title, summary: identity.detail, activities, ...pagination };
  }

  async bptActivity(activityId) {
    if (!/^[1-9][0-9]*$/.test(String(activityId))) throw new ProtocolError('activityId must be the numeric activity ID');
    const page = await this.get(`Process_Activity_Detail.aspx?ActivityId=${activityId}`);
    const identity = bptDetailIdentity(page, 'activity', activityId);
    return { activityId: String(activityId), title: identity.title, summary: identity.detail, source: page.url, observedAt: utc() };
  }

  // ---- integrations (module detail) and their logging level
  async integrations(moduleId) {
    let page = await this.modulePage(moduleId);
    // Current SC calls this WebServices; historical pages use Integrations.
    // Resolve the panel before reading links so another tab cannot supply them.
    const panels = ['tab-WebServices', TABS.integrations[0]].map(tab => ({ tab, panel: tabPanel(page, tab) })).filter(x => x.panel);
    if (panels.length > 1) throw new LayoutError(page.url, 'Integrations', 'multiple supported integration panels');
    const panel = panels[0]?.panel ?? null;
    if (!panel && content(page).all('div').some(n => n.attr('data-tab')))
      throw new LayoutError(page.url, 'Integrations', 'the module tabs have no recognized integration panel');
    if (panel && /^Loading\b/i.test(strip(panel.text)))
      throw new LayoutError(page.url, 'Integrations', 'the integration panel has not loaded');
    let found = this.integrationLinks(page, panel);
    if (!found.length && !panel) {
      const tabs = content(page).all('a').filter(a => fold(a.text) === 'integrations');
      if (tabs.length === 1) { page = await this.follow(page, tabs[0]); found = this.integrationLinks(page); }
      if (!found.length) throw new LayoutError(page.url, 'Integrations', 'no recognized integration listing; refusing an unverified empty result');
    }
    return { moduleId: String(moduleId), integrations: found, ...(panel ? { tab: panels[0].tab } : {}),
      ...(!found.length ? { emptyScope: 'No configurable SOAP/REST integration links in the observed module panel; this does not prove that the module makes no integration calls.' } : {}),
      source: page.url, observedAt: utc() };
  }

  integrationLinks(page, root = null) {
    const found = []; const seen = new Set();
    for (const a of (root ?? content(page)).all('a')) {
      const href = a.attr('href', '') ?? '';
      if (!a.text || inside(a, /RecentItems|sc-content-left/i)) continue;
      if (a.attr('data-name') === 'webservices_exposedwebservice'
          && /(?:^|_)wtListWebService$/.test(a.ancestor('table')?.attr('id', '') ?? '')) {
        const headers = a.ancestor('table').all('th').map(h => fold(h.text));
        if (JSON.stringify(headers) !== JSON.stringify(['name', 'internal access', 'http security', 'integrated authentication']))
          throw new LayoutError(page.url, 'Exposed SOAP', 'unrecognized runtime-only service table');
        let runtime;
        try { runtime = new URL(href, page.url); } catch { throw new ProtocolError('Invalid exposed SOAP runtime URL'); }
        if (runtime.origin !== new URL(page.url).origin || runtime.username || runtime.password || runtime.search || runtime.hash
            || !runtime.pathname.toLowerCase().endsWith('.asmx')) throw new ProtocolError('Invalid exposed SOAP runtime URL');
        const key = 'exposed-soap\n' + runtime.href;
        if (!seen.has(key)) {
          seen.add(key);
          found.push({kind:'exposed-soap', id:null, name:a.text, runtimeUrl:runtime.href,
            configurationAvailable:false, loggingAvailable:false, configurationSource:page.url});
        }
        continue;
      }
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

  async integrationPage(moduleId, name, kind = null, allowRuntimeOnly = false) {
    const matches = (await this.integrations(moduleId)).integrations.filter(i => i.name === name && (kind === null || kind === undefined || i.kind === kind));
    const target = one(matches, `integration named ${repr(name)} in module ${moduleId}`);
    if (target.configurationAvailable === false) {
      if (allowRuntimeOnly) return [target, null, null];
      throw new ProtocolError('This exposed SOAP service has a runtime link only; the observed Service Center table offers no logging configuration');
    }
    const page = await this.get(target.href);
    const combo = one(entries(labels(page, content(page))).filter(({ name: n, label, n: c }) => c.tag === 'select'
      && (/HttpTracingCombo|Logging/i.test(n) || ['logging level', 'log level', 'logging'].includes(label))).map(e => e.n), 'logging-level selector');
    return [target, page, combo];
  }

  async integrationDetail(moduleId, name, kind = null) {
    const [target, page, combo] = await this.integrationPage(moduleId, name, kind, true);
    if (!page) return {moduleId:String(moduleId), integration:target.name, kind:target.kind, integrationId:null,
      currentLevel:null, availableLevels:[], configurationAvailable:false, loggingAvailable:false,
      runtimeUrl:target.runtimeUrl, source:target.configurationSource, observedAt:utc()};
    return { moduleId: String(moduleId), integration: target.name, kind: target.kind, integrationId: target.id,
      currentLevel: selectedText(combo), availableLevels: combo.all('option').map(o => o.text),
      source: page.url, observedAt: utc() };
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

  // ---- solutions (Factory; version-row download calibrated on the live layout)
  solutionsPage() { return this.get('Solutions_List.aspx'); }

  async applicationRuntimeForm(name) {
    let listPage = await this.get('Applications_List.aspx');
    const forms = listPage.doc.all('form');
    const filters = forms.flatMap(form => [...formLabels(listPage,form)].filter(([, [label, node]]) => label === 'name' && typeOf(node) === 'text'));
    if (filters.length) {
      const [fieldName] = one(filters, 'application name filter');
      listPage = await this.click(listPage, button(listPage, ['Filter']), {[fieldName]:name});
    }
    const listing = await this.pages(listPage, 5000, false, 100);
    if (listing.truncated) throw new ProtocolError('Application listing is incomplete');
    const links = listing.rows.flatMap(r => r.links).filter(l => l.name === name && /Application_Edit\.aspx\?ApplicationId=\d+(?:&|$)/.test(l.href));
    const href = one([...new Set(links.map(l => l.href))], 'exact application detail link');
    const page = await this.get(href);
    if (heading(page) !== `Application ${name}`) throw new ProtocolError('Application detail identity changed');
    const panel = tabPanel(page, 'tab-Operation');
    if (!panel || !panel.all('label').some(l => fold(l.text) === 'server request timeout'))
      throw new ProtocolError('Application runtime settings layout is not recognized');
    const control = one(panel.all('input').filter(i => typeOf(i) === 'text' && i.attr('name')), 'server request timeout input');
    const value = control.attr('value');
    if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)))
      throw new ProtocolError('Server request timeout is not a nonnegative integer');
    return { page, panel, control, value: Number(value) };
  }

  async applicationRuntimeSettings(name) {
    const { page, value } = await this.applicationRuntimeForm(name);
    return { application: name, serverRequestTimeout: value, source: page.url, observedAt: utc() };
  }

  async asyncOperationStatus(operationId, lastMessageId = -1) {
    const args = asyncStatusArguments(operationId, lastMessageId);
    await this.login();
    const query = `AjaxStepsGetInfo.aspx?AsyncOperationId=${args.asyncOperationId}&LastSeenId=${args.lastMessageId}&TimeStamp=${encodeURIComponent(new Date().toISOString())}`;
    let body;
    try { body = await this.http.download(query, null, 'binary'); }
    catch (error) {
      if (error instanceof ProtocolError && error.code === 'SC_PROTOCOL_INVALID'
          && error.message === 'Service Center answered with a page instead of the file')
        throw new ProtocolError('Service Center returned HTML for the existing async operation. Its current status is unavailable; no completion or expiration was inferred and no operation was repeated.', 'SC_ASYNC_STATUS_UNAVAILABLE');
      throw error;
    }
    return { asyncOperationId: args.asyncOperationId, ...parseAsyncStatus(body, args.lastMessageId), observedAt: utc(),
      source: this.http.url(query) };
  }

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

  async solutionDownload(name, options = {}) {
    return solutionDownload(this,name,{...this.downloadOptions,...options});
  }

  async solutionVersions(name, limit = 1000, maxPages = 20) {
    if (!(Number.isInteger(limit) && limit >= 1 && limit <= 5000)) throw new ProtocolError('limit must be between 1 and 5000');
    if (!(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= 100)) throw new ProtocolError('maxPages must be between 1 and 100');
    let page = await this.solutionPage(name);
    const versions = [], seen = new Set();
    for (let n = 0; n < maxPages; n++) {
      const table = await assumed(page, 'Solution versions', () => one(content(page).all('table').filter(t => {
        const headers = t.all('th').filter(h => h.ancestor('table') === t).map(h => fold(h.text));
        return ['version', 'name', 'created'].every(h => headers.includes(h));
      }), 'solution versions table'));
      const headers = table.all('th').filter(h => h.ancestor('table') === table).map(h => fold(h.text));
      const batch = table.all('tr').filter(r => r.ancestor('table') === table).flatMap(row => {
        const cells = cellsOf(row);
        if (!cells.length || cells.some(c => c.tag === 'th')) return [];
        if (cells.length === 1 && EMPTY.test(cells[0].text)) return [];
        if (cells.length !== headers.length) throw new ProtocolError('Unrecognized solution version row');
        const version = cells[headers.indexOf('version')].text;
        const label = cells[headers.indexOf('name')];
        const current = !version && [label, ...label.all()].some(c => fold(c.text) === 'current running version');
        if (!current && !version) throw new ProtocolError('Solution version has no identity');
        return [{ version: current ? null : version, currentRunning: current,
          name: current ? 'Current Running Version' : label.text, created: cells[headers.indexOf('created')].text }];
      });
      const marker = fingerprint(batch);
      if (seen.has(marker)) throw new ProtocolError('Service Center pagination did not advance');
      seen.add(marker); versions.push(...batch);
      const next = nextLink(page);
      if (versions.length >= limit || !next || n + 1 === maxPages)
        return { solution: name, versions: versions.slice(0, limit), truncated: versions.length > limit || !!next,
          source: page.url, observedAt: utc() };
      page = await this.nextPage(page, next);
    }
  }

  async solutionDownloadStatus(name, options = {}) {
    return solutionDownloadStatus(this,name,{...this.downloadOptions,...options});
  }

  async solutionDownloadAbandon(name, options = {}) {
    return solutionDownloadAbandon(this,name,{...this.downloadOptions,...options});
  }

  async solutionDownloadRequest(name) {
    if (this.exports === null) throw new ProtocolError('Downloads need a local export folder');
    const page = await this.solutionPage(name);
    let click = null, version = null;
    // Current layouts have one Download per version. Bind to the explicitly
    // labeled running snapshot, never the first button or newest stored row.
    const versionTables = content(page).all('table').filter(t => {
      const headers = t.all('th').filter(h => h.ancestor('table') === t).map(h => fold(h.text));
      return ['version', 'name', 'created'].every(h => headers.includes(h));
    });
    if (versionTables.length) {
      click = await assumed(page, 'The current running solution snapshot', () => {
        const table = one(versionTables, 'solution versions table');
        const headers = table.all('th').filter(h => h.ancestor('table') === table).map(h => fold(h.text));
        const matches = table.all('tr').filter(r => r.ancestor('table') === table).filter(r => {
          const cells = cellsOf(r), label = cells[headers.indexOf('name')];
          return cells[headers.indexOf('version')]?.text === '' && label
            && (fold(label.text) === 'current running version' || label.all().some(n => fold(n.text) === 'current running version'));
        });
        const row = one(matches, 'Current Running Version row');
        const downloads = row.all('input', 'button').filter(n => typeOf(n, n.tag === 'button' ? 'submit' : '') === 'submit'
          && fold(n.attr('value') || n.text) === 'download' && n.attr('name') && !n.has('disabled') && !n.attr('onclick'));
        return one(downloads, 'current running snapshot Download control');
      });
      version = 'current-running';
    } else {
      try { click = button(page, ['Download']); } catch (error) { if (!(error instanceof ProtocolError)) throw error; }
    }
    if (click) {
      const [url,fields] = this.http.formPost(page,click);
      return {url,fields,version};
    }
    else {
      const links = content(page).all('a').filter(a => fold(a.text) === 'download' && a.attr('href') && !/^(?:javascript:|#)/.test(a.attr('href')) && !postbackTarget(a));
      const link = await assumed(page, 'The solution page', () => one(links, 'solution Download control'));
      return {url:this.http.url(link.attr('href'), page.url),fields:null,version};
    }
  }

  // Component names of a solution page's listing (its Name column).
  components(page) {
    const referenceTables = content(page).all('table').filter(t => /wtListReferences$/.test(t.attr('id') || ''));
    const rows = tables(page, false, referenceTables.length === 1 ? referenceTables[0] : null);
    return new Set(rows.flatMap(r => {
      const names = r.links.filter(l => /(?:eSpace|Extension)_Edit\.aspx\?/.test(l.href)).map(l => l.name);
      return names.length ? names : [r.fields.Name || r.fields.Component];
    }).filter(v => v !== null && v !== undefined && v !== ''));
  }

  // ---- generic page writes: prepare reads, send posts inside the reservation, observe re-reads
  // beforeSend(plan, receipt): the last look before the POST, inside the reservation (CX15 r3, CT-1: the client's
  // cancellation of a page delete); a value stops it and nothing is sent (runWrite).
  async webWrite(action, args, { execute = false, words: userWords = null, operationId = null, journal = null, approve = null, beforeSend = null } = {}) {
    const identity = { host: this.vault.host, action, ...Object.fromEntries(WEB_WRITES[action].map(k => [k, pyStr(args[k])])) };
    const [prepare, send] = WEB_HANDLERS[action];
    const run = async (plan, state, receipt) => {
      // Plans carry no secret; the receipt keeps the one it executed so a later verify knows what to expect.
      receipt.plan = plan;
      const outcome = await send.call(this, plan, state, receipt);
      if (!Object.hasOwn(outcome, 'state')) outcome.state = await this.observe(action, identity, plan) ? 'confirmed' : 'accepted-unverified';
      return outcome;
    };
    const gate = async plan => {
      // Before reservation: secret writes need native HTTP that resolves vault references inside the Studio.
      if (SECRET_WRITES.includes(action) && !await this.http.secretsSupported()) throw this.secretRefusal();
      if (approve) await approve(plan);
      // An unknown connection-test result must not prevent explicitly approved
      // cleanup. This never repeats the test or calls its outcome successful.
      if (action === 'db-connection-delete' && plan.authorizationContext && journal)
        journal.supersedeTestForCleanup(identity, plan, operationId);
    };
    return runWrite(identity, () => prepare.call(this, args), run, { execute, words: userWords, operationId, journal,
      authorizing: (id, sha, fn) => this.http.authorizing(id, sha, fn), approve: gate, beforeSend });
  }

  async observe(action, identity, plan = null) {
    if (action === 'application-timeout-set') {
      const now = await this.applicationRuntimeSettings(identity.application);
      return now.source === plan?.target && now.serverRequestTimeout === plan?.value;
    }
    if (action === 'integration-log-level') {
      const [, , combo] = await this.integrationPage(identity.moduleId, identity.integration, plan?.kind ?? null);
      return plan !== null && fold(selectedText(combo)) === fold(plan.level);
    }
    if (action === 'solution-create') return (await this.solutions()).solutions.some(s => s.name === identity.solution);
    if (action === 'solution-delete') {
      const listing = await this.solutions();
      return !listing.truncated && !listing.solutions.some(s => s.name === identity.solution || String(s.id) === plan?.solutionId);
    }
    if (action === 'solution-add-component' || action === 'solution-remove-component') {
      const present = this.components(await this.solutionPage(identity.solution)).has(identity.component);
      return action === 'solution-add-component' ? present : !present;
    }
    if (action === 'db-connection-create') return (await this.dbConnections()).connections.some(c => c.name === identity.connection);
    if (action === 'db-connection-delete') return !(await this.dbConnections()).connections.some(c => c.name === identity.connection);
    if (action === 'db-connection-test') return false; // a test's outcome is its own reply; nothing to re-read
    if (action === 'extension-db-connection') {
      const page = await this.get(`Extension_Edit.aspx?ExtensionId=${await this.extensionRef(identity.extensionId)}`);
      const connection = (await this.mappingConnection(page, identity.connection)).id;
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
    const selectors = controls(form).filter(n => n.tag === 'select' && /\$wtListBox1$/.test(n.attr('name') || ''));
    if (selectors.length) {
      found.select = one(selectors, 'solution component selector');
      const refs = controls(form).filter(n => /\$wtReferenceAddDependencies$/.test(n.attr('name') || ''));
      return [page, click, found, refs.length === 1 ? refs[0] : null];
    }
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

  connectionEndpoint(page, control) {
    const fields = entries(formLabels(page, control.ancestor('form')));
    const value = label => controlValue(one(fields.filter(f => f.label === label).map(f => f.n), 'database ' + label + ' field'));
    const provider = fields.find(f => f.n.tag === 'select' && (/DBMS/i.test(f.name) || f.label === 'dbms'));
    return { dbms: provider ? selectedText(provider.n) : null, parameters: { server: value('server'), database: value('database') } };
  }

  connectionCombos(page, connectionId) {
    return content(page).all('select').filter(s => /DBConnectionCombo/i.test(s.attr('name', '') ?? '') && s.all('option').map(optionValue).includes(connectionId));
  }

  async mappingConnection(page, connection) {
    if (connection !== '(not configured)') return this.dbConnection(connection);
    const combos = content(page).all('select').filter(s => /DBConnectionCombo/i.test(s.attr('name', '') ?? ''));
    if (!combos.length) throw new ProtocolError('No database-connection selector on this extension');
    const values = combos.map(c => optionValue(one(c.all('option').filter(o => fold(o.text) === '(not configured)'), 'unconfigured database option')));
    if (new Set(values).size !== 1) throw new LayoutError(page.url, 'Unconfigured database options', 'selectors disagree on their unconfigured value');
    return { id: values[0], name: '(not configured)' };
  }

  // The numeric extension ID, given either that ID or the extension's exact name.
  async extensionRef(value) { return /^[1-9][0-9]*$/.test(String(value)) ? String(value) : this.extensionId(String(value)); }
}

const sendPostback = async function (plan, s) {
  if (s.control.tag === 'a') checked(await this.http.postback(s.page, s.control, s.updates));
  else checked(await this.http.submit(s.page, s.control, s.updates));
  return {};
};

// action -> [prepare(args), send(plan, state)], called with the Client as this.
const WEB_HANDLERS = {
  'application-timeout-set': [async function (a) {
    for (const v of [a.value, a.expectedValue])
      if (!/^\d+$/.test(String(v ?? '')) || !Number.isSafeInteger(Number(v)) || Number(v) > 2147483647)
        throw new ProtocolError('Timeout and expected value must be nonnegative 32-bit integers');
    const {page,panel,control,value} = await this.applicationRuntimeForm(a.application);
    if (value !== Number(a.expectedValue)) throw new ProtocolError('Application timeout changed; expected value does not match');
    const click = one(panel.all('input').filter(n => typeOf(n) === 'submit'
      && /\$wtApplyRuntimeMobileButton$/.test(n.attr('name') || '') && n.attr('value') === 'Apply' && !n.has('disabled')), 'runtime Apply control');
    const script = click.attr('onclick') || '';
    // Only the observed confirmation and client validation pattern; never execute script.
    if (!/^var ret = confirm\('[^']*'\);if\( ret != true \) \{return false;\}OsPage_ClientValidate\('[A-Za-z0-9_]+'\);$/.test(script)
        || !script.endsWith(`OsPage_ClientValidate('${click.attr('id')}');`))
      throw new ProtocolError('Unrecognized runtime Apply script; nothing sent');
    const updates = {[control.attr('name')]:String(Number(a.value))};
    this.http.formPost(page,click,updates);
    return [{host:this.vault.host,action:'application-timeout-set',application:a.application,previousValue:value,
      value:Number(a.value),target:page.url,execute:false,runtimeCompletionVerified:false}, {page,control:click,updates}];
  }, async function (plan,s) {
    checked(await this.http.submit(s.page,s.control,s.updates));
    return {runtimeCompletionVerified:false, note:'Saved value is read back; application reload completion is not proven by this receipt'};
  }],
  'solution-delete': [async function (a) {
    const page = await this.solutionPage(a.solution);
    const name = one(page.doc.all('input').filter(n => /Solution_?Name$/.test(n.attr('name') || '')), 'solution name field');
    if (name.attr('value') !== a.solution) throw new ProtocolError('Solution identity changed; nothing sent');
    const solutionId = new URL(page.url).searchParams.get('SolutionId');
    if (!/^[1-9][0-9]*$/.test(solutionId || '')) throw new ProtocolError('Solution ID unavailable; nothing sent');
    const control = await assumed(page, 'The solution detail header', () => one(page.doc.all('a').filter(n =>
      fold(caption(n)) === 'delete' && !n.ancestor('tr') && postbackTarget(n)), 'solution Delete postback'));
    return [{host:this.vault.host,action:'solution-delete',solution:a.solution,solutionId,namedTargets:[a.solution],
      destructive:true,confirm:redactText(confirmText(control)).slice(0,300),target:page.url,execute:false}, {page,control}];
  }, sendPostback],
  'solution-create': [async function (a) {
    if (!/^[A-Za-z0-9 _.-]{1,100}$/.test(a.solution)) throw new ProtocolError('Solution name must be plain text (letters, digits, space, _ . -)');
    const current = await this.solutions();
    if (current.truncated) throw new ProtocolError('Solution listing is incomplete; absence not proven');
    if (current.solutions.some(s => s.name === a.solution)) throw new ProtocolError('A solution with this name already exists');
    const listing = await this.solutionsPage();
    const link = await assumed(listing, 'The solutions list', () => one(content(listing).all('a').filter(l => ['new solution', 'create solution', 'new'].includes(fold(l.text))), 'New Solution link'));
    const event = postbackTarget(link);
    if (event && (event.kind !== 'postback' || event.argument !== '' || !/\$wtNewSolutionLink$/.test(event.target)))
      throw new ProtocolError('Unrecognized New Solution navigation; nothing sent');
    const page = event ? await this.readPostback(listing, ...this.http.eventPost(listing, link)) : await this.follow(listing, link);
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
      if (found.select) {
        const option = one(found.select.all('option').filter(o => [a.component, a.component+' (Module)', a.component+' (Extension)'].includes(o.text)), 'exact component option');
        if (!optionValue(option) || option.has('disabled')) throw new ProtocolError('Component option is unavailable');
        Object.assign(plan, {componentLabel:option.text,componentKey:optionValue(option)});
        return [plan,state];
      }
      const lookup = await this.componentLookup(page, found.box, found.value, a.component);
      Object.assign(plan, { componentLabel: lookup.label, componentKey: lookup.key });
      state.lookupState = lookup.state;
    }
    return [plan, state];
  }, async function (plan, s) {
    if (plan.alreadyPresent) return { state: 'confirmed', noChange: true };
    const updates = s.select ? {[s.select.attr('name')]:plan.componentKey}
      : { [s.box.attr('name')]: plan.componentLabel, [s.value.attr('name')]: plan.componentKey, [s.aux.attr('name')]: 'isVisible' };
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
    const referenceTables = content(page).all('table').filter(t => /wtListReferences$/.test(t.attr('id') || ''));
    const scope = referenceTables.length === 1 ? referenceTables : content(page).all('table');
    const rows = scope.flatMap(t => t.all('tr')).filter(r => r.children.some(c => c?.tag === 'td' && (c.text === a.component
      || c.all('a').some(l => l.text === a.component && /(?:eSpace|Extension)_Edit\.aspx\?/.test(l.attr('href') || '')))));
    const row = one(rows, `component row ${repr(a.component)}`);
    const candidates = row.all('a', 'input').filter(n => ['remove', 'delete', 'disassociate'].includes(fold(strip(caption(n)))));
    if (!candidates.length) {
      const checkbox = one(row.all('input').filter(n => typeOf(n) === 'checkbox' && n.attr('name') && !n.has('disabled')), 'component selection checkbox');
      const control = await assumed(page, 'The solution components', () => one(content(page).all('input','button').filter(n =>
        /\$wtReferenceDeleteButton2$/.test(n.attr('name') || '') && fold(caption(n)) === 'dissociate selected'), 'Dissociate Selected control'));
      const updates = Object.fromEntries(row.ancestor('table').all('input').filter(n => typeOf(n) === 'checkbox' && n.attr('name')).map(n => [n.attr('name'),null]));
      updates[checkbox.attr('name')] = controlValue(checkbox) || 'on';
      return [{host:this.vault.host,action:'solution-remove-component',solution:a.solution,component:a.component,
        confirm:redactText(confirmText(control)).slice(0,300),target:page.url,execute:false}, {page,control,updates}];
    }
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
      ...this.connectionEndpoint(page, click),
      loginTarget: target, loginStored: Boolean(await this.vault.present(target)), secretRefsSupported: await this.http.secretsSupported(),
      target: page.url, execute: false };
    const refs = this.loginRefs(plan, {user, password});
    const placeholders = Object.fromEntries(Object.keys(refs).map(key => [key, '']));
    const ajax = this.http.scriptedAjaxPost(page, click, placeholders);
    if (!ajax) this.http.formPost(page, click, placeholders); // refuse before any reservation
    return [plan, { page, click, user, password, ajax, refs }];
  }, async function (plan, s, receipt) {
    let response;
    if (s.ajax) {
      const [final, , raw, charset] = await this.http.fetch(...s.ajax, 'text-write', toSecretRefs(s.refs));
      const body = decode(raw, charset);
      // The native transport has already removed resolved credentials/session
      // material. Keep its redacted reply so uncertain parsing can be repaired
      // and reconciled without repeating the external connection test.
      if (this.exports && receipt) receipt.responseEvidence = this.save('db-test-reply', 'txt', Buffer.from(redactText(body)));
      response = new Page(final, new Document(/<form\b/i.test(body) ? body : ajaxMarkup(body).join('')));
    } else response = await this.http.submit(s.page, s.click, null, s.refs);
    if (urlsplit(response.url).path.toLowerCase().endsWith('/login.aspx')) throw new ProtocolError('Service Center login required or session expired');
    const outcome = connectionTestOutcome(response);
    if (!outcome && !response.doc.all().some(n => n.text))
      // The bridge dropped the whole reply (htmlOmitted): it echoed the login in a form it cannot mask.
      return { state: 'accepted-unverified', testPassed: null, feedback: 'The reply was withheld because it echoed the login. The connection test remains unverified; reconcile the existing receipt without repeating the test.' };
    if (!outcome) throw new LayoutError(response.url, 'The connection test reply', 'it shows no success or error feedback');
    // The test changes nothing; its reply is the result. The server's text can echo the login, so only the outcome
    // comes back.
    return { state: 'confirmed', ...outcome };
  }],

  'db-connection-delete': [async function (a) {
    const connection = await this.dbConnection(a.connection);
    const page = await this.get(connection.href);
    const control = one(content(page).all('a', 'input').filter(n => fold(strip(caption(n))) === 'delete' && (n.tag === 'input' || postbackTarget(n))), 'Delete control');
    // Extensions that use the connection must be named by the user's words too (matrix D4).
    const used = [...new Set(tables(page).map(r => r.fields.Extension).filter(Boolean))].sort();
    const plan = { host: this.vault.host, action: 'db-connection-delete', connection: a.connection, connectionId: connection.id, usedBy: used,
      ...(a.authorization_context ? this.connectionEndpoint(page, control) : {}),
      namedTargets: [a.connection, ...used], confirm: redactText(confirmText(control)).slice(0, 300), target: page.url, destructive: true, execute: false };
    return [plan, { page, control }];
  }, sendPostback],

  'extension-db-connection': [async function (a) {
    const extensionId = await this.extensionRef(a.extensionId);
    const page = await this.get(`Extension_Edit.aspx?ExtensionId=${extensionId}`);
    const connection = await this.mappingConnection(page, a.connection);
    const combos = this.connectionCombos(page, connection.id);
    if (!combos.length) throw new ProtocolError('No database-connection selector of this extension offers that connection');
    const pending = combos.filter(c => controlValue(c) !== connection.id);
    const plan = { host: this.vault.host, action: 'extension-db-connection', extensionId, connection: a.connection, connectionId: connection.id,
      selectors: combos.length, pending: pending.length,
      currentSelections: combos.map(c => ({ selector: c.attr('name'), value: controlValue(c), connection: selectedText(c) })),
      target: page.url, execute: false };
    return [plan, { url: page.url }];
  }, async function (plan, s) {
    // One OsAjax Change (a read that stages the value) -> Apply (the write) for one selector. The bridge accepts each
    // operationId once, so a second selector is a new call with its own operationId, after this one's re-read.
    const page = await this.get(s.url);
    const current = this.connectionCombos(page, plan.connectionId);
    if (JSON.stringify(current.map(c => c.attr('name')).sort()) !== JSON.stringify(plan.currentSelections.map(c => c.selector).sort()))
      throw new ProtocolError('Database selectors changed after planning; no mapping request sent');
    const baseline = new Map(plan.currentSelections.map(c => [c.selector, c.value]));
    if (current.some(c => controlValue(c) !== baseline.get(c.attr('name'))))
      return { state: 'refused', code: 'SC_MAPPING_CHANGED', sent: false,
        error: 'Database mapping changed after planning; no mapping request sent' };
    const pending = current.filter(c => controlValue(c) !== plan.connectionId);
    if (!pending.length) return { state: 'confirmed', noChange: true };
    const combo = pending[0];
    const name = combo.attr('name');
    // Modern pages declare an empty AJAX event in onchange. It is not the
    // synthetic Change event used by older controls: preserve the native route.
    const handler = combo.attr('onchange');
    let event = 'Change';
    if (handler) {
      const call = /OsAjax\([^,]*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,/.exec(handler);
      if (!call || call[1] !== combo.attr('id') || call[2] !== name || !['', 'Change'].includes(call[3]))
        throw new ProtocolError('Unrecognized database selector change handler; no mapping request sent');
      event = call[3];
    }
    const reply = await this.http.text(...this.http.ajaxPost(page, combo, { [name]: plan.connectionId }, event));
    const state = ajaxState(reply);
    if (!state) throw new LayoutError(page.url, "The extension's OsAjax 'Change' reply", 'it carries no refreshed form state');
    const osv = one(controls(combo.ancestor('form')).map(n => n.attr('name')).filter(n => n.endsWith('__OSVSTATE')), 'form state field');
    checked(await this.http.submit(page, button(page, ['Apply']), { [name]: plan.connectionId, [osv]: state }));
    const observed = this.connectionCombos(await this.get(s.url), plan.connectionId);
    const left = observed.filter(c => controlValue(c) !== plan.connectionId);
    const expectedNames = plan.currentSelections.map(c => c.selector).sort();
    const observedNames = observed.map(c => c.attr('name')).sort();
    if (JSON.stringify(expectedNames) !== JSON.stringify(observedNames))
      return { state: 'accepted-unverified', observedDesiredState: false, observationMismatch: 'database-selectors-changed',
        observedSelections: observed.map(c => ({ selector: c.attr('name'), value: controlValue(c), connection: selectedText(c) })) };
    if (!left.length) return { state: 'confirmed' };
    if (left.length < pending.length) {
      // This Apply landed; the remaining selectors need their own operation (a new operationId each).
      return { state: 'accepted', remainingSelectors: left.length, continuation: continuation('o11_service_center_write',
        { action: 'extension-db-connection', host: plan.host, extensionId: plan.extensionId, connection: plan.connection, execute: true },
        'repeat with a new operationId (and the user words) for the next selector') };
    }
    return { state: 'accepted-unverified', observedDesiredState: false,
      observedSelections: observed.map(c => ({ selector: c.attr('name'), value: controlValue(c), connection: selectedText(c) })) };
  }],

  'integration-log-level': [async function (a) {
    const [target, page, combo] = await this.integrationPage(a.moduleId, a.integration, a.kind ?? null);
    if (a.expectedValue !== undefined && fold(selectedText(combo)) !== fold(a.expectedValue))
      throw new ProtocolError('Integration logging level changed; expected value does not match');
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
    // new operationId reopens secretReady (index.mjs): an absent entry gets the private Windows prompt (012e263e).
    Object.assign(failure, { target: error.extra.target ?? null, part: error.extra.part ?? null,
      continuation: continuation('o11_service_center_write', { ...(identity ? { action: identity.action, host: identity.host } : {}), execute: true },
        'Nothing was sent. Retry with a new operationId: when the entry is absent, the retry opens the private Windows prompt in its own window for the database login or the secret site property value (the user types there, never in the chat) and goes on once it is stored; an entry that exists without this part is never overwritten through the window, so provision that part privately first') });
  }
  return failure;
}

// Prepare by default. Execute: the user's words, an operationId UUID, the durable reservation before anything is sent,
// and no replay: the same operationId returns its receipt; a failure after sending stays uncertain. approve(plan)
// checks the words against the resolved target before the reservation. beforeSend(plan, receipt), inside the
// reservation right before the send: a value it returns stops the write with nothing sent (the receipt closes 'refused'
// with notSent and that value, so its target lock is released).
export async function runWrite(identity, prepare, send, { execute, words: userWords, operationId, journal, authorizing = null, lock = null, approve = null, beforeSend = null }) {
  if (execute) {
    if (!wordsGiven(userWords) || !strip(userWords) || !operationId || !journal) throw new ProtocolError("Execution requires the user's words, operation-id and a durable journal"); // CX15 r7
    const existing = journal.lookup(operationId, identity);
    if (existing) return { ...existing, replayed: false, existingReceipt: true };
  }
  const [plan, state] = await prepare();
  if (!execute) return plan;
  if (approve) await approve(plan);
  return journal.reserve(operationId, identity, userWords, plan, lock ? lock(plan) : null, async receipt => {
    let tracker = {};
    try {
      const body = async t => {
        tracker = t;
        const stop = beforeSend ? beforeSend(plan, receipt) : null;
        if (stop) { Object.assign(receipt, { ...stop, state: 'refused', notSent: true }); return; }
        Object.assign(receipt, await send(plan, state, receipt));
      };
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

// Windows refuses a rename over a file another process holds open for a moment (a scanner, a reader): EPERM, EBUSY and
// EACCES are retried for about two seconds before the error is thrown (CX15 r2, C5: the rewrite of a parent receipt after
// a child was sent must not fail on that).
const pauseMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function renameRetrying(from, to, { attempts = 80, waitMs = 25 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (error) { if (attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; pauseMs(waitMs); }
  }
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
    if (result.identity?.action === 'timer-run') {
      const directory = path.join(this.root, 'timer-observations', canonicalUuid(operationId));
      if (fs.existsSync(directory)) {
        const names = fs.readdirSync(directory).filter(n => /^[0-9]{17}-[a-f0-9]{64}\.json$/.test(n)).sort();
        if (names.length) {
          const observation = JSON.parse(fs.readFileSync(path.join(directory, names.at(-1)), 'utf8'));
          if (observation.schema !== 'ssam-timer-observation/1' || observation.operationId !== result.operationId
            || observation.identitySha256 !== fingerprint(result.identity)
            || observation.planSha256 !== result.authorization?.planSha256
            || !names.at(-1).endsWith('-' + fingerprint(observation) + '.json'))
            throw new ProtocolError('Stored timer observation does not match the receipt');
          result.timerObservation = { ...observation, file: path.resolve(directory, names.at(-1)) };
        }
      }
    }
    return result;
  }

  // Append observed evidence without confirming/replacing the original send,
  // releasing its lock, or changing its pre-send baseline.
  recordTimerObservation(receipt, observation) {
    const current = JSON.parse(fs.readFileSync(this.path(receipt.operationId), 'utf8'));
    if (current.identity?.action !== 'timer-run' || current.state === 'sending'
      || !same(current.identity, receipt.identity) || !same(current.authorization, receipt.authorization)
      || current.plan?.timerLogBaseline?.available !== true)
      throw new ProtocolError('Timer receipt changed or has no complete pre-send baseline');
    if (observation.attributedToRequest !== false || observation.executionCompleted !== null
      || observation.verificationScope !== 'new-exact-timer-log-rows')
      return null; // Incomplete reads cannot become a new stored execution observation.
    const record = { schema: 'ssam-timer-observation/1', operationId: current.operationId,
      identitySha256: fingerprint(current.identity), planSha256: current.authorization.planSha256,
      recordedAt: utc(), source: 'live-read', observation };
    const directory = path.join(this.root, 'timer-observations', current.operationId);
    fs.mkdirSync(directory, { recursive: true });
    const name = new Date().toISOString().replace(/[^0-9]/g, '') + '-' + fingerprint(record) + '.json';
    const file = path.join(directory, name);
    Journal.writeDurable(file, JSON.stringify(record, null, 2), 'wx');
    return { ...record, file: path.resolve(file) };
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
    Journal.rename(temporary, file);
  }
  static rename(from, to) { renameRetrying(from, to); }
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
    if (!wordsGiven(userWords) || !strip(userWords)) throw new ProtocolError("discard needs the user's own words"); // CX15 r7
    return this.resolve(receipt, 'discarded', 'discarded by the user; the outcome of the send stays unknown and nothing was sent again',
      { authorization: { wordsSha256: sha256(Buffer.from(userWords, 'utf8')) } }, now);
  }

  // The last receipt that wrote a target, by a reference to it (host, kind, folded name or key): a repeated delete whose
  // target is gone answers from it without any send.
  pointerFile(ref) { return path.join(this.root, 'targets', fingerprint(ref) + '.txt'); }
  supersedeTestForCleanup(identity, plan, operationId) {
    if (!canonicalUuid(operationId) || identity.action !== 'db-connection-delete') throw new ProtocolError('Invalid cleanup operation');
    const target = Journal.targetOf(identity), held = this.holder(target);
    if (!held) return;
    const previous = this.lookup(held);
    const same = previous?.identity?.action === 'db-connection-test'
      && previous.identity.host === identity.host && previous.identity.connection === identity.connection
      && previous.plan?.connectionId === plan.connectionId && previous.plan?.dbms === plan.dbms
      && previous.plan?.parameters?.server === plan.parameters?.server
      && previous.plan?.parameters?.database === plan.parameters?.database;
    if (!same || !plan.authorizationContext || plan.usedBy?.length
      || !['uncertain', 'accepted-unverified'].includes(previous?.state)
      || this.rawState(held) === 'sending')
      throw new ProtocolError('Pending operation does not qualify for approved connection-test cleanup');
    if (this.holder(target) !== held) throw new ProtocolError('Pending connection-test lock changed');
    Object.assign(previous, { state:'superseded', ok:false, supersededBy:canonicalUuid(operationId),
      testOutcome:'unverified', updatedAt:utc(),
      verification:'Unverified test retained; exact unchanged unused connection approved for deletion. No test replay.' });
    this.rewrite(previous);
    const lock = this.lockFile(target);
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8').trim() === held) fs.unlinkSync(lock);
  }

  point(ref, operationId) {
    const file = this.pointerFile(ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    Journal.writeDurable(file, canonicalUuid(operationId), 'w');
  }
  pointed(ref) {
    try { return canonicalUuid(fs.readFileSync(this.pointerFile(ref), 'utf8').trim()); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  acceptMaskedSecret(receipt) {
    if (receipt.identity?.action !== 'property-set' || receipt.plan?.secret !== true
        || receipt.secretValuePresent !== true || receipt.valueVerified !== false
        || receipt.state !== 'accepted-unverified' || this.rawState(receipt.operationId) !== 'accepted-unverified')
      throw new ProtocolError('Only a completed secret POST with observed masked presence can be acknowledged');
    const lock = this.lockFile(receipt.lock ?? Journal.targetOf(receipt.identity));
    if (!fs.existsSync(lock) || fs.readFileSync(lock, 'utf8') !== receipt.operationId)
      throw new ProtocolError('Pending target lock no longer belongs to this receipt');
    Object.assign(receipt, { state: 'accepted', ok: true, reconciledAt: utc(),
      verification: 'POST completed; a masked stored value is present. The submitted secret was never compared.' });
    this.rewrite(receipt);
    fs.unlinkSync(lock);
  }

  reconcile(receipt) {
    if (receipt.state === 'accepted' && receipt.identity?.action === 'apply-settings'
        && receipt.executionCompleted === true && receipt.applySettingsObservation?.success === true
        && receipt.applySettingsObservation?.terminal === true
        && receipt.applySettingsObservation.applyId === receipt.applyId) {
      const current = JSON.parse(fs.readFileSync(this.path(receipt.operationId), 'utf8'));
      if (current.state !== 'accepted' || current.applyId !== receipt.applyId
          || fingerprint(current.identity) !== fingerprint(receipt.identity))
        throw new ProtocolError('Apply settings receipt changed during reconciliation');
      Object.assign(receipt, { state: 'confirmed', ok: true, reconciledAt: utc(),
        verification: 'The recorded apply settings job reported terminal success; no write was resent' });
      this.rewrite(receipt);
      return;
    }
    if (receipt.state === 'accepted' && receipt.identity?.action === 'solution-publish'
        && receipt.executionCompleted === true && receipt.publicationObservation?.success === true
        && receipt.publicationObservation?.terminal === true
        && receipt.publicationObservation.solutionPublishId === receipt.solutionPublishId) {
      const current = JSON.parse(fs.readFileSync(this.path(receipt.operationId), 'utf8'));
      if (current.state !== 'accepted' || current.solutionPublishId !== receipt.solutionPublishId
          || fingerprint(current.identity) !== fingerprint(receipt.identity))
        throw new ProtocolError('Publication receipt changed during reconciliation');
      Object.assign(receipt, { state: 'confirmed', ok: true, reconciledAt: utc(),
        verification: 'The recorded publication job reported terminal success; no publication was resent' });
      this.rewrite(receipt);
      return;
    }
    if (['confirmed', 'accepted'].includes(receipt.state)) return;
    if (JSON.parse(fs.readFileSync(this.path(receipt.operationId), 'utf8')).state === 'sending')
      throw new ProtocolError('Sender may still be active; a sending receipt cannot be automatically reconciled');
    const lock = this.lockFile(receipt.lock ?? Journal.targetOf(receipt.identity));
    if (!fs.existsSync(lock) || fs.readFileSync(lock, 'utf8') !== receipt.operationId) throw new ProtocolError('Pending target lock no longer belongs to this receipt');
    Object.assign(receipt, { state: 'confirmed', ok: true, reconciledAt: utc(), verification: 'Desired state observed; this does not prove which writer established it' });
    const file = this.path(receipt.operationId);
    const temporary = file.replace(/\.json$/, '.tmp');
    Journal.writeDurable(temporary, JSON.stringify(receipt, null, 2), 'wx');
    Journal.rename(temporary, file);
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
      Journal.rename(temporary, file);
      if (RELEASED.includes(receipt.state)) fs.rmSync(lock, { force: true });
    }
  }
}
