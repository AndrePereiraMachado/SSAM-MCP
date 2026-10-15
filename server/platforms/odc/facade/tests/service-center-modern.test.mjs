// The code under test writes under the user's profile: this process's profile is a temporary folder.
import './fixtures/isolated-profile.mjs';
// Port of kernel/tests/test_service_center_modern.py (34 cases): modern Service Center pages (fixtures sc-pages/modern,
// copied from the realistic synthetic fixtures of the integrator): div[data-tab] tabs, __doPostBack anchors with the
// event fields added here, lists read only from the content (never Recent Items), OsAjax Next and Filter, the XLSX
// exports and the Web Forms hidden fields. Every postback is compared with the fixture's own request. Offline: a fake
// bridge, no Studio, Service Center or credential store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client, Journal } from '../service-center/client.mjs';
import { StudioWebTransport } from '../service-center/http.mjs';
import { BridgeError, LayoutError, ProtocolError } from '../service-center/errors.mjs';
import { main } from '../service-center/index.mjs';
import { sha256 } from '../service-center/util.mjs';
import { FakeBridge, MODERN, SC, fakeVault, files, html, readText, request, temp, uuid , zip } from './fixtures/sc-fake-bridge.mjs';

process.env.ANVIL_WORKER = '0'; process.env.ANVIL_ODC_NO_WORKER = '1';
// A pending private prompt is not waited for here (its bounded wait: pa2-f8-sc.test.mjs).
process.env.SSAM_PROMPT_WAIT_MS = '0';
const HOST = 'sc.example.test';
const SECRETS = ['sc_http:studioSession', 'sc_api:soap', 'sc_web', 'sc_web:secretRefs'];
const TIMER = SC + 'eSpace_Timer_Edit.aspx?EspaceKey=7c3d9e10-0000-4000-8000-00000000e102&Cyclic_Job_Key=9a8b7c6d-0000-4000-8000-00000000c001';
const PROPERTY = id => SC + `eSpace_SiteProperty_Edit.aspx?SitePropertyId=${id}&EspaceId=102`;
const ESPACE = `GET ${SC}eSpace_Edit.aspx?EspaceId=102`;

// An OsAjax reply as the bridge returns any non-HTML text for accept=html.
const reply = (name, contentType = 'text/javascript') => () => ({ ok: true, status: 200, finalUrl: `https://${HOST}${SC}X.aspx`, contentType, html: readText(path.join(MODERN, name)) });
const client = (bridge, exports = null) => Object.assign(new Client(fakeVault(HOST), new StudioWebTransport(HOST, bridge), exports), {downloadOptions:{principal:'synthetic-user'}});
const isProtocol = pattern => e => e instanceof ProtocolError && (!pattern || pattern.test(e.message));

function setup() {
  const dir = temp();
  const journal = new Journal(path.join(dir, 'receipts'));
  return { dir, journal, execute: (c, action, args, words = 'go') => c.webWrite(action, args, { execute: true, words, operationId: uuid(), journal }) };
}
// [path, form, accept, write] of a POST the facade sent.
const sent = (bridge, index = -1) => { const call = bridge.posts().at(index); return [call[3], call[4], call[5], call[6]]; };
// The POST equals the fixture's own request (path and form), with the named fields changed (null = absent).
function assertForm(fixture, bridge, index = -1, changes = {}) {
  const expected = request(fixture);
  const form = { ...expected.form };
  for (const [key, value] of Object.entries(changes)) {
    const name = Object.hasOwn(form, key) ? key : Object.keys(form).find(k => k.endsWith(key)) ?? key;
    if (value === null) delete form[name]; else form[name] = value;
  }
  const [pagePath, posted] = sent(bridge, index);
  assert.equal(pagePath, expected.path);
  assert.deepEqual(posted, form);
}
const mainDeps = (bridge, s, extra = {}) => ({ journal: s.journal, locate: () => bridge, present: async () => false, running: async () => false,
  opener: () => assert.fail('no prompt'), exports: s.dir, ...extra });

// ---- logs
test('error log rows come from the content and Next is the page\'s own postback', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Error_Logs.aspx`]: html('logs/error-logs.page1.html'), [`POST ${SC}Error_Logs.aspx`]: html('logs/error-logs.page2-last.html') } });
  const result = await client(bridge).logs('error', 50);
  assert.equal(result.rows.length, 5);
  assert.equal(result.truncated, false);
  assert.equal(result.rows[0].fields.Message, "Invalid object name 'OSUSR_SYN_ORDER1'.");
  assert.equal(result.rows[0].links[0].href, `https://${HOST}${SC}Show_Error.aspx?Error_Id=c0ffee00-0000-4000-8000-0000000e0001`);
  const evidence = JSON.stringify(result);
  for (const decoy of ['RecentDecoy', 'Licensed to', 'Apply Settings']) assert.ok(!evidence.includes(decoy), decoy);
  // The live link declares an OsAjax event; the legacy empty-name postback can
  // return an unrelated empty page and must not be treated as the next page.
  assertForm('logs/error-logs.next.ajax.request.json', bridge, -1, {'wt9$wtContentTop$wtEnableSearchStackTracer':'off'});
  assert.equal(sent(bridge)[3], false);
});

test('an OsAjax reply to Next is read through its state and markup', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Error_Logs.aspx`]: html('logs/error-logs.page1.html'), [`POST ${SC}Error_Logs.aspx`]: reply('logs/error-logs.next.osajax-reply.txt') } });
  const result = await client(bridge).logs('error', 50);
  assert.deepEqual(result.rows.slice(3).map(r => r.fields.Message), ['Synthetic second-page error A', 'Synthetic second-page error B']);
  assert.deepEqual([result.truncated, result.paginationUnsupported], [false, undefined]);
});

test('an unknown OsAjax reply stops paging without inventing rows', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Error_Logs.aspx`]: html('logs/error-logs.page1.html'),
    [`POST ${SC}Error_Logs.aspx`]: () => ({ ok: true, status: 200, contentType: 'text/plain', finalUrl: `https://${HOST}${SC}Error_Logs.aspx`, html: 'OK' }) } });
  const result = await client(bridge).logs('error', 50);
  assert.deepEqual([result.rows.length, result.truncated, result.paginationUnsupported], [3, true, true]);
  assert.ok(result.paginationError.includes('page-layout'));
});

test('an empty log is empty, not unknown', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Error_Logs.aspx`]: html('logs/error-logs.empty.html') } });
  const result = await client(bridge).logs('error', 50);
  assert.deepEqual([result.rows, result.truncated], [[], false]);
});

test('filter postback and stack search match the fixture', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Error_Logs.aspx`]: html('logs/error-logs.page1.html'),
    [`POST ${SC}Error_Logs.aspx`]: [html('logs/error-logs.page1.html'), html('logs/error-logs.page2-last.html')] } });
  const result = await client(bridge).logs('error', 3, { application: 'Sample Orders', module: 'SampleOrders' }, { stackContains: 'Invalid object' });
  assertForm('logs/error-logs.filter.request.json', bridge, 0);
  assert.deepEqual([result.rows.length, result.truncated], [3, true]);
  assert.equal(result.effectiveFilters.message, 'Invalid object');
});

