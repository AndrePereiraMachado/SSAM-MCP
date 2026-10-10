// next-steps.mjs: every answer brings its next exact call when one is obvious. Success: `next`, reads only, arguments
// from the answer. Refusal: the continuation the code implies when the tool gave none. Never a write as `next`, never
// the user's words, exact answers untouched. Pure: no Studio, no bridge, no file.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { addNextSteps, successNext, refusalContinuation, READS, WORDS_MARKER, JOB_MARKER, KEY_MARKER } from '../next-steps.mjs';
import { shapeToolResult } from '../responses.mjs';
import { WORDS_MARKER as CYCLE_MARKER } from '../o11-cycle.mjs';

const SHA = 'a'.repeat(64);
const TASK = 'b'.repeat(32);
const WORDS = 'pode entregar, Joao 4471';
const OML = 'C:\\w\\.local\\snapshots\\Orders-20261003101010.oml';
const ODC_OML = 'C:\\odc\\snapshots\\Orders-' + SHA + '.oml';
// Tools that write: none of them may ever be a success `next`.
const WRITES = ['o11_deliver', 'o11_publish', 'o11_access', 'o11_environment', 'o11_data', 'studio_deliver', 'studio_merge', 'studio_publish',
  'studio_create', 'studio_create_app', 'studio_authorize', 'studio_data_insert', 'studio_data_update', 'studio_data_delete', 'studio_close', 'studio_command',
  'studio_dismiss_dialog', 'studio_refresh_references', 'studio_open', 'studio_attach', 'odc_write', 'odc_portal_write', 'odc_deploy',
  'odc_configurations', 'odc_asset_delete', 'odc_external_db_connection', 'ssam_connect', 'propose', 'continue'];
const allNext = [];
const next = (tool, args, value) => { const n = successNext(tool, args, value); if (n) allNext.push(...n); return n; };

test('o11_studio snapshot: the map of the capture, then o11_inspect with the hash; other commands have no next', () => {
  const shot = { ok: true, path: OML, sha256: SHA, module: 'Orders', key: 'k', environment: 'h.test', snapshotId: 's1' };
  assert.deepEqual(next('o11_studio', { command: 'snapshot', args: { module: 'Orders' } }, shot), [
    { tool: 'ssam_map', arguments: { lane: 'o11', target: OML, expectedSourceSha256: SHA } },
    { tool: 'o11_inspect', arguments: { oml: OML, expectedSourceSha256: SHA } }]);
  for (const command of ['status', 'wait', 'errors', 'windows', 'open-module', 'login', 'dismiss-dialog'])
    assert.equal(next('o11_studio', { command }, { ok: true, path: OML, sha256: SHA }), null, command);
  // Not a capture: no next.
  assert.equal(next('o11_studio', { command: 'snapshot' }, { ok: true, path: 'C:\\x\\a.txt', sha256: SHA }), null);
});

test('studio_snapshot and studio_latest: ssam_map then studio_inspect {target, expectedSourceSha256}', () => {
  const expected = [{ tool: 'ssam_map', arguments: { lane: 'odc', target: ODC_OML, expectedSourceSha256: SHA } },
    { tool: 'studio_inspect', arguments: { target: ODC_OML, expectedSourceSha256: SHA } }];
  const snapshot = { ok: true, module: 'Orders', moduleKey: 'k', sha256: SHA, path: ODC_OML, capturedAt: 't', modified: false, host: 'h', dependencies: [] };
  assert.deepEqual(next('studio_snapshot', { module: 'Orders', pid: 7 }, snapshot), expected);
  assert.deepEqual(next('studio_latest', { module: 'Orders' }, { ok: true, module: 'Orders', revision: 3, sha256: SHA, path: ODC_OML }), expected);
});

