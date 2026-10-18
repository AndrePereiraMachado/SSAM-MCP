import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyScenarioHold, readOdcRuntimeVersion } from '../debug-odc-scenario-hold.mjs';

const coordinator = { holdBetweenScenarios: async () => {} };
test('the scenario hold is an explicit ODC coordinator option and refuses O11, client-local and static-read runs', () => {
  assert.equal(qualifyScenarioHold({}, coordinator), false);
  assert.equal(qualifyScenarioHold({ holdBetweenScenarios: false }, coordinator), false);
  assert.equal(qualifyScenarioHold({ holdBetweenScenarios: true, lane: 'odc' }, coordinator), true);
  for (const [input, services, mode, code] of [
    [{ holdBetweenScenarios: 'yes' }, coordinator, {}, 'hold_invalid'],
    [{ holdBetweenScenarios: true, lane: 'o11' }, coordinator, {}, 'hold_o11_unsupported'],
    [{ holdBetweenScenarios: true }, coordinator, { localOnly: true }, 'hold_client_local_unsupported'],
    [{ holdBetweenScenarios: true }, coordinator, { staticOnly: true }, 'hold_static_read_unsupported'],
    [{ holdBetweenScenarios: true }, {}, {}, 'hold_coordinator_required'],
  ]) assert.throws(() => qualifyScenarioHold(input, services, mode), new RegExp('^Error: debug_odc_native_' + code + '$'));
});

test('the runtime version is read from the published app without credentials or redirects', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url: String(url), options }); return { status: 200, redirected: false, url: String(url), json: async () => ({ versionToken: 'v2_token' }) }; };
  assert.equal(await readOdcRuntimeVersion({ runtimeUrl: 'https://dev.example.test/Store/' }, { fetchImpl, now: () => 7 }), 'v2_token');
  assert.equal(calls[0].url, 'https://dev.example.test/Store/moduleservices/moduleversioninfo?7');
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.credentials, 'omit');
  for (const answer of [{ status: 500 }, { status: 200, redirected: true }, { status: 200, url: 'https://other.example.test/x', json: async () => ({ versionToken: 'v' }) },
    { status: 200, json: async () => ({ versionToken: '../x' }) }, { status: 200, json: async () => { throw new Error('bad json'); } }])
    await assert.rejects(readOdcRuntimeVersion({ runtimeUrl: 'https://dev.example.test/Store/' }, { fetchImpl: async url => ({ redirected: false, url: String(url), ...answer }) }),
      /^Error: debug_odc_native_publication_check_failed$/);
  await assert.rejects(readOdcRuntimeVersion({ runtimeUrl: 'https://dev.example.test/Store/' }, { fetchImpl: async () => { throw new Error('offline'); } }),
    /^Error: debug_odc_native_publication_check_failed$/);
  await assert.rejects(readOdcRuntimeVersion({ runtimeUrl: 'http://dev.example.test/Store/' }, { fetchImpl }), /endpoints_invalid/);
});
