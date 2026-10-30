import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orderParts, writeCall } from '../ssam-code.mjs';
import { moduleMap, ddlFile } from '../module-map.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { shapeCall } from '../call-shapes.mjs';
import { registerSsamReference } from '../ssam-reference.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';
import { writeCapture, writeIndex } from './fixtures/module-index.mjs';

const flow = (name, body = '') => ({ part: 'logic', text: `server action ${name}\n${body}  end\n` });
const page = (name, body = '') => ({ part: 'html', text: `<screen name="${name}">${body}</screen>` });
test('review 1: a multi-action part cycle is left to kernel composition', () => {
  const parts = [{ part: 'logic', text: [flow('A', '  B()\n').text, flow('C').text] }, flow('B', '  C()\n')];
  const result = orderParts(parts);
  assert.equal(result.cycle, undefined); assert.deepEqual(result.parts, parts); assert.ok(result.notes.length);
});
test('review 1: mutually navigating screens preserve their input order', () => {
  const parts = [page('List', '<a destination="Detail"/>'), page('Detail', '<a destination="List"/>')];
  const result = orderParts(parts);
  assert.equal(result.cycle, undefined); assert.deepEqual(result.parts, parts); assert.ok(result.notes.length);
});
test('review 1: child names are neither module declarations nor references', () => {
  const children = { part: 'ops', ops: [{ op: 'create', parent: '@espace', type: 'ServerAction', name: 'GetCustomer' }, { op: 'create', parent: 'GetCustomer', type: 'InputParameter', name: 'Name', dataType: 'Customer Identifier' }] };
  const entity = { part: 'ddl', text: 'create entity Customer (\n Id Long Integer identifier,\n Name Text(120)\n);' };
  const result = orderParts([children, entity]); assert.equal(result.cycle, undefined); assert.equal(result.parts[0], entity);
});
test('review 1: mutual foreign keys stay together when a timer must move', () => {
  const data = { part: 'ddl', text: 'create entity Employee (\n Id Long Integer identifier,\n DepartmentId Department Identifier\n);\ncreate entity Department (\n Id Long Integer identifier,\n ManagerId Employee Identifier\n);\ntimer Nightly action Refresh schedule "03:00"\n' };
  const result = orderParts([data, flow('Refresh', '  local E: Employee\n')]);
  assert.equal(result.cycle, undefined); assert.equal(result.parts.length, 3);
  assert.match(result.parts[0].text, /create entity Employee[^]*create entity Department/);
});
test('review 2: drop and recreate is an ordering barrier', () => {
  const parts = [{ part: 'ddl', text: 'drop entity Foo;\ncreate entity Foo (Id Long Integer);' }, flow('UseFoo', '  local R: Foo\n')];
  assert.equal(orderParts(parts).parts.map(p => p.text).join(''), parts.map(p => p.text).join(''));
});
test('review 2: same-line drop and create remain before their consumer', () => {
  const parts = [{ part: 'ddl', text: 'drop entity Foo; create entity Foo (Id Long Integer);' }, flow('UseFoo', '  local R: Foo\n')];
  assert.equal(orderParts(parts).parts.map(p => p.text).join(''), parts.map(p => p.text).join(''));
});
test('review 2: rename then recreate keeps the order', () => {
  const parts = [{ part: 'ops', ops: [{ op: 'set', target: 'ServerAction:Load', property: 'Name', value: 'LoadOld' }] }, flow('Load')];
  assert.deepEqual(orderParts(parts).parts, parts);
});
for (const attr of ['from="Visit"', 'where="Visit.Id &gt; 0"', 'sort="Visit.Id"']) test('review 3: aggregate reference ' + attr, () => {
  const screen = page('Overview', `<aggregate ${attr}/>`), data = { part: 'ddl', text: 'create entity Visit (Id Long Integer);' };
  assert.deepEqual(orderParts([screen, data]).parts, [data, screen]);
});
test('review 3: drop-only follows a rewrite without the removed reference', () => {
  const drop = { part: 'ddl', text: 'drop entity OldRecord;' }, rewrite = flow('Load');
  assert.deepEqual(orderParts([drop, rewrite]).parts, [rewrite, drop]);
});
for (const name of ['Create', 'Type', 'Timer', 'Drop', 'Setting']) test('review 4: static record ' + name + ' does not split the statement', async () => {
  const { splitDdl } = await import('../part-dependencies.mjs');
  const entity = `create static entity State (\n Id Integer identifier,\n Label Text(50)\n)\nvalues\n ${name} (Id=1, Label="X");`;
  assert.deepEqual(splitDdl(entity + '\ntimer Nightly action Refresh\n').map(t => t.trim()), [entity, 'timer Nightly action Refresh']);
});
test('review 5: unchanged multi-op part has no movement or duplicated change description', () => {
  const ops = [{ op: 'set', target: '@a', property: 'Label', value: 'x' }, { op: 'set', target: '@a', property: 'Label', value: 'y' }];
  const part = { part: 'ops', ops }; assert.equal(orderParts([part]).moved, false);
  const result = writeCall({ lane: 'odc', module: 'Sample', also: [part] });
  assert.equal(result.refusal, undefined); assert.equal(result.arguments.changes.length, 1);
  assert.match(result.arguments.changes[0], /^2 job op/); assert.ok(!result.normalizations?.some(n => n.rule === 'parts-order'));
});
test('review 6: cycle note uses original spelling and delivery proceeds', () => {
  const result = writeCall({ lane: 'o11', module: 'Sample', ...flow('First', '  Second()\n'), also: [flow('Second', '  First()\n')] });
  assert.equal(result.refusal, undefined); assert.match(JSON.stringify(result.normalizations), /First, Second/);
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(dir, 'store') }, c = writeCapture(dir, 'review capture');
  writeIndex(env.SSAM_MODULE_INDEX_ROOT, 'odc', c.sha256);
  const blocks = ['Record', 'Totals', 'Data', 'Entities', 'All'].map((name, i) => ({ name, key: 'K' + i, section: 'structures', kind: 'Structure', elements: 1, text: `type ${name} = { Value: Text; }` }));
  const file = ddlFile('odc', c.sha256, env); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-ddl/1', extractor: 1, adapter: 'kernel', lane: 'odc', sourceSha256: c.sha256, module: { name: 'Sample', key: 'R0' }, elements: blocks.length, blocks }));
  return { dir, ...c, ask: input => moduleMap({ lane: 'odc', target: c.file, ...input }, { env, read: async () => { throw new Error('Unexpected reader'); } }) };
}
test('review 7: missing DDL names are corrected without dropping valid selections', async t => {
  const c = fixture(t), result = await c.ask({ view: 'ddl', element: ['Record', 'Totalz'] });
  assert.deepEqual(result.missing, ['Totalz']); assert.doesNotMatch(result.error, /Record/);
  assert.deepEqual(result.corrected.arguments.element, ['Record', 'Totals']); assert.equal((await c.ask(result.corrected.arguments)).ok, true);
});
for (const name of ['Data', 'Entities', 'All']) test('review 8: exact name wins over section alias ' + name, async t => {
  const result = await fixture(t).ask({ view: 'ddl', element: name });
  assert.equal(result.ok, true); assert.equal(result.element, name); assert.ok(!result.normalizations?.length);
});
test('review 9: a refused uses CSV never claims acceptance', async t => {
  const result = await fixture(t).ask({ view: 'uses', element: 'Record, Totals' });
  assert.equal(result.ok, false); assert.ok(!JSON.stringify(result.normalizations ?? []).includes('CSV was accepted'));
});
test('review 10: missing evidence does not offer a placeholder as corrected', t => {
  const c = fixture(t), result = createEvidenceReader({ roots: [c.dir] }).read({ file: path.join(c.dir, 'absent.json') });
  assert.equal(result.ok, false); assert.equal(result.corrected, undefined);
});
test('review 10: malformed evidence is not advertised as an executable retry', t => {
  const c = fixture(t), file = path.join(c.dir, 'malformed.json'); fs.writeFileSync(file, '{broken');
  const result = createEvidenceReader({ roots: [c.dir] }).read({ file });
  assert.equal(result.code, 'INVALID_JSON'); assert.equal(result.corrected, undefined);
});
test('review 10: missing tool query does not offer a placeholder as corrected', async t => {
  const kernel = tempKernel({ cli: false }), mcp = await linked(registerSsamReference, { root: kernel.root, env: kernel.env });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  const result = await mcp.call('ssam_reference', { lane: 'o11', kind: 'tool', query: {} });
  assert.equal(result.corrected, undefined);
});
test('review 11: any field name filters a text line', t => {
  const c = fixture(t), file = path.join(c.dir, 'lines.json'); fs.writeFileSync(file, JSON.stringify(['Error in Details', 'Other']));
  const result = createEvidenceReader({ roots: [c.dir] }).read({ file, where: 'arbitrary~Details' });
  assert.equal(result.ok, true); assert.equal(result.total, 1);
});
test('review 12: typed delete matches an unqualified call', () => {
  const remove = { part: 'ops', ops: [{ op: 'delete', target: 'ServerAction:Fetch' }] }, caller = flow('Load', '  Fetch()\n');
  assert.deepEqual(orderParts([remove, caller]).parts, [caller, remove]);
});
for (const keyed of [true, false]) test('review 12: 78 deletes use pinned native usages, keyed=' + keyed, async () => {
  const { orderDeleteDependencies } = await import('../delete-dependencies.mjs');
  const target = i => keyed ? '@K' + i : 'ServerAction:A' + i;
  const ops = Array.from({ length: 78 }, (_, i) => ({ op: 'delete', target: target(i) })), calls = [];
  const result = await orderDeleteDependencies(ops, { lane: 'o11', module: 'Sample', map: async input => {
    calls.push(input); return { ok: true, usages: input.usageTargets.map(target => { const i = Number(target.match(/\d+$/)[0]); return { target, resolved: { key: 'K' + i, path: 'ServerAction:A' + i }, entries: i < 77 ? [{ consumer: { key: 'K' + (i + 1), path: 'ServerAction:A' + (i + 1) } }] : [] }; }) };
  } });
  assert.deepEqual(result.ops, [...ops].reverse()); assert.equal(calls.length, 1); assert.ok(result.notes.length);
});
test('review 13: a DDL edit infers its unique job element', async t => {
  const c = fixture(t), file = path.join(c.dir, 'job.json');
  const text = JSON.stringify({ ops: [{ op: 'spec', data: { ddl: 'create index OldIndex on Record (Id);' } }] });
  fs.writeFileSync(file, text);
  const { createHash } = await import('node:crypto');
  const result = writeCall({ lane: 'o11', module: 'Sample', part: 'ddl', basedOn: { job: file, sha256: createHash('sha256').update(text).digest('hex') }, edits: [{ find: 'OldIndex', with: 'NewIndex' }] }, { readJob: () => ({ ops: [{ op: 'spec', data: { ddl: 'create index OldIndex on Record (Id);' } }] }) });
  assert.equal(result.refusal, undefined, JSON.stringify(result)); assert.ok(result.normalizations.some(n => n.rule === 'ddl-edit-target'));
});
test('review 13: evidence text is accepted as a reported filter before schema validation', () => {
  const result = shapeCall('ssam_evidence', { file: 'evidence.json', text: 'Details' });
  assert.equal(result.args.where, '~Details'); assert.equal(result.args.text, undefined); assert.ok(result.normalizations.length);
});
test('review 13: incomplete code input offers grammar guidance only', () => {
  const result = writeCall({ lane: 'o11', part: 'logic', text: 'invalid' });
  assert.equal(result.refusal.corrected, undefined); assert.equal(result.refusal.continuation.arguments.action, 'grammar');
});
test('review 13: parent Kind:Name resolves in the same capture', async t => {
  const c = fixture(t), result = await c.ask({ parent: 'MobileFlow:MainFlow' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.count, 3); assert.ok(result.normalizations.length);
});
test('review 13: an owned action suffix resolves against its pinned reading', async () => {
  const { expandEditPart } = await import('../flow-edits.mjs');
  const reading = { action: { name: 'MainFlow/Settings/SaveProfile', key: 'ActionKey' }, text: 'action Settings.SaveProfile @ActionKey\n  assign Value = 1 @n1\n  end @n2\n' };
  const result = expandEditPart({ part: 'logic', element: 'Settings.SaveProfile', basedOn: 'a'.repeat(16), edits: [{ replace: '@n1', with: 'assign Value = 2' }] }, 'o11', { readReading: () => reading });
  assert.deepEqual(result.problems, []); assert.ok(result.notes.some(n => n.rule === 'action-path'));
});
test('round2 4: inline dryRun correction executes the native checker without writing', async t => {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport, Client } = { ...(await import('@modelcontextprotocol/server')), ...(await import('@modelcontextprotocol/client')) };
  const c = fixture(t); let writes = 0;
  const server = await createSsamServer({ odc: false, deps: { dataRoot: c.dir, answersRoot: c.dir, runAnvil: async args => { assert.ok(args.includes('--check')); assert.ok(args.includes('--no-write-fields')); writes++; return { envelope: { ok: true, data: { ok: true, problems: [] } } }; }, writeLock: async (_, fn) => fn() } });
  const [a,b] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'review', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]); t.after(async () => { await client.close(); await server.close(); });
  const result = (await client.callTool({ name: 'o11_data', arguments: { host: 'example.test', module: 'Sample', oml: c.file, request: { operation: 'update', entity: 'Record', records: [{ Id: '1', Value: 'x' }], dryRun: true } } })).structuredContent;
  assert.equal(result.code, 'INPUT_INVALID'); assert.equal(writes, 0);
  assert.equal(result.corrected.tool, 'o11_data'); assert.equal(result.corrected.arguments.request.preview, true);
  const corrected = (await client.callTool({ name: result.corrected.tool, arguments: result.corrected.arguments })).structuredContent;
  assert.equal(corrected.ok, true, JSON.stringify(corrected)); assert.equal(corrected.written, 0); assert.equal(writes, 1);
  const guidance = (await client.callTool({ name: 'o11_data', arguments: { host: 'example.test', module: 'Sample', oml: c.file, request: { operation: 'update', entity: 'Record', columns: { Value: 'Value' } } } })).structuredContent;
  assert.equal(guidance.corrected, undefined); assert.equal(guidance.continuation.tool, 'ssam_reference');
  const filePreview = (await client.callTool({ name: 'o11_data', arguments: { host: 'example.test', module: 'Sample', oml: c.file, request: { operation: 'update', entity: 'Record', files: [], preview: true } } })).structuredContent;
  assert.equal(filePreview.ok, false); assert.equal(writes, 1);
});
test('review 12: code delivery applies the native keyed delete order', async t => {
  const { registerSsamCode } = await import('../ssam-code.mjs');
  const { fromJsonSchema } = await import('@modelcontextprotocol/server');
  let delivered;
  const mcp = await linked(registerSsamCode, { fromJsonSchema, map: async input => ({ ok: true, usages: input.usageTargets.map(target => ({ target, resolved: { key: target.slice(1), path: 'ServerAction:' + target.slice(1) }, entries: target === '@A' ? [{ consumer: { key: 'B', path: 'ServerAction:B' } }] : [] })) }),
    deliver: async (_, args) => { delivered = args.job.ops; return { structuredContent: { ok: true }, content: [{ type: 'text', text: '{"ok":true}' }] }; } });
  t.after(() => mcp.close());
  const result = await mcp.call('ssam_code', { lane: 'o11', action: 'write', module: 'Sample', ops: [{ op: 'delete', target: '@A' }, { op: 'delete', target: '@B' }] });
  assert.equal(result.ok, true); assert.deepEqual(delivered.map(op => op.target), ['@B', '@A']);
});

