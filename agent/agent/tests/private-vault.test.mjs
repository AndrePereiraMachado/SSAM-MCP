import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const helper=fileURLToPath(new URL('../lib/private-vault.ps1',import.meta.url));
test('vault FILETIME preserves unsigned halves across the signed low-bit boundary', {skip:process.platform!=='win32'},()=>{
 const script=`$ErrorActionPreference='Stop'
. '${helper.replaceAll("'","''")}'
$dates=@([DateTime]::FromFileTimeUtc(0),[DateTime]::FromFileTimeUtc(2147483647L),[DateTime]::FromFileTimeUtc(2147483648L),[DateTime]::Parse('1970-01-01T00:00:00Z').ToUniversalTime(),[DateTime]::Parse('2026-11-02T00:00:00Z').ToUniversalTime(),[DateTime]::Parse('2099-12-31T23:59:59Z').ToUniversalTime())
$rows=@();foreach($date in $dates){
 $ticks=$date.ToFileTimeUtc();$bytes=[BitConverter]::GetBytes($ticks)
 $ft=[pscustomobject]@{dwLowDateTime=[BitConverter]::ToInt32($bytes,0);dwHighDateTime=[BitConverter]::ToInt32($bytes,4)}
 $actual=Convert-VaultFileTime $ft
 $rows+=@{equal=($actual.Ticks -eq $date.Ticks);negativeLow=($ft.dwLowDateTime -lt 0);high=$ft.dwHighDateTime;kind=$actual.Kind.ToString()}
}
$legacyThrows=$false;try{$null=[int64][uint32](-1)}catch{$legacyThrows=$true}
$invalidHighThrows=$false;try{$null=Convert-VaultFileTime ([pscustomobject]@{dwLowDateTime=0;dwHighDateTime=[int]::MinValue})}catch{$invalidHighThrows=$true}
@{rows=$rows;legacyThrows=$legacyThrows;invalidHighThrows=$invalidHighThrows}|ConvertTo-Json -Depth 5 -Compress`;
 const run=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.legacyThrows,true);assert.equal(result.invalidHighThrows,true);assert.equal(result.rows.length,6);assert.ok(result.rows.every(x=>x.equal&&x.kind==='Utc'));assert.ok(result.rows.some(x=>x.negativeLow));assert.ok(result.rows.some(x=>!x.negativeLow));assert.ok(new Set(result.rows.map(x=>x.high)).size>=4);
});