test('o11_environment download: the map of the downloaded module; inventory and writes have no next', () => {
  assert.deepEqual(next('o11_environment', { action: 'download', host: 'h', module: 'Orders' }, { ok: true, file: OML, module: 'Orders', key: 'k', versionId: 1 }),
    [{ tool: 'ssam_map', arguments: { lane: 'o11', target: OML } }]);
  assert.equal(next('o11_environment', { action: 'inventory', host: 'h' }, { ok: true, host: 'h', file: 'C:\\x\\inventory.json' }), null);
  assert.equal(next('o11_environment', { action: 'create-module', host: 'h' }, { ok: true, file: OML }), null);
});

test('o11_inspect and studio_inspect: a summarized answer reads its navigation; a paged list its next page, without defaults', () => {
  const summarized = { ok: true, file: OML, out: 'C:\\o.json', inline: false, sourceSha256: SHA, summary: { schema: 's', nodes: 900, count: 200, returned: 60, nextOffset: 60, targets: [] },
    navigation: { target: OML, expectedSourceSha256: SHA }, hint: 'Use navigation.target' };
  // The schema fills the defaults in: they never reach the next call.
  const args = { oml: OML, kind: 'MobileScreen', offset: 0, usages: false, includeInternal: false, depth: 3, max: 60, all: false, full: false, cold: false, budget: 60000 };
  assert.deepEqual(next('o11_inspect', args, summarized), [
    { tool: 'o11_inspect', arguments: { oml: OML, path: KEY_MARKER, expectedSourceSha256: SHA }, why: 'troque <key> por uma reference de summary.targets' },
    { tool: 'o11_inspect', arguments: { oml: OML, kind: 'MobileScreen', offset: 60, expectedSourceSha256: SHA } }]);
  // ODC: target instead of oml; a module name in the call becomes the captured file.
  const odc = { ...summarized, file: ODC_OML, navigation: { target: ODC_OML, expectedSourceSha256: SHA }, summary: { schema: 's', nodes: 900 } };
  assert.deepEqual(next('studio_inspect', { target: 'Orders', path: 'MobileScreen:Home', depth: 6 }, odc),
    [{ tool: 'studio_inspect', arguments: { target: ODC_OML, path: KEY_MARKER, expectedSourceSha256: SHA }, why: 'troque <key> por uma reference de summary.targets' }]);
  // Inline list with more pages: only the next page; inline tree: nothing.
  assert.deepEqual(next('studio_inspect', { target: ODC_OML, name: 'Quote', max: 10 }, { ok: true, file: ODC_OML, inline: true, sourceSha256: SHA, count: 30, returned: 10, nextOffset: 10, entries: [] }),
    [{ tool: 'studio_inspect', arguments: { target: ODC_OML, name: 'Quote', max: 10, offset: 10, expectedSourceSha256: SHA } }]);
  assert.equal(next('o11_inspect', { oml: OML, path: '@k' }, { ok: true, file: OML, inline: true, sourceSha256: SHA, tree: { kind: 'X', key: 'k' } }), null);
  assert.equal(next('o11_inspect', { oml: OML }, { ok: true, file: OML, inline: true, sourceSha256: SHA, count: 3, nextOffset: null }), null);
  // Without the hash there is no guarded read: nothing.
  assert.equal(next('o11_inspect', { oml: OML }, { ...summarized, sourceSha256: undefined, navigation: { target: OML } }), null);
});

