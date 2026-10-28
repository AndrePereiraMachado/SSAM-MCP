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
