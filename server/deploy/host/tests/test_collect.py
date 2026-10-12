# Tests of the owner console's host collector (server/deploy/host/collect.py, DESIGN section 3.6).
#   python -m unittest discover -s server/deploy/host/tests
# Fixtures (tests/fixtures): linux-host/ and docker-prod/ reproduce the read-only production probe of 2026-10-12 02:51Z
# with neutral names and documentation IPs; expected-host.json is the document of two runs (02:50:30Z, 02:51:00Z).
# The fixtures carry sentinels that must never reach host.json or the collector state: a secret in every container's
# Config.Env, the health checks' Output, an extra warm field, customer data in the server's stdout (customer name,
# session ids, machine), the User-Agent and Authorization headers of Caddy's access log.

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_DIR = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, 'fixtures')
LINUX = os.path.join(FIXTURES, 'linux-host')
DOCKER = os.path.join(FIXTURES, 'docker-prod')
EXPECTED = os.path.join(FIXTURES, 'expected-host.json')
COLLECT = os.path.join(HOST_DIR, 'collect.py')
sys.path.insert(0, HOST_DIR)

import collect  # noqa: E402

RUN1 = '2026-10-12T02:50:30Z'
RUN2 = '2026-10-12T02:51:00Z'
SENTINELS = ('SENTINEL', 'ssam_EXEMPLO', 'Cliente Alfa', 'PC-TESTE', 'claude-code', 'tok_0000000a1fa0',
             '00000000-0000-4000', 'REDACTED', '--log-file', 'abc123')
SERVER_LOG = 'logs-ssam-prod-ssam-server-1'
CADDY_LOG = 'logs-ssam-prod-caddy-1'


def iso_plus(base, seconds):
    return collect.iso(collect.parse_time(base) + seconds)


def stamped(t_iso, body):
    """One line as `docker logs --timestamps` prints it (the fixture format of DockerFixture)."""
    text = body if isinstance(body, str) else json.dumps(body, separators=(',', ':'))
    return collect.docker_time(collect.parse_time(t_iso)) + ' ' + text + '\n'


def access(t_iso, status, ip, uri='/mcp'):
    return stamped(t_iso, {'level': 'info', 'ts': collect.parse_time(t_iso), 'logger': 'http.log.access.log0',
                           'msg': 'handled request', 'status': status,
                           'request': {'remote_ip': ip, 'uri': uri,
                                       'headers': {'User-Agent': ['SENTINEL-UA'], 'Authorization': ['REDACTED']}}})


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='collect-test-')
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def path(self, *parts):
        return os.path.join(self.tmp, *parts)

    def copy(self, source, name):
        target = self.path(name)
        shutil.copytree(source, target)
        return target

    def write(self, path, text):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write(text)

    def collect(self, now, host=LINUX, docker=DOCKER, state='state', out='host.json', extra=(), code=0):
        argv = ['--fixture-host', host, '--fixture-docker', docker, '--out', self.path(out), '--state', self.path(state),
                '--now', now] + list(extra)
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = collect.main(argv)
        self.assertEqual(result, code, stderr.getvalue())
        if code != 0:
            return None
        with open(self.path(out), encoding='utf-8') as handle:
            return json.load(handle)

    def state_text(self, state='state'):
        with open(self.path(state, 'state.json'), encoding='utf-8') as handle:
            return handle.read()


# ------------------------------------------------------------------------------------------------- full fixture run

