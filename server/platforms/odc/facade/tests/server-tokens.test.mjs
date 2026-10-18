// Tokens of the served MCP with the agent credential of phase 2 (server-tokens.mjs; docs/FASE2-AGENTE.md 2.2 and 9.3):
// both secrets shown once and kept only as SHA-256, verify vs verifyAgent, agent-rotate, revoke kills both, lanes,
// and phase-1 records (no agent fields) still valid. The owner console's verbs: renew and setLanes (store and CLI),
// error codes behind unchanged messages, and the writers' lock + atomic replace shared by the CLI and the console.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createTokenStore, tokenCli, parseLanes, AGENT_PREFIX } from '../server-tokens.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-tokens-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => { const d = path.join(tmp, 'dir' + (++n)); fs.mkdirSync(d); return d; };
const hex = text => createHash('sha256').update(text).digest('hex');
const DAY = 86400000;
const T0 = new Date('2026-10-12T12:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const clockAt = start => { let t = start.getTime(); return { now: () => new Date(t), advance: ms => { t += ms; } }; };
const fileOf = dir => path.join(dir, 'tokens.json');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const VIEW_KEYS = ['agent', 'createdAt', 'customer', 'expiresAt', 'id', 'lanes', 'state'];
const RECORD_KEYS = ['agentIssuedAt', 'agentSha256', 'createdAt', 'customer', 'expiresAt', 'id', 'lanes', 'revokedAt', 'sha256'];
const FULL_USAGE = 'Usage: ssam server-token issue --customer <name> [--days N] [--lanes odc,o11] | agent-rotate --id <id> | renew --id <id> --days N | lanes --id <id> --lanes odc,o11 | revoke --id <id> | list';
// Refused with this code and exactly this message.
const refuses = (fn, code, message) => assert.throws(fn, error => { assert.equal(error.code, code); assert.equal(error.message, message); return true; });
// tokens.json parses with the schema, its records carry only known fields, and no lock or temp file is left behind.
function assertSound(dir) {
  const parsed = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
  assert.equal(parsed.schema, 'ssam-server-tokens/1');
  assert.ok(Array.isArray(parsed.tokens));
  for (const t of parsed.tokens) assert.deepEqual(Object.keys(t).filter(k => !RECORD_KEYS.includes(k)), [], 'known fields only');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f !== 'tokens.json'), [], 'no lock or temp file left');
  return parsed.tokens;
}

test('issue shows the MCP token and the agent credential once; tokens.json keeps only their hashes', () => {
  const dir = freshDir();
  const env = { SSAM_SERVER_DIR: dir };
  const issued = tokenCli(['issue', '--customer', 'Cliente Um', '--days', '30'], { root: tmp, env });
  assert.match(issued.token, /^ssam_[A-Za-z0-9_-]{43}$/);
  assert.match(issued.agentCredential, /^ssam_agent_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(issued.agentCredential.slice(AGENT_PREFIX.length), 'base64url').length, 32);
  assert.deepEqual(issued.lanes, ['odc', 'o11'], '--lanes defaults to odc,o11');
  assert.equal(typeof issued.agent.issuedAt, 'string');
  const text = fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8');
  for (const secret of [issued.token, issued.agentCredential]) {
    assert.ok(!text.includes(secret) && !text.includes(secret.slice(AGENT_PREFIX.length)) && !text.includes(secret.slice(5)), 'no plaintext');
    assert.ok(text.includes(hex(secret)), 'its hash');
  }
  const parsed = JSON.parse(text);
  assert.equal(parsed.schema, 'ssam-server-tokens/1');
  assert.deepEqual(Object.keys(parsed.tokens[0]).sort(), ['agentIssuedAt', 'agentSha256', 'createdAt', 'customer', 'expiresAt', 'id', 'lanes', 'sha256']);
  const listed = tokenCli(['list'], { root: tmp, env });
  const shown = JSON.stringify(listed);
  assert.ok(!shown.includes(issued.token) && !shown.includes(issued.agentCredential) && !shown.includes('sha256') && !shown.includes('lastSeenAt'), 'list shows no secret, hash or lastSeenAt');
  assert.deepEqual(listed.tokens[0].agent, { issuedAt: issued.agent.issuedAt });
  assert.deepEqual(listed.tokens[0].lanes, ['odc', 'o11']);
  const odcOnly = tokenCli(['issue', '--customer', 'So ODC', '--lanes', 'odc'], { root: tmp, env });
  assert.deepEqual(odcOnly.lanes, ['odc']);
  assert.deepEqual(tokenCli(['issue', '--customer', 'Ordem', '--lanes', 'o11, ODC,odc'], { root: tmp, env }).lanes, ['odc', 'o11']);
  assert.throws(() => tokenCli(['issue', '--customer', 'X', '--lanes', 'odc,web'], { root: tmp, env }), /lanes/);
  assert.throws(() => tokenCli(['issue', '--customer', 'X', '--lanes'], { root: tmp, env }), /Usage/);
  assert.throws(() => parseLanes(''), /lanes/);
});

