// S11: the discover index persisted by identity, over the real lane sources (needs the lane CLI). A loaded index answers
// byte for byte as the build that wrote it (20 intents of the fixtures per lane); a file of another identity or a torn
// one is never served (rebuilt, and the answer says why); a release of the facade or the catalog rebuilds the index from
// the persisted CLI extraction without running a CLI process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, discover, extractKey, laneSources, INDEX_SCHEMA } from '../discovery.mjs';
import { discoverAll } from '../tool-routing.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INTENTS = Object.values(JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'text-routes-phrases.json'), 'utf8')).routes).flat().map(p => p.intent).slice(0, 20);
// The lane cache of this checkout seeds the private one with the CLI's side (native probes and extraction): this file
// measures what is served, not the probes (a checkout without them probes once, about 45 s a lane).
function privateSources(lane) {
  const live = laneSources(lane, { studio: { connection: () => null } });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `ssam-index-persist-${lane}-`));
  for (const f of fs.existsSync(live.cacheDir) ? fs.readdirSync(live.cacheDir) : []) if (/^(native|extract)-/.test(f)) fs.copyFileSync(path.join(live.cacheDir, f), path.join(cacheDir, f));
  return snapshotSources(lane, { studioDir: live.studioDir, env: live.env, cacheDir });
}
// Two calls differ on purpose in their wall time (elapsedMs, whose digits count in the answer's size and budget): the
// clock stands still while the two answers are made, so they are compared byte for byte with nothing normalized.
async function frozen(run) {
  const now = performance.now;
  performance.now = () => 0;
  try { return await run(); } finally { performance.now = now; }
}
// The one word the answer says of the index on purpose: identity.cache "rebuilt" (7 bytes) or "reused" (6). It counts in
// the internal answer each recovery budget is measured on (discovery.mjs: recoveryBudget = bytes(answer) + 2048), so the
// rebuilt answer's recovery calls ask exactly one byte more (unless both sit at the default floor); nothing else may differ.
const REBUILT_EXTRA = Buffer.byteLength('rebuilt') - Buffer.byteLength('reused');
function asLoaded(answer, loaded) {
  const copy = structuredClone(answer);
  for (const [i, t] of (copy?.size?.truncated ?? []).entries()) {
    const mine = t?.call?.arguments; const theirs = loaded?.size?.truncated?.[i]?.call?.arguments;
    if (typeof mine?.budgetBytes === 'number' && mine.budgetBytes === theirs?.budgetBytes + REBUILT_EXTRA) mine.budgetBytes = theirs.budgetBytes;
  }
  return copy;
}

