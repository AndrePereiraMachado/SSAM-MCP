// o11_access on a real McpServer over InMemoryTransport, with a fake Anvil CLI. No Studio, no dotnet, no Python, no
// socket (the bridge port of the connection record is only a number in the argv); every folder is temporary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Access, accessArguments, cleanKernel } from '../o11-access.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { WORDS_MARKER } from '../o11-cycle.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import envelopes from './fixtures/o11-access-envelopes.json' with { type: 'json' };

const sha256 = text => createHash('sha256').update(text).digest('hex');
const WORDS = '  sim, aplique os papéis do manifesto v3 em dev  ';
const PORT = 45999; // a number in the argv only: nothing listens on it and nothing connects to it
const SHELL = /dotnet|python|\.ps1|--execute|--deliver-work|ssam (connect|doctor|deliver|access)|odc /i;

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-access-'));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority'), studio = path.join(base, 'Studio');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  const env = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  const record = path.join(root, '.local', 'connections', 'ss4.json');
  fs.mkdirSync(path.dirname(record), { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, startedUtc: '2026-10-02T00:00:00Z', studioDir: studio, authorityDir: auth, port: PORT }));
  const manifest = path.join(base, 'manifests', 'roles.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'ssam-access/1', manifestVersion: 3, environment: 'dev.example.test', entries: [] }));
  let clock = Date.parse('2026-10-02T10:15:00.000Z');
  const local = path.join(root, '.local');
  return { base, root, env, record, manifest, local, work: path.join(local, 'work'), store: path.join(local, 'access'),
    now: () => new Date(clock += 1000), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// The kernel's own checkpoint format (DurableJson.Write): {format, sha256, payload}.
const durable = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const payload = JSON.stringify(value);
  fs.writeFileSync(file, JSON.stringify({ format: 1, sha256: sha256(payload), payload })); };
const writeTask = (box, state) => durable(path.join(box.work, 'deliver', state.taskId, 'task.json'), state);
const writeReceipt = (box, operationId, receipt) => durable(path.join(box.store, 'applies', operationId + '.json'), receipt);

// The receipt the kernel returns for this call's operation (fixtures name it "@op").
const forCall = (envelope, args) => JSON.parse(JSON.stringify(envelope).replaceAll('@op', args[args.indexOf('--operation-id') + 1]));

async function serve(deps) {
  const server = new McpServer({ name: 'o11-access-test', version: '1.0.0' });
  registerO11Access(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'o11-access-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = args => client.callTool({ name: 'o11_access', arguments: args }).catch(error => ({ isError: true, content: [{ type: 'text', text: error.message }], thrown: true }));
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

function setup(t, extra = {}) {
  const box = sandbox();
  const events = [];
  const handler = extra.apply ?? (args => forCall(envelopes.applyDelivered, args));
  const runAnvil = extra.runAnvil ?? fakeAnvil({ access: (args, options) => {
    events.push('cli');
    return args[1] === 'plan' ? envelopes.planOk : args[1] === 'verify' ? envelopes.verify : handler(args, options, box);
  } });
  const deps = { root: box.root, env: box.env, lane: 'ss4', now: box.now, runAnvil, assertSelected: async () => { events.push('selected'); }, ...extra.deps };
  t.after(box.cleanup);
  return { ...box, runAnvil, events, deps };
}

// The strict parser of the kernel for `access apply` (kernel/src/Anvil.Core/Access/AccessArguments.cs), ported for the
// test: every option known, a value option always takes the next token, a flag counts only where an option may stand.
const APPLY_VALUES = ['--manifest', '--words', '--plan', '--operation-id', '--port', '--deliver-work', '--work', '--ss-dir'];
const APPLY_FLAGS = ['--execute', '--prepare-only'];
function parseApply(argv) {
  assert.deepEqual(argv.slice(0, 2), ['access', 'apply']);
  const values = {}; const flags = new Set();
  for (let i = 2; i < argv.length; i++) {
    const name = argv[i];
    if (APPLY_FLAGS.includes(name)) { if (flags.has(name)) throw new Error(name + ' twice'); flags.add(name); continue; }
    if (!APPLY_VALUES.includes(name)) throw new Error('unexpected ' + name);
    const value = argv[++i];
    if (value === undefined || (name !== '--words' && value.startsWith('--'))) throw new Error('missing value of ' + name);
    if (Object.hasOwn(values, name)) throw new Error(name + ' twice');
    values[name] = value;
  }
  if (flags.has('--execute') && flags.has('--prepare-only')) throw new Error('--execute and --prepare-only exclude each other');
  return { execute: flags.has('--execute'), prepareOnly: flags.has('--prepare-only'), values };
}

test('the tool keeps the o11_access name and actions, takes no execution argument and its description says it executes', async t => {
  const box = setup(t);
  const { client, call, close } = await serve(box.deps); t.after(close);
  const tool = (await client.listTools()).tools.find(x => x.name === 'o11_access');
  assert.ok(tool, 'missing o11_access');
  const schema = tool.inputSchema;
  // users (A13, pa2-f8-access.test.mjs) adds its read-only fields; manifestPath is required by plan and apply themselves.
  assert.deepEqual(Object.keys(schema.properties).sort(), ['action', 'email', 'host', 'manifestPath', 'max', 'operationId', 'role', 'username', 'words']);
  assert.deepEqual(schema.properties.action.enum, ['plan', 'apply', 'verify', 'users']);
  assert.deepEqual([...schema.required].sort(), ['action']);
  assert.equal(schema.additionalProperties, false);
  for (const flag of ['execute', 'prepareOnly', 'createAccounts', 'createActive', 'port', 'deliverWork', 'plan', 'work']) assert.ok(!(flag in schema.properties), flag);
  assert.match(tool.description, /apply .*EXECUTES/);
  assert.match(tool.description, /one delivery per owner module/);
  assert.match(tool.description, /bound to the manifest environment/);
  assert.match(tool.description, /Never publishes/);
  assert.match(tool.description, /never creates accounts/);
  assert.doesNotMatch(tool.description, SHELL);
  assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.annotations.destructiveHint, true);
  // An argument the schema does not name is refused before anything runs.
  const execute = await call({ action: 'apply', manifestPath: box.manifest, words: 'ok', execute: true });
  assert.equal(execute.isError, true);
  assert.equal(box.runAnvil.calls.length, 0);
  assert.deepEqual(box.events, []);
});

test('accessArguments: plan and verify as today; apply executes with the port and the lane store, words last, never --prepare-only', () => {
  const manifest = path.resolve('roles.json');
  const ctx = { operationId: 'AB'.repeat(16), port: PORT, deliverWork: path.resolve('work') };
  assert.deepEqual(accessArguments({ action: 'plan', manifestPath: manifest }).argv, ['access', 'plan', '--manifest', manifest]);
  assert.deepEqual(accessArguments({ action: 'verify', manifestPath: manifest }).argv, ['access', 'verify']);
  const apply = accessArguments({ action: 'apply', manifestPath: manifest, words: 'ok' }, ctx);
  assert.deepEqual(apply.argv, ['access', 'apply', '--execute', '--manifest', manifest, '--operation-id', 'ab'.repeat(16),
    '--port', String(PORT), '--deliver-work', path.resolve('work'), '--words', 'ok']);
  assert.equal(apply.operationId, 'ab'.repeat(16));
  assert.ok(!apply.argv.includes('--prepare-only'));
  // the caller's operationId (reconcile) wins over a new one
  assert.equal(accessArguments({ action: 'apply', manifestPath: manifest, words: 'ok', operationId: 'cd'.repeat(16) }, ctx).operationId, 'cd'.repeat(16));
  for (const [input, code] of [
    [{ action: 'apply', manifestPath: manifest }, 'WORDS_REQUIRED'], [{ action: 'apply', manifestPath: manifest, words: '   ' }, 'WORDS_REQUIRED'],
    [{ action: 'apply', manifestPath: manifest, words: WORDS_MARKER }, 'WORDS_REQUIRED'],
    [{ action: 'plan', manifestPath: manifest, words: 'ok' }, 'WORDS_NOT_TAKEN'], [{ action: 'verify', manifestPath: manifest, words: 'ok' }, 'WORDS_NOT_TAKEN'],
    [{ action: 'plan', manifestPath: manifest, operationId: 'ab'.repeat(16) }, 'OPERATION_NOT_TAKEN'],
    [{ action: 'apply', manifestPath: manifest, words: 'ok', operationId: 'not-hex' }, 'OPERATION_ID_INVALID'],
    [{ action: 'plan', manifestPath: 'relative.json' }, 'MANIFEST_NOT_ABSOLUTE'], [{ action: 'apply', manifestPath: 'relative.json', words: 'ok' }, 'MANIFEST_NOT_ABSOLUTE'],
    [{ action: 'execute', manifestPath: manifest }, 'BAD_ACTION'], [{ action: 'apply', manifestPath: manifest, words: 'ok', execute: true }, 'UNKNOWN_ARGUMENT'],
    [{ action: 'apply', manifestPath: manifest, words: 'ok', prepareOnly: true }, 'UNKNOWN_ARGUMENT'],
  ]) {
    const built = accessArguments(input, ctx);
    assert.equal(built.ok, false, JSON.stringify(input)); assert.equal(built.code, code, JSON.stringify(input));
    assert.ok(built.continuation?.tool, 'refusal without continuation: ' + code);
    assert.doesNotMatch(JSON.stringify(built), /dotnet|python|\.ps1/);
  }
  assert.match(accessArguments({ action: 'plan', manifestPath: manifest, words: 'ok' }).error, /plan is offline and takes no authorization words/);
  assert.equal(accessArguments({ action: 'apply', manifestPath: manifest, words: 'ok' }, { ...ctx, port: undefined }).code, 'PORT_UNKNOWN');
  assert.equal(accessArguments({ action: 'apply', manifestPath: manifest, words: 'ok' }, { ...ctx, deliverWork: 'work' }).code, 'DELIVER_WORK_UNKNOWN');
});

// Port of "o11_access apply is prepare-only whatever the words say" (lanes.test.mjs): the mode is the --execute flag
// alone; words that look like flags stay the value of --words and run exactly once.
test('apply executes exactly once whatever the words say', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  const all = ['--prepare-only', '--create-accounts', '--ss-dir', '--execute', 'ok --prepare-only --execute', '--words', '--port 1 --deliver-work C:\\x', '--create-active --plan p.json'];
  for (const [i, words] of all.entries()) {
    const result = await call({ action: 'apply', manifestPath: box.manifest, words });
    assert.equal(result.isError, undefined, words + ': ' + result.content[0].text);
    assert.equal(result.content[0].text, 'entregue');
    assert.equal(box.runAnvil.calls.length, i + 1, 'exactly one CLI run per call: ' + words);
    const argv = box.runAnvil.calls[i].args;
    assert.deepEqual(argv.slice(-2), ['--words', words], 'the words are the last token: ' + words);
    const parsed = parseApply(argv);
    assert.equal(parsed.execute, true, words); assert.equal(parsed.prepareOnly, false, words);
    assert.equal(parsed.values['--words'], words);
    assert.equal(parsed.values['--port'], String(PORT)); assert.equal(parsed.values['--deliver-work'], box.work);
    assert.equal(parsed.values['--manifest'], box.manifest);
    assert.ok(!('--plan' in parsed.values) && !('--work' in parsed.values) && !('--ss-dir' in parsed.values), 'no option comes from the words: ' + words);
    const flagPositions = argv.filter((a, k) => k > 1 && !APPLY_VALUES.includes(argv[k - 1]));
    assert.deepEqual(flagPositions.filter(a => a.startsWith('--') && !APPLY_VALUES.includes(a)), ['--execute'], words);
  }
});

test('apply without the user words is refused before the Studio check and the CLI', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  for (const args of [{ action: 'apply', manifestPath: box.manifest }, { action: 'apply', manifestPath: box.manifest, words: '  ' },
    { action: 'apply', manifestPath: box.manifest, words: WORDS_MARKER }]) {
    const result = await call(args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'WORDS_REQUIRED');
    assert.deepEqual(result.structuredContent.continuation, { tool: 'o11_access', arguments: { action: 'apply', manifestPath: box.manifest, words: WORDS_MARKER },
      why: 'Ask the user to authorize applying this manifest and pass their exact words in words.' });
  }
  assert.equal(box.runAnvil.calls.length, 0);
  assert.deepEqual(box.events, []);
  assert.ok(!fs.existsSync(path.join(box.local, 'journal')), 'nothing journaled without words');
});

