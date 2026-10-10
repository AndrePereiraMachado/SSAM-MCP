"""Bounded, same-origin HTTP and HTML forms for the Service Center protocol.

This is an independent implementation. HTML and protocol contracts are data;
scripts from the server are never evaluated. Cookies and credentials stay in memory
(direct HTTPS) or in the Studio process (StudioWebTransport).
"""
from __future__ import annotations

import base64
import ctypes
import http.cookiejar
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass, field
from html.parser import HTMLParser


class ProtocolError(RuntimeError):
    pass


class BridgeError(ProtocolError):
    """A refusal or failure with a contract code (STUDIO_NOT_SIGNED_IN, WEB_SIGN_IN_REQUIRED, UNCERTAIN...)."""
    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


# Codes with which the bridge turns a request down before sending anything to Service Center.
NOT_SENT = frozenset({'NOT_ALLOWED', 'BAD_REQUEST', 'HOST_MISMATCH', 'STUDIO_NOT_SIGNED_IN', 'WEB_SIGN_IN_REQUIRED',
                      'STUDIO_BRIDGE_OUTDATED', 'STUDIO_UNAVAILABLE', 'SECRET_NOT_FOUND'})
# bridge_manifest capability of a bridge that fills sc_web secretRefs from the vault inside the Studio (CONTRATO, o11-facade).
SECRET_CAPABILITY = 'sc_web:secretRefs'
# Once the session expired the login page answers in place of the asked page (same URL, HTTP 200, live on 11.42): its form
# posts to Login.aspx inside div.sc-layout-login, with only "Log in with SSO" when the environment signs in by SSO.
LOGIN_PAGE = re.compile(r'<form\b[^>]*\baction="(?:[^"]*/)?_?login(?:sso)?\.aspx(?:\?[^"]*)?"|class="[^"]*\bsc-layout-login\b', re.I)


def host_name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", value):
        raise ProtocolError("Use a DNS host, without scheme, port, path or credentials")
    if any(not p or len(p) > 63 or p.startswith('-') or p.endswith('-') for p in value.split('.')):
        raise ProtocolError("Invalid DNS host")
    return value.lower()


class Vault:
    """Windows generic credential: UTF-16 password blob, native UserName field."""
    def __init__(self, host, target=None):
        self.host = host_name(host)
        self.target = target or f"SSAM/O11/{self.host}/ServiceCenter"
        if self.target not in (f"SSAM/O11/{self.host}/ServiceCenter", f"SSAM/O11/{self.host}/ServiceStudio"):
            raise ProtocolError("Credential target must match this O11 host and ServiceCenter or ServiceStudio")

    @staticmethod
    def _native(target, use):
        if os.name != 'nt':
            raise ProtocolError("Windows Credential Manager is required")
        from ctypes import wintypes as w

        class Credential(ctypes.Structure):
            _fields_ = [('flags', w.DWORD), ('type', w.DWORD), ('target', w.LPWSTR),
                        ('comment', w.LPWSTR), ('written', w.FILETIME), ('size', w.DWORD),
                        ('blob', ctypes.c_void_p), ('persist', w.DWORD), ('count', w.DWORD),
                        ('attributes', ctypes.c_void_p), ('alias', w.LPWSTR), ('user', w.LPWSTR)]

        api = ctypes.WinDLL('advapi32', use_last_error=True)
        api.CredReadW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.POINTER(ctypes.POINTER(Credential))]
        api.CredReadW.restype = w.BOOL
        api.CredFree.argtypes = [ctypes.c_void_p]
        pointer = ctypes.POINTER(Credential)()
        if not api.CredReadW(target, 1, 0, ctypes.byref(pointer)):
            return use(None)
        try:
            return use(pointer.contents)
        finally:
            api.CredFree(pointer)

    @classmethod
    def read(cls, target, require_user=True):
        def use(c):
            if c is None:
                raise ProtocolError("Credential unavailable in Windows Credential Manager")
            if not c.size or c.size % 2 or (require_user and not c.user):
                raise ProtocolError("Stored credential is incomplete")
            return c.user, ctypes.string_at(c.blob, c.size).decode('utf-16-le')
        return cls._native(target, use)

    @classmethod
    def present(cls, target):
        # Status only: the blob is never decoded.
        return cls._native(target, lambda c: c is not None and bool(c.size))

    def exists(self):
        return self.present(self.target)

    def login_fields(self, user_field, password_field):
        user, password = self.read(self.target)
        return {user_field: user, password_field: password}

    # Database connection logins (SSAM/O11/<host>/DatabaseConnection/<name>) and secret site property values
    # (SSAM/O11/<host>/SiteProperty/<name>) are never read here: only their target names travel, as sc_web secretRefs,
    # and the Studio reads them inside its own process right before the send (CONTRATO, item 1 of wave 2).
    def secret_target(self, kind, name):
        if kind not in ('DatabaseConnection', 'SiteProperty') or not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', name or ''):
            raise ProtocolError(f"{kind} vault entries are named by a plain identifier")
        return f"SSAM/O11/{self.host}/{kind}/{name}"


