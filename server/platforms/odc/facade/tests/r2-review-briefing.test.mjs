import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as store from '../hosted/verified-store.mjs';
import { customerStateDir } from '../hosted/storage.mjs';
import { hostedCheck, checkSlots } from '../hosted/checks.mjs';
import { codeCheck } from '../code-check.mjs';
import { runWithExecutor } from '../executor.mjs';
import { buildBeforeApply, withCheckedCandidate } from '../o11-build-phase.mjs';
import { withStudioWriteLock } from '../studio-write-lock.mjs';
import { createBuildPool } from '../build-pool.mjs';
import { modelSha256 } from '../o11-capture-store.mjs';
import { nextSection } from '../work-packet.mjs';
import * as planning from '../code-plan.mjs';
import { wrapHostedTool } from '../hosted/policy.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';
import { registerO11Cycle } from '../o11-cycle.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { fileURLToPath } from 'node:url';
test.after(cleanupHostedDirs);
const sha = b => createHash('sha256').update(b).digest('hex');
const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return file; };
const oml = model => { const h = Buffer.from('{}'), n = Buffer.alloc(4); n.writeUInt32LE(h.length); return Buffer.concat([Buffer.from('OML'),n,h,Buffer.from(model)]); };
function setup(t, slots) {
  const d = hostedDirs(os.tmpdir()), ws = d.workspace;
  const agent = fakeAgentLink({ agentRoot: d.agentRoot, connected: true });
  const context = { hosted:true, workspace:ws, agent, lanes:['o11'], executor:{call:async()=>{throw Error('No machine call');},quota:{full:()=>false},o11Connection:()=>({pid:6001})} };
  const base = put(path.join(ws,'o11','base.oml'),oml('base'));
  const deps={root:ws,local:path.join(ws,'o11'),odcRoot:path.join(ws,'odc'),env:{ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1'},
    writeCall:()=>({tool:'o11_deliver',arguments:{job:{ops:[]}}}),runJob:async input=>{
      put(path.join(input.work,'model.bin'),'work');put(input.out,oml('candidate'));
      put(input.out.replace(/\.oml$/,'.kernel-result.json'),JSON.stringify({isValid:true,accepted:true,sources:[{path:input.job,sha256:sha(fs.readFileSync(input.job))}]}));
      return {ok:true,job:input.job};
    }};
  const check=hostedCheck(context,i=>codeCheck(i,deps),{slots:checkSlots(slots)});
  return {ws,context,base,deps,check:i=>runWithExecutor(context,()=>check({lane:'o11',module:'Inventory',base,...i}))};
}
const size = dir => { let n=0;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);n+=e.isDirectory()?size(p):fs.statSync(p).size;}return n; };
async function build(s, offer, { producers, hosted=true, document={ops:[]}, sources=[], resolveRelative=false, onBuild }={}) {
  const job=put(path.join(s.ws,'o11','delivery.json'),JSON.stringify(document));
  const lane={local:path.join(s.ws,'o11'),work:path.join(s.ws,'o11','work'),name:'ss4'};
  const ctx={root:s.ws,env:{},now:()=>new Date(),buildPool:createBuildPool({dir:path.join(s.ws,'pool'),size:1}),
    bridge:()=>({ok:async(method,args)=>method==='list_open_modules'?{modules:[{name:'Inventory',key:'K',hasESpace:true}]}:{path:put(args.path,oml('base')),key:'K'}}),
    buildRunner:()=>async args=>{const out=args[args.indexOf('--out')+1],j=args[args.indexOf('--job')+1];onBuild?.(j);
      const extra=resolveRelative?[...new Set([document.base,...document.ops.map(o=>o.producer)].filter(v=>v?.startsWith('job:')).map(v=>path.resolve(path.dirname(j),v.slice(4)+'.json')))].map(file=>({path:file,sha256:sha(fs.readFileSync(file))})):sources;
      put(out,oml('candidate'));put(out.replace(/\.oml$/,'.result.json'),JSON.stringify({isValid:true,accepted:true,sources:[{path:j,sha256:sha(fs.readFileSync(j))},...extra]}));return{envelope:{ok:true,data:{isValid:true,accepted:true}}};}};
  const run=()=>withStudioWriteLock({tool:'o11_deliver',args:{module:'Inventory',job},lane:'o11',deps:{o11Root:s.ws,odcRoot:s.ws,connection:()=>null},phased:true},
    ()=>withCheckedCandidate(offer,()=>buildBeforeApply({input:{module:'Inventory',...(producers?{producers}:{})},job,ctx,lane,task:{id:'preview'}})));
  return {built:await (hosted?runWithExecutor(s.context,run):run()),job};
}
test('review 1 hosted preview uses delivery job sources, preventing job-changed',async t=>{
  const s=setup(t),{built,job}=await build(s,null);
  const manifest=JSON.parse(fs.readFileSync(built.manifest)), result=JSON.parse(fs.readFileSync(manifest.result));
  assert.deepEqual(result.sources,[{path:path.resolve(job),sha256:sha(fs.readFileSync(job))}]);
});
test('review 2 equal checks retain one candidate and remove private work; stale state expires',async t=>{
  const s=setup(t),first=await s.check(),before=size(s.ws),refs=[first.candidateRef];
  for(let i=0;i<2;i++)refs.push((await s.check()).candidateRef);
  assert.ok(first.candidateRef);assert.deepEqual(refs,[first.candidateRef,first.candidateRef,first.candidateRef]);assert.equal(size(s.ws),before);
  const root=customerStateDir(s.ws);
  assert.deepEqual(fs.readdirSync(path.join(root,'checks')),[]);
  store.candidateOffer(s.ws,first.candidateRef,{lane:'o11',module:'Inventory'});
  put(path.join(root,'builds','expired','x'),'x');
  const old=new Date(0);for(const rel of ['builds/expired','verified/candidate/'+first.candidateRef,'verified/candidate/'+first.candidateRef+'.json'])fs.utimesSync(path.join(root,rel),old,old);
  store.sweepVerified(s.ws,{now:Date.now()});
  assert.equal(fs.existsSync(path.join(root,'builds','expired')),false);
  assert.throws(()=>store.candidateOffer(s.ws,first.candidateRef,{lane:'o11',module:'Inventory'}));
});
test('review 4 worker checks preserve the original next and never offer write',async t=>{
  const s=setup(t),stub=put(path.join(s.ws,'inbox','stub.flow'),'server action Stub\n  end');
  const answer=await s.check({stubs:[stub]});assert.equal(answer.ok,true);assert.equal(answer.write,undefined);assert.match(answer.next,/answer only the file path/);
});
test('review 3 original listing overruns and hosted core ceiling are restored',async t=>{
  const { TOOL_LISTING_OVERRUN_BYTES,toolListingBytes }=await import('../tool-listing.mjs');
  assert.equal(TOOL_LISTING_OVERRUN_BYTES.o11_deliver,572);assert.equal(TOOL_LISTING_OVERRUN_BYTES.ssam_code,898);
  const {createSsamServer}=await import('../ssam.mjs'),{InMemoryTransport}=await import('@modelcontextprotocol/server'),{Client}=await import('@modelcontextprotocol/client');
  const server=await createSsamServer({profile:'app'}),client=new Client({name:'review',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
  const tools=(await client.listTools()).tools,core=['ssam_doctor','ssam_connect','ssam_discover','ssam_map','ssam_code','ssam_reference','ssam_evidence','ssam_task','o11_inspect','o11_deliver','o11_publish','o11_studio','studio_deliver','studio_inspect','studio_status'];
  assert.ok(core.reduce((n,name)=>n+toolListingBytes(tools.find(t=>t.name===name)),0)<=34097);
});
test('review 6 plan counts requested elements rather than rename identifiers',()=>{
  assert.equal(!!nextSection({lane:'o11',intent:'rename GetOrder to LoadOrder'}).plan,false);
  assert.equal(!!nextSection({lane:'o11',intent:'create action GetOrder returning CustomerDto'}).plan,false);
  for(const intent of ['create two screens','criar duas telas e três ações','create 12 screens','add Orders and Customers entities','create twenty-one screens','criar vinte e duas telas'])assert.ok(nextSection({lane:'o11',intent}).plan,intent);
  assert.equal(!!nextSection({lane:'o11',intent:'fix the Save button on Orders screen and the Total label'}).plan,false);
});
test('review 7 briefing uses kernel contract and catalog pitfalls',async t=>{
  assert.equal(typeof planning.planBriefing,'function');
  const index={contracts:{logic:{flow:{required:['action'],kernelSentinel:'flow-contract'}}},capabilities:[{id:'logic.flow',contract:['logic.flow'],limits:['catalog-sentinel'],guidance:{origin:'kernel'}}]};
  const b=await planning.planBriefing('o11',['logic'],{briefingIndex:index});
  assert.equal(b.contract['logic.flow'].kernelSentinel,'flow-contract');assert.equal(b.pitfalls[0].limits[0],'catalog-sentinel');
  const s=setup(t),plan=await planning.codePlan({lane:'o11',module:'Inventory',items:[{kind:'action',name:'Lookup',intent:'Look up a row',signature:'server action Lookup'}]},
    {...s.deps,briefingIndex:index,newestCapture:()=>({path:s.base,sha256:sha(fs.readFileSync(s.base))}),moduleDigest:async()=>({ok:true,digest:{module:{name:'Inventory'},actions:[],sections:[]}})});
  assert.equal(plan.ok,true);const prompt=fs.readFileSync(plan.batches[0].promptFile,'utf8');assert.match(prompt,/flow-contract/);assert.match(prompt,/catalog-sentinel/);
});
test('review 8 verified references are isolated by backend',t=>{
  const s=setup(t),old=process.env.SSAM_BACKEND_NAME;t.after(()=>old===undefined?delete process.env.SSAM_BACKEND_NAME:process.env.SSAM_BACKEND_NAME=old);
  process.env.SSAM_BACKEND_NAME='backend-a';const ref=store.keepVerified(s.ws,'patch',{jobSha256:'a',patch:[]});
  process.env.SSAM_BACKEND_NAME='backend-b';assert.throws(()=>store.readVerified(s.ws,'patch',ref));
});
test('review 9 a changed producer invalidates the retained candidate',async t=>{
  const s=setup(t),answer=await s.check();let offer=store.candidateOffer(s.ws,answer.candidateRef,{lane:'o11',module:'Inventory'});
  const producer=put(path.join(s.ws,'o11','library.oml'),'old');offer.candidate.producers={Library:{path:producer,sha256:sha('old')}};
  const ref=store.keepCandidate(s.ws,{lane:'o11',module:'Inventory',candidate:offer.candidate});
  offer=store.candidateOffer(s.ws,ref,{lane:'o11',module:'Inventory'});assert.equal(offer.candidate.producers.Library.sha256,sha('old'));
  await build(s,offer,{producers:{Library:producer}});assert.equal(offer.outcome.reused,true);
  put(producer,'new');await build(s,offer,{producers:{Library:producer}});assert.equal(offer.outcome.reused,false);
});
test('review 10 visible manifests are refused; check ref passes through delivery gate',async t=>{
  const s=setup(t),checked=await s.check(),c=store.candidateOffer(s.ws,checked.candidateRef,{lane:'o11',module:'Inventory'}).candidate;
  const manifest=put(path.join(s.ws,'o11','manifest.json'),JSON.stringify({base:c.base,job:c.job,candidate:c.path,result:c.result,candidateSha256:c.sha256,baseSha256:c.baseSha256,baseModelSha256:c.baseModelSha256,producers:{}}));
  assert.throws(()=>store.keepPreview(s.ws,'Inventory',manifest));let reused;
  const gate=wrapHostedTool('o11_deliver',{inputSchema:{}},async()=>{
    const {checkedCandidateOffer}=await import('../o11-build-phase.mjs');const offer=checkedCandidateOffer();await build(s,offer);reused=offer.outcome.reused;
    return {content:[{type:'text',text:'{"ok":true}'}],structuredContent:{ok:true}};
  },{context:s.context,run:(_,fn)=>fn()});
  const result=await gate({module:'Inventory',job:{ops:[]},candidateRef:checked.candidateRef},{});
  assert.equal(result.structuredContent.ok,true);assert.equal(reused,true);
});
test('review 11 retention disk failure preserves successful validation; offer errors redact paths',async t=>{
  const s=setup(t);put(path.join(customerStateDir(s.ws),'verified'),'block');const answer=await s.check();assert.equal(answer.ok,true);assert.equal(answer.candidateRef,undefined);assert.match(answer.retention,/could not be retained/);
  const other=setup(t),ref=(await other.check()).candidateRef,dir=path.join(customerStateDir(other.ws),'verified','candidate',ref);
  fs.rmSync(dir,{recursive:true,force:true});put(dir,'block');
  assert.throws(()=>store.candidateOffer(other.ws,ref,{lane:'o11',module:'Inventory'}),e=>!e.message.includes(other.ws));
  const atomic=setup(t),rename=fs.renameSync;let attempted=false;
  fs.renameSync=()=>{attempted=true;throw Error('disk failure');};
  try{assert.throws(()=>store.keepVerified(atomic.ws,'patch',{patch:[]}));}finally{fs.renameSync=rename;}
  assert.equal(attempted,true);assert.deepEqual(fs.readdirSync(path.join(customerStateDir(atomic.ws),'verified','patch')),[]);
});

test('round 2 item 1 composed preview preserves every dependency source',async t=>{
  const s=setup(t),parts=['base','producer'].map(name=>put(path.join(s.ws,'o11',name+'.json'),'{"ops":[]}'));
  const sources=parts.map(file=>({path:file,sha256:sha(fs.readFileSync(file))}));
  const {built,job}=await build(s,null,{document:{base:'job:'+parts[0],ops:[{op:'reference',producer:'job:'+parts[1]}]},sources});
  const manifest=JSON.parse(fs.readFileSync(built.manifest)),result=JSON.parse(fs.readFileSync(manifest.result));
  assert.deepEqual(result.sources,[{path:job,sha256:sha(fs.readFileSync(job))},...sources]);
});

function realResult(s, at, hot) {
  const previous=s.deps.runJob;
  s.deps.runJob=async input=>{const answer=await previous(input),file=input.out.replace(/\.oml$/,'.kernel-result.json'),result=JSON.parse(fs.readFileSync(file));
    result.provenance={schema:'anvil-job-provenance/2',suite:'o11',at,platform:'O11',ideVersion:'11',jobSha256:sha(fs.readFileSync(input.job)),baseKind:'fixture',baseSha256:sha(fs.readFileSync(s.base)),kernelSha256:'a'.repeat(64),nativeAssemblies:{'Studio.dll':'b'.repeat(64)}};
    if(hot)result.hot=hot;put(file,JSON.stringify(result));return answer;};
}
test('round 2 item 2 real provenance times do not change refs; materialization is reused and size is bounded',async t=>{
  const s=setup(t);realResult(s,'2026-10-28T12:00:00Z');const first=await s.check();assert.ok(first.candidateRef);
  const dir=path.join(customerStateDir(s.ws),'verified','candidate',first.candidateRef),file=path.join(dir,'candidate.oml');
  assert.equal(fs.existsSync(dir),false,'checking stores only the bundle, not a second materialization');
  store.candidateOffer(s.ws,first.candidateRef,{lane:'o11',module:'Inventory'});
  const old=new Date(Date.now()-10000);fs.utimesSync(file,old,old);const stamp=fs.statSync(file).mtimeMs,before=size(s.ws);
  realResult(s,'2026-10-28T12:00:01Z');const second=await s.check();assert.equal(second.candidateRef,first.candidateRef);assert.equal(size(s.ws),before);assert.equal(fs.statSync(file).mtimeMs,stamp);
  assert.equal(typeof store.VERIFIED_MAX_BYTES,'number');
  store.sweepVerified(s.ws,{maxBytes:1});assert.ok(size(path.join(customerStateDir(s.ws),'verified'))<=1);
});
test('round 2 item 3 original discover projection and reviews are preserved and new fields explain themselves',async t=>{
  const {TOOL_LISTING,TOOL_LISTING_REVIEWS}=await import('../tool-listing.mjs');
  assert.equal(TOOL_LISTING_REVIEWS.ssam_discover.description,'a15784930698af510d83bd52356dcc2a330ed5f4a68a20cc4c94959a7b0ad4c2');
  assert.equal(TOOL_LISTING_REVIEWS.ssam_code.description,'3497feeb0e626f9ba6fc27c11e4776cefc617ac050e0673f6f924d11baa1b202');
  assert.ok(TOOL_LISTING.ssam_code.description.includes('plan only:items/element,shared absolute ddl/json,workers batches'));
  assert.ok(TOOL_LISTING.ssam_code.description.includes('check only:latest capture,base absolute OML,stubs absolute flow/html signatures'));
  assert.match(TOOL_LISTING.ssam_discover.description,/`tools` gives the exact MCP tool/);
  const {createSsamServer}=await import('../ssam.mjs'),{InMemoryTransport}=await import('@modelcontextprotocol/server'),{Client}=await import('@modelcontextprotocol/client');
  const server=await createSsamServer({profile:'app'}),client=new Client({name:'round2',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
  const tools=Object.fromEntries((await client.listTools()).tools.map(t=>[t.name,t]));
  const {toolListingBytes}=await import('../tool-listing.mjs');
  const core=['ssam_doctor','ssam_connect','ssam_discover','ssam_map','ssam_code','ssam_reference','ssam_evidence','ssam_task','o11_inspect','o11_deliver','o11_publish','o11_studio','studio_deliver','studio_inspect','studio_status'];
  assert.ok(core.reduce((n,name)=>n+toolListingBytes(tools[name]),0)<=34057);
  for(const [name,fields]of Object.entries({ssam_discover:['packetRef','parallel']}))
    for(const field of fields)assert.ok(tools[name].inputSchema.properties[field].description?.length,`${name}.${field}`);
});
test('round 2 item 5 briefing tests have a unique integration filename',()=>{
  // Only this package's own file: tests/r2-review.test.mjs belongs to another R2 line and stays there after the merge.
  const own=fileURLToPath(new URL('./r2-review-briefing.test.mjs',import.meta.url));
  assert.equal(path.resolve(own),path.resolve(fileURLToPath(import.meta.url)));
  assert.match(fs.readFileSync(own,'utf8'),/round 2 item 5 briefing tests have a unique integration filename/);
});
test('round 2 item 6 expired verified patches carry the original explicit recovery',async t=>{
  const s=setup(t),job=put(path.join(s.ws,'o11','job.json'),'{"ops":[]}'),patch=[{op:'add',path:'/ops/-',value:{op:'find',name:'x'}}],basedOn={job,sha256:sha(fs.readFileSync(job))};s.context.lanes=['o11','odc'];
  put(job+'.verified-patch.json',JSON.stringify({schema:'ssam-verified-patch/1',job,jobSha256:basedOn.sha256,patch}));
  const ref=store.keepVerified(s.ws,'patch',{jobSha256:basedOn.sha256,patch}),file=path.join(customerStateDir(s.ws),'verified','patch',ref+'.json');fs.utimesSync(file,new Date(0),new Date(0));store.sweepVerified(s.ws);
  for(const name of ['o11_deliver','studio_deliver','ssam_code','ssam_reference']){
    const gate=wrapHostedTool(name,{inputSchema:{}},()=>{throw Error('must not execute');},{context:s.context,run:(_,fn)=>fn()});
    const args=name==='ssam_reference'?{lane:'o11',kind:'check-job',query:{basedOn,patch:{verified:ref}}}:{lane:'o11',module:'Inventory',basedOn,patch:{verified:ref}};
    const answer=(await gate(args,{})).structuredContent;assert.equal(answer.ok,false);assert.equal(answer.continuation?.tool,name);
    assert.deepEqual(name==='ssam_reference'?answer.continuation.arguments.query.patch:answer.continuation.arguments.patch,patch);
  }
});
test('round 2 item 7 hot hints survive reuse outside the content hash',async t=>{
  const s=setup(t),hot={reused:true,reason:'same model',savedMs:123,modelSha256:modelSha256(s.base)};realResult(s,'2026-10-28T12:00:00Z',hot);
  const first=await s.check();realResult(s,'2026-10-28T12:00:00Z',{...hot,savedMs:456});const second=await s.check();assert.equal(first.candidateRef,second.candidateRef);
  const offer=store.candidateOffer(s.ws,second.candidateRef,{lane:'o11',module:'Inventory'}),{built}=await build(s,offer);assert.equal(built.hot?.savedMs,456);
  assert.equal(JSON.stringify(store.readVerified(s.ws,'candidate',first.candidateRef)).includes('same model'),false);
});
test('round 2 item 4 check ref reaches the real o11_deliver handler with its hot hint',async t=>{
  const s=setup(t),hot={reused:true,reason:'checked model',savedMs:123,modelSha256:modelSha256(s.base)};realResult(s,'2026-10-28T12:00:00Z',hot);const checked=await s.check();
  let handler,config,prebuilt;
  const option=(args,k)=>args[args.indexOf(k)+1];
  // check-job: the static preflight a delivery may run first answers with its verdict.
  const runner=fakeAnvil({'check-job':()=>({ok:true,data:{valid:true}}),deliver:async args=>{prebuilt=JSON.parse(fs.readFileSync(option(args,'--prebuilt')));const work=path.join(option(args,'--work'),'deliver','d'.repeat(32));fs.mkdirSync(work,{recursive:true});return{ok:true,data:{delivered:true,taskId:'d'.repeat(32),work,writeState:'applied',module:'Inventory',apply:{isValid:true,accepted:true,prebuilt:{reused:true}}}};}});
  registerO11Cycle({registerTool:(name,c,h)=>{if(name==='o11_deliver'){handler=h;config=c;}}},{root:s.ws,lane:'ss4',env:{ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1',USERPROFILE:s.ws,LOCALAPPDATA:s.ws},runAnvil:runner,buildRunner:()=>{throw Error('must reuse checked candidate');},buildPool:createBuildPool({dir:path.join(s.ws,'pool'),size:1}),registerTask:false,journal:()=>{},assertSelected:async()=>{},lastPublication:async()=>null,
    bridge:{ok:async(method,args)=>{if(method==='list_open_modules')return{modules:[{name:'Inventory',key:'K',hasESpace:true}]};if(method==='snapshot_module')return{path:put(args.path,oml('base')),key:'K'};throw Error(method);}}});
  const gate=wrapHostedTool('o11_deliver',config,handler,{context:s.context,run:(_,fn)=>fn()});
  const args={module:'Inventory',job:{ops:[]},candidateRef:checked.candidateRef,authorize:'Pode entregar o módulo Inventory'};
  const result=await runWithExecutor(s.context,()=>withStudioWriteLock({tool:'o11_deliver',args,lane:'o11',deps:{o11Root:s.ws,odcRoot:s.ws,connection:()=>null},phased:true},()=>gate(args,{})));
  assert.ok(prebuilt,JSON.stringify(result));assert.equal(prebuilt.hot?.savedMs,123);assert.equal(runner.calls.filter(c=>c.args[0]==='deliver').length,1);
});

test('compact patch schemas retain validation and return an executable corrected call',async t=>{
  const s=setup(t);s.context.lanes=['o11','odc'];const job=put(path.join(s.ws,'o11','patch-base.json'),JSON.stringify({ops:[{op:'find',name:'old'}]}));
  for(const name of ['o11_deliver','studio_deliver','ssam_code','ssam_reference']){
    let called=0;const gate=wrapHostedTool(name,{inputSchema:{}},async()=>{called++;return{structuredContent:{ok:true}};},{context:s.context,run:(_,fn)=>fn()});
    const holder={basedOn:{job,sha256:sha(fs.readFileSync(job))},patch:[{op:'replace',path:'/ops/0/name',value:'new',extra:'invalid'}]};
    const args=name==='ssam_reference'?{lane:'o11',kind:'check-job',query:holder}:{lane:'o11',action:'write',module:'Inventory',...holder};
    const refusal=(await gate(args,{})).structuredContent;assert.equal(refusal.code,'PATCH_INVALID',name+': '+JSON.stringify(refusal));assert.equal(called,0);
    assert.deepEqual(name==='ssam_reference'?refusal.corrected.query.patch:refusal.corrected.patch,[{op:'replace',path:'/ops/0/name',value:'new'}]);
    assert.equal((await gate(refusal.corrected,{})).structuredContent.ok,true);assert.equal(called,1);
  }
});

test('round 3 item 1 B2 restores original text costs and candidate refs are supplied by checks',async t=>{
  const {createSsamServer}=await import('../ssam.mjs'),{InMemoryTransport}=await import('@modelcontextprotocol/server'),{Client}=await import('@modelcontextprotocol/client');
  const L=await import('../tool-listing.mjs'),server=await createSsamServer({profile:'app'}),client=new Client({name:'round3',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
  const tools=Object.fromEntries((await client.listTools()).tools.map(t=>[t.name,t]));
  for(const [name,text,overrun]of [['ssam_code',1922,898],['o11_deliver',1596,572]]){
    const tool=tools[name];assert.equal(tool.inputSchema.properties.candidateRef.description,undefined);
    assert.equal(L.toolListingBytes(tool)-L.toolStructureBytes(tool),text);assert.equal(L.toolListingBytes(tool)-L.toolListingLimit(tool),overrun);
  }
  assert.equal(L.TOOL_LISTING_REVIEWS.o11_deliver['/properties/patch'],'712cc2860ddb686e132e1088f4dba092da5bcaf21947b7cbe20a45c61d1863e0');
});
test('round 3 item 2 real kernel fields and reference sidecar retain one reusable content ref',async t=>{
  const s=setup(t),previous=s.deps.runJob;let n=0;
  s.deps.runJob=async input=>{const answer=await previous(input),file=input.out.replace(/\.oml$/,'.kernel-result.json'),result=JSON.parse(fs.readFileSync(file));n++;
    const sidecar=put(input.out+'.references.json',JSON.stringify({references:[{key:'K',name:'Library'}]}));
    Object.assign(result,{items:[{name:'Teams'}],loadMs:n,applyMs:n+1,hotTimings:{warmMs:n},timings:{applyMs:n},baseCache:{hit:n%2===0,port:40000+n},referenceInventory:{file:sidecar,references:1},provenance:{at:String(n),kernelSha256:'a'.repeat(64)}});
    put(file,JSON.stringify(result));return answer;};
  const first=await s.check(),second=await s.check();assert.equal(first.candidateRef,second.candidateRef);
  const saved=store.readVerified(s.ws,'candidate',first.candidateRef),result=JSON.parse(Buffer.from(saved.blobs.result,'base64'));
  for(const key of ['loadMs','applyMs','hotTimings','timings','baseCache'])assert.equal(result[key],undefined,key);
  assert.deepEqual(result.items,[{name:'Teams'}]);
  assert.equal(result.referenceInventory.file,'@references');
  const offer=store.candidateOffer(s.ws,first.candidateRef,{lane:'o11',module:'Inventory'}),materialized=JSON.parse(fs.readFileSync(offer.candidate.result));
  assert.deepEqual(JSON.parse(fs.readFileSync(materialized.referenceInventory.file)),{references:[{key:'K',name:'Library'}]});
  await build(s,offer);assert.equal(offer.outcome.reused,true);
});
test('round 3 item 3 a concurrent check and build survive the verified size cap',async t=>{
  const s=setup(t,{global:2,perCustomer:2}),previous=s.deps.runJob;let count=0,signal,release,padding;
  const entered=new Promise(resolve=>signal=resolve),hold=new Promise(resolve=>release=resolve);
  s.deps.runJob=async input=>{const first=++count===1;const answer=await previous(input),file=put(path.join(input.work,'held.bin'),'');fs.truncateSync(file,140*1024*1024);
    if(first){padding=file;signal();await hold;}return answer;};
  const building=put(path.join(customerStateDir(s.ws),'builds','active','base.oml'),'');fs.truncateSync(building,140*1024*1024);
  const first=s.check();await entered;let survived;
  try{const second=await s.check();assert.ok(second.candidateRef);survived=fs.existsSync(padding)&&fs.existsSync(building);}finally{release();await first;}
  assert.equal(survived,true);
});
test('round 3 item 4 relative job dependencies resolve beside the delivery job',async t=>{
  const s=setup(t),part=put(path.join(s.ws,'o11','Part.json'),'{"ops":[]}');
  const {built,job}=await build(s,null,{document:{base:'job:Part',ops:[{op:'reference',producer:'job:Part'}]},resolveRelative:true});
  assert.ok(built);const manifest=JSON.parse(fs.readFileSync(built.manifest)),result=JSON.parse(fs.readFileSync(manifest.result));
  assert.deepEqual(result.sources,[{path:job,sha256:sha(fs.readFileSync(job))},{path:part,sha256:sha(fs.readFileSync(part))}]);
});
test('round 3 item 5 non-executable patch templates are expected, never corrected',async()=>{
  const {patchJob,patchErrorFields}=await import('../job-patch.mjs');
  assert.throws(()=>patchJob({ops:[{op:'find',name:'x'}]},[{op:'move',path:'/ops/0',value:{}}]),error=>{
    const fields=patchErrorFields(error);assert.equal(fields.corrected,undefined);assert.match(fields.expected.patch[0].op,/add\|remove/);return true;});
});

const BENIGN={ops:[]},SWAPPED={ops:[{op:'prototype',data:{source:'C:/outside'}}]};
const retainedCandidates=s=>{const dir=path.join(customerStateDir(s.ws),'verified','candidate');return fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^[a-f0-9]{64}\.json$/.test(f)):[];};
test('round 4 item 1 a job changed while it is built retains no candidate',async t=>{
  const s=setup(t),{built,job}=await build(s,null,{document:BENIGN,onBuild:file=>fs.writeFileSync(file,JSON.stringify(SWAPPED))});
  fs.writeFileSync(job,JSON.stringify(BENIGN));
  assert.ok(built?.manifest,'the build itself still answers; the kernel pins the job again at delivery');
  assert.equal(built.candidateRef,undefined);assert.match(built.retention,/not retained because the job changed while it was built/);
  assert.deepEqual(retainedCandidates(s),[]);
  const unchanged=await build(s,null,{document:BENIGN});assert.match(unchanged.built.candidateRef,/^[a-f0-9]{64}$/);assert.equal(unchanged.built.retention,undefined);
});
test('round 4 item 1 a retained candidate whose source hash is another job is refused as job-changed',async t=>{
  const s=setup(t),dir=path.join(customerStateDir(s.ws),'builds','swapped');
  const job=put(path.join(dir,'job.json'),JSON.stringify(BENIGN)),base=put(path.join(dir,'base.oml'),oml('base')),candidate=put(path.join(dir,'candidate.oml'),oml('built from the swapped job'));
  const result=put(path.join(dir,'candidate.result.json'),JSON.stringify({isValid:true,accepted:true,sources:[{path:job,sha256:sha(JSON.stringify(SWAPPED))}]}));
  const ref=store.keepCandidate(s.ws,{lane:'o11',module:'Inventory',candidate:{path:candidate,sha256:sha(fs.readFileSync(candidate)),result,job,base,baseModelSha256:modelSha256(base),producers:{}}});
  const offer=store.candidateOffer(s.ws,ref,{lane:'o11',module:'Inventory'}),{built}=await build(s,offer,{document:BENIGN});
  assert.equal(offer.outcome.reused,false);assert.equal(offer.outcome.reason,'job-changed');assert.equal(built.checked,undefined);
  assert.equal(fs.readFileSync(JSON.parse(fs.readFileSync(built.manifest)).candidate).subarray(9).toString('utf8'),'candidate','the delivery builds its own candidate');
});
