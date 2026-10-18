import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PortalReadAdapter } from '../runtime/portal-read.mjs';

test('native empty page preserves request bounds; mismatches and foreign rows remain refused', async () => {
  const input = { environmentKey: 'dev-stage', applicationKey: 'quotes-app', since: '2026-10-05T16:10:45Z',
    until: '2026-10-05T16:12:00Z', search: 'Ação SSAMDbg', limit: 25, offset: 0 };
  const empty = { Limit: '0', Offset: '0', NextPageOffset: '0', TotalPages: '0', TotalResults: '0' };
  const origin = 'https://example.test';
  let data, observed;
  const adapter = new PortalReadAdapter({ target: 'odc3', origin, broker: { target: 'odc3', origin,
    async readScreenservice(request) { observed = request; return { target: 'odc3', origin, body: { data } }; } } });
  data = { LogsList: { List: [] }, LogSearch_Page: empty };
  const result = await adapter.execute({ operationId: 'monitoring.errors', input });
  assert.equal(result.ok, true);
  assert.equal(result.paginationSemantics, 'native-empty-page');
  assert.deepEqual(result.requestedPage, { limit: 25, offset: 0 });
  assert.equal(result.pagination.Limit, 0);
  assert.equal(result.nextPageAvailable, false);
  assert.equal(observed.clientVariables.LogListSearchKeyword, Buffer.from(input.search, 'utf8').toString('base64'));
  assert.equal('LogsSearchKeyword' in observed.clientVariables, false);
  const row = { ApplicationKey: input.applicationKey, Severity: 'Error', Time: '2026-10-05T16:11:00Z', Message: 'withheld technical text' };
  for (const rows of [[row], [], [{ ...row, ApplicationKey: 'foreign-app' }], [{ ...row, Severity: 'Information' }], [{ ...row, Time: '2026-10-05T16:20:00Z' }]]) {
    data = { LogsList: { List: rows }, LogSearch_Page: rows.length ? empty : { ...empty, Limit: '100' } };
    const refused = await adapter.execute({ operationId: 'monitoring.errors', input });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'PORTAL_RESPONSE_SCOPE_MISMATCH');
    assert.equal(JSON.stringify(refused).includes(row.Message), false);
    assert.equal('rows' in refused, false);
  }
  data = { LogsList: { List: [row] }, LogSearch_Page: { ...empty, Limit: '25', TotalPages: '1', TotalResults: '1' } };
  assert.equal((await adapter.execute({ operationId: 'monitoring.errors', input })).paginationSemantics, 'bounded-page');
});
