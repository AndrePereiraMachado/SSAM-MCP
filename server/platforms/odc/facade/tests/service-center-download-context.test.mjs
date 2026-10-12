import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DownloadContextStore, downloadBinding } from '../service-center/download-context.mjs';
import { parseSolutionPreparation } from '../service-center/solution-preparation.mjs';
import { Transport } from '../service-center/http.mjs';
import { ProtocolError } from '../service-center/errors.mjs';
import { createPowerShellRunner } from '../service-center/vault.mjs';

const identity = {host:'sc.example.test',principal:'operator@example.test',solution:'Example'};
const transport = new Transport(identity.host);
const marker = 'PRIVATE_FORM_SENTINEL_' + crypto.randomUUID();
const form = `<html><body onload="javascript: Bootstrap('6812', '.aspx', 2, 'error', -1, -1, -1, -1, -1); return false;">
<form method="post" action="Solution_Download.aspx"><input type="hidden" name="__OSVSTATE" value="${marker}">
<div class="sc-content-main"><div class="heading2">Download&#160;Running Version of Solution Example</div>
<div id="ButtonZoneDoneOK" style="display:none"><input type="submit" name="final" value="Download"></div>
<textarea id="error" name="error"></textarea></div></form></body></html>`;
const response = html => [transport.url('Solution_Edit.aspx?SolutionId=1'),'text/html; charset=utf-8',Buffer.from(html),'utf-8'];

test('preparation parser binds the running solution and returns private original form fields without executing scripts', () => {
  const result = parseSolutionPreparation(response(form), identity.solution, transport);
  assert.equal(result.asyncOperationId, '6812');
  assert.equal(result.steps, 2);
  assert.equal(result.url, transport.url('Solution_Download.aspx'));
  assert.deepEqual(result.fields, [['__OSVSTATE',marker],['final','Download'],['error','']]);
  // Hidden means not ready. This parser intentionally makes no readiness claim.
  assert.equal(result.completedSuccessfully, undefined);
  assert.equal(result.ready, undefined);
  const optional = parseSolutionPreparation(response(form.replace('</form>', '<input type="hidden" name="__VIEWSTATE" value=""></form>')), identity.solution, transport);
  assert.deepEqual(optional.fields.at(-1), ['__VIEWSTATE','']);
});

test('unknown scripts, target mismatch and unusable form state cannot become a download continuation', () => {
  for (const html of [
    form.replace("'.aspx'", "'.aspx'); globalThis.compromised=true; Bootstrap('"),
    form.replace('return false;', 'return false; extra();'),
    form.replace(', -1, -1, -1, -1, -1)', ', 1, -1, -1, -1, -1)'),
    form.replace("'6812'", "'2147483648'"),
    form.replace(', 2,', ', 0,'),
    form.replace('Version of Solution Example', 'Version of Solution Another'),
    form.replace('action="Solution_Download.aspx"', 'action="Solution_Publish.aspx"'),
    form.replace('action="Solution_Download.aspx"', 'action="https://other.example/ServiceCenter/Solution_Download.aspx"'),
    form.replace('name="final"', 'disabled name="final"'),
    form.replace('name="final"', 'onclick="execute()" name="final"'),
    form.replace('method="post"', 'method="post" onsubmit="execute()"'),
    form.replace(marker, ''),
    form.replace('</form>', '<input type="hidden" name="__OSVSTATE" value="duplicate"></form>'),
    form.replace('id="ButtonZoneDoneOK"', 'id="ButtonZoneNOK"'),
  ]) assert.throws(() => parseSolutionPreparation(response(html), identity.solution, transport), ProtocolError);
  assert.throws(() => parseSolutionPreparation([response(form)[0],'application/octet-stream',Buffer.from(form),'utf-8'],identity.solution,transport),ProtocolError);
});