class FullRunTests(Base):
    def run_cli(self, now):
        proc = subprocess.run(
            [sys.executable, '-I', COLLECT, '--fixture-host', LINUX, '--fixture-docker', DOCKER,
             '--out', self.path('host.json'), '--state', self.path('state'), '--now', now],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode('utf-8', 'replace'))
        self.assertIn(b'host.json written', proc.stdout)
        return proc

    def test_two_runs_under_python_isolated_mode_equal_expected_host_json(self):
        self.run_cli(RUN1)
        self.run_cli(RUN2)
        with open(self.path('host.json'), 'rb') as handle:
            raw = handle.read()
        self.assertTrue(raw.endswith(b'\n') and raw.count(b'\n') == 1, 'one JSON line')
        raw.decode('ascii')  # ASCII only (json.dumps escapes the rest)
        with open(EXPECTED, encoding='utf-8') as handle:
            expected = json.load(handle)
        self.assertEqual(json.loads(raw), expected)
        self.assertFalse(os.path.exists(self.path('host.json.tmp')))

    def test_output_matches_the_field_list_of_the_contract(self):
        self.collect(RUN1)
        doc = self.collect(RUN2)

        def has(obj, keys, where):
            self.assertIsInstance(obj, dict, where)
            missing = set(keys.split()) - set(obj)
            self.assertFalse(missing, '%s lacks %s' % (where, sorted(missing)))

        def integer(value, where):
            self.assertTrue(isinstance(value, int) and not isinstance(value, bool), '%s: %r' % (where, value))

        has(doc, 'schema collectedAt collector host updates security tls backups docker server caddy coolify', 'top')
        self.assertEqual(doc['schema'], 'ssam-console-host/1')
        has(doc['collector'], 'version durationMs intervalS project errors', 'collector')
        for name in collect.SECTION_ORDER:
            has(doc[name], 'ok at', name)
            self.assertIs(doc[name]['ok'], True, name)
        h = doc['host']
        has(h, 'hostname os kernel nproc uptimeS bootAt load cpu mem psi disks net time failedUnits', 'host')
        has(h['cpu'], 'pct iowaitPct stealPct windowS', 'host.cpu')
        has(h['mem'], 'totalB availableB swapTotalB swapUsedB', 'host.mem')
        has(h['psi'], 'cpuSome10 memSome10 ioSome10', 'host.psi')
        has(h['net'], 'iface rxB txB rxBps txBps', 'host.net')
        has(h['time'], 'ntpSynced tz', 'host.time')
        for disk in h['disks']:
            has(disk, 'mount fs sizeB usedB availB usedPct inodesPct', 'host.disks[]')
            for key in ('sizeB', 'usedB', 'availB'):
                integer(disk[key], 'disk.' + key)
        for key in ('totalB', 'availableB', 'swapTotalB', 'swapUsedB'):
            integer(h['mem'][key], 'mem.' + key)
        u = doc['updates']
        has(u, 'upgradable security packages rebootRequired rebootSince rebootPkgs unattended', 'updates')
        has(u['unattended'], 'enabled lastRunAt lastSuccessAt', 'updates.unattended')
        s = doc['security']
        has(s['ufw'], 'active defaultIncoming defaultOutgoing defaultRouted allowIn rules', 'security.ufw')
        has(s['ssh'], 'passwordAuth permitRootLogin fail2ban failures24h topSources', 'security.ssh')
        for cert in doc['tls']['certs']:
            has(cert, 'name notBefore notAfter issuer', 'tls.certs[]')
        b = doc['backups']
        has(b, 'dir exists count totalB newest cron cronLogTail', 'backups')
        has(b['cron'], 'backup rotate', 'backups.cron')
        d = doc['docker']
        has(d, 'engine containers volumes systemDf', 'docker')
        for c in d['containers']:
            has(c, 'name service project image imageId state health failingStreak lastHealth startedAt restartCount '
                   'oomKilled restartPolicy cpuPct memB memLimitB netRxB netTxB blkReadB blkWriteB pids', 'container')
            for key in ('memB', 'memLimitB', 'netRxB', 'netTxB', 'blkReadB', 'blkWriteB'):
                integer(c[key], 'container.' + key)
        for v in d['volumes']:
            has(v, 'name sizeB', 'volume')
        has(d['systemDf'], 'imagesB imagesReclaimableB volumesB buildCacheB', 'systemDf')
        srv = doc['server']
        has(srv, 'health image startup processes stderr', 'server')
        has(srv['health']['probe'], 'available ok pid ms error', 'server.health.probe')
        has(srv['image'], 'tag version revision created', 'server.image')
        has(srv['startup'], 'containerId startedAt complete kernel warm warmFailures', 'server.startup')
        for p in srv['processes']:
            has(p, 'kind pid elapsedS rssB cpuPct port token', 'process')
            integer(p['rssB'], 'process.rssB')
        has(srv['stderr'], 'windowS friction warmFailures', 'server.stderr')
        cad = doc['caddy']
        has(cad['window'], 'from to byStatus denied errors lastErrors', 'caddy.window')
        has(cad['last15m'], 'byStatus denied', 'caddy.last15m')
        has(cad['today'], 'date byStatus denied', 'caddy.today')
        for row in cad['window']['denied'] + cad['last15m']['denied'] + cad['today']['denied']:
            has(row, 'ip status path count', 'caddy denied row')
        for c in doc['coolify']['containers']:
            has(c, 'name state restartPolicy', 'coolify')

    def test_no_customer_data_secret_or_header_reaches_host_json_or_state(self):
        self.collect(RUN1)
        self.collect(RUN2)
        with open(self.path('host.json'), encoding='utf-8') as handle:
            text = handle.read()
        state = self.state_text()
        for sentinel in SENTINELS:
            self.assertNotIn(sentinel, text, sentinel)
            self.assertNotIn(sentinel, state, sentinel)
        self.assertNotIn('"Output"', text)
        self.assertNotIn('"headers"', text + state)


# --------------------------------------------------------------------------------------------- one section failing

