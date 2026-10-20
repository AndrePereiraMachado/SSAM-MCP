// HTTP pipeline of the console (DESIGN 2.2, 4): every request passes, in this order, the Host check (DNS rebinding;
// auth.hostAllowed: the loopback in the key mode, the public host in the GitHub mode), the Origin check
// (auth.originAllowed) and the Sec-Fetch-Site check (on /api/* and on every POST; a page is reached by a top-level
// navigation, from GitHub's redirect among others), /healthz, the lockout (429 for everything but /healthz), the method
// check (GET and POST only: OPTIONS and anything else get 405 with no CORS header, before any credential is asked), the
// auth pages (auth.page: the console's page without a session goes to the sign-in page; auth.routes: /auth/*), static
// files (no credential, no data), then on /api/*: the credential (auth.check: the key header or the session cookie),
// the CSRF token on POST (auth.csrfOk), then the route.
// POST bodies must be application/json, at most 8 KiB, a JSON object; unknown fields are refused by the route.
// Mutations go through the gate: at most 10 per rolling 60 s, run one at a time.
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, ERRORS } from './texts.mjs';
export { hostnameOf } from './auth.mjs';

export const MAX_BODY = 8 * 1024;
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': CSP,
};

// Mutation gate (2.2 step 8): rolling 60 s window of 10, then one at a time through a promise chain.
export function createGate({ now = Date.now, max = 10, windowMs = 60000 } = {}) {
  let times = [];
  let chain = Promise.resolve();
  function admit() {
    const t = now();
    times = times.filter(x => x > t - windowMs);
    if (times.length >= max) {
      const n = Math.max(1, Math.ceil((times[0] + windowMs - t) / 1000));
      throw new ApiError('RATE_LIMITED', { n }, { retryAfter: n });
    }
    times.push(t);
  }
  function run(fn) {
    admit();
    const result = chain.then(() => fn());
    chain = result.catch(() => {});
    return result;
  }
  return { run, admit };
}

export function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(text);
}
// A download (DESIGN-QUALIDADE 4.4): {type, name, text} from a route, with the same security headers as every answer.
// The file name keeps only letters, digits, dot, dash and underscore.
const FILE_TYPES = new Set(['text/csv; charset=utf-8', 'application/json; charset=utf-8', 'application/x-ndjson; charset=utf-8']);
export function sendFile(res, status, file) {
  const type = FILE_TYPES.has(file?.type) ? file.type : 'application/octet-stream';
  const name = String(file?.name ?? 'arquivo').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'arquivo';
  const body = Buffer.from(String(file?.text ?? ''), 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': body.length });
  res.end(body);
}
// A page of the auth (sign-in, refusals) or a redirect: {status, headers, html}; {status, headers, body} is JSON.
export function sendPage(res, page) {
  if (page.body !== undefined) return sendJson(res, page.status ?? 200, page.body, page.headers ?? {});
  const body = Buffer.from(String(page.html ?? ''), 'utf8');
  res.writeHead(page.status ?? 200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, ...(page.headers ?? {}) });
  res.end(body);
  return undefined;
}
export function sendError(res, error, extra = {}) {
  const api = error instanceof ApiError ? error : new ApiError('INTERNAL', { código: 'ERRO' });
  const body = { ok: false, error: { code: api.apiCode, message: api.message, ...(api.apiCode === 'INVALID_FIELD' && api.field ? { field: api.field } : {}) } };
  const headers = { ...extra };
  if (api.retryAfter) headers['Retry-After'] = String(api.retryAfter);
  sendJson(res, api.status, body, headers);
}

// Reads at most MAX_BODY bytes; stops at the limit.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) { reject(new ApiError('BODY_TOO_LARGE')); return; }
    const parts = [];
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) { done = true; parts.length = 0; reject(new ApiError('BODY_TOO_LARGE')); return; }
      parts.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts)); } });
    req.on('error', () => { if (!done) { done = true; reject(new ApiError('BAD_JSON')); } });
  });
}

// Static files of CONSOLE_PUBLIC_DIR (2.2 step 3): whitelist of extensions, confined to the folder, /mock never served.
function staticTarget(publicDir, rawPath) {
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const parts = decoded.split(/[\\/]+/).filter(Boolean);
  if (parts.some(p => p === '.' || p === '..' || p.includes(':'))) return null;
  if (!parts.length) parts.push('index.html');
  if (parts[0].toLowerCase() === 'mock') return null;
  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  if (!Object.hasOwn(STATIC_TYPES, ext)) return null;
  const root = path.resolve(publicDir);
  const full = path.resolve(root, ...parts);
  if (!full.startsWith(root + path.sep)) return null;
  return { full, type: STATIC_TYPES[ext] };
}
function serveStatic(res, publicDir, rawPath) {
  const target = staticTarget(publicDir, rawPath);
  if (!target) return false;
  let body;
  try {
    const st = fs.statSync(target.full);
    if (!st.isFile()) return false;
    body = fs.readFileSync(target.full);
  } catch { return false; }
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': target.type, 'Content-Length': body.length });
  res.end(body);
  return true;
}

