import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createO11Runner } from '../debug-o11-run.mjs';
import { debugRun, debugRunToolSchema } from '../debug-run.mjs';
import { compileTraditionalPreparation } from '../debug-o11-traditional.mjs';
import { appUserBinding } from '../debug-app-user.mjs';

const native = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-o11-traditional-native-reading.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-traditional-public-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = structuredClone(native.contract), file = path.join(root, 'source.oml');
  fs.writeFileSync(file, 'synthetic native Traditional transport model');
  contract.binding.sourceSha256 = hash(fs.readFileSync(file)); contract.sourceContract = { path: file, sha256: contract.binding.sourceSha256 };
  const target = contract.binding, events = [];
  // Pinned publication proof: the runner re-validates (and renews only elapsed) inventory evidence before running.
  const proofFile = path.join(root, 'inventory.json');
  fs.writeFileSync(proofFile, JSON.stringify({ host: target.host, capturedAtUtc: new Date().toISOString(),
    modules: [{ Name: target.module, Key: target.moduleKey, ApplicationKey: target.applicationKey, VersionId: target.revision, IsActive: true }] }));
  const inventoryProof = { path: proofFile, sha256: hash(fs.readFileSync(proofFile)) };
  const runO11 = createO11Runner({ root, native: {
    capture: async () => ({ target, versionId: target.revision, snapshot: contract.sourceContract, inventoryProof, readings: [contract.preparation] }),
    assets: async () => { throw Error('Traditional must not use AMD'); },
    acquireTraditional: async () => ({ contract, plan: compileTraditionalPreparation(contract) }),
    prepareUser: async (target, { sessionId }) => ({ ok: true, descriptor: { state: 'credentials-entered', authenticated: false,
      binding: appUserBinding(target, sessionId), credentialRef: randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString() } }),
    releaseUser: async () => { events.push('release'); return { ok: true }; },
    endpointPublicationCheck: async () => { events.push('publication'); },
    debug: async request => { events.push(request.op); return request.op === 'stop' ? { ok: true, state: 'stopped' }
      : { ok: true, state: 'connected', sessionId: 'd'.repeat(32) }; },
    traceRead: () => [], settle: async () => { events.push('settle'); },
    invokeTraditional: async () => { events.push('invoke'); return { ok: true, sent: true, answered: true,
      loginSubmitted: true, loginAnswered: true, uncertain: false, memoryReferencesReleased: true }; },
    ...overrides,
  } });
  const input = { op: 'run', lane: 'o11', host: target.host, module: target.module, moduleKey: target.moduleKey,
    applicationKey: target.applicationKey, runtimeUrl: target.runtimeUrl, action: '@' + contract.preparation.key,
    trace: 'none', inputs: {}, timeoutSeconds: 30 };
  return { input, events, call: raw => debugRun(debugRunToolSchema.parse(raw), { services: { runO11 } }) };
}

test('public Traditional preserves uncertain transport/login outcomes and never executes the next scenario', async t => {
  for (const failure of ['throw', 'login', 'entry']) {
    let sends = 0;
    const f = fixture(t, { invokeTraditional: async () => { sends++;
      if (failure === 'throw') throw Error('private transport details');
      return { ok: false, sent: failure === 'entry', answered: false, loginSubmitted: true,
        loginAnswered: failure === 'entry', uncertain: false, memoryReferencesReleased: true }; } });
    const input = { ...f.input, scenarios: [{ name: 'one', inputs: {} }, { name: 'two', inputs: {} }] };
    const result = await f.call(input);
    assert.equal(result.uncertain, true, result.error); assert.equal(result.lockRetained, true); assert.equal(sends, 1);
    assert.equal(result.credentialsReleased, true); assert.deepEqual(result.notSent, ['two']);
    assert.doesNotMatch(JSON.stringify(result), /private transport details/);
    assert.equal((await f.call(input)).error, 'debug_o11_native_binding_busy'); assert.equal(sends, 1);
  }
});

