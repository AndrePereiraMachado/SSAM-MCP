import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCallDeadline } from '../call-deadline.mjs';
import { trackTask, readTask, tasksDir, closeFacadeTask } from '../ssam-task.mjs';
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
function gate() { let release; const promise = new Promise(resolve => release = resolve); return { promise, release }; }
for (const intermediate of [{ ok: true }, { ok: false, outcome: 'uncertain' }]) {
  test(`cancelled inherited tracker stays running until its outer handler finishes (${intermediate.ok ? 'ok' : 'uncertain'} inner result)`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-cancel-tracker-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = tasksDir(root), deadline = createCallDeadline({ root, timeoutMs: 1000 });
    const inner = gate(), outer = gate(), started = gate(), innerFinished = gate();
    let id;
    const run = deadline.wrap('o11_publish', async () => {
      await trackTask({ tool: 'o11_publish', summary: { module: 'SyntheticModule' }, dir }, async task => {
        id = task.id; started.release(); await inner.promise; return intermediate;
      });
      innerFinished.release(); await outer.promise;
      return reply({ ok: true, version: 7 });
    });
    const controller = new AbortController();
    const original = run({ module: 'SyntheticModule' }, { mcpReq: { signal: controller.signal } });
    await started.promise; controller.abort();
    await assert.rejects(original, error => error.code === 'CANCELLED');
    inner.release(); await innerFinished.promise;
    const during = readTask(id, { dir });
    try {
      assert.equal(during.state, 'running', 'inner tracker completion cannot finalize the still-active external handler');
      assert.equal(during.cancelled, true);
      assert.equal(during.endedAt, undefined);
      assert.equal(closeFacadeTask(id, 'Synthetic reconciliation', { dir }).code, 'CLOSE_TASK_RUNNING');
      assert.equal(deadline.runningCount(), 1);
    } finally { outer.release(); await run({ continueTask: id }); }
    const final = readTask(id, { dir });
    assert.equal(final.state, 'ok');assert.equal(final.deliveries,1);
    assert.equal(final.callResult.version,undefined,'brief call result never carries the full answer payload');
    assert.equal(final.result?.version,undefined,'tracker record also remains brief');
    const body=fs.readFileSync(final.answer.file,'utf8');
    assert.equal(createHash('sha256').update(body).digest('hex'),final.answer.sha256,'saved answer integrity is verified');
    assert.deepEqual(JSON.parse(body).structuredContent,{ok:true,version:7},'full final version is preserved in the saved answer');
    assert.equal(final.cancelled, true); assert.equal(deadline.runningCount(), 0);
    assert.deepEqual(final.summary, { module: 'SyntheticModule' });
  });
}