@dataclass(eq=False)
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)
    parent: Node | None = None

    def all(self, *tags):
        for c in self.children:
            if isinstance(c, Node):
                if not tags or c.tag in tags:
                    yield c
                yield from c.all(*tags)

    @property
    def text(self):
        if self.tag in ('script', 'style', 'input'):
            return ''
        return ' '.join(' '.join(c.text if isinstance(c, Node) else c for c in self.children).split())

    @property
    def readable(self):
        if self.tag in ('script', 'style', 'input'):
            return ''
        if self.tag == 'br':
            return '\n'
        content = ''.join(c.readable if isinstance(c, Node) else c for c in self.children)
        return '\n' + content + '\n' if self.tag in ('div', 'p', 'tr', 'pre', 'li', 'h1', 'h2', 'h3') else content

    def ancestor(self, tag):
        n = self.parent
        while n is not None and n.tag != tag:
            n = n.parent
        return n


class Document(HTMLParser):
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'wbr'}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Node('document')
        self.current = self.root
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        # HTML's optional table/cell/option end tags, common in older SC versions.
        optional = {'tr': {'tr'}, 'td': {'td', 'th'}, 'th': {'td', 'th'}, 'option': {'option'}, 'li': {'li'}}
        if self.current.tag in optional.get(tag, set()):
            self.current = self.current.parent
        n = Node(tag, dict(attrs), parent=self.current)
        self.current.children.append(n)
        if tag not in self.VOID:
            self.current = n

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        n = self.current
        while n is not self.root and n.tag != tag:
            n = n.parent
        if n is not self.root:
            self.current = n.parent

    def handle_data(self, data):
        self.current.children.append(data)

    def all(self, *tags):
        return self.root.all(*tags)

    def login(self):
        return any(n.attrs.get('type', '').lower() == 'password' for n in self.all('input'))

    def label(self, node):
        # Modern Service Center labels carry for='' (matrix rule 4): only a real id pairs a label with its control.
        labels = [n.text for n in self.all('label') if n.attrs.get('for') and n.attrs.get('for') == node.attrs.get('id')]
        return ' '.join(labels) or node.attrs.get('aria-label') or node.attrs.get('title') or ''

    def content(self):
        """The page's own content: div.sc-content-main of the modern Service Center (never the sidebar with Recent
        Items, the licensee line or the Apply Settings alert); the whole document on pages without it."""
        found = [n for n in self.all('div') if 'sc-content-main' in n.attrs.get('class', '').split()]
        return found[0] if len(found) == 1 else self.root


def controls(form):
    return [n for n in form.all('input', 'select', 'textarea', 'button')
            if n.attrs.get('name') and 'disabled' not in n.attrs]


def control_value(n):
    if n.tag == 'textarea':
        # Preserve whitespace of Text/Long Text properties.
        return ''.join(c for c in n.children if isinstance(c, str))
    if n.tag == 'select':
        options = list(n.all('option'))
        chosen = next((o for o in options if 'selected' in o.attrs), options[0] if options else None)
        return chosen.attrs.get('value', chosen.text) if chosen else ''
    if n.attrs.get('type', '').lower() in ('checkbox', 'radio') and 'value' not in n.attrs:
        return 'on'  # what a browser posts for a checked box without a value attribute
    return n.attrs.get('value', '') or ''


def json_pointer(name):
    """RFC 6901 pointer of one form field (secretRefs address fields of sc_web's form object)."""
    return '/' + name.replace('~', '~0').replace('/', '~1')


