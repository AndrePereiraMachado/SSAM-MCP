// A publication that meets a Studio dialog (a conflicting version, an error report): o11_publish answers in seconds with
// the dialog and its exact question, never closes it by itself, and closing an error report waits for the person's words.
// Synthetic values only; fake bridges, temporary folders.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createO11Publish, publishOutcome } from '../o11-publish.mjs';
import { o11Bridge, flightOf, BridgeError } from '../o11-bridge.mjs';
import { withStudioWriteLock } from '../studio-write-lock.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';
import { WORDS_MARKER } from '../next-steps.mjs';

const WORDS = 'sim, pode publicar o SynthModule';
const ok = data => ({ success: true, data, error: null });
const fail = error => ({ success: false, data: null, error });
const ACTIVE = { name: 'SynthModule', key: 'k-synth', kind: 'Web', environment: 'dev.example.com', isModified: false, pendingDialogs: [] };
const CONFLICT = { title: 'Conflicting version found', type: 'DialogWindow', isVisible: true, isModal: true,
  texts: ['A newer version of SynthModule was published by another developer.', '[Button] Merge', '[Button] Cancel'] };
const REPORT = { title: 'Unexpected Error', type: 'DialogWindow', isVisible: true, isModal: false, texts: ['[Button] OK'] };

function folders(t, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-publish-dialog-' + tag + '-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = { pid: process.pid, port: 42000 + Math.floor(Math.random() * 999) };
  return { root, record, lock: { o11Root: root, o11Lane: 'ss4', connection: () => record, queueMs: 4000 } };
}

// A Studio whose publish never answers: from the publish on, windows shows `dialog`.
async function studio(t, dialog, { before = false } = {}) {
  let shown = before;
  const fake = await fakeBridge(async request => {
    switch (request.method) {
      case 'ping': return ok({ pid: process.pid });
      case 'bridge_manifest': return ok({ capabilities: [] });
      case 'windows': return ok({ windows: shown ? [dialog] : [] });
      case 'open_module': return ok({ name: request.params.name, opened: true, alreadyOpen: true, selected: true, elapsedMs: 1 });
      case 'get_active_module': return ok(ACTIVE);
      case 'list_open_modules': return ok({ modules: [{ ...ACTIVE, hasESpace: true }] });
      case 'get_errors': return ok({ isValid: true, errors: 0, warnings: 0, messages: [], rawMessages: [] });
      case 'publish': shown = true; return undefined; // the Studio shows the dialog and the publication waits for it
      default: return fail('Unknown method: ' + request.method);
    }
  });
  t.after(() => fake.close());
  return fake;
}

function publisher({ root, record }, fake) {
  const real = o11Bridge({ port: fake.port, pid: process.pid, flight: flightOf({ lane: 'ss4', root, record }) });
  // The product watches every 2 s and abandons after 8 reads of a dialog (16 s); the test watches every 20 ms.
  const bridge = { ...real, ok: (method, params, options) => real.ok(method, params, method === 'publish' ? { ...options, probeMs: 20, probeTimeoutMs: 200, timeoutMs: 20000 } : options) };
  return createO11Publish({ root, env: { ANVIL_WORKER: '0', ANVIL_LANE: 'ss4' }, lane: 'ss4', bridge, assertSelected: async () => {},
    tasksDir: path.join(root, '.local', 'tasks'), journal: () => {}, grants: { wordsFor: ({ authorize }) => ({ words: authorize, authorization: null }) },
    compilerErrorOf: async () => ({ unavailable: 'not in this test' }) });
}