test('verifyAgent accepts only the agent credential, verify only the MCP token', () => {
  let clock = new Date();
  const store = createTokenStore(freshDir(), { now: () => clock });
  const issued = store.issue({ customer: 'Agente', days: 1, lanes: ['odc'] });
  const ok = store.verifyAgent(issued.agentCredential);
  assert.deepEqual({ status: ok.status, id: ok.id, customer: ok.customer, lanes: ok.lanes }, { status: 'ok', id: issued.id, customer: 'Agente', lanes: ['odc'] });
  assert.equal(ok.agentSha256, hex(issued.agentCredential));
  assert.equal(store.verify(issued.token).status, 'ok');
  assert.deepEqual(store.verify(issued.token).lanes, ['odc']);
  assert.equal(store.verify(issued.agentCredential).status, 'unknown', 'an agent credential is not an MCP token');
  assert.equal(store.verifyAgent(issued.token).status, 'unknown', 'an MCP token is not an agent credential');
  assert.equal(store.verifyAgent(AGENT_PREFIX + 'A'.repeat(43)).status, 'unknown');
  assert.equal(store.verifyAgent(undefined).status, 'unknown');
  assert.equal(store.verifyAgent(AGENT_PREFIX + 'A'.repeat(300)).status, 'unknown');
  const looked = store.lookup(issued.id);
  assert.deepEqual(looked, { id: issued.id, customer: 'Agente', state: 'active', lanes: ['odc'], credential: true, agentSha256: hex(issued.agentCredential) });
  assert.equal(store.lookup('tok_nope'), null);
  clock = new Date(Date.now() + 2 * 86400000);
  assert.equal(store.verifyAgent(issued.agentCredential).status, 'expired');
});

test('agent-rotate gives a new credential once and the old one stops; the MCP token is untouched', () => {
  const dir = freshDir();
  const env = { SSAM_SERVER_DIR: dir };
  const issued = tokenCli(['issue', '--customer', 'Troca'], { root: tmp, env });
  const before = fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8');
  const rotated = tokenCli(['agent-rotate', '--id', issued.id], { root: tmp, env });
  assert.match(rotated.agentCredential, /^ssam_agent_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(rotated.agentCredential, issued.agentCredential);
  assert.equal(rotated.rotated.id, issued.id);
  assert.ok(!JSON.stringify(rotated.rotated).includes('ssam_'), 'the view carries no secret');
  const store = createTokenStore(dir);
  assert.equal(store.verifyAgent(issued.agentCredential).status, 'unknown', 'the old credential is unknown (401)');
  assert.equal(store.verifyAgent(rotated.agentCredential).status, 'ok');
  assert.equal(store.verify(issued.token).status, 'ok', 'the MCP token still works');
  const after = fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8');
  assert.ok(!after.includes(rotated.agentCredential) && after.includes(hex(rotated.agentCredential)) && !after.includes(hex(issued.agentCredential)));
  assert.notEqual(before, after);
  assert.throws(() => tokenCli(['agent-rotate'], { root: tmp, env }), /Usage/);
  assert.throws(() => tokenCli(['agent-rotate', '--id', 'tok_nope'], { root: tmp, env }), /Unknown token id/);
  tokenCli(['revoke', '--id', issued.id], { root: tmp, env });
  assert.throws(() => tokenCli(['agent-rotate', '--id', issued.id], { root: tmp, env }), /revoked/);
});

test('revoke kills both the MCP token and the agent credential', () => {
  const dir = freshDir();
  const store = createTokenStore(dir);
  const issued = store.issue({ customer: 'Revoga' });
  const other = store.issue({ customer: 'Outro' });
  const result = tokenCli(['revoke', '--id', issued.id], { root: tmp, env: { SSAM_SERVER_DIR: dir } });
  assert.equal(result.revoked.state, 'revoked');
  assert.equal(store.verify(issued.token).status, 'revoked');
  assert.equal(store.verifyAgent(issued.agentCredential).status, 'revoked');
  assert.equal(store.lookup(issued.id).state, 'revoked');
  assert.equal(store.verifyAgent(other.agentCredential).status, 'ok', 'other records unchanged');
});

test('phase-1 records (no agent credential, no lanes) are still valid MCP tokens', () => {
  const dir = freshDir();
  const token = 'ssam_' + 'B'.repeat(43);
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ schema: 'ssam-server-tokens/1', tokens: [
    { id: 'tok_000000000001', customer: 'Fase Um', createdAt: '2026-10-01T00:00:00.000Z', sha256: hex(token) }] }, null, 2));
  const store = createTokenStore(dir);
  assert.deepEqual(store.verify(token), { status: 'ok', id: 'tok_000000000001', customer: 'Fase Um', lanes: ['odc', 'o11'] });
  assert.deepEqual(store.lookup('tok_000000000001'), { id: 'tok_000000000001', customer: 'Fase Um', state: 'active', lanes: ['odc', 'o11'], credential: false, agentSha256: null });
  assert.equal(store.verifyAgent('ssam_agent_' + 'B'.repeat(43)).status, 'unknown');
  const listed = store.list()[0];
  assert.equal(listed.agent, null); assert.deepEqual(listed.lanes, ['odc', 'o11']);
  // An agent credential can be added to a phase-1 record later, without touching its MCP token.
  const rotated = store.agentRotate('tok_000000000001');
  assert.equal(store.verifyAgent(rotated.agentCredential).status, 'ok');
  assert.equal(store.verify(token).status, 'ok');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')).schema, 'ssam-server-tokens/1');
});

