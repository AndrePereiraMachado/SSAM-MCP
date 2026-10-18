import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import { foreignPendingReason } from '../debug-foreign-pending.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, CAPABILITIES, SEED_EVIDENCE, INTERACTIVE, DISPATCHERS, dispatcherBranches, admissionRules,
  describeQualification, qualificationRows, legacyNotice, legacyPrefix, verifyEvidence } from '../debug-adapter-registry.mjs';
import { serverSessionSchema } from '../debug-server-session.mjs';
import { clientSessionSchema } from '../debug-client-session.mjs';
import { debugRunToolSchema } from '../debug-run.mjs';
import { workspaceRoot } from '../workspace.mjs';

const facade = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = file => fs.readFileSync(path.join(facade, file), 'utf8');
const find = (lane, adapter) => ADAPTERS.find(r => r.lane === lane && r.adapter === adapter);
const KEY = 'AQEBAQEBAQEBAQEBAQEBAQ';

test('rows are frozen, typed and reference only known evidence keys', () => {
  assert.ok(Object.isFrozen(ADAPTERS) && ADAPTERS.every(Object.isFrozen) && Object.isFrozen(SEED_EVIDENCE));
  assert.deepEqual([...INTERACTIVE], [true, false, 'excluded', 'native-limit', 'legacy']);
  const ids = new Set();
  for (const row of [...ADAPTERS, ...CAPABILITIES]) {
    const id = row.lane + '|' + (row.adapter ?? row.capability) + '|' + row.runtime;
    assert.ok(!ids.has(id), 'duplicate ' + id); ids.add(id);
    assert.ok(['o11', 'odc'].includes(row.lane) && ['client', 'server'].includes(row.runtime) && typeof row.label === 'string', id);
    assert.ok(INTERACTIVE.includes(row.interactive), id);
    assert.ok(row.refusalCode === null || /^[a-z0-9_]+$/.test(row.refusalCode), id);
    for (const key of row.evidenceKeys) assert.ok(SEED_EVIDENCE[key]?.lane === row.lane, id + ' -> ' + key);
  }
  for (const row of ADAPTERS) {
    assert.ok(Array.isArray(row.entryKinds) && Array.isArray(row.contextModes) && Array.isArray(row.branches), row.adapter);
    if (row.interactive === 'legacy' || row.absent) assert.deepEqual(row.branches, [], row.adapter);
    else assert.ok(row.branches.length > 0, row.adapter);
  }
});

test('every dispatcher branch has a row and every row a branch (static scan)', () => {
  for (const lane of ['o11', 'odc']) {
    const scanned = dispatcherBranches(lane, source(DISPATCHERS[lane]));
    assert.ok(scanned.length >= 8, lane + ' scan found too few branches');
    const rows = ADAPTERS.filter(r => r.lane === lane && r.interactive !== 'legacy' && !r.absent);
    for (const row of rows) for (const branch of row.branches) assert.ok(scanned.includes(branch), lane + ' row ' + row.adapter + ' has no branch ' + branch);
    assert.deepEqual([...new Set(rows.flatMap(r => r.branches))].sort(), scanned, lane + ' branch without a row');
  }
  // A new dispatcher branch must fail the scan until a row covers it.
  const grown = source(DISPATCHERS.odc).replace("if (prepared.adapter?.kind === 'workflow-event') {",
    "if (prepared.adapter?.kind === 'screen-aggregate') {} if (prepared.adapter?.kind === 'workflow-event') {");
  assert.ok(dispatcherBranches('odc', grown).includes('adapter:screen-aggregate'));
});

