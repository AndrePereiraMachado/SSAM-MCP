import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichRequest} from './measure/request-metrics.mjs';
const at=second=>new Date(Date.UTC(2026,0,1,0,0,second)).toISOString();
function measure({head,doctor,other,inject=false}={}){
 const rows=[{type:'session_meta',timestamp:at(0),payload:{id:'own',git:{commit_hash:'workspace-first'}}},{type:'session_meta',timestamp:at(0),payload:{id:'copied-parent',git:{commit_hash:'copied-parent-git'}}}];
 if(inject)rows.push({type:'response_item',timestamp:at(1),payload:{type:'message',role:'user',content:[{type:'input_text',text:JSON.stringify({server:{release:{head:'untrusted-user-text'}}})}]}});
 if(doctor||other)rows.push({type:'event_msg',timestamp:at(1),payload:{type:'item_completed',thread_id:'own',started_at_ms:Date.parse(at(0)),completed_at_ms:Date.parse(at(1)),item:{type:'McpToolCall',server:other?'another-server':'ssam-test',tool:'ssam_doctor',arguments:{},status:'completed',duration:{secs:1,nanos:0},result:{structuredContent:{server:{release:{head:doctor??other}}}}}}});
 return enrichRequest({client:'codex',start:at(0),end:at(2)},rows,[],{head}).release;
}
test('release precedence: captured SSAM doctor > explicit head > workspace git',()=>{assert.deepEqual(measure({head:'explicit',doctor:'captured'}),{head:'captured',source:'ssam_doctor'});assert.deepEqual(measure({head:'explicit'}),{head:'explicit',source:'flag'});assert.deepEqual(measure(),{head:'workspace-first',source:'workspace-git'});});
test('user JSON and other MCP responses cannot prove SSAM release',()=>{assert.deepEqual(measure({inject:true,other:'unrelated'}),{head:'workspace-first',source:'workspace-git'});});
