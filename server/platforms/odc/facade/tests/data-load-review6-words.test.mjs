import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDataLoad,o11DataChannel} from '../data-load.mjs';
import {OWNER_REPLY,WORDS_ECHO,noteWords,wordsSha256} from '../destructive-operations.mjs';

// Review 6 of CX13: the owner's words that confirm an overwrite (confirmUpdates) or a close of a file load go through the
// ONE rule of the destructive operations (CX15, destructive-operations.mjs), the same predicate as every other gate:
//   R6-U1a: a confirmation never serves another load and never lasts forever: the update preview is bound to its load
//           (operationId + fingerprint), it is consumed when it grants, it is valid 30 min (PREVIEW_TTL_MS) and words
//           that already confirmed a preview never confirm another (they were seen on the host before it);
//   B-P4:   the load's words taken from a preview count only for the load of that preview;
//   R6-F15: a server text (a <template>, the marker of the owner's words, OWNER_REPLY, a sha256) as any words field is one
//           WORDS_REQUIRED before any read or write; the kernel gets sha256:<hex> of the words, never the words; plan.json,
//           journal.jsonl, the previews and the receipts keep only the sha256;
//   R6-W1:  "seen before" is the CX15 store of the host (every destructive tool, and the ownerRequest), not this load's own.
const stock={name:'Stock',identifier:'Id',indexes:[],attributes:[{name:'Id',type:'Stock Identifier'},{name:'Sku',type:'Text'},{name:'Qty',type:'Integer'}]};
let sequence=0;
const uuid=()=>`b6100000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
const HOUR=3600*1000;
function fixture(t,lane,db){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r6w-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const clock={at:Date.parse('2026-10-17T12:00:00Z')};let nextId=100;const sent=[];const calls=[];const faults={failInsert:0};
  const count=(name,fn)=>async(...args)=>{calls.push(name);return fn(...args);};
  const channel={schema:count('schema',async()=>({entities:[stock]})),check:count('check',async()=>({ok:true})),readAll:count('readAll',async()=>({records:db.map(r=>({...r})),complete:true})),
    write:count('write',async ops=>ops.map(op=>{
      if(op.operation==='insert'&&faults.failInsert){faults.failInsert--;sent.push({op:op.operation,failed:true});return{ok:false,outcome:'failed',failedRows:op.records.map((_,index)=>({index,reason:'synthetic constraint'}))};}
      sent.push({op:op.operation,records:op.records,authorization:op.authorization});
      const ids=op.records.map(record=>{
        if(op.operation==='update'){const row=db.find(r=>String(r.Id)===String(record.Id));Object.assign(row,record);return String(row.Id);}
        const row={...record,Id:String(nextId++)};db.push(row);return row.Id;});
      return{ok:true,outcome:'completed',ids};
    }))};
  const file=(name,text)=>{const f=path.join(root,name);fs.writeFileSync(f,text);return f;};
  const destructiveRoot=path.join(root,'destructive'),journalRoot=path.join(root,'loads');
  const options=()=>({journalRoot,now:()=>clock.at,destructive:{root:destructiveRoot}});
  return{root,db,channel,sent,calls,faults,file,options,clock,destructiveRoot,journalRoot,later:(ms=6000)=>{clock.at+=ms;}};
}
const load=(f,lane,extra={})=>({lane,host:'synthetic.test',module:'M',entity:'Stock',operation:'insert',keys:['Sku'],operationId:uuid(),authorization:'carregar o estoque sintetico do arquivo',...extra});

for(const lane of ['o11','odc']){
  test(`R6-U1a ${lane}: an old confirmUpdates replayed on a new load, 1 h or 26 h later, gets a new preview and overwrites nothing`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,lane,db);
    const X=load(f,lane,{files:[f.file('stock.csv','Sku,Qty\nSKU-1,100\n')]});
    const stop=await runDataLoad(X,f.channel,f.options());
    assert.equal(stop.code,'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED');f.later();
    const old={previewSha256:stop.updatePreview.sha256,authorize:'sim pode atualizar 1 linha do estoque'};
    const done=await runDataLoad({...X,confirmUpdates:old},f.channel,f.options());
    assert.equal(done.complete,true,JSON.stringify(done).slice(0,400));assert.equal(db[0].Qty,'100');
    for(const [label,ms] of [['1 h',HOUR],['26 h',25*HOUR]]){
      db[0].Qty='1';f.sent.length=0;f.later(ms); // another writer restored the old value
      const Y={...X,operationId:uuid()};
      const replay=await runDataLoad({...Y,confirmUpdates:old},f.channel,f.options());
      assert.equal(replay.ok,false,label+' '+JSON.stringify(replay).slice(0,400));
      assert.match(replay.code,/^DATA_LOAD_UPDATE_(PREVIEW_CHANGED|CONFIRMATION_REQUIRED)$/,label);
      assert.equal(replay.updatePreview?.count,1,label+': a new preview of the row');
      assert.notEqual(replay.updatePreview.sha256,old.previewSha256,label+': never the old preview');
      assert.equal(f.sent.length,0,label+': nothing sent');assert.equal(db[0].Qty,'1',label+': no overwrite without new words');
    }
  });
  test(`R6-U1a ${lane}: an update preview grants once and only within 30 min`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,lane,db);
    const X=load(f,lane,{files:[f.file('stock.csv','Sku,Qty\nSKU-1,100\n')]});
    const stop=await runDataLoad(X,f.channel,f.options());f.later(31*60*1000);
    const late=await runDataLoad({...X,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:'pode atualizar 1 linha agora'}},f.channel,f.options());
    assert.equal(late.ok,false);assert.equal(f.sent.length,0,'an expired preview never grants');
    assert.ok(late.problems?.some(p=>p.code==='PREVIEW_EXPIRED'),JSON.stringify(late).slice(0,600));
    assert.ok(late.updatePreview?.sha256,'the answer is a new preview of the same rows');
    // The new preview is valid for 30 min; the owner's fresh words confirm it, once.
    f.later();
    const granted=await runDataLoad({...X,confirmUpdates:{previewSha256:late.updatePreview.sha256,authorize:'sim, 1 linha pode atualizar'}},f.channel,f.options());
    assert.equal(granted.complete,true,JSON.stringify(granted).slice(0,400));assert.equal(db[0].Qty,'100');
    const previewFile=path.join(f.journalRoot,'.update-previews',`${late.updatePreview.sha256}.json`);
    assert.ok(JSON.parse(fs.readFileSync(previewFile,'utf8')).consumedAt,'the preview is consumed when it grants');
    // The same preview presented again by another load of the same transition never grants.
    db[0].Qty='1';f.sent.length=0;f.later();
    const again=await runDataLoad({...X,operationId:uuid(),confirmUpdates:{previewSha256:late.updatePreview.sha256,authorize:'outra resposta, 1 linha'}},f.channel,f.options());
    assert.equal(again.ok,false);assert.equal(f.sent.length,0);assert.equal(db[0].Qty,'1');
  });
  test(`R6-U1a ${lane}: a consumed preview never grants again, even to its own load`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,lane,db);
    const X=load(f,lane,{files:[f.file('stock.csv','Sku,Qty\nSKU-1,100\n')]});
    const stop=await runDataLoad(X,f.channel,f.options());f.later();
    const write=f.channel.write;f.channel.write=async ops=>ops.map(()=>({ok:false,outcome:'not-submitted',code:'STUDIO_BUSY',error:'synthetic busy'}));
    const confirm={previewSha256:stop.updatePreview.sha256,authorize:'pode atualizar 1 linha, so desta vez'};
    const busy=await runDataLoad({...X,confirmUpdates:confirm},f.channel,f.options());
    assert.equal(busy.complete,false,JSON.stringify(busy).slice(0,400));
    // A grant lost after the preview was consumed (the plan write that follows it never happened): the preview stays spent.
    const planFile=path.join(f.journalRoot,X.operationId,'plan.json');
    const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));assert.ok(Object.keys(plan.confirmedUpdates??{}).length,'the grant was recorded');
    delete plan.confirmedUpdates;fs.writeFileSync(planFile,JSON.stringify(plan));
    f.channel.write=write;f.sent.length=0;f.later();
    const again=await runDataLoad({...X,confirmUpdates:{...confirm,authorize:'pode atualizar 1 linha, outra resposta'}},f.channel,f.options());
    assert.equal(again.ok,false,JSON.stringify(again).slice(0,400));assert.equal(f.sent.length,0);assert.equal(db[0].Qty,'1');
    assert.notEqual(again.updatePreview?.sha256,undefined,'a new preview');
  });
  test(`R6-U1a ${lane}: words that confirmed one preview never confirm another`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'},{Id:'8',Sku:'SKU-2',Qty:'2'}];const f=fixture(t,lane,db);
    const X=load(f,lane,{files:[f.file('x.csv','Sku,Qty\nSKU-1,100\n')]});
    const stopX=await runDataLoad(X,f.channel,f.options());f.later();
    const words='confirmo, 1 linha do estoque';
    assert.equal((await runDataLoad({...X,confirmUpdates:{previewSha256:stopX.updatePreview.sha256,authorize:words}},f.channel,f.options())).complete,true);
    f.later(2*HOUR);f.sent.length=0;
    const Y=load(f,lane,{files:[f.file('y.csv','Sku,Qty\nSKU-2,200\n')],authorization:'carregar o segundo arquivo de estoque'});
    const stopY=await runDataLoad(Y,f.channel,f.options());f.later();
    const reused=await runDataLoad({...Y,confirmUpdates:{previewSha256:stopY.updatePreview.sha256,authorize:words}},f.channel,f.options());
    assert.equal(reused.ok,false);assert.ok(reused.problems?.some(p=>p.code==='WORDS_BEFORE_PREVIEW'),JSON.stringify(reused).slice(0,600));
    assert.equal(f.sent.length,0);assert.equal(db[1].Qty,'2');
  });
  test(`B-P4 ${lane}: a load without words never takes the words of another load's preview`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,lane,db);
    const X=load(f,lane,{files:[f.file('x.csv','Sku,Qty\nSKU-1,100\n')]});
    const stopX=await runDataLoad(X,f.channel,f.options());f.later();
    const Y=load(f,lane,{files:[f.file('y.csv','Sku,Qty\nSKU-9,9\n')],authorization:undefined});
    const borrowed=await runDataLoad({...Y,confirmUpdates:{previewSha256:stopX.updatePreview.sha256,authorize:'sim, 1 linha, carga y'}},f.channel,f.options());
    assert.equal(borrowed.ok,false,JSON.stringify(borrowed).slice(0,400));assert.equal(f.sent.length,0);
    assert.deepEqual(db.map(r=>r.Sku),['SKU-1'],'nothing inserted with the words of another load');
  });
  test(`R6-F15 ${lane}: a server text in any words field of a load is one WORDS_REQUIRED before any read or write`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,lane,db);
    const markers=[WORDS_ECHO,'<palavras do usuário>',OWNER_REPLY,"<the owner's next message after the preview, verbatim>",'sha256:'+'a'.repeat(64),`sim, ${WORDS_ECHO}`];
    const file=f.file('stock.csv','Sku,Qty\nSKU-1,100\nSKU-2,5\n');
    for(const marker of markers){
      for(const shape of [{authorization:marker},{authorization:undefined,confirmUpdates:{previewSha256:'b'.repeat(64),authorize:marker}},{authorization:undefined,close:{previewSha256:'c'.repeat(64),authorize:marker}}]){
        f.calls.length=0;
        const out=await runDataLoad(load(f,lane,{files:[file],...shape}),f.channel,f.options());
        assert.equal(out.code,'WORDS_REQUIRED',JSON.stringify({marker,shape:Object.keys(shape),out}).slice(0,500));
        assert.deepEqual(f.calls,[],'nothing read or sent: '+marker);
      }
    }
    const both=await runDataLoad(load(f,lane,{files:[file],authorization:WORDS_ECHO,confirmUpdates:{previewSha256:'b'.repeat(64),authorize:OWNER_REPLY}}),f.channel,f.options());
    assert.equal(both.code,'WORDS_REQUIRED');assert.equal(both.problems.length,2,'one refusal with every field');
    assert.deepEqual(f.sent,[]);assert.deepEqual(db,[{Id:'7',Sku:'SKU-1',Qty:'1'}]);
  });
  test(`R6-F15 ${lane}: plan.json, journal.jsonl, the previews and the receipts keep only the sha256 of the owner's words`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,lane,db);f.faults.failInsert=99;
    const loadWords='carregar o estoque guardado so como hash',updateWords='pode atualizar 1 linha guardada so como hash',closeWords='pode fechar 1 linha guardada so como hash';
    const X=load(f,lane,{files:[f.file('stock.csv','Sku,Qty\nSKU-1,100\nSKU-2,5\n')],authorization:loadWords,batchSize:1});
    const stop=await runDataLoad(X,f.channel,f.options());f.later();
    const failed=await runDataLoad({...X,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:updateWords}},f.channel,f.options());
    assert.equal(failed.code,'DATA_WRITE_FAILED',JSON.stringify(failed).slice(0,400));
    for(const op of f.sent.filter(s=>s.authorization!==undefined))assert.equal(op.authorization,'sha256:'+wordsSha256(loadWords),'the channel gets the sha256 of the load words');
    const preview=await runDataLoad({...X,authorization:undefined,close:{preview:true}},f.channel,f.options());f.later();
    const closed=await runDataLoad({...X,authorization:undefined,close:{previewSha256:preview.closePreview.sha256,authorize:closeWords}},f.channel,f.options());
    assert.equal(closed.state,'closed',JSON.stringify(closed).slice(0,400));
    const files=[f.journalRoot,f.destructiveRoot].flatMap(dir=>fs.readdirSync(dir,{recursive:true}).map(String).map(name=>path.join(dir,name)).filter(p=>fs.statSync(p).isFile()));
    assert.ok(files.some(p=>p.endsWith('plan.json'))&&files.some(p=>p.endsWith('journal.jsonl'))&&files.some(p=>p.includes('.update-previews')));
    for(const p of files){const text=fs.readFileSync(p,'utf8');for(const words of [loadWords,updateWords,closeWords])assert.equal(text.includes(words),false,`${path.relative(f.root,p)} keeps the words in clear`);}
    const plan=JSON.parse(fs.readFileSync(path.join(f.journalRoot,X.operationId,'plan.json'),'utf8'));
    assert.equal(plan.authorizationSha256,wordsSha256(loadWords));
  });
  test(`R6-W1 ${lane}: words another destructive tool saw on the host before the preview never confirm it`,async t=>{
    const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,lane,db);
    const X=load(f,lane,{files:[f.file('x.csv','Sku,Qty\nSKU-1,100\n')]});
    const words='sim, apaga 1 registro de Stock, ja disse antes';
    noteWords({host:'synthetic.test',tool:'studio_data_delete',words,now:f.clock.at-HOUR,root:f.destructiveRoot});
    const stop=await runDataLoad(X,f.channel,f.options());f.later();
    const out=await runDataLoad({...X,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:words}},f.channel,f.options());
    assert.equal(out.ok,false);assert.ok(out.problems?.some(p=>p.code==='WORDS_BEFORE_PREVIEW'),JSON.stringify(out).slice(0,600));
    assert.equal(f.sent.length,0);assert.equal(db[0].Qty,'1');
  });
}
test('R6-W1 o11: the ownerRequest of a load is seen before its preview and never confirms it',async t=>{
  const db=[{Id:'7',Sku:'SKU-1',Qty:'1'}];const f=fixture(t,'o11',db);
  const request='atualize 1 linha do estoque com o arquivo';
  const X=load(f,'o11',{files:[f.file('x.csv','Sku,Qty\nSKU-1,100\n')],ownerRequest:request});
  const stop=await runDataLoad(X,f.channel,f.options());f.later();
  const out=await runDataLoad({...X,confirmUpdates:{previewSha256:stop.updatePreview.sha256,authorize:request}},f.channel,f.options());
  assert.equal(out.ok,false);assert.ok(out.problems?.some(p=>p.code==='WORDS_BEFORE_PREVIEW'),JSON.stringify(out).slice(0,600));
  assert.equal(f.sent.length,0);
});
test('R6-F15 o11: the kernel --request of a file load carries sha256:<hex> of the owner\'s words, never the words',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx13-r6k-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const words='carregar pedidos sinteticos agora mesmo';const requests=[];const db=[];let nextId=500;
  const entity={name:'E',key:'oek-E',identifier:'Id',indexes:[],attributes:[{name:'Id',type:'E Identifier',autoNumber:true},{name:'Code',type:'Text'},{name:'Qty',type:'Integer'}]};
  const ok=data=>({ok:true,envelope:{ok:true,command:'data',data},wallMs:1});
  const runAnvil=async args=>{
    if(args.includes('--schema'))return ok({ok:true,module:'SyntheticApp',moduleKey:'omk-1',entities:[entity]});
    const request=JSON.parse(fs.readFileSync(args[args.indexOf('--request')+1],'utf8'));requests.push(request);
    if(args.includes('--check'))return ok({ok:true});
    const results=(request.batch??[request]).map(op=>op.operation==='read-all'?{ok:true,records:db.map(r=>({...r})),complete:true}
      :{ok:true,ids:op.records.map(record=>{const Id=String(nextId++);db.push({...record,Id});return Id;})});
    return ok({ok:true,host:'synthetic.test',module:'SyntheticApp',results});
  };
  const file=path.join(root,'rows.json');fs.writeFileSync(file,JSON.stringify([{Code:'A',Qty:1},{Code:'B',Qty:2}]));
  const call={host:'synthetic.test',module:'SyntheticApp',oml:path.join(root,'x.oml')};fs.writeFileSync(call.oml,'synthetic');
  const out=await runDataLoad({lane:'o11',...call,operation:'insert',entity:'E',files:[file],keys:['Code'],operationId:uuid(),authorization:words},
    o11DataChannel({runAnvil,call:{...call,entity:'E'},work:path.join(root,'work')}),{journalRoot:path.join(root,'work','loads'),destructive:{root:path.join(root,'destructive')}});
  assert.equal(out.complete,true,JSON.stringify(out).slice(0,400));
  const authorizations=requests.flatMap(r=>[r.authorization,...(r.batch??[]).map(op=>op.authorization)]).filter(a=>a!==undefined);
  assert.ok(authorizations.length>=2,'the check and the write carry the authorization');
  assert.deepEqual([...new Set(authorizations)],['sha256:'+wordsSha256(words)]);
  for(const name of fs.readdirSync(path.join(root,'work'),{recursive:true}).map(String))if(fs.statSync(path.join(root,'work',name)).isFile())
    assert.equal(fs.readFileSync(path.join(root,'work',name),'utf8').includes(words),false,name+' keeps the words in clear');
});