test('renew extends an active token from its expiry, and an expired one from now (it is active again at once)', () => {
  const dir = freshDir();
  const clock = clockAt(T0);
  const store = createTokenStore(dir, { now: clock.now });
  const server = createTokenStore(dir, { now: clock.now }); // the running server: another instance with its own cache
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 30 });
  const renewed = store.renew(alfa.id, { days: 10 });
  assert.equal(renewed.previousExpiresAt, iso(T0.getTime() + 30 * DAY));
  assert.equal(renewed.expiresAt, iso(T0.getTime() + 40 * DAY));
  assert.equal(renewed.state, 'active');
  assert.deepEqual(Object.keys(renewed).sort(), ['previousExpiresAt', ...VIEW_KEYS].sort());
  assert.ok(!JSON.stringify(renewed).includes('ssam_'), 'the view carries no secret');
  assert.equal(store.list()[0].expiresAt, renewed.expiresAt);
  assertSound(dir);

  const beta = store.issue({ customer: 'Cliente Beta', days: 1 });
  clock.advance(5 * DAY);
  assert.equal(server.verify(beta.token).status, 'expired');
  assert.equal(server.verifyAgent(beta.agentCredential).status, 'expired');
  const back = store.renew(beta.id, { days: 30 });
  assert.equal(back.previousExpiresAt, iso(T0.getTime() + DAY));
  assert.equal(back.expiresAt, iso(T0.getTime() + 35 * DAY), 'counted from now (T0 + 5 days), not from the old expiry');
  assert.equal(back.state, 'active');
  // Same file size after a renew (ISO dates of the same length): the server still sees it at its next request.
  assert.equal(server.verify(beta.token).status, 'ok');
  assert.equal(server.verifyAgent(beta.agentCredential).status, 'ok');
  assert.equal(server.stateOf(beta.id), 'active');
  assert.equal(server.lookup(beta.id).state, 'active');
  assertSound(dir);
});

test('renew refuses unknown, revoked and no-expiry tokens and days outside 1..3650, writing nothing', () => {
  const dir = freshDir();
  const store = createTokenStore(dir, { now: () => T0 });
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 30 });
  const gama = store.issue({ customer: 'Cliente Gama', days: 30 });
  const delta = store.issue({ customer: 'Cliente Delta' });
  store.revoke(gama.id);
  const before = fs.readFileSync(fileOf(dir), 'utf8');
  refuses(() => store.renew('tok_nope', { days: 30 }), 'UNKNOWN_TOKEN', 'Unknown token id: tok_nope');
  refuses(() => store.renew(gama.id, { days: 30 }), 'TOKEN_REVOKED', `Token ${gama.id} is revoked; issue a new one instead.`);
  refuses(() => store.renew(delta.id, { days: 30 }), 'NO_EXPIRY', `Token ${delta.id} has no expiry; nothing to renew.`);
  for (const days of [0, 3651, 1.5, '30', -1, NaN, Infinity, null, undefined])
    refuses(() => store.renew(alfa.id, { days }), 'INVALID_DAYS', 'days: an integer from 1 to 3650');
  refuses(() => store.renew(alfa.id), 'INVALID_DAYS', 'days: an integer from 1 to 3650');
  assert.equal(fs.readFileSync(fileOf(dir), 'utf8'), before, 'a refused renew writes nothing');
  assert.equal(store.renew(alfa.id, { days: 1 }).expiresAt, iso(T0.getTime() + 31 * DAY), '1 day is allowed');
  assertSound(dir);
});

