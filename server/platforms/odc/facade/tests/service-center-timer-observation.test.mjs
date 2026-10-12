import test from 'node:test';
import assert from 'node:assert/strict';
import { timerLogSnapshot, compareTimerLogs, observeTimerErrors } from '../service-center/timer-observation.mjs';
const identity = { host: 'sc.example.test', moduleId: '577', name: 'Tick' };
const target = 'https://sc.example.test/ServiceCenter/eSpace_Timer_Edit.aspx?Cyclic_Job_Key=key1';
const row = (time = '2026-10-08 17:26:58') => ({ fields: { 'Time of Log': time, Timer: 'Tick', Duration: '0s', Tenant: '3' },
  links: [{ href: target + '&EspaceId=577' }] });
const list = rows => ({ complete: true, truncated: false, rows });
const snapshot = rows => timerLogSnapshot(list(rows), identity, target);

test('new exact execution is observed without attributing trigger or claiming success', () => {
  const after = snapshot([row()]);
  const result = compareTimerLogs(snapshot([]), after);
  assert.equal(result.executionObserved, true);
  assert.equal(result.attributedToRequest, false);
  assert.equal(result.executionCompleted, null);
  assert.equal(result.newRuns.length, 1);
  assert.equal(compareTimerLogs(after, after).executionObserved, false);
});
test('timer key, module id and host all bind the log row', () => {
  for (const replace of [['key1', 'key2'], ['EspaceId=577', 'EspaceId=578'], ['sc.example.test', 'other.example.test']]) {
    const other = row(); other.links[0].href = other.links[0].href.replace(...replace);
    assert.deepEqual(snapshot([other]).runs, []);
  }
});
test('tenant-specific timer observation never counts another tenant or an unbound row', () => {
  const scopedTarget = target + '&TenantId=3';
  const rows = [row(), row(), row()];
  rows[0].links[0].href += '&TenantId=3';
  rows[1].links[0].href += '&TenantId=4';
  const after = timerLogSnapshot(list(rows), identity, scopedTarget);
  assert.equal(after.tenantId, '3');
  assert.equal(after.runs.length, 1);
  const before = timerLogSnapshot(list([]), identity, scopedTarget);
  assert.equal(compareTimerLogs(before, after).executionObserved, true);
  assert.equal(compareTimerLogs(before, {...after, tenantId:'4'}).reason, 'timer-identity-changed');
  assert.equal(compareTimerLogs(snapshot([]), after).executionObserved, null);
  assert.equal(timerLogSnapshot(list(rows), identity, target+'&TenantId=invalid').available, false);
});
test('partial logs, malformed exact rows, duplicates or missing baseline do not prove execution', () => {
  const malformed = row(); delete malformed.fields.Duration;
  for (const after of [timerLogSnapshot({ ...list([]), truncated: true }, identity, target), snapshot([malformed]), snapshot([row(), row()])]) {
    assert.equal(after.available, false);
    assert.equal(compareTimerLogs(snapshot([]), after).executionObserved, null);
  }
  assert.equal(compareTimerLogs(undefined, snapshot([row()])).executionObserved, null);
  assert.equal(compareTimerLogs(snapshot([]), { ...snapshot([row()]), moduleId: 'other' }).executionObserved, null);
});
test('mutable next-run value does not create a new execution; errors remain visible', () => {
  const before = row(); before.fields['Next Run'] = 'deactivated';
  const after = row(); after.fields['Next Run'] = '2026-10-09 01:00:00';
  assert.equal(compareTimerLogs(snapshot([before]), snapshot([after])).executionObserved, false);
  after.fields.Duration = '2s';
  assert.equal(compareTimerLogs(snapshot([before]), snapshot([after])).executionObserved, false);
  after.links.push({ href: 'https://sc.example.test/ServiceCenter/Show_Error.aspx?Error_Id=error1' });
  assert.equal(snapshot([after]).runs[0].hasErrorLink, true);
  assert.equal(compareTimerLogs(snapshot([before]), snapshot([after])).executionObserved, false);
});

