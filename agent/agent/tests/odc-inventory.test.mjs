import test from 'node:test';import assert from 'node:assert/strict';
import {bundledOdcProtocols}from '../lib/agent.mjs';
test('the hello inventory names every pinned ODC DLL once, without granting a capability',()=>{
 const f=path=>({path,sha256:'a'.repeat(64),size:1});
 assert.deepEqual(bundledOdcProtocols([f('net10/ODC3.Bridge.v109.dll'),f('net8/ODC3.Bridge.v108.dll'),f('copy/ODC3.Bridge.v108.dll'),f('ODC3.Bridge.v108.deps.json'),{path:'ODC3.Bridge.v999.dll'}]),['v108','v109']);
 assert.deepEqual(bundledOdcProtocols(null),[]);
 assert.deepEqual(bundledOdcProtocols([null, f('ODC3.Bridge.v0108.dll'), {...f('ODC3.Bridge.v109.dll'),size:'1'}, {...f('ODC3.Bridge.v109.dll'),size:1.5}, f('ODC3.Bridge.v999999999999999999999.dll'), f('ODC3.Bridge.v108.dll')]),['v108','v999999999999999999999']);
});
