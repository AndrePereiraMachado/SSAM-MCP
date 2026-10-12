// DESIGN 3.6 and 7.2 "host.json": missing, stale (121 s), invalid schema, a section ok:false, partial documents and unknown
// extra fields; the host transition events, the 15-minute series, Caddy windows counted once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HOST_PROD, clock, makeEnv, startConsole, writeHost } from './helpers.mjs';
import * as S from './shapes.mjs';

const T0 = '2026-10-12T03:00:00Z';
const ids = ov => ov.alerts.map(a => a.id).sort();

test('host.json missing, stale, invalid or partial', async t => {
  const env = makeEnv();
  const now = clock(T0);
  const c = await startConsole(env, { now });
  t.after(() => c.close());
  // missing
  await c.app.tickAll();
  let vps = (await c.get('/api/vps')).body;
  assert.equal(vps.collector.state, 'missing');
  assert.equal(vps.host, null);
  let ov = (await c.get('/api/overview')).body;
  assert.deepEqual(ids(ov), ['coletor']);
  assert.equal(ov.alerts[0].severity, 'critical');
  // fresh
  writeHost(env, HOST_PROD, '2026-10-12T02:59:50Z');
  await c.app.tickAll();
  ov = (await c.get('/api/overview')).body;
  assert.equal(ov.status.collector.state, 'fresh');
  assert.equal(ov.status.collector.ageS, 10);
  assert.ok(ids(ov).includes('coletor'), 'one false evaluation keeps the alert (hysteresis)');
  await c.app.tickAlerts();
  assert.ok(!ids((await c.get('/api/overview')).body).includes('coletor'));
  // stale: 121 s without a new collection (120 s is still fresh)
  now.set('2026-10-12T03:01:50Z');
  await c.app.tickAll();
  assert.equal((await c.get('/api/overview')).body.status.collector.state, 'fresh');
  now.set('2026-10-12T03:01:51Z');
  await c.app.tickAll();
  ov = (await c.get('/api/overview')).body;
  assert.equal(ov.status.collector.state, 'stale');
  assert.equal(ov.status.collector.ageS, 121);
  const stale = ov.alerts.find(a => a.id === 'coletor');
  assert.equal(stale.severity, 'warning');
  assert.equal(stale.title, 'O coletor da VPS parou: últimos dados às 23:59 (há 2 min 01 s).');
  assert.ok((await c.get('/api/events?group=vps')).body.events.some(e => e.text === 'Coletor da VPS parou.'));
  // back
  writeHost(env, HOST_PROD, '2026-10-12T03:01:55Z');
  await c.app.tickAll();
  assert.ok((await c.get('/api/events?group=vps')).body.events.some(e => e.text === 'Coletor da VPS voltou.'));
  // invalid schema, then garbage
  writeHost(env, { ...HOST_PROD, schema: 'ssam-console-host/9' }, '2026-10-12T03:02:00Z');
  now.set('2026-10-12T03:02:05Z');
  await c.app.tickAll();
  vps = (await c.get('/api/vps')).body;
  assert.equal(vps.collector.state, 'invalid');
  S.assertShape(assert, vps, S.Vps, 'vps invalid');
  ov = (await c.get('/api/overview')).body;
  assert.equal(ov.alerts.find(a => a.id === 'coletor').title, 'host.json em formato desconhecido (ssam-console-host/9); atualize o coletor (host/install.sh).');
  fs.writeFileSync(env.hostJson, '{"schema": "ssam-console-host/1", "collectedAt": ');
  const mt = new Date(Date.now() + 5000);
  fs.utimesSync(env.hostJson, mt, mt);
  await c.app.tickAll();
  assert.equal((await c.get('/api/vps')).body.collector.state, 'invalid');
  // a section ok:false, a missing section and unknown extra fields
  const partial = structuredClone(HOST_PROD);
  partial.updates = { ok: false, error: 'TIMEOUT', at: '2026-10-12T03:02:30Z' };
  delete partial.tls;
  partial.futuro = { ok: true, qualquer: 1 };
  partial.host.campoNovo = [1, 2, 3];
  partial.docker.containers[0].campoNovo = 'x';
  writeHost(env, partial, '2026-10-12T03:02:30Z');
  now.set('2026-10-12T03:02:35Z');
  await c.app.tickAll();
  vps = (await c.get('/api/vps')).body;
  S.assertShape(assert, vps, S.Vps, 'vps partial');
  assert.equal(vps.collector.state, 'fresh');
  assert.equal(vps.updates, null);
  assert.equal(vps.tls, null);
  assert.ok(vps.collector.errors.includes('updates: TIMEOUT'));
  ov = (await c.get('/api/overview')).body;
  const parcial = ov.alerts.find(a => a.id === 'coleta-parcial');
  assert.equal(parcial.title, 'Coleta parcial: updates falharam (TIMEOUT).');
  assert.equal(parcial.severity, 'info');
  assert.ok(!ids(ov).includes('reinicio-pendente'), 'no updates data, no update rule');
  assert.equal(ov.summary.find(r => r.area === 'coletor').facts.sectionErrors, 1);
  S.assertShape(assert, ov, S.Overview, 'overview partial');
});

