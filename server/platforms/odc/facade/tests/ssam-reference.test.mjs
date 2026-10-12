import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerSsamReference, resolveUiCatalog, functionList, FUNCTIONS_MAX } from '../ssam-reference.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';

// Every verb answers {ok:true, data:{argv}} unless a test gives its own handler.
const echo = verb => args => ({ ok: true, command: verb, data: { argv: args } });
const verbs = ['api', 'functions', 'ui-block', 'types', 'where-can', 'recipe', 'verify-message', 'verify-catalog'];
async function harness(t, { handlers = {}, cli = true } = {}) {
  const kernel = tempKernel({ cli });
  const run = fakeAnvil({ ...Object.fromEntries(verbs.map(v => [v, echo(v)])),
    'check-job': () => ({ ok: true, command: 'check-job', data: { valid: true, errors: [], elapsedMs: 1 } }),
    'check-delivery': () => ({ ok: true, command: 'check-delivery', data: { accepted: true } }), ...handlers });
  let n = 0;
  const deps = { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, uuid: () => `job-${++n}` };
  const mcp = await linked(registerSsamReference, deps);
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  return { ...mcp, run, root: kernel.root, ask: (lane, kind, query) => mcp.call('ssam_reference', { lane, kind, query }) };
}

test('ssam_reference maps each kind to the exact O11 CLI argv, in the kernel folder', async t => {
  const h = await harness(t);
  const catalog = path.join(h.root, 'model-api-test.json'); fs.writeFileSync(catalog, '{}');
  const ui = path.join(h.root, 'catalog', 'ui');
  const cases = [
    ['api', 'IForEachNode', ['api', '--name', 'IForEachNode']],
    ['api', { name: 'IForEachNode', catalog }, ['api', '--name', 'IForEachNode', '--catalog', catalog]],
    ['api', { op: 'logic' }, ['api', '--op', 'logic']],
    ['api', { op: 'native', type: 'IServerAction' }, ['api', '--op', 'native', '--type', 'IServerAction']],
    ['functions', 'AddDays', ['functions', '--name', 'AddDays']],
    ['functions', { find: 'date' }, ['functions', '--find', 'date']],
    ['ui-block', 'Tabs', ['ui-block', '--catalog', path.join(ui, 'OutSystemsUI-2.28.1.json'), '--name', 'Tabs']],
    ['ui-block', { catalog: 'RichWidgets', find: 'popup' }, ['ui-block', '--catalog', path.join(ui, 'RichWidgets-unversioned.json'), '--find', 'popup']],
    ['ui-block', { catalog: 'OutSystemsUI-2.9.0', name: 'Card' }, ['ui-block', '--catalog', path.join(ui, 'OutSystemsUI-2.9.0.json'), '--name', 'Card']],
    ['types', { assembly: 'ServiceStudio.Framework', filter: 'MobileWidgets', max: 20 }, ['types', '--assembly', 'ServiceStudio.Framework', '--filter', 'MobileWidgets', '--max', '20']],
    ['where-can', 'IServiceAction', ['where-can', '--name', 'IServiceAction']],
    ['recipe', 'table with filter', ['recipe', '--find', 'table with filter']],
    ['recipe', { find: 'crud', ops: true, max: 3 }, ['recipe', '--find', 'crud', '--ops', '--max', '3']],
    ['verify-message', 'RequiredConnector_Out', ['verify-message', '--name', 'RequiredConnector_Out']],
    ['verify-message', { find: 'connector' }, ['verify-message', '--find', 'connector']],
  ];
  for (const [index, [kind, query, argv]] of cases.entries()) {
    const value = await h.ask('o11', kind, query);
    assert.equal(value.ok, true, kind + ' ' + JSON.stringify(value));
    assert.deepEqual(h.run.calls[index].args, argv, kind);
    assert.equal(h.run.calls[index].options.cwd, h.root, 'cwd = kernel (where-can and verify-message find the repo there)');
    assert.equal(h.run.calls[index].options.cli, undefined, 'the O11 lane runner resolves its own anvil.dll');
    assert.deepEqual(value.data, { argv });
  }
  const receipt = path.join(h.root, 'result.json'); fs.writeFileSync(receipt, '{}');
  assert.equal((await h.ask('o11', 'check-delivery', receipt)).ok, true);
  assert.deepEqual(h.run.calls.at(-1).args, ['check-delivery', '--result', receipt]);
});