test('the error log export is the full XLSX', async () => {
  const s = setup();
  const body = fs.readFileSync(path.join(MODERN, 'logs', 'ErrorLog.xlsx'));
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Error_Logs.aspx`]: html('logs/error-logs.page1.html'),
    [`POST ${SC}Error_Logs.aspx`]: (f, a) => (a === 'xlsx' ? body : assert.fail('export is xlsx')) } });
  const result = await client(bridge, s.dir).logs('error', 100, null, { exportAll: true });
  assertForm('logs/error-logs.export.request.json', bridge);
  assert.deepEqual([result.rowCount, result.columns[0]], [5, 'Tenant_Id']);
  assert.equal(result.rows[0].INSTANT, '2026-10-01 14:03:12');
  assert.equal(result.export.sha256, sha256(body));
});

test('the integration filter is OsAjax and the export reuses its refreshed state', async () => {
  const s = setup();
  const filters = { module: 'SampleOrders', type: 'REST (Consume)', action: 'SampleCatalogApi', since: '2026-10-01', until: '2026-10-02' };
  const body = fs.readFileSync(path.join(MODERN, 'logs', 'IntegrationsLog.xlsx'));
  const pages = { [`GET ${SC}Integration_Logs.aspx`]: html('logs/integration-logs.page1.html') };
  let bridge = new FakeBridge({ pages: { ...pages, [`POST ${SC}Integration_Logs.aspx`]: reply('logs/integration-logs.filter.osajax-reply.txt') } });
  const listed = await client(bridge).logs('integration', 50, filters);
  // The historical fixture includes a submit value excluded by native OsSerializeForm.
  assertForm('logs/integration-logs.filter.osajax.request.json', bridge, -1, {'wt9$wtContentTop$wtFilter':null});
  assert.deepEqual(listed.rows.map(r => r.fields.Action), ['SampleCatalogApi.GetItems']);
  assert.equal(Object.hasOwn(listed.effectiveFilters, 'message'), false);
  assert.equal(Object.hasOwn(listed.effectiveFilters, 'source'), false);
  assert.equal(listed.effectiveFilters.action, 'SampleCatalogApi');
  bridge = new FakeBridge({ pages: { ...pages, [`POST ${SC}Integration_Logs.aspx`]: [reply('logs/integration-logs.filter.osajax-reply.txt'), body] } });
  const exported = await client(bridge, s.dir).logs('integration', 50, filters, { exportAll: true });
  assertForm('logs/integration-logs.export.request.json', bridge);
  assert.deepEqual([sent(bridge)[2], exported.rowCount], ['xlsx', 2]);
});

test('log filters from another kind are refused before any HTTP request', async () => {
  for (const [kind, filters, options] of [
    ['integration', { message: '' }], ['integration', { source: '' }],
    ['timer', { message: 'ProcessQueue' }], ['error', { action: 'GetItems' }],
    ['general', { type: 'SOAP (Expose)' }], ['integration', {}, { stackContains: 'stack' }],
    ['error', { message: 'msg' }, { stackContains: 'stack' }]
  ]) {
    const bridge = new FakeBridge();
    await assert.rejects(client(bridge).logs(kind, 10, filters, options), e => e.code === 'SC_LOG_FILTER_UNSUPPORTED');
    assert.deepEqual(bridge.calls, []);
  }
});

test('assumed general and timer logs read their listing (Timers is Cyclic_Job_Logs.aspx, filtered by Name) and refuse another', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}General_Logs.aspx`]: html('logs/general-logs.page1.html'), [`GET ${SC}Cyclic_Job_Logs.aspx`]: html('logs/timer-logs.page1.html') } });
  assert.equal((await client(bridge).logs('general', 10)).rows[0].fields['Message Type'], 'INFO');
  assert.equal((await client(bridge).logs('timer', 10)).rows[0].fields.Timer, 'ProcessQueue');
  // The live timer filter is the text input labelled "Name".
  const timers = client(bridge);
  const [, updates] = timers.logFilters('timer', await timers.get('Cyclic_Job_Logs.aspx'), { timer: 'ProcessQueue' });
  assert.deepEqual(updates, { 'wt9$wtContentTop$wtInput1': 'ProcessQueue' });
  bridge.pages[`GET ${SC}Cyclic_Job_Logs.aspx`] = html('logs/timer-logs.page1.html', ['>Timer</th>', '>Job</th>']);
  await assert.rejects(client(bridge).logs('timer', 10), e => e instanceof LayoutError
    && e.code === 'LAYOUT_UNKNOWN' && e.extra.continuation.arguments.action === 'page-layout' && e.extra.continuation.arguments.path === 'Cyclic_Job_Logs.aspx');
});

test('error detail reads only the content', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Show_Error.aspx?Error_Id=c0ffee00-0000-4000-8000-0000000e0001`]: html('logs/show-error.html') } });
  const detail = (await client(bridge).errorDetail('c0ffee00-0000-4000-8000-0000000e0001')).detail;
  assert.ok(detail.includes('   at ssSampleOrders.Flows.FlowMainFlow.ScrnOrders.Preparation(HeContext heContext)'));
  assert.ok(detail.includes('0a1b2c3d-0000-4000-8000-00000000f001'));
  for (const decoy of ['RecentDecoy', 'Licensed to', 'licensee@example.test']) assert.ok(!detail.includes(decoy), decoy);
});

// ---- module tabs
const modulePages = () => ({ [ESPACE]: html('factory/espace-edit.html') });

test('tabs are inline panels and Recent Items are ignored', async () => {
  const c = client(new FakeBridge({ pages: modulePages() }));
  const timers = await c.resources('102', 'timers');
  assert.deepEqual([timers.tab, timers.rows.map(r => r.fields.Name)], ['tab-Timers', ['ProcessQueue', 'NightlyCleanup']]);
  assert.equal(timers.rows[0].links[0].href, `https://${HOST}${TIMER}`);
  const props = await c.resources('102', 'site-properties');
  assert.deepEqual(props.rows.map(r => r.fields.Name), ['MaxBatchSize', 'FeatureEnabled', 'PartnerApiToken']);
  assert.deepEqual(new Set(props.rows.map(r => r.fields['Effective Value'])), new Set(['<redacted>']));
  const found = (await c.integrations('102')).integrations;
  assert.deepEqual(found.map(i => [i.kind, i.id, i.name]), [['exposed-rest', '35', 'SampleOrdersApi'], ['consumed-rest', '122', 'SampleCatalogApi'], ['consumed-soap', '20', 'SampleLegacyService']]);
  assert.ok(!JSON.stringify([timers, props, found]).includes('Decoy'));
});

test('current WebServices integration panel excludes links in other module tabs', async () => {
  const current = html('factory/espace-edit.html').replaceAll('tab-Integrations', 'tab-WebServices')
    .replace('aria-labelledby="Versions" aria-hidden="false">', 'aria-labelledby="Versions" aria-hidden="false"><a href="eSpace_RestExpose_Edit.aspx?RestExposeId=987">OtherTabApi</a>');
  const result = await client(new FakeBridge({ pages: { [ESPACE]: current } })).integrations('102');
  assert.equal(result.tab, 'tab-WebServices');
  assert.deepEqual(result.integrations.map(i => i.name), ['SampleOrdersApi', 'SampleCatalogApi', 'SampleLegacyService']);
});

test('integration tab ambiguity and unknown module layouts cannot become empty lists', async () => {
  const original = html('factory/espace-edit.html');
  const dual = original.replace('aria-labelledby="Integrations" aria-hidden="true">', '$&<div data-tab="tab-WebServices"><table><tr><th>Name</th></tr></table></div>');
  assert.notEqual(dual, original);
  const pending = '<form><div class="sc-content-main"><div data-tab="tab-WebServices">Loading Integrations</div></div></form>';
  for (const source of [dual, original.replaceAll('tab-Integrations', 'tab-UnknownIntegrations'), pending, '<form><div class="sc-content-main">Unavailable</div></form>']) {
    await assert.rejects(client(new FakeBridge({ pages: { [ESPACE]: source } })).integrations('102'), e => e instanceof LayoutError);
  }
});

test('exposed SOAP runtime links are listed without inventing a logging editor or calling the service', async () => {
  const table = '<table id="x_wtListWebService"><thead><tr><th>Name</th><th>Internal Access</th><th>HTTP Security</th><th>Integrated Authentication</th></tr></thead><tbody><tr><td><a data-name="webservices_exposedwebservice" href="/Demo/(000000)/Probe.asmx">Probe</a></td><td></td><td>SSL/TLS</td><td></td></tr></tbody></table>';
  const page = '<form><div class="sc-content-main"><div data-tab="tab-WebServices">'+table+'</div></div><div id="RecentItems">'+table.replaceAll('Probe','Decoy')+'</div></form>';
  const bridge = new FakeBridge({pages:{[ESPACE]:page}}), c=client(bridge);
  const listing = await c.integrations('102');
  assert.equal(listing.integrations.length,1);
  assert.deepEqual([listing.integrations[0].name,listing.integrations[0].id,listing.integrations[0].loggingAvailable],['Probe',null,false]);
  const detail=await c.integrationDetail('102','Probe','exposed-soap');
  assert.equal(detail.currentLevel,null);assert.deepEqual(detail.availableLevels,[]);assert.equal(detail.configurationAvailable,false);
  await assert.rejects(setup().execute(c,'integration-log-level',{moduleId:'102',integration:'Probe',kind:'exposed-soap',level:'Full'}), /runtime link only/);
  assert.equal(bridge.posts().length,0);
  assert.ok(bridge.calls.filter(x=>x[0]==='web').every(x=>x[3].startsWith('/ServiceCenter/eSpace_Edit.aspx')));
  for(const invalid of [page.replace('HTTP Security','Logging Level'),page.replace('/Demo/(000000)/Probe.asmx','https://other.example.test/Probe.asmx')]) {
    await assert.rejects(client(new FakeBridge({pages:{[ESPACE]:invalid}})).integrations('102'));
  }
});

