"""Modern Service Center pages (kernel/tests/fixtures/service-center/modern, copied from the integrator's realistic
synthetic fixtures _notes/scp/fixtures/o11/web): div[data-tab] tabs, __doPostBack anchors with the event fields added
by the facade, lists read only from the content (never Recent Items), OsAjax Next and Filter, the XLSX exports and the
Web Forms hidden fields. Every postback is compared with the fixture's own request. Offline: a fake bridge, no Studio,
Service Center or credential store."""
import hashlib
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from test_service_center_studio import FakeBridge, FakeVault  # noqa: E402
from service_center.client import Client, Journal, LayoutError  # noqa: E402
from service_center.http import BridgeError, ProtocolError, StudioWebTransport  # noqa: E402
from o11_service_center import main  # noqa: E402

HOST = 'sc.example.test'
SC = '/ServiceCenter/'
MODERN = Path(__file__).resolve().parent / 'fixtures' / 'service-center' / 'modern'
SECRETS = ('sc_api:soap', 'sc_web', 'sc_web:secretRefs')
TIMER = SC + 'eSpace_Timer_Edit.aspx?EspaceKey=7c3d9e10-0000-4000-8000-00000000e102&Cyclic_Job_Key=9a8b7c6d-0000-4000-8000-00000000c001'
PROPERTY = SC + 'eSpace_SiteProperty_Edit.aspx?SitePropertyId={}&EspaceId=102'


def html(name, *replacements):
    text = (MODERN / name).read_text(encoding='utf-8')
    for old, new in replacements:
        assert old in text, old
        text = text.replace(old, new)
    return text


def request(name):
    return json.loads((MODERN / name).read_text(encoding='utf-8'))['request']


def reply(name, content_type='text/javascript'):
    """An OsAjax reply as the bridge returns any non-HTML text for accept=html."""
    return lambda form, accept: {'ok': True, 'status': 200, 'finalUrl': f'https://{HOST}{SC}X.aspx', 'contentType': content_type,
                                 'html': (MODERN / name).read_text(encoding='utf-8')}


def client(bridge, exports=None):
    vault = FakeVault()
    vault.host = HOST
    return Client(vault, StudioWebTransport(HOST, bridge), exports)


class ModernTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.journal = Journal(Path(self.temp.name) / 'receipts')

    def tearDown(self):
        self.temp.cleanup()

    def execute(self, c, action, args, words='go'):
        return c.web_write(action, args, execute=True, words=words, operation_id=str(uuid.uuid4()), journal=self.journal)

    def sent(self, bridge, index=-1):
        """(path, form, accept, write) of a POST the facade sent."""
        call = bridge.posts()[index]
        return call[3], call[4], call[5], call[6]

    def assertForm(self, fixture, bridge, index=-1, **changes):
        """The POST equals the fixture's own request (path and form), with the named fields changed (None = absent)."""
        expected = request(fixture)
        form = dict(expected['form'])
        for key, value in changes.items():
            name = next(k for k in form if k.endswith(key)) if key not in form else key
            if value is None:
                form.pop(name)
            else:
                form[name] = value
        path, sent, _, _ = self.sent(bridge, index)
        self.assertEqual(expected['path'], path)
        self.assertEqual(form, sent)


