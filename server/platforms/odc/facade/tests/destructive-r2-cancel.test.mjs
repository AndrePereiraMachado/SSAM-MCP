import './fixtures/isolated-profile.mjs';
// CX15 r2, family F2 (cancellation): the O11 engine reads the client's abort right before each send, not only at the top
// of its loop (C1), and an abort that came during the last item never answers 'confirmed'; the odc_* guard and the data
// deletes honor the same signal (C2) and ssam_task finds the record while it runs (T5). Offline: fake bridge, fake clock,
// synthetic names (the reviewer's reproductions of C:\t\revisoes\cx15\cancel\, turned into the rule).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Journal } from '../service-center/client.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { CONFIRM_MIN_AGE_MS, readOperation } from '../destructive-operations.mjs';
import { CATALOG, FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock } from './fixtures/destructive-flow.mjs';

const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const WORDS = 'sim, apaga os 4 ZZC';

// Four applications ZZC A..D, each with one module (two for B) so every item has a backup plan.
function environment() {
  const s = { apps: ['A', 'B', 'C', 'D'].map(x => ({ key: 'k-' + x.toLowerCase(), name: 'ZZC ' + x })), dir: temp(), clock: fakeClock(), controller: new AbortController(),
    onList: () => {}, onSend: () => {}, onModule: () => {} };
  s.espaces = [{ key: 'm-a', name: 'ZZCA_CS', app: 'k-a' }, { key: 'm-b1', name: 'ZZCB_CS', app: 'k-b' }, { key: 'm-b2', name: 'ZZCB_UI', app: 'k-b' },
    { key: 'm-c', name: 'ZZCC_CS', app: 'k-c' }, { key: 'm-d', name: 'ZZCD_CS', app: 'k-d' }];
  s.root = path.join(s.dir, 'destructive');
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => { const rows = s.apps.filter(a => !a.gone).map(a => ({ Key: a.key, Name: a.name })); s.onList(rows); return rows; },
    ListEspaces: () => s.espaces.filter(m => !s.apps.find(a => a.key === m.app)?.gone).map(m => ({ Key: m.key, Name: m.name, ApplicationKey: m.app })),
    ListExtensions: [], GetConsumers: [],
    DeleteApplication: args => {
      if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] };
      for (const a of s.apps) if (a.key === args.appKey) a.gone = true;
      s.onSend(args.appKey);
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: [] };
    } } });
  // A backup that reads each module (its own hook per module) and never looks at the signal itself.
  const backup = async item => { const files = []; for (const module of item.modules ?? []) { s.onModule(item.name, module); files.push({ path: 'x:/' + module + '.oml', sha256: '0'.repeat(64), bytes: 1, module }); } return { files }; };
  s.deps = (extra = {}) => ({ journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false, exports: s.dir, registry: REGISTRY,
    sleep: async () => {}, clock: s.clock, destructiveRoot: s.root, backup, ...extra });
  s.run = (argv, extra) => runServiceCenter([...argv, '--host=' + PERSONAL], s.deps(extra));
  s.sends = () => s.bridge.calls.filter(c => c[0] === 'api' && c[2] === 'DeleteApplication' && c[4] && c[3].simulate === false).map(c => c[3].appKey);
  s.preview = async () => { const p = await s.run(['delete', '--prefix=ZZC']); s.clock.advance(CONFIRM_MIN_AGE_MS); return p; };
  s.execute = token => s.run(['delete', '--confirmation-token=' + token, '--words=' + WORDS], { signal: s.controller.signal });
  s.abort = () => { if (!s.controller.signal.aborted) s.controller.abort(); };
  s.states = preview => readOperation(preview.operationId, { root: s.root }).items.map(i => [i.name, i.state]);
  return s;
}
// The read again of an item is the first listing after the previous item's wait saw it gone.
function abortOnRereadOf(s, sendsBefore, goneKey) {
  let goneSeen = false;
  s.onList = rows => {
    if (s.sends().length !== sendsBefore) return;
    if (goneSeen) s.abort();
    else if (!goneKey || !rows.some(r => r.Key === goneKey)) goneSeen = true;
  };
}

test('C1: an abort during the read again before the 3rd of 4 sends nothing more: the 3rd and 4th are not-started, the operation is cancelled', async () => {
  const s = environment();
  const preview = await s.preview();
  abortOnRereadOf(s, 2, 'k-b');
  const result = await s.execute(preview.confirmationToken);
  assert.deepEqual(s.sends(), ['k-a', 'k-b'], 'no send after the abort');
  assert.deepEqual([result.state, result.code, result.notStarted], ['cancelled', 'CANCELLED', ['ZZC C', 'ZZC D']]);
  assert.deepEqual(s.states(preview), [['ZZC A', 'deleted'], ['ZZC B', 'deleted'], ['ZZC C', 'not-started'], ['ZZC D', 'not-started']]);
  assert.equal(readOperation(preview.operationId, { root: s.root }).state, 'cancelled');
});

test('C1: an abort during the download of the last module of a middle app, and of the last app, leaves that app not-started', async () => {
  const middle = environment();
  const p1 = await middle.preview();
  middle.onModule = (name, module) => { if (name === 'ZZC B' && module === 'ZZCB_UI') middle.abort(); };
  const r1 = await middle.execute(p1.confirmationToken);
  assert.deepEqual(middle.sends(), ['k-a']);
  assert.deepEqual([r1.state, r1.notStarted], ['cancelled', ['ZZC B', 'ZZC C', 'ZZC D']]);
  assert.deepEqual(middle.states(p1)[1], ['ZZC B', 'not-started']);
  const last = environment();
  const p2 = await last.preview();
  last.onModule = name => { if (name === 'ZZC D') last.abort(); };
  const r2 = await last.execute(p2.confirmationToken);
  assert.deepEqual(last.sends(), ['k-a', 'k-b', 'k-c']);
  assert.deepEqual([r2.state, r2.code, r2.notStarted, Boolean(r2.cancelledAt)], ['cancelled', 'CANCELLED', ['ZZC D'], true]);
  assert.deepEqual(last.states(p2)[3], ['ZZC D', 'not-started']);
});

test('C1: an abort during the read again of the last item sends nothing for it and never answers confirmed', async () => {
  const s = environment();
  const preview = await s.preview();
  abortOnRereadOf(s, 3, 'k-c');
  const result = await s.execute(preview.confirmationToken);
  assert.deepEqual(s.sends(), ['k-a', 'k-b', 'k-c']);
  assert.deepEqual([result.state, result.ok, result.notStarted, Boolean(result.cancelledAt)], ['cancelled', false, ['ZZC D'], true]);
  assert.equal(readOperation(preview.operationId, { root: s.root }).state, 'cancelled');
});

test('C1: an abort while the last send is in flight: that send went out and the answer says so; never confirmed without cancelledAt', async () => {
  const s = environment();
  const preview = await s.preview();
  s.onSend = key => { if (key === 'k-d') s.abort(); };
  const result = await s.execute(preview.confirmationToken);
  assert.deepEqual(s.sends(), ['k-a', 'k-b', 'k-c', 'k-d']);
  assert.notEqual(result.state, 'confirmed');
  assert.equal(result.state, 'cancelled'); assert.ok(result.cancelledAt);
  assert.deepEqual(result.inFlightAtCancel, ['ZZC D']);
  assert.doesNotMatch(result.error, /nothing was sent after the cancellation$/);
  assert.match(result.error, /ZZC D was being sent/);
  const record = readOperation(preview.operationId, { root: s.root });
  assert.equal(record.state, 'cancelled'); assert.equal(record.items[3].cancelledInFlight, true);
});
