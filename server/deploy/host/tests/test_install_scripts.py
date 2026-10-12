# Tests of host/install.sh and host/uninstall.sh in --dry-run (DESIGN section 7.4): the read-only checks run, every
# change is printed with the SSAM_CONSOLE_ROOT prefix, nothing is changed and no mutating command runs (systemctl,
# chown, install, curl are stubs that record their calls). Needs a POSIX sh: on the VPS /bin/sh; on Windows the sh of
# Git for Windows (SSAM_TEST_SH=<path> picks another). Skipped when none is found.

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_DIR = os.path.dirname(HERE)
INSTALL = os.path.join(HOST_DIR, 'install.sh').replace('\\', '/')
UNINSTALL = os.path.join(HOST_DIR, 'uninstall.sh').replace('\\', '/')
HOST_PATHS = ('/var/lib/ssam-console', '/usr/local/lib/ssam-console', '/etc/ssam-console', '/etc/systemd/system',
              '/etc/cron.d', '/var/backups/ssam-server')
STUBS = ('systemctl', 'chown', 'install', 'docker', 'ss', 'curl')
STUB = '''#!/bin/sh
echo "$(basename "$0") $*" >> "$STUB_LOG"
if [ "$(basename "$0")" = docker ] && [ "$1" = version ]; then echo 29.8.2; fi
exit 0
'''


def find_sh():
    candidates = [os.environ.get('SSAM_TEST_SH'), shutil.which('sh')]
    for base in (os.environ.get('ProgramFiles', r'C:\Program Files'), os.environ.get('ProgramW6432', '')):
        if base:
            candidates.append(os.path.join(base, 'Git', 'usr', 'bin', 'sh.exe'))
            candidates.append(os.path.join(base, 'Git', 'bin', 'sh.exe'))
            candidates.append(os.path.join(base, 'Microsoft Visual Studio', '18', 'Community', 'Common7', 'IDE',
                                           'CommonExtensions', 'Microsoft', 'TeamFoundation', 'Team Explorer', 'Git',
                                           'usr', 'bin', 'sh.exe'))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


SH = find_sh()


