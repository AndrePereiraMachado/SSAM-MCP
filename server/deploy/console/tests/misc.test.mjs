// Environment contract (1.2: --tcp loopback only), the unix socket rules of 7.2 (Linux only), the display time zone,
// pt-BR formats of the texts, the one-at-a-time mutation queue, the event ring and the checkpoint schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, parseGithub, parseListen, parseTcp } from '../config.mjs';
import { createEvents } from '../events.mjs';
import { createGate } from '../http.mjs';
import { listen } from '../listen.mjs';
import { eventText, fmt, licenseText } from '../texts.mjs';
import { createTz } from '../tz.mjs';
import { CONSOLE_DIR, makeEnv, startConsole, tempDir } from './helpers.mjs';

test('--tcp accepts loopback only; the environment contract has its defaults', () => {
  assert.deepEqual(parseTcp('127.0.0.1:7320'), { host: '127.0.0.1', port: 7320 });
  assert.deepEqual(parseTcp('[::1]:7320'), { host: '::1', port: 7320 });
  assert.deepEqual(parseTcp('localhost:0'), { host: '127.0.0.1', port: 0 });
  for (const bad of ['0.0.0.0:7320', '192.0.2.1:80', '[::]:7320', 'evil.example:7320', '127.0.0.1', '127.0.0.1:99999', '']) assert.throws(() => parseTcp(bad), bad);
  const c = loadConfig([], {});
  assert.equal(c.serverDir, path.resolve('/data/server'));
  assert.equal(c.socket, path.resolve('/run/console/console.sock'));
  assert.equal(c.stateDir, path.resolve('/state'));
  assert.equal(c.hostJson, path.resolve('/host/host.json'));
  assert.equal(c.tokenModule, path.resolve('/app/platforms/odc/facade/server-tokens.mjs'));
  assert.equal(c.timeZone, 'America/Sao_Paulo');
  assert.equal(c.domain, null);
  const t = loadConfig(['--tcp', '127.0.0.1:7399'], { CONSOLE_DOMAIN: 'ssam.example.com', CONSOLE_TZ: 'UTC', CONSOLE_STATE_DIR: '/tmp/x' });
  assert.equal(t.socket, null);
  assert.deepEqual(t.tcp, { host: '127.0.0.1', port: 7399 });
  assert.equal(t.domain, 'ssam.example.com');
  assert.equal(t.timeZone, 'UTC');
  const r = spawnSync(process.execPath, [path.join(CONSOLE_DIR, 'server.mjs'), '--tcp', '0.0.0.0:7399'], { encoding: 'utf8', env: { ...process.env, CONSOLE_STATE_DIR: tempDir('cfg') } });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout.trim()).console, 'config-error');
});

test('unix socket: chmod 0600, a stale socket is replaced, a live one means already-running', { skip: process.platform === 'win32' && 'unix sockets are tested on Linux (the rehearsal)' }, async () => {
  const dir = tempDir('sock');
  const socket = path.join(dir, 'console.sock');
  const first = http.createServer((q, s) => s.end('ok'));
  assert.deepEqual(await listen(first, { socket }), { kind: 'socket', path: socket });
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
  const second = http.createServer();
  assert.deepEqual(await listen(second, { socket }), { kind: 'already-running' });
  await new Promise(resolve => first.close(resolve));
  // a socket file nobody answers on (left by a killed process)
  const stale = net.createServer();
  await new Promise(resolve => stale.listen(socket, resolve));
  stale.unref();
  await new Promise(resolve => { stale.close(resolve); });
  if (!fs.existsSync(socket)) { const s = net.createServer(); await new Promise(r => s.listen(socket, r)); s.close(); }
  const third = http.createServer();
  const where = await listen(third, { socket });
  assert.equal(where.kind, 'socket');
  third.close();
  fs.writeFileSync(path.join(dir, 'plain'), 'x');
  await assert.rejects(listen(http.createServer(), { socket: path.join(dir, 'plain') }), e => e.code === 'NOT_A_SOCKET');
});

