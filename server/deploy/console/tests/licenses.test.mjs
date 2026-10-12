// DESIGN 3.5, 4.1 and 7.2 "licenses": capability flags with and without renew/setLanes (501 NOT_SUPPORTED), revoke twice
// (409 ALREADY_REVOKED), store errors mapped by code then by message, external changes become "externo" history lines,
// console-audit line shape, unreadable store (503) and a failing console-audit append.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mapStoreError } from '../licenses.mjs';
import { FAKE_MODULE, REAL_MODULE, makeEnv, startConsole } from './helpers.mjs';
import { buildScenario } from './scenario.mjs';

const load = async m => (await import(pathToFileURL(m).href)).createTokenStore;
const auditLines = env => fs.readFileSync(path.join(env.serverDir, 'console-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('current image module: renew and lanes are 501 NOT_SUPPORTED; revoke twice is 409 ALREADY_REVOKED', async t => {
  const env = makeEnv();
  const sc = await buildScenario(env);
  const c = await startConsole(env);
  t.after(() => c.close());
  const lic = (await c.get('/api/licenses')).body;
  assert.deepEqual(lic.capabilities, { issue: true, revoke: true, agentRotate: true, renew: false, lanes: false });
  const alfa = lic.licenses.find(l => l.id === sc.alfa.id);
  assert.deepEqual(alfa.actions.lanes, { allowed: false, reason: 'Indisponível nesta imagem (chega com o 24º envio).' });
  let r = await c.post(`/api/licenses/${sc.alfa.id}/renew`, { days: 30, confirm: 'Cliente Alfa', expectExpiresAt: alfa.expiresAt });
  assert.equal(r.status, 501);
  assert.deepEqual(r.body.error, { code: 'NOT_SUPPORTED', message: 'Indisponível nesta imagem do servidor (chega com o 24º envio).' });
  r = await c.post(`/api/licenses/${sc.alfa.id}/lanes`, { lanes: ['odc'], confirm: 'Cliente Alfa', expectLanes: ['odc', 'o11'] });
  assert.equal(r.status, 501);
  r = await c.post(`/api/licenses/${sc.beta.id}/revoke`, { confirm: 'Cliente Beta' });
  assert.equal(r.status, 200);
  assert.equal(r.body.license.state, 'revoked');
  r = await c.post(`/api/licenses/${sc.beta.id}/revoke`, { confirm: 'Cliente Beta' });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.error, { code: 'ALREADY_REVOKED', message: 'A licença já estava revogada.' });
  r = await c.post(`/api/licenses/${sc.gama.id}/agent-rotate`, { confirm: 'Cliente Gama' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'TOKEN_NOT_ACTIVE');
  r = await c.post('/api/licenses/tok_ffffffffffff/revoke', { confirm: 'x' });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body.error, { code: 'UNKNOWN_TOKEN', message: 'Licença tok_ffffffffffff não existe.' });
  r = await c.post('/api/licenses/../revoke', { confirm: 'x' });
  assert.equal(r.status, 404);
  r = await c.post('/api/licenses/tok_XYZ/revoke', { confirm: 'x' });
  assert.equal(r.body.error.code, 'UNKNOWN_TOKEN');
  // console-audit lines: whitelisted fields, no secret
  for (const l of auditLines(env)) {
    assert.deepEqual(Object.keys(l), ['time', 'action', 'actor', 'token', 'customer', 'result', 'code', 'detail']);
    for (const k of Object.keys(l.detail)) assert.ok(['days', 'expiresAt', 'previousExpiresAt', 'lanes', 'previousLanes', 'alert', 'hours'].includes(k), k);
  }
  const lines = auditLines(env);
  // validation, confirmation and unknown ids are not actions; refusals found inside the gate are
  assert.deepEqual(lines.map(l => [l.action, l.result, l.code]), [['revoke', 'ok', null], ['revoke', 'error', 'ALREADY_REVOKED'], ['agent-rotate', 'error', 'TOKEN_NOT_ACTIVE']]);
  assert.equal(lines[0].actor, 'painel');
  assert.equal(lines[0].customer, 'Cliente Beta');
  const ev = (await c.get('/api/events?group=licenca')).body.events.map(e => e.text);
  assert.ok(ev.includes('Licença de Cliente Beta revogada.'));
});

