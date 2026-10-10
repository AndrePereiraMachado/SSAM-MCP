// Atritos 2, lane F7b, A19: the doctor's ok says whether the lane asked (or, without lane, some lane) is usable. A tenant
// without an API Client credential and a module without a runtime origin are warnings [{check, message, continuation}],
// never ok:false (real case, 2026-10-05 23:25: Studio and bridge ok on both lanes, yet ok:false for
// "portal <tenant> ok:false credentialAvailable:false", 15 of 15 doctors). A lane asked and not usable answers
// DOCTOR_LANE_UNUSABLE with that lane's continuation. Fakes only: no Studio, no vault, no process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.SSAM_ODC_OFFLINE = '1'; // nothing here may touch an ODC Studio, a vault entry or a prompt
const m_lib = await import('../lib.mjs');
const m_ssam = await import('../ssam.mjs');

const brief = (modules = []) => ({ ok: true, bridge: 'v39', busy: null, modules: [], dialogsWithChoices: [], modalWindows: 0, catalog: {},
  applicationUrls: { tool: 'ssam_app_url', modules } });
const odcDeps = ({ credential = { 'a.example.test': false, 'b.example.test': true }, modules = [], pids = [4242] } = {}) => ({
  dotnetVersion: async () => '10.0.401',
  newestBridgeDll: () => ({ version: 'v39', path: 'C:\\x\\ODC3.Bridge.v39.dll' }),
  exists: () => true,
  studioPids: async () => pids,
  studioBrief: async () => brief(modules),
  readCatalog: () => ({ tenant: 'a.example.test', modules: ['A'], modulesListedAt: '2026-10-06T00:00:00Z' }),
  tenants: () => ({ default: 'a.example.test', tenants: Object.fromEntries(Object.keys(credential).map(h => [h, { portalOrigin: 'https://' + h }])) }),
  portalBridge: async host => ({ credentialAvailable: credential[host], bridge: { catalog: { apis: new Map([[1, 1]]), operations: new Map([[1, 1]]) } } }),
  readJournal: () => '',
});

test('ODC doctor: a tenant without an API Client credential is a warning with the prompt as continuation, and ok stays true', async () => {
  const report = await m_lib.doctor({ deps: odcDeps() });
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(c => c.ok === false)));
  const portal = report.checks.find(c => c.name === 'portal a.example.test');
  assert.deepEqual([portal.ok, portal.credentialAvailable], [true, false]);
  const warning = report.warnings.find(w => w.check === 'portal a.example.test');
  assert.ok(warning, JSON.stringify(report.warnings));
  assert.deepEqual([warning.continuation.tool, warning.continuation.arguments], ['odc_read', { tenant: 'a.example.test', auth: 'api-client' }]);
  assert.equal(report.warnings.some(w => w.check === 'portal b.example.test'), false, 'a tenant with its credential has no warning');
});

test('ODC doctor: a module without a runtime origin for its links is a warning, not a failure', async () => {
  const report = await m_lib.doctor({ deps: odcDeps({ credential: { 'b.example.test': true },
    modules: [{ module: 'Cardapio', appLinks: { available: false, error: 'No runtime origin for personal-x.outsystems.dev / Development. Pass environment (the runtime origin), or configure the exact stage domain.' } },
      { module: 'Quotes', appLinks: { available: true, ok: true, url: 'https://x/Quotes/' } }] }) });
  assert.equal(report.ok, true);
  const origin = report.warnings.filter(w => w.check === 'runtime origin');
  assert.equal(origin.length, 1);
  assert.match(origin[0].message, /No runtime origin/);
  assert.equal(origin[0].continuation.tool, 'ssam_app_url');
  assert.equal(origin[0].continuation.arguments.app, 'Cardapio');
});

test('ODC doctor: a real failure still zeroes ok (no ODC Studio open)', async () => {
  const report = await m_lib.doctor({ deps: odcDeps({ pids: [] }) });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.name === 'ODC Studio running').ok, false);
});

const lane = (name, ok, extra = {}) => async () => ({ lane: name, ok, studio: { open: ok }, ...extra });
const broken = async () => { throw new Error('the ODC doctor must not run for lane o11'); };

test('ssam doctor: lane o11 asked with a broken ODC lane is ok:true; without lane, ok is some lane usable and each lane keeps its own', async () => {
  assert.equal(typeof m_ssam.RESTART_NEXT, 'string', 'the doctor of the atritos 2 package (A19)');
  const o11 = await m_ssam.doctor('o11', { lanes: { o11: lane('o11', true), odc: broken } });
  assert.equal(o11.ok, true); assert.deepEqual(Object.keys(o11.lanes), ['o11']); assert.equal(o11.code, undefined);
  const both = await m_ssam.doctor(undefined, { lanes: { o11: lane('o11', true), odc: lane('odc', false, { doctor: { ok: false } }) } });
  assert.equal(both.ok, true);
  assert.deepEqual([both.lanes.o11.ok, both.lanes.odc.ok], [true, false]);
  assert.equal(both.code, undefined);
  // Lane warnings reach the top with their lane.
  const warned = await m_ssam.doctor('odc', { lanes: { odc: lane('odc', true, { warnings: [{ check: 'portal a.example.test', message: 'm', continuation: { tool: 'odc_read', arguments: {} } }] }) } });
  assert.equal(warned.ok, true);
  assert.deepEqual(warned.warnings, [{ lane: 'odc', check: 'portal a.example.test', message: 'm', continuation: { tool: 'odc_read', arguments: {} } }]);
});

test('ssam doctor: a lane asked and not usable is DOCTOR_LANE_UNUSABLE with that lane\'s continuation or component hint', async () => {
  assert.equal(typeof m_ssam.RESTART_NEXT, 'string', 'the doctor of the atritos 2 package (A19)');
  const connect = { tool: 'ssam_connect', arguments: { lane: 'o11' }, why: 'Open Service Studio normally first' };
  const o11 = await m_ssam.doctor('o11', { lanes: { o11: lane('o11', false, { continuation: connect }) } });
  assert.deepEqual([o11.ok, o11.code, o11.continuation], [false, 'DOCTOR_LANE_UNUSABLE', connect]);
  const hint = { why: 'The O11 CLI of this checkout is not built; the integrator builds it.' };
  const built = await m_ssam.doctor('o11', { lanes: { o11: lane('o11', false, { hint }) } });
  assert.deepEqual([built.code, built.hint, built.continuation], ['DOCTOR_LANE_UNUSABLE', hint, undefined]);
  const none = await m_ssam.doctor(undefined, { lanes: { o11: lane('o11', false, { continuation: connect }), odc: lane('odc', false, { continuation: { tool: 'ssam_connect', arguments: { lane: 'odc' } } }) } });
  assert.deepEqual([none.ok, none.code, none.continuation.tool, none.continuation.arguments], [false, 'DOCTOR_LANE_UNUSABLE', 'ssam_connect', {}]);
  assert.deepEqual(none.unusable, ['o11', 'odc']);
});
