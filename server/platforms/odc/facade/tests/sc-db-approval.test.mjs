import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {approveDatabasePlan} from '../service-center/db-approval.mjs';
import {serviceCenterArguments} from '../o11-operations.mjs';

test('contextual SQL approval binds provider, endpoint, catalog, exact name and no consumers', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sc-db-approval-'));
  try {
    const proposal=path.join(root,'proposal.md'), file=path.join(root,'approval.json'), words='Autorizo esse escopo e sua exclusão';
    fs.writeFileSync(proposal,'One disposable SQL connection, no data or schema changes.');
    const constraints={server:'sql.example.test',port:1433,database:'Disposable',noDdl:true,noDataWrites:true,
      noBusinessDataReads:true,deleteTemporaryConnections:true,requiresTestedHeadlessTransport:true};
    const actions=['db-connection-create','db-connection-test','db-connection-delete'];
    fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,
      source:{kind:'human-conversation',threadId:'11111111-2222-3333-4444-555555555555',messageId:'22222222-2222-3333-4444-555555555555',question:'Approve the exact temporary connection?'},
      proposal:{file:proposal,sha256:createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},constraints,
      scope:actions.map(operation=>({lane:'o11',host:'personal-proof.outsystemscloud.com',operation,targets:['SQLProof']}))}));
    for(const action of actions){
      const plan={host:'personal-proof.outsystemscloud.com',action,connection:'SQLProof',dbms:'SQL Server',parameters:{server:'sql.example.test,1433',database:'Disposable'},usedBy:[]};
      assert.equal(approveDatabasePlan(file,words,plan).operation,action);
      for(const bad of [{connection:'Other'}, {dbms:'Oracle'}, {usedBy:['BusinessExtension']},
        {parameters:{server:'other.example.test',database:'Disposable'}}, {parameters:{server:'sql.example.test,1433',database:'Business'}}])
        assert.throws(()=>approveDatabasePlan(file,words,{...plan,...bad}));
      assert.ok(serviceCenterArguments({action,authorizationContext:file,host:plan.host,connection:plan.connection},'write').includes('--authorization-context='+file));
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
