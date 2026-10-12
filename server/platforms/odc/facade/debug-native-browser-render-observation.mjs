// Lane-neutral, read-only DOM evidence of a mounted page. The only browser
// command is DOMSnapshot.captureSnapshot: no Runtime evaluation, no DOM agent
// tracking, no input or app call. Equality with native values is decided by
// the session owner from its own reads; the verdict carries booleans only.
const fail=code=>{throw new Error('debug_native_browser_render_'+code);};
const DOM_ID=/^[A-Za-z0-9_.:-]{1,200}$/;
const TEXT_TYPES=['Integer','LongInteger','Text'];
function validTargets(targets){
 const instances=targets?.instances;
 return Array.isArray(instances)&&instances.length<=500&&instances.every(i=>typeof i?.key==='string'&&i.key.length<=300&&
  Array.isArray(i.ids)&&i.ids.length<=500&&i.ids.every(id=>DOM_ID.test(id??''))&&
  Array.isArray(i.texts)&&i.texts.length<=500&&i.texts.every(t=>DOM_ID.test(t?.id??'')));
}
export async function observeNativeBrowserRender({page,documentUrl,targets,timeoutMs=5000}){
 if(typeof page?.send!=='function'||!/^https:\/\//.test(documentUrl??'')||!validTargets(targets))fail('contract_invalid');
 let snapshot;
 try{snapshot=await page.send('DOMSnapshot.captureSnapshot',{computedStyles:[]},timeoutMs);}catch{fail('unavailable');}
 const strings=snapshot?.strings,document=snapshot?.documents?.[0],nodes=document?.nodes;
 if(!Array.isArray(strings)||!Array.isArray(nodes?.parentIndex)||!Array.isArray(nodes.nodeType)||!Array.isArray(nodes.attributes))fail('unavailable');
 const text=i=>Number.isInteger(i)&&i>=0&&typeof strings[i]==='string'?strings[i]:undefined;
 const byId=new Map();
 nodes.attributes.forEach((attributes,node)=>{
  if(!Array.isArray(attributes))return;
  for(let k=0;k+1<attributes.length;k+=2)if(text(attributes[k])==='id'){const id=text(attributes[k+1]);if(id!==undefined)byId.set(id,[...(byId.get(id)??[]),node]);}
 });
 // Text content: every text node under the element, in document order.
 const within=(node,root)=>{for(let p=node,guard=0;p>=0&&guard<=nodes.parentIndex.length;p=nodes.parentIndex[p],guard++)if(p===root)return true;return false;};
 const content=root=>nodes.nodeType.map((type,i)=>type===3&&within(i,root)?text(nodes.nodeValue?.[i])??'':null).filter(v=>v!==null).join('');
 return {schema:'ssam-native-browser-render/1',observed:true,evaluated:false,
  documentMatched:(text(document.documentURL)??'').startsWith(documentUrl),
  roots:targets.instances.map(i=>({key:i.key,present:i.ids.some(id=>byId.has(id)),found:i.ids.filter(id=>byId.has(id)).length})),
  texts:targets.instances.flatMap(i=>i.texts.map(t=>{const found=byId.get(t.id)??[];
   return {key:i.key,id:t.id,present:found.length>0,unique:found.length===1,...(found.length===1?{text:content(found[0])}:{})};}))};
}
// lastRead(functions, variable) -> {type, text} | undefined: the owner's own last
// complete native read. Only strings are compared; nothing is evaluated.
export function compareNativeRenderEvidence({observation,targets,lastRead}){
 const reasons=new Set(),instances=validTargets(targets)?targets.instances:[];
 if(observation?.observed!==true)reasons.add('render-unobserved');
 if(observation?.documentMatched!==true)reasons.add('document-mismatch');
 if(targets?.complete!==true||!instances.length)reasons.add('render-targets-incomplete');
 const roots=instances.map(i=>({key:i.key,present:observation?.roots?.find(r=>r.key===i.key)?.present===true}));
 if(roots.some(r=>!r.present))reasons.add('root-missing');
 const bindings=instances.flatMap(i=>i.texts.map(t=>{
  const seen=observation?.texts?.find(x=>x.key===i.key&&x.id===t.id);
  const read=i.ambiguous||typeof lastRead!=='function'?undefined:lastRead(i.functions??[],t.variable);
  const present=seen?.present===true,unique=seen?.unique===true&&typeof seen.text==='string';
  const nativeRead=typeof read?.text==='string',typeSupported=nativeRead&&TEXT_TYPES.includes(read.type);
  if(i.ambiguous)reasons.add('instance-ambiguous');
  if(!present)reasons.add('text-missing');else if(!unique)reasons.add('text-ambiguous');
  if(!i.ambiguous&&!nativeRead)reasons.add('native-read-missing');else if(nativeRead&&!typeSupported)reasons.add('native-type-unsupported');
  const matches=present&&unique&&typeSupported&&seen.text===read.text;
  if(present&&unique&&typeSupported&&!matches)reasons.add('text-mismatch');
  return {key:i.key,id:t.id,variable:t.variable??null,present,unique,nativeRead,typeSupported,matches};
 }));
 if(!bindings.length)reasons.add('no-single-variable-bindings');
 return {renderVerified:reasons.size===0,reasons:[...reasons],roots,bindings,compared:bindings.filter(b=>b.matches).length,valuesReturned:false};
}
