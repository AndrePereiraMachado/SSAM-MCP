// S9 through the whole ssam server: ssam_code draft -> part -> write {draft} delivers with o11_deliver, whose build phase
// takes the candidate of the draft's joint check (the same model as the capture of the delivery): the kernel runs `deliver
// --prebuilt` and no `apply` at all, one apply fewer than the same write without a draft. When the module's capture has
// another model than the one the check ran on, the build applies as always and the answer says why. Fake bridge, fake CLI,
// fake check (with a candidate on disk as code-check.mjs keeps it); temporary folders only.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createBuildPool } from '../build-pool.mjs';
import { writeCall, normalizeCodeOps } from '../ssam-code.mjs';
import { CHECK_CANDIDATE } from '../code-check.mjs';
import { modelSha256 } from '../o11-capture-store.mjs';
import { anvilRoot, o11Lane } from '../workspace.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const words = 'pode entregar, Ana 0912';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const option = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const oml = (header, model) => { const head = Buffer.from(header); const length = Buffer.alloc(4); length.writeUInt32LE(head.length); return Buffer.concat([Buffer.from('OML'), length, head, Buffer.from(model)]); };
const flow = name => `/// ${name}.\nserver action ${name}\n  out Count: Integer\n  assign Count = 1\n  end\n`;
const valueOf = r => r.structuredContent ?? JSON.parse(r.content[0].text);

// The check of a set as code-check.mjs answers it on a local capture of `checkModel`: the job it applied (the kernel form,
// normalizeCodeOps), the candidate and the kernel's own result beside it, under the symbol key the draft keeps.
function fakeCheck(root, checkModel) {
  let n = 0;
  return async input => {
    const call = writeCall(input);
    const dir = path.join(root, 'checks', String(++n)); fs.mkdirSync(dir, { recursive: true });
    const job = path.join(dir, 'job.json'); fs.writeFileSync(job, JSON.stringify(normalizeCodeOps(call.arguments.job).job, null, 2));
    const base = path.join(dir, 'capture.oml'); fs.writeFileSync(base, oml('{check}', checkModel));
    const candidate = path.join(dir, 'candidate.oml'); fs.writeFileSync(candidate, oml('{candidate}', checkModel + '+job'));
    const result = path.join(dir, 'candidate.kernel-result.json');
    fs.writeFileSync(result, JSON.stringify({ isValid: true, accepted: true, sources: [{ path: job, sha256: sha(fs.readFileSync(job)) }], provenance: { kernelSha256: 'k' } }));
    const capture = { path: base, sha256: sha(fs.readFileSync(base)), model: modelSha256(base) };
    return { ok: true, lane: 'o11', module: input.module, action: 'check', capture, valid: true, job, jobSha256: sha(fs.readFileSync(job)),
      [CHECK_CANDIDATE]: { path: candidate, sha256: sha(fs.readFileSync(candidate)), result, job, base, baseSha256: capture.sha256, baseModelSha256: capture.model, producers: {}, via: 'worker' } };
  };
}

