import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BridgeStallRule, classifyWindow, constants, watchedVerbs, preProbeVerbs, errorReportAutoVerbs, errorReportAutoCapability, errorReportTitles } from '../bridge-stall.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('../../../../kernel/tests/fixtures/bridge-stall/cases.json', import.meta.url), 'utf8'));
test('the shared rule constants and title policy match the contract', () => {
  assert.deepEqual(constants, fixture.constants);
  for (const [actual, expected] of [[watchedVerbs, fixture.watchedVerbs], [preProbeVerbs, fixture.preProbeVerbs], [errorReportAutoVerbs, fixture.errorReportAutoVerbs], [errorReportTitles, fixture.errorReportTitles]]) assert.deepEqual(actual, expected);
  assert.equal(errorReportAutoCapability, fixture.errorReportAutoCapability);
});
for (const item of fixture.cases) test(`shared parity: ${item.name}`, () => {
  if (item.classify) { assert.equal(classifyWindow(item.classify.title, item.classify.texts), item.kind); return; }
  const rule = new BridgeStallRule(item.method, {probeMs:item.probeMs, timeoutMs:item.timeoutMs});
  let verdict = rule.begin(item.before, { capabilities:item.capabilities, pid:123, startedUtc:item.startedUtc });
  for (let i=0; i<item.probes.length && !verdict; i++) {
    verdict = rule.observe({...item.probes[i], afterMs:item.probes[i].afterMs ?? (i+1)*2000});
    if (verdict) assert.equal(i, item.probes.length-1, 'verdict must occur at precisely the expected probe');
  }
  assert.equal(verdict?.verdict ?? null,item.expected);
  if(item.expectedQuestion) assert.equal(verdict.blockedBy.question,item.expectedQuestion);
  // CX14 R2: what the person typed in a dialog (a TextBox) never leaves the rule: not in texts, buttons or question.
  for (const text of item.absent ?? []) assert.ok(!JSON.stringify(verdict ?? null).includes(text), `typed text leaked: ${text}`);
  if (verdict) { assert.equal(verdict.method,item.method); assert.equal(verdict.studio.pid,123); }
  if (verdict?.blockedBy) { assert.equal(typeof verdict.blockedBy.seenMs,'number'); assert.ok(verdict.blockedBy.type); }
});
