"""The connected Service Studio's Service Center verbs (contract _notes/scp/CONTRATO.md, O11 section): sc_session,
sc_api, sc_web and studio_login over the existing JSON-lines bridge and its authority key. The Studio's token,
id_token and cookies never leave the Studio process; only projected business data comes back."""
from __future__ import annotations

import json
import os
import pathlib
import re
import socket
import uuid

from .http import NOT_SENT, BridgeError, host_name

KERNEL = pathlib.Path(__file__).resolve().parents[2]
VERBS = ('sc_session', 'sc_api', 'sc_web', 'studio_login')
# SECRET_NOT_FOUND: a sc_web secretRefs (or login) entry is missing from the vault (the bridge names its target, never a value).
# WEB_LOGIN_REJECTED / WEB_SIGN_IN_INTERACTIVE: sc_web login submitted the stored login once and the form came back / the
# sign-in needs the user (another identity provider, MFA); the hidden window is never shown.
CODES = ('STUDIO_NOT_SIGNED_IN', 'WEB_SIGN_IN_REQUIRED', 'NOT_ALLOWED', 'HOST_MISMATCH', 'UNCERTAIN', 'REMOTE_ERROR', 'BAD_REQUEST',
         'SECRET_NOT_FOUND', 'WEB_LOGIN_REJECTED', 'WEB_SIGN_IN_INTERACTIVE')
# The bridge keeps its Service Center window hidden and signs it in with the vault login (sc_web open {hidden}, sc_web login).
HIDDEN_LOGIN = 'sc_web:login'
SECRET_KEY = re.compile(r'pass(?:word|wd)|secret|token|cookie|authorization|connection_?string|credential|api_?key', re.I)
REPLY_LIMIT = 100 * 1024 * 1024


def redact_text(text):
    text = re.sub(r'(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}', r'\1 <redacted>', text)
    text = re.sub(r'(?i)\b(password|pwd|secret|token|access_token|id_token|refresh_token)(\s*[=:]\s*)[^;&\s,"\']+', r'\1\2<redacted>', text)
    return re.sub(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}', '<redacted-jwt>', text)


