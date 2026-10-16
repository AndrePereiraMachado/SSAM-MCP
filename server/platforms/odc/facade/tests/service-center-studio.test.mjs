// The code under test writes under the user's profile: this process's profile is a temporary folder.
import './fixtures/isolated-profile.mjs';
import {zip} from './fixtures/sc-fake-bridge.mjs';
// Port of kernel/tests/test_service_center_studio.py (56 cases): Service Center through the connected Studio (bridge
// sc_session/sc_api/sc_web/studio_login), offline: a fake bridge, synthetic HTML fixtures (sc-pages) and a loopback
// JSON-lines server (fake-o11-bridge.mjs). No Studio, Service Center, identity provider or credential store is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anvilRoot } from '../workspace.mjs';
import { Resolver, guardWrite, hostClass, hostsFile, openPrompt, promptScript } from '../service-center/auth.mjs';
import { CODES, StudioBridge, VERBS, locateStudioBridge, redact } from '../service-center/bridge.mjs';
import { Client, Journal, bridgeFailure } from '../service-center/client.mjs';
import { AuthRequired, BridgeError, ProtocolError } from '../service-center/errors.mjs';
import { Document, Page, jsonPointer } from '../service-center/html.mjs';
import { NOT_SENT, SECRET_CAPABILITY, StudioWebTransport } from '../service-center/http.mjs';
import { main, runServiceCenter } from '../service-center/index.mjs';
import { READS } from '../service-center/studio-api.mjs';
import { DELETE_OPERATIONS, derivedOperationId } from '../service-center/delete.mjs';
import { CREDENTIAL } from '../service-center/vault.mjs';
import { xlsxRows } from '../service-center/xlsx.mjs';
import { sha256 } from '../service-center/util.mjs';
import { FakeBridge, SC, fakeVault, files, fixture, temp, uuid, xlsx } from './fixtures/sc-fake-bridge.mjs';
import { fakeBridge as loopbackBridge } from './fixtures/fake-o11-bridge.mjs';
import { CONFIRM_MIN_AGE_MS } from '../destructive-operations.mjs';
import { fakeClock, noBackup, previewThenConfirm } from './fixtures/destructive-flow.mjs';

process.env.ANVIL_WORKER = '0'; process.env.ANVIL_ODC_NO_WORKER = '1';
// A pending private prompt is not waited for here (its bounded wait: pa2-f8-sc.test.mjs): CREDENTIAL_PROMPT_PENDING at once.
process.env.SSAM_PROMPT_WAIT_MS = '0';
const HOST = 'test.example.com';
const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');

test('extension database provider read requires an exact extension key and logical database', () => {
  const [surface, operation, args] = READS['extension-database-provider'];
  assert.equal(surface, 'integration-studio');
  assert.equal(operation, 'TranslateLogicalDatabaseToDbConnection');
  assert.deepEqual(args({extension_key:'proof-key',logical_database:'Cargo<&'}), {extensionKey:'proof-key',logicalDatabase:'Cargo<&'});
  assert.throws(() => args({extension_key:'bad key',logical_database:'Cargo'}), ProtocolError);
  assert.throws(() => args({extension_key:'proof-key'}), ProtocolError);
});
const isProtocol = pattern => e => e instanceof ProtocolError && (!pattern || pattern.test(e.message));
const coded = code => e => e instanceof BridgeError && e.code === code;
const webClient = (bridge, exports = null, host = HOST, stored = true) => new Client(fakeVault(host, stored), new StudioWebTransport(host, bridge), exports);

function solutionPages(bridge, components) {
  const listing = fixture('solutions.html');
  const edit = () => {
    let html = fixture('solution-edit.html');
    for (const name of ['Orders', 'Billing_Core']) if (!components.has(name)) html = html.replaceAll(`<td>${name}</td>`, '<td>-</td>');
    if (components.has('Payments')) html = html.replaceAll('</table>', '<tr><td>Payments</td><td>Module</td><td></td></tr></table>');
    return html;
  };
  Object.assign(bridge.pages, { [`GET ${SC}eSpaces_List.aspx`]: listing, [`GET ${SC}Solutions_List.aspx`]: listing, [`GET ${SC}Solution_Edit.aspx?SolutionId=5`]: edit });
}

// ---- StudioWebTransport
test('reads go without and authorized posts with the write fields', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Error_Logs.aspx`]: fixture('error-logs-1.html'), [`POST ${SC}Write.aspx`]: '<p>done</p>' } });
  const t = new StudioWebTransport(HOST, bridge);
  const page = await t.request('Error_Logs.aspx');
  assert.equal(page.url, `https://${HOST}${SC}Error_Logs.aspx`);
  await t.request('Write.aspx', [['a', '1']]);
  assert.equal(bridge.calls.at(-1)[6], false);
  const operation = uuid();
  let tracker;
  await t.authorizing(operation, 'a'.repeat(64), async tr => { tracker = tr; await t.request('Write.aspx', [['a', '1']]); });
  assert.deepEqual(bridge.calls.at(-1), ['web', 'fetch', 'POST', SC + 'Write.aspx', { a: '1' }, 'html', true, operation, 'a'.repeat(64)]);
  assert.equal(tracker.sent, true);
});

test('a login page or another host is never followed', async () => {
  for (const [final, code] of [[`https://${HOST}${SC}Login.aspx?OriginalURL=x`, 'WEB_SIGN_IN_REQUIRED'], ['https://id.outsystems.com/login?state=opaque', 'HOST_MISMATCH']]) {
    const bridge = new FakeBridge({ pages: { [`GET ${SC}X.aspx`]: { ok: true, status: 200, finalUrl: final, contentType: 'text/html', html: '<p/>' } } });
    await assert.rejects(new StudioWebTransport(HOST, bridge).request('X.aspx'), e => coded(code)(e) && !e.message.includes('opaque'), final);
  }
  // Port of 7e7a6d41: an expired session (live, 11.42): the SSO login page answers at the asked URL with HTTP 200.
  const expired = '<form method="post" action="Login.aspx" id="WebForm1"><div class="sc-layout-login"><span>You don\'t have a valid '
    + 'Service Center session.</span><input type="submit" name="wt89$wtContentRight$wtButton2" value="Log in with SSO"></div></form>';
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Show_Error.aspx`]: { ok: true, status: 200, finalUrl: `https://${HOST}${SC}Show_Error.aspx`,
    contentType: 'text/html; charset=utf-8', html: expired } } });
  await assert.rejects(new StudioWebTransport(HOST, bridge).request('Show_Error.aspx'), e => coded('WEB_SIGN_IN_REQUIRED')(e) && e.extra.sent === false);
  for(const accept of ['binary','xlsx','text'])
    await assert.rejects(new StudioWebTransport(HOST, bridge).fetch('Show_Error.aspx',null,accept),
      e=>coded('WEB_SIGN_IN_REQUIRED')(e)&&e.extra.sent===false);
});

test('HTTP 403 never reauthenticates, while explicit 401 retries only one GET', async () => {
  for (const status of [401, 403]) {
    for (const fields of [null, [['save','1']]]) {
      let requests = 0, reentries = 0;
      const transport = new StudioWebTransport(HOST, { web: async () => {
        requests++;
        return {status, finalUrl:`https://${HOST}${SC}X.aspx`, contentType:'text/html',html:'<p>denied</p>'};
      } }, { reenter: async () => { reentries++; } });
      await assert.rejects(transport.request('X.aspx',fields), e => e.code === (status === 403 ? 'NOT_ALLOWED' : 'WEB_SIGN_IN_REQUIRED'));
      const retry = status === 401 && fields === null;
      assert.equal(requests,retry ? 2 : 1);
      assert.equal(reentries,retry ? 1 : 0);
    }
  }
});

test('repeated field names and foreign paths fail before the bridge', async () => {
  const bridge = new FakeBridge();
  const t = new StudioWebTransport(HOST, bridge);
  await assert.rejects(t.request('Write.aspx', [['a', '1'], ['a', '2']]), isProtocol(/repeats/));
  await assert.rejects(t.request('https://evil.test/ServiceCenter/X.aspx'), isProtocol());
  assert.deepEqual(bridge.calls, []);
});

test('a redirected postback is read again; binary fallback never repeats a POST', async () => {
  const bridge = new FakeBridge({ pages: { [`POST ${SC}Edit.aspx`]: { ok: true, status: 0, redirected: true, finalUrl: null }, [`GET ${SC}Edit.aspx`]: '<p>after</p>',
    [`POST ${SC}Download.aspx`]: new BridgeError('BAD_REQUEST', 'accept', { write: false }),
    [`GET ${SC}Download.aspx`]: (f, a) => (a === 'binary' ? new BridgeError('BAD_REQUEST', 'accept', { write: false }) : Buffer.from('PK\x03\x04', 'latin1')) } });
  const t = new StudioWebTransport(HOST, bridge);
  const page = await t.authorizing(uuid(), 'c'.repeat(64), () => t.request('Edit.aspx', [['save', '1']]));
  assert.equal(page.doc.root.text, 'after');
  assert.deepEqual(bridge.calls.map(c => [c[2], c[6]]), [['POST', true], ['GET', false]]);
  await assert.rejects(t.download('Download.aspx', [['d', '1']], 'binary'),{code:'BAD_REQUEST'});
  assert.deepEqual(await t.download('Download.aspx', null, 'binary'), Buffer.from('PK\x03\x04', 'latin1'));
  assert.deepEqual(bridge.calls.slice(2).map(c => [c[2],c[5]]), [['POST','binary'],['GET','binary'],['GET','xlsx']]);
});

test('downloads decode base64 and refuse a page instead of the file', async () => {
  const bridge = new FakeBridge({ pages: { [`POST ${SC}Export.aspx`]: [Buffer.from('PK\x03\x04data', 'latin1'), '<html>login</html>'] } });
  const t = new StudioWebTransport(HOST, bridge);
  assert.deepEqual(await t.download('Export.aspx', [['x', '1']], 'xlsx'), Buffer.from('PK\x03\x04data', 'latin1'));
  await assert.rejects(t.download('Export.aspx', [['x', '1']], 'xlsx'), isProtocol(/page instead of the file/));
});

// ---- Web Forms
test('the OsAjax pager is replayed as the page\'s own form post', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Error_Logs.aspx`]: fixture('error-logs-1.html'), [`POST ${SC}Error_Logs.aspx`]: fixture('error-logs-2.html') } });
  const result = await webClient(bridge).logs('error', 10);
  assert.deepEqual(result.rows.map(r => r.fields.Message), ['NullReference in Checkout', 'Timeout calling PaymentsAPI', 'Invoice rounding']);
  assert.equal(result.truncated, false);
  const form = bridge.posts()[0][4];
  assert.equal(form.__OSVSTATE, 'state-page-1');
  assert.equal(form.__EVENTTARGET, 'wt12$wtNextLink');
  assert.equal(form.__EVENTARGUMENT, '');
  assert.ok(form.__AJAX);
  assert.equal(form['wt12$wtNextLink'], undefined);
  assert.ok(!Object.hasOwn(form, 'wt12$wtFilterButton'));
  assert.equal(bridge.posts()[0][6], false, 'a pager post is a read');
  assert.deepEqual(result.rows.filter(r => JSON.stringify(r.links).includes('Orders') && Object.hasOwn(r, 'RecentItems')), []);
});

test('__doPostBack carries the event and the page state', () => {
  const page = new Page(`https://${HOST}${SC}Solution_Edit.aspx?SolutionId=5`, new Document(fixture('solution-edit.html')));
  const link = page.doc.all('a').find(a => a.text === 'Remove');
  const [url, pairs] = new StudioWebTransport(HOST, new FakeBridge()).eventPost(page, link);
  const fields = Object.fromEntries(pairs);
  assert.equal(url, `https://${HOST}${SC}Solution_Edit.aspx?SolutionId=5`);
  assert.deepEqual([fields.__EVENTTARGET, fields.__EVENTARGUMENT], ['wt3$wtComponents$ctl02$wtRemove', '']);
  assert.deepEqual([fields.__VIEWSTATE, fields.__EVENTVALIDATION], ['vs-solution-5', 'ev-solution-5']);
  assert.ok(!Object.hasOwn(fields, 'wt3$wtAddButton'));
});

