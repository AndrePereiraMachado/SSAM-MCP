// Environment contract of the console (DESIGN 1.2): SSAM_SERVER_DIR, CONSOLE_SOCKET (or --tcp 127.0.0.1:<port> for tests
// and local runs, loopback only), CONSOLE_STATE_DIR, CONSOLE_HOST_JSON, CONSOLE_PUBLIC_DIR, CONSOLE_TOKEN_MODULE,
// CONSOLE_DOMAIN (public URL before a `listening` event is seen), CONSOLE_TZ (America/Sao_Paulo) and
// CONSOLE_LICENSE_WRITES (auto | on | off, licenses.mjs: auto writes licenses only with a token module that locks
// tokens.json between writers, the 24th image's; DEPLOY.md 15.4) and CONSOLE_KERNEL_CATALOG (the kernel's verify catalogs
// that name the native ids a quality line may keep; DESIGN-QUALIDADE 2.5, 4.1: the image's own /app/kernel/catalog) and
// CONSOLE_TOOLS_CATALOG (the hosted tool catalog whose names the console may show, tool-names.mjs: the image's own
// /app/platforms/odc/facade/hosted/tools.json by default).
// The Coolify mode (COOLIFY.md 11): SSAM_DATABASE_URL (the tokens in Postgres, passed to the token module's
// openTokenStore; without it tokens.json), the GitHub sign-in (CONSOLE_GITHUB_CLIENT_ID, CONSOLE_GITHUB_CLIENT_SECRET,
// CONSOLE_GITHUB_ALLOWED_LOGINS, CONSOLE_PUBLIC_URL, CONSOLE_SESSION_SECRET; github-auth.mjs) and CONSOLE_LISTEN
// (host:port inside the compose network, any address: allowed only with the GitHub sign-in, since the console then
// answers to whoever reaches that port). CONSOLE_GITHUB_BASE_URL and CONSOLE_GITHUB_API_URL exist for the tests' fake
// GitHub only.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONSOLE_VERSION = '1.0.0';
export const DEFAULT_KERNEL_CATALOG = '/app/kernel/catalog';
const LOOPBACK = new Map([['127.0.0.1', '127.0.0.1'], ['::1', '::1'], ['localhost', '127.0.0.1']]);

// "127.0.0.1:7399", "[::1]:7399" or "localhost:7399"; any other host is refused (the console never listens outside loopback).
export function parseTcp(value) {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(String(value ?? '').trim());
  if (!m) throw new Error('--tcp: use 127.0.0.1:<port>');
  const host = (m[1] ?? m[2]).toLowerCase();
  const port = Number(m[3]);
  if (!LOOPBACK.has(host)) throw new Error('--tcp: only a loopback address (127.0.0.1, [::1] or localhost) is accepted');
  if (port > 65535) throw new Error('--tcp: port out of range');
  return { host: LOOPBACK.get(host), port };
}

export const LICENSE_WRITES = ['auto', 'on', 'off'];
export function parseLicenseWrites(value) {
  const v = String(value ?? '').trim().toLowerCase() || 'auto';
  if (!LICENSE_WRITES.includes(v)) throw new Error('CONSOLE_LICENSE_WRITES: use auto, on or off');
  return v;
}

// "0.0.0.0:7320" or "[::]:7320": where the console listens inside a compose network (CONSOLE_LISTEN).
export function parseListen(value) {
  const m = /^(?:\[([^\]]+)\]|([^:[\]\s]+)):(\d{1,5})$/.exec(String(value ?? '').trim());
  if (!m) throw new Error('CONSOLE_LISTEN: use <address>:<port>, e.g. 0.0.0.0:7320');
  const port = Number(m[3]);
  if (port < 1 || port > 65535) throw new Error('CONSOLE_LISTEN: port out of range');
  return { host: m[1] ?? m[2], port };
}

