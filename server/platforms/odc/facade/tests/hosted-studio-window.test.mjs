import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { studioIdentity, studioWarningOf, studioRefusal, servedVersions } from '../studio-identity.mjs';
import { compatibility } from '../agent-hub.mjs';
const kernel = { odc: '1.7.29', o11: '11.55.93', odcBridge: 'v97',
  servedVersions: {odc: ['1.7.28', '1.7.29'], o11: ['11.55.92', '11.55.93']},
  builds: {odc: '1.7.29.10940', o11: '11.55.93.65289'} };
for (const [lane, exact, older, newer, build] of [
  ['odc', '1.7.29.10940', '1.7.27.1', '1.7.30.1', '1.7.29.11000'],
  ['o11', '11.55.93.65289', '11.55.91.1', '11.55.94.1', '11.55.93.65300'],
]) {
  test(`${lane}: exact, below window, above window and build difference`, () => {
    assert.equal(studioWarningOf(studioIdentity(lane, exact, kernel)), null);
    const refused = studioRefusal(studioIdentity(lane, older, kernel));
    assert.equal(refused.cause, 'STUDIO_UPDATE_REQUIRED');
    assert.deepEqual(refused.served, kernel.servedVersions[lane]);
    assert.match(refused.userMessage, /older than the versions this server serves/);
    const next = studioIdentity(lane, newer, kernel);
    assert.equal(next.ok, true);
    assert.equal(studioRefusal(next), null);
    const warning = studioWarningOf(next);
    assert.equal(warning.code, 'studioNewerThanServed');
    assert.match(warning.userMessage, /the owner was notified/);
    assert.doesNotMatch(JSON.stringify(warning), /kernel|\.mjs|C:\\|stack|[ãõç]/);
    assert.equal(studioWarningOf(studioIdentity(lane, build, kernel)).code, 'studioBuildDiffers');
  });
}
test('served versions include the container, kernel window and injected deployment window', () => {
  assert.deepEqual(servedVersions('odc', kernel, {SSAM_SERVED_VERSIONS: '{"odc":["1.7.27"]}'}), ['1.7.27','1.7.28','1.7.29']);
});
test('v97 and an O11 bridge built inside the window are accepted', () => {
  const hello = {studios: {odc:{installed:{version:'1.7.30.1'}}, o11:{installed:{version:'11.55.94.1'}}},
    pack: {lanes:['odc','o11'], odcBridge:'v97', o11BuiltFor:'11.55.92', o11Hook:'dev'}};
  const result = compatibility(hello, kernel, ['odc','o11']);
  assert.equal(result.odc.ok, true);
  assert.equal(result.o11.ok, true);
  assert.equal(result.odc.warning.code, 'studioNewerThanServed');
});

test('a newer O11 Studio accepts its matching local bridge without accepting an unrelated future pack', () => {
  const hello = { studios: { o11: { installed: { version: '11.55.94.1' } } },
    pack: { lanes: ['o11'], o11BuiltFor: '11.55.94', o11Hook: 'dev' } };
  const result = compatibility(hello, kernel, ['o11']).o11;
  assert.equal(result.ok, true);
  assert.equal(result.warning.code, 'studioNewerThanServed');
  for (const o11BuiltFor of ['11.55.95', '11.55.91', null]) {
    assert.equal(compatibility({ ...hello, pack: { ...hello.pack, o11BuiltFor } }, kernel, ['o11']).o11.code, 'AGENT_PACK_MISMATCH');
  }
  assert.equal(compatibility({ ...hello, pack: { ...hello.pack, o11Hook: 'unknown' } }, kernel, ['o11']).o11.code, 'AGENT_PACK_MISMATCH');
  assert.equal(compatibility(hello, { ...kernel, o11Hook: 'h1' }, ['o11']).o11.code, 'AGENT_PACK_MISMATCH');
  assert.equal(compatibility(hello, kernel, []).o11.code, 'LANE_DISABLED');
});

test('three deployed releases route to the matching kernel for both lanes', () => {
  const window = { odc: ['1.7.28', '1.7.29', '1.7.30'], o11: ['11.55.92', '11.55.93', '11.55.94'] };
  for (const lane of ['odc', 'o11']) for (const version of window[lane]) {
    const local = { ...kernel, [lane]: version, builds: {}, servedVersions: window };
    const hello = { studios: { [lane]: { installed: { version: version + '.1' } } },
      pack: { lanes: [lane], odcBridge: 'v97', o11BuiltFor: version, o11Hook: 'dev' } };
    assert.equal(compatibility(hello, local, [lane])[lane].ok, true);
    const other = window[lane].find(value => value !== version);
    assert.equal(compatibility(hello, { ...local, [lane]: other }, [lane])[lane].cause, 'STUDIO_VERSION_CHANGED');
  }
});