test('time zone: local days across the UTC midnight, local midnight, whole-day differences, UTC-03:00 fallback', () => {
  const tz = createTz('America/Sao_Paulo');
  assert.equal(tz.day('2026-10-12T02:59:59Z'), '2026-10-11');
  assert.equal(tz.day('2026-10-12T03:00:00Z'), '2026-10-12');
  assert.equal(tz.hour('2026-10-12T01:30:00Z'), 22);
  assert.equal(new Date(tz.midnight('2026-10-12')).toISOString(), '2026-10-12T03:00:00.000Z');
  assert.deepEqual(tz.days('2026-10-02', 3), ['2026-09-30', '2026-10-01', '2026-10-02']);
  assert.equal(tz.dayDiff(Date.parse('2026-10-12T15:00:00Z'), Date.parse('2026-10-13T02:59:00Z')), 0);
  assert.equal(tz.dayDiff(Date.parse('2026-10-12T15:00:00Z'), Date.parse('2026-10-13T03:00:00Z')), 1);
  assert.equal(tz.dmy('2026-10-12T02:00:00Z'), '11/10/2026');
  assert.equal(tz.hm('2026-10-12T02:00:00Z'), '23:00');
  const broken = createTz('Not/AZone');
  assert.equal(broken.day('2026-10-12T02:59:59Z'), '2026-10-11', 'fixed UTC-03:00 without zone data');
  assert.equal(broken.hm('2026-10-12T02:00:00Z'), '23:00');
});

test('pt-BR formats used by the texts (6.6)', () => {
  assert.equal(fmt.duration(850), '850 ms');
  assert.equal(fmt.duration(1200), '1,2 s');
  assert.equal(fmt.duration(185000), '3 min 05 s');
  assert.equal(fmt.duration(3720000), '1 h 02 min');
  assert.equal(fmt.duration(4 * 86400000 + 11 * 3600000), '4 d 11 h');
  assert.equal(fmt.bytes(0), '0 B');
  assert.equal(fmt.bytes(512), '512 B');
  assert.equal(fmt.bytes(1150), '1,1 KiB');
  assert.equal(fmt.bytes(1126), '1 KiB');
  assert.equal(fmt.bytes(394543104), '376 MiB');
  assert.equal(fmt.bytes(6 * 1024 ** 3), '6 GiB');
  assert.equal(fmt.pct(6.4), '6');
  assert.equal(fmt.pct(0.5), '0,5');
  assert.equal(fmt.pct(null), '—');
  assert.equal(fmt.lanes(['o11', 'odc']), 'ODC, O11');
  assert.equal(eventText.listening({ pid: 7, mode: 'hosted' }), 'Servidor iniciado (pid 7, modo hosted).');
  const dmy = () => '11/11/2026';
  assert.equal(licenseText({ action: 'issue', customer: 'Cliente Delta', result: 'ok', detail: { lanes: ['odc', 'o11'], expiresAt: 'x' } }, dmy), 'Licença emitida para Cliente Delta (ODC, O11, até 11/11/2026).');
  assert.equal(licenseText({ action: 'issue', customer: 'Cliente Delta', result: 'ok', detail: { lanes: ['odc'], expiresAt: null } }, dmy), 'Licença emitida para Cliente Delta (ODC, sem validade).');
  assert.equal(licenseText({ action: 'renew', customer: 'Cliente Beta', result: 'ok', detail: { expiresAt: 'x' } }, dmy), 'Validade de Cliente Beta estendida até 11/11/2026.');
  assert.equal(licenseText({ action: 'revoke', customer: 'Cliente Gama', result: 'ok', external: true }, dmy), 'Licença de Cliente Gama revogada (fora do painel).');
  assert.equal(eventText.sessionOpened('Cliente Alfa', { client: 'x'.repeat(200), ip: '192.0.2.1' }).length < 200, true, 'customer-controlled values are capped');
});

test('mutation queue: one at a time, in order, a failure does not block the next', async () => {
  const gate = createGate();
  const order = [];
  const job = (name, ms, fail = false) => () => new Promise((resolve, reject) => {
    order.push(`start ${name}`);
    setTimeout(() => { order.push(`end ${name}`); fail ? reject(new Error(name)) : resolve(name); }, ms);
  });
  const results = await Promise.allSettled([gate.run(job('a', 30)), gate.run(job('b', 5, true)), gate.run(job('c', 1))]);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});

