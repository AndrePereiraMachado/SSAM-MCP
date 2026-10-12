// HTTP pipeline of the console (DESIGN 2.2, 4): every request passes, in this order, the Host check (DNS rebinding),
// the Origin and Sec-Fetch-Site checks, /healthz, the key lockout (429 for everything but /healthz), the method check
// (GET and POST only: OPTIONS and anything else get 405 with no CORS header, before any key is asked), static files
// (no key, no data), the access key on /api/*, then the route.
// POST bodies must be application/json, at most 8 KiB, a JSON object; unknown fields are refused by the route.
// Mutations go through the gate: at most 10 per rolling 60 s, run one at a time.
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, ERRORS } from './texts.mjs';

export const MAX_BODY = 8 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
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

// "localhost:7320" -> "localhost"; "[::1]:7320" -> "[::1]"; null when malformed.
export function hostnameOf(host) {
  if (typeof host !== 'string' || !host || host.length > 300) return null;
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]/@\s]+)(?::(\d{1,5}))?$/.exec(host.trim());
  return m ? m[1].toLowerCase() : null;
}

export function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...extra });
  res.end(text);
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
  const locked = () => auth.lockedFor();

  async function handle(req, res) {
    const rawUrl = String(req.url ?? '/');
    const q = rawUrl.indexOf('?');
    const rawPath = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
    const query = new URLSearchParams(q >= 0 ? rawUrl.slice(q + 1) : '');
    // 1. Host
    const hostHeader = req.headers.host;
    if (!LOCAL_HOSTS.has(hostnameOf(hostHeader))) return sendError(res, new ApiError('HOST_REFUSED'));
    // 2. Origin and Sec-Fetch-Site
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'http://' + hostHeader) return sendError(res, new ApiError('ORIGIN_REFUSED'));
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return sendError(res, new ApiError('FETCH_SITE_REFUSED'));
    // 3. /healthz (no key, no data, never locked)
    if (rawPath === '/healthz') {
      if (req.method !== 'GET') return sendError(res, new ApiError('METHOD_NOT_ALLOWED'), { Allow: 'GET' });
      return sendJson(res, 200, { ok: true });
    }
    // lockout after 10 wrong keys: every other request answers 429
    const wait = locked();
    if (wait) return sendError(res, new ApiError('RATE_LIMITED', { n: wait }, { retryAfter: wait }));
    // methods: GET and POST only (a preflight OPTIONS gets 405 and no CORS header)
    if (req.method !== 'GET' && req.method !== 'POST') return sendError(res, new ApiError('METHOD_NOT_ALLOWED'), { Allow: 'GET, POST' });
    const isApi = rawPath === '/api' || rawPath.startsWith('/api/');
    if (!isApi) {
      if (req.method === 'GET' && serveStatic(res, publicDir, rawPath)) return undefined;
      return sendError(res, new ApiError(req.method === 'GET' ? 'NOT_FOUND' : 'METHOD_NOT_ALLOWED'));
    }
    // 4. key
    const verdict = auth.check(req.headers['x-ssam-console-key']);
    if (verdict === 'missing') return sendError(res, new ApiError('KEY_REQUIRED'));
    if (verdict !== 'ok') {
      auth.noteBad();   // the 10th wrong key still gets 401; the lockout answers the requests after it
      return sendError(res, new ApiError('KEY_INVALID'));
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
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') { req.resume(); return sendError(res, new ApiError('CONTENT_TYPE')); }
        let raw;
        try { raw = await readBody(req); } catch (error) { return sendError(res, error, { Connection: 'close' }); }
        try { body = JSON.parse(raw.toString('utf8') || 'null'); } catch { return sendError(res, new ApiError('BAD_JSON')); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, new ApiError('BAD_JSON'));
      }
      const out = await r.handler({ params, query, body, req });
      return sendJson(res, out?.status ?? 200, out?.body ?? { ok: true });
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