const text = (value, max = 4096) => (value == null ? '' : String(value).trim().slice(0, max));
// The GitHub sign-in (github-auth.mjs), or null without CONSOLE_GITHUB_CLIENT_ID. With it, the secret, at least one
// allowed login and the public URL are required: the console refuses to start otherwise.
export function parseGithub(env) {
  const clientId = text(env.CONSOLE_GITHUB_CLIENT_ID, 200);
  if (!clientId) return null;
  const clientSecret = text(env.CONSOLE_GITHUB_CLIENT_SECRET, 200);
  if (!clientSecret) throw new Error('CONSOLE_GITHUB_CLIENT_SECRET: required with CONSOLE_GITHUB_CLIENT_ID');
  const allowedLogins = [...new Set(text(env.CONSOLE_GITHUB_ALLOWED_LOGINS).split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!allowedLogins.length) throw new Error('CONSOLE_GITHUB_ALLOWED_LOGINS: at least one GitHub login (comma-separated) is required');
  if (allowedLogins.some(l => !/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(l))) throw new Error('CONSOLE_GITHUB_ALLOWED_LOGINS: a GitHub login has letters, digits and single hyphens, at most 39 characters');
  const origin = value => {
    let url;
    try { url = new URL(text(value, 300)); } catch { return null; }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    return url.origin;
  };
  const publicUrl = origin(env.CONSOLE_PUBLIC_URL);
  if (!publicUrl) throw new Error('CONSOLE_PUBLIC_URL: the https origin of the console (https://painel.example.com), no path');
  const sessionSecret = text(env.CONSOLE_SESSION_SECRET, 1024) || null;
  if (sessionSecret !== null && sessionSecret.length < 32) throw new Error('CONSOLE_SESSION_SECRET: at least 32 characters (or unset: generated into CONSOLE_STATE_DIR)');
  const baseUrl = origin(env.CONSOLE_GITHUB_BASE_URL || 'https://github.com');
  const apiUrl = origin(env.CONSOLE_GITHUB_API_URL || 'https://api.github.com');
  if (!baseUrl || !apiUrl) throw new Error('CONSOLE_GITHUB_BASE_URL / CONSOLE_GITHUB_API_URL: an origin (tests only)');
  return { clientId, clientSecret, allowedLogins, publicUrl, sessionSecret, baseUrl, apiUrl };
}

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const at = argv.indexOf('--tcp');
  const github = parseGithub(env);
  const listen = text(env.CONSOLE_LISTEN) ? parseListen(env.CONSOLE_LISTEN) : null;
  if (listen && !github) throw new Error('CONSOLE_LISTEN needs the GitHub sign-in (CONSOLE_GITHUB_CLIENT_ID...): without it the console listens on loopback (--tcp) or the unix socket only');
  const tcp = at >= 0 ? parseTcp(argv[at + 1]) : listen;
  const dir = (value, fallback) => path.resolve(value || fallback);
  return {
    serverDir: dir(env.SSAM_SERVER_DIR, '/data/server'),
    socket: tcp ? null : dir(env.CONSOLE_SOCKET, '/run/console/console.sock'),
    tcp,
    // the tokens in Postgres (the token module's openTokenStore); null keeps tokens.json in serverDir
    databaseUrl: text(env.SSAM_DATABASE_URL) || null,
    github,
    stateDir: dir(env.CONSOLE_STATE_DIR, '/state'),
    hostJson: dir(env.CONSOLE_HOST_JSON, '/host/host.json'),
    publicDir: dir(env.CONSOLE_PUBLIC_DIR, path.join(here, 'public')),
    tokenModule: dir(env.CONSOLE_TOKEN_MODULE, '/app/platforms/odc/facade/server-tokens.mjs'),
    domain: env.CONSOLE_DOMAIN ? String(env.CONSOLE_DOMAIN).trim().slice(0, 253) || null : null,
    timeZone: env.CONSOLE_TZ || 'America/Sao_Paulo',
    licenseWrites: parseLicenseWrites(env.CONSOLE_LICENSE_WRITES),
    kernelCatalog: dir(env.CONSOLE_KERNEL_CATALOG, DEFAULT_KERNEL_CATALOG),
    toolsCatalog: env.CONSOLE_TOOLS_CATALOG ? path.resolve(env.CONSOLE_TOOLS_CATALOG) : null,
  };
}
