import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Document,Page} from '../service-center/html.mjs';
import {Client,nextLink,skeleton,ajaxPage,pagerNotify} from '../service-center/client.mjs';
import {Transport} from '../service-center/http.mjs';
import {xlsx} from './fixtures/sc-fake-bridge.mjs';
import {ProtocolError} from '../service-center/errors.mjs';

test('request correlation resolves the silent 50-event display cap through the bound export',async()=>{
 const key='12345678-abcd-1234-abcd-123456789012',url='https://lab.example/ServiceCenter/GroupedRequest_Logs.aspx?RequestKey='+key;
 const headers=['Time of Event','Event Type','Module / Extension','Element','Message'];
 const source='<form><div class="sc-content-main"><span class="heading2">Request Log</span><input type="submit" name="export" value="Export to excel"><table><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr>'+Array.from({length:50},()=>'<tr><td>2026-10-08 04:00:00</td><td>General</td><td>Module (App)</td><td>Action</td><td>Repeated</td></tr>').join('')+'</table></div></form>';
 const header=['Id','Instant','Type','Application Name','Module Name','Element Name','Message'];
 const records=Array.from({length:135},(_,i)=>[String(i),'2026-10-08 04:00:00','General','App','Module','Action','Repeated']);
 let body=xlsx([header,...records]),calls=0;
 const client=new Client({host:'lab.example'},{export:async(p,control)=>{assert.equal(p.url,url);assert.equal(control.attr('name'),'export');calls++;return body;}});
 client.get=async()=>new Page(url,new Document(source));
 const full=await client.trace(key,300);assert.equal(full.logs.rows.length,135);assert.equal(full.logs.complete,true);assert.equal(full.logs.sourceKind,'request-bound-xlsx');assert.equal(calls,1);
 const limited=await client.trace(key,60);assert.equal(limited.logs.rows.length,60);assert.equal(limited.logs.rowCount,135);assert.equal(limited.logs.complete,false);
 for(const bad of [xlsx([header,...records.slice(0,49)]),xlsx([['Unknown'],...records]),xlsx([header,...records.map(r=>[...r.slice(0,6),'Other'])])]){
  body=bad;const result=await client.trace(key,300);assert.equal(result.logs.rows.length,50);assert.equal(result.logs.complete,false);assert.equal(result.logs.completenessUnknown,true);
 }
 client.http.export=async()=>{throw new ProtocolError('No supported export');};
 assert.equal((await client.trace(key,300)).logs.complete,false);
});

