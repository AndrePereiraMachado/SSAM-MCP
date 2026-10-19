// Owner request (18/10, a8 phase 6): a fast, easy way to switch ssam_code off on the VPS without a new image. The switch
// of the image is the class of ssam_code in hosted/tools.json (hosted/served.mjs); SSAM_HOSTED_SSAM_CODE=off|on, read once
// when the server starts (its first read of the catalog), sets that same class: off is exactly the off state already
// tested (hosted-code-switch: the paragraph and the rules of b606ee7b word for word, SSAM_CODE_HOSTED_PENDING with the
// ssam_map continuation, no internal name), on serves it, absent (or empty) leaves the catalog as the image has it; any
// other value is no switch and the state says it was ignored. Each state runs in a process of its own
// (fixtures/hosted-code-env-probe.mjs), as the variable is read once per process. Synthetic values only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codeServedHosted, withCodeSwitch, CODE_SWITCH } from '../hosted/served.mjs';
import { hostedTools } from '../hosted/policy.mjs';
import { HOSTED_INSTRUCTIONS, HOSTED_RULES } from '../ssam.mjs';
import { findings } from './fixtures/internal-text.mjs';
import { OFF_HOSTED_INSTRUCTIONS, OFF_HOSTED_RULES, OFF_CAUSE, OFF_CONTINUATION } from './fixtures/hosted-code-off.mjs';

const PROBE = fileURLToPath(new URL('./fixtures/hosted-code-env-probe.mjs', import.meta.url));
const INBOX = ' The agent inbox folder of this account is C:\\Users\\someone\\SSAM-agent\\inbox.';
const probe = value => {
  const env = { ...process.env };
  delete env[CODE_SWITCH];
  if (value !== undefined) env[CODE_SWITCH] = value;
  const run = spawnSync(process.execPath, [PROBE], { env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(run.status, 0, 'probe ' + JSON.stringify(value) + ': ' + (run.stderr || run.stdout).slice(0, 800));
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
};
const served = (state, value) => {
  assert.equal(state.served, true, JSON.stringify(value));
  assert.equal(state.cls, 'server');
  assert.equal(state.answer.ok, true, 'served: the grammar ran on the server ' + JSON.stringify(state.answer));
  assert.equal(state.ran, 1);
  assert.equal(state.instructions, HOSTED_INSTRUCTIONS + ' ' + HOSTED_RULES + INBOX);
};
const off = (state, value) => {
  assert.equal(state.served, false, JSON.stringify(value));
  assert.equal(state.cls, 'unavailable');
  assert.equal(state.answer.code, 'HOSTED_UNAVAILABLE');
  assert.equal(state.answer.cause, OFF_CAUSE);
  assert.deepEqual(state.answer.continuation, OFF_CONTINUATION);
  assert.match(state.answer.error, /^ssam_code is not available on a hosted SSAM server: .*ssam_map/);
  assert.deepEqual(findings(state.answer), [], 'no internal name in the refusal');
  assert.equal(state.ran, 0, 'nothing ran');
  assert.equal(state.instructions, OFF_HOSTED_INSTRUCTIONS + ' ' + OFF_HOSTED_RULES + INBOX, 'the paragraph and the rules of b606ee7b, word for word');
};

test('the image as shipped serves ssam_code; this test process starts without the variable', () => {
  assert.equal(process.env[CODE_SWITCH], undefined);
  assert.equal(codeServedHosted(), true);
  assert.equal(hostedTools().ssam_code.class, 'server');
});

test('SSAM_HOSTED_SSAM_CODE absent or empty: the catalog as the image has it (served)', () => {
  for (const value of [undefined, '']) {
    const state = probe(value);
    served(state, value);
    assert.deepEqual(state.state, { served: true, switch: null }, JSON.stringify(state.state));
  }
});

test('SSAM_HOSTED_SSAM_CODE=off: exactly the off state already tested, by the gate and by the instructions (also OFF, " off ")', () => {
  for (const value of ['off', 'OFF', ' off ']) {
    const state = probe(value);
    off(state, value);
    assert.deepEqual(state.state, { served: false, switch: 'off' }, JSON.stringify(state.state));
  }
});

test('SSAM_HOSTED_SSAM_CODE=on: served (the image serves it already: the same state)', () => {
  const state = probe('on');
  served(state, 'on');
  assert.deepEqual(state.state, { served: true, switch: 'on' });
});

test('any other value is no switch: the catalog as the image has it, and the state says the value was ignored', () => {
  const state = probe('maybe');
  served(state, 'maybe');
  assert.deepEqual(state.state, { served: true, switch: null, ignored: true });
});

test('withCodeSwitch: off sets only the class of ssam_code to unavailable (its off state stays beside it); on serves an image that ships it off; anything else changes nothing', () => {
  const shipped = hostedTools();
  const offTools = withCodeSwitch(shipped, 'off');
  assert.equal(offTools.ssam_code.class, 'unavailable');
  assert.deepEqual({ ...offTools.ssam_code, class: shipped.ssam_code.class }, shipped.ssam_code, 'only the class changes');
  for (const name of Object.keys(shipped)) if (name !== 'ssam_code') assert.equal(offTools[name], shipped[name], name);
  const imageOff = { ...shipped, ssam_code: { ...shipped.ssam_code, class: 'unavailable' } };
  assert.equal(withCodeSwitch(imageOff, 'on').ssam_code.class, 'server');
  assert.equal(withCodeSwitch(shipped, 'on').ssam_code.class, 'server');
  for (const value of [undefined, null, '', 'maybe', 'false', '0']) assert.equal(withCodeSwitch(shipped, value), shipped, String(value));
  assert.equal(shipped.ssam_code.class, 'server', 'the catalog itself is never changed');
});