test('event ring: newest limit, after=<seq> without gaps, filters, 2000 kept, replay merge keeps numbers growing', () => {
  const ev = createEvents({ max: 5 });
  for (let i = 0; i < 8; i++) ev.emit({ time: `2026-10-12T00:00:0${i}Z`, group: i % 2 ? 'sessao' : 'agente', level: i === 7 ? 'error' : 'info', text: `e${i}` });
  assert.deepEqual(ev.query({ limit: 2 }).events.map(e => e.text), ['e6', 'e7']);
  assert.deepEqual(ev.query({ after: 5 }).events.map(e => e.seq), [6, 7, 8]);
  const page = ev.query({ after: 3, limit: 2 });
  assert.deepEqual([page.events.map(e => e.seq), page.lastSeq], [[4, 5], 5]);
  assert.deepEqual(ev.query({ groups: new Set(['sessao']) }).events.map(e => e.text), ['e3', 'e5', 'e7'], 'the ring keeps e3..e7');
  assert.deepEqual(ev.query({ levels: new Set(['error']) }).events.map(e => e.text), ['e7']);
  assert.equal(ev.ring.length, 5);
  const last = ev.lastSeq;
  ev.adopt([{ seq: 1, time: '2026-10-11T00:00:00Z', group: 'chamada', level: 'info', text: 'old' }]);
  assert.ok(ev.ring.every(e => e.seq > last));
  assert.equal(ev.ring.length, 5);
  assert.ok(!ev.ring.some(e => e.text === 'old'), 'only the newest 5 by time are kept');
});

test('checkpoint: schema, written atomically, no partial file left', async t => {
  const env = makeEnv();
  const c = await startConsole(env);
  t.after(() => c.close());
  c.app.writeCheckpoint(true);
  const cp = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'checkpoint.json'), 'utf8'));
  assert.equal(cp.schema, 'ssam-console-checkpoint/1');
  // readers.quality and quality: the quality records' reader and checkpoint part (DESIGN-QUALIDADE 4.1)
  assert.deepEqual(Object.keys(cp.readers), ['serverLog', 'audit', 'access', 'quality']);
  assert.deepEqual(Object.keys(cp.quality), ['sessions', 'pending']);
  assert.deepEqual(Object.keys(cp.readers.serverLog), ['ino', 'offset', 'size', 'mtimeMs', 'carry', 'lastRotatedStamp', 'head']);
  assert.deepEqual(fs.readdirSync(env.stateDir).filter(n => n.endsWith('.tmp')), []);
  assert.equal(c.app.writeCheckpoint(), false, 'not rewritten when nothing changed');
  const key = fs.readFileSync(path.join(env.stateDir, 'access.key'), 'utf8');
  assert.equal(key, c.key);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(env.stateDir, 'access.key')).mode & 0o777, 0o600);
});

