import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { CODE_FILE_MAX_BYTES, EXAMPLE_DDL_UI, EXAMPLE_HTML, EXAMPLE_LOGIC, EXAMPLE_SETUP_OPS,
  exampleCall, exampleLogicTexts, headerOf, normalizeCodeOps, readCodeFiles, splitActions, writeCall } from '../ssam-code.mjs';
import { shapeCall } from '../call-shapes.mjs';
import { createSsamServer } from '../ssam.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../../..');
const fixtureRoot = path.join(workspace, 'kernel/tests/fixtures');
const caseRoot = path.join(here, 'fixtures/caso-tickets');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const original = readJson(path.join(caseRoot, 'd8ce8b7a.json'));
const separated = readJson(path.join(caseRoot, 'b7fb270e.json'));
const accepted = readJson(path.join(caseRoot, '2549ac63.json'));
const caseFiles = ['dados.ddl', 'ops.json', 'parte-1.flow', 'parte-2.flow', 'parte-3.flow'].map(file => path.join(caseRoot, file));
const valueOf = result => result.structuredContent ?? JSON.parse(result.content[0].text);
const simple = name => `/// Does ${name}.\nserver action ${name}\n  end\n`;
const three = ['First', 'Second', 'Third'].map(simple);
const multi = three.join('\n');
function tmp(t) {
  const parent = path.join(workspace, '.local/cx2-tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(dir, file, text) { const out = path.join(dir, file); fs.writeFileSync(out, text); return out; }
function opsOf(result) { assert.ok(!result.refusal, JSON.stringify(result.refusal)); return result.arguments.job.ops; }

// The facade runs in memory; only this fake delivery receives calls, never a Studio or worker.
async function liveServer(t) {
  const root = tmp(t); const seen = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-files-odc', version: '0.0.1' });
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
  const client = new Client({ name: 'ssam-code-files-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, seen };
}

test('T1 splitActions: one action stays untouched; descriptions, all header kinds, CRLF and indentation', () => {
  for (const text of [...EXAMPLE_LOGIC, ...accepted.ops[3].data.flow]) assert.equal(splitActions(text), null);
  assert.deepEqual(splitActions(EXAMPLE_LOGIC.join('\n')), EXAMPLE_LOGIC);
  assert.deepEqual(splitActions(multi.replace(/\n/g, '\r\n')), three);
  assert.equal(splitActions(multi, { preserveWhitespace: true }).join(''), multi);
  const documented = '/// First line\n/// Second line\n\nserver action Later\n  end\n';
  assert.deepEqual(splitActions(simple('Earlier') + '\n' + documented), [simple('Earlier'), documented]);
  for (const kind of ['server action', 'service action', 'client action', 'data action', 'action']) {
    const second = `${kind} ${kind.includes('data') || kind === 'action' ? 'Home.' : ''}Next\n  end\n`;
    assert.deepEqual(splitActions(simple('Earlier') + '\n' + second), [simple('Earlier'), second]);
  }
  assert.equal(splitActions('server action Outer\n  action Indented\n  end\n'), null);
  assert.equal(splitActions('/// Only a description\n'), null);
});

test('T2 writeCall: several actions become one logic op in both lanes; one basedOn is ambiguous', () => {
  for (const lane of ['o11', 'odc']) {
    const result = writeCall({ lane, module: 'M', part: 'logic', text: multi });
    assert.deepEqual(opsOf(result), [{ op: 'logic', data: { flow: three } }]);
    assert.ok(result.normalizations.some(note => note.rule === 'logic-split' && note.at === '/text'));
    const refused = writeCall({ lane, module: 'M', part: 'logic', text: multi, basedOn: 'source-sha' }).refusal;
    assert.equal(refused.code, 'INPUT_INVALID'); assert.match(refused.error, /one text per action/);
  }
});

test('T3 case acceptance: original combined input becomes the exact fifteen previously separated texts', () => {
  const before = JSON.stringify(original);
  const normalized = normalizeCodeOps(original);
  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.job.ops[3].data.flow, separated.ops[3].data.flow);
  assert.equal(normalized.job.ops[3].data.flow.length, 15);
  assert.equal(JSON.stringify(original), before, 'normalization never mutates its caller');
  assert.equal(normalizeCodeOps(accepted).changed, false);
  const result = writeCall({ lane: 'o11', module: 'DemoFabio_CS', part: 'logic', text: original.ops[3].data.flow[0], ops: original.ops.slice(0, 3) });
  assert.deepEqual(opsOf(result)[3].data.flow, separated.ops[3].data.flow);
});

test('T4 case acceptance: five files produce the exact accepted four ops, including one live delivery', async t => {
  const input = { lane: 'o11', module: 'DemoFabio_CS', files: caseFiles };
  const result = writeCall(input);
  assert.deepEqual(opsOf(result), accepted.ops);
  for (const rule of ['files', 'logic-split', 'logic-merge']) assert.ok(result.normalizations.some(note => note.rule === rule), rule);
  assert.deepEqual(opsOf(writeCall({ ...input, files: [caseFiles[2], caseFiles[3], caseFiles[1], caseFiles[0], caseFiles[4]] })), accepted.ops);
  const { client, seen } = await liveServer(t);
  const response = valueOf(await client.callTool({ name: 'ssam_code', arguments: { ...input, lane: 'odc', action: 'write' } }));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(seen.length, 1); assert.deepEqual(readJson(seen[0].job).ops, accepted.ops);
  const flowNames = accepted.ops[3].data.flow.map(text => headerOf(text).name);
  const jsonNames = accepted.ops[2].data.actions.map(action => action.name);
  for (const name of [flowNames[0], flowNames.at(-1), jsonNames[0], jsonNames.at(-1)]) assert.ok(seen[0].owners.includes(name), name);
});

test('T5 neutral examples: files and inline parts build identical jobs on both lanes', t => {
  const dir = tmp(t);
  // The logic example is per lane (exampleLogicTexts: ODC declares the read-only MasterSource of a multi-source aggregate).
  for (const lane of ['o11', 'odc']) {
    const files = [put(dir, 'data.ddl', EXAMPLE_DDL_UI), put(dir, 'screen.html', EXAMPLE_HTML), put(dir, `actions-${lane}.flow`, exampleLogicTexts(lane).join('\n'))];
    assert.deepEqual(
      opsOf(writeCall({ lane, module: 'M', files, ops: EXAMPLE_SETUP_OPS })),
      opsOf(writeCall(exampleCall(lane).arguments)), lane);
  }
});

test('T6 mixed parts: every invalid file is named in one refusal and nothing reaches delivery', async t => {
  const dir = tmp(t);
  const partial = '/// Computes the expected date of a visit.\nserver action CalcularPrevisao @cfFoFGSrc0SAUdxt1u0pKA\n'
    + '  in VisitaId: Visita Identifier @p1\n  out Previsao: Date Time @p2\n  assign Previsao = AddHours(CurrDateTime(), -3) @n4\n  end @n5\n';
  const files = [put(dir, 'a.ddl', 'CREATE TABLE X (Id INT PRIMARY KEY)'), put(dir, 'b.flow', partial),
    'C:\\nao\\existe.flow', put(dir, 'c.json', '{broken json'), 'relativo.flow', put(dir, 'd.xyz', 'unknown')];
  const { client, seen } = await liveServer(t);
  const result = valueOf(await client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'write', module: 'M', part: 'logic', text: simple('Valid'), files } }));
  assert.equal(result.code, 'INPUT_INVALID', JSON.stringify(result));
  assert.deepEqual([...new Set(result.problems.flatMap(problem => problem.pointers ?? [problem.at]))].sort(), files.map((_, i) => `files/${i}`));
  assert.equal(seen.length, 0);
});

