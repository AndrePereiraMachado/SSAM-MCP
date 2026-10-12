import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { CookieJar } from 'tough-cookie';
import { compileTraditionalEntry, traditionalRequest } from './debug-o11-traditional.mjs';
import { privateAppUserVault, appUserBinding, sameAppUserTarget } from './debug-app-user.mjs';
import { validatePrivateDescriptor } from './debug-app-user-worker.mjs';
import { o11NativeDirectory } from './debug-o11-native-entry.mjs';
import { blockedBinding } from './debug-o11-native-run.mjs';

const fail = code => { throw new Error('debug_o11_native_traditional_' + code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const publicCode = error => /^debug_o11_native_traditional_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_o11_native_traditional_execution_failed';
const one = rows => { if (rows.length !== 1) fail('form_contract_unqualified'); return rows[0]; };
function persist(file, value, exclusive = false) {
  const destination = exclusive ? file : file + '.tmp', fd = fs.openSync(destination, exclusive ? 'wx' : 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!exclusive) fs.renameSync(destination, file);
}

// Request deadline that does not count time the server debugger holds the request: the idle
// timer is suspended while paused and re-armed on resume. The fixed native lease (hardDeadlineAt)
// is never paused. An expiry only aborts; the caller keeps the sent marker (never a resend).
export function createPauseAwareDeadline({ timeoutMs, hardDeadlineAt, now = Date.now, timers = globalThis, onExpire = () => {} }) {
  const controller = new AbortController(); let idle = null, hard = null, paused = false, done = false;
  const clear = () => { if (idle !== null) timers.clearTimeout(idle); if (hard !== null) timers.clearTimeout(hard); idle = hard = null; };
  const expire = reason => { if (done) return; done = true; clear(); controller.abort(new Error(reason)); onExpire(reason); };
  const arm = () => { if (!done && !paused) idle = timers.setTimeout(() => { idle = null; expire('request_timeout'); }, timeoutMs); };
  if (hardDeadlineAt !== undefined) {
    const remaining = hardDeadlineAt - now();
    if (!(remaining > 0)) expire('inspection_expired'); else hard = timers.setTimeout(() => { hard = null; expire('inspection_expired'); }, remaining);
  }
  arm();
  return { signal: controller.signal, get expired() { return done && controller.signal.aborted; },
    pause() { if (done || paused) return; paused = true; if (idle !== null) { timers.clearTimeout(idle); idle = null; } },
    resume() { if (done || !paused) return; paused = false; arm(); },
    dispose() { done = true; clear(); } };
}

// Parse inert HTML only: no script evaluation, resource loading or browser.
// Control names, state and submission URL come from the original login response.
export function originalTraditionalLoginForm(html, plan) {
  const dom = new JSDOM(html, { url: plan.login.url });
  try {
    const document = dom.window.document;
    const control = (parameter, type) => one([...document.querySelectorAll('input')].filter(input =>
      input.type === type && input.name && !input.disabled &&
      (input.id === 'wt' + plan.login.controls[parameter].name || input.id.endsWith('_wt' + plan.login.controls[parameter].name))));
    const username = control('Username', 'text'), password = control('Password', 'password');
    const form = username.form;
    if (!form || password.form !== form || form.method.toUpperCase() !== 'POST') fail('form_contract_unqualified');
    const action = new URL(form.getAttribute('action') || plan.login.url, plan.login.url);
    const original = new URL(plan.login.url);
    if (action.origin !== original.origin || action.pathname !== original.pathname || action.username || action.password || action.hash) fail('form_route_changed');
    const submit = one([...form.querySelectorAll('input[type=submit],button[type=submit],button:not([type])')].filter(button =>
      !button.disabled && button.name && (button.value || button.textContent.trim()) === plan.login.button.label));
    const fields = [];
    for (const input of form.querySelectorAll('input[type=hidden]')) {
      if (!input.name || input.disabled || input.value.length > 2 * 1024 * 1024) fail('form_contract_unqualified');
      fields.push([input.name, input.value]);
    }
    // Current O11 emits its signed __OSVSTATE plus ASP.NET state; it does not
    // emit __EVENTVALIDATION on the observed native Traditional login form.
    if (!fields.some(([name]) => name === '__VIEWSTATE') || !fields.some(([name, value]) => name === '__OSVSTATE' && value)) fail('form_state_unavailable');
    if (new Set(fields.map(([name]) => name)).size !== fields.length || fields.some(([name]) => [username.name, password.name, submit.name].includes(name))) fail('form_contract_unqualified');
    return { url: action.href, fields, username: username.name, password: password.name, submit: [submit.name, submit.value || submit.textContent.trim()] };
  } finally { dom.window.close(); }
}

// The rendered OsAjax call of an Ajax Submit control, in the only shape proven live (the Service
// Center pages, service-center/http.mjs scriptedAjaxPost): own control id, its event target, an
// empty argument and the '__OSVSTATE,' list. Any other call is refused, never approximated.
const OS_AJAX = /^OsAjax\(arguments\[0\] \|\| window\.event,'([A-Za-z0-9_]{1,300})','([A-Za-z0-9_$]{1,300})','','(__OSVSTATE,)',''\); return false;$/;
const scripted = element => /OsAjax|__doPostBack|\.submit\(/.test((element.getAttribute('onclick') ?? '') + ' ' + (element.tagName === 'A' ? element.getAttribute('href') ?? '' : ''));

// The rendered screen form, submitted as the browser would: successful controls in tree order,
// the rendered __OSVSTATE/__VIEWSTATE, and the published Button (name/value) or Link
// (__doPostBack target into the rendered __EVENTTARGET/__EVENTARGUMENT). No field is invented.
// Ajax Submit sends what the runtime's OsAjaxBaseBackend sends for the rendered OsAjax call:
// OsSerializeForm (no submit controls), unchecked boxes as 'off', then __EVENTTARGET,
// __EVENTARGUMENT and __AJAX built from that call (the Service Center live contract, matrix L7/D5).
export function originalTraditionalActionForm(html, plan, pageUrl) {
  const action = plan?.screenAction; if (!action) fail('action_contract_invalid');
  const dom = new JSDOM(html, { url: pageUrl });
  try {
    const document = dom.window.document, page = new URL(pageUrl), widget = action.widget, ajaxPlan = action.method === 'Ajax Submit';
    const named = element => element.id === 'wt' + widget.name || element.id.endsWith('_wt' + widget.name);
    const single = rows => { if (rows.length !== 1) fail('action_control_unqualified'); return rows[0]; };
    let control, eventTarget = null, ajax = null;
    if (widget.kind === 'ButtonWidget') control = single([...document.querySelectorAll('input[type=submit],input[type=button],button')].filter(b =>
      !b.disabled && b.name && (widget.name ? named(b) : (b.value || b.textContent.trim()) === widget.label)));
    else control = single([...document.querySelectorAll('a')].filter(a => widget.name ? named(a) : a.textContent.trim() === widget.label));
    // The rendered control must match the published method: an OsAjax control is never a Submit and vice versa.
    const script = (control.getAttribute('onclick') ?? '').trim();
    if (/OsAjax/.test(script + (control.getAttribute('href') ?? '')) !== ajaxPlan) fail('action_method_mismatch');
    if (ajaxPlan) {
      const call = OS_AJAX.exec(script);
      if (!call || call[1] !== control.id || (widget.kind === 'ButtonWidget' && call[2] !== control.name) || control.getAttribute('formaction')) fail('action_ajax_unsupported');
      ajax = { protocol: 'OsAjaxBaseBackend', controlId: call[1], eventTarget: call[2], fieldList: call[3] };
    } else if (widget.kind === 'ButtonWidget') { if (scripted(control) || control.getAttribute('formaction')) fail('action_control_unqualified'); }
    else {
      const postBack = /__doPostBack\('([^'\\]{1,500})','([^'\\]{0,500})'\)/.exec((control.getAttribute('href') ?? '') + ' ' + (control.getAttribute('onclick') ?? ''));
      if (!postBack) fail('action_control_unqualified');
      eventTarget = [postBack[1], postBack[2]];
    }
    const form = control.form ?? control.closest('form');
    if (!form || form.method.toUpperCase() !== 'POST') fail('form_contract_unqualified');
    if ((form.getAttribute('enctype') ?? '').toLowerCase().startsWith('multipart/') || form.querySelector('input[type=file][name]')) fail('form_encoding_unsupported');
    const target = new URL(form.getAttribute('action') || pageUrl, pageUrl);
    if (target.origin !== page.origin || target.pathname !== page.pathname || target.username || target.password || target.hash) fail('form_route_changed');
    const hidden = [...form.querySelectorAll('input[type=hidden]')].filter(input => input.name && !input.disabled).map(input => [input.name, input.value]);
    if (hidden.some(([, value]) => value.length > 2 * 1024 * 1024) || new Set(hidden.map(([name]) => name)).size !== hidden.length) fail('form_contract_unqualified');
    if (!hidden.some(([name]) => name === '__VIEWSTATE') || !hidden.some(([name, value]) => name === '__OSVSTATE' && value)) fail('form_state_unavailable');
    if (eventTarget && !['__EVENTTARGET', '__EVENTARGUMENT'].every(field => hidden.some(([name]) => name === field))) fail('form_contract_unqualified');
    const fields = [], bag = element => !!element.closest('#__CheckBoxBag');
    if (ajax) {
      for (const element of form.elements) {
        const type = (element.type ?? '').toLowerCase();
        if (!element.name || element.disabled || element.closest('fieldset[disabled]') || bag(element) ||
            ['__EVENTTARGET', '__EVENTARGUMENT', '__AJAX', '__AJAXEVENT'].includes(element.name)) continue;
        if (element.tagName === 'BUTTON' || ['submit', 'button', 'image', 'reset'].includes(type)) continue;
        if (['checkbox', 'radio'].includes(type)) { if (element.checked) fields.push([element.name, element.getAttribute('value') ?? 'on']); }
        else if (element.tagName === 'SELECT') for (const option of element.selectedOptions) fields.push([element.name, option.value]);
        else fields.push([element.name, element.value]);
      }
      // OsPrepareCheckboxesForSubmit: unchecked boxes contribute 'off', disabled checked boxes 'on'.
      for (const box of form.querySelectorAll('input[type=checkbox]')) if (box.name && !bag(box) && (!box.checked || box.disabled))
        fields.push([box.name, box.checked ? 'on' : 'off']);
      fields.push(['__EVENTTARGET', ajax.eventTarget], ['__EVENTARGUMENT', ''], ['__AJAX', '1280,1024,' + ajax.controlId + ',0,0,0,0,0,0,']);
      return { url: target.href, fields, control: ajax.eventTarget, ajax };
    }
    for (const element of form.elements) {
      if (!element.name || element.disabled || element.closest('fieldset[disabled]')) continue;
      const type = (element.type ?? '').toLowerCase();
      if (element === control) fields.push([element.name, element.value || element.textContent.trim()]);
      else if (element.tagName === 'INPUT' && type === 'hidden') fields.push([element.name,
        eventTarget && element.name === '__EVENTTARGET' ? eventTarget[0] : eventTarget && element.name === '__EVENTARGUMENT' ? eventTarget[1] : element.value]);
      else if (element.tagName === 'BUTTON' || ['submit', 'button', 'image', 'reset'].includes(type)) continue;
      else if (['checkbox', 'radio'].includes(type)) { if (element.checked) fields.push([element.name, element.getAttribute('value') ?? 'on']); }
      else if (element.tagName === 'SELECT') for (const option of element.selectedOptions) fields.push([element.name, option.value]);
      else fields.push([element.name, element.value]);
    }
    return { url: target.href, fields, control: eventTarget ? eventTarget[0] : control.name };
  } finally { dom.window.close(); }
}

// inspection: { paused?, subscribe(listener) } relays the server session's paused/resumed events.
export async function invokePrivateTraditional(input, { vault = privateAppUserVault, fetchImpl = fetch, now = Date.now, timers = globalThis, inspection } = {}) {
  const plan = compileTraditionalEntry(input.contract), request = traditionalRequest(plan, input.inputs);
  o11NativeDirectory(input.root, input.directory);
  if (!/^[a-f0-9-]{36}$/.test(input.operationId ?? '') || !/^scenario-\d{1,3}$/.test(input.scenarioId ?? '') ||
      !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > 300 || input.context !== 'app-user') fail('invocation_invalid');
  const host = new URL(plan.binding.runtimeUrl).hostname;
  if (blockedBinding(input.root, host, plan.binding.moduleKey)) fail('binding_blocked');
  const parentLock = path.join(input.root, '.local/debugger/native-runs/o11', host, plan.binding.moduleKey + '.lock');
  if (!fs.existsSync(parentLock) || JSON.parse(fs.readFileSync(parentLock, 'utf8')).operationId !== input.operationId) fail('binding_lock_missing');
  const pin = input.contract.sourceContract;
  if (pin?.sha256 !== plan.binding.sourceSha256 || hash(fs.readFileSync(pin.path)) !== pin.sha256) fail('source_changed');
  const descriptor = validatePrivateDescriptor(input.descriptor);
  if (Date.parse(descriptor.expiresAt) <= now() || !sameAppUserTarget(descriptor.binding, appUserBinding(plan.binding, descriptor.binding.sessionId))) fail('app_user_scope_mismatch');
  const receiptPath = path.join(input.directory, 'traditional-' + input.scenarioId + '.json');
  const report = { schema: 'ssam-o11-traditional-receipt/1', operationId: input.operationId, scenarioId: input.scenarioId,
    binding: plan.binding, entryKey: plan.entry.key, ok: false, sent: false, answered: false, uncertain: false,
    loginSubmitted: false, loginAnswered: false, originalLoginForm: false, browser: false,
    requestOwnershipProved: false, appUserIdentityProved: false, rolesProved: false, propagationProved: false,
    preparationExecutionProved: false, memoryReferencesReleased: false, requests: [],
    ...(plan.screenAction ? { screenActionKey: plan.screenAction.key, actionSubmitted: false, actionAnswered: false } : {}) };
  let record, form, body, reserved = false, hardDeadlineAt, paused = inspection?.paused === true; const jar = new CookieJar(), deadlines = new Set();
  const unsubscribe = inspection?.subscribe?.(event => {
    if (!['paused', 'resumed'].includes(event?.kind)) return;
    paused = event.kind === 'paused'; for (const deadline of deadlines) paused ? deadline.pause() : deadline.resume();
  });
  const save = () => persist(receiptPath, report);
  const requestOriginal = async (url, method, phase, submittedBody, accept = 'text/html') => {
    if (Date.parse(descriptor.expiresAt) <= now()) fail('credentials_expired');
    const target = new URL(url);
    if (target.origin !== new URL(plan.binding.runtimeUrl).origin || !target.pathname.startsWith('/' + plan.binding.module + '/') ||
        target.username || target.password || target.hash) fail('request_denied');
    report.uncertain = true;
    if (phase === 'entry') report.sent = true;
    if (phase === 'login-submit') report.loginSubmitted = true;
    if (phase === 'action-submit') report.actionSubmitted = true;
    report.requests.push({ phase, method, sent: true, answered: false }); save();
    const headers = { Accept: accept }, cookies = await jar.getCookieString(url);
    if (cookies) headers.Cookie = cookies;
    if (submittedBody) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const deadline = createPauseAwareDeadline({ timeoutMs: input.timeoutSeconds * 1000, hardDeadlineAt, now, timers });
    if (paused) deadline.pause(); deadlines.add(deadline);
    let response, bytes;
    try {
      response = await fetchImpl(url, { method, headers, ...(submittedBody ? { body: submittedBody } : {}),
        redirect: 'manual', credentials: 'omit', signal: deadline.signal });
      if (response.url && response.url !== url) fail('response_url_changed');
      for (const cookie of response.headers.getSetCookie?.() ?? []) await jar.setCookie(cookie, url, { http: true });
      const chunks = [], reader = response.body?.getReader(); let size = 0;
      if (reader) while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); fail('response_limit'); } chunks.push(Buffer.from(next.value)); }
      bytes = Buffer.concat(chunks);
    } finally { deadlines.delete(deadline); deadline.dispose(); }
    report.requests.at(-1).answered = true; report.requests.at(-1).status = response.status;
    report.uncertain = false;
    if (phase === 'entry') report.answered = true;
    if (phase === 'login-submit') report.loginAnswered = true;
    if (phase === 'action-submit') report.actionAnswered = true;
    save(); return { response, bytes };
  };
  try {
    if (fs.existsSync(receiptPath)) {
      const previous = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (previous.operationId !== input.operationId || previous.scenarioId !== input.scenarioId) fail('receipt_scope_mismatch');
      for (const field of ['sent', 'answered', 'loginSubmitted', 'loginAnswered', 'actionSubmitted', 'actionAnswered']) if (field in report) report[field] = previous[field] === true;
      report.uncertain = previous.uncertain === true || report.sent && !report.answered || report.loginSubmitted && !report.loginAnswered || report.actionSubmitted === true && !report.actionAnswered;
      fail('scenario_already_submitted');
    }
    // Interactive inspection binds the fixed native lease; neither a pause nor a scenario extends it.
    if (input.inspectionExpiresAt !== undefined) {
      hardDeadlineAt = Date.parse(input.inspectionExpiresAt);
      if (typeof input.inspectionExpiresAt !== 'string' || !Number.isFinite(hardDeadlineAt) || hardDeadlineAt <= now() ||
          hardDeadlineAt - now() > 600000 || hardDeadlineAt > Date.parse(descriptor.expiresAt)) fail('inspection_deadline_invalid');
      report.inspection = { expiresAt: input.inspectionExpiresAt, fixed: true, pauseAware: true };
    }
    record = await vault('read', descriptor);
    if (!record.ok || record.kind !== 'credentials' || !sameAppUserTarget(record.binding, descriptor.binding) || Date.parse(record.expiresAt) <= now() ||
        typeof record.username !== 'string' || !record.username || typeof record.password !== 'string' || !record.password) fail('credentials_unavailable');
    fs.mkdirSync(input.directory, { recursive: true }); persist(receiptPath, report, true); reserved = true;
    const initial = await requestOriginal(plan.login.url, 'GET', 'login-page');
    if (initial.response.status !== 200 || !/^text\/html(?:;|$)/i.test(initial.response.headers.get('content-type') ?? '')) fail('login_page_unavailable');
    form = originalTraditionalLoginForm(initial.bytes.toString('utf8'), plan); report.originalLoginForm = true;
    body = new URLSearchParams(form.fields); body.set(form.username, record.username); body.set(form.password, record.password);
    body.set(...form.submit);
    const login = await requestOriginal(form.url, 'POST', 'login-submit', body.toString());
    body = null; form = null;
    if (![302, 303].includes(login.response.status)) fail('login_rejected');
    // Validate but do not follow the original login destination: the requested
    // screen is sent exactly once below, after the native login answered.
    const redirect = new URL(login.response.headers.get('location') ?? '', plan.login.url);
    if (redirect.origin !== new URL(plan.binding.runtimeUrl).origin || redirect.username || redirect.password ||
        !(await jar.getCookieString(request.url))) fail('login_context_unavailable');
    const result = await requestOriginal(request.url, 'GET', 'entry');
    const isHtml = response => /^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '');
    report.status = result.response.status;
    report.responseSha256 = hash(result.bytes);
    report.ok = result.response.status === 200 && isHtml(result.response);
    report.result = { outputs: {}, screenResponseReceived: report.ok };
    if (!plan.screenAction) return report;
    // Exactly one postback of the rendered form per scenario (the receipt is the post marker).
    if (!report.ok) fail('entry_page_unavailable');
    report.ok = false;
    const page = originalTraditionalActionForm(result.bytes.toString('utf8'), plan, request.url);
    body = new URLSearchParams(page.fields);
    // An OsAjax reply is text (the Service Center 'text' acceptance); no Ajax header is added.
    const posted = await requestOriginal(page.url, 'POST', 'action-submit', body.toString(), page.ajax ? '*/*' : 'text/html');
    body = null;
    const status = posted.response.status, redirected = [301, 302, 303, 307, 308].includes(status);
    if (redirected) {
      const target = new URL(posted.response.headers.get('location') ?? '', page.url);
      if (target.origin !== new URL(plan.binding.runtimeUrl).origin || target.username || target.password) fail('action_redirect_invalid');
    }
    report.postback = { method: plan.screenAction.method, control: page.control, status, redirectNotFollowed: redirected,
      fields: page.ajax ? 'rendered-form-osajax' : 'rendered-form', ajaxHeadersAdded: false, ...(page.ajax ? { ajax: page.ajax } : {}) };
    report.actionResponseSha256 = hash(posted.bytes);
    const kind = (posted.response.headers.get('content-type') ?? '').toLowerCase();
    report.ok = status === 200 && (page.ajax ? /^(?:text\/|application\/(?:json|javascript))/.test(kind) : isHtml(posted.response)) || [302, 303].includes(status);
    report.result = { outputs: {}, screenResponseReceived: true, screenActionResponseReceived: report.ok };
    return report;
  } catch (error) {
    report.error = publicCode(error); return report;
  } finally {
    unsubscribe?.(); for (const deadline of deadlines) deadline.dispose();
    if (record) { record.username = ''; record.password = ''; record = undefined; }
    form = null; body = null; await jar.removeAllCookies(); report.memoryReferencesReleased = true;
    if (reserved) save();
  }
}