class SectionFailureTests(Base):
    """Each section fails alone (missing file, timeout, exit 1, garbage output) and the others stay intact. coolify
    cannot fail alone: it is read from docker's listing and fails with docker (covered by the docker case)."""

    @classmethod
    def setUpClass(cls):
        cls.base_tmp = tempfile.mkdtemp(prefix='collect-base-')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = collect.main(['--fixture-host', LINUX, '--fixture-docker', DOCKER, '--now', RUN1,
                                 '--out', os.path.join(cls.base_tmp, 'host.json'),
                                 '--state', os.path.join(cls.base_tmp, 'state')])
        assert code == 0
        with open(os.path.join(cls.base_tmp, 'host.json'), encoding='utf-8') as handle:
            cls.baseline = json.load(handle)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.base_tmp, True)

    def failing(self, mutate, failed, intact_except=()):
        host = self.copy(LINUX, 'host-fixture')
        docker = self.copy(DOCKER, 'docker-fixture')
        mutate(host, docker)
        doc = self.collect(RUN1, host=host, docker=docker)
        for name, code in failed.items():
            self.assertEqual(doc[name], {'ok': False, 'error': code, 'at': RUN1}, name)
            self.assertIn('%s: %s' % (name, code), doc['collector']['errors'])
        for name in collect.SECTION_ORDER:
            if name not in failed and name not in intact_except:
                self.assertEqual(doc[name], self.baseline[name], '%s changed when another section failed' % name)
        return doc

    def test_host_missing_meminfo(self):
        self.failing(lambda h, d: os.remove(os.path.join(h, 'proc_meminfo')), {'host': 'NOT_FOUND'})

    def test_host_garbage_proc_stat(self):
        self.failing(lambda h, d: self.write(os.path.join(h, 'proc_stat_1'), 'garbage\n'), {'host': 'PARSE'})

    def test_updates_timeout(self):
        self.failing(lambda h, d: self.write(os.path.join(h, 'apt_upgradable.txt.error'), 'TIMEOUT'),
                     {'updates': 'TIMEOUT'})

    def test_security_exit_1(self):
        self.failing(lambda h, d: self.write(os.path.join(h, 'ufw_status_verbose.txt.error'), 'EXIT_1'),
                     {'security': 'EXIT_1'})

    def test_security_garbage(self):
        self.failing(lambda h, d: self.write(os.path.join(h, 'ufw_status_verbose.txt'), 'ERROR: you need root\n'),
                     {'security': 'PARSE'})

    def test_tls_permission(self):
        self.failing(lambda h, d: self.write(os.path.join(h, 'certs.error'), 'PERMISSION'), {'tls': 'PERMISSION'})

    def test_tls_garbage(self):
        self.failing(lambda h, d: self.write(os.path.join(h, 'certs', 'ssam.example.com.txt'), 'unable to load\n'),
                     {'tls': 'PARSE'})

    def test_backups_permission(self):
        self.failing(lambda h, d: self.write(os.path.join(h, 'backups.error'), 'PERMISSION'),
                     {'backups': 'PERMISSION'})

    def test_docker_timeout_takes_server_caddy_and_coolify_along(self):
        self.failing(lambda h, d: self.write(os.path.join(d, 'ps.jsonl.error'), 'TIMEOUT'),
                     {'docker': 'TIMEOUT', 'server': 'TIMEOUT', 'caddy': 'TIMEOUT', 'coolify': 'TIMEOUT'})

    def test_server_container_missing(self):
        def mutate(h, d):
            with open(os.path.join(d, 'ps.jsonl'), encoding='utf-8') as handle:
                rows = [line for line in handle if 'ssam-prod-ssam-server-1' not in line]
            self.write(os.path.join(d, 'ps.jsonl'), ''.join(rows))
        doc = self.failing(mutate, {'server': 'NOT_FOUND'}, intact_except=('docker',))
        self.assertTrue(doc['docker']['ok'])
        self.assertEqual([c['service'] for c in doc['docker']['containers']], ['caddy'])

    def test_caddy_logs_exit_1(self):
        self.failing(lambda h, d: self.write(os.path.join(d, CADDY_LOG + '.error'), 'EXIT_1'), {'caddy': 'EXIT_1'})

    def test_caddy_garbage_lines_are_skipped_not_fatal(self):
        def mutate(h, d):
            self.write(os.path.join(d, CADDY_LOG + '.out'), stamped('2026-10-12T02:50:10Z', '{"broken": ') +
                       stamped('2026-10-12T02:50:11Z', '[1, 2, 3]') + stamped('2026-10-12T02:50:12Z', 'plain text'))
            self.write(os.path.join(d, CADDY_LOG + '.err'), '')
        doc = self.failing(mutate, {}, intact_except=('caddy',))
        self.assertTrue(doc['caddy']['ok'])
        self.assertEqual(doc['caddy']['window']['byStatus'], {})
        self.assertEqual(doc['caddy']['window']['errors'], 0)

    def test_side_probes_become_null_and_a_collector_error(self):
        def mutate(h, d):
            os.remove(os.path.join(h, 'sshd_T.txt'))
            self.write(os.path.join(d, 'stats.jsonl.error'), 'TIMEOUT')
            self.write(os.path.join(d, 'top.txt'), 'nonsense\n')
            os.remove(os.path.join(d, 'health.json'))
        doc = self.failing(mutate, {}, intact_except=('security', 'docker', 'server'))
        self.assertTrue(doc['security']['ok'] and doc['docker']['ok'] and doc['server']['ok'])
        self.assertIsNone(doc['security']['ssh']['passwordAuth'])
        self.assertEqual(doc['security']['ssh']['failures24h'], 40)
        self.assertIsNone(doc['docker']['containers'][0]['cpuPct'])
        self.assertIsNone(doc['server']['processes'])
        self.assertEqual(doc['server']['health']['probe'],
                         {'available': False, 'ok': False, 'pid': None, 'ms': None, 'error': 'UNREACHABLE'})
        errors = doc['collector']['errors']
        for expected in ('security.sshd: NOT_FOUND', 'docker.stats: TIMEOUT', 'server.processes: PARSE'):
            self.assertIn(expected, errors)


# ------------------------------------------------------------------------------------------------------------ rates

class RateTests(Base):
    def test_first_run_has_null_rates_and_the_second_has_them(self):
        first = self.collect(RUN1)['host']
        self.assertEqual(first['cpu'], {'pct': None, 'iowaitPct': None, 'stealPct': None, 'windowS': None})
        self.assertIsNone(first['net']['rxBps'])
        self.assertIsNone(first['net']['txBps'])
        self.assertIsInstance(first['net']['rxB'], int)
        second = self.collect(RUN2)['host']
        self.assertEqual(second['cpu'], {'pct': 1.2, 'iowaitPct': 0.0, 'stealPct': 0.5, 'windowS': 30})
        self.assertEqual((second['net']['rxBps'], second['net']['txBps']), (1830, 410))

    def test_a_gap_longer_than_ten_minutes_gives_null_rates(self):
        self.collect(RUN1)
        later = self.collect(iso_plus(RUN1, 630))['host']
        self.assertIsNone(later['cpu']['pct'])
        self.assertIsNone(later['net']['rxBps'])

    def test_counters_going_back_after_a_reboot_give_null_rates(self):
        host = self.copy(LINUX, 'host-fixture')
        for name in ('proc_stat', 'proc_net_dev'):
            first, second = os.path.join(host, name + '_1'), os.path.join(host, name + '_2')
            os.replace(first, first + '.x')
            os.replace(second, first)
            os.replace(first + '.x', second)
        self.collect(RUN1, host=host)
        later = self.collect(RUN2, host=host)['host']
        self.assertIsNone(later['cpu']['pct'])
        self.assertIsNone(later['net']['rxBps'])


# ------------------------------------------------------------------------------------------------------------ caddy

