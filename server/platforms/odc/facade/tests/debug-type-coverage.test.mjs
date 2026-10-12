import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditTypeCoverage, verifyPin, parsePredicate, attestTransport, COVERAGE_TYPES, COVERAGE_ROLES } from '../debug-type-coverage.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'type-coverage-')), base = path.join(root, '.local', 'debugger');
  roots.push(root);
  const put = (rel, value) => { const file = path.join(base, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); fs.writeFileSync(file, bytes); return sha(bytes); };
  return { root, base, put };
}
const audit = (rel, hash, transport, cells, extra = {}) => ({ path: rel, sha256: hash, transport, live: true, lane: 'o11', runtime: 'server',
  operationId: 'op-' + transport, sessionId: 'session-' + transport, predicates: ['/ok==true'], scenarios: '/scenarios', pauses: '/pauses', cells, ...extra });
const cell = (result, lane, runtime, type, role) => result.cells.find(c => c.lane === lane && c.runtime === runtime && c.type === type && c.role === role);
const documented = { 'server-binary-size-only': { id: 'server-binary-size-only', status: 'documented', evidence: [{ path: 'limits/binary.json', ok: true }] },
  'no-evidence': { id: 'no-evidence', status: 'open', evidence: [] } };

test('maps verified audits to (lane, runtime, type, role, surface, scenarios, pauses); MCP-only stays partial, MCP+CLI closes', () => {
  const { root, put } = fixture();
  const mcp = put('a/mcp.json', { ok: true, transport: 'public-mcp', scenarios: [1, 2, 3], pauses: 24 }), cli = put('a/cli.json', { ok: true, transport: 'root-cli-json-lines', scenarios: 2, pauses: 9 });
  const audits = [audit('a/mcp.json', mcp, 'mcp', [{ type: 'Decimal', role: 'input' }, { type: 'Decimal', role: 'return' }]),
    audit('a/cli.json', cli, 'cli', [{ type: 'Decimal', role: 'input' }])];
  const result = auditTypeCoverage({ root, audits });
  assert.equal(result.schema, 'ssam-debugger-type-coverage/1');
  assert.equal(result.readOnly, true);
  const input = cell(result, 'o11', 'server', 'Decimal', 'input');
  assert.equal(input.status, 'closed');
  assert.deepEqual(input.surfaces.mcp, { audits: ['a/mcp.json'], attested: 1, scenarios: 3, pauses: 24 });
  assert.deepEqual(input.surfaces.cli, { audits: ['a/cli.json'], attested: 1, scenarios: 2, pauses: 9 });
  const ret = cell(result, 'o11', 'server', 'Decimal', 'return');
  assert.equal(ret.status, 'partial');
  assert.deepEqual(ret.surfaces.cli, { audits: [], attested: 0, scenarios: 0, pauses: 0 });
  // The full grid is emitted: untouched cells are open, never omitted or promoted.
  assert.equal(result.cells.length, 2 * 2 * COVERAGE_TYPES.length * COVERAGE_ROLES.length);
  assert.equal(cell(result, 'odc', 'client', 'Text', 'local').status, 'open');
  assert.deepEqual(result.audits.map(a => [a.path, a.ok, a.scenarios, a.pauses, a.operationId]), [['a/mcp.json', true, 3, 24, 'op-mcp'], ['a/cli.json', true, 2, 9, 'op-cli']]);
});

test('hash mismatch is refused and turns every cell of that audit open', () => {
  const { root, put } = fixture();
  const mcp = put('a/mcp.json', { ok: true, scenarios: 1, pauses: 1 }), cli = put('a/cli.json', { ok: true, scenarios: 1, pauses: 1 });
  put('a/cli.json', { ok: true, scenarios: 1, pauses: 2 }); // changed after pinning
  const result = auditTypeCoverage({ root, audits: [audit('a/mcp.json', mcp, 'mcp', [{ type: 'Text', role: 'input' }]),
    audit('a/cli.json', cli, 'cli', [{ type: 'Text', role: 'input' }])] });
  const refused = result.audits.find(a => a.path === 'a/cli.json');
  assert.equal(refused.ok, false); assert.equal(refused.reason, 'hash-mismatch');
  const c = cell(result, 'o11', 'server', 'Text', 'input');
  assert.equal(c.status, 'open');
  assert.ok(c.reasons.some(r => r.includes('a/cli.json') && r.includes('hash-mismatch')));
});

