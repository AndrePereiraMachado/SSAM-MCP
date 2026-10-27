import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acceptMigration, migrationStates } from '../preview/acceptance.mjs';
import { verifyLoadedRevision, validateRevision } from '../preview/revisions.mjs';
const hash = v => createHash('sha256').update(v).digest('hex');

test('revision proof hashes code already loaded by Chrome, not a fetched replacement', async () => {
  const code = 'window.version = 1;', asset = { url:'https://example.com/app.js', sha256:hash(code) };
  const commands = [];
  const cdp = { send: async (method, args) => {
    commands.push(method);
    return method === 'Page.getResourceTree' ? {frameTree:{frame:{id:'1'},resources:[{url:asset.url,type:'Script'}]}}
      : {content:code,base64Encoded:false};
  }};
  const result = await verifyLoadedRevision(cdp, {assets:[asset]}, 'https://example.com');
  assert.equal(result.verified, true);
  assert.deepEqual(commands, ['Page.enable','Page.getResourceTree','Page.getResourceContent']);
  assert.equal((await verifyLoadedRevision(cdp, {assets:[{...asset,sha256:hash('stale')}]}, 'https://example.com')).verified, false);
  assert.throws(() => validateRevision({assets:[asset]}, 'https://other.example.com'));
});

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-accept-'));
  t.after(() => fs.rmSync(workspace, {recursive:true,force:true}));
  const save = (name, text) => { const file = path.join(workspace,name); fs.writeFileSync(file,text); return {file,sha256:hash(text)}; };
  const artifact = save('artifact.png','pixels');
  const identity = 'a'.repeat(64);
  const revision = {verified:true,fingerprint:identity,assets:[{expected:identity,actual:identity,matched:true}]};
  const receipt = {schema:'ssam-browser-comparison/1',scenario:'home-loaded',passed:true,relation:'equivalent',sourceRevisionVerified:true,
    revisions:{reference:revision,candidate:revision},evidence:{reference:artifact,candidate:artifact,referenceImage:artifact,candidateImage:artifact}};
  const contract = {schema:'ssam-migration-acceptance/1',components:[{id:'home',kind:'screen'}],
    cases:[{id:'home-loaded',component:'home',state:'loaded'}],revisions:{reference:identity,candidate:identity}};
  return { workspace,save,receipt,contract,input:() => ({contract,evidence:[{scenario:'home-loaded',receipt:save('comparison.json',JSON.stringify(receipt))}]}) };
}

test('complete matrix with verified revisions and intact evidence passes', t => {
  const f = fixture(t); const result = acceptMigration(f.input(), f);
  assert.equal(result.accepted,true); assert.equal(result.checked.length,1);
  assert.equal(fs.existsSync(result.receipt.file),true);
});
test('unexecuted popup states cannot inherit a screen pass', t => {
  const f = fixture(t); f.contract.components.push({id:'editor',kind:'popup'});
  const result = acceptMigration(f.input(), f);
  assert.equal(result.accepted,false);
  assert.equal(result.problems.filter(x=>x.code==='MIGRATION_STATE_MISSING').length,4);
});
test('unverified or mismatched deployed revisions block acceptance', t => {
  const f = fixture(t); f.receipt.sourceRevisionVerified=false;
  assert.equal(acceptMigration(f.input(),f).accepted,false);
  f.receipt.sourceRevisionVerified=true; f.contract.revisions.candidate='b'.repeat(64);
  assert.equal(acceptMigration(f.input(),f).accepted,false);
});
test('changed screenshots are rejected even if the comparison receipt still says passed', t => {
  const f=fixture(t); const input=f.input(); fs.writeFileSync(f.receipt.evidence.referenceImage.file,'changed');
  assert.throws(()=>acceptMigration(input,f),{code:'MIGRATION_ACCEPTANCE_INVALID'});
});
test('missing and failed scenarios do not pass', t => {
  const f=fixture(t); assert.equal(acceptMigration({...f.input(),evidence:[]},f).accepted,false);
  f.receipt.passed=false; assert.equal(acceptMigration(f.input(),f).accepted,false);
});
test('pagination next requires a records transition proof', t => {
  const f=fixture(t); f.contract.components=[{id:'home',kind:'pagination'}];
  f.contract.cases=[{id:'home-loaded',component:'home',state:'next'}];
  const result=acceptMigration(f.input(),f);
  assert.equal(result.accepted,false);
  assert.ok(result.problems.some(p=>p.code==='MIGRATION_TRANSITION_UNPROVEN'));
});

test('all component families require their full state matrix and intact receipts', t => {
  const f=fixture(t), evidence=[];
  f.contract.components=[]; f.contract.cases=[];
  for(const [kind,states] of Object.entries(migrationStates)) {
    f.contract.components.push({id:kind,kind});
    for(const state of states) {
      const id=kind+'-'+state;
      f.contract.cases.push({id,component:kind,state});
      const receipt={...f.receipt,scenario:id,assertions:[{key:'component',count:1},{key:'rows',count:state==='empty'?0:state==='single'?1:25,expected:{reference:['1'],candidate:['1']}}]};
      const entry={scenario:id,receipt:f.save(id+'.json',JSON.stringify(receipt))};
      if(state==='next') entry.transition=f.save(id+'-transition.json',JSON.stringify({...receipt,relation:'pagination'}));
      evidence.push(entry);
    }
  }
  assert.equal(acceptMigration({contract:f.contract,evidence},f).accepted,true);
  evidence.pop();
  assert.equal(acceptMigration({contract:f.contract,evidence},f).accepted,false);
});

test('an empty table cannot pass when only a missing row selector is declared',t=>{
  const f=fixture(t); f.contract.components=[{id:'home',kind:'table'}]; f.contract.cases=[{id:'home-loaded',component:'home',state:'empty'}];
  f.receipt.assertions=[{key:'rows',count:0}];
  const result=acceptMigration(f.input(),f);
  assert.ok(result.problems.some(p=>p.code==='MIGRATION_TABLE_CONTAINER_REQUIRED'));
});