class LogTests(ModernTest):
    def test_error_log_rows_come_from_the_content_and_next_is_the_pages_own_postback(self):
        bridge = FakeBridge(pages={('GET', SC + 'Error_Logs.aspx'): html('logs/error-logs.page1.html'),
                                   ('POST', SC + 'Error_Logs.aspx'): html('logs/error-logs.page2-last.html')})
        result = client(bridge).logs('error', 50)
        self.assertEqual(5, len(result['rows']))
        self.assertFalse(result['truncated'])
        self.assertEqual('Invalid object name \'OSUSR_SYN_ORDER1\'.', result['rows'][0]['fields']['Message'])
        self.assertEqual(f'https://{HOST}{SC}Show_Error.aspx?Error_Id=c0ffee00-0000-4000-8000-0000000e0001', result['rows'][0]['links'][0]['href'])
        evidence = json.dumps(result)
        for decoy in ('RecentDecoy', 'Licensed to', 'Apply Settings'):
            self.assertNotIn(decoy, evidence)
        # The Next link is OsAjax: replayed as the GitSSAM postback (its name with an empty value), a read.
        self.assertForm('logs/error-logs.next.gitssam-variant.request.json', bridge)
        self.assertFalse(self.sent(bridge)[3])

    def test_an_osajax_reply_to_next_is_read_through_its_state_and_markup(self):
        bridge = FakeBridge(pages={('GET', SC + 'Error_Logs.aspx'): html('logs/error-logs.page1.html'),
                                   ('POST', SC + 'Error_Logs.aspx'): reply('logs/error-logs.next.osajax-reply.txt')})
        result = client(bridge).logs('error', 50)
        self.assertEqual(['Synthetic second-page error A', 'Synthetic second-page error B'], [r['fields']['Message'] for r in result['rows'][3:]])
        self.assertEqual((False, None), (result['truncated'], result.get('paginationUnsupported')))

    def test_an_unknown_osajax_reply_stops_paging_without_inventing_rows(self):
        bridge = FakeBridge(pages={('GET', SC + 'Error_Logs.aspx'): html('logs/error-logs.page1.html'),
                                   ('POST', SC + 'Error_Logs.aspx'): lambda f, a: {'ok': True, 'status': 200, 'contentType': 'text/plain',
                                                                                    'finalUrl': f'https://{HOST}{SC}Error_Logs.aspx', 'html': 'OK'}})
        result = client(bridge).logs('error', 50)
        self.assertEqual((3, True, True), (len(result['rows']), result['truncated'], result['paginationUnsupported']))
        self.assertIn('page-layout', result['paginationError'])

    def test_empty_log_is_empty_not_unknown(self):
        bridge = FakeBridge(pages={('GET', SC + 'Error_Logs.aspx'): html('logs/error-logs.empty.html')})
        result = client(bridge).logs('error', 50)
        self.assertEqual(([], False), (result['rows'], result['truncated']))

    def test_filter_postback_and_stack_search_match_the_fixture(self):
        bridge = FakeBridge(pages={('GET', SC + 'Error_Logs.aspx'): html('logs/error-logs.page1.html'),
                                   ('POST', SC + 'Error_Logs.aspx'): [html('logs/error-logs.page1.html'), html('logs/error-logs.page2-last.html')]})
        result = client(bridge).logs('error', 3, {'application': 'Sample Orders', 'module': 'SampleOrders'}, stack_contains='Invalid object')
        self.assertForm('logs/error-logs.filter.request.json', bridge, 0)
        self.assertEqual((3, True), (len(result['rows']), result['truncated']))

    def test_error_log_export_is_the_full_xlsx(self):
        body = (MODERN / 'logs' / 'ErrorLog.xlsx').read_bytes()
        bridge = FakeBridge(pages={('GET', SC + 'Error_Logs.aspx'): html('logs/error-logs.page1.html'),
                                   ('POST', SC + 'Error_Logs.aspx'): lambda f, a: body if a == 'xlsx' else self.fail('export is xlsx')})
        result = client(bridge, self.temp.name).logs('error', 100, export=True)
        self.assertForm('logs/error-logs.export.request.json', bridge)
        self.assertEqual((5, 'Tenant_Id'), (result['rowCount'], result['columns'][0]))
        self.assertEqual('2026-10-01 14:03:12', result['rows'][0]['INSTANT'])
        self.assertEqual(hashlib.sha256(body).hexdigest(), result['export']['sha256'])

    def test_integration_filter_is_osajax_and_the_export_reuses_its_refreshed_state(self):
        filters = {'module': 'SampleOrders', 'type': 'REST (Consume)', 'action': 'SampleCatalogApi', 'since': '2026-10-01', 'until': '2026-10-02'}
        body = (MODERN / 'logs' / 'IntegrationsLog.xlsx').read_bytes()
        pages = {('GET', SC + 'Integration_Logs.aspx'): html('logs/integration-logs.page1.html')}
        bridge = FakeBridge(pages={**pages, ('POST', SC + 'Integration_Logs.aspx'): reply('logs/integration-logs.filter.osajax-reply.txt')})
        listed = client(bridge).logs('integration', 50, filters)
        self.assertForm('logs/integration-logs.filter.osajax.request.json', bridge)
        self.assertEqual(['SampleCatalogApi.GetItems'], [r['fields']['Action'] for r in listed['rows']])
        bridge = FakeBridge(pages={**pages, ('POST', SC + 'Integration_Logs.aspx'): [reply('logs/integration-logs.filter.osajax-reply.txt'), body]})
        exported = client(bridge, self.temp.name).logs('integration', 50, filters, export=True)
        self.assertForm('logs/integration-logs.export.request.json', bridge)
        self.assertEqual(('xlsx', 2), (self.sent(bridge)[2], exported['rowCount']))

    def test_assumed_general_and_timer_logs_read_their_listing_and_refuse_another(self):
        bridge = FakeBridge(pages={('GET', SC + 'General_Logs.aspx'): html('logs/general-logs.page1.html'),
                                   ('GET', SC + 'Cyclic_Job_Logs.aspx'): html('logs/timer-logs.page1.html')})
        self.assertEqual('INFO', client(bridge).logs('general', 10)['rows'][0]['fields']['Message Type'])
        self.assertEqual('ProcessQueue', client(bridge).logs('timer', 10)['rows'][0]['fields']['Timer'])
        # The live timer filter is the text input labelled "Name".
        timers = client(bridge)
        _, updates = timers.log_filters('timer', timers.get('Cyclic_Job_Logs.aspx'), {'timer': 'ProcessQueue'})
        self.assertEqual({'wt9$wtContentTop$wtInput1': 'ProcessQueue'}, updates)
        bridge.pages[('GET', SC + 'Cyclic_Job_Logs.aspx')] = html('logs/timer-logs.page1.html', ('>Timer</th>', '>Job</th>'))
        with self.assertRaises(LayoutError) as e:
            client(bridge).logs('timer', 10)
        self.assertEqual(('LAYOUT_UNKNOWN', 'page-layout', 'Cyclic_Job_Logs.aspx'),
                         (e.exception.code, e.exception.extra['continuation']['action'], e.exception.extra['continuation']['path']))

    def test_error_detail_reads_only_the_content(self):
        bridge = FakeBridge(pages={('GET', SC + 'Show_Error.aspx?Error_Id=c0ffee00-0000-4000-8000-0000000e0001'): html('logs/show-error.html')})
        detail = client(bridge).error_detail('c0ffee00-0000-4000-8000-0000000e0001')['detail']
        self.assertIn('   at ssSampleOrders.Flows.FlowMainFlow.ScrnOrders.Preparation(HeContext heContext)', detail)
        self.assertIn('0a1b2c3d-0000-4000-8000-00000000f001', detail)
        for decoy in ('RecentDecoy', 'Licensed to', 'licensee@example.test'):
            self.assertNotIn(decoy, detail)