class CaddyWindowTests(Base):
    def docker_with_caddy(self, lines):
        docker = self.copy(DOCKER, 'docker-caddy')
        self.write(os.path.join(docker, CADDY_LOG + '.out'), ''.join(lines))
        self.write(os.path.join(docker, CADDY_LOG + '.err'), '')
        return docker

    def test_first_window_is_35_seconds(self):
        caddy = self.collect(RUN1)['caddy']
        self.assertEqual(caddy['window']['from'], iso_plus(RUN1, -35))
        self.assertEqual(caddy['window']['to'], RUN1)

    def test_window_last15m_and_today_roll_over_at_local_midnight(self):
        # 02:59:50Z = 23:59:50 in America/Sao_Paulo (10/11); 03:00:20Z = 00:00:20 the next local day.
        docker = self.docker_with_caddy([
            access('2026-10-12T02:59:30Z', 401, '203.0.113.10'),
            access('2026-10-12T02:59:40Z', 200, '198.51.100.20', '/health'),
            access('2026-10-12T02:59:55Z', 401, '203.0.113.10'),
            access('2026-10-12T03:00:05Z', 401, '203.0.113.30', '/mcp?x=SENTINEL-QUERY'),
            access('2026-10-12T03:00:10Z', 200, '198.51.100.20', '/health'),
            access('2026-10-12T03:10:00Z', 401, '203.0.113.50'),
            access('2026-10-12T03:20:00Z', 404, '203.0.113.40', '/wp-login.php'),
        ])
        a = self.collect('2026-10-12T02:59:50Z', docker=docker)['caddy']
        self.assertEqual(a['today']['date'], '2026-10-11')
        self.assertEqual(a['today']['byStatus'], {'200': 1, '401': 1})

        b = self.collect('2026-10-12T03:00:20Z', docker=docker)['caddy']
        self.assertEqual(b['window']['from'], '2026-10-12T02:59:50Z')
        self.assertEqual(b['window']['byStatus'], {'200': 1, '401': 2})
        self.assertEqual(b['today']['date'], '2026-10-12')
        self.assertEqual(b['today']['byStatus'], {'200': 1, '401': 1}, 'the 02:59:55Z line belongs to yesterday')
        self.assertEqual(b['today']['denied'], [{'ip': '203.0.113.30', 'status': 401, 'path': '/mcp', 'count': 1}])
        self.assertEqual(b['last15m']['byStatus'], {'200': 2, '401': 3})
        self.assertEqual(b['last15m']['denied'], [
            {'ip': '203.0.113.10', 'status': 401, 'path': '/mcp', 'count': 2},
            {'ip': '203.0.113.30', 'status': 401, 'path': '/mcp', 'count': 1}])

        # Half an hour later: the window starts at most 15 min back, and last15m forgets the old windows.
        c = self.collect('2026-10-12T03:30:00Z', docker=docker)['caddy']
        self.assertEqual(c['window']['from'], '2026-10-12T03:15:00Z')
        self.assertEqual(c['window']['byStatus'], {'404': 1})
        self.assertEqual(c['last15m']['byStatus'], {'404': 1})
        self.assertEqual(c['today']['byStatus'], {'200': 1, '401': 1, '404': 1})
        text = json.dumps(c) + self.state_text()
        self.assertNotIn('SENTINEL', text)

    def test_a_line_on_the_boundary_of_two_windows_counts_once(self):
        docker = self.docker_with_caddy([access(RUN1, 401, '203.0.113.10')])
        first = self.collect(RUN1, docker=docker)['caddy']
        second = self.collect(RUN2, docker=docker)['caddy']
        self.assertEqual(first['window']['byStatus'], {'401': 1})
        self.assertEqual(second['window']['byStatus'], {})
        self.assertEqual(second['last15m']['byStatus'], {'401': 1})


# ---------------------------------------------------------------------------------------------------- startup capture

class StartupTests(Base):
    STARTED = '2026-10-11T22:36:14Z'
    KERNEL = {'time': '2026-10-11T22:36:14.542Z', 'event': 'kernel',
              'kernel': {'o11': '11.55.91', 'odc': '1.7.27', 'odcBridge': 'v48', 'o11Hook': None,
                         'odcBridgeAccepted': ['v45']}}
    LISTENING = {'time': '2026-10-11T22:36:14.550Z', 'event': 'listening', 'pid': 7, 'mode': 'hosted'}
    SESSION = {'time': '2026-10-11T22:37:00.000Z', 'event': 'session-opened', 'token': 'tok_0000000a1fa0',
               'customer': 'Cliente Alfa', 'session': '00000000-0000-4000-8000-00000000000a', 'ip': '203.0.113.9'}
    WARM = {'time': '2026-10-11T22:38:42.454Z', 'event': 'warm', 'ms': 148000, 'note': 'SENTINEL-NOTE',
            'indexes': {'ok': True, 'lanes': {'odc': {'ok': True, 'cache': 'hit', 'ms': 900}}},
            'delivery': {'builder': {'ok': True, 'pid': 41}, 'worker': {'ok': True}}}

    def server_logs(self, docker, events, stderr=''):
        self.write(os.path.join(docker, SERVER_LOG + '.out'), ''.join(stamped(e['time'], e) for e in events))
        self.write(os.path.join(docker, SERVER_LOG + '.err'), stderr)

    def test_capture_waits_for_warm_then_keeps_it(self):
        docker = self.copy(DOCKER, 'docker-startup')
        self.server_logs(docker, [self.KERNEL, self.LISTENING, self.SESSION])
        early = self.collect('2026-10-11T22:41:14Z', docker=docker)['server']['startup']
        self.assertFalse(early['complete'])
        self.assertEqual(early['kernel']['kernel']['odcBridge'], 'v48')
        self.assertIsNone(early['warm'])

        long_error = 'E' * 300
        self.server_logs(docker, [self.KERNEL, self.LISTENING, self.SESSION, self.WARM],
                         stamped('2026-10-11T22:38:00Z', {'ssam': 'warm', 'lane': 'odc', 'error': long_error}))
        done = self.collect('2026-10-11T22:42:14Z', docker=docker)['server']['startup']
        self.assertTrue(done['complete'])
        self.assertEqual(done['warm']['ms'], 148000)
        self.assertEqual(done['warm']['time'], '2026-10-11T22:38:42.454Z')
        self.assertNotIn('note', done['warm'])
        self.assertEqual(done['warmFailures'], [{'lane': 'odc', 'error': 'E' * 200}])

        # Complete: never read again (the logs going away or failing changes nothing).
        os.remove(os.path.join(docker, SERVER_LOG + '.out'))
        self.assertEqual(self.collect('2026-10-11T22:42:44Z', docker=docker)['server']['startup'], done)
        self.write(os.path.join(docker, SERVER_LOG + '.error'), 'EXIT_1')
        self.assertEqual(self.collect('2026-10-11T22:43:14Z', docker=docker)['server']['startup'], done)
        text = json.dumps(done) + self.state_text()
        for sentinel in ('Cliente Alfa', 'tok_0000000a1fa0', '00000000-0000-4000', 'SENTINEL'):
            self.assertNotIn(sentinel, text)

    def test_a_new_start_is_captured_again(self):
        docker = self.copy(DOCKER, 'docker-restart')
        self.server_logs(docker, [self.KERNEL, self.LISTENING, self.WARM])
        first = self.collect('2026-10-11T22:42:14Z', docker=docker)['server']['startup']
        self.assertTrue(first['complete'])
        with open(os.path.join(docker, 'inspect.json'), encoding='utf-8') as handle:
            records = json.load(handle)
        for record in records:
            if record['Name'] == '/ssam-prod-ssam-server-1':
                record['State']['StartedAt'] = '2026-10-11T23:00:00.000000000Z'
        self.write(os.path.join(docker, 'inspect.json'), json.dumps(records))
        kernel = dict(self.KERNEL, time='2026-10-11T23:00:00.400Z')
        kernel['kernel'] = dict(self.KERNEL['kernel'], odcBridge='v49')
        self.server_logs(docker, [self.KERNEL, self.LISTENING, self.WARM, kernel])
        again = self.collect('2026-10-11T23:01:00Z', docker=docker)['server']['startup']
        self.assertEqual(again['startedAt'], '2026-10-11T23:00:00Z')
        self.assertFalse(again['complete'])
        self.assertEqual(again['kernel']['kernel']['odcBridge'], 'v49')
        self.assertIsNone(again['warm'])

    def test_complete_after_15_minutes_without_warm(self):
        docker = self.copy(DOCKER, 'docker-cold')
        self.server_logs(docker, [self.KERNEL, self.LISTENING])
        startup = self.collect(iso_plus(self.STARTED, 15 * 60 + 5), docker=docker)['server']['startup']
        self.assertTrue(startup['complete'])
        self.assertIsNone(startup['warm'])
        self.assertIsNotNone(startup['kernel'])


