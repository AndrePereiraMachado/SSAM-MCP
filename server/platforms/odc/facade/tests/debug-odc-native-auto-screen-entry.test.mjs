import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveEntry,resolveOriginalScreenEntry} from '../debug-odc-native-entry-resolve.mjs';
import {prepareNativeEntry} from '../debug-odc-native-run.mjs';

function fixture(reverse=false){
 const nodes={T:{kind:'ServerAction',path:'ServerAction:Target'},C:{kind:'ClientAction',path:'ClientAction:Caller',nativeEntryKind:'client-action'},
  A:{kind:'ScreenAction',path:'MobileScreen:View/ScreenAction:A',nativeEntryKind:'client-action'},
  B:{kind:'ScreenAction',path:'MobileScreen:View/ScreenAction:B',nativeEntryKind:'client-action'},
  Z:{kind:'ScreenAction',path:'MobileScreen:View/ScreenAction:Z',nativeEntryKind:'client-action'},
  M:{kind:'ClientAction',path:'ClientAction:Intermediate'},V:{kind:'MobileScreen',path:'MobileScreen:View'},
  X:{kind:'ScreenAction',path:'MobileScreen:Other/ScreenAction:X',nativeEntryKind:'client-action'}};
 for(const [key,node] of Object.entries(nodes))Object.assign(node,{key,name:key,inputs:[],properties:{Name:key}});
 let edges=[['C','T'],['A','C'],['B','C'],['M','C'],['Z','M']].map(([caller,callee])=>({caller,callee,path:nodes[caller].path+'/ExecuteServerActionNode:'+callee,kind:'ExecuteServerActionNode',arguments:[]}));
 if(reverse)edges=edges.reverse();
 const graph={node:key=>nodes[key]??null,inputs:key=>nodes[key]?.inputs??[],callers:key=>edges.filter(e=>e.callee===key).map(e=>({key:e.caller,node:nodes[e.caller],edge:e}))};
 const closureReads=[];
 const readers={resolveTarget:async()=>({...nodes.T,closureCalls:[]}),properties:selector=>Object.values(nodes).find(n=>n.path===selector),inputs:()=>[],
  usages:key=>edges.filter(e=>e.callee===key).map(e=>({consumer:{kind:e.kind,key:'call'+e.caller+e.callee,path:e.path}})),argumentsOf:()=>[],
  closure:async key=>{closureReads.push(key);return key==='@A'?[{kind:'SendEmailNode'},{kind:'ExecuteServerActionNode',actionKind:'ServerAction',actionKey:'T'}]:[];}};
 return {graph,readers,nodes,edges,closureReads};
}

test('eligible screen selection preserves closest-distance/key order and the original path under reversed enumeration',()=>{
 const a=fixture(),b=fixture(true);
 assert.equal(resolveEntry(a.graph,'T').entry.key,'C');
 const selected=resolveOriginalScreenEntry(a.graph,'T');
 assert.equal(selected.entry.key,'A');assert.equal(selected.entry.distance,2);assert.equal(selected.overridden,undefined);
 assert.equal(selected.entryEligibility,'original-screen-for-server-request/v1');
 assert.deepEqual(selected.path.map(s=>s.key),['A','C','T']);assert.deepEqual(selected,resolveOriginalScreenEntry(b.graph,'T'));
 assert.deepEqual(selected.alternatives.map(n=>n.key),['B','Z']);
 assert.throws(()=>resolveOriginalScreenEntry(a.graph,'T',{maxDepth:1}),/graph_depth_limit/);
 assert.throws(()=>resolveOriginalScreenEntry(a.graph,'T',{maxNodes:2}),/graph_node_limit/);
});

test('public prepare selects the original ScreenAction automatically and includes its full effects',async()=>{
 const f=fixture(),r=await prepareNativeEntry({action:'T',inputs:{},persist:false},f.readers);
 assert.equal(r.ok,true);assert.equal(r.overridden,false);assert.equal(r.entry.key,'A');assert.deepEqual(r.path.map(s=>s.key),['A','C','T']);
 assert.deepEqual(r.effects,['email']);assert.deepEqual(f.closureReads,['@C','@A']);
 assert.equal(r.entryEligibility,'original-screen-for-server-request/v1');assert.deepEqual(r.bindings,[]);
 const missing=fixture();delete missing.readers.closure;
 await assert.rejects(()=>prepareNativeEntry({action:'T',persist:false},missing.readers),/original_screen_closure_unavailable/);
});

test('explicit unsafe/unrelated entries and absent native screen remain refused; explicit original screen remains valid',async()=>{
 const f=fixture();
 const unsafe=await prepareNativeEntry({action:'T',entry:'C',inputs:{},persist:false},f.readers);
 assert.equal(unsafe.ok,false);assert.equal(unsafe.error,'debug_odc_native_original_screen_entry_required');
 const unrelated=await prepareNativeEntry({action:'T',entry:'X',persist:false},f.readers);assert.equal(unrelated.ok,false);assert.equal(unrelated.error,'entry_override_not_a_caller');
 const explicit=await prepareNativeEntry({action:'T',entry:'B',inputs:{},persist:false},f.readers);assert.equal(explicit.ok,true);assert.equal(explicit.overridden,true);assert.equal(explicit.entry.key,'B');
 for(const n of ['A','B','Z'])f.nodes[n].nativeEntryKind=null;
 const absent=await prepareNativeEntry({action:'T',persist:false},f.readers);assert.equal(absent.ok,false);assert.equal(absent.error,'debug_odc_native_original_screen_entry_required');
});

test('pure globals remain direct while a server call in a global target closure triggers screen eligibility',async()=>{
 const f=fixture();f.readers.resolveTarget=async()=>({...f.nodes.C,closureCalls:[]});
 const pure=await prepareNativeEntry({action:'C',inputs:{},persist:false},f.readers);assert.equal(pure.ok,true);assert.equal(pure.entry.key,'C');assert.equal(pure.entryEligibility,undefined);
 f.readers.resolveTarget=async()=>({...f.nodes.C,closureCalls:[{kind:'ExecuteServerActionNode',actionKind:'ServerAction',actionKey:'T'}]});
 const backend=await prepareNativeEntry({action:'C',inputs:{},persist:false},f.readers);assert.equal(backend.ok,true);assert.equal(backend.entry.key,'A');assert.deepEqual(backend.path.map(s=>s.key),['A','C']);
});
