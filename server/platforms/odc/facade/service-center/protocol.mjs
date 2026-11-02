// What Service Center answered when it was not what the call expected (SC_PROTOCOL_INVALID), kept with the refusal and in the
// friction queue: protocol {operation, expected, got, sample, form}. Until 25/10/2026 the queue held only the code, and the 34
// SC_PROTOCOL_INVALID of 14..24/10 could not be explained from it (meta de 20/10, item 21); the answers preserved in the
// sessions showed that every one of them was a local argument refusal (now SC_ARGUMENT_INVALID, errors.mjs).
// sample: the first 300 characters of the answer, without credentials. ONE rule masks before the cut (review W2-DIAG,
// correction 2: quoted values, unquoted attributes, a key "pass", cookie headers, OSToken in a query and textarea bodies went
// through): scripts, styles and textarea bodies; cookie and set-cookie header lines after their name; every value attribute
// (value, content, data-*), quoted or not; the value of ANY key whose name contains a secret word (SECRET_NAME, no word
// boundary: OSToken, apiKey, ASPXAUTH...), quoted or not, as JSON, query, form, header or connection-string text; the cell
// after a table label of that name; private key blocks; bearer/basic values, JWTs, long base64 or hex runs and e-mail addresses.
import { ProtocolError, continuation } from './errors.mjs';

export const SAMPLE_LIMIT = 300;
// The login page Service Center answers in place of the asked one (http.mjs LOGIN_PAGE), its SSO and an OutSystems ID page.
const LOGIN = /<form\b[^>]*\baction="(?:[^"]*\/)?_?login(?:sso)?\.aspx|class="[^"]*\bsc-layout-login\b|id\.outsystems\.com|\bLog in with SSO\b/i;
const ERROR_PAGE = /<title>[^<]*(?:error|exception|unavailable|not found)[^<]*<\/title>|Server Error in '|An error occurred|Runtime Error|Service Unavailable/i;

