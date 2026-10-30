import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitAnswer, fitFinal, finalFitOptions, oneLine } from '../answer-size.mjs';
import { exposedValue, exposedResult, presentedDocument } from '../exposure.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { presenter, withStudioFields } from '../hosted/policy.mjs';
import { fileOrigin, answerFolders } from '../reference-files.mjs';
const bytes = v => Buffer.byteLength(JSON.stringify(v));
const rootOf = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round4-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const problem = { code: 'TYPE', pointer: '/ops/0', message: 'The input value is Text but the parameter requires an Integer.' };
const longError = () => 'Validation failed.\n' + 'A unique detail about the current module state.\n'.repeat(500) + problem.message;
const extras = { studioWarning: { code: 'studioBuildDiffers', userMessage: 'w'.repeat(330), error: 'e'.repeat(330) }, studioWarnings: [{ detail: 'x'.repeat(400) }, { detail: 'y'.repeat(400) }] };
const readText = (reader, args) => { let text = ''; for (;;) { const page = reader.read(args); assert.equal(page.ok, true); text += page.value; if (page.next === undefined) return text; args = { ...args, offset: page.next }; } };

test('round 4.1: a long error containing a problem retains all unique text', t => {
  const root = rootOf(t), error = longError();
  const out = fitAnswer('o11_deliver', {}, { ok: false, code: 'TYPE', error, problems: [problem] }, { root });
  assert.equal(out.error, 'Validation failed.'); assert.deepEqual(out.problems, [problem]);
  assert.equal(out.errorDetail.omitted, true); assert.ok(bytes(out) <= 9216);
  assert.equal(readText(createEvidenceReader({ roots: [root] }), out.errorDetail.read.arguments), error);
  const shorter = 'Additional context. '.repeat(20) + problem.message;
  const compact = fitAnswer('o11_deliver', {}, { ok: false, error: shorter, problems: [problem] }, { root });
  assert.equal(compact.error, shorter, 'a contained message does not make unique surrounding text redundant');
});

test('round 4.2: unavailable evidence storage keeps a bounded useful answer with an English note', t => {
  const root = rootOf(t), blocked = path.join(root, 'not-a-directory'); fs.writeFileSync(blocked, 'occupied');
  for (const n of [16, 17, 80]) {
    const problems = Array.from({ length: n }, (_, i) => ({ code: 'P', pointer: `/x/${i}`, message: 'The value needs correction here. '.repeat(14) }));
    const raw = { ok: false, code: 'REFUSED', outcome: 'not-written', verified: false, problems };
    const out = fitFinal(raw, extras, { tool: 'o11_deliver', root, directory: path.join(blocked, 'answers') });
    assert.ok(bytes(out) <= 9216, bytes(out));
    assert.equal(out.ok, false); assert.equal(out.code, raw.code); assert.equal(out.outcome, raw.outcome); assert.equal(out.verified, false);
    assert.deepEqual(out.studioWarning, extras.studioWarning); assert.deepEqual(out.studioWarnings, extras.studioWarnings);
    assert.match(out.storageNote, /remaining content could not be saved/i); assert.doesNotMatch(out.storageNote, /not-a-directory|[\\/]/);
    assert.ok(out.problems.length > 0); assert.deepEqual(out.problems, problems.slice(0, out.problems.length));
    assert.equal(out.problems.length + out.problemsLeft, n); assert.equal(out.omitted, undefined);
  }
});

test('round 4.3: POSIX path tokens preserve quoted names and withhold server segments', () => {
  const p = '/data/server/customers/c7/o11/snapshots/My Sales App.oml';
  for (const quoted of [p, `"${p}"`, `'${p}'`]) for (let max = 60; max <= 240; max += 5) {
    const text = 'The kernel stopped while reading the producer capture and could not continue with the delivery of the module; it looked under ' + quoted + ' and gave up';
    const compact = oneLine(text, max); assert.ok(compact.length <= max);
    // Round 6 decision: an unquoted name after the first space is client text.
    if (quoted !== p) assert.ok(!compact.includes('Sales App') || compact.includes(p), compact);
    const out = exposedValue({ message: compact }, { exposure: 'licensee', tool: 'o11_deliver' });
    assert.doesNotMatch(out.message, quoted === p ? /snapshots|customers/ : /Sales App|snapshots|customers/);
  }
  for (const suffix of ['My Data Folder', 'My Data Folder.oml']) {
    const text = 'The capture could not be read from "' + '/data/server/' + suffix + '".';
    assert.equal(exposedValue({ message: text }, { exposure: 'owner', tool: 'o11_deliver' }).message, text);
    assert.doesNotMatch(exposedValue({ message: oneLine(text, 200) }, { exposure: 'licensee', tool: 'o11_deliver' }).message, /My Data Folder/);
  }
});

