import './fixtures/isolated-profile.mjs';
// CX15 r3, N3 (F4.2), with the provisional decision "strict" kept: the cleanups of own fixtures whose approvals bound the
// WORDS and MESSAGE of the creation had no path through the MCP (those words were said before any list and carry no
// count). Now, after the odc_* guard validated the owner's reply to the preview, ONE helper (owned-cleanup-approval.mjs)
// accepts a NEW approval of that reply whose proposal is the preview file, bound to the creation receipt of THIS target.
// End to end through the MCP SDK and the real OdcAccess (fake ODC Studio bridge): the owned-consumer delete (an asset and
// the app that consumes it, both created by SSAM) previews, the owner's reply with the count deletes once; an origin of
// another target is refused; the r1 scenario F (an approval of an own fixture with the words of the request, said before
// the list, no number) deletes nothing. Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { r3OdcWorld, HOST, LIB } from './fixtures/r3-odc-world.mjs';
import { previewFile } from '../destructive-operations.mjs';
import { consumerSetHash } from '../../portal/runtime/owned-consumer-deletion-approval.mjs';

const APP = '8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c51';
const ASSET_CREATE = 'asset-repository-api-v1:post:/assets', DELETE = 'asset-repository-api-v1:delete:/assets/{assetKey}';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const codes = answer => (answer.problems ?? []).map(p => p.code);
const deletes = w => w.writes.filter(x => x.method === 'DELETE');
const CREATION_WORDS = 'sim, pode criar a ZZScratchLib e a ZZScratchApp para o teste';
const CONSUMERS = [{ key: APP, name: 'ZZScratchApp', type: 'App', revision: 3 }];

// The world: ZZScratchLib consumed by ZZScratchApp; both created by SSAM (receipts of ASSET_CREATE with the creation's
// words and message), looked up by the access's journal.
async function owned() {
  const w = await r3OdcWorld({ extraAssets: { [APP]: { assetKey: APP, name: 'ZZScratchApp', revision: 3, assetType: 'App' } }, consumers: { [LIB]: CONSUMERS } });
  const source = { kind: 'human-conversation', threadId: crypto.randomUUID(), messageId: crypto.randomUUID(), question: 'Create the synthetic fixtures?' };
  const creationProposal = path.join(w.dir, 'creation-proposal.md'); fs.writeFileSync(creationProposal, 'Synthetic fixtures ZZScratchLib and ZZScratchApp');
  const origins = { [LIB]: crypto.randomUUID(), [APP]: crypto.randomUUID() };
  const receipts = Object.fromEntries(Object.entries(origins).map(([key, id]) => [id, { operationUuid: id, state: 'confirmed', status: 201,
    identity: { kind: 'odc-public', tenant: HOST, operationId: ASSET_CREATE, target: {} }, response: { assetKey: key },
    authorization: { wordsSha256: sha(CREATION_WORDS), proposalSha256: sha(fs.readFileSync(creationProposal)), source } }]));
  const lookup = w.access.receipts.lookup.bind(w.access.receipts);
  w.access.receipts.lookup = (id, ...rest) => receipts[String(id).toLowerCase()] ?? lookup(id, ...rest);
  // An approval: words, its proposal file and the owned origins (by asset key).
  w.approval = ({ words, proposal, ownedAssetOrigins = origins, sourceOf = source }) => {
    const file = path.join(w.dir, 'approval-' + crypto.randomUUID() + '.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', words, source: sourceOf,
      proposal: { file: proposal, sha256: sha(fs.readFileSync(proposal)) },
      scope: [{ lane: 'odc', host: HOST, operation: DELETE, targets: ['ZZScratchLib', 'ZZScratchApp'] }],
      constraints: { allowOwnedConsumerBreakage: true, producerAssetKey: LIB, consumerSetSha256: consumerSetHash(CONSUMERS), ownedAssetOrigins } }));
    return file;
  };
  w.origins = origins; w.creationProposal = creationProposal; w.source = source;
  return w;
}