test('renew caps the new expiry at 3650 days from now', () => {
  const dir = freshDir();
  const clock = clockAt(T0);
  const store = createTokenStore(dir, { now: clock.now });
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 3650 });
  const before = fs.readFileSync(fileOf(dir), 'utf8');
  refuses(() => store.renew(alfa.id, { days: 1 }), 'EXPIRY_TOO_FAR', 'expiry: at most 3650 days from now');
  assert.equal(fs.readFileSync(fileOf(dir), 'utf8'), before);
  clock.advance(10 * DAY);
  const atCap = store.renew(alfa.id, { days: 10 });
  assert.equal(atCap.expiresAt, iso(clock.now().getTime() + 3650 * DAY), 'exactly 3650 days from now is allowed');
  refuses(() => store.renew(alfa.id, { days: 1 }), 'EXPIRY_TOO_FAR', 'expiry: at most 3650 days from now');
  const beta = store.issue({ customer: 'Cliente Beta', days: 1 });
  clock.advance(2 * DAY);
  assert.equal(store.renew(beta.id, { days: 3650 }).expiresAt, iso(clock.now().getTime() + 3650 * DAY), 'an expired token may get the full 3650 days');
  assertSound(dir);
});

test('setLanes changes the lanes of active and expired tokens and verify() answers with them at once', () => {
  const dir = freshDir();
  const clock = clockAt(T0);
  const store = createTokenStore(dir, { now: clock.now });
  const server = createTokenStore(dir, { now: clock.now });
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 30 });
  assert.deepEqual(server.verify(alfa.token).lanes, ['odc', 'o11']);
  const changed = store.setLanes(alfa.id, ['odc']);
  assert.deepEqual(changed.previousLanes, ['odc', 'o11']);
  assert.deepEqual(changed.lanes, ['odc']);
  assert.deepEqual(Object.keys(changed).sort(), ['previousLanes', ...VIEW_KEYS].sort());
  assert.ok(!JSON.stringify(changed).includes('ssam_'));
  assert.deepEqual(store.verify(alfa.token).lanes, ['odc']);
  assert.deepEqual(server.verify(alfa.token), { status: 'ok', id: alfa.id, customer: 'Cliente Alfa', lanes: ['odc'] });
  assert.deepEqual(server.verifyAgent(alfa.agentCredential).lanes, ['odc']);
  assert.deepEqual(server.lookup(alfa.id).lanes, ['odc']);
  assertSound(dir);
  // parseLanes rules: any order and case fold to the canonical order, repeats fold to one.
  const both = store.setLanes(alfa.id, 'O11, odc');
  assert.deepEqual([both.previousLanes, both.lanes], [['odc'], ['odc', 'o11']]);
  assert.deepEqual(store.setLanes(alfa.id, ['o11', 'o11']).lanes, ['o11']);
  assert.deepEqual(server.verify(alfa.token).lanes, ['o11']);
  const beta = store.issue({ customer: 'Cliente Beta', days: 1 });
  clock.advance(2 * DAY);
  const expired = store.setLanes(beta.id, 'o11');
  assert.equal(expired.state, 'expired', 'allowed on an expired token, which stays expired');
  assert.deepEqual(expired.lanes, ['o11']);
  assert.deepEqual(server.verify(beta.token), { status: 'expired', id: beta.id, customer: 'Cliente Beta', lanes: ['o11'] });
  assertSound(dir);
});

