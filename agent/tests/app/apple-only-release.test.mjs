import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse,withoutOffers} from '../../scripts/build.mjs';
import {assertBridgeTrust} from '../../scripts/bridge-trust-gate.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const args=['--platform','mac','--native','core','--notarize','--bundled-bridges-only'];
test('Apple-only distribution forces offline updates and rejects incompatible signing modes',()=>{
 const options=parse(args);assert.equal(options.noUpdates,true);assert.equal(options.bundledBridgesOnly,true);
 for(const extra of [['--test-unsigned'],['--pack-only'],['--cert-sha1','a'.repeat(40)],['--bridge-public-key','key.pem']]) assert.throws(()=>parse([...args,...extra]));
 assert.throws(()=>parse(args.filter(a=>a!=='--notarize')));
 assert.throws(()=>parse(args.map(a=>a==='mac'?'win':a)));
});
test('bundled-only pack preserves integrity data and disables remote offers',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-apple-only-'));try{
 const original={id:'fixture',files:[{path:'native/core',sha256:'a'}],odcBridge:'v108'};
 fs.writeFileSync(path.join(folder,'pack.json'),JSON.stringify(original));
 assert.deepEqual(withoutOffers(folder),{...original,bridgeOffer:false});
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('ordinary release still rejects absent bridge trust anchors',()=>{
 assert.throws(()=>assertBridgeTrust({publicKey:'',nativeKey:'',thumbprint:'',nativeThumbprint:''}),/must be configured/);
 assert.equal(parse(['--platform','mac','--notarize','--native','core','--no-updates']).bundledBridgesOnly,undefined);
});
