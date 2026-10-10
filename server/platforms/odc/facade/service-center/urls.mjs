// urllib.parse as the Python adapter used it (urlsplit, urljoin, parse_qs, quote, urlencode, unquote), so the same
// URLs pass or fail the same-origin checks. The WHATWG URL parser normalizes dot segments and %2e before a check
// could see them; these functions keep them, as Python did, and the checks refuse them.

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;
const USES_RELATIVE = new Set(['', 'ftp', 'http', 'gopher', 'nntp', 'imap', 'wais', 'file', 'https', 'shttp', 'mms', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'sftp', 'svn', 'svn+ssh', 'ws', 'wss']);
const USES_NETLOC = new Set(['', 'ftp', 'http', 'gopher', 'nntp', 'telnet', 'imap', 'wais', 'file', 'mms', 'https', 'shttp', 'snews', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'rsync', 'svn', 'svn+ssh', 'sftp', 'nfs', 'git', 'git+ssh', 'ws', 'wss', 'itms-services']);

export function urlsplit(url, defaultScheme = '') {
  url = String(url).replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '');
  let scheme = defaultScheme.replace(/[\t\r\n]/g, ''); let netloc = ''; let query = ''; let fragment = '';
  const i = url.indexOf(':');
  if (i > 0 && /^[A-Za-z]/.test(url[0]) && SCHEME_CHARS.test(url.slice(0, i))) { scheme = url.slice(0, i).toLowerCase(); url = url.slice(i + 1); }
  if (url.startsWith('//')) {
    let delim = url.length;
    for (const c of '/?#') { const w = url.indexOf(c, 2); if (w >= 0) delim = Math.min(delim, w); }
    netloc = url.slice(2, delim); url = url.slice(delim);
    if (netloc.includes('[') !== netloc.includes(']')) throw new Error('Invalid IPv6 URL');
  }
  const hash = url.indexOf('#');
  if (hash >= 0) { fragment = url.slice(hash + 1); url = url.slice(0, hash); }
  const q = url.indexOf('?');
  if (q >= 0) { query = url.slice(q + 1); url = url.slice(0, q); }
  const at = netloc.lastIndexOf('@');
  const userinfo = at >= 0 ? netloc.slice(0, at) : null;
  const hostport = at >= 0 ? netloc.slice(at + 1) : netloc;
  const host = hostport.startsWith('[') ? hostport.slice(1, hostport.indexOf(']')) : hostport.split(':')[0];
  return { scheme, netloc, path: url, query, fragment,
    username: userinfo === null ? null : userinfo.split(':')[0],
    hostname: host ? host.toLowerCase() : null };
}

export function urlunsplit({ scheme, netloc, path, query, fragment }) {
  let url = path;
  if (netloc || (scheme && USES_NETLOC.has(scheme) && url.slice(0, 2) !== '//')) {
    if (url && url[0] !== '/') url = '/' + url;
    url = '//' + (netloc || '') + url;
  }
  if (scheme) url = scheme + ':' + url;
  if (query) url += '?' + query;
  if (fragment) url += '#' + fragment;
  return url;
}

export function urljoin(base, url) {
  if (!base) return url;
  if (!url) return base;
  const b = urlsplit(base);
  const u = urlsplit(url, b.scheme);
  if (u.scheme !== b.scheme || !USES_RELATIVE.has(u.scheme)) return url;
  let { netloc, path, query } = u;
  if (USES_NETLOC.has(u.scheme)) {
    if (netloc) return urlunsplit({ scheme: u.scheme, netloc, path, query, fragment: u.fragment });
    netloc = b.netloc;
  }
  if (!path) return urlunsplit({ scheme: u.scheme, netloc, path: b.path, query: query || b.query, fragment: u.fragment });
  const baseParts = b.path.split('/');
  if (baseParts.at(-1) !== '') baseParts.pop();
  let segments;
  if (path.startsWith('/')) segments = path.split('/');
  else {
    segments = [...baseParts, ...path.split('/')];
    segments = [segments[0], ...segments.slice(1, -1).filter(Boolean), ...(segments.length > 1 ? [segments.at(-1)] : [])];
  }
  const resolved = [];
  for (const seg of segments) {
    if (seg === '..') resolved.pop();
    else if (seg !== '.') resolved.push(seg);
  }
  if (['.', '..'].includes(segments.at(-1))) resolved.push('');
  return urlunsplit({ scheme: u.scheme, netloc, path: resolved.join('/') || '/', query, fragment: u.fragment });
}

// unquote(): %XX runs decoded as UTF-8, invalid bytes replaced.
export function unquote(text) {
  if (!text.includes('%')) return text;
  const bytes = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const pair = chars[i] === '%' ? (chars[i + 1] ?? '') + (chars[i + 2] ?? '') : '';
    if (/^[0-9A-Fa-f]{2}$/.test(pair)) { bytes.push(parseInt(pair, 16)); i += 2; }
    else bytes.push(...Buffer.from(chars[i], 'utf8'));
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

// parse_qs(query, keep_blank_values): {name: [values]}; '&' separates, '+' is a space.
export function parseQs(query, keepBlank = false) {
  const result = {};
  for (const item of String(query).split('&')) {
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq < 0 && !keepBlank) continue;
    const name = eq < 0 ? item : item.slice(0, eq); const value = eq < 0 ? '' : item.slice(eq + 1);
    if (!value.length && !keepBlank) continue;
    const key = unquote(name.replace(/\+/g, ' '));
    (result[key] ??= []).push(unquote(value.replace(/\+/g, ' ')));
  }
  return result;
}

const ALWAYS_SAFE = /[A-Za-z0-9_.\-~]/;
// quote(text, safe='/') and quote_plus(): UTF-8 bytes outside the safe set as %XX.
export function quote(text, safe = '/', plus = false) {
  let out = '';
  for (const byte of Buffer.from(String(text), 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (byte < 128 && (ALWAYS_SAFE.test(ch) || safe.includes(ch))) out += ch;
    else if (plus && ch === ' ') out += '+';
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
// urlencode(pairs): quote_plus of each name and value.
export const urlencode = pairs => pairs.map(([k, v]) => quote(k, '', true) + '=' + quote(v, '', true)).join('&');
