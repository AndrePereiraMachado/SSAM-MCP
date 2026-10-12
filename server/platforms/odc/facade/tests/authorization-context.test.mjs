import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {authorizationContext} from '../authorization-context.mjs';
import {validateCreateAppInput} from '../studio-create-app.mjs';

test('context binds literal human approval to proposal hash, lane, host, operation and exact targets', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-approval-'));t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
 const file=path.join(dir,'approval.json'),proposal=path.join(dir,'proposal.md'),words='Pode sim, e depois apague.';
 fs.writeFileSync(proposal,'Create, publish and delete the disposable Proof app at example.test.');
 const record={schema:'ssam-authorization-context/1',decision:'approved',words,
   source:{kind:'human-conversation',threadId:'11111111-2222-3333-4444-555555555555',messageId:'22222222-2222-3333-4444-555555555555',question:'May I execute the attached proposal?'},
   proposal:{file:proposal,sha256:createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},
   scope:[{lane:'odc',host:'example.test',operation:'create',targets:['Proof']}]};
 const save=()=>fs.writeFileSync(file,JSON.stringify(record));save();
 const scope={lane:'odc',host:'example.test',operation:'create',targets:['Proof']};
 assert.equal(authorizationContext(undefined,words,scope),null);
 assert.deepEqual(authorizationContext(file,words,scope).targets,['Proof']);
 record.scope[0].operation='create-app';save();
 const input={kind:'reactive',name:'Proof',module:'Proof',tenant:'example.test',authorize:words,authorizationContext:file};
 assert.equal(validateCreateAppInput(input),null);
 assert.equal(validateCreateAppInput({...input,publish:true}).code,'AUTHORIZATION_CONTEXT_INVALID');
 assert.equal(validateCreateAppInput({...input,tenant:'other.test'}).code,'AUTHORIZATION_CONTEXT_INVALID');
 assert.equal(validateCreateAppInput({...input,module:'Other'}).code,'AUTHORIZATION_CONTEXT_INVALID');
 record.scope[0].operation='create';save();
 for(const change of [{lane:'o11'},{host:'other.test'},{operation:'delete'},{targets:['Proof2']},{targets:['Proof','Consumer']},{targets:[]}])
   assert.throws(()=>authorizationContext(file,words,{...scope,...change}),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 assert.throws(()=>authorizationContext(file,'different words',scope),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 record.decision='rejected';save();assert.throws(()=>authorizationContext(file,words,scope),{code:'AUTHORIZATION_CONTEXT_INVALID'});
 record.decision='approved';save();fs.appendFileSync(proposal,' changed');
 assert.throws(()=>authorizationContext(file,words,scope),{code:'AUTHORIZATION_CONTEXT_INVALID'});
});