test('a property value is redacted unless asked and never when masked', async () => {
  const pages = { ...modulePages(), [`GET ${PROPERTY(501)}`]: html('site-properties/site-property-edit.integer.html'), [`GET ${PROPERTY(503)}`]: html('site-properties/site-property-edit.secret.html') };
  const c = client(new FakeBridge({ pages }));
  assert.equal((await c.propertyValue('102', 'MaxBatchSize')).value, '<redacted>');
  assert.equal((await c.propertyValue('102', 'MaxBatchSize', true)).value, '250');
  const shown = await c.propertyValue('102', 'PartnerApiToken', true);
  assert.deepEqual([shown.value, shown.secret, shown.revealed], ['<redacted>', true, false]);
});

test('a tab header without its panel is an unknown layout', async () => {
  const page = html('factory/espace-edit.html', ['class="tabs-content-item" data-tab="tab-Timers"', 'class="tabs-content-item" data-pane="tab-Timers"']);
  await assert.rejects(client(new FakeBridge({ pages: { [ESPACE]: page } })).resources('102', 'timers'), e => e instanceof LayoutError);
});

// ---- timers and site properties
const timerBridge = (timer, post, extra = {}, options = {}) => new FakeBridge({ pages: { ...modulePages(), [`GET ${TIMER}`]: timer, [`POST ${SC}eSpace_Timer_Edit.aspx`]: post, ...extra }, ...options });
const mutate = (s, bridge, action, name = 'ProcessQueue', extra = {}) => client(bridge).mutate(action, '102', name, { execute: true, words: 'go', operationId: uuid(), journal: s.journal, ...extra });

test('a malformed native timer schedule refuses activation before any reservation or POST',async()=>{
 const s=setup();
 const invalid=html('timers/timer-edit.inactive.html',
  ['wtSchedule_Time','wtInputTimerTimes'],['wtSchedule_Recurrence','wtSelectScheduleType'],['value="03:00"','value="Every "']);
 const bridge=timerBridge(invalid,()=>assert.fail('must not post'));
 const operationId=uuid();
 await assert.rejects(mutate(s,bridge,'timer-activate','ProcessQueue',{operationId}),e=>e.code==='TIMER_SCHEDULE_INVALID');
 assert.equal(bridge.posts().length,0);assert.equal(fs.existsSync(s.journal.path(operationId)),false);
});

test('Run Now posts the fixture form and only means scheduled', async () => {
  const s = setup();
  const bridge = timerBridge(html('timers/timer-edit.active.html'), html('timers/timer-run-now.response.html'));
  const receipt = await mutate(s, bridge, 'timer-run');
  assertForm('timers/timer-run-now.request.json', bridge);
  assert.deepEqual([receipt.state, receipt.executionCompleted, sent(bridge)[3]], ['accepted', false, true]);
  const refused = await mutate(s, timerBridge(html('timers/timer-edit.active.html'), html('timers/timer-run-now.error.html')), 'timer-run');
  assert.deepEqual([refused.ok, refused.state], [false, 'uncertain']);
});

test('deactivate and activate are confirmed by the opposite button', async () => {
  const s = setup();
  const state = ['timers/timer-edit.active.html'];
  const post = form => { state[0] = Object.hasOwn(form, 'wt9$wtContentTop$wtDeactivateButton') ? 'timers/timer-edit.inactive.html' : 'timers/timer-activate.response.html'; return html(state[0]); };
  const bridge = timerBridge(() => html(state[0]), post);
  assert.equal((await mutate(s, bridge, 'timer-deactivate')).state, 'confirmed');
  assertForm('timers/timer-deactivate.request.json', bridge);
  assert.equal((await mutate(s, bridge, 'timer-activate')).state, 'confirmed');
  assert.equal(sent(bridge)[1]['wt9$wtContentTop$wtActivateButton'], 'Activate');
});

test('an acknowledged toggle that leaves the opposite state resolves without repeating the POST',async()=>{
 const s=setup();
 const bridge=timerBridge(html('timers/timer-edit.inactive.html'),html('timers/timer-activate.response.html'));
 const c=client(bridge);
 const receipt=await c.mutate('timer-activate','102','ProcessQueue',{execute:true,words:'go',operationId:uuid(),journal:s.journal});
 assert.equal(receipt.state,'uncertain');assert.equal(bridge.posts().length,1);
 const verified=await c.verify(receipt,s.journal);
 assert.equal(verified.state,'not-executed');assert.equal(bridge.posts().length,1);
 assert.equal(verified.observedDesiredState,false);
});

test('Run Now saves its pre-send log baseline and verify observes an exact new log without resending', async () => {
  const s = setup();
  const bridge = timerBridge(html('timers/timer-edit.active.html'), html('timers/timer-run-now.response.html'));
  const c = client(bridge);
  let rows = [];
  c.logs = async (kind, _limit, filters) => {
    assert.equal(kind, 'timer'); assert.equal(filters.timer, 'ProcessQueue');
    return { complete: true, truncated: false, rows };
  };
  const operationId = uuid();
  const receipt = await c.mutate('timer-run', '102', 'ProcessQueue', { execute: true, words: 'go', operationId, journal: s.journal });
  assert.equal(s.journal.lookup(operationId, receipt.identity).plan.timerLogBaseline.available, true);
  const writes = bridge.posts().length;
  rows = [{ fields: { 'Time of Log': '2026-10-09 01:00:00', Timer: 'ProcessQueue', Duration: '0s' },
    links: [{ href: 'https://' + HOST + TIMER + '&EspaceId=102' }] }];
  const result = await c.verify(receipt, s.journal);
  assert.equal(result.executionObserved, true);
  assert.equal(result.executionCompleted, null);
  assert.equal(result.attributedToRequest, false);
  assert.equal(result.state, 'accepted');
  assert.equal(result.replayed, false);
  assert.equal(bridge.posts().length, writes);
});

test('unacknowledged Run Now resolves its receipt when readback finds a new exact timer log',async()=>{
  const s=setup();let sentRun=false;
  const bridge=timerBridge(html('timers/timer-edit.active.html'),()=>{sentRun=true;return '<div>Response received</div>';});
  const c=client(bridge);
  c.logs=async()=>({complete:true,truncated:false,rows:sentRun?[{
    fields:{'Time of Log':'2026-10-14 19:30:01',Timer:'ProcessQueue',Duration:'0s'},
    links:[{href:'https://'+HOST+TIMER+'&EspaceId=102'}]
  }]:[]});
  const result=await c.mutate('timer-run','102','ProcessQueue',{execute:true,words:'run',operationId:uuid(),journal:s.journal});
  assert.equal(result.outcome,'execution-observed');assert.equal(result.state,'confirmed');
  assert.equal(result.requestStatus,'unconfirmed');assert.equal(result.attributedToRequest,false);
  assert.equal(result.evidence.basis,'new-exact-timer-log-rows');assert.equal(bridge.posts().length,1);
  assert.equal(s.journal.holder(Journal.targetOf(result.identity)),null);
});

test('the schedule is set by its controls and read back', async () => {
  const s = setup();
  const state = [html('timers/timer-edit.active.html')];
  const post = () => {
    state[0] = html('timers/timer-schedule.response.html', ['<option value="__ossli_0" selected="selected">Daily</option>', '<option value="__ossli_0">Daily</option>'],
      ['<option value="__ossli_3">Every N minutes', '<option value="__ossli_3" selected="selected">Every N minutes'],
      ['name="wt9$wtContentMain$wtSchedule_Interval" type="text" value=""', 'name="wt9$wtContentMain$wtSchedule_Interval" type="text" value="15"']);
    return state[0];
  };
  const bridge = timerBridge(() => state[0], post);
  const plan = await client(bridge).mutate('timer-schedule', '102', 'ProcessQueue', { value: { recurrence: 'every n minutes', every: '15' } });
  assert.deepEqual([plan.currentSchedule, plan.schedule], [{ recurrence: 'Daily', at: '03:00', every: '', timeout: '20' }, { recurrence: 'Every N minutes', every: '15' }]);
  const receipt = await mutate(s, bridge, 'timer-schedule', 'ProcessQueue', { value: { recurrence: 'Every N minutes', every: '15' } });
  assertForm('timers/timer-schedule.request.json', bridge);
  assert.equal(receipt.state, 'confirmed');
  const verified = await client(bridge).verify(receipt, s.journal);
  assert.equal(verified.observedDesiredState, true);
  await assert.rejects(client(bridge).mutate('timer-schedule', '102', 'ProcessQueue', { value: { recurrence: 'Hourly' } }), isProtocol(/option/));
});