test('persisted empty timer filter accepts the exact native empty-list layout without assuming arbitrary missing tables',async()=>{
 const {Client}=await import('../service-center/client.mjs');const {Page,Document}=await import('../service-center/html.mjs');
 const html='<div class="sc-content-main"><h1>Timer Log</h1><span id="wt101_wtContentMain_wtList"><div>No Logs to show</div></span></div>';
 const page=(markup=html,url='https://sc.example.test/ServiceCenter/Cyclic_Job_Logs.aspx')=>new Page(url,new Document(markup));
 const client=Object.create(Client.prototype);
 assert.doesNotThrow(()=>client.logSchema('timer',page()));
 for(const markup of [html.replace('wt101_wtContentMain_wtList','unknown'),html.replace('Timer Log','Other Page'),html.replace('No Logs to show','Loading'),html.replace('</span>','</span><span id="x_wtContentMain_wtList">No Logs to show</span>'),html.replace('</div>','</div><table><tr><th>Unexpected</th></tr></table>')])
  assert.throws(()=>client.logSchema('timer',page(markup)));
 assert.throws(()=>client.logSchema('timer',page(html,'https://sc.example.test/ServiceCenter/Other.aspx')));
 assert.throws(()=>client.logSchema('general',page()));
});

test('failed attempts require same-host error links and matching detail identities, without claiming request completion', async () => {
 const id='1d8546e2-005b-4159-b3d9-adf9fe1c14bb';
 const r=row();r.fields.Server='server1';
 r.links.push({name:'Module1',href:'https://sc.example.test/ServiceCenter/eSpace_Edit.aspx?EspaceId=577'},
  {name:'Error',href:'https://sc.example.test/ServiceCenter/Show_Error.aspx?Error_Id='+id});
 const comparison=compareTimerLogs(snapshot([]),snapshot([r]));
 const detail={errorId:id,truncated:false,source:r.links[2].href,detail:`Id\n${id}\nTime of Log\n2026-10-08 17:26:58\nModule\nModule1\nServer\nserver1\nRequest Key\nrequest1\nMessage\nTimer Tick error (inside action 'Action1'). Timer duration = 0 secs:synthetic [retry 1 of 3 scheduled]`};
 const good=await observeTimerErrors(comparison,identity,async()=>detail);
 assert.equal(good.failedAttemptObserved,true);assert.equal(good.errorObservations[0].retryScheduled,true);
 assert.equal(comparison.executionCompleted,null);assert.equal(comparison.attributedToRequest,false);
 const terminalDetail={...detail,detail:detail.detail.replace("Timer Tick error (inside action 'Action1'). Timer duration = 0 secs:synthetic [retry 1 of 3 scheduled]",'Timer Tick reached maximum number of retries (3) [Calculating next run]')};
 const terminal=await observeTimerErrors(comparison,identity,async()=>terminalDetail);
 assert.equal(terminal.failedCycleObserved,true);assert.equal(terminal.errorObservations[0].retryLimit,3);
 assert.equal(terminal.errorObservations[0].retryScheduled,false);
 assert.equal((await observeTimerErrors(comparison,identity,async()=>({...terminalDetail,detail:terminalDetail.detail.replace('retries (3)','retries (unknown)')}))).failedCycleObserved,false);
 for(const changed of [{...detail,truncated:true},{...detail,source:detail.source.replace('sc.example.test','foreign.test')},
  {...detail,errorId:'wrong'},...['Module1','server1','2026-10-08 17:26:58','Timer Tick'].map(text=>({...detail,detail:detail.detail.replace(text,'wrong')})),
  {...detail,detail:detail.detail+'\nModule\nModule1'}]){
  assert.equal((await observeTimerErrors(comparison,identity,async()=>changed)).failedAttemptObserved,false);
 }
 assert.equal((await observeTimerErrors(comparison,identity,async()=>{throw Error('offline');})).errorDetailsComplete,false);
 assert.equal((await observeTimerErrors(comparison,identity,async()=>{throw Error('must not read');},0)).errorObservations[0].reason,'error-read-limit');
 const foreign=structuredClone(r);foreign.links[2].href=foreign.links[2].href.replace('sc.example.test','foreign.test');
 const observed=await observeTimerErrors(compareTimerLogs(snapshot([]),snapshot([foreign])),identity,async()=>{throw Error('must not request foreign link');});
 assert.equal(observed.errorObservations[0].reason,'error-identity-incomplete');
 assert.equal(snapshot([r]).runs[0].fingerprint,snapshot([foreign]).runs[0].fingerprint);
});