// Round 2 regressions: each failed on dcbfbd2e.
const refresh = () => flow('Refresh');
const timer = () => ({ part: 'ddl', text: 'timer Nightly action Refresh schedule "03:00"' });
test('round2 1: an unrelated SCC does not suppress the timer dependency', () => {
  const t = timer(), r = refresh(), a = flow('First', '  Second()\n'), b = flow('Second', '  First()\n');
  const result = orderParts([t, a, b, r]);
  assert.ok(result.parts.indexOf(r) < result.parts.indexOf(t));
  assert.ok(result.parts.indexOf(a) < result.parts.indexOf(b)); assert.match(result.notes.join(), /First/);
});
test('round2 1: a disjoint entity-actions barrier does not create a cycle', () => {
  const use = flow('UseFoo', '  local R: Foo\n'), gen = { part: 'ops', ops: [{ op: 'entity-actions', data: { entities: 'all' } }] }, data = { part: 'ddl', text: 'create entity Foo (Id Long Integer);' };
  assert.deepEqual(orderParts([use, gen, data]).parts, [data, gen, use]);
});
test('round2 2: distinct drop/create names leave timer dependencies enabled', () => {
  const data = { part: 'ddl', text: 'drop entity Old;\ncreate entity Foo (Id Long Integer);\ntimer Nightly action Refresh schedule "03:00"' }, r = refresh();
  const parts = orderParts([data, r]).parts; assert.ok(parts.indexOf(r) < parts.findIndex(p => /timer Nightly/.test(p.text ?? '')));
});
test('round2 3: a screen action consumes its screen without writing the screen', () => {
  const action = { part: 'logic', text: 'action Visits.OpenSummary\n  end\n' }, screen = page('Visits', '<button onclick="OpenSummary">x</button>');
  assert.deepEqual(orderParts([action, screen]).parts, [screen, action]);
});
test('round2 4: write refusal grammar is guidance, never corrected', () => {
  const result = writeCall({ lane: 'o11', part: 'logic', text: 'invalid' });
  assert.equal(result.refusal.corrected, undefined); assert.equal(result.refusal.continuation.arguments.action, 'grammar');
});
test('round2 4: missing map target has guidance without a fake corrected read', async () => {
  const result = await moduleMap({ lane: 'o11' }); assert.equal(result.ok, false);
  assert.equal(result.corrected, undefined); assert.equal(result.continuation.tool, 'ssam_discover');
});
test('round2 4: registered grammar guidance never becomes corrected', async t => {
  const { registerSsamCode } = await import('../ssam-code.mjs'), { fromJsonSchema } = await import('@modelcontextprotocol/server');
  const mcp = await linked(registerSsamCode, { fromJsonSchema }); t.after(() => mcp.close());
  const result = await mcp.call('ssam_code', { lane: 'o11', action: 'read' });
  assert.equal(result.corrected, undefined); assert.equal(result.continuation.arguments.action, 'grammar');
});
test('round2 4: a known incompatible code argument has a correction that executes', async t => {
  const { registerSsamCode } = await import('../ssam-code.mjs'), { fromJsonSchema } = await import('@modelcontextprotocol/server');
  let delivered = 0; const mcp = await linked(registerSsamCode, { fromJsonSchema, deliver: async () => { delivered++; return { structuredContent: { ok: true }, content: [{ type: 'text', text: '{\"ok\":true}' }] }; } }); t.after(() => mcp.close());
  const result = await mcp.call('ssam_code', { lane: 'o11', action: 'write', module: 'Sample', ...flow('Run'), base: 'unexpected.oml' });
  assert.equal(result.corrected.arguments.base, undefined); assert.equal(result.corrected.arguments.action, 'write');
  assert.equal((await mcp.call(result.corrected.tool, result.corrected.arguments)).ok, true); assert.equal(delivered, 1);
});
test('round2 5: every alternative field is normalized on string evidence rows', t => {
  const c = fixture(t), file = path.join(c.dir, 'alternatives.json'); fs.writeFileSync(file, JSON.stringify(['Error in Details', 'Warning in Overview', 'Unrelated']));
  const result = createEvidenceReader({ roots: [c.dir] }).read({ file, where: 'name~Details|title~Overview' });
  assert.equal(result.total, 2);
});
for (const keyed of [false, true]) test('round2 6: native indexed deletes cross disjoint mutations, including path, keyed=' + keyed, async t => {
  const { deletionIndex } = await import('./fixtures/r2-delete-index.mjs'), { orderDeleteDependencies } = await import('../delete-dependencies.mjs');
  const c = fixture(t), native = deletionIndex(c.dir), target = i => keyed ? '@A' + String(i).padStart(3, '0') : 'ServerAction:Action' + i;
  const removes = Array.from({ length: 78 }, (_, i) => ({ op: 'delete', [i % 2 ? 'path' : 'target']: target(i) }));
  const unrelated = { op: 'set', target: '@Unrelated', property: 'Label', value: 'Changed' };
  const result = await orderDeleteDependencies([removes[0], unrelated, ...removes.slice(1)], { lane: 'o11', module: 'Sample', map: native.map });
  const positions = new Map(result.ops.filter(op => op.op === 'delete').map((op, i) => [Number((op.target ?? op.path).match(/\d+$/)[0]), i]));
  for (const [consumer, provider] of native.dependencies) if (consumer.startsWith('A')) assert.ok(positions.get(Number(consumer.slice(1))) < positions.get(Number(provider.slice(1))));
  assert.equal(result.ops.includes(unrelated), true);
  if (!keyed) {
    const parent = { op: 'delete', path: 'ServerAction:Action1' }, child = { op: 'delete', path: 'ServerAction:Action1/ExecuteServerActionNode:Call' };
    assert.deepEqual((await orderDeleteDependencies([parent, child], { lane: 'o11', module: 'Sample', map: native.map })).ops, [child, parent]);
  }
});
test('round2 7: N deletes request one native rich-index read', async t => {
  const { deletionIndex } = await import('./fixtures/r2-delete-index.mjs'), { orderDeleteDependencies } = await import('../delete-dependencies.mjs');
  const native = deletionIndex(fixture(t).dir);
  await orderDeleteDependencies(Array.from({ length: 78 }, (_, i) => ({ op: 'delete', target: 'ServerAction:Action' + i })), { lane: 'o11', module: 'Sample', map: native.map });
  assert.deepEqual(native.counts(), { calls: 1, reads: 1 });
});
test('support: a native keyed delete cannot cross a same-name recreation', async t => {
  const { deletionIndex } = await import('./fixtures/r2-delete-index.mjs'), { orderDeleteDependencies } = await import('../delete-dependencies.mjs');
  const native = deletionIndex(fixture(t).dir, 2), a = { op: 'delete', target: '@A000' }, recreate = { op: 'create', type: 'ServerAction', name: 'Action0' }, b = { op: 'delete', path: 'ServerAction:Action1' };
  const result = (await orderDeleteDependencies([a, recreate, b], { lane: 'o11', module: 'Sample', map: native.map })).ops; assert.ok(result.indexOf(a) < result.indexOf(recreate));
});

