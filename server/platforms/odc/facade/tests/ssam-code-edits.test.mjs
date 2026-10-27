import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport, McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { applyFlowEdits, expandEditPart, loadFlowReading } from '../flow-edits.mjs';
import { codeRead, headerOf, registerSsamCode, writeCall } from '../ssam-code.mjs';
import { flowReadingOf, textSha } from '../module-flow.mjs';
import { flowReadingFile } from '../module-map.mjs';
import { createSsamServer } from '../ssam.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
test('Preparation edits preserve its owned native header and do not allow deleting it', () => {
  const source = 'preparation Home.Preparation @screenKey.#Preparation\n  assign Message = "Initial" @n1\n  end @n2\n';
  const result = applyFlowEdits(source, [{ replace: '@n1', with: 'assign Message = "Edited"' }]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.text, source.replace('"Initial"', '"Edited"'));
  assert.ok(applyFlowEdits(source, [{ delete: '@screenKey.#Preparation' }]).problems.length);
});
const workspace = path.resolve(here, '../../../..');
const fixtureRoot = path.join(workspace, 'kernel/tests/fixtures');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const valueOf = result => result.structuredContent ?? JSON.parse(result.content[0].text);
// Literal reading from docs/TEXTO-LOGICA.md, including the two occurrences of the shared End.
const reading = `/// Altera o status do pedido.
/// O cancelamento devolve o estoque uma única vez.
server action AlterarStatusPedido public @MrB+ndLCeEidaZwSA+2WWg
  @{Folder=&"Pedidos"}
  /// pedido a alterar
  in PedidoId: Pedido Identifier @p1
  in Motivo?: Text = "" @p2
  out Sucesso: Boolean @p3
  local Pedido: Pedido @l1
  //-> @n1 Confere antes de alterar @n2
  GetPedido = aggregate FROM Pedido WHERE (Pedido.Id = PedidoId) MAX 1 @n1
  if GetPedido.List.Empty:  # O pedido existe? @n3
    raise PedidoNaoEncontrado("Pedido não encontrado") @n4
  assign Pedido = GetPedido.List.Current.Pedido  # Guardar o pedido @n5
  switch:  # Que transição é esta? @n6
    case StatusPedidoId = Entities.StatusPedido.Cancelado:
      DevolverEstoque(PedidoId) @n7
      UpdatePedido(Source=Pedido) @n8
      assign  # Preparar o retorno @n9
        Sucesso = True
        Pedido.Motivo = Motivo
      end @n10
    otherwise:
      -> @n8
  on exception All Exceptions abort log: @n11
    end @n10
`;
const key = headerOf(reading).key;
const name = headerOf(reading).name;
const sha = textSha(reading);
const linesOf = text => text.replace(/\r\n/g, '\n').split('\n');
const lineOf = value => linesOf(reading).find(line => line.trim() === value || line.trimEnd().endsWith(' ' + value));

