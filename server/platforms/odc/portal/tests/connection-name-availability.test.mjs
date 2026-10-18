import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionNameAvailabilityInput as input, connectionNameAvailabilityResult as result} from '../runtime/connection-name-availability.mjs';

test('availability preserves both boolean outcomes and the exact queried identity without reserving it', () => {
  for (const available of [true, false]) {
    const raw = {inputParameters: {ConnectionName:'Name With Spaces',ConnectionId:''}};
    assert.equal(input(raw), raw);
    assert.deepEqual(result(raw,{IsNameAvailable:available}),{name:'Name With Spaces',connectionId:'',available,
      reservationMade:false,scope:'queried-name-at-read-time'});
  }
});
test('missing or coerced responses cannot claim name availability', () => {
  const raw = {inputParameters:{ConnectionName:'Proof',ConnectionId:'existing-key'}};
  for (const data of [null,{}, {IsNameAvailable:'false'},{IsNameAvailable:1},{IsNameAvailable:null}])
    assert.throws(()=>result(raw,data),e=>e.code==='PORTAL_RESPONSE_INVALID');
});
test('incomplete identity and unexpected native parameters are refused', () => {
  for (const parameters of [undefined,{}, {ConnectionName:'Proof'}, {ConnectionName:' ',ConnectionId:''},
    {ConnectionName:'Proof',ConnectionId:null},{ConnectionName:'Proof',ConnectionId:'',Unknown:true}])
    assert.throws(()=>input({inputParameters:parameters}),e=>e.code==='INPUT_INVALID');
});
