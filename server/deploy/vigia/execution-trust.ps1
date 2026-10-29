param([string]$Workspace,[string[]]$PrivatePaths,[string[]]$Executables)
$ErrorActionPreference='Stop'
$script:AccountSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:SystemSids=@('S-1-5-18','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$script:TrustedSids=$script:SystemSids+@('S-1-5-32-544')
# CREATOR OWNER and CREATOR GROUP only reach accounts that can already create children.
$script:CreatorSids=@('S-1-3-0','S-1-3-1')
$script:FsRights=[Security.AccessControl.FileSystemRights]
# Rights that let another account replace a trusted child: delete it, rename the ancestor itself, or rewrite its ACL or owner.
# 0x10000000 is GENERIC_ALL as stored in an ACE; 0x40000000 is GENERIC_WRITE.
$script:ReplaceRights=[int]($script:FsRights::Delete -bor $script:FsRights::DeleteSubdirectoriesAndFiles -bor $script:FsRights::ChangePermissions -bor $script:FsRights::TakeOwnership) -bor 0x10000000
$script:WriteRights=$script:ReplaceRights -bor [int]$script:FsRights::Write -bor 0x40000000
# The real type of a file system item decides how to climb: .Directory/.Parent objects carry no PSIsContainer.
function Get-ParentDirectory($Item) {
    if($Item -is [IO.FileInfo]){return $Item.Directory}
    if($Item -is [IO.DirectoryInfo]){return $Item.Parent}
    throw 'Unsupported file system item.'
}
# Full rule (the trusted item and its tree): no write by another account, including through an ACE that descendants created
# later would inherit. -Ancestor: only an untrusted owner or a right that can replace the child; an inherit-only ACE of the
# ancestor does not apply to it, and each descendant carries its own inherited copy, checked on its own level.
function Assert-AclItem($Item,[string[]]$Owners,[string[]]$Writers,[switch]$Ancestor) {
    if($Item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Trusted paths cannot contain reparse points.'}
    $acl=Get-Acl -LiteralPath $Item.FullName
    if($Owners -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value){throw 'Path belongs to another account.'}
    $mask=if($Ancestor){$script:ReplaceRights}else{$script:WriteRights}
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        $who=$rule.IdentityReference.Value
        if($rule.AccessControlType -ne 'Allow' -or $Writers -contains $who){continue}
        if(([int]$rule.PropagationFlags -band [int][Security.AccessControl.PropagationFlags]::InheritOnly) -and ($Ancestor -or $Item -is [IO.FileInfo] -or $script:CreatorSids -contains $who)){continue}
        if([int]$rule.FileSystemRights -band $mask){throw 'Another account can modify a trusted path.'}
    }
}
function Assert-Tree($Root,[string[]]$Owners,[string[]]$Writers) {
    $pending=New-Object 'Collections.Generic.Stack[string]';$pending.Push($Root)
    while($pending.Count){foreach($child in Get-ChildItem -LiteralPath $pending.Pop() -Force){
        Assert-AclItem $child $Owners $Writers
        if($child -is [IO.DirectoryInfo]){$pending.Push($child.FullName)}
    }}
}
function Assert-OwnedPath([string]$Path,[switch]$Recurse) {
    $item=Get-Item -LiteralPath ([IO.Path]::GetFullPath($Path)) -Force
    Assert-AclItem $item @($script:AccountSid) @($script:AccountSid)
    if($Recurse -and $item -is [IO.DirectoryInfo]){Assert-Tree $item.FullName @($script:AccountSid) @($script:AccountSid)}
    for($parent=Get-ParentDirectory $item;$null -ne $parent;$parent=Get-ParentDirectory $parent){
        Assert-AclItem $parent ($script:SystemSids+@($script:AccountSid)) ($script:TrustedSids+@($script:AccountSid)) -Ancestor
    }
}
function Assert-Executable([string]$Path) {
    if(-not $Path -or -not [IO.Path]::IsPathRooted($Path)){throw 'An absolute executable path is required.'}
    $full=[IO.Path]::GetFullPath($Path);$item=Get-Item -LiteralPath $full -Force
    if($item -isnot [IO.FileInfo]){throw 'Executable path must name a file.'}
    # The executable and its own folder (searched first for DLLs) keep the full rule; the folders above, the ancestor rule.
    if($full -match '^C:\\ssam-priv\\'){Assert-OwnedPath $item.DirectoryName;Assert-OwnedPath $full;return}
    $locations=@([Environment]::GetFolderPath('ProgramFiles'),${env:ProgramFiles(x86)},(Join-Path $env:SystemRoot 'System32')) | Where-Object {$_}
    if(-not @($locations | Where-Object {$full.StartsWith($_.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'Executable must be system-owned or private to the execution account.'}
    Assert-AclItem $item $script:TrustedSids $script:TrustedSids
    Assert-AclItem $item.Directory $script:TrustedSids $script:TrustedSids
    for($parent=Get-ParentDirectory $item.Directory;$null -ne $parent;$parent=Get-ParentDirectory $parent){
        Assert-AclItem $parent $script:TrustedSids $script:TrustedSids -Ancestor
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
