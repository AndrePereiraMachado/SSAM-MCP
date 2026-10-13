// DESIGN 7.2 "views": every endpoint's JSON matches the shapes of section 4 (tests/shapes.mjs), on a realistic state
// volume, on an empty one and without host.json; plus the main derived values of the payloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FAKE_MODULE, makeEnv, startConsole } from './helpers.mjs';
import { buildScenario } from './scenario.mjs';
import * as S from './shapes.mjs';

test('every endpoint matches the contract shapes on a realistic state volume', async t => {
  const env = makeEnv();
  const sc = await buildScenario(env);
  const c = await startConsole(env);
  t.after(() => c.close());
  await c.app.tickAll();
  await c.app.parts.workspaces.run();
  await c.app.tickAlerts();

  const meta = (await c.get('/api/meta')).body;
  S.assertShape(assert, meta, S.Meta, 'meta');
  assert.equal(meta.publicUrl, 'https://ssam.example.com/mcp');
  assert.equal(meta.serverUrl, 'https://ssam.example.com');
  assert.equal(meta.timeZone, 'America/Sao_Paulo');
  assert.deepEqual(meta.capabilities, { issue: true, revoke: true, agentRotate: true, renew: true, lanes: true, readOnly: null });
  assert.equal(meta.indexing.state, 'ready');

  const ov = (await c.get('/api/overview')).body;
  S.assertShape(assert, ov, S.Overview, 'overview');
  assert.deepEqual(ov.summary.map(r => r.area), ['servidor', 'licencas', 'uso', 'agentes', 'sessoes', 'vps', 'containers', 'backup', 'tls', 'coletor']);
  for (const row of ov.summary) S.assertShape(assert, row.facts, S.SUMMARY_FACTS[row.area], `summary ${row.area}`);
  assert.equal(ov.status.server.state, 'up');
  assert.equal(ov.status.server.warm, 'warm');
  assert.equal(ov.status.server.imageTag, 'prod-20261011-ed0f94b');
  assert.equal(ov.status.sessionsOpen, 1);
  assert.equal(ov.status.agentsConnected, 1);
  assert.deepEqual(ov.status.licenses, { active: 2, expired: 0, revoked: 1 });
  assert.equal(ov.status.collector.state, 'fresh');
  assert.ok(ov.recentEvents.length > 0 && ov.recentEvents.length <= 10);
  assert.ok(ov.recentEvents[0].seq > ov.recentEvents[ov.recentEvents.length - 1].seq, 'recentEvents newest first');
  const rules = ov.alerts.map(a => a.rule).sort();
  assert.ok(rules.includes('licenca-vence'), 'Beta expires in 2 days');
  assert.ok(rules.includes('acesso-outra-maquina'));
  const beta = ov.alerts.find(a => a.id === `licenca-vence:${sc.beta.id}`);
  assert.equal(beta.severity, 'critical');
  assert.equal(beta.subject.customer, 'Cliente Beta');
  assert.equal(ov.summary.find(r => r.area === 'licencas').facts.nextExpiry.token, sc.beta.id);

  const lic = (await c.get('/api/licenses')).body;
  S.assertShape(assert, lic, S.Licenses, 'licenses');
  const alfa = lic.licenses.find(l => l.id === sc.alfa.id);
  assert.equal(alfa.agent.state, 'connected');
  assert.equal(alfa.sessionsOpen, 1);
  assert.deepEqual(alfa.machine, { id: 'abc123', name: 'PC-TESTE-01', user: 'teste', at: alfa.machine.at });
  assert.equal(alfa.accessAlerts, 1);
  assert.equal(alfa.daily14.reduce((s, n) => s + n, 0), 3);
  assert.equal(alfa.workspace.bytes, 4096);
  // the box's token module is the 24th image's: renew and lanes are offered
  assert.deepEqual(alfa.actions.renew, { allowed: true, reason: null });
  assert.deepEqual(alfa.actions.lanes, { allowed: true, reason: null });
  assert.equal(alfa.actions.revoke.allowed, true);
  const gama = lic.licenses.find(l => l.id === sc.gama.id);
  assert.equal(gama.state, 'revoked');
  assert.equal(gama.actions.revoke.reason, 'Licença revogada.');
  assert.equal(gama.agent.state, 'never');

  for (const q of ['?range=today', '?range=7d', '?range=30d', `?range=day&day=${new Date().toISOString().slice(0, 10)}`, `?range=7d&token=${sc.alfa.id}`, '']) {
    const u = (await c.get('/api/usage' + q)).body;
    S.assertShape(assert, u, S.Usage, 'usage ' + q);
  }
  for (const q of ['?range=today', '?range=7d', '?range=30d', '?range=day&day=2026-10-12', '']) {
    const r = (await c.get('/api/quality' + q)).body;
    S.assertShape(assert, r, S.Quality, 'quality ' + q);
    assert.equal(r.available, false, 'no quality file in this volume');
  }
  S.assertShape(assert, (await c.get('/api/quality?range=7d&token=' + sc.alfa.id)).body, { ...S.Quality, token: 'string' }, 'quality token');
  const u7 = (await c.get('/api/usage?range=7d')).body;
  assert.equal(u7.range.days, 7);
  assert.equal(u7.totals.calls, 4);
  assert.equal(u7.totals.failures, 1);
  assert.equal(u7.byCode[0].code, 'AGENT_NOT_CONNECTED');
  assert.equal(u7.byCustomer[0].customer, 'Cliente Alfa');
  assert.equal(u7.byCustomer[0].workspaceBytes, 4096);
  assert.equal(u7.byDay.length, 7);
  assert.ok(u7.byDay[0].day > u7.byDay[6].day, 'byDay newest first');
  assert.equal(u7.denied.available, true);
  assert.equal(u7.denied.rows[0].ip, '203.0.113.9');
  const one = (await c.get(`/api/usage?range=7d&token=${sc.beta.id}`)).body;
  assert.equal(one.totals.calls, 1);
  assert.deepEqual(one.byCustomer.map(r => r.token), [sc.beta.id]);
  assert.deepEqual(one.byTool.map(r => r.tool), ['ssam_doctor']);

  const live = (await c.get('/api/live')).body;
  S.assertShape(assert, live, S.Live, 'live');
  assert.equal(live.sessions.length, 1);
  assert.equal(live.sessions[0].session, '11111111');
  assert.equal(live.sessions[0].customer, 'Cliente Alfa');
  assert.equal(live.agents[0].studioO11.version, '11.55.91');
  assert.equal(live.agents[0].studioO11.port, 50123);
  assert.equal(live.agents[0].calls1h, 2);
  assert.equal(live.agents[0].failures1h, 1);
  assert.equal(live.workers.available, true);
  assert.deepEqual(live.workers.rows.map(r => r.kind), ['server', 'odc-worker']);
  assert.deepEqual(live.closedToday.length <= 1, true);

  const vps = (await c.get('/api/vps')).body;
  S.assertShape(assert, vps, S.Vps, 'vps');
  assert.equal(vps.server.kernel.drift, false);
  assert.equal(vps.server.warm.state, 'warm');
  assert.equal(vps.server.warm.workerRunning, true);
  assert.equal(vps.series.points.length, 96);

  const ev = (await c.get('/api/events?limit=500')).body;
  S.assertShape(assert, ev, S.Events, 'events');
  for (let i = 1; i < ev.events.length; i++) assert.ok(ev.events[i].seq > ev.events[i - 1].seq);
  assert.ok(ev.events.some(e => e.text === 'Servidor iniciado (pid 7, modo hosted).'));
  assert.ok(ev.events.some(e => e.text === 'Cliente Alfa abriu sessão MCP (claude-code 2.1.281, IP 192.0.2.10).'));
  assert.ok(ev.events.some(e => e.text === 'Cliente Beta abriu sessão MCP (cliente sem nome, IP 198.51.100.20).'));
  assert.ok(ev.events.some(e => e.text === 'Cliente Beta: sessão MCP encerrada (o cliente encerrou).'));
  assert.ok(ev.events.some(e => e.text === 'Cliente Alfa chamou odc_read: falhou com AGENT_NOT_CONNECTED em 2,1 s.'));
  assert.ok(ev.events.some(e => e.text === 'Cliente Alfa chamou studio_inspect: ok em 900 ms.'));
  assert.ok(ev.events.some(e => e.text === 'Agente de Cliente Alfa conectou (versão 0.2.0, PC-TESTE-01 (teste), IP 192.0.2.10).'));
  assert.ok(ev.events.some(e => e.text === 'Chamada odc_read ao agente de Cliente Alfa falhou: AGENT_TIMEOUT.'));
  assert.ok(ev.events.some(e => e.text === 'Máquina registrada para Cliente Alfa: PC-TESTE-01 (teste).'));
  const filtered = (await c.get('/api/events?group=chamada&level=warning')).body;
  assert.ok(filtered.events.length === 1 && filtered.events[0].code === 'AGENT_NOT_CONNECTED');
  const after = (await c.get(`/api/events?after=${ev.lastSeq}`)).body;
  assert.deepEqual(after.events, []);
  assert.equal((await c.get('/api/events?limit=0')).body.error.code, 'INVALID_FIELD');
  assert.equal((await c.get('/api/events?group=nada')).body.error.field, 'group');

  // mutations through the real module
  const issued = await c.post('/api/licenses', { customer: 'Cliente Delta', days: null, lanes: ['odc'], confirm: 'Cliente Delta' });
  assert.equal(issued.status, 201);
  S.assertShape(assert, issued.body, S.IssueAnswer, 'issue');
  assert.equal(issued.body.license.expiresAt, null);
  assert.equal(issued.body.publicUrl, 'https://ssam.example.com/mcp');
  const dup = await c.post('/api/licenses', { customer: 'Cliente Alfa', days: 30, lanes: ['odc', 'o11'], confirm: 'Cliente Alfa' });
  assert.deepEqual(dup.body.duplicates, [sc.alfa.id]);
  const rot = await c.post(`/api/licenses/${sc.alfa.id}/agent-rotate`, { confirm: 'Cliente Alfa' });
  S.assertShape(assert, rot.body, S.RotateAnswer, 'agent-rotate');
  const rev = await c.post(`/api/licenses/${issued.body.license.id}/revoke`, { confirm: 'Cliente Delta' });
  S.assertShape(assert, rev.body, S.RevokeAnswer, 'revoke');
  assert.equal(rev.body.license.state, 'revoked');
  // the box's token module (24th image) renews and changes lanes; a stale renew is the error answer
  const renewed = await c.post(`/api/licenses/${sc.alfa.id}/renew`, { days: 30, confirm: 'Cliente Alfa', expectExpiresAt: alfa.expiresAt });
  assert.equal(renewed.status, 200);
  S.assertShape(assert, renewed.body, S.RenewAnswer, 'renew');
  const laned = await c.post(`/api/licenses/${sc.alfa.id}/lanes`, { lanes: ['odc'], confirm: 'Cliente Alfa', expectLanes: ['odc', 'o11'] });
  assert.equal(laned.status, 200);
  S.assertShape(assert, laned.body, S.LanesAnswer, 'lanes');
  const stale = await c.post(`/api/licenses/${sc.alfa.id}/renew`, { days: 30, confirm: 'Cliente Alfa', expectExpiresAt: alfa.expiresAt });
  assert.equal(stale.status, 409);
  S.assertShape(assert, stale.body, S.ErrorAnswer, 'error');
  const ack = await c.post('/api/alerts/ack', { id: `licenca-vence:${sc.beta.id}`, hours: 24 });
  S.assertShape(assert, ack.body, S.AckAnswer, 'ack');
  const unack = await c.post('/api/alerts/unack', { id: `licenca-vence:${sc.beta.id}` });
  S.assertShape(assert, unack.body, S.UnackAnswer, 'unack');
  const hist = (await c.get('/api/history')).body;
  S.assertShape(assert, hist, S.HistoryList, 'history');
  assert.deepEqual(hist.entries.slice(0, 8).map(e => e.action), ['alert-unack', 'alert-ack', 'lanes', 'renew', 'revoke', 'agent-rotate', 'issue', 'issue']);
  const histAlfa = (await c.get(`/api/history?token=${sc.alfa.id}&limit=1`)).body;
  assert.deepEqual(histAlfa.entries.map(e => e.action), ['lanes']);
  const lic2 = (await c.get('/api/licenses')).body;
  assert.equal(lic2.licenses.find(l => l.id === sc.alfa.id).history[0].action, 'lanes');
  const key = await c.post('/api/key/rotate', {});
  S.assertShape(assert, key.body, S.KeyAnswer, 'key');
});

