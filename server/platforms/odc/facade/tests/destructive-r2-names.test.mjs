import './fixtures/isolated-profile.mjs';
// CX15 r2, M: the odc_* guard takes the target as named only by a WHOLE word of the owner's reply (as the O11 lane does):
// "OtherLib" does not name the asset Lib. Offline: a fake ODC access under the guard, a temporary root, a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardedAccess } from '../../portal/runtime/destructive-preview.mjs';
import { CONFIRM_MIN_AGE_MS } from '../destructive-operations.mjs';

const TENANT = 'personal-r2names.outsystems.dev';
const ASSET = '7d1c4f2a-0b6e-4c55-9a51-2f6b8d9e1a11';

test('M: the owner\'s reply names the asset as a whole word; a longer word that contains the name does not delete it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r2-names-'));
  try {
    const sends = []; let at = Date.parse('2026-10-15T12:00:00Z');
    const access = {
      pickTenant: async tenant => tenant ?? TENANT,
      tenantInfo: host => ({ host, known: true, class: 'personal', readOnly: false, label: null }),
      resolvePublic: async (host, auth) => ({ path: auth === 'api-client' ? 'vault' : 'studio', host }),
      apiClientAvailable: async () => false,
      dependentsOf: async () => ({ ok: true, name: 'Lib', consumers: [], checkedEnvironments: ['dev'], includesPublishingDefault: true }),
      read: async ({ path: p = {} }) => (p.assetKey === ASSET ? { ok: true, status: 200, data: { assetKey: ASSET, name: 'Lib', revision: 2, assetType: 'Library' } } : { ok: false, status: 404 }),
      receipts: { lookup: () => null },
      assetDelete: async input => { sends.push(input); return { ok: true, receipt: { operationUuid: input.operationUuid, state: 'confirmed' } }; },
    };
    const guarded = guardedAccess(access, { now: () => at, root });
    const preview = await guarded.assetDelete({ tenant: TENANT, assetKey: ASSET });
    at += CONFIRM_MIN_AGE_MS + 1000;
    const run = authorize => guarded.assetDelete({ tenant: TENANT, assetKey: ASSET, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize });
    const other = await run('sim, apaga o 1 OtherLib');
    assert.ok((other.problems ?? []).some(p => p.code === 'DESTRUCTIVE_TARGET_NOT_NAMED'), JSON.stringify(other).slice(0, 300));
    assert.deepEqual(sends, [], 'nothing sent');
    const named = await run('sim, pode apagar o 1, Lib');
    assert.equal(named.ok, true, JSON.stringify(named).slice(0, 300));
    assert.equal(sends.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