const page=html=>new Page('https://lab.example/ServiceCenter/Error_Logs.aspx',new Document(html));
test('trace loads the declared RequestKey listing, including events whose message contains no key',async()=>{
 const key='12345678-abcd-1234-abcd-123456789012',url='https://lab.example/ServiceCenter/GroupedRequest_Logs.aspx?RequestKey='+key;
 const markup='<table><tr><th>Time of Event</th><th>Event Type</th><th>Module / Extension</th><th>Element</th><th>Message</th></tr><tr><td>now</td><td>Error</td><td>Example</td><td>Action</td><td>Example failure</td></tr><tr><td>now</td><td>Request</td><td>Example</td><td>Screen</td><td></td></tr></table>';
 const source='<form><div class="sc-content-main"><span class="heading2">Request Log</span>Loading records<input type="submit" id="owner_wtGetRecordsButton" name="owner$wtGetRecordsButton" onclick="OsAjax(event,\'owner_wtGetRecordsButton\',\'owner$wtGetRecordsButton\',\'\',\'__OSVSTATE,\',\'\');"></div></form>';
 const client=new Client({host:'lab.example'});let clicks=0;
 client.get=async path=>{assert.equal(path,'GroupedRequest_Logs.aspx?RequestKey='+key);return new Page(url,new Document(source));};
 client.logs=async()=>assert.fail('message search cannot establish request correlation');
 client.click=async(_page,control)=>{clicks++;assert.equal(control.attr('name'),'owner$wtGetRecordsButton');return new Page(url,new Document(markup));};
 const result=await client.trace(key);assert.equal(result.logs.rows.length,2);assert.equal(result.logs.complete,true);assert.equal(result.kind,'log-correlation');assert.equal(clicks,1);
 const limited=await client.trace(key,1);assert.equal(limited.logs.rows.length,1);assert.equal(limited.logs.truncated,true);assert.equal(limited.logs.complete,false);
 for(const bad of [source.replace('owner_wtGetRecordsButton','other'),source.replace('Request Log','Error Log'),source.replace('name="owner$wtGetRecordsButton"','name="owner$Delete"')]){
  client.get=async()=>new Page(url,new Document(bad));await assert.rejects(client.trace(key),e=>e.code==='LAYOUT_UNKNOWN');
 }
 client.get=async()=>new Page(url.replace(key,'another-key'),new Document(source));await assert.rejects(client.trace(key),e=>e.code==='LAYOUT_UNKNOWN');
 client.get=async()=>new Page(url,new Document(source));client.click=async()=>new Page(url,new Document(source));await assert.rejects(client.trace(key),e=>e.code==='LAYOUT_UNKNOWN');
 client.click=async()=>new Page(url,new Document(markup.replace('Event Type','Unknown')));await assert.rejects(client.trace(key),e=>e.code==='LAYOUT_UNKNOWN');
});
test('property value follows the live Effective Value label, preserving default and secret masking',async()=>{
 const client=new Client({host:'lab.example'});
 for(const control of ['<input name="wtSitePropertyInput2" value="True">','<textarea name="wtSitePropertyInput">example</textarea>']){
  client.detail=async()=>page('<form><label for="">Default Value</label><input name="default" readonly value="original"><label for="">Effective Value</label>'+control+'</form>');
  const result=await client.propertyValue('544','Example');assert.equal(result.value,'<redacted>');assert.equal(result.revealed,false);
  assert.equal((await client.propertyValue('544','Example',true)).value,control.includes('textarea')?'example':'True');
 }
 client.detail=async()=>page('<form><label for="">Effective Value</label><input name="wtSitePropertyInput" type="password" value="secret"></form>');
 const secret=await client.propertyValue('544','Example',true);assert.equal(secret.secret,true);assert.equal(secret.revealed,false);assert.equal(secret.value,'<redacted>');
 for(const source of ['<label>Default Value</label><input name="wtSitePropertyInput">','<label>Effective Value</label><input name="one"><label>Effective Value</label><input name="two">','<label>Effective Value</label><input name="one" disabled>']){
  client.detail=async()=>page('<form>'+source+'</form>');await assert.rejects(client.propertyValue('544','Example'),e=>e.code==='LAYOUT_UNKNOWN');
 }
});
const next=(slot,component='wt89_wtContentMain_wt90')=>{
 const id=component+'_wt'+slot+'LinksPlaceholderRight_wt75_wt20';
 const target=id.replaceAll('_','$');
 return `<a id="${id}" href="#" onclick="OsAjax(event,'${id}','${target}','','__OSVSTATE,',''); return false;">Next</a>`;
};
test('the two live pager slots advance once instead of claiming the first 20 rows are complete',async()=>{
 const client=new Client({host:'lab.example'});
 const first=page(`<div class="sc-content-main">${next('Top')}<table><tr><th>Message</th></tr><tr><td>First</td></tr></table>${next('Bottom')}</div>`);
 const last=page('<div class="sc-content-main"><table><tr><th>Message</th></tr><tr><td>Second</td></tr></table></div>');
 let advances=0;
 client.nextPage=async(_page,link)=>{advances++;assert.match(link.attr('id'),/TopLinks/);return last;};
 const all=await client.pages(first,10);
 assert.equal(all.rows.length,2);assert.equal(all.truncated,false);assert.equal(advances,1);
 const limited=await client.pages(first,1);
 assert.equal(limited.truncated,true);assert.equal(advances,1);
 const pageLimited=await client.pages(first,100,false,1);
 assert.equal(pageLimited.truncated,true);assert.equal(pageLimited.pageLimit,1);assert.equal(advances,1);
});
test('unrelated or ambiguous Next controls refuse instead of silently reporting completeness',()=>{
 assert.throws(()=>nextLink(page(next('Top')+next('Bottom','another'))),/Ambiguous Next/);
 assert.throws(()=>nextLink(page(next('Top')+next('Bottom')+next('Top'))),/Ambiguous Next/);
 assert.equal(nextLink(page('<a rel="next" aria-disabled="true" href="Next.aspx">Next</a>')),null);
});
test('BPT top and bottom direct Next links share one destination; differing destinations remain ambiguous',async()=>{
 const nav=(slot,index=20)=>`<a id="owner_wt${slot}LinksPlaceholderRight_wtLink16" href="Process_Monitoring.aspx?Index=${index}">Next</a>`;
 const first=page('<table><tr><th>Process Name</th></tr><tr><td>First</td></tr></table>'+nav('Top')+nav('Bottom'));
 const client=new Client({host:'lab.example'});let followed=0;
 client.follow=async(_page,link)=>{followed++;assert.match(link.attr('id'),/TopLinks/);assert.equal(link.attr('href'),'Process_Monitoring.aspx?Index=20');return page('<table><tr><th>Process Name</th></tr><tr><td>Second</td></tr></table>');};
 const result=await client.pages(first,100);assert.equal(result.rows.length,2);assert.equal(result.truncated,false);assert.equal(followed,1);
 assert.throws(()=>nextLink(page(nav('Top')+nav('Bottom',40))),/Ambiguous Next/);
 assert.throws(()=>nextLink(page(nav('Top')+nav('Bottom').replace('href=','onclick="other()" href='))),/Ambiguous Next/);
 const ordered=nav('Top').replace('?Index=20','?Index=20&ModuleKey=abc')+nav('Bottom').replace('?Index=20','?ModuleKey=abc&Index=20');
 assert.match(nextLink(page(ordered)).attr('id'),/TopLinks/);
 const repeated=nav('Top').replace('?Index=20','?Index=20&Index=40')+nav('Bottom').replace('?Index=20','?Index=40&Index=20');
 assert.throws(()=>nextLink(page(repeated)),/Ambiguous Next/);
});
test('BPT module filter does not select the status control named Espace_Selector2',async()=>{
 const client=new Client({host:'lab.example'});
 client.get=async()=>page('<form><div class="sc-content-main"><label>Name</label><input name="wtInput1"><label>Module</label><select name="wtEspace_Selector"><option value="441">HeadlessTrad_UI</option></select><label>Status</label><select name="wtEspace_Selector2"><option value="all">(All)</option></select><input type="submit" name="filter" value="Filter"></div></form>');
 client.click=async(_page,_control,updates)=>{assert.deepEqual(updates,{wtEspace_Selector:'441',wtInput1:'ApproveContact'});return page('<table><tr><th>Process Name</th><th>Module</th></tr><tr><td>ApproveContact</td><td>HeadlessTrad_UI</td></tr></table>');};
 const result=await client.bptProcesses('HeadlessTrad_UI','ApproveContact');assert.equal(result.rows.length,1);assert.equal(result.truncated,false);
});
test('live span heading and br stack are read, while diagnostic Session Id is redacted from detail and capture',async()=>{
 const source='<div class="sc-content-main"><span class="heading2">Error detail</span><div class="columns"><div class="columns-item"><label>Session Id</label></div><div class="columns-item">private-session-value</div></div><div><label>Stack</label><span>Example<br>  at ActionOne<br>  at ActionTwo</span></div></div>';
 const client=new Client({host:'lab.example'});client.get=async()=>page(source);
 const detail=await client.errorDetail('example-error');
 assert.match(detail.detail,/Error detail/);assert.match(detail.detail,/at ActionOne\n  at ActionTwo/);assert.doesNotMatch(detail.detail,/private-session/);assert.match(detail.detail,/\[redacted\]/);
 const capture=skeleton(new Document(source).root);
 assert.doesNotMatch(capture,/private-session/);assert.match(capture,/Session Id/);
});

