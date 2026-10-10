// Execute the emitted handler and expression boundary, not a duplicate codec implementation.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const [receiptPath,out]=process.argv.slice(2);
if(!receiptPath||!out)throw Error('Usage: node native-value-codecs.cjs <delivery result.json> <proof.json>');
const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8').replace(/^\uFEFF/,''));
const delivery=receipt.data||receipt;
const job=JSON.parse(fs.readFileSync(path.join(delivery.work,'attempt-0','generated.json'),'utf8'));
const actions=job.ops.filter(op=>op.op==='logic').flatMap(op=>op.data.actions);
const handler=actions.find(a=>a.name==='ValueCard_Handler_change');
assert(handler,'Expected the value gallery change handler in the actual compiled specification');
const code=handler.steps.find(s=>s.node==='IJavaScriptNode').properties.JavaScript;
const input={read_summary:JSON.stringify({title:'Pronto',enabled:true,amount:1.5}),read_rows:JSON.stringify([
 {id:'9223372036854775807',title:'A',score:1,tags:[{Value:'inicial'}]},
 {id:'9007199254740993',title:'B',score:2,tags:[{Value:'outro'}]}]),read_edits:0};
function run(mutation){
 const parameters={...input};
 // Insert an adversarial authored statement before the final state is encoded.
 const emitted=mutation?code.replace('$parameters.write_summary=',mutation+'\n$parameters.write_summary='):code;
 vm.runInNewContext(emitted,{$parameters:parameters},{timeout:1000});return parameters;
}
const first=run();assert.equal(JSON.parse(first.write_summary).amount,2);
assert.equal(JSON.parse(first.write_rows)[0].id,'9223372036854775807');
assert.deepEqual(JSON.parse(first.write_rows)[0].tags,[{Value:'inicial'},{Value:'editado'}]);
assert.equal(first.changed_rows,true);assert.equal(first.write_edits,1);
assert.deepEqual(JSON.parse(run('rows=[];').write_rows),[]);
const failures=[
 "summary.amount=NaN;", "summary.amount=Infinity;", "summary.amount=9007199254740992;",
 "summary.amount='2';", "summary.title=null;", "summary.extra=true;", "delete summary.enabled;",
 "summary[Symbol('hidden')]=1;", "Object.defineProperty(summary,'hidden',{value:1});",
 "Object.defineProperty(summary,'title',{get(){return 'computed';}});",
 "rows[0].tags=['ok',, 'bad'];", "rows[0].tags[Symbol('hidden')]=1;",
 "Object.defineProperty(rows[0].tags,'hidden',{value:1});",
 "Object.defineProperty(rows[0].tags,'0',{get(){return 'computed';}});",
 "rows[0].id=9223372036854775807;", "rows=null;"
];
for(const statement of failures)assert.throws(()=>run(statement),/inferred native type/,statement);
const unchanged=run('rows=JSON.parse($parameters.read_rows).map(row=>({...row,tags:row.tags.map(tag=>tag.Value)}));');
assert.equal(unchanged.changed_rows,false,'An unchanged value must not replace native list identity');
const expressions=actions.filter(a=>a.function&&a.steps.some(s=>s.properties?.JavaScript?.includes('Object.freeze')));
assert(expressions.length>0);let frozen=false;
for(const action of expressions){
 const step=action.steps.find(s=>s.node==='IJavaScriptNode');if(!step.properties.JavaScript.includes('const summary='))continue;
 const parameters={summary:input.read_summary,rows:input.read_rows};
 const script=step.properties.JavaScript.replace('const value=','summary.amount=99;\nconst value=');
 assert.throws(()=>vm.runInNewContext('"use strict";\n'+script,{$parameters:parameters},{timeout:1000}),/read only|readonly/i);
 frozen=true;break;
}
assert(frozen,'Expressions must not mutate captured records');
// Native state assignment must occur after every complex value has been decoded successfully.
const runIndex=handler.steps.findIndex(s=>s.node==='IJavaScriptNode');
const writeIndex=handler.steps.findIndex((s,i)=>i>runIndex&&s.assign);
assert(writeIndex>runIndex);assert(handler.steps.slice(writeIndex+1).every(s=>s.node!=='IJSONDeserializeNode'));
const proof={ok:true,rejectedValues:failures.length,checks:['actual generated JavaScript executed','nested value round trip','exact text identifiers','empty array output','invalid values rejected','unchanged list identity retained','expression captures immutable','native writes follow all decodes']};
fs.writeFileSync(out,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
