param([string]$Workspace,[string[]]$PrivatePaths)
$ErrorActionPreference='Stop'
function Assert-OwnedPath([string]$Path) {
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $full=[IO.Path]::GetFullPath($Path)
    if(-not (Test-Path -LiteralPath $full)){throw 'Private execution path does not exist.'}
    # Every ancestor under the volume must also prevent an untrusted rename.
    $item=Get-Item -LiteralPath $full -Force
    while($null -ne $item -and $item.FullName.Length -gt 3) {
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Execution paths cannot contain reparse points.'}
        $acl=Get-Acl -LiteralPath $item.FullName
        if($item.FullName -eq $full -and $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'Execution path belongs to a different account.'}
        foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
            if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and $rule.IdentityReference.Value -ne $sid){throw 'Another account can modify an execution path.'}
        }
        $item=if($item.PSIsContainer){$item.Parent}else{$item.Directory}
    }
}
function Assert-ExecutionClone([string]$Root) {
    if(-not (Test-Path -LiteralPath (Join-Path $Root '.git') -PathType Container)){throw 'A dedicated owned clone is required; worktrees are refused.'}
    Assert-OwnedPath $Root
    Assert-OwnedPath (Join-Path $Root '.git')
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $pending=New-Object 'Collections.Generic.Stack[string]'
    $pending.Push($Root)
    while($pending.Count) {
        foreach($child in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            if($child.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'The execution tree contains a reparse point.'}
            $acl=Get-Acl -LiteralPath $child.FullName
            if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'An execution tree entry belongs to another account.'}
            $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
            foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
                if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $write) -and $rule.IdentityReference.Value -ne $sid){throw 'Another account can modify the execution tree.'}
            }
            if($child.PSIsContainer){$pending.Push($child.FullName)}
        }
    }
    # Reject linked worktree metadata and object storage controlled elsewhere.
    foreach($name in 'commondir','objects/info/alternates') {if(Test-Path -LiteralPath (Join-Path $Root ".git/$name")){throw 'Shared Git storage is refused.'}}
}
if($Workspace){Assert-ExecutionClone $Workspace}
foreach($target in $PrivatePaths){
    if([IO.Path]::GetFullPath($target) -notmatch '^C:\\ssam-priv\\'){throw 'Automatic state must be inside C:\ssam-priv.'}
    Assert-OwnedPath $target
}
