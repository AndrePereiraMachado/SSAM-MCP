import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SCHEMA, validateModel, validateSubmission, validateDecision } from '../../src/main/private-dialog/contract.mjs';
const model = extra => ({schema:SCHEMA,id:'12345678-abcd-1234',form:'login',host:'tenant.example.test',service:'users',...extra});
test('private dialog preserves exact display text and rejects secret/bootstrap extensions',()=>{
 const value=model({rows:[{label:'From page',value:'<script>&\n'+'x'.repeat(400),data:true}]});
 assert.deepEqual(validateModel(value),value);
 for(const extra of [{password:'secret'},{url:'https://attacker.test'},{id:1234567890123456},{rows:[{label:'A',value:'B',html:true}]}])assert.throws(()=>validateModel(model(extra)));
});
test('private dialog limits model bytes without truncating rows',()=>{
 assert.throws(()=>validateModel(model({rows:Array.from({length:8},()=>({label:'A',value:'x'.repeat(8000)}))})));
 assert.throws(()=>validateModel(model({form:'approve',rows:[]})));
});
test('login and new-password dialogs preserve secrets exactly with strict shape',()=>{
 const input={username:'Å user ',password:' p<&\n ',remember:false};assert.equal(validateSubmission(model(),input),input);
 assert.throws(()=>validateSubmission(model(),{...input,remember:'false'}));
 assert.throws(()=>validateSubmission(model(),{...input,extra:true}));
 assert.throws(()=>validateSubmission(model({form:'password'}),{password:'a',confirmation:'b'}),/PASSWORD_MISMATCH/);
 assert.deepEqual(validateSubmission(model({form:'password'}),{password:'a',confirmation:'a'}),{password:'a',confirmation:'a'});
});
test('approval and profile return only exact allowed intent',()=>{
 assert.throws(()=>validateSubmission(model({form:'approve'}),{approved:false}));
 assert.throws(()=>validateSubmission(model({form:'forget'}),{approved:true,host:'other'}));
 const m=model({form:'profile',profiles:[{profile:'a'.repeat(64),principal:'name'}]});validateModel(m);
 assert.equal(validateSubmission(m,{profile:'a'.repeat(64)}).profile,'a'.repeat(64));
 assert.throws(()=>validateSubmission(m,{profile:'b'.repeat(64)}));
 assert.throws(()=>validateModel({...m,profiles:[...m.profiles,...m.profiles]}));
});
test('core acknowledgement is bound and errors cannot inject arbitrary text',()=>{
 const m=model();assert.equal(validateDecision(m,{type:'decision',id:m.id,ok:true}).ok,true);
 for(const v of [{type:'decision',id:'foreign',ok:true},{type:'decision',id:m.id,ok:false,code:'password=secret'},{type:'decision',id:m.id,ok:true,code:'CREDENTIAL_STORE_FAILED'}])assert.throws(()=>validateDecision(m,v));
 assert.equal(validateDecision(m,{type:'decision',id:m.id,ok:false,code:'CREDENTIAL_STORE_FAILED'}).ok,false);
});
test('private page has no shared app API, HTML injection or network policy',()=>{
 const page=fs.readFileSync(new URL('../../src/renderer/private-dialog/index.html',import.meta.url),'utf8');
 const renderer=fs.readFileSync(new URL('../../src/renderer/private-dialog/main.mjs',import.meta.url),'utf8');
 const preload=fs.readFileSync(new URL('../../src/preload/private-dialog.mjs',import.meta.url),'utf8');
 assert.match(page,/connect-src 'none'/);assert.match(page,/form-action 'none'/);
 assert.doesNotMatch(renderer,/innerHTML|outerHTML|eval\(|console\./);assert.match(renderer,/textContent = text/);
 assert.doesNotMatch(preload,/readLog|setup:|setSettings|openFolder/);
});
