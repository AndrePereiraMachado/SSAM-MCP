"""CX15 r2 (L): the deletes of kernel/scripts/o11_service_center.py never run there, in one call or with --execute: each
answers DESTRUCTIVE_NEEDS_DEDICATED_TOOL with the call of the MCP tool o11_service_center_write (two calls: the exact
list with its count, then the token and the owner's reply), and nothing reaches the bridge or the journal. Offline: a
fake bridge that fails the test on any call; the script entry point in a child process with an isolated profile."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from service_center.client import Journal
from o11_service_center import main

HOST = 'test.example.com'
SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'o11_service_center.py'
CASES = [
    (('application-delete', '--application', 'Sample Shared'), {'action': 'delete', 'applications': ['Sample Shared']}),
    (('application-delete', '--application-key', 'app-2'), {'action': 'delete', 'applications': ['app-2']}),
    (('module-delete', '--module', 'Orders'), {'action': 'delete', 'modules': ['Orders']}),
    (('module-delete', '--module-key', 'k-orders'), {'action': 'delete', 'modules': ['k-orders']}),
    (('extension-delete', '--module-key', 'k-ext'), {'action': 'delete', 'extensions': ['k-ext']}),
    (('db-connection-delete', '--connection', 'LegacyERP'), {'action': 'db-connection-delete', 'connection': 'LegacyERP'}),
]


class NoBridge:
    """Any use of the bridge fails the test: a refused delete never reaches it."""
    def __getattr__(self, name):
        raise AssertionError('the bridge was used: ' + name)


class DeletesRefusedHere(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = Journal(Path(self.temp.name) / 'receipts')

    def run_main(self, *argv):
        return main([*argv, '--host', HOST], journal=self.journal, locate=lambda: NoBridge(), present=lambda t: False,
                    running=lambda: False, opener=lambda *a: self.fail('no prompt'), exports=self.temp.name)

    def test_every_delete_with_or_without_execute_and_words_is_refused_with_the_mcp_call(self):
        for argv, arguments in CASES:
            for extra in ((), ('--execute', '--operation-id', str(uuid.uuid4()), '--words', 'apaga ' + argv[-1] + ' on test', '--confirm-host', HOST)):
                with self.subTest(argv=argv, execute=bool(extra)):
                    result = self.run_main(*argv, *extra)
                    self.assertEqual((False, 'DESTRUCTIVE_NEEDS_DEDICATED_TOOL', False), (result['ok'], result['code'], result['sent']))
                    self.assertEqual('o11_service_center_write', result['continuation']['tool'])
                    self.assertEqual({**arguments, 'host': HOST}, result['continuation']['arguments'])
                    self.assertNotIn('words', result['continuation']['arguments'], 'the continuation is the preview: no words, no token')
        self.assertEqual([], list(Path(self.temp.name).rglob('*')), 'nothing reserved or written')

    def test_the_script_entry_point_refuses_and_exits_1_without_contacting_a_studio(self):
        home = Path(self.temp.name) / 'home'
        for sub in ('AppData/Local', 'AppData/Roaming'):
            (home / sub).mkdir(parents=True, exist_ok=True)
        env = {**os.environ, 'USERPROFILE': str(home), 'HOME': str(home), 'LOCALAPPDATA': str(home / 'AppData/Local'),
               'APPDATA': str(home / 'AppData/Roaming'), 'SSAM_SC_RECEIPTS': str(Path(self.temp.name) / 'receipts'), 'PYTHONDONTWRITEBYTECODE': '1',
               # A lane no Studio serves: even a script that tried to locate a bridge would ping no port.
               'ANVIL_LANE': 'cx15-no-lane', 'ANVIL_AUTHORITY_DIR': str(Path(self.temp.name) / 'authority')}
        child = subprocess.run([sys.executable, str(SCRIPT), 'application-delete', '--host', HOST, '--application', 'Sample Shared',
                                '--execute', '--operation-id', str(uuid.uuid4()), '--words', 'delete Sample Shared on test', '--confirm-host', HOST],
                               capture_output=True, text=True, env=env, timeout=120)
        self.assertEqual(1, child.returncode, child.stderr)
        result = json.loads(child.stdout)
        self.assertEqual(('DESTRUCTIVE_NEEDS_DEDICATED_TOOL', 'o11_service_center_write'), (result['code'], result['continuation']['tool']))
        self.assertFalse((Path(self.temp.name) / 'receipts').exists(), 'no receipt')


if __name__ == '__main__':
    unittest.main()
