import './fixtures/isolated-profile.mjs';
// CX15 r3, BYPASS-2 (F1.2): odc_write PATCH with a non-empty *ToRemove list (userKeysToRemove of /groups/{key}/users,
// applicationRoleKeysToRemove of /groups/{key}/application-roles, and any other *ToRemove field of the catalog) removes N
// members or roles in ONE call: it is destructive now. Without the token it is a preview with the count and the keys (and
// names) that leave, and nothing is sent, even with words and a new operationUuid; the owner's reply with the number and
// the names sends ONE PATCH; the receipt keeps the removed keys. *ToAdd alone stays a mutation (one call, as before).
// The real OdcAccess over a fake ODC Studio bridge, through the MCP SDK. Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { r3OdcWorld, HOST, GROUP, USERS, ROLES } from './fixtures/r3-odc-world.mjs';
import { readOperation } from '../destructive-operations.mjs';
import { effectOf } from '../../portal/runtime/effects.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MEMBERS = 'user-access-management-api-v1:patch:/groups/{key}/users';
const ROLES_OF_GROUP = 'user-access-management-api-v1:patch:/groups/{key}/application-roles';
const [ANA, BIA, CAIO, DUDA] = Object.keys(USERS);
const [LEITOR, EDITOR] = Object.keys(ROLES);
const codes = answer => (answer.problems ?? []).map(p => p.code);
const patches = w => w.writes.filter(x => x.method === 'PATCH');

test('BYPASS-2: PATCH userKeysToRemove (3 keys) previews the count and the names and sends 0 PATCH, even with words and a new operationUuid; the owner\'s reply with 3 and the names sends ONE PATCH; the receipt keeps the keys', async () => {
  const w = await r3OdcWorld();
  try {
    const body = { userKeysToAdd: [], userKeysToRemove: [ANA, BIA, CAIO] };
    // The call of the review: words that name nothing and a new operationUuid, no token.
    const first = await w.call('odc_write', { tenant: HOST, operationId: MEMBERS, path: { key: GROUP }, body, authorize: 'pode tirar eles do grupo', operationUuid: crypto.randomUUID() });
    assert.deepEqual(patches(w), [], 'no PATCH reached the tenant: ' + JSON.stringify(first).slice(0, 400));
    assert.equal(first.code, 'CONFIRMATION_REQUIRED', JSON.stringify(first).slice(0, 600));
    assert.equal(first.sent, false);
    assert.equal(first.count, 3);
    assert.deepEqual(first.items.map(i => [i.key, i.name]), [[ANA, 'ZZAna'], [BIA, 'ZZBia'], [CAIO, 'ZZCaio']]);
    assert.ok(first.items.every(i => i.application === 'ZZOps'), 'the group is the parent of every key that leaves');
    assert.deepEqual(first.removes.keys, { userKeysToRemove: [ANA, BIA, CAIO] });
    assert.ok(first.confirmationToken && first.operationId);
    // A preview without words (the documented first call) is the same list.
    const preview = await w.call('odc_write', { tenant: HOST, operationId: MEMBERS, path: { key: GROUP }, body });
    assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 400));
    assert.equal(preview.count, 3);
    assert.deepEqual(patches(w), []);
    w.wait();
    const args = { ...preview.continuation.arguments };
    assert.deepEqual([args.confirmationToken, args.operationUuid, args.body], [preview.confirmationToken, preview.operationId, body]);
    // The count without the names: one refusal, nothing sent, the token stays usable.
    const unnamed = await w.call('odc_write', { ...args, authorize: 'sim, pode tirar os 3 do ZZOps' });
    assert.ok(codes(unnamed).includes('WORDS_MUST_NAME'), JSON.stringify(unnamed).slice(0, 600));
    assert.deepEqual(patches(w), []);
    // The owner's reply with the number and the names: one PATCH, the previewed body.
    const done = await w.call('odc_write', { ...args, authorize: 'confirmo os 3: ZZCaio, ZZAna e ZZBia saem do ZZOps' });
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 600));
    assert.equal(patches(w).length, 1);
    assert.equal(patches(w)[0].route, `/api/identity/v1/groups/${GROUP}/users`);
    assert.deepEqual(patches(w)[0].body, body);
    const record = readOperation(preview.operationId, { root: w.root });
    assert.equal(record.state, 'completed');
    assert.deepEqual(record.items.map(i => i.key).sort(), [ANA, BIA, CAIO].sort());
    const receipt = w.receipts().find(r => r.operationUuid === preview.operationId);
    assert.ok(receipt, 'the receipt of the PATCH');
    assert.deepEqual(receipt.removes, { userKeysToRemove: [ANA, BIA, CAIO] }, 'the receipt keeps the removed keys');
  } finally { await w.close(); }
});

