import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {organizationRenamePlan,organizationRenameObservation,ORGANIZATION_GET} from '../runtime/organization-rename.mjs';
const organization={id:crypto.randomUUID(),name:'Synthetic organization',ring:'GA',assetPortfolioCount:1,platformRegion:'us-east-1',dataPlatformRegion:'us-east-1'};
const result=()=>({ok:true,data:structuredClone(organization)});
test('organization name changes preserve all public state and restore the exact original',()=>{
 const p=organizationRenamePlan({result:result(),name:'Synthetic proof'});assert.equal(p.sent,false);assert.equal(p.liveVerified,false);
 assert.deepEqual(p.body,{name:'Synthetic proof'});assert.deepEqual({...p.after,name:organization.name},organization);
 const restore=organizationRenamePlan({result:{ok:true,data:p.after},name:p.restore.body.name});assert.deepEqual(restore.after,p.before);
 assert.equal(organizationRenameObservation(p.after,{ok:true,data:p.after}).verified,true);
 assert.equal(organizationRenameObservation(p.after,result()).verified,false);
 assert.equal(organizationRenameObservation(p.after,{ok:true,data:{...p.after,assetPortfolioCount:2}}).verified,false);
 for(const bad of [{ok:false,data:p.after},{ok:true,data:{...p.after,id:crypto.randomUUID()}},{ok:true,data:null}])assert.equal(organizationRenameObservation(p.after,bad).verified,false);
 assert.equal(organizationRenameObservation(p.after,result()).operationId,ORGANIZATION_GET);
 for(const name of ['', '   ',null,organization.name])assert.throws(()=>organizationRenamePlan({result:result(),name}),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 for(const data of [null,[],{...organization,id:'wrong'},{...organization,name:null}])assert.throws(()=>organizationRenamePlan({result:{ok:true,data},name:'New'}));
});