function tmp(t) {
  const parent = path.join(workspace, '.local/cx4-tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'edits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function storeReading(lane, text, env, sourceSha256 = 'a'.repeat(64), action = {}) {
  const h = headerOf(text);
  const value = flowReadingOf({ key: h.key, kind: h.kind, name: h.name, ids: {}, ...action, text }, lane, sourceSha256);
  const file = flowReadingFile(lane, sourceSha256, value.textSha, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return value;
}
function indexEnv(t) {
  const old = process.env.SSAM_MODULE_INDEX_ROOT;
  process.env.SSAM_MODULE_INDEX_ROOT = path.join(tmp(t), 'index');
  t.after(() => { if (old === undefined) delete process.env.SSAM_MODULE_INDEX_ROOT; else process.env.SSAM_MODULE_INDEX_ROOT = old; });
  return process.env;
}
function edited(edits, expected, removed = []) {
  const result = applyFlowEdits(reading, edits);
  assert.deepEqual(result.problems, []);
  assert.equal(result.text, expected);
  assert.deepEqual([...result.removes].sort(), [...removed].sort());
  return result;
}
function opsOf(result) { assert.ok(!result.refusal, JSON.stringify(result.refusal)); return result.arguments.job.ops; }

// The problems of a refusal as the ssam MCP exit answers them (answer-size.mjs, CX7): every problem, each with its fields,
// the empty ones (lines: [] of a problem with no reading line) left out; the whole answer stays recoverable (ssam_evidence).
const atExit = problems => problems.map(p => Object.fromEntries(Object.entries(p).filter(([, v]) =>
  !(v === null || (Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)))));

// Only the fake lane receives delivery calls; no Studio or worker is contacted.
async function liveServer(t) {
  const root = tmp(t); const seen = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-edits-odc', version: '0.0.1' });
    fake.registerTool('studio_deliver', { description: 'Fake delivery.', inputSchema: z.object({
      feature: z.string().min(1), module: z.string().optional(), job: z.string().optional(),
      owners: z.array(z.string()).optional(), changes: z.array(z.string()).optional(), until: z.string().optional(),
      publish: z.boolean().optional(), authorize: z.string().optional(),
    }).strict() }, async args => {
      seen.push(args);
      const answer = { ok: true, result: 'delivered' };
      return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer };
    });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: {
    odcFacade, odcRoot: root, answersRoot: root, lock: { o11Root: root, odcRoot: root, connection: () => null },
  } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ssam-code-edits-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, seen };
}

async function deliveryBoundary(t) {
  const seen = [];
  const server = new McpServer({ name: 'line-edits-boundary', version: '1' });
  registerSsamCode(server, { fromJsonSchema, map: async () => { throw Error('unexpected read'); }, deliver: async (tool, args) => {
    seen.push({ tool, args });
    const answer = { ok: true, result: 'delivered' };
    return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer };
  } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'line-edits-boundary-client', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, seen };
}

test('E1 R1-R5: addresses, indentation, replacement blocks, deletion and insertion', () => {
  edited([{ replace: '@n5', with: 'assign Pedido = OutroPedido' }], reading.replace(lineOf('@n5'), '  assign Pedido = OutroPedido @n5'));
  edited([{ replace: '@n3', with: 'if True:' }], reading.replace(lineOf('@n3'), '  if True: @n3'));
  edited([{ replace: '@n9', with: ['assign', '  Sucesso = False'] }], reading.replace('      assign  # Preparar o retorno @n9\n        Sucesso = True\n        Pedido.Motivo = Motivo', '      assign @n9\n        Sucesso = False'));
  edited([{ delete: '@p1' }], reading.replace('  /// pedido a alterar\n  in PedidoId: Pedido Identifier @p1\n', ''), ['@p1']);
  edited([{ delete: '  @{Folder=&"Pedidos"}' }], reading.replace('  @{Folder=&"Pedidos"}\n', ''));
  const switchStart = reading.indexOf('  switch:');
  const handlerStart = reading.indexOf('  on exception');
  edited([{ delete: '@n6' }], reading.slice(0, switchStart) + reading.slice(handlerStart), ['@n6', '@n7', '@n8', '@n9']);
  edited([{ after: '@n3', insert: 'assign Sucesso = False' }], reading.replace(lineOf('@n4') + '\n', lineOf('@n4') + '\n  assign Sucesso = False\n'));
  edited([{ after: '@n3', insert: '    assign Sucesso = False' }], reading.replace(lineOf('@n3') + '\n', lineOf('@n3') + '\n    assign Sucesso = False\n'));
  edited([{ before: '@p1', insert: 'local Novo: Text' }], reading.replace('  /// pedido a alterar', '  local Novo: Text\n  /// pedido a alterar'));
  edited([{ after: '@n3', insert: 'assign A = 1' }, { after: '@n3', insert: 'assign B = 2' }], reading.replace(lineOf('@n4') + '\n', lineOf('@n4') + '\n  assign A = 1\n  assign B = 2\n'));
  const ambiguous = applyFlowEdits(reading, [{ replace: '@n10', with: 'end' }]);
  assert.equal(ambiguous.problems.length, 1);
  assert.equal(ambiguous.problems[0].lines.filter(line => /end @n10/.test(line.text)).length, 2);
  edited([{ replace: '@n10#2', with: 'raise Failed()' }], reading.replace('\n    end @n10\n', '\n    raise Failed() @n10\n'));
  edited([{ replace: 'case StatusPedidoId = Entities.StatusPedido.Cancelado:', with: 'case True:' }], reading.replace('    case StatusPedidoId = Entities.StatusPedido.Cancelado:', '    case True:'));
  edited([{ replace: '@' + key, with: 'server action Renamed public' }], reading.replace('server action AlterarStatusPedido public @' + key, 'server action Renamed public @' + key));
  assert.ok(applyFlowEdits(reading, [{ delete: '@' + key }]).problems.length);
  edited([{ replace: '@n5', with: lineOf('@n5').trim().replace(/\s+@n5$/, '') }], reading);
  // @n1 in the comment is a reference; @n2 is its owner, and a jump never owns @n8.
  edited([{ replace: '@n2', with: '//-> @n1 New comment' }], reading.replace(lineOf('@n2'), '  //-> @n1 New comment @n2'));
  edited([{ replace: '@n8', with: 'UpdatePedido(Source=Outro)' }], reading.replace(lineOf('@n8'), '      UpdatePedido(Source=Outro) @n8'));
});

test('E1 R6: malformed shapes, result ids, references and overlap retain reading evidence', () => {
  const invalid = [
    [], [{ replace: '@n99', with: 'end' }], [{ replace: '@n10', with: 'end' }],
    [{ replace: 'missing line', with: 'end' }], [{ replace: 'end @n10', with: 'end' }],
    [{}], [{ replace: '@n1', delete: '@n2', with: 'end' }], [{ after: '@n1' }],
    [{ before: '@n1' }], [{ replace: '@n1' }], [{ delete: '@p1', with: 'x' }],
    [{ delete: '@p1', insert: 'x' }], [{ replace: '@n1', with: '' }],
    [{ replace: '@n1', with: 'end', typo: true }],
    [{ replace: '@n4', with: 'raise Failed()' }, { delete: '@n3' }],
    [{ delete: '@n3' }, { after: '@n4', insert: 'assign A = 1' }],
    [{ before: '@n1', insert: 'assign A = 1' }, { after: '@n1', insert: 'assign B = 2' }],
    [{ delete: '@n3' }, { before: '@n4', insert: 'assign A = 1' }],
    [{ replace: '@n5', with: 'assign A = 1 @n4' }], [{ delete: '@n8' }],
    [{ delete: '@n1' }],
  ];
  for (const edits of invalid) {
    const result = applyFlowEdits(reading, edits);
    assert.ok(result.problems.length, JSON.stringify(edits));
    for (const problem of result.problems) {
      assert.match(problem.at, /^edits\/(?:\d+)?$/);
      assert.ok(Array.isArray(problem.lines), JSON.stringify(problem));
      for (const line of problem.lines) assert.equal(linesOf(reading)[line.line - 1], line.text);
    }
  }
  const crlf = reading.replace(/\n/g, '\r\n');
  assert.equal(applyFlowEdits(crlf, [{ replace: '@n5', with: lineOf('@n5').trim().replace(/\s+@n5$/, '') }]).text, crlf);
  for (const ending of ['', '\n', '\r\n']) {
    const source = ['server action Finish @kFinish', '  assign X = 1 @n1', '  end @n2'].join(ending === '\r\n' ? '\r\n' : '\n') + ending;
    const result = applyFlowEdits(source, [{ replace: '@n1', with: 'assign X = 2' }]);
    assert.deepEqual(result.problems, []);
    assert.equal(result.text, source.replace('X = 1', 'X = 2'));
  }
  for (const ending of ['', '\n\n', '\r\n\r\n']) {
    const source = reading.trimEnd().replace(/\n/g, ending.startsWith('\r') ? '\r\n' : '\n') + ending;
    const result = applyFlowEdits(source, [{ replace: '@n10#2', with: 'end\n' }]);
    assert.deepEqual(result.problems, []);
    assert.equal(result.text, source);
  }
});

test('E2 one refusal collects all parts and never delivers', async t => {
  const env = indexEnv(t); storeReading('odc', reading, env);
  const { client, seen } = await liveServer(t);
  const emptyFile = path.join(tmp(t), 'empty.flow'); fs.writeFileSync(emptyFile, '');
  const input = { lane: 'odc', action: 'write', module: 'M', part: 'logic', basedOn: sha, edits: [
    { replace: '@n99', with: 'end' }, { replace: '@n10', with: 'end' },
    { replace: '@n4', with: 'raise Failed()' }, { delete: '@n3' },
    { replace: '@n1' }, { after: '@n5', delete: '@n5', insert: 'assign A = 1' }, { delete: '@n8' },
  ], files: [emptyFile], also: [
    { part: 'logic', basedOn: 'ffffffffffffffff', edits: [{ delete: '@n1' }] },
    { part: 'logic', basedOn: sha, text: reading, edits: [{ delete: '@p1' }] },
  ] };
  const direct = writeCall(input).refusal;
  assert.equal(direct.code, 'INPUT_INVALID');
  for (const at of ['edits/0', 'edits/1', 'edits/2', 'edits/3', 'edits/4', 'edits/5', 'edits/6', 'also/0', 'also/1', 'files/0']) {
    assert.ok(direct.problems.some(problem => problem.at === at || problem.at.startsWith(at + '/')), at + ': ' + JSON.stringify(direct.problems));
  }
  for (const problem of direct.problems.filter(problem => problem.at.startsWith('edits/'))) assert.ok(problem.lines?.length, JSON.stringify(problem));
  const response = valueOf(await client.callTool({ name: 'ssam_code', arguments: input }));
  assert.equal(response.code, 'INPUT_INVALID');
  assert.deepEqual(response.problems, atExit(direct.problems));
  assert.equal(seen.length, 0);
});

test('E2 patch mixed with top-level or nested edits never bypasses validation', async t => {
  const env = indexEnv(t); storeReading('odc', reading, env);
  const { client, seen } = await liveServer(t);
  const patchBase = { job: path.join(tmp(t), 'not-read.json'), sha256: 'f'.repeat(64) };
  const cases = [
    { lane: 'odc', action: 'write', module: 'M', part: 'logic', basedOn: patchBase, patch: [], edits: [{ replace: '@n5', with: 'assign Pedido = OutroPedido' }] },
    { lane: 'odc', action: 'write', module: 'M', basedOn: patchBase, patch: [], also: [{ part: 'logic', element: name, basedOn: sha, edits: [{ replace: '@n5', with: 'assign Pedido = OutroPedido' }] }] },
  ];
  for (const input of cases) {
    const direct = writeCall(input).refusal;
    assert.equal(direct?.code, 'INPUT_INVALID');
    assert.ok(direct.problems.some(problem => /patch/.test(problem.at + ' ' + problem.error)), JSON.stringify(direct));
    if (input.edits) assert.ok(direct.problems.some(problem => /basedOn/.test(problem.error)), JSON.stringify(direct));
    const response = valueOf(await client.callTool({ name: 'ssam_code', arguments: input }));
    assert.equal(response.code, 'INPUT_INVALID');
    assert.deepEqual(response.problems, atExit(direct.problems));
  }
  assert.equal(seen.length, 0);
});

test('E3 edits use the existing delivery op in both lanes, preserving also order', async t => {
  const env = indexEnv(t);
  const boundary = await deliveryBoundary(t);
  const second = 'server action Another @kAnotherAction\n  end @n1\n';
  const changed = reading.replace(lineOf('@n5'), '  assign Pedido = OutroPedido @n5');
  const secondChanged = second.replace('end @n1', 'raise Failed() @n1');
  for (const lane of ['o11', 'odc']) {
    storeReading(lane, reading, env); const other = storeReading(lane, second, env);
    const first = { lane, action: 'write', module: 'M', part: 'logic', element: name, basedOn: sha, edits: [{ replace: '@n5', with: 'assign Pedido = OutroPedido' }] };
    const result = writeCall(first);
    assert.deepEqual(opsOf(result), [{ op: 'logic', data: { flow: [{ text: changed, basedOn: sha }] } }]);
    assert.equal(result.tool, lane === 'o11' ? 'o11_deliver' : 'studio_deliver');
    assert.ok(result.normalizations.some(note => note.rule === 'logic-edits'));
    const many = { ...first, also: [{ part: 'logic', element: 'Another', basedOn: other.textSha, edits: [{ replace: '@n1', with: 'raise Failed()' }] }] };
    assert.deepEqual(opsOf(writeCall(many)), [{ op: 'logic', data: { flow: [{ text: changed, basedOn: sha }, { text: secondChanged, basedOn: other.textSha }] } }]);
    for (const input of [first, many]) {
      const before = boundary.seen.length;
      const response = valueOf(await boundary.client.callTool({ name: 'ssam_code', arguments: input }));
      assert.equal(response.ok, true);
      assert.ok(response.normalizations.some(note => note.rule === 'logic-edits'));
      assert.equal(boundary.seen.length, before + 1);
      assert.equal(boundary.seen.at(-1).tool, result.tool);
      assert.deepEqual(boundary.seen.at(-1).args.job.ops, opsOf(writeCall(input)));
    }
    if (lane === 'odc') {
      const { client, seen } = await liveServer(t);
      assert.equal(valueOf(await client.callTool({ name: 'ssam_code', arguments: first })).ok, true);
      assert.equal(seen.length, 1);
      assert.deepEqual(readJson(seen[0].job).ops, opsOf(result));
      assert.equal(valueOf(await client.callTool({ name: 'ssam_code', arguments: many })).ok, true);
      assert.equal(seen.length, 2);
      assert.deepEqual(readJson(seen[1].job).ops, opsOf(writeCall(many)));
    }
  }
});

test('E4 read offers an edit continuation with the served textSha', async () => {
  for (const lane of ['o11', 'odc']) {
    const result = await codeRead({ lane, part: 'logic', module: 'M', element: name }, { map: async () => ({
      ok: true, schema: 'ssam-flow-page/1', action: { name, key, textSha: sha }, text: reading,
    }) });
    assert.equal(result.continuations.edit.tool, 'ssam_code');
    assert.deepEqual(result.continuations.edit.arguments, { lane, action: 'write', part: 'logic', module: 'M', element: name, basedOn: sha,
      edits: [{ replace: '@n1', with: '<the changed line>' }] });
  }
});

test('reading lookup and expansion validate hashes, lane, aliases and ambiguous forms', t => {
  const env = indexEnv(t); const saved = storeReading('o11', reading, env);
  assert.deepEqual(loadFlowReading('o11', sha.toUpperCase(), { env }), saved);
  assert.equal(loadFlowReading('odc', sha, { env }), null);
  assert.equal(loadFlowReading('o11', 'bad', { env }), null);
  for (const element of [name, key, '@' + key, 'Folder/' + name, 'Screen.' + name]) {
    const result = expandEditPart({ element, basedOn: sha, edits: [{ replace: '@n5', with: 'assign Pedido = OutroPedido' }], at: 'also/3' }, 'o11');
    assert.deepEqual(result.problems, []);
    assert.equal(result.part.part, 'logic');
    assert.ok(result.notes.some(note => note.rule === 'part-from-edits'));
  }
  for (const extra of [{ part: 'html' }, { element: 'Wrong' }, { basedOn: [sha] }, { basedOn: { job: 'x' } }, { text: reading }]) {
    const result = expandEditPart({ part: 'logic', basedOn: sha, edits: [{ delete: '@p1' }], at: 'also/3', ...extra }, 'o11');
    assert.equal(result.part, null);
    assert.ok(result.problems.every(problem => problem.at.startsWith('also/3')));
  }
  const missing = expandEditPart({ part: 'logic', element: name, basedOn: 'f'.repeat(16), edits: [{ delete: '@p1' }] }, 'o11');
  assert.match(JSON.stringify(missing.problems), /no read of this textSha/);
  // A saved old source is valid even if another capture exists; digest age is the kernel merge's concern.
  storeReading('o11', reading, env, 'b'.repeat(64));
  assert.equal(loadFlowReading('o11', sha, { env }).text, reading);
});

test('reading lookup ignores corrupt newer captures and rejects every invalid identity', t => {
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(tmp(t), 'index') };
  const valid = storeReading('o11', reading, env);
  const oldFile = flowReadingFile('o11', 'a'.repeat(64), sha, env);
  const newFile = flowReadingFile('o11', 'b'.repeat(64), sha, env);
  fs.utimesSync(oldFile, new Date(1000), new Date(1000));
  fs.writeFileSync(newFile, '{broken');
  assert.deepEqual(loadFlowReading('o11', sha, { env }), valid);
  for (const change of [
    { lane: 'odc' }, { schema: 'wrong' }, { extractor: -1 }, { adapter: 'wrong' },
    { textSha: 'f'.repeat(16) }, { text: reading + 'changed' },
  ]) {
    fs.writeFileSync(newFile, JSON.stringify({ ...valid, ...change }));
    assert.deepEqual(loadFlowReading('o11', sha, { env }), valid, JSON.stringify(change));
  }
  fs.unlinkSync(oldFile);
  for (const change of [
    { lane: 'odc' }, { schema: 'wrong' }, { extractor: -1 }, { adapter: 'wrong' },
    { textSha: 'f'.repeat(16) }, { text: reading + 'changed' },
  ]) {
    fs.writeFileSync(newFile, JSON.stringify({ ...valid, ...change }));
    assert.equal(loadFlowReading('o11', sha, { env }), null, JSON.stringify(change));
  }
});

