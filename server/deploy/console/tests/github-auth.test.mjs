// The GitHub sign-in of the Coolify mode (github-auth.mjs, auth.mjs, http.mjs; COOLIFY.md 11) against a fake GitHub
// (a local HTTP server standing in for github.com and api.github.com through config.github.baseUrl / apiUrl): the
// authorization code flow end to end, the session cookie (HttpOnly, Secure, SameSite=Lax, 12 h), the CSRF token on
// every POST, the logout, a login outside the list refused with a page and an audit line, bad or reused or stale states,
// a GitHub that fails, forged and expired cookies, the lockout, the public host as the only Host, cross-site navigations
// allowed for the pages and refused for the API, the session secret persisted (a restart keeps the session) and the
// entry point's log without secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CONSOLE_DIR, FAKE_MODULE, SECRET, clock, freePort, makeEnv, request, sleep, startConsole } from './helpers.mjs';
import { buildScenario } from './scenario.mjs';
import { SESSION_COOKIE, SESSION_MS, STATE_MS, cookieOf } from '../github-auth.mjs';

const CLIENT_ID = 'Iv1.testclientid0001';
const CLIENT_SECRET = 'ghs_testclientsecret_' + 'a'.repeat(20);
const auditLines = env => fs.readFileSync(path.join(env.serverDir, 'console-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

// github.com and api.github.com in one local server: /login/oauth/authorize answers the redirect back with a code for
// fake.login; /login/oauth/access_token checks the app's id and secret and the code; /user answers the login of the token.
async function startFakeGithub() {
  const fake = { login: 'Owner-Login', tokenStatus: 200, userStatus: 200, codes: new Map(), tokens: new Map() };
  const calls = { authorize: [], token: [], user: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
      calls.authorize.push(Object.fromEntries(url.searchParams));
      const code = 'code-' + randomBytes(4).toString('hex');
      fake.codes.set(code, fake.login);
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { Location: back.href });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls.token.push({ headers: req.headers, body });
      if (fake.tokenStatus !== 200) return json(fake.tokenStatus, { error: 'down' });
      if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET || !fake.codes.has(body.code)) return json(200, { error: 'bad_verification_code' });
      const login = fake.codes.get(body.code);
      fake.codes.delete(body.code);
      const token = 'gho_' + randomBytes(12).toString('hex');
      fake.tokens.set(token, login);
      return json(200, { access_token: token, token_type: 'bearer', scope: '' });
    }
    if (req.method === 'GET' && url.pathname === '/user') {
      calls.user.push({ headers: req.headers });
      if (fake.userStatus !== 200) return json(fake.userStatus, { message: 'down' });
      const auth = String(req.headers.authorization ?? '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token || !fake.tokens.has(token)) return json(401, { message: 'Bad credentials' });
      return json(200, { login: fake.tokens.get(token), id: 1, name: 'Owner' });
    }
    return json(404, { message: 'Not Found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { fake, calls, port, origin: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

async function githubEnv(gh, { sessionSecret = null, allowedLogins = ['owner-login'], licenseWrites = 'on' } = {}) {
  const port = await freePort();
  return makeEnv({ tokenModule: FAKE_MODULE, port, licenseWrites,
    github: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowedLogins, publicUrl: `http://localhost:${port}`, sessionSecret, baseUrl: gh.origin, apiUrl: gh.origin } });
}
// The browser's walk: the console's login redirect, the fake GitHub's redirect back, the callback. -> the callback answer.
async function signIn(c, gh) {
  const r = await request(c.port, { path: '/auth/github/login' });
  assert.equal(r.status, 302);
  const authorize = new URL(r.headers.location);
  const ghRes = await request(gh.port, { path: authorize.pathname + authorize.search, headers: { Host: authorize.host } });
  assert.equal(ghRes.status, 302);
  const back = new URL(ghRes.headers.location);
  assert.equal(back.origin, `http://localhost:${c.port}`);
  assert.equal(back.pathname, '/auth/github/callback');
  return request(c.port, { path: back.pathname + back.search, headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } });
}
const cookieHeader = r => { const set = r.headers['set-cookie']?.[0]; assert.ok(set, 'a Set-Cookie'); return set.split(';')[0]; };
const withSession = (cookie, csrf, extra = {}) => ({ Cookie: cookie, ...(csrf ? { 'X-SSAM-Console-CSRF': csrf } : {}), ...extra });

test('GitHub sign-in: the flow, the cookie, the CSRF token on every write, the logout; a login outside the list is refused with a page and an audit line', async t => {
  const gh = await startFakeGithub();
  t.after(() => gh.close());
  const env = await githubEnv(gh);
  const sc = await buildScenario(env, { module: FAKE_MODULE });
  const c = await startConsole(env);
  t.after(() => c.close());
  assert.equal(c.app.auth.mode, 'github');
  assert.equal(c.key, null, 'no access key in the GitHub mode');
  assert.ok(!fs.existsSync(path.join(env.stateDir, 'access.key')));

  await t.test('without a session: the page goes to the sign-in page, the API answers 401 SESSION_REQUIRED', async () => {
    let r = await request(c.port, { path: '/' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/auth/signin');
    r = await request(c.port, { path: '/index.html' });
    assert.equal(r.status, 302);
    r = await request(c.port, { path: '/auth/signin' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
    assert.ok(r.text.includes('href="/auth/github/login"') && r.text.includes('Entrar com GitHub'));
    assert.ok(!/<script|style=/.test(r.text), 'CSP-clean page');
    for (const p of ['/api/meta', '/api/licenses', '/api/overview']) {
      r = await request(c.port, { path: p });
      assert.equal(r.status, 401, p);
      assert.deepEqual(r.body.error, { code: 'SESSION_REQUIRED', message: 'Entre com a conta do GitHub do dono para usar o painel.' });
    }
    // the assets of the page need no session
    assert.equal((await request(c.port, { path: '/app.css' })).status, 200);
    assert.equal((await request(c.port, { path: '/healthz' })).status, 200);
  });

  let cookie = null;
  let csrf = null;
  await t.test('the allowed login enters: GitHub asked as GitHub wants, the token used once for /user, the session cookie set', async () => {
    const r = await signIn(c, gh);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/');
    const set = r.headers['set-cookie'][0];
    assert.match(set, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; Max-Age=${SESSION_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax$`));
    cookie = cookieHeader(r);
    const a = gh.calls.authorize[0];
    assert.equal(a.client_id, CLIENT_ID);
    assert.equal(a.redirect_uri, `http://localhost:${c.port}/auth/github/callback`);
    assert.match(a.state, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(a.allow_signup, 'false');
    assert.equal(a.scope, undefined, 'no scope: the public login is enough');
    const tk = gh.calls.token[0];
    assert.equal(tk.headers.accept, 'application/json');
    assert.match(tk.headers['user-agent'], /^ssam-console\/\d/);
    assert.deepEqual(Object.keys(tk.body).sort(), ['client_id', 'client_secret', 'code', 'redirect_uri']);
    assert.equal(tk.body.redirect_uri, a.redirect_uri);
    assert.equal(gh.calls.user.length, 1, 'the token is used once, for /user');
    const u = gh.calls.user[0].headers;
    assert.equal(u.accept, 'application/vnd.github+json');
    assert.match(u.authorization, /^Bearer gho_/);
    assert.match(u['user-agent'], /^ssam-console\//);
    assert.equal(u['x-github-api-version'], '2022-11-28');
    const meta = await request(c.port, { path: '/api/meta', headers: { Cookie: cookie } });
    assert.equal(meta.status, 200);
    assert.equal(meta.body.auth.mode, 'github');
    assert.equal(meta.body.auth.login, 'Owner-Login');
    assert.match(meta.body.auth.csrf, /^[A-Za-z0-9_-]{32}$/);
    assert.ok(Date.parse(meta.body.auth.expiresAt) > Date.now());
    csrf = meta.body.auth.csrf;
    assert.equal((await request(c.port, { path: '/', headers: { Cookie: cookie } })).status, 200);
    const again = await request(c.port, { path: '/auth/signin', headers: { Cookie: cookie } });
    assert.equal(again.status, 302);
    assert.equal(again.headers.location, '/');
    assert.deepEqual(auditLines(env).map(l => [l.action, l.result, l.code, l.detail.login, l.token]), [['signin', 'ok', null, 'Owner-Login', null]]);
    assert.ok(c.logs.some(l => l.includes('"console":"signin","login":"Owner-Login","ok":true')));
  });

  await t.test('every write needs the CSRF token of the session; with it, issue, renew, lanes, agent-rotate and revoke write and are audited', async () => {
    const post = (p, body, headers) => request(c.port, { method: 'POST', path: p, body, headers: { 'Content-Type': 'application/json', ...headers } });
    const issueBody = { customer: 'Cliente Delta', days: 30, lanes: ['odc'], confirm: 'Cliente Delta' };
    let r = await post('/api/licenses', issueBody, withSession(cookie, null));
    assert.equal(r.status, 403);
    assert.deepEqual(r.body.error, { code: 'CSRF_REQUIRED', message: 'Pedido recusado: falta o token da sessão. Recarregue o painel e repita a ação.' });
    r = await post('/api/licenses', issueBody, withSession(cookie, 'x'.repeat(32)));
    assert.equal(r.status, 403);
    r = await post('/api/licenses', issueBody, { 'X-SSAM-Console-CSRF': csrf });
    assert.equal(r.status, 401, 'the token without the cookie is nothing');
    r = await post('/api/licenses', issueBody, withSession(cookie, csrf));
    assert.equal(r.status, 201);
    assert.match(r.body.secret.token, SECRET);
    const delta = r.body.license;
    r = await post(`/api/licenses/${delta.id}/renew`, { days: 10, confirm: 'Cliente Delta', expectExpiresAt: delta.expiresAt }, withSession(cookie, csrf));
    assert.equal(r.status, 200);
    r = await post(`/api/licenses/${delta.id}/lanes`, { lanes: ['odc', 'o11'], confirm: 'Cliente Delta', expectLanes: ['odc'] }, withSession(cookie, csrf));
    assert.equal(r.status, 200);
    r = await post(`/api/licenses/${delta.id}/agent-rotate`, { confirm: 'Cliente Delta' }, withSession(cookie, csrf));
    assert.equal(r.status, 200);
    r = await post(`/api/licenses/${sc.beta.id}/revoke`, { confirm: 'Cliente Beta' }, withSession(cookie, csrf));
    assert.equal(r.status, 200);
    r = await post('/api/alerts/ack', { id: 'x', hours: 24 }, withSession(cookie, null));
    assert.equal(r.status, 403);
    // the key rotation does not exist here
    r = await post('/api/key/rotate', {}, withSession(cookie, csrf));
    assert.equal(r.status, 404);
    assert.deepEqual(auditLines(env).map(l => [l.action, l.result]),
      [['signin', 'ok'], ['issue', 'ok'], ['renew', 'ok'], ['lanes', 'ok'], ['agent-rotate', 'ok'], ['revoke', 'ok']]);
    const lic = await request(c.port, { path: '/api/licenses', headers: { Cookie: cookie } });
    assert.equal(lic.body.licenses.find(l => l.id === sc.beta.id).state, 'revoked');
  });

  await t.test('nothing of the app secret, the GitHub token or the cookie reaches the log or the state dir; the session secret is kept 0600', async () => {
    const text = c.logs.join('\n');
    assert.ok(!text.includes(CLIENT_SECRET), 'client secret logged');
    assert.ok(!/gho_/.test(text), 'GitHub token logged');
    assert.ok(!text.includes(cookie.split('=')[1]), 'cookie logged');
    assert.ok(!text.includes(csrf), 'csrf logged');
    const secretFile = path.join(env.stateDir, 'session.secret');
    assert.match(fs.readFileSync(secretFile, 'utf8'), /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
    assert.ok(c.logs.some(l => l.includes('"console":"session-secret-created"')));
  });

  await t.test('a login outside the list: a "not allowed" page, no cookie, an audit line, a log line, an event; the list is case-insensitive', async () => {
    gh.fake.login = 'Intruder';
    let r = await signIn(c, gh);
    assert.equal(r.status, 403);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.ok(r.text.includes('não está autorizada neste painel') && r.text.includes('Intruder'));
    assert.equal(r.headers['set-cookie'], undefined);
    const refused = auditLines(env).at(-1);
    assert.deepEqual([refused.action, refused.result, refused.code, refused.detail.login, refused.actor], ['signin-refused', 'error', 'LOGIN_NOT_ALLOWED', 'Intruder', 'painel']);
    assert.ok(c.logs.some(l => l.includes('"console":"signin-refused","login":"Intruder","ok":false,"code":"LOGIN_NOT_ALLOWED"')));
    const events = await request(c.port, { path: '/api/events', headers: { Cookie: cookie } });
    assert.ok(events.body.events.some(e => e.group === 'painel' && e.level === 'warning' && e.text === 'Entrada recusada: a conta Intruder do GitHub não está na lista do dono.'));
    // a markup-looking login is escaped on the page
    gh.fake.login = 'x<b>y';
    r = await signIn(c, gh);
    assert.equal(r.status, 502, 'GitHub answered a login that is not one: refused as a GitHub error');
    gh.fake.login = 'OWNER-login';
    r = await signIn(c, gh);
    assert.equal(r.status, 302);
    assert.ok(r.headers['set-cookie'][0].startsWith(SESSION_COOKIE + '='));
    gh.fake.login = 'Owner-Login';
  });

  await t.test('logout ends the session: the id is refused from then on, the cookie cleared, the audit line written', async () => {
    const post = (p, headers) => request(c.port, { method: 'POST', path: p, body: {}, headers: { 'Content-Type': 'application/json', ...headers } });
    let r = await post('/api/auth/logout', withSession(cookie, null));
    assert.equal(r.status, 403);
    r = await post('/api/auth/logout', withSession(cookie, csrf));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.match(r.headers['set-cookie'][0], new RegExp(`^${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax$`));
    r = await request(c.port, { path: '/api/meta', headers: { Cookie: cookie } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'SESSION_INVALID');
    r = await request(c.port, { path: '/', headers: { Cookie: cookie } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/auth/signin?r=expirou');
    r = await request(c.port, { path: '/auth/signin?r=saiu' });
    assert.ok(r.text.includes('Sessão encerrada'));
    assert.deepEqual(auditLines(env).at(-1).action, 'signout');
    assert.ok(!c.app.auth.lockedFor(), 'an ended session is not a bad attempt');
  });
});

test('states: unknown, reused and stale (10 min) states are refused as bad attempts; a cancelled or failing GitHub gets a page; pending states are capped', async t => {
  const gh = await startFakeGithub();
  t.after(() => gh.close());
  const env = await githubEnv(gh);
  const now = clock();
  const c = await startConsole(env, { now });
  t.after(() => c.close());
  const callback = qs => request(c.port, { path: '/auth/github/callback?' + qs });
  let r = await callback('state=zzz&code=abc');
  assert.equal(r.status, 400);
  assert.ok(r.text.includes('inválido ou expirado'));
  assert.ok(c.logs.some(l => l.includes('"console":"signin-refused","code":"STATE_INVALID"')));
  r = await callback('code=abc');
  assert.equal(r.status, 400);
  // a state is used once
  r = await signIn(c, gh);
  assert.equal(r.status, 302);
  const used = gh.calls.authorize.at(-1).state;
  r = await callback(`state=${used}&code=abc`);
  assert.equal(r.status, 400);
  // a stale one
  r = await request(c.port, { path: '/auth/github/login' });
  const stale = new URL(r.headers.location).searchParams.get('state');
  now.advance(STATE_MS + 1);
  r = await callback(`state=${stale}&code=abc`);
  assert.equal(r.status, 400);
  // the owner cancelled at GitHub
  r = await callback('error=access_denied&error_description=x&state=' + stale);
  assert.equal(r.status, 400);
  assert.ok(r.text.includes('Entrada cancelada'));
  // GitHub down at the token step, then at the user step: a 502 page, no cookie, a log line without secrets
  gh.fake.tokenStatus = 503;
  r = await signIn(c, gh);
  assert.equal(r.status, 502);
  assert.ok(r.text.includes('não respondeu') && r.text.includes('token'));
  gh.fake.tokenStatus = 200;
  gh.fake.userStatus = 500;
  r = await signIn(c, gh);
  assert.equal(r.status, 502);
  assert.ok(r.text.includes('user'));
  gh.fake.userStatus = 200;
  assert.ok(c.logs.some(l => l.includes('"console":"github-error","step":"token","status":503')));
  assert.ok(!c.logs.join('\n').includes(CLIENT_SECRET));
  // pending states: at most 64, the oldest dropped
  for (let i = 0; i < 70; i++) await request(c.port, { path: '/auth/github/login' });
  assert.equal(c.app.auth.pendingStates, 64);
  // ten bad callbacks lock the console (but /healthz) for 60 s
  for (let i = 0; i < 10; i++) await callback('state=bad' + i + '&code=x');
  r = await request(c.port, { path: '/auth/signin' });
  assert.equal(r.status, 429);
  assert.equal((await request(c.port, { path: '/healthz' })).status, 200);
  now.advance(61000);
  assert.equal((await request(c.port, { path: '/auth/signin' })).status, 200);
});

test('the session: forged cookies are bad attempts, it ends after 12 h, the persisted secret keeps it across a restart, CONSOLE_SESSION_SECRET is used when given', async t => {
  const gh = await startFakeGithub();
  t.after(() => gh.close());
  const env = await githubEnv(gh);
  const now = clock();
  let c = await startConsole(env, { now });
  const r = await signIn(c, gh);
  const cookie = cookieHeader(r);
  const value = cookie.slice(cookie.indexOf('=') + 1);
  const [body] = value.split('.');
  const forged = [
    `${SESSION_COOKIE}=${body}.${randomBytes(32).toString('base64url')}`,
    `${SESSION_COOKIE}=${Buffer.from(JSON.stringify({ id: 'x', login: 'owner-login', iat: 0, exp: now() + 1e9, csrf: 'y' })).toString('base64url')}.abc`,
    `${SESSION_COOKIE}=garbage`,
  ];
  for (const f of forged) {
    const bad = await request(c.port, { path: '/api/meta', headers: { Cookie: f } });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'SESSION_INVALID');
  }
  for (let i = 0; i < 7; i++) await request(c.port, { path: '/api/meta', headers: { Cookie: forged[0] } });
  assert.equal((await request(c.port, { path: '/api/meta', headers: { Cookie: cookie } })).status, 429, 'ten forged cookies lock the console');
  now.advance(61000);
  assert.equal((await request(c.port, { path: '/api/meta', headers: { Cookie: cookie } })).status, 200);
  // a restart with the same state dir: the same secret, the session still holds
  await c.close();
  c = await startConsole(env, { now });
  t.after(() => c.close());
  assert.ok(!c.logs.some(l => l.includes('session-secret-created')), 'the secret was kept, not made again');
  assert.equal((await request(c.port, { path: '/api/meta', headers: { Cookie: cookie } })).status, 200);
  // 12 h later the session is over: the API says so, the page goes to the sign-in page with the reason
  now.advance(SESSION_MS + 1);
  let e = await request(c.port, { path: '/api/meta', headers: { Cookie: cookie } });
  assert.equal(e.status, 401);
  assert.deepEqual(e.body.error, { code: 'SESSION_INVALID', message: 'A sessão expirou ou foi encerrada. Entre de novo com o GitHub.' });
  e = await request(c.port, { path: '/', headers: { Cookie: cookie } });
  assert.equal(e.status, 302);
  assert.equal(e.headers.location, '/auth/signin?r=expirou');
  assert.match(e.headers['set-cookie'][0], /Max-Age=0/);
  assert.ok(!c.app.auth.lockedFor(), 'an expired session is not a bad attempt');
  // a secret given in the environment: nothing is written to the state dir
  const env2 = await githubEnv(gh, { sessionSecret: 's'.repeat(40) });
  const c2 = await startConsole(env2, { now });
  t.after(() => c2.close());
  assert.ok(!fs.existsSync(path.join(env2.stateDir, 'session.secret')));
  assert.equal((await signIn(c2, gh)).status, 302);
  assert.equal(cookieOf('a=1; ssam_console_session=v.w; b=2', SESSION_COOKIE), 'v.w');
  assert.equal(cookieOf(undefined, SESSION_COOKIE), null);
});

test('Host and Origin in the GitHub mode: only the public host; a cross-site navigation reaches the pages (GitHub\'s redirect) but never the API', async t => {
  const gh = await startFakeGithub();
  t.after(() => gh.close());
  const env = await githubEnv(gh);
  const c = await startConsole(env);
  t.after(() => c.close());
  const cookie = cookieHeader(await signIn(c, gh));
  for (const host of [`127.0.0.1:${c.port}`, 'localhost', 'localhost:1', 'painel.example.com', `LOCALHOST:${c.port}`]) {
    const r = await request(c.port, { path: '/api/meta', headers: { Host: host, Cookie: cookie } });
    assert.equal(r.status, host === `LOCALHOST:${c.port}` ? 200 : 403, host);
  }
  let r = await request(c.port, { path: '/api/meta', headers: { Origin: 'http://evil.example', Cookie: cookie } });
  assert.equal(r.body.error.code, 'ORIGIN_REFUSED');
  r = await request(c.port, { path: '/api/meta', headers: { Origin: `http://localhost:${c.port}`, Cookie: cookie } });
  assert.equal(r.status, 200);
  r = await request(c.port, { path: '/api/meta', headers: { 'Sec-Fetch-Site': 'cross-site', Cookie: cookie } });
  assert.equal(r.body.error.code, 'FETCH_SITE_REFUSED');
  r = await request(c.port, { method: 'POST', path: '/api/auth/logout', body: {}, headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site', Cookie: cookie } });
  assert.equal(r.body.error.code, 'FETCH_SITE_REFUSED');
  r = await request(c.port, { path: '/auth/signin', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(r.status, 200);
  r = await request(c.port, { path: '/', headers: { 'Sec-Fetch-Site': 'cross-site', Cookie: cookie } });
  assert.equal(r.status, 200, 'the page after GitHub\'s redirect chain');
  // the API answers a session on a GET without the CSRF token; a cross-site form cannot set the token on a POST
  r = await request(c.port, { path: '/api/licenses', headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
});

test('the entry point in the GitHub mode: the auth log line, CONSOLE_LISTEN only with the sign-in, no secret on stdout', async t => {
  const gh = await startFakeGithub();
  t.after(() => gh.close());
  const env = await githubEnv(gh);
  const port = env.config.tcp.port;
  const base = { ...process.env, SSAM_SERVER_DIR: env.serverDir, CONSOLE_STATE_DIR: env.stateDir, CONSOLE_HOST_JSON: env.hostJson, CONSOLE_PUBLIC_DIR: env.publicDir,
    CONSOLE_TOKEN_MODULE: FAKE_MODULE, CONSOLE_DOMAIN: 'ssam.example.com', CONSOLE_LICENSE_WRITES: 'on',
    CONSOLE_GITHUB_CLIENT_ID: CLIENT_ID, CONSOLE_GITHUB_CLIENT_SECRET: CLIENT_SECRET, CONSOLE_GITHUB_ALLOWED_LOGINS: ' Owner-Login , other ',
    CONSOLE_PUBLIC_URL: `http://localhost:${port}`, CONSOLE_GITHUB_BASE_URL: gh.origin, CONSOLE_GITHUB_API_URL: gh.origin };
  const child = spawn(process.execPath, [path.join(CONSOLE_DIR, 'server.mjs')], { env: { ...base, CONSOLE_LISTEN: `127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  for (let i = 0; i < 100 && !out.includes('"console":"auth"'); i++) await sleep(50);
  assert.ok(out.includes(`"console":"listening","socket":"127.0.0.1:${port}"`), out + err);
  assert.ok(out.includes(`"console":"auth","mode":"github","logins":2,"publicUrl":"http://localhost:${port}"`), out);
  const r = await request(port, { path: '/' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/auth/signin');
  assert.ok(!fs.existsSync(path.join(env.stateDir, 'access.key')));
  assert.ok(!out.includes(CLIENT_SECRET) && !err.includes(CLIENT_SECRET));
  child.kill();
  // CONSOLE_LISTEN without the sign-in is a configuration error (exit 2), as is a sign-in without allowed logins
  const { spawnSync } = await import('node:child_process');
  let bad = spawnSync(process.execPath, [path.join(CONSOLE_DIR, 'server.mjs')], { encoding: 'utf8', env: { ...process.env, CONSOLE_STATE_DIR: env.stateDir, CONSOLE_LISTEN: '0.0.0.0:7320' } });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout.trim()).console, 'config-error');
  bad = spawnSync(process.execPath, [path.join(CONSOLE_DIR, 'server.mjs')], { encoding: 'utf8', env: { ...base, CONSOLE_GITHUB_ALLOWED_LOGINS: ' , ' } });
  assert.equal(bad.status, 2);
  assert.match(JSON.parse(bad.stdout.trim()).message, /CONSOLE_GITHUB_ALLOWED_LOGINS/);
});
