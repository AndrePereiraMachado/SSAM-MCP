import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sanitizeRows,privacyIssues} from './sanitize-fixture.mjs';
import {isCont} from './measure/legacy-owner-continuation.mjs';
import {measureOwnerWait} from './measure/owner-wait.mjs';
import {analyzeCodex,analyzeClaude} from './analyze.mjs';

const at=n=>new Date(Date.UTC(2026,0,1,0,0,n)).toISOString();
const phrases=['ok, pode seguir','sim.','s, segue','1)','pode!'];
function fixture(client,phrase){
 if(client==='claude')return [
  {type:'user',uuid:'request-a',timestamp:at(0),message:{content:'Build synthetic feature'}},
  {type:'assistant',timestamp:at(10),message:{id:'message-a',content:[{type:'text',text:'Ready'}]}},
  {type:'user',uuid:'request-b',timestamp:at(40),message:{content:phrase}},
  {type:'assistant',timestamp:at(45),message:{id:'message-b',content:[{type:'text',text:'Done'}]}}
 ];
 const row=(type,payload,n)=>({type,payload,timestamp:at(n)});
 return [row('session_meta',{id:'session-a'},0),row('event_msg',{type:'task_started',turn_id:'turn-a'},0),
  row('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'Build synthetic feature'}]},1),
  row('event_msg',{type:'turn_aborted'},10),
  row('response_item',{type:'message',role:'user',content:[{type:'input_text',text:phrase}]},40),
  row('event_msg',{type:'task_started',turn_id:'turn-b'},40),
  row('event_msg',{type:'task_complete'},45)];
}
function humanText(rows,client){return client==='claude'?rows[2].message.content:rows[4].payload.content[0].text;}
for(const client of ['claude','codex'])for(const phrase of phrases)test(`${client}: continuation boundary survives sanitization (${phrase})`,()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'continuation-boundary-'));
 try{
  const original=fixture(client,phrase),sanitized=sanitizeRows(original);
  const file=path.join(directory,'synthetic.jsonl');fs.writeFileSync(file,sanitized.map(JSON.stringify).join('\n')+'\n');
  const saved=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(isCont(humanText(original,client)),true);assert.equal(isCont(humanText(saved,client)),true);
  const before=measureOwnerWait(original,[],{client}),after=measureOwnerWait(saved,[],{client});
  assert.equal(before.reduce((n,w)=>n+w.sec,0),30);assert.deepEqual(after,before);
  const analyze=client==='claude'?analyzeClaude:analyzeCodex;
  const beforeGroups=analyze(original,{file}),afterGroups=analyze(saved,{file});
  assert.equal(beforeGroups.length,1);assert.equal(afterGroups.length,beforeGroups.length);
  assert.deepEqual(privacyIssues(saved),[]);
  assert.equal(Buffer.byteLength(humanText(saved,client)),Buffer.byteLength(phrase));
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});

test('Only continuation lexical evidence survives, never a private suffix',()=>{
 const suffix='private-message-details';const phrase='ok, '+suffix;
 const sanitized=sanitizeRows(fixture('claude',phrase));
 assert.equal(isCont(humanText(sanitized,'claude')),true);
 assert.ok(!JSON.stringify(sanitized).includes(suffix));
});
