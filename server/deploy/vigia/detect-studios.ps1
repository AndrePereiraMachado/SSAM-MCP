param([string]$Odc,[string]$O11,[string]$Installers)
$ErrorActionPreference='Stop'
$result=@()
foreach($item in @(@{lane='odc';root=$Odc},@{lane='o11';root=$O11})){
 if(-not $item.root){continue}
 $dll=Join-Path $item.root 'ServiceStudio.Framework.dll'
 if(-not (Test-Path -LiteralPath $dll)){continue}
 $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($dll)
 $full=if($info.ProductVersion -match '^\d+\.\d+\.\d+(\.\d+)?'){$Matches[0]}elseif($info.FileVersion -match '^\d+\.\d+\.\d+(\.\d+)?'){$Matches[0]}else{$null}
 if($full){$result+=@{lane=$item.lane;studio=$item.root;fullVersion=$full;version=($full -split '\.')[0..2] -join '.'}}
}
if($Installers -and (Test-Path -LiteralPath $Installers)){
 foreach($file in Get-ChildItem -LiteralPath $Installers -File -Filter '*.exe'){
  if($file.Name -notmatch 'DevelopmentEnvironment|ServiceStudio|o11'){continue}
  $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($file.FullName)
  if($info.ProductVersion -match '^\d+\.\d+\.\d+(\.\d+)?'){
   $full=$Matches[0];$v=($full -split '\.')[0..2] -join '.'
   if(-not @($result | Where-Object { $_.lane -eq 'o11' -and $_.version -eq $v }).Count){$result+=@{lane='o11';version=$v;fullVersion=$full;installer=$file.FullName;requiresInstallation=$true}}
  }
 }
}
ConvertTo-Json -InputObject @($result) -Compress
