#!/usr/bin/env python3
# SSAM owner console - host collector. Owned by the SSAM-MCP monorepo (server/deploy/host); runbook DEPLOY.md section 15.
"""Host collector of the SSAM owner console ("Painel do dono").

Runs as root on the VPS every 30 s (systemd ssam-console-collect.timer), reads fixed host facts and the Docker state with
fixed argument lists (never a shell, never a command built from data, a timeout on every command) and writes ONE JSON
document, schema "ssam-console-host/1", to <OUT_DIR>/host.json: host.json.tmp + fsync + chmod 0640 + chown
root:CONSOLE_GID + os.replace. The console container (uid 10001, no network) mounts that folder read-only.
Python >= 3.10, standard library only, safe under `python3 -I`.

Never read here: the deploy .env, tokens.json, kernel.json, anything under customers/, any *.key, container environments
(docker inspect is asked only for the fields of INSPECT_FIELDS), HTTP headers in Caddy's access log, and any ssam-server
stdout line other than the `kernel` and `warm` events (every other line is tested for its event name and dropped). The
arguments of the server's processes are classified (server, workers, builder) and then dropped.

Every top-level section except schema, collectedAt and collector is {"ok": true, "at": <refresh time>, ...} or
{"ok": false, "error": TIMEOUT|NOT_FOUND|EXIT_<n>|PARSE|UNAVAILABLE|PERMISSION, "at": ...}. A section fails when its main
probe fails (host: /proc/stat, meminfo, loadavg, uptime; updates: apt list; security: ufw status; tls: the certificate
files; backups: the backup folder; docker: docker ps + inspect; server and caddy: their container, caddy also its log).
Side probes never fail their section: the value becomes null (lists: [] or, for server.processes, null) and
collector.errors names it ("host.time: NOT_FOUND"). server, caddy and coolify come from docker's listing: when docker
fails they fail with its code. Cadences (the result is cached in STATE_DIR and keeps its own "at"): host, docker, server,
caddy, coolify every run; security and backups 5 min; docker volumes, system df and engine 10 min; updates 30 min;
tls 1 h; a failed cached probe is retried after 2 min. The whole run keeps to a budget (default 22 s, below the unit's
TimeoutStartSec=25s): a command never gets more time than what is left.

Usage (the unit runs the first line):
  python3 -I collect.py --config /etc/ssam-console/collector.conf
  python3 -I collect.py [--config FILE] [--out FILE] [--state DIR] [--project NAME] [--now ISO] [--budget S]
                        [--fixture-host DIR] [--docker CLI | --fixture-docker DIR]
Fixture mode (tests and the Docker Desktop rehearsal, DESIGN 3.6 and 8.2): --fixture-host reads the host facts from files
(FIXTURE_FILES, FIXTURE_COMMANDS; a name_<k> file is read on run k; <name>.error holds an error code to raise),
--fixture-docker reads the Docker answers from files (DockerFixture), --docker keeps Docker real with another CLI path.
In fixture mode chown is skipped. --now freezes the clock (durationMs is then 0).
Exit code: 0 host.json written (sections may be ok:false), 1 not written, 2 bad arguments or configuration.
"""

from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request

try:  # POSIX only: one run at a time
    import fcntl
except ImportError:  # Windows: fixture mode and tests
    fcntl = None

SCHEMA = 'ssam-console-host/1'
STATE_SCHEMA = 'ssam-console-collector-state/1'
VERSION = '1'
INTERVAL_S = 30

DEFAULTS = {
    'COMPOSE_PROJECT': 'ssam-prod',
    'SERVER_SERVICE': 'ssam-server',
    'CADDY_SERVICE': 'caddy',
    'CONSOLE_SERVICE': 'ssam-console',
    'SERVER_PORT': '7310',
    'BACKUP_DIR': '/var/backups/ssam-server',
    'NET_IFACE': 'eth0',
    'OUT_DIR': '/var/lib/ssam-console/host',
    'STATE_DIR': '/var/lib/ssam-console/collector',
    'CONSOLE_GID': '10001',
    'DISPLAY_TZ': 'America/Sao_Paulo',
}

CADENCE_S = {'updates': 1800, 'security': 300, 'tls': 3600, 'backups': 300, 'docker-slow': 600}
RETRY_FAILED_S = 120
FIRST_WINDOW_S = 35
MAX_WINDOW_S = 900
LAST15M_S = 900
STARTUP_WINDOW_S = 900
RATE_MAX_GAP_S = 600
CMD_TIMEOUT_S = 10
BUDGET_S = 22.0
POSIX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
DISK_PATHS = ('/', '/boot', '/boot/efi', '/var/lib/docker')
ARCHIVE_RE = re.compile(r'^ssam-state-\d{8}T\d{6}Z\.tar\.gz$')
TOKEN_DIR_RE = re.compile(r'/customers/(tok_[0-9a-f]{12})/o11/tmp/o11-worker')
EVENT_RE = re.compile(r'"event"\s*:\s*"(kernel|warm)"')
SSAM_WARM_RE = re.compile(r'"ssam"\s*:\s*"warm"')
SSH_FAIL_RE = re.compile(r'Failed password|Invalid user|authentication failure')
SSH_FROM_RE = re.compile(r'\bfrom ([0-9A-Fa-f:.]{2,45})\b')
PROCESS_ORDER = {'server': 0, 'odc-worker': 1, 'o11-worker': 2, 'builder': 3, 'other': 4}

# docker inspect is asked for these fields only (Go template), so a container's Config.Env never reaches this process.
INSPECT_FIELDS = (
    ('Id', '.Id'),
    ('Name', '.Name'),
    ('State', '.State'),
    ('RestartCount', '.RestartCount'),
    ('Image', '.Image'),
    ('ConfigImage', '.Config.Image'),
    ('Labels', '.Config.Labels'),
    ('RestartPolicy', '.HostConfig.RestartPolicy'),
    ('Memory', '.HostConfig.Memory'),
    ('Networks', '.NetworkSettings.Networks'),
    ('Mounts', '.Mounts'),
)
INSPECT_TEMPLATE = '[' + ','.join('{{json %s}}' % expr for _, expr in INSPECT_FIELDS) + ']'
VOLUME_TEMPLATE = '[{{json .Name}},{{json .Mountpoint}}]'

# --fixture-host: host path -> file in the fixture folder; commands by their key.
FIXTURE_FILES = {
    '/proc/stat': 'proc_stat',
    '/proc/meminfo': 'proc_meminfo',
    '/proc/loadavg': 'proc_loadavg',
    '/proc/uptime': 'proc_uptime',
    '/proc/pressure/cpu': 'proc_pressure_cpu',
    '/proc/pressure/memory': 'proc_pressure_memory',
    '/proc/pressure/io': 'proc_pressure_io',
    '/proc/net/dev': 'proc_net_dev',
    '/proc/mounts': 'proc_mounts',
    '/etc/os-release': 'os_release',
    '/var/run/reboot-required.pkgs': 'reboot-required.pkgs',
    '/etc/cron.d/ssam-backup': 'cron.d/ssam-backup',
    '/etc/cron.d/ssam-rotate': 'cron.d/ssam-rotate',
}
FIXTURE_COMMANDS = {
    'timedatectl': 'timedatectl.txt',
    'failed-units': 'systemctl_failed.txt',
    'apt': 'apt_upgradable.txt',
    'unattended': 'unattended_enabled.txt',
    'ufw': 'ufw_status_verbose.txt',
    'sshd': 'sshd_T.txt',
    'journal-ssh': 'journal_ssh.txt',
    'fail2ban': 'fail2ban_show.txt',
    'du': 'du.txt',
}
ERROR_CODE_RE = re.compile(r'^(TIMEOUT|NOT_FOUND|PARSE|UNAVAILABLE|PERMISSION|EXIT_-?\d{1,3})$')


class ProbeError(Exception):
    """A probe failed; `code` is one of the codes of the host.json contract."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class ConfigError(Exception):
    pass


# ---------------------------------------------------------------------------------------------------------------- time

_ISO_RE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$')


def parse_time(text):
    """ISO 8601 / RFC 3339 (nanoseconds allowed) -> epoch seconds (float), or None."""
    if not isinstance(text, str):
        return None
    m = _ISO_RE.match(text.strip())
    if not m:
        return None
    year, month, day, hour, minute, second, frac, zone = m.groups()
    if int(year) < 1971:  # Docker's zero time (0001-01-01T00:00:00Z) = never
        return None
    try:
        base = dt.datetime(int(year), int(month), int(day), int(hour), int(minute), int(second), tzinfo=dt.timezone.utc)
    except ValueError:
        return None
    t = base.timestamp() + (int(frac[:6].ljust(6, '0')) / 1e6 if frac else 0.0)
    if zone and zone != 'Z':
        sign = 1 if zone[0] == '+' else -1
        t -= sign * (int(zone[1:3]) * 3600 + int(zone[-2:]) * 60)
    return t


def iso(t):
    """Epoch seconds -> 2026-10-12T02:51:00Z (UTC, whole seconds), None stays None."""
    if t is None:
        return None
    return dt.datetime.fromtimestamp(math.floor(t), dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def docker_time(t):
    """Epoch seconds -> RFC 3339 with microseconds, for docker logs --since/--until."""
    whole = math.floor(t)
    micro = int(round((t - whole) * 1e6))
    if micro >= 1000000:
        whole, micro = whole + 1, 0
    return dt.datetime.fromtimestamp(whole, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S') + '.%06dZ' % micro


def display_zone(name):
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:  # no time zone database (Windows without tzdata): Brazil has had no DST since 2019
        return dt.timezone(dt.timedelta(hours=-3)) if name == 'America/Sao_Paulo' else dt.timezone.utc


def local_date(t, zone):
    return dt.datetime.fromtimestamp(t, zone).strftime('%Y-%m-%d')


def window_start(previous, now):
    """Start of a log window: just after the previous run's end (docker logs --since and --until are both inclusive, so a
    line stamped exactly at the boundary is counted once), at most MAX_WINDOW_S back; FIRST_WINDOW_S on a first run."""
    if isinstance(previous, (int, float)) and previous < now:
        return previous + 1e-6 if now - previous <= MAX_WINDOW_S else now - MAX_WINDOW_S
    return now - FIRST_WINDOW_S


# ----------------------------------------------------------------------------------------------------- small helpers

def cap(value, n):
    """A string capped at n characters (control characters removed), anything else -> None."""
    if not isinstance(value, str):
        return None
    value = ''.join(ch for ch in value if ch >= ' ' and ch != '\x7f')
    return value[:n]


def as_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def as_num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def ceil_pct(part, whole):
    if whole <= 0:
        return None
    return -(-part * 100 // whole)


def text_of(data):
    return data.decode('utf-8', 'replace') if data else ''


_UNITS = {'b': 1, 'kb': 1000, 'mb': 1000 ** 2, 'gb': 1000 ** 3, 'tb': 1000 ** 4, 'pb': 1000 ** 5,
          'kib': 1024, 'mib': 1024 ** 2, 'gib': 1024 ** 3, 'tib': 1024 ** 4, 'pib': 1024 ** 5}


def parse_bytes(text):
    """Docker's human sizes ("376.3MiB", "1.26MB", "0B") -> integer bytes, or None."""
    if not isinstance(text, str):
        return None
    m = re.match(r'^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKMGTP]?i?B)\s*$', text)
    if not m:
        return None
    unit = _UNITS.get(m.group(2).lower())
    return int(round(float(m.group(1)) * unit)) if unit else None