class HostJsonCheckTests(unittest.TestCase):
    """The Python check that install.sh runs on host.json after the first collector run (its here-document)."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(HOST_DIR, 'install.sh'), encoding='utf-8') as handle:
            text = handle.read()
        start = text.index("<<'PYEOF'\n") + len("<<'PYEOF'\n")
        cls.script = text[start:text.index('\nPYEOF\n', start) + 1]

    def check(self, path):
        proc = subprocess.run([sys.executable, '-I', '-', path], input=self.script.encode('utf-8'),
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60, check=False)
        return proc.returncode, proc.stdout.decode('utf-8', 'replace')

    def test_accepts_the_expected_document_and_lists_section_errors(self):
        code, out = self.check(os.path.join(HERE, 'fixtures', 'expected-host.json'))
        self.assertEqual(code, 0, out)
        self.assertIn('ok     host.json 2026-10-12T02:51:00Z em 0 ms; secoes com erro: nenhuma', out)
        tmp = tempfile.mkdtemp(prefix='hostjson-')
        self.addCleanup(shutil.rmtree, tmp, True)
        with open(os.path.join(HERE, 'fixtures', 'expected-host.json'), encoding='utf-8') as handle:
            doc = json.load(handle)
        doc['updates'] = {'ok': False, 'error': 'TIMEOUT', 'at': doc['collectedAt']}
        doc['collector']['errors'] = ['updates: TIMEOUT']
        partial = os.path.join(tmp, 'partial.json')
        with open(partial, 'w', encoding='utf-8') as handle:
            json.dump(doc, handle)
        code, out = self.check(partial)
        self.assertEqual(code, 0, out)
        self.assertIn('secoes com erro: updates', out)
        self.assertIn('- updates: TIMEOUT', out)

    def test_refuses_another_schema_or_garbage(self):
        tmp = tempfile.mkdtemp(prefix='hostjson-')
        self.addCleanup(shutil.rmtree, tmp, True)
        for name, text in (('schema.json', '{"schema": "ssam-console-host/9"}'), ('garbage.json', 'not json')):
            path = os.path.join(tmp, name)
            with open(path, 'w', encoding='utf-8') as handle:
                handle.write(text)
            code, out = self.check(path)
            self.assertNotEqual(code, 0, out)


@unittest.skipIf(SH is None, 'no POSIX sh found')
class DryRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='install-test-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, 'root')
        self.stubs = os.path.join(self.tmp, 'stubs')
        os.makedirs(self.root)
        os.makedirs(self.stubs)
        for name in STUBS:
            with open(os.path.join(self.stubs, name), 'w', encoding='ascii', newline='\n') as handle:
                handle.write(STUB)
        self.log = os.path.join(self.tmp, 'stub.log').replace('\\', '/')
        self.root_posix = self.posix(self.root)

    def posix(self, path):
        out = subprocess.run([SH, '-c', 'cd "$1" && pwd', '_', path.replace('\\', '/')], stdout=subprocess.PIPE,
                             check=True, timeout=30).stdout
        return out.decode('utf-8').strip()

    def run_script(self, script, *args, root=True):
        env = dict(os.environ)
        env['STUB_LOG'] = self.log
        if root:
            env['SSAM_CONSOLE_ROOT'] = self.root_posix
        else:
            env.pop('SSAM_CONSOLE_ROOT', None)
        # /usr/bin:/bin: Git for Windows' sh started from a Windows process does not have its own tools on PATH.
        wrapper = 'PATH="$1:/usr/bin:/bin:$PATH"; export PATH; chmod +x "$1"/*; shift; exec sh "$@"'
        proc = subprocess.run([SH, '-c', wrapper, '_', self.posix(self.stubs), script] + list(args), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120, check=False)
        return proc.returncode, proc.stdout.decode('utf-8', 'replace')

    def stub_calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding='utf-8') as handle:
            return [line.strip() for line in handle if line.strip()]

    def assert_prefixed(self, output):
        dry = [line for line in output.splitlines() if '(dry-run)' in line]
        self.assertTrue(dry, output)
        for line in dry:
            for host_path in HOST_PATHS:
                for match in re.finditer(re.escape(host_path), line):
                    if not line[:match.start()].endswith(self.root_posix):
                        self.fail('host path without the SSAM_CONSOLE_ROOT prefix: %s' % line)

    def assert_no_mutation(self):
        for call in self.stub_calls():
            tool, _, rest = call.partition(' ')
            if tool == 'systemctl':
                self.assertRegex(rest, r'^is-active\b', call)
            elif tool == 'docker':
                self.assertRegex(rest, r'^(version|ps)\b', call)
            elif tool == 'ss':
                continue
            else:
                self.fail('mutating command ran in --dry-run: %s' % call)
        for dirpath, dirnames, filenames in os.walk(self.root):
            self.assertEqual(filenames, [], 'file created under the root: %s' % dirpath)

    def test_install_dry_run_prints_prefixed_changes_and_changes_nothing(self):
        code, out = self.run_script(INSTALL, '--dry-run', '--with-crons', '--port', '7321')
        self.assertEqual(code, 0, out)
        self.assert_prefixed(out)
        self.assert_no_mutation()
        self.assertEqual(os.listdir(self.root), [])
        r = self.root_posix
        for expected in (
                '(dry-run) install -d -o root -g root -m 0755 %s/var/lib/ssam-console' % r,
                '(dry-run) install -d -o root -g 10001 -m 0750 %s/var/lib/ssam-console/host' % r,
                '(dry-run) install -d -o root -g root -m 0700 %s/var/lib/ssam-console/collector' % r,
                '(dry-run) install -d -o 10001 -g 10001 -m 0700 %s/var/lib/ssam-console/state' % r,
                '(dry-run) install -d -o 10001 -g 10001 -m 0750 %s/var/lib/ssam-console/sock' % r,
                '%s/usr/local/lib/ssam-console/collect.py' % r,
                '%s/etc/ssam-console/collector.conf' % r,
                '%s/etc/systemd/system/ssam-console-proxy.socket' % r,
                '(dry-run) systemctl daemon-reload',
                '(dry-run) systemctl enable --now ssam-console-collect.timer ssam-console-proxy.socket',
                '(dry-run) systemctl start ssam-console-collect.service',
                '(dry-run) install -d -o root -g root -m 0700 %s/var/backups/ssam-server' % r,
                '(dry-run) install -o root -g root -m 0600 /dev/null %s/var/backups/ssam-server/cron.log' % r,
                '%s/etc/cron.d/ssam-backup' % r,
                '%s/etc/cron.d/ssam-rotate' % r,
                'COMPOSE_PROFILES=console',
                'docker compose -f compose.prod.yml up -d ssam-console',
                'dry-run: nada foi alterado'):
            self.assertIn(expected, out)
        self.assertIn('127.0.0.1:7321', out)
        self.assertIn('FALHA  root', out)  # the checks still run and report

    def test_install_refuses_bad_arguments(self):
        for args in (('--port', '80'), ('--port', 'abc'), ('--bogus',)):
            code, out = self.run_script(INSTALL, '--dry-run', *args)
            self.assertEqual(code, 2, (args, out))
        self.assertEqual(self.stub_calls(), [])

    def test_install_without_dry_run_stops_at_the_failed_checks(self):
        code, out = self.run_script(INSTALL)
        self.assertEqual(code, 1, out)
        self.assertIn('nada foi alterado', out)
        self.assert_no_mutation()

    def test_relative_root_refused(self):
        env_root = self.root_posix
        self.root_posix = 'relative/root'
        try:
            code, out = self.run_script(INSTALL, '--dry-run')
        finally:
            self.root_posix = env_root
        self.assertEqual(code, 2, out)

    def test_uninstall_dry_run_lists_removals_and_changes_nothing(self):
        for rel in ('var/lib/ssam-console/state/checkpoint.json', 'etc/ssam-console/collector.conf',
                    'usr/local/lib/ssam-console/collect.py', 'etc/systemd/system/ssam-console-proxy.socket',
                    'etc/cron.d/ssam-backup', 'etc/cron.d/ssam-rotate'):
            path = os.path.join(self.root, *rel.split('/'))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='ascii') as handle:
                handle.write('x\n')
        before = sorted(os.path.relpath(os.path.join(d, f), self.root) for d, _, fs in os.walk(self.root) for f in fs)
        code, out = self.run_script(UNINSTALL, '--dry-run', '--purge', '--crons')
        self.assertEqual(code, 0, out)
        r = self.root_posix
        for expected in ('(dry-run) systemctl disable --now ssam-console-collect.timer ssam-console-proxy.socket',
                         '(dry-run) rm -f %s/etc/systemd/system/ssam-console-proxy.socket' % r,
                         '(dry-run) rm -rf %s/usr/local/lib/ssam-console' % r,
                         '(dry-run) rm -rf %s/var/lib/ssam-console' % r,
                         '(dry-run) rm -rf %s/etc/ssam-console' % r,
                         '(dry-run) rm -f %s/etc/cron.d/ssam-backup' % r,
                         '(dry-run) rm -f %s/etc/cron.d/ssam-rotate' % r,
                         'dry-run: nada foi alterado'):
            self.assertIn(expected, out)
        after = sorted(os.path.relpath(os.path.join(d, f), self.root) for d, _, fs in os.walk(self.root) for f in fs)
        self.assertEqual(before, after)
        for call in self.stub_calls():
            self.assertTrue(call.startswith('docker ps'), call)


if __name__ == '__main__':
    unittest.main()
