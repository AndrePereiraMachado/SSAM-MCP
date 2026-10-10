import './fixtures/isolated-profile.mjs';
// Lane F of the 2026-10-05 package (docs/PACOTE-SESSOES-NOVO.md, C40): the Service Center timer page in the shape the
// sessions met (session dd2b79c0, 2026-10-05 01:06: Run Now named wt254$wtContentTop$wtButton4, one Apply and no control
// the parser identified as the schedule recurrence) is read without LAYOUT_UNKNOWN, and timer-schedule on it plans the
// change through the module (the timer's Schedule property, the route that session then proved) instead of asking for a
// capture round. The page is a synthetic, structure-only fixture (sc-pages/live/timer-edit.html); nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client, Journal, moduleSchedule, timerFields } from '../service-center/client.mjs';
import { StudioWebTransport } from '../service-center/http.mjs';
import { Document, Page } from '../service-center/html.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { FakeBridge, PAGES, SC, fakeVault, html, readText, temp, uuid } from './fixtures/sc-fake-bridge.mjs';

const HOST = 'sc.example.test';
const ESPACE = `GET ${SC}eSpace_Edit.aspx?EspaceId=102`;
const TIMER = SC + 'eSpace_Timer_Edit.aspx?EspaceKey=7c3d9e10-0000-4000-8000-00000000e102&Cyclic_Job_Key=9a8b7c6d-0000-4000-8000-00000000c001';
const LIVE = readText(path.join(PAGES, 'live', 'timer-edit.html'));
const bridge = (timer = LIVE) => new FakeBridge({ pages: { [ESPACE]: html('factory/espace-edit.html'), [`GET ${TIMER}`]: timer,
  [`POST ${SC}eSpace_Timer_Edit.aspx`]: () => assert.fail('nothing is sent') } });
const client = b => new Client(fakeVault(HOST), new StudioWebTransport(HOST, b), temp());
const deps = b => ({ journal: new Journal(path.join(temp(), 'receipts')), locate: () => b, present: async () => false, running: async () => false,
  opener: () => assert.fail('no prompt'), exports: temp() });

test('the timer page in the live format is read without LAYOUT_UNKNOWN', async () => {
  const b = bridge();
  const timer = await client(b).timer('102', 'ProcessQueue');
  assert.deepEqual([timer.name, timer.module, timer.action, timer.schedule, timer.lastRun, timer.nextRun, timer.timeout],
    ['ProcessQueue', 'SampleOrders_CS', 'ProcessQueueAction', 'Every day at 03:00', 'never', '2026-10-02 03:00:00', '20 m']);
  assert.deepEqual(timer.actions, ['Run Now', 'Deactivate', 'Apply']);
  assert.equal(timer.scheduleEditor, 'not-on-page');
  assert.ok(!JSON.stringify(timer).includes('RecentDecoy'));
  // The same read through the tool: timers with a name answers that timer's page.
  const answer = await runServiceCenter(['timers', '--host', HOST, '--module-id', '102', '--name', 'ProcessQueue'], deps(bridge()));
  assert.deepEqual([answer.ok, answer.code, answer.schedule, answer.scheduleEditor], [true, undefined, 'Every day at 03:00', 'not-on-page']);
  // The modeled page with its editor reads the same rows and says the editor is there.
  const modern = await client(bridge(html('timers/timer-edit.active.html'))).timer('102', 'ProcessQueue');
  assert.deepEqual([modern.effectiveSchedule, modern.defaultSchedule, modern.status, modern.scheduleEditor], ['Every day at 03:00', 'When Published', 'Active', 'identified']);
});

test('timer-schedule on the live page plans the module change and sends nothing (no capture round)', async () => {
  const b = bridge();
  const answer = await runServiceCenter(['timer-schedule', '--host', HOST, '--module-id', '102', '--name', 'ProcessQueue',
    '--schedule-recurrence', 'Every', '--schedule-every', '1 hour'], deps(b));
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'TIMER_SCHEDULE_IN_MODULE');
  assert.notEqual(answer.code, 'LAYOUT_UNKNOWN');
  assert.deepEqual(answer.job, { ops: [{ op: 'set', target: 'ITimer:ProcessQueue', prop: 'Schedule', value: 'Every 60 minutes' }] });
  assert.deepEqual([answer.module, answer.schedule, answer.current.schedule, answer.executed], ['SampleOrders_CS', 'Every 60 minutes', 'Every day at 03:00', false]);
  assert.deepEqual([answer.continuation.tool, answer.continuation.arguments.module], ['o11_deliver', 'SampleOrders_CS']);
  assert.deepEqual(answer.continuation.arguments.job, answer.job);
  assert.deepEqual(b.posts(), []);
  // Executing the same request is refused the same way, before any reservation.
  const receipts = temp();
  const executed = await runServiceCenter(['timer-schedule', '--host', HOST, '--module-id', '102', '--name', 'ProcessQueue', '--schedule-every', '15',
    '--execute', '--words', 'go sc', '--confirm-host', HOST, '--operation-id', uuid()], { ...deps(b), journal: new Journal(path.join(receipts, 'r')) });
  assert.equal(executed.code, 'TIMER_SCHEDULE_IN_MODULE');
  assert.equal(executed.job.ops[0].value, 'Every 15 minutes');
  assert.equal(fs.existsSync(path.join(receipts, 'r')) ? fs.readdirSync(path.join(receipts, 'r')).length : 0, 0);
  assert.deepEqual(b.posts(), []);
});

test('the module schedule text follows what the Studio accepts; an unclear request keeps the placeholder', () => {
  assert.equal(moduleSchedule({ recurrence: 'Every', every: '1 hour' }), 'Every 60 minutes');
  assert.equal(moduleSchedule({ every: '15' }), 'Every 15 minutes');
  assert.equal(moduleSchedule({ recurrence: 'Every N minutes', every: '5 minutes' }), 'Every 5 minutes');
  assert.equal(moduleSchedule({ recurrence: 'Daily', at: '0:00' }), 'Every day at 00:00');
  assert.equal(moduleSchedule({ recurrence: 'Weekly', at: '00:05' }), null);
  assert.equal(moduleSchedule({ timeout: '20' }), null);
  // Rows of a header-less detail table are read too.
  const page = new Page(`https://${HOST}${TIMER}`, new Document('<div class="sc-content-main"><table><tr><td>Next Run:</td><td>the timer has no schedule</td></tr></table></div>'));
  assert.deepEqual(timerFields(page), { nextRun: 'the timer has no schedule' });
});
