# Tests of host/install.sh and host/uninstall.sh (DESIGN section 7.4).
#   - DryRunTests: --dry-run runs the read-only checks, prints every change with the SSAM_CONSOLE_ROOT prefix, changes
#     nothing and runs no mutating command (systemctl, chown, install, curl are stubs that record their calls).
#   - AccountTests: the proxy account (ssam-console-proxy.service runs as User=10001 Group=10001; DEPLOY.md 15.1, 15.9,
#     15.10). getent reads a fake passwd/group; groupadd, useradd, userdel and groupdel record their calls and change
#     those files; pgrep reports $FAKE_PROCS processes; id -u says 0 where a test runs as "root".
#   - ContainerTests (opt-in, Docker): install.sh and uninstall.sh run for real as root in an Ubuntu container
#     (fixtures/account-container.sh): SSAM_TEST_DOCKER_IMAGE=ubuntu:26.04, SSAM_TEST_DOCKER_LOG=<dir> keeps the outputs.
# Needs a POSIX sh: on the VPS /bin/sh; on Windows the sh of Git for Windows (SSAM_TEST_SH=<path> picks another).
# Skipped when none is found.

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
DEPLOY_DIR = os.path.dirname(HOST_DIR)
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
# The account tools, on a fake passwd and group in $FAKE_ETC. getent and pgrep only read and record nothing.
FAKES = {
    'getent': '''#!/bin/sh
f="$FAKE_ETC/$1"
[ -f "$f" ] || exit 2
if [ $# -lt 2 ]; then cat "$f"; exit 0; fi
case "$2" in ''|*[!0-9]*) col=1 ;; *) col=3 ;; esac
awk -F: -v k="$2" -v c="$col" '$c == k { print; found = 1; exit } END { exit !found }' "$f" || exit 2
''',
    'groupadd': '''#!/bin/sh
echo "groupadd $*" >> "$STUB_LOG"
gid=""; name=""
while [ $# -gt 0 ]; do
    case "$1" in -g) gid=$2; shift 2 ;; -*) shift ;; *) name=$1; shift ;; esac
done
if awk -F: -v n="$name" -v g="$gid" '$1 == n || $3 == g { f = 1 } END { exit !f }' "$FAKE_ETC/group"; then
    echo "groupadd: group '$name' or GID '$gid' already exists" >&2; exit 9
fi
echo "$name:x:$gid:" >> "$FAKE_ETC/group"
''',
    'useradd': '''#!/bin/sh
echo "useradd $*" >> "$STUB_LOG"
uid=""; gid=""; home=""; shell=""; comment=""; name=""
while [ $# -gt 0 ]; do
    case "$1" in
        -u) uid=$2; shift 2 ;; -g) gid=$2; shift 2 ;; -d) home=$2; shift 2 ;;
        -s) shell=$2; shift 2 ;; -c) comment=$2; shift 2 ;; -*) shift ;; *) name=$1; shift ;;
    esac
done
if awk -F: -v n="$name" -v u="$uid" '$1 == n || $3 == u { f = 1 } END { exit !f }' "$FAKE_ETC/passwd"; then
    echo "useradd: user '$name' or UID '$uid' already exists" >&2; exit 9
fi
awk -F: -v g="$gid" '$3 == g { f = 1 } END { exit !f }' "$FAKE_ETC/group" \\
    || { echo "useradd: group '$gid' does not exist" >&2; exit 6; }
echo "$name:x:$uid:$gid:$comment:$home:$shell" >> "$FAKE_ETC/passwd"
''',
    'userdel': '''#!/bin/sh
echo "userdel $*" >> "$STUB_LOG"
awk -F: -v n="$1" '$1 == n { f = 1 } END { exit !f }' "$FAKE_ETC/passwd" \\
    || { echo "userdel: user '$1' does not exist" >&2; exit 6; }
awk -F: -v n="$1" '$1 != n' "$FAKE_ETC/passwd" > "$FAKE_ETC/passwd.new" && mv "$FAKE_ETC/passwd.new" "$FAKE_ETC/passwd"
# USERGROUPS_ENAB yes (Ubuntu's default): the group with the user's name goes too. FAKE_USERGROUPS=0 keeps it.
[ "${FAKE_USERGROUPS:-1}" = 1 ] || exit 0
awk -F: -v n="$1" '$1 != n' "$FAKE_ETC/group" > "$FAKE_ETC/group.new" && mv "$FAKE_ETC/group.new" "$FAKE_ETC/group"
''',
    'groupdel': '''#!/bin/sh
echo "groupdel $*" >> "$STUB_LOG"
awk -F: -v n="$1" '$1 == n { f = 1 } END { exit !f }' "$FAKE_ETC/group" \\
    || { echo "groupdel: group '$1' does not exist" >&2; exit 6; }
awk -F: -v n="$1" '$1 != n' "$FAKE_ETC/group" > "$FAKE_ETC/group.new" && mv "$FAKE_ETC/group.new" "$FAKE_ETC/group"
''',
    'pgrep': '''#!/bin/sh
n=${FAKE_PROCS:-0}
[ "$n" -gt 0 ] || exit 1
i=0
while [ "$i" -lt "$n" ]; do echo $((4000 + i)); i=$((i + 1)); done
''',
}
ROOT_ID = '''#!/bin/sh
if [ "$1" = -u ]; then echo 0; exit 0; fi
exec /usr/bin/id "$@"
'''
BASE_PASSWD = 'root:x:0:0:root:/root:/bin/bash\nubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash\n'
BASE_GROUP = 'root:x:0:\nubuntu:x:1000:\n'
CREATED_USER = 'ssam-console:x:10001:10001:ssam-console-proxy:/nonexistent:/usr/sbin/nologin\n'
CREATED_GROUP = 'ssam-console:x:10001:\n'
GROUPADD = 'groupadd -r -g 10001 ssam-console'
USERADD = 'useradd -r -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin -c ssam-console-proxy ssam-console'
CHECK = 'uid 10001 e gid 10001 do ssam-console-proxy (existem ou podem ser criados)'
RESET_FAILED = 'systemctl reset-failed ssam-console-proxy.service ssam-console-proxy.socket'
DOCKER_IMAGE = os.environ.get('SSAM_TEST_DOCKER_IMAGE', '')


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