class ModuleTabTests(ModernTest):
    def pages(self):
        return {('GET', SC + 'eSpace_Edit.aspx?EspaceId=102'): html('factory/espace-edit.html')}

    def test_tabs_are_inline_panels_and_recent_items_are_ignored(self):
        c = client(FakeBridge(pages=self.pages()))
        timers = c.resources('102', 'timers')
        self.assertEqual(('tab-Timers', ['ProcessQueue', 'NightlyCleanup']), (timers['tab'], [r['fields']['Name'] for r in timers['rows']]))
        self.assertEqual(f'https://{HOST}{TIMER}', timers['rows'][0]['links'][0]['href'])
        props = c.resources('102', 'site-properties')
        self.assertEqual(['MaxBatchSize', 'FeatureEnabled', 'PartnerApiToken'], [r['fields']['Name'] for r in props['rows']])
        self.assertEqual({'<redacted>'}, {r['fields']['Effective Value'] for r in props['rows']})
        found = c.integrations('102')['integrations']
        self.assertEqual([('exposed-rest', '35', 'SampleOrdersApi'), ('consumed-rest', '122', 'SampleCatalogApi'), ('consumed-soap', '20', 'SampleLegacyService')],
                         [(i['kind'], i['id'], i['name']) for i in found])
        self.assertNotIn('Decoy', json.dumps([timers, props, found]))

    def test_property_value_is_redacted_unless_asked_and_never_when_masked(self):
        pages = {**self.pages(), ('GET', PROPERTY.format(501)): html('site-properties/site-property-edit.integer.html'),
                 ('GET', PROPERTY.format(503)): html('site-properties/site-property-edit.secret.html')}
        c = client(FakeBridge(pages=pages))
        self.assertEqual('<redacted>', c.property_value('102', 'MaxBatchSize')['value'])
        self.assertEqual('250', c.property_value('102', 'MaxBatchSize', reveal=True)['value'])
        shown = c.property_value('102', 'PartnerApiToken', reveal=True)
        self.assertEqual(('<redacted>', True, False), (shown['value'], shown['secret'], shown['revealed']))

    def test_a_tab_header_without_its_panel_is_an_unknown_layout(self):
        page = html('factory/espace-edit.html', ('class="tabs-content-item" data-tab="tab-Timers"', 'class="tabs-content-item" data-pane="tab-Timers"'))
        with self.assertRaises(LayoutError):
            client(FakeBridge(pages={('GET', SC + 'eSpace_Edit.aspx?EspaceId=102'): page})).resources('102', 'timers')