// C40 (2026-10-05): a timer page whose schedule editor is not identified is no unknown layout and asks for no capture:
// the schedule goes through the module (the timer's Schedule property), refused before anything is reserved or sent.
test('a timer page without its schedule editor routes the schedule to the module, sending nothing', async () => {
  const s = setup();
  const page = html('timers/timer-edit.active.html', ['wtSchedule_Recurrence"', 'wtRecurrence"'], ['>Recurrence</label>', '>Repeat</label>']);
  const bridge = timerBridge(page, () => assert.fail('nothing is sent'));
  await assert.rejects(main(['timer-schedule', '--host', HOST, '--module-id', '102', '--name', 'ProcessQueue', '--schedule-every', '15'], mainDeps(bridge, s)),
    e => !(e instanceof LayoutError) && e.code === 'TIMER_SCHEDULE_IN_MODULE' && e.extra.continuation.tool === 'o11_deliver'
      && e.op.value === '00:00 00:15 00:30 00:45 01:00 01:15 01:30 01:45 02:00 02:15 02:30 02:45 03:00 03:15 03:30 03:45 04:00 04:15 04:30 04:45 05:00 05:15 05:30 05:45 06:00 06:15 06:30 06:45 07:00 07:15 07:30 07:45 08:00 08:15 08:30 08:45 09:00 09:15 09:30 09:45 10:00 10:15 10:30 10:45 11:00 11:15 11:30 11:45 12:00 12:15 12:30 12:45 13:00 13:15 13:30 13:45 14:00 14:15 14:30 14:45 15:00 15:15 15:30 15:45 16:00 16:15 16:30 16:45 17:00 17:15 17:30 17:45 18:00 18:15 18:30 18:45 19:00 19:15 19:30 19:45 20:00 20:15 20:30 20:45 21:00 21:15 21:30 21:45 22:00 22:15 22:30 22:45 23:00 23:15 23:30 23:45' && e.op.target === 'ITimer:ProcessQueue');
  assert.deepEqual(bridge.posts(), []);
});

const propertyBridge = (id, page, post, after = null, options = {}) => new FakeBridge({ pages: { ...modulePages(),
  [`GET ${PROPERTY(id)}`]: after ? () => after[0] : page, [`POST ${SC}eSpace_SiteProperty_Edit.aspx`]: post }, ...options });

test('a property value from a file is posted and read back', async () => {
  const s = setup();
  const after = [html('site-properties/site-property-edit.integer.html')];
  const bridge = propertyBridge(501, null, () => { after[0] = html('site-properties/site-property-set.response.html'); return after[0]; }, after);
  const receipt = await mutate(s, bridge, 'property-set', 'MaxBatchSize', { value: '500' });
  assertForm('site-properties/site-property-set.request.json', bridge);
  assert.deepEqual([receipt.state, receipt.plan.value], ['confirmed', '<redacted>']);
});

test('a false boolean leaves the checkbox out', async () => {
  const s = setup();
  const after = [html('site-properties/site-property-edit.boolean.html')];
  const bridge = propertyBridge(502, null, () => { after[0] = html('site-properties/site-property-edit.boolean.html', [' checked="checked"', '']); return after[0]; }, after);
  assert.equal((await mutate(s, bridge, 'property-set', 'FeatureEnabled', { value: 'false' })).state, 'confirmed');
  assertForm('site-properties/site-property-set.boolean-false.request.json', bridge);
});

test('a secret property goes only as a vault reference', async () => {
  const s = setup();
  const target = `SSAM/O11/${HOST}/SiteProperty/PartnerApiToken`;
  const secret = html('site-properties/site-property-edit.secret.html');
  const bridge = propertyBridge(503, secret, () => html('site-properties/site-property-set.secret.response.html'), null, { capabilities: SECRETS });
  await assert.rejects(mutate(s, bridge, 'property-set', 'PartnerApiToken', { value: 'typed-in-chat' }), isProtocol(/value-vault/));
  const receipt = await mutate(s, bridge, 'property-set', 'PartnerApiToken', { secret: target });
  assertForm('site-properties/site-property-set.secret.request.json', bridge, -1, { wtInput_Value: '' });
  assert.deepEqual(bridge.refsOf(bridge.posts().at(-1)), [{ pointer: '/wt9$wtContentMain$wtInput_Value', target, field: 'password' }]);
  assert.deepEqual([receipt.state, receipt.valueVerified], ['accepted', false]);
  const receipts = path.join(s.dir, 'receipts');
  assert.ok(!(JSON.stringify(receipt) + files(receipts).map(f => fs.readFileSync(path.join(receipts, f), 'utf8')).join('')).includes('typed-in-chat'));
  const old = propertyBridge(503, secret, () => assert.fail('never posted'));
  await assert.rejects(mutate(s, old, 'property-set', 'PartnerApiToken', { secret: target }), e => e instanceof BridgeError && e.code === 'STUDIO_BRIDGE_OUTDATED');
});

test('a missing site property credential opens its private prompt before any reservation; nothing is posted', async () => {
  const s = setup();
  const prompts = [];
  const bridge = propertyBridge(503, html('site-properties/site-property-edit.secret.html'), () => assert.fail('never posted'), null, { capabilities: SECRETS });
  await assert.rejects(main(['property-set', '--host', HOST, '--module-id', '102', '--name', 'PartnerApiToken', '--value-vault', `SSAM/O11/${HOST}/SiteProperty/PartnerApiToken`,
    '--execute', '--operation-id', uuid(), '--words', 'set PartnerApiToken on sc', '--confirm-host', HOST],
  mainDeps(bridge, s, { promptWaitMs: 0, opener: (host, kind, name = null) => { prompts.push([kind, name]); return { opened: true }; } })),
  e => e.code === 'CREDENTIAL_PROMPT_PENDING' && e.auth.target === `SSAM/O11/${HOST}/SiteProperty/PartnerApiToken`);
  assert.deepEqual(prompts, [['SiteProperty', 'PartnerApiToken']]);
  assert.equal(fs.existsSync(path.join(s.dir, 'receipts')), false);
});

// ---- database connections
const TARGET = `SSAM/O11/${HOST}/DatabaseConnection/SampleWarehouse`;
const ROW = '<tr>\n\t\t\t<td class="table-row"><a class="link" href="DatabaseConnection_Edit.aspx?DBConnectionId=7">SampleWarehouse</a></td><td class="table-row">SqlServer</td><td class="table-row">db.example.test / warehouse</td>\n\t\t</tr>';
const listing = (present = true) => html('dbconnections/dbconnections-list.html', ...(present ? [] : [[ROW, '']]));

test('create sends the fixture form with vault references for the login', async () => {
  const s = setup();
  const created = [];
  const bridge = new FakeBridge({ pages: { [`GET ${SC}DatabaseConnections_List.aspx`]: () => listing(created.length > 0),
    [`GET ${SC}DatabaseConnection_Edit.aspx`]: html('dbconnections/dbconnection-edit.new.html'),
    [`POST ${SC}DatabaseConnection_Edit.aspx`]: () => { created.push(1); return listing(); } }, capabilities: SECRETS });
  const receipt = await s.execute(client(bridge), 'db-connection-create', { connection: 'SampleWarehouse', server: 'db.example.test', database: 'warehouse', parameters: {} });
  assert.equal(receipt.state, 'confirmed');
  assertForm('dbconnections/dbconnection-create.request.json', bridge, -1, { 'ctl00$wt173': '', 'ctl02$wt133': '' });
  assert.deepEqual(bridge.refsOf(bridge.posts().at(-1)), [{ pointer: '/wt9$wtContentMain$wtDBParams$ctl00$wt173', target: TARGET, field: 'username' },
    { pointer: '/wt9$wtContentMain$wtDBParams$ctl02$wt133', target: TARGET, field: 'password' }]);
});