test('stack search sets the message and the page\'s stack option', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Error_Logs.aspx`]: fixture('error-logs-1.html'), [`POST ${SC}Error_Logs.aspx`]: fixture('error-logs-2.html') } });
  const result = await webClient(bridge).logs('error', 1, null, { stackContains: 'CheckoutService.Pay' });
  const form = bridge.posts()[0][4];
  assert.deepEqual([form['wt12$wtInput1'], form['wt12$wtEnableSearchStackTrace'], form['wt12$wtFilterButton']], ['CheckoutService.Pay', 'on', 'Filter']);
  assert.equal(result.stackContains, 'CheckoutService.Pay');
  await assert.rejects(webClient(new FakeBridge({ pages: { [`GET ${SC}General_Logs.aspx`]: fixture('error-logs-1.html') } })).logs('general', 1, null, { stackContains: 'x' }), isProtocol(/stack/));
});

test('the full export parses the xlsx and keeps the file', async () => {
  const body = xlsx([['ID', 'INSTANT', 'Espace_Name', 'MESSAGE'], ['e-101', '46296.5', 'Orders', 'NullReference'], ['e-100', '46296.25', 'Orders', 'Timeout']]);
  // The filtered page echoes the chosen module, as Service Center does.
  const filtered = fixture('error-logs-1.html').replaceAll('name="wt12$wtEspace_Selector"><option value="0" selected>', 'name="wt12$wtEspace_Selector"><option value="0">')
    .replaceAll('<option value="42">', '<option value="42" selected>');
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Error_Logs.aspx`]: fixture('error-logs-1.html'), [`POST ${SC}Error_Logs.aspx`]: (form, accept) => (accept === 'xlsx' ? body : filtered) } });
  const result = await webClient(bridge, temp()).logs('error', 1, { module: 'Orders' }, { exportAll: true });
  assert.equal(result.rowCount, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows[0], { ID: 'e-101', INSTANT: '2026-10-01 12:00:00', Espace_Name: 'Orders', MESSAGE: 'NullReference' });
  assert.equal(sha256(fs.readFileSync(result.export.file)), sha256(body));
  const exportForm = bridge.posts().at(-1)[4];
  assert.deepEqual([exportForm['wt12$wtExportButton'], exportForm['wt12$wtEspace_Selector']], ['Export to excel', '42']);
});

test('the export after an AJAX fragment uses its refreshed state', async () => {
  const fragment = '<div><input type="hidden" name="__OSVSTATE" value="state-filtered"></div>';
  const body = xlsx([['ID', 'MESSAGE'], ['e-1', 'm']]);
  const page = fixture('error-logs-1.html').replaceAll('action="Error_Logs.aspx"', 'action="Integration_Logs.aspx"');
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Integration_Logs.aspx`]: page, [`POST ${SC}Integration_Logs.aspx`]: [fragment, body] } });
  const result = await webClient(bridge, temp()).logs('integration', 10, { module: 'Orders' }, { exportAll: true });
  assert.equal(result.rowCount, 1);
  const exportForm = bridge.posts().at(-1)[4];
  assert.deepEqual([exportForm.__OSVSTATE, exportForm['wt12$wtEspace_Selector']], ['state-filtered', '42']);
});

test('xlsx with skipped cells keeps columns', () => {
  assert.deepEqual(xlsxRows(xlsx([['a', '', 'c']])), [['a', '', 'c']]);
  assert.throws(() => xlsxRows(Buffer.from('<html>not a workbook</html>')), isProtocol());
});

// ---- page reads
test('BPT monitoring filter, keys, instance and activities', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}Process_Monitoring.aspx?Index=0`]: fixture('bpt.html'), [`POST ${SC}Process_Monitoring.aspx?Index=0`]: fixture('bpt.html'),
    [`GET ${SC}Process_Instance_Detail.aspx?ProcessId=501`]: fixture('bpt-instance.html') } });
  const client = webClient(bridge);
  const processes = await client.bptProcesses('Orders', 'OrderApproval');
  assert.deepEqual([processes.rows[0].processKey, processes.rows[0].moduleKey], ['pk-1', 'mk-1']);
  assert.deepEqual([bridge.posts()[0][4]['wt4$wtEspace_Selector'], bridge.posts()[0][4]['wt4$wtProcessName']], ['42', 'OrderApproval']);
  const instance = await client.bptInstance('501');
  assert.deepEqual(instance.summary, { Status: 'Active', Tenant: 'Users', 'Last Modified': '2026-10-01 10:02' });
  assert.equal(instance.activities[0].activityId, '77');
  await assert.rejects(client.bptInstance('../1'), isProtocol());
});

test('integrations come from the module page, not Recent Items', async () => {
  const bridge = new FakeBridge({ pages: { [`GET ${SC}eSpace_Edit.aspx?EspaceId=42`]: fixture('module-integrations.html') } });
  const found = (await webClient(bridge).integrations('42')).integrations;
  assert.deepEqual(found.map(i => [i.kind, i.id, i.name]), [['consumed-rest', '31', 'PaymentsAPI'], ['exposed-soap', '8', 'LegacySoap']]);
});

test('one named property stays redacted unless asked and never when masked', async () => {
  const page = (kind, value) => new Page(`https://${HOST}${SC}SiteProperty_Edit.aspx?Id=4`, new Document(
    `<form method="post"><label for="v">Value</label><input id="v" name="wt$wtValue" type="${kind}" value="${value}"><input type="submit" name="s" value="Apply"></form>`));
  const client = webClient(new FakeBridge());
  client.detail = async () => page('text', 'https://partner.example.test');
  assert.equal((await client.propertyValue('3', 'PartnerUrl')).value, '<redacted>');
  assert.equal((await client.propertyValue('3', 'PartnerUrl', true)).value, 'https://partner.example.test');
  client.detail = async () => page('password', 'masked-secret');
  const shown = await client.propertyValue('3', 'ApiKey', true);
  assert.deepEqual([shown.value, shown.secret, shown.revealed], ['<redacted>', true, false]);
});

// ---- page writes
const pageWrites = () => { const dir = temp(); const journal = new Journal(dir); return { dir, journal, execute: (client, action, args, words = 'go') => client.webWrite(action, args, { execute: true, words, operationId: uuid(), journal }) }; };

test('solution selector associates exact component and checkbox removal selects only that row', async () => {
 const s=pageWrites(),bridge=new FakeBridge(),client=webClient(bridge);let associated=false;
 const html=()=>`<form method="post" action="Solution_Edit.aspx?SolutionId=5">
 <select name="root$wtListBox1"><option value="module-key">Orders (Module)</option><option value="other-key">OrdersArchive (Module)</option></select>
 <input type="checkbox" name="root$wtReferenceAddDependencies"><input type="submit" name="associate" value="Associate">
 <table id="root_wtListReferences"><tr><th></th><th>Name</th></tr><tr><td><input type="checkbox" name="other" checked></td><td>Other</td></tr>
 ${associated?'<tr><td><input type="checkbox" name="selected"></td><td><a href="eSpace_Edit.aspx?EspaceId=14">Orders</a><span>(Application) (Module) Description</span></td></tr>':''}</table>
 <input type="submit" name="root$wtReferenceDeleteButton2" value="Dissociate Selected"></form>`;
 client.solutionPage=async()=>new Page(`https://${HOST}${SC}Solution_Edit.aspx?SolutionId=5`,new Document(html()));
 bridge.pages[`POST ${SC}Solution_Edit.aspx?SolutionId=5`]=()=>{associated=!associated;return html();};
 const added=await s.execute(client,'solution-add-component',{solution:'Billing',component:'Orders',includeReferences:false});
 assert.equal(added.state,'confirmed');assert.equal(bridge.posts()[0][4]['root$wtListBox1'],'module-key');
 assert.equal(bridge.posts()[0][4]['root$wtReferenceAddDependencies'],undefined);
 const removed=await s.execute(client,'solution-remove-component',{solution:'Billing',component:'Orders'});
 assert.equal(removed.state,'confirmed');assert.equal(bridge.posts()[1][4].selected,'on');
 assert.equal(bridge.posts()[1][4].other,undefined);
 assert.equal(associated,false);
});

test('solution selector refuses ambiguous module and extension labels',async()=>{
 const bridge=new FakeBridge(),client=webClient(bridge);
 client.solutionPage=async()=>new Page(`https://${HOST}${SC}Solution_Edit.aspx?SolutionId=5`,new Document('<form method="post"><select name="root$wtListBox1"><option value="m">Orders (Module)</option><option value="x">Orders (Extension)</option></select><input type="submit" name="associate" value="Associate"></form>'));
 await assert.rejects(client.webWrite('solution-add-component',{solution:'Billing',component:'Orders'}));
 assert.equal(bridge.posts().length,0);
});

test('solution delete binds header identity, confirms absence and never replays', async () => {
  const s=pageWrites(),bridge=new FakeBridge(),client=webClient(bridge);
  let present=true;
  const html=`<form method="post"><input name="wtSolution_Name" value="Billing"><input type="hidden" name="__VIEWSTATE" value="state">
    <a href="javascript:__doPostBack('wtDelete','')" onclick="return confirm('Delete Billing?')">Delete</a>
    <table><tr><td><a href="javascript:__doPostBack('wtOther','')">Delete</a></td></tr></table></form>`;
  client.solutionPage=async()=>new Page(`https://${HOST}${SC}Solution_Edit.aspx?SolutionId=5`,new Document(html));
  client.solutions=async()=>({solutions:present?[{name:'Billing',id:'5'}]:[],truncated:false});
  bridge.pages[`POST ${SC}Solution_Edit.aspx?SolutionId=5`]=()=>{present=false;return '<p>deleted</p>';};
  const plan=await client.webWrite('solution-delete',{solution:'Billing'});
  assert.equal(plan.solutionId,'5');assert.deepEqual(plan.namedTargets,['Billing']);assert.equal(bridge.posts().length,0);
  const args={execute:true,words:'Delete Billing',operationId:uuid(),journal:s.journal};
  const result=await client.webWrite('solution-delete',{solution:'Billing'},args);
  assert.equal(result.state,'confirmed');assert.equal(bridge.posts().length,1);
  assert.equal(bridge.posts()[0][4].__EVENTTARGET,'wtDelete');
  assert.equal((await client.webWrite('solution-delete',{solution:'Billing'},args)).existingReceipt,true);
  assert.equal(bridge.posts().length,1);
  client.solutions=async()=>({solutions:[],truncated:true});
  assert.equal(await client.observe('solution-delete',{solution:'Billing'},plan),false);
  client.solutions=async()=>({solutions:[{name:'Renamed',id:'5'}],truncated:false});
  assert.equal(await client.observe('solution-delete',{solution:'Billing'},plan),false);
});

test('solution delete refuses changed name, missing id and ambiguous header controls before POST', async () => {
  for(const variant of ['name','id','duplicate']){
    const bridge=new FakeBridge(),client=webClient(bridge);
    const link='<a href="javascript:__doPostBack(\'wtDelete\',\'\')">Delete</a>';
    const html=`<form><input name="wtSolution_Name" value="${variant==='name'?'Other':'Billing'}">${link}${variant==='duplicate'?link:''}</form>`;
    client.solutionPage=async()=>new Page(`https://${HOST}${SC}Solution_Edit.aspx?SolutionId=${variant==='id'?'x':'5'}`,new Document(html));
    await assert.rejects(client.webWrite('solution-delete',{solution:'Billing'}));
    assert.equal(bridge.posts().length,0);
  }
});