test('the Coolify mode variables: SSAM_DATABASE_URL passed through, the GitHub sign-in checked whole, CONSOLE_LISTEN only with it', () => {
  assert.equal(loadConfig([], {}).databaseUrl, null);
  assert.equal(loadConfig([], { SSAM_DATABASE_URL: ' postgres://u:p@db:5432/ssam ' }).databaseUrl, 'postgres://u:p@db:5432/ssam');
  assert.equal(loadConfig([], {}).github, null);
  const full = { CONSOLE_GITHUB_CLIENT_ID: 'Iv1.abc', CONSOLE_GITHUB_CLIENT_SECRET: 'shh', CONSOLE_GITHUB_ALLOWED_LOGINS: ' Owner-Login, other ,owner-login', CONSOLE_PUBLIC_URL: 'https://painel.example.com/' };
  const g = parseGithub(full);
  assert.deepEqual(g, { clientId: 'Iv1.abc', clientSecret: 'shh', allowedLogins: ['owner-login', 'other'], publicUrl: 'https://painel.example.com', sessionSecret: null,
    baseUrl: 'https://github.com', apiUrl: 'https://api.github.com' });
  assert.equal(parseGithub({ ...full, CONSOLE_SESSION_SECRET: 'x'.repeat(32) }).sessionSecret, 'x'.repeat(32));
  assert.equal(parseGithub({ ...full, CONSOLE_GITHUB_BASE_URL: 'http://127.0.0.1:9', CONSOLE_GITHUB_API_URL: 'http://127.0.0.1:9' }).apiUrl, 'http://127.0.0.1:9');
  for (const [bad, re] of [
    [{ ...full, CONSOLE_GITHUB_CLIENT_SECRET: '' }, /CONSOLE_GITHUB_CLIENT_SECRET/],
    [{ ...full, CONSOLE_GITHUB_ALLOWED_LOGINS: ' , ' }, /CONSOLE_GITHUB_ALLOWED_LOGINS/],
    [{ ...full, CONSOLE_GITHUB_ALLOWED_LOGINS: undefined }, /CONSOLE_GITHUB_ALLOWED_LOGINS/],
    [{ ...full, CONSOLE_GITHUB_ALLOWED_LOGINS: 'bad login' }, /CONSOLE_GITHUB_ALLOWED_LOGINS/],
    [{ ...full, CONSOLE_PUBLIC_URL: 'painel.example.com' }, /CONSOLE_PUBLIC_URL/],
    [{ ...full, CONSOLE_PUBLIC_URL: 'https://painel.example.com/painel' }, /CONSOLE_PUBLIC_URL/],
    [{ ...full, CONSOLE_PUBLIC_URL: 'ftp://painel.example.com' }, /CONSOLE_PUBLIC_URL/],
    [{ ...full, CONSOLE_SESSION_SECRET: 'short' }, /CONSOLE_SESSION_SECRET/],
  ]) assert.throws(() => parseGithub(bad), re);
  assert.deepEqual(parseListen('0.0.0.0:7320'), { host: '0.0.0.0', port: 7320 });
  assert.deepEqual(parseListen('[::]:7320'), { host: '::', port: 7320 });
  for (const bad of ['', '7320', '0.0.0.0', '0.0.0.0:0', '0.0.0.0:70000']) assert.throws(() => parseListen(bad), bad || '(empty)');
  assert.throws(() => loadConfig([], { CONSOLE_LISTEN: '0.0.0.0:7320' }), /CONSOLE_LISTEN needs the GitHub sign-in/);
  const coolify = loadConfig([], { ...full, CONSOLE_LISTEN: '0.0.0.0:7320' });
  assert.deepEqual(coolify.tcp, { host: '0.0.0.0', port: 7320 });
  assert.equal(coolify.socket, null);
  // the sign-in without CONSOLE_LISTEN: the compose's port, never the unix socket
  assert.deepEqual(loadConfig([], full).tcp, { host: '0.0.0.0', port: 7320 });
  assert.equal(loadConfig([], full).socket, null);
  assert.deepEqual(loadConfig([], { ...full, CONSOLE_LISTEN: '[::]:7321' }).tcp, { host: '::', port: 7321 });
  assert.equal(coolify.github.publicUrl, 'https://painel.example.com');
  // --tcp (loopback) still wins for a local run with the sign-in
  assert.deepEqual(loadConfig(['--tcp', '127.0.0.1:7399'], { ...full, CONSOLE_LISTEN: '0.0.0.0:7320' }).tcp, { host: '127.0.0.1', port: 7399 });
});

test('CONSOLE_LICENSE_WRITES: auto by default, on or off; anything else refuses to start', () => {
  assert.equal(loadConfig([], {}).licenseWrites, 'auto');
  assert.equal(loadConfig([], { CONSOLE_LICENSE_WRITES: 'on' }).licenseWrites, 'on');
  assert.equal(loadConfig([], { CONSOLE_LICENSE_WRITES: ' OFF ' }).licenseWrites, 'off');
  assert.equal(loadConfig([], { CONSOLE_LICENSE_WRITES: '' }).licenseWrites, 'auto');
  assert.throws(() => loadConfig([], { CONSOLE_LICENSE_WRITES: 'yes' }), /CONSOLE_LICENSE_WRITES/);
});