test('module with renew/setLanes: store refusals mapped to 409 codes, an expired license renews to active', async t => {
  const env = makeEnv({ tokenModule: FAKE_MODULE });
  const createTokenStore = await load(FAKE_MODULE);
  const past = createTokenStore(env.serverDir, { now: () => new Date(Date.now() - 10 * 86400000) });
  const old = past.issue({ customer: 'Cliente Gama', days: 1, lanes: ['odc'] });
  const forever = past.issue({ customer: 'Cliente Delta', lanes: ['odc'] });
  const far = createTokenStore(env.serverDir).issue({ customer: 'Cliente Beta', days: 3600, lanes: ['odc'] });
  const c = await startConsole(env);
  t.after(() => c.close());
  const list = (await c.get('/api/licenses')).body.licenses;
  const byId = Object.fromEntries(list.map(l => [l.id, l]));
  assert.equal(byId[old.id].state, 'expired');
  assert.equal(byId[old.id].actions.agentRotate.reason, 'Só para licença ativa.');
  assert.equal(byId[forever.id].actions.renew.reason, 'Licença sem validade: não há o que renovar.');
  let r = await c.post(`/api/licenses/${old.id}/agent-rotate`, { confirm: 'Cliente Gama' });
  assert.equal(r.body.error.code, 'TOKEN_NOT_ACTIVE');
  r = await c.post(`/api/licenses/${forever.id}/renew`, { days: 30, confirm: 'Cliente Delta', expectExpiresAt: null });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.error, { code: 'NO_EXPIRY', message: 'Licença sem validade: não há o que renovar.' });
  r = await c.post(`/api/licenses/${far.id}/renew`, { days: 100, confirm: 'Cliente Beta', expectExpiresAt: byId[far.id].expiresAt });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.error, { code: 'EXPIRY_TOO_FAR', message: 'A validade passaria de 3650 dias a partir de hoje.' });
  r = await c.post(`/api/licenses/${old.id}/renew`, { days: 30, confirm: 'Cliente Gama', expectExpiresAt: byId[old.id].expiresAt });
  assert.equal(r.status, 200);
  assert.equal(r.body.license.state, 'active');
  assert.ok(Math.abs(Date.parse(r.body.expiresAt) - (Date.now() + 30 * 86400000)) < 60000, 'from now when expired');
  await c.post(`/api/licenses/${old.id}/revoke`, { confirm: 'Cliente Gama' });
  r = await c.post(`/api/licenses/${old.id}/renew`, { days: 30, confirm: 'Cliente Gama', expectExpiresAt: r.body.expiresAt });
  assert.deepEqual(r.body.error, { code: 'TOKEN_REVOKED', message: 'A licença está revogada; emita uma nova.' });
  const latest = (await c.get('/api/licenses')).body.licenses.find(l => l.id === old.id);
  r = await c.post(`/api/licenses/${old.id}/lanes`, { lanes: ['o11'], confirm: 'Cliente Gama', expectLanes: latest.lanes });
  assert.equal(r.body.error.code, 'TOKEN_REVOKED');
  const errors = auditLines(env).filter(l => l.result === 'error').map(l => [l.action, l.code]);
  assert.deepEqual(errors, [['agent-rotate', 'TOKEN_NOT_ACTIVE'], ['renew', 'NO_EXPIRY'], ['renew', 'EXPIRY_TOO_FAR'], ['renew', 'TOKEN_REVOKED'], ['lanes', 'TOKEN_REVOKED']]);
});