test('round3 6: discover is restored and the core stays within the base size', async t => {
  const { createSsamServer } = await import('../ssam.mjs'), { toolListingBytes } = await import('../tool-listing.mjs');
  const server = await createSsamServer({ deps: {} }); t.after(() => server.close());
  const core = new Set(['ssam_doctor','ssam_connect','ssam_discover','ssam_map','ssam_code','ssam_reference','ssam_evidence','ssam_task','o11_inspect','o11_deliver','o11_publish','o11_studio','studio_deliver','studio_inspect','studio_status']);
  const bytes = server.ssamTools.filter(tool => core.has(tool.name)).reduce((sum, tool) => sum + toolListingBytes(tool), 0);
  assert.ok(bytes <= 34057, `${bytes}: exceeds the base size`);
  const { TOOL_LISTING } = await import('../tool-listing.mjs');
  assert.match(TOOL_LISTING.ssam_discover.description, /`tools` gives the exact MCP tool, its verb and arguments/);
  assert.match(TOOL_LISTING.ssam_discover.description, /app adds module context; packet:true is the work packet for an agent/);
});

test('round2 7: code delivery delegates O11 planning without a second module read', async t => {
  const { registerSsamCode } = await import('../ssam-code.mjs'), { fromJsonSchema } = await import('@modelcontextprotocol/server');
  const { deletionIndex } = await import('./fixtures/r2-delete-index.mjs'), { prepareDeleteJob } = await import('../delete-dependencies.mjs');
  const native = deletionIndex(fixture(t).dir, 3); let delivered;
  const mcp = await linked(registerSsamCode, { fromJsonSchema, map: native.map, o11PlansDeletes: true,
    deliver: async (_, args) => {
      delivered = (await prepareDeleteJob(args.job, { lane: 'o11', module: 'Sample', map: native.map })).document;
      return { structuredContent: { ok: true }, content: [{ type: 'text', text: '{"ok":true}' }] };
    } }); t.after(() => mcp.close());
  await mcp.call('ssam_code', { lane: 'o11', action: 'write', module: 'Sample', ops: [0,1,2].map(i => ({ op: 'delete', target: 'ServerAction:Action' + i })) });
  assert.deepEqual(delivered.ops.map(op => op.target), ['ServerAction:Action2','ServerAction:Action1','ServerAction:Action0']);
  assert.deepEqual(native.counts(), { calls: 1, reads: 1 });
});

