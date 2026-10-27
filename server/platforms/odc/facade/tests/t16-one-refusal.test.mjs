// T16 (one refusal carries every problem with a certain patch), the facade's part:
//   - a delivery refused for its words answers with the exact resend (every field of the call as sent, the marker in authorize;
//     the whole answer within the refusal budget, a field too long replaced by a placeholder that says what to put back, and a
//     replay of it as it is refused, never sent incomplete);
//   - the grouping of a refusal keeps two message templates under one code apart and one cause together (the template is read
//     on the uncut message; code fragments, node ids, html tags and element kinds are no cause);
//   - "patch": "verified" applies only certain patches (a choice stays on its problem);
//   - a create collision's conditional problems ride on it through the shaping;
//   - a text cut for the answer never splits a character in two.
// Pure, but for o11_deliver calls over an in-memory MCP server with a fake CLI.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle, wordsResend, RESEND_BUDGET_BYTES, WORDS_REQUIRED_TEXT, WORDS_MARKER } from '../o11-cycle.mjs';
import { fitProblems, templateOf, problemOf, patchUnion, refusalFields } from '../refusal-problems.mjs';
import { clipText } from '../answer-size.mjs';
import { clipText as clip } from '../text-clip.mjs';
import { ANSWER_BUDGETS } from '../context-budget.mjs';
import { wordsGiven } from '../destructive-operations.mjs';

test('a basedOn delivery without words gets the exact resend: every field as sent, the marker in authorize', () => {
  const input = { module: 'Orders', basedOn: { job: 'C:\\w\\jobs\\inline\\a.json', sha256: 'ab'.repeat(32) }, patch: [{ op: 'replace', path: '/ops/0/value', value: 'x' }],
    publish: true, closePrevious: 'f'.repeat(32), expectedEnvironment: 'https://dev.example.test', checks: ['k1'] };
  const next = wordsResend(input);
  assert.equal(next.tool, 'o11_deliver');
  assert.deepEqual(next.arguments, { ...input, authorize: WORDS_MARKER });
  // The marker is never words: replayed as it is, the gate refuses it again (nothing sent).
  assert.equal(wordsGiven(next.arguments.authorize), false);
  assert.match(next.why, /resend this same call/);
  // A call that carried words that were blank: the blank never comes back as if it were the words.
  assert.equal(wordsResend({ ...input, authorize: '  ' }).arguments.authorize, WORDS_MARKER);
});

test('the whole resend answer fits the refusal budget: a field too long is a placeholder that says what to put back', () => {
  for (const n of [3000, 7000, 8100, 9000, 40000]) {
    const input = { module: 'Orders', basedOn: { job: 'j.json', sha256: 'cd'.repeat(32) }, patch: [{ op: 'replace', path: '/ops/0/data/html', value: 'x'.repeat(n) }],
      publish: true, expectedEnvironment: 'https://dev.example.test' };
    const next = wordsResend(input);
    const answer = { ok: false, code: 'WORDS_REQUIRED', error: WORDS_REQUIRED_TEXT, continuation: next };
    assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= ANSWER_BUDGETS.refusal, n + ': ' + Buffer.byteLength(JSON.stringify(answer)));
    assert.ok(RESEND_BUDGET_BYTES < ANSWER_BUDGETS.refusal);
    // Every field is there: as sent, or its placeholder (never missing); the guards stay as sent.
    assert.deepEqual(Object.keys(next.arguments).sort(), [...Object.keys(input), 'authorize'].sort());
    assert.equal(next.arguments.expectedEnvironment, 'https://dev.example.test');
    assert.deepEqual(next.arguments.basedOn, input.basedOn);
    if (typeof next.arguments.patch === 'string') {
      assert.equal(next.arguments.patch, '<the patch exactly as you sent it>');
      assert.match(next.why, /<the patch exactly as you sent it> with that field exactly as you sent it/);
    } else assert.deepEqual(next.arguments.patch, input.patch);
  }
  // resume and close keep their own one-field form.
  assert.deepEqual(wordsResend({ resume: 'a'.repeat(32) }).arguments, { resume: 'a'.repeat(32), authorize: WORDS_MARKER });
  assert.deepEqual(wordsResend({ close: { taskId: 'b'.repeat(32), reason: 'x' } }).arguments, { close: { taskId: 'b'.repeat(32), reason: 'x' }, authorize: WORDS_MARKER });
});

