"""Synthetic protocol fixtures; no customer HTML, credentials or live mutations."""
import io
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from service_center.http import BridgeError, Document, Page, ProtocolError, Transport, Vault, button, form_fields
from service_center.client import Client, Journal, tables
from o11_service_center import main

HOST = 'test.example.com'
BASE = f'https://{HOST}/ServiceCenter/'
LOGIN = '''<form method="post" action="Login.aspx"><input type="hidden" name="__OSVSTATE" value="state">
<input name="user"><input type="password" name="pass"><input type="submit" name="login" value="Log in"></form>'''


def page(html, path='Home.aspx'):
    return Page(BASE + path, Document(html))


def detail(action='Run Now', value='old'):
    return page(f'''<form method="post" action="Timer_Edit.aspx?id=7"><input type="hidden" name="state" value="opaque">
<label for="v">Value</label><textarea id="v" name="Input_Value">{value}</textarea>
<input type="submit" name="operation" value="{action}"></form>''', 'Timer_Edit.aspx?id=7')


class FakeVault:
    host = HOST
    reads = 0

    def login_fields(self, user, password):
        self.reads += 1
        return {user: 'test-user', password: 'private-test-password'}


class FakeTransport(Transport):
    secrets = False

    def __init__(self, pages):
        super().__init__(HOST)
        self.pages = list(pages)
        self.requests = []
        self.refs = []

    def secrets_supported(self):
        return self.secrets

    def request(self, url, fields=None, secret_refs=None):
        self.requests.append((self.url(url), dict(fields or [])))
        self.refs.append(secret_refs)
        response = self.pages.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class Operations(Client):
    def __init__(self, action='Run Now', response=None, after=None):
        self.transport = FakeTransport([response or page('<div class="Feedback_Message_Success">Scheduled</div>')])
        super().__init__(FakeVault(), self.transport)
        self.before, self.after = detail(action), after
        self.reads = 0

    def detail(self, *args):
        self.reads += 1
        return self.after if self.reads > 1 and self.after is not None else self.before


