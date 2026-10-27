import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {versionPairs} from './gen-compose.mjs';
// The committed window. Until 2026-10-27 this test fixed the initial pairs (11.55.93 + 1.7.29, 11.55.92 + 1.7.28); the
// Studio watcher rotates the window (vigia -Approve pins each new pair), so it checks what every deployable window keeps:
// each pair pinned by the immutable digest of its published tag, distinct images, the newest version of each lane first.
const cmp=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
test('the committed window pins every pair by an immutable digest, newest first',()=>{
 const manifest=JSON.parse(fs.readFileSync(new URL('./versions.json',import.meta.url),'utf8'));
 const pairs=versionPairs(manifest);assert.ok(pairs.length>=1&&pairs.length<=manifest.window);
 for(const p of pairs)assert.match(p.image,/^docker\.io\/andrepereiramachado\/ssam-server:prod-[\w.-]+@sha256:[a-f0-9]{64}$/);
 assert.equal(new Set(pairs.map(p=>p.image)).size,pairs.length);
 for(const lane of ['odc','o11']){const v=manifest[lane].map(x=>x.version);assert.equal(v[0],[...v].sort(cmp).at(-1),lane+' default is the newest');}
});
