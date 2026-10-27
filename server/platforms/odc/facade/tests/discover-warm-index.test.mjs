// S11: the warm-up of the discover index at the server start (ssam.mjs warmIndexes, scheduled by scheduleWarm, off with
// SSAM_NO_WARM=1) and the first discover share ONE build: the discover that arrives while the warm-up builds waits for it
// instead of building again, and a warm-up that is cancelled while a discover waits does not stop that build.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, laneSources } from '../discovery.mjs';
import { warmIndexes, scheduleWarm } from '../ssam.mjs';
import { inFlightCount } from '../discovery-index-store.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';

const lane = 'odc';
const cliBuilt = fs.existsSync(laneSources(lane).cli);
// A private cache seeded with this checkout's CLI side (native probes, extraction), as discovery-index-persist does.
function privateSources() {
  const live = laneSources(lane, { studio: { connection: () => null } });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-warm-index-'));
  for (const f of fs.existsSync(live.cacheDir) ? fs.readdirSync(live.cacheDir) : []) if (/^(native|extract)-/.test(f)) fs.copyFileSync(path.join(live.cacheDir, f), path.join(cacheDir, f));
  return snapshotSources(lane, { studioDir: live.studioDir, env: live.env, cacheDir });
}

test('SSAM_NO_WARM=1 schedules no warm-up at the server start', () => {
  assert.equal(scheduleWarm({ env: { SSAM_NO_WARM: '1' }, warm: () => { throw new Error('never'); }, setTimer: () => { throw new Error('never'); } }), null);
});

test('the first discover waits for the warm-up in flight instead of building the index again', { skip: !cliBuilt && 'the odc CLI is not built', timeout: 900000 }, async t => {
  const sources = privateSources();
  // The longest gap between two ticks of a 10 ms timer: how long the server could not answer (a doctor) during the build.
  let last = performance.now(); let longest = 0;
  const ticker = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 10);
  try {
    let builds = 0;
    const warm = warmIndexes({ lanes: [lane], build: name => { builds++; return buildIndex(name, { sources }); }, log: () => {} });
    // The discover arrives while the warm-up builds (no file yet): it joins.
    const discover = await buildIndex(lane, { sources });
    const warmed = await warm;
    // A build that finds every CLI answer on disk runs in one stretch of microtasks: the gap shows on the next tick.
    await new Promise(r => setTimeout(r, 30));
    clearInterval(ticker);
    assert.equal(builds, 1);
    assert.deepEqual(warmed.lanes[lane].ok, true); assert.equal(warmed.lanes[lane].cache, 'built');
    assert.equal(discover.cache.hit, false); assert.equal(discover.cache.joined, true);
    assert.equal(inFlightCount(), 0);
    const files = fs.readdirSync(sources.cacheDir).filter(f => f.startsWith('index-'));
    assert.deepEqual(files, [`index-${discover.index.key}.json`]);
    assert.equal((await buildIndex(lane, { sources })).cache.hit, true);
    // What the server's event loop paid during the build (recorded: doctor answers meanwhile; S11 measured it).
    t.diagnostic(`longest event loop gap during a build from the persisted extraction: ${Math.round(longest)} ms`);
  } finally { clearInterval(ticker); fs.rmSync(sources.cacheDir, { recursive: true, force: true }); }
});

test('a warm-up cancelled while a discover waits leaves the build to the discover; cancelled alone, it stops', { skip: !cliBuilt && 'the odc CLI is not built', timeout: 900000 }, async () => {
  const sources = privateSources();
  try {
    const warm = new AbortController();
    const warming = buildIndex(lane, { sources, signal: warm.signal });
    const discover = buildIndex(lane, { sources });
    warm.abort(new Error('server closing'));
    await assert.rejects(warming, /server closing/);
    const built = await discover;
    assert.equal(built.cache.joined, true); assert.ok(built.index.capabilities.length > 0);
    assert.ok(fs.existsSync(built.cache.file));
    // Alone: a new identity (another descriptor byte) whose only caller cancels: nothing is written for it.
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-warm-cancel-'));
    try {
      const descriptorFile = path.join(box, path.basename(sources.descriptor));
      fs.writeFileSync(descriptorFile, fs.readFileSync(sources.descriptor, 'utf8') + '\n');
      const alone = new AbortController();
      const run = buildIndex(lane, { sources, descriptorFile, signal: alone.signal });
      alone.abort(new Error('server closing'));
      await assert.rejects(run, /server closing/);
      await new Promise(r => setTimeout(r, 200));
      assert.equal(inFlightCount(), 0);
      assert.deepEqual(fs.readdirSync(sources.cacheDir).filter(f => f.startsWith('index-')), [path.basename(built.cache.file)]);
    } finally { fs.rmSync(box, { recursive: true, force: true }); }
  } finally { fs.rmSync(sources.cacheDir, { recursive: true, force: true }); }
});