const receiptUncertain = receipt => receipt.uncertain === true || receipt.sent && !receipt.answered ||
  receipt.loginSubmitted && !receipt.loginAnswered || receipt.actionSubmitted === true && !receipt.actionAnswered;
// options.inspection relays paused/resumed to the worker (one JSON line each after the input line)
// and suspends this outer timer while the server session holds the request.
export async function invokeTraditionalWorker(input, { inspection, timers = globalThis, spawnImpl = spawn, now = Date.now } = {}) {
  const file = fileURLToPath(import.meta.url), receiptPath = path.join(input.directory, 'traditional-' + input.scenarioId + '.json');
  // Known refusals before any child exists: nothing was written or sent, so nothing is uncertain.
  const refuse = code => ({ operationId: input.operationId, scenarioId: input.scenarioId, ok: false, sent: false, uncertain: false, error: 'debug_o11_native_traditional_' + code });
  if (inspection && typeof inspection.subscribe !== 'function') return refuse('inspection_events_invalid');
  if (input.inspectionExpiresAt !== undefined && !(Date.parse(input.inspectionExpiresAt) > now())) return refuse('inspection_deadline_invalid');
  return new Promise(resolve => {
    const child = spawnImpl(process.execPath, [file, '--private-traditional'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '', settled = false, unsubscribe = null, outer = null;
    const finish = value => { if (settled) return; settled = true; outer?.dispose(); unsubscribe?.(); try { child.stdin.end(); } catch {} resolve(value); };
    const recover = () => { try { const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (receipt.operationId === input.operationId && receipt.scenarioId === input.scenarioId) return { ...receipt,
        ok: false, uncertain: receiptUncertain(receipt), error: 'debug_o11_native_traditional_worker_ended' }; } catch {}
      return { ok: false, uncertain: true, error: 'debug_o11_native_traditional_worker_unavailable' }; };
    const lease = Date.parse(input.inspectionExpiresAt);
    outer = createPauseAwareDeadline({ timeoutMs: input.timeoutSeconds * 3000 + 15000, timers, now, hardDeadlineAt: Number.isFinite(lease) ? lease + 15000 : undefined,
      onExpire: () => { child.kill(); finish(recover()); } });
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) child.kill(); });
    child.on('error', () => finish(recover())); child.on('close', () => { try {
      const reply = JSON.parse(output); if (reply.operationId !== input.operationId || reply.scenarioId !== input.scenarioId) throw Error(); finish(reply);
    } catch { finish(recover()); } });
    child.stdin.on('error', () => {});
    if (!inspection) { child.stdin.end(JSON.stringify(input)); return; }
    child.stdin.write(JSON.stringify(input) + '\n');
    if (inspection.paused === true) { outer.pause(); child.stdin.write(JSON.stringify({ kind: 'paused' }) + '\n'); }
    unsubscribe = inspection.subscribe(event => {
      if (settled || !['paused', 'resumed'].includes(event?.kind)) return;
      event.kind === 'paused' ? outer.pause() : outer.resume();
      try { child.stdin.write(JSON.stringify({ kind: event.kind }) + '\n'); } catch {}
    });
  });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url && process.argv[2] === '--private-traditional') {
  // First line: the invocation. Later lines: paused/resumed events of the server session.
  const listeners = new Set(); let paused = false, buffer = '', started = null, input;
  const inspection = { get paused() { return paused; }, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const relay = line => { let event; try { event = JSON.parse(line); } catch { return; }
    if (!['paused', 'resumed'].includes(event?.kind)) return; paused = event.kind === 'paused'; for (const listener of [...listeners]) listener(event); };
  const run = async text => {
    let reply;
    try { input = JSON.parse(text); reply = await invokePrivateTraditional(input, { inspection }); }
    catch (error) {
      reply = { operationId: input?.operationId, scenarioId: input?.scenarioId, ok: false, uncertain: false, error: publicCode(error) };
      // A failure persisting cleanup must not turn a sent request into a clean
      // preflight refusal. The last durable marker owns that distinction.
      if (input?.directory && input?.scenarioId) try {
        const receipt = JSON.parse(fs.readFileSync(path.join(input.directory, 'traditional-' + input.scenarioId + '.json'), 'utf8'));
        if (receipt.operationId !== input.operationId || receipt.scenarioId !== input.scenarioId) throw Error('receipt mismatch');
        reply = { ...receipt, ...reply, uncertain: receiptUncertain(receipt) };
      } catch (readError) { if (readError.code !== 'ENOENT') reply.uncertain = true; }
    }
    process.stdout.write(JSON.stringify(reply), () => process.exit(0));
  };
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk; if (!started && buffer.length > 8 * 1024 * 1024) process.exit(2);
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!started) started = run(line); else relay(line);
    }
  }
  if (!started) started = run(buffer); else if (buffer.trim()) relay(buffer);
  await started;
}