const CLI = {
  o11: process.env.SSAM_CODE_CLI_O11 ? path.join(process.env.SSAM_CODE_CLI_O11, 'anvil.dll') : null,
  odc: process.env.SSAM_CODE_CLI_ODC ? path.join(process.env.SSAM_CODE_CLI_ODC, 'anvil-odc.dll') : null,
};
function runFlow(lane, file, out, env) {
  const result = spawnSync('dotnet', [CLI[lane], 'flow', '--oml', file, '--out', out], {
    env: { ...env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_NO_WARM: '1' },
    encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-4000));
  const at = result.stdout.search(/^\{/m); assert.notEqual(at, -1, result.stdout.slice(-4000));
  const answer = JSON.parse(result.stdout.slice(at));
  assert.equal(answer.ok, true, JSON.stringify(answer).slice(-4000));
  return answer.data;
}
function mulberry32(seed) {
  return () => { let x = seed += 0x6D2B79F5; x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61); return ((x ^ x >>> 14) >>> 0) / 4294967296; };
}
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : 0;
const allMetrics = [];
function metricSummary(label, metrics) {
  const whole = metrics.map(item => item.whole); const edits = metrics.map(item => item.edits);
  const totalBefore = whole.reduce((a, b) => a + b, 0); const totalAfter = edits.reduce((a, b) => a + b, 0);
  return `${label}: cases=${metrics.length}, bytes whole median=${percentile(whole, .5)} p90=${percentile(whole, .9)}, edits median=${percentile(edits, .5)} p90=${percentile(edits, .9)}, totalBefore=${totalBefore}, totalAfter=${totalAfter}, reduction=${totalBefore ? ((1 - totalAfter / totalBefore) * 100).toFixed(2) : 0}%`;
}
for (const lane of ['o11', 'odc']) {
  const skip = !(CLI[lane] && fs.existsSync(CLI[lane])) && `${lane} CLI not given (SSAM_CODE_CLI_${lane.toUpperCase()})`;
  test(`E5 corpus ${lane}: seeded leaf edits equal whole-text delivery ops`, { skip, timeout: 1800000 }, async t => {
    const dir = tmp(t); const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(dir, 'index') };
    const localFiles = lane === 'o11' ? ['reactive-ui.oml', 'traditional-ui.oml', 'mobile-ui.oml', 'blank-service.oml'].map(file => path.join(fixtureRoot, file))
      : fs.readdirSync(path.join(fixtureRoot, 'odc')).filter(file => file.endsWith('.oml')).map(file => path.join(fixtureRoot, 'odc', file));
    const extra = process.env.SSAM_EDIT_CORPUS === '1' ? readJson(path.join(fixtureRoot, 'text-roundtrip/corpus.json')).filter(item => item.lane === lane && fs.existsSync(item.oml)).map(item => item.oml) : [];
    const files = [...new Set([...localFiles, ...extra].map(file => path.resolve(file)))];
    let modules = 0; let actions = 0; let exact = 0; const counts = { replace: 0, insert: 0, delete: 0 }; const metrics = [];
    for (const [fileIndex, file] of files.entries()) await t.test(path.basename(file), () => {
      const seed = 20261013 + fileIndex; const random = mulberry32(seed);
      const data = runFlow(lane, file, path.join(dir, `${fileIndex}.flow`), env);
      const flow = readJson(data.path);
      modules++;
      for (const action of flow.actions.filter(a => a.fixedPoint)) {
        const originalLines = linesOf(action.text); const own = originalLines.map((text, index) => {
          if (/^(?:->|\||\/\/\/)/.test(text.trimStart()) || index === originalLines.findIndex(line => /^(?:server action|service action|client action|data action|action)\s/.test(line.trimStart()))) return null;
          const id = text.match(/\s(@[npl]\d+)\s*$/)?.[1];
          return id ? { id, index, text, indent: text.match(/^\s*/)[0].length } : null;
        }).filter(Boolean);
        if (!own.length) continue;
        const leaves = own.map(candidate => {
          let end = candidate.index + 1;
          while (end < originalLines.length && originalLines[end].trim() && originalLines[end].match(/^\s*/)[0].length > candidate.indent) end++;
          return { ...candidate, end };
        }).filter(candidate => {
          // Metadata belongs to its leaf; it is not a child node. Deleting a jump target is a refusal (E2).
          const children = originalLines.slice(candidate.index + 1, candidate.end);
          const referenced = originalLines.some(line => /^\s*(?:->|\/\/->)\s+/.test(line) && line.match(/^\s*(?:->|\/\/->)\s+(@\S+)/)?.[1] === candidate.id);
          return children.every(line => /^\s*@\{/.test(line)) && !referenced;
        });
        assert.ok(leaves.length, `${action.name}: fixed-point action must have a safe leaf`);
        const leaf = leaves[Math.floor(random() * leaves.length)];
        const occurrences = own.filter(item => item.id === leaf.id);
        const address = occurrences.length > 1 ? `${leaf.id}#${occurrences.findIndex(item => item.index === leaf.index) + 1}` : leaf.id;
        const stored = storeReading(lane, action.text, env, flow.sourceSha256, action);
        const readReading = (readLane, hash) => loadFlowReading(readLane, hash, { env });
        const base = { lane, action: 'write', module: 'M', part: 'logic', element: action.name, basedOn: stored.textSha };
        const withoutId = leaf.text.replace(/\s+@[npl]\d+\s*$/, '');
        const retained = writeCall({ ...base, edits: [{ replace: address, with: withoutId.trimStart() }] }, { readReading });
        assert.equal(opsOf(retained)[0].data.flow[0].text, action.text, `${action.name}: identity replacement`);
        actions++;
        for (const kind of ['replace', 'insert', 'delete']) {
          const expected = [...originalLines]; let edit;
          if (kind === 'replace') {
            const replacement = withoutId + '  # cx4';
            expected[leaf.index] = replacement + ' ' + leaf.id;
            edit = { replace: address, with: random() < .5 ? replacement.trimStart() : replacement };
          } else if (kind === 'insert') {
            const insertion = ' '.repeat(leaf.indent) + 'assign Cx4Probe = 1';
            expected.splice(leaf.end, 0, insertion); edit = { after: address, insert: 'assign Cx4Probe = 1' };
          } else {
            let start = leaf.index;
            while (start > 0 && originalLines[start - 1].match(/^\s*/)[0].length === leaf.indent && /^\s*\/\/\//.test(originalLines[start - 1])) start--;
            expected.splice(start, leaf.end - start); edit = { delete: address };
          }
          const input = { ...base, edits: [edit] }; const text = expected.join('\n');
          const whole = { ...base, text, removes: true };
          assert.deepEqual(opsOf(writeCall(input, { readReading })), opsOf(writeCall(whole)), `${path.basename(file)} ${action.name} ${kind} ${address}, seed=${seed}`);
          counts[kind]++; exact++;
          const metric = { lane, kind, whole: Buffer.byteLength(JSON.stringify(whole)), edits: Buffer.byteLength(JSON.stringify(input)) };
          metrics.push(metric); allMetrics.push(metric);
        }
      }
      t.diagnostic(`${lane} ${path.basename(file)} seed=${seed}`);
    });
    t.diagnostic(`corpus ${lane}: modules=${modules}, actions=${actions}, replace=${counts.replace}, insert=${counts.insert}, delete=${counts.delete}, exact=${exact}, seed=20261013+fileIndex, extended=${process.env.SSAM_EDIT_CORPUS === '1'}`);
    t.diagnostic(metricSummary(lane, metrics));
  });
}
test('E5 corpus total byte metrics', t => { if (allMetrics.length) t.diagnostic(metricSummary('total', allMetrics)); });