test('setLanes refuses invalid or empty lanes and unknown or revoked tokens; the same set writes nothing', () => {
  const dir = freshDir();
  const store = createTokenStore(dir, { now: () => T0 });
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 30 });
  const gama = store.issue({ customer: 'Cliente Gama', days: 30 });
  store.revoke(gama.id);
  const before = fs.readFileSync(fileOf(dir), 'utf8');
  for (const lanes of [['web'], 'odc,web', [], '', ' , ', null, undefined, 5])
    refuses(() => store.setLanes(alfa.id, lanes), 'INVALID_LANES', 'lanes: odc, o11 or odc,o11');
  refuses(() => store.setLanes('tok_nope', ['odc']), 'UNKNOWN_TOKEN', 'Unknown token id: tok_nope');
  refuses(() => store.setLanes(gama.id, ['odc']), 'TOKEN_REVOKED', `Token ${gama.id} is revoked; issue a new one instead.`);
  assert.equal(fs.readFileSync(fileOf(dir), 'utf8'), before);
  const stat = fs.statSync(fileOf(dir));
  sleep(30); // a write now would move the mtime
  const same = store.setLanes(alfa.id, ['o11', 'odc']);
  assert.deepEqual([same.previousLanes, same.lanes, same.id, same.state], [['odc', 'o11'], ['odc', 'o11'], alfa.id, 'active']);
  const after = fs.statSync(fileOf(dir));
  assert.equal(after.mtimeMs, stat.mtimeMs, 'the same set does not write');
  assert.equal(after.ino, stat.ino);
  assert.equal(fs.readFileSync(fileOf(dir), 'utf8'), before);
  assertSound(dir);
  // A phase-1 record (no lanes field) asked for the default set gains no field.
  const phase1 = freshDir();
  const record = { id: 'tok_000000000002', customer: 'Cliente Beta', createdAt: '2026-10-01T00:00:00.000Z', sha256: hex('ssam_' + 'C'.repeat(43)) };
  fs.writeFileSync(fileOf(phase1), JSON.stringify({ schema: 'ssam-server-tokens/1', tokens: [record] }, null, 2));
  const old = createTokenStore(phase1);
  assert.deepEqual(old.setLanes(record.id, 'odc,o11').previousLanes, ['odc', 'o11']);
  assert.deepEqual(assertSound(phase1), [record]);
});

test('server-token renew and lanes: outputs, notes and usage errors', () => {
  const dir = freshDir();
  const env = { SSAM_SERVER_DIR: dir };
  const cli = args => tokenCli(args, { root: tmp, env });
  const issued = cli(['issue', '--customer', 'Cliente Alfa', '--days', '30']);
  const renewed = cli(['renew', '--id', issued.id, '--days', '30']);
  assert.deepEqual(Object.keys(renewed), ['ok', 'renewed', 'previousExpiresAt', 'note']);
  assert.equal(renewed.ok, true);
  assert.equal(renewed.previousExpiresAt, issued.expiresAt);
  assert.equal(Date.parse(renewed.renewed.expiresAt) - Date.parse(issued.expiresAt), 30 * DAY);
  assert.deepEqual(Object.keys(renewed.renewed).sort(), VIEW_KEYS);
  assert.equal(renewed.renewed.state, 'active');
  assert.equal(renewed.note, 'The new expiry holds now. An expired license holds again: the agent reconnects by itself and the client opens new sessions.');
  const changed = cli(['lanes', '--id', issued.id, '--lanes', 'odc']);
  assert.deepEqual(Object.keys(changed), ['ok', 'changed', 'previousLanes', 'note']);
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.previousLanes, ['odc', 'o11']);
  assert.deepEqual(changed.changed.lanes, ['odc']);
  assert.deepEqual(Object.keys(changed.changed).sort(), VIEW_KEYS);
  assert.equal(changed.note, 'It holds for new sessions; the open ones keep the old lanes until they close (60 min unused or a client reconnection).');
  const again = cli(['lanes', '--id', issued.id, '--lanes', 'ODC']);
  assert.deepEqual([again.previousLanes, again.changed.lanes], [['odc'], ['odc']], 'the same set answers ok');
  assert.ok(!JSON.stringify([renewed, changed, again]).includes('ssam_'), 'no secret in the CLI answers');
  assert.deepEqual(cli(['list']).tokens[0].lanes, ['odc']);
  const renewUsage = 'Usage: ssam server-token renew --id <id> --days N';
  const lanesUsage = 'Usage: ssam server-token lanes --id <id> --lanes odc,o11';
  refuses(() => cli(['renew', '--id', issued.id]), 'USAGE', renewUsage);
  refuses(() => cli(['renew', '--days', '30']), 'USAGE', renewUsage);
  refuses(() => cli(['renew', '--id', issued.id, '--days']), 'USAGE', renewUsage);
  refuses(() => cli(['lanes', '--id', issued.id]), 'USAGE', lanesUsage);
  refuses(() => cli(['lanes', '--lanes', 'odc']), 'USAGE', lanesUsage);
  refuses(() => cli(['lanes', '--id', issued.id, '--lanes']), 'USAGE', lanesUsage);
  for (const days of ['abc', '1.5', '0', '3651', ''])
    refuses(() => cli(['renew', '--id', issued.id, '--days', days]), 'INVALID_DAYS', 'days: an integer from 1 to 3650');
  refuses(() => cli(['lanes', '--id', issued.id, '--lanes', 'web']), 'INVALID_LANES', 'lanes: odc, o11 or odc,o11');
  refuses(() => cli(['renew', '--id', 'tok_nope', '--days', '30']), 'UNKNOWN_TOKEN', 'Unknown token id: tok_nope');
  refuses(() => cli(['lanes', '--id', 'tok_nope', '--lanes', 'odc']), 'UNKNOWN_TOKEN', 'Unknown token id: tok_nope');
  const noExpiry = cli(['issue', '--customer', 'Cliente Delta']);
  refuses(() => cli(['renew', '--id', noExpiry.id, '--days', '30']), 'NO_EXPIRY', `Token ${noExpiry.id} has no expiry; nothing to renew.`);
  cli(['revoke', '--id', noExpiry.id]);
  refuses(() => cli(['lanes', '--id', noExpiry.id, '--lanes', 'odc']), 'TOKEN_REVOKED', `Token ${noExpiry.id} is revoked; issue a new one instead.`);
  for (const args of [[], ['nope'], ['--help']]) refuses(() => cli(args), 'USAGE', FULL_USAGE);
  refuses(() => cli(['issue', '--customer', 'Cliente Beta', '--lanes']), 'USAGE', FULL_USAGE);
  refuses(() => cli(['agent-rotate']), 'USAGE', 'Usage: ssam server-token agent-rotate --id <id>');
  refuses(() => cli(['revoke']), 'USAGE', 'Usage: ssam server-token revoke --id <id>');
  assertSound(dir);
});