test('a failed predicate, a synthetic pin or a non-live audit never closes a cell', () => {
  const { root, put } = fixture();
  const bad = put('a/bad.json', { ok: false, scenarios: 1, pauses: 1 }), good = put('a/good.json', { ok: true, scenarios: 1, pauses: 1 });
  const result = auditTypeCoverage({ root, audits: [
    audit('a/bad.json', bad, 'mcp', [{ type: 'Integer', role: 'input' }]),
    audit('a/good.json', 'd'.repeat(64), 'cli', [{ type: 'Boolean', role: 'input' }]),
    audit('a/good.json', good, 'mcp', [{ type: 'Currency', role: 'input' }], { live: false })] });
  assert.equal(result.audits[0].reason, 'predicate-failed');
  assert.equal(result.audits[1].reason, 'synthetic-pin');
  assert.equal(cell(result, 'o11', 'server', 'Integer', 'input').status, 'open');
  assert.equal(cell(result, 'o11', 'server', 'Boolean', 'input').status, 'open');
  const historical = cell(result, 'o11', 'server', 'Currency', 'input');
  assert.equal(historical.status, 'open'); assert.ok(historical.reasons.includes('no-live-audit'));
});

test('a native-limit cell needs a verified evidence path', () => {
  const { root } = fixture();
  const typeLimits = [{ lane: 'o11', runtime: 'server', type: 'Binary Data', role: 'input', limitId: 'server-binary-size-only' },
    { lane: 'odc', runtime: 'server', type: 'Binary Data', role: 'input', limitId: 'no-evidence' },
    { lane: 'odc', runtime: 'client', type: 'Binary Data', role: 'input', limitId: 'unknown-limit' }];
  const result = auditTypeCoverage({ root, typeLimits, limits: documented });
  const limited = cell(result, 'o11', 'server', 'Binary Data', 'input');
  assert.equal(limited.status, 'native-limit');
  assert.deepEqual(limited.nativeLimit, { id: 'server-binary-size-only', evidencePath: 'limits/binary.json' });
  for (const [lane, runtime] of [['odc', 'server'], ['odc', 'client']]) {
    const c = cell(result, lane, runtime, 'Binary Data', 'input');
    assert.equal(c.status, 'open'); assert.ok(c.reasons.some(r => r.startsWith('native-limit-evidence-missing')), lane + runtime);
  }
});

test('never opens DPAPI or vault records and never reads outside .local/debugger', () => {
  const { root, put } = fixture();
  const opened = [];
  const readFile = file => { opened.push(file); return fs.readFileSync(file); };
  const vault = put('x/app-user-vault.json', { ok: true }), dpapi = put('x/record.dpapi', 'opaque');
  const result = auditTypeCoverage({ root, readFile, audits: [audit('x/app-user-vault.json', vault, 'mcp', [{ type: 'Text', role: 'local' }]),
    audit('x/record.dpapi', dpapi, 'cli', [{ type: 'Text', role: 'local' }]),
    audit('../outside.json', vault, 'cli', [{ type: 'Text', role: 'output' }])] });
  assert.deepEqual(result.audits.map(a => a.reason), ['private-store-refused', 'private-store-refused', 'outside-root']);
  assert.deepEqual(opened, []);
  // verifyPin applies the same guard directly.
  assert.equal(verifyPin({ path: 'x/record.dpapi', sha256: dpapi }, { base: path.join(root, '.local', 'debugger'), readFile }).reason, 'private-store-refused');
  assert.deepEqual(opened, []);
});

