// r41 (hosted/backend-metrics.mjs): the load of a backend for the console: RSS each minute, accounts active now and per hour,
// counts only (no token id in the file), kept 24 h / 7 days, read back after a restart.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackendMetrics, containerRss, ACTIVE_MS } from '../hosted/backend-metrics.mjs';

test('samples, active accounts, distinct accounts per hour and the file holds counts only', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-metrics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-02T10:00:30Z'), rss = 1000;
  const m = createBackendMetrics({ runtimeDir: dir, backend: 'b1', now: () => clock, readRss: () => rss, totalMem: () => 8000 });
  m.callStarted('tok_aaaaaaaaaaaa'); m.callStarted('tok_bbbbbbbbbbbb'); m.callEnded('tok_bbbbbbbbbbbb');
  m.sample();
  rss = 3000; clock += ACTIVE_MS + 60000;
  m.sample();
  let doc = JSON.parse(fs.readFileSync(m.file, 'utf8'));
  assert.equal(doc.schema, 'ssam-backend-metrics/1');
  assert.deepEqual(doc.samples.map(s => [s.rssB, s.active]), [[1000, 2], [3000, 1]], 'a: call still running; b: answered more than 5 min ago');
  assert.deepEqual(doc.hours, [{ hour: '2026-11-02T10:00:00.000Z', maxRssB: 3000, accounts: 2, peakActive: 2 }]);
  assert.equal(doc.hostMemTotalB, 8000);
  assert.doesNotMatch(fs.readFileSync(m.file, 'utf8'), /tok_/);
  // after a restart the history is read back; a new day drops what is older than 24 h / 7 days
  clock += 8 * 86400000;
  const again = createBackendMetrics({ runtimeDir: dir, backend: 'b1', now: () => clock, readRss: () => 500, totalMem: () => 8000 });
  again.sample();
  doc = JSON.parse(fs.readFileSync(again.file, 'utf8'));
  assert.equal(doc.samples.length, 1); assert.equal(doc.hours.length, 1);
  assert.ok(containerRss({ platform: 'win32' }) > 0);
  assert.ok(containerRss({ platform: 'linux', procDir: path.join(dir, 'none') }) > 0, 'without /proc: this process');
});