test('static answers are cached per (lane, kind, query); check-job and check-delivery always run', async t => {
  const h = await harness(t);
  const first = await h.ask('o11', 'functions', { find: 'date' });
  const second = await h.ask('o11', 'functions', { find: 'date' });
  assert.equal(first.cached, undefined); assert.equal(second.cached, true);
  assert.deepEqual(second.data, first.data);
  assert.equal(h.run.calls.length, 1);
  await h.ask('o11', 'functions', { name: 'date' });
  await h.ask('o11', 'recipe', { ops: true, find: 'crud' }); await h.ask('o11', 'recipe', { find: 'crud', ops: true });
  assert.equal(h.run.calls.length, 3, 'key order does not matter; another query runs');
  const job = path.join(h.root, 'job.json'); fs.writeFileSync(job, '{"ops":[]}');
  await h.ask('o11', 'check-job', job); await h.ask('o11', 'check-job', job);
  const receipt = path.join(h.root, 'result.json'); fs.writeFileSync(receipt, '{}');
  await h.ask('o11', 'check-delivery', receipt); await h.ask('o11', 'check-delivery', receipt);
  assert.equal(h.run.calls.length, 7);
  // A refusal is not cached.
  const failing = await harness(t, { handlers: { api: () => ({ ok: false, command: 'api', error: 'ArgumentException: missing --name' }) } });
  await failing.ask('o11', 'api', 'IX'); await failing.ask('o11', 'api', 'IX');
  assert.equal(failing.run.calls.length, 2);
});

test('check-job takes a path or the job itself, stored under <lane>/jobs/inline/<uuid>.json', async t => {
  const h = await harness(t, { handlers: { 'check-job': args => {
    const job = JSON.parse(fs.readFileSync(args[2], 'utf8'));
    return job.ops.length ? { ok: true, command: 'check-job', data: { valid: true, errors: [] } }
      : { ok: false, command: 'check-job', data: { valid: false, errors: ['op list is empty'] } };
  } } });
  const inline = { ops: [{ op: 'logic', data: { actions: [] } }] };
  const value = await h.ask('o11', 'check-job', inline);
  const stored = path.join(h.root, '.local', 'jobs', 'inline', 'job-1.json');
  assert.equal(value.ok, true); assert.equal(value.job, stored);
  assert.deepEqual(h.run.calls[0].args, ['check-job', '--job', stored]);
  assert.deepEqual(JSON.parse(fs.readFileSync(stored, 'utf8')), inline);
  const invalid = await h.ask('o11', 'check-job', { ops: [] });
  assert.equal(invalid.ok, false); assert.equal(invalid.code, 'JOB_INVALID'); assert.deepEqual(invalid.errors, ['op list is empty']);
  assert.equal(invalid.continuation.arguments.query, path.join(h.root, '.local', 'jobs', 'inline', 'job-2.json'));
  const relative = await h.ask('o11', 'check-job', 'job.json');
  assert.equal(relative.code, 'PATH_NOT_ABSOLUTE');
  assert.equal(h.run.calls.length, 2);
});

