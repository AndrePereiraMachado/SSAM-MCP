import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PortalCapabilities } from '../runtime/portal-capabilities.mjs';
import { PORTAL_GAPS, PORTAL_READS, PORTAL_WRITES } from '../runtime/portal-routes.mjs';

const raw = JSON.parse(fs.readFileSync(new URL('../catalog/catalog.json', import.meta.url), 'utf8'));
const catalog = { raw, apis: new Map(raw.apis.map(api => [api.id, api])),
  operations: new Map(raw.apis.flatMap(api => api.operations.map(operation => [operation.id, operation]))) };
const evidence = () => JSON.parse(fs.readFileSync(new URL('../catalog/portal-capabilities.json', import.meta.url), 'utf8'));
// W17 (timer run/pause/resume, connection delete) moves ids from PORTAL_GAPS to PORTAL_WRITES; the assertions below
// that name them follow the tables, so applying W17 needs no edit here.
const gap = id => Object.hasOwn(PORTAL_GAPS, id);
const sorted = list => [...(list ?? [])].sort();
const CLI = /`odc |odc portal|internal-routes|pwsh|powershell|\.ps1|python|--match|--tenant|--view/i;

test('all 14 public contracts and 163 operations are discoverable without authentication', () => {
  const capabilities = new PortalCapabilities({ catalog });
  const list = capabilities.list({ kind: 'public', limit: 100 });
  assert.equal(list.total, 14);
  const operations = new Set(list.capabilities.flatMap(entry => capabilities.describe(entry.id).publicApis.flatMap(api => api.operations.map(operation => operation.id))));
  assert.equal(operations.size, 163);
  assert.equal(capabilities.status().liveAccess, 'not_established_by_discovery');
});

test('runtime errors, full traces, job logs and audit trail are separate capabilities', () => {
  const capabilities = new PortalCapabilities({ catalog });
  assert.equal(capabilities.describe('portal.runtime-logs').kind, 'internal');
  assert.equal(capabilities.describe('portal.runtime-logs').execution.code, 'PORTAL_BACKEND_NOT_CONNECTED');
  assert.equal(capabilities.describe('portal.runtime-traces').execution.code, 'PORTAL_BACKEND_NOT_CONNECTED');
  assert.equal(capabilities.describe('portal.trace-correlation').implementation, 'partial_source');
  assert.equal(capabilities.describe('public.builds').execution.implemented, true);
  assert.equal(capabilities.describe('portal.audit-trail').execution.implemented, false);
  assert.equal(capabilities.list({ search: 'erros execução' }).capabilities[0].id, 'portal.runtime-logs');
});

test('GitSSAM internal inventory preserves incomplete and plan-only distinctions', () => {
  const capabilities = new PortalCapabilities({ catalog });
  for (const id of ['connection-discovery', 'external-db-management', 'agent-connections', 'agent-evaluations', 'agent-guardrails']) {
    const entry = capabilities.describe(`portal.${id}`);
    assert.equal(entry.execution.implemented, false);
    assert.ok(entry.legacyEvidence.methods.length);
    assert.equal(entry.currentLiveEvidence, 'not_verified');
  }
  assert.equal(capabilities.describe('portal.agent-connections').legacyEvidence.status, 'historical_partial_live_report');
  assert.equal(capabilities.describe('portal.guardrails-baseline').implementation, 'plan_only');
});

test('with the tenant-aware tools, internal capabilities say how they run (Studio Portal window, then vault broker) and what stays unmapped', () => {
  const capabilities = new PortalCapabilities({ catalog, tenantAccess: true });
  assert.equal(capabilities.status().tenantAccess, true);
  const logs = capabilities.describe('portal.runtime-logs').execution;
  assert.equal(logs.route, 'tenant_access'); assert.equal(logs.implemented, true); assert.equal(logs.liveVerified, false);
  assert.deepEqual(logs.paths.map(p => p.path), ['studio-web', 'vault']); assert.match(logs.paths[0].how, /Portal window inside the user's own ODC Studio/);
  assert.ok(logs.reads.includes('monitoring.logs')); assert.deepEqual(logs.tools, ['odc_portal_read']);
  const db = capabilities.describe('portal.external-db-management').execution;
  assert.deepEqual(sorted(db.writes), sorted(['connections.relationalTest', 'connections.relationalSave', 'connections.importEntities', ...(gap('connections.delete') ? [] : ['connections.delete'])]));
  assert.deepEqual((db.unmapped ?? []).map(u => [u.id, u.code]), ['connections.delete'].filter(gap).map(id => [id, 'PORTAL_ROUTE_UNMAPPED']));
  for (const u of db.unmapped ?? []) assert.match(u.instruction, /Live proof: odc_portal_login.*odc_portal_routes/);
  assert.match(db.secrets, /inside the ODC Studio/);
  const timers = capabilities.describe('portal.timers');
  assert.deepEqual((timers.execution.unmapped ?? []).map(u => u.id), ['timers.run', 'timers.pause', 'timers.resume'].filter(gap));
  assert.ok(timers.publicApis.some(api => api.id === 'asset-configurations-api-v1'));
  assert.equal(capabilities.list({ search: 'pausar timer' }).capabilities[0].id, 'portal.timers');
  // The plan-only baseline and the gaps stay unavailable; public operations name the tenant-aware tools.
  assert.equal(capabilities.describe('portal.guardrails-baseline').execution.implemented, false);
  assert.equal(capabilities.describe('portal.audit-trail').execution.code, 'CAPABILITY_NOT_IMPLEMENTED');
  assert.equal(capabilities.describe('public.builds').execution.authentication, 'studio_session_then_vault_api_client');
  // A list stays compact: counts, not the operation lists or the capture instructions.
  const listed = capabilities.list({ kind: 'internal', limit: 100 }).capabilities.find(c => c.id === 'portal.external-db-management').execution;
  assert.deepEqual([listed.reads, listed.writes, listed.unmapped], gap('connections.delete') ? [6, 3, ['connections.delete']] : [6, 4, undefined]);
  // Without those tools (the standalone server) the same entries are implemented elsewhere, not here.
  const standalone = new PortalCapabilities({ catalog }).describe('portal.external-db-management').execution;
  assert.equal(standalone.implemented, false); assert.match(standalone.nextStep, /SSAM facade/);
});

test('the capability inventory covers every internal route and gap of portal-routes.mjs, and only those', () => {
  const capabilities = new PortalCapabilities({ catalog, tenantAccess: true });
  const covered = { reads: new Set(), writes: new Set(), unmapped: new Set() };
  for (const { id } of capabilities.list({ kind: 'internal', limit: 100 }).capabilities) {
    const access = capabilities.describe(id).access;
    for (const key of Object.keys(covered)) for (const op of access?.[key] ?? []) covered[key].add(op);
  }
  assert.deepEqual([...covered.reads].sort(), Object.keys(PORTAL_READS).sort());
  assert.deepEqual([...covered.writes].sort(), Object.keys(PORTAL_WRITES).sort());
  assert.deepEqual([...covered.unmapped].sort(), Object.keys(PORTAL_GAPS).sort());
  for (const change of [data => data.capabilities.find(c => c.id === 'portal.runtime-logs').access.reads.push('monitoring.invented'),
    data => data.capabilities.find(c => c.id === 'portal.timers').access.unmapped.push('timers.delete'),
    data => data.capabilities.find(c => c.id === 'portal.runtime-logs').access.paths.push('cookies'),
    data => { data.capabilities.find(c => c.id === 'public.builds').access = { tools: ['odc_read'], paths: ['vault'] }; }]) {
    const data = evidence(); change(data);
    assert.throws(() => new PortalCapabilities({ catalog, evidence: data }), error => error.code === 'CAPABILITY_CONFIG_INVALID');
  }
});

test('W17 routes sit in one place of the inventory (unmapped while a gap, writes once captured) and no instruction is a command line', () => {
  const capabilities = new PortalCapabilities({ catalog, tenantAccess: true });
  const where = { 'timers.run': ['portal.timers'], 'timers.pause': ['portal.timers'], 'timers.resume': ['portal.timers'],
    'connections.delete': ['portal.external-db-management', 'portal.agent-connections'] };
  for (const [id, entries] of Object.entries(where)) for (const entry of entries) {
    const access = capabilities.describe(entry).access;
    assert.equal((access.unmapped ?? []).includes(id), gap(id), entry + ': ' + id + ' unmapped');
    assert.equal((access.writes ?? []).includes(id), !gap(id), entry + ': ' + id + ' writes');
    if (!gap(id)) assert.ok(access.tools.includes('odc_portal_write'), entry + ' lists odc_portal_write once ' + id + ' is captured');
  }
  for (const [id, text] of Object.entries(PORTAL_GAPS)) { assert.doesNotMatch(text, CLI, id); assert.match(text, /odc_portal_routes \{module:"/, id); }
  for (const { id } of capabilities.list({ kind: 'internal', limit: 100 }).capabilities) {
    for (const u of capabilities.describe(id).execution.unmapped ?? []) assert.doesNotMatch(u.instruction, CLI, id + ' ' + u.id);
  }
});

test('ODC1 or malformed backend cannot make ODC3 capability executable', () => {
  const backends = new Map([['portal.runtime-logs', { target: 'odc1', authenticated: true, execute() {} }]]);
  const capabilities = new PortalCapabilities({ catalog, backends });
  assert.equal(capabilities.describe('portal.runtime-logs').execution.implemented, false);
  backends.set('portal.runtime-logs', { target: 'odc3', authenticated: true, execute() {}, liveVerified: true, token: 'not-public' });
  const output = capabilities.describe('portal.runtime-logs');
  assert.equal(output.execution.implemented, true);
  assert.equal(output.execution.liveVerified, false);
  assert.equal(JSON.stringify(output).includes('not-public'), false);
});

test('catalog revision, target, unknown refs and duplicate definitions fail closed', () => {
  const changes = [data => data.target = 'odc1', data => data.publicSourceCommit = 'wrong',
    data => data.capabilities.push(data.capabilities[0]), data => data.capabilities[0].publicApiIds = ['unknown']];
  for (const change of changes) {
    const data = evidence(); change(data);
    assert.throws(() => new PortalCapabilities({ catalog, evidence: data }), error => /^CAPABILITY_/.test(error.code));
  }
});

test('unknown IDs, input bounds and explicit pagination are enforced', () => {
  const capabilities = new PortalCapabilities({ catalog });
  assert.throws(() => capabilities.describe('invented'), error => error.code === 'CAPABILITY_NOT_FOUND');
  for (const args of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }, { search: 12 }, { kind: 'anything' }]) {
    assert.throws(() => capabilities.list(args), error => error.code === 'INPUT_INVALID');
  }
  const page = capabilities.list({ offset: 3, limit: 2 });
  assert.equal(page.capabilities.length, 2);
  assert.equal(page.offset, 3);
});
