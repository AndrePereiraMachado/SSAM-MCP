// Atritos 3, lane fa, C34: the Portal log read keeps a valid page. Replay of LF-13 (2026-10-06): the server caps the page
// to 50 rows when 100 were asked, and a row falls 1 s after the window (server rounding); both refused the whole page with
// PORTAL_RESPONSE_SCOPE_MISMATCH. Now the server's Limit is accepted with the requested Offset (serverLimit, the next page
// from the server's values) and a row out of scope leaves the answer, counted. Fake broker; no network, no Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PortalReadAdapter } from '../runtime/portal-read.mjs';

const origin = 'https://tenant.example.test';
const query = { environmentKey: 'stage-x', applicationKey: 'app-x', since: '2026-09-14T12:00:00Z', until: '2026-09-14T13:00:00Z' };
const row = (id, time = '2026-09-14T12:30:00Z') => ({ LogId: id, Severity: 'Error', Message: 'message ' + id, TraceId: 't', ApplicationKey: 'app-x', Time: time });
const run = async (data, input) => {
  const broker = { target: 'odc3', origin, async readScreenservice() { return { target: 'odc3', origin, body: { data } }; } };
  return new PortalReadAdapter({ target: 'odc3', origin, broker }).execute({ operationId: 'monitoring.errors', input: { ...query, ...input } });
};

test('C34: the server Limit 50 for 100 asked, with a row 1 s after the window: ok with 2 rows, droppedOutOfScope 1, serverLimit 50', async () => {
  const result = await run({ LogsList: { List: [row('a'), row('b'), row('c', '2026-09-14T13:00:01Z')] },
    LogSearch_Page: { Limit: '50', Offset: '0', NextPageOffset: '50', TotalPages: '3', TotalResults: '120' } }, { limit: 100, offset: 0 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.rows.map(r => r.LogId), ['a', 'b']);
  assert.equal(result.droppedOutOfScope, 1);
  assert.equal(result.serverLimit, 50);
  assert.equal(result.nextPageAvailable, true, 'the next page from the server values (offset 50)');
  assert.equal(JSON.stringify(result).includes('message c'), false, 'the row out of scope is never exposed');
});

test('C34: the server cap alone is accepted; a larger Limit or another Offset is still a scope the request never asked', async () => {
  const capped = await run({ LogsList: { List: [row('a'), row('b')] }, LogSearch_Page: { Limit: '50', Offset: '0', NextPageOffset: '-1', TotalPages: '1', TotalResults: '2' } }, { limit: 100, offset: 0 });
  assert.equal(capped.ok, true); assert.equal(capped.droppedOutOfScope, undefined); assert.equal(capped.serverLimit, 50); assert.equal(capped.nextPageAvailable, false);
  for (const page of [{ Limit: '200', Offset: '0' }, { Limit: '50', Offset: '10' }]) {
    const refused = await run({ LogsList: { List: [row('a')] }, LogSearch_Page: { NextPageOffset: '-1', TotalPages: '1', TotalResults: '1', ...page } }, { limit: 100, offset: 0 });
    assert.equal(refused.error.code, 'PORTAL_RESPONSE_SCOPE_MISMATCH', JSON.stringify(page));
  }
});
