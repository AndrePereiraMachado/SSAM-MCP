import './fixtures/isolated-profile.mjs';
// marco-a6 (integration of CX13, X3 and the html edit names onto marco-a5): the answers these fronts add reach a licensee
// with nothing internal, and with what using SSAM needs.
// - X3: every certainty reason the kernel serves (patchesApplied[].reason, the normalization of a repair, patchChoice of a
//   choice) and a TEXT_LITERAL_CHOICE refusal. Review x3-4, I1: the reason of BUILTIN_FUNCTION_RENAMED named the kernel class
//   FunctionCatalog.Renames, which the licensee filter does not remove; the reasons are read from the kernel source here, so a
//   new reason that names a kernel type with a member fails this test.
// - html edit names: HTML_BASE_CHANGED (an older reading never replaces the screen) and HTML_NAME_TAKEN (a moved name).
// - CX13: the overwrite preview of a file load, its confirmation with a row the kernel refuses, the close preview and the
//   close, through the hub (o11_data) with a kernel whose refusal text names its classes, files and server folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exposedResult } from '../exposure.mjs';
import { findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const roots = ['C:\\srv\\ssam\\kernel\\.local'];
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const licensee = (tool, value, args = {}) => exposedResult(result(value), { exposure: 'licensee', handleRoots: roots, tool, args }).structuredContent;
const shown = list => list.map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 120));

// The kernel's own types, from its source: a served text that names one with a member (FunctionCatalog.Renames,
// JobRunner.Run) tells how SSAM is built.
const kernelTypes = (() => {
  const names = new Set();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['bin', 'obj'].includes(entry.name)) walk(full); continue; }
      if (!entry.name.endsWith('.cs')) continue;
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/\b(?:class|record|struct|interface|enum)\s+([A-Z][A-Za-z0-9]+)/g))
        if (/[a-z]/.test(m[1]) && /^[A-Z][a-z0-9]+[A-Z]/.test(m[1])) names.add(m[1]);
    }
  };
  walk(path.join(kernel, 'src'));
  return names;
})();
function typeMembers(value, at = '') {
  if (typeof value === 'string') return [...value.matchAll(/\b([A-Z][A-Za-z0-9]+)\.([A-Z][A-Za-z0-9]*)\b/g)].filter(m => kernelTypes.has(m[1])).map(m => at + ': ' + m[0]);
  if (Array.isArray(value)) return value.flatMap((v, i) => typeMembers(v, at + '/' + i));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => typeMembers(v, at + '/' + k));
  return [];
}
const clean = (label, value) => {
  assert.deepEqual(shown(findings(value)), [], label);
  assert.deepEqual(typeMembers(value), [], label);
};
// The corrected job of an applied repair is a handle under the server's .local, as nextBasedOn.job: the next call takes it
// back. Checked as such, then left out of the scan; patchedJob is out of a licensee's answer (review marco-a6 B1).
const isHandle = text => typeof text === 'string' && text.toLowerCase().startsWith(path.win32.join(roots[0], 'jobs').toLowerCase() + '\\');
const withoutHandles = value => {
  const { patchedJob, nextBasedOn, job, ...rest } = value;
  for (const p of [nextBasedOn?.job, job].filter(Boolean)) assert.ok(isHandle(p), 'a handle under .local/jobs: ' + p);
  // the corrected job goes on through nextBasedOn: patchedJob leaves a licensee's answer whole (review marco-a6 B1)
  assert.equal(patchedJob, undefined);
  return rest;
};

// ---- X3: the certainty reasons, as the kernel writes them (PatchCertainty.Rules and UnknownReason)
const certaintySource = fs.readFileSync(path.join(kernel, 'src', 'Anvil.Core', 'Kernel', 'Preflight', 'PatchCertainty.cs'), 'utf8');
const unescape = text => JSON.parse('"' + text + '"');
const RULES = [...certaintySource.matchAll(/\["([A-Z_]+)"\] = new\((true|false), "((?:[^"\\]|\\.)*)"\)/g)].map(m => ({ rule: m[1], certain: m[2] === 'true', reason: unescape(m[3]) }));
const UNKNOWN = unescape(/UnknownReason = "((?:[^"\\]|\\.)*)"/.exec(certaintySource)?.[1] ?? '');

