import './fixtures/isolated-profile.mjs';
// CX15 W4: the backup before deleting. The preview shows the plan per item (the published OML of every module that goes;
// an extension is not backed up yet); the execution downloads it BEFORE the reservation of that item; a failure sends
// nothing for the item and stops the rest; paths and sha256 land in the child receipt, the record and the answer.
// Offline: a fake download (the default runs the CLI through the Studio; here it fails closed with the CLI not built).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../service-center/client.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { CONFIRM_MIN_AGE_MS, backupDir, readOperation, readPreview, storeBackup } from '../destructive-operations.mjs';
import { CATALOG, FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock } from './fixtures/destructive-flow.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { anvilRoot, o11Lane } from '../workspace.mjs';

const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');

// ZZB One (2 eSpaces + 1 extension), ZZB Two (1 eSpace), ZZB Three (no module); the events log orders downloads and sends.
function environment({ failOn = null, defaultBackup = false } = {}) {
  const s = { dir: temp(), clock: fakeClock(), events: [],
    apps: [{ key: 'a-1', name: 'ZZB One' }, { key: 'a-2', name: 'ZZB Two' }, { key: 'a-3', name: 'ZZB Three' }],
    espaces: [{ key: 'm-1', name: 'ZZBOne_CS', app: 'a-1' }, { key: 'm-2', name: 'ZZBOne_UI', app: 'a-1' }, { key: 'm-3', name: 'ZZBTwo_CS', app: 'a-2' }],
    extensions: [{ key: 'x-1', name: 'ZZBOneExt', app: 'a-1' }] };
  s.root = path.join(s.dir, 'destructive');
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  const rows = list => list.filter(r => !r.gone).map(r => ({ Key: r.key, Name: r.name, ApplicationKey: r.app ?? null }));
  s.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => s.apps.filter(a => !a.gone).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: () => rows(s.espaces), ListExtensions: () => rows(s.extensions), GetConsumers: [],
    DeleteApplication: args => {
      if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [...s.espaces, ...s.extensions].filter(m => m.app === args.appKey).map(m => m.name) };
      s.events.push('send ' + args.appKey);
      for (const a of s.apps) if (a.key === args.appKey) a.gone = true;
      for (const m of [...s.espaces, ...s.extensions]) if (m.app === args.appKey) m.gone = true;
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: [] };
    } } });
  // The fake download: one OML per module, stored like the default does; failOn makes one module fail.
  s.backup = async (item, { operationId, host }) => {
    const files = [];
    for (const module of item.modules) {
      s.events.push('download ' + module);
      if (module === failOn) throw new Error('DOWNLOAD_FAILED: the published OML of ' + module + ' was not downloaded');
      const source = path.join(s.dir, module + '.oml'); fs.writeFileSync(source, 'PK oml of ' + module + ' on ' + host);
      files.push({ ...storeBackup({ operationId, name: module + '.oml', source, root: s.root }), module, versionId: 7 });
    }
    return { files };
  };
  s.run = argv => runServiceCenter([...argv, '--host=' + PERSONAL], { journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false,
    exports: s.dir, registry: REGISTRY, sleep: async () => {}, clock: s.clock, destructiveRoot: s.root, ...(defaultBackup ? {} : { backup: s.backup }) });
  s.confirm = async (words = 'sim, apaga os 3 ZZB') => {
    const preview = await s.run(['delete', '--prefix=ZZB']);
    s.clock.advance(CONFIRM_MIN_AGE_MS);
    return { preview, result: await s.run(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=' + words]) };
  };
  return s;
}

test('the preview shows the backup plan per item: the OML of each module; an extension and an empty app are named as not backed up', async () => {
  const s = environment();
  const preview = await s.run(['delete', '--prefix=ZZB']);
  const plan = Object.fromEntries(preview.items.map(i => [i.name, i.backup]));
  // The answer keeps the plan without the module list (the modules are the item's cascade); the preview file has both.
  assert.deepEqual(preview.items[0].cascade, ['ZZBOne_CS', 'ZZBOne_UI', 'ZZBOneExt']);
  const stored = Object.fromEntries(readPreview(preview.previewId, { root: s.root }).items.map(i => [i.name, i.backup]));
  assert.deepEqual(stored['ZZB One'].modules, ['ZZBOne_CS', 'ZZBOne_UI']);
  assert.deepEqual([plan['ZZB One'].possible, plan['ZZB One'].notBackedUp], [true, ['ZZBOneExt']]);
  assert.match(plan['ZZB One'].why, /extension/);
  assert.deepEqual([plan['ZZB Two'].possible, stored['ZZB Two'].modules], [true, ['ZZBTwo_CS']]);
  assert.deepEqual([plan['ZZB Three'].possible, plan['ZZB Three'].why], [false, 'the application has no module to back up']);
  assert.deepEqual(preview.backupPlan, { possible: ['ZZB One', 'ZZB Two'], notPossible: [{ name: 'ZZB Three', why: 'the application has no module to back up' }] });
  assert.deepEqual(s.events, [], 'a preview downloads nothing');
  // An extension alone: possible:false (to confirm: its .xif download as a backup), never a backup failure.
  const x = environment();
  const ext = await x.run(['delete', '--target=extension:ZZBOneExt']);
  assert.deepEqual([ext.items[0].backup.possible, ext.backupPlan.notPossible.map(n => n.name)], [false, ['ZZBOneExt']]);
});

test('one download per module, each BEFORE the send of its item; paths and sha256 in the child receipt, the record and the answer', async () => {
  const s = environment();
  const { preview, result } = await s.confirm();
  assert.equal(result.state, 'confirmed', JSON.stringify(result.problems ?? result.error));
  // The engine's order (no consumers: by name): One, Three (nothing to back up), Two.
  assert.deepEqual(s.events, ['download ZZBOne_CS', 'download ZZBOne_UI', 'send a-1', 'send a-3', 'download ZZBTwo_CS', 'send a-2']);
  // The answer: the folder and the count per item; each path and sha256 in the child receipt and the record.
  assert.deepEqual([result.backup.dir, result.backup.files, result.backup.items], [backupDir(preview.operationId, { root: s.root }), 3, [{ name: 'ZZB One', files: 2 }, { name: 'ZZB Two', files: 1 }]]);
  const recordFiles = readOperation(preview.operationId, { root: s.root }).items.flatMap(i => i.backup?.files ?? []);
  assert.deepEqual(recordFiles.map(f => f.module), ['ZZBOne_CS', 'ZZBOne_UI', 'ZZBTwo_CS']);
  for (const file of recordFiles) {
    assert.equal(path.dirname(file.path), backupDir(preview.operationId, { root: s.root }));
    assert.equal(file.sha256.length, 64);
    assert.ok(fs.existsSync(file.path));
  }
  const parent = s.journal.lookup(preview.operationId);
  const child = s.journal.lookup(parent.children[0].operationId);
  assert.deepEqual(child.plan.backup.files.map(f => [f.module, f.sha256]), recordFiles.slice(0, 2).map(f => [f.module, f.sha256]));
  const record = readOperation(preview.operationId, { root: s.root });
  assert.deepEqual(record.items.map(i => [i.name, i.state, (i.backup?.files ?? []).length]), [['ZZB One', 'deleted', 2], ['ZZB Three', 'deleted', 0], ['ZZB Two', 'deleted', 1]]);
});

test('a backup that fails: BACKUP_FAILED, nothing sent for that item, the rest not started', async () => {
  const s = environment({ failOn: 'ZZBOne_UI' });
  const { preview, result } = await s.confirm();
  assert.deepEqual([result.ok, result.code, result.failed.name], [false, 'BACKUP_FAILED', 'ZZB One']);
  assert.match(result.error, /ZZBOne_UI/);
  assert.deepEqual(s.events, ['download ZZBOne_CS', 'download ZZBOne_UI'], 'nothing sent: not the item, not the rest');
  assert.deepEqual(result.notStarted, ['ZZB One', 'ZZB Three', 'ZZB Two']);
  const record = readOperation(preview.operationId, { root: s.root });
  assert.deepEqual(record.items.map(i => i.state), ['backup-failed', 'not-started', 'not-started']);
  assert.equal(record.state, 'refused');
  // A failure after a deleted item: the operation is partial.
  const later = environment({ failOn: 'ZZBTwo_CS' });
  const second = await later.confirm();
  assert.deepEqual([second.result.code, later.events.filter(e => e.startsWith('send'))], ['BACKUP_FAILED', ['send a-1', 'send a-3']]);
  assert.equal(readOperation(second.preview.operationId, { root: later.root }).state, 'partial');
});

// Only where the CLI is not built: with it, the default download would reach the Studio connected on the lane.
// CX15 r3 (CT-7), converted to the rule of M5 (CX15 r2): without the CLI the default backup is not possible, so the
// PREVIEW shows it (possible:false, CLI_NOT_BUILT) and says in next/confirmWith that the items go WITHOUT a backup; the
// owner's confirmation of that preview deletes them without any download (before: BACKUP_FAILED at the execution).
const cliBuilt = (() => { try { return fs.existsSync(o11LaneOf(o11Lane.lane, { root: anvilRoot }).cli); } catch { return true; } })();
test('without a built O11 CLI the preview says the items go WITHOUT a backup (CLI_NOT_BUILT) and the confirmation deletes them without a download', { skip: cliBuilt ? 'the O11 CLI is built here' : false }, async () => {
  const s = environment({ defaultBackup: true });
  const { preview, result } = await s.confirm();
  const notPossible = preview.itemBackup ? (preview.itemBackup.possible === false ? preview.items.map(i => i.name) : []) : preview.backupPlan.notPossible.map(n => n.name);
  assert.deepEqual(notPossible.sort(), ['ZZB One', 'ZZB Three', 'ZZB Two'], JSON.stringify(preview.itemBackup ?? preview.backupPlan));
  assert.ok(preview.items.some(i => i.backup?.prerequisite === 'CLI_NOT_BUILT') || preview.itemBackup?.prerequisite === 'CLI_NOT_BUILT' || JSON.stringify(preview).includes('CLI_NOT_BUILT'));
  for (const value of [preview.next, preview.confirmWith]) assert.match(value, /3 items will be deleted WITHOUT a backup \(the O11 CLI of this lane is not built; the application has no module to back up\): tell the owner/);
  assert.deepEqual([result.ok, result.state, result.deleted.map(d => d.name)], [true, 'confirmed', ['ZZB One', 'ZZB Three', 'ZZB Two']], JSON.stringify(result).slice(0, 300));
  assert.equal(result.backup, undefined, 'no backup was made');
  assert.deepEqual(s.events.filter(e => e.startsWith('download')), [], 'no download');
});
