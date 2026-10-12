import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioApi } from '../service-center/studio-api.mjs';
import { serviceCenterArguments } from '../o11-operations.mjs';
import { READS } from '../service-center/index.mjs';

test('installation kind is exposed as a read and uses the existing native SOAP operation', async () => {
  const host='sc.example.test', calls=[];
  const api=new StudioApi({api:async(...args)=>{calls.push(args);return{result:{kind:'Cloud',databaseKind:'SQLServer',applicationServerType:'NET'}};}},host);
  assert.ok(READS.includes('installation-kind'));
  assert.ok(serviceCenterArguments({action:'installation-kind',host},'read').includes('installation-kind'));
  const result=await api.read('installation-kind',{});
  assert.deepEqual(calls,[[host,'soap','GetInstallationKind',{}]]);
  assert.deepEqual(result.result,{kind:'Cloud',databaseKind:'SQLServer',applicationServerType:'NET'});
});
