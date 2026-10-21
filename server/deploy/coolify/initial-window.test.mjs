import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {versionPairs} from './gen-compose.mjs';
test('initial window pins the two real Studio pairs by immutable digest',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('./versions.json',import.meta.url),'utf8'));
 const pairs=versionPairs(manifest);assert.equal(pairs.length,2);
 assert.deepEqual(pairs.map(p=>[p.o11,p.odc]),[['11.55.93','1.7.29'],['11.55.92','1.7.28']]);
 for(const p of pairs)assert.match(p.image,/^docker\.io\/andrepereiramachado\/ssam-server:prod-[\w.-]+@sha256:[a-f0-9]{64}$/);
 assert.notEqual(pairs[0].image,pairs[1].image);
});