// routes: { 'GET /api/meta': handler, 'POST /api/licenses/:id/renew': handler, ... }; handler(ctx) -> {status?, body}.
function compile(routes) {
  return Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (m, n) => { names.push(n); return '([^/]+)'; }) + '$');
    return { method, re, names, handler };
  });
}

export function createHttp({ auth, routes, publicDir, log = () => {}, now = Date.now }) {
  const table = compile(routes);
  const pages = compile(auth.routes ?? {});
  const locked = () => auth.lockedFor();

  async function handle(req, res) {
    const rawUrl = String(req.url ?? '/');
    const q = rawUrl.indexOf('?');
    const rawPath = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
    const query = new URLSearchParams(q >= 0 ? rawUrl.slice(q + 1) : '');
    const isApi = rawPath === '/api' || rawPath.startsWith('/api/');
    // 1. Host
    const hostHeader = req.headers.host;
    if (!auth.hostAllowed(hostHeader)) return sendError(res, new ApiError('HOST_REFUSED'));
    // 2. Origin and Sec-Fetch-Site (a page may be reached by a top-level navigation from anywhere, GitHub included)
    const origin = req.headers.origin;
    if (origin !== undefined && !auth.originAllowed(origin, hostHeader)) return sendError(res, new ApiError('ORIGIN_REFUSED'));
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && (isApi || req.method !== 'GET')) return sendError(res, new ApiError('FETCH_SITE_REFUSED'));
    // 3. /healthz (no credential, no data, never locked)
    if (rawPath === '/healthz') {
      if (req.method !== 'GET') return sendError(res, new ApiError('METHOD_NOT_ALLOWED'), { Allow: 'GET' });
      return sendJson(res, 200, { ok: true });
    }
    // lockout after 10 bad attempts: every other request answers 429
    const wait = locked();
    if (wait) return sendError(res, new ApiError('RATE_LIMITED', { n: wait }, { retryAfter: wait }));
    // methods: GET and POST only (a preflight OPTIONS gets 405 and no CORS header)
    if (req.method !== 'GET' && req.method !== 'POST') return sendError(res, new ApiError('METHOD_NOT_ALLOWED'), { Allow: 'GET, POST' });
    if (!isApi) {
      if (req.method === 'GET') {
        const page = auth.page(req, rawPath);
        if (page) return sendPage(res, page);
        for (const r of pages) {
          const m = r.re.exec(rawPath);
          if (!m || r.method !== 'GET') continue;
          return sendPage(res, await r.handler({ params: Object.fromEntries(r.names.map((n, i) => [n, m[i + 1]])), query, body: null, req }));
        }
        if (serveStatic(res, publicDir, rawPath)) return undefined;
      }
      return sendError(res, new ApiError(req.method === 'GET' ? 'NOT_FOUND' : 'METHOD_NOT_ALLOWED'));
    }
    // 4. the credential: the key header, or the session cookie
    const verdict = auth.check(req);
    if (!verdict.ok) {
      if (verdict.bad) auth.noteBad();   // the 10th bad one still gets 401; the lockout answers the requests after it
      return sendError(res, new ApiError(verdict.code));
    }
    // route
    let pathMatched = false;
    for (const r of table) {
      const m = r.re.exec(rawPath);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, m[i + 1]]));
      let body = null;
      if (req.method === 'POST') {
        // 5. the CSRF token of the session (the key mode's is the key header itself)
        if (!auth.csrfOk(req, verdict.session)) { req.resume(); return sendError(res, new ApiError('CSRF_REQUIRED')); }
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') { req.resume(); return sendError(res, new ApiError('CONTENT_TYPE')); }
        let raw;
        try { raw = await readBody(req); } catch (error) { return sendError(res, error, { Connection: 'close' }); }
        try { body = JSON.parse(raw.toString('utf8') || 'null'); } catch { return sendError(res, new ApiError('BAD_JSON')); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, new ApiError('BAD_JSON'));
      }
      const out = await r.handler({ params, query, body, req, session: verdict.session });
      if (out?.file) return sendFile(res, out.status ?? 200, out.file);
      if (out?.html !== undefined) return sendPage(res, out);
      return sendJson(res, out?.status ?? 200, out?.body ?? { ok: true }, out?.headers ?? {});
    }
    return sendError(res, new ApiError(pathMatched ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND'));
  }

  return function listener(req, res) {
    handle(req, res).catch(error => {
      if (!(error instanceof ApiError)) log({ console: 'request-error', code: String(error?.code ?? error?.name ?? 'ERRO').slice(0, 40) });
      if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
      sendError(res, error instanceof ApiError ? error : new ApiError('INTERNAL', { código: String(error?.code ?? error?.name ?? 'ERRO').slice(0, 40) }));
    });
  };
}

// Field checks shared by the routes (2.2 step 6: unknown fields are refused).
export function onlyFields(body, allowed) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new ApiError('INVALID_FIELD', { campo: key.slice(0, 40), regra: 'campo desconhecido' }, { field: key.slice(0, 40) });
}
export const KNOWN_ERRORS = Object.keys(ERRORS);
