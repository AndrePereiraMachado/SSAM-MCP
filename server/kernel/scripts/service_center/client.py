"""Semantic O11 operations over discovered Service Center forms, with durable receipts.

The same parsers serve both page transports: direct HTTPS after the vault form login (http.Transport) and the
connected Studio's own web window (http.StudioWebTransport). Web Forms postbacks are rebuilt from the page's own
form state (__OSVSTATE/__VIEWSTATE/__EVENTVALIDATION); server scripts are never evaluated.

Modern Service Center pages (fixtures _notes/scp/fixtures/o11, matrix-o11.md): lists are read only from the page's
content (div.sc-content-main), never from the sidebar's Recent Items; a module's tabs are div[data-tab] panels of the
same page; anchors post back through __doPostBack with __EVENTTARGET/__EVENTARGUMENT added here; OsAjax replies are
read only through their refreshed "__OSVSTATE" and the HTML they carry. Pages whose layout is only ASSUMED refuse any
other layout with LAYOUT_UNKNOWN and the page-layout read that captures them live."""
from __future__ import annotations

import hashlib
import html as markup
import io
import json
import os
import re
import uuid
import zipfile
import xml.etree.ElementTree as ET
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from .bridge import redact_text
from .http import (NOT_SENT, STATE, BridgeError, Document, Page, ProtocolError, Transport, button, confirm_text,
                   control_value, controls, form_fields, postback_target)


# The Timers log is Cyclic_Job_Logs.aspx (Monitoring > Timers, live on 11.42); Timer_Logs.aspx does not exist.
LOG_PAGES = {'error': 'Error_Logs.aspx', 'general': 'General_Logs.aspx',
             'integration': 'Integration_Logs.aspx', 'timer': 'Cyclic_Job_Logs.aspx'}
EXPORTABLE = ('error', 'integration')
# Log filters: the visible label before the control, or the name suffix of the O11 English pages (matrix L1, L6-L8).
LOG_FILTERS = {'application': (('application',), ('wtApplication_Selector',)),
               'module': (('module', 'espace'), ('wtEspace_Selector',)),
               'message': (('message',), ('wtInput1',)),
               'source': (('source',), ('wtInput7', 'wtSourceInput')),
               'server': (('server',), ('wtInput4',)),
               'type': (('type',), ('wtTypeSelector',)),
               'action': (('action',), ('wtActionInput',)),
               'timer': (('timer', 'name'), ('wtTimerInput',)),
               'since': (('from', 'from date', 'start date'), ('wtFilter_FromDate',)),
               'until': (('to', 'to date', 'end date'), ('wtFilter_ToDate2',))}
# General and timer logs are ASSUMED pages: their listing must show these columns or the page is refused.
ASSUMED_LOGS = {'general': ('module', 'message'), 'timer': ('module', 'timer')}
ACTIONS = {'timer-run': ('Run Now', 'Run now'), 'timer-deactivate': ('Deactivate',),
           'timer-activate': ('Activate',), 'property-set': ('Apply', 'Save'), 'timer-schedule': ('Apply', 'Save')}
VALUE_ACTIONS = ('property-set', 'timer-schedule')
# The timer page's schedule editor (matrix T4, ASSUMED): label or name suffix of each control.
SCHEDULE = {'recurrence': (('recurrence',), 'wtSchedule_Recurrence'), 'at': (('at',), 'wtSchedule_Time'),
            'every': (('every (minutes)', 'every'), 'wtSchedule_Interval'),
            'timeout': (('timeout (minutes)', 'timeout'), 'wtTimeout')}
# Page writes beyond timers and properties: the target keys of their journal identity.
WEB_WRITES = {'solution-create': ('solution',), 'solution-add-component': ('solution', 'component'),
              'solution-remove-component': ('solution', 'component'), 'db-connection-create': ('connection',),
              'db-connection-test': ('connection',), 'db-connection-delete': ('connection',),
              'extension-db-connection': ('extensionId', 'connection'), 'integration-log-level': ('moduleId', 'integration')}
# Page writes whose form carries the database login: it goes only as sc_web secretRefs, filled inside the Studio.
SECRET_WRITES = ('db-connection-create', 'db-connection-test')
INTEGRATION_LINKS = (('consumed-rest', r'eSpace_RestWebReference_Edit\.aspx\?[^#]*?RestWebreferenceId=(\d+)'),
                     ('exposed-rest', r'eSpace_RestExpose_Edit\.aspx\?[^#]*?RestExposeId=(\d+)'),
                     ('consumed-soap', r'eSpace_SoapConsume_Edit\.aspx\?[^#]*?SoapConsumeId=(\d+)'),
                     ('consumed-soap', r'eSpace_WebReference_Edit\.aspx\?[^#]*?WebreferenceId=(\d+)'),
                     ('exposed-soap', r'eSpace_SoapExpose_Edit\.aspx\?[^#]*?SoapExposeId=(\d+)'),
                     ('exposed-soap', r'eSpace_WebService_Edit\.aspx\?[^#]*?WebServiceId=(\d+)'))
# A module page's tabs: the div[data-tab] panel of the modern page; older versions link one page per tab.
TABS = {'timers': ('tab-Timers', ('timers',)), 'site-properties': ('tab-SiteProperties', ('site properties', 'siteproperties')),
        'integrations': ('tab-Integrations', ('integrations',))}
EMPTY = re.compile(r'\bno (?:\w+ ){0,2}(?:were )?(?:found|to show|available)\b', re.I)
PAGE_PATH = re.compile(r'[A-Za-z][A-Za-z0-9_]{0,80}\.aspx(?:\?[A-Za-z0-9_.=&%-]{0,500})?')
# States after which the target lock is released: done, or never sent, or definitely refused by the server.
RELEASED = ('confirmed', 'accepted', 'refused', 'rejected')


def utc():
    return datetime.now(timezone.utc).isoformat()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class LayoutError(BridgeError):
    """A Service Center page modeled only on synthetic fixtures (ASSUMED) that does not show the layout the parser
    knows. Nothing is guessed and nothing is sent; the answer asks for a live capture of the page."""
    def __init__(self, url, what, detail):
        parts = urlsplit(url or '')
        path = parts.path.rsplit('/', 1)[-1] + ('?' + parts.query if parts.query else '')
        super().__init__('LAYOUT_UNKNOWN', f'{what}: {detail}. This Service Center page was modeled on synthetic fixtures and not '
                         'captured live yet, so nothing was guessed or sent. Capture this page live with o11_service_center_read '
                         f'action=page-layout path={path} (a read-only GET) so the parser can be calibrated.',
                         write=True, executed=False,
                         continuation={'tool': 'o11_service_center_read', 'action': 'page-layout', 'path': path})


def assumed(page, what, find):
    """A control lookup on an ASSUMED page: a missing or ambiguous control means an unknown layout."""
    try:
        return find()
    except BridgeError:
        raise
    except ProtocolError as e:
        raise LayoutError(page.url, what, str(e).rstrip('.')) from None


def observed_value(field):
    if field.attrs.get('type', '').lower() == 'checkbox':
        return 'true' if 'checked' in field.attrs else 'false'
    return control_value(field)


def shown(field):
    """What the page shows in a control: a select's chosen option text, else its value."""
    return selected_text(field) if field.tag == 'select' else observed_value(field)


def expected_value(field, value):
    if field.attrs.get('type', '').lower() == 'checkbox':
        if value.lower() not in ('true', 'false'):
            raise ProtocolError('Boolean properties require true or false')
        return value.lower()
    return value


def content(page):
    return page.doc.content()


def heading(page):
    found = [n.text for n in content(page).all('div', 'h1', 'h2') if n.tag in ('h1', 'h2') or 'heading2' in n.attrs.get('class', '').split()]
    return found[0] if found else ''


def errors(page):
    return [n for n in page.doc.all() if n.text and re.search(
        r'(?:Feedback_Message_Error|ValidationMessage|ErrorMessage)', n.attrs.get('class', ''), re.I)]


def acknowledged(page, pattern):
    return any(re.search(pattern, n.text, re.I) and re.search('Feedback_Message_Success', n.attrs.get('class', ''), re.I)
               for n in page.doc.all())


def checked(page):
    # An expired session answers with the login page at the asked URL: its form posts to Login.aspx.
    if urlsplit(page.url).path.lower().endswith('/login.aspx') or any(
            re.fullmatch(r'_?login(?:sso)?\.aspx', urlsplit(f.attrs.get('action') or '').path.rsplit('/', 1)[-1], re.I)
            for f in page.doc.all('form')):
        raise ProtocolError("Service Center login required or session expired")
    if errors(page):
        # Feedback may echo a password/property value. Never return raw server feedback.
        raise ProtocolError("Service Center reported a validation/permission error")
    return page


def tables(page, redact_values=False, root=None):
    """Header-keyed rows of the listings inside root (default: the page content, never the sidebar)."""
    result = []
    for table in (root if root is not None else content(page)).all('table'):
        if inside(table, r'RecentItems|sc-content-left'):
            continue
        rows = [r for r in table.all('tr') if r.ancestor('table') is table]
        headers = []
        for row in rows:
            cells = [c for c in row.children if getattr(c, 'tag', None) in ('th', 'td')]
            if not cells:
                continue
            if any(c.tag == 'th' for c in cells):
                headers = [c.text or f'column{i+1}' for i, c in enumerate(cells)]
                continue
            if not headers:
                continue  # Ignore layout tables rather than inventing record schemas.
            if len(cells) == 1 and len(headers) > 1 and EMPTY.search(cells[0].text):
                continue  # the listing's own "No items to show..." row
            values = {}
            for i, c in enumerate(cells):
                key = headers[i] if i < len(headers) else f'column{i+1}'
                values[key] = '<redacted>' if redact_values and re.search('value|valor', key, re.I) else c.text
            links = [{'name': a.text, 'href': a.attrs['href']} for c in cells for a in c.all('a') if a.attrs.get('href')]
            if redact_values:
                links = [{'name': a.text, 'href': a.attrs['href']} for i, c in enumerate(cells)
                         if i < len(headers) and not re.search('value|valor', headers[i], re.I)
                         for a in c.all('a') if a.attrs.get('href')]
            result.append({'fields': values, 'links': links})
    return result