test('host transitions: restarts, health changes, series and Caddy windows counted once', async t => {
  const env = makeEnv();
  const now = clock(T0);
  const c = await startConsole(env, { now });
  t.after(() => c.close());
  writeHost(env, HOST_PROD, '2026-10-12T02:59:30Z');
  await c.app.tickAll();
  await c.app.tickAll();   // the same collection seen twice
  const next = structuredClone(HOST_PROD);
  next.docker.containers[1].restartCount = 2;
  next.docker.containers[0].health = 'unhealthy';
  writeHost(env, next, '2026-10-12T03:00:00Z');
  now.set('2026-10-12T03:00:05Z');
  await c.app.tickAll();
  const texts = (await c.get('/api/events?group=vps')).body.events.map(e => e.text);
  assert.ok(texts.includes('caddy reiniciou.'));
  assert.ok(texts.includes('Saúde do ssam-server: saudável → com falha.'));
  const ov = (await c.get('/api/overview')).body;
  assert.equal(ov.alerts.find(a => a.id === 'container-reiniciou:caddy').title, 'caddy reiniciou 2 vez(es) nas últimas 24 h.');
  assert.equal(ov.alerts.find(a => a.id === 'servidor-fora').title, 'O ssam-server está unhealthy há 5,0 s.');
  assert.equal(ov.status.server.state, 'down');
  assert.equal(ov.summary.find(r => r.area === 'containers').facts.restarts24h, 2);
  // 02:59:30Z is 23:59:30 on 11/10 local: the series files are per local day
  const read = day => fs.readFileSync(path.join(env.stateDir, 'series', `host-${day}.jsonl`), 'utf8').trim().split('\n');
  const lines = [...read('2026-10-11'), ...read('2026-10-12')];
  assert.equal(lines.length, 2, 'one series line per new collection');
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ['t', 'cpu', 'mem', 'load1', 'rx', 'tx', 'scpu', 'smem', 'disk']);
  const vps = (await c.get('/api/vps')).body;
  const filled = vps.series.points.filter(p => p.cpuPct != null);
  assert.equal(filled.length, 2, '02:59:30 and 03:00:00 fall in two 15-minute buckets');
  assert.equal(filled[1].cpuPct, 1.2);
  assert.equal(filled[1].srvMemB, 394543104);
  assert.equal(vps.series.points[95].t > filled[1].t || vps.series.points[95].t === filled[1].t, true);
  const u = (await c.get('/api/usage?range=7d')).body;
  assert.deepEqual(u.denied.byStatus, { 401: 2 }, 'two windows of 1 denial, the repeated poll not counted');
  assert.equal(u.denied.since, '2026-10-12T02:50:30Z');
  // 24 h later the restart no longer counts
  now.set('2026-10-13T03:00:10Z');
  writeHost(env, next, '2026-10-13T03:00:00Z');
  await c.app.tickAll();
  await c.app.tickAlerts();
  assert.ok(!(await c.get('/api/overview')).body.alerts.some(a => a.id === 'container-reiniciou:caddy'));
});

test('host transitions: a restart by hand (startedAt moves, RestartCount does not) gives the event but no alert', async t => {
  const env = makeEnv();
  const now = clock(T0);
  const c = await startConsole(env, { now });
  t.after(() => c.close());
  writeHost(env, HOST_PROD, '2026-10-12T02:59:30Z');
  await c.app.tickAll();
  const next = structuredClone(HOST_PROD);
  const srv = next.docker.containers.find(x => x.service === 'ssam-server');
  srv.startedAt = '2026-10-12T02:59:50Z';     // docker compose restart ssam-server: same RestartCount, new start
  writeHost(env, next, '2026-10-12T03:00:00Z');
  now.set('2026-10-12T03:00:05Z');
  await c.app.tickAll();
  await c.app.tickAlerts();
  const events = (await c.get('/api/events?group=vps')).body.events;
  const ev = events.filter(e => e.text === 'ssam-server reiniciou.');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].level, 'info');
  const ov = (await c.get('/api/overview')).body;
  assert.ok(!ov.alerts.some(a => a.rule === 'container-reiniciou'), 'a restart by hand is not a crash');
  // the same collection seen again, and a console restart from the checkpoint, emit nothing more
  await c.app.tickAll();
  writeHost(env, next, '2026-10-12T03:00:30Z');
  now.set('2026-10-12T03:00:35Z');
  await c.app.tickAll();
  assert.equal((await c.get('/api/events?group=vps')).body.events.filter(e => e.text === 'ssam-server reiniciou.').length, 1);
});