async function deliverServer(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't16-words-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority');
  for (const dir of [root, home, auth, path.join(root, '.local', 'connections')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242,
    startedUtc: '2026-10-02T00:00:00Z', studioDir: path.join(base, 'Studio'), authorityDir: auth, port: 45999 }));
  const calls = [];
  const env = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  const server = new McpServer({ name: 't16', version: '1.0.0' });
  registerO11Cycle(server, { root, env, lane: 'ss4', now: () => new Date('2026-10-23T10:00:00Z'), runAnvil: async argv => { calls.push(argv); return { ok: true }; },
    assertSelected: async () => {} });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't16-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { base, calls, call: async args => (await client.callTool({ name: 'o11_deliver', arguments: args })).structuredContent };
}

test('o11_deliver without words answers WORDS_REQUIRED with the exact resend and sends nothing', async t => {
  const { base, calls, call } = await deliverServer(t);
  const args = { module: 'Orders', basedOn: { job: path.join(base, 'job.json'), sha256: 'ab'.repeat(32) }, patch: [{ op: 'replace', path: '/ops/0/value', value: 'x' }],
    publish: true, expectedEnvironment: 'https://dev.example.test' };
  const answer = await call(args);
  assert.equal(answer.code, 'WORDS_REQUIRED');
  assert.equal(calls.length, 0, 'nothing reached the CLI');
  // Every field of the call as sent (the schema's defaults, such as until, ride along) and the marker in authorize.
  for (const [k, v] of Object.entries(args)) assert.deepEqual(answer.continuation.arguments[k], v, k);
  assert.equal(answer.continuation.arguments.authorize, WORDS_MARKER);
});

test('a resend with a placeholder replayed with the words is refused, never sent without the field', async t => {
  const { calls, call } = await deliverServer(t);
  const job = { ops: [{ op: 'create', parent: '@espace', type: 'IServerAction', name: 'A', description: 'x'.repeat(9000) }] };
  const first = await call({ module: 'Orders', job, publish: true, checks: ['A'] });
  assert.equal(first.code, 'WORDS_REQUIRED');
  assert.equal(first.continuation.arguments.job, '<the job exactly as you sent it>');
  const replay = await call({ ...first.continuation.arguments, authorize: 'yes, deliver it' });
  assert.notEqual(replay?.ok, true, JSON.stringify(replay).slice(0, 400));
  assert.ok(!calls.some(argv => argv.includes('deliver')), 'no delivery reached the CLI: ' + JSON.stringify(calls).slice(0, 300));
});

test('one code under one generic fix with two message templates is two groups, each with its own members', () => {
  const generic = 'correct the reported element or value as the diagnostic describes';
  const problem = (op, message) => ({ phase: 'apply', op, pointer: `/ops/${op}/data/html`, code: 'HTML_INVALID', severity: 'error', message, fix: generic });
  const list = [problem(1, "html: line 3 col 2: onclick=\"Alpha\": no element is named 'Alpha'"), problem(2, "html: line 9 col 4: onclick=\"Beta\": no element is named 'Beta'"),
    problem(3, "html: line 43 col 7: stray '<'")];
  const { problems } = fitProblems(list, { alwaysGroup: true, preserveAll: true });
  assert.equal(problems.length, 2, JSON.stringify(problems));
  const names = problems.find(p => p.count === 2);
  assert.ok(names, 'the two unknown names are one template');
  assert.deepEqual(names.ops, [1, 2]);
  assert.equal(templateOf(list[0].message), templateOf(list[1].message));
  assert.notEqual(templateOf(list[0].message), templateOf(list[2].message));
  assert.equal(templateOf(String.raw`op #1 (html Home): cannot read C:\srv\a\a.html`),
    templateOf(String.raw`op #2 (html Other): cannot read C:\srv\b\x\b.html at Anvil.Core.Kernel.Verbs.Apply in JobRunner.cs:line 12`));
});