test('plan runs offline without words, the Studio check or a journal, and answers the kernel plan', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  const result = await call({ action: 'plan', manifestPath: box.manifest });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(box.runAnvil.calls[0].args, ['access', 'plan', '--manifest', box.manifest]);
  assert.deepEqual(box.events, ['cli'], 'no assertSelected for plan');
  assert.equal(result.structuredContent.schema, 'ssam-access-plan/1');
  assert.equal(result.structuredContent.modules[0].module, 'Orders');
  assert.ok(!fs.existsSync(path.join(box.local, 'journal')));

  const words = await call({ action: 'plan', manifestPath: box.manifest, words: 'ok' });
  assert.equal(words.structuredContent.code, 'WORDS_NOT_TAKEN');
  assert.equal(box.runAnvil.calls.length, 1);
});

test('a plan refused by the kernel comes back with its errors and an MCP continuation', async t => {
  const box = setup(t, { runAnvil: fakeAnvil({ access: () => envelopes.planRefused }) });
  const { call, close } = await serve(box.deps); t.after(close);
  const result = await call({ action: 'plan', manifestPath: box.manifest });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'ACCESS_PLAN_REFUSED');
  assert.match(result.structuredContent.errors[0], /does not reference \(System\) User/);
  assert.equal(result.structuredContent.continuation.tool, 'o11_access');
});