test('renew and lanes answers (module with renew/setLanes)', async t => {
  const env = makeEnv({ tokenModule: FAKE_MODULE });
  const sc = await buildScenario(env, { module: FAKE_MODULE });
  const c = await startConsole(env);
  t.after(() => c.close());
  const lic = (await c.get('/api/licenses')).body;
  assert.equal(lic.capabilities.renew, true);
  assert.equal(lic.capabilities.lanes, true);
  const beta = lic.licenses.find(l => l.id === sc.beta.id);
  assert.equal(beta.actions.renew.allowed, true);
  const renewed = await c.post(`/api/licenses/${sc.beta.id}/renew`, { days: 30, confirm: 'Cliente Beta', expectExpiresAt: beta.expiresAt });
  assert.equal(renewed.status, 200);
  S.assertShape(assert, renewed.body, S.RenewAnswer, 'renew');
  assert.equal(renewed.body.previousExpiresAt, beta.expiresAt);
  assert.equal(Date.parse(renewed.body.expiresAt), Date.parse(beta.expiresAt) + 30 * 86400000);
  const lanes = await c.post(`/api/licenses/${sc.alfa.id}/lanes`, { lanes: ['odc'], confirm: 'Cliente Alfa', expectLanes: ['odc', 'o11'] });
  S.assertShape(assert, lanes.body, S.LanesAnswer, 'lanes');
  assert.deepEqual(lanes.body.previousLanes, ['odc', 'o11']);
  assert.equal(lanes.body.openSessions, 1);
  const same = await c.post(`/api/licenses/${sc.alfa.id}/lanes`, { lanes: ['odc'], confirm: 'Cliente Alfa', expectLanes: ['odc'] });
  assert.equal(same.status, 400);
  assert.equal(same.body.error.code, 'NO_CHANGE');
  const ev = (await c.get('/api/events?group=licenca')).body.events.map(e => e.text);
  assert.ok(ev.some(x => /^Validade de Cliente Beta estendida até \d{2}\/\d{2}\/\d{4}\.$/.test(x)));
  assert.ok(ev.includes('Faixas de Cliente Alfa: ODC, O11 → ODC.'));
});

