import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orderParts, writeCall } from '../ssam-code.mjs';

const timer = { part: 'ddl', text: 'timer Nightly action RunNightly schedule "03:00"', at: 'timer' };
const creators = {
  text: { part: 'logic', text: 'server action RunNightly\n  end\n', at: 'action' },
  json: { part: 'ops', ops: [{ op: 'logic', data: { actions: [{ name: 'RunNightly', steps: [] }] } }], at: 'action' },
  flow: { part: 'ops', ops: [{ op: 'logic', data: { flow: ['server action RunNightly\n  end\n'] } }], at: 'action' },
  create: { part: 'ops', ops: [{ op: 'create', type: 'IServerAction', name: 'RunNightly', parent: '@espace' }], at: 'action' },
};

for (const [kind, action] of Object.entries(creators)) {
  test(`a timer follows its action created by ${kind}, independent of input order`, () => {
    for (const parts of [[timer, action], [action, timer]]) {
      const result = orderParts(parts);
      assert.deepEqual(result.parts, [action, timer]);
      assert.equal(result.moved, parts[0] === timer);
      assert.equal(result.parts[0], action, 'ordering preserves the original payload');
    }
  });
}

test('a timer follows all referenced creators and matches names without case sensitivity', () => {
  const ddl = { ...timer, text: timer.text + '\ntimer Weekly action RUNWEEKLY schedule "04:00"' };
  const weekly = { part: 'logic', text: 'server action RunWeekly\n  end\n', at: 'weekly' };
  assert.deepEqual(orderParts([ddl, creators.json, weekly]).parts, [creators.json, weekly, ddl]);
});

test('a timer of an existing action keeps the ordinary data-first ordering', () => {
  const unrelated = { part: 'logic', text: 'server action AnotherAction\n  end\n' };
  assert.deepEqual(orderParts([unrelated, timer]).parts, [timer, unrelated]);
});

test('timers waiting for the same action keep their relative order', () => {
  const second = { ...timer, at: 'second', text: timer.text.replace('Nightly action', 'NightlySecond action') };
  assert.deepEqual(orderParts([timer, second, creators.json]).parts, [creators.json, timer, second]);
});

test('the delivery job puts a JSON action before its timer and reports the reordering', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'actions.json');
  fs.writeFileSync(file, JSON.stringify({ ops: creators.json.ops }));
  const result = writeCall({ lane: 'o11', module: 'Scheduler', part: 'ddl', text: timer.text, files: [file] });
  assert.equal(result.tool, 'o11_deliver', JSON.stringify(result));
  assert.equal(result.arguments.job.ops[0].op, 'logic');
  assert.equal(result.arguments.job.ops[1].op, 'spec');
  assert.ok(result.normalizations.some(n => n.rule === 'parts-order'));
});

for (const local of [
  { part: 'logic', text: 'action Dashboard.RunNightly\n  end\n' },
  { part: 'logic', text: 'data action Dashboard.RunNightly\n  end\n' },
  { part: 'ops', ops: [{ op: 'logic', data: { actions: [{ name: 'RunNightly', kind: 'screen', owner: 'Dashboard', steps: [] }] } }] },
  { part: 'ops', ops: [{ op: 'logic', data: { actions: [{ name: 'RunNightly', kind: 'data', owner: 'Dashboard', steps: [] }] } }] },
  { part: 'ops', ops: [{ op: 'create', type: 'IServerAction', name: 'RunNightly', parent: '@screenKey' }] },
]) {
  test('a local action does not delay a timer of an existing module action: ' + JSON.stringify(local), () => {
    const data = { ...timer, text: 'entity EventLog\n  Caption: Text\n' + timer.text };
    assert.deepEqual(orderParts([data, local]).parts, [data, local]);
    assert.deepEqual(orderParts([local, data]).parts, [data, local]);
  });
}

test('the ordering note distinguishes a timer dependency from ordinary data ordering', () => {
  const result = writeCall({ lane: 'o11', module: 'Scheduler', part: 'ddl', text: timer.text,
    also: [{ part: 'logic', text: creators.text.text }] });
  const note = result.normalizations.find(n => n.rule === 'parts-order');
  assert.ok(note, JSON.stringify(result));
  assert.match(JSON.stringify(note), /timers follow/);
  assert.doesNotMatch(JSON.stringify(note), /data first/);
  const ordinary = writeCall({ lane: 'o11', module: 'Scheduler', part: 'logic', text: creators.text.text,
    also: [{ part: 'ddl', text: 'entity EventLog\n  Caption: Text' }] });
  const dataNote = ordinary.normalizations.find(n => n.rule === 'parts-order');
  assert.match(JSON.stringify(dataNote), /data first/);
  assert.doesNotMatch(JSON.stringify(dataNote), /timers follow/);
});

test('entities stay before a screen action that uses them when its timer action already exists', () => {
  const data = { part: 'ddl', text: 'entity EventLog\n  Caption: Text\ntimer Nightly action RunNightly schedule "03:00"' };
  const local = { part: 'logic', text: 'action Dashboard.RunNightly\n  local Entry: EventLog\n  end\n' };
  assert.deepEqual(orderParts([data, local]).parts, [data, local]);
});