test('a relative or missing manifestPath is refused before the CLI', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  for (const args of [{ action: 'plan', manifestPath: 'roles.json' }, { action: 'apply', manifestPath: 'manifests/roles.json', words: WORDS }]) {
    const result = await call(args);
    assert.equal(result.isError, true); assert.equal(result.structuredContent.code, 'MANIFEST_NOT_ABSOLUTE');
  }
  const missing = await call({ action: 'apply', manifestPath: path.join(box.base, 'none.json'), words: WORDS });
  assert.equal(missing.structuredContent.code, 'MANIFEST_NOT_FOUND');
  assert.equal(box.runAnvil.calls.length, 0);
  assert.deepEqual(box.events, []);
});

test('all deliveries delivered: only "entregue"; the journal and the task keep the sha256 of the words, never the words', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  const result = await call({ action: 'apply', manifestPath: box.manifest, words: WORDS });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'entregue');
  assert.deepEqual(result.structuredContent, { ok: true, result: 'entregue' });
  const argv = box.runAnvil.calls[0].args;
  const operationId = argv[argv.indexOf('--operation-id') + 1];
  assert.match(operationId, /^[0-9a-f]{32}$/);
  assert.equal(box.runAnvil.calls[0].options.timeoutMs, 3600000);

  const lines = fs.readFileSync(path.join(box.local, 'journal', 'o11_access.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.event), ['start', 'end']);
  assert.equal(lines[0].tool, 'o11_access');
  assert.equal(lines[0].wordsSha256, sha256(WORDS.trim()), 'the hash the kernel records (trimmed words)');
  assert.equal(lines[0].operationId, operationId); assert.equal(lines[1].operationId, operationId);
  assert.equal(lines[0].manifest, box.manifest); assert.equal(lines[0].port, PORT);
  assert.equal(lines[1].outcome, 'delivered');
  const tasks = fs.readdirSync(path.join(box.local, 'tasks')).map(f => fs.readFileSync(path.join(box.local, 'tasks', f), 'utf8'));
  assert.equal(tasks.length, 1);
  assert.equal(JSON.parse(tasks[0]).state, 'ok');
  for (const text of [fs.readFileSync(path.join(box.local, 'journal', 'o11_access.jsonl'), 'utf8'), ...tasks])
    assert.ok(!text.includes(WORDS.trim()), 'the words never reach a file');

  // nothing left to deliver (the kernel answers "unchanged") is no error either
  const unchanged = setup(t, { apply: args => forCall(envelopes.applyUnchanged, args) });
  const second = await serve(unchanged.deps); t.after(second.close);
  assert.equal((await second.call({ action: 'apply', manifestPath: unchanged.manifest, words: WORDS })).content[0].text, 'entregue');
});

