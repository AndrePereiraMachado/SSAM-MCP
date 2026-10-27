// R1 (plano 24/10): ssam_code write takes fix:"apply" over the nextBasedOn of a refused o11 write and hands it to o11_deliver.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeCall } from '../ssam-code.mjs';

const BASE = { job: 'C:\\lane\\jobs\\inline\\x.json', sha256: 'a'.repeat(64) };

test('fix "apply" goes to o11_deliver or studio_deliver with its basedOn (and a patch of the caller after it); a missing basedOn is refused', () => {
  assert.deepEqual(writeCall({ lane: 'o11', module: 'Orders', fix: 'apply', basedOn: BASE }), { tool: 'o11_deliver', arguments: { module: 'Orders', fix: 'apply', basedOn: BASE } });
  const patch = [{ op: 'replace', path: 'actions/A/name', value: 'B' }];
  assert.deepEqual(writeCall({ lane: 'o11', module: 'Orders', fix: 'apply', basedOn: BASE, patch, authorize: 'sim' }).arguments, { module: 'Orders', authorize: 'sim', fix: 'apply', basedOn: BASE, patch });
  assert.deepEqual(writeCall({ lane: 'odc', module: 'Orders', fix: 'apply', basedOn: BASE, feature: 'F', owners: ['A'], changes: ['c'] }),
    { tool: 'studio_deliver', arguments: { module: 'Orders', feature: 'F', owners: ['A'], changes: ['c'], fix: 'apply', basedOn: BASE } });
  assert.equal(writeCall({ lane: 'o11', module: 'Orders', fix: 'apply' }).refusal.code, 'INPUT_INVALID');
});