// The review's examples (case job of a migration, names made neutral): a code fragment, a node id, the kind of the element and
// where a long message is cut never split one cause into several groups.
test('the same cause is one group: data actions that assign a local of their screen or block, timestamps marked UTC', () => {
  const kinds = [['screen', 'Orders'], ['block', 'UserBadge'], ['screen', 'Stock'], ['screen', 'Audit'], ['screen', 'Mine'], ['screen', 'Filtered'],
    ['screen', 'Detail'], ['screen', 'Returns'], ['screen', 'Public'], ['screen', 'Ops']];
  const assigns = kinds.map(([kind, name], i) => ({ phase: 'preflight', op: 64, pointer: '/ops/64/data/flow/' + i, code: 'EXPR_UNKNOWN_IDENTIFIER', severity: 'error',
    message: `data action ${name}.GetData: assigns '${i % 2 ? 'Rows' : 'Selected' + name}', a local variable of ${kind} ${name}: a data action does not see the ${kind}'s local variables (assign ${i % 2 ? 'Rows' : 'Selected' + name} = ${i === 5 ? 'Filter + 1' : 'Loaded' + (i + 10) + '.Rows'} @n${i + 2})`,
    fix: `set the variable in the screen action that refreshes GetData (or after its data is fetched), or make it an output of GetData` }));
  const tail = ' parses it as UTC shifts it a second time (expected: the local time shown with a display mask, or a UTC text made on the server; actual: local time marked UTC)';
  const spans = ['StartedOnCell', 'OccurredOnCell', 'DecidedOnText', 'ReturnedOnText'].map((id, i) => ({ phase: 'preflight', op: 33 + i, pointer: `/ops/${33 + i}/data/html`,
    code: 'DATETIME_TZ_REINTERPRETED', severity: 'error',
    message: `<span id="${id}"> (line ${74 + i * 20}) of screen Screen${i}, attribute 'data-utc': '${'If(Rows.Current.At' + i + ' = NullDate(), "", FormatDateTime(Rows.Current.At' + i + ', "yyyy-MM-ddTHH:mm:ss") + "' + 'Z'.repeat(380 + i * 9) + '")'}' is a Date Time of client-side code`
      + ' marked UTC, which the page fills with the local time of the browser; the script that' + tail,
    fix: 'show the local time with a display mask, or make the UTC text on the server' }));
  assert.ok(spans.every(p => p.message.length > 600), 'the messages are longer than the cut');
  for (const opts of [{ alwaysGroup: true }, { alwaysGroup: true, preserveAll: true }]) {
    const { problems } = fitProblems([...assigns, ...spans], opts);
    const byCode = code => problems.filter(p => p.code === code);
    assert.equal(byCode('EXPR_UNKNOWN_IDENTIFIER').length, 1, JSON.stringify(opts) + ' ' + JSON.stringify(byCode('EXPR_UNKNOWN_IDENTIFIER').map(p => p.message)));
    assert.equal(byCode('EXPR_UNKNOWN_IDENTIFIER')[0].count, 10);
    assert.equal(byCode('DATETIME_TZ_REINTERPRETED').length, 1, JSON.stringify(opts));
    assert.equal(byCode('DATETIME_TZ_REINTERPRETED')[0].count, 4);
  }
});

