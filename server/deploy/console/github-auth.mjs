// The GitHub sign-in of the console (the Coolify mode, COOLIFY.md 11): an OAuth App of the owner, the authorization
// code flow with Node's fetch alone, and only the GitHub accounts of CONSOLE_GITHUB_ALLOWED_LOGINS get in.
//   GET /auth/signin                 the sign-in page (a link; with a session already, straight to /)
//   GET /auth/github/login           a random state (kept here, 10 min, one use) and a redirect to github.com/login/oauth/authorize
//   GET /auth/github/callback        the state checked, the code exchanged for a token (POST /login/oauth/access_token), the
//                                    login read once (GET api.github.com/user) and the token forgotten; an allowed login
//                                    gets the session cookie and /, any other login a "not allowed" page, an audit line
//                                    and a bad attempt (the lockout)
//   POST /api/auth/logout            (apiRoutes: behind the session and the CSRF token) ends the session: its id is
//                                    refused from then on and the cookie is cleared
// The session cookie is base64url({id, login, iat, exp, csrf}) "." HMAC-SHA256 under the session secret
// (CONSOLE_SESSION_SECRET, or one made at the first start and kept in /state/session.secret, 0600, so a restart keeps the
// owner signed in); HttpOnly, Secure, SameSite=Lax, Path=/, 12 h. The CSRF token of the session travels in the header
// X-SSAM-Console-CSRF of every POST (the SPA reads it from /api/meta): a cross-site form cannot set it. The GitHub
// token is used for /user and never stored; nothing of the client secret, the token or the cookie is logged.
// CONSOLE_GITHUB_BASE_URL and CONSOLE_GITHUB_API_URL replace github.com and api.github.com in the tests only.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CONSOLE_VERSION } from './config.mjs';
import { cap } from './texts.mjs';

export const SESSION_COOKIE = 'ssam_console_session';
export const SESSION_SECRET_FILE = 'session.secret';
export const SESSION_MS = 12 * 3600 * 1000;
export const STATE_MS = 10 * 60 * 1000;
export const CSRF_HEADER = 'x-ssam-console-csrf';
const MAX_STATES = 64;
const FETCH_MS = 10000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const b64 = value => Buffer.from(value).toString('base64url');
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const coded = (message, extra) => Object.assign(new Error(message), extra);

