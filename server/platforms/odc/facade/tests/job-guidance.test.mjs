// Conduction on the normal job entry (catalog M2): a failed job answers with the contract of the failing op, the
// catalog capabilities of its element with that lane's statement, the negative job proving the same refusal, a gap
// when the lane's catalog does not cover the element, and the exact continuation — from the same discovery index.
// Fixtures are real failures of 2026-09-23 (queue INT-M2-001), with machine paths replaced by <fixtures>.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { failureOf, elementOf, jobGuidance, withJobGuidance, jobArgument, GUIDANCE_SCHEMA } from '../job-guidance.mjs';
import { laneSources } from '../discovery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'fixtures', 'job-guidance');
const load = name => JSON.parse(fs.readFileSync(path.join(dir, name + '.run.json'), 'utf8').replaceAll('<fixtures>', dir.replaceAll('\\', '\\\\')));
const cliBuilt = lane => fs.existsSync(laneSources(lane).cli);
// The guidance is measured over the base catalog: what a front delivers must not change these expectations (the
// capability that answers an element, or the gap on a lane) - the same rule as the base discovery tests (C-004).
const BASE_ONLY = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-base-only-'));
const base = lane => ({ ...laneSources(lane), fragments: BASE_ONLY });

test('the failure is read the same way from the O11 text lines and the ODC JSON envelope', () => {
  const o11 = failureOf(load('o11-verb-unknown-key')); const odc = failureOf(load('odc-verb-unknown-key-odc'));
  for (const f of [o11, odc]) { assert.equal(f.stage, 'kernel'); assert.equal(f.op, 0); assert.equal(f.verb, 'create'); assert.equal(f.exception, 'InvalidOperationException'); assert.match(f.message, /^create: unknown key\(s\) 'bogus'/); }
  const verify = failureOf(load('o11-unknown-function'));
  assert.equal(verify.stage, 'verify'); assert.deepEqual(verify.verify.unexpected.map(m => m.id), ['ExpressionUnknownFunction', 'UnusedUserAction']);
  assert.equal(failureOf({ ok: false, output: ['something else'] }).stage, 'unknown');
});

// The job runner (job-runner.mjs) answers JSON: {ok, error?, resultFile}; the failure is read from it as from the
// old text lines, and its continuation is an MCP call, never a shell line.
test('the failure is read from the job runner JSON answer (error, resultFile) like the old text and envelope', () => {
  const kernel = failureOf({ ok: false, lane: 'o11', error: load('o11-verb-unknown-key').output[1].replace(/^== .*?: ok=False /, ''), resultFile: path.join(dir, 'o11-verb-unknown-key.result.json') });
  assert.deepEqual([kernel.stage, kernel.op, kernel.verb, kernel.exception], ['kernel', 0, 'create', 'InvalidOperationException']);
  assert.equal(kernel.resultFile, path.join(dir, 'o11-verb-unknown-key.result.json'));
  const verify = failureOf({ ok: false, lane: 'o11', accepted: false, resultFile: path.join(dir, 'o11-unknown-function.result.json') });
  assert.equal(verify.stage, 'verify'); assert.deepEqual(verify.verify.unexpected.map(m => m.id), ['ExpressionUnknownFunction', 'UnusedUserAction']);
  const runner = failureOf({ ok: false, code: 'job-not-found', error: 'Job file not found: C:\\x.json' });
  assert.deepEqual([runner.stage, runner.message], ['runner', 'Job file not found: C:\\x.json']);
  // The preflight's I2 text form (`op #N (<verb>) [CODE]: ...`) names the same op and verb.
  const preflight = failureOf({ ok: false, code: 'PREFLIGHT_REFUSED', error: 'op #2 (logic) [LOGIC_INVALID]: logic: action Probe: unknown key Fix: use one of: name, steps' });
  assert.deepEqual([preflight.stage, preflight.op, preflight.verb], ['kernel', 2, 'logic']);
  assert.match(preflight.message, /^logic: action Probe: unknown key/);
});

// A small index of the shape discovery builds (no CLI needed): two capabilities whose role is IStructure on o11.
const syntheticIndex = (createContract = { required: ['parent', 'type'], optional: ['name', 'args', 'as', 'source', 'empty'] }) => ({
  key: 'synthetic', builtAt: '2026-10-02T00:00:00Z', lane: 'o11', jobs: [], negatives: [], limits: [], synonyms: {},
  contracts: { verbs: { verbs: { create: createContract } } },
  capabilities: [
    { id: 'data.structure', title: 'Structures', route: { kind: 'job' }, elements: [{ role: 'structure', jobType: 'Structure', native: 'IStructure' }],
      operations: { create: { route: 'job op create', preconditions: ['parent is the module'], roles: { structure: { status: 'applicable', native: 'IStructure' } } } } },
    { id: 'data.structure-attribute', title: 'Structure attributes', route: { kind: 'job' }, elements: [{ role: 'structure', native: 'IStructure' }] },
  ] });