test('patch "verified" is the union of the certain patches only; a choice stays on its problem', () => {
  const certain = { code: 'FUNCTION_UNKNOWN', op: 0, pointer: '/ops/0/value', severity: 'error', message: "'Lower(' is not a built-in", fix: 'write ToLower(...)',
    patch: [{ op: 'replace', path: '/ops/0/value', value: 'ToLower(X)' }], patchRule: 'BUILTIN_FUNCTION_RENAMED', patchCertain: true };
  const choice = { code: 'NAME_COLLISION', op: 1, pointer: '/ops/1/name', severity: 'error', message: "create IServerAction 'A' under IESpace 'M': the module already has IServerAction:A there",
    fix: 'use the existing IServerAction:A, or give the new element another name', patch: [{ op: 'replace', path: '/ops/1', value: { op: 'get', target: 'IServerAction:A' } }],
    patchRule: 'CREATE_USES_EXISTING', patchCertain: false };
  const reconnect = { code: 'DELETE_HAS_CONSUMERS', op: 2, pointer: 'IServerAction:B/IStartNode/IActionConnector', severity: 'error', message: 'uses IAssignNode',
    fix: 'remove the step with reconnect:true', patch: [{ op: 'add', path: '/ops/2/reconnect', value: true }], patchRule: 'DELETE_RECONNECTS', patchCertain: false };
  assert.deepEqual(patchUnion([certain, choice, reconnect]), certain.patch);
  assert.equal(patchUnion([certain, choice, reconnect], { all: true }).length, 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't16-verified-'));
  try {
    const jobFile = path.join(dir, 'job.json');
    fs.writeFileSync(jobFile, JSON.stringify({ ops: [{}, {}, {}] }));
    const fields = refusalFields([certain, choice, reconnect], {}, { jobFile });
    assert.equal(fields.verifiedPatch?.ops, 1, JSON.stringify(fields.verifiedPatch));
    const kept = JSON.parse(fs.readFileSync(jobFile + '.verified-patch.json', 'utf8'));
    assert.deepEqual(kept.patch, certain.patch);
    // Only choices: no verified call at all.
    assert.equal(refusalFields([choice, reconnect], {}, { jobFile: path.join(dir, 'none.json') }).verifiedPatch, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a create collision keeps its conditional problems, dependents and choices through the shaping and the grouping', () => {
  const collision = { phase: 'base', op: 0, pointer: '/ops/0/name', code: 'NAME_COLLISION', severity: 'error', message: "create IServerAction 'A' under IESpace 'M'", fix: 'use the existing',
    existing: 'IServerAction:A', freeName: 'A2', dependents: [1, 2],
    conditional: [{ if: 'the patch (use the existing element)', phase: 'base', op: 1, pointer: '/ops/1/name', code: 'NAME_COLLISION', message: "create IInputParameter 'X'" }] };
  const shaped = problemOf(collision);
  assert.deepEqual(shaped.conditional, collision.conditional);
  assert.deepEqual(shaped.dependents, [1, 2]);
  assert.equal(shaped.existing, 'IServerAction:A');
  const other = { ...collision, op: 5, pointer: '/ops/5/name', conditional: [{ if: 'another name', op: 6, code: 'X', message: 'y' }] };
  const { problems } = fitProblems([collision, other], { alwaysGroup: true, preserveAll: true });
  const items = problems.flatMap(p => p.items ?? [p]);
  assert.ok(items.every(i => Array.isArray(i.conditional) && i.conditional.length === 1), JSON.stringify(problems));
});

test('a text cut for the answer never splits a character outside the BMP', () => {
  const emoji = '\u{1F600}';
  const text = 'a'.repeat(298) + emoji + 'tail';   // the emoji's two halves at 298 and 299
  for (const cut of [clipText(text, 300), clip(text, 300), clip('a'.repeat(296) + emoji + 'tail', 300, '...')]) {
    assert.ok(cut.length <= 300);
    assert.equal(Buffer.from(cut, 'utf8').toString('utf8'), cut, 'no lone surrogate');
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut));
  }
  assert.ok(clipText(text, 300).endsWith('…'));
  assert.equal(clipText('short', 300), 'short');
  assert.equal(clipText('b'.repeat(301), 300), 'b'.repeat(299) + '…');
  // The 600-character clip of a problem's message (refusal-problems.mjs problemOf).
  const long = { code: 'X', severity: 'error', message: 'm'.repeat(596) + emoji + 'rest', fix: null };
  const m = problemOf(long).message;
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(m), JSON.stringify(m.slice(-6)));
});