test('every refusal carries error.code and keeps the message older images used', () => {
  const dir = freshDir();
  const clock = clockAt(T0);
  const store = createTokenStore(dir, { now: clock.now });
  refuses(() => store.issue({ customer: '../x' }), 'INVALID_CUSTOMER', 'customer: 1-64 letters, digits, space, dot, dash or underscore');
  refuses(() => store.issue(), 'INVALID_CUSTOMER', 'customer: 1-64 letters, digits, space, dot, dash or underscore');
  refuses(() => store.issue({ customer: 'Cliente Alfa', days: 0 }), 'INVALID_DAYS', 'days: an integer from 1 to 3650');
  refuses(() => store.issue({ customer: 'Cliente Alfa', days: null }), 'INVALID_DAYS', 'days: an integer from 1 to 3650');
  refuses(() => store.issue({ customer: 'Cliente Alfa', lanes: 'web' }), 'INVALID_LANES', 'lanes: odc, o11 or odc,o11');
  refuses(() => parseLanes(''), 'INVALID_LANES', 'lanes: odc, o11 or odc,o11');
  assert.deepEqual(fs.readdirSync(dir), [], 'refused input touches nothing');
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 1 });
  const beta = store.issue({ customer: 'Cliente Beta' });
  refuses(() => store.agentRotate('tok_nope'), 'UNKNOWN_TOKEN', 'Unknown token id: tok_nope');
  refuses(() => store.revoke('tok_nope'), 'UNKNOWN_TOKEN', 'Unknown token id: tok_nope');
  clock.advance(2 * DAY);
  refuses(() => store.agentRotate(alfa.id), 'TOKEN_NOT_ACTIVE', `Token ${alfa.id} is expired; issue a new one instead.`);
  store.revoke(beta.id);
  refuses(() => store.agentRotate(beta.id), 'TOKEN_NOT_ACTIVE', `Token ${beta.id} is revoked; issue a new one instead.`);
  assert.equal(store.revoke(beta.id).state, 'revoked', 'revoking twice is still not an error');
  assertSound(dir);
  // A file of another schema: readers and writers refuse it, and a writer never replaces a file it cannot read.
  fs.writeFileSync(fileOf(dir), JSON.stringify({ schema: 'other/1', tokens: [] }));
  refuses(() => createTokenStore(dir).list(), 'STORE_INVALID', 'Invalid tokens file: ' + fileOf(dir));
  refuses(() => createTokenStore(dir).renew(alfa.id, { days: 1 }), 'STORE_INVALID', 'Invalid tokens file: ' + fileOf(dir));
  const broken = '{"schema": "ssam-server-tokens/1", "tok';
  fs.writeFileSync(fileOf(dir), broken);
  assert.throws(() => createTokenStore(dir).verify('ssam_' + 'A'.repeat(43)), e => e instanceof SyntaxError && e.code === 'STORE_INVALID');
  assert.throws(() => createTokenStore(dir).issue({ customer: 'Cliente Gama' }), e => e instanceof SyntaxError && e.code === 'STORE_INVALID');
  assert.equal(fs.readFileSync(fileOf(dir), 'utf8'), broken);
  assert.deepEqual(fs.readdirSync(dir), ['tokens.json'], 'the lock is released after a refusal');
});