class ScriptCase(unittest.TestCase):
    """A temporary root, the stubs and fakes on PATH and a fake passwd/group with two unrelated accounts."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='install-test-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, 'root')
        self.stubs = os.path.join(self.tmp, 'stubs')
        self.etc = os.path.join(self.tmp, 'etc')
        for path in (self.root, self.stubs, self.etc):
            os.makedirs(path)
        for name in STUBS:
            self.write(os.path.join(self.stubs, name), STUB)
        for name, text in FAKES.items():
            self.write(os.path.join(self.stubs, name), text)
        self.set_accounts()
        self.log = os.path.join(self.tmp, 'stub.log').replace('\\', '/')
        self.root_posix = self.posix(self.root)

    @staticmethod
    def write(path, text):
        with open(path, 'w', encoding='ascii', newline='\n') as handle:
            handle.write(text)

    def as_root(self):
        self.write(os.path.join(self.stubs, 'id'), ROOT_ID)

    def set_accounts(self, passwd='', group=''):
        self.write(os.path.join(self.etc, 'passwd'), BASE_PASSWD + passwd)
        self.write(os.path.join(self.etc, 'group'), BASE_GROUP + group)

    def accounts(self):
        result = []
        for name in ('passwd', 'group'):
            with open(os.path.join(self.etc, name), encoding='ascii', newline='') as handle:
                result.append(handle.read())
        return tuple(result)

    def posix(self, path):
        out = subprocess.run([SH, '-c', 'cd "$1" && pwd', '_', path.replace('\\', '/')], stdout=subprocess.PIPE,
                             check=True, timeout=30).stdout
        return out.decode('utf-8').strip()

    def run_script(self, script, *args, root=True, env=None):
        full = dict(os.environ)
        full['STUB_LOG'] = self.log
        full['FAKE_ETC'] = self.etc.replace('\\', '/')
        if root:
            full['SSAM_CONSOLE_ROOT'] = self.root_posix
        else:
            full.pop('SSAM_CONSOLE_ROOT', None)
        full.update(env or {})
        # /usr/bin:/bin: Git for Windows' sh started from a Windows process does not have its own tools on PATH.
        wrapper = 'PATH="$1:/usr/bin:/bin:$PATH"; export PATH; chmod +x "$1"/*; shift; exec sh "$@"'
        proc = subprocess.run([SH, '-c', wrapper, '_', self.posix(self.stubs), script] + list(args), env=full,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120, check=False)
        return proc.returncode, proc.stdout.decode('utf-8', 'replace')

    def stub_calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding='utf-8') as handle:
            return [line.strip() for line in handle if line.strip()]

    def account_calls(self):
        return [call for call in self.stub_calls() if call.split(' ', 1)[0] in ('groupadd', 'useradd', 'userdel',
                                                                                   'groupdel')]

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


@unittest.skipIf(SH is None, 'no POSIX sh found')
class DryRunTests(ScriptCase):
    def assert_prefixed(self, output):
        dry = [line for line in output.splitlines() if '(dry-run)' in line]
        self.assertTrue(dry, output)
        for line in dry:
            for host_path in HOST_PATHS:
                for match in re.finditer(re.escape(host_path), line):
                    if not line[:match.start()].endswith(self.root_posix):
                        self.fail('host path without the SSAM_CONSOLE_ROOT prefix: %s' % line)

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


@unittest.skipIf(SH is None, 'no POSIX sh found')
class AccountTests(ScriptCase):
    """uid/gid 10001 of ssam-console-proxy.service: created when missing, reused under any name, never another's."""

    def test_install_dry_run_plans_the_account_first_and_changes_nothing(self):
        before = self.accounts()
        code, out = self.run_script(INSTALL, '--dry-run')
        self.assertEqual(code, 0, out)
        self.assertIn('ok     ' + CHECK, out)
        lines = out.splitlines()
        group_at = lines.index('  (dry-run) ' + GROUPADD)
        user_at = lines.index('  (dry-run) ' + USERADD)
        folders_at = next(i for i, line in enumerate(lines) if '(dry-run) install -d -o 10001' in line)
        reset_at = lines.index('  (dry-run) ' + RESET_FAILED)
        enable_at = next(i for i, line in enumerate(lines) if '(dry-run) systemctl enable --now' in line)
        self.assertLess(group_at, user_at)
        self.assertLess(user_at, folders_at)  # the account exists before anything is given to 10001
        self.assertLess(reset_at, enable_at)  # a proxy that failed with 217/USER starts clean
        self.assertEqual(self.account_calls(), [])
        self.assert_no_mutation()
        self.assertEqual(self.accounts(), before)

    def test_install_rerun_after_the_creation_is_a_no_op(self):
        code, out = self.run_script(INSTALL, '--dry-run')
        self.assertEqual(code, 0, out)
        # What a real run does: the two printed commands, through the fake groupadd and useradd.
        for line in out.splitlines():
            if line.startswith('  (dry-run) groupadd ') or line.startswith('  (dry-run) useradd '):
                command = line[len('  (dry-run) '):]
                code, made = self.run_script('-c', command, root=False)
                self.assertEqual(code, 0, made)
        self.assertEqual(self.accounts(), (BASE_PASSWD + CREATED_USER, BASE_GROUP + CREATED_GROUP))
        self.assertEqual(self.account_calls(), [GROUPADD, USERADD])
        code, out = self.run_script(INSTALL, '--dry-run')
        self.assertEqual(code, 0, out)
        self.assertIn('existe  grupo ssam-console (gid 10001)', out)
        self.assertIn('existe  usuario ssam-console (uid 10001)', out)
        self.assertNotIn('groupadd', out)
        self.assertNotIn('useradd', out)
        self.assertNotIn('reset-failed', out)
        self.assertEqual(self.account_calls(), [GROUPADD, USERADD])

    def test_install_reuses_uid_and_gid_10001_under_any_name(self):
        self.set_accounts('app:x:10001:10001:app:/home/app:/bin/sh\n', 'app:x:10001:\n')
        before = self.accounts()
        code, out = self.run_script(INSTALL, '--dry-run')
        self.assertEqual(code, 0, out)
        self.assertIn('ok     ' + CHECK, out)
        self.assertIn('existe  grupo app (gid 10001)', out)
        self.assertIn('existe  usuario app (uid 10001)', out)
        self.assertNotIn('groupadd', out)
        self.assertNotIn('useradd', out)
        self.assertEqual(self.accounts(), before)
        # Only the missing half is created; the name ssam-console of another id is irrelevant when nothing is created
        # under that name.
        self.set_accounts('app:x:10001:100:app:/home/app:/bin/sh\nssam-console:x:999:999::/x:/bin/sh\n')
        code, out = self.run_script(INSTALL, '--dry-run')
        self.assertEqual(code, 0, out)
        self.assertIn('ok     ' + CHECK, out)
        self.assertIn('(dry-run) ' + GROUPADD, out)
        self.assertIn('existe  usuario app (uid 10001)', out)
        self.assertNotIn('useradd', out)

    def test_install_refuses_the_name_taken_by_another_id_before_changing_anything(self):
        self.as_root()
        self.set_accounts('ssam-console:x:999:999:other:/var/lib/other:/usr/sbin/nologin\n', 'ssam-console:x:999:\n')
        before = self.accounts()
        code, out = self.run_script(INSTALL)
        self.assertEqual(code, 1, out)
        self.assertIn('ok     root', out)
        self.assertIn('FALHA  ' + CHECK, out)
        self.assertIn('- o grupo ssam-console ja existe com o gid 999 (o proxy roda com o gid 10001)', out)
        self.assertIn('- o usuario ssam-console ja existe com o uid 999 (o proxy roda com o uid 10001)', out)
        self.assertIn('o install.sh nunca muda outro usuario ou grupo', out)
        self.assertIn('nada foi alterado', out)
        self.assertNotIn('== Conta do proxy', out)
        self.assert_no_mutation()
        self.assertEqual(self.accounts(), before)
        # Only the user name taken: the free group is not created either (checks first, then changes).
        self.set_accounts('ssam-console:x:999:100:other:/var/lib/other:/usr/sbin/nologin\n')
        before = self.accounts()
        code, out = self.run_script(INSTALL)
        self.assertEqual(code, 1, out)
        self.assertIn('FALHA  ' + CHECK, out)
        self.assertIn('- o usuario ssam-console ja existe com o uid 999', out)
        self.assertNotIn('- o grupo', out)
        self.assertEqual(self.account_calls(), [])
        self.assertEqual(self.accounts(), before)
        # The dry-run reports it and plans no user.
        code, out = self.run_script(INSTALL, '--dry-run')
        self.assertEqual(code, 0, out)
        self.assertIn('FALHA   usuario ssam-console ja existe com o uid 999: nada criado', out)
        self.assertNotIn('(dry-run) useradd', out)
        self.assertEqual(self.account_calls(), [])

    def test_install_without_getent_fails_the_check(self):
        os.remove(os.path.join(self.stubs, 'getent'))
        code, out = self.run_script(INSTALL, '--dry-run')
        if 'getent nao encontrado' not in out:
            self.skipTest('this sh has its own getent')  # Git for Windows ships none; a Linux host does
        self.assertEqual(code, 0, out)
        self.assertIn('FALHA  ' + CHECK, out)
        self.assertEqual(self.account_calls(), [])

    def test_uninstall_keeps_the_account_by_default(self):
        self.as_root()
        self.set_accounts(CREATED_USER, CREATED_GROUP)
        before = self.accounts()
        code, out = self.run_script(UNINSTALL)
        self.assertEqual(code, 0, out)
        self.assertIn('mantidos usuario ssam-console e grupo ssam-console (--purge apaga o ssam-console criado pelo '
                      'install.sh)', out)
        self.assertEqual(self.account_calls(), [])
        self.assertEqual(self.accounts(), before)

    def test_uninstall_purge_removes_the_account_install_created(self):
        self.as_root()
        self.set_accounts(CREATED_USER, CREATED_GROUP)
        code, out = self.run_script(UNINSTALL, '--purge', '--dry-run')
        self.assertEqual(code, 0, out)
        self.assertIn('(dry-run) userdel ssam-console', out)
        self.assertIn('(dry-run) groupdel ssam-console', out)
        self.assertEqual(self.account_calls(), [])
        # Ubuntu: userdel takes the group of the same name with it.
        code, out = self.run_script(UNINSTALL, '--purge')
        self.assertEqual(code, 0, out)
        self.assertIn('+ userdel ssam-console', out)
        self.assertIn('o grupo ssam-console saiu junto com o usuario (userdel)', out)
        self.assertEqual(self.account_calls(), ['userdel ssam-console'])
        self.assertEqual(self.accounts(), (BASE_PASSWD, BASE_GROUP))
        # A userdel that leaves the group: groupdel follows.
        os.remove(self.log)
        self.set_accounts(CREATED_USER, CREATED_GROUP)
        code, out = self.run_script(UNINSTALL, '--purge', env={'FAKE_USERGROUPS': '0'})
        self.assertEqual(code, 0, out)
        self.assertEqual(self.account_calls(), ['userdel ssam-console', 'groupdel ssam-console'])
        self.assertEqual(self.accounts(), (BASE_PASSWD, BASE_GROUP))

    def test_uninstall_purge_never_touches_another_account(self):
        self.as_root()
        cases = (
            # uid/gid 10001 under another name (install.sh reused them)
            ('app:x:10001:10001:app:/home/app:/bin/sh\n', 'app:x:10001:\n',
             ('mantido o usuario app (uid 10001): nao e o ssam-console do install.sh',
              'mantido o grupo app (gid 10001): nao e o ssam-console do install.sh')),
            # ssam-console of another id, nothing on 10001
            ('ssam-console:x:999:999::/x:/bin/sh\n', 'ssam-console:x:999:\n',
             ('nenhum usuario com o uid 10001 e nenhum grupo com o gid 10001',)),
            # the group ssam-console 10001 is the primary group of another user
            ('app:x:10001:10001:app:/home/app:/bin/sh\n', CREATED_GROUP,
             ('mantido o grupo ssam-console: e o grupo principal de app',)),
        )
        for passwd, group, expected in cases:
            self.set_accounts(passwd, group)
            before = self.accounts()
            code, out = self.run_script(UNINSTALL, '--purge')
            self.assertEqual(code, 0, out)
            for line in expected:
                self.assertIn(line, out)
            self.assertEqual(self.account_calls(), [], out)
            self.assertEqual(self.accounts(), before)

    def test_uninstall_purge_keeps_the_account_while_uid_10001_runs(self):
        self.as_root()
        self.set_accounts(CREATED_USER, CREATED_GROUP)
        before = self.accounts()
        code, out = self.run_script(UNINSTALL, '--purge', env={'FAKE_PROCS': '3'})
        self.assertEqual(code, 0, out)
        self.assertIn('mantido o usuario ssam-console: 3 processo(s) rodam como uid 10001', out)
        self.assertIn('mantido o grupo ssam-console: e o grupo principal de ssam-console', out)
        self.assertEqual(self.account_calls(), [])
        self.assertEqual(self.accounts(), before)


