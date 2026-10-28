param([string]$Odc,[string]$O11,[string]$Installers)
# The Studio versions on this machine: the installed (or frozen) Studio folders, read from ServiceStudio.Framework.dll,
# with the .NET each one runs on (tfm of its main runtimeconfig.json; null when the folder has none), and downloaded O11
# installers, read without running them. Prints one JSON array.
$ErrorActionPreference='Stop'
$result=@()
$runtimeConfig=@{odc='ODCStudio.runtimeconfig.json';o11='ServiceStudio.runtimeconfig.json'}
$exe=@{odc='ODCStudio.exe';o11='ServiceStudio.exe'}
foreach($item in @(@{lane='odc';root=$Odc},@{lane='o11';root=$O11})){
 if(-not $item.root){continue}
 $dll=Join-Path $item.root 'ServiceStudio.Framework.dll'
 if(-not (Test-Path -LiteralPath $dll)){continue}
 $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($dll)
 $full=if($info.ProductVersion -match '^\d+\.\d+\.\d+(\.\d+)?'){$Matches[0]}elseif($info.FileVersion -match '^\d+\.\d+\.\d+(\.\d+)?'){$Matches[0]}else{$null}
 $tfm=$null
 $rc=Join-Path $item.root $runtimeConfig[$item.lane]
 if(Test-Path -LiteralPath $rc){try{$tfm=(Get-Content -LiteralPath $rc -Raw | ConvertFrom-Json).runtimeOptions.tfm}catch{$tfm=$null}}
 # An installed Studio has its executable and its runtimeconfig.json; without them it is incomplete (an installation
 # half-way, a repair needed), and the watcher defers its lane instead of guessing its runtime.
 $missing=@(@($exe[$item.lane],$runtimeConfig[$item.lane]) | Where-Object { -not (Test-Path -LiteralPath (Join-Path $item.root $_)) })
 if($full){$result+=@{lane=$item.lane;studio=$item.root;fullVersion=$full;version=($full -split '\.')[0..2] -join '.';tfm=$tfm;missing=$missing}}
}
if($Installers -and (Test-Path -LiteralPath $Installers)){
 foreach($file in Get-ChildItem -LiteralPath $Installers -File -Filter '*.exe'){
  if($file.Name -notmatch 'DevelopmentEnvironment|ServiceStudio|o11'){continue}
  $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($file.FullName)
  if($info.ProductVersion -match '^\d+\.\d+\.\d+(\.\d+)?'){
   $full=$Matches[0];$v=($full -split '\.')[0..2] -join '.'
   if(-not @($result | Where-Object { $_.lane -eq 'o11' -and $_.version -eq $v }).Count){$result+=@{lane='o11';version=$v;fullVersion=$full;installer=$file.FullName;requiresInstallation=$true;tfm=$null}}
  }
 }
}
ConvertTo-Json -InputObject @($result) -Compress