class TimerAndPropertyTests(ModernTest):
    def bridge(self, timer, post, extra=None, **options):
        pages = {('GET', SC + 'eSpace_Edit.aspx?EspaceId=102'): html('factory/espace-edit.html'), ('GET', TIMER): timer,
                 ('POST', SC + 'eSpace_Timer_Edit.aspx'): post, **(extra or {})}
        return FakeBridge(pages=pages, **options)

    def mutate(self, bridge, action, name='ProcessQueue', **kwargs):
        return client(bridge).mutate(action, '102', name, execute=True, words='go', operation_id=str(uuid.uuid4()), journal=self.journal, **kwargs)

    def test_run_now_posts_the_fixture_form_and_only_means_scheduled(self):
        bridge = self.bridge(html('timers/timer-edit.active.html'), html('timers/timer-run-now.response.html'))
        receipt = self.mutate(bridge, 'timer-run')
        self.assertForm('timers/timer-run-now.request.json', bridge)
        self.assertEqual(('accepted', False, True), (receipt['state'], receipt['executionCompleted'], self.sent(bridge)[3]))
        refused = self.mutate(self.bridge(html('timers/timer-edit.active.html'), html('timers/timer-run-now.error.html')), 'timer-run')
        self.assertEqual((False, 'uncertain'), (refused['ok'], refused['state']))

    def test_deactivate_and_activate_are_confirmed_by_the_opposite_button(self):
        state = ['timers/timer-edit.active.html']
        def post(form, accept):
            state[0] = 'timers/timer-edit.inactive.html' if 'wt9$wtContentTop$wtDeactivateButton' in form else 'timers/timer-activate.response.html'
            return html(state[0])
        bridge = self.bridge(lambda f, a: html(state[0]), post)
        self.assertEqual('confirmed', self.mutate(bridge, 'timer-deactivate')['state'])
        self.assertForm('timers/timer-deactivate.request.json', bridge)
        self.assertEqual('confirmed', self.mutate(bridge, 'timer-activate')['state'])
        self.assertEqual('Activate', self.sent(bridge)[1]['wt9$wtContentTop$wtActivateButton'])

    def test_schedule_is_set_by_its_controls_and_read_back(self):
        state = [html('timers/timer-edit.active.html')]
        def post(form, accept):
            state[0] = html('timers/timer-schedule.response.html', ('<option value="__ossli_0" selected="selected">Daily</option>', '<option value="__ossli_0">Daily</option>'),
                            ('<option value="__ossli_3">Every N minutes', '<option value="__ossli_3" selected="selected">Every N minutes'),
                            ('name="wt9$wtContentMain$wtSchedule_Interval" type="text" value=""', 'name="wt9$wtContentMain$wtSchedule_Interval" type="text" value="15"'))
            return state[0]
        bridge = self.bridge(lambda f, a: state[0], post)
        plan = client(bridge).mutate('timer-schedule', '102', 'ProcessQueue', value={'recurrence': 'every n minutes', 'every': '15'})
        self.assertEqual(({'recurrence': 'Daily', 'at': '03:00', 'every': '', 'timeout': '20'}, {'recurrence': 'Every N minutes', 'every': '15'}),
                         (plan['currentSchedule'], plan['schedule']))
        receipt = self.mutate(bridge, 'timer-schedule', value={'recurrence': 'Every N minutes', 'every': '15'})
        self.assertForm('timers/timer-schedule.request.json', bridge)
        self.assertEqual('confirmed', receipt['state'])
        verified = client(bridge).verify(receipt, self.journal)
        self.assertTrue(verified['observedDesiredState'])
        with self.assertRaisesRegex(ProtocolError, 'option'):
            client(bridge).mutate('timer-schedule', '102', 'ProcessQueue', value={'recurrence': 'Hourly'})

    def test_an_assumed_timer_page_without_its_schedule_editor_is_refused_with_a_capture_request(self):
        page = html('timers/timer-edit.active.html', ('wtSchedule_Recurrence"', 'wtRecurrence"'), ('>Recurrence</label>', '>Repeat</label>'))
        bridge = self.bridge(page, lambda f, a: self.fail('nothing is sent'))
        args = ['timer-schedule', '--host', HOST, '--module-id', '102', '--name', 'ProcessQueue', '--schedule-every', '15']
        with self.assertRaises(LayoutError) as e:
            main(args, journal=self.journal, locate=lambda: bridge, present=lambda t: False, running=lambda: False,
                 opener=lambda *a: self.fail('no prompt'), exports=self.temp.name)
        self.assertIn('capture this page live', str(e.exception).casefold())
        self.assertEqual(TIMER[len(SC):], e.exception.extra['continuation']['path'])
        self.assertEqual([], bridge.posts())

    def property_bridge(self, property_id, page, post, after=None, **options):
        pages = {('GET', SC + 'eSpace_Edit.aspx?EspaceId=102'): html('factory/espace-edit.html'),
                 ('GET', PROPERTY.format(property_id)): (lambda f, a: after[0]) if after else page, ('POST', SC + 'eSpace_SiteProperty_Edit.aspx'): post}
        return FakeBridge(pages=pages, **options)

    def test_property_value_from_a_file_is_posted_and_read_back(self):
        after = [html('site-properties/site-property-edit.integer.html')]
        def post(form, accept):
            after[0] = html('site-properties/site-property-set.response.html')
            return after[0]
        bridge = self.property_bridge(501, None, post, after)
        receipt = self.mutate(bridge, 'property-set', 'MaxBatchSize', value='500')
        self.assertForm('site-properties/site-property-set.request.json', bridge)
        self.assertEqual(('confirmed', '<redacted>'), (receipt['state'], receipt['plan']['value']))

    def test_a_false_boolean_leaves_the_checkbox_out(self):
        after = [html('site-properties/site-property-edit.boolean.html')]
        def post(form, accept):
            after[0] = html('site-properties/site-property-edit.boolean.html', (' checked="checked"', ''))
            return after[0]
        bridge = self.property_bridge(502, None, post, after)
        self.assertEqual('confirmed', self.mutate(bridge, 'property-set', 'FeatureEnabled', value='false')['state'])
        self.assertForm('site-properties/site-property-set.boolean-false.request.json', bridge)

    def test_a_secret_property_goes_only_as_a_vault_reference(self):
        target = f'SSAM/O11/{HOST}/SiteProperty/PartnerApiToken'
        secret = html('site-properties/site-property-edit.secret.html')
        bridge = self.property_bridge(503, secret, lambda f, a: html('site-properties/site-property-set.secret.response.html'), capabilities=SECRETS)
        with self.assertRaisesRegex(ProtocolError, 'value-vault'):
            self.mutate(bridge, 'property-set', 'PartnerApiToken', value='typed-in-chat')
        receipt = self.mutate(bridge, 'property-set', 'PartnerApiToken', secret=target)
        self.assertForm('site-properties/site-property-set.secret.request.json', bridge, wtInput_Value='')
        self.assertEqual([{'pointer': '/wt9$wtContentMain$wtInput_Value', 'target': target, 'field': 'password'}],
                         bridge.refs[bridge.calls.index(bridge.posts()[-1])])
        self.assertEqual(('accepted', False), (receipt['state'], receipt['valueVerified']))
        self.assertNotIn('typed-in-chat', json.dumps(receipt) + ''.join(p.read_text() for p in (Path(self.temp.name) / 'receipts').glob('*')))
        old = self.property_bridge(503, secret, lambda f, a: self.fail('never posted'))
        with self.assertRaises(BridgeError) as e:
            self.mutate(old, 'property-set', 'PartnerApiToken', secret=target)
        self.assertEqual('STUDIO_BRIDGE_OUTDATED', e.exception.code)

    def test_the_cli_opens_the_site_property_prompt_before_any_reservation(self):
        prompts = []
        bridge = self.property_bridge(503, html('site-properties/site-property-edit.secret.html'), lambda f, a: self.fail('never posted'), capabilities=SECRETS)
        with self.assertRaises(BridgeError) as e:
            main(['property-set', '--host', HOST, '--module-id', '102', '--name', 'PartnerApiToken', '--value-vault', f'SSAM/O11/{HOST}/SiteProperty/PartnerApiToken',
                  '--execute', '--operation-id', str(uuid.uuid4()), '--words', 'set PartnerApiToken on sc', '--confirm-host', HOST],
                 journal=self.journal, locate=lambda: bridge, present=lambda t: False, running=lambda: False,
                 opener=lambda host, kind, name=None: prompts.append((kind, name)) or {'opened': True}, exports=self.temp.name)
        self.assertEqual(('CREDENTIAL_PROMPT_OPENED', [('SiteProperty', 'PartnerApiToken')]), (e.exception.code, prompts))
        self.assertFalse((Path(self.temp.name) / 'receipts').exists())


