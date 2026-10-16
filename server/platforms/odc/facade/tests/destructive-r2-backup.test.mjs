import './fixtures/isolated-profile.mjs';
// CX15 r2, M5: the preview reads the cheap prerequisites of the OML backup (the O11 CLI built, the Studio selected with
// ssam_connect still running) and shows a backup that cannot be made now as possible:false with the reason; the execution
// follows the preview the owner confirmed (an item shown without a backup is deleted like an application with no module;
// one shown with a backup needs it: a download that fails is BACKUP_FAILED). Offline: the fake bridge, a fake backup, a
// temporary kernel root for the default readiness; no Studio is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../service-center/client.mjs';
import * as sc from '../service-center/index.mjs';
import { CONFIRM_MIN_AGE_MS, readOperation } from '../destructive-operations.mjs';
import { CATALOG, FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock } from './fixtures/destructive-flow.mjs';

const HOST = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const NOT_BUILT = { code: 'CLI_NOT_BUILT', why: 'the O11 Anvil CLI of this lane is not built, so the published OML cannot be downloaded' };

function world({ ready = () => null, backup }) {
  const s = { apps: [{ key: 'a-1', name: 'ZZ One' }], espaces: [{ key: 'm-1', name: 'ZZOne_CS', app: 'a-1' }], dir: temp(), sends: [], backups: [], clock: fakeClock(), ready };
  s.root = path.join(s.dir, 'destructive');
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => s.apps.filter(a => !a.gone).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: () => s.espaces.filter(m => !m.gone).map(m => ({ Key: m.key, Name: m.name, ApplicationKey: m.app })), ListExtensions: [], GetConsumers: [],
    DeleteApplication: args => { if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: ['ZZOne_CS'] };
      s.sends.push(args.appKey); s.apps[0].gone = true; s.espaces[0].gone = true; return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: ['ZZOne_CS'] }; } } });
  const fakeBackup = backup ?? (async item => { s.backups.push(item.name); return { files: [] }; });
  s.run = (...argv) => sc.runServiceCenter([...argv, '--host=' + HOST], { journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false,
    exports: s.dir, registry: REGISTRY, sleep: async () => {}, clock: s.clock, destructiveRoot: s.root, backup: fakeBackup, backupReady: async () => s.ready() });
  return s;
}

test('M5: with the CLI not built the preview shows the backup as not possible, with the reason and that the item goes without one; the confirmed execution deletes it without calling the backup', async () => {
  const s = world({ ready: () => NOT_BUILT });
  const preview = await s.run('delete', '--prefix=ZZ');
  assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 300));
  const item = preview.items.find(i => i.name === 'ZZ One');
  const plan = item.backup ?? preview.itemBackup ?? preview.backupPlan?.notPossible?.[0];
  assert.equal(plan.possible ?? false, false, JSON.stringify(preview).slice(0, 500));
  assert.match(JSON.stringify(preview), /CLI of this lane is not built/);
  assert.match(JSON.stringify(preview), /deleted without a backup, like an application with no module/);
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const done = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=sim, apaga o 1 ZZ');
  assert.equal(done.ok, true, JSON.stringify(done).slice(0, 400));
  assert.deepEqual([s.sends, s.backups], [['a-1'], []], 'deleted, and the backup was never called');
  assert.equal(readOperation(preview.operationId, { root: s.root }).items[0].state, 'deleted');
});

test('M5: the execution follows the preview: shown with a backup, a backup that cannot be made at execution is BACKUP_FAILED (nothing sent), never a silent delete without it', async () => {
  const s = world({ backup: async () => { throw new Error('the published OML of ZZOne_CS was not downloaded (CLI_NOT_BUILT)'); } });
  const preview = await s.run('delete', '--prefix=ZZ');
  assert.equal(JSON.stringify(preview).includes('"possible":true'), true, JSON.stringify(preview).slice(0, 400));
  s.ready = () => NOT_BUILT; // the prerequisites went away between the two calls
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const done = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=sim, apaga o 1 ZZ');
  assert.equal(done.code, 'BACKUP_FAILED', JSON.stringify(done).slice(0, 400));
  assert.deepEqual(s.sends, [], 'nothing sent');
});

test('M5: the default readiness reads the lane without contacting a Studio: CLI not built, a selected Studio that is gone, and ready', async () => {
  assert.equal(typeof sc.moduleBackupReadiness, 'function', 'index.mjs exports the readiness of the module backup');
  const root = tmp('cx15r2-m5-kernel-');
  try {
    const lane = 'ss4';
    assert.equal((await sc.moduleBackupReadiness({ root, lane }))?.code, 'CLI_NOT_BUILT');
    fs.mkdirSync(path.join(root, '.local', 'cli'), { recursive: true }); fs.writeFileSync(path.join(root, '.local', 'cli', 'anvil.dll'), 'synthetic');
    assert.equal(await sc.moduleBackupReadiness({ root, lane }), null, 'the CLI built and no Studio selected: ready (the download uses the default lane)');
    const connections = path.join(root, '.local', 'connections'); fs.mkdirSync(connections, { recursive: true });
    const record = pid => fs.writeFileSync(path.join(connections, lane + '.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: lane, pid, port: 4516, startedUtc: '2026-10-15T11:00:00Z',
      studioDir: path.join(root, 'studio'), authorityDir: path.join(root, 'authority') }));
    record(424242);
    assert.equal((await sc.moduleBackupReadiness({ root, lane, alive: () => false }))?.code, 'STUDIO_NOT_SELECTED');
    record(process.pid);
    assert.equal(await sc.moduleBackupReadiness({ root, lane }), null);
    fs.writeFileSync(path.join(connections, lane + '.json'), '{"ok":false}');
    assert.equal((await sc.moduleBackupReadiness({ root, lane }))?.code, 'STUDIO_NOT_SELECTED', 'an invalid record');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
