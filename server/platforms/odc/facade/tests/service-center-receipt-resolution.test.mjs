// P6 (friction c8b1090d, 2026-10-08): a Run Now of SeedSurvivorDemoDocumentTimer (module 545) came back uncertain in 4 ms;
// verify answered "cannot be inferred" and kept the target lock, so every later Run Now of that timer was refused
// ("pending/uncertain operation") even after the timer was deleted. Now verify reads the timer's real state and resolves
// the receipt when the reading proves the outcome; discard closes it with the user's words; a failure before the POST
// went out is refused (never uncertain); TARGET_PENDING names the holder and the ways out. Synthetic pages, no network.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Document, Page } from '../service-center/html.mjs';
import { Transport } from '../service-center/http.mjs';
import { Client, Journal, TIMER_RUN_GRACE_MS } from '../service-center/client.mjs';
import { TargetPending } from '../service-center/errors.mjs';
import { main, runServiceCenter } from '../service-center/index.mjs';
import { fingerprint } from '../service-center/util.mjs';
import { temp, files, uuid } from './fixtures/sc-fake-bridge.mjs';

const HOST = 'personal-2qqw9srv.outsystemscloud.com';
const BASE = `https://${HOST}/ServiceCenter/`;
const TIMER = 'SeedSurvivorDemoDocumentTimer';
const page = (html, at) => new Page(BASE + at, new Document(html));
const timerPage = ({ lastRun = 'never', status = 'Active', onclick = '' } = {}) => page(`<form method="post" action="eSpace_Timer_Edit.aspx?EspaceKey=k&amp;Cyclic_Job_Key=j">
<div><span>Last Run</span><span>${lastRun}</span></div><div><span>Status</span><span>${status}</span></div>
<input type="submit" name="wt254$wtContentTop$wtButton4" value="Run Now"${onclick ? ` onclick="${onclick}"` : ''}></form>`, 'eSpace_Timer_Edit.aspx?EspaceKey=k&Cyclic_Job_Key=j');
const listing = names => ({ truncated: false, source: BASE + 'eSpace_Edit.aspx?EspaceId=545', rows: names.map(n => ({ links: [{ name: n, href: BASE + 'eSpace_Timer_Edit.aspx?n=' + n }] })) });

class FakeTransport extends Transport {
  constructor(pages = []) { super(HOST); this.pages = [...pages]; this.requests = []; }
  async request(url, fields = null) { this.requests.push([url, fields]); const next = this.pages.shift(); if (next instanceof Error) throw next; return next; }
}
// The timer of module 545 as Service Center shows it now: `timers` lists the module's timers, `timer` is its page.
class Timers extends Client {
  constructor({ timers = [TIMER], timer = timerPage(), replies = [] } = {}) {
    super({ host: HOST, present: async () => true }, new FakeTransport(replies));
    this.timers = timers; this.timer = timer;
  }
  async resourceListing() { return listing(this.timers); }
  async detail() { return this.timer; }
}

// The receipt of the evidence (C:\Users\andre\.ssam-hybrid\o11\service-center\receipts\5c1a0e26-....json), with its lock,
// written as the journal of 2026-10-08 left them: an older receipt, without lastRunBefore in its plan.
function evidence(dir, { createdAt = '2026-10-08T12:36:15.771000+00:00', plan = {} } = {}) {
  const operationId = '5c1a0e26-0000-4000-8000-000000014001';
  const identity = { host: HOST, action: 'timer-run', moduleId: '545', name: TIMER };
  const receipt = { schema: 'ssam-service-center/1', operationId, identity,
    authorization: { wordsSha256: '87e1a272c119af8d5393ad15baf450f5450fc69e87622f6b70670f26a35fdb52', planSha256: '700335c3a5f66a3cbec5e5f4f51d95c866b12b1cc8b4f7736991bf13261961c0' },
    state: 'uncertain', ok: false, createdAt, receipt: path.join(dir, operationId + '.json'),
    plan: { host: HOST, action: 'timer-run', moduleId: '545', name: TIMER, target: BASE + 'eSpace_Timer_Edit.aspx?EspaceKey=7b294810&Cyclic_Job_Key=7950fb10',
      control: 'wt254$wtContentTop$wtButton4', execute: false, ...plan },
    error: 'Response or readback was not confirmed; inspect this receipt and live state before any new operation', updatedAt: '2026-10-08T12:36:15.775000+00:00' };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, operationId + '.json'), JSON.stringify(receipt, null, 2));
  const lock = path.join(dir, fingerprint({ host: HOST, moduleId: '545', name: TIMER }) + '.lock');
  fs.writeFileSync(lock, operationId);
  return { operationId, lock };
}
const registry = dir => { const file = path.join(dir, 'hosts.json'); fs.writeFileSync(file, JSON.stringify({ hosts: { [HOST]: { class: 'personal' } } })); return file; };

