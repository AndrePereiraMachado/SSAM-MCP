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
import { FakeBridge, MODERN, SC, fakeVault, files, html, readText, request, temp, uuid } from './fixtures/sc-fake-bridge.mjs';

process.env.ANVIL_WORKER = '0'; process.env.ANVIL_ODC_NO_WORKER = '1';
// A pending private prompt is not waited for here (its bounded wait: pa2-f8-sc.test.mjs).
process.env.SSAM_PROMPT_WAIT_MS = '0';
const HOST = 'sc.example.test';
const SECRETS = ['sc_api:soap', 'sc_web', 'sc_web:secretRefs'];
const TIMER = SC + 'eSpace_Timer_Edit.aspx?EspaceKey=7c3d9e10-0000-4000-8000-00000000e102&Cyclic_Job_Key=9a8b7c6d-0000-4000-8000-00000000c001';
const PROPERTY = id => SC + `eSpace_SiteProperty_Edit.aspx?SitePropertyId=${id}&EspaceId=102`;
const ESPACE = `GET ${SC}eSpace_Edit.aspx?EspaceId=102`;

// An OsAjax reply as the bridge returns any non-HTML text for accept=html.
const reply = (name, contentType = 'text/javascript') => () => ({ ok: true, status: 200, finalUrl: `https://${HOST}${SC}X.aspx`, contentType, html: readText(path.join(MODERN, name)) });
const client = (bridge, exports = null) => new Client(fakeVault(HOST), new StudioWebTransport(HOST, bridge), exports);
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
    const name = Object.hasOwn(form, key) ? key : Object.keys(form).find(k => k.endsWith(key));
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
  // The Next link is OsAjax: replayed as the GitSSAM postback (its name with an empty value), a read.
  assertForm('logs/error-logs.next.gitssam-variant.request.json', bridge);
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
  assertForm('logs/integration-logs.filter.osajax.request.json', bridge);
  assert.deepEqual(listed.rows.map(r => r.fields.Action), ['SampleCatalogApi.GetItems']);
  bridge = new FakeBridge({ pages: { ...pages, [`POST ${SC}Integration_Logs.aspx`]: [reply('logs/integration-logs.filter.osajax-reply.txt'), body] } });
  const exported = await client(bridge, s.dir).logs('integration', 50, filters, { exportAll: true });
  assertForm('logs/integration-logs.export.request.json', bridge);
  assert.deepEqual([sent(bridge)[2], exported.rowCount], ['xlsx', 2]);
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
      && e.op.value === 'Every 15 minutes' && e.op.target === 'ITimer:ProcessQueue');
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