test('public Traditional keeps a known pre-send refusal distinct from an unknown execution outcome', async t => {
  const f = fixture(t, { invokeTraditional: async () => ({ ok: false, sent: false, answered: false, uncertain: false,
    loginSubmitted: false, loginAnswered: false, memoryReferencesReleased: true, error: 'debug_o11_native_traditional_credentials_expired' }) });
  const result = await f.call(f.input);
  assert.equal(result.uncertain, false, result.error); assert.equal(result.lockRetained, false);
  assert.equal(result.credentialsReleased, true); assert.equal(result.results[0].ok, false);
});

test('public Traditional retains an unknown Start and does not call the screen', async t => {
  let sends = 0;
  const f = fixture(t, { debug: async () => { throw Error('start transport lost'); }, invokeTraditional: async () => { sends++; } });
  const result = await f.call({ ...f.input, trace: 'full', depth: 4 });
  assert.equal(result.error, 'debug_o11_native_server_trace_start_uncertain');
  assert.equal(result.uncertain, true); assert.equal(result.lockRetained, true); assert.equal(sends, 0);
  assert.equal(result.credentialsReleased, true);
});

test('public runner preserves proven local start refusal without invoking or stopping a nonexistent worker', async t => {
  let sends = 0; const debugCalls = [];
  const f = fixture(t, { debug: async request => { debugCalls.push(request.op); return {
    ok: false, state: 'not-started', workerStarted: false, uncertain: false,
    sessionId: 'a'.repeat(32), receiptPath: 'local-failure-receipt', error: 'debug_o11_selected_studio_unavailable' };
  }, invokeTraditional: async () => { sends++; } });
  const result = await f.call({ ...f.input, trace: 'full', depth: 4 });
  assert.equal(result.ok, false); assert.equal(result.uncertain, false); assert.equal(result.lockRetained, false);
  assert.equal(result.debuggerStartFailure.error, 'debug_o11_selected_studio_unavailable');
  assert.equal(result.debuggerStartFailure.sessionId, 'a'.repeat(32));
  assert.equal(sends, 0); assert.deepEqual(debugCalls, ['start']);
  assert.equal(result.credentialsReleased, true);
});


// ---- Traditional screen-action postback (Submit / Ajax Submit), pause-aware deadline ----
import { EventEmitter } from 'node:events';
import { invokePrivateTraditional, invokeTraditionalWorker, createPauseAwareDeadline, originalTraditionalActionForm } from '../debug-o11-traditional-worker.mjs';
import { compileTraditionalScreenAction } from '../debug-o11-traditional.mjs';
import { actionContract, screenPage, html, loginForm, workerFixture as worker, original, timersFake, inspectionFake } from './fixtures/debug-o11-traditional-action-fixture.mjs';

