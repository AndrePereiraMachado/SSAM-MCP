param(
 [Parameter(Mandatory)][string]$Config,
 [switch]$DryRun,
 [string]$Approve,
 [string]$Reject,
 [string]$Reason,
 [string]$Retry,
 [string]$AcknowledgeRollback,
 [switch]$NoUpdate
)
# Entry point of the Studio versions watcher (README.md). The scheduled task runs it with -Config only.
$ErrorActionPreference='Stop'
# node: SSAM_NODE, else "node" in the configuration, else the Codex runtime of this user, else node on PATH.
$configuration=Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$automatic=$configuration.automatic -ne $false -and -not $DryRun
if($automatic){
 . "$PSScriptRoot\execution-trust.ps1" -PrivatePaths $Config
 foreach($name in 'node','python','dotnet','git','bash','powershell','tar','docker','sshKeygen'){Assert-Executable $configuration.$name}
 Assert-Executable $configuration.automaticDeployment.ssh.executable
 $node=$configuration.node
}else{$node=$env:SSAM_NODE}
if(-not $node){try{$node=(Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json).node}catch{$node=$null}}
if(-not $automatic -and -not $node){$candidate=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe';if(Test-Path -LiteralPath $candidate){$node=$candidate}}
if(-not $automatic -and -not $node){$found=Get-Command node -ErrorAction SilentlyContinue;if($found){$node=$found.Source}}
if(-not $node -or -not (Test-Path -LiteralPath $node)){throw 'node.exe not found: set "node" in the watcher configuration or SSAM_NODE.'}
$argsList=@((Join-Path $PSScriptRoot 'vigia.mjs'),'--config',$Config)
if($DryRun){$argsList+='--dry-run'}
if($Approve){$argsList+=@('--approve',$Approve)}
if($Reject){$argsList+=@('--reject',$Reject);if($Reason){$argsList+=@('--reason',$Reason)}}
if($AcknowledgeRollback){$argsList+=@('--acknowledge-rollback',$AcknowledgeRollback)}
if($Retry){$argsList+=@('--retry',$Retry)}
if($NoUpdate){$argsList+='--no-update'}
& $node @argsList
exit $LASTEXITCODE