test('the CLI opens the site property prompt before any reservation', async () => {
  const s = setup();
  const prompts = [];
  const bridge = propertyBridge(503, html('site-properties/site-property-edit.secret.html'), () => assert.fail('never posted'), null, { capabilities: SECRETS });
  await assert.rejects(main(['property-set', '--host', HOST, '--module-id', '102', '--name', 'PartnerApiToken', '--value-vault', `SSAM/O11/${HOST}/SiteProperty/PartnerApiToken`,
    '--execute', '--operation-id', uuid(), '--words', 'set PartnerApiToken on sc', '--confirm-host', HOST],
  mainDeps(bridge, s, { opener: (host, kind, name = null) => { prompts.push([kind, name]); return { opened: true }; } })),
  e => e instanceof BridgeError && e.code === 'CREDENTIAL_PROMPT_PENDING');
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

test('the extension mapping is the fixture Change then Apply', async () => {
  const s = setup();
  const mapped = [];
  const extension = () => { const page = html('factory/extension-edit.html'); return mapped.length ? page.replaceAll('<option value="0" selected="selected">', '<option value="0">').replaceAll('<option value="7">', '<option value="7" selected="selected">') : page; };
  const post = (form, accept) => { if (Object.hasOwn(form, '__AJAXEVENT')) return reply('factory/extension-db-mapping.change.osajax-reply.txt')(form, accept); mapped.push(1); return extension(); };
  const bridge = new FakeBridge({ pages: { [`GET ${SC}DatabaseConnections_List.aspx`]: listing(), [`GET ${SC}Extension_Edit.aspx?ExtensionId=202`]: extension, [`POST ${SC}Extension_Edit.aspx`]: post } });
  const receipt = await s.execute(client(bridge), 'extension-db-connection', { extensionId: '202', connection: 'SampleWarehouse' });
  assert.equal(receipt.state, 'confirmed');
  assertForm('factory/extension-db-mapping.change.osajax.request.json', bridge, 0);
  assertForm('factory/extension-db-mapping.apply.request.json', bridge, 1);
  assert.deepEqual(bridge.posts().map(p => p[6]), [false, true]);
});

// ---- solutions
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

test('add component resolves the key by the autocomplete lookup, then associates', async () => {
  const s = setup();
  const added = [];
  const post = (form, accept) => { if (form.__AJAXEVENT === 'Notify') return reply('solutions/solution-component-lookup.osajax-reply.txt')(form, accept); added.push(1); return html('solutions/solution-edit.html'); };
  const edit = () => html('solutions/solution-edit.html', ...(added.length ? [['>SampleUtilExt</a>', '>SampleShared_IS</a>']] : []));
  const bridge = new FakeBridge({ pages: { ...solutionPages(), [`GET ${SC}Solution_Edit.aspx?SolutionId=11`]: edit, [`POST ${SC}Solution_Edit.aspx?_ts=0`]: post, [`POST ${SC}Solution_Edit.aspx`]: post } });
  const args = { solution: 'SampleRelease', component: 'SampleShared_IS', includeReferences: true };
  const plan = await client(bridge).webWrite('solution-add-component', args);
  assert.deepEqual([plan.componentLabel, plan.componentKey, plan.alreadyPresent], ['SampleShared_IS (Module)', '7c3d9e10-0000-4000-8000-00000000e103', false]);
  assertForm('solutions/solution-component-lookup.osajax.request.json', bridge, 0, { wtComponentInput: 'SampleShared_IS', __AJAX: '1024,768,,0,0,0,0,0,0,SampleShared_IS%' });
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
  const osp = Buffer.from('PK\x03\x04osp', 'latin1');
  const bridge = new FakeBridge({ pages: { ...solutionPages(), [`POST ${SC}Solution_Edit.aspx`]: (f, a) => (a === 'binary' ? osp : assert.fail(a)) } });
  const saved = await client(bridge, s.dir).solutionDownload('SampleRelease');
  assertForm('solutions/solution-download.request.json', bridge);
  assert.equal(saved.sha256, sha256(osp));
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

test('the BPT filter posts the fixture form', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Process_Monitoring.aspx?Index=0`]: html('bpt/process-monitoring.html'), [`POST ${SC}Process_Monitoring.aspx`]: html('bpt/process-monitoring.html') } });
  const result = await client(bridge).bptProcesses('SampleOrders', 'OrderApproval');
  assertForm('bpt/process-monitoring.filter.request.json', bridge);
  assert.deepEqual([result.rows[0].processKey, result.rows[0].moduleKey], ['3f2e1d0c-0000-4000-8000-00000000b001', '7c3d9e10-0000-4000-8000-00000000e101']);
});

test('BPT instance and activity summaries', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Process_Instance_Detail.aspx?ProcessId=9001`]: html('bpt/process-instance-detail.html'),
    [`GET ${SC}Process_Activity_Detail.aspx?ActivityId=9102`]: html('bpt/process-activity-detail.html') } });
  const instance = await client(bridge).bptInstance('9001');
  assert.deepEqual([instance.title, instance.summary.Status, instance.activities.map(a => a.activityId)], ['Process OrderApproval Instance no. 9001', 'Active', ['9101', '9102']]);
  assert.equal((await client(bridge).bptActivity('9102')).summary['Following Activity'], 'ApproveOrder');
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