test('T7 call shapes: files string and file/paths/filePaths aliases normalize and deliver', async t => {
  const { client, seen } = await liveServer(t);
  for (const [field, value] of [['files', caseFiles[0]], ['file', caseFiles[0]], ['paths', [caseFiles[0]]], ['filePaths', caseFiles[0]]]) {
    const input = { lane: 'odc', action: 'write', module: 'M', [field]: value };
    const shaped = shapeCall('ssam_code', input);
    assert.deepEqual(shaped.args.files, [caseFiles[0]]);
    assert.ok(shaped.normalizations.some(note => note.rule === (field === 'files' ? 'files-list' : 'files-field')));
    const response = valueOf(await client.callTool({ name: 'ssam_code', arguments: input }));
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.deepEqual(readJson(seen.at(-1).job).ops, [accepted.ops[0]]);
  }
  assert.equal(seen.length, 4);
  const schema = (await client.listTools()).tools.find(tool => tool.name === 'ssam_code').inputSchema.properties.files;
  assert.equal(schema.type, 'array'); assert.equal(schema.minItems, 1); assert.ok(schema.maxItems > 0);
  assert.equal(schema.items.maxLength, undefined, 'paths must never be silently truncated');
});

test('T8 case metric: principal sends paths instead of repeating the combined text and ops', t => {
  const inline = { lane: 'o11', action: 'write', module: 'DemoFabio_CS', part: 'logic', text: original.ops[3].data.flow[0], ops: original.ops.slice(0, 3) };
  const fileInput = { lane: 'o11', action: 'write', module: 'DemoFabio_CS', files: caseFiles };
  const before = Buffer.byteLength(JSON.stringify(inline)); const after = Buffer.byteLength(JSON.stringify(fileInput));
  assert.ok(after < before);
  t.diagnostic(`case bytes: inline=${before}, files=${after}, saved=${before - after} (${((1 - after / before) * 100).toFixed(2)}%)`);
});