test('a dialog in the middle of the publication: the answer comes in seconds with the dialog and its exact question', async t => {
  const box = folders(t, 'mid');
  const fake = await studio(t, CONFLICT);
  const publish = publisher(box, fake);
  const started = Date.now();
  const value = await withStudioWriteLock({ tool: 'o11_publish', args: { module: 'SynthModule' }, lane: 'ss4', deps: box.lock },
    () => publish({ module: 'SynthModule', authorize: WORDS }));
  assert.ok(Date.now() - started < 10000, 'answered in ' + (Date.now() - started) + ' ms, never the 240 s of the queue');
  assert.equal(value.ok, false); assert.equal(value.code, 'PUBLISH_UNCERTAIN'); assert.equal(value.outcome, 'uncertain');
  assert.match(value.error, /was sent and then stopped by the dialog "Conflicting version found"; it may still finish/);
  assert.equal(value.stalled.verdict, 'dialog');
  assert.deepEqual(value.blockedBy, [{ kind: 'MessageBox', title: 'Conflicting version found', type: 'DialogWindow', buttons: ['Merge', 'Cancel'] }]);
  assert.equal(value.question, 'Conflicting version found | A newer version of SynthModule was published by another developer. | [Button] Merge | [Button] Cancel');
  // A question for the person: SSAM waits for the answer in the Studio, never closes it.
  assert.deepEqual(value.continuation.arguments, { command: 'wait', args: { condition: 'no-dialogs' } });
  assert.equal(value.continuation.question, value.question);
  assert.ok(!value.recovery.some(s => s.arguments?.command === 'dismiss-dialog'), 'no dismiss of a question');
  assert.equal(fake.seen.filter(r => r.method === 'publish').length, 1, 'published once, never repeated');
});

test('an error report met by the publication: closing it takes the person\'s words (the marker in args.words, the question)', async t => {
  const box = folders(t, 'report');
  const fake = await studio(t, REPORT);
  const value = await withStudioWriteLock({ tool: 'o11_publish', args: { module: 'SynthModule' }, lane: 'ss4', deps: box.lock },
    () => publisher(box, fake)({ module: 'SynthModule', authorize: WORDS }));
  assert.equal(value.code, 'PUBLISH_UNCERTAIN');
  assert.equal(value.blockedBy[0].kind, 'UnexpectedError');
  const dismiss = value.recovery.find(s => s.arguments?.command === 'dismiss-dialog');
  assert.deepEqual(dismiss.arguments, { command: 'dismiss-dialog', args: { title: 'Unexpected Error', words: WORDS_MARKER } });
  assert.equal(dismiss.requiresUserWords, undefined, 'the marker of the words, never a loose flag');
  assert.equal(dismiss.question, value.question);
  assert.match(dismiss.why, /^Only with the person's own words/);
  assert.equal(value.continuation, value.recovery[0]);
});

test('an error report open before the publication: nothing is sent, and the same rule for closing it', async t => {
  const box = folders(t, 'before');
  const fake = await studio(t, REPORT, { before: true });
  const value = await withStudioWriteLock({ tool: 'o11_publish', args: { module: 'SynthModule' }, lane: 'ss4', deps: box.lock },
    () => publisher(box, fake)({ module: 'SynthModule', authorize: WORDS }));
  // The tab read already sees it as a pending dialog of the Studio, or the bridge's pre-probe refuses: nothing is published.
  assert.equal(value.ok, false);
  assert.equal(fake.seen.filter(r => r.method === 'publish').length, 0);
  const refused = publishOutcome({ error: new BridgeError('The Studio error report "Unexpected Error" is open; nothing was sent.', { code: 'STUDIO_ERROR_DIALOG_OPEN', executed: false,
    reply: { success: false, executed: false, code: 'STUDIO_ERROR_DIALOG_OPEN', data: { stall: { verdict: 'dialog-before', blockedBy: { title: 'Unexpected Error', type: 'DialogWindow', kind: 'UnexpectedError' } } } },
    stall: { verdict: 'dialog-before', blockedBy: { title: 'Unexpected Error', type: 'DialogWindow', kind: 'UnexpectedError' } } }) }, { name: 'SynthModule' });
  assert.equal(refused.code, 'STUDIO_ERROR_DIALOG_OPEN'); assert.equal(refused.outcome, 'not-sent');
  assert.match(refused.error, /was not sent: the dialog "Unexpected Error" is open/);
  assert.equal(refused.continuation.arguments.args.words, WORDS_MARKER);
});

