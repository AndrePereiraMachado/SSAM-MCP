// r41: the account's own workspace quota is edited in Licenses (route, history, read-back, external change) and drives the
// workspace view; the load of each backend (backends.mjs) reaches the VPS payload; the quota of a license follows its own
// value, else the server's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeEnv, startConsole, REAL_MODULE } from './helpers.mjs';
import { buildScenario } from './scenario.mjs';
import { quotaOfLicense, GIB } from '../workspaces.mjs';
import { summarizeBackend, createBackends } from '../backends.mjs';

test('the quota of a license: its own value, else the server value', () => {
  assert.deepEqual(quotaOfLicense({ quotaGiB: 40 }, 10), { bytes: 40 * GIB, gib: 40, source: 'account' });
  assert.deepEqual(quotaOfLicense({ quotaGiB: null }, 20), { bytes: 20 * GIB, gib: 20, source: 'server' });
  assert.deepEqual(quotaOfLicense(undefined), { bytes: 10 * GIB, gib: 10, source: 'server' });
  assert.equal(quotaOfLicense({ quotaGiB: 0 }, 10).source, 'server');
});

test('Licenses sets and clears the quota of an account end to end; the workspace shows it; refusals and an external change', async t => {
  const env = makeEnv();
  const sc = await buildScenario(env);
  const c = await startConsole(env);
  t.after(() => c.close());
  let alfa = (await c.get('/api/licenses')).body.licenses.find(l => l.id === sc.alfa.id);
  assert.deepEqual(alfa.actions.quota, { allowed: true, reason: null });
  assert.equal(alfa.quotaGiB, null);
  let r = await c.post(`/api/licenses/${sc.alfa.id}/quota`, { quotaGiB: 25, confirm: 'Cliente Alfa', expectQuotaGiB: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.license.quotaGiB, r.body.previousQuotaGiB], [25, null]);
  const { createTokenStore } = await import(pathToFileURL(REAL_MODULE).href);
  assert.equal(createTokenStore(env.serverDir).lookup(sc.alfa.id).quotaGiB, 25, 'the image module reads it back');
  alfa = (await c.get('/api/licenses')).body.licenses.find(l => l.id === sc.alfa.id);
  if (alfa.workspace) assert.deepEqual([alfa.workspace.quotaBytes, alfa.workspace.quotaSource], [25 * GIB, 'account']);
  r = await c.post(`/api/licenses/${sc.alfa.id}/quota`, { quotaGiB: 25, confirm: 'Cliente Alfa', expectQuotaGiB: 25 });
  assert.equal(r.body.error.code, 'NO_CHANGE');
  r = await c.post(`/api/licenses/${sc.alfa.id}/quota`, { quotaGiB: 30, confirm: 'Cliente Alfa', expectQuotaGiB: null });
  assert.equal(r.body.error.code, 'STALE');
  for (const bad of [0, 2000, 1.5, '10']) {
    r = await c.post(`/api/licenses/${sc.alfa.id}/quota`, { quotaGiB: bad, confirm: 'Cliente Alfa', expectQuotaGiB: 25 });
    assert.equal(r.status, 400, String(bad));
  }
  r = await c.post(`/api/licenses/${sc.alfa.id}/quota`, { quotaGiB: null, confirm: 'Cliente Alfa', expectQuotaGiB: 25 });
  assert.deepEqual([r.status, r.body.license.quotaGiB, r.body.previousQuotaGiB], [200, null, 25]);
  // a change made outside the console (ssam server-token quota) becomes an "externo" history line
  createTokenStore(env.serverDir).setQuota(sc.alfa.id, 12);
  c.app.parts.licenses.detectExternal();
  const hist = (await c.get('/api/history')).body;
  const lines = (hist.entries ?? []).filter(e => e.action === "quota");
  assert.ok(lines.some(e => e.actor === 'externo' && e.detail?.quotaGiB === 12), JSON.stringify(lines));
  assert.ok(lines.some(e => e.actor === 'painel' && e.detail?.quotaGiB === 25));
  // a revoked license cannot change
  const gama = (await c.get('/api/licenses')).body.licenses.find(l => l.id === sc.gama.id);
  assert.equal(gama.actions.quota.allowed, false);
});

test('the load of each backend: RSS now and peaks, accounts per hour and at once, from the files the backends write', async t => {
  const env = makeEnv();
  const now = Date.now();
  const hour = h => new Date(Math.floor((now - h * 3600000) / 3600000) * 3600000).toISOString();
  const doc = { schema: 'ssam-backend-metrics/1', backend: 'b1', updatedAt: new Date(now - 30000).toISOString(), hostMemTotalB: 8 * GIB,
    samples: [{ t: new Date(now - 120000).toISOString(), rssB: 2 * GIB, active: 1 }, { t: new Date(now - 60000).toISOString(), rssB: 3 * GIB, active: 2 }],
    hours: [{ hour: hour(0), maxRssB: 3 * GIB, accounts: 4, peakActive: 2 }, { hour: hour(5), maxRssB: 5 * GIB, accounts: 7, peakActive: 3 },
      { hour: hour(48), maxRssB: 6 * GIB, accounts: 9, peakActive: 5 }] };
  const s = summarizeBackend(doc, now);
  assert.deepEqual([s.rssNowB, s.rssPeak24hB, s.rssPeak7dB, s.activeNow, s.activePeak24h, s.activePeak7d, s.accountsThisHour, s.accountsPeakHour24h, s.accountsPeakHour7d, s.stale],
    [3 * GIB, 5 * GIB, 6 * GIB, 2, 3, 5, 4, 7, 9, false]);
  const dir = path.join(env.serverDir, 'versions', 'o11-11.55.94-odc-1.7.31', 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'backend.json'), JSON.stringify(doc));
  fs.mkdirSync(path.join(env.serverDir, 'versions', 'other', 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(env.serverDir, 'versions', 'other', 'metrics', 'backend.json'), '{"schema":"another"}');
  assert.deepEqual(createBackends({ serverDir: env.serverDir }).list().map(b => b.name), ['o11-11.55.94-odc-1.7.31']);
  const c = await startConsole(env);
  t.after(() => c.close());
  const vps = (await c.get('/api/vps')).body;
  assert.equal(vps.backends.length, 1);
  assert.equal(vps.backends[0].rssPeak24hB, 5 * GIB);
  assert.doesNotMatch(JSON.stringify(vps.backends), /tok_/);
});
