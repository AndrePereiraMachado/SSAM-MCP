// Lane-neutral, one trusted click in the SSAM-owned headless page (never a
// Studio, never the user's browser). The element is resolved read-only through
// the DOM agent (getDocument/querySelectorAll/getAttributes/getBoxModel and a
// hit test); the only input is one CDP Input.dispatchMouseEvent press/release
// pair at the box center. No Runtime evaluation, no handler is called by hand.
// The submission is journaled before the input and the outcome after it; a lost
// reply leaves the click uncertain and nothing is ever resent. The outcome proves
// only the dispatched input: handlerInvoked stays null (the native stop on the
// handler, handlerObserved, is the caller's evidence).
const fail=code=>{throw new Error('debug_native_browser_interaction_'+code);};
const DOM_ID=/^[A-Za-z0-9_.:-]{1,200}$/,KEY=/^[A-Za-z0-9_+]{22}$/,NAME=/^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
export const NATIVE_INTERACTION_MAX=10;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
const targetOk=t=>typeof t==='string'&&(/^@[A-Za-z0-9_+]{22}$/.test(t)||NAME.test(t));
// Public run.interactions: [{target:'@<widgetKey>'|'<WidgetName>', event:'click'}], 1..10.
export function nativeInteractionRequests(list){
 if(!Array.isArray(list)||!list.length||list.length>NATIVE_INTERACTION_MAX||list.some(i=>!plain(i)||Object.keys(i).length!==2||!targetOk(i.target)||i.event!=='click'))
  fail('requests_invalid');
 return list.map(({target,event})=>({target,event}));
}
// Authorized, resolved interactions as recorded before the browser exists.
export function isNativeInteractionAuthorization(list){
 return Array.isArray(list)&&list.length>0&&list.length<=NATIVE_INTERACTION_MAX&&list.every(i=>plain(i)&&Object.keys(i).length===5&&
  targetOk(i.target)&&i.event==='click'&&NAME.test(i.name??'')&&KEY.test(i.viewKey??'')&&KEY.test(i.actionKey??''));
}
export function createNativeBrowserInteraction({page,beforeInteraction,recordOutcome,timeoutMs=5000}){
 if(typeof page?.send!=='function'||typeof beforeInteraction!=='function'||typeof recordOutcome!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1)
  fail('contract_invalid');
 const attempted=new Set();let uncertain=false;
 const read=async(method,params,code)=>{try{return await page.send(method,params,timeoutMs);}catch{fail(code);}};
 async function resolve(id,documentUrl){
  const document=await read('DOM.getDocument',{depth:0},'document_unavailable');
  if(!Number.isInteger(document?.root?.nodeId)||document.root.documentURL!==documentUrl)fail('document_mismatch');
  const found=(await read('DOM.querySelectorAll',{nodeId:document.root.nodeId,selector:'[id="'+id+'"]'},'element_missing'))?.nodeIds;
  if(!Array.isArray(found)||!found.length)fail('element_missing');
  if(found.length!==1)fail('element_ambiguous');
  const node=found[0],list=(await read('DOM.getAttributes',{nodeId:node},'element_missing'))?.attributes??[];
  const attributes=new Map();for(let i=0;i+1<list.length;i+=2)attributes.set(String(list[i]).toLowerCase(),String(list[i+1]));
  if(attributes.has('hidden')||attributes.get('aria-hidden')==='true'||attributes.has('inert'))fail('element_hidden');
  if(attributes.has('disabled')||attributes.get('aria-disabled')==='true')fail('element_disabled');
  const model=(await read('DOM.getBoxModel',{nodeId:node},'element_hidden'))?.model,quad=model?.border;
  if(!Array.isArray(quad)||quad.length!==8||quad.some(v=>!Number.isFinite(v))||!(model.width>0)||!(model.height>0))fail('element_hidden');
  const x=(quad[0]+quad[2]+quad[4]+quad[6])/4,y=(quad[1]+quad[3]+quad[5]+quad[7])/4;
  const viewport=(await read('Page.getLayoutMetrics',{},'viewport_unavailable'))?.cssLayoutViewport;
  if(!(x>=0&&y>=0&&x<viewport?.clientWidth&&y<viewport?.clientHeight))fail('element_outside_viewport');
  // The point must hit the element itself or one of its descendants.
  const hit=await read('DOM.getNodeForLocation',{x:Math.round(x),y:Math.round(y),includeUserAgentShadowDOM:false,ignorePointerEventsNone:false},'element_obscured');
  const pushed=Number.isInteger(hit?.backendNodeId)?(await read('DOM.pushNodesByBackendIdsToFrontend',{backendNodeIds:[hit.backendNodeId]},'element_obscured'))?.nodeIds?.[0]:undefined;
  const inside=pushed===node||((await read('DOM.querySelectorAll',{nodeId:node,selector:'*'},'element_obscured'))?.nodeIds??[]).includes(pushed);
  if(!Number.isInteger(pushed)||!inside)fail('element_obscured');
  return {x:Math.round(x),y:Math.round(y)};
 }
 return {
  receipt:()=>({attempted:attempted.size,uncertain}),
  // metadata: public journal fields of the caller (target, keys); never values.
  async click({sequence,id,documentUrl,metadata={}}){
   if(uncertain)fail('uncertain');
   if(!Number.isInteger(sequence)||sequence<0||attempted.has(sequence))fail('already_attempted');
   if(!DOM_ID.test(id??'')||typeof documentUrl!=='string'||!plain(metadata))fail('target_invalid');
   const point=await resolve(id,documentUrl);
   const base={sequence,event:'click',id};
   if((await beforeInteraction({...base,...metadata}))?.recorded!==true)fail('journal_unavailable');
   attempted.add(sequence);
   const event={...point,button:'left',clickCount:1};
   try{
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...event,buttons:1},timeoutMs);
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...event,buttons:0},timeoutMs);
   }catch{
    uncertain=true;
    try{await recordOutcome({...base,handlerInvoked:null,dispatched:false,trusted:true,transportUnconfirmed:true});}catch{}
    fail('transport_unconfirmed');
   }
   let recorded=false;
   try{recorded=(await recordOutcome({...base,handlerInvoked:null,dispatched:true,trusted:true,transportUnconfirmed:false}))?.recorded===true;}catch{}
   if(!recorded){uncertain=true;fail('outcome_unrecorded');}
   return {sequence,event:'click',dispatched:true,trusted:true,point,evaluated:false};
  },
 };
}
