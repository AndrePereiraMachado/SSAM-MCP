// Lote 4, F1: a failed O11 publication carries the publish log in the structure of o11_studio publish-log, and an internal
// compiler error (ESpace.Dump, 17 PUBLISH_FAILED of 19/10) carries the exact server lines and the elements cited before
// it. The logs are real ones preserved by the sessions of 13-22/10 (tests/fixtures/publish-logs, tenant, person, server
// and the customer's module names anonymized). No Studio, no Service Center, nothing published; folders are temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createO11Publish, compilerExcerpt, compilerErrorRow, elementsBefore, compilerServerLog, withPublishLog } from '../o11-publish.mjs';
import { o11Studio } from '../o11-studio.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'publish-logs', name + '.json'), 'utf8'));
const DUMP = fixture('espace-dump-2026-10-19');
const REFERENCE = fixture('broken-reference-2026-10-22');
const UPGRADE = fixture('upgrade-error-2026-10-15');
const WORDS = 'sim, pode publicar o modulo agora';
const ok = data => ({ success: true, data, error: null });
const fail = (error, extra = {}) => ({ success: false, data: null, error, ...extra });
const FAILED = 'publish: \'X\' completed with failure; an upload is not a successful publication.';

// A Studio with one module open whose publication fails with `log`; o11_publish and o11_studio publish-log on the same bridge.
async function studio(t, log, { compilerErrorOf, serverReadMs } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-publish-server-log-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'); fs.mkdirSync(root, { recursive: true });
  const env = { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4', ANVIL_BRIDGE_PROBE_MS: '0', USERPROFILE: base, HOME: base, APPDATA: base, LOCALAPPDATA: base };
  const active = { name: log.module, key: log.moduleKey, kind: 'Web', environment: log.environment, isModified: false, pendingDialogs: [] };
  const fake = await fakeBridge(async request => {
    switch (request.method) {
      case 'open_module': return ok({ name: request.params.name, opened: true, alreadyOpen: true, selected: true, elapsedMs: 1 });
      case 'get_active_module': return ok(active);
      case 'get_errors': return ok({ isValid: true, errors: 0, warnings: 0, messages: [], rawMessages: [] });
      case 'publish': return fail(FAILED.replace('X', log.module), { data: { publishLog: log } });
      case 'publish_log': return ok(log);
      default: return fail('Unknown method: ' + request.method);
    }
  });
  t.after(() => fake.close());
  const bridge = o11Bridge({ port: fake.port, authorization: 'K' });
  const calls = [];
  let clock = Date.parse('2026-10-19T16:41:09.000Z');
  const deps = { root, env, lane: 'ss4', now: () => new Date(clock += 1000), bridge, assertSelected: async () => {}, tasksDir: path.join(root, '.local', 'tasks'),
    journal: () => {}, grants: { wordsFor: ({ authorize }) => ({ words: authorize, authorization: null }) },
    compilerErrorOf: async input => { calls.push(input); return compilerErrorOf ? compilerErrorOf(input) : { unavailable: 'no server in this test' }; }, serverReadMs };
  const publish = createO11Publish(deps);
  const publishLog = () => o11Studio({ bridge: () => bridge, assertSelected: async () => {}, lane: 'ss4', root, env })({ command: 'publish-log', args: { module: log.module } });
  return { publish: () => publish({ module: log.module, authorize: WORDS }), publishLog, calls, fake };
}

test('compilerExcerpt: the exception block of the real 19/10 error detail, verbatim, with the Dump frame and the message', () => {
  const excerpt = compilerExcerpt(DUMP.serviceCenter.errorDetail.detail);
  assert.equal(excerpt.message, 'Internal Error: Invalid compiler output.\nCondition is false');
  assert.equal(excerpt.lines[0], '[1] System.InvalidOperationException: Condition is false');
  // Verbatim: the Service Center page indents the frames with non-breaking spaces.
  assert.equal(excerpt.lines[excerpt.dumpLine].trim(), 'at OutSystems.HubEdition.Compiler.ESpace.Dump()');
  assert.deepEqual(excerpt.lines.map(l => l.trim()), [
    '[1] System.InvalidOperationException: Condition is false',
    'at DebugExtensions.MustBeTrue(Boolean cond)',
    'at OutSystems.HubEdition.Compiler.ESpace.Dump()',
    'at OutSystems.HubEdition.Compiler.Compiler.DumpEspaceCode(ESpace eSpace, CompilationContext context)',
    'at OutSystems.HubEdition.Compiler.Compiler.InnerGenerateCode(ESpace eSpace, CompilationContext context)',
    'at OutSystems.HubEdition.Compiler.Utils.CompilerUtils.TrapExceptionsInContext(Action action, CompilationContext context)']);
  for (const line of excerpt.lines) assert.ok(DUMP.serviceCenter.errorDetail.detail.includes(line), 'every line is the server\'s own: ' + line);
  assert.equal(compilerExcerpt('Internal Error: Invalid compiler output.\nCondition is false'), null, 'no Dump frame, no excerpt');
  assert.equal(compilerExcerpt(undefined), null);
});

test('compilerErrorRow: the CompilerService error of the publication window, never the next publication\'s nor another source', () => {
  const window = { startedAt: DUMP.publishStartedAt, endedAt: DUMP.publishEndedAt };
  const row = compilerErrorRow({ rows: DUMP.serviceCenter.listing.rows }, window);
  assert.equal(row.timeOfLog, '2026-10-19 16:41:15');
  assert.match(row.errorId, /^[0-9a-f-]{36}$/);
  assert.equal(row.module, null, 'the server logged no module');
  // The second publication (16:42:37..16:42:44) gets its own error, 87 s later.
  assert.equal(compilerErrorRow({ rows: DUMP.serviceCenter.listing.rows }, { startedAt: '2026-10-19T16:42:37.372Z', endedAt: '2026-10-19T16:42:44.056Z' }).timeOfLog, '2026-10-19 16:42:42');
  // A window with only EditData/Server.API errors (16:41:54) is not a compiler error.
  assert.equal(compilerErrorRow({ rows: DUMP.serviceCenter.listing.rows.filter(r => !/CompilerService/.test(r.fields.Source)) }, window), null);
  assert.equal(compilerErrorRow({ result: { rows: DUMP.serviceCenter.listing.rows } }, { startedAt: '2026-10-19T18:00:00Z', endedAt: '2026-10-19T18:00:10Z' }), null);
});

test('elementsBefore: the elements the publish log cited before the internal error, the bridge\'s element or the quoted name', () => {
  assert.deepEqual(elementsBefore(DUMP.publishLog), [
    { name: 'TamanhoPagina', kind: 'SiteProperty', key: 'k-site-property', stage: 'compile', type: 'Warning' },
    { name: 'MembroLinha', stage: 'compile', type: 'Warning' }]);
  const many = { messages: [...Array.from({ length: 30 }, (_, i) => ({ type: 'Warning', stage: 'compile', text: `Unused '${'E' + i}'` })), { type: 'Error', stage: 'compile', text: 'Internal Error' }, { type: 'Warning', text: "after 'Later'" }] };
  const cited = elementsBefore(many);
  assert.equal(cited.length, 20); assert.equal(cited[0].name, 'E10'); assert.equal(cited.at(-1).name, 'E29');
  assert.ok(!cited.some(e => e.name === 'Later'), 'what came after the error is not cited before it');
});

test('19/10 replayed: "Internal Error" at compile reads the CompilerService error of its window; the answer quotes the ESpace.Dump lines', async t => {
  const s = await studio(t, DUMP.publishLog, { compilerErrorOf: ({ startedAt, endedAt }) => {
    const row = compilerErrorRow({ rows: DUMP.serviceCenter.listing.rows }, { startedAt: DUMP.publishStartedAt, endedAt: DUMP.publishEndedAt });
    assert.ok(Date.parse(endedAt) >= Date.parse(startedAt));
    return { ...row, detail: DUMP.serviceCenter.errorDetail.detail, url: DUMP.serviceCenter.errorDetail.source, observedAt: DUMP.serviceCenter.errorDetail.observedAt };
  } });
  const value = await s.publish();
  assert.equal(value.code, 'PUBLISH_FAILED'); assert.equal(value.outcome, 'failed');
  assert.equal(s.calls.length, 1, 'one server read'); assert.equal(s.calls[0].module, 'Demandas_TW'); assert.equal(s.calls[0].host, DUMP.publishLog.environment);
  const log = value.serverLog;
  assert.equal(log.source, 'service-center'); assert.equal(log.espaceDump, true);
  assert.equal(log.message, 'Internal Error: Invalid compiler output.\nCondition is false');
  assert.match(log.excerpt[log.dumpLine], /OutSystems\.HubEdition\.Compiler\.ESpace\.Dump\(\)/);
  assert.equal(log.timeOfLog, '2026-10-19 16:41:15');
  assert.deepEqual(log.detailCall.arguments, { action: 'error-detail', errorId: log.errorId, host: DUMP.publishLog.environment });
  assert.deepEqual(log.elementsBefore.map(e => e.name), ['TamanhoPagina', 'MembroLinha']);
  assert.equal(value.diagnosis.code, 'COMPILER_ESPACE_DUMP'); assert.equal(value.diagnosis.causeKnown, false);
  assert.equal(value.diagnosis.leads.length, 2, 'the leads of the 19/10 captures, to check, never a repair');
  assert.equal(value.continuation.tool, 'o11_service_center_read', 'server diagnostics, never a guessed repair');
  assert.doesNotMatch(value.continuation.why, /Fix it.*publish again/);
});

test('the Dump lines already in the publish log are quoted from it, and the Service Center is not read', async t => {
  const own = { ...DUMP.publishLog, messages: [...DUMP.publishLog.messages.slice(0, 2), { ...DUMP.publishLog.messages[2], detail: compilerExcerpt(DUMP.serviceCenter.errorDetail.detail).lines.join('\n') }] };
  const s = await studio(t, own);
  const value = await s.publish();
  assert.equal(s.calls.length, 0);
  assert.equal(value.serverLog.source, 'publish-log'); assert.equal(value.serverLog.espaceDump, true); assert.equal(value.diagnosis.code, 'COMPILER_ESPACE_DUMP');
});

test('a Service Center that cannot be read, or answers late, says so; the failed publication is the same', async t => {
  const down = await studio(t, DUMP.publishLog, { compilerErrorOf: () => { throw new Error('SC_AUTH_REQUIRED: no session'); } });
  const a = await down.publish();
  assert.equal(a.code, 'PUBLISH_FAILED'); assert.equal(a.serverLog.espaceDump, false); assert.match(a.serverLog.unavailable, /SC_AUTH_REQUIRED/);
  assert.equal(a.serverLog.message, 'Internal Error'); assert.equal(a.diagnosis, undefined);
  const slow = await studio(t, DUMP.publishLog, { compilerErrorOf: () => new Promise(() => {}), serverReadMs: 50 });
  const started = Date.now(); const b = await slow.publish();
  assert.ok(Date.now() - started < 5000); assert.match(b.serverLog.unavailable, /did not answer within/);
});

test('an error that is not the compiler\'s (a broken producer reference, an upgrade error) never reads the server', async t => {
  for (const { publishLog } of [REFERENCE, UPGRADE]) {
    const s = await studio(t, publishLog);
    const value = await s.publish();
    assert.equal(value.code, 'PUBLISH_FAILED'); assert.equal(value.serverLog, undefined); assert.equal(s.calls.length, 0);
  }
  assert.equal(compilerServerLog(REFERENCE.publishLog), null);
});

test('o11_publish and o11_studio publish-log answer the same structured log (type, text, element, stage), real logs', async t => {
  for (const { publishLog } of [DUMP, REFERENCE, UPGRADE]) {
    const s = await studio(t, publishLog);
    const failed = await s.publish();
    const read = await s.publishLog();
    const { ok, ...expected } = read;
    assert.equal(ok, true);
    assert.deepEqual(failed.publishLog, expected, publishLog.module + ': one structure for the two reads');
    for (const m of failed.publishLog.messages) for (const k of ['type', 'stage', 'text']) assert.ok(m[k] != null, publishLog.module + ' ' + k);
  }
});

test('the error TrueChange did not see comes with its element, and the continuation goes to it (22/10, broken producer reference)', async t => {
  const s = await studio(t, REFERENCE.publishLog);
  const value = await s.publish();
  const first = value.publishLog.messages.find(m => m.type === 'Error');
  assert.deepEqual(first.element, REFERENCE.answer.messages[0].element);
  assert.equal(first.element.kind, 'Reference'); assert.equal(first.stage, 'compile');
  assert.equal(value.messages[0].element.name, first.element.name, 'the short list says the same');
  assert.equal(value.error, REFERENCE.answer.error, 'the same sentence as the preserved answer');
  assert.deepEqual(value.continuation.arguments, { lane: 'o11', target: REFERENCE.publishLog.module, name: first.element.name });
  // The upgrade error of 15/10 is a deployment error (SQL truncation): its element is the Timer the upgrade wrote.
  const upgrade = withPublishLog({ ok: false, code: 'PUBLISH_FAILED' }, UPGRADE.publishLog, UPGRADE.publishLog.module);
  assert.equal(upgrade.error, UPGRADE.answer.error);
  assert.equal(upgrade.publishLog.failedStage, 'deploy');
  assert.deepEqual(upgrade.publishLog.messages[0].element, UPGRADE.answer.messages[0].element);
  assert.deepEqual(upgrade.continuation.arguments, { lane: 'o11', target: UPGRADE.publishLog.module, name: 'AgentQueue' });
  // Without an element the continuation reads the whole log instead of guessing one.
  const bare = withPublishLog({ ok: false, code: 'PUBLISH_FAILED' }, { ...UPGRADE.publishLog, messages: UPGRADE.publishLog.messages.map(({ element, ...m }) => m) }, UPGRADE.publishLog.module);
  assert.equal(bare.continuation.arguments.command, 'publish-log');
});