def parse_pair(text):
    """"376.3MiB / 6GiB" -> (bytes, bytes)."""
    if not isinstance(text, str) or '/' not in text:
        return None, None
    left, right = text.split('/', 1)
    return parse_bytes(left), parse_bytes(right)


def parse_percent(text):
    if not isinstance(text, str):
        return None
    m = re.match(r'^\s*([0-9]+(?:\.[0-9]+)?)\s*%\s*$', text)
    return float(m.group(1)) if m else None


def optional(errors, label, fn, default=None):
    """A side probe: its failure becomes `default` and a collector error, never the section's failure."""
    try:
        return fn()
    except ProbeError as exc:
        errors.append('%s: %s' % (label, exc.code))
    except (ValueError, KeyError, IndexError, TypeError, AttributeError):
        errors.append('%s: PARSE' % label)
    return default


def loads_object(line):
    """One JSON object from an untrusted line, or None (lines over 64 KiB are skipped)."""
    if len(line) > 65536:
        return None
    line = line.strip()
    if not line.startswith('{'):
        return None
    try:
        value = json.loads(line)
    except (ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


# --------------------------------------------------------------------------------------------- commands and budget

class Deadline:
    def __init__(self, budget):
        self.end = time.monotonic() + budget

    def timeout(self, wanted):
        left = self.end - time.monotonic() - 0.5
        if left < 1:
            raise ProbeError('TIMEOUT')
        return min(wanted, left)


class Result:
    __slots__ = ('code', 'out', 'err')

    def __init__(self, code, out, err):
        self.code, self.out, self.err = code, out, err


class Runner:
    """Runs one fixed argv list (no shell) with a timeout; failures become ProbeError codes."""

    def __init__(self, deadline, env):
        self.deadline = deadline
        self.env = env

    def run(self, argv, timeout=CMD_TIMEOUT_S, ok=(0,), stdout=True, stderr=False):
        limit = self.deadline.timeout(timeout)
        try:
            proc = subprocess.run(
                list(argv), stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE if stdout else subprocess.DEVNULL,
                stderr=subprocess.PIPE if stderr else subprocess.DEVNULL,
                timeout=limit, env=self.env, check=False)
        except FileNotFoundError:
            raise ProbeError('NOT_FOUND') from None
        except PermissionError:
            raise ProbeError('PERMISSION') from None
        except subprocess.TimeoutExpired:
            raise ProbeError('TIMEOUT') from None
        except OSError:
            raise ProbeError('UNAVAILABLE') from None
        if proc.returncode not in ok:
            raise ProbeError('EXIT_%d' % proc.returncode)
        return Result(proc.returncode, text_of(proc.stdout), text_of(proc.stderr))


def subprocess_env():
    env = dict(os.environ)
    if os.name == 'posix':
        env['PATH'] = POSIX_PATH
    env['LANG'] = 'C'
    env['LC_ALL'] = 'C'
    for key in ('PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP'):
        env.pop(key, None)
    return env


def read_file(path, limit=1 << 20, tail=False):
    """Reads at most `limit` bytes of one file (the last ones with tail=True); errors become ProbeError codes."""
    try:
        with open(path, 'rb') as handle:
            if tail:
                handle.seek(0, 2)
                size = handle.tell()
                handle.seek(max(0, size - limit))
            return text_of(handle.read(limit))
    except FileNotFoundError:
        raise ProbeError('NOT_FOUND') from None
    except PermissionError:
        raise ProbeError('PERMISSION') from None
    except IsADirectoryError:
        raise ProbeError('UNAVAILABLE') from None
    except OSError:
        raise ProbeError('UNAVAILABLE') from None


def scan_dir(path):
    """[(name, is_file, is_dir, size, mtime)] of one folder, lstat only (no symlink followed), or None when missing."""
    try:
        with os.scandir(path) as it:
            rows = []
            for entry in it:
                try:
                    st = entry.stat(follow_symlinks=False)
                    rows.append((entry.name, entry.is_file(follow_symlinks=False),
                                 entry.is_dir(follow_symlinks=False), st.st_size, st.st_mtime))
                except OSError:
                    continue
            return rows
    except FileNotFoundError:
        return None
    except NotADirectoryError:
        return None
    except PermissionError:
        raise ProbeError('PERMISSION') from None
    except OSError:
        raise ProbeError('UNAVAILABLE') from None


def host_join(directory, name):
    return directory.rstrip('/') + '/' + name


# ------------------------------------------------------------------------------------------------------ host sources

class HostReal:
    """The VPS itself: /proc, a few files, fixed commands."""

    fixture = False

    def __init__(self, runner, conf):
        self.runner = runner
        self.backup_dir = conf['BACKUP_DIR']

    def read(self, path, limit=1 << 20):
        return read_file(path, limit)

    def mtime(self, path):
        try:
            return os.stat(path).st_mtime
        except FileNotFoundError:
            return None
        except PermissionError:
            raise ProbeError('PERMISSION') from None
        except OSError:
            raise ProbeError('UNAVAILABLE') from None

    def statvfs(self, path):
        try:
            st = os.stat(path)
            vfs = os.statvfs(path)
        except FileNotFoundError:
            return None
        except PermissionError:
            raise ProbeError('PERMISSION') from None
        except (OSError, AttributeError):
            raise ProbeError('UNAVAILABLE') from None
        return {'dev': st.st_dev, 'frsize': vfs.f_frsize, 'blocks': vfs.f_blocks, 'bfree': vfs.f_bfree,
                'bavail': vfs.f_bavail, 'files': vfs.f_files, 'ffree': vfs.f_ffree}

    def uname(self):
        try:
            u = os.uname()
        except AttributeError:
            raise ProbeError('UNAVAILABLE') from None
        return u.nodename, u.release

    def cmd(self, key, argv, timeout=CMD_TIMEOUT_S, ok=(0,)):
        return self.runner.run(argv, timeout=timeout, ok=ok).out

    def list_backups(self):
        return scan_dir(self.backup_dir)

    def read_backup(self, name, limit, tail=False):
        return read_file(host_join(self.backup_dir, name), limit, tail)

    def certs(self, mountpoint):
        """[(name, openssl text | ProbeError)] for <caddy-data>/caddy/certificates/*/*/*.crt; never a .key or .json."""
        if not mountpoint:
            raise ProbeError('UNAVAILABLE')
        root = host_join(mountpoint, 'caddy/certificates')
        found = []
        for issuer, _, is_dir, _, _ in scan_dir(root) or []:
            if not is_dir:
                continue
            issuer_dir = host_join(root, issuer)
            for domain, _, domain_is_dir, _, _ in scan_dir(issuer_dir) or []:
                if not domain_is_dir:
                    continue
                domain_dir = host_join(issuer_dir, domain)
                for name, is_file, _, _, _ in scan_dir(domain_dir) or []:
                    if is_file and name.endswith('.crt'):
                        found.append((name[:-4], host_join(domain_dir, name)))
        rows = []
        for name, path in sorted(found)[:20]:
            try:
                out = self.runner.run(['openssl', 'x509', '-noout', '-startdate', '-enddate', '-issuer', '-subject',
                                       '-in', path]).out
                rows.append((name, out))
            except ProbeError as exc:
                rows.append((name, exc))
        return rows


class HostFixture:
    """--fixture-host: the same answers from files (see FIXTURE_FILES and FIXTURE_COMMANDS)."""

    fixture = True

    def __init__(self, root, run_index, conf):
        self.root = root
        self.run_index = run_index
        self.backup_dir = conf['BACKUP_DIR']
        self._json_cache = {}

    def _path(self, name):
        error_file = os.path.join(self.root, name + '.error')
        if os.path.isfile(error_file):
            with open(error_file, encoding='utf-8') as handle:
                code = handle.read().strip()
            raise ProbeError(code if ERROR_CODE_RE.match(code) else 'EXIT_1')
        chosen = None
        for k in range(1, 10):
            candidate = os.path.join(self.root, '%s_%d' % (name, k))
            if k <= self.run_index and os.path.exists(candidate):
                chosen = candidate
        path = chosen or os.path.join(self.root, name)
        if not os.path.exists(path):
            raise ProbeError('NOT_FOUND')
        return path

    def _json(self, name):
        if name not in self._json_cache:
            try:
                with open(self._path(name), encoding='utf-8') as handle:
                    self._json_cache[name] = json.load(handle)
            except ProbeError:
                self._json_cache[name] = {}
        return self._json_cache[name]

    def read(self, path, limit=1 << 20):
        name = FIXTURE_FILES.get(path)
        if name is None:
            raise ProbeError('NOT_FOUND')
        return read_file(self._path(name), limit)

    def mtime(self, path):
        value = self._json('mtimes.json').get(path)
        return parse_time(value) if isinstance(value, str) else None

    def statvfs(self, path):
        value = self._json('statvfs.json').get(path)
        return dict(value) if isinstance(value, dict) else None

    def uname(self):
        lines = read_file(self._path('uname.txt')).split()
        if len(lines) < 2:
            raise ProbeError('PARSE')
        return lines[0], lines[1]

    def cmd(self, key, argv, timeout=CMD_TIMEOUT_S, ok=(0,)):
        return read_file(self._path(FIXTURE_COMMANDS[key]))

    def list_backups(self):
        if os.path.isfile(os.path.join(self.root, 'backups.error')):
            self._path('backups')  # raises the injected error
        rows = scan_dir(os.path.join(self.root, 'backups'))
        if rows is None:
            return None
        mtimes = self._json('mtimes.json')
        out = []
        for name, is_file, is_dir, size, mtime in rows:
            override = parse_time(mtimes.get(host_join(self.backup_dir, name), '') or '')
            out.append((name, is_file, is_dir, size, override if override is not None else mtime))
        return out

    def read_backup(self, name, limit, tail=False):
        return read_file(os.path.join(self.root, 'backups', name), limit, tail)

    def certs(self, mountpoint):
        if os.path.isfile(os.path.join(self.root, 'certs.error')):
            self._path('certs')  # raises the injected error
        rows = scan_dir(os.path.join(self.root, 'certs'))
        out = []
        for name, is_file, _, _, _ in sorted(rows or []):
            if is_file and name.endswith('.txt'):
                out.append((name[:-4], read_file(os.path.join(self.root, 'certs', name))))
        return out


# ---------------------------------------------------------------------------------------------------- docker sources

def reduce_inspect(obj):
    """The INSPECT_FIELDS of one full `docker inspect` object (fixture mode applies the template's selection)."""
    out = {}
    for name, expr in INSPECT_FIELDS:
        value = obj
        for part in expr.strip('.').split('.'):
            value = value.get(part) if isinstance(value, dict) else None
        out[name] = value
    return out


def http_health(ip, port, timeout):
    """GET http://<ip>:<port>/health without proxies -> (status, body bytes, ms); errors -> ProbeError-like codes."""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        raise ProbeError('NO_ADDRESS') from None
    host = '[%s]' % address if address.version == 6 else str(address)
    request = urllib.request.Request('http://%s:%d/health' % (host, port),
                                     headers={'User-Agent': 'ssam-console-collector/1'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    started = time.monotonic()
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(4096)
            status = response.status
    except urllib.error.HTTPError as exc:
        return exc.code, b'', int((time.monotonic() - started) * 1000)
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, ConnectionRefusedError):
            raise ProbeError('REFUSED') from None
        if isinstance(reason, TimeoutError):
            raise ProbeError('TIMEOUT') from None
        raise ProbeError('UNREACHABLE') from None
    except TimeoutError:
        raise ProbeError('TIMEOUT') from None
    except OSError:
        raise ProbeError('UNREACHABLE') from None
    return status, body, int((time.monotonic() - started) * 1000)


class DockerReal:
    """The Docker CLI with fixed argument lists."""

    def __init__(self, runner, cli):
        self.runner = runner
        self.cli = cli

    def _run(self, args, timeout=CMD_TIMEOUT_S, ok=(0,), stdout=True, stderr=False):
        return self.runner.run([self.cli] + list(args), timeout=timeout, ok=ok, stdout=stdout, stderr=stderr)

    def version(self):
        return self._run(['version', '--format', '{{.Server.Version}}']).out.strip()

    def ps(self):
        rows = []
        for line in self._run(['ps', '-a', '--no-trunc', '--format', '{{json .}}']).out.splitlines():
            obj = loads_object(line)
            if obj is not None:
                rows.append(obj)
        return rows

    def inspect(self, ids):
        result = self._run(['inspect', '--type', 'container', '--format', INSPECT_TEMPLATE] + list(ids), ok=(0, 1))
        records = []
        for line in result.out.splitlines():
            line = line.strip()
            if not line.startswith('['):
                continue
            try:
                values = json.loads(line)
            except ValueError:
                continue
            if isinstance(values, list) and len(values) == len(INSPECT_FIELDS):
                records.append({name: value for (name, _), value in zip(INSPECT_FIELDS, values)})
        if result.code != 0 and not records:
            raise ProbeError('EXIT_%d' % result.code)
        return records

    def stats(self, ids):
        out = self._run(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}'] + list(ids)).out
        return [obj for obj in (loads_object(line) for line in out.splitlines()) if obj is not None]

    def volumes(self, project):
        out = self._run(['volume', 'ls', '--filter', 'label=com.docker.compose.project=%s' % project,
                         '--format', '{{.Name}}']).out
        return [line.strip() for line in out.splitlines() if line.strip()]

    def volume_mounts(self, names):
        out = self._run(['volume', 'inspect', '--format', VOLUME_TEMPLATE] + list(names)).out
        mounts = {}
        for line in out.splitlines():
            try:
                name, mountpoint = json.loads(line)
            except (ValueError, TypeError):
                continue
            if isinstance(name, str) and isinstance(mountpoint, str):
                mounts[name] = mountpoint
        return mounts

    def system_df(self):
        out = self._run(['system', 'df', '--format', '{{json .}}']).out
        return [obj for obj in (loads_object(line) for line in out.splitlines()) if obj is not None]

    def image_labels(self, image_id):
        out = self._run(['image', 'inspect', '--format', '{{json .Config.Labels}}', image_id]).out.strip()
        try:
            labels = json.loads(out) if out else None
        except ValueError:
            raise ProbeError('PARSE') from None
        return labels if isinstance(labels, dict) else {}

    def top(self, record):
        return self._run(['top', record['Id'], '-eo', 'pid,etimes,rss,pcpu,args']).out

    def logs(self, record, since, until, stdout=True, stderr=True):
        result = self._run(['logs', '--since', docker_time(since), '--until', docker_time(until), record['Id']],
                           timeout=CMD_TIMEOUT_S, stdout=stdout, stderr=stderr)
        return result.out, result.err

    def health(self, ip, port, deadline):
        return http_health(ip, port, deadline.timeout(4))


class DockerFixture:
    """--fixture-docker DIR: version.txt, ps.jsonl, inspect.json (full objects), stats.jsonl, volume_ls.txt,
    volume_inspect.json, system_df.jsonl, image_inspect.json, top.txt, logs-<container>.out|.err (each line prefixed by
    the Docker timestamp, as `docker logs --timestamps` prints it; --since/--until filter on it), health.json
    ({"status", "body", "ms"}). <file>.error holds an error code to raise."""

    def __init__(self, root):
        self.root = root

    def _file(self, name, required=True):
        error_file = os.path.join(self.root, name + '.error')
        if os.path.isfile(error_file):
            with open(error_file, encoding='utf-8') as handle:
                code = handle.read().strip()
            raise ProbeError(code if (ERROR_CODE_RE.match(code) or code in ('REFUSED', 'UNREACHABLE')) else 'EXIT_1')
        path = os.path.join(self.root, name)
        if not os.path.exists(path):
            if required:
                raise ProbeError('NOT_FOUND')
            return ''
        return read_file(path, 64 << 20)

    def _json(self, name):
        try:
            return json.loads(self._file(name))
        except ValueError:
            raise ProbeError('PARSE') from None

    def version(self):
        return self._file('version.txt').strip()

    def ps(self):
        return [obj for obj in (loads_object(line) for line in self._file('ps.jsonl').splitlines()) if obj]

    def inspect(self, ids):
        wanted = set(ids)
        return [reduce_inspect(obj) for obj in self._json('inspect.json')
                if isinstance(obj, dict) and obj.get('Id') in wanted]

    def stats(self, ids):
        wanted = set(ids)
        rows = [obj for obj in (loads_object(line) for line in self._file('stats.jsonl').splitlines()) if obj]
        return [row for row in rows if row.get('ID') in wanted]

    def volumes(self, project):
        return [line.strip() for line in self._file('volume_ls.txt').splitlines() if line.strip()]

    def volume_mounts(self, names):
        wanted = set(names)
        return {obj['Name']: obj['Mountpoint'] for obj in self._json('volume_inspect.json')
                if isinstance(obj, dict) and obj.get('Name') in wanted and isinstance(obj.get('Mountpoint'), str)}

    def system_df(self):
        return [obj for obj in (loads_object(line) for line in self._file('system_df.jsonl').splitlines()) if obj]

    def image_labels(self, image_id):
        for obj in self._json('image_inspect.json'):
            if isinstance(obj, dict) and obj.get('Id') == image_id:
                labels = (obj.get('Config') or {}).get('Labels')
                return labels if isinstance(labels, dict) else {}
        raise ProbeError('EXIT_1')

    def top(self, record):
        return self._file('top.txt')

    def logs(self, record, since, until, stdout=True, stderr=True):
        name = (record.get('Name') or '').lstrip('/')
        self._file('logs-%s' % name, required=False)  # error injection: logs-<container>.error

        def pick(text):
            kept = []
            for line in text.splitlines():
                stamp, _, rest = line.partition(' ')
                t = parse_time(stamp)
                if t is not None and since <= t <= until:
                    kept.append(rest)
            return '\n'.join(kept) + ('\n' if kept else '')

        out = pick(self._file('logs-%s.out' % name, required=False)) if stdout else ''
        err = pick(self._file('logs-%s.err' % name, required=False)) if stderr else ''
        return out, err

    def health(self, ip, port, deadline):
        if not os.path.exists(os.path.join(self.root, 'health.json')) and \
                not os.path.exists(os.path.join(self.root, 'health.json.error')):
            raise ProbeError('UNREACHABLE')
        data = self._json('health.json')
        body = data.get('body')
        return int(data.get('status', 0)), json.dumps(body).encode('utf-8'), int(data.get('ms', 0))


# --------------------------------------------------------------------------------------------------------- parsers

def parse_proc_stat(text):
    total = idle = iowait = steal = None
    nproc = 0
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == 'cpu':
            values = [int(v) for v in parts[1:9]]
            if len(values) < 4:
                raise ValueError('short cpu line')
            values += [0] * (8 - len(values))
            total = sum(values)  # user nice system idle iowait irq softirq steal (guest is inside user)
            idle, iowait, steal = values[3], values[4], values[7]
        elif re.match(r'^cpu\d+$', parts[0]):
            nproc += 1
    if total is None:
        raise ValueError('no cpu line')
    return {'total': total, 'idle': idle, 'iowait': iowait, 'steal': steal, 'nproc': nproc or None}


def parse_meminfo(text):
    values = {}
    for line in text.splitlines():
        m = re.match(r'^(\w+):\s+(\d+)\s*kB', line)
        if m:
            values[m.group(1)] = int(m.group(2)) * 1024
    if 'MemTotal' not in values or 'MemAvailable' not in values:
        raise ValueError('meminfo')
    swap_total = values.get('SwapTotal', 0)
    return {'totalB': values['MemTotal'], 'availableB': values['MemAvailable'], 'swapTotalB': swap_total,
            'swapUsedB': max(0, swap_total - values.get('SwapFree', swap_total))}


def parse_loadavg(text):
    parts = text.split()
    return [float(parts[0]), float(parts[1]), float(parts[2])]


def parse_uptime(text):
    return float(text.split()[0])


def parse_psi_some10(text):
    for line in text.splitlines():
        if line.startswith('some '):
            m = re.search(r'\bavg10=([0-9.]+)', line)
            if m:
                return float(m.group(1))
    raise ValueError('psi')


def parse_netdev(text, iface):
    for line in text.splitlines():
        name, sep, rest = line.partition(':')
        if sep and name.strip() == iface:
            fields = rest.split()
            return int(fields[0]), int(fields[8])
    raise ProbeError('NOT_FOUND')


def parse_os_release(text):
    for line in text.splitlines():
        if line.startswith('PRETTY_NAME='):
            return cap(line.split('=', 1)[1].strip().strip('"\''), 80)
    return None


def parse_mounts(text):
    mounts = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 3:
            mounts.append((parts[1].replace('\\040', ' '), parts[2]))
    return mounts


def fs_of(mounts, path):
    best, best_len = None, -1
    for mountpoint, fstype in mounts:
        if path == mountpoint or path.startswith(mountpoint.rstrip('/') + '/'):
            if len(mountpoint) > best_len:
                best, best_len = fstype, len(mountpoint)
    return cap(best, 16)


def parse_timedatectl(text):
    values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    if 'NTPSynchronized' not in values and 'Timezone' not in values:
        raise ValueError('timedatectl')
    synced = values.get('NTPSynchronized')
    return {'ntpSynced': {'yes': True, 'no': False}.get((synced or '').strip()),
            'tz': cap((values.get('Timezone') or '').strip(), 40) or None}


def parse_apt(text):
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines or not lines[0].startswith('Listing'):
        raise ValueError('apt')
    packages, security = [], 0
    for line in lines[1:]:
        name, sep, rest = line.partition('/')
        if not sep or not re.match(r'^[A-Za-z0-9.+:_-]{1,80}$', name):
            continue
        suite = rest.split(' ', 1)[0]
        if '-security' in suite:
            security += 1
        packages.append(name)
    return len(packages), security, packages[:40]


def parse_lines(text, max_lines, max_len):
    return [cap(line.strip(), max_len) for line in text.splitlines() if line.strip()][:max_lines]


def parse_ufw(text):
    status = None
    defaults = {}
    rules = []
    allow_in = []
    in_rules = False
    for line in text.splitlines():
        if line.startswith('Status:'):
            status = line.split(':', 1)[1].strip()
        elif line.startswith('Default:'):
            for value, direction in re.findall(r'(\w+) \((incoming|outgoing|routed)\)', line):
                defaults[direction] = value
        elif re.match(r'^--+\s', line + ' '):
            in_rules = True
        elif in_rules and line.strip():
            rule = re.sub(r'\s{2,}', ' ', line.strip())
            if len(rules) < 30:
                rules.append(cap(rule, 120))
            m = re.match(r'^(.+?)\s+ALLOW IN\b', rule)
            if m:
                target = m.group(1).replace(' (v6)', '').strip()
                if target not in allow_in:
                    allow_in.append(cap(target, 40))
    if status not in ('active', 'inactive'):
        raise ValueError('ufw')
    return {'active': status == 'active', 'defaultIncoming': defaults.get('incoming'),
            'defaultOutgoing': defaults.get('outgoing'), 'defaultRouted': defaults.get('routed'),
            'allowIn': allow_in, 'rules': rules}


def parse_sshd(text):
    values = {}
    for line in text.splitlines():
        key, _, value = line.strip().partition(' ')
        if key in ('passwordauthentication', 'permitrootlogin', 'port') and key not in values:
            values[key] = value.strip()
    if not values:
        raise ValueError('sshd -T')
    password = values.get('passwordauthentication')
    port = values.get('port')
    return {'passwordAuth': {'yes': True, 'no': False}.get(password),
            'permitRootLogin': cap(values.get('permitrootlogin'), 32),
            'port': int(port) if port and port.isdigit() else None}


def parse_ssh_journal(text):
    failures = 0
    sources = {}
    for line in text.splitlines():
        if not SSH_FAIL_RE.search(line):
            continue
        failures += 1
        m = SSH_FROM_RE.search(line)
        if m:
            try:
                ip = str(ipaddress.ip_address(m.group(1)))
            except ValueError:
                continue
            sources[ip] = sources.get(ip, 0) + 1
    top = sorted(sources.items(), key=lambda item: (-item[1], item[0]))[:5]
    return failures, [{'ip': ip, 'count': count} for ip, count in top]


def parse_fail2ban(text):
    values = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
    if values.get('LoadState') == 'not-found':
        return 'absent'
    state = values.get('ActiveState')
    if not state:
        raise ValueError('fail2ban')
    return cap(state.strip(), 16)


def parse_openssl_date(value):
    try:
        return dt.datetime.strptime(' '.join(value.split()), '%b %d %H:%M:%S %Y %Z').replace(
            tzinfo=dt.timezone.utc).timestamp()
    except ValueError:
        return None


def dn_value(dn, key):
    m = re.search(r'(?:^|[,/]\s*)%s\s*=\s*([^,/]+)' % key, dn)
    return m.group(1).strip() if m else None


def parse_openssl(text, fallback_name):
    values = {}
    for line in text.splitlines():
        key, sep, value = line.partition('=')
        if sep:
            values[key.strip()] = value.strip()
    not_before = parse_openssl_date(values.get('notBefore', ''))
    not_after = parse_openssl_date(values.get('notAfter', ''))
    if not_after is None:
        raise ValueError('openssl')
    issuer = values.get('issuer', '')
    issuer_name = ' '.join(part for part in (dn_value(issuer, 'O'), dn_value(issuer, 'CN')) if part) or None
    name = dn_value(values.get('subject', ''), 'CN') or fallback_name
    return {'name': cap(name, 120), 'notBefore': iso(not_before), 'notAfter': iso(not_after),
            'issuer': cap(issuer_name, 80)}


def parse_info(text):
    info = {}
    for line in text.splitlines():
        key, _, value = line.partition(' ')
        if key in ('created', 'image', 'revision', 'mode') and key not in info:
            info[key] = cap(value.strip(), 120)
    return info


def parse_cron_log(text):
    lines = [cap(line.rstrip(), 200) for line in text.splitlines() if line.startswith(('backup:', 'rotate:'))]
    return lines[-10:]


def parse_du(text, mounts):
    by_path = {}
    for line in text.splitlines():
        size, sep, path = line.partition('\t')
        if sep and size.strip().isdigit():
            by_path[path.strip()] = int(size.strip())
    sizes = {}
    for name, mountpoint in mounts.items():
        if mountpoint in by_path:
            sizes[name] = by_path[mountpoint]
    return sizes


def parse_top(text):
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise ValueError('top')
    titles = [title.upper() for title in lines[0].split()]
    if 'PID' not in titles or titles[-1] not in ('COMMAND', 'CMD', 'ARGS'):
        raise ValueError('top header')
    index = {title: i for i, title in enumerate(titles)}
    rows = []
    for line in lines[1:]:
        fields = line.split(None, len(titles) - 1)
        if len(fields) < len(titles):
            continue

        def number(title, kind):
            if title not in index:
                return None
            try:
                return kind(fields[index[title]])
            except ValueError:
                return None

        rows.append({'pid': number('PID', int), 'elapsedS': number('ELAPSED', int), 'rssK': number('RSS', int),
                     'cpuPct': number('%CPU', float), 'args': fields[-1]})
    return rows


def classify_process(args):
    """kind/port/token of one process; None for the container's init. The args themselves are never returned."""
    argv0 = args.split(None, 1)[0] if args.strip() else ''
    base = argv0.rsplit('/', 1)[-1]
    if base == 'docker-init':
        return None
    m = re.search(r'--port[ =](\d{1,5})\b', args)
    port = int(m.group(1)) if m else None
    token = None
    name = None
    if 'facade/ssam.mjs serve' in args:
        kind = 'server'
    elif re.search(r'anvil-odc\.dll\s+serve\b', args):
        kind = 'odc-worker'
    elif TOKEN_DIR_RE.search(args):
        kind = 'o11-worker'
        token = TOKEN_DIR_RE.search(args).group(1)
    elif re.search(r'(^|[/\s])anvil\.dll\s+serve\b', args):
        kind = 'o11-worker'
    elif '/studio/builder/' in args:
        kind = 'builder'
    else:
        kind = 'other'
        name = re.sub(r'[^A-Za-z0-9._-]', '', base)[:32] or None
    out = {'kind': kind, 'port': port, 'token': token}
    if kind == 'other':
        out['name'] = name
    return out


def image_tag(reference):
    if not isinstance(reference, str) or not reference or reference.startswith('sha256:'):
        return None
    reference = reference.split('@', 1)[0]
    last = reference.rsplit('/', 1)[-1]
    return cap(last.split(':', 1)[1], 128) if ':' in last else 'latest'


def sanitize(value, shape):
    """Copies only the keys of `shape` with the right types (strings capped at 200); '*' matches lane-like keys."""
    if isinstance(shape, dict):
        if not isinstance(value, dict):
            return None
        out = {}
        for key, sub in shape.items():
            if key == '*':
                for k, v in value.items():
                    if isinstance(k, str) and re.match(r'^[a-z0-9]{1,16}$', k):
                        out[k] = sanitize(v, sub)
            elif key in value:
                out[key] = sanitize(value[key], sub)
        return out
    if shape is bool:
        return value if isinstance(value, bool) else None
    if shape is float:
        return as_num(value)
    if shape is str:
        return cap(value, 200)
    if shape == 'str-list':
        return [cap(v, 40) for v in value[:10] if isinstance(v, str)] if isinstance(value, list) else None
    return None


KERNEL_SHAPE = {'o11': str, 'odc': str, 'odcBridge': str, 'o11Hook': str, 'odcBridgeAccepted': 'str-list'}
WARM_SHAPE = {
    'indexes': {'ok': bool, 'error': str, 'ms': float,
                'lanes': {'*': {'ok': bool, 'cache': str, 'ms': float, 'error': str}}},
    'delivery': {'builder': {'ok': bool, 'pid': float, 'note': str}, 'worker': {'ok': bool, 'note': str},
                 'error': str},
    'ms': float,
}


# --------------------------------------------------------------------------------------------------------- context

class Ctx:
    def __init__(self, conf, host, docker, now, state, deadline, fixture):
        self.conf = conf
        self.host = host
        self.docker = docker
        self.now = now
        self.state = state
        self.deadline = deadline
        self.fixture = fixture
        self.project = conf['COMPOSE_PROJECT']
        self.zone = display_zone(conf['DISPLAY_TZ'])
        self.records = None  # docker inspect records, set by the docker section
        self.docker_error = 'UNAVAILABLE'


def run_section(ctx, name, builder):
    errors = []
    try:
        body = builder(ctx, errors)
        data = {'ok': True, 'at': iso(ctx.now)}
        data.update(body)
    except ProbeError as exc:
        data = {'ok': False, 'error': exc.code, 'at': iso(ctx.now)}
    except Exception as exc:  # malformed input that slipped past a parser: PARSE, with the place (never the data)
        frame = traceback.extract_tb(exc.__traceback__)[-1]
        print('collect: %s: %s at line %d' % (name, type(exc).__name__, frame.lineno), file=sys.stderr)
        data = {'ok': False, 'error': 'PARSE', 'at': iso(ctx.now)}
    return data, errors


def cached_section(ctx, name, builder):
    """A section on its own cadence: the cached result (with its own "at") while fresh, else a new probe."""
    entry = ctx.state.setdefault('sections', {}).get(name)
    if isinstance(entry, dict) and isinstance(entry.get('data'), dict) and isinstance(entry.get('t'), (int, float)):
        limit = CADENCE_S[name]
        if not entry['data'].get('ok', True) or entry.get('errors'):
            limit = min(limit, RETRY_FAILED_S)
        if 0 <= ctx.now - entry['t'] < limit:
            return entry['data'], list(entry.get('errors') or [])
    data, errors = run_section(ctx, name, builder)
    ctx.state['sections'][name] = {'t': ctx.now, 'data': data, 'errors': errors}
    return data, errors


# --------------------------------------------------------------------------------------------------------- sections

def build_host(ctx, errors):
    h = ctx.host
    cpu = parse_proc_stat(h.read('/proc/stat'))
    mem = parse_meminfo(h.read('/proc/meminfo'))
    load = parse_loadavg(h.read('/proc/loadavg'))
    uptime = parse_uptime(h.read('/proc/uptime'))
    nodename, release = optional(errors, 'host.uname', h.uname, (None, None))
    os_name = optional(errors, 'host.os', lambda: parse_os_release(h.read('/etc/os-release')))

    psi, psi_error = {}, None
    for key, name in (('cpuSome10', 'cpu'), ('memSome10', 'memory'), ('ioSome10', 'io')):
        try:
            psi[key] = parse_psi_some10(h.read('/proc/pressure/' + name))
        except ProbeError as exc:
            psi[key], psi_error = None, psi_error or exc.code
        except ValueError:
            psi[key], psi_error = None, psi_error or 'PARSE'
    if psi_error:
        errors.append('host.psi: %s' % psi_error)

    iface = ctx.conf['NET_IFACE']
    netdev = optional(errors, 'host.net', lambda: parse_netdev(h.read('/proc/net/dev'), iface))

    previous = ctx.state.get('counters') if isinstance(ctx.state.get('counters'), dict) else {}
    gap = ctx.now - previous['t'] if isinstance(previous.get('t'), (int, float)) else None
    usable = gap is not None and 0 < gap <= RATE_MAX_GAP_S
    cpu_out = {'pct': None, 'iowaitPct': None, 'stealPct': None, 'windowS': None}
    old_cpu = previous.get('cpu')
    if usable and isinstance(old_cpu, list) and len(old_cpu) == 4:
        d_total = cpu['total'] - old_cpu[0]
        d_idle = cpu['idle'] - old_cpu[1]
        d_iowait = cpu['iowait'] - old_cpu[2]
        d_steal = cpu['steal'] - old_cpu[3]
        if d_total > 0 and min(d_idle, d_iowait, d_steal) >= 0 and d_idle + d_iowait <= d_total:
            cpu_out = {'pct': round(100.0 * (d_total - d_idle - d_iowait) / d_total, 1),
                       'iowaitPct': round(100.0 * d_iowait / d_total, 1),
                       'stealPct': round(100.0 * d_steal / d_total, 1),
                       'windowS': int(round(gap))}
    net_out = {'iface': iface, 'rxB': None, 'txB': None, 'rxBps': None, 'txBps': None}
    if netdev:
        net_out['rxB'], net_out['txB'] = netdev
        old_net = previous.get('net')
        if usable and previous.get('iface') == iface and isinstance(old_net, list) and len(old_net) == 2:
            d_rx, d_tx = netdev[0] - old_net[0], netdev[1] - old_net[1]
            if d_rx >= 0 and d_tx >= 0:
                net_out['rxBps'] = int(round(d_rx / gap))
                net_out['txBps'] = int(round(d_tx / gap))
    ctx.state['counters'] = {'t': ctx.now, 'cpu': [cpu['total'], cpu['idle'], cpu['iowait'], cpu['steal']],
                             'iface': iface, 'net': list(netdev) if netdev else None}

    time_info = optional(errors, 'host.time', lambda: parse_timedatectl(
        h.cmd('timedatectl', ['timedatectl', 'show', '-p', 'NTPSynchronized', '-p', 'Timezone'])),
        {'ntpSynced': None, 'tz': None})
    failed = optional(errors, 'host.failedUnits', lambda: len(
        [line for line in h.cmd('failed-units', ['systemctl', '--failed', '--no-legend', '--plain']).splitlines()
         if line.strip()]))
    disks = optional(errors, 'host.disks', lambda: collect_disks(h, errors), [])

    return {
        'hostname': cap(nodename, 64),
        'os': os_name,
        'kernel': cap(release, 64),
        'nproc': cpu['nproc'],
        'uptimeS': int(uptime),
        'bootAt': iso(ctx.now - int(uptime)),
        'load': load,
        'cpu': cpu_out,
        'mem': mem,
        'psi': psi,
        'disks': disks,
        'net': net_out,
        'time': time_info,
        'failedUnits': failed,
    }


def collect_disks(h, errors):
    mounts = optional(errors, 'host.mounts', lambda: parse_mounts(h.read('/proc/mounts')), [])
    seen, disks = set(), []
    for path in DISK_PATHS:
        vfs = h.statvfs(path)
        if vfs is None or vfs['dev'] in seen:
            continue
        seen.add(vfs['dev'])
        size = vfs['blocks'] * vfs['frsize']
        used = (vfs['blocks'] - vfs['bfree']) * vfs['frsize']
        avail = vfs['bavail'] * vfs['frsize']
        files = vfs['files']
        disks.append({'mount': path, 'fs': fs_of(mounts, path), 'sizeB': size, 'usedB': used, 'availB': avail,
                      'usedPct': ceil_pct(used, used + avail),
                      'inodesPct': ceil_pct(files - vfs['ffree'], files) if files else None})
    if not disks:
        raise ProbeError('NOT_FOUND')
    return disks


def build_updates(ctx, errors):
    h = ctx.host
    upgradable, security, packages = parse_apt(h.cmd('apt', ['apt', 'list', '--upgradable']))
    reboot_required, reboot_since, reboot_pkgs = None, None, []
    try:
        reboot_t = h.mtime('/var/run/reboot-required')
        reboot_required = reboot_t is not None
        reboot_since = iso(reboot_t)
    except ProbeError as exc:
        errors.append('updates.reboot: %s' % exc.code)
    if reboot_required:
        reboot_pkgs = optional(errors, 'updates.rebootPkgs',
                               lambda: parse_lines(h.read('/var/run/reboot-required.pkgs', 4096), 20, 80), [])
    enabled = optional(errors, 'updates.unattended', lambda: h.cmd(
        'unattended', ['systemctl', 'is-enabled', 'unattended-upgrades'], ok=(0, 1)).strip() == 'enabled')
    last_run = optional(errors, 'updates.unattended',
                        lambda: h.mtime('/var/lib/apt/periodic/unattended-upgrades-stamp'))
    last_ok = optional(errors, 'updates.unattended', lambda: h.mtime('/var/lib/apt/periodic/update-success-stamp'))
    return {'upgradable': upgradable, 'security': security, 'packages': packages,
            'rebootRequired': reboot_required, 'rebootSince': reboot_since, 'rebootPkgs': reboot_pkgs,
            'unattended': {'enabled': enabled, 'lastRunAt': iso(last_run), 'lastSuccessAt': iso(last_ok)}}


def build_security(ctx, errors):
    h = ctx.host
    ufw = parse_ufw(h.cmd('ufw', ['ufw', 'status', 'verbose']))
    ssh = {'passwordAuth': None, 'permitRootLogin': None, 'port': None, 'fail2ban': None, 'failures24h': None,
           'topSources': []}
    sshd = optional(errors, 'security.sshd', lambda: parse_sshd(h.cmd('sshd', ['sshd', '-T'])))
    if sshd:
        ssh.update(sshd)
    journal = optional(errors, 'security.journal', lambda: parse_ssh_journal(h.cmd(
        'journal-ssh', ['journalctl', '-u', 'ssh', '-u', 'ssh.socket', '--since', '-24h', '-o', 'cat', '--no-pager'],
        timeout=15)))
    if journal:
        ssh['failures24h'], ssh['topSources'] = journal
    ssh['fail2ban'] = optional(errors, 'security.fail2ban', lambda: parse_fail2ban(h.cmd(
        'fail2ban', ['systemctl', 'show', '-p', 'LoadState', '-p', 'ActiveState', 'fail2ban'])))
    return {'ufw': ufw, 'ssh': ssh}


def caddy_data_mount(ctx):
    record = pick_container(ctx, ctx.conf['CADDY_SERVICE'], required=False)
    for mount in (record or {}).get('Mounts') or []:
        if isinstance(mount, dict) and mount.get('Destination') == '/data' and isinstance(mount.get('Source'), str):
            source = mount['Source']
            if re.match(r'^/[A-Za-z0-9._/-]+$', source) and '..' not in source:
                return source
    return None


def build_tls(ctx, errors):
    rows = ctx.host.certs(caddy_data_mount(ctx))
    certs, first_error = [], None
    for name, text in rows:
        if isinstance(text, ProbeError):
            first_error = first_error or text.code
            continue
        try:
            certs.append(parse_openssl(text, name))
        except ValueError:
            first_error = first_error or 'PARSE'
    if rows and not certs:
        raise ProbeError(first_error or 'PARSE')
    if first_error:
        errors.append('tls.cert: %s' % first_error)
    certs.sort(key=lambda c: c['name'] or '')
    return {'certs': certs}


def cron_mentions(h, path, word):
    try:
        return word in h.read(path, 4096)
    except ProbeError as exc:
        if exc.code == 'NOT_FOUND':
            return False
        raise


def build_backups(ctx, errors):
    h = ctx.host
    directory = ctx.conf['BACKUP_DIR']
    entries = h.list_backups()
    cron = {'backup': optional(errors, 'backups.cron', lambda: cron_mentions(h, '/etc/cron.d/ssam-backup', 'backup.sh')),
            'rotate': optional(errors, 'backups.cron',
                               lambda: cron_mentions(h, '/etc/cron.d/ssam-rotate', 'rotate-logs.sh'))}
    if entries is None:
        return {'dir': directory, 'exists': False, 'count': 0, 'totalB': 0, 'newest': None, 'cron': cron,
                'cronLogTail': []}
    names = {name for name, is_file, _, _, _ in entries if is_file}
    archives = sorted((e for e in entries if e[1] and ARCHIVE_RE.match(e[0])), key=lambda e: e[0])
    newest = None
    if archives:
        name, _, _, size, mtime = archives[-1]
        info = {}
        if name + '.info' in names:
            info = optional(errors, 'backups.info', lambda: parse_info(h.read_backup(name + '.info', 4096)), {})
        newest = {'name': name, 'sizeB': size, 'mtime': iso(mtime), 'sha256File': name + '.sha256' in names,
                  'infoFile': name + '.info' in names, 'created': info.get('created'), 'image': info.get('image'),
                  'revision': info.get('revision'), 'mode': info.get('mode')}
    tail = []
    if 'cron.log' in names:
        tail = optional(errors, 'backups.cronLog',
                        lambda: parse_cron_log(h.read_backup('cron.log', 65536, tail=True)), [])
    return {'dir': directory, 'exists': True, 'count': len(archives), 'totalB': sum(e[3] for e in archives),
            'newest': newest, 'cron': cron, 'cronLogTail': tail}


def labels_of(record):
    labels = record.get('Labels')
    return labels if isinstance(labels, dict) else {}


def state_of(record):
    state = record.get('State')
    return state if isinstance(state, dict) else {}


def name_of(record):
    return cap((record.get('Name') or '').lstrip('/'), 128) or ''


def project_records(ctx):
    return [r for r in ctx.records or []
            if labels_of(r).get('com.docker.compose.project') == ctx.project
            and labels_of(r).get('com.docker.compose.oneoff') != 'True']


def pick_container(ctx, service, required=True):
    if ctx.records is None:
        if required:
            raise ProbeError(ctx.docker_error)
        return None
    found = [r for r in project_records(ctx) if labels_of(r).get('com.docker.compose.service') == service]
    if not found:
        if required:
            raise ProbeError('NOT_FOUND')
        return None
    found.sort(key=lambda r: (state_of(r).get('Status') == 'running', state_of(r).get('StartedAt') or ''))
    return found[-1]


def container_entry(record, stats):
    labels = labels_of(record)
    state = state_of(record)
    health = state.get('Health') if isinstance(state.get('Health'), dict) else None
    last_health = []
    if health:
        for item in (health.get('Log') or [])[-5:]:
            if isinstance(item, dict):
                last_health.append({'at': iso(parse_time(item.get('Start'))), 'exit': as_int(item.get('ExitCode'))})
    memory = as_int(record.get('Memory'))
    entry = {
        'name': name_of(record),
        'service': cap(labels.get('com.docker.compose.service'), 64),
        'project': cap(labels.get('com.docker.compose.project'), 64),
        'image': cap(record.get('ConfigImage'), 200),
        'imageId': cap(record.get('Image'), 80),
        'state': cap(state.get('Status'), 16),
        'health': cap(health.get('Status'), 16) if health else None,
        'failingStreak': as_int(health.get('FailingStreak')) if health else None,
        'lastHealth': last_health,
        'startedAt': iso(parse_time(state.get('StartedAt'))),
        'restartCount': as_int(record.get('RestartCount')),
        'oomKilled': bool(state.get('OOMKilled')),
        'restartPolicy': cap((record.get('RestartPolicy') or {}).get('Name'), 32),
        'cpuPct': None, 'memB': None, 'memLimitB': memory if memory else None,
        'netRxB': None, 'netTxB': None, 'blkReadB': None, 'blkWriteB': None, 'pids': None,
    }
    if stats:
        used, limit = parse_pair(stats.get('MemUsage'))
        entry['cpuPct'] = parse_percent(stats.get('CPUPerc'))
        entry['memB'] = used
        if not entry['memLimitB']:
            entry['memLimitB'] = limit
        entry['netRxB'], entry['netTxB'] = parse_pair(stats.get('NetIO'))
        entry['blkReadB'], entry['blkWriteB'] = parse_pair(stats.get('BlockIO'))
        pids = stats.get('PIDs')
        entry['pids'] = int(pids) if isinstance(pids, str) and pids.isdigit() else as_int(pids)
    return entry


def build_docker(ctx, errors):
    d = ctx.docker
    try:
        listing = d.ps()
        ids = [row['ID'] for row in listing if isinstance(row.get('ID'), str) and re.match(r'^[0-9a-f]{12,64}$', row['ID'])]
        records = d.inspect(ids) if ids else []
    except ProbeError as exc:
        ctx.docker_error = exc.code
        raise
    ctx.records = records
    project = project_records(ctx)
    running = [r for r in project if state_of(r).get('Status') == 'running']
    stats = {}
    if running:
        rows = optional(errors, 'docker.stats', lambda: d.stats([r['Id'] for r in running]), [])
        for row in rows:
            stats[row.get('ID')] = row
    containers = [container_entry(r, stats.get(r.get('Id'))) for r in project]
    containers.sort(key=lambda c: (c['service'] or '', c['name']))
    slow, slow_errors = cached_section(ctx, 'docker-slow', build_docker_slow)
    errors.extend(slow_errors)
    return {'engine': slow.get('engine'), 'containers': containers, 'volumes': slow.get('volumes') or [],
            'systemDf': slow.get('systemDf')}


def build_docker_slow(ctx, errors):
    d = ctx.docker
    engine = optional(errors, 'docker.engine', lambda: cap(d.version(), 32))
    volumes = optional(errors, 'docker.volumes', lambda: volume_sizes(ctx, errors), [])
    empty_df = {'imagesB': None, 'imagesReclaimableB': None, 'volumesB': None, 'buildCacheB': None}
    system_df = optional(errors, 'docker.systemDf', lambda: parse_system_df(d.system_df()), empty_df)
    return {'engine': engine, 'volumes': volumes, 'systemDf': system_df}


def volume_sizes(ctx, errors):
    names = [n for n in ctx.docker.volumes(ctx.project) if re.match(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$', n)]
    if not names:
        return []
    mounts = {n: m for n, m in ctx.docker.volume_mounts(names).items()
              if re.match(r'^/[A-Za-z0-9._/-]+$', m) and '..' not in m}
    sizes = {}
    if mounts:
        try:
            out = ctx.host.cmd('du', ['du', '-s', '-B1', '--'] + sorted(mounts.values()), timeout=60, ok=(0, 1))
            sizes = parse_du(out, mounts)
        except ProbeError as exc:
            errors.append('docker.volumes.du: %s' % exc.code)
    return [{'name': n, 'sizeB': sizes.get(n)} for n in sorted(names)]


def parse_system_df(rows):
    out = {'imagesB': None, 'imagesReclaimableB': None, 'volumesB': None, 'buildCacheB': None}
    for row in rows:
        kind = row.get('Type')
        size = parse_bytes(row.get('Size'))
        if kind == 'Images':
            out['imagesB'] = size
            reclaimable = row.get('Reclaimable')
            out['imagesReclaimableB'] = parse_bytes(reclaimable.split('(')[0]) if isinstance(reclaimable, str) else None
        elif kind == 'Local Volumes':
            out['volumesB'] = size
        elif kind == 'Build Cache':
            out['buildCacheB'] = size
    if all(value is None for value in out.values()):
        raise ValueError('system df')
    return out


def probe_health(ctx, ip):
    available = bool(ctx.state.get('probeAvailable'))
    probe = {'available': available, 'ok': False, 'pid': None, 'ms': None, 'error': None}
    if not ip:
        probe['error'] = 'NO_ADDRESS'
        return probe
    try:
        status, body, ms = ctx.docker.health(ip, int(ctx.conf['SERVER_PORT']), ctx.deadline)
    except ProbeError as exc:
        probe['error'] = exc.code
        return probe
    probe['ms'] = ms
    if status != 200:
        probe['error'] = 'HTTP_%d' % status
        return probe
    try:
        answer = json.loads(body.decode('utf-8', 'replace'))
    except ValueError:
        answer = None
    if not isinstance(answer, dict) or answer.get('ok') is not True:
        probe['error'] = 'PARSE'
        return probe
    probe.update(ok=True, pid=as_int(answer.get('pid')), available=True)
    ctx.state['probeAvailable'] = True
    return probe


def server_image(ctx, record, errors):
    image_id = record.get('Image')
    tag = image_tag(record.get('ConfigImage'))
    cache = ctx.state.get('image') if isinstance(ctx.state.get('image'), dict) else {}
    if cache.get('id') == image_id and isinstance(cache.get('data'), dict):
        data = dict(cache['data'])
        data['tag'] = tag
        return data
    try:
        labels = ctx.docker.image_labels(image_id) if isinstance(image_id, str) else {}
    except ProbeError as exc:
        errors.append('server.image: %s' % exc.code)
        return {'tag': tag, 'version': None, 'revision': None, 'created': None}
    data = {'tag': tag,
            'version': cap(labels.get('org.opencontainers.image.version'), 128),
            'revision': cap(labels.get('org.opencontainers.image.revision'), 64),
            'created': cap(labels.get('org.opencontainers.image.created'), 40)}
    ctx.state['image'] = {'id': image_id, 'data': data}
    return data


def server_startup(ctx, record, errors):
    state = state_of(record)
    started = parse_time(state.get('StartedAt'))
    key = '%s|%s' % (record.get('Id'), state.get('StartedAt'))
    cache = ctx.state.get('startup') if isinstance(ctx.state.get('startup'), dict) else {}
    if cache.get('key') == key and isinstance(cache.get('data'), dict) and cache['data'].get('complete'):
        return cache['data']
    base = {'containerId': cap(record.get('Id'), 64), 'startedAt': iso(started), 'complete': False, 'kernel': None,
            'warm': None, 'warmFailures': []}
    if started is None:
        return base
    until = started + STARTUP_WINDOW_S
    try:
        out, err = ctx.docker.logs(record, started, until, stdout=True, stderr=True)
    except ProbeError as exc:
        errors.append('server.startup: %s' % exc.code)
        return cache['data'] if cache.get('key') == key and isinstance(cache.get('data'), dict) else base
    kernel = warm = None
    for line in out.splitlines():
        # Every other stdout line carries customer data (sessions, IPs, machine names): never parsed, never kept.
        if not EVENT_RE.search(line):
            continue
        event = loads_object(line)
        if not event:
            continue
        if event.get('event') == 'kernel' and kernel is None:
            kernel = {'time': cap(event.get('time'), 40), 'kernel': sanitize(event.get('kernel'), KERNEL_SHAPE)}
        elif event.get('event') == 'warm' and warm is None:
            warm = sanitize(event, WARM_SHAPE)
            warm = dict({'time': cap(event.get('time'), 40)}, **warm)
    failures = []
    for line in err.splitlines():
        if not SSAM_WARM_RE.search(line):
            continue
        event = loads_object(line)
        if event and event.get('ssam') == 'warm' and len(failures) < 10:
            failures.append({'lane': cap(event.get('lane'), 16), 'error': cap(event.get('error'), 200)})
    base.update(kernel=kernel, warm=warm, warmFailures=failures, complete=warm is not None or ctx.now >= until)
    ctx.state['startup'] = {'key': key, 'data': base}
    return base


def server_processes(ctx, record):
    processes = []
    for row in parse_top(ctx.docker.top(record)):
        kind = classify_process(row.pop('args'))
        if kind is None:
            continue
        entry = {'kind': kind['kind'], 'pid': row['pid'], 'elapsedS': row['elapsedS'],
                 'rssB': row['rssK'] * 1024 if row['rssK'] is not None else None, 'cpuPct': row['cpuPct'],
                 'port': kind['port'], 'token': kind['token']}
        if 'name' in kind:
            entry['name'] = kind['name']
        processes.append(entry)
    processes.sort(key=lambda p: (PROCESS_ORDER.get(p['kind'], 9), p['pid'] or 0))
    return processes


def server_stderr(ctx, record, errors):
    since = window_start(ctx.state.get('stderrTo'), ctx.now)
    window = int(round(ctx.now - since))
    try:
        _, err = ctx.docker.logs(record, since, ctx.now, stdout=False, stderr=True)
    except ProbeError as exc:
        errors.append('server.stderr: %s' % exc.code)
        return {'windowS': window, 'friction': None, 'warmFailures': None}
    lines = err.splitlines()
    ctx.state['stderrTo'] = ctx.now
    return {'windowS': window, 'friction': sum(1 for line in lines if line.startswith('[ssam-friction]')),
            'warmFailures': sum(1 for line in lines if SSAM_WARM_RE.search(line))}


def build_server(ctx, errors):
    record = pick_container(ctx, ctx.conf['SERVER_SERVICE'])
    running = state_of(record).get('Status') == 'running'
    ip = None
    if running:
        networks = record.get('Networks') if isinstance(record.get('Networks'), dict) else {}
        backend = networks.get('%s_backend' % ctx.project)
        ip = backend.get('IPAddress') if isinstance(backend, dict) else None
    probe = probe_health(ctx, ip or None)
    image = server_image(ctx, record, errors)
    startup = server_startup(ctx, record, errors)
    processes = optional(errors, 'server.processes', lambda: server_processes(ctx, record)) if running else []
    stderr = server_stderr(ctx, record, errors)
    return {'health': {'probe': probe}, 'image': image, 'startup': startup, 'processes': processes, 'stderr': stderr}


class CaddyCounts:
    """Status counts and denied (ip, status, path) counts; the access lines' headers are never looked at."""

    def __init__(self):
        self.by_status = {}
        self.denied = {}

    def add(self, status, ip, path, n=1):
        key = str(status)
        self.by_status[key] = self.by_status.get(key, 0) + n
        if status in (401, 403, 429):
            denied_key = (ip, status, path)
            self.denied[denied_key] = self.denied.get(denied_key, 0) + n

    def merge(self, other):
        for key, n in other.by_status.items():
            self.by_status[key] = self.by_status.get(key, 0) + n
        for key, n in other.denied.items():
            self.denied[key] = self.denied.get(key, 0) + n

    def top(self, limit):
        rows = sorted(self.denied.items(), key=lambda item: (-item[1], item[0][0] or '', item[0][1], item[0][2] or ''))
        return [{'ip': ip, 'status': status, 'path': path, 'count': n} for (ip, status, path), n in rows[:limit]]

    def statuses(self):
        return {key: self.by_status[key] for key in sorted(self.by_status, key=lambda k: (len(k), k))}

    def dump(self, limit):
        return {'byStatus': self.statuses(), 'denied': [[r['ip'], r['status'], r['path'], r['count']]
                                                        for r in self.top(limit)]}

    @classmethod
    def load(cls, data):
        counts = cls()
        if isinstance(data, dict):
            for key, n in (data.get('byStatus') or {}).items():
                if isinstance(key, str) and isinstance(n, int):
                    counts.by_status[key] = n
            for row in data.get('denied') or []:
                if isinstance(row, list) and len(row) == 4 and isinstance(row[3], int):
                    counts.denied[(row[0], row[1], row[2])] = row[3]
        return counts


def build_caddy(ctx, errors):
    record = pick_container(ctx, ctx.conf['CADDY_SERVICE'])
    saved = ctx.state.get('caddy') if isinstance(ctx.state.get('caddy'), dict) else {}
    since = window_start(saved.get('lastTo'), ctx.now)
    out, err = ctx.docker.logs(record, since, ctx.now, stdout=True, stderr=True)
    today_date = local_date(ctx.now, ctx.zone)
    window, today_part = CaddyCounts(), CaddyCounts()
    error_count, last_errors = 0, []
    for line in (out + '\n' + err).splitlines():
        entry = loads_object(line)
        if not entry:
            continue
        logger = entry.get('logger')
        if isinstance(logger, str) and logger.startswith('http.log.access'):
            status = as_int(entry.get('status'))
            request = entry.get('request') if isinstance(entry.get('request'), dict) else {}
            if status is not None:
                ip = cap(request.get('remote_ip'), 64)
                uri = request.get('uri')
                path = cap(uri.split('?', 1)[0], 120) if isinstance(uri, str) else None
                window.add(status, ip, path)
                ts = as_num(entry.get('ts'))
                if (local_date(ts, ctx.zone) if ts is not None else today_date) == today_date:
                    today_part.add(status, ip, path)
        if entry.get('level') == 'error':
            error_count += 1
            last_errors.append(cap(entry.get('msg'), 200))
    buckets = []
    for bucket in saved.get('buckets') or []:
        if isinstance(bucket, dict) and isinstance(bucket.get('t'), (int, float)) and 0 <= ctx.now - bucket['t'] < LAST15M_S:
            buckets.append(bucket)
    buckets.append(dict({'t': ctx.now}, **window.dump(200)))
    last15m = CaddyCounts()
    for bucket in buckets:
        last15m.merge(CaddyCounts.load(bucket))
    saved_today = saved.get('today') if isinstance(saved.get('today'), dict) else {}
    today = CaddyCounts.load(saved_today) if saved_today.get('date') == today_date else CaddyCounts()
    today.merge(today_part)
    ctx.state['caddy'] = {'lastTo': ctx.now, 'buckets': buckets, 'today': dict({'date': today_date}, **today.dump(500))}
    return {
        'window': {'from': iso(since), 'to': iso(ctx.now), 'byStatus': window.statuses(), 'denied': window.top(20),
                   'errors': error_count, 'lastErrors': last_errors[-3:]},
        'last15m': {'byStatus': last15m.statuses(), 'denied': last15m.top(20)},
        'today': {'date': today_date, 'byStatus': today.statuses(), 'denied': today.top(20)},
    }


def build_coolify(ctx, errors):
    if ctx.records is None:
        raise ProbeError(ctx.docker_error)
    rows = []
    for record in ctx.records:
        name = name_of(record)
        if name.startswith('coolify'):
            rows.append({'name': name, 'state': cap(state_of(record).get('Status'), 16),
                         'restartPolicy': cap((record.get('RestartPolicy') or {}).get('Name'), 32)})
    rows.sort(key=lambda r: r['name'])
    return {'containers': rows}


SECTION_ORDER = ('host', 'updates', 'security', 'tls', 'backups', 'docker', 'server', 'caddy', 'coolify')


def collect(ctx):
    results = {}
    # docker first: server, caddy, coolify and tls (the Caddy data volume) read its listing.
    results['docker'] = run_section(ctx, 'docker', build_docker)
    results['host'] = run_section(ctx, 'host', build_host)
    results['updates'] = cached_section(ctx, 'updates', build_updates)
    results['security'] = cached_section(ctx, 'security', build_security)
    results['tls'] = cached_section(ctx, 'tls', build_tls)
    results['backups'] = cached_section(ctx, 'backups', build_backups)
    results['server'] = run_section(ctx, 'server', build_server)
    results['caddy'] = run_section(ctx, 'caddy', build_caddy)
    results['coolify'] = run_section(ctx, 'coolify', build_coolify)
    errors = []
    for name in SECTION_ORDER:
        data, section_errors = results[name]
        if not data.get('ok'):
            errors.append('%s: %s' % (name, data.get('error')))
        errors.extend(e for e in section_errors if e not in errors)
    doc = {'schema': SCHEMA, 'collectedAt': iso(ctx.now),
           'collector': {'version': VERSION, 'durationMs': 0, 'intervalS': INTERVAL_S, 'project': ctx.project,
                         'errors': errors}}
    for name in SECTION_ORDER:
        doc[name] = results[name][0]
    return doc


# ---------------------------------------------------------------------------------------------- config, state, I/O

def load_config(path):
    conf = dict(DEFAULTS)
    if path:
        try:
            text = read_file(path, 65536)
        except ProbeError as exc:
            if exc.code != 'NOT_FOUND':
                raise ConfigError('cannot read %s (%s)' % (path, exc.code)) from None
            print('collect: %s not found; using the defaults' % path, file=sys.stderr)
            text = ''
        for number, raw in enumerate(text.splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            key, sep, value = line.partition('=')
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
                value = value[1:-1]
            if not sep or key not in DEFAULTS:
                raise ConfigError('%s line %d: unknown setting %r' % (path, number, key))
            conf[key] = value
    validate_config(conf)
    return conf


def validate_config(conf):
    checks = {
        'COMPOSE_PROJECT': r'^[a-z0-9][a-z0-9_-]{0,62}$',
        'SERVER_SERVICE': r'^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$',
        'CADDY_SERVICE': r'^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$',
        'CONSOLE_SERVICE': r'^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$',
        'SERVER_PORT': r'^[0-9]{1,5}$',
        'BACKUP_DIR': r'^/[A-Za-z0-9._/-]*$',
        'NET_IFACE': r'^[A-Za-z0-9_.:@-]{1,32}$',
        'OUT_DIR': r'^/[A-Za-z0-9._/-]*$',
        'STATE_DIR': r'^/[A-Za-z0-9._/-]*$',
        'CONSOLE_GID': r'^[0-9]{1,10}$',
        'DISPLAY_TZ': r'^[A-Za-z0-9_+/-]{1,64}$',
    }
    for key, pattern in checks.items():
        if not re.match(pattern, conf[key]) or '..' in conf[key]:
            raise ConfigError('invalid %s: %r' % (key, conf[key]))
    if not 0 < int(conf['SERVER_PORT']) < 65536:
        raise ConfigError('invalid SERVER_PORT')


def fresh_state():
    return {'schema': STATE_SCHEMA, 'runs': 0, 'sections': {}}


def load_state(directory):
    path = os.path.join(directory, 'state.json')
    try:
        state = json.loads(read_file(path, 4 << 20))
    except ProbeError as exc:
        if exc.code != 'NOT_FOUND':
            print('collect: state unreadable (%s); starting fresh' % exc.code, file=sys.stderr)
        return fresh_state()
    except ValueError:
        print('collect: state corrupt; starting fresh', file=sys.stderr)
        return fresh_state()
    if not isinstance(state, dict) or state.get('schema') != STATE_SCHEMA:
        return fresh_state()
    if not isinstance(state.get('sections'), dict):
        state['sections'] = {}
    return state


def write_atomic(path, data, mode, gid=None):
    """tmp + fsync + chmod + (chown) + os.replace in the same folder: a reader sees the old file or the new one."""
    directory = os.path.dirname(path) or '.'
    tmp = path + '.tmp'
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    fd = os.open(tmp, flags, 0o600)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        if gid is not None:
            os.chown(tmp, 0, gid)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if os.name == 'posix':
        try:
            dir_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass


def resolve_cli(value):
    if os.name == 'posix' or os.path.isabs(value):
        return value
    return shutil.which(value) or value


def parse_args(argv):
    parser = argparse.ArgumentParser(prog='collect.py', description='SSAM owner console - host collector')
    parser.add_argument('--config', help='key=value file (default: built-in defaults)')
    parser.add_argument('--out', help='output file (default <OUT_DIR>/host.json)')
    parser.add_argument('--state', help='collector state folder (default STATE_DIR)')
    parser.add_argument('--project', help='compose project (default COMPOSE_PROJECT)')
    parser.add_argument('--now', help='freeze the clock at this ISO time (tests)')
    parser.add_argument('--budget', type=float, default=BUDGET_S, help='seconds for the whole run (default 22)')
    parser.add_argument('--fixture-host', help='read the host facts from this folder')
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--docker', default='docker', help='docker CLI (default: docker in the fixed PATH)')
    group.add_argument('--fixture-docker', help='read the Docker answers from this folder')
    return parser.parse_args(argv)


def main(argv=None):
    try:
        args = parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    try:
        conf = load_config(args.config)
        if args.project:
            conf['COMPOSE_PROJECT'] = args.project
            validate_config(conf)
    except ConfigError as exc:
        print('collect: %s' % exc, file=sys.stderr)
        return 2
    frozen = None
    if args.now:
        frozen = parse_time(args.now)
        if frozen is None:
            print('collect: --now must be an ISO time', file=sys.stderr)
            return 2
    fixture = bool(args.fixture_host or args.fixture_docker)
    out_path = args.out or host_join(conf['OUT_DIR'], 'host.json')
    state_dir = args.state or conf['STATE_DIR']
    started = time.monotonic()
    now = frozen if frozen is not None else time.time()
    try:
        os.makedirs(state_dir, mode=0o700, exist_ok=True)
        os.makedirs(os.path.dirname(out_path) or '.', mode=0o750, exist_ok=True)
    except OSError as exc:
        print('collect: cannot create folders (%s)' % type(exc).__name__, file=sys.stderr)
        return 1
    lock = None
    if fcntl is not None:
        lock = open(os.path.join(state_dir, 'collect.lock'), 'a')
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print('collect: another run is in progress', file=sys.stderr)
            lock.close()
            return 0
    try:
        state = load_state(state_dir)
        run_index = (state.get('runs') if isinstance(state.get('runs'), int) else 0) + 1
        deadline = Deadline(args.budget)
        runner = Runner(deadline, subprocess_env())
        host = HostFixture(args.fixture_host, run_index, conf) if args.fixture_host else HostReal(runner, conf)
        docker = DockerFixture(args.fixture_docker) if args.fixture_docker else DockerReal(runner, resolve_cli(args.docker))
        ctx = Ctx(conf, host, docker, now, state, deadline, fixture)
        doc = collect(ctx)
        duration = 0 if frozen is not None else int((time.monotonic() - started) * 1000)
        doc['collector']['durationMs'] = duration
        gid = None
        if not fixture and hasattr(os, 'geteuid') and os.geteuid() == 0:
            gid = int(conf['CONSOLE_GID'])
        try:
            write_atomic(out_path, json.dumps(doc, separators=(',', ':')).encode('ascii') + b'\n', 0o640, gid)
        except OSError as exc:
            print('collect: could not write %s (%s)' % (out_path, type(exc).__name__), file=sys.stderr)
            return 1
        state['runs'] = run_index
        state['lastRunAt'] = iso(now)
        try:
            write_atomic(os.path.join(state_dir, 'state.json'),
                         json.dumps(state, separators=(',', ':')).encode('ascii'), 0o600)
        except OSError as exc:
            print('collect: could not save the state (%s)' % type(exc).__name__, file=sys.stderr)
        errors = doc['collector']['errors']
        print('collect: host.json written (%d ms); errors: %s' % (duration, '; '.join(errors) if errors else 'none'))
        return 0
    finally:
        if lock is not None:
            lock.close()


if __name__ == '__main__':
    sys.exit(main())
