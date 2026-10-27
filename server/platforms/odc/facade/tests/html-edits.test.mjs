import './fixtures/isolated-profile.mjs';
// CX16 W3 (7.1, 7.4): the shape of the edits of a reading, and the edits by exact text of the texts of a refused or checked
// job (basedOn {job, sha256}) as a JSON Patch over that job. Synthetic jobs only (no Studio, no kernel, no capture).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { jobTextEdits, readingEditsShape } from '../html-edits.mjs';
import { patchJob, resolvePatchedJob, PATCH_MAX_OPS } from '../job-patch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = text => Buffer.byteLength(text, 'utf8');

function tmp(t) {
  const parent = path.join(workspace, '.local/cx16-tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'html-edits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const LOGIN = `<screen name="Login" actions="DoLogin">
<var name="User" type="Text"/>
<div class="login">
 <input bind="User" class="form-control"/>
 <button class="btn" onclick="DoLogin">Entrar</button>
</div>
</screen>
`;
const HEADER = `<block name="Header">
<div class="header">
 {{ "Bike" }}
</div>
</block>
`;
const DDL = `create entity Station (
  Id Long Integer identifier auto required,
  Name Text(120) required
);
`;
const DO_LOGIN = 'action Login.DoLogin\n  in User: Text\n  assign X = 1\n  end\n';
const LIST = '/// Lists.\nserver action ListStations\n  out Rows: Station List\n  GetStations = aggregate FROM Station MAX 50\n  end\n';
// Two actions in one text: an edit of B is searched in B's stretch only.
const TWO = 'server action A\n  assign X = 1\n  end\n\n/// B.\nserver action B\n  assign X = 1\n  end\n';
const EDIT_TEXTS = ['<div k="w3" class="a">\n {{ Station.Name }}\n</div>', '<button k="w9" class="btn">Go</button>'];
const job = () => ({ ops: [
  { op: 'reference', producer: 'Bike_CS', elements: ['IServerEntity:Station'] },
  { op: 'spec', data: { ddl: DDL } },
  { op: 'html', data: { html: HEADER } },
  { op: 'html', data: { html: LOGIN } },
  { op: 'html', data: { screen: 'Stations', basedOn: { capture: 'c'.repeat(64), html: 'h'.repeat(64) }, edit: EDIT_TEXTS } },
  { op: 'logic', data: { flow: [DO_LOGIN, { text: LIST, basedOn: 'abcdefabcdef0123' }, TWO] } },
  { op: 'logic', data: { text: 'action Stations.Refresh\n  refresh GetStations\n  end\n' } },
] });
function writeJob(t, value = job()) {
  const file = path.join(tmp(t), 'job.json');
  const text = JSON.stringify(value, null, 2);
  fs.writeFileSync(file, text);
  return { file, sha256: sha(text), value };
}
const write = (base, extra) => ({ lane: 'o11', action: 'write', module: 'Bike_UI', basedOn: { job: base.file, sha256: base.sha256 }, ...extra });
// The text at a JSON pointer of a job.
const at = (value, pointer) => pointer.split('/').slice(1).reduce((node, token) => node[Array.isArray(node) ? Number(token) : token], value);
function corrected(base, extra) {
  const result = jobTextEdits(write(base, extra));
  assert.ok(result && !result.problems, JSON.stringify(result?.problems));
  return { ...result, job: patchJob(base.value, result.input.patch).job };
}

test('readingEditsShape: every form of 7.1 passes; every bad shape is a problem at edits/<j>, all at once', () => {
  assert.deepEqual(readingEditsShape([
    { find: 'Entrar', with: 'Sair' }, { find: 'x', with: '' },
    { set: 'w17', attributes: { class: 'a b', 'os-Width': null } },
    { replace: 'w17', with: '<div class="a">x</div>' }, { delete: 'w3' },
    { after: 'w4', insert: '<i/>' }, { before: '@AbC', insert: '<i/>' },
    { into: 'w5/Content', insert: '<i/>', at: 'first' }, { into: '/', insert: '<i/>' }, { into: 'w23.true', insert: '<i/>', at: 'last' },
    { move: 'w9', after: 'w3' }, { move: 'w9', into: 'w5', at: 'first' },
  ]), []);
  for (const bad of [null, [], {}, 'x', Array.from({ length: 501 }, () => ({ delete: 'w1' }))]) {
    const problems = readingEditsShape(bad);
    assert.equal(problems.length, 1); assert.equal(problems[0].at, 'edits'); assert.equal(problems[0].code, 'HTML_EDIT_INVALID');
  }
  const cases = [
    [{}, /exactly one address/], [{ set: 'w1', delete: 'w2' }, /exactly one address.*set, delete/], [{ find: 'x' }, /find needs with/],
    [{ find: '', with: 'y' }, /exact, nonempty text/], [{ replace: 'w1' }, /replace needs with/], [{ replace: 'w1', with: 3 }, /replace needs with/],
    [{ set: 'w1' }, /set needs attributes/], [{ set: 'w1', attributes: 'class=a' }, /set needs attributes/],
    [{ set: 'w1', attributes: { k: 'w9' } }, /never changes k/], [{ set: 'w1', attributes: { class: 1 } }, /string or null: class/],
    [{ after: 'w1' }, /after needs insert/], [{ into: 'w1', insert: '<i/>', at: 'middle' }, /"first" or "last"/],
    [{ move: 'w1' }, /exactly one destination/], [{ move: 'w1', after: 'w2', before: 'w3' }, /exactly one destination/],
    [{ move: 'w1', after: 'w2', with: '<i/>' }, /with does not go with move/], [{ move: 'w1', after: 'w2', at: 'first' }, /at goes with into/],
    [{ delete: 'w1', with: 'x' }, /with does not go with delete/], [{ find: 'a', with: 'b', insert: 'c' }, /insert does not go with find/],
    [{ delete: 'w1', typo: 1 }, /unknown edit key: typo/], [{ delete: '' }, /address of an element/], [3, /an edit is an object/],
  ];
  const problems = readingEditsShape(cases.map(c => c[0]));
  cases.forEach(([edit, pattern], j) => {
    const mine = problems.filter(p => p.at === `edits/${j}`);
    assert.ok(mine.some(p => pattern.test(p.error)), `${JSON.stringify(edit)}: ${JSON.stringify(mine)}`);
    assert.ok(mine.every(p => p.code === 'HTML_EDIT_INVALID'));
  });
});

test('null when the write has no edits over a job: reading edits, a patch alone and plain writes stay as they were', t => {
  const base = writeJob(t);
  assert.equal(jobTextEdits(write(base, { patch: [{ op: 'test', path: '/ops/0/op', value: 'reference' }] })), null);
  assert.equal(jobTextEdits({ lane: 'o11', module: 'M', part: 'html', element: 'Login', basedOn: { capture: 'c', html: 'h' }, edits: [{ delete: 'w1' }] }), null);
  assert.equal(jobTextEdits({ lane: 'o11', module: 'M', part: 'logic', element: 'X', basedOn: 'abcdefabcdef0123', edits: [{ delete: '@n1' }] }), null);
  // A partial job over basedOn with edits of a read in also (their own basedOn): the partial-job route of today.
  assert.equal(jobTextEdits(write(base, { also: [{ part: 'logic', element: 'X', basedOn: 'abcdefabcdef0123', edits: [{ delete: '@n1' }] }] })), null);
  assert.equal(jobTextEdits({ lane: 'o11', module: 'M', part: 'logic', text: DO_LOGIN }), null);
});

test('a <screen> and a <block> document of the job: one replace each, reproduced by patchJob, with the note', t => {
  const base = writeJob(t);
  const loginAfter = LOGIN.replace('class="btn" onclick="DoLogin">Entrar', 'class="btn btn-primary" onclick="DoLogin">Entrar');
  const headerAfter = HEADER.replace('{{ "Bike" }}', '{{ "Bikes" }}');
  const r = corrected(base, { part: 'html', element: 'Login', edits: [{ find: 'class="btn" onclick="DoLogin">Entrar', with: 'class="btn btn-primary" onclick="DoLogin">Entrar' }],
    also: [{ element: 'Header', edits: [{ find: '{{ "Bike" }}', with: '{{ "Bikes" }}' }] }] });
  assert.deepEqual(r.input.patch, [{ op: 'replace', path: '/ops/3/data/html', value: loginAfter }, { op: 'replace', path: '/ops/2/data/html', value: headerAfter }]);
  assert.equal(r.job.ops[3].data.html, loginAfter); assert.equal(r.job.ops[2].data.html, headerAfter);
  assert.deepEqual(r.input.basedOn, { job: base.file, sha256: base.sha256 });
  for (const gone of ['edits', 'element', 'also']) assert.equal(Object.hasOwn(r.input, gone), false, gone);
  assert.deepEqual(r.notes, [
    { rule: 'job-text-edits', at: '/edits', note: `Login: 1 edit(s) on job ${base.sha256.slice(0, 12)}: ${bytes(LOGIN)} -> ${bytes(loginAfter)} bytes` },
    { rule: 'job-text-edits', at: '/also/0/edits', note: `Header: 1 edit(s) on job ${base.sha256.slice(0, 12)}: ${bytes(HEADER)} -> ${bytes(headerAfter)} bytes` },
  ]);
  // A document keeps the text as the model wrote it (it takes both on<event>="X" and "X()").
  const event = corrected(base, { element: 'Login', edits: [{ find: 'onclick="DoLogin"', with: 'onclick="DoLogin()"' }] });
  assert.equal(event.job.ops[3].data.html, LOGIN.replace('onclick="DoLogin"', 'onclick="DoLogin()"'));
});

test('the texts of an edit op of the job (data.edit) are the screen it edits, apart from a document with the same words', t => {
  const base = writeJob(t);
  const r = corrected(base, { element: 'Stations', edits: [{ find: 'class="a"', with: 'class="a b"' }, { find: 'class="btn">Go', with: 'class="btn">Ir' }] });
  assert.deepEqual(r.input.patch.map(p => p.path), ['/ops/4/data/edit/0', '/ops/4/data/edit/1']);
  assert.deepEqual(r.job.ops[4].data.edit, [EDIT_TEXTS[0].replace('class="a"', 'class="a b"'), EDIT_TEXTS[1].replace('>Go', '>Ir')]);
  assert.equal(r.job.ops[3].data.html, LOGIN, 'class="btn" of the Login document is another element');
  // The text of an edit op takes an event without arguments as the reader writes it (the kernel refuses X() there).
  const event = corrected(base, { element: 'Stations', edits: [{ find: 'class="btn">', with: 'class="btn" onclick="Go()">' }] });
  assert.equal(event.job.ops[4].data.edit[1], '<button k="w9" class="btn" onclick="Go">Go</button>');
});

test('logic: the header names the action, with and without its screen; data.flow strings, {text} items and data.text', t => {
  const base = writeJob(t);
  const owned = corrected(base, { element: 'Login.DoLogin', edits: [{ find: 'assign X = 1', with: 'assign X = 2' }] });
  assert.deepEqual(owned.input.patch, [{ op: 'replace', path: '/ops/5/data/flow/0', value: DO_LOGIN.replace('X = 1', 'X = 2') }]);
  const bare = corrected(base, { part: 'logic', element: 'DoLogin', edits: [{ find: 'assign X = 1', with: 'assign X = 3' }] });
  assert.equal(bare.input.patch[0].path, '/ops/5/data/flow/0');
  const server = corrected(base, { element: 'ListStations', edits: [{ find: 'MAX 50', with: 'MAX 100' }] });
  assert.deepEqual(server.input.patch, [{ op: 'replace', path: '/ops/5/data/flow/1/text', value: LIST.replace('MAX 50', 'MAX 100') }]);
  assert.equal(server.job.ops[5].data.flow[1].basedOn, 'abcdefabcdef0123', 'the rest of the item stays');
  const text = corrected(base, { element: 'MainFlow/Stations.Refresh', edits: [{ find: 'refresh GetStations', with: 'refresh GetStations\n  end' }] });
  assert.equal(text.input.patch[0].path, '/ops/6/data/text');
  // Two actions in one text: "assign X = 1" occurs in A and in B; in B (its stretch) it occurs once.
  const second = corrected(base, { element: 'B', edits: [{ find: 'assign X = 1', with: 'assign X = 9' }] });
  assert.equal(second.job.ops[5].data.flow[2], TWO.slice(0, TWO.lastIndexOf('assign X = 1')) + 'assign X = 9\n  end\n');
  const wrongScreen = jobTextEdits(write(base, { element: 'Stations.DoLogin', edits: [{ find: 'assign X = 1', with: 'x' }] }));
  assert.equal(wrongScreen.problems[0].code, 'EDIT_ELEMENT_UNKNOWN');
  assert.ok(wrongScreen.problems[0].names.includes('Login.DoLogin') && wrongScreen.problems[0].names.includes('ddl') && wrongScreen.problems[0].names.includes('Header'));
});

test('ddl: the data.ddl of the spec op', t => {
  const base = writeJob(t);
  const r = corrected(base, { element: 'ddl', edits: [{ find: 'Name Text(120) required', with: 'Name Text(200) required' }] });
  assert.deepEqual(r.input.patch, [{ op: 'replace', path: '/ops/1/data/ddl', value: DDL.replace('Text(120)', 'Text(200)') }]);
  assert.equal(jobTextEdits(write(base, { part: 'logic', element: 'ddl', edits: [{ find: 'Name', with: 'N' }] })).problems[0].code, 'EDIT_ELEMENT_UNKNOWN', 'part breaks the tie');
});

test('find once, nowhere or twice: EDIT_TEXT_NOT_UNIQUE with the lines of each occurrence or the nearest ones', t => {
  const base = writeJob(t);
  const twice = jobTextEdits(write(base, { element: 'Login', edits: [{ find: 'class="', with: 'x' }] }));
  assert.equal(twice.problems.length, 1);
  const p = twice.problems[0];
  assert.equal(p.code, 'EDIT_TEXT_NOT_UNIQUE'); assert.equal(p.at, 'edits/0'); assert.match(p.error, /occurs 3 times in Login/);
  assert.deepEqual(p.lines, [{ line: 3, text: '<div class="login">' }, { line: 4, text: ' <input bind="User" class="form-control"/>' }, { line: 5, text: ' <button class="btn" onclick="DoLogin">Entrar</button>' }]);
  const nowhere = jobTextEdits(write(base, { element: 'Login', edits: [{ find: '<button class="btn" onclick="DoLogin">Sair</button>', with: 'x' }] })).problems[0];
  assert.equal(nowhere.code, 'EDIT_TEXT_NOT_UNIQUE'); assert.match(nowhere.error, /occurs nowhere in Login/);
  assert.deepEqual(nowhere.lines, [{ line: 5, text: ' <button class="btn" onclick="DoLogin">Entrar</button>' }]);
  // Overlapping starts count: "aa" is twice in "aaa".
  const overlapping = writeJob(t, { ops: [{ op: 'spec', data: { ddl: 'aaa' } }] });
  assert.match(jobTextEdits(write(overlapping, { element: 'ddl', edits: [{ find: 'aa', with: 'b' }] })).problems[0].error, /occurs 2 times/);
});

test('EDIT_OVERLAP: two edits of the same stretch, and an edit beside the model\'s patch on the same path', t => {
  const base = writeJob(t);
  const two = jobTextEdits(write(base, { element: 'Login', edits: [{ find: 'class="login"', with: 'class="x"' }, { find: '<div class="login">', with: '<div>' }] }));
  assert.deepEqual(two.problems.map(p => [p.at, p.code]), [['edits/0', 'EDIT_OVERLAP'], ['edits/1', 'EDIT_OVERLAP']]);
  // Adjacent stretches do not overlap.
  const adjacent = corrected(base, { element: 'Login', edits: [{ find: '<div ', with: '<section ' }, { find: 'class="login">', with: 'class="l">' }] });
  assert.equal(adjacent.job.ops[3].data.html, LOGIN.replace('<div class="login">', '<section class="l">'));
  for (const patch of [[{ op: 'replace', path: '/ops/3/data/html', value: '<screen name="Login"></screen>' }], [{ op: 'remove', path: 'ops/3' }],
    [{ op: 'test', path: '/ops/3/data/html', value: LOGIN }]]) {
    const r = jobTextEdits(write(base, { element: 'Login', edits: [{ find: 'Entrar', with: 'Sair' }], patch }));
    assert.deepEqual(r.problems.map(p => [p.at, p.code]), [['patch/0', 'EDIT_OVERLAP'], ['edits/0', 'EDIT_OVERLAP']], JSON.stringify(patch));
  }
  // The model's patch elsewhere goes after the generated replaces (replace keeps every index of the base).
  const together = corrected(base, { element: 'Login', edits: [{ find: 'Entrar', with: 'Sair' }], patch: [{ op: 'add', path: '/ops/-', value: { op: 'create', parent: '@espace', type: 'IRole', name: 'Admin' } }] });
  assert.deepEqual(together.input.patch.map(p => p.op + ' ' + p.path), ['replace /ops/3/data/html', 'add /ops/-']);
  assert.equal(together.job.ops.length, 8); assert.match(together.job.ops[3].data.html, />Sair</);
  // A model patch that does not apply to the base is a problem of this refusal, at its own index.
  const broken = jobTextEdits(write(base, { element: 'Login', edits: [{ find: 'Entrar', with: 'Sair' }], patch: [{ op: 'replace', path: '/ops/99/data', value: 1 }] }));
  assert.deepEqual(broken.problems.map(p => [p.at, p.code]), [['patch/0', 'PATCH_INVALID']]);
});

test('a composite job, new parts beside a correction and a changed base are refused with one sentence each', t => {
  const composite = writeJob(t, { jobs: ['job:a', 'job:b'] });
  const c = jobTextEdits(write(composite, { element: 'Login', edits: [{ find: 'a', with: 'b' }] }));
  assert.deepEqual(c.problems.map(p => [p.at, p.code]), [['basedOn', 'PATCH_PATH_FORBIDDEN']]); assert.match(c.problems[0].error, /composite job/);
  const base = writeJob(t);
  const mixed = jobTextEdits(write(base, { element: 'Login', edits: [{ find: 'Entrar', with: 'Sair' }], text: DO_LOGIN, ops: [{ op: 'create' }], files: ['C:\\x.flow'],
    also: [{ part: 'logic', text: LIST }, { part: 'logic', element: 'X', basedOn: 'abcdefabcdef0123', edits: [{ delete: '@n1' }] }] }));
  assert.deepEqual(mixed.problems.map(p => p.at), ['text', 'files', 'ops', 'also/0', 'also/1']);
  assert.equal(new Set(mixed.problems.map(p => p.error)).size, 1); assert.match(mixed.problems[0].error, /^a correction of a job is patch \+ edits/);
  const changed = jobTextEdits(write({ ...base, sha256: 'f'.repeat(64) }, { element: 'Login', edits: [{ find: 'Entrar', with: 'Sair' }] }));
  assert.deepEqual(changed.problems.map(p => [p.at, p.code]), [['basedOn', 'BASE_CHANGED']]);
  const missing = jobTextEdits(write({ file: path.join(path.dirname(base.file), 'none.json'), sha256: base.sha256 }, { element: 'Login', edits: [{ find: 'Entrar', with: 'Sair' }] }));
  assert.deepEqual(missing.problems.map(p => p.code), ['BASE_NOT_FOUND']); assert.match(missing.problems[0].error, /nothing was patched/);
  const task = jobTextEdits({ lane: 'o11', module: 'M', basedOn: { taskId: 'a'.repeat(32) }, element: 'Login', edits: [{ find: 'Entrar', with: 'Sair' }] });
  assert.match(task.problems[0].error, /need basedOn \{job, sha256\}/);
});

test('every problem in one refusal: shape, element, uniqueness, overlap and mixing together', t => {
  const base = writeJob(t);
  const r = jobTextEdits(write(base, { element: 'Login', text: 'x', edits: [{ replace: 'w1', with: 'x' }, { find: 'class="', with: 'x' }, { find: 'Entrar', with: 'Sair' }, { find: 'Entrar</button>', with: 'Sair</button>' }],
    also: [{ element: 'Nope', edits: [{ find: 'a', with: 'b' }] }, { element: 'ddl', edits: [] }] }));
  const seen = r.problems.map(p => `${p.at} ${p.code ?? ''}`.trim());
  for (const expected of ['text', 'edits/0', 'edits/1 EDIT_TEXT_NOT_UNIQUE', 'edits/2 EDIT_OVERLAP', 'edits/3 EDIT_OVERLAP', 'also/0/element EDIT_ELEMENT_UNKNOWN', 'also/1/edits'])
    assert.ok(seen.includes(expected), expected + ' in ' + JSON.stringify(seen));
  assert.match(r.problems.find(p => p.at === 'edits/0').error, /an edit is \{find, with\}.*replace address a read/);
  assert.equal(r.error, r.problems.map(p => `${p.at}: ${p.error}`).join(' | '));
});

test('a job-list (paths /<i>/...) and the limit of the patch, with the count', t => {
  const list = writeJob(t, [{ op: 'set', target: '@a', prop: 'Label', value: 'x' }, ...EDIT_TEXTS.map((text, i) => ({ op: 'html', data: { screen: 'S' + i, basedOn: { capture: 'c', html: 'h' }, edit: [text] } }))]);
  const r = corrected(list, { element: 'S1', edits: [{ find: '>Go<', with: '>Ir<' }] });
  assert.deepEqual(r.input.patch, [{ op: 'replace', path: '/2/data/edit/0', value: EDIT_TEXTS[1].replace('>Go<', '>Ir<') }]);
  assert.equal(r.job[2].data.edit[0], EDIT_TEXTS[1].replace('>Go<', '>Ir<'));
  const base = writeJob(t);
  const model = Array.from({ length: PATCH_MAX_OPS }, () => ({ op: 'test', path: '/ops/0/op', value: 'reference' }));
  const over = jobTextEdits(write(base, { element: 'Login', edits: [{ find: 'Entrar', with: 'Sair' }], patch: model }));
  assert.equal(over.problems.length, 1); assert.equal(over.problems[0].code, 'PATCH_INVALID');
  assert.match(over.problems[0].error, new RegExp(`1 replace\\(s\\), one per text the edits change, \\+ ${PATCH_MAX_OPS} operation\\(s\\) of patch = ${PATCH_MAX_OPS + 1}; at most ${PATCH_MAX_OPS}`));
});

test('past the limit, the changed texts of one list are one replace of that list (and the count is checked again)', t => {
  const texts = ['A', 'B', 'C'].map(n => `server action ${n}\n  assign X = 1\n  end\n`);
  const base = writeJob(t, { ops: [{ op: 'logic', data: { flow: [texts[0], { text: texts[1], basedOn: 'abcdefabcdef0123' }, texts[2]] } }] });
  const edit = n => ({ element: n, edits: [{ find: 'assign X = 1', with: `assign X = ${n}` }] });
  const model = n => Array.from({ length: n }, () => ({ op: 'test', path: '/ops/0/op', value: 'logic' }));
  // The limit is PATCH_MAX_OPS (job-patch.mjs). 3 texts + (PATCH_MAX_OPS - 3): one replace per text.
  const fits = corrected(base, { ...edit('A'), also: [edit('B'), edit('C')], patch: model(PATCH_MAX_OPS - 3) });
  assert.deepEqual(fits.input.patch.slice(0, 3).map(p => p.path), ['/ops/0/data/flow/0', '/ops/0/data/flow/1/text', '/ops/0/data/flow/2']);
  // 3 texts + (PATCH_MAX_OPS - 2) = one past the limit: the list is one replace (1 + PATCH_MAX_OPS - 2), with every other
  // field of its items kept.
  const joined = corrected(base, { ...edit('A'), also: [edit('B'), edit('C')], patch: model(PATCH_MAX_OPS - 2) });
  assert.equal(joined.input.patch.length, PATCH_MAX_OPS - 1);
  assert.deepEqual(joined.input.patch[0], { op: 'replace', path: '/ops/0/data/flow', value: [texts[0].replace('X = 1', 'X = A'), { text: texts[1].replace('X = 1', 'X = B'), basedOn: 'abcdefabcdef0123' }, texts[2].replace('X = 1', 'X = C')] });
  assert.deepEqual(joined.job.ops[0].data.flow, joined.input.patch[0].value);
  const over = jobTextEdits(write(base, { ...edit('A'), also: [edit('B'), edit('C')], patch: model(PATCH_MAX_OPS) }));
  assert.ok(over.problems[0].error.includes(`needs 1 replace(s), the texts of each list joined, + ${PATCH_MAX_OPS} operation(s) of patch = ${PATCH_MAX_OPS + 1}`), over.problems[0].error);
});

test('edits without effect are accepted (R5): the patch only tests the text, and resolvePatchedJob writes the corrected job', t => {
  const base = writeJob(t);
  const same = corrected(base, { element: 'Login', edits: [{ find: 'Entrar', with: 'Entrar' }] });
  assert.deepEqual(same.input.patch, [{ op: 'test', path: '/ops/3/data/html', value: LOGIN }]);
  assert.deepEqual(same.job, base.value);
  // The patch route of today: sha256 checked again, the whole corrected job in a NEW file, normalized as every patched job.
  const r = jobTextEdits(write(base, { element: 'Login.DoLogin', edits: [{ find: 'assign X = 1', with: 'assign X = 2' }] }));
  const inlineDir = path.join(path.dirname(base.file), 'inline');
  const resolved = resolvePatchedJob({ patch: r.input.patch, basedOn: r.input.basedOn }, { inlineDir });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const next = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
  assert.equal(next.ops[5].data.flow[0], DO_LOGIN.replace('X = 1', 'X = 2'));
  assert.equal(next.ops[3].data.html, LOGIN);
  assert.equal(fs.readFileSync(base.file, 'utf8'), JSON.stringify(base.value, null, 2), 'the base is never rewritten');
});