def summary(page):
    """Label/value rows of header-less detail tables (BPT process, instance and activity pages)."""
    found = {}
    for table in content(page).all('table'):
        rows = [r for r in table.all('tr') if r.ancestor('table') is table]
        if any(getattr(c, 'tag', None) == 'th' for r in rows for c in r.children):
            continue  # a listing, not a detail table
        for row in rows:
            texts = [c.text for c in row.children if getattr(c, 'tag', None) == 'td' and c.text]
            if len(texts) >= 2 and len(texts[0]) <= 60:
                found.setdefault(texts[0].strip(' :'), texts[-1])
    return found


def next_link(page):
    links = [a for a in content(page).all('a') if (a.text.casefold() in ('next', 'next ›', '›', '>', 'próxima', 'seguinte')
             or a.attrs.get('rel') == 'next') and 'disabled' not in a.attrs
             and 'disabled' not in a.attrs.get('class', '').lower() and (a.attrs.get('href') or a.attrs.get('onclick'))]
    return links[0] if len(links) == 1 else None


def inside(node, pattern):
    n = node.parent
    while n is not None:
        if re.search(pattern, n.attrs.get('id', '') + ' ' + n.attrs.get('class', ''), re.I):
            return True
        n = n.parent
    return False


def labels(page, form):
    """Fillable controls of a form with their visible label: <label for>, aria-label/title, else the text right before
    the control (Service Center renders labels with for='' and per-DBMS parameters as text before a generated name)."""
    found, last = {}, ''

    def walk(node):
        nonlocal last
        for c in node.children:
            if isinstance(c, str):
                text = ' '.join(c.split())
                if len(text) > 1:
                    last = text
            elif c.tag in ('script', 'style'):
                continue
            elif c.tag in ('input', 'select', 'textarea'):
                kind = c.attrs.get('type', 'text').lower()
                if c.attrs.get('name') and 'disabled' not in c.attrs and kind not in ('hidden', 'submit', 'button', 'image', 'reset'):
                    found[c.attrs['name']] = ((page.doc.label(c) or last).strip(' :*').casefold(), c)
                    last = ''
            else:
                walk(c)
    walk(form)
    return found


def form_labels(page, form):
    """labels() of one form's controls inside the page content. The modern form wraps the whole page: walking it from
    the top would give the hidden telemetry fields (*wtButtonNameField) the sidebar's last text as their label."""
    return {name: (label, n) for name, (label, n) in labels(page, content(page)).items() if n.ancestor('form') is form}


def one(items, what):
    if len(items) != 1:
        raise ProtocolError(f"Expected exactly one {what}; found {len(items)}")
    return items[0]


def selected_text(select):
    options = list(select.all('option'))
    chosen = next((o for o in options if 'selected' in o.attrs), options[0] if options else None)
    return chosen.text if chosen else ''


def by_suffix(form, suffix, what):
    return one([n for n in controls(form) if n.attrs['name'].endswith(suffix)], what)


def tab_panel(page, tab):
    """The div[data-tab] content panel of a tab of the modern page (all tabs are rendered inline), or None when the
    page has no such tab markup."""
    marked = [n for n in content(page).all('div') if n.attrs.get('data-tab') == tab]
    panels = [n for n in marked if 'tabs-header-item' not in n.attrs.get('class', '').split()]
    if not marked:
        return None
    if len(panels) != 1:
        raise LayoutError(page.url, 'Module page', f'the {tab} tab has {len(panels)} content panels')
    return panels[0]


def ajax_state(reply):
    """The refreshed __OSVSTATE of an OsAjax reply: the "__OSVSTATE","<state>" pair is its only evidenced token. The
    state is an opaque base64-like token, so a pair with anything else (a comment's placeholder) is not it."""
    match = re.search(r'"__OSVSTATE"\s*[,:]\s*"([A-Za-z0-9+/=_.:-]+)"', reply)
    return match.group(1) if match else None


def ajax_markup(reply):
    """The HTML an OsAjax reply carries in its string literals (the widgets it replaces); the envelope is not parsed."""
    found = []
    for literal in re.findall(r'"((?:[^"\\]|\\.)*)"', reply, re.S):
        try:
            text = json.loads('"' + literal + '"')
        except ValueError:
            continue
        if re.search(r'<(?:table|tr|td|a|div|span|select|input)\b', text, re.I):
            found.append(text)
    return found


def ajax_page(page, reply):
    """A page rebuilt from an OsAjax reply: the original form's fields with the refreshed state, around the replaced
    markup, so the next postback (Next, Export) carries that state as the browser's form would."""
    state, fragments = ajax_state(reply), ajax_markup(reply)
    form = next(page.doc.all('form'), None)
    if state is None or not fragments or form is None:
        raise LayoutError(page.url, 'OsAjax reply', 'it carries no refreshed form state or no list markup')
    pairs = [(k, state if k.endswith('__OSVSTATE') else v) for k, v in form_fields(form)]
    hidden = ''.join(f'<input type="hidden" name="{markup.escape(k)}" value="{markup.escape(v)}">' for k, v in pairs)
    action = markup.escape(form.attrs.get('action') or '')
    return Page(page.url, Document(f'<form method="post" action="{action}">{hidden}<div class="sc-content-main">{"".join(fragments)}</div></form>'))


def page_name(href):
    """A linked page and its query parameter names, never their values."""
    parts = urlsplit(href)
    names = sorted(parse_qs(parts.query, keep_blank_values=True))
    return parts.path.rsplit('/', 1)[-1] + ('?' + '&'.join(n + '=' for n in names) if names else '')


def skeleton(node):
    """Markup for calibration: scripts dropped, input values and text areas emptied (button captions and option values
    kept), so no field value is stored."""
    if isinstance(node, str):
        return markup.escape(node, quote=False)
    if node.tag in ('script', 'style'):
        return ''
    attrs = dict(node.attrs)
    if node.tag == 'input' and attrs.get('type', 'text').lower() not in ('submit', 'button', 'reset', 'image', 'checkbox', 'radio'):
        attrs.pop('value', None)
    inner = '' if node.tag == 'textarea' else ''.join(skeleton(c) for c in node.children)
    if node.tag == 'document':
        return inner
    rendered = ''.join(f' {k}' if v is None else f' {k}="{markup.escape(v)}"' for k, v in attrs.items())
    return f'<{node.tag}{rendered}>' if node.tag in Document.VOID else f'<{node.tag}{rendered}>{inner}</{node.tag}>'


def describe(page, root):
    """Names only: controls with their labels, buttons, tabs, table headers, postback targets and linked pages."""
    form = next(page.doc.all('form'), None)
    buttons = [n for n in root.all('input', 'button') if n.attrs.get('type', 'submit' if n.tag == 'button' else '').lower() in ('submit', 'button')]
    return {
        'title': heading(page),
        'tabs': sorted({n.attrs['data-tab'] for n in root.all('div') if n.attrs.get('data-tab')}),
        'formState': sorted(n.attrs['name'] for n in (form.all('input') if form else []) if n.attrs.get('type', '').lower() == 'hidden' and n.attrs.get('name')),
        'controls': [{'name': name, 'tag': n.tag, 'type': n.attrs.get('type', n.tag).lower(), 'label': label,
                      **({'options': [o.text for o in n.all('option')][:50]} if n.tag == 'select' else {})}
                     for name, (label, n) in labels(page, root).items()],
        'buttons': [{'name': n.attrs.get('name'), 'caption': (n.attrs.get('value') or n.text)[:80], 'scripted': bool(n.attrs.get('onclick'))} for n in buttons],
        'postbacks': [{'text': a.text[:80], **postback_target(a)} for a in root.all('a') if postback_target(a)],
        'tables': [{'id': t.attrs.get('id'), 'headers': [c.text for c in t.all('th')]} for t in root.all('table')],
        'links': sorted({page_name(a.attrs['href']) for a in root.all('a') if a.attrs.get('href') and not a.attrs['href'].startswith(('javascript:', '#'))}),
        'feedback': sorted({c for n in root.all() for c in n.attrs.get('class', '').split() if c.startswith('Feedback_Message_') and n.text}),
    }


def xlsx_rows(body):
    """Rows of the first sheet of an XLSX export, with the standard library only."""
    if not body.startswith(b'PK'):
        raise ProtocolError('Service Center export is not an XLSX file')
    try:
        book = zipfile.ZipFile(io.BytesIO(body))
    except zipfile.BadZipFile:
        raise ProtocolError('Service Center export is not a valid XLSX file') from None
    ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'

    def part(name):
        if book.getinfo(name).file_size > 64 * 1024 * 1024:
            raise ProtocolError('XLSX part exceeds 64 MiB')
        return ET.fromstring(book.read(name))
    names = book.namelist()
    if 'xl/worksheets/sheet1.xml' not in names:
        raise ProtocolError('XLSX export has no first sheet')
    shared = ([''.join(t.text or '' for t in si.iter(ns + 't')) for si in part('xl/sharedStrings.xml').findall(ns + 'si')]
              if 'xl/sharedStrings.xml' in names else [])
    rows = []
    for row in part('xl/worksheets/sheet1.xml').iter(ns + 'row'):
        values = {}
        for position, cell in enumerate(row.findall(ns + 'c')):
            letters = re.match(r'[A-Z]+', cell.attrib.get('r', ''))
            index = position if not letters else sum((ord(ch) - 64) * 26 ** i for i, ch in enumerate(reversed(letters.group()))) - 1
            v = cell.find(ns + 'v')
            if cell.attrib.get('t') == 's' and v is not None and (v.text or '').isdigit() and int(v.text) < len(shared):
                values[index] = shared[int(v.text)]
            elif v is not None:
                values[index] = v.text or ''
            else:
                values[index] = ''.join(t.text or '' for t in cell.iter(ns + 't'))
        rows.append([values.get(i, '') for i in range(max(values) + 1)] if values else [])
    return rows


