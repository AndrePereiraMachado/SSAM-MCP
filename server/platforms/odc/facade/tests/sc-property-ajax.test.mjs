import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Transport,StudioWebTransport} from '../service-center/http.mjs';
import {Client,Journal} from '../service-center/client.mjs';
import {Document,Page} from '../service-center/html.mjs';
import {temp,uuid} from './fixtures/sc-fake-bridge.mjs';
const host='test.example.com',url=`https://${host}/ServiceCenter/eSpace_SiteProperty_Edit.aspx?SitePropertyId=7.8`;
const script="OsAjax(arguments[0] || window.event,'apply','form$apply','','__OSVSTATE,',''); return false;";
const page=(secret=false,onclick=script)=>new Page(url,new Document(`<form method="post"><div class="sc-content-main"><input type="hidden" name="__OSVSTATE" value="state"><label for="value">Effective Value</label><input id="value" name="propertyValue" type="${secret?'password':'text'}" value="7"><input type="submit" id="apply" name="form$apply" value="Apply" onclick="${onclick}"></div></form>`));
test('AJAX excludes submit values while ordinary form submission preserves the clicked value',()=>{
 const http=new Transport(host),p=page(),control=p.doc.all('input').at(-1);
 const ajax=new URLSearchParams(http.ajaxPost(p,control)[1]);
 assert.equal(ajax.get('__EVENTTARGET'),'form$apply');assert.equal(ajax.has('form$apply'),false);
 const ordinary=page(false,''),button=ordinary.doc.all('input').at(-1);
 assert.equal(new URLSearchParams(http.formPost(ordinary,button)[1]).get('form$apply'),'Apply');
});
test('AJAX rebuilds checkbox bag and represents unchecked and disabled checked controls',()=>{
 const http=new Transport(host),p=new Page(url,new Document('<form method="post"><input type="checkbox" name="off"><input type="checkbox" name="on" checked disabled><input type="checkbox" name="normal" checked value="yes"><div id="__CheckBoxBag"><input name="off" value="stale"></div><input type="submit" name="apply" value="Apply"></form>'));
 const control=p.doc.all('input').at(-1),fields=new URLSearchParams(http.ajaxPost(p,control)[1]);
 assert.deepEqual(fields.getAll('off'),['off']);assert.deepEqual(fields.getAll('on'),['on']);assert.equal(fields.get('normal'),'yes');
 assert.equal(new URLSearchParams(http.ajaxPost(p,control,{normal:null})[1]).get('normal'),'off');
 const normal=new URLSearchParams(http.formPost(p,control)[1]);assert.equal(normal.get('off'),'stale');assert.equal(normal.has('on'),false);
});
test('property AJAX commits once with journal authorization and verifies the fresh common value',async()=>{
 let sent=0,value='7';const journal=new Journal(temp()),operationId=uuid();
 const http=new Transport(host,{send:async request=>{sent++;const fields=new URLSearchParams(request.body);assert.equal(fields.get('__EVENTTARGET'),'form$apply');assert.equal(fields.get('propertyValue'),'9');value='9';return{status:200,body:Buffer.from(JSON.stringify('<div class="Feedback_Message_Success">Saved</div>')),contentType:'text/javascript'};}});
 const client=new Client({host},http);
 client.detail=async()=>page(false,"if (OsPage_ClientValidate('apply')) "+script);client.prepare=async(...args)=>{const result=await Client.prototype.prepare.call(client,...args);result[3].attrs.set('value',value);return result;};
 const args={execute:true,value:'9',words:'Approved fixture',operationId,journal};
 const result=await client.mutate('property-set','7','Test',args);assert.equal(result.state,'confirmed');assert.equal(sent,1);
 assert.equal((await client.mutate('property-set','7','Test',args)).existingReceipt,true);assert.equal(sent,1);
});
test('property AJAX carries only a vault reference and empty placeholder through native authorized transport',async()=>{
 const calls=[],target=`SSAM/O11/${host}/SiteProperty/Test`,journal=new Journal(temp()),operationId=uuid();
 const http=new StudioWebTransport(host,{capabilities:async()=>new Set(['sc_web:secretRefs']),web:async(_host,action,args)=>{assert.equal(action,'fetch');calls.push(args);return{ok:true,status:200,finalUrl:url,contentType:'text/javascript',html:JSON.stringify('<div class="Feedback_Message_Success">Saved</div>')};}});
 const client=new Client({host},http);client.detail=async()=>page(true,"validateEmptyValue('value', 'The effective value is empty. Do you want to confirm?');if (OsPage_ClientValidate('apply')) "+script);
 const result=await client.mutate('property-set','7','Test',{execute:true,secret:target,words:'Approved fixture',operationId,journal});
 assert.equal(calls.length,1);assert.equal(calls[0].write,true);assert.equal(calls[0].operationId,operationId);assert.ok(calls[0].authorizeSha256);
 assert.equal(calls[0].form.propertyValue,'');assert.deepEqual(calls[0].secretRefs,[{pointer:'/propertyValue',target,field:'password'}]);
 assert.equal(result.state,'accepted');assert.equal(result.valueVerified,false);
});
test('unknown property AJAX scripts and overlapping secret/value fields refuse before send',async()=>{
 const http=new Transport(host,{send:async()=>assert.fail('No send')});const p=page(true,script.replace("'form$apply'","'other'"));
 assert.throws(()=>http.scriptedAjaxPost(p,p.doc.all('input').at(-1)),/Unsupported AJAX/);
 const valid=page(true);assert.throws(()=>http.scriptedAjaxPost(valid,valid.doc.all('input').at(-1),{propertyValue:'wrong'},{propertyValue:{target:'vault',field:'password'}}),/cannot also carry/);
 const guarded=page(true,"if (OsPage_ClientValidate('other')) "+script);
 assert.throws(()=>http.scriptedAjaxPost(guarded,guarded.doc.all('input').at(-1),null,null,{clientValidation:true}),/validation guard/);
 const timerGuard=page(false,"if (OsPage_ClientValidate('apply')) "+script);
 assert.throws(()=>http.timerRunPost(timerGuard,timerGuard.doc.all('input').at(-1)),/validation guard/);
 const emptyGuard=page(true,"validateEmptyValue('value', 'The effective value is empty. Do you want to confirm?');if (OsPage_ClientValidate('apply')) "+script);
 assert.throws(()=>http.scriptedAjaxPost(emptyGuard,emptyGuard.doc.all('input').at(-1),null,null,{clientValidation:true}),/empty-value confirmation/);
 const mismatched=page(true,emptyGuard.doc.all('input').at(-1).attr('onclick').replace("'value'","'other'"));
 assert.throws(()=>http.scriptedAjaxPost(mismatched,mismatched.doc.all('input').at(-1),null,{propertyValue:{target:`SSAM/O11/${host}/SiteProperty/Test`,field:'password'}},{clientValidation:true}),/empty-value confirmation/);
 const sibling=page(true,emptyGuard.doc.all('input').at(-1).attr('onclick').replace("'value'","'owner_wtSitePropertyInput'"));
 sibling.doc.all('input').find(n=>n.attr('name')==='propertyValue').attrs.set('id','owner_wtSecretSitePropertyInput');
 const post=http.scriptedAjaxPost(sibling,sibling.doc.all('input').at(-1),null,{propertyValue:{target:`SSAM/O11/${host}/SiteProperty/Test`,field:'password'}},{clientValidation:true});
 assert.equal(post[2][0].pointer,'/propertyValue');
 const replacement=page(true,emptyGuard.doc.all('input').at(-1).attr('onclick').replace('empty. Do','empty. The value inserted will replace the current saved value. Do'));
 const refs={propertyValue:{target:`SSAM/O11/${host}/SiteProperty/Test`,field:'password'}};
 assert.equal(http.scriptedAjaxPost(replacement,replacement.doc.all('input').at(-1),null,refs,{clientValidation:true})[2][0].pointer,'/propertyValue');
 assert.throws(()=>http.scriptedAjaxPost(replacement,replacement.doc.all('input').at(-1),null,null,{clientValidation:true}),/empty-value confirmation/);
});

