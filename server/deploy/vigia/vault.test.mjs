import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url)),ps='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const quote=s=>"'"+s.replaceAll("'","''")+"'";
function run(script){const r=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true,env:{...process.env,PSModulePath:'C:/Windows/System32/WindowsPowerShell/v1.0/Modules;'+(process.env.PSModulePath??'')}});return r;}
test('DPAPI uses entropy: correct purpose decrypts and another purpose is refused',{skip:process.platform!=='win32'},()=>{
 const r=run(`. ${quote(path.join(here,'vault.ps1'))}; $v=Protect-VigiaValue 'synthetic' 'one'; if((Unprotect-VigiaValue $v 'one') -ne 'synthetic'){exit 2}; try { Unprotect-VigiaValue $v 'two' | Out-Null; exit 3 } catch { 'purpose rejected' }`);
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/purpose rejected/);
});
test('MSIX virtualized profile is refused before vault setup',{skip:process.platform!=='win32'},()=>{
 const r=run(`. ${quote(path.join(here,'vault.ps1'))}; function Get-VigiaPackage { [pscustomobject]@{Id='synthetic-package'} }; $env:LOCALAPPDATA='C:/normal-profile'; try { Assert-VigiaNormalProfile; exit 3 } catch { if($_.Exception.Message -notmatch 'normal Windows PowerShell'){exit 4}; 'profile rejected' }`);
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/profile rejected/);
});
test('publisher verification refuses unsigned or different-publisher input',{skip:process.platform!=='win32'},()=>{
 const script=quote(path.join(here,'verify-publisher.ps1'));
 const r=run(`function Get-AuthenticodeSignature { param($LiteralPath) [pscustomobject]@{Status='NotSigned';SignerCertificate=$null} }; try { . ${script} -File 'synthetic.exe'; exit 3 } catch { 'unsigned rejected' }`);
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/unsigned rejected/);
});

test('clone trust walks every entry and refuses a foreign owner using synthetic ACLs',{skip:process.platform!=='win32'},t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clone-acl-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'.git'));fs.writeFileSync(path.join(dir,'foreign.txt'),'fixture');
 const script=`. ${quote(path.join(here,'execution-trust.ps1'))}; $script:foreign=$false;
 function Get-Acl { param($LiteralPath) $a=[pscustomobject]@{Bad=($script:foreign -and $LiteralPath.EndsWith('foreign.txt'))}; $a | Add-Member ScriptMethod GetOwner { param($type) if($this.Bad){return New-Object Security.Principal.SecurityIdentifier('S-1-5-18')} return [Security.Principal.WindowsIdentity]::GetCurrent().User }; $a | Add-Member ScriptMethod GetAccessRules {param($one,$two,$type) return @()}; return $a };
 Assert-ExecutionClone ${quote(dir)}; $script:foreign=$true; try { Assert-ExecutionClone ${quote(dir)}; exit 3 } catch { if($_.Exception.Message -notmatch 'another account'){throw}; 'foreign owner rejected' }`;
 const r=run(script);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/foreign owner rejected/);
});
test('Artifacts refuses development before accessing a certificate and leaves dependencies unchanged',{skip:process.platform!=='win32'},t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sign-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'ODC3.Bridge.v100.dll'),'own');fs.writeFileSync(path.join(dir,'Microsoft.Dependency.dll'),'original');
 const vault=path.join(dir,'vault.json');
 const signing=path.resolve(here,'../../scripts/odc-runtime-signing.ps1');
 const r=run(`. ${quote(path.join(here,'vault.ps1'))}; @{schema=2;values=@{authenticodeThumbprint=(Protect-VigiaValue ('b'*40))}} | ConvertTo-Json | Set-Content -LiteralPath ${quote(vault)}; $script:count=0; function Get-Item { param($LiteralPath) $c=[pscustomobject]@{HasPrivateKey=$true;Subject='owner';Issuer='provider';EnhancedKeyUsageList=@([pscustomobject]@{ObjectId=[pscustomobject]@{Value='1.3.6.1.5.5.7.3.3'}})}; $c | Add-Member ScriptMethod Verify {$true}; return $c }; function Get-AuthenticodeSignature { param($LiteralPath) [pscustomobject]@{Status='Valid';SignerCertificate=[pscustomobject]@{Subject='O=Microsoft Corporation';Thumbprint=('c'*40)}} }; function Set-AuthenticodeSignature { param($LiteralPath,$Certificate,$HashAlgorithm,$IncludeChain,$TimestampServer) $script:count++; [pscustomobject]@{Status='Valid';TimeStamperCertificate='timestamp';SignerCertificate=[pscustomobject]@{Thumbprint=('b'*40)}} }; . ${quote(signing)} -Mode Artifacts -ArtifactDirectory ${quote(dir)} -Vault ${quote(vault)} -TimestampServer 'http://timestamp.test'; if($script:count -ne 1){exit 7}; 'only owned signed'`);
 assert.notEqual(r.status,0);assert.match(r.stderr,/clone|required|path|account/i);assert.equal(fs.readFileSync(path.join(dir,'Microsoft.Dependency.dll'),'utf8'),'original');
});
test('installed system executables of this machine pass the full executable trust walk (real Windows, read-only)',{skip:process.platform!=='win32'},t=>{
 const candidates=['C:/Program Files/Git/cmd/git.exe','C:/Program Files/Git/bin/bash.exe','C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe','C:/Windows/System32/OpenSSH/ssh.exe','C:/Windows/System32/OpenSSH/ssh-keygen.exe','C:/Windows/System32/tar.exe','C:/Program Files/dotnet/dotnet.exe','C:/Program Files/Docker/Docker/resources/bin/docker.exe'].filter(f=>fs.existsSync(f)).map(f=>path.win32.normalize(f));
 if(!candidates.length)return t.skip('no standard executable is installed');
 const r=run(`. ${quote(path.join(here,'execution-trust.ps1'))}; foreach($p in @(${candidates.map(quote).join(',')})){try{Assert-Executable $p;"trusted $p"}catch{"refused $p : $($_.Exception.Message)"}}`);
 assert.equal(r.status,0,r.stderr);assert.doesNotMatch(r.stdout,/refused/);assert.equal((r.stdout.match(/^trusted /gm)??[]).length,candidates.length);
});
