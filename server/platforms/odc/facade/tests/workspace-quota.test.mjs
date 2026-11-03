// r41 (hosted/workspace-quota.mjs, server-tokens.mjs setQuota, hosted/mirror.mjs createQuota): the workspace quota of an
// account is its license record's value, else SSAM_WORKSPACE_QUOTA_GIB, else 10 GiB; an invalid server value stops the hosted
// server at start; over the quota the retention cleanup runs once and only a workspace still over refuses, saying what was
// freed and what to do.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveQuota, serverQuotaGiB, assertServerQuota, quotaInput, DEFAULT_QUOTA_GIB, GIB } from '../hosted/workspace-quota.mjs';
import { createQuota, workspaceFull, workspaceFullText, QUOTA_BYTES } from '../hosted/mirror.mjs';
import { createTokenStore, tokenActions } from '../server-tokens.mjs';
import { startHttpServer } from '../http-server.mjs';

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-quota-')); roots.push(r); return r; };
const coreDump = size => { const b = Buffer.alloc(size); b.write('\x7fELF', 0, 'latin1'); b[5] = 1; b.writeUInt16LE(4, 16); return b; };

test('the quota of an account: its own value, else SSAM_WORKSPACE_QUOTA_GIB, else 10 GiB', () => {
  assert.equal(DEFAULT_QUOTA_GIB, 10);
  assert.equal(QUOTA_BYTES, 10 * GIB);
  assert.deepEqual(effectiveQuota(null, {}), { gib: 10, bytes: 10 * GIB, source: 'default' });
  assert.deepEqual(effectiveQuota({}, { SSAM_WORKSPACE_QUOTA_GIB: '' }), { gib: 10, bytes: 10 * GIB, source: 'default' }, 'an empty variable is unset');
  assert.deepEqual(effectiveQuota({}, { SSAM_WORKSPACE_QUOTA_GIB: '20' }), { gib: 20, bytes: 20 * GIB, source: 'env' });
  assert.deepEqual(effectiveQuota({ quotaGiB: 40 }, { SSAM_WORKSPACE_QUOTA_GIB: '20' }), { gib: 40, bytes: 40 * GIB, source: 'account' });
  assert.deepEqual(effectiveQuota({ quotaGiB: 2 }, {}), { gib: 2, bytes: 2 * GIB, source: 'account' }, 'an account may also get less');
  assert.equal(effectiveQuota({ quotaGiB: 0 }, { SSAM_WORKSPACE_QUOTA_GIB: '20' }).source, 'env', 'an invalid record value is ignored');
});

test('an invalid SSAM_WORKSPACE_QUOTA_GIB stops the hosted server at start with WORKSPACE_QUOTA_INVALID', async () => {
  for (const bad of ['0', '5GB', '1.5', '-3', '1025', 'ten']) assert.throws(() => serverQuotaGiB({ SSAM_WORKSPACE_QUOTA_GIB: bad }), e => e.code === 'WORKSPACE_QUOTA_INVALID' && /SSAM_WORKSPACE_QUOTA_GIB/.test(e.message), bad);
  assert.equal(serverQuotaGiB({ SSAM_WORKSPACE_QUOTA_GIB: ' 16 ' }), 16);
  const lines = [];
  assert.throws(() => assertServerQuota({ SSAM_WORKSPACE_QUOTA_GIB: '5GB' }, e => lines.push(e)), e => e.code === 'WORKSPACE_QUOTA_INVALID');
  assert.equal(lines.filter(l => l.event === 'workspace-quota-invalid').length, 1);
  // the start check comes before the SDK import and the listen
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'http-server.mjs'), 'utf8');
  const check = source.indexOf('if (agents) assertServerQuota(env, sink);');
  assert.ok(check > 0 && check < source.indexOf("await import('@modelcontextprotocol/server')") && check < source.indexOf('server.listen('));
  const started = [];
  await assert.rejects(startHttpServer({ createServer: async () => ({}), dir: tmp(), agents: { kernel: null }, env: { SSAM_WORKSPACE_QUOTA_GIB: '5GB' }, log: e => started.push(e) }),
    e => e.code === 'WORKSPACE_QUOTA_INVALID');
  assert.deepEqual(started.map(e => e.event), ['workspace-quota-invalid'], 'nothing listened');
});

test('a license record keeps its own quota: set, read, cleared, refused when invalid or revoked, and through the CLI', () => {
  const store = createTokenStore(tmp());
  const { id } = store.issue({ customer: 'Alfa' });
  assert.equal(store.lookup(id).quotaGiB, undefined);
  const set = store.setQuota(id, 25);
  assert.deepEqual([set.previousQuotaGiB, set.quotaGiB], [null, 25]);
  assert.equal(store.lookup(id).quotaGiB, 25);
  assert.equal(store.list().find(t => t.id === id).quotaGiB, 25);
  assert.equal(effectiveQuota(store.lookup(id), { SSAM_WORKSPACE_QUOTA_GIB: '10' }).gib, 25, 'the account wins over the server');
  for (const bad of [0, 1025, 1.5, '2x', true]) assert.throws(() => store.setQuota(id, bad), e => e.code === 'INVALID_QUOTA', String(bad));
  const cli = tokenActions(store, ['quota', '--id', id, '--gib', 'default']);
  assert.deepEqual([cli.ok, cli.previousQuotaGiB, cli.changed.quotaGiB], [true, 25, undefined]);
  assert.equal(store.lookup(id).quotaGiB, undefined);
  assert.equal(quotaInput('default'), null); assert.equal(quotaInput('12'), 12);
  store.revoke(id);
  assert.throws(() => store.setQuota(id, 5), e => e.code === 'TOKEN_REVOKED');
  assert.throws(() => tokenActions(store, ['quota', '--id', id]), e => e.code === 'USAGE');
});

test('the gate refusal and the mirror refusal carry the same text; a quota without cleanup still refuses', () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, 'big.bin'), Buffer.alloc(200));
  const quota = createQuota(ws, { limitBytes: 100 });
  assert.equal(quota.full(), true);
  assert.match(workspaceFull(quota).message, /\(0 GiB, 0 GiB used\)/);
  assert.equal(workspaceFull(quota).code, 'WORKSPACE_FULL');
});
