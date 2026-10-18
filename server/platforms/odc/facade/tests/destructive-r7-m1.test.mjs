import './fixtures/isolated-profile.mjs';
// CX15 r7 (M-1, the debugger; a regression of r5 that r6 did not close): the DEBUG_APP_USER_SIGN_IN_FAILED continuation of
// ssam_debug_run (debug-run.mjs, repeat(raw)) carries the owner's words; the hub masks them; replayed as it is, the runner
// got the marker as words, and the executors only asked for a nonempty text (the ODC mount ran to the end with the marker,
// OWNER_REPLY, "<the user's own words>", a sha256 or punctuation, and kept the sha256 of THAT text). The op authorize and
// ssam_debug_invoke took them too. Now debugRun, the op authorize, the invoke schema and every executor decide with the one
// predicate (wordsGiven): WORDS_REQUIRED (or the executor's own explicit refusal) before any executor, sign-in or file.
// Fakes only, synthetic values (the review's repro: C:\t\revisoes\cx15-6\review\repros\d1-debugger-marker.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as ops from '../destructive-operations.mjs';
import { debugRun } from '../debug-run.mjs';
import { runOdcNativeMount } from '../debug-odc-native-mount-run.mjs';
import { invokeSchema } from '../debug-invoke.mjs';
import { mountFixture, prepared } from './fixtures/destructive-r7-mount.mjs';

const MARKER = "<the user's own words>"; // English since 16/10; the marker before stays refused (legacyMarker)
const OWNER = 'ZQD1 roda o processo de teste no DEV';
const SERVER_TEXTS = { marker: MARKER, legacyMarker: '<palavras do usuário>', ownerReply: "<the owner's next message after the list, verbatim>", scTemplate: "<the user's own words>", hash: 'sha256:' + 'a'.repeat(64), punctuation: '!!! ... ???' };

test('M-1 (ssam_debug_run): the sign-in failure continuation, masked by the hub and replayed as it is, is WORDS_REQUIRED and the runner is never called; with the owner\'s words it runs', async () => {
  const raw = { op: 'run', lane: 'o11', execution: 'native-entry', host: 'fixture.outsystemscloud.com', module: 'Fixture', moduleKey: 'A'.repeat(22), applicationKey: 'B'.repeat(22),
    runtimeUrl: 'https://fixture.outsystemscloud.com/Fixture/', action: 'LaunchOrder', contextMode: 'native-background', words: OWNER, launch: { inputs: {}, contextMode: 'app-user' } };
  const first = await debugRun(structuredClone(raw), { services: { runO11: async () => { throw new Error('debug_o11_native_login_rejected'); } } });
  const answer = ops.resultWithoutWordEchoes({ content: [{ type: 'text', text: JSON.stringify(first) }], structuredContent: first, isError: true }, { tool: 'ssam_debug_run' }).structuredContent;
  const step = answer.continuation;
  assert.equal(step?.tool, 'ssam_debug_run'); assert.equal(step.arguments.words, MARKER);
  const received = [];
  const runner = async input => { received.push(input); return { ok: true, state: 'answered' }; };
  const replay = await debugRun(structuredClone(step.arguments), { services: { runO11: runner } });
  assert.equal(replay.code, 'WORDS_REQUIRED', JSON.stringify(replay).slice(0, 300));
  assert.equal(received.length, 0, 'the runner was never called');
  for (const [kind, words] of Object.entries(SERVER_TEXTS)) {
    assert.equal((await debugRun({ ...structuredClone(step.arguments), words }, { services: { runO11: runner } })).code, 'WORDS_REQUIRED', kind);
    assert.equal((await debugRun({ ...structuredClone(step.arguments), words: OWNER, roleCycle: { roleKey: '00000000-0000-4000-8000-000000000001', words } }, { services: { runO11: runner } })).code, 'WORDS_REQUIRED', 'roleCycle ' + kind);
  }
  assert.equal(received.length, 0);
  const ran = await debugRun({ ...structuredClone(step.arguments), words: OWNER }, { services: { runO11: runner } });
  assert.notEqual(ran.code, 'WORDS_REQUIRED'); assert.equal(received.length, 1, 'with the owner\'s words the runner runs');
});

test('M-1 (the ODC mount executor): a server text as words is refused before the sign-in and the browser; the owner\'s words mount', async () => {
  for (const [kind, words] of Object.entries(SERVER_TEXTS)) {
    const f = mountFixture();
    let error = null;
    try { await runOdcNativeMount({ op: 'run', lane: 'odc', lifecycle: 'mounted', words }, prepared(), f.readers, f.services); } catch (e) { error = e.message; }
    assert.match(String(error), /explicit_authorization_required/, kind);
    assert.equal(f.calls.includes('sign-in') || f.calls.includes('mount'), false, kind + ': nothing ran');
    assert.equal(fs.readdirSync(f.root, { recursive: true }).map(String).some(p => p.endsWith('authorization.json')), false, kind + ': no authorization file');
    fs.rmSync(f.root, { recursive: true, force: true });
  }
  const f = mountFixture();
  const report = await runOdcNativeMount({ op: 'run', lane: 'odc', lifecycle: 'mounted', words: OWNER }, prepared(), f.readers, f.services);
  assert.ok(f.calls.includes('mount'), 'the owner\'s words mount');
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(report.receiptPath), 'authorization.json'), 'utf8')).wordsSha256.length, 64);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('M-1 (op authorize, ssam_debug_invoke): the standing grant and the invoke authorization take the owner\'s words only', async () => {
  for (const [kind, words] of Object.entries(SERVER_TEXTS)) {
    const granted = await debugRun({ op: 'authorize', tenant: 'fixture.outsystems.dev', words }, {});
    assert.equal(granted.code, 'WORDS_REQUIRED', 'authorize ' + kind);
    const parsed = invokeSchema.safeParse({ op: 'run', planId: '00000000-0000-4000-8000-000000000002', operationId: '00000000-0000-4000-8000-000000000003', authorization: words, sessionId: 'a'.repeat(32) });
    assert.equal(parsed.success, false, 'invoke ' + kind);
    assert.ok(JSON.stringify(parsed.error?.issues ?? []).includes('WORDS_REQUIRED'), 'invoke ' + kind + ' ' + JSON.stringify(parsed.error?.issues ?? []).slice(0, 200));
  }
});