test('the evidence lock is the lock of that one timer, not of the host', () => {
  // 5944e4fc... is the lock file next to the 5c1a0e26 receipt in the user's journal.
  assert.equal(fingerprint({ host: HOST, moduleId: '545', name: TIMER }), '5944e4fc676ceaff05a3052d20fe4bd587791fc8dc117981221de96a7175f922');
});

test('c8b1090d: verify of the uncertain Run Now of a timer deleted since resolves it as obsolete and frees the timer', async () => {
  const dir = temp(); const journal = new Journal(dir);
  const { operationId, lock } = evidence(dir);
  const client = new Timers({ timers: ['OtherTimer'] });
  const result = await client.verify(journal.lookup(operationId), journal);
  assert.equal(result.state, 'obsolete', JSON.stringify(result));
  assert.match(result.resolution.reason, /not in the complete timer listing of module 545/);
  assert.equal(fs.existsSync(lock), false, 'the lock is released');
  const stored = JSON.parse(fs.readFileSync(journal.path(operationId), 'utf8'));
  assert.equal(stored.state, 'obsolete');
  assert.equal(stored.resolutions.length, 1);
  assert.match(fs.readFileSync(path.join(dir, 'resolutions.jsonl'), 'utf8'), /"to":"obsolete"/);
  assert.deepEqual(client.http.requests, [], 'verify sends nothing');
  // A timer of the same name created again takes a new Run Now.
  const again = new Timers({ replies: [page('<div class="Feedback_Message_Success">Timer scheduled</div>', 'x.aspx')] });
  const run = await again.mutate('timer-run', '545', TIMER, { execute: true, words: 'rode o timer', operationId: uuid(), journal });
  assert.equal(run.state, 'accepted');
});

test('the uncertain Run Now of an existing timer that still never ran long after resolves as not-executed', async () => {
  const dir = temp(); const journal = new Journal(dir);
  const { operationId, lock } = evidence(dir);
  const result = await new Timers({ timer: timerPage({ lastRun: 'never' }) }).verify(journal.lookup(operationId), journal);
  assert.equal(result.state, 'not-executed', JSON.stringify(result));
  assert.equal(result.observed.lastRun, 'never');
  assert.equal(fs.existsSync(lock), false);
});

test('a Last Run that moved from the one seen before the send confirms; unchanged within the grace stays uncertain', async () => {
  const dir = temp(); const journal = new Journal(dir);
  const recent = new Date(Date.now() - 60000).toISOString();
  const { operationId, lock } = evidence(dir, { createdAt: recent, plan: { lastRunBefore: '2026-10-08 10:00:00' } });
  const waiting = await new Timers({ timer: timerPage({ lastRun: '2026-10-08 10:00:00' }) }).verify(journal.lookup(operationId), journal);
  assert.equal(waiting.state, 'uncertain');
  assert.ok(waiting.recheckAfter && Date.parse(waiting.recheckAfter) - Date.parse(recent) === TIMER_RUN_GRACE_MS);
  assert.equal(fs.existsSync(lock), true, 'still held while the scheduler may pick it up');
  const ran = await new Timers({ timer: timerPage({ lastRun: '2026-10-08 12:37:02' }) }).verify(journal.lookup(operationId), journal);
  assert.equal(ran.state, 'confirmed');
  assert.equal(ran.ok, true);
  assert.equal(fs.existsSync(lock), false);
});

test('the plan of a Run Now keeps the Last Run seen before the send', async () => {
  const plan = await new Timers({ timer: timerPage({ lastRun: '2026-10-07 23:00:00' }) }).mutate('timer-run', '545', TIMER);
  assert.equal(plan.lastRunBefore, '2026-10-07 23:00:00');
});