for (const op of [{ op: 'set', target: 'Foo', prop: 'Description', value: 'x' }, { op: 'entity-actions', data: { entities: ['Foo'] } }]) test('round3 1: a new entity precedes its modifier ' + op.op, () => {
  const modifier = { part: 'ops', ops: [op] }, create = { part: 'ddl', text: 'create entity Foo (Id Long Integer);' };
  assert.deepEqual(orderParts([modifier, create]).parts, [create, modifier]);
});
test('round3 1: a shared-name modifier does not absorb the creator into a call cycle', () => {
  const use = flow('UseFoo', '  local R: Foo\n  Helper()\n'), helper = flow('Helper', '  UseFoo()\n');
  const modifier = { part: 'ops', ops: [{ op: 'set', target: 'Foo', prop: 'Description', value: 'x' }] }, create = { part: 'ddl', text: 'create entity Foo (Id Long Integer);' };
  const result = orderParts([use, modifier, create, helper]);
  assert.ok(result.parts.indexOf(create) < result.parts.indexOf(use)); assert.ok(result.parts.indexOf(use) < result.parts.indexOf(helper));
});
test('round3 2: a mixed DDL splits creation from drop around the consumer rewrite', () => {
  const rewrite = { part: 'logic', text: 'action Visitas.Cancelar\n  end\n' }, data = { part: 'ddl', text: 'create entity FamBar (Id Long Integer);\ndrop entity FamFoo;' };
  const result = orderParts([rewrite, data]); assert.equal(result.parts.length, 3);
  assert.match(result.parts[0].text, /^create entity FamBar/); assert.equal(result.parts[1], rewrite); assert.match(result.parts[2].text, /drop entity FamFoo/);
});
function largeOps(n) { return Array.from({ length: n }, (_, i) => i % 4 === 0 ? { op: 'delete', target: 'ServerAction:Old' + i }
  : i % 4 === 1 ? { op: 'set', target: 'Entity' + (i % 50), prop: 'Description', value: 'v' + i }
  : i % 4 === 2 ? { op: 'create', parent: '@espace', type: 'IServerAction', name: 'New' + i }
  : { op: 'logic', data: { flow: [`server action Use${i}\n  New${i - 1}()\n  end\n`] } }); }