# ------------------------------------------------------------------------------------------- process classification

class ProcessTests(unittest.TestCase):
    CASES = [
        ('/sbin/docker-init -- ssam-server-start', None),
        ('node facade/ssam.mjs serve --host 0.0.0.0 --allow-remote --port 7310 --log-file /data/server/server.log '
         '--public-host ssam.example.com', {'kind': 'server', 'port': 7310, 'token': None}),
        ('dotnet /app/kernel/.local/lane-odc/cli/anvil-odc.dll serve --port 18547 --log-dir /app/kernel/.local/lane-odc',
         {'kind': 'odc-worker', 'port': 18547, 'token': None}),
        ('dotnet /app/kernel/.local/lane-o11/cli/anvil.dll serve --port 18600 '
         '--root /data/server/customers/tok_0123456789ab/o11/tmp/o11-worker-1',
         {'kind': 'o11-worker', 'port': 18600, 'token': 'tok_0123456789ab'}),
        ('dotnet /app/kernel/.local/lane-o11/cli/anvil.dll serve --port=18601',
         {'kind': 'o11-worker', 'port': 18601, 'token': None}),
        ('dotnet /studio/builder/Builder.dll --pipe x', {'kind': 'builder', 'port': None, 'token': None}),
        ('/bin/sh -c sleep 5', {'kind': 'other', 'port': None, 'token': None, 'name': 'sh'}),
    ]

    def test_classification(self):
        for args, expected in self.CASES:
            self.assertEqual(collect.classify_process(args), expected, args)

    def test_processes_keep_no_argument(self):
        header = 'PID ELAPSED RSS %CPU COMMAND\n'
        rows = ''.join('%d %d %d 0.1 %s\n' % (100 + i, 50 + i, 1000 + i, args) for i, (args, _) in enumerate(self.CASES))

        class FakeDocker:
            def top(self, record):
                return header + rows

        ctx = types.SimpleNamespace(docker=FakeDocker())
        processes = collect.server_processes(ctx, {'Id': 'x'})
        self.assertEqual([p['kind'] for p in processes],
                         ['server', 'odc-worker', 'o11-worker', 'o11-worker', 'builder', 'other'])
        for p in processes:
            self.assertLessEqual(set(p), {'kind', 'pid', 'elapsedS', 'rssB', 'cpuPct', 'port', 'token', 'name'})
            self.assertEqual(p['rssB'] % 1024, 0)
        text = json.dumps(processes)
        for fragment in ('--log-file', 'server.log', 'ssam.example.com', '/customers/', 'facade', 'dotnet', 'sleep'):
            self.assertNotIn(fragment, text)


# ------------------------------------------------------------------------------------------------ read-path allowlist

