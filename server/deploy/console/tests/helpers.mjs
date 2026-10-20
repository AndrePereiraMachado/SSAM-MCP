// Shared helpers of the console tests: temp folders in the OS temp dir, a fake public dir, an injectable clock, an
// in-process console on 127.0.0.1:<random port>, raw HTTP requests (any Host/Origin header) and log line writers.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConsole } from '../app.mjs';
import { listen } from '../listen.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONSOLE_DIR = path.resolve(HERE, '..');
// The token module of this box: the 24th image's (tokens.json.lock, renew and setLanes).
export const REAL_MODULE = path.resolve(HERE, '..', '..', '..', 'platforms', 'odc', 'facade', 'server-tokens.mjs');
// The token module of the 23rd image (prod-20261011-ed0f94b, the rollback image of the 24th), byte for byte
// (ed0f94b:server/platforms/odc/facade/server-tokens.mjs): no lock, no renew, no setLanes, PARSE on a broken file.
export const IMAGE23_MODULE = path.join(HERE, 'fixtures', 'server-tokens-23.mjs');
export const FAKE_MODULE = path.join(HERE, 'fixtures', 'fake-tokens.mjs');
export const RACING_MODULE = path.join(HERE, 'fixtures', 'racing-tokens.mjs');
export const SECRET = /ssam_[A-Za-z0-9_-]{20,}/;
export const HOST_PROD = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'host-prod.json'), 'utf8'));
export const KERNEL_JSON = { o11: '11.55.91', odc: '1.7.27', odcBridge: 'v48', odcBridgeAccepted: ['v45'] };

// Temp folders are removed when the test process exits (KEEP_TEST_DIRS=1 keeps them for a look).
const created = [];
process.on('exit', () => {
  if (process.env.KEEP_TEST_DIRS) return;
  for (const d of created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still in use */ } }
});
export function tempDir(prefix = 'c') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `ssam-console-${prefix}-`));
  created.push(d);
  return d;
}

// serverDir, stateDir, publicDir (index.html, app.css, js/main.js, favicon.svg and a mock fixture that must never be served).
// licenseWrites defaults to 'on' here so the tests drive every action with the image's module; production defaults to
// 'auto' (licenses.mjs, DEPLOY.md 15.4), which the license tests cover on their own.
// databaseUrl: the tokens in Postgres through the module's openTokenStore (null keeps tokens.json); github: the GitHub
// sign-in (config.mjs parseGithub's shape) in place of the access key; port: a fixed loopback port (freePort()).
export function makeEnv({ tokenModule = REAL_MODULE, domain = 'ssam.example.com', kernel = KERNEL_JSON, licenseWrites = 'on', databaseUrl = null, github = null, port = 0 } = {}) {
  const root = tempDir('env');
  const env = { root, serverDir: path.join(root, 'server'), stateDir: path.join(root, 'state'), publicDir: path.join(root, 'public'),
    hostJson: path.join(root, 'host', 'host.json') };
  for (const d of [env.serverDir, env.stateDir, path.join(env.publicDir, 'js'), path.join(env.publicDir, 'mock'), path.dirname(env.hostJson)]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(env.publicDir, 'index.html'), '<!doctype html><title>Painel SSAM</title>');
  fs.writeFileSync(path.join(env.publicDir, 'app.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(env.publicDir, 'js', 'main.js'), 'export {};');
  fs.writeFileSync(path.join(env.publicDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(env.publicDir, 'mock', 'overview.json'), '{"mock":true}');
  fs.writeFileSync(path.join(env.publicDir, 'notes.txt'), 'not whitelisted');
  if (kernel) fs.writeFileSync(path.join(env.serverDir, 'kernel.json'), JSON.stringify(kernel));
  env.config = { serverDir: env.serverDir, socket: null, tcp: { host: '127.0.0.1', port }, stateDir: env.stateDir, hostJson: env.hostJson,
    publicDir: env.publicDir, tokenModule, domain, timeZone: 'America/Sao_Paulo', licenseWrites, databaseUrl, github };
  return env;
}

// A loopback port nothing listens on right now (for a console whose public URL must be known before it listens).
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

export function clock(start = Date.now()) {
  let t = typeof start === 'string' ? Date.parse(start) : start;
  const c = () => t;
  c.set = v => { t = typeof v === 'string' ? Date.parse(v) : v; };
  c.advance = ms => { t += ms; };
  c.iso = () => new Date(t).toISOString();
  return c;
}

const lastHostMtime = new Map();
export function writeHost(env, doc, collectedAt) {
  const d = structuredClone(doc);
  if (collectedAt) d.collectedAt = collectedAt;
  fs.writeFileSync(env.hostJson, JSON.stringify(d));
  // A strictly newer whole-second mtime on every write: two same-size documents written within one millisecond (or with
  // NTFS keeping the previous explicit mtime) must still give the reader a new mtime+size stamp.
  const prev = lastHostMtime.get(env.hostJson) ?? 0;
  const ms = Math.max(Math.ceil(fs.statSync(env.hostJson).mtimeMs / 1000) * 1000 + 1000, prev + 1000);
  lastHostMtime.set(env.hostJson, ms);
  const t = new Date(ms);
  fs.utimesSync(env.hostJson, t, t);
  return d;
}

export const line = obj => JSON.stringify(obj) + '\n';
export const appendLines = (file, list) => fs.appendFileSync(file, list.map(line).join(''));
export const writeLines = (file, list) => fs.writeFileSync(file, list.map(line).join(''));

// An in-process console listening on 127.0.0.1:<random>, booted (cold start or resume finished).
export async function startConsole(env, { now = Date.now, logs = [], begin = true } = {}) {
  const app = await createConsole({ config: env.config, now, log: l => logs.push(JSON.stringify(l)) });
  const where = await listen(app.server, env.config);
  const s = { app, port: where.port, key: app.auth.rotate(), logs };
  if (begin) await app.begin();
  // the key is read at each call, so a test can store a rotated key in s.key
  s.api = (method, p, { body, headers = {}, key: k = s.key, raw } = {}) => request(s.port, { method, path: p, body, raw,
    headers: { ...(k ? { 'X-SSAM-Console-Key': k } : {}), ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } });
  s.close = () => new Promise(resolve => { app.stop(); app.server.closeAllConnections?.(); app.server.close(() => resolve()); });
  s.get = p => s.api('GET', p);
  s.post = (p, body) => s.api('POST', p, { body });
  return s;
}

export function request(port, { method = 'GET', path: p = '/', headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    const h = Object.fromEntries(Object.entries({ Host: `localhost:${port}`, ...headers }).filter(([, v]) => v !== undefined));
    if (payload !== null && !Object.hasOwn(h, 'Content-Length') && !Object.hasOwn(h, 'Transfer-Encoding')) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, body: json });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// Every file under the given folders (recursively), with its text.
export function filesUnder(...dirs) {
  const out = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full); else out.push({ file: full, text: fs.readFileSync(full).toString('latin1') });
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