test('audit specs with unknown types, roles or surfaces are refused, not guessed', () => {
  const { root, put } = fixture();
  const hash = put('a/a.json', { ok: true, scenarios: 1, pauses: 1 });
  const result = auditTypeCoverage({ root, audits: [audit('a/a.json', hash, 'mcp', [{ type: 'Varchar', role: 'input' }]),
    audit('a/a.json', hash, 'stdio', [{ type: 'Text', role: 'input' }]), audit('a/a.json', hash, 'mcp', [{ type: 'Text', role: 'global' }])] });
  assert.deepEqual(result.audits.map(a => a.reason), ['spec-invalid', 'spec-invalid', 'spec-invalid']);
  assert.equal(cell(result, 'o11', 'server', 'Text', 'input').status, 'open');
  assert.throws(() => parsePredicate('ok==true'), /predicate_invalid/);
  assert.deepEqual(parsePredicate('/cleanup/completed==true'), { pointer: '/cleanup/completed', op: '==', expected: true });
  assert.deepEqual(parsePredicate('/pauses>=6'), { pointer: '/pauses', op: '>=', expected: 6 });
});

test('a surface counts toward closure only when the audit file attests it; a contradicting file is refused', () => {
  const { root, put } = fixture();
  const bare = put('a/bare-mcp.json', { ok: true }), cli = put('a/cli.json', { ok: true, transport: 'root-cli-json-lines' }), mcp = put('a/mcp.json', { ok: true, publicMcp: true });
  const result = auditTypeCoverage({ root, audits: [audit('a/bare-mcp.json', bare, 'mcp', [{ type: 'Text', role: 'input' }]), audit('a/cli.json', cli, 'cli', [{ type: 'Text', role: 'input' }]),
    audit('a/cli.json', cli, 'mcp', [{ type: 'Date', role: 'input' }]), audit('a/mcp.json', mcp, 'mcp', [{ type: 'Time', role: 'input' }]), audit('a/cli.json', cli, 'cli', [{ type: 'Time', role: 'input' }])] });
  const text = cell(result, 'o11', 'server', 'Text', 'input');
  assert.equal(text.status, 'partial'); assert.ok(text.reasons.includes('transport-unattested:mcp'), text.reasons.join(' '));
  assert.equal(result.audits[2].reason, 'transport-mismatch');
  assert.equal(cell(result, 'o11', 'server', 'Date', 'input').status, 'open');
  assert.equal(cell(result, 'o11', 'server', 'Time', 'input').status, 'closed');
  assert.deepEqual(['public-mcp', 'public-mcp-stdio', 'root-cli-json-lines', 'stdio'].map(x => attestTransport({ transport: x })), ['mcp', 'mcp', 'cli', null]);
  assert.equal(attestTransport({ publicMcp: true }), 'mcp'); assert.equal(attestTransport({ surface: 'cli' }), 'cli'); assert.equal(attestTransport({}), null);
});

test('types the SDK refuses (Object) are refused cells only with verified refusal evidence', () => {
  const { root, put } = fixture();
  const hash = put('a/object-refusal.json', { refused: true });
  const objectCells = [{ type: 'Object', role: 'input' }, { type: 'Object', role: 'return' }];
  const refusal = (sha256, extra = {}) => ({ path: 'a/object-refusal.json', sha256, lane: 'odc', runtime: 'client', predicates: ['/refused==true'], cells: objectCells, ...extra });
  const ok = auditTypeCoverage({ root, refusals: [refusal(hash)] });
  const c = cell(ok, 'odc', 'client', 'Object', 'input');
  assert.equal(c.status, 'refused'); assert.deepEqual(c.refusal, { evidencePath: 'a/object-refusal.json' });
  assert.equal(cell(ok, 'odc', 'client', 'Object', 'local').status, 'open', 'only the listed cells');
  for (const bad of [refusal('9'.repeat(64)), refusal(hash, { predicates: ['/refused==false'] }), refusal(hash, { predicates: [] })]) {
    const r = cell(auditTypeCoverage({ root, refusals: [bad] }), 'odc', 'client', 'Object', 'input');
    assert.equal(r.status, 'open'); assert.ok(r.reasons.some(x => x.startsWith('refusal-evidence-invalid:')), r.reasons.join(' '));
  }
});
