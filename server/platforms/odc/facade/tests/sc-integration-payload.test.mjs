import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, Page } from '../service-center/html.mjs';
import { Client, checked } from '../service-center/client.mjs';
import { integrationPayloadPage, integrationPayloadControl, exactIntegrationRow, selectIntegrationRecord, redactPayload } from '../service-center/integration-payload.mjs';
import { main } from '../service-center/index.mjs';
import { serviceCenterArguments } from '../o11-operations.mjs';
import { FakeBridge, html, temp, xlsx, SC } from './fixtures/sc-fake-bridge.mjs';

const host='sc.example.test', key='11111111-2222-4333-8444-555555555555';
const event={requestKey:key,action:'Weather.Fetch',moduleId:'102',module:'Weather_IS',application:'Weather',type:'REST (Consume)',instant:'2026-10-14 03:57:16',endpoint:'https://api.example.test/forecast',durationMs:518,errorId:null};
const page=(body,url=SC+'Integration_Logs.aspx')=>new Page('https://'+host+url,new Document(body));
const esc=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const detail=(request='GET /forecast HTTP/1.1',response='HTTP/1.1 200 OK\n\n{"ok":true}',metadata={})=>{
 const fields={'Request Key':key,Action:event.action,'Time of Log':event.instant,'Module Id':event.moduleId,...metadata};
 return page('<div class="sc-content-main"><h1>Integration Log Detail</h1><table>'+Object.entries(fields).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('')+'</table><label for="req">Request</label><pre id="req">'+esc(request)+'</pre><label for="res">Response</label><textarea id="res">'+esc(response)+'</textarea></div>',SC+'Integration_LogDetail.aspx?Id=42');
};
const row=(link='')=>page('<div class="sc-content-main"><h1>Integrations Log</h1><table><tr><th>Time of Log</th><th>Module</th><th>Type</th><th>Action</th><th>Endpoint</th><th>Duration</th><th></th></tr><tr><td>'+event.instant+'</td><td><a href="eSpace_Edit.aspx?EspaceId=102">Weather_IS</a></td><td>'+event.type+'</td><td>'+event.action+'</td><td>'+event.endpoint+'</td><td>518 ms</td><td>'+link+'</td></tr></table></div>');
const exported={Request_Key:key,ACTION:event.action,INSTANT:event.instant,Espace_Id:'102',Espace_Name:event.module,Application_Name:event.application,TYPE:event.type,ENDPOINT:event.endpoint,DURATION:'518',Error_Id:''};

test('exact export identity refuses another request/module and duplicate timestamps',()=>{
 assert.deepEqual(selectIntegrationRecord([exported],{requestKey:key,action:event.action,moduleId:'102'}),event);
 assert.equal(selectIntegrationRecord([exported],{requestKey:'another',action:event.action}).code,'SC_INTEGRATION_EVENT_NOT_FOUND');
 assert.equal(selectIntegrationRecord([exported],{requestKey:key,action:event.action,moduleId:'103'}).code,'SC_INTEGRATION_EVENT_NOT_FOUND');
 assert.equal(selectIntegrationRecord([exported,exported],{requestKey:key,action:event.action}).code,'SC_INTEGRATION_EVENT_AMBIGUOUS');
});

test('observed native row without payload control is not-exposed, never not-recorded or empty success',()=>{
 const source=row(),matched=exactIntegrationRow(source,event);
 const result=integrationPayloadControl(source,matched.row,event);
 assert.equal(result.code,'SC_INTEGRATION_PAYLOAD_NOT_EXPOSED');assert.equal(result.payloadStatus,'not-exposed');
 assert.equal(result.recordingStatus,'unknown');assert.equal(result.request,null);assert.equal(result.response,null);
 assert.equal(exactIntegrationRow(source,{...event,moduleId:'999'}).code,'SC_INTEGRATION_EVENT_NOT_FOUND');
});

test('payloads require exact request, action, module and timestamp; empty recorded request is valid',()=>{
 const valid=integrationPayloadPage(detail('', '{"temperature":22}'),event);
 assert.equal(valid.ok,true);assert.equal(valid.request.text,'');assert.equal(valid.response.text,'{\n  "temperature": 22\n}');
 for(const metadata of [{'Request Key':'wrong'},{Action:'Other.Fetch'},{'Module Id':'103'},{'Time of Log':'2026-10-14 03:57:15'}])
  assert.equal(integrationPayloadPage(detail('private-request','private-response',metadata),event).code,'SC_INTEGRATION_DETAIL_IDENTITY_MISMATCH');
 const notRecorded=detail();notRecorded.doc.all('pre','textarea').forEach(n=>n.parent.children.splice(n.parent.children.indexOf(n),1));
 notRecorded.doc.content().children.push('Request and response data were not recorded');
 assert.equal(integrationPayloadPage(notRecorded,event).payloadStatus,'not-recorded');
 assert.equal(integrationPayloadPage(page('<h1>Some other page</h1>'),event).payloadStatus,'identity-unverified');
});