test('a page write prepares, then posts once with authorization and confirms by reading', async () => {
  const s = pageWrites();
  const bridge = new FakeBridge();
  const components = new Set(['Orders', 'Billing_Core']);
  solutionPages(bridge, components);
  bridge.pages[`POST ${SC}Solution_Edit.aspx?SolutionId=5`] = () => { components.delete('Orders'); return fixture('solution-edit.html'); };
  const client = webClient(bridge);
  const plan = await client.webWrite('solution-remove-component', { solution: 'Billing', component: 'Orders' });
  assert.equal(plan.execute, false);
  assert.deepEqual(bridge.posts(), []);
  const operation = uuid();
  const receipt = await client.webWrite('solution-remove-component', { solution: 'Billing', component: 'Orders' }, { execute: true, words: 'remove Orders from Billing', operationId: operation, journal: s.journal });
  assert.equal(receipt.state, 'confirmed');
  assert.equal(bridge.posts().length, 1);
  const [, , , , form, , write, sentId, wordsHash] = bridge.posts()[0];
  assert.deepEqual([form.__EVENTTARGET, form.__EVENTARGUMENT], ['wt3$wtComponents$ctl02$wtRemove', '']);
  assert.deepEqual([write, sentId, wordsHash], [true, operation, sha256('remove Orders from Billing')]);
  const again = await client.webWrite('solution-remove-component', { solution: 'Billing', component: 'Orders' }, { execute: true, words: 'remove Orders from Billing', operationId: operation, journal: s.journal });
  assert.equal(again.existingReceipt, true);
  assert.equal(bridge.posts().length, 1);
  assert.ok(!files(s.dir).map(f => fs.readFileSync(path.join(s.dir, f), 'utf8')).join('').includes('remove Orders from Billing'));
});

test('remove component is the row\'s own postback', async () => {
  const s = pageWrites();
  const bridge = new FakeBridge();
  const components = new Set(['Orders', 'Billing_Core']);
  solutionPages(bridge, components);
  bridge.pages[`POST ${SC}Solution_Edit.aspx?SolutionId=5`] = form => { assert.equal(form.__EVENTTARGET, 'wt3$wtComponents$ctl02$wtRemove'); components.delete('Orders'); return fixture('solution-edit.html'); };
  const receipt = await s.execute(webClient(bridge), 'solution-remove-component', { solution: 'Billing', component: 'Orders' });
  assert.equal(receipt.state, 'confirmed');
  assert.ok(receipt.plan.confirm.includes('Remove component Orders'));
});

test('a new database connection sends only vault references for its login', async () => {
  const s = pageWrites();
  const created = [];
  const listing = () => fixture('db-connections.html').replaceAll('</table>', created.map(n => `<tr><td><a href="DatabaseConnection_Edit.aspx?DBConnectionId=9">${n}</a></td><td>SQL Server</td></tr>`).join('') + '</table>');
  const pages = { [`GET ${SC}DatabaseConnections_List.aspx`]: listing, [`GET ${SC}DatabaseConnection_Edit.aspx`]: fixture('db-connection-new.html'),
    [`POST ${SC}DatabaseConnection_Edit.aspx`]: form => { created.push(form['wt5$wtConnection_Name']); return fixture('db-connections.html'); } };
  const args = { connection: 'NewDb', dbms: 'SqlServer', server: 'sql.example.test', database: 'erp', parameters: {} };
  // A bridge that does not fill secretRefs would post the empty placeholders: refused before any reservation.
  const old = new FakeBridge({ pages });
  await assert.rejects(s.execute(webClient(old), 'db-connection-create', args), coded('STUDIO_BRIDGE_OUTDATED'));
  assert.deepEqual([old.posts(), files(s.dir)], [[], []]);
  const bridge = new FakeBridge({ pages, capabilities: ['sc_http:studioSession', 'sc_web', 'sc_web:secretRefs'] });
  const client = webClient(bridge);
  const plan = await client.webWrite('db-connection-create', args);
  const target = 'SSAM/O11/test.example.com/DatabaseConnection/NewDb';
  assert.deepEqual([plan.dbms, plan.loginStored, plan.loginTarget, plan.secretRefsSupported], ['SQL Server', true, target, true]);
  const receipt = await s.execute(client, 'db-connection-create', args);
  assert.equal(receipt.state, 'confirmed');
  const form = bridge.posts()[0][4];
  assert.deepEqual(['wt5$wtConnection_Name', 'wt5$ctl07$wtParam', 'wt5$ctl09$wtParam', 'wt5$ctl11$wtParam', 'wt5$ctl13$wtParam'].map(k => form[k]), ['NewDb', 'sql.example.test', 'erp', '', '']);
  assert.deepEqual(bridge.refsOf(bridge.posts()[0]), [{ pointer: '/wt5$ctl11$wtParam', target, field: 'username' }, { pointer: '/wt5$ctl13$wtParam', target, field: 'password' }]);
  await assert.rejects(client.webWrite('db-connection-create', { ...args, connection: 'Other', parameters: { Password: 'x' } }), isProtocol(/Secrets never travel/));
  await assert.rejects(client.webWrite('db-connection-create', { ...args, connection: 'Other', parameters: { 'User name': 'x' } }), isProtocol(/Secrets never travel/));
});

test('the extension mapping is an OsAjax Change, then Apply with the refreshed state', async () => {
  const s = pageWrites();
  const mapped = [];
  const extension = () => { const html = fixture('extension-edit.html').replace(", '', '__OSVSTATE,'", ", 'Change', '__OSVSTATE,'"); return mapped.length ? html.replaceAll('<option value="3">', '<option value="3" selected>').replaceAll('value="0" selected', 'value="0"') : html; };
  const post = form => {
    if (Object.hasOwn(form, '__AJAXEVENT')) {
      assert.deepEqual([form.__AJAXEVENT, form['wt7$wtOperations$ctl02$wtDBConnectionCombo']], ['Change', '3']);
      return { ok: true, status: 200, finalUrl: `https://${HOST}${SC}Extension_Edit.aspx?ExtensionId=12`, contentType: 'text/plain', html: '{"__OSVSTATE":"ext-state-2","html":""}' };
    }
    assert.deepEqual([form.__OSVSTATE, form['wt7$wtOperations$ctl02$wtDBConnectionCombo'], form['wt7$wtOperations_ApplyButton']], ['ext-state-2', '3', 'Apply']);
    mapped.push(true);
    return fixture('extension-edit.html');
  };
  const bridge = new FakeBridge({ pages: { [`GET ${SC}DatabaseConnections_List.aspx`]: fixture('db-connections.html'), [`GET ${SC}Extension_Edit.aspx?ExtensionId=12`]: extension,
    [`POST ${SC}Extension_Edit.aspx?ExtensionId=12`]: post } });
  const receipt = await s.execute(webClient(bridge), 'extension-db-connection', { extensionId: '12', connection: 'LegacyERP' });
  assert.equal(receipt.state, 'confirmed');
  // The OsAjax Change only stages the value (a read postback); Apply is the one write, sent once with its operationId.
  assert.deepEqual(bridge.posts().map(p => p[6]), [false, true]);
  assert.equal(bridge.posts()[1][7], receipt.operationId);
});

test('two logical database selectors advance once per receipt and expose the remaining continuation',async()=>{
 const s=pageWrites(),names=['wt7$wtOperations$ctl02$wtDBConnectionCombo','wt7$wtOperations$ctl03$wtDBConnectionCombo'];
 const values=['0','0'];
 const render=()=>{
  const base=fixture('extension-edit.html'),select=base.match(/<select[\s\S]*?<\/select>/)[0];
  return base.replace(select,names.map((name,i)=>{
   const html=select.replaceAll('ctl02',i?'ctl03':'ctl02');
   return values[i]==='3'?html.replace('value="0" selected','value="0"').replace('value="3"','value="3" selected'):html;
  }).join(''));
 };
 const bridge=new FakeBridge({pages:{[`GET ${SC}DatabaseConnections_List.aspx`]:fixture('db-connections.html'),
  [`GET ${SC}Extension_Edit.aspx?ExtensionId=12`]:render,
  [`POST ${SC}Extension_Edit.aspx?ExtensionId=12`]:form=>{
   if(Object.hasOwn(form,'__AJAX'))return {ok:true,status:200,finalUrl:`https://${HOST}${SC}Extension_Edit.aspx?ExtensionId=12`,contentType:'text/plain',html:'{"__OSVSTATE":"next-state","html":""}'};
   names.forEach((name,i)=>{values[i]=form[name];});return render();
  }}});
 const client=webClient(bridge),args={extensionId:'12',connection:'LegacyERP'};
 const first=await s.execute(client,'extension-db-connection',args);assert.equal(first.state,'accepted');assert.equal(first.remainingSelectors,1);
 assert.deepEqual(values,['3','0']);assert.equal(first.continuation.tool,'o11_service_center_write');
 const repeated=await client.webWrite('extension-db-connection',args,{execute:true,words:'go',operationId:first.operationId,journal:s.journal});
 assert.equal(repeated.existingReceipt,true);assert.equal(bridge.posts().length,2);
 const second=await s.execute(client,'extension-db-connection',args);assert.equal(second.state,'confirmed');assert.deepEqual(values,['3','3']);
 assert.deepEqual(bridge.posts().map(p=>p[6]),[false,true,false,true]);
});

test('extension mapping refuses concurrent selection changes before Change or Apply', async () => {
  for (const selected of ['3', '9']) {
    const s=pageWrites();let reads=0;
    const base=fixture('extension-edit.html').replace('</select>','<option value="9">Other database</option></select>');
    const changed=base.replaceAll('value="0" selected','value="0"').replaceAll(`<option value="${selected}">`,`<option value="${selected}" selected>`);
    const bridge=new FakeBridge({pages:{
      [`GET ${SC}DatabaseConnections_List.aspx`]:fixture('db-connections.html'),
      [`GET ${SC}Extension_Edit.aspx?ExtensionId=12`]:()=>++reads===1?base:changed,
    }});
    const receipt=await s.execute(webClient(bridge),'extension-db-connection',{extensionId:'12',connection:'LegacyERP'});
    assert.equal(receipt.state,'refused'); assert.equal(receipt.code,'SC_MAPPING_CHANGED'); assert.equal(receipt.sent,false);
    assert.deepEqual(bridge.posts(),[]);
  }
});

test('extension mapping restores the native unconfigured option and verifies it without a connection lookup', async () => {
  const s=pageWrites();let mapped=true;
  const base=fixture('extension-edit.html').replace('(Platform database)','(not configured)').replace('value="0"','value="17"');
  const extension=()=>mapped?base.replaceAll('<option value="3">','<option value="3" selected>').replaceAll('value="17" selected','value="17"'):base;
  const post=form=>{
    assert.equal(form['wt7$wtOperations$ctl02$wtDBConnectionCombo'],'17');
    if(Object.hasOwn(form,'__AJAX'))return {ok:true,status:200,finalUrl:`https://${HOST}${SC}Extension_Edit.aspx?ExtensionId=12`,contentType:'text/plain',html:'{"__OSVSTATE":"clear-state","html":""}'};
    assert.equal(form.__OSVSTATE,'clear-state');mapped=false;return extension();
  };
  const bridge=new FakeBridge({pages:{[`GET ${SC}Extension_Edit.aspx?ExtensionId=12`]:extension,[`POST ${SC}Extension_Edit.aspx?ExtensionId=12`]:post}});
  const client=webClient(bridge),args={extensionId:'12',connection:'(not configured)'};
  const plan=await client.webWrite('extension-db-connection',args);
  assert.equal(plan.currentSelections[0].value,'3');assert.equal(plan.connectionId,'17');
  const receipt=await s.execute(client,'extension-db-connection',args);
  assert.equal(receipt.state,'confirmed');assert.equal(mapped,false);
  assert.deepEqual(bridge.posts().map(p=>p[6]),[false,true]);
});

test('extension mapping never confirms an ignored change or a missing selector', async () => {
  for (const missing of [false, true]) {
    const s=pageWrites();let applied=false;
    const base=fixture('extension-edit.html');
    const bridge=new FakeBridge({pages:{
      [`GET ${SC}DatabaseConnections_List.aspx`]:fixture('db-connections.html'),
      [`GET ${SC}Extension_Edit.aspx?ExtensionId=12`]:()=>applied&&missing?'<p>no selectors</p>':base,
      [`POST ${SC}Extension_Edit.aspx?ExtensionId=12`]:form=>{
        if(Object.hasOwn(form,'__AJAX'))return {ok:true,status:200,finalUrl:`https://${HOST}${SC}Extension_Edit.aspx?ExtensionId=12`,contentType:'text/plain',html:'{"__OSVSTATE":"next-state","html":""}'};
        applied=true;return base;
      }
    }});
    const receipt=await s.execute(webClient(bridge),'extension-db-connection',{extensionId:'12',connection:'LegacyERP'});
    assert.equal(receipt.state,'accepted-unverified');assert.equal(receipt.observedDesiredState,false);
    assert.equal(receipt.observedSelections.length,missing?0:1);
    if(missing)assert.equal(receipt.observationMismatch,'database-selectors-changed');
    else assert.equal(receipt.observedSelections[0].value,'0');
    assert.deepEqual(bridge.posts().map(p=>p[6]),[false,true]);
  }
});