test('BPT is excluded, ODC exposed SOAP is a native limit, invoke and rest-wrapper are legacy, O11 mount is absent', () => {
  assert.equal(find('o11', 'bpt-original-launch').interactive, 'excluded');
  assert.equal(find('odc', 'exposed-soap').interactive, 'native-limit');
  assert.deepEqual(find('odc', 'exposed-soap').entryKinds, ['soap-method']);
  assert.equal(find('odc', 'ssam_debug_invoke').interactive, 'legacy');
  for (const lane of ['o11', 'odc']) assert.equal(find(lane, 'rest-wrapper').interactive, 'legacy');
  const mount = find('o11', 'mounted-screen'); assert.equal(mount.interactive, 'excluded'); assert.equal(mount.absent, true);
  for (const adapter of ['ssam_debug_invoke', 'rest-wrapper']) {
    const notice = legacyNotice(adapter);
    assert.match(notice, /^LEGACY /); assert.match(notice, /not counted/); assert.match(notice, /ssam_debug_server/);
  }
  assert.throws(() => legacyNotice('server-chain'), /not_legacy/);
  assert.equal(legacyPrefix('ssam_debug_invoke'), 'legacy ssam_debug_invoke (not interactive): ');
  assert.equal(legacyPrefix('rest-wrapper'), "legacy execution:'rest-wrapper' (not interactive): ");
  assert.throws(() => legacyPrefix('client-action'), /not_legacy/);
});

test('refusal codes are codes the debugger actually emits', () => {
  const files = fs.readdirSync(facade).filter(f => /^debug.*\.mjs$/.test(f) && f !== 'debug-adapter-registry.mjs');
  const corpus = files.map(source).join('\n');
  for (const row of [...ADAPTERS, ...CAPABILITIES].filter(r => r.refusalCode)) assert.ok(corpus.includes("'" + row.refusalCode), row.refusalCode);
});

function runCorpus() {
  const out = [];
  for (const lane of [undefined, 'o11', 'odc']) for (const contextMode of [undefined, 'app-user', 'anonymous', 'native-background'])
    for (const trace of [undefined, 'full', 'none']) for (const execution of [undefined, 'rest-wrapper'])
      for (const launch of [undefined, { contextMode: 'app-user' }, { contextMode: 'app-user', inputs: { A: 1 } }, { contextMode: 'anonymous' }])
        for (const words of [undefined, ' ', 'go']) for (const workflow of [undefined, { module: 'Flow' }]) for (const op of ['run', 'status'])
          out.push(Object.fromEntries(Object.entries({ op, lane, action: 'Act', contextMode, trace, execution, launch, words, workflow }).filter(([, v]) => v !== undefined)));
  return out;
}

test('admission rules reproduce the current session schemas exactly (parity corpus)', () => {
  const server = serverSessionSchema(debugRunToolSchema), client = clientSessionSchema(debugRunToolSchema);
  const scopes = [{ functionKey: KEY, nodeKeys: [KEY] }];
  let accepted = 0;
  for (const run of runCorpus()) {
    for (const [runtime, schema] of [['server', server], ['client', client]]) {
      const rules = admissionRules(run.lane ?? 'odc', runtime), verdict = rules.admit(run);
      const parsed = schema.safeParse({ op: 'start', run, scopes });
      assert.equal(verdict.ok, parsed.success, runtime + ' ' + JSON.stringify(run));
      if (!verdict.ok) assert.ok(parsed.error.issues.some(i => i.message === verdict.message), runtime + ' message ' + JSON.stringify(run));
      if (verdict.ok) accepted++;
    }
  }
  assert.ok(accepted > 100);
});

test('admission context modes and requirements come from the rows', { skip: foreignPendingReason('timer-background') }, () => {
  assert.deepEqual([...admissionRules('odc', 'server').contextModes].sort(),['anonymous', 'app-user', 'native-background']);
  assert.deepEqual(admissionRules('o11', 'client').contextModes, ['app-user']);
  assert.ok(admissionRules('odc', 'server').refusals.some(r => r.adapter === 'exposed-soap' && r.refusalCode === 'debug_native_endpoint_odc_exposed_soap_unavailable'));
  const wake = { op: 'run', lane: 'odc', contextMode: 'native-background', launch: { contextMode: 'app-user' }, words: 'go' };
  assert.equal(admissionRules('odc', 'server').admit(wake).ok, true);
  assert.deepEqual(admissionRules('odc', 'server').admit(wake).adapters, ['timer-original-wake']);
  const withoutWake = ADAPTERS.filter(r => r.adapter !== 'timer-original-wake');
  assert.equal(admissionRules('odc', 'server', withoutWake).admit(wake).ok, false);
  assert.throws(() => admissionRules('x', 'server'), /scope_invalid/);
});