// A key whose name contains one of these words holds a secret, whatever surrounds it (no word boundary).
export const SECRET_NAME = 'pass|pwd|secret|token|session|cookie|auth|key|code|ticket|assertion|state|saml|credential|csrf|xsrf|nonce|signature';
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const MASKS = [
  [/<script\b[\s\S]*?(?:<\/script>|$)/gi, '<script/>'],
  [/<style\b[\s\S]*?(?:<\/style>|$)/gi, '<style/>'],
  [/(<textarea\b[^>]*>)[\s\S]*?(?:<\/textarea>|$)/gi, '$1…</textarea>'],
  [/-----BEGIN [^-\r\n]*-----[\s\S]*?(?:-----END[^\r\n]*|$)/g, '…'],
  // An authorization scheme's credential, before the key rule below reads its scheme word as the value.
  [/\b(Bearer|Basic|Negotiate|NTLM)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 …'],
  // A cookie header carries nothing but secrets: the whole line after its name.
  [/\b(Set-Cookie|Cookie)(\s*:\s*)[^\r\n]*/gi, '$1$2…'],
  // Every value attribute, quoted or not.
  [new RegExp(String.raw`\b(value|content|data-[\w-]+)(\s*=\s*)(?:${QUOTED}|[^\s>]+)`, 'gi'), '$1$2"…"'],
  // A JSON key of a secret name: its value, quoted or not.
  [new RegExp(String.raw`("[^"\r\n]{0,80}(?:${SECRET_NAME})[^"\r\n]{0,80}"\s*:\s*)(?:${QUOTED}|[^,}\]\s]+)`, 'gi'), '$1"…"'],
  // A key of a secret name in a query, a form, a header or a connection string: its value, quoted or not.
  [new RegExp(String.raw`([A-Za-z0-9_.$-]{0,80}(?:${SECRET_NAME})[A-Za-z0-9_.$-]{0,80})(\s*[=:]\s*)(?!(?:Bearer|Basic|Negotiate|NTLM) )(?:${QUOTED}|[^;&\s,"'<>]+)`, 'gi'), '$1$2…'],
  // A table label of a secret name: the cell after it.
  [new RegExp(String.raw`(<t[dh]\b[^>]*>[^<]{0,80}(?:${SECRET_NAME})[^<]{0,80}<\/t[dh]>\s*<t[dh]\b[^>]*>)[^<]*`, 'gi'), '$1…'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '…'],
  [/[A-Za-z0-9+/_=-]{40,}/g, '…'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '…'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<e-mail>'],
];
export function protocolSample(body, limit = SAMPLE_LIMIT) {
  if (body === null || body === undefined) return null;
  let text = Buffer.isBuffer(body) ? body.subarray(0, 65536).toString('utf8') : String(body).slice(0, 65536);
  for (const [pattern, mask] of MASKS) text = text.replace(pattern, mask);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

// login: the login page (or an SSO/identity page) in place of the answer; redirect: a redirect the transport does not follow;
// error-page: an HTTP error or an error page; json: JSON where a page or a file was expected; unexpected: anything else.
export function protocolForm({ status = null, contentType = '', body = null, location = null } = {}) {
  const text = body === null || body === undefined ? '' : Buffer.isBuffer(body) ? body.subarray(0, 65536).toString('utf8') : String(body);
  if (status === 401 || LOGIN.test(text) || /\/_?login(?:sso)?\.aspx|id\.outsystems\.com/i.test(location ?? '')) return 'login';
  if (location) return 'redirect';
  if ((Number.isInteger(status) && status >= 400) || (/html/i.test(contentType) && ERROR_PAGE.test(text))) return 'error-page';
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) return 'json';
  return 'unexpected';
}

// A Service Center answer the transport refuses: the HTTP exchange, what it expected, what came, and the sample.
export class ProtocolMismatch extends ProtocolError {
  constructor(message, { method = 'GET', path = null, expected, status = null, contentType = '', body = null, location = null } = {}) {
    super(message);
    this.name = 'ProtocolMismatch';
    const form = protocolForm({ status, contentType, body, location });
    const got = [Number.isInteger(status) ? 'HTTP ' + status : null, contentType ? String(contentType).split(';')[0].trim() : null,
      location ? 'redirect to ' + locationOf(location) : null, form].filter(Boolean).join(', ');
    this.protocol = { operation: method + ' ' + (path ?? '?'), expected, got, sample: protocolSample(body), form };
  }
}

// HTTP 404: the page, or the target its query names (a numeric ID, a key), does not exist on this host. Not a protocol the
// transport does not know (SC_PROTOCOL_INVALID): its own code, so the answer says what is missing instead of asking to repeat
// a read that answers the same. The message keeps the transport's sentence ("Service Center returned HTTP 404").
export class PageNotFound extends ProtocolMismatch {
  constructor(message, context = {}) { super(message, context); this.name = 'PageNotFound'; this.code = 'SC_PAGE_NOT_FOUND'; }
}

// Where a redirect points, without its query (an SSO redirect carries state and codes there).
function locationOf(location) {
  try { const url = new URL(location, 'https://service-center.invalid/'); return url.host === 'service-center.invalid' ? url.pathname : url.host + url.pathname; }
  catch { return String(location).split('?')[0].slice(0, 120); }
}

// The next call for each form: login -> sign in again (o11_service_center_session), redirect -> the session status (which
// login, which transport), error-page and json -> the same read once more (a write is never repeated: verify its receipt).
export function protocolContinuation(protocol, { host = null, retry = null, write = false, operationId = null } = {}) {
  const at = host ? { host } : {};
  const signIn = continuation('o11_service_center_session', { action: 'sign-in', ...at }, 'Service Center answered with its login page: the session is not signed in or expired; sign in, then repeat the call');
  const status = continuation('o11_service_center_session', { action: 'status', ...at }, 'Service Center redirected where the transport does not follow: the status says which login and transport the host uses');
  const verify = operationId ? continuation('o11_service_center_write', { action: 'verify', ...at, operationId }, 'a write is never repeated: verify reads the target and resolves the receipt') : null;
  const again = write ? verify : retry ? { ...retry, why: 'Service Center answered with an error or an unexpected shape once; a read may be repeated once, then report it with this protocol detail' } : null;
  switch (protocol?.form) {
    case 'login': return { continuation: signIn, alternatives: [again].filter(Boolean) };
    case 'redirect': return { continuation: status, alternatives: [signIn] };
    case 'error-page': case 'json': return again ? { continuation: again, alternatives: [status] } : { continuation: status, alternatives: [] };
    default: return again ? { continuation: again, alternatives: [status] } : { continuation: status, alternatives: [] };
  }
}

// The protocol detail of any other SC_PROTOCOL_INVALID (a page or reply the parser does not know): the operation and the refusal.
export function genericProtocol(action, error) {
  return { operation: action ?? null, expected: 'a Service Center answer this operation knows', got: String(error?.message ?? '').slice(0, SAMPLE_LIMIT), sample: null, form: 'unexpected' };
}