async function serve(t, { model = 'ORDERS-MODEL', checkModel = model } = {}) {
  const root = fs.mkdtempSync(path.join(isolatedProfile, 'draft-candidate-'));
  const log = { applies: 0, delivers: [] };
  const bridge = { ok: async (method, params = {}) => {
    if (method === 'list_open_modules') return { modules: [{ name: 'Orders', key: 'K-Orders', hasESpace: true }] };
    if (method === 'snapshot_module' && params.module_key) { fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, oml('{window}', model)); return { key: params.module_key, path: params.path }; }
    throw Object.assign(new Error('not in this test: ' + method), { code: 'BRIDGE_NOT_LISTENING' });
  } };
  let tasks = 0;
  const runAnvil = fakeAnvil({
    apply: async args => {
      log.applies++;
      const out = option(args, '--out');
      fs.writeFileSync(out, 'candidate'); fs.writeFileSync(out.replace(/\.oml$/, '.result.json'), JSON.stringify({ isValid: true, accepted: true }));
      return { ok: true, command: 'apply', data: { isValid: true, accepted: true } };
    },
    deliver: async args => {
      const prebuilt = option(args, '--prebuilt');
      log.delivers.push({ prebuilt, manifest: prebuilt ? JSON.parse(fs.readFileSync(prebuilt, 'utf8')) : null });
      const taskId = String(++tasks).padStart(32, '0');
      const work = path.join(option(args, '--work'), 'deliver', taskId); fs.mkdirSync(work, { recursive: true });
      return { ok: true, command: 'deliver', data: { delivered: true, taskId, work, writeState: 'applied', module: 'Orders', apply: { isValid: true, accepted: true, ...(prebuilt ? { prebuilt: { reused: true } } : {}) } } };
    },
  });
  const server = await createSsamServer({ odc: false, deps: { codeCheck: fakeCheck(root, checkModel),
    cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil, assertSelected: async () => {}, tasksDir: path.join(root, 'tasks'), bridge, lastPublication: async () => null,
      lock: { connection: () => null }, buildPool: createBuildPool({ dir: path.join(root, 'pool'), size: 1, queueMs: 10000 }), buildRunner: () => runAnvil },
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'draft-candidate', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const drafts = [];
  t.after(async () => {
    await client.close(); await server.close();
    // ssam_code keeps its drafts in the lane's work folder of this checkout: only the drafts of this test go
    for (const id of drafts) fs.rmSync(path.join(o11LaneOf(o11Lane.lane, { root: anvilRoot }).work, 'drafts', id), { recursive: true, force: true });
  });
  const call = async args => valueOf(await client.callTool({ name: 'ssam_code', arguments: args }));
  return { call, log, drafts, runAnvil };
}

async function draftAndWrite(s) {
  const opened = await s.call({ lane: 'o11', action: 'draft', module: 'Orders' });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  s.drafts.push(opened.draft.id);
  for (const name of ['CloseOrder', 'ReopenOrder']) {
    const part = await s.call({ lane: 'o11', action: 'part', draft: opened.draft.id, part: 'logic', text: flow(name) });
    assert.equal(part.accepted, true, JSON.stringify(part));
  }
  return s.call({ lane: 'o11', action: 'write', draft: opened.draft.id, authorize: words });
}

test('S9 server: a draft whose joint check ran on the model of the delivery\'s capture is delivered with the checked candidate and no apply', async t => {
  const plain = await serve(t);
  const direct = await plain.call({ lane: 'o11', action: 'write', module: 'Orders', part: 'logic', text: flow('CloseOrder') + '\n' + flow('ReopenOrder'), authorize: words });
  assert.equal(direct.result, 'delivered', JSON.stringify(direct));
  assert.equal(plain.log.applies, 1, 'the same write without a draft: the build phase applies once');

  const s = await serve(t);
  const written = await draftAndWrite(s);
  assert.equal(written.result, 'delivered', JSON.stringify(written));
  assert.equal(s.log.applies, 0, 'one apply fewer: the checked candidate is the build');
  assert.equal(s.log.delivers.length, 1);
  const { manifest } = s.log.delivers[0];
  assert.ok(manifest && manifest.checked, 'deliver --prebuilt with the manifest of the checked candidate');
  assert.equal(manifest.baseModelSha256, sha(Buffer.from('ORDERS-MODEL')));
  assert.deepEqual(written.draft.prebuilt.candidate, { reused: true });
  assert.equal(written.draft.prebuilt.reused, true, 'the write reused the check of the set, as before');
});

test('S9 server: the module changed after the check: the delivery builds again and says prebuilt.candidate {reused:false, reason}', async t => {
  const s = await serve(t, { model: 'ORDERS-MODEL-2', checkModel: 'ORDERS-MODEL' });
  const written = await draftAndWrite(s);
  assert.equal(written.result, 'delivered', JSON.stringify(written));
  assert.equal(s.log.applies, 1, 'the build applied on the capture the delivery took');
  assert.equal(s.log.delivers[0].manifest.checked, undefined, 'never the candidate of another base');
  assert.equal(s.log.delivers[0].manifest.checkedCandidate.reason, 'capture-changed');
  assert.deepEqual(written.draft.prebuilt.candidate, { reused: false, reason: 'capture-changed' });
});
