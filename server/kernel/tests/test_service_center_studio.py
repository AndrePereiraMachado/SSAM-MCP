"""Service Center through the connected Studio (bridge sc_session/sc_api/sc_web/studio_login), offline: a fake bridge,
synthetic HTML fixtures (kernel/tests/fixtures/service-center) and a loopback JSON-lines server. No Studio, Service
Center, identity provider or credential store is contacted."""
import base64
import hashlib
import io
import json
import re
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from service_center import auth as auth_module
from service_center import studio_api
from service_center.auth import AuthRequired, Resolver, guard_write, open_prompt
from service_center.bridge import VERBS, StudioBridge, redact
from service_center.client import Client, Journal, bridge_failure, xlsx_rows
from service_center.http import BridgeError, Document, Page, ProtocolError, StudioWebTransport, Vault
from o11_service_center import main

HOST = 'test.example.com'
PERSONAL = 'personal-2qqw9srv.outsystemscloud.com'
FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'service-center'
SC = '/ServiceCenter/'


def fixture(name, **values):
    text = (FIXTURES / name).read_text(encoding='utf-8')
    for key, value in values.items():
        text = text.replace('{' + key + '}', value)
    return text


def xlsx(rows):
    """A minimal XLSX (shared strings + first sheet), as the Service Center export produces."""
    strings = sorted({v for r in rows for v in r if not v.replace('.', '').isdigit()})
    index = {s: i for i, s in enumerate(strings)}
    def cell(ref, value):
        if value in index:
            return f'<c r="{ref}" t="s"><v>{index[value]}</v></c>'
        return f'<c r="{ref}"><v>{value}</v></c>'
    sheet = ''.join(f'<row r="{n + 1}">' + ''.join(cell(chr(65 + i) + str(n + 1), v) for i, v in enumerate(r) if v != '') + '</row>'
                    for n, r in enumerate(rows))
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as book:
        book.writestr('xl/sharedStrings.xml', f'<sst xmlns="{ns}">' + ''.join(f'<si><t>{s}</t></si>' for s in strings) + '</sst>')
        book.writestr('xl/worksheets/sheet1.xml', f'<worksheet xmlns="{ns}"><sheetData>{sheet}</sheetData></worksheet>')
    return buffer.getvalue()


class FakeBridge:
    """The contract's bridge verbs in memory: pages by (method, path), API results by operation."""
    pid, version = 4242, '2.0.0'

    # login: what sc_web login answers (an Exception is raised; anything else signs the hidden window in).
    def __init__(self, signed=True, web=True, verbs=VERBS, pages=None, api=None, capabilities=('sc_api:soap', 'sc_web'), login=None):
        self.signed, self.web_signed, self._verbs, self._capabilities = signed, web, set(verbs), set(capabilities)
        self.login_reply = login
        self.pages, self.replies, self.calls, self.targets = dict(pages or {}), dict(api or {}), [], []
        self.refs = {}  # call index -> secretRefs of that sc_web fetch

    def supports(self):
        return set(VERBS) <= self._verbs

    def capabilities(self):
        return set(self._capabilities)

    def session(self, host):
        self.calls.append(('session', host))
        return {'ok': True, 'source': 'studio', 'host': host, 'bridgeVersion': self.version,
                'studio': {'signedIn': self.signed, 'user': 'dev@example.test', 'loginType': 'sso'},
                'web': {'open': self.web_signed, 'signedIn': self.web_signed}}

    def login(self, host):
        self.calls.append(('login', host))
        return {'ok': True}

    def api(self, host, surface, operation, args=None, *, write=False, operation_id=None, authorize_sha256=None, target=None):
        self.calls.append(('api', surface, operation, dict(args or {}), write, operation_id, authorize_sha256))
        self.targets.append(target)
        reply = self.replies[operation]
        if callable(reply):
            reply = reply(args or {})
        if isinstance(reply, Exception):
            raise reply
        return {'ok': True, 'source': 'studio', 'host': host, 'user': 'dev@example.test', 'elapsedMs': 3, 'result': reply}

    def web(self, host, action, *, method=None, path=None, form=None, accept=None, write=False, operation_id=None, authorize_sha256=None,
            secret_refs=None, hidden=False):
        self.calls.append(('web', action, method, path, dict(form or {}), accept, write, operation_id, authorize_sha256))
        if secret_refs:
            self.refs[len(self.calls) - 1] = [dict(r) for r in secret_refs]
        if action == 'login':
            if isinstance(self.login_reply, Exception):
                raise self.login_reply
            self.web_signed = True
            return {'ok': True, 'signedIn': True, 'submitted': True, 'hidden': True}
        if action != 'fetch':
            return {'ok': True, 'signedIn': self.web_signed}
        entry = self.pages[(method, path)]
        if isinstance(entry, list):
            entry = entry.pop(0)
        if callable(entry):
            entry = entry(form or {}, accept)
        if isinstance(entry, Exception):
            raise entry
        if isinstance(entry, dict):
            return entry
        base = {'ok': True, 'source': 'studio-web', 'host': host, 'status': 200, 'finalUrl': f'https://{host}{path}'}
        if isinstance(entry, bytes):
            return dict(base, contentType='application/octet-stream', bodyBase64=base64.b64encode(entry).decode())
        return dict(base, contentType='text/html; charset=utf-8', html=entry)

    def posts(self):
        return [c for c in self.calls if c[0] == 'web' and c[2] == 'POST']

    def writes(self):
        return [c for c in self.calls if (c[0] == 'api' and c[4]) or (c[0] == 'web' and c[6])]


class FakeVault:
    """Status only: no test reads a credential value (the facade never does for database logins and secret values)."""
    host = HOST

    def __init__(self, stored=True):
        self.stored = stored

    def present(self, target):
        return self.stored

    def secret_target(self, kind, name):
        return Vault.secret_target(self, kind, name)


def web_client(bridge, exports=None, host=HOST, stored=True):
    vault = FakeVault(stored)
    vault.host = host
    return Client(vault, StudioWebTransport(host, bridge), exports)


def solution_pages(bridge, components):
    listing = fixture('solutions.html')
    def edit(form, accept):
        html = fixture('solution-edit.html')
        for name in ('Orders', 'Billing_Core'):
            if name not in components:
                html = html.replace(f'<td>{name}</td>', '<td>-</td>')
        if 'Payments' in components:
            html = html.replace('</table>', '<tr><td>Payments</td><td>Module</td><td></td></tr></table>')
        return html
    bridge.pages.update({('GET', SC + 'eSpaces_List.aspx'): listing, ('GET', SC + 'Solutions_List.aspx'): listing,
                         ('GET', SC + 'Solution_Edit.aspx?SolutionId=5'): edit})


class StudioWebTransportTests(unittest.TestCase):
    def test_reads_go_without_and_authorized_posts_with_the_write_fields(self):
        bridge = FakeBridge(pages={('GET', SC + 'Error_Logs.aspx'): fixture('error-logs-1.html'),
                                   ('POST', SC + 'Write.aspx'): '<p>done</p>'})
        t = StudioWebTransport(HOST, bridge)
        page = t.request('Error_Logs.aspx')
        self.assertEqual(f'https://{HOST}{SC}Error_Logs.aspx', page.url)
        t.request('Write.aspx', [('a', '1')])
        self.assertFalse(bridge.calls[-1][6])
        operation = str(uuid.uuid4())
        with t.authorizing(operation, 'a' * 64) as tracker:
            t.request('Write.aspx', [('a', '1')])
        self.assertEqual(('web', 'fetch', 'POST', SC + 'Write.aspx', {'a': '1'}, 'html', True, operation, 'a' * 64), bridge.calls[-1])
        self.assertTrue(tracker['sent'])

    def test_login_page_or_another_host_is_never_followed(self):
        for final, code in ((f'https://{HOST}{SC}Login.aspx?OriginalURL=x', 'WEB_SIGN_IN_REQUIRED'),
                            ('https://id.outsystems.com/login?state=opaque', 'HOST_MISMATCH')):
            bridge = FakeBridge(pages={('GET', SC + 'X.aspx'): {'ok': True, 'status': 200, 'finalUrl': final, 'contentType': 'text/html', 'html': '<p/>'}})
            with self.subTest(final=final), self.assertRaises(BridgeError) as e:
                StudioWebTransport(HOST, bridge).request('X.aspx')
            self.assertEqual(code, e.exception.code)
            self.assertNotIn('opaque', str(e.exception))
        # An expired session (live, 11.42): the SSO login page answers at the asked URL with HTTP 200.
        expired = ('<form method="post" action="Login.aspx" id="WebForm1"><div class="sc-layout-login"><span>You don\'t have a valid '
                   'Service Center session.</span><input type="submit" name="wt89$wtContentRight$wtButton2" value="Log in with SSO"></div></form>')
        bridge = FakeBridge(pages={('GET', SC + 'Show_Error.aspx'): {'ok': True, 'status': 200, 'finalUrl': f'https://{HOST}{SC}Show_Error.aspx',
                                                                   'contentType': 'text/html; charset=utf-8', 'html': expired}})
        with self.assertRaises(BridgeError) as e:
            StudioWebTransport(HOST, bridge).request('Show_Error.aspx')
        self.assertEqual(('WEB_SIGN_IN_REQUIRED', False), (e.exception.code, e.exception.extra['sent']))

    def test_repeated_field_names_and_foreign_paths_fail_before_the_bridge(self):
        bridge = FakeBridge()
        t = StudioWebTransport(HOST, bridge)
        with self.assertRaisesRegex(ProtocolError, 'repeats'):
            t.request('Write.aspx', [('a', '1'), ('a', '2')])
        with self.assertRaises(ProtocolError):
            t.request('https://evil.test/ServiceCenter/X.aspx')
        self.assertEqual([], bridge.calls)

    def test_a_redirected_postback_is_read_again_and_binary_falls_back_to_the_xlsx_body(self):
        bridge = FakeBridge(pages={('POST', SC + 'Edit.aspx'): {'ok': True, 'status': 0, 'redirected': True, 'finalUrl': None},
                                   ('GET', SC + 'Edit.aspx'): '<p>after</p>',
                                   ('POST', SC + 'Download.aspx'): lambda f, a: BridgeError('BAD_REQUEST', 'accept', write=False) if a == 'binary' else b'PK\x03\x04'})
        t = StudioWebTransport(HOST, bridge)
        with t.authorizing(str(uuid.uuid4()), 'c' * 64):
            page = t.request('Edit.aspx', [('save', '1')])
        self.assertEqual('after', page.doc.root.text)
        self.assertEqual([('POST', True), ('GET', False)], [(c[2], c[6]) for c in bridge.calls])
        self.assertEqual(b'PK\x03\x04', t.download('Download.aspx', [('d', '1')], 'binary'))
        self.assertEqual(['binary', 'xlsx'], [c[5] for c in bridge.calls[2:]])

    def test_downloads_decode_base64_and_refuse_a_page_instead_of_the_file(self):
        bridge = FakeBridge(pages={('POST', SC + 'Export.aspx'): [b'PK\x03\x04data', '<html>login</html>']})
        t = StudioWebTransport(HOST, bridge)
        self.assertEqual(b'PK\x03\x04data', t.download('Export.aspx', [('x', '1')], 'xlsx'))
        with self.assertRaisesRegex(ProtocolError, 'page instead of the file'):
            t.download('Export.aspx', [('x', '1')], 'xlsx')