class DatabaseConnectionTests(ModernTest):
    TARGET = f'SSAM/O11/{HOST}/DatabaseConnection/SampleWarehouse'
    ROW = '<tr>\n\t\t\t<td class="table-row"><a class="link" href="DatabaseConnection_Edit.aspx?DBConnectionId=7">SampleWarehouse</a></td><td class="table-row">SqlServer</td><td class="table-row">db.example.test / warehouse</td>\n\t\t</tr>'

    def listing(self, present=True):
        return html('dbconnections/dbconnections-list.html', *(() if present else ((self.ROW, ''),)))

    def refs(self, bridge, index=-1):
        return bridge.refs[bridge.calls.index(bridge.posts()[index])]

    def test_create_sends_the_fixture_form_with_vault_references_for_the_login(self):
        created = []
        bridge = FakeBridge(pages={('GET', SC + 'DatabaseConnections_List.aspx'): lambda f, a: self.listing(bool(created)),
                                   ('GET', SC + 'DatabaseConnection_Edit.aspx'): html('dbconnections/dbconnection-edit.new.html'),
                                   ('POST', SC + 'DatabaseConnection_Edit.aspx'): lambda f, a: created.append(1) or self.listing()}, capabilities=SECRETS)
        args = {'connection': 'SampleWarehouse', 'server': 'db.example.test', 'database': 'warehouse', 'parameters': {}}
        receipt = self.execute(client(bridge), 'db-connection-create', args)
        self.assertEqual('confirmed', receipt['state'])
        self.assertForm('dbconnections/dbconnection-create.request.json', bridge, **{'ctl00$wt173': '', 'ctl02$wt133': ''})
        self.assertEqual([{'pointer': '/wt9$wtContentMain$wtDBParams$ctl00$wt173', 'target': self.TARGET, 'field': 'username'},
                          {'pointer': '/wt9$wtContentMain$wtDBParams$ctl02$wt133', 'target': self.TARGET, 'field': 'password'}], self.refs(bridge))

    def test_test_connection_returns_only_the_outcome(self):
        for page, passed in (('dbconnections/dbconnection-test.success.html', True), ('dbconnections/dbconnection-test.failure.html', False)):
            with self.subTest(page=page):
                bridge = FakeBridge(pages={('GET', SC + 'DatabaseConnections_List.aspx'): self.listing(),
                                           ('GET', SC + 'DatabaseConnection_Edit.aspx?DBConnectionId=7'): html('dbconnections/dbconnection-edit.existing.html'),
                                           ('POST', SC + 'DatabaseConnection_Edit.aspx'): html(page)}, capabilities=SECRETS)
                receipt = self.execute(client(bridge), 'db-connection-test', {'connection': 'SampleWarehouse'})
                self.assertEqual(('confirmed', passed), (receipt['state'], receipt['testPassed']))
                _, form, _, write = self.sent(bridge)
                self.assertEqual(('Test Connection', '', '', True), (form['wt9$wtContentMain$wtTestConnectionButton'], form['wt9$wtContentMain$wtDBParams$ctl00$wt173'],
                                                                     form['wt9$wtContentMain$wtDBParams$ctl02$wt133'], write))
                self.assertNotIn('wt9$wtContentMain$wtSaveButton', form)
                self.assertEqual(['username', 'password'], [r['field'] for r in self.refs(bridge)])
                # The server's text echoes the login; it never comes back.
                self.assertNotIn('svc_reader', json.dumps(receipt))

    def test_delete_does_not_run_here(self):
        # CX15 r2 (L): db-connection-delete does not run in this script (test_service_center_deletes.py); the page form it
        # posted is the facade's (service-center/client.mjs), previewed and confirmed by o11_service_center_write.
        bridge = FakeBridge()
        run = lambda *extra: main(['db-connection-delete', '--host', HOST, '--connection', 'SampleWarehouse', *extra], journal=self.journal,
                                  locate=lambda: bridge, present=lambda t: False, running=lambda: False, opener=lambda *a: self.fail('no prompt'), exports=self.temp.name)
        for result in (run(), run('--execute', '--confirm-host', HOST, '--operation-id', str(uuid.uuid4()), '--words', 'delete SampleWarehouse, used by SampleWarehouseExt, on sc')):
            self.assertEqual(('DESTRUCTIVE_NEEDS_DEDICATED_TOOL', 'o11_service_center_write'), (result['code'], result['continuation']['tool']))
        self.assertEqual([], bridge.posts())

    def test_extension_mapping_is_the_fixture_change_then_apply(self):
        mapped = []
        def extension(form, accept):
            page = html('factory/extension-edit.html')
            return page.replace('<option value="0" selected="selected">', '<option value="0">').replace('<option value="7">', '<option value="7" selected="selected">') if mapped else page
        def post(form, accept):
            if '__AJAXEVENT' in form:
                return reply('factory/extension-db-mapping.change.osajax-reply.txt')(form, accept)
            mapped.append(1)
            return extension(form, accept)
        bridge = FakeBridge(pages={('GET', SC + 'DatabaseConnections_List.aspx'): self.listing(),
                                   ('GET', SC + 'Extension_Edit.aspx?ExtensionId=202'): extension, ('POST', SC + 'Extension_Edit.aspx'): post})
        receipt = self.execute(client(bridge), 'extension-db-connection', {'extensionId': '202', 'connection': 'SampleWarehouse'})
        self.assertEqual('confirmed', receipt['state'])
        self.assertForm('factory/extension-db-mapping.change.osajax.request.json', bridge, 0)
        self.assertForm('factory/extension-db-mapping.apply.request.json', bridge, 1)
        self.assertEqual([False, True], [p[6] for p in bridge.posts()])


