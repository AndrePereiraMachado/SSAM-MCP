import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { offersPreferForeign, preferredNote, preparePreferForeign } from '../odc-prefer-foreign.mjs';
import { phasedDeliver, phasedStudio } from '../odc-build-phase.mjs';
import { runWithExecutor } from '../executor.mjs';

test('ODC prefer requires the hello capability and the packaged bridge together', () => {
  for (const version of ['v106', 'v107', 'v108', 'v109', null]) {
    for (const declared of [false, true]) {
      const link = { info: () => ({ connected: true, instance: 'test', connectedAt: 1,
        pack: { odcBridge: version }, agentOdcCommands: declared ? ['merge:prefer-foreign'] : [] }) };
      assert.equal(offersPreferForeign(link), declared && ['v108', 'v109'].includes(version));
    }
  }
});

test('ODC prefer manifest, unreadable fallback and no concurrent BASE_DRIFT redo', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefer-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'manifest.json');
  const agent = { info: () => ({ connected: true, connectedAt: 1, pack: { odcBridge: 'v108' }, agentOdcCommands: ['merge:prefer-foreign'] }) };
  fs.writeFileSync(file, '{invalid');
  assert.equal(preparePreferForeign(file, agent), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
  fs.writeFileSync(file, '{}');
  let calls = 0;
  await runWithExecutor({ hosted: true, agent, executor: { call: async () => ({}) } }, async () => {
    const studio = phasedStudio(async () => ({ ok: false, code: 'BASE_DRIFT', failed: 'merge', merged: false }));
    const value = await phasedDeliver({}, {}, { deliver: async () => { calls++; return studio(['merge', file]); } });
    assert.equal(value.code, 'BASE_DRIFT');
  });
  assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).preferForeign, true);
  calls = 0;
  await runWithExecutor({ hosted: true, agent, executor: { call: async () => ({}) } }, async () => {
    const studio = phasedStudio(async () => ({ ok: false, code: 'BASE_DRIFT', failed: 'merge', merged: false, preferForeign: false, preferForeignUnavailable: 'missing member' }));
    await phasedDeliver({}, {}, { deliver: async () => { calls++; return calls === 1 ? studio(['merge', file]) : { ok: true }; } });
  });
  assert.equal(calls, 2, 'a bridge missing a native member keeps the old retry');
});

test('ODC optional offer failures never fail delivery or poison the connection cache', () => {
  let fail = true;
  const info = { connected: true, instance: 'one', connectedAt: 1, pack: { odcBridge: 'v108' }, agentOdcCommands: ['merge:prefer-foreign'] };
  const link = { info() { if (fail) throw Error('transport'); return info; } };
  assert.equal(offersPreferForeign(link), false);
  fail = false;
  assert.equal(offersPreferForeign(link), true);
  info.connectedAt = 2;
  info.agentOdcCommands = [];
  assert.equal(offersPreferForeign(link), false);
});

for (const failure of ['writeFileSync', 'renameSync']) {
  test(`ODC optional manifest ${failure} failure preserves the original bytes`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prefer-atomic-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'manifest.json');
    const bytes = Buffer.from('{ "module": "M", "baseSha256": "unchanged" }\n');
    fs.writeFileSync(file, bytes);
    const real = fs[failure];
    t.mock.method(fs, failure, (...args) => {
      if (failure === 'writeFileSync') real(args[0], 'partial');
      throw Error('injected filesystem failure');
    });
    const link = { info: () => ({ connected: true, pack: { odcBridge: 'v109' }, agentOdcCommands: ['merge:prefer-foreign'] }) };
    assert.equal(preparePreferForeign(file, link), false);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(fs.readdirSync(dir), ['manifest.json']);
  });
}

test('ODC note lists conflicts before other edits and counts them separately', () => {
  const note = preferredNote({ conflicts: 1, others: 1, entries: [
    { conflict: false, element: 'Other', property: 'Name', user: 'old name', delivery: 'name' },
    { conflict: true, element: 'Action:A', property: 'Description', user: 'person value', delivery: 'delivery value' }
  ] });
  assert.ok(note.indexOf('Action:A') < note.indexOf('Other'));
  assert.match(note, /1 value\(s\).*1 other edit/);
  assert.match(note, /person value/);
  assert.match(note, /delivery value/);
});