class FakeSystem:
    """The VPS as the real code paths see it (HostReal, DockerReal): patched open, os.scandir, os.stat, os.statvfs,
    os.uname and subprocess.run answer from the fixtures and record every path and command."""

    FORBIDDEN = ('.env', 'tokens.json', 'kernel.json', '/customers/', '.key', 'access.key', 'machine-pins',
                 'server.log', 'audit-', 'segredo')
    FILES = {
        '/proc/stat': 'proc_stat_1', '/proc/meminfo': 'proc_meminfo', '/proc/loadavg': 'proc_loadavg',
        '/proc/uptime': 'proc_uptime_1', '/proc/pressure/cpu': 'proc_pressure_cpu',
        '/proc/pressure/memory': 'proc_pressure_memory', '/proc/pressure/io': 'proc_pressure_io',
        '/proc/net/dev': 'proc_net_dev_1', '/proc/mounts': 'proc_mounts', '/etc/os-release': 'os_release',
        '/var/run/reboot-required.pkgs': 'reboot-required.pkgs',
    }
    ABSENT = ('/etc/cron.d/ssam-backup', '/etc/cron.d/ssam-rotate')
    COMMANDS = {
        ('timedatectl', 'show'): 'timedatectl.txt', ('systemctl', '--failed'): 'systemctl_failed.txt',
        ('apt', 'list'): 'apt_upgradable.txt', ('systemctl', 'is-enabled'): 'unattended_enabled.txt',
        ('ufw', 'status'): 'ufw_status_verbose.txt', ('sshd', '-T'): 'sshd_T.txt',
        ('journalctl', '-u'): 'journal_ssh.txt', ('systemctl', 'show'): 'fail2ban_show.txt', ('du', '-s'): 'du.txt',
    }
    BACKUP_DIR = '/var/backups/ssam-server'
    CADDY_DATA = '/var/lib/docker/volumes/ssam-prod_caddy-data/_data'

    def __init__(self, certs_root, conf_path):
        self.certs_root = certs_root
        self.conf_path = conf_path
        self.opened, self.scanned, self.stated, self.argvs, self.violations, self.health = [], [], [], [], [], []
        self.real_open = open
        self.real_scandir = os.scandir
        with open(os.path.join(LINUX, 'mtimes.json'), encoding='utf-8') as handle:
            self.mtimes = json.load(handle)
        with open(os.path.join(LINUX, 'statvfs.json'), encoding='utf-8') as handle:
            self.vfs = json.load(handle)
        with open(os.path.join(DOCKER, 'inspect.json'), encoding='utf-8') as handle:
            self.inspect = json.load(handle)
        with open(os.path.join(DOCKER, 'volume_inspect.json'), encoding='utf-8') as handle:
            self.volumes = json.load(handle)
        with open(os.path.join(DOCKER, 'image_inspect.json'), encoding='utf-8') as handle:
            self.images = json.load(handle)

    def guard(self, kind, value):
        text = str(value)
        for word in self.FORBIDDEN:
            if word in text:
                self.violations.append('%s %s' % (kind, text))

    def fixture_text(self, name):
        with self.real_open(os.path.join(LINUX, name), encoding='utf-8') as handle:
            return handle.read()

    def docker_text(self, name):
        # No os.path.exists here: os.stat is patched while the collector runs.
        try:
            with self.real_open(os.path.join(DOCKER, name), encoding='utf-8') as handle:
                return handle.read()
        except FileNotFoundError:
            return ''

    # ---- patched functions
    def open(self, path, mode='r', *args, **kwargs):
        path = os.fspath(path)
        self.opened.append(path)
        self.guard('open', path)
        if path in self.FILES:
            return self.real_open(os.path.join(LINUX, self.FILES[path]), mode, *args, **kwargs)
        if path == self.conf_path:
            return self.real_open(path, mode, *args, **kwargs)
        if path.startswith(self.BACKUP_DIR + '/'):
            return self.real_open(os.path.join(LINUX, 'backups', path[len(self.BACKUP_DIR) + 1:]), mode, *args, **kwargs)
        raise FileNotFoundError(2, 'No such file', path)

    def scandir(self, path):
        path = os.fspath(path)
        self.scanned.append(path)
        self.guard('scandir', path)
        if path == self.BACKUP_DIR:
            return self.real_scandir(os.path.join(LINUX, 'backups'))
        if path.startswith(self.CADDY_DATA + '/caddy/certificates'):
            return self.real_scandir(self.certs_root + path[len(self.CADDY_DATA):])
        raise FileNotFoundError(2, 'No such file', path)

    def stat(self, path, *args, **kwargs):
        path = os.fspath(path)
        self.stated.append(path)
        self.guard('stat', path)
        if path in self.mtimes:
            return types.SimpleNamespace(st_mtime=collect.parse_time(self.mtimes[path]), st_dev=0, st_size=0)
        if path in self.vfs:
            return types.SimpleNamespace(st_mtime=0.0, st_dev=self.vfs[path]['dev'], st_size=0)
        raise FileNotFoundError(2, 'No such file', path)

    def statvfs(self, path):
        self.stated.append(path)
        v = self.vfs.get(path)
        if v is None:
            raise FileNotFoundError(2, 'No such file', path)
        return types.SimpleNamespace(f_frsize=v['frsize'], f_blocks=v['blocks'], f_bfree=v['bfree'],
                                     f_bavail=v['bavail'], f_files=v['files'], f_ffree=v['ffree'])

    @staticmethod
    def uname():
        return types.SimpleNamespace(sysname='Linux', nodename='vps-exemplo', release='7.0.0-34-generic')

    def http_health(self, ip, port, timeout):
        self.health.append((ip, port))
        return 200, b'{"ok":true,"pid":7}', 3

    def run(self, argv, **kwargs):
        if not isinstance(argv, list) or kwargs.get('shell'):
            self.violations.append('not an argv list or shell=True: %r' % (argv,))
        self.argvs.append(list(argv))
        for arg in argv:
            self.guard('argv', arg)
        out, err = self.answer(list(argv))
        return types.SimpleNamespace(
            returncode=0,
            stdout=out.encode('utf-8') if kwargs.get('stdout') == subprocess.PIPE else None,
            stderr=err.encode('utf-8') if kwargs.get('stderr') == subprocess.PIPE else None)

    def answer(self, argv):
        tool = argv[0]
        if tool == 'docker' and argv[1] == 'logs':
            since, until, cid = collect.parse_time(argv[3]), collect.parse_time(argv[5]), argv[6]
            name = next(o['Name'].lstrip('/') for o in self.inspect if o['Id'] == cid)
            return (self.pick(self.docker_text('logs-%s.out' % name), since, until),
                    self.pick(self.docker_text('logs-%s.err' % name), since, until))
        if tool == 'docker':
            return self.docker(argv[1:]), ''
        if tool == 'openssl':
            name = argv[-1].rsplit('/', 1)[-1]
            if not name.endswith('.crt'):
                self.violations.append('openssl on %s' % argv[-1])
            return self.fixture_text(os.path.join('certs', name[:-4] + '.txt')), ''
        key = (tool, argv[1] if len(argv) > 1 else '')
        if key in self.COMMANDS:
            return self.fixture_text(self.COMMANDS[key]), ''
        self.violations.append('unexpected command %r' % (argv,))
        return '', ''

    def docker(self, args):
        sub = args[0]
        if sub == 'version':
            return self.docker_text('version.txt')
        if sub == 'ps':
            return self.docker_text('ps.jsonl')
        if sub == 'inspect':
            if args[:4] != ['inspect', '--type', 'container', '--format'] or args[4] != collect.INSPECT_TEMPLATE:
                self.violations.append('docker inspect without the field template: %r' % (args[:5],))
            ids = set(args[5:])
            lines = []
            for obj in self.inspect:
                if obj['Id'] in ids:
                    reduced = collect.reduce_inspect(obj)
                    lines.append(json.dumps([reduced[name] for name, _ in collect.INSPECT_FIELDS]))
            return '\n'.join(lines) + '\n'
        if sub == 'stats':
            ids = set(args)
            return ''.join(line + '\n' for line in self.docker_text('stats.jsonl').splitlines()
                           if json.loads(line)['ID'] in ids)
        if sub == 'volume' and args[1] == 'ls':
            return self.docker_text('volume_ls.txt')
        if sub == 'volume' and args[1] == 'inspect':
            names = set(args[4:])
            return ''.join(json.dumps([v['Name'], v['Mountpoint']]) + '\n' for v in self.volumes if v['Name'] in names)
        if sub == 'system':
            return self.docker_text('system_df.jsonl')
        if sub == 'image':
            for image in self.images:
                if image['Id'] == args[-1]:
                    return json.dumps(image['Config']['Labels'])
            return 'null'
        if sub == 'top':
            return self.docker_text('top.txt')
        self.violations.append('unexpected docker command %r' % (args,))
        return ''

    @staticmethod
    def pick(text, since, until):
        kept = []
        for line in text.splitlines():
            stamp, _, rest = line.partition(' ')
            t = collect.parse_time(stamp)
            if t is not None and since <= t <= until:
                kept.append(rest)
        return '\n'.join(kept) + ('\n' if kept else '')