test('empty state volume and missing host.json still answer every endpoint (200)', async t => {
  const env = makeEnv({ kernel: null });
  const c = await startConsole(env);
  t.after(() => c.close());
  await c.app.tickAll();
  for (const [p, shape] of [['/api/meta', S.Meta], ['/api/overview', S.Overview], ['/api/licenses', S.Licenses], ['/api/usage?range=today', S.Usage], ['/api/quality?range=today', S.Quality],
    ['/api/live', S.Live], ['/api/vps', S.Vps], ['/api/events', S.Events], ['/api/history', S.HistoryList]]) {
    const r = await c.get(p);
    assert.equal(r.status, 200, p);
    S.assertShape(assert, r.body, shape, p);
  }
  const vps = (await c.get('/api/vps')).body;
  assert.equal(vps.collector.state, 'missing');
  for (const k of ['host', 'updates', 'security', 'tls', 'backups', 'containers', 'volumes', 'systemDf', 'coolify', 'series']) assert.equal(vps[k], null, k);
  const ov = (await c.get('/api/overview')).body;
  assert.equal(ov.status.server.state, 'unknown');
  assert.equal(ov.status.server.warm, 'unknown');
  assert.equal(ov.status.host, null);
  assert.deepEqual(ov.alerts.map(a => a.id), ['coletor']);
  assert.equal(ov.alerts[0].title, 'O coletor da VPS não está instalado ou nunca rodou (host/install.sh).');
  const live = (await c.get('/api/live')).body;
  assert.equal(live.server, null);
  assert.deepEqual(live.workers, { available: false, rows: [] });
  assert.ok(!fs.existsSync(env.serverDir + '/tokens.json'));
});