test('the integration log level reads back', async () => {
  const s = pageWrites();
  const level = ['selected', ''];
  const bridge = new FakeBridge({ pages: { [`GET ${SC}eSpace_Edit.aspx?EspaceId=42`]: fixture('module-integrations.html'),
    [`GET ${SC}eSpace_RestWebReference_Edit.aspx?RestWebreferenceId=31&EspaceId=42`]: () => fixture('integration-detail.html', { DEFAULT: level[0], FULL: level[1] }) } });
  bridge.pages[`POST ${SC}eSpace_RestWebReference_Edit.aspx?RestWebreferenceId=31&EspaceId=42`] = form => { assert.equal(form['wt9$wtHttpTracingCombo'], '1'); level.splice(0, 2, '', 'selected'); return '<p>ok</p>'; };
  const client = webClient(bridge);
  const plan = await client.webWrite('integration-log-level', { moduleId: '42', integration: 'PaymentsAPI', level: 'Full' });
  assert.deepEqual([plan.currentLevel, plan.changed, plan.kind], ['Default', true, 'consumed-rest']);
  await assert.rejects(s.execute(client, 'integration-log-level', { moduleId: '42', integration: 'PaymentsAPI', level: 'Full', expectedValue: 'Troubleshoot' }), /expected value/);
  assert.equal(bridge.posts().length, 0);
  const receipt = await s.execute(client, 'integration-log-level', { moduleId: '42', integration: 'PaymentsAPI', level: 'Full', expectedValue: 'Default' });
  assert.deepEqual([receipt.state, receipt.observedLevel], ['confirmed', 'Full']);
  await assert.rejects(s.execute(client, 'integration-log-level', { moduleId: '42', integration: 'PaymentsAPI', level: 'Default', expectedValue: 'Troubleshoot' }), /expected value/);
  assert.equal(bridge.posts().length, 1);
});

test('a write the bridge refuses is refused and one it loses stays uncertain', async () => {
  for (const [error, state, locked] of [[new BridgeError('NOT_ALLOWED', 'outside allowlist', { write: true }), 'refused', false],
    [new BridgeError('UNCERTAIN', 'lost after send', { write: true }), 'uncertain', true]]) {
    const dir = temp();
    const bridge = new FakeBridge();
    solutionPages(bridge, new Set(['Orders', 'Billing_Core']));
    bridge.pages[`POST ${SC}Solution_Edit.aspx?SolutionId=5`] = error;
    const receipt = await webClient(bridge).webWrite('solution-remove-component', { solution: 'Billing', component: 'Orders' }, { execute: true, words: 'go', operationId: uuid(), journal: new Journal(dir) });
    assert.equal(receipt.state, state);
    assert.equal(files(dir, /\.lock$/).length > 0, locked, state);
  }
});

// ---- Studio API (bridge sc_api)
function studioApi() {
  const dir = temp();
  const s = { dir, journal: new Journal(dir), modules: [{ Key: 'k-orders', Name: 'Orders' }, { Key: 'k-billing', Name: 'Billing' }], associated: false };
  s.remove = args => { s.modules = s.modules.filter(m => m.Key !== args.moduleKey); return { success: true, message: null }; }; // the shape Anvil.Bridge ScApi projects for DeleteModule
  s.bridge = new FakeBridge({ api: { ListApplications: [], ListEspaces: () => [...s.modules], ListExtensions: [], GetConsumers: [{ Name: 'Billing' }], DeleteModule: a => s.remove(a) } });
  s.clock = fakeClock(); s.root = temp();
  s.run = (...argv) => main([...argv, '--host', HOST], { journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false,
    opener: () => assert.fail('no prompt with a Studio connected'), exports: dir, registry: REGISTRY, sleep: async () => {}, clock: s.clock, destructiveRoot: s.root, backup: noBackup });
  // CX15: the preview, 5 s on the fake clock, then the token with the owner's words.
  s.confirm = async (argv, words) => (await previewThenConfirm(s.run, argv, words, { clock: s.clock })).result;
  s.deletes = () => s.bridge.calls.filter(c => c[0] === 'api' && c[2] === 'DeleteModule');
  return s;
}

// module-delete is an alias of the delete engine (delete.mjs): two calls since CX15, the preview without the token, the
// execution with it and the owner's words given after the preview (with the count).
test('module delete previews without the token, refuses words that do not name the module and its consumer, then deletes with the token', async () => {
  const s = studioApi();
  const plan = await s.run('module-delete', '--module', 'Orders');
  // CX15: the list of a preview is its items (each with its consumers).
  assert.deepEqual([plan.state, plan.items.map(t => t.key), Object.fromEntries(plan.items.map(i => [i.name, i.consumers])), plan.auth.path], ['previewed', ['k-orders'], { Orders: ['Billing'] }, 'studio']);
  assert.deepEqual(s.deletes(), []);
  const operation = plan.operationId;
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const refused = await s.run('module-delete', '--confirmation-token', plan.confirmationToken, '--words', 'yes delete it, the 1, on test', '--confirm-host', HOST);
  assert.deepEqual([refused.code, refused.problems.map(p => p.code).sort()], ['DELETE_REFUSED', ['CONSUMERS_WOULD_BREAK', 'WORDS_MUST_NAME']]);
  assert.deepEqual([s.deletes(), files(s.dir)], [[], []]);
  const words = 'delete the 1 module Orders on test; Billing breaks and that is fine';
  const receipt = await s.run('module-delete', '--confirmation-token', plan.confirmationToken, '--words', words, '--confirm-host', HOST);
  assert.deepEqual([receipt.state, receipt.operationId], ['confirmed', operation]);
  assert.equal(s.deletes().length, 1);
  const [, surface, , args, write, sentId, wordsHash] = s.deletes()[0];
  assert.deepEqual([surface, args, write, sentId, wordsHash], ['soap', { moduleKey: 'k-orders', moduleKind: 'eSpace' }, true, derivedOperationId(operation, 'module', 'k-orders', 1), sha256(words)]);
  // The destructive call names its key as target, and a corporate host write carries the explicit instruction.
  assert.ok(s.bridge.targets.includes('k-orders'));
  assert.equal(s.bridge.corporate, true);
  const again = await s.run('module-delete', '--confirmation-token', plan.confirmationToken, '--words', words, '--confirm-host', HOST);
  assert.deepEqual([again.state, again.absent.map(a => a.key)], ['absent', ['k-orders']]);
  assert.equal(s.deletes().length, 1);
});

test('a lost API write stays uncertain and allows one new send only; a refused one releases the target', async () => {
  const s = studioApi();
  s.bridge.replies.DeleteModule = new BridgeError('UNCERTAIN', 'connection lost after send', { write: true });
  // CX15: every round is a new preview and the owner's new reply (words seen before a preview never confirm it).
  const base = ['extension-delete', '--module-key', 'k-orders', '--confirm-host', HOST];
  const round = words => s.confirm(base, words);
  s.bridge.replies.ListExtensions = () => [...s.modules];
  assert.equal((await round('delete the 1, Orders and Billing test')).state, 'uncertain');
  // Read again as still there, unchanged: exactly one new send, never a third.
  assert.equal((await round('again: delete the 1, Orders and Billing test')).state, 'uncertain');
  // The third round is refused by its preview already: the target's last delete was sent twice.
  const third = await s.run(...base);
  assert.deepEqual([third.code, third.problems.map(p => p.code)], ['DELETE_REFUSED', ['DELETE_UNCONFIRMED']]);
  assert.equal(s.deletes().length, 2);
  s.journal = new Journal(path.join(s.dir, 'other'));
  s.bridge.replies.DeleteModule = new BridgeError('NOT_ALLOWED', 'outside the allowlist', { write: true });
  const refused = await round('now: delete the 1, Orders and Billing test');
  assert.deepEqual([refused.state, refused.code], ['refused', 'NOT_ALLOWED']);
  assert.deepEqual(files(path.join(s.dir, 'other'), /\.lock$/), []);
  s.bridge.replies.DeleteModule = a => s.remove(a);
  assert.equal((await round('finally: delete the 1, Orders and Billing test')).state, 'confirmed');
});

test('solution publish sends the prepared package once and returns its job', async () => {
  const s = studioApi();
  const osp = path.join(s.dir, 'Billing.osp');
  fs.writeFileSync(osp, Buffer.from('PK\x03\x04solution', 'latin1'));
  s.bridge.replies.PublishSolution = { messages: [], solutionPublishId: 17, packUID: 'p', needsConfiguration: false };
  const receipt = await s.run('solution-publish', '--solution', 'Billing', '--osp-file', osp, '--execute', '--operation-id', uuid(), '--words', 'publish Billing on test', '--confirm-host', HOST);
  assert.deepEqual([receipt.state, receipt.solutionPublishId, receipt.executionCompleted], ['accepted', 17, false]);
  assert.equal(receipt.continuation.arguments.action, 'solution-publish-status');
  const call = s.bridge.calls.find(c => c[0] === 'api' && c[2] === 'PublishSolution');
  assert.deepEqual(call[3], { file: osp, filename: 'Billing.osp' });
  const finish = { Type: 'State', MessageDefinition: { Message: 'finish' } };
  const success = { Type: 'Info', MessageDefinition: { Detail: 'The solution was successfully published. 1 module was published.' } };
  for (const messages of [[], [finish], [success], [finish, success, {Type:'Error'}]]) {
    s.bridge.replies.CheckSolutionPublish = {messages, lastMessageId: 19};
    const pending = await s.run('verify', '--operation-id', receipt.operationId);
    assert.equal(pending.state, 'accepted');
    assert.equal(pending.observedDesiredState, false);
    assert.equal(pending.executionCompleted, false);
  }
  s.bridge.replies.CheckSolutionPublish = {messages:[finish,success],lastMessageId:20};
  await assert.rejects(s.run('solution-publish-status', '--publish-id', '18', '--operation-id', receipt.operationId), /must match/);
  await assert.rejects(s.run('solution-publish-status', '--publish-id', '17', '--operation-id', receipt.operationId, '--last-message-id', '10'), /complete publication status/);
  const status = await s.run('solution-publish-status', '--publish-id', '17', '--operation-id', receipt.operationId);
  assert.equal(status.receiptState, 'confirmed');
  assert.equal(status.executionCompleted, true);
  const verified = s.journal.lookup(receipt.operationId);
  assert.equal(verified.state, 'confirmed');
  assert.equal(verified.executionCompleted, true);
  assert.equal(verified.publicationObservation.solutionPublishId, 17);
  assert.equal(verified.publicationObservation.lastMessageId, 20);
  assert.equal(s.bridge.calls.filter(c => c[0] === 'api' && c[2] === 'PublishSolution').length, 1);
  const reads = s.bridge.calls.filter(c => c[0] === 'api' && c[2] === 'CheckSolutionPublish').length;
  s.bridge.replies.CheckSolutionPublish = new Error('Job already removed');
  const cached = await s.run('solution-publish-status', '--publish-id', '17', '--operation-id', receipt.operationId);
  assert.equal(cached.source, 'confirmed-receipt');
  assert.equal(s.bridge.calls.filter(c => c[0] === 'api' && c[2] === 'CheckSolutionPublish').length, reads);
});

