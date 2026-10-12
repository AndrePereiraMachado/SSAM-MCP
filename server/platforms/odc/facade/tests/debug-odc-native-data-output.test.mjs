import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeDataActionOutputs } from '../debug-odc-native-data-output.mjs';
import { nativeOutputComparison } from '../debug-native-output-comparison.mjs';

test('Data Action outputs use the native wire contract, exclude fetch state and expose wire mismatch', () => {
  const plan = { member: { call: { kind: 'data-action' }, dataActVar: 'readDataAct' }, outputs: [] };
  const attrs = [{ name: 'DisplayLabel', nameForJson: 'Result', attrName: 'resultOut', dataType: 0 },
    { name: 'DataFetchStatus', nameForJson: '', attrName: 'statusAttr' }];
  const record = { resultOut: 0, statusAttr: 1, getAttributes: () => attrs };
  const outputs = nativeDataActionOutputs(plan, { variables: { readDataAct: record } });
  assert.deepEqual(outputs, [{ wire: 'Result', attrName: 'resultOut', dataType: 0 }]);
  const project = () => Object.fromEntries(outputs.map(a => [a.wire, record[a.attrName]]));
  assert.equal(nativeOutputComparison({ Result: 42 }, project()).unequalScalars, 1);
  record.resultOut = 42;
  assert.equal(nativeOutputComparison({ Result: 42 }, project()).representationEqual, true);
  attrs.push({ ...attrs[0] });
  assert.throws(() => nativeDataActionOutputs(plan, { variables: { readDataAct: record } }), /contract_unavailable/);
  assert.throws(() => nativeDataActionOutputs(plan, {}), /contract_unavailable/);
  const server = { member: { call: { kind: 'server-action' } }, outputs: [{ wire: 'Original' }] };
  assert.equal(nativeDataActionOutputs(server, {}), server.outputs);
});