test('verifier errors come back, short, and nothing is reported about what was delivered beyond the module names', async t => {
  const box = setup(t, { apply: (args, _, b) => { writeTask(b, envelopes.tasks['2b3c4d5e6f708192a3b4c5d6e7f8091a']); return forCall(envelopes.applyVerifierRefused, args); } });
  const { call, close } = await serve(box.deps); t.after(close);
  const result = await call({ action: 'apply', manifestPath: box.manifest, words: WORDS });
  assert.equal(result.isError, true);
  const value = result.structuredContent;
  assert.equal(value.outcome, 'refused'); assert.equal(value.code, 'VALIDATION_REFUSED');
  assert.equal(value.module, 'Billing'); assert.equal(value.taskId, '2b3c4d5e6f708192a3b4c5d6e7f8091a'); assert.equal(value.stage, 'verify');
  assert.equal(value.merged, true);
  assert.match(value.error, /merge kept for review/);
  assert.ok(value.messages.some(m => /Required property 'Description' is empty/.test(m)));
  assert.deepEqual(value.deliveredModules, ['Orders']);
  assert.equal(value.continuation.tool, 'o11_access'); assert.equal(value.continuation.arguments.action, 'plan');
  for (const key of ['deliveries', 'receiptPath', 'publication', 'modules', 'counts', 'users']) assert.ok(!(key in value), 'no receipt field ' + key);
  assert.doesNotMatch(result.content[0].text, SHELL);
  assert.equal(box.runAnvil.calls.length, 1);

  const before = setup(t, { apply: (args, _, b) => { writeTask(b, envelopes.tasks['1a2b3c4d5e6f708192a3b4c5d6e7f809']); return forCall(envelopes.applyRefusedBeforeMerge, args); } });
  const other = await serve(before.deps); t.after(other.close);
  const refused = (await other.call({ action: 'apply', manifestPath: before.manifest, words: WORDS })).structuredContent;
  assert.equal(refused.code, 'VALIDATION_REFUSED'); assert.equal(refused.stage, 'apply'); assert.equal(refused.merged, undefined);
  assert.ok(refused.messages.some(m => /Undefined variable 'RoleId'/.test(m)));
  assert.match(refused.error, /merge was not attempted/);
});

