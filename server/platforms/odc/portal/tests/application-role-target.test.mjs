import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {OdcAccess,guardTarget} from '../runtime/access.mjs';
test('role revocation resolves only the exact live role name and preserves the target gate',async()=>{
 const roleKey='11111111-1111-4111-8111-111111111111',operation={id:'user-access-management-api-v1:delete:/users/{key}/application-roles/{roleKey}'};
 let rows=[{key:roleKey,name:'DiagnosticApp'}],calls=0;
 const access={send:async(host,resolved,id,input,options)=>{calls++;assert.equal(id,'user-access-management-api-v1:get:/application-roles');assert.deepEqual(input,{query:{key:roleKey}});assert.equal(options.write,false);return {ok:true,data:{results:rows}};},journal:()=>{}};
 const names=()=>OdcAccess.prototype.targetNames.call(access,'corp.test',{},operation,{path:{key:'user',roleKey}});
 assert.deepEqual(await names(),['DiagnosticApp',roleKey]);guardTarget('restore DiagnosticApp original role access',await names());
 for(const invalid of [[{key:'other',name:'DiagnosticApp'}],[{key:roleKey,name:'DiagnosticApp'},{key:roleKey,name:'DiagnosticApp'}],[]]){
  rows=invalid;assert.deepEqual(await names(),[roleKey]);assert.throws(()=>guardTarget('restore DiagnosticApp', [roleKey]),/name its target/);
 }
 assert.equal(calls,5);
});
