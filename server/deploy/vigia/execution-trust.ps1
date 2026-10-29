param([string]$Workspace,[string[]]$PrivatePaths,[string[]]$Executables)
$ErrorActionPreference='Stop'
$script:AccountSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:SystemSids=@('S-1-5-18','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$script:TrustedSids=$script:SystemSids+@('S-1-5-32-544')
function Assert-AclItem($Item,[string[]]$Owners,[string[]]$Writers) {
    if($Item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Trusted paths cannot contain reparse points.'}
    $acl=Get-Acl -LiteralPath $Item.FullName
    if($Owners -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value){throw 'Path belongs to another account.'}
    $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and $Writers -notcontains $rule.IdentityReference.Value){throw 'Another account can modify a trusted path.'}
    }
}
function Assert-Tree($Root,[string[]]$Owners,[string[]]$Writers) {
    $pending=New-Object 'Collections.Generic.Stack[string]';$pending.Push($Root)
    while($pending.Count){foreach($child in Get-ChildItem -LiteralPath $pending.Pop() -Force){
        Assert-AclItem $child $Owners $Writers
        if($child.PSIsContainer){$pending.Push($child.FullName)}
    }}
}
function Assert-OwnedPath([string]$Path,[switch]$Recurse) {
    $item=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force
    Assert-AclItem $item @($script:AccountSid) @($script:AccountSid)
    if($Recurse -and $item.PSIsContainer){Assert-Tree $item.FullName @($script:AccountSid) @($script:AccountSid)}
    $parent=if($item.PSIsContainer){$item.Parent}else{$item.Directory}
    while($null -ne $parent){
        Assert-AclItem $parent ($script:SystemSids+@($script:AccountSid)) ($script:TrustedSids+@($script:AccountSid))
        $parent=$parent.Parent
    }
}
function Assert-Executable([string]$Path) {
    if(-not $Path -or -not [IO.Path]::IsPathRooted($Path)){throw 'An absolute executable path is required.'}
    $full=[IO.Path]::GetFullPath($Path);$item=Get-Item -LiteralPath $full -Force
    if($item.PSIsContainer){throw 'Executable path must name a file.'}
    if($full -match '^C:\\ssam-priv\\'){Assert-OwnedPath $full;return}
    $locations=@([Environment]::GetFolderPath('ProgramFiles'),${env:ProgramFiles(x86)},(Join-Path $env:SystemRoot 'System32')) | Where-Object {$_}
    if(-not @($locations | Where-Object {$full.StartsWith($_.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'Executable must be system-owned or private to the execution account.'}
    while($null -ne $item){
        Assert-AclItem $item $script:TrustedSids $script:TrustedSids
        $item=if($item.PSIsContainer){$item.Parent}else{$item.Directory}
    }
}
function Assert-ExecutionClone([string]$Root) {
    if(-not (Test-Path -LiteralPath (Join-Path $Root '.git') -PathType Container)){throw 'A dedicated owned clone is required; worktrees are refused.'}
    Assert-OwnedPath $Root -Recurse
    foreach($name in 'commondir','objects/info/alternates'){if(Test-Path -LiteralPath (Join-Path $Root ".git/$name")){throw 'Shared Git storage is refused.'}}
}
if($Workspace){Assert-ExecutionClone $Workspace}
foreach($target in $PrivatePaths){
    if([IO.Path]::GetFullPath($target) -notmatch '^C:\\ssam-priv\\'){throw 'Automatic state must be inside C:\ssam-priv.'}
    Assert-OwnedPath $target -Recurse
}
foreach($executable in $Executables){Assert-Executable $executable}
