import './fixtures/isolated-profile.mjs';
// CX16 W4 (7.5): ssam_code writes, reads and checks screens and blocks by element (edits of a read, basedOn {capture, html})
// and corrects a refused or checked job by exact text (basedOn {job, sha256} + edits [{find, with}]), on both lanes, through
// the delivery paths of today (the html op with data.edits; the patch route). No Studio, no kernel: fake runners and lanes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport, McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { CODE_DESCRIPTION, codeCall, grammarCard, normalizeCodeOps, registerSsamCode, writeCall } from '../ssam-code.mjs';
import { expandEditPart } from '../flow-edits.mjs';
import { editCall, HTML_NOTE } from '../module-map.mjs';
import { codeCheck } from '../code-check.mjs';
import { createSsamServer } from '../ssam.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valueOf = result => result.structuredContent ?? JSON.parse(result.content[0].text);
function tmp(t) {
  const parent = path.join(workspace, '.local/cx16-tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'code-html-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const put = (dir, name, text = name) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };

const READ = { capture: 'c'.repeat(64), html: 'h'.repeat(64) };
const EDITS = [{ set: 'w7', attributes: { class: 'btn btn-primary' } }, { into: 'w3', insert: '<span>Novo</span>', at: 'first' }, { find: 'Entrar', with: 'Sair' }];
const LOGIN = '<screen name="Login" actions="DoLogin">\n<div class="login">\n <button class="btn" onclick="DoLogin">Entrar</button>\n</div>\n</screen>\n';
const DO_LOGIN = 'action Login.DoLogin\n  assign X = 1\n  end\n';
const baseJob = () => ({ ops: [
  { op: 'reference', producer: 'Bike_CS', elements: ['IServerEntity:Station'] },
  { op: 'html', data: { html: LOGIN } },
  { op: 'logic', data: { flow: [DO_LOGIN] } },
] });
function writeJob(dir, value = baseJob()) {
  const file = path.join(dir, 'refused', 'job.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2); fs.writeFileSync(file, text);
  return { job: file, sha256: sha(text) };
}
const opsOf = result => { assert.ok(!result.refusal, JSON.stringify(result.refusal)); return result.arguments.job.ops; };

async function liveServer(t, root) {
  const seen = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-cx16-odc', version: '0.0.1' });
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
  const client = new Client({ name: 'cx16-html-edits', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, seen };
}
async function deliveryBoundary(t) {
  const seen = [];
  const server = new McpServer({ name: 'cx16-boundary', version: '1' });
  registerSsamCode(server, { fromJsonSchema, map: async () => { throw Error('unexpected read'); }, deliver: async (tool, args) => {
    seen.push({ tool, args });
    const answer = { ok: true, result: 'delivered' };
    return { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer };
  } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx16-boundary-client', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, seen };
}

test('W4 edits of a read screen: one html op {screen, basedOn, edits} on both lanes; ODC owners name the screen', () => {
  for (const lane of ['o11', 'odc']) {
    const input = { lane, action: 'write', module: 'Bike_UI', part: 'html', element: 'Login', basedOn: READ, edits: EDITS };
    const call = writeCall(input);
    assert.deepEqual(opsOf(call), [{ op: 'html', data: { screen: 'Login', basedOn: READ, edits: EDITS } }]);
    assert.equal(call.tool, lane === 'o11' ? 'o11_deliver' : 'studio_deliver');
    if (lane === 'odc') { assert.deepEqual(call.arguments.owners, ['Login']); assert.deepEqual(call.arguments.changes, ['html written as ssam-html/1: Login']); }
    // part from the form of the base: basedOn {capture, html} with edits is part html (listed).
    const bare = writeCall({ ...input, part: undefined });
    assert.deepEqual(opsOf(bare), opsOf(call));
    assert.ok(bare.normalizations.some(n => n.rule === 'part-from-edits' && /part html/.test(n.note)), JSON.stringify(bare.normalizations));
  }
  // The shape is checked here, every problem at once; the address is the kernel's (no reading is needed here).
  const bad = writeCall({ lane: 'o11', action: 'write', module: 'M', part: 'html', element: 'Login', basedOn: READ, edits: [{ set: 'w1', attributes: { k: 'w2' } }, {}, { find: 'x' }] }).refusal;
  assert.equal(bad.code, 'INPUT_INVALID');
  assert.deepEqual(bad.problems.map(p => [p.at, p.code]), [['edits/0', 'HTML_EDIT_INVALID'], ['edits/1', 'HTML_EDIT_INVALID'], ['edits/2', 'HTML_EDIT_INVALID']]);
  const noBase = writeCall({ lane: 'o11', action: 'write', module: 'M', part: 'html', element: 'Login', basedOn: 'abcdefabcdef0123', edits: [{ delete: 'w1' }] }).refusal;
  assert.ok(noBase.problems.some(p => /\{capture, html\}/.test(p.error)), JSON.stringify(noBase.problems));
  const noElement = writeCall({ lane: 'o11', action: 'write', module: 'M', part: 'html', basedOn: READ, edits: [{ delete: 'w1' }] }).refusal;
  assert.ok(noElement.problems.some(p => /element/.test(p.error)), JSON.stringify(noElement.problems));
  const both = writeCall({ lane: 'o11', action: 'write', module: 'M', part: 'html', element: 'Login', basedOn: READ, text: '<div k="w1"/>', edits: [{ delete: 'w1' }] }).refusal;
  assert.ok(both.problems.some(p => /text or edits/.test(p.error)), JSON.stringify(both.problems));
  // expandEditPart: html passes its item whole (shape checked); a job base is marked for the job text edits.
  assert.deepEqual(expandEditPart({ part: 'html', element: 'Login', basedOn: READ, edits: EDITS, at: 'also/2' }, 'o11'),
    { part: { part: 'html', element: 'Login', basedOn: READ, edits: EDITS, at: 'also/2' }, problems: [], notes: [] });
  const job = { job: 'C:\\x\\job.json', sha256: 'a'.repeat(64) };
  assert.equal(expandEditPart({ element: 'Login', basedOn: job, edits: [{ find: 'a', with: 'b' }] }, 'o11').part.jobText, true);
});

test('W4 also with two screens, and the first item with only edits is kept beside ops and also (line 938)', () => {
  for (const lane of ['o11', 'odc']) {
    const other = { capture: READ.capture, html: 'e'.repeat(64) };
    const two = writeCall({ lane, action: 'write', module: 'Bike_UI', part: 'html', element: 'Login', basedOn: READ, edits: EDITS,
      also: [{ part: 'html', element: 'Stations', basedOn: other, edits: [{ delete: 'w9' }] }] });
    assert.deepEqual(opsOf(two), [{ op: 'html', data: { screen: 'Login', basedOn: READ, edits: EDITS } }, { op: 'html', data: { screen: 'Stations', basedOn: other, edits: [{ delete: 'w9' }] } }]);
    if (lane === 'odc') assert.deepEqual(two.arguments.owners, ['Login', 'Stations']);
    const role = { op: 'create', parent: '@espace', type: 'IRole', name: 'BikeAdmin' };
    const withOps = writeCall({ lane, action: 'write', module: 'Bike_UI', part: 'html', element: 'Login', basedOn: READ, edits: EDITS, ops: [role] });
    assert.deepEqual(opsOf(withOps), [role, { op: 'html', data: { screen: 'Login', basedOn: READ, edits: EDITS } }]);
    // A new screen action and the edit of its screen: the action first (the button that names it resolves), the edit kept.
    const withAction = writeCall({ lane, action: 'write', module: 'Bike_UI', part: 'html', element: 'Login', basedOn: READ, edits: EDITS,
      also: [{ part: 'logic', text: 'action Login.Forgot\n  end\n' }] });
    assert.deepEqual(opsOf(withAction).map(op => op.op + (op.data.edits ? ' edits' : '')), ['logic', 'html edits']);
  }
});

test('W4 normalizeCodeOps: {op:"html", screen, edits, basedOn} beside data is data, listed as the edit form is', () => {
  const { job, changed, normalizations } = normalizeCodeOps({ ops: [{ op: 'html', screen: 'Login', basedOn: READ, edits: EDITS }] });
  assert.equal(changed, true);
  assert.deepEqual(job.ops, [{ op: 'html', data: { screen: 'Login', edits: EDITS, basedOn: READ } }]);
  assert.deepEqual(normalizations, [{ rule: 'job-op', at: '/ops/0', note: 'html: screen, edits and basedOn beside data are data' }]);
  // The edit form keeps its words.
  assert.equal(normalizeCodeOps([{ op: 'html', screen: 'Login', basedOn: READ, edit: ['<div k="w1"/>'] }]).normalizations[0].note, 'html: screen, edit and basedOn beside data are data');
});

test('W4 the edit continuation of an html read is the edits form, and codeCall makes it ssam_code write edits', () => {
  const html = { root: 'Login', htmlSha256: READ.html, model: 'Bike_UI' };
  for (const lane of ['o11', 'odc']) {
    const continuation = editCall(lane, html, READ.capture);
    const op = continuation.arguments.job.ops[0];
    assert.deepEqual(op.data.edits, [{ set: '<k>', attributes: { '<attribute>': '<value>' } }, { find: '<exact text>', with: '<new text>' }]);
    assert.equal(Object.hasOwn(op.data, 'edit'), false);
    const code = codeCall(continuation);
    assert.equal(code.tool, 'ssam_code');
    assert.deepEqual(code.arguments, { lane, module: 'Bike_UI', action: 'write', part: 'html', element: 'Login', basedOn: READ, edits: op.data.edits,
      ...(lane === 'odc' ? { feature: 'Login (change)', owners: ['Login'], changes: ['<what changes in the screen>'] } : {}) });
    // The round trip: the same op again.
    assert.deepEqual(opsOf(writeCall(code.arguments)), [op]);
  }
  // The reading note says edits first and the edit form as the alternative.
  assert.match(HTML_NOTE, /edits/); assert.match(HTML_NOTE, /only the elements you changed, each whole with its k/);
});

test('W4 basedOn {job, sha256} + edits: the patch route of today, the model resends nothing; refusals of 7.4 are INPUT_INVALID', t => {
  const dir = tmp(t); const base = writeJob(dir);
  const input = lane => ({ lane, action: 'write', module: 'Bike_UI', basedOn: base, element: 'Login', edits: [{ find: '>Entrar<', with: '>Sair<' }],
    also: [{ element: 'Login.DoLogin', edits: [{ find: 'assign X = 1', with: 'assign X = 2' }] }] });
  const patch = [{ op: 'replace', path: '/ops/1/data/html', value: LOGIN.replace('>Entrar<', '>Sair<') }, { op: 'replace', path: '/ops/2/data/flow/0', value: DO_LOGIN.replace('X = 1', 'X = 2') }];
  const o11 = writeCall(input('o11'));
  assert.deepEqual(o11.tool, 'o11_deliver');
  assert.deepEqual(o11.arguments, { module: 'Bike_UI', patch, basedOn: base, until: 'merge' });
  assert.deepEqual(o11.normalizations.map(n => [n.rule, n.at]), [['job-text-edits', '/edits'], ['job-text-edits', '/also/0/edits']]);
  for (const piece of ['<screen', '<div class="login">', 'action Login.DoLogin']) assert.ok(!JSON.stringify(input('o11')).includes(piece), 'the model sends no document: ' + piece);
  const odc = writeCall(input('odc'));
  assert.equal(odc.tool, 'studio_deliver');
  assert.deepEqual(odc.arguments.patch, patch); assert.deepEqual(odc.arguments.basedOn, base);
  assert.deepEqual(odc.arguments.owners, ['Login', 'DoLogin']);
  assert.equal(odc.arguments.job, undefined);
  // The model's own patch goes after the generated one; the same path in both is EDIT_OVERLAP.
  const added = writeCall({ ...input('o11'), patch: [{ op: 'add', path: '/ops/-', value: { op: 'create', parent: '@espace', type: 'IRole', name: 'R' } }] });
  assert.deepEqual(added.arguments.patch.map(p => p.op), ['replace', 'replace', 'add']);
  const overlap = writeCall({ ...input('o11'), patch: [{ op: 'replace', path: '/ops/1/data/html', value: LOGIN }] }).refusal;
  assert.equal(overlap.code, 'INPUT_INVALID'); assert.ok(overlap.problems.some(p => p.code === 'EDIT_OVERLAP' && p.at === 'patch/0'));
  const unknown = writeCall({ ...input('o11'), element: 'Nope' }).refusal;
  assert.equal(unknown.problems[0].code, 'EDIT_ELEMENT_UNKNOWN'); assert.ok(unknown.problems[0].names.includes('Login.DoLogin'));
  const changed = writeCall({ ...input('o11'), basedOn: { ...base, sha256: 'f'.repeat(64) } }).refusal;
  assert.ok(changed.problems.some(p => p.code === 'BASE_CHANGED'));
  // The read-edit refusal of today stays: patch + edits of a read action.
  const read = writeCall({ lane: 'o11', action: 'write', module: 'M', basedOn: base, patch: [], also: [{ part: 'logic', element: 'X', basedOn: 'abcdefabcdef0123', edits: [{ delete: '@n1' }] }] }).refusal;
  assert.ok(read.problems.some(p => p.at === 'patch' && /cannot be combined/.test(p.error)), JSON.stringify(read.problems));
});

test('W4 codeCheck: basedOn {job} + edits checks the corrected job; the model\'s patch stays refused', async t => {
  const dir = tmp(t); const base = writeJob(dir); const capture = put(dir, 'base.oml');
  for (const lane of ['o11', 'odc']) {
    let ran = null;
    const result = await codeCheck({ lane, module: 'Bike_UI', base: capture, basedOn: base, element: 'Login', edits: [{ find: '>Entrar<', with: '>Sair<' }], producers: { Bike_CS: capture } },
      { root: dir, local: path.join(dir, 'local'), runJob: async request => { ran = readJson(request.job); return { ok: true, job: request.job }; } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(ran.ops[1].data.html, LOGIN.replace('>Entrar<', '>Sair<'));
    assert.deepEqual(ran.ops.map(op => op.op), ['reference', 'html', 'logic']);
    assert.deepEqual(Object.keys(result.producers), ['Bike_CS'], 'the reference ops read are those of the corrected job');
    assert.ok(result.normalizations.some(n => n.rule === 'job-text-edits'), JSON.stringify(result.normalizations));
    const checks = path.join(lane === 'o11' ? path.join(dir, 'local') : path.join(dir, '.local', 'lane-odc'), 'jobs', 'check');
    assert.deepEqual(fs.readdirSync(checks).filter(name => name.endsWith('.json')), [], 'no stray patched file beside the check folders');
  }
  // The model's own patch in a check: refused as before (forbidden), the job never run.
  let calls = 0;
  const refused = await codeCheck({ lane: 'o11', module: 'Bike_UI', base: capture, basedOn: base, patch: [{ op: 'test', path: '/ops/0/op', value: 'reference' }] },
    { root: dir, local: path.join(dir, 'local'), runJob: async () => { calls++; return { ok: true }; } });
  assert.equal(refused.code, 'INPUT_INVALID'); assert.ok(refused.problems.some(p => p.at === 'patch')); assert.equal(calls, 0);
  // A base that changed: INPUT_INVALID with its code, nothing run.
  const changed = await codeCheck({ lane: 'o11', module: 'Bike_UI', base: capture, basedOn: { ...base, sha256: 'f'.repeat(64) }, element: 'Login', edits: [{ find: '>Entrar<', with: '>Sair<' }] },
    { root: dir, local: path.join(dir, 'local'), runJob: async () => { calls++; return { ok: true }; } });
  assert.equal(changed.code, 'INPUT_INVALID', JSON.stringify(changed)); assert.equal(calls, 0);
  assert.ok(changed.problems.some(p => p.code === 'INPUT_INVALID' && p.reason === 'BASE_CHANGED'), JSON.stringify(changed.problems));
  // An edit refused for its text alone (no INPUT_INVALID among the write's problems) still makes the check INPUT_INVALID.
  const unique = await codeCheck({ lane: 'o11', module: 'Bike_UI', base: capture, basedOn: base, element: 'Login', edits: [{ find: 'class="', with: 'x' }] },
    { root: dir, local: path.join(dir, 'local'), runJob: async () => { calls++; return { ok: true }; } });
  assert.equal(unique.code, 'INPUT_INVALID', JSON.stringify(unique)); assert.equal(calls, 0);
  assert.deepEqual(unique.problems.map(p => [p.at, p.reason]), [['edits/0', 'EDIT_TEXT_NOT_UNIQUE']]);
});

test('W4 a refused check names its job (job, jobSha256, nextBasedOn); a static refusal passes stage, stoppedBefore, static and its continuation', async t => {
  const dir = tmp(t); const capture = put(dir, 'base.oml'); const guided = [];
  const deps = runJob => ({ root: dir, local: path.join(dir, 'local'), runJob, guidance: async (_lane, _job, result) => { guided.push(result.stage ?? 'none'); return result; } });
  const input = { lane: 'o11', module: 'Bike_UI', base: capture, part: 'logic', text: 'server action Neutral\n  end\n' };
  const plain = await codeCheck(input, deps(async request => ({ ok: false, code: 'PREFLIGHT_REFUSED', job: request.job, problems: [{ code: 'LOGIC_INVALID', pointer: '/ops/0', message: 'x' }] })));
  assert.equal(plain.code, 'CHECK_REFUSED');
  assert.equal(plain.jobSha256, sha(fs.readFileSync(plain.job))); assert.deepEqual(plain.nextBasedOn, { job: plain.job, sha256: plain.jobSha256 });
  assert.deepEqual(plain.continuation, { tool: 'ssam_code', arguments: { ...input, action: 'check' } }, 'without a static refusal the continuation is as before');
  assert.equal(plain.stage, undefined);
  // A runner that names no job: the job of the check is named.
  const nameless = await codeCheck(input, deps(async () => ({ ok: false, code: 'PREFLIGHT_REFUSED', problems: [] })));
  assert.match(nameless.job, /job\.json$/); assert.equal(nameless.nextBasedOn.sha256, sha(fs.readFileSync(nameless.job)));
  // The static refusal of the precheck (W7): stopped before the apply, its own continuation (the edits), never the input again.
  const continuation = { tool: 'ssam_code', arguments: { lane: 'o11', action: 'check', module: 'Bike_UI', basedOn: { job: 'J', sha256: 'S' }, element: 'Login', edits: [{ find: 'a', with: 'b' }] } };
  const statics = { basis: { module: { fresh: true } }, checked: ['S1'], skipped: [], elapsedMs: 12 };
  const stopped = await codeCheck(input, deps(async request => ({ ok: false, code: 'PREFLIGHT_REFUSED', stage: 'static', stoppedBefore: 'apply', phases: ['preflight', 'static'],
    verifyRan: false, verifyReason: 'stopped before the Studio and the apply', problems: [{ code: 'HTML_NAME_UNKNOWN', pointer: '/ops/0', message: 'm' }], static: statics, job: request.job, continuation })));
  assert.equal(stopped.code, 'CHECK_REFUSED'); assert.equal(stopped.refusalCode, 'PREFLIGHT_REFUSED');
  assert.equal(stopped.stage, 'static'); assert.equal(stopped.stoppedBefore, 'apply'); assert.deepEqual(stopped.static, statics);
  assert.deepEqual(stopped.phases, ['preflight', 'static']); assert.deepEqual(stopped.continuation, continuation);
  assert.equal(stopped.verifyRan, false); assert.ok(stopped.nextBasedOn);
  // The guidance runs for the other refusals only (7.5 c): the static one carries its own correction.
  assert.deepEqual(guided, ['none', 'none']);
});

test('W4 through the server: a write with edits of a read and a correction by edits of a job are delivered as expected', async t => {
  const root = tmp(t);
  const { client, seen } = await liveServer(t, root);
  const edits = valueOf(await client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'write', module: 'Bike_UI', part: 'html', element: 'Login', basedOn: READ, edits: EDITS } }));
  assert.equal(edits.ok, true, JSON.stringify(edits));
  assert.equal(seen.length, 1);
  assert.deepEqual(readJson(seen[0].job).ops, [{ op: 'html', data: { screen: 'Login', basedOn: READ, edits: EDITS } }]);
  assert.deepEqual(seen[0].owners, ['Login']);
  const base = writeJob(root);
  const correction = valueOf(await client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', action: 'write', module: 'Bike_UI', basedOn: base, element: 'Login', edits: [{ find: '>Entrar<', with: '>Sair<' }] } }));
  assert.equal(correction.ok, true, JSON.stringify(correction));
  assert.equal(seen.length, 2);
  const corrected = readJson(seen[1].job);
  assert.equal(corrected.ops[1].data.html, LOGIN.replace('>Entrar<', '>Sair<'));
  assert.equal(corrected.ops[2].data.flow[0], DO_LOGIN);
  assert.ok(correction.normalizations.some(n => n.rule === 'job-text-edits'), JSON.stringify(correction.normalizations));
  // The boundary of ssam_code alone (any registered deliver): the html op as writeCall builds it, O11 too.
  const boundary = await deliveryBoundary(t);
  const o11 = valueOf(await boundary.client.callTool({ name: 'ssam_code', arguments: { lane: 'o11', action: 'write', module: 'Bike_UI', element: 'Login', basedOn: READ, edits: EDITS } }));
  assert.equal(o11.ok, true, JSON.stringify(o11));
  assert.deepEqual(boundary.seen[0], { tool: 'o11_deliver', args: { module: 'Bike_UI', job: { ops: [{ op: 'html', data: { screen: 'Login', basedOn: READ, edits: EDITS } }] }, until: 'merge' } });
});

test('W4 texts: one new html rule, the edits schema covers logic, html and job text, one sentence in the description', async t => {
  const rules = grammarCard('html', 'odc').card.rules;
  const rule = rules.find(r => /^Change a few elements of a read screen/.test(r));
  assert.ok(rule, JSON.stringify(rules));
  assert.match(rule, /basedOn \{capture, html\}/); assert.match(rule, /basedOn \{job, sha256\}/);
  assert.equal(rules[rules.indexOf(rule) - 1].startsWith('Changing an existing screen'), true, 'right after the rule of a read screen');
  assert.match(CODE_DESCRIPTION, /html: edits/);
  const server = new McpServer({ name: 'cx16-schema', version: '1' });
  registerSsamCode(server, { fromJsonSchema, map: async () => ({}), deliver: async () => ({}) });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'cx16-schema-client', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(x => x.name === 'ssam_code');
  const description = tool.inputSchema.properties.edits.description;
  for (const word of ['logic', 'html', '{find, with}', 'job']) assert.ok(description.includes(word), word + ': ' + description);
  const before = 'write logic: line edits of ONE read action (element + basedOn = its textSha) instead of its whole text: {replace:"@n4", with:"..."}, {after:"@n2"|before:"@n2", insert:"..."}, {delete:"@n3"}; the header by its @key, a line without id by its exact text, "@n10#2" the 2nd line with @n10';
  assert.ok(description.length <= before.length + 160, `${description.length} > ${before.length} + 160`);
});