test('external changes between polls become "externo" history lines; the first snapshot records nothing', async t => {
  const env = makeEnv({ tokenModule: FAKE_MODULE });
  const sc = await buildScenario(env, { module: FAKE_MODULE });
  const c = await startConsole(env);
  t.after(() => c.close());
  await c.app.tickAll();
  assert.deepEqual((await c.get('/api/history')).body.entries, [], 'licenses that existed at install are not history');
  // ssam-admin writes through the same module while the console runs
  const cli = (await load(FAKE_MODULE))(env.serverDir);
  const added = cli.issue({ customer: 'Cliente Delta', days: 30, lanes: ['odc'] });
  cli.revoke(sc.beta.id);
  cli.agentRotate(sc.alfa.id);
  cli.renew(sc.alfa.id, { days: 10 });
  cli.setLanes(sc.alfa.id, ['o11']);
  await c.app.tickAll();
  const h = (await c.get('/api/history')).body.entries;
  assert.ok(h.every(e => e.actor === 'externo' && e.result === 'ok'));
  assert.deepEqual(h.map(e => [e.action, e.token]).sort(), [['agent-rotate', sc.alfa.id], ['issue', added.id], ['lanes', sc.alfa.id], ['renew', sc.alfa.id], ['revoke', sc.beta.id]].sort());
  const lanes = h.find(e => e.action === 'lanes');
  assert.deepEqual(lanes.detail, { lanes: ['o11'], previousLanes: ['odc', 'o11'] });
  const renew = h.find(e => e.action === 'renew');
  assert.ok(renew.detail.previousExpiresAt && renew.detail.expiresAt > renew.detail.previousExpiresAt);
  const ev = (await c.get('/api/events?group=licenca')).body.events.map(e => e.text);
  assert.ok(ev.includes('Licença de Cliente Beta revogada (fora do painel).'));
  assert.ok(ev.includes('Credencial do agente de Cliente Alfa trocada (fora do painel).'));
  assert.ok(ev.includes('Faixas de Cliente Alfa: ODC, O11 → O11 (fora do painel).'));
  assert.ok(ev.some(x => /^Licença emitida para Cliente Delta \(ODC, até \d{2}\/\d{2}\/\d{4}\) \(fora do painel\)\.$/.test(x)));
  assert.ok(c.logs.some(l => l === `{"console":"external-change","action":"revoke","token":"${sc.beta.id}"}`));
  await c.app.tickAll();
  assert.equal((await c.get('/api/history')).body.entries.length, h.length, 'nothing recorded twice');
  // the console's own mutation is not mistaken for an external one
  await c.post(`/api/licenses/${added.id}/revoke`, { confirm: 'Cliente Delta' });
  await c.app.tickAll();
  const after = (await c.get('/api/history')).body.entries;
  assert.equal(after.length, h.length + 1);
  assert.equal(after[0].actor, 'painel');
  const snap = JSON.parse(fs.readFileSync(path.join(env.stateDir, 'tokens-snapshot.json'), 'utf8'));
  assert.ok(!JSON.stringify(snap).includes('sha256'), 'public view only');
});

test('unreadable store: 503 STORE_UNREADABLE and the licencas-ilegiveis alert; views stay up', async t => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.serverDir, 'tokens.json'), '{"schema":');
  const c = await startConsole(env);
  t.after(() => c.close());
  await c.app.tickAll();
  const r = await c.get('/api/licenses');
  assert.equal(r.status, 503);
  assert.deepEqual(r.body.error, { code: 'STORE_UNREADABLE', message: 'O arquivo de licenças não pode ser lido agora (PARSE).' });
  const ov = await c.get('/api/overview');
  assert.equal(ov.status, 200);
  const alert = ov.body.alerts.find(a => a.id === 'licencas-ilegiveis');
  assert.equal(alert.detail, 'PARSE');
  fs.writeFileSync(path.join(env.serverDir, 'tokens.json'), '{"schema":"outro","tokens":[]}');
  const again = await c.get('/api/licenses');
  assert.equal(again.body.error.message, 'O arquivo de licenças não pode ser lido agora (STORE_INVALID).');
});

test('a token module that cannot be loaded: every capability off, 501 for mutations, 503 for the list', async t => {
  const env = makeEnv({ tokenModule: path.join(makeEnv().root, 'nada.mjs') });
  const c = await startConsole(env);
  t.after(() => c.close());
  const meta = (await c.get('/api/meta')).body;
  assert.deepEqual(meta.capabilities, { issue: false, revoke: false, agentRotate: false, renew: false, lanes: false });
  assert.equal((await c.post('/api/licenses', { customer: 'Cliente Alfa', days: 30, lanes: ['odc'], confirm: 'Cliente Alfa' })).status, 501);
  assert.equal((await c.get('/api/licenses')).status, 503);
  assert.ok(c.logs.some(l => l.includes('"console":"token-module-failed"')));
});