test('N3 (owned consumers): preview -> the owner\'s reply with the count, in a new approval whose proposal is the preview -> one DELETE; the creation\'s words are not needed', async () => {
  const w = await owned();
  try {
    const preview = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB });
    assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 400));
    assert.deepEqual(preview.items.map(i => [i.name, i.consumers]), [['ZZScratchLib', ['ZZScratchApp']]]);
    w.wait();
    const reply = 'sim, pode apagar o 1: ZZScratchLib, mesmo quebrando a ZZScratchApp';
    const file = w.approval({ words: reply, proposal: previewFile(preview.previewId, { root: w.root }), sourceOf: { ...w.source, messageId: crypto.randomUUID() } });
    const done = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: reply, authorizationContext: file });
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 700));
    assert.equal(deletes(w).length, 1);
    assert.equal(deletes(w)[0].route, '/api/asset-repository/v1/assets/' + LIB);
  } finally { await w.close(); }
});

test('N3 (owned consumers): an origin of another target, or a new approval whose proposal is not the preview, is refused; nothing is deleted', async () => {
  const w = await owned();
  try {
    const preview = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB });
    w.wait();
    const replies = ['sim, pode apagar o 1: ZZScratchLib (quebra a ZZScratchApp)', 'confirmo o 1, ZZScratchLib, mesmo com a ZZScratchApp', 'ok, o 1: ZZScratchLib e azar da ZZScratchApp'];
    // The origin of the asset is a receipt of ANOTHER asset (its response names another key).
    const foreign = crypto.randomUUID();
    const lookup = w.access.receipts.lookup;
    w.access.receipts.lookup = (id, ...rest) => (String(id).toLowerCase() === foreign ? { operationUuid: foreign, state: 'confirmed', status: 201,
      identity: { kind: 'odc-public', tenant: HOST, operationId: ASSET_CREATE, target: {} }, response: { assetKey: crypto.randomUUID() }, authorization: {} } : lookup(id, ...rest));
    const alien = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: replies[0],
      authorizationContext: w.approval({ words: replies[0], proposal: previewFile(preview.previewId, { root: w.root }), ownedAssetOrigins: { [LIB]: foreign, [APP]: w.origins[APP] } }) });
    assert.notEqual(alien.ok, true);
    assert.equal(alien.error?.code ?? alien.code, 'AUTHORIZATION_CONTEXT_INVALID', JSON.stringify(alien).slice(0, 500));
    // A new token is needed after an execution that went to the access: a new preview.
    w.wait();
    const second = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB });
    w.wait();
    // The proposal of the new approval is the creation's proposal, not the preview the owner was shown.
    const other = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: second.confirmationToken, operationUuid: second.operationId, authorize: replies[1],
      authorizationContext: w.approval({ words: replies[1], proposal: w.creationProposal }) });
    assert.notEqual(other.ok, true);
    assert.equal(other.error?.code ?? other.code, 'AUTHORIZATION_CONTEXT_INVALID', JSON.stringify(other).slice(0, 500));
    assert.deepEqual(deletes(w), [], 'nothing deleted');
  } finally { await w.close(); }
});

test('N3 keeps F of r1: an approval of an own fixture with the words of the request (said before the list, no number) deletes nothing', async () => {
  const w = await owned();
  try {
    const request = 'ok apaga a ZZScratchLib';
    const preview = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, authorize: request });
    assert.equal(preview.code, 'CONFIRMATION_REQUIRED');
    w.wait();
    const file = w.approval({ words: request, proposal: previewFile(preview.previewId, { root: w.root }) });
    const done = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: request, authorizationContext: file });
    assert.notEqual(done.ok, true);
    assert.deepEqual(codes(done).filter(c => ['CONFIRMATION_COUNT_MISMATCH', 'WORDS_BEFORE_PREVIEW'].includes(c)).sort(), ['CONFIRMATION_COUNT_MISMATCH', 'WORDS_BEFORE_PREVIEW']);
    // The creation's own words, in an approval of the creation's proposal: refused by the guard as well.
    const creation = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: CREATION_WORDS,
      authorizationContext: w.approval({ words: CREATION_WORDS, proposal: w.creationProposal }) });
    assert.notEqual(creation.ok, true);
    assert.deepEqual(deletes(w), []);
  } finally { await w.close(); }
});

test('N3: the tools of the own-fixture cleanups say how the cleanup is confirmed after the preview (a new approval of the owner\'s reply, the preview as its proposal)', async () => {
  const { OWNED_CLEANUP } = await import('../../portal/runtime/owned-cleanup-approval.mjs');
  const w = await r3OdcWorld();
  try {
    const { tools } = await w.client.listTools();
    for (const name of ['odc_a2a_connection_delete', 'odc_asset_delete', 'odc_portal_write']) assert.ok(tools.find(t => t.name === name)?.description.includes(OWNED_CLEANUP), name);
  } finally { await w.close(); }
});