test('secret verification acknowledges masked presence without comparing or resending its value',async()=>{
 const journal=new Journal(temp()),operationId=uuid(),target=`SSAM/O11/${host}/SiteProperty/Test`;
 let sent=0;
 const http=new StudioWebTransport(host,{capabilities:async()=>new Set(['sc_web:secretRefs']),web:async()=>{sent++;return{ok:true,status:200,finalUrl:url,contentType:'text/javascript',html:JSON.stringify('<div>Updated listing</div>')};}});
 const client=new Client({host},http);let configured=null;
 client.detail=async()=>{const p=page(true,"if (OsPage_ClientValidate('apply')) "+script);if(configured!==null)p.doc.all('input').find(n=>n.attr('name')==='propertyValue').attrs.set('placeholder',configured?'•••••••••':'No value set');return p;};
 const receipt=await client.mutate('property-set','7','Test',{execute:true,secret:target,words:'Approved fixture',operationId,journal});
 assert.equal(receipt.state,'accepted-unverified');assert.equal(sent,1);
 configured=false;const absent=await client.verify(receipt,journal);assert.equal(absent.state,'accepted-unverified');assert.equal(absent.secretValuePresent,false);
 configured=true;const verified=await client.verify(receipt,journal);assert.equal(verified.state,'accepted');assert.equal(verified.valueVerified,false);assert.equal(verified.observedDesiredState,null);assert.equal(verified.replayed,false);assert.equal(sent,1);
 assert.equal(journal.lookup(operationId).state,'accepted');
 assert.throws(()=>journal.acceptMaskedSecret({...receipt,state:'uncertain'}),/completed secret POST/);
 assert.throws(()=>journal.acceptMaskedSecret({...receipt,state:'sending'}),/completed secret POST/);
});