// open and refresh used to answer studio_snapshot as `next`: a step the session took before every delivery although
// studio_deliver captures the live module itself (QuizLive, 2026-10-05). The next read is the module map.
test('the ODC cycle: open and refresh -> the module map; build/manifest -> check-base; check-base -> preview; preview and merge stop', () => {
  assert.deepEqual(next('studio_open', { module: 'Orders', pid: 42 }, { ok: true, alreadyOpen: true, module: 'Orders' }), [{ tool: 'ssam_map', arguments: { lane: 'odc', target: 'Orders', pid: 42 } }]);
  assert.deepEqual(next('studio_refresh_references', { module: 'Orders' }, { ok: true }), [{ tool: 'ssam_map', arguments: { lane: 'odc', target: 'Orders' } }]);
  const manifest = 'C:\\odc\\lab\\07-x\\manifest.json';
  assert.deepEqual(next('studio_build', { feature: 'F', base: ODC_OML, sha: SHA, output: 'o' }, { ok: true, manifest, output: [] }), [{ tool: 'studio_check_base', arguments: { manifest } }]);
  assert.equal(next('studio_build', { feature: 'F', output: 'o', newModule: true }, { ok: true, manifest }), null, 'a new module goes to studio_authorize create: a write');
  assert.deepEqual(next('studio_manifest', { base: 'b', candidate: 'c', output: 'o', feature: 'F', owners: ['A'], changes: ['B'] }, { ok: true, manifest }), [{ tool: 'studio_check_base', arguments: { manifest } }]);
  assert.deepEqual(next('studio_check_base', { manifest, pid: 9 }, { ok: true, module: 'Orders', gate: 'none' }), [{ tool: 'studio_preview', arguments: { manifest, pid: 9 } }]);
  for (const tool of ['studio_preview', 'studio_merge', 'studio_authorize', 'studio_publish', 'studio_create'])
    assert.equal(next(tool, { manifest }, { ok: true, manifest, module: 'Orders' }), null, tool);
});

test('ssam_map keeps its own continuations: no next, same object', () => {
  const map = { ok: true, lane: 'o11', file: OML, sourceSha256: SHA, entries: [], continuations: { inspect: { tool: 'o11_inspect', arguments: { oml: OML, path: '@<key>', expectedSourceSha256: SHA } }, next: null } };
  assert.equal(addNextSteps('ssam_map', { lane: 'o11', target: OML }, map), map);
});

test('a write is never a success next, whatever the answer carries', () => {
  const rich = { ok: true, path: OML, sha256: SHA, file: OML, manifest: 'C:\\m\\manifest.json', module: 'Orders', taskId: TASK, navigation: { target: OML, expectedSourceSha256: SHA }, sourceSha256: SHA };
  for (const tool of WRITES.filter(t => !['studio_open', 'studio_refresh_references', 'o11_environment'].includes(t)))
    assert.equal(successNext(tool, { module: 'Orders', authorize: WORDS }, rich), null, tool);
  // The three that have a next only name reads (open/refresh -> the module map, download -> map).
  for (const tool of ['studio_open', 'studio_refresh_references']) for (const c of successNext(tool, { module: 'Orders' }, rich)) assert.equal(c.tool, 'ssam_map');
  for (const action of ['create-app', 'add-modules', 'create-module', 'update-app', 'delete-app', 'refresh-refs', 'set-user-provider'])
    assert.equal(successNext('o11_environment', { action, authorize: WORDS }, rich), null, action);
  // Every next produced by the tests of this file is a read.
  assert.ok(allNext.length >= 15);
  for (const c of allNext) { assert.ok(READS.has(c.tool), c.tool); assert.ok(!WRITES.includes(c.tool), c.tool); }
});