class ServiceCenterTests(unittest.TestCase):
    def test_same_origin_and_path_before_any_request(self):
        t = Transport(HOST)
        for url in ['https://evil.test/ServiceCenter/Login.aspx', 'http://' + HOST + '/ServiceCenter/',
                    '../Users/Login.aspx', '/ServiceCenter/%2e%2e/Users/', 'https://user@' + HOST + '/ServiceCenter/',
                    BASE+'../Users/Login.aspx',
                    'https://' + HOST + ':443/ServiceCenter/', '//evil.test/ServiceCenter/']:
            with self.subTest(url=url), self.assertRaises(ProtocolError):
                t.url(url)

    def test_vault_does_not_fallback_to_another_host(self):
        for target in ['SSAM/O11/evil.test/ServiceCenter', 'SSAM/ODC/test/Portal', 'any']:
            with self.assertRaises(ProtocolError):
                Vault(HOST, target)
        self.assertEqual(Vault(HOST).target, f'SSAM/O11/{HOST}/ServiceCenter')

    def test_login_uses_hidden_state_and_only_one_attempt(self):
        transport = FakeTransport([page(LOGIN, 'Login.aspx'), page('<a href="Logout.aspx">Log out</a>')])
        vault = FakeVault()
        client = Client(vault, transport)
        client.login(); client.login()
        self.assertEqual(1, vault.reads)
        self.assertEqual(2, len(transport.requests))
        self.assertEqual({'__OSVSTATE': 'state', 'user': 'test-user', 'pass': 'private-test-password', 'login': 'Log in'}, transport.requests[1][1])

    def test_bad_login_fails_without_server_feedback_or_secret(self):
        t = FakeTransport([page(LOGIN, 'Login.aspx'), page(LOGIN + '<span class="ValidationMessage">private-test-password</span>', 'Login.aspx')])
        with self.assertRaises(ProtocolError) as e:
            Client(FakeVault(), t).login()
        self.assertNotIn('private-test-password', str(e.exception))
        self.assertEqual(2, len(t.requests))

    def test_logout_marker_is_required(self):
        t = FakeTransport([page(LOGIN, 'Login.aspx'), page('<p>Unexpected identity provider</p>')])
        with self.assertRaisesRegex(ProtocolError, 'confirm'):
            Client(FakeVault(), t).login()

    def test_an_expired_session_answering_the_login_form_in_place_is_never_read(self):
        t = FakeTransport([page(LOGIN, 'Login.aspx'), page('<a href="Logout.aspx">Log out</a>'), page(LOGIN, 'Error_Logs.aspx')])
        with self.assertRaisesRegex(ProtocolError, 'session expired'):
            Client(FakeVault(), t).get('Error_Logs.aspx')

    def test_form_preserves_unicode_and_whitespace_but_not_other_buttons(self):
        d = detail('Save', '  a\n b &amp; ç  ')
        fields = dict(form_fields(next(d.doc.all('form')), button(d, ('Save',))))
        self.assertEqual('  a\n b & ç  ', fields['Input_Value'])
        self.assertEqual('opaque', fields['state'])
        self.assertEqual('Save', fields['operation'])

    def test_unknown_scripted_form_fails_before_post(self):
        d = page('<form method="post"><input type="submit" name="go" value="Save" onclick="OsAjax(event)"></form>')
        t = FakeTransport([])
        with self.assertRaisesRegex(ProtocolError, 'scripted'):
            t.submit(d, button(d, ('Save',)))
        self.assertEqual([], t.requests)

    def test_external_form_action_is_refused(self):
        d = page('<form method="post" action="https://evil.test/"><input type="submit" name="go" value="Save"></form>')
        t = FakeTransport([])
        with self.assertRaises(ProtocolError):
            t.submit(d, button(d, ('Save',)))
        self.assertEqual([], t.requests)

    def test_site_property_values_redacted_in_listing(self):
        d = page('<table><tr><th>Name</th><th>Default Value</th><th>Effective Value</th></tr><tr><td>Token</td><td>abc-secret</td><td>def-secret</td></tr></table>')
        encoded = json.dumps(tables(d, True))
        self.assertNotIn('secret', encoded)
        self.assertIn('Token', encoded)

    def test_log_rows_headers_entities_and_pagination(self):
        first = page('<table><tr><th>Message</th></tr><tr><td>Error &amp; detail</td></tr></table><a rel="next" href="Error_Logs.aspx?p=2">Next</a>', 'Error_Logs.aspx')
        second = page('<table><tr><th>Message</th></tr><tr><td>Second</td></tr></table>', 'Error_Logs.aspx?p=2')
        t = FakeTransport([second]); c = Client(FakeVault(), t); c.authenticated = True
        result = c.pages(first, 10)
        self.assertEqual(['Error & detail', 'Second'], [r['fields']['Message'] for r in result['rows']])
        self.assertFalse(result['truncated'])

    def test_limit_reports_truncation_and_does_not_fetch_next(self):
        d = page('<table><tr><th>M</th></tr><tr><td>1</td></tr></table><a rel="next" href="Next.aspx">Next</a>')
        t = FakeTransport([]); c = Client(FakeVault(), t)
        self.assertTrue(c.pages(d, 1)['truncated'])
        self.assertEqual([], t.requests)

    def test_duplicate_target_or_incomplete_listing_refuses(self):
        c = Client(FakeVault(), FakeTransport([]))
        c.resource_listing = lambda *a: {'truncated': False, 'rows': [{'links': [{'name': 'Worker', 'href': BASE+'1'}, {'name': 'Worker', 'href': BASE+'2'}]}]}
        with self.assertRaisesRegex(ProtocolError, 'exact name'):
            c.detail(2, 'timers', 'Worker')

    def test_unsupported_filter_fails_without_search_post(self):
        d = page('<form method="post"><input name="unrecognized"><input type="submit" name="f" value="Filter"></form>')
        c = Client(FakeVault(), FakeTransport([])); c.get = lambda *a: d
        with self.assertRaisesRegex(ProtocolError, 'unambiguous'):
            c.logs(filters={'module': 'Orders'})
        self.assertEqual([], c.http.requests)

    def test_error_filters_are_resolved_and_submitted(self):
        d = page('<form method="post"><select name="wtEspace_Selector"><option value="0">All</option><option value="42">Orders</option></select><input name="wtInput1"><input type="submit" name="f" value="Filter"></form>', 'Error_Logs.aspx')
        t = FakeTransport([page('<table><tr><th>Message</th></tr></table>')]); c = Client(FakeVault(), t)
        c.get = lambda *a: d
        c.logs(filters={'module': 'Orders', 'message': 'failed'})
        self.assertEqual('42', t.requests[0][1]['wtEspace_Selector'])
        self.assertEqual('failed', t.requests[0][1]['wtInput1'])

    def test_plan_does_not_write_or_read_a_property_secret(self):
        c = Operations('Save')
        plan = c.mutate('property-set', '3', 'Token')
        self.assertFalse(plan['execute'])
        self.assertNotIn('old', json.dumps(plan))
        self.assertEqual([], c.http.requests)

    def test_execution_requires_authorization_before_network(self):
        c = Operations()
        with self.assertRaises(ProtocolError):
            c.mutate('timer-run', '3', 'Worker', execute=True)
        self.assertEqual(0, c.reads)

    def test_successful_timer_only_means_scheduled_and_receipt_does_not_replay(self):
        with tempfile.TemporaryDirectory() as temp:
            j = Journal(temp); op = str(uuid.uuid4()); c = Operations()
            result = c.mutate('timer-run', '3', 'Worker', execute=True, words='run Worker', operation_id=op, journal=j)
            self.assertEqual('accepted', result['state'])
            self.assertFalse(result['executionCompleted'])
            again = c.mutate('timer-run', '3', 'Worker', execute=True, words='run Worker', operation_id=op, journal=j)
            self.assertTrue(again['existingReceipt']); self.assertFalse(again['replayed'])
            self.assertEqual(1, len(c.http.requests))

    def test_lost_reply_is_uncertain_and_blocks_a_new_id(self):
        with tempfile.TemporaryDirectory() as temp:
            j = Journal(temp); c = Operations(response=ProtocolError('lost'))
            result = c.mutate('timer-run', '3', 'Worker', execute=True, words='run Worker', operation_id=str(uuid.uuid4()), journal=j)
            self.assertEqual('uncertain', result['state'])
            with self.assertRaisesRegex(ProtocolError, 'pending/uncertain'):
                c.mutate('timer-run', '3', 'Worker', execute=True, words='run Worker', operation_id=str(uuid.uuid4()), journal=j)
            self.assertEqual(1, len(c.http.requests))

    def test_receipt_is_durable_before_send(self):
        with tempfile.TemporaryDirectory() as temp:
            j = Journal(temp); c = Operations(); op = str(uuid.uuid4())
            original = c.http.request
            def send(*args):
                self.assertEqual('sending', json.loads(j.path(op).read_text())['state'])
                return original(*args)
            c.http.request = send
            c.mutate('timer-run', '3', 'Worker', execute=True, words='run Worker', operation_id=op, journal=j)

    def test_deactivate_confirmed_by_new_control(self):
        with tempfile.TemporaryDirectory() as temp:
            c = Operations('Deactivate', after=detail('Activate'))
            result = c.mutate('timer-deactivate', '3', 'Worker', execute=True, words='deactivate Worker', operation_id=str(uuid.uuid4()), journal=Journal(temp))
            self.assertEqual('confirmed', result['state'])

    def test_property_confirmed_by_readback_and_no_values_in_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            c = Operations('Save', after=detail('Save', 'new-secret-value'))
            result = c.mutate('property-set', '3', 'Token', value='new-secret-value', execute=True, words='change Token', operation_id=str(uuid.uuid4()), journal=Journal(temp))
            self.assertEqual('confirmed', result['state'])
            evidence = ''.join(p.read_text() for p in Path(temp).glob('*'))
            for private in ('new-secret-value', 'change Token', 'opaque'):
                self.assertNotIn(private, evidence)

    def test_http_200_error_is_not_success(self):
        with tempfile.TemporaryDirectory() as temp:
            c = Operations(response=page('<div class="Feedback_Message_Error">No permission</div>'))
            result = c.mutate('timer-run', '3', 'Worker', execute=True, words='run Worker', operation_id=str(uuid.uuid4()), journal=Journal(temp))
            self.assertFalse(result['ok']); self.assertEqual('uncertain', result['state'])

    def test_receipt_id_cannot_change_target(self):
        with tempfile.TemporaryDirectory() as temp:
            j = Journal(temp); op = str(uuid.uuid4()); c = Operations()
            c.mutate('timer-run', '3', 'Worker', execute=True, words='run Worker', operation_id=op, journal=j)
            with self.assertRaisesRegex(ProtocolError, 'different target'):
                c.mutate('timer-run', '4', 'Worker', execute=True, words='run Worker', operation_id=op, journal=j)

    def test_cli_refuses_secret_for_timer(self):
        with self.assertRaises(ProtocolError):
            main(['timer-run', '--host', HOST, '--module-id', '2', '--name', 'Worker', '--value-vault', 'some-target'])

    def test_receipt_path_traversal_refused(self):
        with tempfile.TemporaryDirectory() as temp, self.assertRaises(ProtocolError):
            Journal(temp).lookup('../outside')

    def test_outsystems_id_redirect_is_classified_without_vault_read(self):
        t = Transport(HOST)
        t.opener.open = lambda *a, **kw: (_ for _ in ()).throw(HTTPError(BASE+'Login.aspx', 302, 'redirect', {'Location': 'https://id.outsystems.com/community/login?private=opaque'}, io.BytesIO()))
        v = FakeVault()
        with self.assertRaisesRegex(ProtocolError, 'OutSystems ID SSO') as e:
            Client(v, t).login()
        self.assertEqual(0, v.reads)
        self.assertNotIn('opaque', str(e.exception))

    def test_post_307_never_replays_even_on_same_host(self):
        t = Transport(HOST)
        calls = []
        def request(*a, **kw):
            calls.append(1)
            raise HTTPError(BASE+'Write.aspx', 307, 'redirect', {'Location': 'Write2.aspx'}, io.BytesIO())
        t.opener.open = request
        with self.assertRaisesRegex(ProtocolError, 'replay'):
            t.request('Write.aspx', {'v': 'secret'})
        self.assertEqual(1, len(calls))

    def test_unknown_page_cannot_be_reported_as_empty_logs(self):
        with self.assertRaisesRegex(ProtocolError, 'schema'):
            Client(FakeVault(), FakeTransport([])).pages(page('<p>Access denied</p>'))

    def test_verify_can_release_uncertain_deactivation_without_post(self):
        with tempfile.TemporaryDirectory() as temp:
            j = Journal(temp); c = Operations('Deactivate', response=ProtocolError('lost'))
            r = c.mutate('timer-deactivate', '3', 'Worker', execute=True, words='deactivate Worker', operation_id=str(uuid.uuid4()), journal=j)
            c.before = detail('Activate')
            result = c.verify(r, j)
            self.assertTrue(result['observedDesiredState'])
            self.assertFalse(list(Path(temp).glob('*.lock')))
            self.assertEqual(1, len(c.http.requests))

    def test_verify_run_never_infers_completion_or_releases_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            j = Journal(temp); c = Operations(response=ProtocolError('lost'))
            r = c.mutate('timer-run', '3', 'Worker', execute=True, words='run Worker', operation_id=str(uuid.uuid4()), journal=j)
            result = c.verify(r, j)
            self.assertEqual('uncertain', result['state'])
            self.assertTrue(list(Path(temp).glob('*.lock')))

    def test_boolean_property_unchecks_without_sending_the_field(self):
        with tempfile.TemporaryDirectory() as temp:
            def checkbox(checked):
                return page('<form method="post"><label for="v">Value</label><input id="v" name="v" type="checkbox" value="True" '+('checked' if checked else '')+'><input type="submit" name="save" value="Save"></form>')
            c = Operations('Save', after=checkbox(False)); c.before = checkbox(True)
            r = c.mutate('property-set', '3', 'Enabled', value='false', execute=True, words='disable Enabled', operation_id=str(uuid.uuid4()), journal=Journal(temp))
            self.assertEqual('confirmed', r['state'])
            self.assertNotIn('v', c.http.requests[0][1])

    def test_secret_property_goes_as_a_vault_reference_and_is_never_claimed_readback_verified(self):
        target = f'SSAM/O11/{HOST}/SiteProperty/Token'
        masked = page('<form method="post"><label for="v">Value</label><input id="v" name="v" type="password"><input type="submit" name="save" value="Save"></form>')
        with tempfile.TemporaryDirectory() as temp:
            # A secret field never takes a value from a file: the value would pass through this process.
            c = Operations(after=masked); c.before = masked
            with self.assertRaisesRegex(ProtocolError, 'value-vault'):
                c.mutate('property-set', '3', 'Token', value='new-secret', execute=True, words='update Token', operation_id=str(uuid.uuid4()), journal=Journal(temp))
            # Without a transport that fills secretRefs (the Studio window), nothing is reserved or sent.
            with self.assertRaises(BridgeError) as e:
                c.mutate('property-set', '3', 'Token', secret=target, execute=True, words='update Token', operation_id=str(uuid.uuid4()), journal=Journal(temp))
            self.assertEqual(('STUDIO_REQUIRED', [], []), (e.exception.code, c.http.requests, list(Path(temp).glob('*'))))
            c = Operations(response=page('<div class="Feedback_Message_Success">Site property saved</div>'), after=masked)
            c.before, c.http.secrets = masked, True
            r = c.mutate('property-set', '3', 'Token', secret=target, execute=True, words='update Token', operation_id=str(uuid.uuid4()), journal=Journal(temp))
            self.assertEqual('accepted', r['state'])
            self.assertFalse(r['valueVerified'])
            self.assertEqual(({'save': 'Save', 'v': ''}, [{'pointer': '/v', 'target': target, 'field': 'password'}]), (c.http.requests[0][1], c.http.refs[0]))

    def test_error_detail_preserves_stack_lines_and_omits_hidden_form_state(self):
        c = Client(FakeVault(), FakeTransport([]))
        c.get = lambda *a: page('<main><input type="hidden" value="private-state"><pre>Exception\n  at ActionOne\n  at ActionTwo</pre><script>private-script</script></main>')
        r = c.error_detail('error-123')
        self.assertIn('\n  at ActionOne\n  at ActionTwo', r['detail'])
        self.assertNotIn('private-', r['detail'])


if __name__ == '__main__':
    unittest.main()
