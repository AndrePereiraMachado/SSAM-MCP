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
  assert.deepEqual(answer.job, { ops: [{ op: 'set', target: 'ITimer:ProcessQueue', prop: 'Schedule', value: '00:00 01:00 02:00 03:00 04:00 05:00 06:00 07:00 08:00 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00 17:00 18:00 19:00 20:00 21:00 22:00 23:00' }] });
  assert.deepEqual([answer.module, answer.schedule, answer.current.schedule, answer.executed], ['SampleOrders_CS', '00:00 01:00 02:00 03:00 04:00 05:00 06:00 07:00 08:00 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00 17:00 18:00 19:00 20:00 21:00 22:00 23:00', 'Every day at 03:00', false]);
  assert.deepEqual([answer.continuation.tool, answer.continuation.arguments.module], ['o11_deliver', 'SampleOrders_CS']);
  assert.deepEqual(answer.continuation.arguments.job, answer.job);
  assert.deepEqual(b.posts(), []);
  // Executing the same request is refused the same way, before any reservation.
  const receipts = temp();
  const executed = await runServiceCenter(['timer-schedule', '--host', HOST, '--module-id', '102', '--name', 'ProcessQueue', '--schedule-every', '15',
    '--execute', '--words', 'go sc', '--confirm-host', HOST, '--operation-id', uuid()], { ...deps(b), journal: new Journal(path.join(receipts, 'r')) });
  assert.equal(executed.code, 'TIMER_SCHEDULE_IN_MODULE');
  assert.equal(executed.job.ops[0].value, '00:00 00:15 00:30 00:45 01:00 01:15 01:30 01:45 02:00 02:15 02:30 02:45 03:00 03:15 03:30 03:45 04:00 04:15 04:30 04:45 05:00 05:15 05:30 05:45 06:00 06:15 06:30 06:45 07:00 07:15 07:30 07:45 08:00 08:15 08:30 08:45 09:00 09:15 09:30 09:45 10:00 10:15 10:30 10:45 11:00 11:15 11:30 11:45 12:00 12:15 12:30 12:45 13:00 13:15 13:30 13:45 14:00 14:15 14:30 14:45 15:00 15:15 15:30 15:45 16:00 16:15 16:30 16:45 17:00 17:15 17:30 17:45 18:00 18:15 18:30 18:45 19:00 19:15 19:30 19:45 20:00 20:15 20:30 20:45 21:00 21:15 21:30 21:45 22:00 22:15 22:30 22:45 23:00 23:15 23:30 23:45');
  assert.equal(fs.existsSync(path.join(receipts, 'r')) ? fs.readdirSync(path.join(receipts, 'r')).length : 0, 0);
  assert.deepEqual(b.posts(), []);
});

