// Tokens of the served MCP with the agent credential of phase 2 (server-tokens.mjs; docs/FASE2-AGENTE.md 2.2 and 9.3):
// both secrets shown once and kept only as SHA-256, verify vs verifyAgent, agent-rotate, revoke kills both, lanes,
// and phase-1 records (no agent fields) still valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTokenStore, tokenCli, parseLanes, AGENT_PREFIX } from '../server-tokens.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-tokens-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => { const d = path.join(tmp, 'dir' + (++n)); fs.mkdirSync(d); return d; };
const hex = text => createHash('sha256').update(text).digest('hex');

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
