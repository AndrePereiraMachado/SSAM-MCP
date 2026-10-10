"""Who authenticates a Service Center call, per call and per host (contract _notes/scp/CONTRATO.md, resolver):

1. the Studio connected to SSAM and logged in on the host: its own clients (`studio`), and for .aspx pages its own
   web window (`studio-web`). A bridge with sc_web:login keeps that window hidden and signs it in itself with the vault
   entry SSAM/O11/<host>/ServiceCenter (read inside the Studio, never here); without the entry the private prompt
   opens. An older bridge shows the window for the user to sign in once (`web-sign-in`);
2. a Studio connected but not logged in on that host: STUDIO_NOT_SIGNED_IN (`sign-in` opens the Studio's dialog);
3. no Studio: the Windows vault entry SSAM/O11/<host>/ServiceCenter with the existing form login (pages only);
4. nothing at all: only then a private Windows prompt in its own window that stores the credential in the vault,
   answered with CREDENTIAL_PROMPT_OPENED. No credential ever passes through arguments, output or chat.
LifeTime uses its own service-account token (SSAM/O11/<host>/LifeTime): vault, else the same private prompt."""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .bridge import HIDDEN_LOGIN, StudioBridge
from .http import BridgeError, ProtocolError, Vault, host_name

HOSTS_FILE = pathlib.Path(__file__).with_name('hosts.json')
PROMPT_SCRIPT = pathlib.Path(__file__).with_name('windows-o11-credential.ps1')
# Outside %LOCALAPPDATA%: processes of the Claude app (MSIX) see a private copy of it. Not .ssam: that is GitSSAM's.
STATE = pathlib.Path(os.environ.get('USERPROFILE') or pathlib.Path.home()) / '.ssam-hybrid'
KINDS = ('ServiceCenter', 'LifeTime', 'DatabaseConnection', 'SiteProperty')


def credential_target(host, kind, name=None):
    if kind not in KINDS:
        raise ProtocolError('Unknown credential kind')
    host = host_name(host)
    if kind in ('DatabaseConnection', 'SiteProperty'):
        # The same name rule as Vault.secret_target; the Studio reads these entries inside its own process (secretRefs).
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', name or ''):
            raise ProtocolError(f'{kind} vault entries are named by a plain identifier')
        return f'SSAM/O11/{host}/{kind}/{name}'
    return f'SSAM/O11/{host}/{kind}'


class AuthRequired(BridgeError):
    def __init__(self, code, message, *, auth=None, continuation=None, attempts=None):
        super().__init__(code, message)
        self.auth, self.continuation, self.attempts = auth, continuation, attempts or []

    def answer(self):
        return {'ok': False, 'code': self.code, 'error': str(self), 'auth': self.auth or {},
                **({'continuation': self.continuation} if self.continuation else {}), 'attempts': self.attempts}


@dataclass
class Auth:
    path: str
    host: str
    user: str | None = None
    bridge: object = None
    attempts: list = field(default_factory=list)

    def describe(self):
        return {'path': self.path, 'host': self.host, **({'user': self.user} if self.user else {}), 'attempts': self.attempts}


def studio_running():
    """Whether a Service Studio process is open, connected or not (tasklist; nothing else is inspected)."""
    if os.name != 'nt':
        return False
    try:
        out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq ServiceStudio.exe', '/FO', 'CSV', '/NH'],
                             capture_output=True, text=True, timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return 'servicestudio.exe' in out.lower()


def powershell():
    return str(pathlib.Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'WindowsPowerShell' / 'v1.0' / 'powershell.exe')