def secret_refs(secrets):
    """{field name: {target, field}} -> the contract's secretRefs entries. Only vault target names travel; the value is
    read inside the Studio process right before the send."""
    refs = []
    for name, ref in (secrets or {}).items():
        if ref.get('field') not in ('password', 'username') or not re.fullmatch(r'SSAM/O11/[a-z0-9.-]+/(?:DatabaseConnection|SiteProperty)/[A-Za-z0-9_.-]{1,100}', ref.get('target') or ''):
            raise ProtocolError('A secret reference names a same-host DatabaseConnection or SiteProperty vault entry and password or username')
        refs.append({'pointer': json_pointer(name), 'target': ref['target'], 'field': ref['field']})
    return refs


def form_fields(form, clicked=None):
    pairs = []
    for n in controls(form):
        kind = n.attrs.get('type', 'submit' if n.tag == 'button' else 'text').lower()
        if kind in ('submit', 'button', 'image', 'reset') and n is not clicked:
            continue
        if kind in ('checkbox', 'radio') and 'checked' not in n.attrs:
            continue
        pairs.append((n.attrs['name'], control_value(n)))
    return pairs


def button(page, names):
    wanted = {s.casefold() for s in names}
    found = [n for n in page.doc.all('input', 'button')
             if n.attrs.get('type', 'submit' if n.tag == 'button' else '').lower() in ('submit', 'button')
             and (n.attrs.get('value', '') or n.text).strip().casefold() in wanted
             and 'disabled' not in n.attrs]
    if len(found) != 1:
        raise ProtocolError("Expected one available control: " + '/'.join(names))
    if found[0].attrs.get('type', '').lower() == 'button':
        raise ProtocolError("This version requires an unsupported JavaScript form action")
    return found[0]


def postback_target(link):
    """The Web Forms event of a __doPostBack link, or of an OsAjax link (its control name)."""
    source = (link.attrs.get('href', '') + '\n' + link.attrs.get('onclick', '')).replace('&#39;', "'")
    match = re.search(r"__doPostBack\('([^']*)','([^']*)'\)", source)
    if match:
        return {'kind': 'postback', 'target': match.group(1), 'argument': match.group(2)}
    match = re.search(r"OsAjax\([^,]*,\s*'([^']*)'\s*,\s*'([^']*)'", source)
    if match:
        return {'kind': 'osajax', 'target': match.group(2), 'argument': ''}
    return None


def confirm_text(node):
    match = re.search(r"confirm\('((?:\\'|[^'])*)'\)", node.attrs.get('onclick', ''), re.S)
    raw = match.group(1) if match else ''
    return raw.replace('\\x27', "'").replace("\\'", "'").replace('\\n', '\n').replace('\\r', '')


@dataclass
class Page:
    url: str
    doc: Document


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


LIMIT = 8 * 1024 * 1024
BINARY_LIMIT = 64 * 1024 * 1024
STATE = re.compile(r'^__(?:OSVSTATE|VIEWSTATE|VIEWSTATEGENERATOR|EVENTVALIDATION)$')


