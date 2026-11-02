import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const library=fileURLToPath(new URL('../lib/',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/credential-helper-flow.ps1',import.meta.url));
const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
function run(name){
 const out=execFileSync(executable,['-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File',fixture,'-Library',library,'-Case',name],{encoding:'utf8',windowsHide:true,timeout:15000});
 const rows=out.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
 const last=Object.assign({},...rows);if(rows.some(row=>row.errorVisible))last.errorVisible=true;return last;
}
const checks={
 'status-temporary':r=>{assert.equal(r.principal,'temporary@example.test');assert.equal(r.available,true);assert.equal(r.authenticated,true)},
 'ui-forget-temporary':r=>assert.equal(r.forgotten,true),
 status:r=>{assert.equal(r.authenticated,true);assert.equal(r.profiles.length,2)},
 missing:r=>{assert.equal(r.available,false);assert.equal(r.authenticated,false)},
 'status-expired':r=>assert.equal(r.authenticated,false),
 'status-cookie-expired':r=>assert.equal(r.authenticated,false),
 'status-other-principal':r=>assert.equal(r.authenticated,false),
 'selected-other':r=>{assert.equal(r.profile,'b'.repeat(64));assert.equal(r.principal,'second@example.test');assert.equal(r.authenticated,false)},
 'profile-changed':r=>assert.equal(r.code,'CREDENTIAL_SIGN_IN_REQUIRED'),
 binary:r=>{assert.equal(r.ok,true);assert.deepEqual([...Buffer.from(r.body,'base64')],[0,255,128,65,13,10,0,250]);assert.equal(r.privateSession.cookies.length,1);assert.equal(r.privateSession.cookies[0].path,'/ServiceCenter/')},
 charset:r=>{assert.equal(r.ok,true);assert.deepEqual([...Buffer.from(r.body,'base64')],[99,97,102,233]);assert.equal(r.contentType,'text/plain; charset=windows-1252')},
 'binary-secret':r=>assert.equal(r.code,'CREDENTIAL_REQUEST_FAILED'),
 echo:r=>{assert.equal(r.ok,true);assert.equal(Buffer.from(r.body,'base64').toString(),'[redacted] [redacted]');assert.equal(r.redacted,true)},
 csrf:r=>{assert.equal(r.ok,true);assert.equal(Buffer.from(r.body,'base64').toString(),'[redacted]')},
 'timer-basic':r=>{assert.equal(r.ok,true);assert.equal(r.privateSession,null)},
 'timer-token':r=>{assert.equal(r.ok,true);assert.equal(r.privateSession,null)},
 'status-basic':r=>{assert.equal(r.available,true);assert.equal(r.authenticated,false)},
 'oauth-success':r=>{assert.equal(r.authenticated,true);assert.equal(r.privateSession.principal,'owner@example.test');assert.ok(r.privateSession.expiresAt>Date.now())},
 'oauth-foreign':r=>assert.equal(r.code,'CREDENTIAL_AUTH_UNSUPPORTED'),
 'oauth-port':r=>assert.equal(r.code,'CREDENTIAL_AUTH_UNSUPPORTED'),
 'oauth-grant':r=>assert.equal(r.code,'CREDENTIAL_AUTH_UNSUPPORTED'),
 'oauth-expiry':r=>assert.equal(r.code,'CREDENTIAL_LOGIN_FAILED'),
 'oauth-crlf':r=>assert.equal(r.code,'CREDENTIAL_LOGIN_FAILED'),
 'ui-login-error':r=>assert.equal(r.errorVisible,true),
 'ui-api-error':r=>assert.equal(r.errorVisible,true),
 'ui-login-save':r=>{assert.equal(r.saved,true);assert.equal(r.remembered,true);assert.equal(r.vaultWritten,true);assert.equal(r.fieldCount,2);assert.equal(r.fieldsCleared,true)},
 'ui-login-temporary':r=>{assert.equal(r.saved,true);assert.equal(r.remembered,false);assert.equal(r.vaultWritten,false);assert.equal(r.fieldCount,2);assert.equal(r.privateCredential.username,'owner@example.test');assert.equal(r.privateCredential.password,'Fixture-private-entry');assert.equal(r.fieldsCleared,true)},
 'ui-login-save-failed':r=>{assert.equal(r.vaultWritten,false);assert.equal(r.saved,false);assert.equal(r.storageFailureVisible,true)},
 'ui-profile-use':r=>{assert.equal(r.selectionStored,true);assert.equal(r.correctProfile,true)},
 'ui-profile-error':r=>assert.equal(r.errorVisible,true),
 'ui-forget-error':r=>{assert.equal(r.errorVisible,true);assert.equal(r.code,'CREDENTIAL_CONFIRMATION_DECLINED')},
 'ui-forget-confirm':r=>assert.equal(r.forgotten,true),
 'ui-forget-initial':r=>assert.equal(r.code,'CREDENTIAL_CONFIRMATION_DECLINED'),
};
for(const [name,check] of Object.entries(checks))test('private helper integration: '+name,{skip:process.platform!=='win32',timeout:20000},()=>check(run(name)));