def open_prompt(host, kind, name=None, *, state=None, popen=subprocess.Popen, now=time.time):
    """Open the private credential window (Get-Credential + CredWriteW) detached, in its own console. Its output is
    never read: the only result is that the vault entry exists afterwards. One window per target at a time."""
    target = credential_target(host, kind, name)
    folder = pathlib.Path(state or STATE) / 'auth' / 'prompts'
    folder.mkdir(parents=True, exist_ok=True)
    marker = folder / ('o11-' + hashlib.sha256(target.encode('utf-8')).hexdigest()[:24] + '.json')
    if marker.exists() and now() - marker.stat().st_mtime < 300:
        return {'opened': False, 'alreadyOpen': True, 'target': target}
    argv = [powershell(), '-NoProfile', '-File', str(PROMPT_SCRIPT), '-Mode', 'bootstrap', '-Kind', kind, '-HostName', host_name(host)]
    if name:
        argv += ['-Name', name]
    process = popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True,
                    creationflags=getattr(subprocess, 'CREATE_NEW_CONSOLE', 0))
    marker.write_text(json.dumps({'target': target, 'pid': process.pid, 'openedAt': datetime.now(timezone.utc).isoformat()}), encoding='utf-8')
    return {'opened': True, 'target': target}


def host_class(host, registry=HOSTS_FILE):
    hosts = json.loads(pathlib.Path(registry).read_text(encoding='utf-8')).get('hosts', {}) if pathlib.Path(registry).is_file() else {}
    entry = hosts.get(host_name(host)) or {}
    # An environment nobody registered counts as corporate.
    return entry.get('class', 'corporate')


def guard_write(host, words, confirm_host=None, targets=(), registry=HOSTS_FILE):
    """Corporate/unknown hosts need confirmHost and words that name the environment, on every operation; destructive
    operations need words that name each target."""
    kind = host_class(host, registry)
    if kind == 'read-only':
        raise ProtocolError(f'{host} is registered read-only; no Service Center write is sent')
    folded = (words or '').casefold()
    if kind != 'personal':
        label = host.split('.')[0].casefold()
        if confirm_host != host or (label not in folded and host.casefold() not in folded):
            raise ProtocolError(f'{host} is a {kind} environment: every write needs confirmHost={host} and words that name this environment')
    missing = [t for t in targets if t and str(t).casefold() not in folded]
    if missing:
        raise ProtocolError("A destructive operation needs the user's words to name its target: " + ', '.join(map(str, missing)))
    return kind


def _hidden_next(host):
    return {'tool': 'o11_service_center_session', 'action': 'web-sign-in', 'host': host}


def hidden_sign_in(bridge, host, *, present, opener, prompt='auto', attempts=()):
    """The hidden window of the Studio signs in with the stored ServiceCenter login (bridge sc_web login): one submit,
    never repeated. No entry, or an entry the sign-in form rejected: the private prompt opens to store it (again). A
    sign-in that needs the user (another identity provider, MFA) is reported; the window is never shown."""
    host = host_name(host)
    target = credential_target(host, 'ServiceCenter')
    attempts = list(attempts)

    def ask(why, rejected=False):
        if prompt == 'never':
            raise AuthRequired('AUTH_REQUIRED', f'{why}; nothing was prompted (authPrompt=never).',
                               attempts=attempts + [{'path': 'studio-web', 'outcome': 'rejected' if rejected else 'no-login', 'target': target}],
                               continuation=_hidden_next(host))
        opened = opener(host, 'ServiceCenter') or {}
        raise AuthRequired('CREDENTIAL_PROMPT_OPENED', f'{why}: a private Windows prompt opened in its own window for {target}. The user types '
                           'the Service Center login there (for an OutSystems account: its e-mail and password); nothing passes through the chat. '
                           'The Studio signs its hidden Service Center window in with it. Repeat this call after it is stored.',
                           auth={'path': 'prompt', 'host': host, 'target': target, 'alreadyOpen': opened.get('alreadyOpen', False),
                                 **({'rejected': True} if rejected else {})},
                           attempts=attempts + [{'path': 'prompt', 'outcome': 'pending', 'target': target}])

    if not present(target):
        ask(f'No Service Center login is stored for {host}')
    try:
        return bridge.web(host, 'login')
    except AuthRequired:
        raise
    except BridgeError as e:
        if e.code == 'SECRET_NOT_FOUND':
            ask(f'No Service Center login is stored for {host}')
        if e.code == 'WEB_LOGIN_REJECTED':
            ask(f'The sign-in form rejected the Service Center login stored for {host} (it is not submitted again)', True)
        if e.code == 'WEB_SIGN_IN_INTERACTIVE':
            raise AuthRequired('WEB_SIGN_IN_INTERACTIVE', f'The sign-in of {host} needs the user (another identity provider, MFA or a consent '
                               'page); the hidden Service Center window is never shown, so its pages are unavailable here.',
                               attempts=attempts + [{'path': 'studio-web', 'outcome': 'interactive', 'submitted': e.extra.get('submitted')}]) from None
        raise


