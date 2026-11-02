import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const lib=fileURLToPath(new URL('../lib/',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/users-private-ui-flow.ps1',import.meta.url));
for(const name of ['temporary','persistent','cancel'])test(`Users private login: ${name}`,{skip:process.platform!=='win32'},()=>{
 const out=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',fixture,'-Library',lib,'-Case',name],{encoding:'utf8',windowsHide:true,timeout:15000});
 const r=Object.assign({},...out.trim().split(/\r?\n/).map(JSON.parse));
 assert.equal(r.defaultUnchecked,true);assert.equal(r.fieldCount,2);assert.equal(r.masked,true);
 assert.equal(r.vaultWrites,name==='persistent'?1:0);assert.equal(r.saved,name!=='cancel');assert.equal(r.remembered,name==='persistent');
 if(name==='temporary'){assert.equal(r.privateCredential.username,'fixture@example.test');assert.equal(r.privateCredential.password,'Fixture-private-password')}
 else assert.equal(r.privateCredential,undefined);
});