test('file boundaries: extension families, UTF-8 BOM and CRLF, all invalid inputs collected', t => {
  const dir = tmp(t);
  const valid = [put(dir, 'a.sql', '\uFEFF' + EXAMPLE_DDL_UI.replace(/\n/g, '\r\n')), put(dir, 'a.logic', multi),
    put(dir, 'a.htm', EXAMPLE_HTML), put(dir, 'a.txt', simple('TextAction')),
    put(dir, 'list.json', JSON.stringify(EXAMPLE_SETUP_OPS)), put(dir, 'object.json', JSON.stringify({ ops: EXAMPLE_SETUP_OPS })),
    put(dir, 'data.txt', EXAMPLE_DDL_UI), put(dir, 'screen.txt', EXAMPLE_HTML), put(dir, 'case.FLOW', simple('Uppercase'))];
  const good = readCodeFiles(valid);
  assert.deepEqual(good.problems, []); assert.equal(good.parts.length, valid.length);
  assert.equal(good.parts[0].text, EXAMPLE_DDL_UI);
  assert.deepEqual(good.parts.map(part => part.part), ['ddl', 'logic', 'html', 'logic', 'ops', 'ops', 'ddl', 'html', 'logic']);
  assert.equal(CODE_FILE_MAX_BYTES, 8 * 1024 * 1024);
  const maximum = put(dir, 'maximum.flow', simple('Maximum').padEnd(CODE_FILE_MAX_BYTES, ' '));
  assert.deepEqual(readCodeFiles([maximum]).problems, [], 'exactly the maximum size is accepted');
  const folder = path.join(dir, 'folder.flow'); fs.mkdirSync(folder);
  const big = put(dir, 'large.flow', ''); fs.truncateSync(big, CODE_FILE_MAX_BYTES + 1);
  const invalid = [put(dir, 'wrong.flow', EXAMPLE_DDL_UI), put(dir, 'empty.ddl', '\uFEFF\r\n  '), folder, big,
    put(dir, 'scalar.json', '3'), put(dir, 'missing-ops.json', '{}'), put(dir, 'bad-op.json', '[{"noOp":true}]'),
    put(dir, 'unknown.txt', 'unrecognized text')];
  const bad = readCodeFiles(invalid);
  assert.equal(bad.parts.length, 0);
  assert.deepEqual([...new Set(bad.problems.map(problem => problem.at))].sort(), invalid.map((_, i) => `files/${i}`));
  const refusal = writeCall({ lane: 'o11', module: 'M', files: invalid }).refusal;
  assert.equal(refusal.code, 'INPUT_INVALID'); assert.equal(refusal.problems.length, bad.problems.length);
  const patch = writeCall({ lane: 'o11', module: 'M', files: valid, patch: [], basedOn: { job: 'ignored.json', sha256: 'a'.repeat(64) } }).refusal;
  assert.equal(patch.code, 'INPUT_INVALID'); assert.match(patch.error, /files.*patch/);
});

test('logic normalization: nested jobs, strings and arrays split; basedOn and JSON actions preserve identity', () => {
  for (const data of [{ flow: multi }, { flow: [simple('Single'), multi] }, { text: multi }]) {
    const normalized = normalizeCodeOps({ ops: [{ op: 'logic', data }] });
    assert.equal(normalized.changed, true);
    assert.deepEqual(normalized.job.ops[0].data.flow, data.flow?.[0] === simple('Single') ? [simple('Single'), ...three] : three);
  }
  const safe = { ops: [{ op: 'logic', data: { flow: [{ text: multi, basedOn: 'sha' }] } },
    { op: 'logic', data: { flow: [multi], basedOn: 'sha' } }, { op: 'logic', data: { actions: [{ name: 'JsonAction', steps: [] }] } }] };
  assert.equal(normalizeCodeOps(safe).changed, false);
  assert.deepEqual(normalizeCodeOps(safe).job, safe);
  const nested = normalizeCodeOps({ jobs: [{ ops: [{ op: 'logic', data: { flow: [multi] } }] }] });
  assert.deepEqual(nested.job.jobs[0].ops[0].data.flow, three);
});