test('round3 3: 2000 mixed ops have a generous 500ms planning limit', () => {
  const ops = largeOps(2000), started = performance.now(); const result = orderParts([{ part: 'ops', ops }]);
  assert.equal(result.parts.flatMap(p => p.ops).length, ops.length);
  assert.ok(performance.now() - started < 500, 'planning exceeded 500ms');
});
test('round3 3: the graph reads each rank once', async () => {
  const { sortDependencies } = await import('../part-dependencies.mjs'); const parts = largeOps(40).map(op => ({ part: 'ops', ops: [op] })); let calls = 0;
  sortDependencies(parts, () => ({ creates: new Set(), consumes: new Set(), removes: new Set(), writes: new Set(), labels: new Map() }), () => { calls++; return 0; });
  assert.equal(calls, parts.length);
});
test('round3 4: preview inside a batch is refused before any native write', async t => {
  const { createSsamServer } = await import('../ssam.mjs'), { InMemoryTransport, Client } = { ...(await import('@modelcontextprotocol/server')), ...(await import('@modelcontextprotocol/client')) };
  const c = fixture(t); let native = 0;
  const server = await createSsamServer({ odc: false, deps: { dataRoot: c.dir, runAnvil: async () => { native++; return { envelope: { ok: true, data: { ok: true } } }; }, writeLock: async (_, fn) => fn() } });
  const [a,b] = InMemoryTransport.createLinkedPair(), client = new Client({ name: 'round3', version: '1' }); await Promise.all([server.connect(a), client.connect(b)]); t.after(async () => { await client.close(); await server.close(); });
  const result = (await client.callTool({ name: 'o11_data', arguments: { host: 'example.test', module: 'Sample', oml: c.file, request: { authorization: 'Apply these fixture records', batch: [{ operation: 'insert', entity: 'Record', preview: true, records: [{ Value: 'x' }] }] } } })).structuredContent;
  assert.equal(result.code, 'INPUT_INVALID'); assert.equal(result.corrected, undefined); assert.equal(native, 0);
});
test('round3 5: native planning preserves all nondelete relative order and honest movement notes', async t => {
  const { deletionIndex } = await import('./fixtures/r2-delete-index.mjs'), { orderDeleteDependencies } = await import('../delete-dependencies.mjs');
  const native = deletionIndex(fixture(t).dir), a = { op: 'delete', target: 'ServerAction:Action1' }, b = { op: 'delete', target: 'ServerAction:Action2' };
  const logic = { op: 'logic', data: { flow: ['server action UseNew\n  local R: NewFoo\n  end\n'] } }, create = { op: 'create', parent: '@espace', type: 'ServerEntity', name: 'NewFoo' };
  const ops = [a, logic, create, b], result = await orderDeleteDependencies(ops, { lane: 'o11', module: 'Sample', map: native.map });
  assert.deepEqual(result.ops, ops); assert.deepEqual(result.notes, []);
});
test('support: the native DAG includes fan-in, fan-out, screen and unselected consumers', async t => {
  const { deletionIndex } = await import('./fixtures/r2-delete-index.mjs'), { orderDeleteDependencies } = await import('../delete-dependencies.mjs');
  const native = deletionIndex(fixture(t).dir), ops = [...Array.from({ length: 78 }, (_, i) => ({ op: 'delete', target: 'ServerAction:Action' + i })), { op: 'delete', target: 'MobileScreen:Summary' }];
  const result = await orderDeleteDependencies(ops, { lane: 'o11', module: 'Sample', map: native.map });
  const pos = key => result.ops.findIndex(op => op.target === (key === 'S' ? 'MobileScreen:Summary' : 'ServerAction:Action' + Number(key.slice(1))));
  for (const [consumer, provider] of native.dependencies) assert.ok(pos(consumer) < pos(provider));
  assert.equal(result.ops.length, ops.length); assert.ok(!result.ops.some(op => op.target.includes('Outside'))); assert.deepEqual(native.counts(), { calls: 1, reads: 1 });
});
test('support: an incomplete native index retains the job with a note', async t => {
  const { deletionIndex } = await import('./fixtures/r2-delete-index.mjs'), { orderDeleteDependencies } = await import('../delete-dependencies.mjs');
  const native = deletionIndex(fixture(t).dir, 78, { complete: false }), ops = [0,1,2].map(i => ({ op: 'delete', target: 'ServerAction:Action' + i }));
  const result = await orderDeleteDependencies(ops, { lane: 'o11', module: 'Sample', map: native.map }); assert.equal(result.ops, ops); assert.ok(result.notes.length);
});