class ReadPathAllowlistTests(Base):
    def test_real_code_paths_read_only_the_allowlist(self):
        certs = self.path('caddy-data')
        domain_dir = os.path.join(certs, 'caddy', 'certificates', 'acme-v02.api.letsencrypt.org-directory',
                                  'ssam.example.com')
        self.write(os.path.join(domain_dir, 'ssam.example.com.crt'), 'PUBLIC CERTIFICATE\n')
        self.write(os.path.join(domain_dir, 'ssam.example.com.key'), 'SENTINEL-PRIVATE-KEY\n')
        self.write(os.path.join(domain_dir, 'ssam.example.com.json'), '{"sans": ["SENTINEL"]}\n')
        conf_path = self.path('collector.conf')
        shutil.copyfile(os.path.join(HOST_DIR, 'collector.conf.example'), conf_path)
        fake = FakeSystem(certs, conf_path)

        # The fixture-mode answer for the same instant: the real code paths must give the same document.
        fixture_doc = self.collect(RUN1, state='fixture-state', out='fixture.json')

        # The context (and its time zone, which may read the zone database) is built before the patches.
        deadline = collect.Deadline(30)
        runner = collect.Runner(deadline, {'LANG': 'C', 'LC_ALL': 'C'})
        ctx = collect.Ctx(collect.load_config(conf_path), None, None, collect.parse_time(RUN1),
                          collect.fresh_state(), deadline, False)
        with mock.patch.object(collect, 'open', fake.open, create=True), \
                mock.patch.object(collect.os, 'scandir', fake.scandir), \
                mock.patch.object(collect.os, 'stat', fake.stat), \
                mock.patch.object(collect.os, 'statvfs', fake.statvfs, create=True), \
                mock.patch.object(collect.os, 'uname', fake.uname, create=True), \
                mock.patch.object(collect.subprocess, 'run', fake.run), \
                mock.patch.object(collect, 'http_health', fake.http_health):
            conf = collect.load_config(conf_path)
            ctx.conf = conf
            ctx.host = collect.HostReal(runner, conf)
            ctx.docker = collect.DockerReal(runner, 'docker')
            doc = collect.collect(ctx)

        self.assertEqual(fake.violations, [])
        self.assertEqual(doc, fixture_doc)
        allowed_open = set(FakeSystem.FILES) | set(FakeSystem.ABSENT) | {conf_path, FakeSystem.BACKUP_DIR + '/cron.log'}
        self.assertLessEqual(set(fake.opened), allowed_open)
        cert_dirs = {p for p in fake.scanned if p.startswith(FakeSystem.CADDY_DATA + '/caddy/certificates')}
        self.assertLessEqual(set(fake.scanned), {FakeSystem.BACKUP_DIR} | cert_dirs)
        self.assertLessEqual(set(fake.stated), set(fake.mtimes) | set(collect.DISK_PATHS))
        tools = {argv[0] for argv in fake.argvs}
        self.assertLessEqual(tools, {'docker', 'timedatectl', 'systemctl', 'apt', 'ufw', 'sshd', 'journalctl', 'du',
                                     'openssl'})
        docker_subcommands = {argv[1] for argv in fake.argvs if argv[0] == 'docker'}
        self.assertLessEqual(docker_subcommands, {'version', 'ps', 'inspect', 'stats', 'volume', 'system', 'image',
                                                  'top', 'logs'})
        openssl = [argv for argv in fake.argvs if argv[0] == 'openssl']
        self.assertEqual(len(openssl), 1)
        self.assertTrue(openssl[0][-1].endswith('/ssam.example.com.crt'))
        self.assertEqual(fake.health, [('10.0.2.2', 7310)])
        self.assertNotIn('Env', collect.INSPECT_TEMPLATE)
        self.assertNotIn('{{json .Config}}', collect.INSPECT_TEMPLATE)
        self.assertNotIn('SENTINEL', json.dumps(doc))
        # The guard itself works (a negative control).
        probe = FakeSystem(certs, conf_path)
        probe.guard('open', '/var/lib/docker/volumes/ssam-prod_server-state/_data/tokens.json')
        self.assertEqual(len(probe.violations), 1)


# ------------------------------------------------------------------------------------------------------ atomic write