test('the guidance continues with an MCP call {tool:"ssam_discover", arguments:{expand, lane}}, for a file or an inline job', async () => {
  const run = { ok: false, lane: 'o11', error: "op #0 (create Probe): InvalidOperationException: create: unknown key(s) 'bogus'; required: parent, type; optional: name, args, as, source, empty (api --op verbs)" };
  for (const job of [path.join(dir, 'verb-unknown-key.json'), JSON.parse(fs.readFileSync(path.join(dir, 'verb-unknown-key.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(dir, 'verb-unknown-key.json'), 'utf8')).ops]) {
    const g = await jobGuidance({ lane: 'o11', job, run, index: syntheticIndex() });
    assert.equal(g.failure.element, 'IStructure:Probe');
    assert.deepEqual(g.contract.slice.required, ['parent', 'type']);
    assert.deepEqual(g.capabilities.map(c => c.id), ['data.structure', 'data.structure-attribute']);
    assert.deepEqual(g.capabilities[0].expand, { tool: 'ssam_discover', arguments: { expand: 'data.structure:contract+example+operations', lane: 'o11' } });
    assert.deepEqual(g.capabilities[1].expand.arguments, { expand: 'data.structure-attribute:contract+example', lane: 'o11' });
    assert.deepEqual({ tool: g.continuation.tool, arguments: g.continuation.arguments }, g.capabilities[0].expand);
    assert.match(g.continuation.why, /data\.structure/);
    assert.ok(g.next.every(n => typeof n === 'string'));
    assert.doesNotMatch(JSON.stringify(g), /ssam discover|python|dotnet build/);
  }
  // A contract too large to inline is named by keys with its MCP expansion.
  const big = Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['key' + i, 'x'.repeat(40)]));
  const g = await jobGuidance({ lane: 'o11', job: path.join(dir, 'verb-unknown-key.json'), run, index: syntheticIndex(big) });
  assert.deepEqual(g.contract.expand, { tool: 'ssam_discover', arguments: { expand: 'contract:verbs.verbs.create', lane: 'o11' } });
});

test('the element comes from the refusal text, the op type, a Type:Name target or an alias created earlier', () => {
  assert.deepEqual(elementOf({ op: 2, message: "delete: refused, IEntityAttribute 'Email' is used by 2 consumer(s)" }, []).type, 'IEntityAttribute');
  const ops = [{ op: 'create', parent: '@espace', type: 'Structure', as: 'S' }, { op: 'rename', target: '$S', name: 'X' }, { op: 'set', target: 'IServerEntity:Order', prop: 'Public', value: true }];
  assert.equal(elementOf({ op: 0 }, ops).type, 'IStructure');
  assert.equal(elementOf({ op: 1 }, ops).type, 'IStructure');
  assert.equal(elementOf({ op: 2 }, ops).type, 'IServerEntity');
  assert.equal(jobArgument(['--out', 'x.oml', 'job.json', '--quiet']), 'job.json');
  assert.equal(jobArgument(['job.json', '--base', 'b.oml']), 'job.json');
});

test('the normal MCP entry tells every new session how to obtain contracts and that failed jobs carry the guidance', async () => {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ o11: false, odc: false }); // no Studio proxy, no credential
  const client = new Client({ name: 'guidance-entry-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    assert.match(client.getInstructions(), /ssam_discover \{intent, lane\}/);
    // Every session reads an application map first, then the subtrees by @key with the expected hash.
    assert.match(client.getInstructions(), /To read an application, start with ssam_map \{lane, target\}:.*then inspect subtrees, properties and usages by @key with the expected sha256/);
    assert.match(client.getInstructions(), /failed ssam_job\/o11_job .* answers with `discovery`/);
    const tools = (await client.listTools()).tools;
    for (const name of ['ssam_job', 'o11_job']) assert.match(tools.find(t => t.name === name).description, /A failed run also returns `discovery`/, name);
  } finally { await client.close(); await server.close(); }
});

test('a successful run is returned untouched and a guidance failure never changes the job answer', async () => {
  const ok = { ok: true, output: ['== x.json: ok=True'] };
  assert.equal(await withJobGuidance('o11', 'x.json', ok), ok);
  const odd = await withJobGuidance('nolane', 'x.json', load('o11-verb-unknown-key'));
  assert.equal(odd.ok, false); assert.equal(odd.discovery.available, false);
});

for (const lane of ['o11', 'odc']) {
  test(`an unknown verb key (${lane}): the exact verb contract and the capability that states create for the role, within budget`, { skip: !cliBuilt(lane) && `${lane} CLI not built` }, async () => {
    const name = lane === 'o11' ? 'o11-verb-unknown-key' : 'odc-verb-unknown-key-odc';
    const g = await jobGuidance({ lane, sources: base(lane), job: path.join(dir, lane === 'o11' ? 'verb-unknown-key.json' : 'verb-unknown-key-odc.json'), run: load(name) });
    assert.equal(g.schemaVersion, GUIDANCE_SCHEMA);
    assert.equal(g.failure.element, 'IStructure:Probe');
    assert.equal(g.contract.pointer, 'verbs.verbs.create'); assert.deepEqual(g.contract.slice.required, ['parent', 'type']);
    assert.equal(g.capabilities[0].id, 'data.structure');
    assert.equal(g.capabilities[0].operation.name, 'create'); assert.equal(g.capabilities[0].operation.role, 'structure'); assert.equal(g.capabilities[0].operation.status, 'applicable');
    assert.deepEqual(g.continuation.arguments, { expand: 'data.structure:contract+example+operations', lane });
    assert.equal(g.continuation.tool, 'ssam_discover');
    assert.doesNotMatch(JSON.stringify(g), /ssam discover --expand/);
    assert.ok(g.size.bytes <= g.size.budgetBytes);
  });
}

test('a refusal with consumers: the negative job proving the same refusal (not a generic one), the conditional statement with its precondition', { skip: !cliBuilt('o11') && 'o11 CLI not built' }, async () => {
  const g = await jobGuidance({ lane: 'o11', sources: base('o11'), job: 'tests/jobs-negative/delete-attribute-in-use.json', run: load('o11-delete-attribute-in-use') });
  assert.deepEqual(g.refusal.map(r => r.job), ['delete-attribute-in-use']);
  const entity = g.capabilities[0];
  assert.equal(entity.id, 'data.entity'); assert.equal(entity.operation.role, 'entity attribute'); assert.equal(entity.operation.status, 'conditional');
  assert.ok(entity.operation.negative.includes('delete-attribute-in-use'));
  assert.ok(entity.operation.preconditions.some(p => /consumers/.test(p)));
  assert.ok(g.next.some(n => /never add force/.test(n)));
});

test('the ODC refusal of a server action in use is matched to its own negative job only', { skip: !cliBuilt('odc') && 'odc CLI not built' }, async () => {
  const g = await jobGuidance({ lane: 'odc', sources: base('odc'), job: 'tests/jobs-odc-negative/delete-logic-in-use.json', run: load('odc-delete-logic-in-use') });
  assert.deepEqual(g.refusal.map(r => r.job), ['delete-logic-in-use']);
  assert.equal(g.failure.element, 'IServerAction:WfProof_Save');
  assert.ok(g.capabilities.some(c => c.id === 'logic.server-action'));
});

test('a compact-language refusal returns that language contract; a lane without the capability says so with the owner', { skip: !cliBuilt('o11') && 'o11 CLI not built' }, async () => {
  const logic = await jobGuidance({ lane: 'o11', sources: base('o11'), job: 'tests/jobs-negative/logic-unknown-key.json', run: load('o11-logic-unknown-key') });
  assert.equal(logic.contract.pointer, 'logic.action'); assert.ok(logic.contract.slice.includes('inputs'));
  const verify = await jobGuidance({ lane: 'o11', sources: base('o11'), job: 'tests/jobs-negative/unknown-function.json', run: load('o11-unknown-function') });
  assert.equal(verify.failure.stage, 'verify'); assert.equal(verify.failure.element, 'IAssignNode');
  assert.match(verify.catalogGap.note, /no capability of the o11 catalog covers IAssignNode/);
  assert.equal(verify.catalogGap.owner.front, 'A');
  const unused = verify.verify.unexpected.find(m => m.id === 'UnusedUserAction');
  assert.ok(unused.declaredIn.length >= 1 && unused.declaredIn[0].declared.why, 'shows how a suite job declares the same message');
  assert.deepEqual(verify.verify.expectedMessageContract.slice, ['id', 'element', 'why']);
});