test('refusal: an existing continuation stays; a missing one comes from the code; unknown codes add nothing', () => {
  const given = { ok: false, code: 'O11_NOT_CONNECTED', error: 'x', continuation: { tool: 'ssam_connect', arguments: { lane: 'o11' }, why: 'w' } };
  assert.equal(addNextSteps('o11_studio', { command: 'status' }, given), given);
  const cases = [
    ['o11_inspect', {}, { ok: false, code: 'BRIDGE_TIMEOUT', method: 'snapshot_module' }, { tool: 'o11_studio', arguments: { command: 'status' } }],
    ['o11_deliver', { module: 'M' }, { ok: false, code: 'STUDIO_NOT_SELECTED', error: 'x' }, { tool: 'ssam_connect', arguments: { lane: 'o11' } }],
    ['o11_studio', { command: 'snapshot' }, { ok: false, code: 'BRIDGE_NOT_LISTENING', error: 'x' }, { tool: 'ssam_connect', arguments: { lane: 'o11' } }],
    ['o11_publish', { module: 'M' }, { ok: false, code: 'DIALOG_BLOCKING' }, { tool: 'o11_studio', arguments: { command: 'wait', args: { condition: 'no-dialogs' } } }],
    ['o11_inspect', { oml: OML }, { ok: false, code: 'O11_READER_UNAVAILABLE', error: 'x' }, { tool: 'ssam_doctor', arguments: { lane: 'o11' } }],
    ['ssam_reference', { lane: 'odc', kind: 'api' }, { ok: false, code: 'CLI_NOT_BUILT', error: 'x' }, { tool: 'ssam_doctor', arguments: { lane: 'odc' } }],
    // The code nested in error (the portal access layer) counts too.
    ['o11_data', {}, { ok: false, error: { code: 'BRIDGE_TIMEOUT', message: 'm' } }, { tool: 'o11_studio', arguments: { command: 'status' } }],
  ];
  for (const [tool, args, value, expected] of cases) {
    const shaped = addNextSteps(tool, args, value);
    assert.deepEqual({ tool: shaped.continuation.tool, arguments: shaped.continuation.arguments }, expected, tool + ' ' + JSON.stringify(value));
    assert.ok(shaped.continuation.why, 'every continuation says why');
    assert.notEqual(shaped, value); assert.equal(value.continuation, undefined, 'input not mutated');
  }
  // O11 continuations never answer an ODC tool; unknown or absent codes add nothing (never invented).
  for (const [tool, value] of [['studio_status', { ok: false, code: 'BRIDGE_TIMEOUT' }], ['studio_snapshot', { ok: false, code: 'DIALOG_BLOCKING' }],
    ['o11_studio', { ok: false, code: 'BAD_ARGS', error: 'x' }], ['o11_inspect', { ok: false, error: 'boom' }], ['ssam_map', { ok: false, lane: 'o11', error: 'Snapshot content changed' }]])
    assert.equal(addNextSteps(tool, {}, value), value, tool);
});

test('o11_deliver refused by validation: the corrected job with closePrevious and the words marker, never the words', () => {
  const args = { module: 'Orders_CS', job: { ops: [{ op: 'rename' }] }, checks: ['Home'], until: 'merge', authorize: WORDS };
  const refused = { ok: false, outcome: 'refused', code: 'VALIDATION_REFUSED', stage: 'apply', taskId: TASK, error: 'Job rejected', messages: ['E1'] };
  const c = refusalContinuation('o11_deliver', args, refused);
  assert.deepEqual(c.arguments, { module: 'Orders_CS', job: JOB_MARKER, checks: ['Home'], closePrevious: TASK, authorize: WORDS_MARKER });
  assert.equal(c.tool, 'o11_deliver'); assert.match(c.why, /marcador/);
  assert.equal(WORDS_MARKER, CYCLE_MARKER, 'the same marker o11_deliver refuses as words');
  assert.doesNotMatch(JSON.stringify(c), /Joao 4471/);
  // until=apply: validate again, no task to close.
  assert.deepEqual(refusalContinuation('o11_deliver', { ...args, until: 'apply' }, { ok: false, valid: false, code: 'VALIDATION_REFUSED', stage: 'apply', error: 'x' }).arguments,
    { module: 'Orders_CS', job: JOB_MARKER, checks: ['Home'], until: 'apply', authorize: WORDS_MARKER });
  // A merge kept for review, a call without module, or no taskId: the person or the model decides; nothing is invented.
  assert.equal(refusalContinuation('o11_deliver', args, { ...refused, merged: true }), null);
  assert.equal(refusalContinuation('o11_deliver', { resume: TASK, authorize: WORDS }, refused), null);
  assert.equal(refusalContinuation('o11_deliver', args, { ...refused, taskId: null }), null);
  // The same code on another tool is not a delivery.
  assert.equal(refusalContinuation('ssam_job', args, refused), null);
  // The kernel's own continuation (the task that holds the module) is kept as it is.
  const held = { ...refused, continuation: { tool: 'o11_deliver', arguments: { resume: TASK }, why: 'r' } };
  assert.equal(addNextSteps('o11_deliver', args, held), held);
});