class SolutionTests(ModernTest):
    def pages(self, edit='solutions/solution-edit.html', listing=None):
        return {('GET', SC + 'Solutions_List.aspx'): listing or html('solutions/solutions-list.html'),
                ('GET', SC + 'Solution_Edit.aspx?SolutionId=11'): html(edit)}

    def test_create_posts_the_fixture_form_and_reads_the_list_back(self):
        created = []
        listing = lambda f, a: html('solutions/solutions-list.html', *((('>SampleRelease</a>', '>SampleHotfix</a>'),) if created else ()))
        bridge = FakeBridge(pages={**self.pages(listing=listing), ('GET', SC + 'Solution_Edit.aspx'): html('solutions/solution-edit.new.html'),
                                   ('POST', SC + 'Solution_Edit.aspx'): lambda f, a: created.append(1) or html('solutions/solution-edit.created.html')})
        receipt = self.execute(client(bridge), 'solution-create', {'solution': 'SampleHotfix', 'description': 'Synthetic solution created by the fixture'})
        self.assertForm('solutions/solution-create.request.json', bridge)
        self.assertEqual('confirmed', receipt['state'])

    def test_add_component_resolves_the_key_by_the_autocomplete_lookup_then_associates(self):
        added = []
        def post(form, accept):
            if form.get('__AJAXEVENT') == 'Notify':
                return reply('solutions/solution-component-lookup.osajax-reply.txt')(form, accept)
            added.append(1)
            return html('solutions/solution-edit.html')
        edit = lambda f, a: html('solutions/solution-edit.html', *((('>SampleUtilExt</a>', '>SampleShared_IS</a>'),) if added else ()))
        bridge = FakeBridge(pages={**self.pages(), ('GET', SC + 'Solution_Edit.aspx?SolutionId=11'): edit,
                                   ('POST', SC + 'Solution_Edit.aspx?_ts=0'): post, ('POST', SC + 'Solution_Edit.aspx'): post})
        args = {'solution': 'SampleRelease', 'component': 'SampleShared_IS', 'includeReferences': True}
        plan = client(bridge).web_write('solution-add-component', args)
        self.assertEqual(('SampleShared_IS (Module)', '7c3d9e10-0000-4000-8000-00000000e103', False),
                         (plan['componentLabel'], plan['componentKey'], plan['alreadyPresent']))
        self.assertForm('solutions/solution-component-lookup.osajax.request.json', bridge, 0,
                        wtComponentInput='SampleShared_IS', __AJAX='1024,768,,0,0,0,0,0,0,SampleShared_IS%')
        self.assertFalse(bridge.posts()[0][6], 'the lookup is a read')
        receipt = self.execute(client(bridge), 'solution-add-component', args)
        self.assertEqual('confirmed', receipt['state'])
        self.assertForm('solutions/solution-add-component.request.json', bridge)
        with self.assertRaisesRegex(ProtocolError, 'SampleShared'):
            client(bridge).web_write('solution-add-component', dict(args, component='SampleShared'))

    def test_remove_component_is_the_rows_postback(self):
        removed = []
        edit = lambda f, a: html('solutions/solution-edit.html', *((('>SampleUtilExt</a>', '>Gone</a>'),) if removed else ()))
        bridge = FakeBridge(pages={**self.pages(), ('GET', SC + 'Solution_Edit.aspx?SolutionId=11'): edit,
                                   ('POST', SC + 'Solution_Edit.aspx'): lambda f, a: removed.append(1) or html('solutions/solution-edit.html')})
        receipt = self.execute(client(bridge), 'solution-remove-component', {'solution': 'SampleRelease', 'component': 'SampleUtilExt'})
        self.assertForm('solutions/solution-remove-component.request.json', bridge)
        self.assertEqual('confirmed', receipt['state'])

    def test_download_posts_the_fixture_form_and_keeps_the_package(self):
        bridge = FakeBridge(pages={**self.pages(), ('POST', SC + 'Solution_Edit.aspx'): lambda f, a: b'PK\x03\x04osp' if a == 'binary' else self.fail(a)})
        saved = client(bridge, self.temp.name).solution_download('SampleRelease')
        self.assertForm('solutions/solution-download.request.json', bridge)
        self.assertEqual(hashlib.sha256(b'PK\x03\x04osp').hexdigest(), saved['sha256'])

    def test_an_unknown_solutions_list_is_refused_with_a_capture_request(self):
        bridge = FakeBridge(pages={('GET', SC + 'Solutions_List.aspx'): '<form method="post"><p>Solutions moved</p></form>'})
        with self.assertRaises(LayoutError) as e:
            client(bridge).solutions()
        self.assertEqual('Solutions_List.aspx', e.exception.extra['continuation']['path'])


