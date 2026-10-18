import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RETAINED_LOCKS, HISTORICAL_CODE_ALIASES, HISTORICAL_FOLDER_ALIASES, retainedLock, assertLockNotRetained, classifyBackgroundReceipt }
  from '../debug-retained-locks.mjs';
import { lockInventory } from '../debug-lock-inventory.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const OP = '60aa32e5-1100-4e1f-9d5a-7d74e5bc5ce2', HOST = 'personal-2qqw9srv.outsystemscloud.com', KEY = 'bf7WCuRy7keTqvquautTGg';
const FIXTURE = new URL('./fixtures/debug-retained-60aa32e5-receipt.json', import.meta.url);
// The real retained evidence is only READ (hash before/after); it is never opened for writing.
const REAL_DIR = path.join(fileURLToPath(new URL('../../../../.local/debugger/native-runs/o11/', import.meta.url)), HOST);
const REAL_LOCK = path.join(REAL_DIR, KEY + '.lock'), REAL_RECEIPT = path.join(REAL_DIR, OP, 'receipt.json');
const hashOf = file => fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;
const before = { lock: hashOf(REAL_LOCK), receipt: hashOf(REAL_RECEIPT) };
test.after(() => { assert.equal(hashOf(REAL_LOCK), before.lock, 'real lock changed'); assert.equal(hashOf(REAL_RECEIPT), before.receipt, 'real receipt changed'); });

function copy(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-retained-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.local/debugger/native-runs/o11', HOST, OP); fs.mkdirSync(dir, { recursive: true });
  const receipt = path.join(dir, 'receipt.json'); fs.copyFileSync(FIXTURE, receipt);
  const lock = path.join(path.dirname(dir), KEY + '.lock'); fs.writeFileSync(lock, JSON.stringify({ operationId: OP, pid: 69248 }));
  return { root, dir, receipt, lock };
}

test('the retained list is frozen and names exactly the 60aa32e5 Timer wake lock', () => {
  assert.ok(Object.isFrozen(RETAINED_LOCKS) && RETAINED_LOCKS.every(Object.isFrozen));
  assert.deepEqual(RETAINED_LOCKS.map(r => ({ ...r })), [{ operationId: OP, host: HOST, moduleKey: KEY, reason: 'retained by user decision' }]);
  assert.ok(Object.isFrozen(HISTORICAL_CODE_ALIASES) && Object.isFrozen(HISTORICAL_FOLDER_ALIASES));
  assert.equal(HISTORICAL_CODE_ALIASES.debug_native_background_bpt_launch_outcome_uncertain, 'debug_native_background_timer_launch_outcome_uncertain');
  assert.equal(HISTORICAL_FOLDER_ALIASES['publication-before-bpt-send'], 'publication-before-timer-send');
  for (const [from, to] of Object.entries(HISTORICAL_CODE_ALIASES)) assert.equal(to, from.replace('debug_native_background_bpt_', 'debug_native_background_timer_'));
});

test('the historical 60aa32e5 receipt copy is classified timer-original-wake through the alias table, byte-identical', t => {
  if (before.receipt) assert.equal(sha(fs.readFileSync(FIXTURE)), before.receipt, 'fixture is a byte copy of the historical receipt');
  const f = copy(t), bytes = fs.readFileSync(f.receipt);
  const c = classifyBackgroundReceipt(JSON.parse(bytes));
  assert.equal(c.kind, 'timer-original-wake'); assert.equal(c.namespace, 'timer'); assert.equal(c.schema, 'ssam-o11-timer-observation/1');
  assert.equal(c.source, 'background.kind'); assert.equal(c.consistent, true);
  assert.equal(c.error, 'debug_native_background_bpt_launch_outcome_uncertain');
  assert.equal(c.canonicalError, 'debug_native_background_timer_launch_outcome_uncertain'); assert.equal(c.aliased, true);
  assert.deepEqual(c.publicationFolders, { current: ['publication-before-timer', 'publication-before-timer-send'],
    historical: ['publication-before-bpt', 'publication-before-bpt-send'] });
  assert.deepEqual(fs.readFileSync(f.receipt), bytes, 'reading never rewrites the receipt');
});