test('o11_deliver refusal that names its job: the continuation is a patch over it (basedOn), never the whole job again', () => {
  const job = 'C:\\lane\\.local\\jobs\\inline\\a.json';
  const args = { module: 'Orders_CS', job: { ops: [{ op: 'rename' }] }, authorize: WORDS };
  const refused = { ok: false, outcome: 'refused', code: 'VALIDATION_REFUSED', taskId: TASK, error: 'Job rejected', job, jobSha256: SHA, failedOp: 2 };
  const c = refusalContinuation('o11_deliver', args, refused);
  assert.deepEqual(c.arguments, { module: 'Orders_CS', patch: [{ op: 'replace', path: '/ops/2/<campo>', value: '<valor corrigido>' }],
    basedOn: { job, sha256: SHA }, closePrevious: TASK, authorize: WORDS_MARKER });
  assert.equal(c.arguments.job, undefined); assert.match(c.why, /sem reenviar o job inteiro/);
  // Without failedOp the index is a marker; until=apply validates the patch again, no task to close.
  const { failedOp: _f, ...unnamed } = refused;
  assert.equal(refusalContinuation('o11_deliver', { ...args, until: 'apply' }, { ...unnamed, stage: 'apply' }).arguments.patch[0].path, '/ops/<i>/<campo>');
  // A job without a valid sha256 cannot be a base: the whole corrected job, as before.
  assert.equal(refusalContinuation('o11_deliver', args, { ...refused, jobSha256: 'x' }).arguments.job, JOB_MARKER);
});

test('a real delivery refused by the headless validation (the kernel records stage "apply") is delivered again with closePrevious', () => {
  // Delivery.cs: stage = "apply", "job rejected by validation contract; merge was not attempted"; deliverOutcome keeps it.
  const job = 'C:\\lane\\.local\\jobs\\inline\\a.json';
  const refused = { ok: false, outcome: 'refused', code: 'VALIDATION_REFUSED', stage: 'apply', taskId: TASK, error: 'job rejected by validation contract; merge was not attempted', job, jobSha256: SHA };
  for (const until of [undefined, 'merge']) {
    const c = refusalContinuation('o11_deliver', { module: 'Orders', job, ...(until ? { until } : {}), authorize: WORDS }, refused);
    assert.deepEqual(c.arguments, { module: 'Orders', patch: [{ op: 'replace', path: '/ops/<i>/<campo>', value: '<valor corrigido>' }], basedOn: { job, sha256: SHA },
      closePrevious: TASK, authorize: WORDS_MARKER }, String(until));
    assert.equal(c.arguments.until, undefined, 'never only a validation after a real delivery');
  }
  // Only a call made with until=apply validates again.
  assert.equal(refusalContinuation('o11_deliver', { module: 'Orders', job, until: 'apply', authorize: WORDS }, { ...refused, taskId: undefined, valid: false }).arguments.until, 'apply');
});

test('the patch of an array job is at /<i>/...: from the refusal (jobShape) or the inline array of the call', () => {
  const job = 'C:\\lane\\.local\\jobs\\inline\\b.json';
  const refused = { ok: false, outcome: 'refused', code: 'VALIDATION_REFUSED', stage: 'apply', taskId: TASK, error: 'x', job, jobSha256: SHA, failedOp: 0 };
  const pathOf = (input, value) => refusalContinuation('o11_deliver', { module: 'Orders', authorize: WORDS, ...input }, value).arguments.patch[0].path;
  assert.equal(pathOf({ job }, { ...refused, jobShape: 'array' }), '/0/<campo>');
  assert.equal(pathOf({ job: [{ op: 'rename', name: 'X' }] }, refused), '/0/<campo>');
  const { failedOp: _f, ...unnamed } = refused;
  assert.equal(pathOf({ job }, { ...unnamed, jobShape: 'array' }), '/<i>/<campo>');
  assert.equal(pathOf({ job: { ops: [{ op: 'rename' }] } }, refused), '/ops/0/<campo>');
  assert.equal(pathOf({ patch: [{ op: 'remove', path: '/0' }], basedOn: { job, sha256: SHA } }, refused), '/ops/0/<campo>', 'a patch call: only the refusal names the shape');
});