test('round3 4: the delivery handler refuses batch preview before reaching the runner', async t => {
  const { createSsamServer } = await import('../ssam.mjs'); const c = fixture(t); let handler, native = 0;
  const server = await createSsamServer({ odc: false, deps: { dataRoot: c.dir, runAnvil: async () => { native++; return { envelope: { ok: true, data: { ok: true } } }; },
    toolInput: { relaxTool(name, config, fn) { if (name === 'o11_data') handler = fn; return { config, handler: fn }; } } } }); t.after(() => server.close());
  const answer = await handler({ host: 'example.test', module: 'Sample', oml: c.file, request: { authorization: 'Apply these fixture records', batch: [{ operation: 'insert', entity: 'Record', preview: true, records: [{ Value: 'x' }] }] } });
  assert.equal(answer.structuredContent.code, 'INPUT_INVALID'); assert.equal(answer.structuredContent.corrected, undefined); assert.equal(native, 0);
});

test('round3 2: mixed spec DDL uses creation and drop ranks as well', () => {
  const rewrite = flow('Rewrite'), spec = { part: 'ops', ops: [{ op: 'spec', data: { ddl: 'create entity NewRecord (Id Long Integer);\ndrop entity OldRecord;' } }] };
  const result = orderParts([rewrite, spec]).parts; assert.equal(result.length, 3);
  assert.match(result[0].ops[0].data.ddl, /^create entity/); assert.equal(result[1], rewrite); assert.match(result[2].ops[0].data.ddl, /drop entity/);
});

