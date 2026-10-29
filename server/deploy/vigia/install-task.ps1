# Run this reviewed script from an unpackaged PowerShell as the dedicated account.
param(
    [Parameter(Mandatory)][string]$Config,
    [Parameter(Mandatory)][string]$Workspace,
    [ValidateRange(1,24)][int]$Hours=2,
    [string]$TaskName='SSAM Studio watcher',
    [ValidateSet('Password')][string]$LogonType='Password',
    [switch]$Show,
    [switch]$Uninstall
)
$ErrorActionPreference='Stop'
if($Uninstall){Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false;return}
if(-not (Test-Path -LiteralPath (Join-Path $Workspace '.git') -PathType Container)){throw 'A dedicated clone is required.'}
. "$PSScriptRoot\execution-trust.ps1" -Workspace $Workspace -PrivatePaths $Config
. "$PSScriptRoot\vault.ps1"
Assert-VigiaNormalProfile
$configuration=Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if([IO.Path]::GetFullPath($configuration.workspace) -ne [IO.Path]::GetFullPath($Workspace)){throw 'Configuration workspace differs.'}
$exeNames=@('node','python','dotnet','git','bash','powershell','tar','docker','sshKeygen')
foreach($name in $exeNames){Assert-Executable $configuration.$name}
Assert-Executable $configuration.automaticDeployment.ssh.executable
$safe=@('-c','core.hooksPath=','-c','core.fsmonitor=false','-c','core.pager=cat','-c','diff.external=','-c','core.attributesFile=NUL','-c','credential.helper=','-c','protocol.ext.allow=never','-c','protocol.file.allow=never')
Get-ChildItem Env:GIT_* | Remove-Item
$env:GIT_CONFIG_NOSYSTEM='1';$env:GIT_CONFIG_GLOBAL='NUL'
$git=$configuration.git
$branch=(& $git @safe -C $Workspace branch --show-current).Trim()
if($LASTEXITCODE -ne 0 -or $branch -ne 'server/vigia-run' -or (Split-Path $Workspace -Leaf) -ne 'vigia-run'){throw 'Only the reviewed execution clone can be scheduled.'}
# The runtime fetches and verifies the fixed remote before each round.
if((& $git @safe -C $Workspace rev-parse HEAD).Trim() -ne (& $git @safe -C $Workspace rev-parse main).Trim()){throw 'Execution HEAD must equal reviewed main before registration.'}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$action=New-ScheduledTaskAction -Execute $configuration.powershell -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $Workspace 'server\deploy\vigia\vigia.ps1')`" -Config `"$Config`"" -WorkingDirectory $Workspace
$every=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(10)) -RepetitionInterval (New-TimeSpan -Hours $Hours)
$logon=New-ScheduledTaskTrigger -AtLogOn -User $user;$logon.Delay='PT15M'
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 8)
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Password -RunLevel Limited
$task=New-ScheduledTask -Action $action -Trigger @($every,$logon) -Settings $settings -Principal $principal
if($Show){[pscustomobject]@{Task=$TaskName;User=$user;LogonType='Password';Hours=$Hours};return}
$credential=Get-Credential -UserName $user -Message 'Enter the dedicated account password for DPAPI-capable scheduled execution.'
if($null -eq $credential -or $credential.UserName -ne $user){throw 'Credentials must belong to the current dedicated account.'}
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
try{
    $password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -User $user -Password $password -Force | Out-Null
}finally{$password=$null;[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);$credential=$null}
Write-Output 'Dedicated password-logon task registered.'