const until = async condition => { for (let i = 0; i < 500 && !condition(); i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(condition(), 'condition not reached'); };

test('one original postback per scenario with the rendered __OSVSTATE/__VIEWSTATE and the button name; redirects are not followed', async t => {
  const { input, vault } = worker(t), requests = [];
  const result = await invokePrivateTraditional(input, { vault, fetchImpl: original(requests, () => new Response('', { status: 302, headers: { Location: '/HeadlessTrad_UI/ContactDetailWeb.aspx' } })) });
  assert.equal(result.ok, true, result.error); assert.equal(requests.length, 4);
  assert.equal(requests[2].method, 'GET'); assert.equal(requests[3].method, 'POST');
  assert.equal(new URL(requests[3].url).pathname, '/HeadlessTrad_UI/ContactsWeb.aspx');
  assert.deepEqual([...new URLSearchParams(requests[3].body)], [['__OSVSTATE', 'osv-rendered'], ['__VIEWSTATE', ''], ['__VIEWSTATEGENERATOR', 'C2EE9ABB'],
    ['wt5$wtSearch', 'rendered search'], ['wt6$wtActive', 'on'], ['wt9$wtSaveButton', 'Save']]);
  assert.match(requests[3].headers.Cookie, /OSAUTH=fixture/);
  assert.equal(result.actionSubmitted, true); assert.equal(result.actionAnswered, true); assert.equal(result.uncertain, false);
  assert.deepEqual(result.postback, { method: 'Submit', control: 'wt9$wtSaveButton', status: 302, redirectNotFollowed: true, fields: 'rendered-form', ajaxHeadersAdded: false });
  assert.equal(JSON.stringify(result).includes('fixture-password'), false); assert.equal(JSON.stringify(result).includes('osv-rendered'), false);
  const replay = await invokePrivateTraditional(input, { vault, fetchImpl: async () => { throw Error('must not send'); } });
  assert.match(replay.error, /scenario_already_submitted/); assert.equal(replay.uncertain, false); assert.equal(requests.length, 4);
});

test('Ajax Submit sends the rendered OsAjax request: serialized form without submit controls, event target, no button value, no added headers', async t => {
  const { input, vault } = worker(t, actionContract({ method: 'Ajax' })), requests = [];
  const reply = () => new Response('OsAjaxReply', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const result = await invokePrivateTraditional(input, { vault, fetchImpl: original(requests, reply, screenPage({ ajax: true })) });
  assert.equal(result.ok, true, result.error); assert.equal(requests.length, 4);
  // OsAjaxBaseBackend: OsSerializeForm (no submit inputs), unchecked boxes as "off", then the event of the rendered OsAjax call.
  assert.deepEqual([...new URLSearchParams(requests[3].body)], [['__OSVSTATE', 'osv-rendered'], ['__VIEWSTATE', ''], ['__VIEWSTATEGENERATOR', 'C2EE9ABB'],
    ['wt5$wtSearch', 'rendered search'], ['wt6$wtActive', 'on'], ['wt7$wtArchived', 'off'],
    ['__EVENTTARGET', 'wt9$wtSaveButton'], ['__EVENTARGUMENT', ''], ['__AJAX', '1280,1024,wt9_wtSaveButton,0,0,0,0,0,0,']]);
  assert.deepEqual(Object.keys(requests[3].headers).sort(), ['Accept', 'Content-Type', 'Cookie']);
  assert.deepEqual(result.postback, { method: 'Ajax Submit', control: 'wt9$wtSaveButton', status: 200, redirectNotFollowed: false, fields: 'rendered-form-osajax',
    ajaxHeadersAdded: false, ajax: { protocol: 'OsAjaxBaseBackend', controlId: 'wt9_wtSaveButton', eventTarget: 'wt9$wtSaveButton', fieldList: '__OSVSTATE,' } });
  assert.equal(result.result.screenActionResponseReceived, true);
  // The rendered control decides: a Submit plan on an OsAjax button, or an Ajax plan on a plain submit, is refused before any postback.
  for (const [contract, page, code] of [[actionContract(), screenPage({ ajax: true }), 'action_method_mismatch'], [actionContract({ method: 'Ajax' }), screenPage(), 'action_method_mismatch'],
    [actionContract({ method: 'Ajax' }), screenPage({ ajax: true, ajaxFields: '__OSVSTATE,wt5$wtSearch,' }), 'action_ajax_unsupported'],
    [actionContract({ method: 'Ajax' }), screenPage({ ajax: true, ajaxTarget: 'wt10' }), 'action_ajax_unsupported']]) {
    const f = worker(t, contract), seen = [];
    const refused = await invokePrivateTraditional(f.input, { vault: f.vault, fetchImpl: original(seen, () => { throw Error('must not post'); }, page) });
    assert.equal(refused.error, 'debug_o11_native_traditional_' + code); assert.equal(seen.length, 3);
    assert.equal(refused.actionSubmitted, false); assert.equal(refused.uncertain, false);
  }
});

test('a lost postback reply is uncertain and the scenario is never resent; a missing __OSVSTATE is refused before any postback', async t => {
  const lost = worker(t), requests = [];
  const result = await invokePrivateTraditional(lost.input, { vault: lost.vault, fetchImpl: original(requests, () => { throw new Error('connection lost'); }) });
  assert.equal(requests.length, 4); assert.equal(result.uncertain, true); assert.equal(result.actionSubmitted, true); assert.equal(result.actionAnswered, false);
  assert.equal(result.ok, false); assert.equal(result.memoryReferencesReleased, true);
  const replay = await invokePrivateTraditional(lost.input, { vault: lost.vault, fetchImpl: async () => { throw Error('must not send'); } });
  assert.equal(replay.uncertain, true); assert.match(replay.error, /scenario_already_submitted/); assert.equal(requests.length, 4);
  const stateless = worker(t), seen = [];
  const refused = await invokePrivateTraditional(stateless.input, { vault: stateless.vault, fetchImpl: original(seen, () => { throw Error('must not post'); }, screenPage({ state: false })) });
  assert.equal(refused.error, 'debug_o11_native_traditional_form_state_unavailable'); assert.equal(seen.length, 3);
  assert.equal(refused.uncertain, false); assert.equal(refused.actionSubmitted, false);
  const plan = compileTraditionalScreenAction(actionContract());
  assert.throws(() => originalTraditionalActionForm(screenPage({ action: 'https://other.example/HeadlessTrad_UI/ContactsWeb.aspx' }), plan, plan.entry.url), /form_route_changed/);
  assert.throws(() => originalTraditionalActionForm(screenPage().replace('wt9_wtSaveButton"', 'wt9_wtOther"'), plan, plan.entry.url), /action_control_unqualified/);
});

test('pause-aware deadline: paused time does not expire the request; a timeout after resume is uncertain without resend', async t => {
  for (const outcome of ['answered', 'timeout']) {
    const { input, vault } = worker(t, structuredClone(native.contract)); const requests = []; let release;
    input.inspectionExpiresAt = new Date(Date.now() + 120000).toISOString();
    const timers = timersFake(), inspection = inspectionFake();
    const fetchImpl = async (url, options) => { requests.push(url);
      if (requests.length === 1) return html(loginForm());
      if (requests.length === 2) return new Response('', { status: 302, headers: { Location: '/HeadlessTrad_UI/', 'Set-Cookie': 'OSAUTH=fixture; Path=/HeadlessTrad_UI/' } });
      return new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        release = () => resolve(html('<html>screen</html>')); }); };
    const running = invokePrivateTraditional(input, { vault, fetchImpl, timers, inspection });
    await until(() => release);
    inspection.emit({ kind: 'paused' }); timers.fire(5000);  // the server breakpoint holds the request
    assert.equal([...timers.pending.values()].filter(timer => timer.ms === 5000).length, 0, 'request timer suspended while paused');
    inspection.emit({ kind: 'resumed' });
    assert.equal([...timers.pending.values()].filter(timer => timer.ms === 5000).length, 1, 're-armed on resume');
    if (outcome === 'answered') release(); else timers.fire(5000);
    const result = await running;
    if (outcome === 'answered') { assert.equal(result.ok, true, result.error); assert.equal(result.uncertain, false); }
    else { assert.equal(result.ok, false); assert.equal(result.uncertain, true); assert.equal(result.sent, true); assert.equal(result.answered, false); }
    assert.equal(requests.length, 3); assert.equal(inspection.listeners.size, 0);
    assert.deepEqual(result.inspection, { expiresAt: input.inspectionExpiresAt, fixed: true, pauseAware: true });
    if (outcome === 'timeout') {
      const replay = await invokePrivateTraditional(input, { vault, fetchImpl: async () => { throw Error('must not resend'); } });
      assert.equal(replay.uncertain, true); assert.equal(requests.length, 3);
    }
  }
});