test('BYPASS-2: applicationRoleKeysToRemove previews the role names; *ToAdd alone stays a mutation (one call, one PATCH)', async () => {
  const w = await r3OdcWorld();
  try {
    const roles = await w.call('odc_write', { tenant: HOST, operationId: ROLES_OF_GROUP, path: { key: GROUP }, body: { applicationRoleKeysToAdd: [], applicationRoleKeysToRemove: [LEITOR, EDITOR] } });
    assert.equal(roles.state, 'previewed', JSON.stringify(roles).slice(0, 400));
    assert.deepEqual(roles.items.map(i => i.name), ['ZZRoleLeitor', 'ZZRoleEditor']);
    assert.equal(roles.count, 2);
    assert.deepEqual(patches(w), []);
    // *ToAdd only: as before, one call with the owner's words and a new operationUuid.
    const add = await w.call('odc_write', { tenant: HOST, operationId: MEMBERS, path: { key: GROUP }, body: { userKeysToAdd: [DUDA], userKeysToRemove: [] }, authorize: 'pode adicionar a ZZDuda ao ZZOps', operationUuid: crypto.randomUUID() });
    assert.equal(add.ok, true, JSON.stringify(add).slice(0, 400));
    assert.equal(add.confirmationToken, undefined);
    assert.equal(patches(w).length, 1);
    assert.equal(add.effect, 'mutation');
  } finally { await w.close(); }
});

test('BYPASS-2 (family): every *ToRemove field of the catalog makes its write destructive when the list is not empty, and only then', () => {
  const catalog = new Catalog();
  const raw = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'portal', 'catalog', 'catalog.json'), 'utf8'));
  const found = [];
  for (const api of raw.apis) {
    const spec = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'portal', 'catalog', api.specFile), 'utf8'));
    const schemas = spec.components?.schemas ?? {};
    for (const [route, methods] of Object.entries(spec.paths ?? {})) for (const [method, op] of Object.entries(methods)) {
      if (!['post', 'put', 'patch'].includes(method)) continue;
      const refs = [...JSON.stringify(op.requestBody ?? {}).matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map(m => m[1]);
      for (const ref of new Set(refs)) for (const field of Object.keys(schemas[ref]?.properties ?? {}).filter(f => /ToRemove$/.test(f))) {
        const id = `${api.id}:${method}:${route}`;
        found.push(`${id} ${field}`);
        const { operation } = catalog.get(id);
        assert.equal(effectOf(operation, { [field]: [crypto.randomUUID()] }), 'destructive', id + ' ' + field);
        assert.notEqual(effectOf(operation, { [field]: [] }), 'destructive', id + ' ' + field + ' empty');
        assert.notEqual(effectOf(operation, { [field]: null }), 'destructive', id + ' ' + field + ' null');
      }
    }
  }
  assert.deepEqual(found.sort(), [`${ROLES_OF_GROUP} applicationRoleKeysToRemove`, `${MEMBERS} userKeysToRemove`].sort());
});

test('BYPASS-2: writeIsDestructive (the destructive(args) callback of destructivePhase for odc_write) reads the *ToRemove lists', async () => {
  const { writeIsDestructive } = await import('../../portal/runtime/effects.mjs');
  const { destructivePhase } = await import('../destructive-operations.mjs');
  const catalog = new Catalog();
  const destructive = args => writeIsDestructive(catalog, args);
  const removal = { operationId: MEMBERS, path: { key: GROUP }, body: { userKeysToAdd: [], userKeysToRemove: [ANA] } };
  assert.equal(destructive(removal), true);
  assert.equal(destructive({ ...removal, body: { userKeysToAdd: [ANA], userKeysToRemove: [] } }), false);
  assert.equal(destructive({ operationId: 'asset-repository-api-v1:delete:/assets/{assetKey}', path: { assetKey: GROUP } }), true);
  assert.equal(destructive({ operationId: 'no-such-operation' }), false);
  assert.equal(destructivePhase('odc_write', removal, { destructive }), 'preview');
  assert.equal(destructivePhase('odc_write', { ...removal, confirmationToken: 'synthetic.token' }, { destructive }), 'execute');
  assert.equal(destructivePhase('odc_write', { ...removal, body: { userKeysToAdd: [ANA] } }, { destructive }), null);
});
