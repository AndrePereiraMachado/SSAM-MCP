// R3-C (K2): the answer of an applied delivery names the elements the Studio renamed on its own during the merge (the
// kernel's nativeRenames, accepted by the content proof only as NativeNames predicted them), with a note; nothing otherwise.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFields, nativeRenamesOf } from '../o11-cycle.mjs';

const rename = { element: 'ServerAction:Shipment_CountByCarrier/AggregateNode:GetShipments', from: 'GetShipments', to: 'GetShipmentsByCarrierId', rule: 'aggregate-filter-by-attribute' };

test('nativeRenamesOf: the renames the merge made, with the note that the module now has the new names', () => {
  const fields = nativeRenamesOf({ nativeRenames: [rename] });
  assert.deepEqual(fields.nativeRenames, [rename]);
  assert.match(fields.nativeRenamesNote, /^Applied\. The Studio renamed this element on its own/);
  assert.match(fields.nativeRenamesNote, /write them in later jobs/);
  assert.equal(fields.nativeRenamesTotal, undefined);
});

test('nativeRenamesOf: nothing without renames, malformed entries dropped, the list capped at 10', () => {
  assert.deepEqual(nativeRenamesOf({}), {});
  assert.deepEqual(nativeRenamesOf({ nativeRenames: [null, 'x', { from: 'A' }] }), {});
  const many = nativeRenamesOf({ nativeRenames: Array.from({ length: 12 }, (_, i) => ({ ...rename, from: 'Get' + i, to: 'Get' + i + 'ById' })) });
  assert.equal(many.nativeRenames.length, 10);
  assert.equal(many.nativeRenamesTotal, 12);
  assert.match(many.nativeRenamesNote, /these elements/);
});

test('deliveryFields: carries the native renames of the delivery', () => {
  assert.deepEqual(deliveryFields({ nativeRenames: [rename] }).nativeRenames, [rename]);
  assert.equal(deliveryFields({}).nativeRenames, undefined);
});