test('logic merge: preserve order and basedOn alignment; never merge JSON actions or extra data fields', t => {
  const dir = tmp(t);
  const edited = 'server action Existing @kAbcdefg\n  end @n1\n';
  const aligned = writeCall({ lane: 'o11', module: 'M', part: 'logic', text: [multi, edited], basedOn: [null, 'sha'] });
  assert.deepEqual(opsOf(aligned), [{ op: 'logic', data: { flow: [...three, { text: edited, basedOn: 'sha' }] } }]);
  const ambiguous = writeCall({ lane: 'o11', module: 'M', part: 'logic', text: simple('Valid'), also: [{ part: 'logic', text: multi, basedOn: 'sha' }] }).refusal;
  assert.ok(ambiguous.problems.some(problem => problem.at === 'also/0' && /one text per action/.test(problem.error)));
  const jsonAction = { op: 'logic', data: { actions: [{ name: 'JsonAction', steps: [] }] } };
  const special = { op: 'logic', data: { flow: [simple('Special')], extra: true } };
  const opsFile = put(dir, 'ops.json', JSON.stringify([jsonAction, special]));
  const result = writeCall({ lane: 'o11', module: 'M', files: [put(dir, 'a.flow', simple('A')), opsFile, put(dir, 'b.flow', simple('B'))] });
  assert.deepEqual(opsOf(result), [jsonAction, special, { op: 'logic', data: { flow: [simple('A'), simple('B')] } }]);
});

test('mixed refusal: invalid text, also and every file remain together without an early return', async t => {
  const dir = tmp(t);
  const { client, seen } = await liveServer(t);
  const result = valueOf(await client.callTool({ name: 'ssam_code', arguments: {
    lane: 'odc', action: 'write', module: 'M', part: 'ddl', text: 'CREATE TABLE X (Id INT PRIMARY KEY)',
    also: [{ part: 'logic', text: multi, basedOn: 'ambiguous' }, { part: 'ddl', text: 'CREATE TABLE Y (Id INT PRIMARY KEY)' }],
    files: [put(dir, 'invalid.json', 'null'), put(dir, 'empty.flow', '')],
  } }));
  assert.equal(result.code, 'INPUT_INVALID');
  assert.deepEqual([...new Set(result.problems.flatMap(problem => problem.pointers ?? [problem.at]))].sort(), ['also/0', 'also/1', 'files/0', 'files/1', 'text']);
  assert.equal(seen.length, 0);
});

test('ops file owners: create names and names inside data, logic and HTML are retained', t => {
  const dir = tmp(t);
  const ops = [
    { op: 'create', type: 'UserException', name: 'InvalidState' },
    { op: 'spec', data: { ddl: 'create entity Ledger (\n  Id Long Integer identifier auto required\n);' } },
    { op: 'logic', data: { actions: [{ name: 'ReadLedger', steps: [] }], flow: [simple('LoadLedger')] } },
    { op: 'html', data: { html: '<screen name="LedgerHome"/>', } },
  ];
  const result = writeCall({ lane: 'odc', module: 'M', files: [put(dir, 'parts.json', JSON.stringify({ ops }))] });
  assert.deepEqual(opsOf(result), ops);
  for (const name of ['InvalidState', 'Ledger', 'ReadLedger', 'LoadLedger', 'LedgerHome']) assert.ok(result.arguments.owners.includes(name), name);
});

test('ops file ownership covers every screen action and aliases without rewriting the original ops', t => {
  const dir = tmp(t);
  const first = 'action MainFlow/Orders.Approve\n  end\n';
  const second = 'action MainFlow/Payments.Submit\n  end\n';
  const ops = [
    { op: 'ddl', data: { text: 'create entity LedgerItem (\n  Id Long Integer identifier auto required\n);' } },
    { op: 'logic', data: { text: first + '\n' + second } },
    { op: 'create', data: { type: 'UserException', name: 'InvalidEntry' } },
  ];
  const file = put(dir, 'aliases.json', JSON.stringify({ ops }));
  const originalFile = fs.readFileSync(file, 'utf8');
  const result = writeCall({ lane: 'odc', module: 'M', files: [file] });
  assert.deepEqual(opsOf(result), ops, 'ownership inspection preserves the job ops, including aliases and the combined text');
  assert.equal(fs.readFileSync(file, 'utf8'), originalFile, 'ownership inspection never edits the source file');
  for (const name of ['LedgerItem', 'Orders', 'Approve', 'Payments', 'Submit', 'InvalidEntry'])
    assert.ok(result.arguments.owners.includes(name), name);
});