test('database diagnostics preserve explicit lack of evidence through the public command result',async()=>{
 const s=studioApi();
 const run=(...args)=>runServiceCenter([...args,'--host',HOST],{journal:s.journal,locate:()=>s.bridge,present:async()=>false,running:async()=>false,
  opener:()=>assert.fail('No prompt'),exports:s.dir,registry:REGISTRY,sleep:async()=>{}});
 s.bridge.replies.ListDatabases=new BridgeError('REMOTE_ERROR','server-api ListDatabases: NotFoundException: Http Error Code: 404 - Not Found. ');
 const inventory=await run('databases');
 assert.equal(inventory.ok,false);assert.equal(inventory.code,'SC_DATABASE_ENDPOINT_UNAVAILABLE');
 assert.equal(inventory.inventoryVerified,false);assert.equal(inventory.emptyInventoryProven,false);
 s.bridge.replies.GetDatabaseByApplicationKey=new BridgeError('REMOTE_ERROR','server-api GetDatabaseByApplicationKey: BadRequestException: Database not returned');
 const database=await run('application-database','--application-key','app-1');
 assert.equal(database.code,'SC_APPLICATION_DATABASE_UNVERIFIED');assert.equal(database.databaseVerified,false);assert.equal(database.databaseAbsentProven,false);
});

test('apply settings and the database association use their surfaces', async () => {
  const s = studioApi();
  // apply-settings: the PUT the bridge sends itself, {status, body: StartApplySettingsServerResponse}.
  Object.assign(s.bridge.replies, { ListApplications: [{ Key: 'app-1', Name: 'Orders App' }], 'apply-settings': { status: 200, body: { OperationId: 55, REST_Error: null } },
    ListDatabases: [{ Id: 'db-2', Name: 'Main' }], GetDatabaseByApplicationKey: () => ({ Id: s.associated ? 'db-2' : 'db-1' }),
    AssociateAppWithDatabase: () => { s.associated = true; return { associated: true }; } });
  const settings = await s.run('apply-settings', '--application', 'Orders App', '--execute', '--operation-id', uuid(), '--words', 'apply settings test', '--confirm-host', HOST);
  assert.deepEqual([settings.state, settings.applyId], ['accepted', 55]);
  assert.equal(settings.continuation.arguments.operationId, settings.operationId);
  await assert.rejects(s.run('apply-settings-status', '--apply-id', '56', '--operation-id', settings.operationId), /must match/);
  for (const result of [{Status:'running',REST_Error:{ErrorMessage:''}},
    {Status:'finished',REST_Error:{ErrorMessage:'Failed'}}, {Status:'finished',REST_Error:{ErrorMessage:'',ErrorCode:5}}]) {
    s.bridge.replies['apply-settings-status'] = result;
    const observed = await s.run('apply-settings-status', '--apply-id', '55', '--operation-id', settings.operationId);
    assert.equal(observed.receiptState, 'accepted');
    assert.equal(observed.executionCompleted, false);
  }
  s.bridge.replies['apply-settings-status'] = {Status:'finished'};
  await assert.rejects(s.run('apply-settings-status', '--apply-id', '55', '--operation-id', settings.operationId), /Unrecognized/);
  s.bridge.replies['apply-settings-status'] = {Status:'finished',REST_Error:{ErrorMessage:'',ErrorCode:null}};
  const complete = await s.run('apply-settings-status', '--apply-id', '55', '--operation-id', settings.operationId);
  assert.equal(complete.receiptState, 'confirmed');
  assert.equal(complete.executionCompleted, true);
  assert.equal(s.journal.lookup(settings.operationId).state, 'confirmed');
  s.bridge.replies['apply-settings-status'] = new Error('Job gone');
  assert.equal((await s.run('apply-settings-status', '--apply-id', '55', '--operation-id', settings.operationId)).source, 'confirmed-receipt');
  assert.equal(s.bridge.calls.filter(c=>c[0]==='api'&&c[2]==='apply-settings').length, 1);
  const database = await s.run('application-database-set', '--application-key', 'app-1', '--database-id', 'db-2', '--execute', '--operation-id', uuid(), '--words', 'use db-2 test', '--confirm-host', HOST);
  assert.equal(database.state, 'confirmed');
  assert.deepEqual(Object.fromEntries(s.bridge.calls.filter(c => c[0] === 'api' && c[4]).map(c => [c[2], c[1]])), { 'apply-settings': 'sc-rest', AssociateAppWithDatabase: 'server-api' });
});

test('API writes the server refused are rejected', async () => {
  const s = studioApi();
  Object.assign(s.bridge.replies, { DeleteModule: { success: false, message: 'Module has consumers' }, ListApplications: [{ Key: 'app-1', Name: 'Orders App' }],
    'apply-settings': { status: 200, body: { OperationId: 0, REST_Error: { ErrorMessage: 'Application is locked' } } } });
  const deleted = await s.confirm(['module-delete', '--module', 'Orders', '--confirm-host', HOST], 'delete the 1 module Orders and Billing on test');
  assert.deepEqual([deleted.state, deleted.code, deleted.message], ['refused', 'DELETE_REJECTED', 'Module has consumers']);
  const settings = await s.run('apply-settings', '--application-key', 'app-1', '--execute', '--operation-id', uuid(), '--words', 'apply settings test', '--confirm-host', HOST);
  assert.deepEqual([settings.state, settings.message], ['rejected', 'Application is locked']);
  assert.deepEqual(files(s.dir, /\.lock$/), []);
});

test('verify reconciles an uncertain delete by reading only', async () => {
  const s = studioApi();
  s.bridge.replies.DeleteModule = a => { s.remove(a); return new BridgeError('UNCERTAIN', 'reply lost', { write: true }); };
  const receipt = await s.confirm(['module-delete', '--module', 'Orders', '--confirm-host', HOST], 'delete the 1, Orders and Billing on test');
  const operation = receipt.operationId;
  assert.equal(receipt.state, 'uncertain');
  const verified = await s.run('verify', '--operation-id', operation);
  assert.deepEqual([verified.observedDesiredState, verified.state, verified.replayed], [true, 'confirmed', false]);
  assert.equal(s.deletes().length, 1);
  assert.deepEqual(files(s.dir, /\.lock$/), []);
});

test('reads pass named arguments and redact secrets', async () => {
  const s = studioApi();
  s.bridge.replies.ListCommits = { returnValue: [{ Name: 'Orders', Password: 'p@ss', Note: 'Bearer abcdefghijkl' }] };
  const result = await s.run('commits', '--since', '2026-10-01T00:00:00Z');
  const call = s.bridge.calls.at(-1);
  assert.deepEqual([call[2], call[3], call[4]], ['ListCommits', { eSpacesStartVersion: 0, extensionsStartVersion: 0, startDate: '2026-10-01T00:00:00Z' }, false]);
  assert.ok(!JSON.stringify(result).includes('p@ss'));
  assert.ok(!JSON.stringify(result).includes('abcdefghijkl'));
  assert.equal(result.auth.path, 'studio');
  const modules = await s.run('modules');
  assert.deepEqual(modules.result.map(m => m.Name), ['Orders', 'Billing']);
});

test('platform properties hide opaque authentication material from an older bridge', async () => {
  const s = studioApi();
  const marker = 'fictional-opaque-auth-material';
  s.bridge.replies.GetProperties = { HubServerVersion: '11.42.1', ForceSecureAlgorithmsInAuthentication: marker };
  const result = await s.run('platform-properties');
  assert.equal(result.result.HubServerVersion, '11.42.1');
  assert.equal(result.result.ForceSecureAlgorithmsInAuthentication, '<redacted>');
  assert.ok(!JSON.stringify(result).includes(marker));
  const pair = redact([{ Key: 'ForceSecureAlgorithmsInAuthentication', Value: marker }]);
  assert.equal(pair[0].Value, '<redacted>');
  assert.equal(pair[0].Key, 'ForceSecureAlgorithmsInAuthentication');
});

// ---- Studio API writes of this wave
function apiWrites() {
  const dir = temp();
  const s = { dir, journal: new Journal(path.join(dir, 'receipts')), simulation: true,
    apps: [{ Key: 'app-1', Name: 'Sample Orders' }, { Key: 'app-2', Name: 'Sample Shared' }],
    // The shapes Anvil.Bridge projects (ListEspaces: {key, name, applicationKey...}; ListVersions: ModuleInfo).
    modules: [{ key: 'k-orders', name: 'SampleOrders', applicationKey: 'app-1' }, { key: 'k-scratch', name: 'ZZSampleScratch', applicationKey: 'app-2' }],
    extensions: [{ key: 'x-util', name: 'SampleUtilExt', applicationKey: 'app-2', versionId: 3203 }],
    versions: [{ Version: 12, Version_Id: 5012, CommitMessage: 'Synthetic commit' }, { Version: 11, Version_Id: 4990, CommitMessage: 'older' }] };
  const relocate = (key, application) => { for (const row of [...s.modules, ...s.extensions]) if (row.key === key) row.applicationKey = application; return { success: true, message: null }; };
  s.bridge = new FakeBridge({ api: { ListApplications: () => s.apps.map(x => ({ ...x })), ListEspaces: () => s.modules.map(m => ({ ...m })),
    ListExtensions: () => s.extensions.map(x => ({ ...x })), ListVersions: () => s.versions.map(v => ({ ...v })),
    DeleteApplication: args => {
      if (args.simulate) return { success: s.simulation, simulated: true, messages: [{ Id: 'AppDeleteSimulation', Message: 'would delete', Type: 'Info' }], affectedApplications: ['Sample Orders'], deletedModules: ['ZZSampleScratch'] };
      s.apps = s.apps.filter(x => x.Key !== args.appKey);
      return { success: true, simulated: false, messages: [], affectedApplications: ['Sample Orders'], deletedModules: ['ZZSampleScratch'] };
    },
    // Live (11.42, port of 7d6e457b): a successful move answers an empty HEMessage whose default Type is Error.
    MoveModuleBetweenApps: args => { relocate(args.moduleKey, args.toAppKey); return { success: true, message: { Type: 'Error', MessageDefinition: { Id: '', Message: '', Detail: '', Type: 'Error' } } }; },
    AddModuleToApplication: args => relocate(args.moduleKey, args.appKey),
    ChangeCommitMessage: args => { for (const row of s.versions) if (row.Version_Id === args.eSpaceVersionId) row.CommitMessage = args.newCommitMessage; return { changed: true }; },
    UploadAndPublishExtension: () => { s.extensions.push({ key: 'x-new', name: 'SampleNewExt', versionId: 3300 }); return { messages: [], extensionId: 205, extensionVersionId: 3300 }; } } });
  s.clock = fakeClock(); s.root = temp();
  s.run = (...argv) => main([...argv, '--host', HOST], { journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false,
    opener: () => assert.fail('no prompt with a Studio connected'), exports: dir, registry: REGISTRY, clock: s.clock, destructiveRoot: s.root, backup: noBackup });
  s.execute = (words, ...argv) => s.run(...argv, '--execute', '--operation-id', uuid(), '--words', words, '--confirm-host', HOST);
  // CX15: a delete executes with the preview's token and the owner's words given after it (5 s on the fake clock).
  s.confirmToken = (token, words, ...argv) => { s.clock.advance(CONFIRM_MIN_AGE_MS); return s.run(...argv, '--confirmation-token', token, '--words', words, '--confirm-host', HOST); };
  s.apiCalls = operation => s.bridge.calls.filter(c => c[0] === 'api' && c[2] === operation);
  return s;
}

test('application delete reads the simulation in the preview, then deletes with the token and words naming it and its affected applications', async () => {
  const s = apiWrites();
  const plan = await s.run('application-delete', '--application', 'Sample Shared');
  // CX15: the list of a preview is its items; cascade = the simulation's deletedModules plus the listing rows of the app
  // (here its extension SampleUtilExt, which the simulation did not name).
  assert.deepEqual([plan.state, plan.items.map(t => t.key), plan.items.flatMap(i => i.cascade), plan.wordsMustName], ['previewed', ['app-2'], ['ZZSampleScratch', 'SampleUtilExt'], ['Sample Shared', 'Sample Orders']]);
  assert.equal(s.apiCalls('DeleteApplication').length, 1);
  const [, surface, , args, write, operation] = s.apiCalls('DeleteApplication')[0];
  assert.deepEqual([surface, args, write, operation], ['soap', { appKey: 'app-2', simulate: true }, false, null]);
  const refused = await s.confirmToken(plan.confirmationToken, 'delete it, the 1, on test', 'application-delete');
  assert.deepEqual(refused.problems.map(p => p.code).sort(), ['CONSUMERS_WOULD_BREAK', 'WORDS_MUST_NAME']);
  assert.deepEqual(s.apiCalls('DeleteApplication').filter(c => c[4]), []);
  const receipt = await s.confirmToken(plan.confirmationToken, 'delete the 1, Sample Shared on test, Sample Orders is affected', 'application-delete');
  assert.equal(receipt.state, 'confirmed');
  const writes = s.apiCalls('DeleteApplication').filter(c => c[4]);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0][3], writes[0][4], writes[0][5]], [{ appKey: 'app-2', simulate: false }, true, derivedOperationId(receipt.operationId, 'application', 'app-2', 1)]);
  // The destructive call names its key as target, so the bridge checks it against the arguments.
  assert.deepEqual(s.bridge.targets.filter(Boolean), ['app-2']);
});

