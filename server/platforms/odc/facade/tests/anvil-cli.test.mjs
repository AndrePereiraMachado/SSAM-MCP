import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAnvilRunner } from '../anvil-cli.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

function fakeExec(reply) {
  const calls = [];
  const fn = (file, argv, options, callback) => {
    calls.push({ file, argv, options });
    const { error = null, stdout = '', stderr = '' } = typeof reply === 'function' ? reply(argv) : reply;
    setImmediate(() => callback(error, stdout, stderr));
    return { stdin: { end: text => calls.at(-1).input = text } };
  };
  fn.calls = calls;
  return fn;
}

test('the runner spawns dotnet with the lane CLI and arguments as given, in the lane environment, and parses the envelope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-cli-'));
  try {
    const exec = fakeExec({ stdout: JSON.stringify({ ok: true, command: 'inspect', data: { x: 1 } }) + '\n', stderr: 'log line\n' });
    const run = createAnvilRunner({ lane: 'ss5', root, env: { USERPROFILE: root }, execFileFn: exec });
    const result = await run(['inspect', '--oml', 'C:\\a b\\m.oml', '--path', '@k "q" & x'], { input: { a: 1 } });
    assert.equal(result.ok, true); assert.equal(result.exitCode, 0); assert.deepEqual(result.envelope.data, { x: 1 });
    assert.deepEqual(result.stderr, ['log line']);
    const call = exec.calls[0];
    assert.equal(call.file, 'dotnet');
    assert.deepEqual(call.argv.slice(1), ['inspect', '--oml', 'C:\\a b\\m.oml', '--path', '@k "q" & x']);
    assert.match(call.argv[0], /anvil\.dll$/);
    assert.equal(call.options.env.ANVIL_LANE, 'ss5'); assert.equal(call.options.cwd, root);
    assert.equal(call.input, '{"a":1}');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a refusal, a non-JSON output and an exit code are reported, never thrown', async () => {
  const refused = createAnvilRunner({ execFileFn: fakeExec({ error: Object.assign(new Error('exit'), { code: 1 }), stdout: '{"ok":false,"error":"X: no"}' }) });
  const r1 = await refused(['deliver']);
  assert.equal(r1.ok, false); assert.equal(r1.exitCode, 1); assert.equal(r1.envelope.error, 'X: no');
  const usage = createAnvilRunner({ execFileFn: fakeExec({ error: Object.assign(new Error('exit'), { code: 64 }), stdout: '', stderr: 'usage: anvil ...' }) });
  const r2 = await usage(['nope']);
  assert.equal(r2.ok, false); assert.equal(r2.exitCode, 64); assert.equal(r2.envelope, null); assert.deepEqual(r2.stderr, ['usage: anvil ...']);
});

test('the fake runner records calls and shapes envelopes like the real one', async () => {
  const run = fakeAnvil({ 'check-job': () => ({ ok: true, data: { valid: true } }), deliver: () => ({ exitCode: 1, envelope: { ok: false, data: { delivered: false } } }) });
  assert.equal((await run(['check-job', '--job', 'j.json'])).ok, true);
  assert.equal((await run(['deliver'])).ok, false);
  assert.equal((await run(['nope'])).exitCode, 64);
  assert.deepEqual(run.calls.map(c => c.args[0]), ['check-job', 'deliver', 'nope']);
});