test('Next carries the submitted module and checkbox filters with refreshed state, without replaying the Filter button',()=>{
 const original=page('<form method="post" action="Error_Logs.aspx"><input type="hidden" name="__OSVSTATE" value="old"><select name="module"><option value="all" selected>All</option><option value="559">Example</option></select><input type="checkbox" name="stack"><input type="submit" name="filter" value="Filter"></form>');
 const reply='OsJSONUpdate('+JSON.stringify({hidden:{__OSVSTATE:'new-state'},widgets:{list:{value:'<div>'+next('Top')+'</div>'}}})+')';
 const refreshed=ajaxPage(original,reply,[['__OSVSTATE','old'],['module','559'],['stack','on'],['filter','Filter']]);
 const [,fields]=new Transport('lab.example').ajaxPost(refreshed,nextLink(refreshed));
 const sent=Object.fromEntries(fields);
 assert.equal(sent.__OSVSTATE,'new-state');assert.equal(sent.module,'559');assert.equal(sent.stack,'on');assert.equal(sent.filter,undefined);assert.match(sent.__EVENTTARGET,/TopLinksPlaceholderRight/);
 assert.equal(sent[sent.__EVENTTARGET],undefined);assert.ok(sent.__AJAX);
});

test('live Next notification refreshes the same pager once, with its new state and preserved filter',async()=>{
 const target='wt89_wtContentMain_wt90_wtTopLinksPlaceholderRight_wt75';
 const notification='OsJSONUpdate('+JSON.stringify({hidden:{__OSVSTATE:'next-state'},js:["OsNotifyWidget('"+target+"', '');",'OsEndRequest()']})+')';
 const original=page('<form method="post" action="Error_Logs.aspx"><input type="hidden" name="__OSVSTATE" value="old"><input name="module" value="559"><div class="sc-content-main">'+next('Top')+'</div></form>');
 const http=new Transport('lab.example');http.preauthenticated=true;let requests=0;
 http.reply=async(url,fields)=>{
  requests++;const sent=Object.fromEntries(fields);
  if(requests===1){assert.match(sent.__EVENTTARGET,/wt20$/);return[url,notification];}
  assert.equal(requests,2);assert.equal(sent.__EVENTTARGET,target);assert.equal(sent.__AJAXEVENT,'Notify');assert.equal(sent.__OSVSTATE,'next-state');assert.equal(sent.module,'559');
  return[url,'OsJSONUpdate('+JSON.stringify({hidden:{__OSVSTATE:'last-state'},widgets:{value:'<table><tr><th>Message</th></tr><tr><td>Second page</td></tr></table>'}})+')'];
 };
 const result=await new Client({host:'lab.example'},http).nextPage(original,nextLink(original));
 assert.match(result.doc.root.text,/Second page/);assert.equal(requests,2);
 for(const bad of [notification.replace(target,'other_target'),notification.replace('OsEndRequest()','dangerous()'),notification.replace('OsEndRequest()',"OsNotifyWidget('"+target+"', '');")])assert.throws(()=>pagerNotify(bad,target));
});