test('round 4.4: the 102-read legacy envelope keeps identical marker ordering on every pass', t => {
  // Shape and pointer order of recorded envelope 263; customer identities are replaced.
  const root = rootOf(t), file = 'ws:o11/answers/' + 'a'.repeat(64) + '.json';
  const pointers = ['/ok', '/module', '/key', '/isValid', '/errors', '/warnings', ...Array.from({ length: 94 }, (_, i) => `/messages/${i}`), '/byType', '/lastPublish'];
  const calls = pointers.map(pointer => ({ tool: 'ssam_evidence', arguments: { file, pointer, budgetBytes: 28672 } }));
  const input = { ok: true, module: 'Example_UI', omitted: { ...calls[0], why: 'the part /ok, whole', more: calls.slice(1) } };
  let out = fitAnswer('o11_studio', { command: 'errors' }, input, { root });
  assert.equal(out.omitted.more.length + 1, 102);
  for (let i = 0; i < 3; i++) { const next = fitAnswer('o11_studio', { command: 'errors' }, out, { root }); assert.ok(JSON.stringify(next) === JSON.stringify(out), 'the serialized envelope must stay identical'); out = next; }
});

test('round 4.5: a fake gate fits Studio fields before exposure and presents working evidence', async t => {
  const root = rootOf(t), tool = 'o11_deliver', origin = { tool }, present = presenter({ workspace: root, serverRoots: [] });
  const options = finalFitOptions({ workspace: root, tool, args: {}, origin });
  const raw = { ok: false, code: 'TYPE', error: longError() + ' Anvil.Core.Kernel.Verbs', problems: Array.from({ length: 40 }, (_, i) => ({ ...problem, pointer: `/ops/${i}`, message: problem.message + ' Anvil.Core.Kernel.Verbs' })) };
  const handler = async () => ({ structuredContent: raw, content: [{ type: 'text', text: JSON.stringify(raw) }] });
  const fakeGate = async () => {
    const studio = withStudioFields(await handler(), extras);
    const value = fitFinal(studio.structuredContent, {}, options);
    const fitted = { ...studio, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
    return present.result(exposedResult(fitted, { exposure: 'licensee', tool, origin, handleRoots: [root] }));
  };
  const out = await fakeGate(), value = out.structuredContent;
  assert.equal(out.content[0].text, JSON.stringify(value)); assert.ok(bytes(value) <= 9216); assert.doesNotMatch(JSON.stringify(out), /Anvil\.Core|Kernel\.Verbs/);
  assert.equal(value.studioWarning.code, extras.studioWarning.code); assert.equal(value.errorDetail.omitted, true);
  const reader = createEvidenceReader({ roots: [root], present: { originOf: file => fileOrigin(file, { answers: answerFolders({ directory: options.directory }) }), apply: (doc, origin) => presentedDocument(doc, { exposure: 'licensee', origin, handleRoots: [root] }) } });
  const resolve = args => ({ ...args, file: args.file.replace(/^ws:/, root.replace(/\\/g, '/') + '/') });
  const text = readText(reader, resolve(value.errorDetail.read.arguments)); assert.match(text, /unique detail/); assert.doesNotMatch(text, /Anvil\.Core/);
  for (const call of [value.omitted, ...(value.omitted?.more ?? [])].filter(Boolean)) {
    let args = resolve(call.arguments); for (;;) { const page = reader.read(args); assert.equal(page.ok, true); assert.doesNotMatch(JSON.stringify(page), /Anvil\.Core/); if (page.next === undefined) break; args = { ...args, offset: page.next }; }
  }
});