test('the module schedule text follows what the Studio accepts; an unclear request keeps the placeholder', () => {
  assert.equal(moduleSchedule({ recurrence: 'Every', every: '1 hour' }), '00:00 01:00 02:00 03:00 04:00 05:00 06:00 07:00 08:00 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00 17:00 18:00 19:00 20:00 21:00 22:00 23:00');
  assert.equal(moduleSchedule({ every: '15' }), '00:00 00:15 00:30 00:45 01:00 01:15 01:30 01:45 02:00 02:15 02:30 02:45 03:00 03:15 03:30 03:45 04:00 04:15 04:30 04:45 05:00 05:15 05:30 05:45 06:00 06:15 06:30 06:45 07:00 07:15 07:30 07:45 08:00 08:15 08:30 08:45 09:00 09:15 09:30 09:45 10:00 10:15 10:30 10:45 11:00 11:15 11:30 11:45 12:00 12:15 12:30 12:45 13:00 13:15 13:30 13:45 14:00 14:15 14:30 14:45 15:00 15:15 15:30 15:45 16:00 16:15 16:30 16:45 17:00 17:15 17:30 17:45 18:00 18:15 18:30 18:45 19:00 19:15 19:30 19:45 20:00 20:15 20:30 20:45 21:00 21:15 21:30 21:45 22:00 22:15 22:30 22:45 23:00 23:15 23:30 23:45');
  assert.equal(moduleSchedule({ recurrence: 'Every N minutes', every: '5 minutes' }), '00:00 00:05 00:10 00:15 00:20 00:25 00:30 00:35 00:40 00:45 00:50 00:55 01:00 01:05 01:10 01:15 01:20 01:25 01:30 01:35 01:40 01:45 01:50 01:55 02:00 02:05 02:10 02:15 02:20 02:25 02:30 02:35 02:40 02:45 02:50 02:55 03:00 03:05 03:10 03:15 03:20 03:25 03:30 03:35 03:40 03:45 03:50 03:55 04:00 04:05 04:10 04:15 04:20 04:25 04:30 04:35 04:40 04:45 04:50 04:55 05:00 05:05 05:10 05:15 05:20 05:25 05:30 05:35 05:40 05:45 05:50 05:55 06:00 06:05 06:10 06:15 06:20 06:25 06:30 06:35 06:40 06:45 06:50 06:55 07:00 07:05 07:10 07:15 07:20 07:25 07:30 07:35 07:40 07:45 07:50 07:55 08:00 08:05 08:10 08:15 08:20 08:25 08:30 08:35 08:40 08:45 08:50 08:55 09:00 09:05 09:10 09:15 09:20 09:25 09:30 09:35 09:40 09:45 09:50 09:55 10:00 10:05 10:10 10:15 10:20 10:25 10:30 10:35 10:40 10:45 10:50 10:55 11:00 11:05 11:10 11:15 11:20 11:25 11:30 11:35 11:40 11:45 11:50 11:55 12:00 12:05 12:10 12:15 12:20 12:25 12:30 12:35 12:40 12:45 12:50 12:55 13:00 13:05 13:10 13:15 13:20 13:25 13:30 13:35 13:40 13:45 13:50 13:55 14:00 14:05 14:10 14:15 14:20 14:25 14:30 14:35 14:40 14:45 14:50 14:55 15:00 15:05 15:10 15:15 15:20 15:25 15:30 15:35 15:40 15:45 15:50 15:55 16:00 16:05 16:10 16:15 16:20 16:25 16:30 16:35 16:40 16:45 16:50 16:55 17:00 17:05 17:10 17:15 17:20 17:25 17:30 17:35 17:40 17:45 17:50 17:55 18:00 18:05 18:10 18:15 18:20 18:25 18:30 18:35 18:40 18:45 18:50 18:55 19:00 19:05 19:10 19:15 19:20 19:25 19:30 19:35 19:40 19:45 19:50 19:55 20:00 20:05 20:10 20:15 20:20 20:25 20:30 20:35 20:40 20:45 20:50 20:55 21:00 21:05 21:10 21:15 21:20 21:25 21:30 21:35 21:40 21:45 21:50 21:55 22:00 22:05 22:10 22:15 22:20 22:25 22:30 22:35 22:40 22:45 22:50 22:55 23:00 23:05 23:10 23:15 23:20 23:25 23:30 23:35 23:40 23:45 23:50 23:55');
  assert.equal(moduleSchedule({ recurrence: 'Daily', at: '0:00' }), '00:00');
  assert.equal(moduleSchedule({ recurrence: 'Weekly', at: '00:05' }), null);
  assert.equal(moduleSchedule({ timeout: '20' }), null);
  assert.equal(moduleSchedule({ every: '7' }), null);
  assert.equal(moduleSchedule({ every: '120' }), null);
  assert.equal(moduleSchedule({ every: '15', at: '00:00' }), null);
  assert.equal(moduleSchedule({ recurrence: 'Sunday', at: '00:00' }), null);
  // Rows of a header-less detail table are read too.
  const page = new Page(`https://${HOST}${TIMER}`, new Document('<div class="sc-content-main"><table><tr><td>Next Run:</td><td>the timer has no schedule</td></tr></table></div>'));
  assert.deepEqual(timerFields(page), { nextRun: 'the timer has no schedule' });
});