test('qualification text corrects the stale statements and is derived only from rows and evidence', () => {
  const sentence = (text, label) => text.split(/(?<=\.) /).find(s => s.includes(label)) ?? '';
  const o11Server = describeQualification('o11', 'server');
  assert.match(sentence(o11Server, 'REST Basic app-user'), /^Live-qualified on MCP/);
  assert.match(sentence(o11Server, 'producer\/consumer group'), /^Live-qualified on MCP/);
  assert.match(sentence(o11Server, 'BPT original launch'), /^Excluded/);
  assert.match(sentence(o11Server, 'rest-wrapper'), /^Legacy/);
  const o11Client = describeQualification('o11', 'client');
  assert.match(sentence(o11Client, 'client private-read'), /live-qualified on MCP/);
  assert.match(sentence(o11Client, 'manual pause'), /native-next-node.*live-qualified on MCP and CLI/);
  assert.match(sentence(o11Client, 'immediate'), /native limit/);
  assert.match(sentence(o11Client, 'mounted screen'), /absent/);
  assert.match(sentence(describeQualification('odc', 'server'), 'exposed SOAP'), /^Native limit/);
  assert.match(sentence(describeQualification('odc', 'server'), 'ssam_debug_invoke'), /^Legacy/);
  assert.equal(describeQualification('o11', 'server'), o11Server, 'deterministic');
  // No evidence: nothing is claimed.
  assert.match(sentence(describeQualification('o11', 'server', {}), 'REST Basic app-user'), /live qualification pending/i);
  // Synthetic placeholder pins are not evidence.
  const fake = Object.fromEntries(Object.entries(SEED_EVIDENCE).map(([k, v]) => [k, { ...v, sha256: 'd'.repeat(64) }]));
  assert.match(sentence(describeQualification('o11', 'server', fake), 'REST Basic app-user'), /pending/i);
  // Only the rows given are described; transports come from the evidence index.
  const rows = [{ lane: 'o11', adapter: 'alpha', label: 'Alpha entry', runtime: 'server', entryKinds: [], contextModes: ['app-user'],
    interactive: true, refusalCode: null, evidenceKeys: ['k'], branches: ['x'] }];
  const mcp = { k: { lane: 'o11', transport: 'mcp', path: 'a/audit.json', sha256: 'a'.repeat(64) } };
  const text = describeQualification('o11', 'server', mcp, rows, []);
  assert.match(text, /Live-qualified on MCP \(CLI proof pending\): Alpha entry\./);
  assert.ok(!/REST|SOAP|Timer|legacy/i.test(text));
  assert.match(describeQualification('o11', 'server', { k: { ...mcp.k, transport: 'cli' } }, rows, []), /on CLI \(MCP proof pending\): Alpha entry/);
  const structured = qualificationRows('o11', 'server', mcp, rows);
  assert.deepEqual(structured.map(r => [r.adapter, r.status, r.transports]), [['alpha', 'live-mcp', ['mcp']]]);
});

test('seed evidence pins match the local audit files when they are present', t => {
  const verdicts = verifyEvidence(SEED_EVIDENCE, { root: workspaceRoot });
  const present = Object.entries(verdicts).filter(([, v]) => v.reason !== 'missing');
  if (!present.length) return t.skip('no local debugger evidence');
  for (const [key, verdict] of present) assert.equal(verdict.ok, true, key + ' ' + JSON.stringify(verdict));
  assert.equal(verifyEvidence({ x: { lane: 'o11', transport: 'mcp', path: '../outside.json', sha256: 'a'.repeat(64) } }, { root: workspaceRoot }).x.reason, 'outside-root');
});