for (const lane of ['odc', 'o11']) {
  const cliBuilt = fs.existsSync(laneSources(lane).cli);
  test(`${lane}: a loaded index answers byte for byte as the build that wrote it (${INTENTS.length} intents)`, { skip: !cliBuilt && `the ${lane} CLI is not built`, timeout: 900000 }, async () => {
    const sources = privateSources(lane);
    try {
      const { cache: { file } } = await buildIndex(lane, { sources });
      const differ = [];
      for (const intent of INTENTS) {
        // The first call finds no file and builds; the second reads the file the first wrote.
        fs.rmSync(file, { force: true });
        const rebuilt = await frozen(() => discoverAll({ lane, intent, sources }));
        assert.ok(fs.existsSync(file), intent);
        const loaded = await frozen(() => discoverAll({ lane, intent, sources }));
        if (JSON.stringify(asLoaded(rebuilt, loaded)) !== JSON.stringify(loaded)) differ.push(intent);
      }
      assert.deepEqual(differ, []);
    } finally { fs.rmSync(sources.cacheDir, { recursive: true, force: true }); }
  });

  test(`${lane}: a stored index of another identity or a torn one is never served; the rebuild is named`, { skip: !cliBuilt && `the ${lane} CLI is not built`, timeout: 900000 }, async () => {
    const sources = privateSources(lane);
    try {
      const first = await buildIndex(lane, { sources });
      const { file } = first.cache; const key = first.index.key;
      assert.equal(path.basename(file), `index-${key}.json`);
      assert.equal(path.dirname(file), sources.cacheDir);
      const second = await buildIndex(lane, { sources });
      assert.equal(second.cache.hit, true); assert.equal(second.index.key, key);
      // Another identity under this name (a file copied or renamed): rebuilt, never served.
      fs.writeFileSync(file, JSON.stringify({ ...first.index, key: 'f'.repeat(24), capabilities: [] }));
      const foreign = await buildIndex(lane, { sources });
      assert.equal(foreign.cache.hit, false); assert.match(foreign.cache.note, /holds identity f{24}, not [0-9a-f]{24}: rebuilt/);
      assert.equal(foreign.index.key, key); assert.ok(foreign.index.capabilities.length > 0);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).key, key, 'the rebuild replaced the foreign file');
      // A torn file: rebuilt, and the discover answer says so among the identity warnings.
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(0, 1000));
      const answer = await discover({ lane, intent: INTENTS[0], sources, budgetBytes: 1 << 20 });
      assert.equal(answer.identity.cache, 'rebuilt');
      assert.ok(answer.identity.warnings.some(w => /discovery index: stored index-[0-9a-f]{24}\.json is not JSON \(torn or corrupted\): rebuilt/.test(w)), JSON.stringify(answer.identity.warnings));
      assert.equal((await buildIndex(lane, { sources })).cache.hit, true);
      // Nothing but the pieces of the store in the cache folder (no temporary file left by the atomic writes).
      assert.deepEqual(fs.readdirSync(sources.cacheDir).filter(f => !/^(index|native|extract)-[0-9a-f]{24}\.json$/.test(f)), []);
    } finally { fs.rmSync(sources.cacheDir, { recursive: true, force: true }); }
  });

  test(`${lane}: a release of the catalog rebuilds the index from the persisted CLI extraction, with no CLI process`, { skip: !cliBuilt && `the ${lane} CLI is not built`, timeout: 900000 }, async t => {
    const sources = privateSources(lane);
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-index-release-'));
    try {
      const before = await buildIndex(lane, { sources });
      assert.ok(fs.existsSync(path.join(sources.cacheDir, `extract-${extractKey(sources)}.json`)), 'the CLI extraction is persisted');
      // The release: the lane descriptor changes (one more byte); the CLI host cannot run, so any CLI process would fail.
      const descriptorFile = path.join(box, path.basename(sources.descriptor));
      fs.writeFileSync(descriptorFile, fs.readFileSync(sources.descriptor, 'utf8') + '\n');
      const released = { ...sources, dotnet: path.join(box, 'no-such-dotnet.exe') };
      const started = performance.now();
      const after = await buildIndex(lane, { sources: released, descriptorFile });
      const ms = performance.now() - started;
      assert.equal(after.cache.hit, false); assert.equal(after.cache.extraction, 'hit');
      assert.notEqual(after.index.key, before.index.key);
      assert.equal(after.index.schemaVersion, INDEX_SCHEMA);
      // The same CLI side as the build before the release: contracts, Studio identity and native answers.
      assert.deepEqual(after.index.contracts, before.index.contracts);
      assert.deepEqual(after.index.identity.studio, before.index.identity.studio);
      assert.deepEqual(after.index.nativeRuntime, before.index.nativeRuntime);
      assert.equal(after.index.identity.nativeRuntime.probes.probed, 0);
      assert.deepEqual(after.index.capabilities.map(c => c.id), before.index.capabilities.map(c => c.id));
      // Recorded, not asserted against a machine's speed: S11 measures ≤ 5 s (docs/BENCH-FRIO.md).
      t.diagnostic(`${lane} rebuild after a catalog release: ${Math.round(ms)} ms`);
    } finally { fs.rmSync(sources.cacheDir, { recursive: true, force: true }); fs.rmSync(box, { recursive: true, force: true }); }
  });
}