class Transport:
    """Direct HTTPS with an in-memory cookie jar; the vault form login authenticates it."""
    preauthenticated = False
    authorized = None
    source = 'vault'

    def secrets_supported(self):
        # This process never holds a database login or a secret property value: only the Studio's web window can
        # receive them (sc_web secretRefs), so the direct HTTPS path refuses every write that carries one.
        return False

    def __init__(self, host, timeout=30):
        self.host = host_name(host)
        self.base = f'https://{self.host}/ServiceCenter/'
        self.timeout = timeout
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def url(self, value, base=None):
        url = urllib.parse.urljoin(base or self.base, value)
        p = urllib.parse.urlsplit(url)
        if (p.scheme != 'https' or p.netloc.lower() != self.host or p.username or p.fragment
                or not p.path.lower().startswith('/servicecenter/') or any(s in ('.', '..') for s in p.path.split('/'))
                or re.search(r'%2f|%5c|%2e', p.path, re.I) or '\\' in url):
            raise ProtocolError("Service Center request/redirect must stay on the exact HTTPS host and path")
        return url

    def fetch(self, url, fields=None, accept='html', secret_refs=None):
        """(final url, content type, body bytes, charset). accept: html, text (AJAX replies), xlsx or binary."""
        url = self.url(url)
        if secret_refs:
            raise BridgeError('STUDIO_REQUIRED', "A secret value goes only through the connected Studio's web window (secretRefs); "
                              'this process never reads it. Nothing was sent.', write=True, executed=False)
        data = None if fields is None else urllib.parse.urlencode(fields).encode('utf-8')
        for _ in range(6):
            req = urllib.request.Request(url, data=data, headers={
                'User-Agent': 'SSAM-Hybrid-O11/1', 'Accept': 'text/html' if accept == 'html' else '*/*', 'Connection': 'close',
                **({'Content-Type': 'application/x-www-form-urlencoded'} if data is not None else {})})
            try:
                response = self.opener.open(req, timeout=self.timeout)
            except urllib.error.HTTPError as e:
                if e.code in (301, 302, 303, 307, 308):
                    try:
                        location = e.headers.get('Location', '')
                        if not location:
                            raise ProtocolError('Service Center redirect has no destination')
                        if urllib.parse.urlsplit(urllib.parse.urljoin(url, location)).hostname == 'id.outsystems.com':
                            raise ProtocolError('Service Center requires OutSystems ID SSO; this HTTP adapter has no validated SSO exchange. No vault credential was sent to the identity provider')
                        destination = self.url(location, url)
                    finally:
                        e.close()
                    if data is not None and e.code in (307, 308):
                        raise ProtocolError("Refusing to replay a POST after a redirect")
                    url, data = destination, None
                    continue
                status = e.code
                e.close()
                raise ProtocolError(f"Service Center returned HTTP {status}") from None
            except (OSError, urllib.error.URLError):
                raise ProtocolError("Service Center connection failed; no automatic retry") from None
            with response:
                kind = response.headers.get('Content-Type', '').lower()
                accepted(kind, accept)
                limit = LIMIT if accept in ('html', 'text') else BINARY_LIMIT
                raw = response.read(limit + 1)
                if len(raw) > limit:
                    raise ProtocolError("Service Center response exceeds its size limit")
                return url, kind, raw, response.headers.get_content_charset() or 'utf-8'
        raise ProtocolError("Too many Service Center redirects")

    def request(self, url, fields=None, secret_refs=None):
        final, _, raw, charset = self.fetch(url, fields, **({'secret_refs': secret_refs} if secret_refs else {}))
        return Page(final, Document(raw.decode(charset, errors='replace')))

    def text(self, url, fields=None):
        _, _, raw, charset = self.fetch(url, fields, 'text')
        return raw.decode(charset, errors='replace')

    def reply(self, url, fields=None):
        """(final url, text) of a read postback whose answer may be a page or an OsAjax reply."""
        final, _, raw, charset = self.fetch(url, fields, 'text')
        return final, raw.decode(charset, errors='replace')

    def download(self, url, fields=None, accept='binary'):
        return self.fetch(url, fields, accept)[2]

    def form_post(self, page, clicked, updates=None):
        """(action url, fields) of a click on a plain submit control; nothing is sent."""
        form = clicked.ancestor('form')
        if form is None or form.attrs.get('method', 'get').lower() != 'post':
            raise ProtocolError("Expected a POST form")
        # Unrecognized JS submit routing must not silently become a different operation.
        if clicked.attrs.get('formaction') or re.search(r'OsAjax|__doPostBack|\.submit\(', clicked.attrs.get('onclick', ''), re.I):
            raise ProtocolError("Unsupported scripted form submission; no request sent")
        fields = form_fields(form, clicked)
        updates = updates or {}
        names = {n.attrs['name'] for n in controls(form)}
        if not updates.keys() <= names:
            raise ProtocolError("Unknown form field")
        fields = [(k, v) for k, v in fields if k not in updates]
        fields.extend((k, v) for k, v in updates.items() if v is not None)
        return self.url(form.attrs.get('action') or page.url, page.url), fields

    def submit(self, page, clicked, updates=None, secrets=None):
        """secrets: {field name: {target, field}}. Those fields go as empty placeholders and the Studio fills them from
        the vault (secretRefs); the value never exists in this process."""
        if not secrets:
            return self.request(*self.form_post(page, clicked, updates))
        if set(secrets) & set(updates or {}):
            raise ProtocolError('A secret field cannot also carry a value')
        url, fields = self.form_post(page, clicked, {**(updates or {}), **{name: '' for name in secrets}})
        return self.request(url, fields, secret_refs=secret_refs(secrets))

    def ajax_post(self, page, control, updates=None, event=None, ajax=None):
        """(action url, fields) of an OsAjax event on a control, as the page's script sends it: the form state, the
        control's own value, __EVENTTARGET and __AJAX (matrix L7, D5). A submit adds its own name=value; a select's
        Change carries __AJAXEVENT instead of __EVENTARGUMENT. Nothing is sent."""
        form = control.ancestor('form')
        if form is None or form.attrs.get('method', 'get').lower() != 'post':
            raise ProtocolError("Expected a POST form around the OsAjax control")
        updates = dict(updates or {})
        names = {n.attrs['name'] for n in controls(form)}
        if not set(updates) <= names:
            raise ProtocolError("Unknown form field")
        name = control.attrs['name']
        fields = [(k, v) for k, v in form_fields(form) if k not in updates and k not in ('__EVENTTARGET', '__EVENTARGUMENT', '__AJAX', '__AJAXEVENT')]
        fields.extend((k, v) for k, v in updates.items() if v is not None)
        fields.append(('__EVENTTARGET', name))
        fields.append(('__AJAXEVENT', event) if event else ('__EVENTARGUMENT', ''))
        fields.append(('__AJAX', ajax or '1280,1024,' + (control.attrs.get('id') or name.replace('$', '_')) + ',0,0,0,0,0,0,'))
        if control.attrs.get('type', '').lower() == 'submit':
            fields.append((name, control.attrs.get('value', '')))
        return self.url(form.attrs.get('action') or page.url, page.url), fields

    def export(self, page, clicked, updates=None, accept='xlsx'):
        return self.download(*self.form_post(page, clicked, updates), accept=accept)

    def event_post(self, page, link, updates=None, extra=None):
        """(action url, fields) of a __doPostBack or OsAjax link: the page's own form state plus the event."""
        event = postback_target(link)
        if event is None:
            raise ProtocolError("Link is not a recognized Web Forms postback; no request sent")
        form = link.ancestor('form') or next(page.doc.all('form'), None)
        if form is None or form.attrs.get('method', 'get').lower() != 'post':
            raise ProtocolError("Expected a POST form around the postback")
        updates = dict(updates or {})
        names = {n.attrs['name'] for n in controls(form)}
        if not set(updates) <= names:
            raise ProtocolError("Unknown form field")
        fields = [(k, v) for k, v in form_fields(form) if k not in updates and k not in ('__EVENTTARGET', '__EVENTARGUMENT')]
        fields.extend((k, v) for k, v in updates.items() if v is not None)
        if event['kind'] == 'postback':
            fields += [('__EVENTTARGET', event['target']), ('__EVENTARGUMENT', event['argument'])]
        else:
            # An OsAjax link posted as a full Web Forms request: the control's name carries the event.
            fields.append((event['target'], ''))
        fields.extend((extra or {}).items())
        return self.url(form.attrs.get('action') or page.url, page.url), fields

    def postback(self, page, link, updates=None):
        return self.request(*self.event_post(page, link, updates))

    @contextmanager
    def authorizing(self, operation_id, words_sha256):
        """POSTs inside this block belong to one authorized write (journal already reserved). The yielded tracker
        records whether any of them went out."""
        tracker = {'sent': False}
        self.authorized = (operation_id, words_sha256, tracker)
        try:
            yield tracker
        finally:
            self.authorized = None