test('Test Connection returns only the outcome', async () => {
  for (const [page, passed] of [['dbconnections/dbconnection-test.success.html', true], ['dbconnections/dbconnection-test.failure.html', false]]) {
    const s = setup();
    const bridge = new FakeBridge({ pages: { [`GET ${SC}DatabaseConnections_List.aspx`]: listing(),
      [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=7`]: html('dbconnections/dbconnection-edit.existing.html'),
      [`POST ${SC}DatabaseConnection_Edit.aspx`]: html(page) }, capabilities: SECRETS });
    const receipt = await s.execute(client(bridge), 'db-connection-test', { connection: 'SampleWarehouse' });
    assert.deepEqual([receipt.state, receipt.testPassed], ['confirmed', passed], page);
    const [, form, , write] = sent(bridge);
    assert.deepEqual([form['wt9$wtContentMain$wtTestConnectionButton'], form['wt9$wtContentMain$wtDBParams$ctl00$wt173'], form['wt9$wtContentMain$wtDBParams$ctl02$wt133'], write],
      ['Test Connection', '', '', true]);
    assert.ok(!Object.hasOwn(form, 'wt9$wtContentMain$wtSaveButton'));
    assert.deepEqual(bridge.refsOf(bridge.posts().at(-1)).map(r => r.field), ['username', 'password']);
    // The server's text echoes the login; it never comes back.
    assert.ok(!JSON.stringify(receipt).includes('svc_reader'));
  }
});

test('delete needs words naming the connection and the extensions using it', async () => {
  const s = setup();
  const deleted = [];
  const bridge = new FakeBridge({ pages: { [`GET ${SC}DatabaseConnections_List.aspx`]: () => listing(!deleted.length),
    [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=7`]: html('dbconnections/dbconnection-edit.existing.html'),
    [`POST ${SC}DatabaseConnection_Edit.aspx`]: () => { deleted.push(1); return listing(false); } } });
  const run = (...extra) => main(['db-connection-delete', '--host', HOST, '--connection', 'SampleWarehouse', ...extra], mainDeps(bridge, s));
  const plan = await run();
  assert.deepEqual([plan.usedBy, plan.namedTargets], [['SampleWarehouseExt'], ['SampleWarehouse', 'SampleWarehouseExt']]);
  assert.ok(plan.confirm.includes('delete this database connection'));
  const execute = ['--execute', '--confirm-host', HOST, '--operation-id'];
  await assert.rejects(run(...execute, uuid(), '--words', 'delete SampleWarehouse on sc'), isProtocol(/SampleWarehouseExt/));
  assert.deepEqual(bridge.posts(), []);
  const receipt = await run(...execute, uuid(), '--words', 'delete SampleWarehouse, used by SampleWarehouseExt, on sc');
  assert.equal(receipt.state, 'confirmed');
  const [, form, , write] = sent(bridge);
  const expected = request('dbconnections/dbconnection-delete.request.json').form;
  const keys = ['__EVENTTARGET', '__EVENTARGUMENT', '__OSVSTATE', '__VIEWSTATEGENERATOR'];
  assert.deepEqual(Object.fromEntries(keys.map(k => [k, form[k]])), Object.fromEntries(keys.map(k => [k, expected[k]])));
  assert.equal(write, true);
});

test('extension mapping preserves the native empty AJAX event before Apply', async () => {
  const s = setup();
  const mapped = [];
  const extension = () => { const page = html('factory/extension-edit.html'); return mapped.length ? page.replaceAll('<option value="0" selected="selected">', '<option value="0">').replaceAll('<option value="7">', '<option value="7" selected="selected">') : page; };
  const post = (form, accept) => { if (Object.hasOwn(form, '__AJAX')) return reply('factory/extension-db-mapping.change.osajax-reply.txt')(form, accept); mapped.push(1); return extension(); };
  const bridge = new FakeBridge({ pages: { [`GET ${SC}DatabaseConnections_List.aspx`]: listing(), [`GET ${SC}Extension_Edit.aspx?ExtensionId=202`]: extension, [`POST ${SC}Extension_Edit.aspx`]: post } });
  const receipt = await s.execute(client(bridge), 'extension-db-connection', { extensionId: '202', connection: 'SampleWarehouse' });
  assert.equal(receipt.state, 'confirmed');
  assertForm('factory/extension-db-mapping.change.osajax.request.json', bridge, 0);
  assertForm('factory/extension-db-mapping.apply.request.json', bridge, 1);
  assert.deepEqual(bridge.posts().map(p => p[6]), [false, true]);
});

// ---- solutions
test('extension mapping refuses foreign or unknown native change handlers without sending', async () => {
  for (const change of [
    s => s.replace("&#39;,&#39;&#39;,&#39;__OSVSTATE,", "&#39;,&#39;Delete&#39;,&#39;__OSVSTATE,"),
    s => s.replace("window.event,&#39;wt9_wtContentMain", "window.event,&#39;foreign_wtContentMain"),
  ]) {
    const s = setup();
    const original = html('factory/extension-edit.html');
    const selector = original.match(/<select[^>]*DBConnectionCombo[^>]*>/)[0];
    const page = original.replace(selector, change(selector));
    assert.notEqual(page, html('factory/extension-edit.html'));
    const bridge = new FakeBridge({ pages: { [`GET ${SC}DatabaseConnections_List.aspx`]: listing(),
      [`GET ${SC}Extension_Edit.aspx?ExtensionId=202`]: page } });
    const receipt = await s.execute(client(bridge), 'extension-db-connection', { extensionId: '202', connection: 'SampleWarehouse' });
    assert.notEqual(receipt.state, 'confirmed');
    assert.deepEqual(bridge.posts(), []);
  }
});

test('application timeout writes once, preserves other fields, and refuses a stale baseline or unknown script', async () => {
  let value = '0', script = "var ret = confirm('Apply changes?');if( ret != true ) {return false;}OsPage_ClientValidate('x_wtApplyRuntimeMobileButton');";
  const detail = () => `<form method="post" action="Application_Edit.aspx?ApplicationId=7"><input type="hidden" name="__OSVSTATE" value="state"><div class="sc-content-main"><h1>Application Demo</h1><div data-tab="tab-Operation"><label>Server Request Timeout</label><input type="text" name="timeout" value="${value}"><input type="submit" name="x$wtApplyRuntimeMobileButton" id="x_wtApplyRuntimeMobileButton" value="Apply" onclick="${script}"></div><textarea name="security">unchanged</textarea></div></form>`;
  const bridge = new FakeBridge({pages:{
    [`GET ${SC}Applications_List.aspx`]: '<form><div class="sc-content-main"><table><tr><th>Name</th></tr><tr><td><a href="Application_Edit.aspx?ApplicationId=7">Demo</a></td></tr></table></div></form>',
    [`GET ${SC}Application_Edit.aspx?ApplicationId=7`]: detail,
    [`POST ${SC}Application_Edit.aspx?ApplicationId=7`]: form => {assert.equal(form.security,'unchanged');value=form.timeout;return detail();}
  }});
  const c=client(bridge), s=setup();
  await assert.rejects(s.execute(c,'application-timeout-set',{application:'Demo',value:'120',expectedValue:'9'}), /expected value/);
  assert.equal(bridge.posts().length,0);
  const receipt=await s.execute(c,'application-timeout-set',{application:'Demo',value:'120',expectedValue:'0'});
  assert.equal(receipt.state,'confirmed');assert.equal(receipt.plan.previousValue,0);assert.equal(value,'120');
  assert.equal(receipt.runtimeCompletionVerified,false);
  await c.webWrite('application-timeout-set',{application:'Demo',value:'120',expectedValue:'0'},{execute:true,words:'go',operationId:receipt.operationId,journal:s.journal});
  assert.equal(bridge.posts().length,1);
  script+='window.location="other";';
  await assert.rejects(s.execute(c,'application-timeout-set',{application:'Demo',value:'0',expectedValue:'120'}), /Unrecognized/);
  assert.equal(bridge.posts().length,1);
});

test('application runtime settings bind the exact application and reject ambiguous or malformed controls', async () => {
  const wrap = body => `<form><div class="sc-content-main">${body}</div></form>`;
  const listing = wrap('<table><tr><th>Name</th></tr><tr><td><a href="Application_Edit.aspx?ApplicationId=7">Demo</a></td></tr></table>');
  const detail = value => wrap(`<h1>Application Demo</h1><div data-tab="tab-Operation"><label>Server Request Timeout</label><input type="text" name="timeout" value="${value}"></div>`);
  const bridge = new FakeBridge({pages:{[`GET ${SC}Applications_List.aspx`]:listing,[`GET ${SC}Application_Edit.aspx?ApplicationId=7`]:detail('0')}});
  const c = client(bridge);
  assert.equal((await c.applicationRuntimeSettings('Demo')).serverRequestTimeout, 0);
  bridge.pages[`GET ${SC}Application_Edit.aspx?ApplicationId=7`] = detail('120');
  assert.equal((await c.applicationRuntimeSettings('Demo')).serverRequestTimeout, 120);
  for (const value of ['', '-1', 'abc', '1.5']) {
    bridge.pages[`GET ${SC}Application_Edit.aspx?ApplicationId=7`] = detail(value);
    await assert.rejects(c.applicationRuntimeSettings('Demo'), /nonnegative integer/);
  }
  bridge.pages[`GET ${SC}Application_Edit.aspx?ApplicationId=7`] = detail('0').replace('Application Demo','Application Other');
  await assert.rejects(c.applicationRuntimeSettings('Demo'), /identity changed/);
  bridge.pages[`GET ${SC}Application_Edit.aspx?ApplicationId=7`] = detail('0').replace('</label>','</label><input type="text" name="other" value="1">');
  await assert.rejects(c.applicationRuntimeSettings('Demo'), /timeout input/);
  assert.equal(bridge.posts().length,0);
  const filteredPage = `<form method="post" action="Applications_List.aspx"><input type="hidden" name="__OSVSTATE" value="state"><div class="sc-content-main"><label for="appFilter">Name</label><input type="text" name="appFilter" id="appFilter"><input type="submit" name="filter" value="Filter"><table><tr><th>Name</th></tr></table></div></form>`;
  bridge.pages[`GET ${SC}Applications_List.aspx`] = filteredPage;
  bridge.pages[`POST ${SC}Applications_List.aspx`] = form => {assert.equal(form.appFilter,'Demo');return listing;};
  bridge.pages[`GET ${SC}Application_Edit.aspx?ApplicationId=7`] = detail('0');
  assert.equal((await c.applicationRuntimeSettings('Demo')).serverRequestTimeout,0);
  assert.equal(bridge.posts().length,1);
});

test('solution versions distinguish stored versions from the decorated running snapshot, without writes', async () => {
  const page = `<table><tr><th>Version</th><th>Name</th><th>Created</th></tr>
    <tr><td>7</td><td>Release Seven</td><td>2026-10-01</td></tr>
    <tr><td></td><td><span>Current Running Version</span><span>Snapshot description</span></td><td>2026-10-09</td></tr></table>`;
  const bridge = new FakeBridge({pages:solutionPages()});
  const c = client(bridge);
  bridge.pages[`GET ${SC}Solution_Edit.aspx?SolutionId=11`] = html('solutions/solution-edit.html').replace('<table class="table margin-top-s', page + '<table class="table margin-top-s');
  const result = await c.solutionVersions('SampleRelease', 1);
  assert.equal(result.versions[0].version, '7');
  assert.equal(result.truncated, true);
  const all = await c.solutionVersions('SampleRelease');
  assert.equal(all.versions[1].currentRunning, true);
  assert.equal(all.versions[1].version, null);
  assert.equal(all.versions[1].name, 'Current Running Version');
  assert.equal(all.truncated, false);
  assert.equal(bridge.posts().length, 0);
  await assert.rejects(c.solutionVersions('SampleRelease', 0), /limit/);
  const shell = html('solutions/solution-edit.html');
  bridge.pages[`GET ${SC}Solution_Edit.aspx?SolutionId=11`] = shell;
  await assert.rejects(c.solutionVersions('SampleRelease'), /solution versions table/i);
  bridge.pages[`GET ${SC}Solution_Edit.aspx?SolutionId=11`] = shell.replace('<table class="table margin-top-s', page + page + '<table class="table margin-top-s');
  await assert.rejects(c.solutionVersions('SampleRelease'), /solution versions table/i);
  bridge.pages[`GET ${SC}Solution_Edit.aspx?SolutionId=11`] = shell.replace('<table class="table margin-top-s', page.replace('Current Running Version', 'Unknown snapshot') + '<table class="table margin-top-s');
  await assert.rejects(c.solutionVersions('SampleRelease'), /no identity/);
  const paged = shell.replace('<table class="table margin-top-s', page + '<a href="Solution_Edit.aspx?SolutionId=11&amp;Page=2">Next</a><table class="table margin-top-s');
  bridge.pages[`GET ${SC}Solution_Edit.aspx?SolutionId=11`] = paged;
  bridge.pages[`GET ${SC}Solution_Edit.aspx?SolutionId=11&Page=2`] = shell.replace('<table class="table margin-top-s', page.replace('<td>7</td>', '<td>6</td>') + '<table class="table margin-top-s');
  assert.equal((await c.solutionVersions('SampleRelease', 100, 1)).truncated, true);
  const paginated = await c.solutionVersions('SampleRelease');
  assert.deepEqual(paginated.versions.map(v => v.version), ['7', null, '6', null]);
  assert.equal(paginated.truncated, false);
  bridge.pages[`GET ${SC}Solution_Edit.aspx?SolutionId=11&Page=2`] = paged;
  await assert.rejects(c.solutionVersions('SampleRelease'), /did not advance/);
});

const solutionPages = (edit = 'solutions/solution-edit.html', list = null) => ({ [`GET ${SC}Solutions_List.aspx`]: list ?? html('solutions/solutions-list.html'),
  [`GET ${SC}Solution_Edit.aspx?SolutionId=11`]: html(edit) });

test('create posts the fixture form and reads the list back', async () => {
  const s = setup();
  const created = [];
  const list = () => html('solutions/solutions-list.html', ...(created.length ? [['>SampleRelease</a>', '>SampleHotfix</a>']] : []));
  const bridge = new FakeBridge({ pages: { ...solutionPages(undefined, list), [`GET ${SC}Solution_Edit.aspx`]: html('solutions/solution-edit.new.html'),
    [`POST ${SC}Solution_Edit.aspx`]: () => { created.push(1); return html('solutions/solution-edit.created.html'); } } });
  const receipt = await s.execute(client(bridge), 'solution-create', { solution: 'SampleHotfix', description: 'Synthetic solution created by the fixture' });
  assertForm('solutions/solution-create.request.json', bridge);
  assert.equal(receipt.state, 'confirmed');
});

test('New Solution postback navigates headlessly before any creation is authorized', async () => {
  const bridge=new FakeBridge();
  const c=client(bridge);
  c.solutions=async()=>({solutions:[],truncated:false});
  const listing=html('solutions/solutions-list.html').replace(/href="Solution_Edit.aspx"/g,
    'href="javascript:__doPostBack(\'wtRoot$wtNewSolutionLink\',\'\')"');
  bridge.pages[`GET ${SC}Solutions_List.aspx`]=listing;
  bridge.pages[`POST ${SC}Solutions_List.aspx`]=html('solutions/solution-edit.new.html');
  const plan=await c.webWrite('solution-create',{solution:'SampleHotfix'});
  assert.equal(plan.execute,false);assert.equal(plan.solution,'SampleHotfix');
  assert.equal(bridge.posts().length,1);
  assert.equal(bridge.posts()[0][4].__EVENTTARGET,'wtRoot$wtNewSolutionLink');
  assert.equal(bridge.posts()[0][6],false);
});

test('add component resolves the key by the autocomplete lookup, then associates', async () => {
  const s = setup();
  const added = [];
  const post = (form, accept) => { if (form.__AJAXEVENT === 'Notify') return reply('solutions/solution-component-lookup.osajax-reply.txt')(form, accept); added.push(1); return html('solutions/solution-edit.html'); };
  const edit = () => html('solutions/solution-edit.html', ...(added.length ? [['>SampleUtilExt</a>', '>SampleShared_IS</a>']] : []));
  const bridge = new FakeBridge({ pages: { ...solutionPages(), [`GET ${SC}Solution_Edit.aspx?SolutionId=11`]: edit, [`POST ${SC}Solution_Edit.aspx?_ts=0`]: post, [`POST ${SC}Solution_Edit.aspx`]: post } });
  const args = { solution: 'SampleRelease', component: 'SampleShared_IS', includeReferences: true };
  const plan = await client(bridge).webWrite('solution-add-component', args);
  assert.deepEqual([plan.componentLabel, plan.componentKey, plan.alreadyPresent], ['SampleShared_IS (Module)', '7c3d9e10-0000-4000-8000-00000000e103', false]);
  assertForm('solutions/solution-component-lookup.osajax.request.json', bridge, 0, { wtComponentInput: 'SampleShared_IS', __AJAX: '1024,768,,0,0,0,0,0,0,SampleShared_IS%', 'wt9$wtContentMain$wtAddComponent$wtIncludeReferences':'off' });
  assert.equal(bridge.posts()[0][6], false, 'the lookup is a read');
  const receipt = await s.execute(client(bridge), 'solution-add-component', args);
  assert.equal(receipt.state, 'confirmed');
  assertForm('solutions/solution-add-component.request.json', bridge);
  await assert.rejects(client(bridge).webWrite('solution-add-component', { ...args, component: 'SampleShared' }), isProtocol(/SampleShared/));
});

test('remove component is the row\'s postback', async () => {
  const s = setup();
  const removed = [];
  const edit = () => html('solutions/solution-edit.html', ...(removed.length ? [['>SampleUtilExt</a>', '>Gone</a>']] : []));
  const bridge = new FakeBridge({ pages: { ...solutionPages(), [`GET ${SC}Solution_Edit.aspx?SolutionId=11`]: edit,
    [`POST ${SC}Solution_Edit.aspx`]: () => { removed.push(1); return html('solutions/solution-edit.html'); } } });
  const receipt = await s.execute(client(bridge), 'solution-remove-component', { solution: 'SampleRelease', component: 'SampleUtilExt' });
  assertForm('solutions/solution-remove-component.request.json', bridge);
  assert.equal(receipt.state, 'confirmed');
});

test('download posts the fixture form and keeps the package', async () => {
  const s = setup();
  const osp = zip({'Solution.xml':'<Solution/>'});
  const bridge = new FakeBridge({ pages: { ...solutionPages(), [`POST ${SC}Solution_Edit.aspx`]: (f, a) => (a === 'binary' ? osp : assert.fail(a)) } });
  const saved = await client(bridge, s.dir).solutionDownload('SampleRelease');
  assertForm('solutions/solution-download.request.json', bridge);
  assert.equal(saved.sha256, sha256(osp));
});

const solutionVersionRow = (current, suffix = '', disabled = false) => `<tr><td></td><td>${current ? '' : '2'}</td><td><strong>${current ? 'Current Running Version' : 'Archived'}</strong> Snapshot</td><td>2026-10-08</td><td><input type="submit" name="${current ? 'current' : 'archived'}${suffix}" value="Download" ${disabled ? 'disabled' : ''}></td></tr>`;
const solutionVersionsPage = rows => `<form method="post" action="Solution_Edit.aspx?SolutionId=11"><input type="hidden" name="__OSVSTATE" value="synthetic-state"><div class="sc-content-main"><table><tr><th></th><th>Version</th><th>Name</th><th>Created</th><th></th></tr>${rows}</table></div></form>`;

test('solution download selects the labeled running snapshot even after an archived version', async () => {
  const s = setup(), osp = zip({'Solution.xml':'<Solution/>'});
  const bridge = new FakeBridge({ pages: { ...solutionPages(),
    [`GET ${SC}Solution_Edit.aspx?SolutionId=11`]: solutionVersionsPage(solutionVersionRow(false) + solutionVersionRow(true)),
    [`POST ${SC}Solution_Edit.aspx?SolutionId=11`]: (form, accept) => {
      assert.equal(form.current, 'Download'); assert.equal(form.archived, undefined);
      assert.equal(form.__OSVSTATE, 'synthetic-state'); assert.equal(accept, 'binary'); return osp;
    } } });
  const result = await client(bridge, s.dir).solutionDownload('SampleRelease');
  assert.equal(result.version, 'current-running'); assert.equal(result.sha256, sha256(osp));
  assert.equal(bridge.posts().length, 1); assert.equal(sent(bridge)[3], false);
});

test('ambiguous, absent or disabled running snapshot refuses download without a POST', async () => {
  for (const rows of [solutionVersionRow(true) + solutionVersionRow(true, '2'), solutionVersionRow(false), solutionVersionRow(true, '', true)]) {
    const s = setup();
    const bridge = new FakeBridge({ pages: { ...solutionPages(), [`GET ${SC}Solution_Edit.aspx?SolutionId=11`]: solutionVersionsPage(rows) } });
    await assert.rejects(client(bridge, s.dir).solutionDownload('SampleRelease'), e => e instanceof LayoutError);
    assert.equal(bridge.posts().length, 0);
  }
});

test('an unknown solutions list is refused with a capture request', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Solutions_List.aspx`]: '<form method="post"><p>Solutions moved</p></form>' } });
  await assert.rejects(client(bridge).solutions(), e => e instanceof LayoutError && e.extra.continuation.arguments.path === 'Solutions_List.aspx');
});

// ---- integrations and BPT
test('log level posts the fixture form and reads back', async () => {
  const s = setup();
  const level = ['integrations/rest-consume-edit.html'];
  const detail = SC + 'eSpace_RestWebReference_Edit.aspx?TenantIdx=0&RestWebreferenceId=122&VersionIdx=0';
  const bridge = new FakeBridge({ pages: { ...modulePages(), [`GET ${detail}`]: () => html(level[0]),
    [`POST ${SC}eSpace_RestWebReference_Edit.aspx`]: () => { level[0] = 'integrations/rest-consume-edit.after-full.html'; return html(level[0]); } } });
  const receipt = await s.execute(client(bridge), 'integration-log-level', { moduleId: '102', integration: 'SampleCatalogApi', level: 'Full' });
  assertForm('integrations/log-level.request.json', bridge);
  assert.deepEqual([receipt.state, receipt.observedLevel], ['confirmed', 'Full']);
});

test('integration detail returns the current level and choices without posting configuration', async () => {
  const detail = SC + 'eSpace_RestWebReference_Edit.aspx?TenantIdx=0&RestWebreferenceId=122&VersionIdx=0';
  const bridge = new FakeBridge({ pages: { ...modulePages(), [`GET ${detail}`]: html('integrations/rest-consume-edit.html') } });
  const c = client(bridge);
  const result = await c.integrationDetail('102', 'SampleCatalogApi', 'consumed-rest');
  assert.equal(result.integrationId, '122');
  assert.equal(result.currentLevel, 'Default');
  assert.ok(result.availableLevels.includes('Full'));
  assert.equal(bridge.posts().length, 0);
  await assert.rejects(c.integrationDetail('102', 'SampleCatalogApi', 'exposed-rest'));
  assert.equal(bridge.posts().length, 0);
});

test('the BPT filter posts the fixture form', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Process_Monitoring.aspx?Index=0`]: html('bpt/process-monitoring.html'), [`POST ${SC}Process_Monitoring.aspx`]: html('bpt/process-monitoring.html') } });
  const result = await client(bridge).bptProcesses('SampleOrders', 'OrderApproval');
  assertForm('bpt/process-monitoring.filter.request.json', bridge);
  assert.deepEqual([result.rows[0].processKey, result.rows[0].moduleKey], ['3f2e1d0c-0000-4000-8000-00000000b001', '7c3d9e10-0000-4000-8000-00000000e101']);
});

