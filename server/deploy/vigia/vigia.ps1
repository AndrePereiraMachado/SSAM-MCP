param([Parameter(Mandatory)][string]$Config,[switch]$DryRun)
$ErrorActionPreference='Stop'
$node=if($env:SSAM_NODE){$env:SSAM_NODE}else{Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'}
$argsList=@((Join-Path $PSScriptRoot 'vigia.mjs'),'--config',$Config)
if($DryRun){$argsList+='--dry-run'}
& $node @argsList
exit $LASTEXITCODE