// r44 (field, 2026-11-08): with v4 serving ODC 1.7.31, an ODC Studio 1.7.32 on the default backend (kernel 1.7.30) was told
// "This request uses the newest served version" with served 1.7.30, read as "the server serves up to 1.7.30". The warning
// names the version that ran and the newest version of the whole window, from the window, never the backend's own kernel.
test('a Studio newer than the window names the newest served version of the window, not only the backend that ran', () => {
  const v1 = { odc: '1.7.30', o11: '11.55.94', odcBridge: 'v109', builds: { odc: '1.7.30.10980', o11: '11.55.94.65328' },
    servedVersions: { odc: ['1.7.30', '1.7.29', '1.7.28', '1.7.31'], o11: ['11.55.94', '11.55.93', '11.55.92'] } };
  const odc = studioIdentity('odc', '1.7.32.11065', v1);
  assert.equal(odc.relation, 'newer');
  assert.equal(odc.newest, '1.7.31');
  const warning = studioWarningOf(odc);
  assert.equal(warning.code, 'studioNewerThanServed');
  assert.equal(warning.served, '1.7.30.10980');
  assert.equal(warning.newestServed, '1.7.31');
  assert.match(warning.userMessage, /ODC Studio 1\.7\.32\.11065/);
  assert.match(warning.userMessage, /newest ODC Studio this server serves is 1\.7\.31/);
  assert.match(warning.userMessage, /ran with ODC Studio 1\.7\.30\.10980/);
  assert.doesNotMatch(warning.userMessage, /uses the newest served version/);
  assert.doesNotMatch(JSON.stringify(warning), /kernel|\.mjs|C:\\|stack|[ãõç]/);
  // The backend that ran is the newest of its lane: one version, named once.
  const o11 = studioWarningOf(studioIdentity('o11', '11.55.95.65352', v1));
  assert.equal(o11.newestServed, '11.55.94');
  assert.match(o11.userMessage, /ran with Service Studio 11\.55\.94\.65328, the newest Service Studio this server serves/);
});
// r44: a fifth pair (O11 11.55.95 / ODC 1.7.32) takes a machine with ODC Studio 1.7.32 and Service Studio 11.55.94 (the router
// selects by ODC); its O11 lane is served elsewhere in the window, so the one action is to update Service Studio to the
// backend's version. The text names that version from the identity, for every pair, not only for the 11.55.94 backend.
test('a mixed machine on any pair gets the exact O11 update step from the backend version', () => {
  const window = { odc: ['1.7.30', '1.7.29', '1.7.28', '1.7.31', '1.7.32'], o11: ['11.55.94', '11.55.93', '11.55.92', '11.55.95'] };
  const v5 = { o11: '11.55.95', odc: '1.7.32', odcBridge: 'v109', odcBridgeAccepted: ['v98', 'v101', 'v102', 'v107', 'v106', 'v108'], servedVersions: window };
  const hello = o11 => ({ agent: { odcCommands: ['merge', 'reconcile-merge'] },
    studios: { odc: { installed: { version: '1.7.32.11065' } }, o11: { installed: { version: o11 } } },
    pack: { lanes: ['odc', 'o11'], odcBridge: 'v108', o11BuiltFor: '11.55.94', o11Hook: 'dev' } });
  const mixed = compatibility(hello('11.55.94.65328'), v5, ['odc', 'o11']);
  assert.equal(mixed.odc.ok, true);
  assert.equal(mixed.o11.cause, 'STUDIO_VERSION_CHANGED');
  assert.match(mixed.o11.message, /Update Service Studio to 11\.55\.95, open it again, and reconnect the SSAM Agent/);
  assert.match(studioRefusal(mixed.o11.studio).userMessage, /The ODC lane remains available/);
  assert.match(studioWarningOf(mixed.o11.studio).userMessage, /Update Service Studio to 11\.55\.95/);
  // The 11.55.94 backends keep their text; a Service Studio newer than the backend is never told to update to an older one.
  const v1 = { o11: '11.55.94', odc: '1.7.30', odcBridge: 'v109', odcBridgeAccepted: ['v98', 'v101', 'v102', 'v107', 'v106', 'v108'], servedVersions: window };
  assert.match(compatibility({ ...hello('11.55.93.1'), studios: { ...hello('').studios, odc: { installed: { version: '1.7.30.10980' } }, o11: { installed: { version: '11.55.93.1' } } } }, v1, ['odc', 'o11']).o11.message, /Update Service Studio to 11\.55\.94/);
  const newer = compatibility({ ...hello('11.55.95.65352'), studios: { odc: { installed: { version: '1.7.30.10980' } }, o11: { installed: { version: '11.55.95.65352' } } } }, v1, ['odc', 'o11']).o11;
  assert.equal(newer.cause, 'STUDIO_VERSION_CHANGED');
  assert.doesNotMatch(newer.message, /Update Service Studio to/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordStudioVersions, readStudioVersions } from '../studio-version-state.mjs';
test('version state merges isolated writers, preserves first seen and excludes raw credentials and paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-'));
  try {
    const state = {tokenId:'tok_sample', customer:'Sample', hello:{studios:{odc:{installed:{version:'1.7.30.1',dir:'secret-path'}}}}};
    const compatible = {odc:{ok:true,studio:studioIdentity('odc','1.7.30.1',kernel)}};
    recordStudioVersions(dir, state, compatible, '2026-10-20T12:00:00Z', 'v1');
    recordStudioVersions(dir, {...state,tokenId:'tok_other'}, compatible, '2026-10-20T12:01:00Z', 'v2');
    const data = readStudioVersions(dir);
    assert.equal(Object.keys(data.tokens).length,2);
    assert.deepEqual(data.unserved.odc['1.7.30'].tokens.sort(),['tok_other','tok_sample']);
    assert.equal(data.unserved.odc['1.7.30'].first,'2026-10-20T12:00:00Z');
    assert.doesNotMatch(JSON.stringify(data),/secret-path/);
    recordStudioVersions(dir,state,{odc:{ok:true}},'2026-10-20T12:02:00Z','v1');
    assert.deepEqual(readStudioVersions(dir).unserved.odc['1.7.30'].tokens,['tok_other']);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