test('HTTP headers, JSON, form/query and XML credentials are redacted without erasing business content',()=>{
 for(const text of [
  'GET /forecast?api_key=hidden-one&city=Porto HTTP/1.1\nAuthorization: Digest hidden-two\nCookie: session=hidden-three\n\n{"password":"hidden-four","city":"Porto"}',
  '{"accessToken":"hidden-five","nested":{"clientSecret":"hidden-six","city":"Porto"}}',
  '<Payload><Password>hidden-seven</Password><City>Porto</City></Payload>',
  'password=hidden-eight&city=Porto',
  '{"headers":[{"name":"X-Api-Key","value":"hidden-nine"}],"city":"Porto"}'
 ]) {const redacted=redactPayload(text);assert.doesNotMatch(redacted,/hidden-(?:one|two|three|four|five|six|seven|eight|nine)/);assert.match(redacted,/Porto/);}
 const http=redactPayload('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"api-key":{"data":"private-value"},"password":123456,"city":"Porto"}');
 assert.doesNotMatch(http,/private-value|123456/);assert.match(http,/Porto/);
});

test('foreign and scripted detail controls never become a request',()=>{
 for(const link of ['<a title="View Details" href="https://other.example/Integration_LogDetail.aspx?Id=42">Details</a>',
  '<a title="View Details" href="Integration_LogDetail.aspx?Id=42#other">Details</a>']){
   const source=row(link);assert.throws(()=>integrationPayloadControl(source,exactIntegrationRow(source,event).row,event),{code:'SC_INTEGRATION_DETAIL_ORIGIN_REFUSED'});
 }
 const source=row('<a title="View Details" href="#" onclick="deleteEverything()">Details</a>');
 assert.equal(integrationPayloadControl(source,exactIntegrationRow(source,event).row,event).payloadStatus,'unsupported-detail-control');
 const malicious=row('<a title="View Details" href="DeleteApplication.aspx?ApplicationId=102">Details</a>');
 assert.equal(integrationPayloadControl(malicious,exactIntegrationRow(malicious,event).row,event).payloadStatus,'unsupported-detail-route');
});

test('permission page is typed consistently, before generic layout parsing',()=>{
 assert.throws(()=>checked(page('<div class="sc-content-main"><h1>Permission denied</h1></div>')),{code:'SC_PERMISSION_DENIED'});
});

test('Client binds export and native row, resets filters, and reads only the observed same-host detail link',async()=>{
 const c=new Client({host}),requests=[];
 c.trace=async()=>({logs:{complete:true,source:'https://'+host+SC+'GroupedRequest_Logs.aspx',rows:[{fields:{Element:event.action,'Event Type':event.type,'Time of Event':event.instant},links:[{href:'https://'+host+SC+'eSpace_Edit.aspx?EspaceId=102'}]}]}});
 c.logs=async(kind,limit,filters)=>{assert.equal(kind,'integration');assert.equal(filters.application,'__ossli_all');assert.equal(filters.module,'__ossli_all');assert.equal(filters.since,event.instant);assert.equal(filters.until,event.instant);return{export:{file:'fixture.xlsx'},rows:[exported],truncated:false};};
 c.get=async url=>{requests.push(url);return url==='Integration_Logs.aspx'?page(html('logs/integration-logs.page1.html').replaceAll('wtSourceInput','wtInput4').replace('>Source<','>Server<')):detail();};
 c.click=async()=>row('<a title="View Details" href="Integration_LogDetail.aspx?Id=42">Details</a>');
 const result=await c.integrationLogDetail({requestKey:key,action:event.action,moduleId:'102'});
 assert.equal(result.payloadStatus,'available');assert.equal(requests.length,2);assert.match(requests[1],/Integration_LogDetail\.aspx\?Id=42$/);
});

test('typed route reaches the in-process reader and reports denied access without a replay',async()=>{
 const bridge=new FakeBridge({pages:{['GET '+SC+'GroupedRequest_Logs.aspx?RequestKey='+key]:'<div class="sc-content-main"><h1>Permission denied</h1></div>'}});
 const args={action:'integration-log-detail',host,requestKey:key,logAction:event.action,moduleId:'102'};
 const result=await main(serviceCenterArguments(args),{locate:()=>bridge,present:async()=>false,running:async()=>false,exports:temp()});
 assert.equal(result.code,'SC_PERMISSION_DENIED');assert.equal(result.payloadStatus,'permission-denied');assert.equal(bridge.writes().length,0);
 assert.equal(bridge.calls.filter(c=>c[0]==='web'&&c[1]==='fetch').length,1);
});