class IntegrationAndBptTests(ModernTest):
    def test_log_level_posts_the_fixture_form_and_reads_back(self):
        level = ['integrations/rest-consume-edit.html']
        detail = SC + 'eSpace_RestWebReference_Edit.aspx?TenantIdx=0&RestWebreferenceId=122&VersionIdx=0'
        def post(form, accept):
            level[0] = 'integrations/rest-consume-edit.after-full.html'
            return html(level[0])
        bridge = FakeBridge(pages={('GET', SC + 'eSpace_Edit.aspx?EspaceId=102'): html('factory/espace-edit.html'),
                                   ('GET', detail): lambda f, a: html(level[0]), ('POST', SC + 'eSpace_RestWebReference_Edit.aspx'): post})
        receipt = self.execute(client(bridge), 'integration-log-level', {'moduleId': '102', 'integration': 'SampleCatalogApi', 'level': 'Full'})
        self.assertForm('integrations/log-level.request.json', bridge)
        self.assertEqual(('confirmed', 'Full'), (receipt['state'], receipt['observedLevel']))

    def test_bpt_filter_posts_the_fixture_form(self):
        bridge = FakeBridge(pages={('GET', SC + 'Process_Monitoring.aspx?Index=0'): html('bpt/process-monitoring.html'),
                                   ('POST', SC + 'Process_Monitoring.aspx'): html('bpt/process-monitoring.html')})
        result = client(bridge).bpt_processes('SampleOrders', 'OrderApproval')
        self.assertForm('bpt/process-monitoring.filter.request.json', bridge)
        self.assertEqual(('3f2e1d0c-0000-4000-8000-00000000b001', '7c3d9e10-0000-4000-8000-00000000e101'),
                         (result['rows'][0]['processKey'], result['rows'][0]['moduleKey']))

    def test_bpt_instance_and_activity_summaries(self):
        bridge = FakeBridge(pages={('GET', SC + 'Process_Instance_Detail.aspx?ProcessId=9001'): html('bpt/process-instance-detail.html'),
                                   ('GET', SC + 'Process_Activity_Detail.aspx?ActivityId=9102'): html('bpt/process-activity-detail.html')})
        instance = client(bridge).bpt_instance('9001')
        self.assertEqual(('Process OrderApproval Instance no. 9001', 'Active', ['9101', '9102']),
                         (instance['title'], instance['summary']['Status'], [a['activityId'] for a in instance['activities']]))
        self.assertEqual('ApproveOrder', client(bridge).bpt_activity('9102')['summary']['Following Activity'])

    def test_permission_feedback_is_a_failure(self):
        bridge = FakeBridge(pages={('GET', SC + 'eSpaces_List.aspx'): html('_common/permission-error.html')})
        with self.assertRaisesRegex(ProtocolError, 'permission'):
            client(bridge).modules()


