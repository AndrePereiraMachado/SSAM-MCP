import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { debugSchema } from '../debug.mjs';

test('Only O11 trace function identity accepts the exact native Preparation suffix', () => {
  const key = 'dEWwXGH7NkeApGZ+qJiYJQ', preparation = key + '.#Preparation';
  const input = {op:'start',lane:'o11',module:'HeadlessTrad_UI',moduleKey:key,runtimeUrl:'https://example.test/HeadlessTrad_UI/',nodeKeys:[key],
    trace:{focusFunctionKey:preparation,requireFunctionKey:preparation,scopes:{[preparation]:['GetContacts']}}};
  assert.equal(debugSchema.parse(input).trace.focusFunctionKey,preparation);
  for (const invalid of [key+'.#LaunchProcess',key+'.#WakeTimer',preparation+'.extra',key+'.#preparation']) {
    assert.equal(debugSchema.safeParse({...input,trace:{focusFunctionKey:invalid}}).success,false);
    assert.equal(debugSchema.safeParse({...input,trace:{scopes:{[invalid]:[]}}}).success,false);
  }
  assert.equal(debugSchema.safeParse({...input,lane:'odc',tenant:'tenant'}).success,false);
  assert.equal(debugSchema.safeParse({...input,moduleKey:preparation}).success,false);
  assert.equal(debugSchema.safeParse({...input,nodeKeys:[preparation]}).success,false);
});
