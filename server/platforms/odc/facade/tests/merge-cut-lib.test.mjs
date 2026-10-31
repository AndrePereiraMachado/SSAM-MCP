// The wiring of the check of a cut in lib.mjs: studio() and deliver(), real, in a hosted context, with a fake agent behind the executor.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWithExecutor, prepareWorkspace } from '../executor.mjs';
import { o11Lane } from '../workspace.mjs';
import * as lib from '../lib.mjs';
import { markCutRead, readCut } from '../merge-cut.mjs';

const sha = text => createHash('sha256').update(text).digest('hex').toUpperCase();
const ID = { moduleKey: 'K', host: 'h.test' };
class FakeStudio {
  constructor(snapshots, { namesPid = true } = {}) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.module = 'base'; this.merges = []; this.mode = 'ok'; this.pid = 4242; this.pids = [4242]; this.namesPid = namesPid; this.snapshots = snapshots; }
  relayPort() { return null; } o11Connection() { return null; } async close() {}
  async call(kind, params = {}) {
    if (kind === 'studio.processes') return { processes: this.pids.map(pid => ({ pid })) };
    if (kind !== 'odc.pipe') throw Object.assign(new Error('unexpected ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
    const [command, argument] = params.args;
    const open = sha(this.module);
    if (command === 'status') return { line: JSON.stringify({ ok: true, pid: this.pid, modules: [{ name: 'M', key: 'K', host: 'h.test' }] }) };
    if (command === 'snapshot') {
      const file = path.join(this.snapshots, 'M-' + open + '.oml');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, this.module);
      return { line: JSON.stringify({ ok: true, module: 'M', moduleKey: 'K', host: 'h.test', developerId: 'd', sha256: open, path: file, ...(this.namesPid ? { pid: this.pid } : {}) }) };
    }
    if (command !== 'merge') return { line: JSON.stringify({ ok: true }) };
    const manifest = JSON.parse(fs.readFileSync(argument, 'utf8').replace(/^﻿/, ''));
    this.merges.push({ base: manifest.baseSha256, expected: manifest.expectedBaseSha256 ?? null, afterCut: manifest.afterCut ?? null });
    fs.mkdirSync(manifest.evidenceDir, { recursive: true });
    if (manifest.expectedBaseSha256 && manifest.expectedBaseSha256 !== open) return { line: JSON.stringify({ ok: false, outcome: 'native_error', error: 'MODULE_NOT_AT_BASE: not the module checked; nothing was merged.' }) };
    if (manifest.baseSha256 !== open) return { line: JSON.stringify({ ok: false, outcome: 'gate_refused', gate: 'base_drift', error: 'Open M differs from the captured base; capture a new snapshot and rebuild the candidate.' }) };
    fs.writeFileSync(path.join(manifest.evidenceDir, 'merge-started.json'), JSON.stringify({ at: new Date().toISOString(), pid: this.pid, module: 'M' }));
    this.module += '+merged';
    if (this.mode === 'cut') { this.mode = 'ok'; throw Object.assign(new Error('the answer was lost'), { code: 'PIPE_REPLY_TIMEOUT', sent: true }); }
    if (this.mode === 'cut-transport') { this.mode = 'ok'; throw Object.assign(new Error('broke'), { code: 'PIPE_TRANSPORT', sent: true }); }
    const now = sha(this.module);
    fs.writeFileSync(path.join(manifest.evidenceDir, 'receipt.json'), JSON.stringify({ ok: true, merged: true, strictlyEqual: true, sha256: now }));
    return { line: JSON.stringify({ ok: true, merged: true, strictlyEqual: true, equivalence: 'strict', sha256: now }) };
  }
}
const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', kernel: { odc: '1.7.30', odcBridge: 'v101', o11: '11.55.94' }, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function hosted(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(root, 'customers', tokenId);
  prepareWorkspace(workspace);
  const odc = path.join(workspace, 'odc');
  const executor = new FakeStudio(path.join(odc, 'snapshots'), options);
  return { odc, workspace, executor, context: { id: randomUUID(), hosted: true, tokenId, customer: 'C', lanes: ['odc'], workspace, agent, executor, o11: { lane: o11Lane.lane }, close: async () => {} } };
}
const kernelOf = () => ({ check: null, guide: null, cache: null, prefetch: () => {}, signatureCache: null, mergeOrder: null, reconcile: null,
  apply: async ({ output }) => { fs.mkdirSync(output, { recursive: true }); const file = path.join(output, 'c.oml'); fs.writeFileSync(file, 'candidate'); return { ok: true, candidate: file, receipt: 'r.json' }; },
  prepareManifest: async ({ base, output }) => { fs.mkdirSync(output, { recursive: true }); const manifest = path.join(output, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', feature: 'f', module: 'M', moduleKey: 'K', tenant: 'h.test', basePath: base, baseSha256: path.basename(base).replace(/^M-|\.oml$/g, ''), candidatePath: 'c', candidateSha256: 'X', evidenceDir: path.join(output, 'evidence') })); return { ok: true, manifest }; } });
const builder = async ([feature, base, baseSha, output]) => { fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ schema: 'odc3-manifest/1', feature, module: 'M', moduleKey: 'K', tenant: 'h.test', basePath: base, baseSha256: baseSha, candidatePath: 'c', candidateSha256: 'X', evidenceDir: path.join(output, 'evidence') }));
  return { ok: true }; };

test('N1, the job road: studio_merge by any path is refused over an unread cut; ws: paths too (G37)', async t => {
  const h = hosted(t);
  await runWithExecutor(h.context, async () => {
    const job = path.join(h.odc, 'job.json'); fs.writeFileSync(job, JSON.stringify({ ops: [] }));
    h.executor.mode = 'cut';
    const first = await lib.deliver({ feature: 'f', module: 'M', job, owners: ['O'], changes: ['C'], pid: 4242 }, { kernel: kernelOf(), fragmentPreview: r => r });
    assert.equal(first.outcome, 'uncertain');
    assert.equal(Object.keys(readCut(h.odc, ID).jobs).length, 1, 'the record is in <ws>/odc');
    const other = path.join(h.odc, 'lab', 'manual'); fs.mkdirSync(other, { recursive: true });
    const manual = path.join(other, 'manifest.json');
    fs.writeFileSync(manual, JSON.stringify({ schema: 'odc3-manifest/1', feature: 'x', module: 'M', moduleKey: 'K', tenant: 'h.test', basePath: 'b', baseSha256: 'OTHER', candidatePath: 'c', candidateSha256: 'X', evidenceDir: path.join(other, 'evidence') }));
    const merges = h.executor.merges.length;
    for (const argument of [manual, 'lab/manual/manifest.json', 'ws:odc/lab/manual/manifest.json']) {
      const refused = await lib.studio(['merge', argument], 4242);
      assert.equal(refused.code, 'MODULE_NOT_AT_BASE', argument + ': ' + JSON.stringify(refused));
    }
    assert.equal(h.executor.merges.length, merges, 'none reached the bridge');
  });
});

test('G32: a capture that names no pid is stamped with the process the call reached', async t => {
  const h = hosted(t, { namesPid: false });
  await runWithExecutor(h.context, async () => {
    const capture = await lib.studio(['snapshot', 'M'], 4242);
    assert.equal(capture.pid, 4242);
  });
});

const go = () => lib.deliver({ feature: 'CsFeature', module: 'M', pid: 4242 }, { builder });

test('N2, G33, the C# road: a cut records its feature and base, and answers like the job road', async t => {
  const h = hosted(t);
  await runWithExecutor(h.context, async () => {
    h.executor.mode = 'cut';
    const cut = await go();
    assert.equal(cut.outcome, 'uncertain');
    assert.equal(cut.code, 'MERGE_TIMEOUT');
    assert.equal(cut.merged, null);
    assert.equal(cut.timeout.cutBy, 'client');
    assert.equal(cut.timeout.mergeStarted, true);
    assert.equal(cut.timeout.baseSha256.length, 64);
    assert.ok(cut.timeout.next.length >= 4);
    assert.equal(cut.continuation.tool, 'studio_status');
    assert.equal(Object.keys(readCut(h.odc, ID).jobs).length, 1);
    h.executor.mode = 'cut-transport';
  });
});

test('G33, the C# road: the same feature is refused over a module that moved, before a reading and after it, with the fields of the refusal', async t => {
  const h = hosted(t);
  await runWithExecutor(h.context, async () => {
    h.executor.mode = 'cut';
    await go();
    const merges = h.executor.merges.length;
    const refused = await go();
    assert.equal(refused.code, 'MODULE_NOT_AT_BASE', JSON.stringify(refused));
    assert.equal(refused.merged, null);
    assert.equal(refused.baseSha256.length, 64);
    assert.equal(refused.openSha256.length, 64);
    assert.equal(refused.continuation.arguments.reconcile, true);
    assert.equal(h.executor.merges.length, merges, 'nothing reached the bridge');
    markCutRead(h.odc, ID);
    const module = h.executor.module;
    const after = await go();
    assert.equal(after.code, 'MODULE_NOT_AT_BASE', 'a reading frees new work, never this feature');
    assert.equal(h.executor.module, module, 'not applied again');
  });
});

test('G33, the C# road: over its own base the feature goes once, with the sha for the bridge, and never again', async t => {
  const h = hosted(t);
  await runWithExecutor(h.context, async () => {
    h.executor.mode = 'cut';
    await go();
    h.executor.module = 'base';
    const merges = h.executor.merges.length;
    const again = await go();
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(h.executor.merges[merges].expected, sha('base'));
    assert.equal(h.executor.merges[merges].afterCut, true);
    assert.equal((await go()).code, 'MODULE_NOT_AT_BASE');
  });
});

test('G33, the C# road: another feature goes after a reading; a known ending leaves no record; an unreadable one refuses', async t => {
  const h = hosted(t);
  await runWithExecutor(h.context, async () => {
    const clean = await go();
    assert.equal(clean.ok, true);
    assert.equal(readCut(h.odc, ID), null, 'a clean merge leaves no record');
    h.executor.mode = 'cut';
    await lib.deliver({ feature: 'Second', module: 'M', pid: 4242 }, { builder });
    const before = await go();
    assert.equal(before.code, 'MODULE_NOT_AT_BASE', 'before a reading');
    markCutRead(h.odc, ID);
    assert.equal((await go()).ok, true, 'after it');
    const dir = path.join(h.odc, 'journal', 'merge-cuts');
    fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{not json');
    const refused = await go();
    assert.equal(refused.code, 'CUT_RECORD_UNREADABLE');
    assert.equal(refused.continuation.arguments.reconcile, true);
  });
});

test('G33, the C# road: a merge the bridge abandoned is merged:false and leaves no record; the record that cannot be written stops the merge', async t => {
  const h = hosted(t);
  await runWithExecutor(h.context, async () => {
    const call = h.executor.call.bind(h.executor);
    h.executor.call = async (kind, params) => {
      if (kind === 'odc.pipe' && params.args[0] === 'merge') {
        const manifest = JSON.parse(fs.readFileSync(params.args[1], 'utf8'));
        fs.mkdirSync(manifest.evidenceDir, { recursive: true });
        fs.writeFileSync(path.join(manifest.evidenceDir, 'not-started.json'), '{"executed":false}');
        throw Object.assign(new Error('the answer was lost'), { code: 'PIPE_REPLY_TIMEOUT', sent: true });
      }
      return call(kind, params);
    };
    const abandoned = await go();
    assert.equal(abandoned.code, 'MERGE_NOT_STARTED', JSON.stringify(abandoned));
    assert.equal(abandoned.merged, false);
    assert.equal(readCut(h.odc, ID), null);
    h.executor.call = call;
    fs.rmSync(path.join(h.odc, 'journal', 'merge-cuts'), { recursive: true, force: true });
    fs.mkdirSync(path.join(h.odc, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(h.odc, 'journal', 'merge-cuts'), 'a file where the folder goes');
    const merges = h.executor.merges.length;
    const stopped = await go();
    assert.equal(stopped.code, 'CUT_RECORD_NOT_WRITTEN', JSON.stringify(stopped));
    assert.equal(h.executor.merges.length, merges);
  });
});