test('lane odc runs the anvil-odc CLI and maps what it has; the other kinds name the O11 lane', async t => {
  const definitions = [{ Id: 'RequiredConnector_Out', Severity: 'Error', Title: 'Connector required' }, { Id: 'UnusedVariable', Severity: 'Warning', Title: 'Unused' }];
  const h = await harness(t, { handlers: { 'verify-catalog': args => ({ ok: true, command: 'verify-catalog',
    data: args.includes('--id') ? definitions.find(d => d.Id === args[args.indexOf('--id') + 1]) : { platform: 'odc', count: 2, definitions } }) } });
  const odcCli = path.join(h.root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll');
  const api = await h.ask('odc', 'api', { op: 'logic' });
  assert.equal(api.ok, true); assert.equal(api.lane, 'odc');
  assert.deepEqual(h.run.calls[0].args, ['api', '--op', 'logic']); assert.equal(h.run.calls[0].options.cli, odcCli);
  await h.ask('odc', 'api', 'IServerAction');
  assert.deepEqual(h.run.calls[1].args, ['api', '--op', 'native', '--type', 'IServerAction']);
  const found = await h.ask('odc', 'verify-message', { find: 'connector' });
  assert.deepEqual(h.run.calls[2].args, ['verify-catalog']);
  assert.deepEqual(found.data, { find: 'connector', count: 1, matches: [definitions[0]] });
  const exact = await h.ask('odc', 'verify-message', 'UnusedVariable');
  assert.deepEqual(h.run.calls[3].args, ['verify-catalog', '--id', 'UnusedVariable']); assert.deepEqual(exact.data, definitions[1]);
  const job = await h.ask('odc', 'check-job', { ops: [] });
  assert.equal(job.job, path.join(h.root, '.local', 'lane-odc', 'jobs', 'inline', 'job-1.json'));
  assert.equal(h.run.calls[4].options.cli, odcCli);
  for (const call of h.run.calls) assert.equal(call.options.cli, odcCli);
  // recipe and example are answered on ODC from the suite files (pacote-laneE-reference.test.mjs), never refused.
  for (const kind of ['functions', 'ui-block', 'types', 'where-can', 'check-delivery']) {
    const refused = await h.ask('odc', kind, 'x');
    assert.equal(refused.code, 'KIND_NOT_IN_LANE', kind);
    assert.deepEqual(refused.continuation, { tool: 'ssam_reference', arguments: { lane: 'o11', kind, query: 'x' }, why: refused.continuation.why });
  }
  assert.equal(h.run.calls.length, 5);
  const catalogOnOdc = await h.ask('odc', 'api', { name: 'IX', catalog: 'C:\\x.json' });
  assert.equal(catalogOnOdc.code, 'UNKNOWN_FIELD');
});

test('without a built CLI: CLI_NOT_BUILT with the doctor of that lane, never a build command', async t => {
  const h = await harness(t, { cli: false });
  for (const lane of ['o11', 'odc']) {
    const value = await h.ask(lane, 'api', { op: 'logic' });
    assert.equal(value.code, 'CLI_NOT_BUILT');
    assert.deepEqual(value.continuation.tool, 'ssam_doctor'); assert.deepEqual(value.continuation.arguments, { lane });
    assert.doesNotMatch(JSON.stringify(value), /dotnet build|build\.py|python/);
  }
  const inline = await h.ask('o11', 'check-job', { ops: [] });
  assert.equal(inline.code, 'CLI_NOT_BUILT');
  assert.equal(fs.existsSync(path.join(h.root, '.local', 'jobs', 'inline')), false, 'an inline job is stored only when it can run');
  assert.equal(h.run.calls.length, 0);
});

test('query shapes are checked per kind before anything runs', async t => {
  const h = await harness(t);
  assert.equal((await h.ask('o11', 'functions', { name: 'A', find: 'b' })).code, 'QUERY_SHAPE');
  assert.equal((await h.ask('o11', 'functions', { name: 'A', extra: 1 })).code, 'UNKNOWN_FIELD');
  assert.equal((await h.ask('o11', 'types', 'MobileWidgets')).code, 'QUERY_SHAPE');
  assert.equal((await h.ask('o11', 'types', { assembly: 'X' })).code, 'QUERY_SHAPE');
  assert.equal((await h.ask('o11', 'recipe', { find: '--ops' })).code, 'BAD_VALUE');
  assert.equal((await h.ask('o11', 'api', '--op')).code, 'BAD_VALUE');
  const unknownCatalog = await h.ask('o11', 'ui-block', { catalog: 'NoSuchLib', name: 'Tabs' });
  assert.equal(unknownCatalog.code, 'UI_CATALOG_UNKNOWN');
  assert.deepEqual(unknownCatalog.available, ['OutSystemsUI-2.9.0', 'OutSystemsUI-2.28.1', 'RichWidgets-unversioned']);
  const schema = await h.call('ssam_reference', { lane: 'o11', kind: 'api', query: 'IX', extra: true });
  assert.equal(schema.isError, true);
  assert.equal(h.run.calls.length, 0);
});

test('a CLI refusal points to the next lookup; a large answer goes to a file', async t => {
  const big = Array.from({ length: 3000 }, (_, i) => ({ Name: 'Function' + i, Signature: 'x'.repeat(20) }));
  const h = await harness(t, { handlers: {
    'ui-block': () => ({ ok: false, command: 'ui-block', error: "ArgumentException: block 'Tabz' not in OutSystemsUI 2.28.1; try --find\n   at ..." }),
    functions: () => ({ ok: true, command: 'functions', data: big }),
  } });
  const refused = await h.ask('o11', 'ui-block', 'Tabz');
  assert.equal(refused.code, 'CLI_REFUSED'); assert.doesNotMatch(refused.error, /\n/);
  assert.deepEqual(refused.continuation.arguments, { lane: 'o11', kind: 'ui-block', query: { find: 'Tabz' } });
  const large = await h.ask('o11', 'functions', { find: 'a' });
  assert.equal(large.ok, true); assert.equal(large.data, undefined);
  assert.ok(large.file.startsWith(path.join(h.root, '.local', 'reference')));
  assert.equal(JSON.parse(fs.readFileSync(large.file, 'utf8')).length, 3000);
  assert.equal(large.preview.count, 3000); assert.equal(large.preview.first.length, 20);
});

test('deps.outDir keeps a large answer in a folder of the caller (a bench sandbox), per lane', async t => {
  const kernel = tempKernel({ cli: true });
  const outDir = path.join(fs.mkdtempSync(path.join(path.dirname(kernel.root), 'bench-work-')), 'reference');
  const big = Array.from({ length: 3000 }, (_, i) => ({ Name: 'Function' + i, Signature: 'x'.repeat(20) }));
  const mcp = await linked(registerSsamReference, { root: kernel.root, lane: 'ss4', env: kernel.env, outDir, runAnvil: fakeAnvil({ functions: () => ({ ok: true, command: 'functions', data: big }) }) });
  t.after(async () => { await mcp.close(); kernel.cleanup(); fs.rmSync(path.dirname(outDir), { recursive: true, force: true }); });
  const large = await mcp.call('ssam_reference', { lane: 'o11', kind: 'functions', query: 'Function' });
  assert.equal(path.dirname(large.file), path.join(outDir, 'o11'));
  assert.equal(fs.existsSync(path.join(kernel.root, '.local', 'reference')), false, 'nothing in the kernel .local');
});

test('UI catalogs resolve by library name to the newest version', t => {
  const kernel = tempKernel(); t.after(kernel.cleanup);
  assert.match(resolveUiCatalog(kernel.root), /OutSystemsUI-2\.28\.1\.json$/);
  assert.match(resolveUiCatalog(kernel.root, 'outsystemsui'), /OutSystemsUI-2\.28\.1\.json$/);
  assert.match(resolveUiCatalog(kernel.root, 'RichWidgets'), /RichWidgets-unversioned\.json$/);
  assert.equal(resolveUiCatalog(kernel.root, 'Nope'), null);
});

// 2026-10-12 (production test): eight names in one query answered notFound for the whole text, the session asked again one
// name per call (6 more calls), and NullDateTime and NullTime, never asked, became a refused delivery. Several names now go
// in ONE call: each signature, and for a name the Studio lacks its closest names (and the literal of a typed null).
const CATALOG = {
  GetUserId: { Name: 'GetUserId', Group: 'Roles', Signature: 'GetUserId(): UserId', ReturnType: 'UserId', Parameters: [], Description: 'Returns the identifier of the user that is logged in.', Examples: '' },
  NullDate: { Name: 'NullDate', Group: 'Data Conversion', Signature: 'NullDate(): Date', Parameters: [], Description: 'Returns a null Date value.', Examples: 'NullDate() = #1900-01-01#' },
  AddMinutes: { Name: 'AddMinutes', Group: 'Date and Time', Signature: 'AddMinutes(dt: Date Time, n: Integer): Date Time', Parameters: [{ Name: 'dt' }, { Name: 'n' }], Description: 'Adds n minutes to dt.' + ' x'.repeat(200), Examples: '' },
};
const functionsCli = args => {
  const name = args[args.indexOf('--name') + 1];
  const found = Object.values(CATALOG).find(f => f.Name.toLowerCase() === name.toLowerCase());
  return { ok: true, command: 'functions', data: found ?? { notFound: name, closest: name === 'NullDateTime' ? ['NullDate', 'NewDateTime'] : name === 'NullTime' ? ['CurrTime', 'NewTime', 'NullDate'] : [], hint: 'veja docs/functions.md' } };
};

test('functions takes several names in one call: each signature, closest names for the missing ones, one CLI lookup per name', async t => {
  const h = await harness(t, { handlers: { functions: functionsCli } });
  const value = await h.ask('o11', 'functions', 'GetUserId AddMinutes, NullDateTime; NullDate() NullTime');
  assert.equal(value.ok, true, JSON.stringify(value)); assert.equal(value.asked, 5);
  assert.deepEqual(h.run.calls.map(c => c.args), ['GetUserId', 'AddMinutes', 'NullDateTime', 'NullDate', 'NullTime'].map(n => ['functions', '--name', n]));
  assert.deepEqual(value.data.functions.map(f => f.Signature), ['GetUserId(): UserId', 'AddMinutes(dt: Date Time, n: Integer): Date Time', 'NullDate(): Date']);
  assert.ok(value.data.functions.every(f => !('Parameters' in f) && (f.Description ?? '').length <= 200), 'compact entries');
  assert.deepEqual(value.data.notFound.map(n => [n.name, n.closest[0]]), [['NullDateTime', 'NullDate'], ['NullTime', 'CurrTime']]);
  assert.match(value.data.notFound[0].use, /^NullDate\(\)/); assert.match(value.data.notFound[1].use, /NewTime\(0, 0, 0\)/);
  assert.deepEqual(value.normalized, ['NullDate() -> NullDate']);
  assert.match(value.note, /never write it in an expression/);
  // {names:[...]} is the same lookup, and every name already looked up comes from the session cache.
  const again = await h.ask('o11', 'functions', { names: ['getuserid', 'NullDate'] });
  assert.deepEqual(again.data.functions.map(f => f.Name), ['GetUserId', 'NullDate']);
  assert.equal(h.run.calls.length, 5, 'no new CLI run');
  // One name keeps the one-name answer (the CLI's own data), a call written with parentheses says what was normalized.
  const one = await h.ask('o11', 'functions', 'AddMinutes()');
  assert.equal(one.data.Signature, CATALOG.AddMinutes.Signature); assert.deepEqual(one.normalized, ['AddMinutes() -> AddMinutes']);
  assert.deepEqual(h.run.calls.at(-1).args, ['functions', '--name', 'AddMinutes']);
  // A find, or a text that is no list of names, keeps the one-name path.
  await h.ask('o11', 'functions', { find: 'date' });
  assert.deepEqual(h.run.calls.at(-1).args, ['functions', '--find', 'date']);
});

test('functionList: the forms of a list of names, and what is not one', () => {
  assert.deepEqual(functionList('A B,C;D()'), { names: ['A', 'B', 'C', 'D'], normalized: ['D() -> D'] });
  assert.deepEqual(functionList({ name: ['A', 'a', 'B'] }), { names: ['A', 'B'], normalized: [] });
  assert.equal(functionList({ find: 'x' }), null); assert.equal(functionList({ name: 'A', find: 'B' }), null);
  assert.equal(functionList('Date + 1'), null, 'an expression is no list');
  assert.equal(functionList(Array.from({ length: FUNCTIONS_MAX + 1 }, (_, i) => 'F' + i).join(' ')), null, 'above the cap: the one-name path refuses it');
});