test('a delete the server\'s simulation refuses is never sent', async () => {
  const s = apiWrites();
  s.simulation = false;
  const plan = await s.run('application-delete', '--application', 'Sample Orders');
  assert.deepEqual([plan.code, plan.problems.map(p => p.code)], ['DELETE_REFUSED', ['SIMULATION_REFUSED']]);
  assert.match(plan.problems[0].message, /refuses/);
  const refused = await s.execute('delete Sample Orders on test', 'application-delete', '--application', 'Sample Orders');
  assert.deepEqual(refused.problems.map(p => p.code), ['SIMULATION_REFUSED']);
  assert.deepEqual([s.apiCalls('DeleteApplication').filter(c => c[4]), fs.existsSync(path.join(s.dir, 'receipts'))], [[], false]);
});

test('module move and add resolve keys and read the listing back', async () => {
  const s = apiWrites();
  const moved = await s.execute('move ZZSampleScratch on test', 'module-move', '--module', 'ZZSampleScratch', '--to-application', 'Sample Orders');
  assert.deepEqual([moved.state, moved.observedApplicationKey, moved.message], ['confirmed', 'app-1', null]);
  assert.deepEqual(s.apiCalls('MoveModuleBetweenApps')[0][3], { fromAppKey: 'app-2', toAppKey: 'app-1', moduleKind: 'eSpace', moduleKey: 'k-scratch' });
  await assert.rejects(s.run('module-move', '--module', 'ZZSampleScratch', '--to-application-key', 'app-1'), isProtocol(/already belongs/));
  const added = await s.execute('add SampleUtilExt on test', 'module-add-to-application', '--module', 'SampleUtilExt', '--module-kind', 'Extension', '--application', 'Sample Orders');
  assert.equal(added.state, 'confirmed');
  assert.deepEqual(s.apiCalls('AddModuleToApplication')[0][3], { appKey: 'app-1', moduleKind: 'Extension', moduleKey: 'x-util' });
});

test('the commit message targets the version id and is read back', async () => {
  const s = apiWrites();
  const receipt = await s.execute('reword on test', 'commit-message-set', '--module', 'SampleOrders', '--version', '12', '--commit-message', 'Hotfix 12');
  assert.deepEqual([receipt.state, receipt.plan.versionId, receipt.plan.currentCommitMessage], ['confirmed', 5012, 'Synthetic commit']);
  assert.deepEqual(s.apiCalls('ChangeCommitMessage')[0][3], { eSpaceVersionId: 5012, newCommitMessage: 'Hotfix 12' });
  assert.deepEqual(s.apiCalls('ListVersions')[0][3], { eSpaceKey: 'k-orders' });
  await assert.rejects(s.run('commit-message-set', '--module', 'SampleOrders', '--version', '9', '--commit-message', 'x'), isProtocol(/version 9/));
});

test('extension version precondition refuses a new package when the name appeared after planning', async () => {
  const s = apiWrites();
  const xif = path.join(s.dir, 'SampleNewExt.xif');
  fs.writeFileSync(xif, Buffer.from('synthetic extension'));
  const args = ['extension-publish', '--xif-file', xif, '--extension', 'SampleNewExt', '--expected-version-id', 'none'];
  assert.equal((await s.run(...args)).observedVersionId, null);
  s.extensions.push({key:'concurrent-extension',name:'SampleNewExt',versionId:3400});
  await assert.rejects(s.execute('publish test extension', ...args), e => e.code === 'EXTENSION_VERSION_CHANGED');
  assert.equal(s.apiCalls('UploadAndPublishExtension').length, 0);
  assert.equal(fs.existsSync(path.join(s.dir, 'receipts')), false);
});

test('extension publish sends the prepared xif once', async () => {
  const s = apiWrites();
  const xif = path.join(s.dir, 'SampleNewExt.xif');
  fs.writeFileSync(xif, Buffer.from('PK\x03\x04extension', 'latin1'));
  const plan = await s.run('extension-publish', '--xif-file', xif, '--commit-message', 'v4', '--application', 'Sample Shared');
  assert.deepEqual([plan.xifSha256, plan.applicationKey], [sha256(Buffer.from('PK\x03\x04extension', 'latin1')), 'app-2']);
  const argv = ['extension-publish', '--xif-file', xif, '--commit-message', 'v4', '--application', 'Sample Shared', '--execute', '--operation-id', uuid(), '--words', 'publish SampleNewExt on test', '--confirm-host', HOST];
  const receipt = await s.run(...argv);
  assert.deepEqual([receipt.state, receipt.extensionVersionId], ['confirmed', 3300]);
  assert.deepEqual(s.apiCalls('UploadAndPublishExtension')[0][3], { file: xif, commitMessage: 'v4', applicationKey: 'app-2' });
  assert.equal((await s.run(...argv)).existingReceipt, true);
  assert.equal(s.apiCalls('UploadAndPublishExtension').length, 1);
  s.bridge.replies.UploadAndPublishExtension = { messages: [{ Message: 'Compilation failed', Type: 'Error' }], extensionId: 0, extensionVersionId: 0 };
  const rejected = await s.execute('publish again on test', ...argv.slice(0, 7));
  assert.deepEqual([rejected.state, rejected.errors], ['rejected', ['Compilation failed']]);
  await assert.rejects(s.run('extension-publish', '--xif-file', path.join(s.dir, 'x.zip')), isProtocol(/xif/));
});

test('extension context is revalidated by the write engine before reservation and upload', async () => {
  const s=apiWrites(),xif=path.join(s.dir,'SampleNewExt.xif'),proposal=path.join(s.dir,'proposal.md'),context=path.join(s.dir,'approval.json');
  const words='Authorize standalone test fixtures on test';
  fs.writeFileSync(xif,'synthetic extension');fs.writeFileSync(proposal,'Create SampleNewExt once, standalone; delete afterward.');
  const record={schema:'ssam-authorization-context/1',decision:'approved',words,
    source:{kind:'human-conversation',threadId:'11111111-2222-3333-4444-555555555555',messageId:'22222222-2222-3333-4444-555555555555',question:'Express fixture test authorization'},
    proposal:{file:proposal,sha256:sha256(fs.readFileSync(proposal))},constraints:{createOnly:true},
    scope:[{lane:'o11',host:HOST,operation:'extension-publish',targets:['SampleNewExt']}]};
  const save=()=>fs.writeFileSync(context,JSON.stringify(record));save();
  const args=['extension-publish','--xif-file',xif,'--extension','SampleNewExt','--expected-version-id','none','--authorization-context',context];
  record.scope[0].targets=['Other'];save();
  await assert.rejects(s.execute(words,...args),e=>e.code==='AUTHORIZATION_CONTEXT_INVALID');
  assert.equal(s.apiCalls('UploadAndPublishExtension').length,0);
  record.scope[0].targets=['SampleNewExt'];save();
  const result=await s.execute(words,...args);assert.equal(result.state,'confirmed');
  assert.deepEqual(result.plan.authorizationContext.targets,['SampleNewExt']);
  assert.equal(s.apiCalls('UploadAndPublishExtension').length,1);
});

// ---- the resolver
function resolver(bridge = null, { vault = false, running = false, ...options } = {}) {
  const prompts = [];
  const r = new Resolver(HOST, { locate: () => bridge, present: async () => vault, running: async () => running,
    opener: (host, kind) => { prompts.push([host, kind]); return { opened: true, target: kind }; }, ...options });
  return [r, prompts];
}

test('native API and headless pages reuse the selected authenticated Studio', async () => {
  const bridge = new FakeBridge(); const [r, prompts] = resolver(bridge);
  assert.equal((await r.resolve('api')).path, 'studio');
  assert.equal((await r.resolve('web')).path, 'studio-http');
  assert.deepEqual(bridge.calls.filter(c => c[0] !== 'session'), []);
  assert.deepEqual(prompts, []);
});

test('a legacy window capability cannot open UI; stored HTTP credentials remain usable; nothing stored opens the private prompt', async () => {
  const bridge = new FakeBridge({ capabilities: ['sc_web:login'] });
  assert.equal((await resolver(bridge, { vault: true })[0].resolve('web')).path, 'vault');
  const [pending, prompts] = resolver(bridge, { wait: { waitMs: 0 } });
  await assert.rejects(pending.resolve('web'), e => e.code === 'CREDENTIAL_PROMPT_PENDING');
  assert.deepEqual(prompts, [[HOST, 'ServiceCenter']]);
  await assert.rejects(resolver(bridge, { session: 'studio' })[0].resolve('web'), e => e.code === 'HEADLESS_AUTH_UNAVAILABLE');
  assert.deepEqual(bridge.calls.filter(c => c[0] !== 'session'), []);
});

test('missing credentials: pages open the private prompt (pending), the Studio API never does', async () => {
  for (const [bridge, options, need, code, prompted] of [[null, {}, 'web', 'CREDENTIAL_PROMPT_PENDING', true], [null, { running: true }, 'web', 'CREDENTIAL_PROMPT_PENDING', true],
    [new FakeBridge({ verbs: ['ping'] }), {}, 'web', 'CREDENTIAL_PROMPT_PENDING', true], [null, { prompt: 'never' }, 'web', 'AUTH_REQUIRED', false],
    [null, {}, 'api', 'STUDIO_REQUIRED', false], [new FakeBridge({ signed: false }), {}, 'api', 'STUDIO_NOT_SIGNED_IN', false]]) {
    const [r, prompts] = resolver(bridge, { wait: { waitMs: 0 }, ...options });
    await assert.rejects(r.resolve(need), e => e instanceof AuthRequired && e.code === code);
    assert.deepEqual(prompts, prompted ? [[HOST, 'ServiceCenter']] : []);
  }
});

test('LifeTime uses its own token entry and never opens a prompt', async () => {
  const targets = [];
  const r = new Resolver(HOST, { locate: () => assert.fail('LifeTime is independent'),
    present: async target => { targets.push(target); return true; }, opener: () => assert.fail('headless') });
  assert.equal((await r.resolve('lifetime')).path, 'vault');
  assert.deepEqual(targets, ['SSAM/O11/' + HOST + '/LifeTime']);
});

test('explicit vault selection reads only Studio identity metadata', async () => {
  const bridge = new FakeBridge();
  assert.equal((await resolver(bridge, { vault: true, session: 'vault' })[0].resolve('web')).path, 'vault');
  assert.deepEqual(bridge.calls, [['session', HOST]]);
});

test('the private prompt runs windows-o11-credential.ps1 -Mode bootstrap detached, one window per target, its marker under .ssam-hybrid', () => {
  const state = temp(); const spawned = [];
  const spawnFn = (exe, argv, options) => { spawned.push([exe, argv, options]); return { pid: 4242, unref() {}, on() {} }; };
  const first = openPrompt(HOST, 'DatabaseConnection', 'LegacyERP', { state, spawnFn, now: () => Date.now() });
  assert.deepEqual(first, { opened: true, target: `SSAM/O11/${HOST}/DatabaseConnection/LegacyERP` });
  const [exe, argv, options] = spawned[0];
  assert.ok(/powershell\.exe$/i.test(exe));
  assert.deepEqual(argv.slice(3), ['-Mode', 'bootstrap', '-Kind', 'DatabaseConnection', '-HostName', HOST, '-Name', 'LegacyERP']);
  assert.ok(argv[2].endsWith('windows-o11-credential.ps1'));
  assert.deepEqual([options.detached, options.stdio, options.windowsHide], [true, 'ignore', false]);
  assert.equal(files(path.join(state, 'auth', 'prompts'), /\.json$/).length, 1, 'the marker lives under <state>\\auth\\prompts');
  // The same target within five minutes: the window that is open is the one; nothing new is spawned.
  assert.deepEqual(openPrompt(HOST, 'DatabaseConnection', 'LegacyERP', { state, spawnFn }), { opened: false, alreadyOpen: true, target: `SSAM/O11/${HOST}/DatabaseConnection/LegacyERP` });
  assert.equal(spawned.length, 1);
  assert.throws(() => openPrompt(HOST, 'DatabaseConnection', '../x', { state, spawnFn }), isProtocol());
});

