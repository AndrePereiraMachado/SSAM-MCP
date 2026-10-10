// Bounded, same-origin HTTP for the Service Center pages (port of kernel/scripts/service_center/http.py).
//   Transport           direct HTTPS with an in-memory cookie jar; the vault form login authenticates it (vault.mjs
//                       posts the login itself, so the credential never exists in this process).
//   StudioWebTransport  the connected Studio's own web window (bridge sc_web): the fetch runs in the Studio's WebView,
//                       same origin, and only the body comes back. The cookie never leaves the Studio.
// HTML and protocol contracts are data; scripts from the server are never evaluated.
import http from 'node:http';
import https from 'node:https';
import { BridgeError, ProtocolError } from './errors.mjs';
import { Document, Page, controls, formFields, lower, postbackTarget, secretRefs as toSecretRefs } from './html.mjs';
import { urlencode, urljoin, urlsplit } from './urls.mjs';

// Codes with which the bridge turns a request down before sending anything to Service Center.
export const NOT_SENT = new Set(['NOT_ALLOWED', 'BAD_REQUEST', 'HOST_MISMATCH', 'STUDIO_NOT_SIGNED_IN', 'WEB_SIGN_IN_REQUIRED',
  'STUDIO_BRIDGE_OUTDATED', 'STUDIO_UNAVAILABLE', 'SECRET_NOT_FOUND']);
// bridge_manifest capability of a bridge that fills sc_web secretRefs from the vault inside the Studio.
export const SECRET_CAPABILITY = 'sc_web:secretRefs';
// Once the session expired the login page answers in place of the asked page (same URL, HTTP 200, live on 11.42): its form
// posts to Login.aspx inside div.sc-layout-login, with only "Log in with SSO" when the environment signs in by SSO.
export const LOGIN_PAGE = /<form\b[^>]*\baction="(?:[^"]*\/)?_?login(?:sso)?\.aspx(?:\?[^"]*)?"|class="[^"]*\bsc-layout-login\b/i;
export const LIMIT = 8 * 1024 * 1024;
export const BINARY_LIMIT = 64 * 1024 * 1024;
export const STATE = /^__(?:OSVSTATE|VIEWSTATE|VIEWSTATEGENERATOR|EVENTVALIDATION)$/;
const REDIRECTS = [301, 302, 303, 307, 308];

export function hostName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value))
    throw new ProtocolError('Use a DNS host, without scheme, port, path or credentials');
  if (value.split('.').some(p => !p || p.length > 63 || p.startsWith('-') || p.endsWith('-'))) throw new ProtocolError('Invalid DNS host');
  return value.toLowerCase();
}

export function accepted(kind, accept) {
  if (accept === 'html' && !kind.includes('text/html')) throw new ProtocolError('Expected Service Center HTML; protocol variant unsupported');
  if (accept === 'text' && !(kind.startsWith('text/') || kind.includes('json') || kind.includes('javascript')))
    throw new ProtocolError('Expected a Service Center text reply; protocol variant unsupported');
  // An HTML answer to a download is a login page or an error page, never the file.
  if ((accept === 'xlsx' || accept === 'binary') && kind.includes('text/html')) throw new ProtocolError('Service Center answered with a page instead of the file');
}

const charsetOf = kind => /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(kind)?.[1]?.toLowerCase() ?? null;
export const decode = (raw, charset) => new TextDecoder(charset || 'utf-8').decode(raw);

