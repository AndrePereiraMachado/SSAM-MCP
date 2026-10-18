import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {portfolioRenamePlan,portfolioRenameApproval,portfolioRenameObservation,PORTFOLIO_RENAME} from '../runtime/portfolio-rename.mjs';
import {fingerprint,sha256} from '../runtime/write-journal.mjs';
const key=crypto.randomUUID(),current={key,name:'Portfolio',type:'Cloud',isMainPortfolio:true,nonProductionEnvironmentCount:1};
const inventory=()=>({ok:true,data:{page:{offset:0,totalResults:1},results:[structuredClone(current)]}});
test('rename plan preserves original metadata and prepares a baseline-bound restoration',()=>{
 const p=portfolioRenamePlan({inventory:inventory(),portfolioKey:key,name:'Temporary'});
 assert.deepEqual(p.body,{name:'Temporary'});assert.deepEqual(p.restore.body,{name:'Portfolio'});assert.equal(p.sent,false);
 assert.equal(p.restore.expectedConfigurationSha256,p.resultConfigurationSha256);
 for(const name of ['', ' ', 'Portfolio','x'.repeat(51),null])assert.throws(()=>portfolioRenamePlan({inventory:inventory(),portfolioKey:key,name}));
 for(const mutate of [x=>x.ok=false,x=>x.data.page.totalResults=2,x=>x.data.page.offset=1,x=>x.data.results.push(current)]){
  const i=inventory();mutate(i);assert.throws(()=>portfolioRenamePlan({inventory:i,portfolioKey:key,name:'Temporary'}));
 }
 const changed=inventory();changed.data.results[0]=structuredClone(p.after);assert.equal(portfolioRenameObservation(p.after,changed).verified,true);
 changed.data.results[0].type='Other';assert.equal(portfolioRenameObservation(p.after,changed).verified,false);
});
test('exact consent binds current name, key, body and complete before/after state',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portfolio-rename-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const p=portfolioRenamePlan({inventory:inventory(),portfolioKey:key,name:'Temporary'}),words='Synthetic portfolio rename and restore',proposal=path.join(dir,'proposal.md');fs.writeFileSync(proposal,'Rename own test portfolio');
 const file=path.join(dir,'approval.json');fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,
  source:{kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Synthetic approval'},
  proposal:{file:proposal,sha256:sha256(fs.readFileSync(proposal).toString())},scope:[{lane:'odc',host:'example.outsystems.dev',operation:PORTFOLIO_RENAME,targets:['Portfolio']}],
  constraints:{portfolioKey:key,expectedConfigurationSha256:p.expectedConfigurationSha256,bodySha256:fingerprint(p.body),resultConfigurationSha256:p.resultConfigurationSha256}}));
 const args={file,words,host:'example.outsystems.dev',operationId:PORTFOLIO_RENAME,input:{path:p.path,body:p.body},read:async()=>inventory()};
 assert.deepEqual((await portfolioRenameApproval(args)).expected,p.after);
 for(const override of [{words:'Other'}, {input:{path:p.path,body:{name:'Other'}}},{input:{path:p.path,body:{name:'Temporary',type:'Other'}}},
  {read:async()=>{const i=inventory();i.data.results[0].name='Concurrent rename';return i;}}])await assert.rejects(portfolioRenameApproval({...args,...override}));
});
