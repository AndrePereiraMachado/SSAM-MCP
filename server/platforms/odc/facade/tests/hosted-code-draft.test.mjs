// servidor/fase4-27 a11: the ssam_code drafts of the proto line (R2, code-draft.mjs) on the hosted line. A draft is the
// customer's data: hosted, it lives in the customer's own workspace (<ws>/odc/drafts, <ws>/o11/drafts), never in the
// server's lane folders every customer shares, and it belongs to the customer's token, whatever the session context says;
// another customer reading it by its id is refused (DRAFT_NOT_FOUND or DRAFT_NOT_OWNED), and nothing of it is written
// outside the workspace. A fake executor; no agent, kernel or Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { draftAction } from '../code-draft.mjs';
import { runWithExecutor } from '../executor.mjs';
import { anvilRoot } from '../workspace.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-hosted-draft-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const executor = { id: 'fake', hosted: true, async call(kind) { throw Object.assign(new Error('no machine call: ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); } };
function customer() {
  const tokenId = 'tok_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const workspace = path.join(root, 'customers', tokenId);
  fs.mkdirSync(workspace, { recursive: true });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Synthetic ' + tokenId, lanes: ['odc', 'o11'], workspace, executor, close: async () => {} };
}
const files = dir => { try { return fs.readdirSync(dir, { recursive: true }).map(String).sort(); } catch { return []; } };
const shared = ['odc', 'o11'].map(lane => lane === 'odc' ? path.join(anvilRoot, '.local', 'lane-odc', 'work', 'drafts') : path.join(anvilRoot, '.local', 'work', 'drafts'));

for (const lane of ['odc', 'o11']) test(`hosted ${lane}: a draft is kept in the customer's workspace and belongs to its token`, async () => {
  const a = customer(), b = customer();
  const before = shared.map(files);
  // The session context names one client for both: the hosted token decides, never ctx.customer.
  const ctx = { customer: 'the same session client' };
  const opened = await runWithExecutor(a, () => draftAction({ lane, action: 'draft', module: 'M' }, ctx));
  assert.equal(opened.ok, true, JSON.stringify(opened).slice(0, 400));
  const id = opened.draft.id;
  assert.ok(fs.existsSync(path.join(a.workspace, lane, 'drafts', id, 'draft.json')), 'the draft is in A\'s workspace');
  assert.deepEqual(shared.map(files), before, 'nothing in the server\'s shared lane folders');
  const mine = await runWithExecutor(a, () => draftAction({ lane, action: 'draft', draft: id }, ctx));
  assert.equal(mine.ok, true, JSON.stringify(mine).slice(0, 400));
  const other = await runWithExecutor(b, () => draftAction({ lane, action: 'draft', draft: id }, ctx));
  assert.notEqual(other.ok, true, JSON.stringify(other).slice(0, 400));
  assert.match(String(other.code), /^DRAFT_NOT_(FOUND|OWNED)$/, JSON.stringify(other).slice(0, 400));
  assert.equal(JSON.stringify(other).includes(a.workspace), false, 'no path of another customer');
});