test('an older receipt whose timer shows a dated Last Run stays uncertain; discard closes it with words naming the timer', async () => {
  const dir = temp(); const journal = new Journal(dir);
  const { operationId, lock } = evidence(dir);
  const seen = await new Timers({ timer: timerPage({ lastRun: '2026-10-08 13:00:00' }) }).verify(journal.lookup(operationId), journal);
  assert.equal(seen.state, 'uncertain');
  assert.match(seen.verification, /discard/);
  const deps = { journal, registry: registry(dir), locate: () => assert.fail('discard needs no Studio'), present: () => assert.fail('no vault'), running: async () => false };
  const vague = await runServiceCenter(['discard', '--host', HOST, '--operation-id', operationId, '--words', 'pode descartar'], deps);
  assert.equal(vague.ok, false);
  assert.match(vague.error, /name its target/);
  assert.equal(fs.existsSync(lock), true);
  const words = `descarte o recibo do ${TIMER}`;
  const done = await main(['discard', '--host', HOST, '--operation-id', operationId, '--words', words], deps);
  assert.deepEqual([done.ok, done.state, done.discarded, done.sent], [true, 'discarded', true, false]);
  assert.equal(fs.existsSync(lock), false);
  const evidenceText = files(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.ok(!evidenceText.includes(words), 'only the sha256 of the words is kept');
  assert.match(fs.readFileSync(path.join(dir, 'resolutions.jsonl'), 'utf8'), /"to":"discarded"/);
  // A closed receipt is not discarded twice.
  const twice = await runServiceCenter(['discard', '--host', HOST, '--operation-id', operationId, '--words', words], deps);
  assert.equal(twice.ok, false);
});

test('a held target answers TARGET_PENDING with the holder, verify and discard', async () => {
  const dir = temp(); const journal = new Journal(dir);
  const { operationId } = evidence(dir, { createdAt: new Date().toISOString(), plan: { lastRunBefore: 'never' } });
  const error = await new Timers().mutate('timer-run', '545', TIMER, { execute: true, words: 'rode o timer', operationId: uuid(), journal }).catch(e => e);
  assert.ok(error instanceof TargetPending, String(error));
  assert.match(error.message, /pending\/uncertain/);
  const answer = error.answer();
  assert.deepEqual([answer.code, answer.holder, answer.holderState], ['TARGET_PENDING', operationId, 'uncertain']);
  assert.deepEqual(answer.continuation.arguments, { action: 'verify', host: HOST, operationId });
  assert.equal(answer.alternatives[0].arguments.action, 'discard');
});

test('a Run Now refused before its POST went out is refused, keeps why, and leaves the timer free', async () => {
  const dir = temp(); const journal = new Journal(dir);
  // The live 11.42 button routes through script: the form is never posted as planned.
  const client = new Timers({ timer: timerPage({ onclick: 'OsAjax(event)' }) });
  const result = await client.mutate('timer-run', '545', TIMER, { execute: true, words: 'rode o timer', operationId: uuid(), journal });
  assert.equal(result.state, 'refused', JSON.stringify(result));
  assert.match(result.error, /^Nothing was sent: Unsupported scripted form submission/);
  assert.deepEqual(client.http.requests, []);
  assert.deepEqual(files(dir, /\.lock$/), []);
});

test('a resolution never touches a receipt with a live sender or one that is already closed', () => {
  const dir = temp(); const journal = new Journal(dir);
  const { operationId } = evidence(dir, { createdAt: new Date().toISOString() });
  const raw = JSON.parse(fs.readFileSync(journal.path(operationId), 'utf8'));
  fs.writeFileSync(journal.path(operationId), JSON.stringify({ ...raw, state: 'sending' }));
  assert.throws(() => journal.discard(journal.lookup(operationId), 'descarte SeedSurvivorDemoDocumentTimer'), /Sender may still be active/);
  fs.writeFileSync(journal.path(operationId), JSON.stringify({ ...raw, state: 'sending', createdAt: '2026-10-08T12:36:15.771000+00:00' }));
  assert.equal(journal.discard(journal.lookup(operationId), 'descarte SeedSurvivorDemoDocumentTimer').state, 'discarded');
  assert.throws(() => journal.resolve(journal.lookup(operationId), 'obsolete', 'again'), /Only an uncertain receipt/);
});
