import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {isO11NativeSuspensionCheck} from '../debug-o11-suspended-request.mjs';
test('native suspension query accepts only the current app and active original request token',()=>{
 const target={runtimeUrl:'https://example.invalid/App/',module:'App'},active=new Set(['123456789']);
 const url=new URL('https://example.invalid/App/moduleservices/checkrequestsuspended?requestToken=123456789');
 assert.equal(isO11NativeSuspensionCheck('GET',url,target,active),true);
 for(const altered of ['https://other.invalid/App/moduleservices/checkrequestsuspended?requestToken=123456789',
  'https://example.invalid/Other/moduleservices/checkrequestsuspended?requestToken=123456789',
  url.href+'&requestToken=123456789',url.href+'&extra=1',url.href+'#fragment',url.href.replace('123456789','9')])
  assert.equal(isO11NativeSuspensionCheck('GET',new URL(altered),target,active),false);
 assert.equal(isO11NativeSuspensionCheck('POST',url,target,active),false);
 active.clear();assert.equal(isO11NativeSuspensionCheck('GET',url,target,active),false);
});