test('the file parses with the schema after every verb', () => {
  const dir = freshDir();
  const clock = clockAt(T0);
  const store = createTokenStore(dir, { now: clock.now });
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 30, lanes: ['odc'] }); assertSound(dir);
  store.renew(alfa.id, { days: 30 }); assertSound(dir);
  store.setLanes(alfa.id, 'odc,o11'); assertSound(dir);
  store.setLanes(alfa.id, 'odc,o11'); assertSound(dir);
  store.agentRotate(alfa.id); assertSound(dir);
  clock.advance(90 * DAY);
  store.renew(alfa.id, { days: 7 }); assertSound(dir);
  store.revoke(alfa.id); assertSound(dir);
  store.revoke(alfa.id);
  const [record] = assertSound(dir);
  assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS);
  assert.equal(record.expiresAt, iso(T0.getTime() + 97 * DAY));
});

test('writers replace tokens.json through a unique temp file (pid + 8 hex), fsync it and rename it', () => {
  const dir = freshDir();
  const store = createTokenStore(dir);
  const renames = [];
  const synced = [];
  const { renameSync, fsyncSync } = fs;
  fs.renameSync = (from, to) => { renames.push([path.basename(from), path.basename(to)]); return renameSync(from, to); };
  fs.fsyncSync = fd => { synced.push(fd); return fsyncSync(fd); };
  try {
    const alfa = store.issue({ customer: 'Cliente Alfa', days: 30 });
    store.renew(alfa.id, { days: 5 });
    store.setLanes(alfa.id, 'odc');
    store.agentRotate(alfa.id);
    store.revoke(alfa.id);
  } finally { fs.renameSync = renameSync; fs.fsyncSync = fsyncSync; }
  assert.equal(renames.length, 5);
  for (const [from, to] of renames) {
    assert.match(from, new RegExp('^tokens\\.json\\.' + process.pid + '\\.[0-9a-f]{8}\\.tmp$'));
    assert.equal(to, 'tokens.json');
  }
  assert.equal(new Set(renames.map(([from]) => from)).size, renames.length, 'every temp name is new');
  assert.ok(synced.length >= renames.length, 'each temp file is flushed before its rename');
  assertSound(dir);
});

test('a failed write leaves tokens.json as it was, removes its temp file and releases the lock', () => {
  const dir = freshDir();
  const store = createTokenStore(dir);
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 30 });
  const before = fs.readFileSync(fileOf(dir), 'utf8');
  const { renameSync } = fs;
  fs.renameSync = () => { throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' }); };
  try { assert.throws(() => store.renew(alfa.id, { days: 5 }), { code: 'EIO' }); } finally { fs.renameSync = renameSync; }
  assert.equal(fs.readFileSync(fileOf(dir), 'utf8'), before);
  assertSound(dir);
  assert.equal(store.renew(alfa.id, { days: 5 }).state, 'active', 'the next writer gets the lock at once');
});

test('a stale lock (40 s old) is removed once; a fresh one makes a writer wait and give up with STORE_LOCKED', () => {
  const dir = freshDir();
  const store = createTokenStore(dir, { lockWaitMs: 300 });
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 30 });
  const lockFile = fileOf(dir) + '.lock';
  const lockedMessage = 'Tokens file is locked by another writer (' + lockFile + '); try again.';
  const old = new Date(Date.now() - 40000);
  const staleLock = () => { fs.writeFileSync(lockFile, '{"pid":1}\n'); fs.utimesSync(lockFile, old, old); };
  staleLock();
  let started = Date.now();
  assert.deepEqual(store.setLanes(alfa.id, 'odc').lanes, ['odc']);
  assert.ok(Date.now() - started < 1000, 'no wait behind a stale lock');
  assertSound(dir);
  // Only once: a second stale lock appearing right after the first was removed is waited on, not removed.
  staleLock();
  const { unlinkSync } = fs;
  let removed = 0;
  fs.unlinkSync = p => { unlinkSync(p); if (p === lockFile && removed++ === 0) staleLock(); };
  try { refuses(() => store.renew(alfa.id, { days: 1 }), 'STORE_LOCKED', lockedMessage); } finally { fs.unlinkSync = unlinkSync; }
  assert.equal(removed, 1);
  fs.unlinkSync(lockFile);
  // A fresh lock is never removed by a waiter; the file stays untouched.
  fs.writeFileSync(lockFile, '');
  const before = fs.readFileSync(fileOf(dir), 'utf8');
  started = Date.now();
  refuses(() => store.renew(alfa.id, { days: 1 }), 'STORE_LOCKED', lockedMessage);
  assert.ok(Date.now() - started >= 250, 'it waited before giving up');
  assert.ok(fs.existsSync(lockFile));
  assert.equal(fs.readFileSync(fileOf(dir), 'utf8'), before);
  // Readers never take the lock.
  assert.equal(store.list().length, 1);
  assert.equal(store.verify(alfa.token).status, 'ok');
  assert.equal(store.lookup(alfa.id).state, 'active');
  // The contract's wait is 3 s.
  started = Date.now();
  refuses(() => createTokenStore(dir).revoke(alfa.id), 'STORE_LOCKED', lockedMessage);
  const waited = Date.now() - started;
  assert.ok(waited >= 2900 && waited < 6000, `default wait ${waited} ms`);
  fs.unlinkSync(lockFile);
  assertSound(dir);
});