class AtomicWriteTests(Base):
    def setUp(self):
        super().setUp()
        self.target = self.path('host.json')
        with open(self.target, 'wb') as handle:
            handle.write(b'{"old":true}\n')

    def read(self):
        with open(self.target, 'rb') as handle:
            return handle.read()

    def test_a_reader_sees_the_old_file_until_the_complete_new_one_replaces_it(self):
        seen = {}
        real_replace = os.replace

        def spy(source, target):
            with open(source, 'rb') as handle:
                seen['tmp'] = handle.read()
            with open(target, 'rb') as handle:
                seen['target'] = handle.read()
            real_replace(source, target)

        with mock.patch.object(collect.os, 'replace', spy):
            collect.write_atomic(self.target, b'{"new":true}\n', 0o640)
        self.assertEqual(seen, {'tmp': b'{"new":true}\n', 'target': b'{"old":true}\n'})
        self.assertEqual(self.read(), b'{"new":true}\n')
        self.assertFalse(os.path.exists(self.target + '.tmp'))

    def test_a_failure_keeps_the_old_file_and_removes_the_temp(self):
        with mock.patch.object(collect.os, 'fsync', side_effect=OSError(5, 'EIO')):
            with self.assertRaises(OSError):
                collect.write_atomic(self.target, b'{"new":true}\n', 0o640)
        self.assertEqual(self.read(), b'{"old":true}\n')
        self.assertFalse(os.path.exists(self.target + '.tmp'))

    def test_fsync_chmod_and_chown_happen_before_the_rename(self):
        calls = []
        real_replace, real_fsync, real_chmod = os.replace, os.fsync, os.chmod

        def record(name, real):
            def wrapper(*args):
                calls.append(name)
                return real(*args) if real else None
            return wrapper

        with mock.patch.object(collect.os, 'replace', record('replace', real_replace)), \
                mock.patch.object(collect.os, 'fsync', record('fsync', real_fsync)), \
                mock.patch.object(collect.os, 'chmod', record('chmod', real_chmod)), \
                mock.patch.object(collect.os, 'chown', record('chown', None), create=True):
            collect.write_atomic(self.target, b'x', 0o640, gid=10001)
        self.assertEqual(calls[:4], ['fsync', 'chmod', 'chown', 'replace'])

    @unittest.skipUnless(os.name == 'posix', 'file modes are POSIX')
    def test_mode_0640(self):
        collect.write_atomic(self.target, b'x', 0o640)
        self.assertEqual(os.stat(self.target).st_mode & 0o777, 0o640)

    def test_main_reports_a_write_failure_and_leaves_no_partial_file(self):
        target = self.path('out', 'host.json')
        with mock.patch.object(collect, 'write_atomic', side_effect=OSError(28, 'ENOSPC')):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                code = collect.main(['--fixture-host', LINUX, '--fixture-docker', DOCKER, '--now', RUN1,
                                     '--out', target, '--state', self.path('state')])
        self.assertEqual(code, 1)
        self.assertFalse(os.path.exists(target))
        self.assertIn('could not write', stderr.getvalue())


# ------------------------------------------------------------------------------------------------ config and cadence

class ConfigTests(Base):
    def test_the_example_holds_the_defaults(self):
        self.assertEqual(collect.load_config(os.path.join(HOST_DIR, 'collector.conf.example')), collect.DEFAULTS)

    def test_unknown_key_or_bad_value_refused(self):
        for text in ('FOO=1\n', 'BACKUP_DIR=relative/dir\n', 'SERVER_PORT=99999\n', 'COMPOSE_PROJECT=a;b\n'):
            conf = self.path('bad.conf')
            self.write(conf, text)
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(collect.main(['--config', conf, '--fixture-host', LINUX, '--fixture-docker', DOCKER,
                                               '--out', self.path('h.json'), '--state', self.path('s')]), 2, text)

    def test_bad_now_refused(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(collect.main(['--now', 'yesterday', '--fixture-host', LINUX, '--fixture-docker', DOCKER,
                                           '--out', self.path('h.json'), '--state', self.path('s')]), 2)


class CadenceTests(Base):
    def test_sections_refresh_on_their_own_cadence(self):
        self.collect(RUN1)
        one_min = self.collect(iso_plus(RUN1, 60))
        self.assertEqual(one_min['host']['at'], iso_plus(RUN1, 60))
        self.assertEqual(one_min['docker']['at'], iso_plus(RUN1, 60))
        for name in ('security', 'backups', 'updates', 'tls'):
            self.assertEqual(one_min[name]['at'], RUN1, name)
        five_min = self.collect(iso_plus(RUN1, 301))
        self.assertEqual(five_min['security']['at'], iso_plus(RUN1, 301))
        self.assertEqual(five_min['backups']['at'], iso_plus(RUN1, 301))
        self.assertEqual(five_min['updates']['at'], RUN1)
        self.assertEqual(five_min['tls']['at'], RUN1)
        later = self.collect(iso_plus(RUN1, 1801))
        self.assertEqual(later['updates']['at'], iso_plus(RUN1, 1801))
        self.assertEqual(later['tls']['at'], RUN1)

    def test_a_failed_cached_section_is_retried_after_two_minutes(self):
        host = self.copy(LINUX, 'host-fixture')
        error = os.path.join(host, 'apt_upgradable.txt.error')
        self.write(error, 'TIMEOUT')
        self.assertEqual(self.collect(RUN1, host=host)['updates']['error'], 'TIMEOUT')
        os.remove(error)
        self.assertFalse(self.collect(iso_plus(RUN1, 60), host=host)['updates']['ok'])
        retried = self.collect(iso_plus(RUN1, 121), host=host)['updates']
        self.assertTrue(retried['ok'])
        self.assertEqual(retried['at'], iso_plus(RUN1, 121))

    def test_probe_available_survives_connection_errors(self):
        docker = self.copy(DOCKER, 'docker-probe')
        self.assertTrue(self.collect(RUN1, docker=docker)['server']['health']['probe']['available'])
        os.remove(os.path.join(docker, 'health.json'))
        probe = self.collect(RUN2, docker=docker)['server']['health']['probe']
        self.assertEqual((probe['available'], probe['ok'], probe['error']), (True, False, 'UNREACHABLE'))


if __name__ == '__main__':
    unittest.main()
