// Environment contract of the console (DESIGN 1.2): SSAM_SERVER_DIR, CONSOLE_SOCKET (or --tcp 127.0.0.1:<port> for tests
// and local runs, loopback only), CONSOLE_STATE_DIR, CONSOLE_HOST_JSON, CONSOLE_PUBLIC_DIR, CONSOLE_TOKEN_MODULE,
// CONSOLE_DOMAIN (public URL before a `listening` event is seen) and CONSOLE_TZ (America/Sao_Paulo).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONSOLE_VERSION = '1.0.0';
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

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const at = argv.indexOf('--tcp');
  const tcp = at >= 0 ? parseTcp(argv[at + 1]) : null;
  const dir = (value, fallback) => path.resolve(value || fallback);
  return {
    serverDir: dir(env.SSAM_SERVER_DIR, '/data/server'),
    socket: tcp ? null : dir(env.CONSOLE_SOCKET, '/run/console/console.sock'),
    tcp,
    stateDir: dir(env.CONSOLE_STATE_DIR, '/state'),
    hostJson: dir(env.CONSOLE_HOST_JSON, '/host/host.json'),
    publicDir: dir(env.CONSOLE_PUBLIC_DIR, path.join(here, 'public')),
    tokenModule: dir(env.CONSOLE_TOKEN_MODULE, '/app/platforms/odc/facade/server-tokens.mjs'),
    domain: env.CONSOLE_DOMAIN ? String(env.CONSOLE_DOMAIN).trim().slice(0, 253) || null : null,
    timeZone: env.CONSOLE_TZ || 'America/Sao_Paulo',
  };
}
