// Who may use the console, in one of two modes chosen by the configuration (app.mjs createAuth):
//   - the access key (DESIGN 2.2 step 4, 2.3; the SSH tunnel of DEPLOY.md 15): 32 random bytes in base64url, made at
//     every start and at every POST /api/key/rotate, written to /state/access.key (0600) for painel-ssam.ps1. A presented
//     key (header X-SSAM-Console-Key) is compared in constant time over SHA-256 digests;
//   - the GitHub sign-in (github-auth.mjs; the Coolify mode, COOLIFY.md 11): a session cookie for the owner's GitHub
//     account, with CONSOLE_GITHUB_CLIENT_ID set.
// Both share the lockout: ten bad attempts within 60 s (wrong keys; forged cookies, bad OAuth states and refused logins)
// lock every request except /healthz for 60 s. Both answer the same surface to http.mjs: mode, hostAllowed(host),
// originAllowed(origin, host), check(req) -> { ok, session } | { ok: false, code, bad }, csrfOk(req, session) for the
// POSTs, page(req, path) for a page that needs a session, routes (pages outside /api), apiRoutes (under /api, behind
// check and the CSRF token), describe(session) for /api/meta, rotate(), noteBad(), lockedFor().
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createGithubAuth } from './github-auth.mjs';

const sha256 = text => createHash('sha256').update(String(text), 'utf8').digest();
export const KEY_FILE = 'access.key';
const WINDOW_MS = 60000;
const MAX_BAD = 10;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// "localhost:7320" -> "localhost"; "[::1]:7320" -> "[::1]"; null when malformed.
export function hostnameOf(host) {
  if (typeof host !== 'string' || !host || host.length > 300) return null;
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]/@\s]+)(?::(\d{1,5}))?$/.exec(host.trim());
  return m ? m[1].toLowerCase() : null;
}

// Ten bad attempts within WINDOW_MS lock the console for WINDOW_MS.
export function createLockout({ now = Date.now } = {}) {
  let bad = [];
  let lockedUntil = 0;
  function noteBad() {
    const t = now();
    bad = bad.filter(at => at > t - WINDOW_MS);
    bad.push(t);
    if (bad.length >= MAX_BAD) { lockedUntil = t + WINDOW_MS; bad = []; }
  }
  // Seconds left in the lockout, 0 when open.
  const lockedFor = () => { const left = lockedUntil - now(); return left > 0 ? Math.ceil(left / 1000) : 0; };
  return { noteBad, lockedFor };
}

export function createKeyAuth({ state, now = Date.now }) {
  let digest = null;
  const lockout = createLockout({ now });

  function rotate() {
    const key = randomBytes(32).toString('base64url');
    state.writeText(KEY_FILE, key, 0o600);
    digest = sha256(key);
    return key;
  }
  function check(req) {
    const presented = req.headers['x-ssam-console-key'];
    if (typeof presented !== 'string' || presented === '') return { ok: false, code: 'KEY_REQUIRED', bad: false };
    if (!digest || !timingSafeEqual(sha256(presented), digest)) return { ok: false, code: 'KEY_INVALID', bad: true };
    return { ok: true, session: null };
  }
  return {
    mode: 'key',
    // the tunnel ends on the loopback: only a local Host, and an Origin of exactly http:// + Host
    hostAllowed: host => LOCAL_HOSTS.has(hostnameOf(host)),
    originAllowed: (origin, host) => origin === 'http://' + host,
    check,
    // the key travels in a header no cross-site form can set: that is the CSRF token of this mode
    csrfOk: () => true,
    page: () => null,
    routes: {},
    apiRoutes: {},
    describe: () => ({ mode: 'key', login: null, csrf: null, expiresAt: null }),
    rotate, noteBad: lockout.noteBad, lockedFor: lockout.lockedFor,
  };
}

// The auth of this configuration: the GitHub sign-in with config.github, else the access key.
export function createAuth({ config = {}, state, history, now = Date.now, log = () => {}, emit = () => {}, fetch } = {}) {
  if (config.github) return createGithubAuth({ github: config.github, state, history, now, log, emit, lockout: createLockout({ now }), ...(fetch ? { fetch } : {}) });
  return createKeyAuth({ state, now });
}