class Resolver:
    # login: False only for a dry run (session-status wouldUse), which never signs the hidden window in.
    def __init__(self, host, *, session='auto', prompt='auto', credential_target=None, locate=None,
                 present=Vault.present, running=studio_running, opener=open_prompt, login=True):
        if session not in ('auto', 'studio', 'studio-web', 'vault'):
            raise ProtocolError('session must be auto, studio, studio-web or vault')
        if prompt not in ('auto', 'never'):
            raise ProtocolError('authPrompt must be auto or never')
        self.host = host_name(host)
        self.session, self.prompt, self.target, self.login = session, prompt, credential_target, login
        self.locate, self.present, self.running, self.opener = locate or StudioBridge.locate, present, running, opener
        self._studio = None

    def studio(self):
        """(bridge or None, session info or None, attempts) for this host, computed once per call."""
        if self._studio is None:
            attempts, bridge, info = [], None, None
            try:
                bridge = self.locate()
            except BridgeError as e:
                raise AuthRequired(e.code, str(e), continuation={'tool': 'ssam_connect', 'lane': 'o11'}) from None
            if bridge is None:
                attempts.append({'path': 'studio', 'outcome': 'absent', 'reason': 'no SSAM bridge answers on the O11 lane'})
            elif not bridge.supports():
                attempts.append({'path': 'studio', 'outcome': 'unsupported',
                                 'reason': 'the loaded bridge predates sc_session/sc_api/sc_web/studio_login'})
            else:
                info = bridge.session(self.host)
            self._studio = (bridge, info, attempts)
        return self._studio

    def resolve(self, need):
        """need: api (SOAP/server.api/rest through the Studio), web (.aspx pages) or lifetime (LifeTime token)."""
        if need not in ('api', 'web', 'lifetime'):
            raise ProtocolError('Unknown authentication need')
        attempts = []
        if self.session != 'vault' and need != 'lifetime':
            bridge, info, found = self.studio()
            attempts += found
            if bridge is not None and info is None:
                if need == 'web' and self.session == 'auto' and self.present(self.vault_target('web')):
                    return Auth('vault', self.host, None, None, attempts + [{'path': 'vault', 'outcome': 'used', 'target': self.vault_target('web')}])
                raise AuthRequired('STUDIO_BRIDGE_OUTDATED', 'The connected Studio runs a bridge without the Service Center verbs. Open the '
                                   'Studio through the SSAM shortcut so the new bridge loads, then ssam connect --lane o11. No credential '
                                   'prompt is opened while a Studio is connected.', attempts=attempts,
                                   continuation={'tool': 'ssam_connect', 'lane': 'o11'})
            if info is not None:
                studio = info.get('studio') if isinstance(info.get('studio'), dict) else info
                web = info.get('web') if isinstance(info.get('web'), dict) else {}
                user = studio.get('user')
                if studio.get('signedIn') is not True:
                    raise AuthRequired('STUDIO_NOT_SIGNED_IN', f'The connected Studio is not logged in on {self.host}. o11_service_center_session '
                                       'action=sign-in opens the Studio\'s own login dialog (password or SSO); the user signs in there.',
                                       attempts=attempts + [{'path': 'studio', 'outcome': 'not-signed-in'}],
                                       continuation={'tool': 'o11_service_center_session', 'action': 'sign-in', 'host': self.host})
                if need == 'api':
                    return Auth('studio', self.host, user, bridge, attempts + [{'path': 'studio', 'outcome': 'used'}])
                if web.get('signedIn') is True:
                    return Auth('studio-web', self.host, user, bridge, attempts + [{'path': 'studio-web', 'outcome': 'used'}])
                if HIDDEN_LOGIN in (bridge.capabilities() or ()):
                    if not self.login:
                        raise AuthRequired('WEB_SIGN_IN_REQUIRED', f'The hidden Service Center window of the Studio is not signed in on {self.host} '
                                           'yet; the next page call signs it in with the stored login.',
                                           attempts=attempts + [{'path': 'studio-web', 'outcome': 'not-signed-in'}],
                                           continuation=_hidden_next(self.host))
                    hidden_sign_in(bridge, self.host, present=self.present, opener=self.opener, prompt=self.prompt, attempts=attempts)
                    return Auth('studio-web', self.host, user, bridge, attempts + [{'path': 'studio-web', 'outcome': 'signed-in-hidden'}])
                raise AuthRequired('WEB_SIGN_IN_REQUIRED', f"Service Center pages go through the Studio's own web window, not signed in on {self.host} yet. "
                                   'o11_service_center_session action=web-sign-in opens it; the user signs in once there, then repeat this call.',
                                   attempts=attempts + [{'path': 'studio-web', 'outcome': 'not-signed-in'}],
                                   continuation={'tool': 'o11_service_center_session', 'action': 'web-sign-in', 'host': self.host})
            if self.session in ('studio', 'studio-web'):
                raise AuthRequired('STUDIO_NOT_CONNECTED', 'No Studio is connected to SSAM; open the Service Studio and run ssam_connect {lane:"o11"}.',
                                   attempts=attempts, continuation={'tool': 'ssam_connect', 'lane': 'o11'})
            if self.running():
                raise AuthRequired('STUDIO_NOT_CONNECTED', 'A Service Studio is open but not connected to SSAM; run ssam_connect {lane:"o11"} and '
                                   'repeat. Credentials are asked only when no Studio is open.', attempts=attempts,
                                   continuation={'tool': 'ssam_connect', 'lane': 'o11'})
        if need == 'api':
            raise AuthRequired('STUDIO_REQUIRED', f'This operation runs through the Service Studio API; open the Service Studio, log in to {self.host} '
                               'and run ssam_connect {lane:"o11"}. The vault login covers Service Center pages only.', attempts=attempts,
                               continuation={'tool': 'ssam_connect', 'lane': 'o11'})
        target = self.vault_target(need)
        if self.present(target):
            return Auth('vault', self.host, None, None, attempts + [{'path': 'vault', 'outcome': 'used', 'target': target}])
        attempts.append({'path': 'vault', 'outcome': 'absent', 'target': target})
        continuation = {'tool': 'o11_service_center_session', 'action': 'sign-in', 'host': self.host,
                        **({'surface': 'lifetime'} if need == 'lifetime' else {})}
        if self.prompt == 'never':
            raise AuthRequired('AUTH_REQUIRED', f'No Studio and no vault credential for {self.host}; nothing was prompted (authPrompt=never).',
                               attempts=attempts, continuation=continuation)
        opened = self.opener(self.host, 'LifeTime' if need == 'lifetime' else 'ServiceCenter')
        raise AuthRequired('CREDENTIAL_PROMPT_OPENED', 'No Studio and no vault credential: a private Windows prompt opened in its own window '
                           f'for {target}. The user types there; nothing passes through the chat. Repeat this call after it is stored.',
                           auth={'path': 'prompt', 'host': self.host, 'target': target, 'alreadyOpen': opened.get('alreadyOpen', False)},
                           attempts=attempts + [{'path': 'prompt', 'outcome': 'pending', 'target': target}])

    def vault_target(self, need):
        if need == 'lifetime':
            return credential_target(self.host, 'LifeTime')
        return self.target or credential_target(self.host, 'ServiceCenter')