test('lazy site properties uses only the current declared tab event and masks listed values',async()=>{
 const source=`<form method="post"><span id="owner"><div class="tabs-content-item" data-tab="tab-SiteProperties">Loading Site Properties</div><span id="owner_wtOnTabChange"><input type="hidden" data-p="1" name="tab"><input type="submit" data-p="btn" id="owner_wtOnTabChange_wtTriggerEvent" name="owner$wtOnTabChange$wtTriggerEvent" onclick="OsAjax(event,'owner_wtOnTabChange_wtTriggerEvent','owner$wtOnTabChange$wtTriggerEvent','','__OSVSTATE,','');"></span></span><script>tabs.init('owner', 'owner_wtOnTabChange');</script></form>`;
 const client=new Client({host:'lab.example'});let calls=0;
 client.modulePage=async()=>page(source);
 client.click=async(_page,control,updates)=>{calls++;assert.equal(control.attr('id'),'owner_wtOnTabChange_wtTriggerEvent');assert.deepEqual(updates,{tab:'SiteProperties'});return page('<div class="sc-content-main"><div data-tab="tab-SiteProperties"><table><tr><th>Name</th><th>Value</th></tr><tr><td>ExampleProperty</td><td>private-property-value</td></tr></table></div></div>');};
 const result=await client.resources('559','site-properties');assert.equal(result.rows.length,1);assert.doesNotMatch(JSON.stringify(result),/private-property-value/);assert.equal(calls,1);
 client.modulePage=async()=>page(source.replace("tabs.init('owner', 'owner_wtOnTabChange');","tabs.init('another', 'owner_wtOnTabChange');"));
 await assert.rejects(client.resources('559','site-properties'),e=>e.code==='LAYOUT_UNKNOWN');assert.equal(calls,1);
});


test('unexpected-error calibration drops license reports while preserving harmless preformatted layout',()=>{
 for(const marker of ['InstallerId','License Edition','License Key','Activation Code','ActivationCode','Serial','Serial Number']){
  const doc=new Document('<div class="sc-content-main"><span class="heading2">Unexpected error</span><pre>Diagnostic start\n'+marker+': synthetic-private-value\nStack detail</pre><pre>harmless formatting</pre><textarea name="report">synthetic-private-form-value</textarea></div>');
  const captured=skeleton(doc.root);
  assert.ok(captured.includes('Unexpected error'));assert.ok(captured.includes('<pre>[redacted]</pre>'));
  assert.ok(captured.includes('<pre>harmless formatting</pre>'));assert.doesNotMatch(captured,/synthetic-private|Stack detail|Diagnostic start/);
 }
 const encoded=new Document('<pre><span>Activation&#32;Code:</span><span>synthetic-private</span></pre>');
 assert.doesNotMatch(skeleton(encoded.root),/synthetic-private/);
});