class WebFormsTests(unittest.TestCase):
    def test_osajax_pager_is_replayed_as_the_pages_own_form_post(self):
        bridge = FakeBridge(pages={('GET', SC + 'Error_Logs.aspx'): fixture('error-logs-1.html'),
                                   ('POST', SC + 'Error_Logs.aspx'): fixture('error-logs-2.html')})
        result = web_client(bridge).logs('error', 10)
        self.assertEqual(['NullReference in Checkout', 'Timeout calling PaymentsAPI', 'Invoice rounding'],
                         [r['fields']['Message'] for r in result['rows']])
        self.assertFalse(result['truncated'])
        form = bridge.posts()[0][4]
        self.assertEqual('state-page-1', form['__OSVSTATE'])
        self.assertEqual('', form['wt12$wtNextLink'])
        self.assertNotIn('wt12$wtFilterButton', form)
        self.assertFalse(bridge.posts()[0][6], 'a pager post is a read')
        self.assertEqual([], [r for r in result['rows'] if 'Orders' in json.dumps(r['links']) and 'RecentItems' in r])

    def test_dopostback_carries_the_event_and_the_page_state(self):
        page = Page(f'https://{HOST}{SC}Solution_Edit.aspx?SolutionId=5', Document(fixture('solution-edit.html')))
        link = next(a for a in page.doc.all('a') if a.text == 'Remove')
        url, fields = StudioWebTransport(HOST, FakeBridge()).event_post(page, link)
        fields = dict(fields)
        self.assertEqual(f'https://{HOST}{SC}Solution_Edit.aspx?SolutionId=5', url)
        self.assertEqual(('wt3$wtComponents$ctl02$wtRemove', ''), (fields['__EVENTTARGET'], fields['__EVENTARGUMENT']))
        self.assertEqual(('vs-solution-5', 'ev-solution-5'), (fields['__VIEWSTATE'], fields['__EVENTVALIDATION']))
        self.assertNotIn('wt3$wtAddButton', fields)

    def test_stack_search_sets_the_message_and_the_pages_stack_option(self):
        bridge = FakeBridge(pages={('GET', SC + 'Error_Logs.aspx'): fixture('error-logs-1.html'),
                                   ('POST', SC + 'Error_Logs.aspx'): fixture('error-logs-2.html')})
        result = web_client(bridge).logs('error', 1, stack_contains='CheckoutService.Pay')
        form = bridge.posts()[0][4]
        self.assertEqual(('CheckoutService.Pay', 'on', 'Filter'), (form['wt12$wtInput1'], form['wt12$wtEnableSearchStackTrace'], form['wt12$wtFilterButton']))
        self.assertEqual('CheckoutService.Pay', result['stackContains'])
        with self.assertRaisesRegex(ProtocolError, 'stack'):
            web_client(FakeBridge(pages={('GET', SC + 'General_Logs.aspx'): fixture('error-logs-1.html')})).logs('general', 1, stack_contains='x')

    def test_full_export_parses_the_xlsx_and_keeps_the_file(self):
        body = xlsx([['ID', 'INSTANT', 'Espace_Name', 'MESSAGE'], ['e-101', '46296.5', 'Orders', 'NullReference'],
                     ['e-100', '46296.25', 'Orders', 'Timeout']])
        # The filtered page echoes the chosen module, as Service Center does.
        filtered = fixture('error-logs-1.html').replace('name="wt12$wtEspace_Selector"><option value="0" selected>', 'name="wt12$wtEspace_Selector"><option value="0">') \
            .replace('<option value="42">', '<option value="42" selected>')
        bridge = FakeBridge(pages={('GET', SC + 'Error_Logs.aspx'): fixture('error-logs-1.html'),
                                   ('POST', SC + 'Error_Logs.aspx'): lambda form, accept: body if accept == 'xlsx' else filtered})
        with tempfile.TemporaryDirectory() as temp:
            result = web_client(bridge, temp).logs('error', 1, {'module': 'Orders'}, export=True)
            self.assertEqual(2, result['rowCount'])
            self.assertTrue(result['truncated'])
            self.assertEqual({'ID': 'e-101', 'INSTANT': '2026-10-01 12:00:00', 'Espace_Name': 'Orders', 'MESSAGE': 'NullReference'}, result['rows'][0])
            saved = Path(result['export']['file'])
            self.assertEqual(hashlib.sha256(body).hexdigest(), hashlib.sha256(saved.read_bytes()).hexdigest())
        export_form = bridge.posts()[-1][4]
        self.assertEqual(('Export to excel', '42'), (export_form['wt12$wtExportButton'], export_form['wt12$wtEspace_Selector']))

    def test_export_after_an_ajax_fragment_uses_its_refreshed_state(self):
        fragment = '<div><input type="hidden" name="__OSVSTATE" value="state-filtered"></div>'
        body = xlsx([['ID', 'MESSAGE'], ['e-1', 'm']])
        page = fixture('error-logs-1.html').replace('action="Error_Logs.aspx"', 'action="Integration_Logs.aspx"')
        bridge = FakeBridge(pages={('GET', SC + 'Integration_Logs.aspx'): page,
                                   ('POST', SC + 'Integration_Logs.aspx'): [fragment, body]})
        with tempfile.TemporaryDirectory() as temp:
            result = web_client(bridge, temp).logs('integration', 10, {'module': 'Orders'}, export=True)
        self.assertEqual(1, result['rowCount'])
        export_form = bridge.posts()[-1][4]
        self.assertEqual(('state-filtered', '42'), (export_form['__OSVSTATE'], export_form['wt12$wtEspace_Selector']))

    def test_xlsx_with_skipped_cells_keeps_columns(self):
        self.assertEqual([['a', '', 'c']], xlsx_rows(xlsx([['a', '', 'c']])))
        with self.assertRaises(ProtocolError):
            xlsx_rows(b'<html>not a workbook</html>')


class PageReadTests(unittest.TestCase):
    def test_bpt_monitoring_filter_keys_instance_and_activities(self):
        bridge = FakeBridge(pages={('GET', SC + 'Process_Monitoring.aspx?Index=0'): fixture('bpt.html'),
                                   ('POST', SC + 'Process_Monitoring.aspx?Index=0'): fixture('bpt.html'),
                                   ('GET', SC + 'Process_Instance_Detail.aspx?ProcessId=501'): fixture('bpt-instance.html')})
        client = web_client(bridge)
        processes = client.bpt_processes('Orders', 'OrderApproval')
        self.assertEqual(('pk-1', 'mk-1'), (processes['rows'][0]['processKey'], processes['rows'][0]['moduleKey']))
        self.assertEqual(('42', 'OrderApproval'), (bridge.posts()[0][4]['wt4$wtEspace_Selector'], bridge.posts()[0][4]['wt4$wtProcessName']))
        instance = client.bpt_instance('501')
        self.assertEqual({'Status': 'Active', 'Tenant': 'Users', 'Last Modified': '2026-10-01 10:02'}, instance['summary'])
        self.assertEqual('77', instance['activities'][0]['activityId'])
        with self.assertRaises(ProtocolError):
            client.bpt_instance('../1')

    def test_integrations_come_from_the_module_page_not_recent_items(self):
        bridge = FakeBridge(pages={('GET', SC + 'eSpace_Edit.aspx?EspaceId=42'): fixture('module-integrations.html')})
        found = web_client(bridge).integrations('42')['integrations']
        self.assertEqual([('consumed-rest', '31', 'PaymentsAPI'), ('exposed-soap', '8', 'LegacySoap')],
                         [(i['kind'], i['id'], i['name']) for i in found])

    def test_one_named_property_stays_redacted_unless_asked_and_never_when_masked(self):
        def page(kind, value):
            return Page(f'https://{HOST}{SC}SiteProperty_Edit.aspx?Id=4', Document(
                f'<form method="post"><label for="v">Value</label><input id="v" name="wt$wtValue" type="{kind}" value="{value}">'
                '<input type="submit" name="s" value="Apply"></form>'))
        client = web_client(FakeBridge())
        client.detail = lambda *a: page('text', 'https://partner.example.test')
        self.assertEqual('<redacted>', client.property_value('3', 'PartnerUrl')['value'])
        self.assertEqual('https://partner.example.test', client.property_value('3', 'PartnerUrl', reveal=True)['value'])
        client.detail = lambda *a: page('password', 'masked-secret')
        shown = client.property_value('3', 'ApiKey', reveal=True)
        self.assertEqual(('<redacted>', True, False), (shown['value'], shown['secret'], shown['revealed']))


class PageWriteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.journal = Journal(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def execute(self, client, action, args, words='go'):
        return client.web_write(action, args, execute=True, words=words, operation_id=str(uuid.uuid4()), journal=self.journal)

    def test_a_page_write_prepares_then_posts_once_with_authorization_and_confirms_by_reading(self):
        bridge = FakeBridge()
        components = {'Orders', 'Billing_Core'}
        solution_pages(bridge, components)
        bridge.pages[('POST', SC + 'Solution_Edit.aspx?SolutionId=5')] = lambda form, accept: components.discard('Orders') or fixture('solution-edit.html')
        client = web_client(bridge)
        plan = client.web_write('solution-remove-component', {'solution': 'Billing', 'component': 'Orders'})
        self.assertEqual(False, plan['execute'])
        self.assertEqual([], bridge.posts())
        operation = str(uuid.uuid4())
        receipt = client.web_write('solution-remove-component', {'solution': 'Billing', 'component': 'Orders'}, execute=True,
                                   words='remove Orders from Billing', operation_id=operation, journal=self.journal)
        self.assertEqual('confirmed', receipt['state'])
        (_, _, _, _, form, _, write, sent_id, words_hash), = bridge.posts()
        self.assertEqual(('wt3$wtComponents$ctl02$wtRemove', ''), (form['__EVENTTARGET'], form['__EVENTARGUMENT']))
        self.assertEqual((True, operation, hashlib.sha256(b'remove Orders from Billing').hexdigest()), (write, sent_id, words_hash))
        again = client.web_write('solution-remove-component', {'solution': 'Billing', 'component': 'Orders'}, execute=True,
                                 words='remove Orders from Billing', operation_id=operation, journal=self.journal)
        self.assertTrue(again['existingReceipt'])
        self.assertEqual(1, len(bridge.posts()))
        self.assertNotIn('remove Orders from Billing', ''.join(p.read_text() for p in Path(self.temp.name).glob('*')))

    def test_remove_component_is_the_rows_own_postback(self):
        bridge = FakeBridge()
        components = {'Orders', 'Billing_Core'}
        solution_pages(bridge, components)
        def remove(form, accept):
            self.assertEqual('wt3$wtComponents$ctl02$wtRemove', form['__EVENTTARGET'])
            components.discard('Orders')
            return fixture('solution-edit.html')
        bridge.pages[('POST', SC + 'Solution_Edit.aspx?SolutionId=5')] = remove
        receipt = self.execute(web_client(bridge), 'solution-remove-component', {'solution': 'Billing', 'component': 'Orders'})
        self.assertEqual('confirmed', receipt['state'])
        self.assertIn('Remove component Orders', receipt['plan']['confirm'])

    def test_new_database_connection_sends_only_vault_references_for_its_login(self):
        created = []
        listing = lambda form, accept: fixture('db-connections.html').replace('</table>', ''.join(
            f'<tr><td><a href="DatabaseConnection_Edit.aspx?DBConnectionId=9">{n}</a></td><td>SQL Server</td></tr>' for n in created) + '</table>')
        def create(form, accept):
            created.append(form['wt5$wtConnection_Name'])
            return fixture('db-connections.html')
        pages = {('GET', SC + 'DatabaseConnections_List.aspx'): listing,
                 ('GET', SC + 'DatabaseConnection_Edit.aspx'): fixture('db-connection-new.html'),
                 ('POST', SC + 'DatabaseConnection_Edit.aspx'): create}
        args = {'connection': 'NewDb', 'dbms': 'SqlServer', 'server': 'sql.example.test', 'database': 'erp', 'parameters': {}}
        # A bridge that does not fill secretRefs would post the empty placeholders: refused before any reservation.
        old = FakeBridge(pages=pages)
        with self.assertRaises(BridgeError) as e:
            self.execute(web_client(old), 'db-connection-create', args)
        self.assertEqual('STUDIO_BRIDGE_OUTDATED', e.exception.code)
        self.assertEqual(([], []), (old.posts(), list(Path(self.temp.name).glob('*'))))
        bridge = FakeBridge(pages=pages, capabilities=('sc_web', 'sc_web:secretRefs'))
        client = web_client(bridge)
        plan = client.web_write('db-connection-create', args)
        target = 'SSAM/O11/test.example.com/DatabaseConnection/NewDb'
        self.assertEqual(('SQL Server', True, target, True), (plan['dbms'], plan['loginStored'], plan['loginTarget'], plan['secretRefsSupported']))
        receipt = self.execute(client, 'db-connection-create', args)
        self.assertEqual('confirmed', receipt['state'])
        index = bridge.calls.index(bridge.posts()[0])
        form = bridge.posts()[0][4]
        self.assertEqual(['NewDb', 'sql.example.test', 'erp', '', ''],
                         [form[k] for k in ('wt5$wtConnection_Name', 'wt5$ctl07$wtParam', 'wt5$ctl09$wtParam', 'wt5$ctl11$wtParam', 'wt5$ctl13$wtParam')])
        self.assertEqual([{'pointer': '/wt5$ctl11$wtParam', 'target': target, 'field': 'username'},
                          {'pointer': '/wt5$ctl13$wtParam', 'target': target, 'field': 'password'}], bridge.refs[index])
        with self.assertRaisesRegex(ProtocolError, 'Secrets never travel'):
            client.web_write('db-connection-create', dict(args, connection='Other', parameters={'Password': 'x'}))
        with self.assertRaisesRegex(ProtocolError, 'Secrets never travel'):
            client.web_write('db-connection-create', dict(args, connection='Other', parameters={'User name': 'x'}))

    def test_extension_mapping_is_osajax_change_then_apply_with_the_refreshed_state(self):
        mapped = []
        def extension(form, accept):
            html = fixture('extension-edit.html')
            return html.replace('<option value="3">', '<option value="3" selected>').replace('value="0" selected', 'value="0"') if mapped else html
        def post(form, accept):
            if '__AJAXEVENT' in form:
                self.assertEqual(('Change', '3'), (form['__AJAXEVENT'], form['wt7$wtOperations$ctl02$wtDBConnectionCombo']))
                return {'ok': True, 'status': 200, 'finalUrl': f'https://{HOST}{SC}Extension_Edit.aspx?ExtensionId=12',
                        'contentType': 'text/plain', 'html': '{"__OSVSTATE":"ext-state-2","html":""}'}
            self.assertEqual(('ext-state-2', '3', 'Apply'), (form['__OSVSTATE'], form['wt7$wtOperations$ctl02$wtDBConnectionCombo'], form['wt7$wtOperations_ApplyButton']))
            mapped.append(True)
            return fixture('extension-edit.html')
        bridge = FakeBridge(pages={('GET', SC + 'DatabaseConnections_List.aspx'): fixture('db-connections.html'),
                                   ('GET', SC + 'Extension_Edit.aspx?ExtensionId=12'): extension,
                                   ('POST', SC + 'Extension_Edit.aspx?ExtensionId=12'): post})
        receipt = self.execute(web_client(bridge), 'extension-db-connection', {'extensionId': '12', 'connection': 'LegacyERP'})
        self.assertEqual('confirmed', receipt['state'])
        # The OsAjax Change only stages the value (a read postback); Apply is the one write, sent once with its operationId.
        self.assertEqual([False, True], [p[6] for p in bridge.posts()])
        self.assertEqual(receipt['operationId'], bridge.posts()[1][7])

    def test_integration_log_level_reads_back(self):
        level = ['selected', '']
        bridge = FakeBridge(pages={('GET', SC + 'eSpace_Edit.aspx?EspaceId=42'): fixture('module-integrations.html'),
                                   ('GET', SC + 'eSpace_RestWebReference_Edit.aspx?RestWebreferenceId=31&EspaceId=42'):
                                       lambda f, a: fixture('integration-detail.html', DEFAULT=level[0], FULL=level[1])})
        def apply(form, accept):
            self.assertEqual('1', form['wt9$wtHttpTracingCombo'])
            level[:] = ['', 'selected']
            return '<p>ok</p>'
        bridge.pages[('POST', SC + 'eSpace_RestWebReference_Edit.aspx?RestWebreferenceId=31&EspaceId=42')] = apply
        client = web_client(bridge)
        plan = client.web_write('integration-log-level', {'moduleId': '42', 'integration': 'PaymentsAPI', 'level': 'Full'})
        self.assertEqual(('Default', True, 'consumed-rest'), (plan['currentLevel'], plan['changed'], plan['kind']))
        receipt = self.execute(client, 'integration-log-level', {'moduleId': '42', 'integration': 'PaymentsAPI', 'level': 'Full'})
        self.assertEqual(('confirmed', 'Full'), (receipt['state'], receipt['observedLevel']))

    def test_a_write_the_bridge_refuses_is_refused_and_one_it_loses_stays_uncertain(self):
        for error, state, locked in ((BridgeError('NOT_ALLOWED', 'outside allowlist', write=True), 'refused', False),
                                     (BridgeError('UNCERTAIN', 'lost after send', write=True), 'uncertain', True)):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as temp:
                bridge = FakeBridge()
                solution_pages(bridge, {'Orders', 'Billing_Core'})
                bridge.pages[('POST', SC + 'Solution_Edit.aspx?SolutionId=5')] = error
                receipt = web_client(bridge).web_write('solution-remove-component', {'solution': 'Billing', 'component': 'Orders'},
                                                       execute=True, words='go', operation_id=str(uuid.uuid4()), journal=Journal(temp))
                self.assertEqual(state, receipt['state'])
                self.assertEqual(locked, bool(list(Path(temp).glob('*.lock'))))


class StudioApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.journal = Journal(self.temp.name)
        self.modules = [{'Key': 'k-orders', 'Name': 'Orders'}, {'Key': 'k-billing', 'Name': 'Billing'}]
        self.bridge = FakeBridge(api={'ListEspaces': lambda a: list(self.modules), 'GetConsumers': [{'Name': 'Billing'}],
                                      'DeleteModule': self.delete})

    def tearDown(self):
        self.temp.cleanup()

    def delete(self, args):
        self.modules[:] = [m for m in self.modules if m['Key'] != args['moduleKey']]
        # The shape Anvil.Bridge ScApi projects for DeleteModule.
        return {'success': True, 'message': None}

    def run_main(self, *argv, host=HOST):
        return main([*argv, '--host', host], journal=self.journal, locate=lambda: self.bridge, present=lambda t: False,
                    running=lambda: False, opener=lambda *a: self.fail('no prompt with a Studio connected'), exports=self.temp.name)

    def deletes(self):
        return [c for c in self.bridge.calls if c[0] == 'api' and c[2] == 'DeleteModule']

    # CX15 r2 (L): module-delete and extension-delete do not run in this script (test_service_center_deletes.py); the
    # two-call delete of o11_service_center_write replaced them. Before, these tests sent the delete in one call.
    def test_module_and_extension_delete_do_not_run_here(self):
        for argv in (('module-delete', '--module', 'Orders'), ('module-delete', '--module', 'Orders', '--execute', '--operation-id', str(uuid.uuid4()),
                     '--words', 'delete module Orders on test', '--confirm-host', HOST),
                     ('extension-delete', '--module-key', 'k-orders', '--execute', '--operation-id', str(uuid.uuid4()), '--words', 'delete Orders test', '--confirm-host', HOST)):
            result = self.run_main(*argv)
        self.assertEqual(('DESTRUCTIVE_NEEDS_DEDICATED_TOOL', 'o11_service_center_write'), (result['code'], result['continuation']['tool']))
        self.assertEqual(([], []), (self.deletes(), list(Path(self.temp.name).glob('*'))))

    def test_solution_publish_sends_the_prepared_package_once_and_returns_its_job(self):
        osp = Path(self.temp.name) / 'Billing.osp'
        osp.write_bytes(b'PK\x03\x04solution')
        self.bridge.replies['PublishSolution'] = {'messages': [], 'solutionPublishId': 17, 'packUID': 'p', 'needsConfiguration': False}
        receipt = self.run_main('solution-publish', '--solution', 'Billing', '--osp-file', str(osp), '--execute',
                                '--operation-id', str(uuid.uuid4()), '--words', 'publish Billing on test', '--confirm-host', HOST)
        self.assertEqual(('accepted', 17, False), (receipt['state'], receipt['solutionPublishId'], receipt['executionCompleted']))
        self.assertEqual('solution-publish-status', receipt['continuation']['action'])
        call = next(c for c in self.bridge.calls if c[0] == 'api' and c[2] == 'PublishSolution')
        self.assertEqual({'file': str(osp), 'filename': 'Billing.osp'}, call[3])

    def test_apply_settings_and_database_association_use_their_surfaces(self):
        # apply-settings: the PUT the bridge sends itself, {status, body: StartApplySettingsServerResponse}.
        self.bridge.replies.update({'ListApplications': [{'Key': 'app-1', 'Name': 'Orders App'}],
                                    'apply-settings': {'status': 200, 'body': {'OperationId': 55, 'REST_Error': None}},
                                    'ListDatabases': [{'Id': 'db-2', 'Name': 'Main'}],
                                    'GetDatabaseByApplicationKey': lambda a: {'Id': 'db-2' if self.associated else 'db-1'},
                                    'AssociateAppWithDatabase': self.associate})
        self.associated = False
        settings = self.run_main('apply-settings', '--application', 'Orders App', '--execute', '--operation-id', str(uuid.uuid4()),
                                 '--words', 'apply settings test', '--confirm-host', HOST)
        self.assertEqual(('accepted', 55), (settings['state'], settings['applyId']))
        database = self.run_main('application-database-set', '--application-key', 'app-1', '--database-id', 'db-2', '--execute',
                                 '--operation-id', str(uuid.uuid4()), '--words', 'use db-2 test', '--confirm-host', HOST)
        self.assertEqual('confirmed', database['state'])
        surfaces = {c[2]: c[1] for c in self.bridge.calls if c[0] == 'api' and c[4]}
        self.assertEqual({'apply-settings': 'sc-rest', 'AssociateAppWithDatabase': 'server-api'}, surfaces)

    def associate(self, args):
        self.associated = True
        return {'associated': True}

    def test_api_writes_the_server_refused_are_rejected(self):
        self.bridge.replies.update({'DeleteModule': {'success': False, 'message': 'Module has consumers'},
                                    'ListApplications': [{'Key': 'app-1', 'Name': 'Orders App'}],
                                    'apply-settings': {'status': 200, 'body': {'OperationId': 0, 'REST_Error': {'ErrorMessage': 'Application is locked'}}}})
        # CX15 r2 (L): module-delete does not run here any more (DESTRUCTIVE_NEEDS_DEDICATED_TOOL); apply-settings stays.
        deleted = self.run_main('module-delete', '--module', 'Orders', '--execute', '--operation-id', str(uuid.uuid4()),
                                '--words', 'delete module Orders on test', '--confirm-host', HOST)
        self.assertEqual('DESTRUCTIVE_NEEDS_DEDICATED_TOOL', deleted['code'])
        settings = self.run_main('apply-settings', '--application-key', 'app-1', '--execute', '--operation-id', str(uuid.uuid4()),
                                 '--words', 'apply settings test', '--confirm-host', HOST)
        self.assertEqual(('rejected', 'Application is locked'), (settings['state'], settings['message']))
        self.assertFalse(list(Path(self.temp.name).glob('*.lock')))

    def test_verify_reconciles_an_uncertain_delete_by_reading_only(self):
        # CX15 r2 (L): no delete is sent here any more; an uncertain delete receipt written before (by the journal, as the
        # old one-call delete did) is still verified by reading only.
        def lost(args):
            self.delete(args)
            return BridgeError('UNCERTAIN', 'reply lost', write=True)
        self.bridge.replies['DeleteModule'] = lost
        operation = str(uuid.uuid4())
        plan = {'action': 'module-delete', 'moduleKey': 'k-orders', 'name': 'Orders'}
        with self.journal.reserve(operation, {'host': HOST, 'action': 'module-delete', 'target': 'Orders'}, 'delete Orders on test', plan) as receipt:
            receipt['plan'] = plan
            try:
                self.bridge.api(HOST, 'soap', 'DeleteModule', {'moduleKey': 'k-orders', 'moduleKind': 'eSpace'}, write=True, operation_id=operation)
            except BridgeError:
                receipt.update(state='uncertain', ok=False)
        self.assertEqual('uncertain', self.journal.lookup(operation)['state'])
        verified = self.run_main('verify', '--operation-id', operation)
        self.assertEqual((True, 'confirmed', False), (verified['observedDesiredState'], verified['state'], verified['replayed']))
        self.assertEqual(1, len(self.deletes()))
        self.assertFalse(list(Path(self.temp.name).glob('*.lock')))

    def test_reads_pass_named_arguments_and_redact_secrets(self):
        self.bridge.replies['ListCommits'] = {'returnValue': [{'Name': 'Orders', 'Password': 'p@ss', 'Note': 'Bearer abcdefghijkl'}]}
        result = self.run_main('commits', '--since', '2026-10-01T00:00:00Z')
        call = self.bridge.calls[-1]
        self.assertEqual(('ListCommits', {'eSpacesStartVersion': 0, 'extensionsStartVersion': 0, 'startDate': '2026-10-01T00:00:00Z'}, False),
                         (call[2], call[3], call[4]))
        self.assertNotIn('p@ss', json.dumps(result))
        self.assertNotIn('abcdefghijkl', json.dumps(result))
        self.assertEqual('studio', result['auth']['path'])
        modules = self.run_main('modules')
        self.assertEqual(['Orders', 'Billing'], [m['Name'] for m in modules['result']])


class StudioApiWriteTests(unittest.TestCase):
    """The bridge-ready writes this wave exposes: application delete (simulate, then the words name the application),
    module move / add to application, commit message and extension upload+publish."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.journal = Journal(Path(self.temp.name) / 'receipts')
        self.apps = [{'Key': 'app-1', 'Name': 'Sample Orders'}, {'Key': 'app-2', 'Name': 'Sample Shared'}]
        # The shapes Anvil.Bridge projects (ListEspaces: {key, name, applicationKey...}; ListVersions: ModuleInfo).
        self.modules = [{'key': 'k-orders', 'name': 'SampleOrders', 'applicationKey': 'app-1'},
                        {'key': 'k-scratch', 'name': 'ZZSampleScratch', 'applicationKey': 'app-2'}]
        self.extensions = [{'key': 'x-util', 'name': 'SampleUtilExt', 'applicationKey': 'app-2', 'versionId': 3203}]
        self.versions = [{'Version': 12, 'Version_Id': 5012, 'CommitMessage': 'Synthetic commit'}, {'Version': 11, 'Version_Id': 4990, 'CommitMessage': 'older'}]
        self.simulation = True
        self.bridge = FakeBridge(api={'ListApplications': lambda a: [dict(x) for x in self.apps], 'ListEspaces': lambda a: [dict(m) for m in self.modules],
                                      'ListExtensions': lambda a: [dict(x) for x in self.extensions], 'ListVersions': lambda a: [dict(v) for v in self.versions],
                                      'DeleteApplication': self.delete_app, 'MoveModuleBetweenApps': self.move, 'AddModuleToApplication': self.add,
                                      'ChangeCommitMessage': self.commit, 'UploadAndPublishExtension': self.upload})

    def tearDown(self):
        self.temp.cleanup()

    def delete_app(self, args):
        if args['simulate']:
            return {'success': self.simulation, 'simulated': True, 'messages': [{'Id': 'AppDeleteSimulation', 'Message': 'would delete', 'Type': 'Info'}],
                    'affectedApplications': ['Sample Orders'], 'deletedModules': ['ZZSampleScratch']}
        self.apps[:] = [x for x in self.apps if x['Key'] != args['appKey']]
        return {'success': True, 'simulated': False, 'messages': [], 'affectedApplications': ['Sample Orders'], 'deletedModules': ['ZZSampleScratch']}

    def relocate(self, key, application):
        for row in self.modules + self.extensions:
            if row['key'] == key:
                row['applicationKey'] = application
        return {'success': True, 'message': None}

    def move(self, args):
        self.relocate(args['moduleKey'], args['toAppKey'])
        # Live (11.42): a successful move answers an empty HEMessage whose default Type is Error.
        return {'success': True, 'message': {'Type': 'Error', 'MessageDefinition': {'Id': '', 'Message': '', 'Detail': '', 'Type': 'Error'}}}

    def add(self, args):
        return self.relocate(args['moduleKey'], args['appKey'])

    def commit(self, args):
        for row in self.versions:
            if row['Version_Id'] == args['eSpaceVersionId']:
                row['CommitMessage'] = args['newCommitMessage']
        return {'changed': True}

    def upload(self, args):
        self.extensions.append({'key': 'x-new', 'name': 'SampleNewExt', 'versionId': 3300})
        return {'messages': [], 'extensionId': 205, 'extensionVersionId': 3300}

    def run_main(self, *argv):
        return main([*argv, '--host', HOST], journal=self.journal, locate=lambda: self.bridge, present=lambda t: False,
                    running=lambda: False, opener=lambda *a: self.fail('no prompt with a Studio connected'), exports=self.temp.name)

    def execute(self, *argv, words):
        return self.run_main(*argv, '--execute', '--operation-id', str(uuid.uuid4()), '--words', words, '--confirm-host', HOST)

    def api_calls(self, operation):
        return [c for c in self.bridge.calls if c[0] == 'api' and c[2] == operation]

    # CX15 r2 (L): application-delete does not run in this script (test_service_center_deletes.py): not even its
    # simulation; o11_service_center_write previews it (the server's simulation) and executes it with the owner's count.
    def test_application_delete_does_not_run_here(self):
        for argv in (('application-delete', '--application', 'Sample Shared'),
                     ('application-delete', '--application-key', 'app-2', '--execute', '--operation-id', str(uuid.uuid4()), '--words', 'delete Sample Shared on test', '--confirm-host', HOST)):
            result = self.run_main(*argv)
        self.assertEqual(('DESTRUCTIVE_NEEDS_DEDICATED_TOOL', 'o11_service_center_write'), (result['code'], result['continuation']['tool']))
        self.assertEqual(([], False), (self.api_calls('DeleteApplication'), (Path(self.temp.name) / 'receipts').exists()))

    def test_module_move_and_add_resolve_keys_and_read_the_listing_back(self):
        moved = self.execute('module-move', '--module', 'ZZSampleScratch', '--to-application', 'Sample Orders', words='move ZZSampleScratch on test')
        self.assertEqual(('confirmed', 'app-1', None), (moved['state'], moved['observedApplicationKey'], moved['message']))
        self.assertEqual({'fromAppKey': 'app-2', 'toAppKey': 'app-1', 'moduleKind': 'eSpace', 'moduleKey': 'k-scratch'}, self.api_calls('MoveModuleBetweenApps')[0][3])
        with self.assertRaisesRegex(ProtocolError, 'already belongs'):
            self.run_main('module-move', '--module', 'ZZSampleScratch', '--to-application-key', 'app-1')
        added = self.execute('module-add-to-application', '--module', 'SampleUtilExt', '--module-kind', 'Extension', '--application', 'Sample Orders',
                             words='add SampleUtilExt on test')
        self.assertEqual('confirmed', added['state'])
        self.assertEqual({'appKey': 'app-1', 'moduleKind': 'Extension', 'moduleKey': 'x-util'}, self.api_calls('AddModuleToApplication')[0][3])

    def test_commit_message_targets_the_version_id_and_is_read_back(self):
        receipt = self.execute('commit-message-set', '--module', 'SampleOrders', '--version', '12', '--commit-message', 'Hotfix 12', words='reword on test')
        self.assertEqual(('confirmed', 5012, 'Synthetic commit'), (receipt['state'], receipt['plan']['versionId'], receipt['plan']['currentCommitMessage']))
        self.assertEqual({'eSpaceVersionId': 5012, 'newCommitMessage': 'Hotfix 12'}, self.api_calls('ChangeCommitMessage')[0][3])
        self.assertEqual({'eSpaceKey': 'k-orders'}, self.api_calls('ListVersions')[0][3])
        with self.assertRaisesRegex(ProtocolError, 'version 9'):
            self.run_main('commit-message-set', '--module', 'SampleOrders', '--version', '9', '--commit-message', 'x')

    def test_extension_publish_sends_the_prepared_xif_once(self):
        xif = Path(self.temp.name) / 'SampleNewExt.xif'
        xif.write_bytes(b'PK\x03\x04extension')
        plan = self.run_main('extension-publish', '--xif-file', str(xif), '--commit-message', 'v4', '--application', 'Sample Shared')
        self.assertEqual((hashlib.sha256(b'PK\x03\x04extension').hexdigest(), 'app-2'), (plan['xifSha256'], plan['applicationKey']))
        operation = str(uuid.uuid4())
        argv = ('extension-publish', '--xif-file', str(xif), '--commit-message', 'v4', '--application', 'Sample Shared', '--execute',
                '--operation-id', operation, '--words', 'publish SampleNewExt on test', '--confirm-host', HOST)
        receipt = self.run_main(*argv)
        self.assertEqual(('confirmed', 3300), (receipt['state'], receipt['extensionVersionId']))
        self.assertEqual({'file': str(xif), 'commitMessage': 'v4', 'applicationKey': 'app-2'}, self.api_calls('UploadAndPublishExtension')[0][3])
        self.assertTrue(self.run_main(*argv)['existingReceipt'])
        self.assertEqual(1, len(self.api_calls('UploadAndPublishExtension')))
        self.bridge.replies['UploadAndPublishExtension'] = {'messages': [{'Message': 'Compilation failed', 'Type': 'Error'}], 'extensionId': 0, 'extensionVersionId': 0}
        rejected = self.execute(*argv[:7], words='publish again on test')
        self.assertEqual(('rejected', ['Compilation failed']), (rejected['state'], rejected['errors']))
        with self.assertRaisesRegex(ProtocolError, 'xif'):
            self.run_main('extension-publish', '--xif-file', str(Path(self.temp.name) / 'x.zip'))


class ResolverTests(unittest.TestCase):
    def resolver(self, bridge=None, vault=False, running=False, **options):
        self.prompts = []
        return Resolver(HOST, locate=lambda: bridge, present=lambda target: vault, running=lambda: running,
                        opener=lambda host, kind, name=None: self.prompts.append((host, kind)) or {'opened': True, 'target': kind}, **options)

    def test_studio_first_then_its_web_window(self):
        self.assertEqual('studio', self.resolver(FakeBridge()).resolve('api').path)
        self.assertEqual(('studio-web', 'dev@example.test'), (lambda a: (a.path, a.user))(self.resolver(FakeBridge()).resolve('web')))
        with self.assertRaises(AuthRequired) as e:
            self.resolver(FakeBridge(web=False), vault=True).resolve('web')
        self.assertEqual(('WEB_SIGN_IN_REQUIRED', 'web-sign-in'), (e.exception.code, e.exception.continuation['action']))
        with self.assertRaises(AuthRequired) as e:
            self.resolver(FakeBridge(signed=False), vault=True).resolve('api')
        self.assertEqual(('STUDIO_NOT_SIGNED_IN', 'sign-in'), (e.exception.code, e.exception.continuation['action']))
        self.assertEqual([], self.prompts)

    HIDDEN = ('sc_api:soap', 'sc_web', 'sc_web:login')

    def test_a_hidden_login_bridge_signs_its_window_in_with_the_stored_login(self):
        bridge = FakeBridge(web=False, capabilities=self.HIDDEN)
        auth = self.resolver(bridge, vault=True).resolve('web')
        self.assertEqual(('studio-web', 'signed-in-hidden'), (auth.path, auth.attempts[-1]['outcome']))
        self.assertEqual(['login'], [c[1] for c in bridge.calls if c[0] == 'web'])
        self.assertEqual([], self.prompts)
        dry = FakeBridge(web=False, capabilities=self.HIDDEN)
        with self.assertRaises(AuthRequired) as e:
            self.resolver(dry, vault=True, login=False).resolve('web')
        self.assertEqual('WEB_SIGN_IN_REQUIRED', e.exception.code)
        self.assertEqual([], [c for c in dry.calls if c[0] == 'web'])

    def test_without_a_stored_login_the_prompt_opens_and_a_rejection_is_never_resubmitted(self):
        bridge = FakeBridge(web=False, capabilities=self.HIDDEN)
        with self.assertRaises(AuthRequired) as e:
            self.resolver(bridge).resolve('web')
        self.assertEqual(('CREDENTIAL_PROMPT_OPENED', 'SSAM/O11/test.example.com/ServiceCenter'), (e.exception.code, e.exception.auth['target']))
        self.assertEqual([(HOST, 'ServiceCenter')], self.prompts)
        self.assertEqual([], [c for c in bridge.calls if c[0] == 'web'])
        rejected = FakeBridge(web=False, capabilities=self.HIDDEN, login=BridgeError('WEB_LOGIN_REJECTED', 'rejected', submitted=True))
        with self.assertRaises(AuthRequired) as e:
            self.resolver(rejected, vault=True).resolve('web')
        self.assertEqual(('CREDENTIAL_PROMPT_OPENED', True), (e.exception.code, e.exception.auth.get('rejected')))
        self.assertEqual(1, len([c for c in rejected.calls if c[1] == 'login']))
        mfa = FakeBridge(web=False, capabilities=self.HIDDEN, login=BridgeError('WEB_SIGN_IN_INTERACTIVE', 'mfa', submitted=True))
        with self.assertRaises(AuthRequired) as e:
            self.resolver(mfa, vault=True).resolve('web')
        self.assertEqual(('WEB_SIGN_IN_INTERACTIVE', 'interactive'), (e.exception.code, e.exception.attempts[-1]['outcome']))
        self.assertEqual([], [c for c in mfa.calls if c[1] == 'open'])

    def test_vault_only_without_a_studio_and_the_prompt_only_without_both(self):
        self.assertEqual('vault', self.resolver(None, vault=True).resolve('web').path)
        with self.assertRaises(AuthRequired) as e:
            self.resolver(None).resolve('web')
        self.assertEqual(('CREDENTIAL_PROMPT_OPENED', 'prompt', 'SSAM/O11/test.example.com/ServiceCenter'),
                         (e.exception.code, e.exception.auth['path'], e.exception.auth['target']))
        self.assertEqual([(HOST, 'ServiceCenter')], self.prompts)
        self.assertEqual(['studio', 'vault', 'prompt'], [a['path'] for a in e.exception.attempts])

    def test_no_prompt_while_a_studio_is_open_or_when_it_cannot_help(self):
        cases = [(dict(bridge=None, running=True), 'web', 'STUDIO_NOT_CONNECTED'),
                 (dict(bridge=FakeBridge(verbs=('ping',))), 'web', 'STUDIO_BRIDGE_OUTDATED'),
                 (dict(bridge=None), 'api', 'STUDIO_REQUIRED'),
                 (dict(bridge=None, prompt='never'), 'web', 'AUTH_REQUIRED')]
        for options, need, code in cases:
            with self.subTest(code=code), self.assertRaises(AuthRequired) as e:
                self.resolver(**options).resolve(need)
            self.assertEqual(code, e.exception.code)
            self.assertEqual([], self.prompts)
        self.assertEqual('vault', self.resolver(FakeBridge(verbs=('ping',)), vault=True).resolve('web').path)

    def test_lifetime_uses_its_own_token_entry(self):
        with self.assertRaises(AuthRequired) as e:
            self.resolver(FakeBridge()).resolve('lifetime')
        self.assertEqual('SSAM/O11/test.example.com/LifeTime', e.exception.auth['target'])
        self.assertEqual([(HOST, 'LifeTime')], self.prompts)

    def test_explicit_vault_session_skips_the_studio(self):
        bridge = FakeBridge()
        self.assertEqual('vault', self.resolver(bridge, vault=True, session='vault').resolve('web').path)
        self.assertEqual([], bridge.calls)


class PromptTests(unittest.TestCase):
    def test_prompt_window_is_detached_and_nothing_is_read_back(self):
        launched = []

        class Process:
            pid = 31337
        def popen(argv, **kwargs):
            launched.append((argv, kwargs))
            return Process()
        with tempfile.TemporaryDirectory() as temp:
            first = open_prompt(HOST, 'DatabaseConnection', 'LegacyERP', state=temp, popen=popen)
            second = open_prompt(HOST, 'DatabaseConnection', 'LegacyERP', state=temp, popen=popen)
            marker = next((Path(temp) / 'auth' / 'prompts').glob('*.json')).read_text()
        self.assertEqual((True, True), (first['opened'], second['alreadyOpen']))
        self.assertEqual(1, len(launched))
        argv, kwargs = launched[0]
        self.assertEqual(['-Mode', 'bootstrap', '-Kind', 'DatabaseConnection', '-HostName', HOST, '-Name', 'LegacyERP'], argv[4:])
        self.assertTrue(argv[3].endswith('windows-o11-credential.ps1'))
        self.assertEqual((subprocess.DEVNULL, subprocess.DEVNULL, subprocess.DEVNULL), (kwargs['stdin'], kwargs['stdout'], kwargs['stderr']))
        self.assertEqual(getattr(subprocess, 'CREATE_NEW_CONSOLE', 0), kwargs['creationflags'])
        self.assertEqual({'target', 'pid', 'openedAt'}, set(json.loads(marker)))
        with self.assertRaises(ProtocolError):
            open_prompt(HOST, 'DatabaseConnection', '../x', state='unused', popen=popen)

    def test_the_prompt_script_never_writes_the_secret(self):
        script = (Path(auth_module.__file__).with_name('windows-o11-credential.ps1')).read_text(encoding='utf-8')
        self.assertIn("ValidateSet('status','bootstrap')", script)  # no mode prints a stored value
        outputs = [line for line in script.splitlines() if 'ConvertTo-Json' in line or 'Write-' in line or 'Console]::' in line]
        self.assertTrue(outputs)
        for line in outputs:
            self.assertNotRegex(line, r'\$plain|Password|GetNetworkCredential|CredentialBlob')
        self.assertIn('ZeroFreeCoTaskMemUnicode', script)


class SessionAndGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.prompts = []

    def tearDown(self):
        self.temp.cleanup()

    def run_main(self, *argv, bridge=None, vault=False, running=False):
        return main(list(argv), journal=Journal(self.temp.name), locate=lambda: bridge, present=lambda t: vault, running=lambda: running,
                    opener=lambda host, kind, name=None: self.prompts.append((host, kind)) or {'opened': True}, exports=self.temp.name)

    def test_status_reports_the_path_each_kind_of_call_would_use(self):
        status = self.run_main('session-status', '--host', HOST, bridge=FakeBridge(web=False))
        self.assertEqual({'api': 'studio', 'web': 'WEB_SIGN_IN_REQUIRED'}, status['wouldUse'])
        self.assertEqual(('corporate', True, {'ServiceCenter': False, 'LifeTime': False}),
                         (status['hostClass'], status['studio']['serviceCenterVerbs'], status['vault']))
        self.assertEqual([], self.prompts)

    def test_sign_in_opens_the_studios_dialog_or_the_private_prompt_without_a_studio(self):
        bridge = FakeBridge(signed=False)
        self.assertEqual('opened', self.run_main('session-sign-in', '--host', HOST, bridge=bridge)['dialog'])
        self.assertIn(('login', HOST), bridge.calls)
        opened = self.run_main('session-sign-in', '--host', HOST)
        self.assertEqual(('CREDENTIAL_PROMPT_OPENED', [(HOST, 'ServiceCenter')]), (opened['code'], self.prompts))
        with self.assertRaises(AuthRequired) as e:
            self.run_main('session-sign-in', '--host', HOST, running=True)
        self.assertEqual('STUDIO_NOT_CONNECTED', e.exception.code)
        self.assertEqual(1, len(self.prompts))
        self.run_main('session-sign-in', '--host', HOST, '--surface', 'lifetime')
        self.assertEqual((HOST, 'LifeTime'), self.prompts[-1])

    def test_web_sign_in_opens_the_studios_service_center_window(self):
        bridge = FakeBridge(web=False)
        self.assertEqual('opened', self.run_main('session-web-sign-in', '--host', HOST, bridge=bridge)['window'])
        self.assertEqual(('web', 'open'), bridge.calls[-1][:2])

    def test_corporate_hosts_need_confirmation_and_words_naming_them_before_any_call(self):
        bridge = FakeBridge()
        for extra in ([], ['--confirm-host', HOST], ['--confirm-host', 'other.example.com']):
            with self.subTest(extra=extra), self.assertRaisesRegex(ProtocolError, 'corporate'):
                self.run_main('timer-run', '--host', HOST, '--module-id', '3', '--name', 'W', '--execute', '--operation-id',
                              str(uuid.uuid4()), '--words', 'run W', *extra, bridge=bridge)
        self.assertEqual([], bridge.calls)
        self.assertEqual('corporate', guard_write(HOST, 'run W on test', HOST))
        self.assertEqual('personal', guard_write(PERSONAL, 'run W'))

    def test_connection_delete_does_not_run_here(self):
        # CX15 r2 (L): db-connection-delete does not run in this script; o11_service_center_write previews and executes it.
        bridge = FakeBridge()
        for argv in (('db-connection-delete', '--host', HOST, '--connection', 'LegacyERP'),
                     ('db-connection-delete', '--host', HOST, '--connection', 'LegacyERP', '--confirm-host', HOST, '--execute', '--operation-id', str(uuid.uuid4()), '--words', 'delete LegacyERP on test')):
            result = self.run_main(*argv, bridge=bridge)
        self.assertEqual(('DESTRUCTIVE_NEEDS_DEDICATED_TOOL', 'o11_service_center_write'), (result['code'], result['continuation']['tool']))
        self.assertEqual([], bridge.calls)

    def test_new_connection_without_a_stored_login_opens_its_prompt_before_any_reservation(self):
        argv = ('db-connection-create', '--host', HOST, '--connection', 'NewDb', '--db-server', 'sql', '--execute',
                '--operation-id', str(uuid.uuid4()), '--words', 'create NewDb on test', '--confirm-host', HOST)
        # A bridge without sc_web:secretRefs cannot carry the login: refused, and no prompt is opened for nothing.
        with self.assertRaises(BridgeError) as e:
            self.run_main(*argv, bridge=FakeBridge())
        self.assertEqual(('STUDIO_BRIDGE_OUTDATED', []), (e.exception.code, self.prompts))
        bridge = FakeBridge(capabilities=('sc_web', 'sc_web:secretRefs'))
        with self.assertRaises(AuthRequired) as e:
            self.run_main(*argv, bridge=bridge)
        self.assertEqual(('CREDENTIAL_PROMPT_OPENED', 'SSAM/O11/test.example.com/DatabaseConnection/NewDb'), (e.exception.code, e.exception.auth['target']))
        self.assertEqual([(HOST, 'DatabaseConnection')], self.prompts)
        self.assertEqual(([], []), ([c for c in bridge.calls if c[0] == 'web'], list(Path(self.temp.name).glob('*.json'))))

    def test_secret_writes_are_refused_without_a_studio(self):
        # The vault path (direct HTTPS from this process) never holds a database login or a secret property value.
        with self.assertRaises(BridgeError) as e:
            self.run_main('db-connection-test', '--host', HOST, '--connection', 'LegacyERP', '--execute', '--operation-id', str(uuid.uuid4()),
                          '--words', 'test LegacyERP on test', '--confirm-host', HOST, vault=True)
        self.assertEqual('STUDIO_REQUIRED', e.exception.code)
        self.assertEqual(([], []), (self.prompts, list(Path(self.temp.name).glob('*.json'))))
        with self.assertRaisesRegex(ProtocolError, 'SiteProperty'):
            self.run_main('property-set', '--host', HOST, '--module-id', '3', '--name', 'Token', '--value-vault', 'SSAM/O11/other.example.com/SiteProperty/Token',
                          bridge=FakeBridge(capabilities=('sc_web', 'sc_web:secretRefs')))

    def test_solution_download_keeps_the_package_locally(self):
        bridge = FakeBridge()
        solution_pages(bridge, {'Orders'})
        bridge.pages[('POST', SC + 'Solution_Edit.aspx?SolutionId=5')] = lambda f, a: b'PK\x03\x04osp' if a == 'binary' and f.get('wt3$wtDownloadButton') == 'Download' else '<p/>'
        result = self.run_main('solution-download', '--host', HOST, '--solution', 'Billing', bridge=bridge)
        self.assertEqual((hashlib.sha256(b'PK\x03\x04osp').hexdigest(), 7), (result['sha256'], result['size']))
        self.assertTrue(Path(result['file']).name.startswith('Billing-'))
        self.assertFalse(bridge.posts()[0][6], 'a download is a read')

    def test_reads_refuse_write_arguments_and_reveal_is_property_value_only(self):
        with self.assertRaises(ProtocolError):
            self.run_main('logs', '--host', HOST, '--words', 'x')
        with self.assertRaises(ProtocolError):
            self.run_main('logs', '--host', HOST, '--reveal')


class BridgeClientTests(unittest.TestCase):
    """StudioBridge over a real loopback JSON-lines server shaped like Anvil.Bridge."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.key = Path(self.temp.name) / 'bridge.key'
        self.key.write_text('k3y', encoding='ascii')
        self.seen = []
        seen = self.seen

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                request = json.loads(self.rfile.readline())
                seen.append(request)
                method, params = request['method'], request.get('params') or {}
                if method == 'ping':
                    reply = {'success': True, 'data': {'bridge': 'anvil', 'pid': 99, 'version': '2.0'}}
                elif request.get('authorization') != 'k3y':
                    reply = {'success': False, 'data': None, 'error': 'UnauthorizedAccessException: trusted controller', 'executed': False}
                elif method == 'sc_api' and params['operation'] == 'DeleteModule':
                    return  # the connection drops after the write arrived
                elif method == 'sc_api':
                    reply = {'success': True, 'data': {'ok': True, 'source': 'studio', 'host': params['host'], 'user': 'dev', 'elapsedMs': 2,
                                                       'result': [{'Name': 'A', 'Token': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl'}]}}
                elif method == 'sc_session':
                    reply = {'success': True, 'data': {'ok': False, 'code': 'STUDIO_NOT_SIGNED_IN', 'message': 'no login; password=hunter2'}}
                elif method == 'sc_web' and params.get('secretRefs'):
                    # ScSecrets.cs NotFound: the target and part, never a value; nothing left the Studio.
                    ref = params['secretRefs'][0]
                    reply = {'success': False, 'data': {'ok': False, 'code': 'SECRET_NOT_FOUND', 'executed': False, 'target': ref['target'], 'part': ref['field'],
                                                        'gate': 'secret_not_found', 'message': f"secretRef target {ref['target']}: the Windows vault of this user has no such entry"},
                             'error': 'SECRET_NOT_FOUND: no such entry', 'code': 'SECRET_NOT_FOUND', 'executed': False}
                elif method == 'sc_web' and params['action'] == 'fetch':
                    # The sc-bridge envelope: the contract answer in data also on failure, executed:false when nothing left.
                    reply = {'success': False, 'data': {'ok': False, 'code': 'WEB_SIGN_IN_REQUIRED', 'message': 'window not signed in'},
                             'error': 'WEB_SIGN_IN_REQUIRED: window not signed in', 'code': 'WEB_SIGN_IN_REQUIRED', 'executed': False}
                else:
                    reply = {'success': False, 'data': None, 'error': 'Unknown method: ' + method}
                self.wfile.write((json.dumps(reply) + '\n').encode())

        self.server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def test_contract_replies_errors_and_redaction(self):
        bridge = StudioBridge(self.port, self.key, timeout=5)
        self.assertEqual(99, bridge.ping()['pid'])
        self.assertNotIn('authorization', self.seen[-1])
        reply = bridge.api(HOST, 'soap', 'ListApplications', {'withIcons': False})
        self.assertEqual('k3y', self.seen[-1]['authorization'])
        self.assertEqual({'host': HOST, 'surface': 'soap', 'operation': 'ListApplications', 'args': {'withIcons': False}}, self.seen[-1]['params'])
        self.assertEqual('<redacted>', redact(reply['result'])[0]['Token'])
        with self.assertRaises(BridgeError) as e:
            bridge.session(HOST)
        self.assertEqual('STUDIO_NOT_SIGNED_IN', e.exception.code)
        self.assertNotIn('hunter2', str(e.exception))
        with self.assertRaises(BridgeError) as e:
            bridge.web(HOST, 'status')
        self.assertEqual('STUDIO_BRIDGE_OUTDATED', e.exception.code)
        with self.assertRaises(BridgeError) as e:
            bridge.web(HOST, 'fetch', method='POST', path=SC + 'X.aspx', form={'a': '1'}, write=True,
                       operation_id=str(uuid.uuid4()), authorize_sha256='d' * 64)
        self.assertEqual(('WEB_SIGN_IN_REQUIRED', False, True), (e.exception.code, e.exception.extra['executed'], e.exception.extra['write']))
        operation = str(uuid.uuid4())
        with self.assertRaises(BridgeError) as e:
            bridge.api(HOST, 'soap', 'DeleteModule', {'moduleKey': 'k'}, write=True, operation_id=operation, authorize_sha256='b' * 64)
        self.assertEqual(('UNCERTAIN', True), (e.exception.code, e.exception.extra['write']))
        self.assertEqual({'write': True, 'operationId': operation, 'authorizeSha256': 'b' * 64},
                         {k: self.seen[-1]['params'][k] for k in ('write', 'operationId', 'authorizeSha256')})
        with self.assertRaises(BridgeError) as e:
            bridge.api(HOST, 'soap', 'DeleteModule', {}, write=True, operation_id='not-a-uuid', authorize_sha256='b' * 64)
        self.assertEqual('BAD_REQUEST', e.exception.code)

    def test_a_missing_vault_entry_is_secret_not_found_and_refuses_the_receipt(self):
        target = f'SSAM/O11/{HOST}/DatabaseConnection/Sales'
        bridge = StudioBridge(self.port, self.key, timeout=5)
        with self.assertRaises(BridgeError) as e:
            bridge.web(HOST, 'fetch', method='POST', path=SC + 'DatabaseConnection_Edit.aspx', form={'u': '', 'p': ''}, write=True,
                       operation_id=str(uuid.uuid4()), authorize_sha256='d' * 64,
                       secret_refs=[{'pointer': '/u', 'target': target, 'field': 'username'}, {'pointer': '/p', 'target': target, 'field': 'password'}])
        self.assertEqual([{'pointer': '/u', 'target': target, 'field': 'username'}, {'pointer': '/p', 'target': target, 'field': 'password'}],
                         self.seen[-1]['params']['secretRefs'])
        self.assertEqual(('SECRET_NOT_FOUND', False, target, 'username'),
                         (e.exception.code, e.exception.extra['executed'], e.exception.extra['target'], e.exception.extra['part']))
        failure = bridge_failure(e.exception, {})
        self.assertEqual(('refused', target), (failure['state'], failure['target']))
        self.assertIn('new operationId', failure['continuation'])

    def test_wrong_authority_is_not_executed(self):
        self.key.write_text('other', encoding='ascii')
        with self.assertRaises(BridgeError) as e:
            StudioBridge(self.port, self.key, timeout=5).api(HOST, 'soap', 'ListApplications')
        self.assertEqual('NOT_ALLOWED', e.exception.code)

    def test_locate_follows_the_connection_record_and_refuses_another_studio(self):
        root = Path(self.temp.name)
        record = root / '.local' / 'connections' / 'ss4.json'
        record.parent.mkdir(parents=True)
        def write(pid, port):
            record.write_text(json.dumps({'ok': True, 'lane': 'o11', 'anvilLane': 'ss4', 'pid': pid, 'port': port, 'authorityDir': str(root)}))
        write(99, self.port)
        bridge = StudioBridge.locate(root, 'ss4', timeout=5)
        self.assertEqual((99, self.key), (bridge.pid, bridge.key_file))
        write(98, self.port)
        with self.assertRaises(BridgeError) as e:
            StudioBridge.locate(root, 'ss4', timeout=5)
        self.assertEqual('STUDIO_NOT_CONNECTED', e.exception.code)
        closed = socketserver.TCPServer(('127.0.0.1', 0), socketserver.BaseRequestHandler)
        port = closed.server_address[1]
        closed.server_close()
        write(99, port)
        self.assertIsNone(StudioBridge.locate(root, 'ss4', timeout=5))


class BridgeAgreementTests(unittest.TestCase):
    """The facade calls only what Anvil.Bridge implements (kernel/src/Anvil.Bridge), read from its source."""
    SOURCE = Path(__file__).resolve().parents[1] / 'src' / 'Anvil.Bridge'

    def tables(self):
        text = (self.SOURCE / 'ScOperations.cs').read_text(encoding='utf-8')
        parts = re.split(r'IReadOnlyDictionary<string, ScOp<Sc(\w+)Send>> (\w+) =', text)
        names = {table: set(re.findall(r'^\s*\["([\w-]+)"\] =', body, re.M)) for _, table, body in zip(parts[1::3], parts[2::3], parts[3::3])}
        return {'soap': names['SoapOperations'], 'server-api': names['ServerApiOperations'], 'sc-rest': names['RestOperations']}

    FACADE = Path(__file__).resolve().parents[1] / 'scripts' / 'service_center' / 'studio_api.py'

    def bridge_args(self):
        """op -> the argument names its Prepare reads (a.Key("..."), a.Text("..."), a.Bool("...")...)."""
        text = (self.SOURCE / 'ScOperations.cs').read_text(encoding='utf-8')
        found = {}
        for match in re.finditer(r'^\s*\["([\w-]+)"\] = (.*?)(?=^\s*\["[\w-]+"\] =|^\s*\};)', text, re.M | re.S):
            found[match.group(1)] = set(re.findall(r'\ba\.(?:Key|Text|Int|Bool|Raw|Bytes|OneOf|OptionalObjectKey|Date|Path)\("(\w+)"', match.group(2)))
        return found

    def facade_calls(self):
        """(surface, operation, argument names) of every literal call the facade makes through the bridge."""
        source = self.FACADE.read_text(encoding='utf-8')
        return [(s, o, set(re.findall(r"'(\w+)':", args))) for s, o, args in
                re.findall(r"self\.(?:_send|call)\('([\w-]+)', '([\w-]+)', \{(.*?)\}", source, re.S)]

    def test_every_operation_the_facade_sends_is_in_the_bridge_allowlist(self):
        tables = self.tables()
        sent = {(surface, operation) for surface, operation, _ in studio_api.READS.values()}
        source = self.FACADE.read_text(encoding='utf-8')
        sent |= set(re.findall(r"self\.(?:_send|call)\('([\w-]+)', '([\w-]+)'", source))
        # This wave's writes, named explicitly so that removing one from the bridge fails here.
        sent |= {('soap', 'DeleteApplication'), ('soap', 'MoveModuleBetweenApps'), ('soap', 'AddModuleToApplication'),
                 ('soap', 'ChangeCommitMessage'), ('soap', 'UploadAndPublishExtension'), ('soap', 'ListVersions'),
                 ('soap', 'DeleteModule'), ('soap', 'PublishSolution'), ('sc-rest', 'apply-settings'), ('server-api', 'AssociateAppWithDatabase')}
        missing = sorted(f'{s}:{o}' for s, o in sent if o not in tables[s])
        self.assertEqual([], missing)

    def test_the_arguments_the_facade_sends_are_the_ones_the_bridge_reads(self):
        reads = self.bridge_args()
        for surface, operation, names in self.facade_calls():
            with self.subTest(operation=operation):
                self.assertLessEqual(names, reads[operation] | {'outFile'})
        args = {'application_key': 'k', 'module_key': 'k', 'element_key': '', 'since': '2026-10-01T00:00:00Z', 'solution': 's',
                'publish_id': '1', 'last_message_id': '0', 'apply_id': '1'}
        for action, (surface, operation, build) in studio_api.READS.items():
            with self.subTest(action=action):
                self.assertLessEqual(set(build(type('A', (), args)())), reads[operation] | {'outFile'})
        # UploadAndPublishExtension's arguments are built in a dict variable: the bridge reads file, commitMessage, applicationKey.
        self.assertEqual({'file', 'commitMessage', 'applicationKey'}, reads['UploadAndPublishExtension'])
        self.assertEqual({'appKey', 'simulate'}, reads['DeleteApplication'])

    def test_verbs_and_web_accepts_match(self):
        dispatch = (self.SOURCE / 'Dispatch.cs').read_text(encoding='utf-8')
        for verb in VERBS:
            self.assertIn(f'"{verb}" => await', dispatch)
        protocol = (self.SOURCE / 'ScProtocol.cs').read_text(encoding='utf-8')
        self.assertIn('accept is not ("html" or "xlsx" or "binary")', protocol)

    def test_secret_refs_agree_once_the_bridge_has_them(self):
        from service_center.http import SECRET_CAPABILITY
        sources = ''.join(p.read_text(encoding='utf-8') for p in self.SOURCE.glob('*.cs'))
        if 'secretRefs' not in sources:
            self.skipTest('this branch\'s Anvil.Bridge does not fill sc_web secretRefs yet (CONTRATO, o11-facade section); '
                          'the facade refuses those writes until the bridge announces ' + SECRET_CAPABILITY)
        self.assertIn(f'"{SECRET_CAPABILITY}"', sources)
        for name in ('pointer', 'target', 'field'):
            self.assertIn(f'"{name}"', sources)
        # The facade's pointer is RFC 6901 into the flat form (json_pointer); the bridge decodes it to the field name.
        from service_center.bridge import CODES
        from service_center.http import NOT_SENT, json_pointer
        secrets = (self.SOURCE / 'ScSecrets.cs').read_text(encoding='utf-8')
        self.assertEqual('/wt9$a~1b~0c', json_pointer('wt9$a/b~c'))
        self.assertIn('.Replace("~1", "/").Replace("~0", "~")', secrets)
        # The facade's targets are entries the bridge accepts, never the environment logins it refuses.
        logins = set(re.findall(r'"(\w+)"', re.search(r'Logins = \[(.*?)\];', secrets).group(1)))
        self.assertEqual({'ServiceCenter', 'ServiceStudio', 'LifeTime'}, logins)
        self.assertFalse({'DatabaseConnection', 'SiteProperty'} & logins)
        # A database login is two refs (username, password): within the bridge's limit.
        self.assertGreaterEqual(int(re.search(r'public const int Limit = (\d+);', secrets).group(1)), 2)
        # The bridge's own refusal code keeps its name and counts as nothing sent.
        self.assertIn('SecretNotFound = "SECRET_NOT_FOUND"', (self.SOURCE / 'ScProtocol.cs').read_text(encoding='utf-8'))
        self.assertIn('SECRET_NOT_FOUND', CODES)
        self.assertIn('SECRET_NOT_FOUND', NOT_SENT)


if __name__ == '__main__':
    unittest.main()
