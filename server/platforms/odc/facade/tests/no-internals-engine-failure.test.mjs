import './fixtures/isolated-profile.mjs';
// Review refusal-followups L-C (C:\t\revisoes\refusal-followups\REVISAO.md): the family "nothing internal reaches a licensee"
// was still open beside the two cases of E2, before that delivery too:
//   - o11_extension XIF_ENGINE_FAILED (Anvil.Xif.Engine Program.Unexpected -> XifEngineClient -> XifRefusal.ToJson, relayed as
//     it is by o11-extension.mjs): the record of a failure of SSAM's own engine, its exception type kept apart beside its
//     frames, {stage, exception: "System.NullReferenceException", at: ["Anvil.Xif.Engine.Host.Model", ...]};
//   - studio_build (lib.mjs builder): the first frame of SSAM's own code in the stderr of the builder, as a value of its own
//     (frame: "at Program.Run(String[] args) in <path>\studio\builder\Program.cs:line 120"); a hosted licensee read it with the
//     path as <server>.
// The rule (exposure.mjs), for a licensee: both leave, as failure.exception and the frames of SSAM's prose do; the stage, the
// message and the fix stay. The customer's exception (the debugger's exception object, with its type and its stack) stays, and
// so does an exception type with no frames beside it (the debugger's pause reason). The owner's answers are as the tools built them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exposedResult } from '../exposure.mjs';

const brief = value => String(JSON.stringify(value) ?? '').slice(0, 1500);
const served = (tool, value, exposure = 'licensee') => exposedResult({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: value?.ok === false },
  { exposure, tool, args: {} }).structuredContent;

const XIF = { ok: false, code: 'XIF_ENGINE_FAILED',
  error: 'The SSAM engine failed inside Integration Studio (stage model): NullReferenceException: Object reference not set to an instance of an object. This is a defect of SSAM, not of the spec; nothing was sent.',
  problems: [{ code: 'XIF_ENGINE_FAILED', message: 'The SSAM engine failed inside Integration Studio (stage model): NullReferenceException: Object reference not set to an instance of an object. This is a defect of SSAM, not of the spec; nothing was sent.',
    fix: 'Report it with this answer (ssam_friction); do not change the spec for it.' }],
  stage: 'model', exception: 'System.NullReferenceException', at: ['Anvil.Xif.Engine.Host.Model', 'Anvil.Xif.Engine.Program.Run', 'OutSystems.ServiceStudio.Integration.Model.Load'] };
const FRAME = 'at Program.Run(String[] args) in C:\\src\\platforms\\odc\\studio\\builder\\Program.cs:line 120';
const BUILD = { ok: false, output: [], error: 'Unhandled exception. System.InvalidOperationException: the feature list could not be read',
  frame: FRAME, stack: 'Unhandled exception. System.InvalidOperationException: the feature list could not be read\n' + FRAME };

test('L-C: a licensee is served no type and no frames of a failure of SSAM\'s own engine (XIF_ENGINE_FAILED); the stage, message and fix stay', () => {
  const out = served('o11_extension', XIF);
  assert.equal(out.exception, undefined, brief(out));
  assert.equal(out.at, undefined, brief(out));
  assert.equal(out.stage, 'model');
  assert.equal(out.code, 'XIF_ENGINE_FAILED');
  assert.match(out.error, /^The SSAM engine failed inside Integration Studio \(stage model\): Object reference not set/);
  assert.equal(out.problems[0].fix, XIF.problems[0].fix);
  assert.doesNotMatch(JSON.stringify(out), /Anvil\.|NullReferenceException/, brief(out));
});

test('L-C: a licensee is served no frame of SSAM\'s own code (studio_build); the error stays', () => {
  const out = served('studio_build', BUILD);
  assert.equal(out.frame, undefined, brief(out));
  assert.equal(out.stack, undefined, brief(out));
  assert.equal(out.error, 'Unhandled exception. the feature list could not be read');
  assert.doesNotMatch(JSON.stringify(out), /Program\.cs|\bat Program\./, brief(out));
});

test('L-C: the customer\'s exception stays whole (the debugger\'s exception object and its stack, a pause reason), and the owner reads it all', () => {
  const debug = { ok: true, results: [{ name: 's1', status: 500, exception: { type: 'System.NullReferenceException', message: 'Object reference not set',
    stack: 'at Customer.Orders.Pay(Order order) in C:\\work\\Orders.cs:line 12', at: ['Customer.Orders.Pay', 'Customer.Orders.Run'] } }],
  pause: { reason: 'exception', exception: 'System.NullReferenceException', frames: [{ frame: 0, elementKey: 'k1' }] } };
  assert.deepEqual(served('ssam_debug_run', debug), debug);
  assert.deepEqual(served('o11_extension', XIF, 'owner'), XIF);
  assert.deepEqual(served('studio_build', BUILD, 'owner'), BUILD);
});
