// Golden offline integration: resolve the deterministic entry of a real published action (FloodQuotes r293) and index
// its public runtime, using only cached PUBLIC assets under SSAM_DEBUG_EVIDENCE_ROOT. No network, no Studio, no login.
// Skips when the evidence root is absent so the suite still runs on a clean checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { prepareNativeEntry } from '../debug-odc-native-run.mjs';
import { indexRuntime, guidToKey, keyToGuid } from '../debug-odc-native-runtime.mjs';

const EV = process.env.SSAM_DEBUG_EVIDENCE_ROOT;
const OML = EV && path.join(EV, 'proofs', 'odc-client-server-host', 'current-deployed-model', '09bb7bc201a741089ac915a8d969a8cd', 'FloodQuotes-dev-293.oml');
const ASSETS = EV && path.join(EV, 'proofs', 'odc-client-server-host', 'current-public-runtime', '31911e0eeae14ef782bb1ad3eb22b2c9', 'assets');
const SHA = '83394aadea89732d46f50a89be9c234c110aa0f9752ab344b0f3514efba58be0';
const haveOml = OML && fs.existsSync(OML), haveAssets = ASSETS && fs.existsSync(ASSETS);

test('guid <-> model key round-trips in both directions', () => {
  assert.equal(guidToKey('92286166-fbc8-4e11-9678-5a494552415f'), 'ZmEoksj7EU6WeFpJRVJBXw');
  assert.equal(keyToGuid('ZmEoksj7EU6WeFpJRVJBXw'), '92286166-fbc8-4e11-9678-5a494552415f');
  assert.equal(keyToGuid(guidToKey('1e937b46-5737-46e5-b341-dd95a86ad3bd')), '1e937b46-5737-46e5-b341-dd95a86ad3bd');
});

test('runtime index binds the published stub to its model key by the telemetry span', { skip: !haveAssets }, () => {
  const files = {};
  for (const f of fs.readdirSync(ASSETS).filter(f => f.endsWith('.js'))) files[f] = fs.readFileSync(path.join(ASSETS, f), 'utf8');
  const ix = indexRuntime(files);
  const loc = ix.functions['ZmEoksj7EU6WeFpJRVJBXw']?.[0];
  assert.ok(loc, 'Location_GetProperty indexed by model key');
  assert.equal(loc.type, 'SCREEN_SERVICE_SERVER_ACTION_CALL');
  assert.equal(loc.call.endpoint, 'screenservices/FloodQuotes/MainFlow/Location/ActionLocation_GetProperty');
  assert.equal(loc.call.apiVersion, 'NdV4Q1pcQE+EPIrUc3Sp1w');
  assert.equal(loc.call.inputs.length, 8);
  assert.deepEqual(loc.call.inputs.map(i => i.wire), ['Address1', 'City', 'StateCode', 'PostalCode', 'CountryCode', 'PrecisionCode', 'Address2', 'IsManual']);
  // GetFloodZones (block data action) and the client action are indexed too.
  assert.equal(ix.functions['RnuTHjdX5UazQd2VqGrTvQ']?.[0].type, 'SCREEN_SERVICE_DATA_ACTION_CALL');
  assert.ok(ix.screens['MainFlow.Location']);
});

test('deterministic entry of the published Location_GetProperty is the Location screen (distance 2)', { skip: !haveOml }, async () => {
  const { inspect } = await import('../lib.mjs');
  const rd = async opts => { const r = await inspect({ target: OML, expectedSourceSha256: SHA, budget: 1000000, ...opts }); return r.entries ? r : (r.ok && r.out ? JSON.parse(fs.readFileSync(r.out, 'utf8')) : r); };
  const readers = {
    async: true, binding: { tenant: 'offline', module: 'FloodQuotes', app: 'FloodQuotes' },
    resolveTarget: async name => { const r = await rd({ path: 'ServerAction:' + name, depth: 3, max: 500, full: true }); const t = r.tree; return t ? { key: t.key, name: t.properties?.Name, kind: t.kind, path: t.path, inputs: (t.children ?? []).filter(c => c.kind === 'InputParameter').map(c => ({ name: c.properties?.Name, key: c.key, dataType: (c.properties?.DataType ?? '').split(':').pop(), mandatory: c.properties?.IsMandatory === 'True' })), closureCalls: [] } : null; },
    properties: async p => { const r = await rd({ path: p, depth: 0, all: true }); const t = r.tree; return t ? { key: t.key, kind: t.kind, public: t.properties?.Public === 'True', properties: t.properties } : null; },
    usages: async key => { const r = await rd({ path: '@' + key, usages: true, scope: 'direct', depth: 1, max: 300 }); return (r.entries ?? []).map(e => ({ consumer: e.consumer })); },
    inputs: async p => { const r = await rd({ path: p, depth: 1, max: 300 }); return (r.tree?.children ?? []).filter(c => c.kind === 'InputParameter').map(c => ({ name: c.properties?.Name, key: c.key, dataType: (c.properties?.DataType ?? '').split(':').pop(), mandatory: c.properties?.IsMandatory === 'True' })); },
    argumentsOf: async () => null,
  };
  const r = await prepareNativeEntry({ action: 'Location_GetProperty', inputs: { Address1: '100 Main St', City: 'Tampa', StateCode: 'FL', PostalCode: '33602', CountryCode: 'BR', PrecisionCode: '', Address2: '', IsManual: false }, persist: false }, readers);
  assert.equal(r.ok, true);
  assert.equal(r.entry.kind, 'MobileScreen');
  assert.equal(r.entry.name, 'Location');
  assert.equal(r.entry.entryKind, 'screen');
  assert.equal(r.entry.distance, 2);
  assert.deepEqual(r.entry.roles, ['FloodQuotes']);
  assert.equal(r.scenariosValidated, 1);
  assert.deepEqual(r.action.inputs.map(i => i.name), ['Address1', 'City', 'StateCode', 'PostalCode', 'CountryCode', 'PrecisionCode', 'Address2', 'IsManual']);
});