test('invalid private context identities and excessive payloads fail before spawning a child', async () => {
  const store = new DownloadContextStore({run:async()=>assert.fail('No child process')});
  const id = crypto.randomUUID();
  for (const changed of [{principal:''},{host:'https://sc.example.test'},{solution:''},{version:'archived'}])
    await assert.rejects(store.create(id,{...identity,...changed},{phase:'reserved'}),ProtocolError);
  await assert.rejects(store.read('../outside',identity),ProtocolError);
  await assert.rejects(store.replace(id,identity,-1,{}),ProtocolError);
  await assert.rejects(store.create(id,identity,{oversize:'x'.repeat(8*1024*1024)}),ProtocolError);
  assert.notEqual(downloadBinding(identity),downloadBinding({...identity,principal:'other@example.test'}));
});

test('Windows DPAPI continuation survives process replacement and rejects stale, wrong-target and damaged state', {skip:process.platform!=='win32'}, async () => {
  const store = new DownloadContextStore(), id = crypto.randomUUID();
  const context = {phase:'prepared',asyncOperationId:'6812',fields:[['__OSVSTATE',marker]],ownedCookies:[{name:'test',value:marker}]};
  assert.deepEqual(await store.create(id,identity,context),{revision:0});
  const file = path.join(process.env.USERPROFILE,'.ssam-hybrid','o11','service-center','downloads',id+'.dpapi');
  assert.equal(fs.existsSync(path.join(process.env.LOCALAPPDATA,'SSAM','ServiceCenterDownloads',id+'.dpapi')),false);
  const encrypted = fs.readFileSync(file);
  assert.equal(encrypted.includes(Buffer.from(marker)),false);
  assert.equal(encrypted.includes(Buffer.from(marker,'utf16le')),false);
  assert.deepEqual(await new DownloadContextStore().read(id,identity),{revision:0,context});
  await assert.rejects(store.create(id,identity,{}),{code:'SC_DOWNLOAD_CONTEXT_UNAVAILABLE'});
  for(const changed of [{host:'other.example.test'},{principal:'other@example.test'},{solution:'Other'}])
    await assert.rejects(store.read(id,{...identity,...changed}),{code:'SC_DOWNLOAD_CONTEXT_UNAVAILABLE'});
  const next = {...context,phase:'downloading'};
  assert.deepEqual(await store.replace(id,identity,0,next),{revision:1});
  await assert.rejects(store.replace(id,identity,0,{phase:'prepared'}),{code:'SC_DOWNLOAD_CONTEXT_UNAVAILABLE'});
  assert.deepEqual(await store.read(id,identity),{revision:1,context:next});
  // Both contenders observed revision 1; exactly one can reserve the next send.
  const race = await Promise.allSettled([store.replace(id,identity,1,{phase:'a'}),store.replace(id,identity,1,{phase:'b'})]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await store.read(id,identity)).revision,2);
  const acl = await createPowerShellRunner()(`$null=[Console]::In.ReadToEnd(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $file=Join-Path $env:USERPROFILE '.ssam-hybrid\\o11\\service-center\\downloads\\${id}.dpapi'; $acl=[IO.File]::GetAccessControl($file); @{ok=$true;owner=($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid);otherAllow=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -ne $sid}).Count} | ConvertTo-Json -Compress`,{});
  assert.equal(acl.owner,true); assert.equal(acl.otherAllow,0);
  encrypted[encrypted.length-1] ^= 1;
  fs.writeFileSync(file,encrypted);
  await assert.rejects(store.read(id,identity), error=>error.code==='SC_DOWNLOAD_CONTEXT_UNAVAILABLE' && !error.message.includes(marker));
  await assert.rejects(store.create(id,identity,{phase:'reserved'}),{code:'SC_DOWNLOAD_CONTEXT_UNAVAILABLE'});
});

test('child failures never expose private form values in the public error', async () => {
  const store = new DownloadContextStore({run:async()=>{throw new Error(marker);}});
  await assert.rejects(store.create(crypto.randomUUID(),identity,{state:marker}),error=>error.code==='SC_DOWNLOAD_CONTEXT_UNAVAILABLE' && !error.message.includes(marker));
});