class PageLayoutTests(ModernTest):
    def test_page_layout_returns_names_and_keeps_markup_without_values(self):
        bridge = FakeBridge(pages={('GET', SC + 'DatabaseConnection_Edit.aspx?DBConnectionId=7'): html('dbconnections/dbconnection-edit.existing.html')})
        result = main(['page-layout', '--host', HOST, '--path', 'DatabaseConnection_Edit.aspx?DBConnectionId=7'], journal=self.journal,
                      locate=lambda: bridge, present=lambda t: False, running=lambda: False, opener=lambda *a: self.fail('no prompt'), exports=self.temp.name)
        self.assertEqual(('sc-content-main', 'Database Connection SampleWarehouse'), (result['scope'], result['title']))
        controls = {c['name']: c for c in result['controls']}
        self.assertEqual(('password', 'password'), (controls['wt9$wtContentMain$wtDBParams$ctl02$wt133']['type'], controls['wt9$wtContentMain$wtDBParams$ctl02$wt133']['label']))
        self.assertIn({'text': 'Delete', 'kind': 'postback', 'target': 'wt9$wtContentTop$wtButton7', 'argument': ''}, result['postbacks'])
        self.assertIn('Extension_Edit.aspx?ExtensionId=', result['links'])
        self.assertIn('__OSVSTATE', result['formState'])
        saved = Path(result['capture']['file']).read_text(encoding='utf-8')
        self.assertEqual(hashlib.sha256(saved.encode('utf-8')).hexdigest(), result['capture']['sha256'])
        for value in ('svc_reader', 'db.example.test', 'U1NBTS1TWU5U', 'Recent', 'licensee'):
            self.assertNotIn(value, json.dumps(result) + saved)
        self.assertIn('wtTestConnectionButton', saved)
        with self.assertRaises(ProtocolError):
            main(['page-layout', '--host', HOST, '--path', '../Users/Login.aspx'], journal=self.journal, locate=lambda: bridge,
                 present=lambda t: False, running=lambda: False, exports=self.temp.name)


if __name__ == '__main__':
    unittest.main()