// The cookies of one host, in memory only (http.cookiejar.CookieJar for a single same-origin host).
export class CookieJar {
  constructor() { this.cookies = new Map(); }
  store(url, headers = []) {
    const requestPath = urlsplit(url).path || '/';
    const fallback = requestPath.lastIndexOf('/') > 0 ? requestPath.slice(0, requestPath.lastIndexOf('/')) : '/';
    for (const header of headers) {
      const [pair, ...rest] = String(header).split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), path: fallback, expires: null };
      for (const part of rest) {
        const [key, ...value] = part.split('='); const v = value.join('=').trim();
        const k = key.trim().toLowerCase();
        if (k === 'path' && v.startsWith('/')) cookie.path = v;
        else if (k === 'max-age' && /^-?\d+$/.test(v)) cookie.expires = Date.now() + Number(v) * 1000;
        else if (k === 'expires' && cookie.expires === null && !Number.isNaN(Date.parse(v))) cookie.expires = Date.parse(v);
      }
      const key = cookie.name + '\n' + cookie.path;
      if (cookie.expires !== null && cookie.expires <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, cookie);
    }
  }
  header(url) {
    const path = urlsplit(url).path || '/';
    const now = Date.now();
    return [...this.cookies.values()]
      .filter(c => (c.expires === null || c.expires > now) && (path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')))
      .sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
  }
}

// One HTTP exchange, no redirect followed: {status, location, contentType, setCookie[], body}. The body is read up to
// limit + 1 bytes, so an oversize answer is seen without being held whole.
export function nodeSend() {
  return ({ method, url, headers, body, timeoutMs, limit }) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = (target.protocol === 'http:' ? http : https).request(target, { method, headers, timeout: timeoutMs }, response => {
      const chunks = []; let size = 0; let settled = false;
      const done = () => { if (settled) return; settled = true; resolve({ status: response.statusCode, location: response.headers.location ?? '',
        contentType: response.headers['content-type'] ?? '', setCookie: response.headers['set-cookie'] ?? [], body: Buffer.concat(chunks) }); };
      response.on('data', chunk => { if (settled) return; chunks.push(chunk); size += chunk.length; if (size > limit) { done(); response.destroy(); } });
      response.on('end', done);
      response.on('error', error => { if (!settled) { settled = true; reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (body !== null && body !== undefined) request.write(body);
    request.end();
  });
}

export class Transport {
  constructor(host, { timeoutMs = 30000, send = null, origin = null } = {}) {
    this.host = hostName(host);
    this.base = `https://${this.host}/ServiceCenter/`;
    this.timeoutMs = timeoutMs;
    this.preauthenticated = false;
    this.authorized = null;
    this.source = 'vault';
    this.jar = new CookieJar();
    // Where the bytes go: the host itself; a test points it at a loopback server. The checks use the logical URL.
    this.origin = origin ?? `https://${this.host}`;
    this.send = send ?? nodeSend();
  }

  // This process never holds a database login or a secret property value: only the Studio's web window can receive
  // them (sc_web secretRefs), so the direct HTTPS path refuses every write that carries one.
  async secretsSupported() { return false; }

  physical(url) { const p = urlsplit(url); return this.origin + p.path + (p.query ? '?' + p.query : ''); }

  url(value, base = null) {
    const url = urljoin(base || this.base, value);
    const p = urlsplit(url);
    if (p.scheme !== 'https' || p.netloc.toLowerCase() !== this.host || p.username || p.fragment
        || !p.path.toLowerCase().startsWith('/servicecenter/') || p.path.split('/').some(s => s === '.' || s === '..')
        || /%2f|%5c|%2e/i.test(p.path) || url.includes('\\'))
      throw new ProtocolError('Service Center request/redirect must stay on the exact HTTPS host and path');
    return url;
  }

  // [final url, content type, body, charset]. accept: html, text (AJAX replies), xlsx or binary. firstHop replaces the
  // first exchange (the vault login, posted by vault.mjs); everything after it follows the same rules.
  async fetch(url, fields = null, accept = 'html', secretRefs = null, firstHop = null) {
    url = this.url(url);
    if (secretRefs?.length) throw new BridgeError('STUDIO_REQUIRED', "A secret value goes only through the connected Studio's web window (secretRefs); "
      + 'this process never reads it. Nothing was sent.', { write: true, executed: false });
    let data = fields === null || fields === undefined ? null : urlencode(fields);
    const limit = accept === 'html' || accept === 'text' ? LIMIT : BINARY_LIMIT;
    for (let hop = 0; hop < 6; hop++) {
      const headers = { 'User-Agent': 'SSAM-Hybrid-O11/1', Accept: accept === 'html' ? 'text/html' : '*/*', Connection: 'close',
        ...(data !== null ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {}) };
      const cookie = this.jar.header(url);
      if (cookie) headers.Cookie = cookie;
      let response;
      try {
        response = hop === 0 && firstHop ? await firstHop(url, data)
          : await this.send({ method: data === null ? 'GET' : 'POST', url: this.physical(url), headers, body: data, timeoutMs: this.timeoutMs, limit });
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError('Service Center connection failed; no automatic retry');
      }
      this.jar.store(url, response.setCookie);
      if (REDIRECTS.includes(response.status)) {
        const location = response.location || '';
        if (!location) throw new ProtocolError('Service Center redirect has no destination');
        if (urlsplit(urljoin(url, location)).hostname === 'id.outsystems.com')
          throw new ProtocolError('Service Center requires OutSystems ID SSO; this HTTP adapter has no validated SSO exchange. No vault credential was sent to the identity provider');
        const destination = this.url(location, url);
        if (data !== null && (response.status === 307 || response.status === 308)) throw new ProtocolError('Refusing to replay a POST after a redirect');
        url = destination; data = null;
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new ProtocolError(`Service Center returned HTTP ${response.status}`);
      const kind = String(response.contentType ?? '').toLowerCase();
      accepted(kind, accept);
      if (response.body.length > limit) throw new ProtocolError('Service Center response exceeds its size limit');
      return [url, kind, response.body, response.charset ?? charsetOf(kind) ?? 'utf-8'];
    }
    throw new ProtocolError('Too many Service Center redirects');
  }

  async request(url, fields = null, secretRefs = null) {
    const [final, , raw, charset] = await this.fetch(url, fields, 'html', secretRefs);
    return new Page(final, new Document(decode(raw, charset)));
  }
  async text(url, fields = null) { const [, , raw, charset] = await this.fetch(url, fields, 'text'); return decode(raw, charset); }
  // [final url, text] of a read postback whose answer may be a page or an OsAjax reply.
  async reply(url, fields = null) { const [final, , raw, charset] = await this.fetch(url, fields, 'text'); return [final, decode(raw, charset)]; }
  async download(url, fields = null, accept = 'binary') { return (await this.fetch(url, fields, accept))[2]; }

  // [action url, fields] of a click on a plain submit control; nothing is sent.
  formPost(page, clicked, updates = null) {
    const form = clicked.ancestor('form');
    if (!form || lower(form.attr('method', 'get')) !== 'post') throw new ProtocolError('Expected a POST form');
    // Unrecognized JS submit routing must not silently become a different operation.
    if (clicked.attr('formaction') || /OsAjax|__doPostBack|\.submit\(/i.test(clicked.attr('onclick', '') ?? ''))
      throw new ProtocolError('Unsupported scripted form submission; no request sent');
    const changes = Object.entries(updates ?? {});
    const names = new Set(controls(form).map(n => n.attr('name')));
    if (!changes.every(([k]) => names.has(k))) throw new ProtocolError('Unknown form field');
    const changed = new Set(changes.map(([k]) => k));
    const fields = formFields(form, clicked).filter(([k]) => !changed.has(k));
    fields.push(...changes.filter(([, v]) => v !== null && v !== undefined));
    return [this.url(form.attr('action') || page.url, page.url), fields];
  }

  // secrets: {field name: {target, field}}. Those fields go as empty placeholders and the Studio fills them from the
  // vault (secretRefs); the value never exists in this process.
  async submit(page, clicked, updates = null, secrets = null) {
    if (!secrets || !Object.keys(secrets).length) { const post = this.formPost(page, clicked, updates); this.attempting(); return this.request(...post); }
    if (Object.keys(secrets).some(k => Object.hasOwn(updates ?? {}, k))) throw new ProtocolError('A secret field cannot also carry a value');
    const [url, fields] = this.formPost(page, clicked, { ...(updates ?? {}), ...Object.fromEntries(Object.keys(secrets).map(k => [k, ''])) });
    const refs = toSecretRefs(secrets);
    this.attempting();
    return this.request(url, fields, refs);
  }

  // From here on the authorized POST may go out: a failure after this mark is never read as "nothing was sent" (P6).
  attempting() { if (this.authorized) this.authorized[2].attempted = true; }

  // The vault login: the page's own form state goes from here; vault.mjs adds the user and password fields inside its
  // own PowerShell process and posts them. Only cookies and the (scrubbed) answer come back.
  async vaultLogin(page, clicked, userField, passwordField, vault) {
    const [url, pairs] = this.formPost(page, clicked);
    const fields = pairs.filter(([k]) => k !== userField && k !== passwordField);
    const [final, , raw, charset] = await this.fetch(url, fields, 'html', null, (target, body) => vault.login({
      url: this.physical(target), body, userField, passwordField, cookie: this.jar.header(target), timeoutMs: this.timeoutMs, limit: LIMIT }));
    return new Page(final, new Document(decode(raw, charset)));
  }

  // [action url, fields] of an OsAjax event on a control, as the page's script sends it: the form state, the control's
  // own value, __EVENTTARGET and __AJAX (matrix L7, D5). A submit adds its own name=value; a select's Change carries
  // __AJAXEVENT instead of __EVENTARGUMENT. Nothing is sent.
  ajaxPost(page, control, updates = null, event = null, ajax = null) {
    const form = control.ancestor('form');
    if (!form || lower(form.attr('method', 'get')) !== 'post') throw new ProtocolError('Expected a POST form around the OsAjax control');
    const changes = Object.entries(updates ?? {});
    const names = new Set(controls(form).map(n => n.attr('name')));
    if (!changes.every(([k]) => names.has(k))) throw new ProtocolError('Unknown form field');
    const changed = new Set(changes.map(([k]) => k));
    const name = control.attr('name');
    const fields = formFields(form).filter(([k]) => !changed.has(k) && !['__EVENTTARGET', '__EVENTARGUMENT', '__AJAX', '__AJAXEVENT'].includes(k));
    fields.push(...changes.filter(([, v]) => v !== null && v !== undefined));
    fields.push(['__EVENTTARGET', name]);
    fields.push(event ? ['__AJAXEVENT', event] : ['__EVENTARGUMENT', '']);
    fields.push(['__AJAX', ajax || '1280,1024,' + (control.attr('id') || name.replaceAll('$', '_')) + ',0,0,0,0,0,0,']);
    if (lower(control.attr('type', '')) === 'submit') fields.push([name, control.attr('value', '')]);
    return [this.url(form.attr('action') || page.url, page.url), fields];
  }

  async export(page, clicked, updates = null, accept = 'xlsx') { return this.download(...this.formPost(page, clicked, updates), accept); }

  // [action url, fields] of a __doPostBack or OsAjax link: the page's own form state plus the event.
  eventPost(page, link, updates = null, extra = null) {
    const event = postbackTarget(link);
    if (!event) throw new ProtocolError('Link is not a recognized Web Forms postback; no request sent');
    const form = link.ancestor('form') ?? page.doc.first('form');
    if (!form || lower(form.attr('method', 'get')) !== 'post') throw new ProtocolError('Expected a POST form around the postback');
    const changes = Object.entries(updates ?? {});
    const names = new Set(controls(form).map(n => n.attr('name')));
    if (!changes.every(([k]) => names.has(k))) throw new ProtocolError('Unknown form field');
    const changed = new Set(changes.map(([k]) => k));
    const fields = formFields(form).filter(([k]) => !changed.has(k) && k !== '__EVENTTARGET' && k !== '__EVENTARGUMENT');
    fields.push(...changes.filter(([, v]) => v !== null && v !== undefined));
    if (event.kind === 'postback') fields.push(['__EVENTTARGET', event.target], ['__EVENTARGUMENT', event.argument]);
    else fields.push([event.target, '']); // an OsAjax link posted as a full Web Forms request: its control name carries the event
    fields.push(...Object.entries(extra ?? {}));
    return [this.url(form.attr('action') || page.url, page.url), fields];
  }

  async postback(page, link, updates = null) { return this.request(...this.eventPost(page, link, updates)); }

  // POSTs inside fn belong to one authorized write (journal already reserved). The tracker records whether any of
  // them went out.
  async authorizing(operationId, wordsSha256, fn) {
    const tracker = { sent: false, attempted: false };
    this.authorized = [operationId, wordsSha256, tracker];
    try { return await fn(tracker); } finally { this.authorized = null; }
  }
}

export class StudioWebTransport extends Transport {
  // reenter: signs the expired window in again without asking anyone while the Studio itself is signed in (auth.mjs
  // reenterWindow, C05). A read (GET) answered by the sign-in page calls it once and is read again; a postback never is.
  constructor(host, bridge, { timeoutMs = 120000, reenter = null } = {}) {
    super(host, { timeoutMs, send: () => { throw new ProtocolError('The Studio web transport sends nothing itself'); } });
    this.bridge = bridge;
    this.preauthenticated = true;
    this.source = 'studio-web';
    this.reenter = typeof reenter === 'function' ? reenter : null;
    this.reentered = false;
  }

  async fetch(url, fields = null, accept = 'html', secretRefs = null) {
    try { return await this.fetchOnce(url, fields, accept, secretRefs); }
    catch (error) {
      const read = fields === null || fields === undefined;
      if (!(error instanceof BridgeError) || error.code !== 'WEB_SIGN_IN_REQUIRED' || !read || !this.reenter || this.reentered) throw error;
      this.reentered = true;
      await this.reenter();
      return this.fetchOnce(url, fields, accept, secretRefs);
    }
  }

  // Only a bridge that announces sc_web:secretRefs fills the placeholders; an older one would ignore the field and post
  // them empty.
  async secretsSupported() {
    if (typeof this.bridge?.capabilities !== 'function') return false;
    const capabilities = await this.bridge.capabilities();
    return Boolean(capabilities) && [...capabilities].includes(SECRET_CAPABILITY);
  }

  async fetchOnce(url, fields = null, accept = 'html', secretRefs = null) {
    url = this.url(url);
    const p = urlsplit(url);
    let form = null;
    if (fields !== null && fields !== undefined) {
      form = {};
      for (const [k, v] of fields) {
        if (Object.hasOwn(form, k) && form[k] !== v) throw new ProtocolError('Form repeats a field name with different values; unsupported by the Studio web transport');
        form[k] = v;
      }
    }
    // An OsAjax reply (accept text) only stages a value in the page state: a read postback, never the write itself.
    // The bridge accepts each operationId once, so only the committing post carries it.
    const write = form !== null && this.authorized !== null && accept !== 'text';
    if (secretRefs?.length) {
      if (!write) throw new ProtocolError('Secret references travel only on an authorized write postback');
      if (!await this.secretsSupported()) throw new BridgeError('STUDIO_BRIDGE_OUTDATED', 'The loaded bridge does not fill secret fields from the vault (sc_web:secretRefs); '
        + 'nothing was sent. Reconnect a new bridge version.', { write: true, executed: false });
      if (secretRefs.some(r => form[r.pointer.slice(1).replaceAll('~1', '/').replaceAll('~0', '~')] !== ''))
        throw new ProtocolError('Every secret reference points to an empty placeholder field of this form');
    }
    const path = p.path + (p.query ? '?' + p.query : '');
    let reply;
    try {
      reply = await this.bridge.web(this.host, 'fetch', { method: form === null ? 'GET' : 'POST', path, form,
        accept: accept === 'text' ? 'html' : accept, write,
        ...(write ? { operationId: this.authorized[0], authorizeSha256: this.authorized[1] } : {}),
        ...(secretRefs?.length ? { secretRefs } : {}) });
    } catch (error) {
      if (error instanceof BridgeError) {
        // A bridge without accept=binary returns any download body for xlsx; a read can be asked again.
        if (accept === 'binary' && error.code === 'BAD_REQUEST' && !write) return this.fetch(url, fields, 'xlsx');
        if (write && !((NOT_SENT.has(error.code) || error.extra.executed === false) && error.extra.write)) this.authorized[2].sent = true;
      }
      throw error;
    }
    if (write) this.authorized[2].sent = true;
    if (reply?.redirected === true && form !== null) {
      // A postback answered with a redirect (manual mode): the POST went through; read the page again.
      if (accept !== 'html' && accept !== 'text') throw new ProtocolError('Service Center redirected instead of returning the file');
      return this.fetch(url);
    }
    let final = reply?.finalUrl || url;
    try { final = this.url(final); }
    catch { throw new BridgeError('HOST_MISMATCH', 'The Studio web window left the Service Center host; nothing was followed', { sent: form !== null }); }
    if (urlsplit(final).path.toLowerCase().endsWith('/login.aspx') || [401, 403].includes(reply?.status))
      throw new BridgeError('WEB_SIGN_IN_REQUIRED', "The Studio's Service Center window is not signed in; run o11_service_center_session action=web-sign-in", { sent: form !== null });
    const status = reply && Object.hasOwn(reply, 'status') ? reply.status : 200;
    if (status !== 200) throw new ProtocolError(`Service Center returned HTTP ${status ?? 'None'}`);
    const kind = String(reply.contentType || (Object.hasOwn(reply, 'html') ? 'text/html' : '')).toLowerCase();
    accepted(kind, accept);
    let raw;
    if (Object.hasOwn(reply, 'bodyBase64')) {
      const text = String(reply.bodyBase64);
      if (text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('Invalid base64 body');
      raw = Buffer.from(text, 'base64');
    } else raw = Buffer.from(String(reply.html ?? ''), 'utf8'); // html:null + htmlOmitted: the reply echoed a vault value the bridge could not mask
    if (raw.length > (accept === 'html' || accept === 'text' ? LIMIT : BINARY_LIMIT)) throw new ProtocolError('Service Center response exceeds its size limit');
    if (kind.includes('html') && LOGIN_PAGE.test(raw.toString('utf8')))
      throw new BridgeError('WEB_SIGN_IN_REQUIRED', "Service Center answered with its login page: the session of the Studio's Service Center window "
        + 'expired; nothing was read. Run o11_service_center_session action=web-sign-in, the user signs in once, then repeat the call', { sent: form !== null });
    return [final, kind, raw, 'utf-8'];
  }
}
