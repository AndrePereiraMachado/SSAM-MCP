// LAB protocol investigation. Exported runtime methods are not a supported product API contract.
// No environment flags, private-field writes, DOM mutations or server data changes.
const fs=require('fs'),assert=require('assert/strict'),{chromium}=require('playwright');
const [url,out]=process.argv.slice(2);if(!url||!out)throw Error('Lab URL and proof file required');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
try{
 const page=await browser.newPage();await page.goto(url,{waitUntil:'networkidle'});
 const result=await page.evaluate(()=>{
  const types=require('OutSystems/ClientRuntime/DataTypes'),json=require('OutSystems/ClientRuntime/JSONUtils'),model=require('ZZHtmlImports_UI.model');
  const decode=rows=>json.deserializeFromJSON(JSON.stringify(rows),model.IdentityRowList,false);
  const key=row=>row.getBasicProperty(row.getAttributes().find(a=>a.name==='Id').attrName);
  const snapshot=list=>Array.from({length:list.length},(_,i)=>({key:key(list.getItem(i)),id:list.idOf(i),caption:list.getItem(i).getBasicProperty(list.getItem(i).getAttributes().find(a=>a.name==='Caption').attrName)}));
  const list=decode([{Id:'a',Caption:'A'},{Id:'b',Caption:'B'},{Id:'c',Caption:'C'}]);
  function reconcile(next){
   const incoming=decode(next),order=new Map();
   for(let i=0;i<incoming.length;i++){
    const k=key(incoming.getItem(i));if(!k||order.has(k))throw Error('Duplicate or empty key: '+k);order.set(k,i);
   }
   let data=types.ImmutableBase.getData(list);const existing=new Set();
   // The candidate remains immutable until validation and ordering have finished.
   for(let i=data.count()-1;i>=0;i--){
    const k=key(list.newItem(data.get(i)));if(existing.has(k))throw Error('Duplicate existing key: '+k);existing.add(k);
    if(!order.has(k))data=data.remove(i);
    else data=data.set(i,types.ImmutableBase.getData(incoming.getItem(order.get(k))));
   }
   for(let i=0;i<incoming.length;i++)if(!existing.has(key(incoming.getItem(i))))data=data.push(types.ImmutableBase.getData(incoming.getItem(i)));
   const prepared=data;
   data=prepared.sort(i=>prepared.get(i),item=>order.get(key(list.newItem(item))),true);
   // A new parent cache alone does not invalidate this wrapper's already-read items.
   // Reuse its exported cache API so subsequent reads cannot return stale records.
   const cache=list.getCache();cache.invalidate();list.writePropagate(data,cache);return snapshot(list);
  }
  const r={frontendImplemented:false,environmentFlagChanged:false,initial:snapshot(list)};
  r.updated=reconcile([{Id:'a',Caption:'A changed'},{Id:'b',Caption:'B'},{Id:'c',Caption:'C'}]);
  r.reordered=reconcile([{Id:'c',Caption:'C'},{Id:'a',Caption:'A changed'},{Id:'b',Caption:'B'}]);
  r.inserted=reconcile([{Id:'c',Caption:'C'},{Id:'d',Caption:'D'},{Id:'a',Caption:'A changed'},{Id:'b',Caption:'B'}]);
  r.removed=reconcile([{Id:'d',Caption:'D'},{Id:'a',Caption:'A changed'},{Id:'b',Caption:'B'}]);
  r.equivalent=reconcile([{Id:'d',Caption:'D'},{Id:'a',Caption:'A changed'},{Id:'b',Caption:'B'}]);
  try{reconcile([{Id:'a',Caption:'A'},{Id:'a',Caption:'duplicate'}]);r.duplicateRejected=false;}catch{r.duplicateRejected=true;}
  r.afterDuplicate=snapshot(list);
  r.overlappingPage=reconcile([{Id:'b',Caption:'B page 2'},{Id:'e',Caption:'E'}]);
  r.returnedPage=reconcile([{Id:'a',Caption:'A returned'},{Id:'b',Caption:'B'}]);
  r.empty=reconcile([]);r.refilled=reconcile([{Id:'a',Caption:'A fresh'}]);
  return r;
 });
 fs.writeFileSync(out,JSON.stringify(result,null,2));
 const ids=rows=>Object.fromEntries(rows.map(r=>[r.key,r.id]));const initial=ids(result.initial);
 for(const stage of ['updated','reordered','inserted','removed','equivalent'])for(const row of result[stage])if(initial[row.key])assert.equal(row.id,initial[row.key],stage+': '+row.key);
 assert.equal(result.updated[0].caption,'A changed');assert.deepEqual(result.reordered.map(r=>r.key),['c','a','b']);
 assert.equal(ids(result.inserted).d,ids(result.removed).d);assert.equal(ids(result.equivalent).d,ids(result.removed).d);
 assert(result.duplicateRejected);assert.deepEqual(result.afterDuplicate,result.equivalent);
 assert.equal(ids(result.overlappingPage).b,initial.b);assert.equal(ids(result.returnedPage).b,initial.b);
 assert.notEqual(ids(result.returnedPage).a,initial.a,'Removed items receive a new identity when reintroduced');
 assert.deepEqual(result.empty,[]);assert.notEqual(ids(result.refilled).a,ids(result.returnedPage).a);
 result.ok=true;fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