test('the fixed native lease is never paused and bounds the request; an invalid lease is refused before sending', async t => {
  const timers = timersFake(); let expired = 0;
  const deadline = createPauseAwareDeadline({ timeoutMs: 5000, hardDeadlineAt: 1000 + 30000, now: () => 1000, timers, onExpire: () => expired++ });
  assert.deepEqual([...timers.pending.values()].map(timer => timer.ms).sort((a, b) => a - b), [5000, 30000]);
  deadline.pause(); assert.deepEqual([...timers.pending.values()].map(timer => timer.ms), [30000]);
  timers.fire(30000); assert.equal(expired, 1); assert.equal(deadline.signal.aborted, true);
  deadline.resume(); assert.equal(timers.pending.size, 0, 'an expired deadline never re-arms'); deadline.dispose();
  const { input, vault } = worker(t, structuredClone(native.contract)); let sends = 0;
  for (const expiresAt of [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 700000).toISOString(), 'not-a-date']) {
    const refused = await invokePrivateTraditional({ ...input, scenarioId: 'scenario-' + (++sends), inspectionExpiresAt: expiresAt }, { vault, fetchImpl: async () => { throw Error('must not send'); } });
    assert.equal(refused.error, 'debug_o11_native_traditional_inspection_deadline_invalid'); assert.equal(refused.sent, false);
  }
});

