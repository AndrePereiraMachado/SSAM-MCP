import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertNativeScreenDerivedDefaults } from '../debug-odc-native-host.mjs';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const entryKey = 'VQIPxCcRgESdABMXMV+spw', ownerKey = 'm1krsbkoakaF0reuUaS6Ow';

test('original screen defaults are read, never injected; retained changes and overrides refuse before invoke', () => {
  // Native getAttributes/attrName shape from the published Quotes screen. No
  // SDK, network, authentication, application action or private value is used.
  const attributes = [
    { name: 'ProbeSeed', attrName: 'probeSeedVar', dataType: 1 },
    { name: 'ProbePolicyNumber', attrName: 'probePolicyNumberVar', dataType: 2 },
    { name: 'ProbeBoolean', attrName: 'probeBooleanVar', dataType: 3 },
  ];
  const variables = { probeSeedVar: 40, probePolicyNumberVar: '41', probeBooleanVar: false,
    getAttributes() { return attributes; } };
  const values = [40, '41', false], types = ['Integer', 'Text', 'Boolean'];
  const prepared = { entry: { key: entryKey }, action: { key: 'AAAAAAAAAAAAAAAAAAAAAA' }, sourceContract: { sha256: 'A'.repeat(64) },
    bindings: attributes.map((a, i) => ({ targetInput: a.name, control: 'derived', originalDerived: {
      schema: 'ssam-odc-original-derived-input/1', kind: 'native-screen-local-default',
      entryKey, targetKey: 'AAAAAAAAAAAAAAAAAAAAAA', targetInput: a.name, ownerKey, ownerKind: 'MobileScreen',
      sourceSha256: 'a'.repeat(64), variableKey: String(i).repeat(22), variableName: a.name,
      dataType: types[i], defaultValueSha256: sha(values[i]), evaluatedByDebugger: false,
      stateValidation: 'native-screen-value-before-invoke',
    } })) };
  const options = { plan: { screen: { key: ownerKey } }, screenModel: { variables }, dataTypes: { Integer: 1, Text: 2, Boolean: 3 } };
  let invoked = 0;
  const invoke = context => { assertNativeScreenDerivedDefaults(prepared, { ...options, context }); invoked++; };
  invoke();
  assert.equal(invoked, 1);
  assert.deepEqual(values, [variables.probeSeedVar, variables.probePolicyNumberVar, variables.probeBooleanVar]);
  variables.probeSeedVar = 42; // A previous original action changed retained state.
  assert.throws(() => invoke(), /debug_odc_native_screen_derived_default_changed$/);
  assert.equal(variables.probeSeedVar, 42, 'the debugger must not restore or inject 40');
  assert.equal(invoked, 1);
  variables.probeSeedVar = 40;
  for (const section of ['variables', 'inputs'])
    assert.throws(() => invoke({ screen: { [section]: { ProbeSeed: 40 } } }), /screen_derived_default_override$/);
  variables.probePolicyNumberVar = 41;
  assert.throws(() => invoke(), /screen_derived_default_changed$/);
  variables.probePolicyNumberVar = '41';
  for (const [field, invalid] of [['ownerKey', 'BBBBBBBBBBBBBBBBBBBBBB'], ['sourceSha256', 'b'.repeat(64)], ['entryKey', 'BBBBBBBBBBBBBBBBBBBBBB']]) {
    const proof = prepared.bindings[0].originalDerived, original = proof[field];
    proof[field] = invalid;
    assert.throws(() => invoke(), /screen_derived_default_unqualified$/);
    proof[field] = original;
  }
  attributes.push({ ...attributes[0] });
  assert.throws(() => invoke(), /screen_derived_default_unqualified$/);
  attributes.pop();
  assert.equal(invoked, 1);
  invoke();
  assert.equal(invoked, 2);
  assert.deepEqual(assertNativeScreenDerivedDefaults({ bindings: [] }), { screenDefaultsVerified: 0 }, 'pure client actions remain unaffected');
});

test('explicit screen context verifies the actual native value after application', () => {
  const proof={schema:'ssam-odc-original-derived-input/1',kind:'native-screen-local-context',explicitContext:true,
    entryKey,targetKey:'A'.repeat(22),targetInput:'InputText',ownerKey,ownerKind:'MobileScreen',sourceSha256:'a'.repeat(64),
    variableKey:'B'.repeat(22),variableName:'InputText',dataType:'Text',evaluatedByDebugger:false,stateValidation:'native-screen-value-before-invoke'};
  const prepared={entry:{key:entryKey},action:{key:'A'.repeat(22)},sourceContract:{sha256:'a'.repeat(64)},bindings:[{targetInput:'InputText',originalDerived:proof}]};
  const variables={inputTextVar:'',getAttributes(){return [{name:'InputText',attrName:'inputTextVar',dataType:2}];}};
  const options={plan:{screen:{key:ownerKey}},screenModel:{variables},dataTypes:{Text:2},context:{screen:{variables:{InputText:'[plain Ω😀]'}}}};
  assertNativeScreenDerivedDefaults(prepared,options);
  assert.equal(variables.inputTextVar,'','validation cannot assign the value');
  assert.throws(()=>assertNativeScreenDerivedDefaults(prepared,{...options,applied:true}),/screen_derived_default_changed/);
  variables.inputTextVar='[plain Ω😀]';
  assertNativeScreenDerivedDefaults(prepared,{...options,applied:true});
  assert.throws(()=>assertNativeScreenDerivedDefaults(prepared,{...options,context:undefined}),/screen_context_input_missing/);
  assert.throws(()=>assertNativeScreenDerivedDefaults(prepared,{...options,context:{screen:{variables:{InputText:7}}}}),/screen_derived_default_changed/);
  proof.ownerKey='C'.repeat(22);
  assert.throws(()=>assertNativeScreenDerivedDefaults(prepared,options),/screen_derived_default_unqualified/);
});