def excel_time(value):
    try:
        return (datetime(1899, 12, 30) + timedelta(days=float(value))).strftime('%Y-%m-%d %H:%M:%S')
    except ValueError:
        return value


class Client:
    def __init__(self, vault, transport=None, exports=None):
        self.vault = vault
        self.http = transport or Transport(vault.host)
        self.authenticated = False
        self.exports = Path(exports) if exports else None

    def login(self):
        if self.authenticated or self.http.preauthenticated:
            return
        page = self.http.request('Login.aspx')
        if not page.doc.login():
            # SSO/captcha/identity-provider flows need their own supported protocol.
            raise ProtocolError("No Service Center password form; SSO login variant is unsupported by this adapter")
        passwords = [n for n in page.doc.all('input') if n.attrs.get('type', '').lower() == 'password']
        if len(passwords) != 1:
            raise ProtocolError("Ambiguous login form")
        form = passwords[0].ancestor('form')
        users = [n for n in controls(form) if n.attrs.get('type', 'text').lower() in ('text', 'email')]
        if len(users) != 1:
            raise ProtocolError("Ambiguous login username field")
        click = button(page, ('Log in', 'Login', 'Log In', 'Sign in'))
        if click.ancestor('form') is not form:
            raise ProtocolError("Login controls do not belong to the same form")
        fields = self.vault.login_fields(users[0].attrs['name'], passwords[0].attrs['name'])
        try:
            response = self.http.submit(page, click, fields)
        finally:
            fields.clear()
        checked(response)
        if response.doc.login():
            raise ProtocolError("Service Center did not accept the vault login; no automatic retry")
        if not any('logout' in (a.attrs.get('href', '') + a.text).lower() or 'log out' in a.text.lower()
                   for a in response.doc.all('a', 'input', 'button')):
            raise ProtocolError("Could not confirm an authenticated Service Center session")
        self.authenticated = True

    def get(self, url):
        self.login()
        return checked(self.http.request(url))

    def follow(self, page, link):
        href = link.attrs.get('href', '')
        if href.startswith(('javascript:', '#')) or link.attrs.get('onclick'):
            raise ProtocolError("Scripted navigation variant unsupported; no JavaScript is executed")
        return self.get(self.http.url(href, page.url))

    def read_postback(self, page, url, fields):
        """A read postback whose answer is a page, or an OsAjax reply read through its state and markup."""
        final, text = self.http.reply(url, fields)
        if re.search(r'<form\b', text, re.I):
            return checked(Page(final, Document(text)))
        return ajax_page(page, text)

    def click(self, page, control, updates=None):
        """A read click on a submit control: a plain form post, or the OsAjax request its onclick sends (L7 Filter)."""
        if re.search(r'OsAjax', control.attrs.get('onclick', '')):
            return self.read_postback(page, *self.http.ajax_post(page, control, updates))
        return checked(self.http.submit(page, control, updates))

    def next_page(self, page, link):
        # A Web Forms pager (__doPostBack or OsAjax) is replayed as the page's own form post, never as script.
        if postback_target(link):
            return self.read_postback(page, *self.http.event_post(page, link))
        return self.follow(page, link)

    def absolute(self, rows, page):
        # Links that leave the Service Center (an integration endpoint, LifeTime) are data, never followed.
        for row in rows:
            links = []
            for a in row['links']:
                if a['href'].startswith(('javascript:', '#')):
                    continue
                try:
                    links.append(dict(a, href=self.http.url(a['href'], page.url)))
                except ProtocolError:
                    continue
            row['links'] = links
        return rows

    def pages(self, page, limit=100, redact=False, max_pages=20):
        if not 1 <= limit <= 5000:
            raise ProtocolError("limit must be between 1 and 5000")
        if not 1 <= max_pages <= 100:
            raise ProtocolError("maxPages must be between 1 and 100")
        rows, seen = [], set()
        for _ in range(max_pages):
            if not any(content(page).all('th')) and not EMPTY.search(content(page).text):
                raise ProtocolError("Unrecognized listing schema; refusing to report an empty result")
            batch = tables(page, redact)
            marker = fingerprint(batch)
            if marker in seen:
                raise ProtocolError("Service Center pagination did not advance")
            seen.add(marker)
            rows.extend(self.absolute(batch, page))
            nxt = next_link(page)
            if len(rows) >= limit or nxt is None:
                return {'rows': rows[:limit], 'truncated': len(rows) > limit or nxt is not None,
                        'source': page.url, 'observedAt': utc()}
            try:
                page = self.next_page(page, nxt)
            except ProtocolError as e:
                return {'rows': rows, 'truncated': True, 'source': page.url, 'paginationUnsupported': True,
                        'paginationError': str(e)[:500], 'observedAt': utc()}
        return {'rows': rows[:limit], 'truncated': True, 'pageLimit': max_pages, 'observedAt': utc()}

    def modules(self, limit=100):
        return self.pages(self.get('eSpaces_List.aspx'), limit)

    def module_page(self, module_id):
        if not re.fullmatch(r'[1-9][0-9]*', str(module_id)):
            raise ProtocolError("module-id must be the numeric ID from the live module listing")
        return self.get(f'eSpace_Edit.aspx?EspaceId={module_id}')

    def resource_page(self, module_id, resource):
        """(page, panel) of a module tab: the inline div[data-tab] panel of the modern page, or (on older pages) the page
        its tab link leads to, with panel None."""
        if resource not in TABS:
            raise ProtocolError("Unknown module resource")
        tab, names = TABS[resource]
        page = self.module_page(module_id)
        panel = tab_panel(page, tab)
        if panel is not None:
            return page, panel
        links = [a for a in content(page).all('a') if a.text.casefold() in names]
        if len(links) != 1:
            raise ProtocolError("Could not identify the module's " + resource + " tab")
        return self.follow(page, links[0]), None

    def resource_listing(self, module_id, resource, limit=1000):
        page, panel = self.resource_page(module_id, resource)
        redact = resource == 'site-properties'
        if panel is None:
            return self.pages(page, limit, redact)
        if not any(panel.all('th')) and not EMPTY.search(panel.text):
            raise LayoutError(page.url, 'Module page', f'the {TABS[resource][0]} panel has no listing')
        rows = self.absolute(tables(page, redact, panel), page)
        return {'rows': rows[:limit], 'truncated': len(rows) > limit, 'source': page.url, 'tab': TABS[resource][0], 'observedAt': utc()}

    def resources(self, module_id, resource, limit=100):
        return self.resource_listing(module_id, resource, limit)

    def detail(self, module_id, resource, name):
        listing = self.resource_listing(module_id, resource)
        matches = [a for r in listing['rows'] for a in r['links'] if a['name'] == name]
        # Same name across tenants or pages must never silently choose the first.
        if len(matches) != 1 or listing['truncated']:
            raise ProtocolError("Target must have one exact name in a complete module listing")
        page = self.get(matches[0]['href'])
        title = heading(page)
        if title and name.casefold() not in title.casefold():
            raise LayoutError(page.url, f'The {resource} detail page', f'its heading does not name {name}')
        return page

    def log_filters(self, kind, page, filters, stack_contains=None):
        click = button(page, ('Filter', 'Search'))
        form = click.ancestor('form')
        updates = {}
        if stack_contains is not None:
            if kind != 'error' or 'message' in filters:
                raise ProtocolError("stackContains searches error-log stack traces and replaces the message filter")
            filters = dict(filters, message=stack_contains)
        found = form_labels(page, form)
        for key, value in filters.items():
            if key not in LOG_FILTERS:
                raise ProtocolError("Unknown log filter: " + key)
            names, suffixes = LOG_FILTERS[key]
            matches = [n for name, (label, n) in found.items() if label in names or name.endswith(suffixes)]
            if len(matches) != 1:
                raise ProtocolError("This log page does not expose an unambiguous " + key + " filter")
            n = matches[0]
            if n.tag == 'select':
                options = [o for o in n.all('option') if o.text == value or o.attrs.get('value') == value]
                if len(options) != 1:
                    raise ProtocolError("Log filter does not identify one option: " + key)
                value = options[0].attrs.get('value', options[0].text)
            updates[n.attrs['name']] = value
        if stack_contains is not None:
            # The page's own "search in stack trace" option widens the message filter to the stack.
            box = one([n for n in controls(form) if n.attrs.get('type', '').lower() == 'checkbox'
                       and re.search(r'SearchStackTrace|StackTrace', n.attrs['name'], re.I)], 'stack-trace search option')
            updates[box.attrs['name']] = control_value(box)
        return click, updates

    def log_schema(self, kind, page):
        # General and timer logs are ASSUMED pages: only the listing they are modeled on is read.
        if kind not in ASSUMED_LOGS:
            return
        headers = [c.text.casefold() for t in content(page).all('table') for c in t.all('th')]
        missing = [c for c in ASSUMED_LOGS[kind] if not any(c in h for h in headers)]
        if missing:
            raise LayoutError(page.url, f'The {kind} log page', 'no listing with the columns ' + ', '.join(missing))

    def logs(self, kind='error', limit=100, filters=None, *, stack_contains=None, export=False, max_pages=20):
        if kind not in LOG_PAGES:
            raise ProtocolError("Unknown log kind")
        if export and kind not in EXPORTABLE:
            raise ProtocolError("Service Center exports error and integration logs only")
        original = page = self.get(LOG_PAGES[kind])
        self.log_schema(kind, page)
        filters = filters or {}
        updates = {}
        if filters or stack_contains is not None:
            find = lambda: self.log_filters(kind, page, filters, stack_contains)
            click, updates = assumed(page, f'The {kind} log page', find) if kind in ASSUMED_LOGS else find()
            # The Integration log's Filter is an OsAjax submit: its reply refreshes the state and the list only.
            page = self.click(page, click, updates)
        if export:
            result = self.export_logs(kind, original, page, updates, limit)
        else:
            result = self.pages(page, limit, max_pages=max_pages)
        result.update(kind=kind, filters=filters, timezone='Service Center display timezone',
                      **({'stackContains': stack_contains} if stack_contains is not None else {}))
        return result

    def export_logs(self, kind, original, page, updates, limit):
        if self.exports is None:
            raise ProtocolError("Exports need a local export folder")
        try:
            body = self.http.export(page, button(page, ('Export to excel',)))
        except ProtocolError:
            if page is original:
                raise
            # An AJAX Filter answers with a fragment that carries only the refreshed form state: export from the
            # original form with that state, never reading a missing Export control as zero rows.
            state = {n.attrs['name']: control_value(n) for n in page.doc.all('input') if STATE.match(n.attrs.get('name', ''))}
            if not state:
                raise ProtocolError("The filtered page has neither the Export control nor refreshed form state") from None
            body = self.http.export(original, button(original, ('Export to excel',)), {**updates, **state})
        rows = xlsx_rows(body)
        header = rows[0] if rows else []
        records = [{h or f'column{i+1}': (excel_time(v) if h.upper() == 'INSTANT' else v) for i, (h, v) in
                    enumerate(zip(header, r + [''] * (len(header) - len(r))))} for r in rows[1:]]
        saved = self.save(f'{kind}-log', 'xlsx', body)
        return {'export': saved, 'columns': header, 'rowCount': len(records), 'rows': records[:limit],
                'truncated': len(records) > limit, 'observedAt': utc()}

    def save(self, stem, extension, body):
        self.exports.mkdir(parents=True, exist_ok=True)
        path = self.exports / f"{stem}-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}.{extension}"
        with path.open('xb') as f:
            f.write(body)
        return {'file': str(path.resolve()), 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}

    def error_detail(self, error_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', error_id):
            raise ProtocolError("Invalid error ID")
        page = self.get('Show_Error.aspx?Error_Id=' + error_id)
        # Return visible diagnostics of the page content, never the sidebar, cookies, hidden form state, input values
        # or scripts.
        root = content(page)
        if root is page.doc.root:
            root = next(page.doc.all('main'), None) or next(page.doc.all('body'), page.doc.root)
        elif not any(root.all('pre')) and 'error' not in heading(page).casefold():
            raise LayoutError(page.url, 'The error detail page', 'no stack block and no error heading')
        text = '\n'.join(line.rstrip() for line in root.readable.splitlines() if line.strip())
        return {'errorId': error_id, 'detail': text[:64000], 'truncated': len(text) > 64000,
                'source': page.url, 'observedAt': utc()}

    def trace(self, request_key, limit=100):
        if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', request_key):
            raise ProtocolError("Invalid request/correlation key")
        # Correlate only exact occurrences; this is log correlation, not a distributed tracing service.
        logs = self.logs('error', limit, {'message': request_key})
        return {'requestKey': request_key, 'kind': 'log-correlation', 'logs': logs}

    def page_layout(self, path):
        """A live capture of one page for calibrating the parsers: GET only; names, never field values, come back, and the
        content's markup (input values emptied, scripts dropped) is kept locally with its sha256."""
        if not PAGE_PATH.fullmatch(path or ''):
            raise ProtocolError('path is a Service Center page under /ServiceCenter/, e.g. eSpace_Timer_Edit.aspx?EspaceKey=<key>&Cyclic_Job_Key=<key>')
        if self.exports is None:
            raise ProtocolError('Captures need a local export folder')
        page = self.get(path)
        root = content(page)
        stem = 'page-' + re.sub(r'[^A-Za-z0-9_]', '_', path.split('?')[0].rsplit('.', 1)[0])[:60]
        saved = self.save(stem, 'html', skeleton(root).encode('utf-8'))
        return {'path': path, 'source': page.url, 'scope': 'sc-content-main' if root is not page.doc.root else 'document',
                **describe(page, root), 'capture': saved, 'observedAt': utc(),
                'note': 'Names and captions only; the saved markup has no input values. Hand it over to calibrate the parser.'}

    # ---- site properties and timers
    def value_field(self, action, page, form=None):
        forms = [form] if form is not None else list(page.doc.all('form'))
        candidates = [n for f in forms for n in controls(f) if (page.doc.label(n).strip(': ').casefold() in ('value', 'valor')
                      or re.search(r'(?:Input_?Value|PropertyValue|SiteProperty_Value)$', n.attrs['name'], re.I))
                      and n.attrs.get('type', '').lower() not in ('hidden', 'submit', 'button')]
        if len(candidates) != 1:
            raise ProtocolError("Could not identify one site-property value field")
        return candidates[0]

    def schedule_controls(self, page, form):
        found = form_labels(page, form)
        return {key: one([n for name, (label, n) in found.items() if name.endswith(suffix) or label in names], f'timer schedule {key} control')
                for key, (names, suffix) in SCHEDULE.items()}

    def schedule_request(self, controls_, value):
        """The requested schedule by control (recurrence by its option text), checked against the page's controls."""
        if not isinstance(value, dict) or not value or not set(value) <= set(SCHEDULE):
            raise ProtocolError('timer-schedule takes recurrence, at, every and/or timeout')
        result = {}
        for key, text in value.items():
            node, text = controls_[key], str(text).strip()
            if node.tag == 'select':
                result[key] = one([o for o in node.all('option') if o.text.casefold() == text.casefold() or o.attrs.get('value') == text],
                                  f'{key} option {text!r}').text
            elif re.fullmatch(r'[0-9A-Za-z :.,-]{0,40}', text):
                result[key] = text
            else:
                raise ProtocolError(f'Schedule {key} must be short plain text (as Service Center shows it)')
        return result

    def property_value(self, module_id, name, reveal=False):
        """One named site property. The value stays redacted unless the user asked for it (reveal); a masked
        (password) property is never revealed."""
        page = self.detail(module_id, 'site-properties', name)
        field = assumed(page, 'The site property page', lambda: self.value_field('property-set', page))
        secret = field.attrs.get('type', '').lower() == 'password'
        result = {'moduleId': str(module_id), 'name': name, 'valueType': field.attrs.get('type', field.tag),
                  'secret': secret, 'value': '<redacted>', 'revealed': False, 'source': page.url, 'observedAt': utc()}
        if reveal and not secret:
            result.update(value=observed_value(field), revealed=True)
        return result

    def verify(self, receipt, journal, value=None):
        identity = receipt['identity']
        if identity['host'] != self.vault.host:
            raise ProtocolError('Receipt belongs to another host')
        action = identity['action']
        if action in WEB_WRITES:
            confirmed = self.observe(action, identity, receipt.get('plan'))
        elif action == 'timer-run':
            return dict(receipt, verification='Run Now cannot be safely inferred from current timer state; inspect timer logs', replayed=False)
        elif action == 'timer-schedule':
            requested = (receipt.get('plan') or {}).get('schedule')
            if not requested:
                raise ProtocolError('This receipt keeps no requested schedule to compare')
            _, _, _, schedule = self.prepare(action, identity['moduleId'], identity['name'])
            confirmed = all(shown(schedule[k]).casefold() == v.casefold() for k, v in requested.items())
        elif action == 'property-set':
            if value is None:
                raise ProtocolError('Verification requires the expected value (--value-file); a vault value is never read back')
            _, _, _, field = self.prepare(action, identity['moduleId'], identity['name'])
            confirmed = field.attrs.get('type', '').lower() != 'password' and observed_value(field) == expected_value(field, value)
        else:
            fresh = self.detail(identity['moduleId'], 'timers', identity['name'])
            expected = ACTIONS['timer-deactivate' if action == 'timer-activate' else 'timer-activate']
            try:
                button(fresh, expected)
                confirmed = True
            except ProtocolError:
                confirmed = False
        if confirmed:
            journal.reconcile(receipt)
        return dict(receipt, observedDesiredState=confirmed, replayed=False)

    def prepare(self, action, module_id, name):
        """(plan, page, control, target): the target is the value field (property-set), the schedule controls
        (timer-schedule) or None. Timer and site property pages are ASSUMED: a missing control is an unknown layout."""
        if action not in ACTIONS:
            raise ProtocolError("Unknown Service Center write operation")
        resource = 'site-properties' if action == 'property-set' else 'timers'
        page = self.detail(module_id, resource, name)
        what = 'The site property page' if action == 'property-set' else 'The timer page'
        click = assumed(page, what, lambda: button(page, ACTIONS[action]))
        form = click.ancestor('form')
        plan = {'host': self.vault.host, 'action': action, 'moduleId': str(module_id), 'name': name,
                'target': page.url, 'control': click.attrs.get('name'), 'execute': False}
        target = None
        if action == 'property-set':
            target = assumed(page, what, lambda: self.value_field(action, page, form))
            plan.update(value='<redacted>', valueType=target.attrs.get('type', target.tag),
                        secret=target.attrs.get('type', '').lower() == 'password')
        elif action == 'timer-schedule':
            target = assumed(page, what, lambda: self.schedule_controls(page, form))
            plan['currentSchedule'] = {k: shown(n) for k, n in target.items()}
        return plan, page, click, target

    def property_source(self, field, value, secret):
        """A secret field takes its value only from the vault (secretRefs); a vault value fits a text or password field."""
        kind = field.attrs.get('type', field.tag).lower()
        if secret is not None:
            if kind not in ('password', 'text') and field.tag != 'textarea':
                raise ProtocolError('A vault value fits a text or password site property only')
            if not re.fullmatch(rf'SSAM/O11/{re.escape(self.vault.host)}/SiteProperty/[A-Za-z0-9_.-]{{1,100}}', secret):
                raise ProtocolError('--value-vault must be SSAM/O11/<this host>/SiteProperty/<name>')
        elif value is not None and kind == 'password':
            raise ProtocolError('This site property is secret (masked field): its value comes only from --value-vault '
                                'SSAM/O11/<host>/SiteProperty/<name>, filled inside the Studio, never through this tool')

    def secret_refusal(self):
        if self.http.source == 'studio-web':
            return BridgeError('STUDIO_BRIDGE_OUTDATED', 'The loaded bridge does not fill secret fields from the vault (sc_web:secretRefs); '
                               'nothing was reserved or sent. Reconnect a new bridge version.')
        return BridgeError('STUDIO_REQUIRED', "A secret value (database login, secret site property) goes only through the "
                           "connected Studio's web window, which reads it from the vault inside the Studio; this path never "
                           'holds it. Open and connect the Studio (ssam_connect lane o11), or set it in Service Center yourself.')

    def mutate(self, action, module_id, name, *, value=None, secret=None, execute=False, words=None, operation_id=None, journal=None):
        """value: the new non-secret value (property-set) or the schedule {recurrence, at, every, timeout}
        (timer-schedule). secret: the SiteProperty vault target of a secret value, filled inside the Studio."""
        identity = {'host': self.vault.host, 'action': action, 'moduleId': str(module_id), 'name': name}
        if execute:
            if not words or not words.strip() or not operation_id or journal is None:
                raise ProtocolError("Execution requires the user's words, operation-id and a durable journal")
            existing = journal.lookup(operation_id, identity)
            if existing:
                return dict(existing, replayed=False, existingReceipt=True)
        plan, page, click, target = self.prepare(action, module_id, name)
        if action == 'timer-schedule' and value is not None:
            plan['schedule'] = self.schedule_request(target, value)
        if action == 'property-set':
            self.property_source(target, value, secret)
            if secret is not None:
                plan.update(valueSource='vault', valueTarget=secret, secretRefsSupported=self.http.secrets_supported())
        if not execute:
            return plan
        updates, secrets = {}, None
        if action == 'property-set':
            if secret is not None:
                if not self.http.secrets_supported():
                    raise self.secret_refusal()
                secrets = {target.attrs['name']: {'target': secret, 'field': 'password'}}
            elif value is None:
                raise ProtocolError("property-set requires its value")
            else:
                if target.tag == 'select' and value not in [o.attrs.get('value', o.text) for o in target.all('option')]:
                    raise ProtocolError("Value is not one of the field's accepted options")
                value = expected_value(target, value)
                if target.attrs.get('type', '').lower() == 'radio':
                    raise ProtocolError('Radio-group property protocol variant unsupported')
                updates[target.attrs['name']] = ((target.attrs.get('value', 'on') if value == 'true' else None)
                                                 if target.attrs.get('type', '').lower() == 'checkbox' else value)
        elif action == 'timer-schedule':
            if not plan.get('schedule'):
                raise ProtocolError('timer-schedule requires the new schedule')
            for key, text in plan['schedule'].items():
                node = target[key]
                updates[node.attrs['name']] = (one([o for o in node.all('option') if o.text == text], f'{key} option').attrs.get('value', text)
                                               if node.tag == 'select' else text)
        with journal.reserve(operation_id, identity, words, plan) as receipt:
            tracker = {}
            # Plans carry no secret; the receipt keeps the one it executed so a later verify knows what to expect.
            receipt['plan'] = plan
            try:
                # The durable 'sending' receipt exists BEFORE the request. Any interruption stays uncertain.
                with self.http.authorizing(receipt['operationId'], receipt['authorization']['wordsSha256']) as tracker:
                    response = checked(self.http.submit(page, click, updates, secrets) if secrets else self.http.submit(page, click, updates))
                if action == 'property-set':
                    _, _, _, fresh_value = self.prepare(action, module_id, name)
                    if secrets or fresh_value.attrs.get('type', '').lower() == 'password':
                        # A vault value is never known here, so it is never compared.
                        receipt['state'] = 'accepted' if acknowledged(response, r'saved|updated|applied|changed') else 'accepted-unverified'
                        receipt['valueVerified'] = False
                    elif observed_value(fresh_value) != value:
                        receipt['state'] = 'accepted-unverified'
                    else:
                        receipt['state'] = 'confirmed'
                elif action == 'timer-schedule':
                    _, _, _, schedule = self.prepare(action, module_id, name)
                    now = {k: shown(schedule[k]) for k in plan['schedule']}
                    receipt['observedSchedule'] = now
                    receipt['state'] = 'confirmed' if all(now[k].casefold() == v.casefold() for k, v in plan['schedule'].items()) else 'accepted-unverified'
                elif action in ('timer-activate', 'timer-deactivate'):
                    fresh = self.detail(module_id, 'timers', name)
                    button(fresh, ACTIONS['timer-deactivate' if action == 'timer-activate' else 'timer-activate'])
                    receipt['state'] = 'confirmed'
                else:
                    # HTTP 200 alone is not a scheduling receipt.
                    success = acknowledged(response, r'timer|schedul|queued|execut')
                    receipt['state'] = 'accepted' if success else 'accepted-unverified'
                    receipt['executionCompleted'] = False
                receipt['ok'] = receipt['state'] in ('accepted', 'confirmed')
            except BridgeError as e:
                receipt.update(bridge_failure(e, tracker))
            except Exception:
                receipt.update(state='uncertain', ok=False,
                               error='Response or readback was not confirmed; inspect this receipt and live state before any new operation')
            finally:
                updates.clear()
            receipt['updatedAt'] = utc()
            return receipt

    # ---- BPT (Monitoring > Processes)
    def bpt_processes(self, module=None, process=None, limit=100, max_pages=20):
        page = self.get('Process_Monitoring.aspx?Index=0')
        if module is not None or process is not None:
            click = button(page, ('Filter', 'Search'))
            form = click.ancestor('form')
            fields, updates = form_labels(page, form), {}
            if module is not None:
                select = one([n for name, (label, n) in fields.items() if n.tag == 'select'
                              and (re.search(r'Espace_Selector', name, re.I) or label in ('module', 'espace'))], 'module filter')
                updates[select.attrs['name']] = one([o.attrs.get('value', o.text) for o in select.all('option') if o.text == module], 'module option')
            if process is not None:
                box = one([n for name, (label, n) in fields.items() if n.tag == 'input'
                           and (label in ('process', 'process name') or re.search(r'Process', name, re.I))], 'process filter')
                updates[box.attrs['name']] = process
            page = self.click(page, click, updates)
        result = self.pages(page, limit, max_pages=max_pages)
        for row in result['rows']:
            for link in row['links']:
                query = parse_qs(urlsplit(link['href']).query)
                if 'Process_Details.aspx' in link['href']:
                    row.update(processKey=query.get('ProcessKey', [''])[0], moduleKey=query.get('ModuleKey', [''])[0])
        return dict(result, filters={'module': module, 'process': process})

    def bpt_process(self, process_key, module_key, limit=100, max_pages=20):
        for value in (process_key, module_key):
            if not re.fullmatch(r'[A-Za-z0-9*_-]{1,100}', value or ''):
                raise ProtocolError("processKey and moduleKey come from bpt-processes")
        page = self.get(f'Process_Details.aspx?ProcessKey={quote(process_key)}&ModuleKey={quote(module_key)}&Index=0')
        return {'processKey': process_key, 'moduleKey': module_key, 'summary': summary(page),
                'instances': self.pages(page, limit, max_pages=max_pages)}

    def bpt_instance(self, process_id):
        if not re.fullmatch(r'[1-9][0-9]*', str(process_id)):
            raise ProtocolError("processId must be the numeric instance ID")
        page = self.get(f'Process_Instance_Detail.aspx?ProcessId={process_id}')
        activities = [dict(r, activityId=parse_qs(urlsplit(l['href']).query).get('ActivityId', [''])[0])
                      for r in tables(page) for l in r['links'][:1] if 'Process_Activity_Detail.aspx' in l['href']]
        return {'processId': str(process_id), 'title': heading(page), 'summary': summary(page), 'activities': activities,
                'source': page.url, 'observedAt': utc()}

    def bpt_activity(self, activity_id):
        if not re.fullmatch(r'[1-9][0-9]*', str(activity_id)):
            raise ProtocolError("activityId must be the numeric activity ID")
        page = self.get(f'Process_Activity_Detail.aspx?ActivityId={activity_id}')
        return {'activityId': str(activity_id), 'title': heading(page), 'summary': summary(page), 'source': page.url, 'observedAt': utc()}

    # ---- integrations (module detail) and their logging level
    def integrations(self, module_id):
        page = self.module_page(module_id)
        panel = tab_panel(page, TABS['integrations'][0])
        found = self.integration_links(page, panel)
        if not found and panel is None:
            tabs = [a for a in content(page).all('a') if a.text.casefold() == 'integrations']
            if len(tabs) == 1:
                page = self.follow(page, tabs[0])
                found = self.integration_links(page)
        return {'moduleId': str(module_id), 'integrations': found, 'source': page.url, 'observedAt': utc()}

    def integration_links(self, page, root=None):
        found, seen = [], set()
        for a in (root if root is not None else content(page)).all('a'):
            href = a.attrs.get('href', '')
            if not a.text or inside(a, r'RecentItems|sc-content-left'):
                continue
            for kind, pattern in INTEGRATION_LINKS:
                match = re.search(pattern, href, re.I)
                if match and (kind, match.group(1)) not in seen:
                    seen.add((kind, match.group(1)))
                    found.append({'kind': kind, 'id': match.group(1), 'name': a.text, 'href': self.http.url(href, page.url)})
                    break
        return found

    def integration_page(self, module_id, name, kind=None):
        matches = [i for i in self.integrations(module_id)['integrations'] if i['name'] == name and (kind is None or i['kind'] == kind)]
        target = one(matches, f'integration named {name!r} in module {module_id}')
        page = self.get(target['href'])
        combo = one([c for n, (label, c) in labels(page, content(page)).items() if c.tag == 'select'
                     and (re.search(r'HttpTracingCombo|Logging', n, re.I) or label in ('logging level', 'log level', 'logging'))], 'logging-level selector')
        return target, page, combo

    # ---- database connections (Administration)
    def db_connections(self):
        listing = self.pages(self.get('DatabaseConnections_List.aspx'), 1000)
        connections = []
        for row in listing['rows']:
            for link in row['links']:
                match = re.search(r'DBConnectionId=(\d+)', link['href'])
                if match:
                    connections.append({'id': match.group(1), 'name': link['name'], 'href': link['href'], 'fields': row['fields']})
                    break
        return {'connections': connections, 'truncated': listing['truncated'], 'source': listing.get('source'), 'observedAt': utc()}

    def db_connection(self, name):
        listing = self.db_connections()
        if listing['truncated']:
            raise ProtocolError("Database connection listing is incomplete; refusing to resolve a target by name")
        return one([c for c in listing['connections'] if c['name'] == name], f'database connection named {name!r}')

    def extension_id(self, name):
        listing = self.pages(self.get('Extensions_List.aspx'), 5000)
        ids = [re.search(r'ExtensionId=(\d+)', l['href']).group(1) for r in listing['rows'] for l in r['links']
               if l['name'] == name and re.search(r'ExtensionId=(\d+)', l['href'])]
        if listing['truncated']:
            raise ProtocolError("Extension listing is incomplete; refusing to resolve a target by name")
        return one(sorted(set(ids)), f'extension named {name!r}')

    # ---- solutions (Factory; every solution page is ASSUMED)
    def solutions_page(self):
        return self.get('Solutions_List.aspx')

    def solutions(self, limit=1000):
        page = self.solutions_page()
        listing = assumed(page, 'The solutions list', lambda: self.pages(page, limit))
        found = [{'name': l['name'], 'id': re.search(r'SolutionId=(\d+)', l['href']).group(1), 'href': l['href'], 'fields': r['fields']}
                 for r in listing['rows'] for l in r['links'][:1] if re.search(r'SolutionId=(\d+)', l['href'])]
        if listing['rows'] and not found:
            raise LayoutError(page.url, 'The solutions list', 'its rows link no Solution_Edit.aspx?SolutionId= page')
        return {'solutions': found, 'truncated': listing['truncated'], 'source': listing.get('source'), 'observedAt': utc()}

    def solution_page(self, name):
        listing = self.solutions()
        if listing['truncated']:
            raise ProtocolError("Solution listing is incomplete; refusing to resolve a target by name")
        return self.get(one([s for s in listing['solutions'] if s['name'] == name], f'solution named {name!r}')['href'])

    def solution_download(self, name):
        if self.exports is None:
            raise ProtocolError("Downloads need a local export folder")
        page = self.solution_page(name)
        try:
            click = button(page, ('Download',))
        except ProtocolError:
            click = None
        if click is not None:
            body = self.http.export(page, click, accept='binary')
        else:
            links = [a for a in content(page).all('a') if a.text.casefold() == 'download' and a.attrs.get('href')
                     and not a.attrs['href'].startswith(('javascript:', '#')) and not postback_target(a)]
            body = self.http.download(self.http.url(assumed(page, 'The solution page', lambda: one(links, 'solution Download control')).attrs['href'], page.url))
        # The content type of the .osp answer is not trusted: only the package's ZIP signature is.
        if not body.startswith(b'PK'):
            raise ProtocolError('Solution download is not an OSP package')
        stem = re.sub(r'[^A-Za-z0-9_.-]', '_', name)[:60]
        return {'solution': name, **self.save(stem, 'osp', body), 'observedAt': utc()}

    def components(self, page):
        """Component names of a solution page's listing (its Name column)."""
        return {r['fields'].get('Name') or r['fields'].get('Component') for r in tables(page)} - {None, ''}

    # ---- generic page writes: prepare reads, send posts inside the reservation, observe re-reads
    def web_write(self, action, args, *, execute=False, words=None, operation_id=None, journal=None, approve=None):
        keys = WEB_WRITES[action]
        identity = {'host': self.vault.host, 'action': action, **{k: str(args[k]) for k in keys}}
        prepare = getattr(self, '_prepare_' + action.replace('-', '_'))
        send = getattr(self, '_send_' + action.replace('-', '_'))

        def run(plan, state, receipt):
            # Plans carry no secret; the receipt keeps the one it executed so a later verify knows what to expect.
            receipt['plan'] = plan
            outcome = send(plan, state)
            outcome.setdefault('state', 'confirmed' if self.observe(action, identity, plan) else 'accepted-unverified')
            return outcome

        def gate(plan):
            # Before the reservation: a write with a secret needs the Studio window that fills it from the vault.
            if action in SECRET_WRITES and not self.http.secrets_supported():
                raise self.secret_refusal()
            if approve:
                approve(plan)
        return run_write(identity, lambda: prepare(args), run, execute=execute, words=words, operation_id=operation_id,
                         journal=journal, authorizing=self.http.authorizing, approve=gate)

    def observe(self, action, identity, plan=None):
        if action == 'integration-log-level':
            _, _, combo = self.integration_page(identity['moduleId'], identity['integration'], (plan or {}).get('kind'))
            return plan is not None and selected_text(combo).casefold() == plan['level'].casefold()
        if action == 'solution-create':
            return any(s['name'] == identity['solution'] for s in self.solutions()['solutions'])
        if action in ('solution-add-component', 'solution-remove-component'):
            present = identity['component'] in self.components(self.solution_page(identity['solution']))
            return present if action == 'solution-add-component' else not present
        if action == 'db-connection-create':
            return any(c['name'] == identity['connection'] for c in self.db_connections()['connections'])
        if action == 'db-connection-delete':
            return not any(c['name'] == identity['connection'] for c in self.db_connections()['connections'])
        if action == 'db-connection-test':
            return False  # a test's outcome is its own reply; nothing to re-read
        if action == 'extension-db-connection':
            page = self.get(f"Extension_Edit.aspx?ExtensionId={self.extension_ref(identity['extensionId'])}")
            connection = self.db_connection(identity['connection'])['id']
            combos = self.connection_combos(page, connection)
            return bool(combos) and all(control_value(c) == connection for c in combos)
        raise ProtocolError('Unknown page write')

    def _prepare_solution_create(self, a):
        if not re.fullmatch(r'[A-Za-z0-9 _.-]{1,100}', a['solution']):
            raise ProtocolError('Solution name must be plain text (letters, digits, space, _ . -)')
        if any(s['name'] == a['solution'] for s in self.solutions()['solutions']):
            raise ProtocolError('A solution with this name already exists')
        listing = self.solutions_page()
        new = assumed(listing, 'The solutions list', lambda: one([l for l in content(listing).all('a') if l.text.casefold() in ('new solution', 'create solution', 'new')], 'New Solution link'))
        page = self.follow(listing, new)
        what = 'The new solution form'
        click = assumed(page, what, lambda: button(page, ('Create', 'Save')))
        fields = form_labels(page, click.ancestor('form'))
        name = assumed(page, what, lambda: one([n for n, (label, c) in fields.items() if c.tag == 'input'
                                                and (re.search(r'Solution_?Name$', n) or label in ('name', 'solution name'))], 'solution name field'))
        plan = {'host': self.vault.host, 'action': 'solution-create', 'solution': a['solution'], 'target': page.url, 'execute': False}
        updates = {name: a['solution']}
        if a.get('description') is not None:
            updates[assumed(page, what, lambda: one([n for n, (label, c) in fields.items() if label == 'description' or re.search(r'Description$', n)], 'solution description field'))] = a['description']
            plan['description'] = a['description']
        return plan, {'page': page, 'click': click, 'updates': updates}

    def _send_solution_create(self, plan, s):
        checked(self.http.submit(s['page'], s['click'], s['updates']))
        return {}

    def _component_controls(self, a):
        """The solution page's Associate Component area: the autocomplete input, its hidden value/aux fields, the
        include-references option and Associate (matrix P3, ASSUMED)."""
        page = self.solution_page(a['solution'])
        what = 'The solution page'
        click = assumed(page, what, lambda: button(page, ('Associate',)))
        form = click.ancestor('form')
        found = {key: assumed(page, what, lambda s=suffix, k=key: by_suffix(form, s, k)) for key, suffix in
                 (('box', 'wtComponentInput'), ('value', 'wttxtAutoCompleteValue'), ('aux', 'wttxtAutoCompleteAux'))}
        refs = [n for n in controls(form) if n.attrs['name'].endswith('wtIncludeReferences')]
        return page, click, found, refs[0] if len(refs) == 1 else None

    def component_lookup(self, page, box, value, component):
        """The autocomplete's own lookup (OsAjax Notify, a read): 'label<TAB>key' lines for the typed name; exactly one
        label must be the component (optionally followed by its kind)."""
        widget = value.attrs['name'].rsplit('$', 1)[0].replace('$', '_')
        url, fields = self.http.ajax_post(page, box, {box.attrs['name']: component}, event='Notify', ajax='1024,768,,0,0,0,0,0,0,' + component + '%')
        fields = [(k, widget if k == '__EVENTTARGET' else v) for k, v in fields]
        _, reply = self.http.reply(url + ('&' if '?' in url else '?') + '_ts=0', fields)
        input_id = box.attrs.get('id') or box.attrs['name'].replace('$', '_')
        match = re.search(r"RichWidgets_Input_AutoComplete_setListFor" + re.escape(input_id) + r"""['"]?\]?\s*\(\s*'((?:\\.|[^'\\])*)'""", reply)
        if not match:
            raise LayoutError(page.url, 'The solution component lookup', 'its reply has no autocomplete list for the component input')
        escapes = {'t': '\t', 'n': '\n', 'r': '', "'": "'", '\\': '\\'}
        lines = re.sub(r'\\(.)', lambda m: escapes.get(m.group(1), m.group(1)), match.group(1)).split('\n')
        pairs = [line.split('\t', 1) for line in lines if '\t' in line]
        label, key = one([p for p in pairs if p[0] == component or p[0].startswith(component + ' (')], f'component named {component!r} in the lookup')
        return {'label': label, 'key': key, 'state': ajax_state(reply)}

    def _prepare_solution_add_component(self, a):
        page, click, found, refs = self._component_controls(a)
        present = a['component'] in self.components(page)
        if a.get('includeReferences') and refs is None:
            raise LayoutError(page.url, 'The solution page', 'it has no include-references option')
        plan = {'host': self.vault.host, 'action': 'solution-add-component', 'solution': a['solution'], 'component': a['component'],
                'alreadyPresent': present, 'includeReferences': bool(a.get('includeReferences')), 'target': page.url, 'execute': False}
        state = {'page': page, 'click': click, 'refs': refs, **found}
        if not present:
            lookup = self.component_lookup(page, found['box'], found['value'], a['component'])
            plan.update(componentLabel=lookup['label'], componentKey=lookup['key'])
            state['lookupState'] = lookup['state']
        return plan, state

    def _send_solution_add_component(self, plan, s):
        if plan['alreadyPresent']:
            return {'state': 'confirmed', 'noChange': True}
        updates = {s['box'].attrs['name']: plan['componentLabel'], s['value'].attrs['name']: plan['componentKey'], s['aux'].attrs['name']: 'isVisible'}
        if plan['includeReferences']:
            updates[s['refs'].attrs['name']] = control_value(s['refs'])
        if s.get('lookupState'):
            # Associate goes with the state the lookup refreshed, as the page's form does after the autocomplete.
            form = s['click'].ancestor('form')
            updates[one([n.attrs['name'] for n in controls(form) if n.attrs['name'].endswith('__OSVSTATE')], 'form state field')] = s['lookupState']
        checked(self.http.submit(s['page'], s['click'], updates))
        return {}

    def _prepare_solution_remove_component(self, a):
        page = self.solution_page(a['solution'])
        rows = [r for t in content(page).all('table') for r in t.all('tr')
                if any(c.text == a['component'] for c in r.children if getattr(c, 'tag', None) == 'td')]
        row = one(rows, f"component row {a['component']!r}")
        controls_ = [n for n in row.all('a', 'input') if (n.attrs.get('value', '') or n.text).strip().casefold() in ('remove', 'delete', 'disassociate')]
        control = assumed(page, 'The solution page', lambda: one(controls_, 'remove control in the component row'))
        if control.tag == 'a' and not postback_target(control):
            raise ProtocolError('The remove control is not a recognized postback; no request sent')
        plan = {'host': self.vault.host, 'action': 'solution-remove-component', 'solution': a['solution'], 'component': a['component'],
                'confirm': redact_text(confirm_text(control))[:300], 'target': page.url, 'execute': False}
        return plan, {'page': page, 'control': control}

    def _send_solution_remove_component(self, plan, s):
        if s['control'].tag == 'a':
            checked(self.http.postback(s['page'], s['control']))
        else:
            checked(self.http.submit(s['page'], s['control']))
        return {}

    def connection_form(self, page, click, what):
        """The username and password fields of a database connection form (text before each generated name)."""
        fields = form_labels(page, click.ancestor('form'))
        user = assumed(page, what, lambda: one([n for n, (label, c) in fields.items() if label in ('username', 'user name', 'user', 'login')
                                                 and c.attrs.get('type', 'text').lower() == 'text'], 'username field'))
        password = assumed(page, what, lambda: one([n for n, (label, c) in fields.items() if c.attrs.get('type', '').lower() == 'password'], 'password field'))
        return fields, user, password

    def _prepare_db_connection_create(self, a):
        name = a['connection']
        target = self.vault.secret_target('DatabaseConnection', name)
        if any(c['name'] == name for c in self.db_connections()['connections']):
            raise ProtocolError('A database connection with this name already exists')
        page = self.get('DatabaseConnection_Edit.aspx')
        what = 'The new database connection form'
        click = assumed(page, what, lambda: button(page, ('Create', 'Save')))
        fields, user, password = self.connection_form(page, click, what)
        field = lambda what_, test: one([n for n, (label, c) in fields.items() if test(n, label, c)], what_)
        name_field = field('connection name field', lambda n, label, c: re.search(r'Connection_?Name', n, re.I) or label in ('name', 'connection name', 'logical name'))
        dbms = [c for n, (label, c) in fields.items() if c.tag == 'select' and (re.search(r'DBMS', n, re.I) or label == 'dbms')]
        current = selected_text(dbms[0]) if dbms else None
        if a.get('dbms') and dbms and a['dbms'].casefold() not in (current.casefold(), control_value(dbms[0]).casefold()):
            raise ProtocolError(f"Only the form's default DBMS ({current}) is supported; another DBMS needs a per-DBMS postback not implemented")
        parameters = {'server': a.get('server'), 'database': a.get('database'), **(a.get('parameters') or {})}
        updates = {name_field: name}
        for label_, value in parameters.items():
            if value is None:
                continue
            if re.search(r'pass|secret|token|key|user|login', label_, re.I):
                raise ProtocolError('Secrets never travel as parameters; the login comes from ' + target)
            updates[field(f'{label_!r} field', lambda n, label, c, w=label_.casefold(): label == w)] = value
        plan = {'host': self.vault.host, 'action': 'db-connection-create', 'connection': name, 'dbms': current,
                'parameters': {k: v for k, v in parameters.items() if v is not None}, 'loginTarget': target,
                'loginStored': bool(self.vault.present(target)), 'secretRefsSupported': self.http.secrets_supported(),
                'login': 'username and password from ' + target + ', filled inside the Studio (sc_web secretRefs)',
                'target': page.url, 'execute': False}
        return plan, {'page': page, 'click': click, 'updates': updates, 'user': user, 'password': password}

    def login_refs(self, plan, s):
        return {s['user']: {'target': plan['loginTarget'], 'field': 'username'},
                s['password']: {'target': plan['loginTarget'], 'field': 'password'}}

    def _send_db_connection_create(self, plan, s):
        checked(self.http.submit(s['page'], s['click'], s['updates'], self.login_refs(plan, s)))
        return {}

    def _prepare_db_connection_test(self, a):
        connection = self.db_connection(a['connection'])
        target = self.vault.secret_target('DatabaseConnection', a['connection'])
        page = self.get(connection['href'])
        what = 'The database connection page'
        click = assumed(page, what, lambda: button(page, ('Test Connection', 'Test')))
        _, user, password = self.connection_form(page, click, what)
        plan = {'host': self.vault.host, 'action': 'db-connection-test', 'connection': a['connection'], 'connectionId': connection['id'],
                'loginTarget': target, 'loginStored': bool(self.vault.present(target)), 'secretRefsSupported': self.http.secrets_supported(),
                'target': page.url, 'execute': False}
        return plan, {'page': page, 'click': click, 'user': user, 'password': password}

    def _send_db_connection_test(self, plan, s):
        response = self.http.submit(s['page'], s['click'], None, self.login_refs(plan, s))
        if urlsplit(response.url).path.lower().endswith('/login.aspx'):
            raise ProtocolError("Service Center login required or session expired")
        good = [n for n in response.doc.all() if n.text and re.search('Feedback_Message_Success', n.attrs.get('class', ''), re.I)]
        bad = errors(response)
        if not good and not bad and not any(n.text for n in response.doc.all()):
            # The bridge dropped the whole reply (htmlOmitted): it echoed the login in a form it cannot mask.
            return {'state': 'accepted-unverified', 'testPassed': None,
                    'feedback': 'withheld by the Studio (the reply echoed the login); open the connection page to see the result'}
        if not good and not bad:
            raise LayoutError(response.url, 'The connection test reply', 'it shows no success or error feedback')
        # The test changes nothing; its reply is the result. The server's text can echo the login, so only the outcome
        # comes back.
        return {'state': 'confirmed', 'testPassed': bool(good) and not bad,
                'feedback': 'success' if good and not bad else 'error (server text withheld: it can echo the login)'}

    def _prepare_db_connection_delete(self, a):
        connection = self.db_connection(a['connection'])
        page = self.get(connection['href'])
        control = one([n for n in content(page).all('a', 'input') if (n.attrs.get('value', '') or n.text).strip().casefold() == 'delete'
                       and (n.tag == 'input' or postback_target(n))], 'Delete control')
        # Extensions that use the connection must be named by the user's words too (matrix D4).
        used = sorted({r['fields'].get('Extension') for r in tables(page) if r['fields'].get('Extension')})
        plan = {'host': self.vault.host, 'action': 'db-connection-delete', 'connection': a['connection'], 'connectionId': connection['id'],
                'usedBy': used, 'namedTargets': [a['connection'], *used], 'confirm': redact_text(confirm_text(control))[:300],
                'target': page.url, 'destructive': True, 'execute': False}
        return plan, {'page': page, 'control': control}

    def _send_db_connection_delete(self, plan, s):
        if s['control'].tag == 'a':
            checked(self.http.postback(s['page'], s['control']))
        else:
            checked(self.http.submit(s['page'], s['control']))
        return {}

    def connection_combos(self, page, connection_id):
        return [s for s in content(page).all('select') if re.search(r'DBConnectionCombo', s.attrs.get('name', ''), re.I)
                and connection_id in [o.attrs.get('value', o.text) for o in s.all('option')]]

    def extension_ref(self, value):
        """The numeric extension ID, given either that ID or the extension's exact name."""
        return str(value) if re.fullmatch(r'[1-9][0-9]*', str(value)) else self.extension_id(str(value))

    def _prepare_extension_db_connection(self, a):
        extension_id = self.extension_ref(a['extensionId'])
        connection = self.db_connection(a['connection'])
        page = self.get(f'Extension_Edit.aspx?ExtensionId={extension_id}')
        combos = self.connection_combos(page, connection['id'])
        if not combos:
            raise ProtocolError('No database-connection selector of this extension offers that connection')
        pending = [c.attrs['name'] for c in combos if control_value(c) != connection['id']]
        plan = {'host': self.vault.host, 'action': 'extension-db-connection', 'extensionId': extension_id, 'connection': a['connection'],
                'connectionId': connection['id'], 'selectors': len(combos), 'pending': len(pending), 'target': page.url, 'execute': False}
        return plan, {'url': page.url}

    def _send_extension_db_connection(self, plan, s):
        # One OsAjax Change (a read that stages the value) -> Apply (the write) for one selector. The bridge accepts each
        # operationId once, so a second selector is a new call with its own operationId, after this one's re-read.
        page = self.get(s['url'])
        pending = [c for c in self.connection_combos(page, plan['connectionId']) if control_value(c) != plan['connectionId']]
        if not pending:
            return {'state': 'confirmed', 'noChange': True}
        combo = pending[0]
        name = combo.attrs['name']
        reply = self.http.text(*self.http.ajax_post(page, combo, {name: plan['connectionId']}, event='Change'))
        state = ajax_state(reply)
        if not state:
            raise LayoutError(page.url, "The extension's OsAjax 'Change' reply", 'it carries no refreshed form state')
        osv = one([n.attrs['name'] for n in controls(combo.ancestor('form')) if n.attrs['name'].endswith('__OSVSTATE')], 'form state field')
        checked(self.http.submit(page, button(page, ('Apply',)), {name: plan['connectionId'], osv: state}))
        left = [c for c in self.connection_combos(self.get(s['url']), plan['connectionId']) if control_value(c) != plan['connectionId']]
        if not left:
            return {'state': 'confirmed'}
        if len(left) < len(pending):
            # This Apply landed; the remaining selectors need their own operation (a new operationId each).
            return {'state': 'accepted', 'remainingSelectors': len(left),
                    'continuation': {'tool': 'o11_service_center_write', 'action': 'extension-db-connection', 'execute': True,
                                     'note': 'repeat with a new operationId for the next selector'}}
        return {'state': 'accepted-unverified'}

    def _prepare_integration_log_level(self, a):
        target, page, combo = self.integration_page(a['moduleId'], a['integration'], a.get('kind'))
        options = {o.text.casefold(): o.attrs.get('value', o.text) for o in combo.all('option')}
        if a['level'].casefold() not in options:
            raise ProtocolError('Logging level unavailable; options: ' + ', '.join(o.text for o in combo.all('option')))
        click = button(page, ('Apply', 'Save'))
        plan = {'host': self.vault.host, 'action': 'integration-log-level', 'moduleId': str(a['moduleId']), 'integration': a['integration'],
                'kind': target['kind'], 'integrationId': target['id'], 'currentLevel': selected_text(combo), 'level': a['level'],
                'changed': selected_text(combo).casefold() != a['level'].casefold(), 'target': page.url, 'execute': False}
        return plan, {'page': page, 'click': click, 'combo': combo.attrs['name'], 'value': options[a['level'].casefold()]}

    def _send_integration_log_level(self, plan, s):
        if not plan['changed']:
            return {'state': 'confirmed', 'noChange': True}
        checked(self.http.submit(s['page'], s['click'], {s['combo']: s['value']}))
        _, _, combo = self.integration_page(plan['moduleId'], plan['integration'], plan['kind'])
        level = selected_text(combo)
        return {'state': 'confirmed' if level.casefold() == plan['level'].casefold() else 'accepted-unverified', 'observedLevel': level}


def bridge_failure(e, tracker):
    """Refused only when the bridge turned down the write request itself and no earlier step of it went out; rejected
    when Service Center answered the write with a definite error; anything else stays uncertain."""
    own = e.extra.get('write') is True and not e.extra.get('sent') and not tracker.get('sent')
    refused = own and (e.code in NOT_SENT or e.extra.get('executed') is False)
    rejected = e.extra.get('write') is True and e.code == 'REMOTE_ERROR' and not e.extra.get('signInRequired')
    state = 'refused' if refused else 'rejected' if rejected else 'uncertain'
    failure = {'state': state, 'ok': False, 'code': e.code,
               'error': str(e) if state != 'uncertain' else 'Sent but not confirmed (' + e.code + '); reconcile by a read, never repeat it'}
    if e.code == 'SECRET_NOT_FOUND' and refused:
        # The Studio found no vault entry (or not the part) a secretRefs entry named; nothing was sent. The next call with
        # a new operationId opens the private prompt for that entry when it is absent (secret_ready).
        failure.update(target=e.extra.get('target'), part=e.extra.get('part'),
                       continuation='Store the entry with the private prompt (windows-o11-credential.ps1 -Mode bootstrap, opened by '
                                    'the next call when the entry is absent), then repeat with a new operationId')
    return failure


def run_write(identity, prepare, send, *, execute, words, operation_id, journal, authorizing=None, lock=None, approve=None):
    """Prepare by default. Execute: the user's words, an operationId UUID, the durable reservation before anything is
    sent, and no replay: the same operationId returns its receipt; a failure after sending stays uncertain.
    approve(plan) checks the words against the resolved target before the reservation."""
    if execute:
        if not words or not words.strip() or not operation_id or journal is None:
            raise ProtocolError("Execution requires the user's words, operation-id and a durable journal")
        existing = journal.lookup(operation_id, identity)
        if existing:
            return dict(existing, replayed=False, existingReceipt=True)
    plan, state = prepare()
    if not execute:
        return plan
    if approve:
        approve(plan)
    with journal.reserve(operation_id, identity, words, plan, lock(plan) if lock else None) as receipt:
        tracker = {}
        try:
            scope = authorizing(receipt['operationId'], receipt['authorization']['wordsSha256']) if authorizing else nullcontext({})
            with scope as tracker:
                receipt.update(send(plan, state, receipt))
            receipt['ok'] = receipt['state'] in ('accepted', 'confirmed')
        except BridgeError as e:
            receipt.update(bridge_failure(e, tracker))
        except Exception:
            receipt.update(state='uncertain', ok=False,
                           error='Response or readback was not confirmed; inspect this receipt and live state before any new operation')
        receipt['updatedAt'] = utc()
        return receipt


class Journal:
    """Exclusive durable operation IDs; a crash or lost response is never retried."""
    def __init__(self, root, legacy=None):
        self.root = Path(root)
        self.legacy = Path(legacy) if legacy else None

    def path(self, operation_id):
        try:
            canonical = str(uuid.UUID(operation_id))
        except (ValueError, TypeError, AttributeError):
            raise ProtocolError("operation-id must be a UUID") from None
        return self.root / (canonical + '.json')

    def lookup(self, operation_id, identity=None):
        path = self.path(operation_id)
        if not path.exists() and self.legacy is not None and (self.legacy / path.name).exists():
            # Receipts written before the journal moved out of %LOCALAPPDATA% still answer for their IDs.
            path = self.legacy / path.name
        if not path.exists():
            return None
        result = json.loads(path.read_text(encoding='utf-8'))
        if identity and result['identity'] != identity:
            raise ProtocolError("operation-id already belongs to a different target or operation")
        if result['state'] == 'sending':
            result.update(state='uncertain', ok=False)
        return result

    def reconcile(self, receipt):
        if receipt['state'] in ('confirmed', 'accepted'):
            return
        if json.loads(self.path(receipt['operationId']).read_text())['state'] == 'sending':
            raise ProtocolError('Sender may still be active; a sending receipt cannot be automatically reconciled')
        target = receipt.get('lock') or {k: v for k, v in receipt['identity'].items() if k != 'action'}
        lock = self.root / (fingerprint(target) + '.lock')
        if not lock.exists() or lock.read_text() != receipt['operationId']:
            raise ProtocolError('Pending target lock no longer belongs to this receipt')
        receipt.update(state='confirmed', ok=True, reconciledAt=utc(),
                       verification='Desired state observed; this does not prove which writer established it')
        path = self.path(receipt['operationId'])
        temporary = path.with_suffix('.tmp')
        with temporary.open('x', encoding='utf-8') as f:
            json.dump(receipt, f, indent=2); f.flush(); os.fsync(f.fileno())
        os.replace(temporary, path)
        lock.unlink()

    def reserve(self, operation_id, identity, words, plan, lock_target=None):
        from contextlib import contextmanager

        @contextmanager
        def reserved():
            self.root.mkdir(parents=True, exist_ok=True)
            path = self.path(operation_id)
            # Also exclude concurrent writes with different IDs to the same runtime target.
            target = lock_target or {k: v for k, v in identity.items() if k != 'action'}
            lock = self.root / (fingerprint(target) + '.lock')
            try:
                fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                raise ProtocolError("This runtime target has a pending/uncertain operation; inspect its receipts") from None
            receipt = {'schema': 'ssam-service-center/1', 'operationId': str(uuid.UUID(operation_id)),
                       'identity': identity, 'authorization': {'wordsSha256': hashlib.sha256(words.encode('utf-8')).hexdigest(), 'planSha256': fingerprint(plan)},
                       'state': 'sending', 'ok': False, 'createdAt': utc(), 'receipt': str(path.resolve()),
                       **({'lock': lock_target} if lock_target else {})}
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    f.write(receipt['operationId']); f.flush(); os.fsync(f.fileno())
                # No replacement: even a concurrent same-ID caller cannot repeat the POST.
                with path.open('x', encoding='utf-8') as f:
                    json.dump(receipt, f, indent=2); f.flush(); os.fsync(f.fileno())
            except Exception:
                lock.unlink(missing_ok=True)
                raise
            try:
                yield receipt
            finally:
                temporary = path.with_suffix('.tmp')
                with temporary.open('w', encoding='utf-8') as f:
                    json.dump(receipt, f, indent=2); f.flush(); os.fsync(f.fileno())
                os.replace(temporary, path)
                # Uncertain writes keep their target lock. A read can reconcile; it cannot replay.
                if receipt['state'] in RELEASED:
                    lock.unlink(missing_ok=True)
        return reserved()
