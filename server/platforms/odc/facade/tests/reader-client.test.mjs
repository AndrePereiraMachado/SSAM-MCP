import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { readerGeneration, readerRpc, readingSummary, presentReading } from '../reader-client.mjs';
import { odcStudioDir } from '../lib.mjs';

test('reader generations change for binary content and model runtime content, even with preserved timestamps', t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-reader-generation-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const bin=path.join(directory,'bin'),runtime=path.join(directory,'runtime');fs.mkdirSync(bin);fs.mkdirSync(runtime);
  const dll=path.join(bin,'reader.dll'),native=path.join(runtime,'OutSystems.Model.dll');
  fs.writeFileSync(dll,'AAAA');fs.writeFileSync(native,'AAAA');
  const first=readerGeneration(dll,runtime);
  const stamp=fs.statSync(dll).mtime;fs.writeFileSync(dll,'BBBB');fs.utimesSync(dll,stamp,stamp);
  const second=readerGeneration(dll,runtime);assert.notEqual(second,first);
  const nativeStamp=fs.statSync(native).mtime;fs.writeFileSync(native,'BBBB');fs.utimesSync(native,nativeStamp,nativeStamp);
  assert.notEqual(readerGeneration(dll,runtime),second);
});

test('a copy of the runtime with the same files is another reader generation', t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-reader-runtime-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const bin=path.join(directory,'bin');fs.mkdirSync(bin);
  const dll=path.join(bin,'reader.dll');fs.writeFileSync(dll,'AAAA');
  const [installed,copy]=['installed','copy'].map(name=>{
    const runtime=path.join(directory,name);fs.mkdirSync(runtime);
    const native=path.join(runtime,'OutSystems.Model.dll');fs.writeFileSync(native,'AAAA');fs.utimesSync(native,10000,10000);
    return runtime;
  });
  assert.notEqual(readerGeneration(dll,copy),readerGeneration(dll,installed));
  assert.equal(readerGeneration(dll,copy+path.sep),readerGeneration(dll,copy));
});

test('the ODC reader runtime follows ANVIL_ODC_STUDIO_DIR and refuses a folder that is not an ODC Studio', t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-odc-runtime-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  assert.equal(odcStudioDir({ProgramFiles:'D:\\Programs'}),path.join('D:\\Programs','OutSystems','ODC Studio','ODC Studio'));
  assert.throws(()=>odcStudioDir({ANVIL_ODC_STUDIO_DIR:directory}),/not an ODC Studio directory/);
  fs.writeFileSync(path.join(directory,'OutSystems.ModelAPILoader.dll'),'');
  assert.throws(()=>odcStudioDir({ANVIL_ODC_STUDIO_DIR:directory}),/not an ODC Studio directory/);
  fs.writeFileSync(path.join(directory,'OutSystems.Model.dll'),'');
  assert.equal(odcStudioDir({ANVIL_ODC_STUDIO_DIR:directory,ProgramFiles:'D:\\Programs'}),directory);
  // A relative value names another folder in the reader's own working directory: refused even when it resolves here.
  const relative=path.relative(process.cwd(),directory);
  for(const value of ['',' ',path.join(directory,'missing'),...(path.isAbsolute(relative)?[]:[relative])])
    assert.throws(()=>odcStudioDir({ANVIL_ODC_STUDIO_DIR:value}),/not an ODC Studio directory/);
  // The headless debugger (ssam debug --lane odc) builds against and loads the same folder, never the installation.
  const debugRuntime=fs.readFileSync(new URL('../debug-runtime.mjs',import.meta.url),'utf8');
  assert.match(debugRuntime,/if \(lane === 'odc'\) return \(await import\('\.\/lib\.mjs'\)\)\.odcStudioDir\(\);/);
  assert.doesNotMatch(debugRuntime,/'ODC Studio'/);
});

test('read transport handles fragmented replies and rejects incomplete responses', async t=>{
  const server=net.createServer(socket=>socket.once('data',request=>{
    const {args,authorization}=JSON.parse(request.toString());assert.equal(authorization,'test-credential');
    if(args[0]==='incomplete') return socket.end('{"ok":');
    socket.write('{"ok":'); setImmediate(()=>socket.end('true}\n'));
  }));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const state={port:server.address().port};
  assert.deepEqual(await readerRpc(state,['read'],'test-credential'),{ok:true});
  await assert.rejects(readerRpc(state,['incomplete'],'test-credential'),/without a complete response/);
});

test('large batch results expose target navigation, selection failures and omissions without hiding evidence', t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-reader-summary-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const data={schema:'ssam-reading-batch/1',requested:2,complete:false,entries:[
    {selector:'@x',ok:true,data:{tree:{kind:'Action',key:'x',name:'Pin',reference:'@x',path:'Block:Address/Action:Pin',
      properties:{JavaScript:'x'.repeat(500)},propertyErrors:{Broken:'failed'},propertiesOmitted:{Long:'cut'},propertiesMissing:['Unknown'],childrenOmitted:3,children:[]}}},
    {selector:'Missing',ok:false,error:'Unresolved'}]};
  const summary=readingSummary(data);assert.equal(summary.nodes,1);assert.equal(summary.childrenOmitted,3);
  assert.equal(summary.propertyErrors,1);assert.equal(summary.propertyOmissions,1);assert.equal(summary.failures.length,1);
  assert.equal(summary.propertiesMissing,1);assert.equal(summary.selections[0].childrenOmitted,3);
  const out=path.join(directory,'first.json');
  const result=presentReading({data,sourceSha256:'HASH'}, {file:'snapshot.oml',out,budget:100});
  assert.equal(result.inline,false);assert.equal(result.navigation.target,'snapshot.oml');
  assert.equal(result.navigation.expectedSourceSha256,'HASH');assert.equal(result.summary.targets[0].reference,'@x');
  assert.deepEqual(JSON.parse(fs.readFileSync(out,'utf8')),data);
});

test('usage summaries retain native edge identities, pagination and incomplete-read diagnostics', ()=>{
  const edge={consumer:{reference:'@consumer'},target:{reference:'@target'},internal:false};
  const summary=readingSummary({schema:'ssam-usages/1',scope:'subtree',count:20,returned:10,nextOffset:10,
    complete:false,referenceReadErrors:1,entries:Array.from({length:10},()=>edge)});
  assert.equal(summary.complete,false);assert.equal(summary.nextOffset,10);assert.equal(summary.referenceReadErrors,1);
  assert.equal(summary.edges.length,8);assert.equal(summary.edgesOmitted,2);assert.deepEqual(summary.edges[0],edge);
});