@unittest.skipUnless(DOCKER_IMAGE and shutil.which('docker'),
                     'SSAM_TEST_DOCKER_IMAGE=ubuntu:26.04 (and Docker) runs install.sh for real in a container')
class ContainerTests(unittest.TestCase):
    def scenario(self, name):
        proc = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '-v', DEPLOY_DIR + ':/opt/ssam/deploy:ro',
                               DOCKER_IMAGE, 'sh', '/opt/ssam/deploy/host/tests/fixtures/account-container.sh', name],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600, check=False)
        out = proc.stdout.decode('utf-8', 'replace')
        log_dir = os.environ.get('SSAM_TEST_DOCKER_LOG')
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
            tag = re.sub(r'[^A-Za-z0-9.-]+', '-', DOCKER_IMAGE)
            with open(os.path.join(log_dir, 'container-%s-%s.log' % (tag, name)), 'w', encoding='utf-8',
                      newline='\n') as handle:
                handle.write(out)
        self.assertEqual(proc.returncode, 0, out)
        self.assertIn('OK cenario %s' % name, out)
        return out

    def test_fresh_host_creates_reruns_keeps_and_purges(self):
        out = self.scenario('fresh')
        self.assertIn('+ ' + GROUPADD, out)
        self.assertIn('+ ' + USERADD, out)
        self.assertIn('passwd -S:           ssam-console L ', out)

    def test_name_taken_by_another_id_changes_nothing(self):
        self.scenario('collision')

    def test_existing_uid_is_reused_and_kept(self):
        self.scenario('reuse')


if __name__ == '__main__':
    unittest.main()