test('ODC gates: base_drift -> a new snapshot of the module; studio_busy -> studio_status; without the module nothing', () => {
  const drift = { ok: false, module: 'Orders', baseSha256: SHA, gate: 'base_drift', note: 'Open module differs' };
  assert.deepEqual(refusalContinuation('studio_check_base', { manifest: 'm', pid: 3 }, drift).arguments, { module: 'Orders', pid: 3 });
  assert.equal(refusalContinuation('studio_check_base', { manifest: 'm' }, drift).tool, 'studio_snapshot');
  assert.equal(refusalContinuation('studio_merge', { manifest: 'm' }, { ok: false, gate: 'base_drift', error: 'x' }), null);
  assert.equal(refusalContinuation('studio_deliver', { feature: 'F' }, { ...drift }), null, 'studio_deliver snapshots again itself');
  // An edit in the Studio between the capture and the merge of a job delivery: the same call again, which captures anew.
  const call = { feature: 'F', module: 'Orders', job: 'C:\\jobs\\j.json', owners: ['A'], changes: ['B'] };
  const again = refusalContinuation('studio_deliver', call, { ok: false, failed: 'check-base', gate: 'base_drift', error: 'Open module differs' });
  assert.deepEqual([again.tool, again.arguments], ['studio_deliver', call]); assert.match(again.why, /nada foi mesclado/);
  // The refused attempt claimed its output directory (evidence is never overwritten): the repeat takes a new one.
  const claimed = refusalContinuation('studio_deliver', { ...call, output: 'lab/x' }, { ok: false, failed: 'check-base', gate: 'base_drift', error: 'Open module differs' });
  assert.deepEqual(claimed.arguments, call);
  const busy = refusalContinuation('studio_merge', { manifest: 'm' }, { ok: false, outcome: 'uncertain', gate: 'studio_busy', error: 'still running' });
  assert.deepEqual([busy.tool, busy.arguments], ['studio_status', {}]);
  assert.equal(refusalContinuation('o11_studio', {}, { ok: false, gate: 'studio_busy' }), null, 'ODC gates only on the ODC lane');
});

test('the user\'s words never reach a next or a continuation', () => {
  // A value that carries the words (a module named after them, contrived) loses the call instead of echoing them.
  assert.equal(successNext('studio_open', { module: WORDS, authorize: WORDS }, { ok: true, module: WORDS }), null);
  assert.equal(refusalContinuation('o11_deliver', { module: 'M', checks: [WORDS], authorize: WORDS }, { ok: false, code: 'VALIDATION_REFUSED', taskId: TASK }), null);
  assert.equal(successNext('studio_check_base', { manifest: 'C:\\' + WORDS + '\\manifest.json', words: WORDS }, { ok: true }), null);
  // The data request's authorization and studio_authorize's text are words too; a short word only as a whole argument.
  assert.equal(refusalContinuation('o11_data', { request: { authorization: 'status' } }, { ok: false, code: 'BRIDGE_TIMEOUT' }), null);
  assert.equal(refusalContinuation('o11_data', { request: { authorization: 'stat' } }, { ok: false, code: 'BRIDGE_TIMEOUT' }).tool, 'o11_studio');
  assert.equal(successNext('studio_check_base', { manifest: 'C:\\autorizo publicar\\m.json', text: 'autorizo publicar' }, { ok: true }).length, 1, 'text of a read is a filter');
  // Every scenario of this file with words in the call: never in the answer's steps.
  const scenarios = [['o11_studio', { command: 'snapshot', authorize: WORDS }, { ok: true, path: OML, sha256: SHA }],
    ['o11_deliver', { module: 'M', authorize: WORDS }, { ok: false, code: 'VALIDATION_REFUSED', taskId: TASK }],
    ['o11_publish', { module: 'M', authorize: WORDS }, { ok: false, code: 'DIALOG_BLOCKING' }],
    ['o11_access', { action: 'apply', words: WORDS }, { ok: false, code: 'STUDIO_NOT_SELECTED' }]];
  for (const [tool, args, value] of scenarios) assert.doesNotMatch(JSON.stringify(addNextSteps(tool, args, value)), /Joao 4471/, tool);
});