test('file splitting validates each action and schedules a screen action before the screen edit', t => {
  const dir = tmp(t);
  const partial = 'server action Incomplete @kAbcdefg\n  assign Value = 1 @n3\n  end @n4\n';
  const refused = writeCall({ lane: 'o11', module: 'M', files: [put(dir, 'gaps.flow', simple('Whole') + '\n' + partial)] }).refusal;
  assert.equal(refused.code, 'INPUT_INVALID');
  assert.deepEqual(refused.problems[0].gaps, [{ action: 'Incomplete', missing: ['@n1', '@n2'] }]);
  assert.equal(refused.problems[0].at, 'files/0');
  const screenAction = 'action MainFlow/Home.Save\n  end\n';
  const basedOn = { capture: 'c'.repeat(64), html: 'd'.repeat(64) };
  for (const lane of ['o11', 'odc']) {
    const result = writeCall({ lane, module: 'M', part: 'html', element: 'Home', basedOn, text: '<button k="w1" onclick="Save()">Save</button>',
      files: [put(dir, 'handlers.flow', simple('Background') + '\n' + screenAction)] });
    const ops = opsOf(result);
    assert.deepEqual(ops.map(op => op.op), ['logic', 'html', 'logic']);
    assert.deepEqual(ops[0].data.flow, [screenAction]);
    assert.deepEqual(ops[2].data.flow, [simple('Background')]);
    assert.match(ops[1].data.edit[0], /onclick="Save"/);
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
  const at = result.stdout.search(/^\{/m);
  assert.notEqual(at, -1, result.stdout.slice(-4000));
  const answer = JSON.parse(result.stdout.slice(at));
  assert.equal(answer.ok, true, JSON.stringify(answer).slice(-4000));
  return answer.data;
}
for (const lane of ['o11', 'odc']) {
  const skip = !(CLI[lane] && fs.existsSync(CLI[lane])) && `${lane} CLI not given (SSAM_CODE_CLI_${lane.toUpperCase()})`;
  test(`T9 corpus ${lane}: every flow action has a header and the split preserves the entire reader output`, { skip, timeout: 1800000 }, async t => {
    const dir = tmp(t);
    const localFiles = lane === 'o11' ? ['reactive-ui.oml', 'traditional-ui.oml', 'mobile-ui.oml', 'blank-service.oml'].map(file => path.join(fixtureRoot, file))
      : fs.readdirSync(path.join(fixtureRoot, 'odc')).filter(file => file.endsWith('.oml')).map(file => path.join(fixtureRoot, 'odc', file));
    const extra = process.env.SSAM_SPLIT_CORPUS === '1'
      ? readJson(path.join(fixtureRoot, 'text-roundtrip/corpus.json')).filter(item => item.lane === lane && fs.existsSync(item.oml)).map(item => item.oml) : [];
    const files = [...new Set([...localFiles, ...extra].map(file => path.resolve(file)))];
    let actions = 0; let modules = 0;
    for (const [i, file] of files.entries()) {
      await t.test(path.basename(file), () => {
        assert.ok(fs.existsSync(file), `missing kernel fixture ${file}`);
        const out = path.join(dir, `${i}.flow`);
        const data = runFlow(lane, file, out, { ...process.env, SSAM_MODULE_INDEX_ROOT: path.join(dir, 'index') });
        const text = fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
        const pieces = text.length ? (splitActions(text) ?? [text]) : [];
        const preserved = text.length ? (splitActions(text, { preserveWhitespace: true }) ?? [text]) : [];
        assert.equal(pieces.length, data.actions, `${path.basename(file)} action count`);
        assert.equal(preserved.length, pieces.length, `${path.basename(file)} lossless action count`);
        for (const piece of [...pieces, ...preserved]) assert.ok(headerOf(piece), `${path.basename(file)}: ${piece.slice(0, 200)}`);
        assert.equal(preserved.join(''), text, `${path.basename(file)} exact round trip`);
        modules++; actions += data.actions;
        t.diagnostic(`${lane} ${path.basename(file)}: ${data.actions} actions, exact=true`);
      });
    }
    t.diagnostic(`corpus ${lane}: modules=${modules}, actions=${actions}, exact=true, extended=${process.env.SSAM_SPLIT_CORPUS === '1'}`);
  });
}