test('a failing console-audit append still answers success with audit.written false', async t => {
  const env = makeEnv();
  fs.mkdirSync(path.join(env.serverDir, 'console-audit.jsonl'));
  const c = await startConsole(env);
  t.after(() => c.close());
  const r = await c.post('/api/licenses', { customer: 'Cliente Alfa', days: 30, lanes: ['odc'], confirm: 'Cliente Alfa' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.audit, { written: false });
  assert.ok(c.logs.some(l => l.startsWith('{"console":"audit-write-failed"')));
});

test('store errors: error.code first, then the message per verb (4.1)', () => {
  const e = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  const map = (verb, err) => { const a = mapStoreError(verb, err, 'tok_0000000a1fa0'); return [a.apiCode, a.status, a.field ?? null]; };
  assert.deepEqual(map('renew', e('anything', 'TOKEN_REVOKED')), ['TOKEN_REVOKED', 409, null]);
  assert.deepEqual(map('renew', e('anything', 'INVALID_DAYS')), ['INVALID_FIELD', 400, 'days']);
  assert.deepEqual(map('setLanes', e('x', 'INVALID_LANES')), ['INVALID_FIELD', 400, 'lanes']);
  assert.deepEqual(map('issue', e('x', 'INVALID_CUSTOMER')), ['INVALID_FIELD', 400, 'customer']);
  assert.deepEqual(map('list', e('x', 'STORE_INVALID')), ['STORE_UNREADABLE', 503, null]);
  assert.deepEqual(map('revoke', e('Unknown token id: tok_0000000a1fa0')), ['UNKNOWN_TOKEN', 404, null]);
  assert.deepEqual(map('agentRotate', e('Token tok_0000000a1fa0 is expired; issue a new one instead.')), ['TOKEN_NOT_ACTIVE', 409, null]);
  assert.deepEqual(map('agentRotate', e('Token tok_0000000a1fa0 is revoked; issue a new one instead.')), ['TOKEN_NOT_ACTIVE', 409, null]);
  assert.deepEqual(map('renew', e('Token tok_0000000a1fa0 is revoked; issue a new one instead.')), ['TOKEN_REVOKED', 409, null]);
  assert.deepEqual(map('setLanes', e('Token tok_0000000a1fa0 is revoked; issue a new one instead.')), ['TOKEN_REVOKED', 409, null]);
  assert.deepEqual(map('issue', e('customer: 1-64 letters, digits, space, dot, dash or underscore')), ['INVALID_FIELD', 400, 'customer']);
  assert.deepEqual(map('issue', e('days: an integer from 1 to 3650')), ['INVALID_FIELD', 400, 'days']);
  assert.deepEqual(map('issue', e('lanes: odc, o11 or odc,o11')), ['INVALID_FIELD', 400, 'lanes']);
  assert.deepEqual(map('renew', e('Token tok_0000000a1fa0 has no expiry; nothing to renew.')), ['NO_EXPIRY', 409, null]);
  assert.deepEqual(map('renew', e('expiry: at most 3650 days from now')), ['EXPIRY_TOO_FAR', 409, null]);
  assert.deepEqual(map('list', e('Invalid tokens file: /data/server/tokens.json')), ['STORE_UNREADABLE', 503, null]);
  assert.deepEqual(map('list', Object.assign(new SyntaxError('Unexpected end of JSON input'))), ['STORE_UNREADABLE', 503, null]);
  for (const code of ['EACCES', 'ENOSPC', 'EROFS', 'EIO']) {
    assert.deepEqual(map('issue', e('write failed', code)), ['STORE_WRITE_FAILED', 500, null]);
    assert.equal(mapStoreError('issue', e('x', code)).message, `Não foi possível gravar a licença (${code}). Nada foi alterado.`);
  }
  assert.deepEqual(map('issue', new TypeError('boom')), ['INTERNAL', 500, null]);
  assert.equal(mapStoreError('issue', new TypeError('boom')).message, 'Erro interno do painel (TypeError).');
});

test('the real token module (current image) also runs issue and agent-rotate end to end', async t => {
  const env = makeEnv({ tokenModule: REAL_MODULE });
  const c = await startConsole(env);
  t.after(() => c.close());
  const r = await c.post('/api/licenses', { customer: 'Cliente Alfa', days: 30, lanes: ['odc', 'o11'], confirm: ' Cliente Alfa ' });
  assert.equal(r.status, 201, 'confirm is trimmed');
  assert.equal(r.body.license.agent.state, 'never');
  assert.ok(Math.abs(r.body.license.daysLeft - 30) < 0.01);
  const rot = await c.post(`/api/licenses/${r.body.license.id}/agent-rotate`, { confirm: 'Cliente Alfa' });
  assert.equal(rot.status, 200);
  assert.notEqual(rot.body.license.agentCredentialIssuedAt, null);
  const stored = JSON.parse(fs.readFileSync(path.join(env.serverDir, 'tokens.json'), 'utf8'));
  assert.equal(stored.schema, 'ssam-server-tokens/1');
  assert.equal(stored.tokens.length, 1);
});
