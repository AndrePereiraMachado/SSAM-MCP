import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitAnswer, fitFinal, finalFitOptions, oneLine } from '../answer-size.mjs';
import { exposedValue, exposedResult, presentedDocument } from '../exposure.mjs';
import { presenter } from '../hosted/policy.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { fileOrigin, answerFolders } from '../reference-files.mjs';
const bytes = v => Buffer.byteLength(JSON.stringify(v));
const rootOf = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round5-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const oldPosix = /(?<![\w.:/~-])\/(?:studio|opt|srv|var|home|root|usr|etc|mnt|app|workspace|customers|tmp|data\/(?:server|cache|friction|odc-features))(?=$|[\\/\s"'`<>|,;:)\]]|\.(?:\s|$))(?:\/[^\s"'`<>|,;)\]]*(?<!\.))?/g;
const stringsOf = function* (value) { if (typeof value === 'string') yield value; else if (value && typeof value === 'object') for (const child of Object.values(value)) yield* stringsOf(child); };
const transcript = () => process.env.SSAM_ANSWER_TRANSCRIPT ? JSON.parse(fs.readFileSync(process.env.SSAM_ANSWER_TRANSCRIPT, 'utf8')) : [];

test('round 5.1: POSIX paths preserve dotted segments and stop before surrounding prose', async t => {
  const { POSIX_PATH } = await import('../exposure.mjs');
  const cases = [
    ['/studio/o11/11.55.92/ServiceStudio.Framework.dll', '<server>'],
    ['/opt/ssam/v1.7.30/agent.js', '<server>'],
    ['/app/builder/net10.0/ODC3.Builder.dll', '<server>'],
    ['/data/server/answers/abc.json.origin', '<server>'],
    ['/workspace/app failed because the module Customer is missing', '<server> failed because the module Customer is missing'],
    ['The folder /data/server/o11/jobs does not exist; create it first', 'The folder <server> does not exist; create it first'],
    // Round 6 decision: only a paired quote includes spaces in the path.
    ['/data/server/My App.oml was published by Ana at 10:00', '<server> App.oml was published by Ana at 10:00'],
    ['/data/server/My Archive.7z is ready', '<server> Archive.7z is ready'],
    ['/opt/ssam/bin/anvil crashed after reading build 2.5 of the module', '<server> crashed after reading build 2.5 of the module'],
    ['/tmp/build done. Next step: publish the app', '<server> done. Next step: publish the app'],
    ['/data/server/jobs missing; read an example.json', '<server> missing; read an example.json'],
    ['/data/server/jobs missing, read an example.json', '<server> missing, read an example.json'],
    ['/data/server/jobs missing: read an example.json', '<server> missing: read an example.json'],
    ['/data/server/a.json.', '<server>.'],
    ['/data/server/a.json...', '<server>.'],
    ['"/data/server/My App folder" failed', '"<server>" failed'],
    ["'/data/server/My App.oml' failed", "'<server>' failed"],
  ];
  for (const [input, expected] of cases) {
    const actual = exposedValue({ message: input }, { exposure: 'licensee', tool: 'o11_deliver' }).message;
    assert.equal(actual, expected, input);
  }
  for (const input of ['C:\\Program Files\\Server\\kernel\\anvil.dll failed', '\\\\fileserver\\share\\Server Folder\\kernel\\anvil.dll failed']) {
    assert.equal(exposedValue({ message: input }, { exposure: 'licensee', tool: 'o11_deliver' }).message, '<server> failed');
  }
  assert.ok(POSIX_PATH instanceof RegExp, 'the shared POSIX definition is exported');
  let answers = 0, strings = 0;
  for (const call of transcript()) {
    let value; try { value = JSON.parse(call.text); } catch { continue; }
    if (!value || typeof value !== 'object' || !/__ssam_|__o11_|__studio_|__odc_/.test(call.name)) continue;
    answers++;
    for (const text of stringsOf(value)) { assert.equal(text.replace(POSIX_PATH, '<server>'), text.replace(oldPosix, '<server>'), `changed corpus string ${strings}`); strings++; }
  }
  if (process.env.SSAM_ANSWER_TRANSCRIPT) { assert.equal(answers, 575); assert.ok(strings > 1000); t.diagnostic(`${answers} answers, ${strings} strings preserve the earlier path rule`); }
});

test('round 5.2: JSON pointers and DDL comments do not consume the rest of a compact line', t => {
  const texts = [
    'The value of /actions/A12 cannot be assigned because the input expects Integer and receives Text; fix the binding of the parameter in the action flow before delivering again and check the other usages',
    'Problem at /ops/3/data/flow line 4: the statement is not valid. Use the grammar of the logic text, then send the same write again with the corrected text and the same words',
    'Screen /screens/Home uses widget Container1 without a class; the CSS rule is missing in the theme and the build would render it without style unless the rule is added',
    '/// Documentation of the Customer structure.\nentity Customer { name: Text; description: Text; }\n' + 'The remaining contract must still be visible. '.repeat(8),
  ];
  for (const text of texts) for (const max of [100, 160, 240]) {
    const line = oneLine(text, max); assert.ok(line.length >= Math.min(max, 90), line); assert.ok(line.length <= max); assert.match(line, /assigned|statement|widget|contract/);
  }
  const url = 'https://example.test/a/long/source?name=value';
  for (const quote of ['', '"', "'"]) for (let max = 30; max <= 140; max++) {
    const line = oneLine('Follow ' + quote + url + quote + ' for the complete source and its current parameters.', max);
    assert.ok(!line.includes('example.test') || line.includes(url), line);
  }
  let checked = 0;
  const visit = (value, key) => {
    if (typeof value === 'string' && ['message', 'error', 'detail', 'fix', 'text'].includes(key) && value.length > 160 && /\/\/\/|\/(?:actions|ops|screens)\//.test(value)) { assert.ok(oneLine(value, 160).length >= 60, value.slice(0, 100)); checked++; }
    else if (value && typeof value === 'object') for (const [k, child] of Object.entries(value)) visit(child, k);
  };
  for (const call of transcript()) { try { visit(JSON.parse(call.text)); } catch (error) { if (error instanceof assert.AssertionError) throw error; } }
  if (process.env.SSAM_ANSWER_TRANSCRIPT) { assert.ok(checked > 0); t.diagnostic(`${checked} long pointer messages remain useful`); }
});

test('round 5.3: production-order fake gate fits the exposed value and preserves Studio fields', async t => {
  const workspace = rootOf(t), tool = 'o11_deliver', args = {}, servedOrigin = { tool, kind: 'check-delivery' };
  const fitOptions = finalFitOptions({ workspace, tool, args, origin: servedOrigin });
  const fields = { studioWarning: { code: 'studioBuildDiffers', message: 'w'.repeat(800) }, studioWarnings: [{ message: 'x'.repeat(800) }] };
  const raw = { ok: false, error: 'The delivery requires correction.', problems: Array.from({ length: 80 }, (_, i) => ({ code: 'TYPE', pointer: `/ops/${i}`, message: 'Inspect /studio/o11/11.55.92/ServiceStudio.Framework.dll before retrying. Anvil.Core.Kernel.Verbs ' + 'Correct the input binding. '.repeat(8) })) };
  const handler = async () => { const value = fitAnswer(tool, args, raw, fitOptions); return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }; };
  const withStudioFields = answer => {
    const original = answer.structuredContent;
    const structuredContent = fitFinal(original, fields, fitOptions);
    return { ...answer, structuredContent, content: answer.content.map(item => item.type === 'text' && item.text === JSON.stringify(original) ? { ...item, text: JSON.stringify(structuredContent) } : item) };
  };
  const present = presenter({ workspace, serverRoots: [] });
  const out = present.result(withStudioFields(exposedResult(await handler(), { exposure: 'licensee', tool, args, origin: servedOrigin, handleRoots: [workspace] })));
  const value = out.structuredContent;
  assert.equal(out.content[0].text, JSON.stringify(value)); assert.ok(bytes(value) <= 9216);
  for (const key of Object.keys(fields)) assert.equal(JSON.stringify(value[key]), JSON.stringify(fields[key]));
  const noInternals = value => assert.doesNotMatch(JSON.stringify(value), /Anvil\.Core|ServiceStudio\.Framework|11\.55\.92/);
  noInternals(out);
  const reader = createEvidenceReader({ roots: [workspace], present: { originOf: file => fileOrigin(file, { answers: answerFolders({ directory: fitOptions.directory }) }), apply: (doc, origin) => presentedDocument(doc, { exposure: 'licensee', origin, handleRoots: [workspace] }) } });
  const calls = [value.omitted, ...(value.omitted?.more ?? [])].filter(Boolean); assert.ok(calls.length > 0);
  for (const call of calls) {
    let read = { ...call.arguments, file: call.arguments.file.replace(/^ws:/, workspace.replace(/\\/g, '/') + '/') };
    for (;;) { const page = reader.read(read); assert.equal(page.ok, true); noInternals(page); if (page.next === undefined) break; read = { ...read, offset: page.next }; }
  }
});

test('round 5.4: a repeated first error line becomes a summary while its complete detail stays readable', t => {
  const root = rootOf(t), message = 'The input expects Integer and receives Text.', error = message + '\n' + 'Unique detail in the remaining error.\n'.repeat(500);
  const out = fitAnswer('o11_deliver', {}, { ok: false, error, problems: [{ code: 'TYPE', message, count: 2 }] }, { root });
  assert.equal(out.error, '2 problems: TYPE x2'); assert.equal(out.problems[0].message, message); assert.equal(out.errorDetail.omitted, true);
  const reader = createEvidenceReader({ roots: [root] }); let read = out.errorDetail.read.arguments, text = '';
  for (;;) { const page = reader.read(read); assert.equal(page.ok, true); text += page.value; if (page.next === undefined) break; read = { ...read, offset: page.next }; }
  assert.equal(text, error);
});