test('the prompt script and the vault PowerShell never write the secret', () => {
  const script = fs.readFileSync(promptScript(), 'utf8');
  assert.ok(script.includes("ValidateSet('status','bootstrap')")); // no mode prints a stored value
  const outputs = script.split(/\r?\n/).filter(l => /ConvertTo-Json|Write-|Console\]::/.test(l));
  assert.ok(outputs.length);
  for (const line of outputs) assert.doesNotMatch(line, /\$plain|Password|GetNetworkCredential|CredentialBlob/);
  assert.ok(script.includes('ZeroFreeCoTaskMemUnicode'));
  // vault.mjs: its JSON answers carry status, cookies and the scrubbed body, never $secret or $user.
  for (const line of (CREDENTIAL.setup + CREDENTIAL.read).split('\n').filter(l => /ConvertTo-Json|Write-/.test(l))) assert.doesNotMatch(line, /\$secret|\$user/);
});

// ---- session tool and guards
function sessions() {
  const dir = temp(); const prompts = [];
  const clock = fakeClock(); const root = temp();
  const run = (argv, { bridge = null, vault = false, running = false } = {}) => main(argv, { journal: new Journal(dir), locate: () => bridge, present: async () => vault,
    running: async () => running, opener: (host, kind) => { prompts.push([host, kind]); return { opened: true }; }, exports: dir, registry: REGISTRY, clock, destructiveRoot: root });
  return { dir, prompts, run, clock };
}

test('status reports the path each kind of call would use', async () => {
  const s = sessions();
  const status = await s.run(['session-status', '--host', HOST], { bridge: new FakeBridge({ web: false }) });
  assert.deepEqual(status.wouldUse, { api: 'studio', web: 'studio-http' });
  assert.deepEqual([status.hostClass, status.studio.serviceCenterVerbs, status.vault], ['corporate', true, { ServiceCenter: false, LifeTime: false }]);
  assert.deepEqual(s.prompts, []);
});

test('sign-in never launches a Studio dialog; without a Studio and nothing stored it opens the private prompt', async () => {
  const s = sessions(); const bridge = new FakeBridge({ signed: false });
  await assert.rejects(s.run(['session-sign-in', '--host', HOST], { bridge }), e => e.code === 'STUDIO_NOT_SIGNED_IN');
  assert.deepEqual(s.prompts, []);
  for (const argv of [[], ['--surface', 'lifetime']])
    await assert.rejects(s.run(['session-sign-in', '--host', HOST, ...argv]), e => e.code === 'CREDENTIAL_PROMPT_PENDING');
  assert.deepEqual(bridge.calls, [['session', HOST]]); assert.deepEqual(s.prompts, [[HOST, 'ServiceCenter'], [HOST, 'LifeTime']]);
});

test('web sign-in uses only the headless login command', async () => {
  const s = sessions(); const bridge = new FakeBridge({ web: false });
  const done = await s.run(['session-web-sign-in', '--host', HOST], { bridge });
  assert.equal(done.windowCreated, false); assert.equal(done.auth.path, 'studio-http');
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'web').map(c => c[1]), ['login']);
  assert.deepEqual(s.prompts, []);
});

test('corporate hosts need confirmation and words naming them before any call', async () => {
  const s = sessions();
  const bridge = new FakeBridge();
  for (const extra of [[], ['--confirm-host', HOST], ['--confirm-host', 'other.example.com']])
    await assert.rejects(s.run(['timer-run', '--host', HOST, '--module-id', '3', '--name', 'W', '--execute', '--operation-id', uuid(), '--words', 'run W', ...extra], { bridge }), isProtocol(/corporate/));
  assert.deepEqual(bridge.calls, []);
  assert.equal(guardWrite(HOST, 'run W on test', HOST, [], REGISTRY), 'corporate');
  assert.equal(guardWrite(PERSONAL, 'run W', null, [], REGISTRY), 'personal');
  assert.throws(() => guardWrite('readonly.example.test', 'x', 'readonly.example.test', [], REGISTRY), isProtocol(/read-only/));
  // The real registry (kernel data file, read only): an environment nobody registered counts as corporate.
  assert.equal(hostsFile(), path.join(anvilRoot, 'scripts', 'service_center', 'hosts.json'));
  assert.equal(hostClass('nobody-registered.example.test'), 'corporate');
});