test('BPT instance summary and refusal of an activity without instance identity', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Process_Instance_Detail.aspx?ProcessId=9001`]: html('bpt/process-instance-detail.html'),
    [`GET ${SC}Process_Activity_Detail.aspx?ActivityId=9102`]: html('bpt/process-activity-detail.html') } });
  const instance = await client(bridge).bptInstance('9001');
  assert.deepEqual([instance.title, instance.summary.Status, instance.activities.map(a => a.activityId)], ['Process OrderApproval Instance no. 9001', 'Active', ['9101', '9102']]);
  // This historical synthetic activity layout names the activity but carries no
  // instance ID. The request URL alone cannot prove the returned resource.
  await assert.rejects(client(bridge).bptActivity('9102'), {code:'SC_RESOURCE_IDENTITY_UNVERIFIED'});
});

test('BPT activities follow pages and report row/page caps, refusing a foreign instance', async () => {
  const base = html('bpt/process-instance-detail.html');
  const nextPath = `${SC}Process_Instance_Detail.aspx?ProcessId=9001&Index=2`;
  const first = base.replace('<table class="table"', '<a rel="next" href="' + nextPath.replaceAll('&', '&amp;') + '">Next</a><table class="table"');
  const second = base.replaceAll('9101', '9201').replaceAll('9102', '9202');
  const create = (last = second) => client(new FakeBridge({ pages: {
    [`GET ${SC}Process_Instance_Detail.aspx?ProcessId=9001`]: first, [`GET ${nextPath}`]: last,
  } }));
  const full = await create().bptInstance('9001');
  assert.deepEqual(full.activities.map(a => a.activityId), ['9101','9102','9201','9202']);
  assert.equal(full.truncated, false);
  const capped = await create().bptInstance('9001', 1);
  assert.deepEqual(capped.activities.map(a => a.activityId), ['9101']);
  assert.equal(capped.truncated, true);
  const pageCap = await create().bptInstance('9001', 100, 1);
  assert.equal(pageCap.activities.length, 2);
  assert.equal(pageCap.truncated, true);
  assert.equal(pageCap.pageLimit, 1);
  await assert.rejects(create(second.replaceAll('9001', '9002')).bptInstance('9001'), {code:'SC_RESOURCE_IDENTITY_UNVERIFIED'});
});

test('permission feedback is a failure', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}eSpaces_List.aspx`]: html('_common/permission-error.html') } });
  await assert.rejects(client(bridge).modules(), isProtocol(/permission/));
});

