import './fixtures/isolated-profile.mjs';
// CX15 r3, what the subagents left for the common files: the catalog says the two new rules of the ODC guard (BYPASS-2: a
// PATCH with a non-empty *ToRemove list is a delete in two calls, naming the group and every key; N3: an own fixture's
// cleanup is confirmed by a NEW approval of the preview, bound to this target's creation receipt), and the summary of an
// operation (ssam_task {}, every answer's `operation`) says a cancellation that met a send in flight and the local failure
// that ended it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginOperation, createPreview, endOperation, readPreview, summarizeOperation } from '../destructive-operations.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = JSON.parse(fs.readFileSync(path.resolve(here, '..', 'catalog', 'tools.json'), 'utf8')).tools;

test('BYPASS-2 in the catalog: odc_write says a PATCH whose *ToRemove list is not empty is destructive, naming the group and every key', () => {
  const text = tools.odc_write.preconditions.join(' ');
  assert.match(text, /PATCH whose \*ToRemove list is not empty/);
  assert.match(text, /userKeysToRemove/);
  assert.match(text, /applicationRoleKeysToRemove/);
  assert.match(text, /the group and every key that leaves/);
});

test('N3 in the catalog: the five own-fixture cleanups say how they are confirmed after the preview', () => {
  const routes = {
    odc_a2a_connection_delete: tools.odc_a2a_connection_delete.preconditions,
    odc_asset_delete: tools.odc_asset_delete.preconditions,
    'odc_portal_write apiClients.delete': tools.odc_portal_write.verbs['apiClients.delete'].preconditions,
    'odc_external_library discard': tools.odc_external_library.verbs.discard.preconditions,
  };
  for (const [route, preconditions] of Object.entries(routes)) {
    const text = preconditions.join(' ');
    // CX15 r4 (W-3, converted): the file binds the reply by its wordsSha256 and never keeps the words (before: "whose words
    // are the owner's reply").
    assert.match(text, /a NEW approval whose wordsSha256 is the sha256 \(64 hex of the UTF-8 bytes\) of the owner's reply to the preview exactly as it goes in authorize \(the file never keeps the words\) and whose proposal is the preview file/, route);
    assert.match(text, /bound to the creation receipt of this target; the creation's words and message are not needed/, route);
  }
});

test('the summary of an operation says cancelRequestedAt and the local failure that ended it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r3-followups-'));
  const T0 = Date.parse('2026-10-15T12:00:00Z');
  const block = createPreview({ tool: 'odc_asset_delete', lane: 'odc', host: 'personal-r3f.outsystems.dev', operation: 'asset-delete', items: [{ kind: 'asset', key: 'k', name: 'ZZSynth Lib' }], now: T0, root });
  const record = beginOperation({ preview: readPreview(block.previewId, { root }), now: T0 + 6000, root });
  endOperation(record, 'uncertain', { now: T0 + 7000, root, cancelRequestedAt: new Date(T0 + 6500).toISOString(), localFailure: 'EPERM' });
  const summary = summarizeOperation(record, { root });
  assert.equal(summary.cancelRequestedAt, new Date(T0 + 6500).toISOString());
  assert.equal(summary.localFailure, 'EPERM');
});
