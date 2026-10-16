import './fixtures/isolated-profile.mjs';
// CX15 r2, G: the token binds the whole preview as written (its items, recomputed, the times, the words seen before it,
// the texts of the server); an edit of the preview file makes the token unknown (PREVIEW_UNKNOWN), nothing is confirmed.
// Offline: a temporary root, a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ops from '../destructive-operations.mjs';

const HOST = 'personal-r2token.outsystemscloud.com';
const T0 = Date.parse('2026-10-15T12:00:00Z');
const ITEMS = [{ kind: 'application', key: 'a-1', name: 'ZZ One', cascade: [], consumers: [] }];

test('G: an edit of the preview file (other items, wordsBefore, expiry, the server texts) makes its token unknown; the file as written confirms', () => {
  const edits = {
    items: p => { p.items = [{ kind: 'application', key: 'a-9', name: 'Producao', cascade: [], consumers: [] }]; },
    'items, listSha256 kept': p => { p.items[0].key = 'a-9'; },
    wordsBefore: p => { p.wordsBefore = []; },
    expiresAt: p => { p.expiresAt = new Date(T0 + 365 * 24 * 3600 * 1000).toISOString(); },
    serverPhrases: p => { p.serverPhrases = []; },
    mustName: p => { p.mustName = []; },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r2-token-'));
    try {
      const block = ops.createPreview({ tool: 'o11_service_center_write', lane: 'o11', host: HOST, operation: 'delete', items: ITEMS, mustName: ['ZZ One'], words: 'apaga o ZZ', now: T0, root });
      const file = path.join(root, 'previews', block.previewId + '.json');
      const confirm = words => ops.checkExecute({ token: block.confirmationToken, tool: 'o11_service_center_write', host: HOST, operation: 'delete', words, now: T0 + 60000, root });
      assert.deepEqual(confirm('sim, pode apagar o 1, ZZ One').problems, [], name + ': the file as written confirms');
      const p = JSON.parse(fs.readFileSync(file, 'utf8')); edit(p); fs.writeFileSync(file, JSON.stringify(p));
      assert.deepEqual(confirm('sim, pode apagar o 1, Producao').problems.map(x => x.code), ['PREVIEW_UNKNOWN'], name);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