test('a kernel refusal returns its errors without command lines, with the MCP call to make instead', async t => {
  const box = setup(t, { apply: () => envelopes.applyNoPlan });
  const { call, close } = await serve(box.deps); t.after(close);
  const noPlan = (await call({ action: 'apply', manifestPath: box.manifest, words: WORDS })).structuredContent;
  assert.equal(noPlan.code, 'ACCESS_REFUSED'); assert.equal(noPlan.stage, 'plan');
  assert.match(noPlan.error, /no successful plan/); assert.match(noPlan.error, /o11_access action plan/);
  assert.deepEqual(noPlan.continuation.arguments, { action: 'plan', manifestPath: box.manifest });

  const port = setup(t, { apply: () => envelopes.applyExecuteRefused });
  const second = await serve(port.deps); t.after(second.close);
  const result = await second.call({ action: 'apply', manifestPath: port.manifest, words: WORDS });
  assert.equal(result.structuredContent.stage, 'execute');
  assert.match(result.structuredContent.error, /prepared for Studio port 45001/);
  assert.doesNotMatch(result.content[0].text, SHELL);
  assert.deepEqual(result.structuredContent.continuation.arguments, { action: 'apply', manifestPath: port.manifest, words: WORDS_MARKER });
  assert.equal(cleanKernel('more than one successful plan (with and without --create-accounts); pass --plan <plan.json>'), 'more than one successful plan (with and without --create-accounts);');
});