test('the kernel types are read and the scan catches a type with a member (the old reason of review x3-4, I1)', () => {
  assert.ok(kernelTypes.size > 200, 'kernel types read: ' + kernelTypes.size);
  for (const name of ['FunctionCatalog', 'JobRunner', 'ScreenHtml', 'HtmlExpander']) assert.ok(kernelTypes.has(name), name);
  assert.ok(RULES.length >= 12 && UNKNOWN, 'certainty rules read: ' + RULES.length);
  const old = 'The explicit FunctionCatalog.Renames entry preserves declared arguments; no action in scope has the written name.';
  assert.deepEqual(typeMembers({ reason: licensee('ssam_job', { reason: old }).reason }), ['/reason: FunctionCatalog.Renames'], 'the filter keeps it: the kernel text is what must not say it');
  assert.deepEqual(typeMembers({ value: 'GetCards.List.Current.Card.Title and Customer.Name' }), [], 'an expression of the module is no kernel type');
});

test('X3: every certainty reason reaches a licensee without internals, in patchesApplied, the normalization and patchChoice', () => {
  const certain = RULES.filter(r => r.certain), choices = RULES.filter(r => !r.certain);
  assert.ok(certain.length >= 3 && choices.length >= 5);
  const accepted = { ok: true, lane: 'o11', job: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\inline\\a1.json', accepted: true,
    patchesApplied: certain.map((r, i) => ({ code: 'HTML_INVALID', pointer: '/ops/' + i + '/data/html', phase: 'apply', patchRule: r.rule, reason: r.reason,
      from: '<input placeholder="Buscar por nome"/>', to: '<input placeholder="{{ "Buscar por nome" }}"/>', patchSha256: 'a'.repeat(64) })),
    normalizations: { items: certain.map(r => ({ rule: r.rule, patchApplied: true, path: '/ops/0/data/html', reason: r.reason })) },
    patchedJob: { path: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\inline\\a1.json.patched-job.json', sha256: 'b'.repeat(64) },
    nextBasedOn: { job: 'C:\\srv\\ssam\\kernel\\.local\\jobs\\inline\\a1.json.patched-job.json', sha256: 'b'.repeat(64) } };
  const outA = licensee('ssam_job', accepted, { lane: 'o11', job: {} });
  clean('accepted', withoutHandles(outA));
  assert.deepEqual(outA.patchesApplied.map(p => p.reason), certain.map(r => r.reason), 'each reason served whole');
  const refused = { ok: false, lane: 'odc', code: 'PREFLIGHT_REFUSED', error: 'the job has ' + (choices.length + 1) + ' problems; nothing was saved',
    problems: [...choices, { rule: 'NO_SUCH_RULE', reason: UNKNOWN }].map((r, i) => ({ phase: 'apply', code: 'HTML_INVALID', severity: 'error', pointer: '/ops/' + i + '/data/html',
      message: 'line 1 col 30: the text "Hunt obrigatorio" is no expression', fix: 'quote the text, or write the name the page declares',
      patch: [{ op: 'replace', path: '/ops/' + i + '/data/html', value: '<input placeholder="{{ &quot;Hunt obrigatorio&quot; }}"/>' }], patchRule: r.rule, patchCertain: false, patchChoice: r.reason })) };
  const outR = licensee('ssam_job', refused, { lane: 'odc', job: {} });
  clean('refused', outR);
  assert.deepEqual(outR.problems.map(p => p.patchChoice), [...choices.map(r => r.reason), UNKNOWN]);
  assert.ok(outR.problems.every(p => p.patch?.length === 1 && p.fix && p.patchCertain === false));
});

test('X3: a TEXT_LITERAL_CHOICE refusal of a delivery keeps its choice, fix, patch and next step for a licensee', () => {
  const choice = RULES.find(r => r.rule === 'TEXT_LITERAL_CHOICE');
  assert.ok(choice);
  const job = 'C:\\srv\\ssam\\kernel\\.local\\jobs\\inline\\d7.json';
  const answer = { ok: false, outcome: 'refused', code: 'KERNEL_REFUSED', module: 'Orders',
    error: 'line 1 col 41: "Hunt obrigatorio" is no expression of the screen (at Anvil.Core.Kernel.ScreenDocument.Compile in C:\\srv\\ssam\\kernel\\src\\Anvil.Core\\Kernel\\Verbs.ScreenDocument.cs:line 801)',
    problems: [{ phase: 'apply', code: 'HTML_INVALID', severity: 'error', pointer: '/ops/1/data/html', message: 'line 1 col 41: "Hunt obrigatorio" is no expression of the screen',
      fix: 'a text: quote it ({{ "Hunt obrigatorio" }}); a name: write the one the page declares (Hint)', patch: [{ op: 'replace', path: '/ops/1/data/html', value: '<screen name="Orders">...</screen>' }],
      patchRule: choice.rule, patchCertain: false, patchChoice: choice.reason }],
    nextBasedOn: { job, sha256: 'c'.repeat(64) },
    continuation: { tool: 'o11_deliver', arguments: { module: 'Orders', patch: 'verified', basedOn: { job, sha256: 'c'.repeat(64) }, authorize: '<the user\'s words>' },
      why: 'Apply the patch the owner chooses, over the job above.' } };
  const out = licensee('o11_deliver', answer, { module: 'Orders', job: {} });
  clean('o11_deliver literal choice', out);
  const [p] = out.problems;
  assert.equal(p.patchRule, 'TEXT_LITERAL_CHOICE'); assert.equal(p.patchCertain, false); assert.equal(p.patchChoice, choice.reason);
  assert.deepEqual(p.patch, answer.problems[0].patch); assert.equal(p.fix, answer.problems[0].fix);
  assert.deepEqual(out.continuation.arguments, answer.continuation.arguments);
  assert.doesNotMatch(out.error, /Anvil\.|\.cs\b|C:\\srv/);
});

// ---- the html edit names: HTML_BASE_CHANGED and HTML_NAME_TAKEN, with the texts the kernel writes
const screenText = '<screen name="Audit" k="w1">\n<div class="banner" k="w5">Novos pedidos</div>\n<table k="w9"><thead><tr><th>Data</th></tr></thead></table>\n</screen>';
test('html edit: HTML_BASE_CHANGED keeps the current text, the next basedOn and the patch; its prose loses the server path', () => {
  const capture = 'C:\\srv\\ssam\\kernel\\.local\\captures\\audit-7.oml';
  const reading = 'd'.repeat(64);
  for (const sameJob of [false, true]) {
    const problem = { phase: 'apply', code: 'HTML_BASE_CHANGED', severity: 'error', pointer: '/basedOn',
      message: `Audit is not the reading 0123456789ab the element edits (the document they make on it) were written on (${sameJob ? 'an earlier op of this job changed it' : 'it changed since'}; now ${reading.slice(0, 12)}), and <thead> at line 3 has no k and is no part the merge matches by its owner in the reading the edit was written on: the element edits (the document they make on it) would write that reading back over what changed, so nothing is written`,
      fix: sameJob ? 'when an earlier html op of this job changed Audit, make this change in that op (one html op per screen and job); else send in \'edit\' only the elements it changes, each whole with its k: each replaces the element with its ObjectKey and the rest of the screen stays as the earlier ops left it'
        : `write the edit again on the current text (current.text, basedOn {"capture": "${capture.replace(/\\/g, '\\\\')}", "html": "${reading}"}), or send in 'edit' only the elements it changes, each whole with its k: each replaces the element with its ObjectKey (a change made inside it since is the edit's) and the rest of the screen stays; the patch writes the same edits on the current text (each address the element with its ObjectKey now), checked to plan clean`,
      patch: [{ op: 'replace', path: '/basedOn', value: { capture, html: reading } }, { op: 'replace', path: '/edits', value: [{ set: 'w5', attributes: { class: 'banner wide' } }] }],
      current: { html: reading, text: screenText, elements: [{ address: 'w5', edit: 0, k: 'w5', text: '<div class="banner" k="w5">Novos pedidos</div>' }] },
      next: { basedOn: { capture, html: reading } } };
    const answer = { ok: false, outcome: 'refused', code: 'HTML_BASE_CHANGED', error: problem.message, problems: [problem] };
    const out = licensee('studio_deliver', answer, { module: 'Audit', job: {} });
    clean('HTML_BASE_CHANGED sameJob=' + sameJob, out);
    const [p] = out.problems;
    assert.equal(p.current.text, screenText, 'the current text is the customer\'s screen, whole');
    assert.deepEqual(p.current.elements, problem.current.elements);
    assert.deepEqual(p.next.basedOn, { capture, html: reading }, 'the next basedOn is a handle the next call takes back');
    assert.deepEqual(p.patch, problem.patch);
    assert.match(p.message, /<thead> at line 3 has no k/);
    assert.doesNotMatch(p.fix, /C:\\\\srv|C:\\srv/, 'the server path in the prose is not served');
  }
});

test('html edit: HTML_NAME_TAKEN says why the name is kept and keeps its checked patch for a licensee', () => {
  const problem = { phase: 'apply', code: 'HTML_NAME_TAKEN', severity: 'error', pointer: '/ops/0/data/edit/1', element: 'w42',
    message: 'id="Div16" is the name k="w5" keeps in Audit: its text writes no id, and an element with k whose text leaves its id out keeps the name it has (id="" clears it)',
    fix: 'to move the name here, write id="" on k="w5" (the patch); to leave it there, give this element another one: id="Div162"',
    patch: [{ op: 'replace', path: '/ops/0/data/edit', value: '<div k="w5" id="">Novos pedidos</div><div k="w42" id="Div16">Total</div>' }] };
  const answer = { ok: false, outcome: 'refused', code: 'KERNEL_REFUSED', error: problem.message, problems: [problem] };
  for (const tool of ['o11_deliver', 'studio_deliver']) {
    const out = licensee(tool, answer, { module: 'Audit', job: {} });
    clean('HTML_NAME_TAKEN ' + tool, out);
    assert.deepEqual(out.problems[0], problem, 'nothing of it is internal: served as the kernel wrote it');
  }
});

// ---- CX13: the overwrite preview and its confirmation, the close preview and the close, through the hub
const INTERNAL = 'Anvil.Core.Kernel.DataWriter rejected the row (C:\\srv\\ssam\\kernel\\.local\\cli\\work\\req-1.json, DataCommands.cs:212)';
function o11Kernel(rows) {
  const db = rows; let nextId = 500;
  const ok = data => ({ ok: true, envelope: { ok: true, command: 'data', data }, wallMs: 1 });
  const runAnvil = async args => {
    const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
    if (args.includes('--schema')) return ok({ ok: true, module: 'SyntheticApp', moduleKey: 'omk-1', entities: [{ name: 'E', key: 'oek-E', static: false, identifier: 'Id', indexes: [],
      attributes: [{ name: 'Id', type: 'E Identifier', autoNumber: true }, { name: 'Code', type: 'Text' }, { name: 'Qty', type: 'Integer' }] }] });
    const request = JSON.parse(fs.readFileSync(opt('--request'), 'utf8'));
    if (args.includes('--check')) return ok({ ok: true });
    const results = [];
    for (const op of request.batch ?? [request]) {
      if (op.operation === 'read-all') { results.push({ ok: true, records: db.slice(op.offset ?? 0, (op.offset ?? 0) + (op.limit ?? 10000)).map(r => ({ ...r })), complete: true }); continue; }
      const reports = op.records.map(record => {
        if (record.Code === 'BAD') return { status: 'Failed', error: INTERNAL };
        const values = Object.fromEntries(Object.entries(record).map(([k, v]) => [k, v == null ? null : String(v)]));
        if (op.operation === 'update') { const row = db.find(r => r.Id === String(record.Id)); Object.assign(row, values); return { status: 'Success', recordId: String(record.Id) }; }
        const Id = String(nextId++); db.push({ ...values, Id }); return { status: 'Success', recordId: Id };
      });
      const failed = reports.filter(r => r.status !== 'Success');
      results.push(failed.length ? { ok: false, code: 'DATA_WRITE_FAILED', error: `${failed.length} of ${reports.length} records failed (${failed[0].error})`, reports } : { ok: true, ids: reports.map(r => r.recordId) });
      if (failed.length) break;
    }
    return ok({ ok: true, host: 'synthetic.test', module: 'SyntheticApp', results });
  };
  return runAnvil;
}

test('CX13: the overwrite preview, its confirmation, the close preview and the close reach a licensee with nothing internal', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-cx13-'));
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const clock = { at: Date.parse('2026-10-19T12:00:00Z') };
  const server = await createSsamServer({ odc: false, deps: { dataRoot: root, answersRoot: root, tasksDir: path.join(root, '.local', 'tasks'),
    runAnvil: o11Kernel([{ Id: '7', Code: 'A', Qty: '1' }]), dataNow: () => clock.at, exposure: { profile: 'licensee', caller: () => 'licensee-marco-a6' } } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'no-internals-cx13', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const W = 'carregar os pedidos sinteticos do licenciado', C1 = 'pode atualizar 1 linha do licenciado';
  const file = path.join(root, 'orders.csv'); fs.writeFileSync(file, 'Code,Qty\nA,100\nB,2\nBAD,3\n');
  const base = { host: 'synthetic.test', module: 'SyntheticApp', oml: path.join(root, 'x.oml') }; fs.writeFileSync(base.oml, 'synthetic');
  const req = { operation: 'insert', entity: 'E', files: [file], keys: ['Code'], operationId: 'b7400000-0000-4000-8000-0000000000a6', batchSize: 1 };
  const call = async request => { const r = await client.callTool({ name: 'o11_data', arguments: { ...base, request } }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const check = (label, value) => {
    const text = JSON.stringify(value);
    assert.doesNotMatch(text, /Anvil\.|DataCommands|\.cs\b|C:\\\\srv/, label + ': ' + text.slice(0, 400));
    assert.ok(![W, C1].some(w => text.includes(w)), label + ': the owner\'s words are never served back');
    // only the caller's own file, the server's handles under its root, and the receipts SSAM keeps for him are paths
    const rest = findings(value).filter(f => !(f.family === 'absolute path' && f.sample.includes(root.slice(0, 20))));
    assert.deepEqual(shown(rest), [], label);
    assert.deepEqual(typeMembers(value), [], label);
  };
  const s1 = await call({ ...req, authorization: W });
  assert.equal(s1.code, 'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED', JSON.stringify(s1).slice(0, 400));
  assert.match(s1.updatePreview?.sha256 ?? '', /^[0-9a-f]{64}$/);
  check('update preview', s1);
  clock.at += 6000;
  const s2 = await call({ ...req, confirmUpdates: { previewSha256: s1.updatePreview.sha256, authorize: C1 } });
  assert.equal(s2.code, 'DATA_WRITE_FAILED', JSON.stringify(s2).slice(0, 400));
  check('confirmation with a refused row', s2);
  const s3 = await call({ ...req, close: { preview: true } });
  assert.match(s3.closePreview?.sha256 ?? '', /^[0-9a-f]{64}$/, JSON.stringify(s3).slice(0, 400));
  check('close preview', s3);
  clock.at += 6000;
  const s4 = await call({ ...req, close: { previewSha256: s3.closePreview.sha256, authorize: `fechar mesmo com ${s3.closePreview.count} linha pendente` } });
  assert.equal(s4.state, 'closed', JSON.stringify(s4).slice(0, 400));
  check('closed', s4);
});

// ---- X3: patchedJob (the corrected job and its provenance sidecar) leaves a licensee's answer whole (review marco-a6 B1):
// the corrected job goes on through nextBasedOn, a handle. The sidecar's folder, read by guess, is a handle under a root, and
// <server> outside the roots, by the rule of no-internals-paths.test.mjs.
test('X3: a licensee\'s answer goes on with the corrected job through nextBasedOn, never with its paths or its sidecar\'s folder', () => {
  const corrected = path.win32.join(roots[0], 'jobs', 'a1.oml.patched-job.json');
  const answer = { ok: true, accepted: true, patchedJob: { path: corrected, sha256: 'b'.repeat(64), source: { path: corrected + '.source.json', sha256: 'c'.repeat(64) } },
    nextBasedOn: { job: corrected, sha256: 'b'.repeat(64) } };
  for (const tool of ['ssam_job', 'o11_deliver', 'studio_deliver']) {
    const out = licensee(tool, answer, { job: {} });
    assert.equal(out.patchedJob, undefined, tool + ': patchedJob leaves a licensee\'s answer whole (review marco-a6 B1)');
    assert.deepEqual(out.nextBasedOn, answer.nextBasedOn, tool);
    assert.deepEqual(exposedResult(result(answer), { exposure: 'owner', tool }).structuredContent, answer, 'the owner reads it whole');
  }
  const sidecar = licensee('ssam_evidence', { ok: true, value: { jobSha256: 'b'.repeat(64), sourceDirectory: path.win32.join(roots[0], 'jobs', 'inline') } }, { file: corrected + '.source.json' });
  assert.equal(sidecar.value.jobSha256, 'b'.repeat(64));
  assert.equal(sidecar.value.sourceDirectory, path.win32.join(roots[0], 'jobs', 'inline'), 'a folder under a root is a handle, in any key (review marco-a6 B1)');
  const elsewhere = licensee('ssam_evidence', { ok: true, value: { jobSha256: 'b'.repeat(64), sourceDirectory: 'C:\\srv\\jobs\\acme' } }, { file: corrected + '.source.json' });
  assert.equal(elsewhere.value.sourceDirectory, '<server>', 'the server folder of the sidecar, outside the roots');
});