// The value of one cookie of a Cookie header, or null.
export function cookieOf(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

// A page of this module (CSP-clean: the console's own stylesheet, no script, no inline style).
export function authPage({ title, text, link = null, login = null }) {
  const action = link ? `<p><a class="btn btn-primary" href="${esc(link.href)}">${esc(link.text)}</a></p>` : '';
  const who = login ? `<p class="fatal-text mono">${esc(login)}</p>` : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex, nofollow">
  <title>Painel SSAM: ${esc(title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <div class="fatal auth-page" role="main">
    <div class="fatal-card">
      <div class="fatal-brand"><p class="fatal-name">Painel SSAM</p></div>
      <p class="fatal-text">${esc(text)}</p>
      ${who}
      ${action}
    </div>
  </div>
</body>
</html>
`;
}

const SIGNIN_TEXT = {
  entrar: 'Entre com a conta do GitHub do dono para abrir o painel.',
  saiu: 'Sessão encerrada. Entre de novo quando quiser.',
  expirou: 'A sessão expirou (12 h) ou foi encerrada. Entre de novo.',
};
const ENTER = { href: '/auth/github/login', text: 'Entrar com GitHub' };

export function createGithubAuth({ github: g, state, history, now = Date.now, log = () => {}, emit = () => {}, lockout, fetch = globalThis.fetch }) {
  const publicUrl = new URL(g.publicUrl);
  const callbackUrl = publicUrl.origin + '/auth/github/callback';
  const allowed = new Set(g.allowedLogins.map(l => l.toLowerCase()));
  const userAgent = 'ssam-console/' + CONSOLE_VERSION;
  const secret = loadSecret();
  const states = new Map();    // state -> issued at (ms)
  const revoked = new Map();   // session id -> its exp (a logout before the cookie's end)

  // CONSOLE_SESSION_SECRET, else /state/session.secret (made once: 32 random bytes in base64url, 0600).
  function loadSecret() {
    if (g.sessionSecret) return Buffer.from(g.sessionSecret, 'utf8');
    const kept = String(state.readText(SESSION_SECRET_FILE) ?? '').trim();
    if (/^[A-Za-z0-9_-]{43,}$/.test(kept)) return Buffer.from(kept, 'utf8');
    const made = randomBytes(32).toString('base64url');
    state.writeText(SESSION_SECRET_FILE, made, 0o600);
    log({ console: 'session-secret-created' });
    return Buffer.from(made, 'utf8');
  }
  const sign = text => createHmac('sha256', secret).update(text).digest();
  function prune() {
    const t = now();
    for (const [k, at] of states) if (t - at > STATE_MS) states.delete(k);
    for (const [k, exp] of revoked) if (exp <= t) revoked.delete(k);
  }

  // ---- the session cookie
  function makeSession(login) {
    const iat = now();
    const payload = { id: randomBytes(16).toString('hex'), login, iat, exp: iat + SESSION_MS, csrf: randomBytes(24).toString('base64url') };
    const body = b64(JSON.stringify(payload));
    return { payload, cookie: body + '.' + b64(sign(body)) };
  }
  // 'missing' | 'invalid' (forged or malformed: a bad attempt) | 'expired' (over, logged out, or a login no longer allowed) | 'ok'
  function parse(req) {
    const raw = cookieOf(req.headers.cookie, SESSION_COOKIE);
    if (!raw) return { word: 'missing' };
    const dot = raw.indexOf('.');
    if (dot <= 0 || raw.length > 2048) return { word: 'invalid' };
    const body = raw.slice(0, dot);
    const mac = Buffer.from(raw.slice(dot + 1), 'base64url');
    const expected = sign(body);
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return { word: 'invalid' };
    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { word: 'invalid' }; }
    if (!payload || typeof payload.id !== 'string' || typeof payload.login !== 'string' || typeof payload.csrf !== 'string' || !Number.isFinite(payload.exp)) return { word: 'invalid' };
    prune();
    if (payload.exp <= now() || revoked.has(payload.id) || !allowed.has(payload.login.toLowerCase())) return { word: 'expired' };
    return { word: 'ok', session: payload };
  }
  const attrs = 'Path=/; HttpOnly; Secure; SameSite=Lax';
  const setCookie = cookie => `${SESSION_COOKIE}=${cookie}; Max-Age=${SESSION_MS / 1000}; ${attrs}`;
  const clearCookie = () => `${SESSION_COOKIE}=; Max-Age=0; ${attrs}`;

  // ---- audit line + event + log line of a sign-in, a refusal, a sign-out (the login is not a customer's name)
  function record(action, login, { result = 'ok', code = null } = {}) {
    const time = new Date(now()).toISOString();
    const who = cap(login, 39);
    history.append({ time, action, actor: 'painel', token: null, customer: null, result, code, detail: { login: who } });
    const text = action === 'signin' ? `Entrada no painel: ${who} (GitHub).`
      : action === 'signout' ? `Saída do painel: ${who}.`
        : `Entrada recusada: a conta ${who} do GitHub não está na lista do dono.`;
    emit({ time, level: result === 'error' ? 'warning' : 'info', group: 'painel', text, code });
    log({ console: action, login: who, ok: result === 'ok', ...(code ? { code } : {}) });
  }

  // ---- GitHub: the code for a token, the token for the login; the token lives in this function only
  async function call(step, url, init) {
    let res;
    try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_MS), redirect: 'error' }); }
    catch (error) { throw coded('github ' + step, { step, code: cap(error?.name ?? 'FETCH', 40) }); }
    if (!res.ok) throw coded('github ' + step, { step, status: res.status });
    try { return await res.json(); } catch { throw coded('github ' + step, { step, code: 'BAD_JSON' }); }
  }
  async function loginOf(code) {
    const token = await call('token', g.baseUrl + '/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify({ client_id: g.clientId, client_secret: g.clientSecret, code, redirect_uri: callbackUrl }),
    });
    if (typeof token?.access_token !== 'string' || !token.access_token) throw coded('github token', { step: 'token', code: cap(token?.error ?? 'NO_TOKEN', 40) });
    const user = await call('user', g.apiUrl + '/user', {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token.access_token, 'User-Agent': userAgent, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (typeof user?.login !== 'string' || !LOGIN.test(user.login)) throw coded('github user', { step: 'user', code: 'NO_LOGIN' });
    return user.login;
  }

  const html = (status, page, headers = {}) => ({ status, headers, html: page });
  const redirect = (location, headers = {}) => ({ status: 302, headers: { Location: location, ...headers }, html: '' });
  const signinPage = reason => authPage({ title: 'entrar', text: SIGNIN_TEXT[reason] ?? SIGNIN_TEXT.entrar, link: ENTER });

  function login() {
    prune();
    while (states.size >= MAX_STATES) states.delete(states.keys().next().value);
    const s = randomBytes(24).toString('base64url');
    states.set(s, now());
    const u = new URL('/login/oauth/authorize', g.baseUrl);
    u.searchParams.set('client_id', g.clientId);
    u.searchParams.set('redirect_uri', callbackUrl);
    u.searchParams.set('state', s);
    u.searchParams.set('allow_signup', 'false');
    return redirect(u.href);
  }
  async function callback({ query }) {
    if (query.get('error')) {
      log({ console: 'signin-cancelled', code: cap(query.get('error'), 40) });
      return html(400, authPage({ title: 'entrada cancelada', text: 'Entrada cancelada no GitHub. Nada mudou.', link: ENTER }));
    }
    const s = query.get('state');
    const code = query.get('code');
    prune();
    if (!s || !code || !states.has(s)) {
      lockout.noteBad();
      log({ console: 'signin-refused', code: 'STATE_INVALID' });
      return html(400, authPage({ title: 'pedido inválido', text: 'Pedido de entrada inválido ou expirado (10 min). Comece de novo.', link: ENTER }));
    }
    states.delete(s);   // one use
    let who;
    try { who = await loginOf(code); } catch (error) {
      log({ console: 'github-error', step: error.step ?? '?', ...(error.status ? { status: error.status } : {}), ...(error.code ? { code: error.code } : {}) });
      return html(502, authPage({ title: 'GitHub indisponível', text: `O GitHub não respondeu como esperado (${error.step ?? '?'}). Tente de novo em instantes.`, link: ENTER }));
    }
    if (!allowed.has(who.toLowerCase())) {
      lockout.noteBad();
      record('signin-refused', who, { result: 'error', code: 'LOGIN_NOT_ALLOWED' });
      return html(403, authPage({ title: 'conta não autorizada', text: 'Esta conta do GitHub não está autorizada neste painel. Só a conta do dono entra.', login: who, link: { href: '/auth/github/login', text: 'Entrar com outra conta' } }));
    }
    const { cookie } = makeSession(who);
    record('signin', who);
    return redirect('/', { 'Set-Cookie': setCookie(cookie) });
  }
  function logout({ session }) {
    prune();
    revoked.set(session.id, session.exp);
    record('signout', session.login);
    return { status: 200, headers: { 'Set-Cookie': clearCookie() }, body: { ok: true } };
  }

  return {
    mode: 'github',
    hostAllowed: host => typeof host === 'string' && host.trim().toLowerCase() === publicUrl.host.toLowerCase(),
    originAllowed: origin => origin === publicUrl.origin,
    check(req) {
      const { word, session } = parse(req);
      if (word === 'ok') return { ok: true, session };
      if (word === 'missing') return { ok: false, code: 'SESSION_REQUIRED', bad: false };
      return { ok: false, code: 'SESSION_INVALID', bad: word === 'invalid' };
    },
    csrfOk: (req, session) => {
      const presented = req.headers[CSRF_HEADER];
      if (typeof presented !== 'string' || !session?.csrf || presented.length !== session.csrf.length) return false;
      return timingSafeEqual(Buffer.from(presented), Buffer.from(session.csrf));
    },
    // the console's page needs a session; without one the sign-in page (an expired session says so)
    page(req, rawPath) {
      if (rawPath !== '/' && rawPath !== '/index.html') return null;
      const { word } = parse(req);
      if (word === 'ok') return null;
      if (word === 'invalid') lockout.noteBad();
      return redirect(word === 'missing' ? '/auth/signin' : '/auth/signin?r=expirou', word === 'missing' ? {} : { 'Set-Cookie': clearCookie() });
    },
    routes: {
      'GET /auth/signin': ({ query, req }) => (parse(req).word === 'ok' ? redirect('/') : html(200, signinPage(query.get('r')))),
      'GET /auth/github/login': login,
      'GET /auth/github/callback': callback,
    },
    apiRoutes: { 'POST /api/auth/logout': logout },
    describe: session => ({ mode: 'github', login: session?.login ?? null, csrf: session?.csrf ?? null, expiresAt: session ? new Date(session.exp).toISOString() : null }),
    rotate: () => null,
    noteBad: lockout.noteBad, lockedFor: lockout.lockedFor,
    // for the tests: the number of pending states
    get pendingStates() { prune(); return states.size; },
  };
}
