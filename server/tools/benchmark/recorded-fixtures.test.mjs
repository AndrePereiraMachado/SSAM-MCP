import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import { fileURLToPath } from 'node:url';
import {sanitizeRows,sanitizeExcerpt,createSanitizer,privacyIssues,fixtureBytes,MAX_FIXTURE_BYTES,MAX_FIXTURE_TOTAL_BYTES} from './sanitize-fixture.mjs';
import { classifyOutcome } from './measure/lane-outcomes.mjs';
import { analyzeRollout } from './measure/codex-context.mjs';
import { extractNormalizedCalls } from './measure/time-split.mjs';
const dir=fileURLToPath(new URL('./fixtures/recorded/',import.meta.url));
const files=()=>fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl'));
const read=f=>fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(JSON.parse);
test('recorded excerpts: deterministic, LF, bounded and sanitized',()=>{
 let total=0;assert.ok(files().length>=9);
 for(const f of files()){const raw=fs.readFileSync(dir+f,'utf8'),rows=read(dir+f);total+=Buffer.byteLength(raw);assert.ok(Buffer.byteLength(raw)<=MAX_FIXTURE_BYTES,f);assert.ok(!raw.includes('\r'),f);assert.deepEqual(privacyIssues(rows),[],f);assert.deepEqual(sanitizeRows(rows),sanitizeRows(rows),f);const expected=JSON.parse(fs.readFileSync(dir+f.replace('.jsonl','.expected.json'),'utf8'));assert.equal(rows.length,expected.records);assert.equal(Buffer.byteLength(raw),expected.bytes);assert.deepEqual(privacyIssues(expected),[],f+' expected');if(expected.shrunk?.length)for(const pointer of expected.shrunk)assert.match(pointer,/^\/\d+\//);}
 assert.ok(total<=MAX_FIXTURE_TOTAL_BYTES);
});
test('privacy scan includes revised tenant domains, escaped and project user paths, and network IPs but not versions',()=>{
 for(const value of ['synthetic.outsystems.app','SYNTHETIC.OUTSYSTEMS.DEV','x.outsystemsenterprise.net','C:\\Users\\synthetic-person\\private','C:\\\\Users\\\\synthetic-person\\private','C--Users-synthetic-person-private','https://10.20.30.40/a','http://127.0.0.1:8000','192.168.10.20:443','Bearer private-token','gAAAA0123456789abcdef','owner@example.com'])assert.ok(privacyIssues(value).length,value);
 assert.deepEqual(privacyIssues(['version 1.0.0.0','localhost']),[]);
 const privateRecord={creator_user_id:'account-private',creator_account_id:'user-private',payload:{output:JSON.stringify({creator_user_id:'private',creator_account_id:'private',token:'private',password:'private'})}};
 const sanitized=sanitizeRows([privateRecord]);assert.deepEqual(privacyIssues(sanitized),[]);assert.equal(sanitized[0].creator_user_id,undefined);assert.equal(JSON.parse(sanitized[0].payload.output).creator_account_id,undefined);
});
test('filler keeps Unicode bytes and JS length, distinct text, repeated text, and full identity across excerpt files',()=>{
 const rows=[{text:'Owner alpha é中😀\n"\\',id:'original-identifier-1'},{text:'Owner bravo é中😀\n"\\',parent_thread_id:'original-identifier-1'},{text:'Owner alpha é中😀\n"\\'}],out=sanitizeRows(rows);
 for(let i=0;i<rows.length;i++){assert.equal(out[i].text.length,rows[i].text.length);assert.equal(Buffer.byteLength(out[i].text),Buffer.byteLength(rows[i].text));}
 assert.notEqual(out[0].text,out[1].text);assert.equal(out[0].text,out[2].text);assert.equal(out[0].id,out[1].parent_thread_id);
 const idMap=new Map(),a=sanitizeRows([{id:'original-identifier-1'}],{idMap}),b=sanitizeRows([{parent_thread_id:'original-identifier-1'}],{idMap});assert.equal(a[0].id,b[0].parent_thread_id);
 const shared=createSanitizer(),one=shared.sanitizeRows([{id:'full-original-thread',text:'same evidence é中😀'}]),two=shared.sanitizeRows([{parent_thread_id:'full-original-thread',text:'same evidence é中😀'}]);assert.equal(one[0].id,two[0].parent_thread_id);assert.equal(one[0].text,two[0].text);
});
test('contract identity and owner continuation markers stay usable without preserving private text',()=>{
 const rows=[{type:'user',message:{role:'user',content:'siga'}},{type:'tool_use',input:{query:'api',intent:'read actions'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions for private-path'}]}},{type:'tool_use',input:{query:'read personal-zzzzzzzz.outsystems.dev'}}],out=sanitizeRows(rows);
 assert.equal(out[0].message.content,'siga');assert.equal(out[1].input.query,'api');assert.equal(out[1].input.intent,'read actions');assert.ok(out[2].payload.content[0].text.startsWith('# AGENTS.md instructions'));assert.deepEqual(privacyIssues(out),[]);
});
test('InputValidationError client evidence stays classified after sanitization',()=>{
 const output='<tool_use_error>InputValidationError: private owner details</tool_use_error>',sanitized=sanitizeRows([{message:{content:[{type:'tool_result',is_error:true,content:output}]}}])[0].message.content[0].content;
 assert.equal(classifyOutcome({name:'studio_deliver',isError:true,output:sanitized}).code,'CLIENT_INPUT_INVALID');assert.equal(sanitized.length,output.length);
});
test('oversize unmeasured context may shrink only explicit paths, with evidence fields preserved',()=>{
 const original=[{type:'prompt_snapshot',timestamp:'2026-01-01T00:00:00Z',payload:{text:'private text '.repeat(10000)},usage:{input_tokens:123}},{type:'token_usage_record',timestamp:'2026-01-01T00:00:01Z',payload:{usage:{input_tokens:456}}}];
 assert.throws(()=>sanitizeExcerpt(original),/64 KiB/);const excerpt=sanitizeExcerpt(original,{shrinkPaths:['/0/payload/text']});assert.deepEqual(excerpt.shrunk,['/0/payload/text']);assert.ok(excerpt.bytes<=MAX_FIXTURE_BYTES);assert.equal(excerpt.rows[0].payload.text,'[shrunk]');assert.deepEqual(excerpt.rows.map(r=>r.usage??r.payload.usage),original.map(r=>r.usage??r.payload.usage));assert.deepEqual(excerpt,sanitizeExcerpt(original,{shrinkPaths:['/0/payload/text']}));
 assert.throws(()=>sanitizeExcerpt(original,{shrinkPaths:['/1/payload/usage']}),/not an unmeasured/);
 assert.throws(()=>sanitizeExcerpt([{type:'compacted',payload:{replacement_history:[{type:'message',content:[],counter:1}]}}],{shrinkPaths:['/0/payload/replacement_history']}),/Only unmeasured text/);
});
test('real compacted excerpt is bounded and lists only unmeasured text shrink paths',()=>{
 const name='codex-compacted-shrunk',rows=read(dir+name+'.jsonl'),expected=JSON.parse(fs.readFileSync(dir+name+'.expected.json','utf8'));
 assert.equal(expected.originalRecordBytes,160022);assert.equal(expected.source,'recorded');assert.deepEqual(expected.shrunk,['/0/payload/replacement_history/19/encrypted_content','/0/payload/replacement_history/14/content/1/text']);assert.equal(rows[0].type,'compacted');assert.equal(analyzeRollout(rows).compactions,expected.measuredMetrics.compactions);assert.equal(rows[0].payload.replacement_history[19].encrypted_content,'[shrunk]');assert.equal(rows[0].payload.replacement_history[14].content[1].text,'[shrunk]');assert.equal(fixtureBytes(rows),expected.bytes);
});
test('sanitizer preserves Unicode byte lengths, IDs, nested JSON and structural values',()=>{
 const row={type:'response_item',timestamp:'2026-01-01T00:00:00Z',payload:{type:'function_call_output',call_id:'abc12345',output:JSON.stringify({ok:false,code:'BUILD_REFUSED',failed:'build',text:'private é中😀'})}};
 const out=sanitizeRows([row,row]);assert.equal(fixtureBytes(out),fixtureBytes([row,row]));assert.equal(out[0].payload.call_id,out[1].payload.call_id);assert.equal(JSON.parse(out[0].payload.output).code,'BUILD_REFUSED');assert.ok(!JSON.stringify(out).includes('private'));assert.deepEqual(out,sanitizeRows([row,row]));
});
test('shrunk compacted original preserves counted reset, every numeric field and record structure',{skip:process.env.BENCH_REAL_TRANSCRIPTS!=='1'||!fs.existsSync('C:/t/codex/cx10/complement-sanitize/compacted.original.jsonl')},()=>{
 const original=read('C:/t/codex/cx10/complement-sanitize/compacted.original.jsonl'),sanitized=read(dir+'codex-compacted-shrunk.jsonl'),expected=JSON.parse(fs.readFileSync(dir+'codex-compacted-shrunk.expected.json','utf8'));
 assert.deepEqual(sanitizeExcerpt(original,{shrinkPaths:expected.shrunk}).rows,sanitized);assert.deepEqual(numeric(original),numeric(sanitized));assert.equal(analyzeRollout(original).compactions,analyzeRollout(sanitized).compactions);assertTextSizes(original,sanitized,'',new Set(expected.shrunk));assert.deepEqual(shape(original),shape(sanitized));
});
function shape(v){if(Array.isArray(v))return v.map(shape);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,shape(x)]));return typeof v;}
test('module and entity names are text, only tool names stay visible',()=>{const rows=[{name:'PrivateOwnerModule',type:'entity'},{type:'tool_use',name:'mcp__ssam__ssam_map',input:{name:'PrivateOwnerModule'}}];const out=sanitizeRows(rows);assert.equal(out[1].name,'mcp__ssam__ssam_map');assert.ok(!JSON.stringify(out).includes('PrivateOwnerModule'));assert.equal(fixtureBytes(out),fixtureBytes(rows));});
test('additional fixtures prove recorded refusal and declared synthetic exceptions',()=>{const item=read(dir+'o11-refusal.jsonl')[0].payload.item;assert.equal(classifyOutcome({name:item.tool,args:item.arguments,output:item.result}).outcome,'refused');assert.equal(analyzeRollout(read(dir+'synthetic-compaction.jsonl')).compactions,1);const result=read(dir+'synthetic-delivered-published.jsonl')[0].message.content[0];assert.equal(classifyOutcome({name:'studio_deliver',output:result.content}).outcome,'accepted');});
test('copied-parent telemetry is excluded, fixture explicitly synthetic',()=>{assert.equal(extractNormalizedCalls([{rows:read(dir+'synthetic-parent-copy.jsonl')}]).length,0);assert.equal(JSON.parse(fs.readFileSync(dir+'synthetic-parent-copy.expected.json','utf8')).source,'synthetic');});
test('recorded original versus sanitized counts, durations, tokens and bytes',{skip:process.env.BENCH_REAL_TRANSCRIPTS!=='1'||!fs.existsSync('C:/t/codex/cx10/recorded-manifest.json')},()=>{
 for(const name of JSON.parse(fs.readFileSync('C:/t/codex/cx10/recorded-manifest.json','utf8'))){const original=read('C:/t/codex/cx10/'+name+'.original.jsonl'),sanitized=read(dir+name+'.jsonl'),expected=JSON.parse(fs.readFileSync(dir+name+'.expected.json','utf8'));assert.deepEqual(sanitizeExcerpt(original,{shrinkPaths:expected.shrunk??[]}).rows,sanitized);if(!expected.shrunk?.length)assert.ok(Math.abs(fixtureBytes(original)-fixtureBytes(sanitized))/fixtureBytes(original)<.01);for(let i=0;i<original.length;i++){assert.equal(original[i].timestamp,sanitized[i].timestamp);assert.deepEqual(numeric(original[i].payload?.usage??original[i].message?.usage),numeric(sanitized[i].payload?.usage??sanitized[i].message?.usage));assert.deepEqual(original[i].payload?.item?.duration,sanitized[i].payload?.item?.duration);assertTextSizes(original[i],sanitized[i],'/'+i,new Set(expected.shrunk??[]));}}
});
function assertTextSizes(original,sanitized,path,shrunk){if(shrunk.has(path)||sanitized===undefined)return;if(typeof original==='string'&&typeof sanitized==='string'){assert.equal(sanitized.length,original.length,path);assert.equal(Buffer.byteLength(sanitized),Buffer.byteLength(original),path);}else if(original&&typeof original==='object')for(const[k,v]of Object.entries(original))assertTextSizes(v,sanitized?.[k],path+'/'+k,shrunk);}

function numeric(v){if(typeof v==='number')return v;if(Array.isArray(v))return v.map(numeric);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([,x])=>typeof x==='number'||(x&&typeof x==='object')).map(([k,x])=>[k,numeric(x)]));return null;}