test('a writer waits for a lock held by another process and succeeds once it is released', async () => {
  const dir = freshDir();
  const store = createTokenStore(dir);
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 30 });
  const lockFile = fileOf(dir) + '.lock';
  const holder = spawn(process.execPath, ['-e', [
    "const fs = require('node:fs');",
    "const fd = fs.openSync(process.argv[1], 'wx');",
    "process.stdout.write('held\\n');",
    'setTimeout(() => { fs.closeSync(fd); fs.unlinkSync(process.argv[1]); }, 400);',
  ].join('\n'), lockFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => holder.once('exit', resolve));
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); exited.then(code => reject(new Error('holder exited ' + code))); });
  assert.ok(fs.existsSync(lockFile), 'the other process holds the lock');
  const started = Date.now();
  const changed = store.setLanes(alfa.id, 'o11');
  const waited = Date.now() - started;
  assert.deepEqual(changed.lanes, ['o11']);
  assert.ok(waited >= 150 && waited < 3000, `waited ${waited} ms for the other process`);
  assert.equal(await exited, 0);
  assertSound(dir);
});

test('writers in several processes never lose one another\'s records', async () => {
  const dir = freshDir();
  const moduleUrl = new URL('../server-tokens.mjs', import.meta.url).href;
  const script = [
    'const { createTokenStore } = await import(' + JSON.stringify(moduleUrl) + ');',
    'const store = createTokenStore(process.argv[1]);',
    'for (let i = 0; i < 15; i++) {',
    "  const t = store.issue({ customer: 'Cliente ' + process.argv[2] + ' ' + i, days: 30 });",
    '  if (i % 3 === 0) store.renew(t.id, { days: 1 });',
    "  if (i % 5 === 0) store.setLanes(t.id, 'odc');",
    '}',
  ].join('\n');
  const run = name => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, name], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('writer ' + name + ' exited ' + code + ': ' + stderr)));
  });
  await Promise.all(['Alfa', 'Beta', 'Gama'].map(run));
  const tokens = assertSound(dir);
  assert.equal(tokens.length, 45);
  assert.equal(new Set(tokens.map(t => t.id)).size, 45);
  for (const name of ['Alfa', 'Beta', 'Gama']) {
    const mine = tokens.filter(t => t.customer.startsWith('Cliente ' + name + ' '));
    assert.equal(mine.length, 15);
    assert.equal(mine.filter(t => t.lanes.length === 1).length, 3, 'every lanes change kept');
    assert.equal(mine.filter(t => Date.parse(t.expiresAt) - Date.parse(t.createdAt) === 31 * DAY).length, 5, 'every renew kept');
  }
});

test('a writer re-reads the file inside the lock even when the cache stamp did not move', () => {
  const dir = freshDir();
  const store = createTokenStore(dir, { now: () => T0 });
  const alfa = store.issue({ customer: 'Cliente Alfa', days: 30 });
  const beta = store.issue({ customer: 'Cliente Beta', days: 30 });
  const file = fileOf(dir);
  const whole = new Date('2026-10-12T00:00:00.000Z');
  fs.utimesSync(file, whole, whole);
  assert.equal(store.list().length, 2); // the cache now holds this content under this stamp
  // Another writer changes Beta in place, keeping the inode, the size and the mtime: the worst case for the stamp.
  const text = fs.readFileSync(file, 'utf8');
  const edited = text.replace('"customer": "Cliente Beta"', '"customer": "Cliente Bota"');
  assert.equal(edited.length, text.length);
  fs.writeFileSync(file, edited);
  fs.utimesSync(file, whole, whole);
  assert.equal(store.list().find(t => t.id === beta.id).customer, 'Cliente Beta', 'readers trust the unchanged stamp');
  store.renew(alfa.id, { days: 1 });
  const after = createTokenStore(dir).list();
  assert.equal(after.find(t => t.id === beta.id).customer, 'Cliente Bota', 'the writer kept the change it could not see in its cache');
  assert.equal(after.find(t => t.id === alfa.id).expiresAt, iso(T0.getTime() + 31 * DAY));
  assertSound(dir);
});