test('verify reads linked failures without changing the receipt, replaying, or treating failed reads as success',async()=>{
 const {Client}=await import('../service-center/client.mjs');const client=Object.create(Client.prototype);
 const r=row();r.fields.Server='server1';
 r.links.push({name:'Module1',href:'https://sc.example.test/ServiceCenter/eSpace_Edit.aspx?EspaceId=577'},
  {href:'https://sc.example.test/ServiceCenter/Show_Error.aspx?Error_Id=1d8546e2-005b-4159-b3d9-adf9fe1c14bb'});
 client.vault={host:identity.host};client.logs=async()=>list([r]);
 let reads=0;client.errorDetail=async()=>{reads++;throw Error('unavailable');};
 const receipt={identity:{...identity,action:'timer-run'},state:'accepted-unverified',plan:{target,timerLogBaseline:snapshot([])}};
 const original=structuredClone(receipt);let stored;
 const result=await client.verify(receipt,{recordTimerObservation:(_receipt,observation)=>{stored=observation;return {observation};}});
 assert.equal(reads,1);assert.equal(result.executionObserved,true);assert.equal(result.executionCompleted,null);
 assert.equal(result.failedAttemptObserved,false);assert.equal(result.errorDetailsComplete,false);
 assert.equal(result.state,'accepted-unverified');assert.equal(result.replayed,false);assert.deepEqual(receipt,original);
 assert.equal(stored.executionObserved,true);assert.equal(stored.errorDetailsComplete,false);
});

test('error detail permission refusal remains distinct from an unknown layout',async()=>{
 const {Client}=await import('../service-center/client.mjs');const {Page,Document}=await import('../service-center/html.mjs');
 const client=Object.create(Client.prototype);
 client.get=async()=>new Page('https://sc.example.test/ServiceCenter/Show_Error.aspx?Error_Id=error1',
  new Document('<div class="sc-content-main"><h1>Permission denied</h1></div>'));
 await assert.rejects(()=>client.errorDetail('error1'),{code:'SC_PERMISSION_DENIED'});
});

test('timer observation survives journal reopening without changing the send receipt and refuses altered evidence',async()=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const {Journal}=await import('../service-center/client.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-timer-observation-'));
 try {
  const journal=new Journal(root);const id='12345678-1234-4234-8234-123456789abc';
  const receipt=journal.create(id,{...identity,action:'timer-run'},'authorized test',{target,timerLogBaseline:snapshot([])});
  assert.throws(()=>journal.recordTimerObservation(receipt,{}));
  receipt.state='accepted-unverified';journal.rewrite(receipt);
  const original=fs.readFileSync(journal.path(id),'utf8');
  const observed={...compareTimerLogs(snapshot([]),snapshot([row()])),failedAttemptObserved:false,errorObservations:[],errorDetailsComplete:true};
  const saved=journal.recordTimerObservation(receipt,observed);
  assert.equal(fs.readFileSync(journal.path(id),'utf8'),original);
  const reopened=new Journal(root).lookup(id);
  assert.equal(reopened.state,'accepted-unverified');assert.equal(reopened.timerObservation.file,saved.file);
  assert.equal(reopened.timerObservation.observation.executionObserved,true);
  assert.equal(reopened.plan.timerLogBaseline.runs.length,0);
  assert.throws(()=>journal.recordTimerObservation({...receipt,identity:{...receipt.identity,moduleId:'foreign'}},observed));
  const changed=JSON.parse(fs.readFileSync(saved.file,'utf8'));changed.observation.executionCompleted=true;
  fs.writeFileSync(saved.file,JSON.stringify(changed));assert.throws(()=>new Journal(root).lookup(id));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