def accepted(kind, accept):
    if accept == 'html' and 'text/html' not in kind:
        raise ProtocolError("Expected Service Center HTML; protocol variant unsupported")
    if accept == 'text' and not (kind.startswith('text/') or 'json' in kind or 'javascript' in kind):
        raise ProtocolError("Expected a Service Center text reply; protocol variant unsupported")
    if accept in ('xlsx', 'binary') and 'text/html' in kind:
        # An HTML answer to a download is a login page or an error page, never the file.
        raise ProtocolError("Service Center answered with a page instead of the file")


class StudioWebTransport(Transport):
    """Service Center pages through the connected Studio's own web window (bridge sc_web): the fetch runs in the
    Studio's WebView, same origin, and only the body comes back. The cookie never leaves the Studio."""
    preauthenticated = True
    source = 'studio-web'

    def __init__(self, host, bridge, timeout=120):
        super().__init__(host, timeout)
        self.bridge = bridge
        self.opener = None

    def secrets_supported(self):
        # Only a bridge that announces sc_web:secretRefs fills the placeholders; an older one would ignore the field
        # and post them empty.
        capabilities = getattr(self.bridge, 'capabilities', None)
        return bool(capabilities) and SECRET_CAPABILITY in capabilities()

    def fetch(self, url, fields=None, accept='html', secret_refs=None):
        url = self.url(url)
        p = urllib.parse.urlsplit(url)
        form = None
        if fields is not None:
            form = {}
            for k, v in fields:
                if k in form and form[k] != v:
                    raise ProtocolError("Form repeats a field name with different values; unsupported by the Studio web transport")
                form[k] = v
        # An OsAjax reply (accept text) only stages a value in the page state: a read postback, never the write itself.
        # The bridge accepts each operationId once, so only the committing post carries it.
        write = form is not None and self.authorized is not None and accept != 'text'
        if secret_refs:
            if not write:
                raise ProtocolError('Secret references travel only on an authorized write postback')
            if not self.secrets_supported():
                raise BridgeError('STUDIO_BRIDGE_OUTDATED', 'The loaded bridge does not fill secret fields from the vault (sc_web:secretRefs); '
                                  'nothing was sent. Reconnect a new bridge version.', write=True, executed=False)
            if any(form.get(r['pointer'][1:].replace('~1', '/').replace('~0', '~')) != '' for r in secret_refs):
                raise ProtocolError('Every secret reference points to an empty placeholder field of this form')
        path = p.path + ('?' + p.query if p.query else '')
        try:
            reply = self.bridge.web(self.host, 'fetch', method='GET' if form is None else 'POST', path=path, form=form,
                                    accept='html' if accept == 'text' else accept, write=write,
                                    **({'operation_id': self.authorized[0], 'authorize_sha256': self.authorized[1]} if write else {}),
                                    **({'secret_refs': secret_refs} if secret_refs else {}))
        except BridgeError as e:
            if accept == 'binary' and e.code == 'BAD_REQUEST' and not write:
                # A bridge without accept=binary returns any download body for xlsx; a read can be asked again.
                return self.fetch(url, fields, 'xlsx')
            if write and not ((e.code in NOT_SENT or e.extra.get('executed') is False) and e.extra.get('write')):
                self.authorized[2]['sent'] = True
            raise
        if write:
            self.authorized[2]['sent'] = True
        if reply.get('redirected') is True and form is not None:
            # A postback answered with a redirect (manual mode): the POST went through; read the page again.
            if accept not in ('html', 'text'):
                raise ProtocolError("Service Center redirected instead of returning the file")
            return self.fetch(url)
        final = reply.get('finalUrl') or url
        try:
            final = self.url(final)
        except ProtocolError:
            raise BridgeError('HOST_MISMATCH', "The Studio web window left the Service Center host; nothing was followed", sent=form is not None) from None
        if urllib.parse.urlsplit(final).path.lower().endswith('/login.aspx') or reply.get('status') in (401, 403):
            raise BridgeError('WEB_SIGN_IN_REQUIRED', "The Studio's Service Center window is not signed in; run o11_service_center_session action=web-sign-in", sent=form is not None)
        status = reply.get('status', 200)
        if status != 200:
            raise ProtocolError(f"Service Center returned HTTP {status}")
        kind = str(reply.get('contentType') or ('text/html' if 'html' in reply else '')).lower()
        accepted(kind, accept)
        if 'bodyBase64' in reply:
            raw = base64.b64decode(reply['bodyBase64'], validate=True)
        else:
            # html:null + htmlOmitted: the answer to a secretRefs postback echoed a vault value the bridge could not mask.
            raw = str(reply.get('html') or '').encode('utf-8')
        if len(raw) > (LIMIT if accept in ('html', 'text') else BINARY_LIMIT):
            raise ProtocolError("Service Center response exceeds its size limit")
        if 'html' in kind and LOGIN_PAGE.search(raw.decode('utf-8', 'replace')):
            raise BridgeError('WEB_SIGN_IN_REQUIRED', "Service Center answered with its login page: the session of the Studio's Service "
                              "Center window expired; nothing was read. Run o11_service_center_session action=web-sign-in, the user "
                              "signs in once, then repeat the call", sent=form is not None)
        return final, kind, raw, 'utf-8'