// ---- page layout
test('page-layout returns names and keeps markup without values', async () => {
  const s = setup();
  const bridge = new FakeBridge({ pages: { [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=7`]: html('dbconnections/dbconnection-edit.existing.html') } });
  const result = await main(['page-layout', '--host', HOST, '--path', 'DatabaseConnection_Edit.aspx?DBConnectionId=7'], mainDeps(bridge, s));
  assert.deepEqual([result.scope, result.title], ['sc-content-main', 'Database Connection SampleWarehouse']);
  const controls = Object.fromEntries(result.controls.map(c => [c.name, c]));
  assert.deepEqual([controls['wt9$wtContentMain$wtDBParams$ctl02$wt133'].type, controls['wt9$wtContentMain$wtDBParams$ctl02$wt133'].label], ['password', 'password']);
  assert.ok(result.postbacks.some(p => JSON.stringify(p) === JSON.stringify({ text: 'Delete', kind: 'postback', target: 'wt9$wtContentTop$wtButton7', argument: '' })));
  assert.ok(result.links.includes('Extension_Edit.aspx?ExtensionId='));
  assert.ok(result.formState.includes('__OSVSTATE'));
  const saved = fs.readFileSync(result.capture.file, 'utf8');
  assert.equal(sha256(Buffer.from(saved, 'utf8')), result.capture.sha256);
  for (const value of ['svc_reader', 'db.example.test', 'U1NBTS1TWU5U', 'Recent', 'licensee']) assert.ok(!(JSON.stringify(result) + saved).includes(value), value);
  assert.ok(saved.includes('wtTestConnectionButton'));
  await assert.rejects(main(['page-layout', '--host', HOST, '--path', '../Users/Login.aspx'], mainDeps(bridge, s)), isProtocol());
});


test('contextual delete preflight keeps the approved SQL endpoint through CLI argument normalization', async () => {
  const s=setup();
  const bridge=new FakeBridge({pages:{
    [`GET ${SC}DatabaseConnections_List.aspx`]:listing(),
    [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=7`]:html('dbconnections/dbconnection-edit.existing.html')
  }});
  const plan=await main(['db-connection-delete','--host',HOST,'--connection','SampleWarehouse',
    '--authorization-context',path.join(s.dir,'approval.json')],mainDeps(bridge,s));
  assert.ok(plan.parameters?.server); assert.ok(plan.parameters?.database);
  assert.deepEqual(bridge.posts(),[]);
});