test('exact answers stay the whole text: entregue, publicado, fechada', () => {
  for (const [tool, result] of [['o11_deliver', 'entregue'], ['o11_publish', 'publicado'], ['o11_deliver', 'fechada'], ['studio_deliver', 'entregue']]) {
    const value = Object.freeze({ ok: true, result });
    assert.equal(addNextSteps(tool, { module: 'M', authorize: WORDS }, value), value);
    const reply = { content: [{ type: 'text', text: result }], structuredContent: value };
    if (tool !== 'studio_deliver') { const shaped = shapeToolResult(tool, { module: 'M', authorize: WORDS }, reply, { lane: 'o11' }); assert.equal(shaped, reply); assert.equal(shaped.content[0].text, result); }
  }
});

test('next stays small: at most two calls of 1 KB, nothing for an oversized path; a big answer grows by a few hundred bytes', () => {
  const long = 'C:\\' + 'x'.repeat(1200) + '.oml';
  assert.equal(successNext('studio_snapshot', { module: 'M' }, { ok: true, path: long, sha256: SHA }), null);
  const summary = { schema: 's', nodes: 5000, targets: Array.from({ length: 32 }, (_, i) => ({ kind: 'MobileScreen', name: 'S' + i, reference: '@k' + i, path: 'MobileScreen:S' + i })) };
  const big = { ok: true, file: OML, out: 'C:\\o.json', bytes: 900000, inline: false, sourceSha256: SHA, summary: { ...summary, nextOffset: 60 }, navigation: { target: OML, expectedSourceSha256: SHA }, hint: 'h' };
  const shaped = addNextSteps('o11_inspect', { oml: OML, kind: 'MobileScreen' }, big);
  assert.ok(shaped.next.length <= 2);
  for (const c of shaped.next) assert.ok(Buffer.byteLength(JSON.stringify(c)) <= 1024);
  const grown = Buffer.byteLength(JSON.stringify(shaped)) - Buffer.byteLength(JSON.stringify(big));
  assert.ok(grown < 600, 'grew ' + grown + ' bytes');
});

test('through shapeToolResult: the structured value and its text carry the same next; a refusal its continuation and isError', () => {
  const shot = { ok: true, path: OML, sha256: SHA, module: 'Orders', key: 'k', environment: null, snapshotId: null };
  const reply = shapeToolResult('o11_studio', { command: 'snapshot', args: { module: 'Orders' } }, { content: [{ type: 'text', text: JSON.stringify(shot) }], structuredContent: shot }, { lane: 'o11' });
  assert.equal(reply.structuredContent.next[0].tool, 'ssam_map');
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
  assert.equal(reply.isError, undefined);
  const refused = { ok: false, code: 'BRIDGE_TIMEOUT', method: 'snapshot_module', outcome: 'unknown' };
  const r = shapeToolResult('o11_inspect', { module: 'Orders' }, { content: [{ type: 'text', text: JSON.stringify(refused) }], structuredContent: refused, isError: true }, { lane: 'o11' });
  assert.equal(r.isError, true); assert.equal(r.structuredContent.continuation.tool, 'o11_studio');
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  // A JSON-text answer (no structuredContent): the text gets the next, structuredContent stays absent.
  const text = shapeToolResult('studio_snapshot', { module: 'Orders' }, { content: [{ type: 'text', text: JSON.stringify({ ok: true, path: ODC_OML, sha256: SHA }) }] });
  assert.equal(text.structuredContent, undefined); assert.equal(JSON.parse(text.content[0].text).next[1].tool, 'studio_inspect');
});