test('round3 3: native deletion planning scales to 2000 targets', async () => {
  const { orderDeleteDependencies } = await import('../delete-dependencies.mjs');
  const ops = Array.from({ length: 2000 }, (_, i) => ({ op: 'delete', target: '@D' + i }));
  const usages = ops.map((op, i) => ({ target: op.target, resolved: { key: 'D' + i, name: 'A' + i, path: 'ServerAction:A' + i }, entries: i + 1 < ops.length ? [{ consumer: { key: 'D' + (i + 1), path: 'ServerAction:A' + (i + 1) } }] : [] }));
  const start = performance.now(); const result = await orderDeleteDependencies(ops, { lane: 'o11', module: 'Sample', map: async () => ({ ok: true, usages }) });
  assert.equal(result.ops[0], ops.at(-1)); assert.equal(result.ops.at(-1), ops[0]); assert.ok(performance.now() - start < 500, 'delete planning exceeded 500ms');
});

for (const ending of ['\n', '\r\n', '']) test('round4 1: a keyed drop keeps its trailing comment, ending=' + JSON.stringify(ending), async () => {
  const { splitDdl } = await import('../part-dependencies.mjs');
  const create = 'create entity FamBar (Id Long Integer);', drop = '\ndrop entity FamFoo; -- @E5' + ending;
  assert.deepEqual(splitDdl(create + drop), [create, drop]);
  const parts = orderParts([flow('Rewrite'), { part: 'ddl', text: create + drop }]).parts;
  assert.equal(parts.length, 3); assert.equal(parts[2].text, drop);
});
test('round4 1: keyed static records stay with their entity when a timer is separated', async () => {
  const { splitDdl } = await import('../part-dependencies.mjs');
  const entity = 'create static entity Status ( -- @E2\n Id Integer identifier, -- @E2a\n Label Text(50) -- @E2b\n)\nvalues\n R000 (Id=1, Label="A"), -- @r0\n R001 (Id=2, Label="B"); -- @r1\n';
  const timer = 'timer Nightly action Refresh -- @M1\n', text = entity + timer;
  assert.deepEqual(splitDdl(text), [entity, timer]);
  const result = orderParts([{ part: 'ddl', text }, flow('Refresh', '  local S: Status Identifier\n')]);
  assert.equal(result.parts[0].text, entity); assert.equal(result.parts[2].text, timer);
});
for (const size of ['small', 'large']) test('round4 1: ddlOf roundtrip retains every keyed line, size=' + size, async () => {
  const { ddlOf } = await import('./fixtures/ddl-text.mjs'), { ddlText } = await import('../module-ddl.mjs'), { splitDdl } = await import('../part-dependencies.mjs');
  const text = ddlText(ddlOf({ lane: 'o11', sourceSha256: 'a'.repeat(64), size })), fragments = splitDdl(text);
  assert.equal(fragments.join(''), text);
  assert.ok(fragments.every(f => !/^\s*--\s*@/.test(f)), 'no fragment starts with an orphan key');
  assert.ok(fragments.every(f => f.replace(/--[^\r\n]*/g, '').trim()), 'no comment-only fragment');
  const keyedLines = value => value.split(/\r?\n/).filter(line => /--\s*@/.test(line));
  assert.deepEqual(fragments.flatMap(keyedLines), keyedLines(text));
});
test('round4 1: trailing comments never become their own fragment', async () => {
  const { splitDdl } = await import('../part-dependencies.mjs');
  const text = 'drop entity Old; -- @E1\n-- trailing note\n';
  assert.deepEqual(splitDdl(text), [text]);
});
test('round4 2: a keyed spec drop carries the original basedOn', () => {
  const basedOn = 'b'.repeat(64), text = 'create entity FamBar (Id Long Integer);\ndrop entity FamFoo; -- @E5\n';
  const result = orderParts([{ part: 'ops', ops: [{ op: 'spec', data: { basedOn, ddl: text } }] }, flow('Rewrite')]);
  const fragments = result.parts.flatMap(p => p.ops ?? []).filter(op => op.op === 'spec');
  assert.equal(fragments.length, 2); assert.ok(fragments.every(op => op.data.basedOn === basedOn));
  assert.match(fragments[1].data.ddl, /drop entity FamFoo; -- @E5/);
});
test('round4 2: a keyed timer spec also carries basedOn when separated', () => {
  const basedOn = 'c'.repeat(64), text = 'create entity Counter (Id Long Integer); -- @E1\ntimer RefreshTimer action Refresh -- @T1\n';
  const result = orderParts([{ part: 'ops', ops: [{ op: 'spec', data: { basedOn, ddl: text } }] }, flow('Refresh', '  local R: Counter\n')]);
  const fragments = result.parts.flatMap(p => p.ops ?? []).filter(op => op.op === 'spec');
  assert.equal(fragments.length, 2); assert.ok(fragments.every(op => op.data.basedOn === basedOn));
  assert.match(fragments[1].data.ddl, /timer RefreshTimer action Refresh -- @T1/);
});
test('round4 3: a chain of 20000 parts is iterative and under one second', () => {
  const parts = Array.from({ length: 20000 }, (_, i) => flow('P' + i, i ? `  P${i - 1}()\n` : '')).reverse();
  const start = performance.now(), result = orderParts(parts), elapsed = performance.now() - start;
  assert.equal(result.parts.length, parts.length); assert.ok(result.parts.every((part, i) => part === parts[parts.length - 1 - i]));
  assert.ok(elapsed < 1000, `planning took ${elapsed}ms`);
});
test('round4 3: a chain of 10000 deletes is iterative and under one second', async () => {
  const { orderDeleteDependencies } = await import('../delete-dependencies.mjs');
  const ops = Array.from({ length: 10000 }, (_, i) => ({ op: 'delete', target: '@K' + i }));
  const usages = ops.map((op, i) => ({ target: op.target, resolved: { key: 'K' + i, path: 'ServerAction:A' + i, name: 'A' + i }, entries: i + 1 < ops.length ? [{ consumer: { key: 'K' + (i + 1), path: 'ServerAction:A' + (i + 1) } }] : [] }));
  const start = performance.now(), result = await orderDeleteDependencies(ops, { lane: 'o11', module: 'Sample', map: async () => ({ ok: true, usages }) }), elapsed = performance.now() - start;
  assert.equal(result.ops.length, ops.length); assert.ok(result.ops.every((op, i) => op === ops[ops.length - 1 - i]));
  assert.ok(elapsed < 1000, `delete planning took ${elapsed}ms`);
});