test('an uncertain delivery is never repeated: uncertain outcome, resume of the same kernel task', async t => {
  const box = setup(t, { apply: (args, _, b) => { writeTask(b, envelopes.tasks['3c4d5e6f708192a3b4c5d6e7f8091a2b']); return forCall(envelopes.applyUncertain, args); } });
  const { call, close } = await serve(box.deps); t.after(close);
  const result = await call({ action: 'apply', manifestPath: box.manifest, words: WORDS });
  assert.equal(result.isError, true);
  const value = result.structuredContent;
  assert.equal(value.outcome, 'uncertain'); assert.equal(value.code, 'ACCESS_UNCERTAIN');
  assert.equal(value.module, 'Orders'); assert.equal(value.writeState, 'unknown'); assert.equal(value.taskId, '3c4d5e6f708192a3b4c5d6e7f8091a2b');
  assert.match(value.error, /Nothing was repeated/);
  assert.deepEqual(value.continuation.arguments, { resume: '3c4d5e6f708192a3b4c5d6e7f8091a2b', authorize: WORDS_MARKER });
  assert.equal(value.continuation.tool, 'o11_deliver');
  assert.equal(box.runAnvil.calls.length, 1, 'the CLI ran once');
  const task = JSON.parse(fs.readFileSync(path.join(box.local, 'tasks', fs.readdirSync(path.join(box.local, 'tasks'))[0]), 'utf8'));
  assert.equal(task.state, 'uncertain'); assert.equal(task.result.taskId, '3c4d5e6f708192a3b4c5d6e7f8091a2b');
  const end = fs.readFileSync(path.join(box.local, 'journal', 'o11_access.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.equal(end.outcome, 'uncertain'); assert.equal(end.kernelTaskId, '3c4d5e6f708192a3b4c5d6e7f8091a2b');
});

test('a lost answer is read from the receipt on disk: the delivery that was running is resumed, nothing is replayed', async t => {
  const job = 'C:\\anvil\\.local\\access\\plans\\v3-ab12ab12ab12\\Orders-access.json';
  const calls = [];
  // The process was stopped while Orders was merging: the receipt says "delivering" (no taskId yet), task.json says intent.
  const runAnvil = async (args, options) => {
    calls.push({ args, options });
    const operationId = args[args.indexOf('--operation-id') + 1];
    writeReceipt(box, operationId, { schema: 'ssam-access-apply/1', operationId, status: 'executing',
      deliveries: [{ module: 'Orders', job, status: 'delivering', startedAtUtc: new Date(Date.now() - 5000).toISOString() }, { module: 'Billing', status: 'prepared' }] });
    writeTask(box, { taskId: '6f708192a3b4c5d6e7f8091a2b3c4d5e', module: 'Orders', request: { JobPath: job }, delivered: false, writeState: 'intent', stage: 'merge',
      updatedAt: new Date().toISOString() });
    return { ok: false, exitCode: 1, envelope: null, timedOut: true, stderr: [], wallMs: 1, line: 'x' };
  };
  const box = setup(t, { runAnvil });
  const { call, close } = await serve(box.deps); t.after(close);
  const value = (await call({ action: 'apply', manifestPath: box.manifest, words: WORDS })).structuredContent;
  assert.equal(value.outcome, 'uncertain'); assert.equal(value.taskId, '6f708192a3b4c5d6e7f8091a2b3c4d5e'); assert.equal(value.writeState, 'intent');
  assert.equal(value.continuation.tool, 'o11_deliver'); assert.equal(value.continuation.arguments.resume, '6f708192a3b4c5d6e7f8091a2b3c4d5e');
  assert.equal(calls.length, 1);
});

test('a timeout with no receipt is uncertain, reconciled by the same operation through o11_access, which sends that operationId again', async t => {
  const calls = [];
  const runAnvil = async (args, options) => { calls.push({ args, options }); return { ok: false, exitCode: 1, envelope: null, timedOut: true, unknown: true, stderr: ['worker connection failed after submission'], wallMs: 1, line: 'worker access' }; };
  const box = setup(t, { runAnvil });
  const { call, close } = await serve(box.deps); t.after(close);
  const value = (await call({ action: 'apply', manifestPath: box.manifest, words: WORDS })).structuredContent;
  const operationId = calls[0].args[calls[0].args.indexOf('--operation-id') + 1];
  assert.equal(value.outcome, 'uncertain'); assert.equal(value.operationId, operationId);
  assert.deepEqual(value.continuation, { tool: 'o11_access', arguments: { action: 'apply', manifestPath: box.manifest, operationId, words: WORDS_MARKER },
    why: 'Returns the receipt of this same operation: the kernel reconciles by operationId and never repeats a delivery. words: the same words of the user, in place of the marker.' });
  assert.equal(calls.length, 1, 'never retried inside the call');

  // The reconciling call: the same --operation-id; the kernel answers the recorded receipt.
  const reconcile = await call({ action: 'apply', manifestPath: box.manifest, words: WORDS, operationId: operationId.toUpperCase() });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[calls[1].args.indexOf('--operation-id') + 1], operationId);
  assert.equal(reconcile.structuredContent.outcome, 'uncertain');
});

test('assertSelected runs before the apply CLI, and a Studio no longer selected stops it with ssam_connect', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  await call({ action: 'apply', manifestPath: box.manifest, words: WORDS });
  assert.deepEqual(box.events, ['selected', 'cli']);

  const lost = setup(t, { deps: { assertSelected: async () => { throw new Error('The selected Studio session is no longer connected. Call ssam_connect {lane:"o11"} to select the current Studio.'); } } });
  const other = await serve(lost.deps); t.after(other.close);
  const result = await other.call({ action: 'apply', manifestPath: lost.manifest, words: WORDS });
  assert.equal(result.structuredContent.code, 'STUDIO_NOT_SELECTED');
  assert.deepEqual(result.structuredContent.continuation.arguments, { lane: 'o11' });
  assert.equal(lost.runAnvil.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(lost.local, 'journal')));
});

test('without a connection record the port is the lane table bridge; verify answers phase 2 through the CLI', async t => {
  const box = setup(t);
  fs.rmSync(box.record);
  const { call, close } = await serve(box.deps); t.after(close);
  await call({ action: 'apply', manifestPath: box.manifest, words: WORDS });
  const argv = box.runAnvil.calls[0].args;
  assert.equal(argv[argv.indexOf('--port') + 1], String(o11LaneOf('ss4', { root: box.root, env: box.env }).bridge));

  const verify = await call({ action: 'verify', manifestPath: box.manifest });
  assert.deepEqual(box.runAnvil.calls[1].args, ['access', 'verify']);
  assert.equal(verify.isError, true);
  assert.equal(verify.structuredContent.code, 'NOT_IMPLEMENTED'); assert.equal(verify.structuredContent.phase, 2);
});