test('classification uses background.kind/schema, never the error prefix', () => {
  const bpt = classifyBackgroundReceipt({ background: { kind: 'process-original-launch', schema: 'ssam-o11-bpt-observation/1' },
    error: 'debug_native_background_bpt_launch_outcome_uncertain' });
  assert.equal(bpt.namespace, 'bpt'); assert.equal(bpt.canonicalError, 'debug_native_background_bpt_launch_outcome_uncertain'); assert.equal(bpt.aliased, false);
  // A timer-looking error on a BPT receipt does not make it a Timer, and vice versa.
  assert.equal(classifyBackgroundReceipt({ background: { kind: 'process-original-launch' }, error: 'debug_native_background_timer_x' }).namespace, 'bpt');
  assert.equal(classifyBackgroundReceipt({ background: { schema: 'ssam-o11-timer-observation/1' }, error: 'debug_native_background_bpt_watch_not_connected' }).canonicalError,
    'debug_native_background_timer_watch_not_connected');
  assert.equal(classifyBackgroundReceipt({ background: { schema: 'ssam-o11-timer-observation/1' } }).source, 'background.schema');
  const mixed = classifyBackgroundReceipt({ background: { kind: 'timer-original-wake', schema: 'ssam-o11-bpt-observation/1' } });
  assert.equal(mixed.kind, null); assert.equal(mixed.consistent, false); assert.equal(mixed.namespace, null);
  const none = classifyBackgroundReceipt({ error: 'debug_native_background_bpt_launch_outcome_uncertain' });
  assert.equal(none.kind, null); assert.equal(none.namespace, null); assert.equal(none.canonicalError, 'debug_native_background_bpt_launch_outcome_uncertain');
});

test('reconcile, archive and neutralization of 60aa32e5 / bf7WCuRy7keTqvquautTGg refuse with debug_lock_retained_by_decision', t => {
  const f = copy(t), lockBytes = fs.readFileSync(f.lock);
  for (const action of ['reconcile', 'archive', 'neutralize']) {
    for (const binding of [{ operationId: OP }, { operationId: OP.replaceAll('-', '') }, { host: HOST, moduleKey: KEY }, { host: HOST.toUpperCase(), moduleKey: KEY },
      { lockPath: f.lock }, { lockPath: path.join(f.dir, 'reconciled-answered.lock') }, { lockPath: REAL_LOCK }])
      assert.throws(() => assertLockNotRetained({ ...binding, action }), { message: 'debug_lock_retained_by_decision' }, JSON.stringify(binding));
  }
  assert.equal(retainedLock({ host: HOST, moduleKey: KEY }).reason, 'retained by user decision');
  for (const binding of [{ host: 'dev.example', moduleKey: KEY }, { host: HOST, moduleKey: 'A'.repeat(22) }, { operationId: '60aa32e5' },
    { lockPath: path.join(f.root, 'native-runs/o11', HOST, 'A'.repeat(22) + '.lock') }, {}]) {
    assert.equal(retainedLock(binding), null, JSON.stringify(binding)); assert.doesNotThrow(() => assertLockNotRetained(binding));
  }
  assert.deepEqual(fs.readFileSync(f.lock), lockBytes);
});

test('the inventory lists the retained copy as retained-by-decision with its Timer classification', t => {
  const f = copy(t), { locks, blockedBindings } = lockInventory({ root: f.root });
  const lock = locks.find(l => l.moduleKey === KEY);
  assert.equal(lock.class, 'retained-by-decision'); assert.equal(lock.reconciler, null); assert.equal(lock.reconcilerAvailable, false);
  assert.match(lock.reason, /retained by user decision/); assert.equal(lock.background.kind, 'timer-original-wake');
  assert.equal(lock.background.canonicalError, 'debug_native_background_timer_launch_outcome_uncertain');
  assert.ok(!lock.missingEvidence.some(m => m.includes('debug_native_background_bpt_')), 'never re-labelled a BPT launch');
  assert.deepEqual(blockedBindings.filter(b => b.moduleKey === KEY).map(b => b.classes), [['retained-by-decision']]);
});
