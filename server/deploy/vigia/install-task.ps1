<#
.SYNOPSIS
  Registers the Windows scheduled task that runs the Studio versions watcher every 2 hours (or removes it with -Uninstall).

.DESCRIPTION
  The task runs as the signed-in user, only while that user is logged on (no stored password), never two at a time
  (MultipleInstances IgnoreNew; the watcher also holds its own lock), catches up after sleep (StartWhenAvailable), and
  runs without a window (conhost --headless) and stays visible in the Task Scheduler library. It runs vigia.ps1 of the watcher worktree, which fast-forwards itself from the local
  main before each round. Nothing is installed by any other script.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\andre\SSAM-MCP-wt\vigia-run\server\deploy\vigia\install-task.ps1 -Show
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\andre\SSAM-MCP-wt\vigia-run\server\deploy\vigia\install-task.ps1
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\andre\SSAM-MCP-wt\vigia-run\server\deploy\vigia\install-task.ps1 -Uninstall
#>
param(
    [string]$Config = 'C:\t\vigia-auto\config.json',
    [string]$Workspace = 'C:\Users\andre\SSAM-MCP-wt\vigia-auto',
    [ValidateRange(1, 24)][int]$Hours = 2,
    [string]$TaskName = 'SSAM Studio watcher',
    [switch]$Uninstall,
    [switch]$Show
)
$ErrorActionPreference = 'Stop'
if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed the scheduled task '$TaskName'. The watcher's files in $(Split-Path -Parent $Config) stay."
    } else { Write-Host "No scheduled task '$TaskName' is installed." }
    return
}
$script = Join-Path $Workspace 'server\deploy\vigia\vigia.ps1'
if (-not (Test-Path -LiteralPath $script)) { throw "No watcher at $script." }
if (-not (Test-Path -LiteralPath $Config)) { throw "No watcher configuration at $Config." }
if (-not (Test-Path -LiteralPath (Join-Path $Workspace '.git') -PathType Leaf)) { throw "$Workspace is not a dedicated Git worktree." }
$configuration = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$configured = $configuration.workspace
if ([IO.Path]::GetFullPath($configured).TrimEnd('\') -ne [IO.Path]::GetFullPath($Workspace).TrimEnd('\')) { throw "The configuration's workspace ($configured) is not $Workspace." }
$git = 'C:\Program Files\Git\cmd\git.exe'
$branch = (& $git -C $Workspace branch --show-current).Trim()
if (-not $branch -or $branch -eq 'main' -or $branch -like 'vigia/*') { throw "The watcher worktree must be on its integration branch, not '$branch'." }
# The task runs the worktree's own watcher, which fast-forwards itself from then on; a watcher older than the self-updating
# one would not, so the worktree is brought to main here (fast-forward only) and must carry the round protocol.
$head = (& $git -C $Workspace rev-parse HEAD).Trim()
$source = if ($configuration.updateFrom) { $configuration.updateFrom } else { 'server/vigia-auto' }
$main = (& $git -C $Workspace rev-parse --verify "$source^{commit}").Trim()
if ($head -ne $main) {
    & $git -C $Workspace merge-base --is-ancestor HEAD $main
    if ($LASTEXITCODE -ne 0) { throw "$Workspace ($branch at $($head.Substring(0,7))) cannot fast-forward to $source ($($main.Substring(0,7)))." }
    if ($Show) { Write-Host "Would fast-forward $Workspace from $($head.Substring(0,7)) to $source $($main.Substring(0,7))." }
    else {
        if (& $git -C $Workspace status --porcelain) { throw "$Workspace has uncommitted changes." }
        & $git -C $Workspace merge --ff-only $main | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Fast-forward of $Workspace failed." }
        Write-Host "Fast-forwarded $Workspace to $source $($main.Substring(0,7))."
    }
}
$watcher = Join-Path $Workspace 'server\deploy\vigia\vigia.mjs'
if (-not $Show -and -not (Select-String -LiteralPath $watcher -SimpleMatch 'ROUND_PROTOCOL=2' -Quiet)) { throw "The watcher in $Workspace does not update itself yet: main must carry server/vigia-ops first." }

$user = "$env:USERDOMAIN\$env:USERNAME"
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "--headless `"$powershell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -Config `"$Config`""
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments -WorkingDirectory $Workspace
$every = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(10)) -RepetitionInterval (New-TimeSpan -Hours $Hours)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT15M'
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 8)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger @($every, $logon) -Settings $settings -Principal $principal `
    -Description "SSAM Studio versions watcher: every $Hours h and 15 min after logon, detects releases, builds signed bridges, publishes, deploys and rolls back on failure. Logs: $(Split-Path -Parent $Config)\runs. server/deploy/vigia/README.md"
if ($Show) {
    [pscustomobject]@{
        TaskName = $TaskName; User = $user; LogonType = $principal.LogonType; RunLevel = $principal.RunLevel
        Execute = $action.Execute; Arguments = $action.Arguments; WorkingDirectory = $action.WorkingDirectory
        Every = $every.Repetition.Interval; Duration = $(if ($every.Repetition.Duration) { $every.Repetition.Duration } else { 'indefinitely' }); FirstRun = $every.StartBoundary
        AtLogOn = "$($logon.UserId) after $($logon.Delay)"; MultipleInstances = $settings.MultipleInstances; StartWhenAvailable = $settings.StartWhenAvailable
        ExecutionTimeLimit = $settings.ExecutionTimeLimit; Hidden = $settings.Hidden; Branch = $branch
    } | Format-List
    Write-Host 'Nothing was registered (-Show).'
    return
}
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
$registered = Get-ScheduledTask -TaskName $TaskName
Write-Host "Registered '$TaskName' for $user (state $($registered.State)): every $Hours h from $($every.StartBoundary) and 15 min after logon. Remove it with -Uninstall."