test('the worker process relays pause/resume and suspends its own outer timer while paused', async () => {
  const timers = timersFake(), inspection = inspectionFake(), writes = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => child.emit('close');
  child.stdin = { on: () => {}, write: chunk => writes.push(String(chunk)), end: chunk => { if (chunk) writes.push(String(chunk)); } };
  const input = { operationId: randomUUID(), scenarioId: 'scenario-0', timeoutSeconds: 5, directory: os.tmpdir(), inspectionExpiresAt: new Date(Date.now() + 60000).toISOString() };
  const running = invokeTraditionalWorker(input, { inspection, timers, spawnImpl: () => child });
  assert.equal(JSON.parse(writes[0]).scenarioId, 'scenario-0');
  const outer = () => [...timers.pending.values()].filter(timer => timer.ms === 5 * 3000 + 15000).length;
  assert.equal(outer(), 1);
  inspection.emit({ kind: 'paused' }); assert.equal(outer(), 0); assert.deepEqual(JSON.parse(writes.at(-1)), { kind: 'paused' });
  inspection.emit({ kind: 'resumed' }); assert.equal(outer(), 1); assert.deepEqual(JSON.parse(writes.at(-1)), { kind: 'resumed' });
  child.stdout.emit('data', JSON.stringify({ operationId: input.operationId, scenarioId: 'scenario-0', ok: true })); child.emit('close');
  assert.equal((await running).ok, true); assert.equal(inspection.listeners.size, 0);
});

test('the worker parent refuses an expired lease or an inspection without subscribe before spawning: nothing sent, not uncertain', async () => {
  let spawned = 0; const spawnImpl = () => { spawned++; throw Error('must not spawn'); };
  const base = { operationId: randomUUID(), scenarioId: 'scenario-0', timeoutSeconds: 5, directory: os.tmpdir() };
  const expired = await invokeTraditionalWorker({ ...base, inspectionExpiresAt: new Date(Date.now() - 20000).toISOString() }, { inspection: inspectionFake(), spawnImpl });
  assert.deepEqual([expired.ok, expired.uncertain, expired.sent, expired.error, expired.operationId], [false, false, false, 'debug_o11_native_traditional_inspection_deadline_invalid', base.operationId]);
  const unsubscribable = await invokeTraditionalWorker({ ...base, inspectionExpiresAt: new Date(Date.now() + 60000).toISOString() }, { inspection: { paused: false }, spawnImpl });
  assert.deepEqual([unsubscribable.ok, unsubscribable.uncertain, unsubscribable.error], [false, false, 'debug_o11_native_traditional_inspection_events_invalid']);
  assert.equal(spawned, 0);
});

test('the real worker process answers a preflight refusal in both stdin modes without waiting for more events', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-traditional-process-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const inspection of [undefined, inspectionFake()]) {
    const input = { operationId: randomUUID(), scenarioId: 'scenario-0', timeoutSeconds: 5, directory, contract: { schema: 'not-a-contract' } };
    const reply = await invokeTraditionalWorker(input, inspection ? { inspection } : {});
    assert.equal(reply.ok, false); assert.equal(reply.uncertain, false); assert.equal(reply.error, 'debug_o11_native_traditional_contract_invalid');
    assert.equal(reply.operationId, input.operationId);
    if (inspection) assert.equal(inspection.listeners.size, 0);
  }
});