def redact(value):
    """Business data only: secret-named fields are masked whatever the bridge projected."""
    if isinstance(value, dict):
        return {k: '<redacted>' if SECRET_KEY.search(str(k)) and v not in (None, '', False) else redact(v)
                for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


class StudioBridge:
    corporate = False  # a write to a corporate host passed auth.guard_write (corporateInstruction)

    def __init__(self, port, key_file, pid=None, timeout=120.0, connect=socket.create_connection):
        self.port, self.key_file, self.pid, self.timeout, self.connect = port, pathlib.Path(key_file), pid, timeout, connect
        self.version = None
        self._verbs = None
        self._capabilities = None

    @classmethod
    def locate(cls, root=KERNEL, lane_name=None, timeout=120.0):
        """The bridge of the Studio selected with `ssam connect --lane o11`, or None when no bridge answers."""
        lane = (lane_name or os.environ.get('ANVIL_LANE') or 'ss4').strip().lower()
        record_file = pathlib.Path(root) / '.local' / 'connections' / f'{lane}.json'
        record = None
        if record_file.is_file():
            record = json.loads(record_file.read_text(encoding='utf-8-sig'))
            if (record.get('ok') is not True or not isinstance(record.get('port'), int) or not isinstance(record.get('pid'), int)
                    or not pathlib.Path(str(record.get('authorityDir', ''))).is_absolute()):
                raise BridgeError('STUDIO_NOT_CONNECTED', 'Invalid Studio connection record; run ssam connect --lane o11')
        if record:
            port, key_file = record['port'], pathlib.Path(record['authorityDir']) / 'bridge.key'
        else:
            import anvil_authority
            import lanes
            port, key_file = lanes.lane(lane).bridge, anvil_authority.key_path()
        bridge = cls(port, key_file, None, timeout)
        alive = bridge.ping()
        if alive is None:
            return None
        if record and alive['pid'] != record['pid']:
            raise BridgeError('STUDIO_NOT_CONNECTED', 'The Studio selected with ssam connect is no longer the one on the bridge port; run ssam connect --lane o11 again')
        bridge.pid, bridge.version = alive['pid'], alive.get('version')
        return bridge

    def _exchange(self, method, params, write=False, authenticated=True):
        try:
            sock = self.connect(('127.0.0.1', self.port), timeout=self.timeout)
        except OSError:
            raise BridgeError('STUDIO_UNAVAILABLE', 'No bridge answers on the lane port; nothing was sent', write=write) from None
        try:
            request = {'method': method, 'params': params}
            if authenticated:
                try:
                    request['authorization'] = self.key_file.read_text(encoding='ascii').strip()
                except OSError:
                    raise BridgeError('NOT_ALLOWED', 'The local controller authority is unavailable; nothing was sent', write=write) from None
            sock.sendall((json.dumps(request) + '\n').encode('utf-8'))
            request.clear()
            buffer = b''
            while b'\n' not in buffer:
                chunk = sock.recv(1 << 20)
                if not chunk:
                    raise ConnectionError('bridge closed the connection')
                buffer += chunk
                if len(buffer) > REPLY_LIMIT:
                    raise ValueError('bridge reply exceeds its size limit')
            return json.loads(buffer.split(b'\n', 1)[0].decode('utf-8'))
        except BridgeError:
            raise
        except (OSError, ValueError):
            if write:
                raise BridgeError('UNCERTAIN', 'The bridge connection broke after the write was sent; reconcile by a read, never repeat it', write=True) from None
            raise BridgeError('STUDIO_UNAVAILABLE', 'The bridge connection broke during a read; nothing was changed') from None
        finally:
            sock.close()

    def ping(self):
        try:
            reply = self._exchange('ping', {}, authenticated=False)
        except BridgeError:
            return None
        data = reply.get('data') or {}
        if reply.get('success') is not True or data.get('bridge') != 'anvil' or not isinstance(data.get('pid'), int):
            return None
        return data

    def verbs(self):
        if self._verbs is None:
            reply = self._exchange('bridge_manifest', {}, authenticated=False)
            data = (reply.get('data') or {}) if reply.get('success') is True else {}
            self._capabilities = {str(c) for c in data.get('capabilities') or []}
            self._verbs = set(data.get('verbs') or []) | {c.split(':')[0] for c in self._capabilities}
        return self._verbs

    def capabilities(self):
        """The manifest's capability strings (sc_api:soap, sc_web, sc_web:secretRefs...)."""
        self.verbs()
        return self._capabilities

    def supports(self):
        return set(VERBS) <= self.verbs()

    def _verb(self, method, params, write=False):
        reply = self._exchange(method, params, write)
        data = reply.get('data')
        if reply.get('success') is True and not (isinstance(data, dict) and data.get('ok') is False):
            return data if isinstance(data, dict) and data.get('ok') is True else {'ok': True, 'result': data}
        # A failure carries the contract answer in data ({ok:false, code, message}) and executed:false when nothing
        # left the Studio; older bridges only have the error text.
        data = data if isinstance(data, dict) else {}
        error = str(data.get('message') or reply.get('error') or '')
        executed = reply.get('executed', data.get('executed'))
        code = data.get('code') or reply.get('code')
        if code not in (*CODES, 'STUDIO_UNAVAILABLE'):
            if error.startswith('Unknown method'):
                code = 'STUDIO_BRIDGE_OUTDATED'
                error = 'The loaded bridge has no ' + method + '; reconnect a new bridge version'
            elif executed is False:
                code = 'NOT_ALLOWED'
            else:
                code = next((c for c in CODES if c in error), None) or ('UNCERTAIN' if write else 'REMOTE_ERROR')
        raise BridgeError(code, redact_text(error or code)[:500], write=write, executed=executed,
                          **{k: redact(data[k]) for k in ('status', 'fault', 'gate', 'signedInHosts', 'signInRequired', 'target', 'part', 'location', 'submitted') if k in data})

    def session(self, host):
        return self._verb('sc_session', {'host': host_name(host)})

    def login(self, host):
        return self._verb('studio_login', {'host': host_name(host)})

    def write_fields(self, operation_id, authorize_sha256, target=None):
        fields = {'write': True, **authorization(operation_id, authorize_sha256)}
        if target:
            fields['target'] = target
        if self.corporate:
            # Set by the caller only after confirmHost and words naming the environment passed (auth.guard_write).
            fields['corporateInstruction'] = True
        return fields

    def api(self, host, surface, operation, args=None, *, write=False, operation_id=None, authorize_sha256=None, target=None):
        if surface not in ('soap', 'server-api', 'sc-rest') or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{1,80}', operation or ''):
            raise BridgeError('BAD_REQUEST', 'Unknown Service Center API surface or operation', write=write)
        params = {'host': host_name(host), 'surface': surface, 'operation': operation, 'args': args or {}}
        if write:
            params.update(self.write_fields(operation_id, authorize_sha256, target))
        return self._verb('sc_api', params, write)

    def web(self, host, action, *, method=None, path=None, form=None, accept=None, write=False,
            operation_id=None, authorize_sha256=None, secret_refs=None, hidden=False):
        if action not in ('status', 'open', 'login', 'fetch', 'close'):
            raise BridgeError('BAD_REQUEST', 'Unknown Service Center web action')
        params = {'host': host_name(host), 'action': action}
        if action == 'open' and hidden:
            params['hidden'] = True
        if action == 'fetch':
            if method not in ('GET', 'POST') or not str(path or '').lower().startswith('/servicecenter/'):
                raise BridgeError('BAD_REQUEST', 'Studio web fetch needs GET/POST and a /ServiceCenter/ path', write=write)
            params.update(method=method, path=path, accept=accept or 'html')
            if form is not None:
                params['form'] = form
            # A state-changing postback carries the same authorization fields as sc_api; reads go without them.
            if write:
                params.update(self.write_fields(operation_id, authorize_sha256))
            if secret_refs:
                # Vault target names only: the Studio reads the values inside its own process right before the send.
                if not write or form is None:
                    raise BridgeError('BAD_REQUEST', 'secretRefs go only on a write postback', write=write)
                params['secretRefs'] = [{'pointer': r['pointer'], 'target': r['target'], 'field': r['field']} for r in secret_refs]
        return self._verb('sc_web', params, write and action == 'fetch')


def authorization(operation_id, authorize_sha256):
    try:
        canonical = str(uuid.UUID(str(operation_id)))
    except ValueError:
        raise BridgeError('BAD_REQUEST', 'A write needs an operationId UUID', write=True) from None
    if not re.fullmatch(r'[0-9a-f]{64}', authorize_sha256 or ''):
        raise BridgeError('BAD_REQUEST', "A write needs the sha256 of the user's authorization words", write=True)
    return {'operationId': canonical, 'authorizeSha256': authorize_sha256}