test('a connection delete needs words naming it and reads back its absence', async () => {
  const s = sessions();
  const deleted = [];
  const bridge = new FakeBridge({ pages: {
    [`GET ${SC}DatabaseConnections_List.aspx`]: () => (deleted.length ? '<table><tr><th>Name</th></tr></table><p>No connections found</p>' : fixture('db-connections.html')),
    [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: fixture('db-connection-edit.html'),
    [`POST ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: f => { deleted.push(f.__EVENTTARGET); return fixture('db-connections.html'); } } });
  // CX15: the plan is the preview; the execution is its token with the owner's words (with the count) after it.
  const plan = await s.run(['db-connection-delete', '--host', HOST, '--connection', 'LegacyERP'], { bridge });
  assert.deepEqual([plan.destructive, plan.connectionId], [true, '3']);
  const base = ['db-connection-delete', '--host', HOST, '--connection', 'LegacyERP', '--confirm-host', HOST, '--confirmation-token', plan.confirmationToken];
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  await assert.rejects(s.run([...base, '--words', 'delete it, the 1, on test'], { bridge }), isProtocol(/name its target/));
  assert.deepEqual(bridge.posts(), []);
  const receipt = await s.run([...base, '--words', 'delete the 1, LegacyERP on test'], { bridge });
  assert.deepEqual([receipt.state, deleted, receipt.auth.path], ['confirmed', ['wt5$wtDeleteLink'], 'studio-http']);
});

test('a new connection without a stored login opens its private prompt before any reservation', async () => {
  const s = sessions();
  const argv = ['db-connection-create', '--host', HOST, '--connection', 'NewDb', '--db-server', 'sql', '--execute', '--operation-id', uuid(), '--words', 'create NewDb on test', '--confirm-host', HOST];
  // A bridge without sc_web:secretRefs cannot carry the login: refused, and no prompt is opened for nothing.
  await assert.rejects(s.run(argv, { bridge: new FakeBridge() }), coded('STUDIO_BRIDGE_OUTDATED'));
  assert.deepEqual(s.prompts, []);
  const bridge = new FakeBridge({ capabilities: ['sc_http:studioSession', 'sc_web', 'sc_web:secretRefs'] });
  await assert.rejects(s.run(argv, { bridge }), e => e instanceof AuthRequired && e.code === 'CREDENTIAL_PROMPT_PENDING');
  assert.deepEqual(s.prompts, [[HOST, 'DatabaseConnection']]);
  assert.deepEqual([bridge.calls.filter(c => c[0] === 'web'), files(s.dir, /\.json$/)], [[], []]);
});

test('secret writes are refused without a Studio', async () => {
  const s = sessions();
  // The vault path (direct HTTPS from this process) never holds a database login or a secret property value.
  await assert.rejects(s.run(['db-connection-test', '--host', HOST, '--connection', 'LegacyERP', '--execute', '--operation-id', uuid(), '--words', 'test LegacyERP on test', '--confirm-host', HOST], { vault: true }),
    coded('STUDIO_REQUIRED'));
  assert.deepEqual([s.prompts, files(s.dir, /\.json$/)], [[], []]);
  await assert.rejects(s.run(['property-set', '--host', HOST, '--module-id', '3', '--name', 'Token', '--value-vault', 'SSAM/O11/other.example.com/SiteProperty/Token'],
    { bridge: new FakeBridge({ capabilities: ['sc_http:studioSession', 'sc_web', 'sc_web:secretRefs'] }) }), isProtocol(/SiteProperty/));
});

test('the solution download keeps the package locally', async () => {
  const s = sessions();
  const bridge = new FakeBridge();
  solutionPages(bridge, new Set(['Orders']));
  const osp = zip({'Solution.xml':'<Solution/>'});
  bridge.pages[`POST ${SC}Solution_Edit.aspx?SolutionId=5`] = (f, a) => (a === 'binary' && f['wt3$wtDownloadButton'] === 'Download' ? osp : '<p/>');
  const result = await s.run(['solution-download', '--host', HOST, '--solution', 'Billing'], { bridge });
  assert.match(result.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'the tool mints the UUID of a new download');
  assert.deepEqual([result.sha256, result.size], [sha256(osp), osp.length]);
  assert.ok(path.basename(result.file).startsWith('Billing-'));
  assert.equal(bridge.posts()[0][6], false, 'a download is a read');
});

test('reads refuse write arguments and reveal is property-value only', async () => {
  const s = sessions();
  await assert.rejects(s.run(['logs', '--host', HOST, '--words', 'x']), isProtocol());
  await assert.rejects(s.run(['logs', '--host', HOST, '--reveal']), isProtocol());
});

// ---- StudioBridge over a loopback JSON-lines server shaped like Anvil.Bridge
async function loopback() {
  const dir = temp();
  const key = path.join(dir, 'bridge.key');
  fs.writeFileSync(key, 'k3y', 'ascii');
  const server = await loopbackBridge((request, socket) => {
    const { method } = request; const params = request.params ?? {};
    if (method === 'ping') return { success: true, data: { bridge: 'anvil', pid: 99, version: '2.0' } };
    if (method === 'bridge_manifest') return { success: true, data: { verbs: VERBS, capabilities: ['sc_http:studioSession'] } };
    if (request.authorization !== 'k3y') return { success: false, data: null, error: 'UnauthorizedAccessException: trusted controller', executed: false };
    if (method === 'sc_api' && params.operation === 'DeleteModule') { socket.end(); return undefined; } // the connection drops after the write arrived
    if (method === 'sc_api') return { success: true, data: { ok: true, source: 'studio', host: params.host, user: 'dev', elapsedMs: 2,
      result: [{ Name: 'A', Token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl' }] } };
    if (method === 'sc_session') return { success: true, data: { ok: false, code: 'STUDIO_NOT_SIGNED_IN', message: 'no login; password=hunter2' } };
    if (method === 'sc_http' && params.secretRefs) {
      // ScSecrets.cs NotFound: the target and part, never a value; nothing left the Studio.
      const ref = params.secretRefs[0];
      return { success: false, data: { ok: false, code: 'SECRET_NOT_FOUND', executed: false, target: ref.target, part: ref.field, gate: 'secret_not_found',
        message: `secretRef target ${ref.target}: the Windows vault of this user has no such entry` }, error: 'SECRET_NOT_FOUND: no such entry', code: 'SECRET_NOT_FOUND', executed: false };
    }
    if (method === 'sc_http' && params.action === 'fetch')
      // The sc-bridge envelope: the contract answer in data also on failure, executed:false when nothing left.
      return { success: false, data: { ok: false, code: 'WEB_SIGN_IN_REQUIRED', message: 'window not signed in' }, error: 'WEB_SIGN_IN_REQUIRED: window not signed in', code: 'WEB_SIGN_IN_REQUIRED', executed: false };
    return { success: false, data: null, error: 'Unknown method: ' + method };
  });
  return { dir, key, server, port: server.port, seen: server.seen };
}

test('contract replies, errors and redaction', async () => {
  const l = await loopback();
  try {
    const bridge = new StudioBridge(l.port, l.key, { timeoutMs: 5000 });
    assert.equal((await bridge.ping()).pid, 99);
    assert.ok(!Object.hasOwn(l.seen.at(-1), 'authorization'));
    const reply = await bridge.api(HOST, 'soap', 'ListApplications', { withIcons: false });
    assert.equal(l.seen.at(-1).authorization, 'k3y');
    assert.deepEqual(l.seen.at(-1).params, { host: HOST, surface: 'soap', operation: 'ListApplications', args: { withIcons: false } });
    assert.equal(redact(reply.result)[0].Token, '<redacted>');
    await assert.rejects(bridge.session(HOST), e => coded('STUDIO_NOT_SIGNED_IN')(e) && !e.message.includes('hunter2'));
    await assert.rejects(bridge.web(HOST, 'status'), coded('STUDIO_BRIDGE_OUTDATED'));
    await assert.rejects(bridge.web(HOST, 'fetch', { method: 'POST', path: SC + 'X.aspx', form: { a: '1' }, write: true, operationId: uuid(), authorizeSha256: 'd'.repeat(64) }),
      e => coded('WEB_SIGN_IN_REQUIRED')(e) && e.extra.executed === false && e.extra.write === true);
    const operation = uuid();
    await assert.rejects(bridge.api(HOST, 'soap', 'DeleteModule', { moduleKey: 'k' }, { write: true, operationId: operation, authorizeSha256: 'b'.repeat(64) }),
      e => coded('UNCERTAIN')(e) && e.extra.write === true);
    const params = l.seen.at(-1).params;
    assert.deepEqual({ write: params.write, operationId: params.operationId, authorizeSha256: params.authorizeSha256 }, { write: true, operationId: operation, authorizeSha256: 'b'.repeat(64) });
    await assert.rejects(bridge.api(HOST, 'soap', 'DeleteModule', {}, { write: true, operationId: 'not-a-uuid', authorizeSha256: 'b'.repeat(64) }), coded('BAD_REQUEST'));
  } finally { await l.server.close(); }
});

test('a missing vault entry is SECRET_NOT_FOUND and refuses the receipt', async () => {
  const l = await loopback();
  try {
    const target = `SSAM/O11/${HOST}/DatabaseConnection/Sales`;
    const bridge = new StudioBridge(l.port, l.key, { timeoutMs: 5000 });
    const refs = [{ pointer: '/u', target, field: 'username' }, { pointer: '/p', target, field: 'password' }];
    let caught;
    await assert.rejects(bridge.web(HOST, 'fetch', { method: 'POST', path: SC + 'DatabaseConnection_Edit.aspx', form: { u: '', p: '' }, write: true, operationId: uuid(),
      authorizeSha256: 'd'.repeat(64), secretRefs: refs }), e => { caught = e; return true; });
    assert.deepEqual(l.seen.at(-1).params.secretRefs, refs);
    assert.deepEqual([caught.code, caught.extra.executed, caught.extra.target, caught.extra.part], ['SECRET_NOT_FOUND', false, target, 'username']);
    const failure = bridgeFailure(caught, {}, { action: 'db-connection-create', host: HOST });
    assert.deepEqual([failure.state, failure.target], ['refused', target]);
    assert.ok(failure.continuation.why.includes('new operationId'));
    // 012e263e: an absent database login or secret property value gets the private Windows prompt before the reservation.
    assert.match(failure.continuation.why, /private Windows prompt in its own window/);
    assert.doesNotMatch(failure.continuation.why, /never opens a prompt/);
    assert.equal(failure.continuation.tool, 'o11_service_center_write');
  } finally { await l.server.close(); }
});

test('a wrong authority is not executed', async () => {
  const l = await loopback();
  try {
    fs.writeFileSync(l.key, 'other', 'ascii');
    await assert.rejects(new StudioBridge(l.port, l.key, { timeoutMs: 5000 }).api(HOST, 'soap', 'ListApplications'), coded('NOT_ALLOWED'));
  } finally { await l.server.close(); }
});

test('locate follows the connection record and refuses another Studio', async () => {
  const l = await loopback();
  try {
    const record = path.join(l.dir, '.local', 'connections', 'ss4.json');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    const write = (pid, port) => fs.writeFileSync(record, JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid, port, authorityDir: l.dir }));
    const env = { USERPROFILE: l.dir, LOCALAPPDATA: l.dir, ANVIL_AUTHORITY_DIR: l.dir };
    write(99, l.port);
    const bridge = await locateStudioBridge({ root: l.dir, lane: 'ss4', env, timeoutMs: 5000 });
    assert.deepEqual([bridge.pid, bridge.keyFile], [99, l.key]);
    write(98, l.port);
    await assert.rejects(locateStudioBridge({ root: l.dir, lane: 'ss4', env, timeoutMs: 5000 }), e => coded('STUDIO_NOT_CONNECTED')(e) && e.extra.continuation.tool === 'ssam_connect');
    const closed = await loopbackBridge(() => undefined); const port = closed.port; await closed.close();
    write(99, port);
    assert.equal(await locateStudioBridge({ root: l.dir, lane: 'ss4', env, timeoutMs: 5000 }), null);
  } finally { await l.server.close(); }
});

// ---- the facade calls only what Anvil.Bridge implements (kernel/src/Anvil.Bridge, read from its source)
const BRIDGE_SOURCE = path.join(anvilRoot, 'src', 'Anvil.Bridge');
// studio-api.mjs and the delete engine (delete.mjs) call the bridge with this.call/this.send.
const FACADE = ['studio-api.mjs', 'delete.mjs'].map(f => path.join(import.meta.dirname, '..', 'service-center', f));
function bridgeTables() {
  const text = fs.readFileSync(path.join(BRIDGE_SOURCE, 'ScOperations.cs'), 'utf8');
  const parts = text.split(/IReadOnlyDictionary<string, ScOp<Sc(\w+)Send>> (\w+) =/);
  const names = {};
  for (let i = 1; i + 2 < parts.length; i += 3) names[parts[i + 1]] = new Set([...parts[i + 2].matchAll(/^\s*\["([\w-]+)"\] =/gm)].map(m => m[1]));
  return { soap: names.SoapOperations, 'server-api': names.ServerApiOperations, 'sc-rest': names.RestOperations, 'integration-studio': names.IntegrationStudioOperations };
}
// op -> the argument names its Prepare reads (a.Key("..."), a.Text("..."), a.Bool("...")...).
function bridgeArgs() {
  const text = fs.readFileSync(path.join(BRIDGE_SOURCE, 'ScOperations.cs'), 'utf8');
  const found = {};
  for (const m of text.matchAll(/^\s*\["([\w-]+)"\] = (.*?)(?=^\s*\["[\w-]+"\] =|^\s*\};)/gms))
    found[m[1]] = new Set([...m[2].matchAll(/\ba\.(?:Key|Text|Int|Bool|Raw|Bytes|OneOf|OptionalObjectKey|Date|Path)\("(\w+)"/g)].map(x => x[1]));
  return found;
}
// [surface, operation, argument names] of every literal call the facade makes through the bridge.
const facadeCalls = () => FACADE.flatMap(file => [...fs.readFileSync(file, 'utf8').matchAll(/this\.(?:send|call)\('([\w-]+)', '([\w-]+)', \{(.*?)\}/gs)]
  .map(m => [m[1], m[2], new Set([...('{' + m[3]).matchAll(/[{,]\s*(\w+)\s*(?=[:,}]|$)/g)].map(x => x[1]))]));

test('every operation the facade sends is in the bridge allowlist', () => {
  const tables = bridgeTables();
  const sent = new Set(Object.values(READS).map(([surface, operation]) => surface + ':' + operation));
  for (const [surface, operation] of facadeCalls()) sent.add(surface + ':' + operation);
  // This wave's writes, named explicitly so that removing one from the bridge fails here.
  for (const pair of ['soap:DeleteApplication', 'soap:MoveModuleBetweenApps', 'soap:AddModuleToApplication', 'soap:ChangeCommitMessage', 'soap:UploadAndPublishExtension',
    'soap:ListVersions', 'soap:DeleteModule', 'soap:PublishSolution', 'sc-rest:apply-settings', 'server-api:AssociateAppWithDatabase']) sent.add(pair);
  assert.ok(facadeCalls().length >= 10);
  // The delete engine's operations (and the bridge gate's list) are all in the allowlist.
  for (const operation of DELETE_OPERATIONS) {
    assert.ok(facadeCalls().some(([surface, op]) => surface === 'soap' && op === operation), operation);
    sent.add('soap:' + operation);
  }
  assert.deepEqual([...sent].filter(p => { const [s, o] = [p.slice(0, p.indexOf(':')), p.slice(p.indexOf(':') + 1)]; return !tables[s].has(o); }).sort(), []);
});

test('the arguments the facade sends are the ones the bridge reads', () => {
  const reads = bridgeArgs();
  for (const [, operation, names] of facadeCalls()) for (const name of names) assert.ok(reads[operation].has(name) || name === 'outFile', `${operation}.${name}`);
  const args = { extension_key:'k', logical_database:'Cargo', application_key: 'k', module_key: 'k', element_key: '', since: '2026-10-01T00:00:00Z', solution: 's', publish_id: '1', last_message_id: '0', apply_id: '1' };
  for (const [action, [, operation, build]] of Object.entries(READS)) for (const name of Object.keys(build(args))) assert.ok(reads[operation].has(name) || name === 'outFile', `${action}.${name}`);
  // UploadAndPublishExtension's arguments are built in a variable: the bridge reads file, commitMessage, applicationKey.
  assert.deepEqual(reads.UploadAndPublishExtension, new Set(['file', 'commitMessage', 'applicationKey']));
  assert.deepEqual(reads.DeleteApplication, new Set(['appKey', 'simulate']));
});

test('verbs and web accepts match', () => {
  const dispatch = fs.readFileSync(path.join(BRIDGE_SOURCE, 'Dispatch.cs'), 'utf8');
  for (const verb of VERBS) assert.ok(dispatch.includes(`"${verb}" =>`), verb);
  assert.ok(fs.readFileSync(path.join(BRIDGE_SOURCE, 'ScProtocol.cs'), 'utf8').includes('accept is not ("html" or "xlsx" or "binary")'));
});

test('secretRefs agree once the bridge has them', t => {
  const sources = fs.readdirSync(BRIDGE_SOURCE).filter(f => f.endsWith('.cs')).map(f => fs.readFileSync(path.join(BRIDGE_SOURCE, f), 'utf8')).join('');
  if (!sources.includes('secretRefs')) { t.skip('this branch\'s Anvil.Bridge does not fill sc_web secretRefs yet'); return; }
  assert.ok(sources.includes(`"${SECRET_CAPABILITY}"`));
  for (const name of ['pointer', 'target', 'field']) assert.ok(sources.includes(`"${name}"`), name);
  // The facade's pointer is RFC 6901 into the flat form (jsonPointer); the bridge decodes it to the field name.
  const secrets = fs.readFileSync(path.join(BRIDGE_SOURCE, 'ScSecrets.cs'), 'utf8');
  assert.equal(jsonPointer('wt9$a/b~c'), '/wt9$a~1b~0c');
  assert.ok(secrets.includes('.Replace("~1", "/").Replace("~0", "~")'));
  // The facade's targets are entries the bridge accepts, never the environment logins it refuses.
  const logins = new Set([.../"(\w+)"/g[Symbol.matchAll](/Logins = \[(.*?)\];/s.exec(secrets)[1])].map(m => m[1]));
  assert.deepEqual(logins, new Set(['ServiceCenter', 'ServiceStudio', 'LifeTime']));
  assert.ok(!logins.has('DatabaseConnection') && !logins.has('SiteProperty'));
  // A database login is two refs (username, password): within the bridge's limit.
  assert.ok(Number(/public const int Limit = (\d+);/.exec(secrets)[1]) >= 2);
  // The bridge's own refusal code keeps its name and counts as nothing sent.
  assert.ok(fs.readFileSync(path.join(BRIDGE_SOURCE, 'ScProtocol.cs'), 'utf8').includes('SecretNotFound = "SECRET_NOT_FOUND"'));
  assert.ok(CODES.includes('SECRET_NOT_FOUND'));
  assert.ok(NOT_SENT.has('SECRET_NOT_FOUND'));
});