test('live-shaped connection AJAX submits secretRefs once and reads only outcome from feedback markup',async()=>{
  const control='wt9$wtContentMain$wtTestConnectionButton', id=control.replaceAll('$','_');
  const onclick=`OsAjax(arguments[0] || window.event,'${id}','${control}','','__OSVSTATE,',''); return false;`;
  for(const passed of [true,false]) {
    const s=setup();
    const page=html('dbconnections/dbconnection-edit.existing.html').replace('value="Test Connection"',`onclick="${onclick}" value="Test Connection"`);
    const feedback=`<div class="${passed?'Feedback_Message_Success':'Feedback_Message_Error'}">private-provider-message</div>`;
    const bridge=new FakeBridge({capabilities:SECRETS,pages:{
      [`GET ${SC}DatabaseConnections_List.aspx`]:listing(),
      [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=7`]:page,
      [`POST ${SC}DatabaseConnection_Edit.aspx`]:()=>({ok:true,status:200,contentType:'text/javascript',
        finalUrl:`https://${HOST}${SC}DatabaseConnection_Edit.aspx`,html:JSON.stringify({html:feedback})})
    }});
    const result=await s.execute(client(bridge),'db-connection-test',{connection:'SampleWarehouse'});
    assert.equal(result.state,'confirmed'); assert.equal(result.testPassed,passed);
    assert.equal(bridge.posts().length,1); const [,form,,write]=sent(bridge);
    assert.equal(form.__EVENTTARGET,control); assert.equal(write,true);
    assert.equal(bridge.refsOf(bridge.posts()[0]).length,2);
    assert.ok(!JSON.stringify(result).includes('private-provider-message'));
  }
});

test('unsupported connection test script refuses before creating a receipt or sending',async()=>{
  const s=setup(), page=html('dbconnections/dbconnection-edit.existing.html').replace('value="Test Connection"','onclick="other.submit()" value="Test Connection"');
  const bridge=new FakeBridge({capabilities:SECRETS,pages:{[`GET ${SC}DatabaseConnections_List.aspx`]:listing(),
    [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=7`]:page}});
  await assert.rejects(s.execute(client(bridge),'db-connection-test',{connection:'SampleWarehouse'}),isProtocol(/Unsupported/));
  assert.deepEqual(bridge.posts(),[]); assert.equal(fs.existsSync(path.join(s.dir,'receipts')),false);
});


test('BPT detail refuses general pages and nearby IDs instead of returning requested-ID empty success',async()=>{
 const known=html('bpt/process-instance-detail.html');
 for(const page of [known.replaceAll('Instance no. 9001','Instance no. 90010'),known.replaceAll('Process OrderApproval Instance no. 9001','Process Monitoring')]){
  const bridge=new FakeBridge({pages:{[`GET ${SC}Process_Instance_Detail.aspx?ProcessId=9001`]:page}});
  await assert.rejects(client(bridge).bptInstance('9001'),{code:'SC_RESOURCE_IDENTITY_UNVERIFIED'});
 }
 const bridge=new FakeBridge({pages:{[`GET ${SC}Process_Activity_Detail.aspx?ActivityId=9103`]:html('bpt/process-activity-detail.html')}});
 await assert.rejects(client(bridge).bptActivity('9103'),{code:'SC_RESOURCE_IDENTITY_UNVERIFIED'});
 const anonymous=html('bpt/process-activity-detail.html').replaceAll(' Instance nr. 9102','');
 const noId=new FakeBridge({pages:{[`GET ${SC}Process_Activity_Detail.aspx?ActivityId=9102`]:anonymous}});
 await assert.rejects(client(noId).bptActivity('9102'),{code:'SC_RESOURCE_IDENTITY_UNVERIFIED'});
});


test('BPT process details reject the general monitoring fallback and foreign instance rows',async()=>{
 const url=`GET ${SC}Process_Details.aspx?ProcessKey=p&ModuleKey=m&Index=0`;
 const fallback=new FakeBridge({pages:{[url]:html('bpt/process-monitoring.html')}});
 await assert.rejects(client(fallback).bptProcess('p','m'),{code:'SC_RESOURCE_IDENTITY_UNVERIFIED'});
 const prefix='<html><body><h1>Process Detail</h1><table><tr><td>Label</td><td>Example</td></tr><tr><td>Status</td><td>The process is OK.</td></tr>'+['Active Instances','Active Instances with Errors','Suspended Instances','Closed Instances'].map(k=>`<tr><td>${k}</td><td>0</td></tr>`).join('')+'</table>';
 const empty=new FakeBridge({pages:{[url]:prefix+'<table><tr><th>Instance Id</th><th>Status</th></tr><tr><td colspan="2">No items to show</td></tr></table></body></html>'}});
 assert.equal((await client(empty).bptProcess('p','m')).instances.rows.length,0);
 const foreign=new FakeBridge({pages:{[url]:prefix+'<table><tr><th>Instance Id</th></tr><tr><td><a href="Process_Instance_Detail.aspx?ProcessId=12">11</a></td></tr></table></body></html>'}});
 await assert.rejects(client(foreign).bptProcess('p','m'),{code:'SC_RESOURCE_IDENTITY_UNVERIFIED'});
});
