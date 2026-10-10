param([Parameter(Mandatory=$true)][ValidateSet('prompt','read','forget','seal-session')][string]$Mode)

# Application credentials are unrelated to Studio/debugger credentials.
# The parent launches this helper hidden, with redirected stdin/stdout. Only the
# credential dialog is visible. Never invoke read from a model-facing tool.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$phase = 'input'
$clearBytes = $null
$clear = $null
$password = $null
$secret = $null
$form = $null
$passwordBox = $null
$usernameBox = $null
$vaultFile = $null
$createdFile = $false
$completed = $false
$temporaryFile = $null
$createdTemporaryFile = $false

function Fail([string]$Code) { throw [InvalidOperationException]::new($Code) }

function Get-RequiredProperty($Object, [string]$Name) {
  if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) { Fail 'invalid_input' }
  return $Object.$Name
}

function ConvertTo-CredentialReference($Value) {
  $reference = [string]$Value
  if ($reference -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') { Fail 'invalid_reference' }
  return $reference
}

function ConvertTo-Binding($Value) {
  $lane = [string](Get-RequiredProperty $Value 'lane')
  if ($lane -cnotin @('odc','o11')) { Fail 'invalid_binding' }
  $app = [string](Get-RequiredProperty $Value 'app')
  if ($app -cnotmatch '^[A-Za-z_][A-Za-z0-9_]{0,198}$') { Fail 'invalid_binding' }
  $sessionId = [string](Get-RequiredProperty $Value 'sessionId')
  if ($sessionId -cnotmatch '^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$') { Fail 'invalid_binding' }
  $sessionId = $sessionId.Replace('-','')
  $rawUrl = [string](Get-RequiredProperty $Value 'runtimeUrl')
  $runtime = $null
  if ($rawUrl.Length -gt 2048 -or -not [Uri]::TryCreate($rawUrl,[UriKind]::Absolute,[ref]$runtime)) { Fail 'invalid_binding' }
  if ($runtime.Scheme -cne 'https' -or $runtime.UserInfo.Length -gt 0 -or $runtime.Query.Length -gt 0 -or $runtime.Fragment.Length -gt 0) { Fail 'invalid_binding' }
  $appPath = '/' + $app
  if ($runtime.Host.Length -eq 0 -or ($runtime.AbsolutePath -cne $appPath -and $runtime.AbsolutePath -cne ($appPath + '/'))) { Fail 'invalid_binding' }
  $canonicalUrl = $runtime.GetLeftPart([UriPartial]::Authority).ToLowerInvariant() + $runtime.AbsolutePath.TrimEnd('/') + '/'
  $module = [string](Get-RequiredProperty $Value 'module')
  $moduleKey = [string](Get-RequiredProperty $Value 'moduleKey')
  if ($module -cnotmatch '^[A-Za-z_][A-Za-z0-9_]{0,198}$' -or $moduleKey -cnotmatch '^[A-Za-z0-9_+]{22}$') { Fail 'invalid_binding' }
  return [ordered]@{lane=$lane;runtimeUrl=$canonicalUrl;app=$app;sessionId=$sessionId;module=$module;moduleKey=$moduleKey}
}

function Assert-Binding($Stored, $Expected) {
  $canonical = ConvertTo-Binding $Stored
  foreach ($name in @('lane','runtimeUrl','app','sessionId','module','moduleKey')) {
    if ($canonical[$name] -cne $Expected[$name]) { Fail 'binding_mismatch' }
  }
}

function Assert-NoReparse([string]$Path) {
  if ([IO.File]::Exists($Path) -or [IO.Directory]::Exists($Path)) {
    if (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'private_storage_unavailable' }
  }
}

function Set-PrivateDirectory([string]$Path, $Sid) {
  Assert-NoReparse $Path
  if (-not [IO.Directory]::Exists($Path)) { $null = [IO.Directory]::CreateDirectory($Path) }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($Sid)
  $acl.SetAccessRuleProtection($true,$false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($Sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
  [IO.Directory]::SetAccessControl($Path,$acl)
}

function Assert-PrivateFile([string]$Path, $Sid) {
  Assert-NoReparse $Path
  if (-not [IO.File]::Exists($Path)) { Fail 'credentials_unavailable' }
  $acl = [IO.File]::GetAccessControl($Path)
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Sid.Value) { Fail 'private_storage_unavailable' }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -cne $Sid.Value) { Fail 'private_storage_unavailable' }
  }
  if ((New-Object IO.FileInfo($Path)).Length -gt 65536) { Fail 'credentials_unavailable' }
}

function Assert-PrivateDirectory([string]$Path, $Sid) {
  Assert-NoReparse $Path
  if (-not [IO.Directory]::Exists($Path)) { Fail 'credentials_unavailable' }
  $acl = [IO.Directory]::GetAccessControl($Path)
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Sid.Value) { Fail 'private_storage_unavailable' }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -cne $Sid.Value) { Fail 'private_storage_unavailable' }
  }
}

function Read-PrivateCiphertext([string]$Path) { return ,([IO.File]::ReadAllBytes($Path)) }
function Unprotect-AppUserRecord([byte[]]$Bytes, [byte[]]$Entropy) {
  return ,([Security.Cryptography.ProtectedData]::Unprotect($Bytes,$Entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser))
}

function Get-ScopedForgetCandidate([string]$Path, $Sid, [byte[]]$Entropy, $ExpectedBinding) {
  # ACL/reparse/owner validation precedes the corrupt-ciphertext exception. A
  # read failure is never mistaken for corrupt ciphertext and cannot authorize deletion.
  Assert-PrivateFile $Path $Sid
  $ciphertext = Read-PrivateCiphertext $Path
  $decrypted = $null
  try {
    try { $decrypted = Unprotect-AppUserRecord $ciphertext $Entropy }
    catch {
      # An interrupted write cannot prove its payload binding. The preallocated
      # exact reference and its private CurrentUser ACL authorize this cleanup.
      return @{path=$Path;corrupt=$true}
    }
    $record = [Text.Encoding]::UTF8.GetString($decrypted) | ConvertFrom-Json
    if ((Get-RequiredProperty $record 'version') -ne 1) { Fail 'credentials_unavailable' }
    Assert-Binding (Get-RequiredProperty $record 'binding') $ExpectedBinding
    return @{path=$Path;corrupt=$false}
  } finally {
    if ($null -ne $decrypted) { [Array]::Clear($decrypted,0,$decrypted.Length) }
    $record = $null
  }
}

try {
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  if (-not [Console]::IsInputRedirected -or -not [Console]::IsOutputRedirected) { Fail 'private_pipe_required' }
  $inputJson = [Console]::In.ReadToEnd()
  if ($inputJson.Length -eq 0 -or $inputJson.Length -gt 16384) { Fail 'invalid_input' }
  $request = $inputJson | ConvertFrom-Json
  $inputJson = $null
  $binding = ConvertTo-Binding (Get-RequiredProperty $request 'binding')
  # The controller allocates this opaque reference before opening the dialog, so
  # an interrupted/uncertain prompt can still be cleaned up by exact scope.
  $credentialRef = ConvertTo-CredentialReference (Get-RequiredProperty $request 'credentialRef')

  $phase = 'storage'
  Add-Type -AssemblyName System.Security
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $localData = [IO.Path]::GetFullPath([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData))
  if ([string]::IsNullOrWhiteSpace($localData)) { Fail 'private_storage_unavailable' }
  $ssamDirectory = Join-Path $localData 'SSAM'
  $vaultRoot = [IO.Path]::GetFullPath((Join-Path $ssamDirectory 'DebugAppUser'))
  Assert-NoReparse $localData
  Assert-NoReparse $ssamDirectory
  Assert-NoReparse $vaultRoot

  if ($Mode -eq 'prompt') {
    $ttl = 600
    if ($null -ne $request.PSObject.Properties['ttlSeconds']) {
      $ttlInput = $request.ttlSeconds
      if ($ttlInput -isnot [int] -and $ttlInput -isnot [long]) { Fail 'invalid_ttl' }
      if ($ttlInput -lt 30 -or $ttlInput -gt 3600) { Fail 'invalid_ttl' }
      $ttl = [int]$ttlInput
    }
    $phase = 'dialog'
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [Windows.Forms.Application]::EnableVisualStyles()
    $form = New-Object Windows.Forms.Form
    $form.Text = 'SSAM Debug ' + [char]0x2014 + ' ' + $binding.lane.ToUpperInvariant() + ' ' + [char]0x2014 + ' ' + $binding.app + ' ' + [char]0x2014 + ' App User Sign In'
    $form.ClientSize = New-Object Drawing.Size(560,344)
    $form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.ShowInTaskbar = $true
    $form.TopMost = $true
    $form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
    $form.Font = New-Object Drawing.Font('Segoe UI',9)

    $intro = New-Object Windows.Forms.Label
    $intro.Location = New-Object Drawing.Point(24,18)
    $intro.Size = New-Object Drawing.Size(512,40)
    $intro.Text = 'Enter the application user for this debug session. These credentials will be used to sign in and validate login and roles.'
    $form.Controls.Add($intro)
    $contextLabel = New-Object Windows.Forms.Label
    $contextLabel.Location = New-Object Drawing.Point(24,65)
    $contextLabel.Size = New-Object Drawing.Size(512,62)
    $contextLabel.Text = 'Platform: ' + $binding.lane.ToUpperInvariant() + "`r`nApplication: " + $binding.app + "`r`nEnvironment: " + $binding.runtimeUrl
    $contextLabel.AutoEllipsis = $true
    $form.Controls.Add($contextLabel)

    $usernameLabel = New-Object Windows.Forms.Label
    $usernameLabel.Location = New-Object Drawing.Point(24,139)
    $usernameLabel.Size = New-Object Drawing.Size(100,24)
    $usernameLabel.Text = 'Username'
    $form.Controls.Add($usernameLabel)
    $usernameBox = New-Object Windows.Forms.TextBox
    $usernameBox.Location = New-Object Drawing.Point(130,135)
    $usernameBox.Size = New-Object Drawing.Size(406,28)
    $usernameBox.MaxLength = 512
    $usernameBox.TabIndex = 0
    $form.Controls.Add($usernameBox)
    $passwordLabel = New-Object Windows.Forms.Label
    $passwordLabel.Location = New-Object Drawing.Point(24,178)
    $passwordLabel.Size = New-Object Drawing.Size(100,24)
    $passwordLabel.Text = 'Password'
    $form.Controls.Add($passwordLabel)
    $passwordBox = New-Object Windows.Forms.TextBox
    $passwordBox.Location = New-Object Drawing.Point(130,174)
    $passwordBox.Size = New-Object Drawing.Size(406,28)
    $passwordBox.UseSystemPasswordChar = $true
    $passwordBox.MaxLength = 4096
    $passwordBox.TabIndex = 1
    $form.Controls.Add($passwordBox)

    $hint = New-Object Windows.Forms.Label
    $hint.Location = New-Object Drawing.Point(24,216)
    $hint.Size = New-Object Drawing.Size(512,40)
    $hint.Text = 'Credentials are encrypted for your Windows account and expire with this debug session. Never enter them in chat.'
    $form.Controls.Add($hint)
    $validationLabel = New-Object Windows.Forms.Label
    $validationLabel.Location = New-Object Drawing.Point(24,263)
    $validationLabel.Size = New-Object Drawing.Size(512,24)
    $validationLabel.ForeColor = [Drawing.Color]::DarkRed
    $form.Controls.Add($validationLabel)
    $signIn = New-Object Windows.Forms.Button
    $signIn.Text = 'Sign In'
    $signIn.Location = New-Object Drawing.Point(332,298)
    $signIn.Size = New-Object Drawing.Size(98,30)
    $signIn.TabIndex = 2
    $signIn.Add_Click({
      if ([string]::IsNullOrWhiteSpace($usernameBox.Text) -or $passwordBox.Text.Length -eq 0) {
        $validationLabel.Text = 'Enter your username and password.'
        return
      }
      $form.DialogResult = [Windows.Forms.DialogResult]::OK
    })
    $form.Controls.Add($signIn)
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.Location = New-Object Drawing.Point(438,298)
    $cancel.Size = New-Object Drawing.Size(98,30)
    $cancel.TabIndex = 3
    $cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
    $form.Controls.Add($cancel)
    $form.AcceptButton = $signIn
    $form.CancelButton = $cancel
    $form.Add_Shown({ $form.Activate(); $form.BringToFront(); $usernameBox.Focus() | Out-Null })
    $dialogResult = $form.ShowDialog()
    if ($dialogResult -ne [Windows.Forms.DialogResult]::OK) {
      [Console]::Out.Write('{"ok":false,"cancelled":true}')
      $completed = $true
    } else {
      $phase = 'encrypt'
      $vaultFile = Join-Path $vaultRoot ($credentialRef + '.dpapi')
      $now = [DateTimeOffset]::UtcNow
      $expiresAt = $now.AddSeconds($ttl).ToString('o')
      $secret = [ordered]@{version=1;kind='credentials';binding=$binding;createdAt=$now.ToString('o');expiresAt=$expiresAt;username=$usernameBox.Text;password=$passwordBox.Text}
      $clear = $secret | ConvertTo-Json -Depth 8 -Compress
      $clearBytes = [Text.Encoding]::UTF8.GetBytes($clear)
      $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
      $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      $usernameBox.Clear()
      $passwordBox.Clear()
      $form.Dispose()
      $form = $null
      $phase = 'storage'
      Set-PrivateDirectory $vaultRoot $currentSid
      $stream = [IO.File]::Open($vaultFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      $createdFile = $true
      try { $stream.Write($encrypted,0,$encrypted.Length) } finally { $stream.Dispose() }
      Assert-PrivateFile $vaultFile $currentSid
      # No username, password or private storage path belongs in public output.
      [Console]::Out.Write(([ordered]@{ok=$true;credentialRef=$credentialRef;expiresAt=$expiresAt;binding=$binding} | ConvertTo-Json -Depth 8 -Compress))
      $completed = $true
    }
  } else {
    $vaultFile = Join-Path $vaultRoot ($credentialRef + '.dpapi')
    if ($Mode -eq 'forget') {
      $phase = 'cleanup'
      $pendingFile = Join-Path $vaultRoot ($credentialRef + '.tmp')
      $forgetPaths = @($vaultFile,$pendingFile) | Where-Object { [IO.File]::Exists($_) }
      $candidates = @()
      if (@($forgetPaths).Count -gt 0) {
        Assert-PrivateDirectory $vaultRoot $currentSid
        $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
        foreach ($pendingPath in $forgetPaths) {
          $candidates += Get-ScopedForgetCandidate $pendingPath $currentSid $entropy $binding
        }
        # Validate every existing record before deleting either exact file. A
        # complete record belonging to another binding prevents all cleanup.
        foreach ($candidate in $candidates) { [IO.File]::Delete($candidate.path) }
      }
      [Console]::Out.Write((@{ok=$true;forgotten=(@($candidates).Count -gt 0)} | ConvertTo-Json -Compress))
      $completed = $true
    } else {
      Assert-PrivateDirectory $vaultRoot $currentSid
      Assert-PrivateFile $vaultFile $currentSid
      $phase = 'decrypt'
      $entropy = [Text.Encoding]::UTF8.GetBytes('SSAM.DebugAppUser.v1|' + $credentialRef)
      $clearBytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($vaultFile),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      $clear = [Text.Encoding]::UTF8.GetString($clearBytes)
      $secret = $clear | ConvertFrom-Json
      if ((Get-RequiredProperty $secret 'version') -ne 1) { Fail 'credentials_unavailable' }
      $phase = 'binding'
      Assert-Binding (Get-RequiredProperty $secret 'binding') $binding
      $createdAt = [DateTimeOffset]::Parse([string](Get-RequiredProperty $secret 'createdAt'))
      $expiresAt = [DateTimeOffset]::Parse([string](Get-RequiredProperty $secret 'expiresAt'))
      $duration = ($expiresAt - $createdAt).TotalSeconds
      if ($duration -lt 30 -or $duration -gt 3600 -or $createdAt -gt [DateTimeOffset]::UtcNow.AddSeconds(30)) { Fail 'credentials_unavailable' }
        $phase = 'expiration'
        if ($expiresAt -le [DateTimeOffset]::UtcNow) { Fail 'credentials_expired' }
        if ($Mode -eq 'seal-session') {
          $phase = 'encrypt'
          $authenticatedSession = Get-RequiredProperty $request 'session'
          if ($null -eq $authenticatedSession -or $authenticatedSession -isnot [PSCustomObject]) { Fail 'invalid_session' }
          # Replace the credential payload entirely after native authentication;
          # no username/password are retained in the authenticated session record.
          $sealed = [ordered]@{version=1;kind='session';binding=$binding;createdAt=$createdAt.ToString('o');expiresAt=$expiresAt.ToString('o');session=$authenticatedSession}
          if ($null -ne $clearBytes) { [Array]::Clear($clearBytes,0,$clearBytes.Length) }
          $clear = $sealed | ConvertTo-Json -Depth 32 -Compress
          $clearBytes = [Text.Encoding]::UTF8.GetBytes($clear)
          if ($clearBytes.Length -gt 61440) { Fail 'invalid_session' }
          $encrypted = [Security.Cryptography.ProtectedData]::Protect($clearBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
          $phase = 'storage'
          $temporaryFile = Join-Path $vaultRoot ($credentialRef + '.tmp')
          $stream = [IO.File]::Open($temporaryFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
          $createdTemporaryFile = $true
          try { $stream.Write($encrypted,0,$encrypted.Length) } finally { $stream.Dispose() }
          Assert-PrivateFile $temporaryFile $currentSid
          # File.Replace avoids a period where the reference is missing or partial.
          [IO.File]::Replace($temporaryFile,$vaultFile,[NullString]::Value)
          $temporaryFile = $null
          [Console]::Out.Write(([ordered]@{ok=$true;credentialRef=$credentialRef;kind='session';expiresAt=$expiresAt.ToString('o');binding=$binding} | ConvertTo-Json -Depth 8 -Compress))
        } else {
          $kind = [string](Get-RequiredProperty $secret 'kind')
          if ($kind -eq 'credentials') {
            $username = [string](Get-RequiredProperty $secret 'username')
            $password = [string](Get-RequiredProperty $secret 'password')
            if ([string]::IsNullOrWhiteSpace($username) -or $username.Length -gt 512 -or $password.Length -eq 0 -or $password.Length -gt 4096) { Fail 'credentials_unavailable' }
            $privateOutput = [ordered]@{ok=$true;kind='credentials';username=$username;password=$password;expiresAt=$expiresAt.ToString('o');binding=$binding}
          } elseif ($kind -eq 'session') {
            $privateOutput = [ordered]@{ok=$true;kind='session';session=(Get-RequiredProperty $secret 'session');expiresAt=$expiresAt.ToString('o');binding=$binding}
          } else { Fail 'credentials_unavailable' }
          # Private worker pipe only. Caller must never log or forward this output.
          [Console]::Out.Write(($privateOutput | ConvertTo-Json -Depth 32 -Compress))
        }
      $completed = $true
    }
  }
} catch {
  # Exception text can include data supplied by the user. Emit only fixed text.
  [Console]::Out.Write(([ordered]@{ok=$false;error='debug_app_user_credentials_unavailable';phase=$phase;message='The application sign-in could not be completed. No credential value was logged.'} | ConvertTo-Json -Compress))
} finally {
  if ($null -ne $passwordBox -and -not $passwordBox.IsDisposed) { $passwordBox.Clear() }
  if ($null -ne $usernameBox -and -not $usernameBox.IsDisposed) { $usernameBox.Clear() }
  if ($null -ne $form) { $form.Dispose() }
  if ($null -ne $clearBytes) { [Array]::Clear($clearBytes,0,$clearBytes.Length) }
  if ($createdFile -and -not $completed -and $null -ne $vaultFile) {
    try { [IO.File]::Delete($vaultFile) } catch { }
  }
  if ($createdTemporaryFile -and $null -ne $temporaryFile) { try { [IO.File]::Delete($temporaryFile) } catch { } }
  $clear = $null
  $username = $null
  $password = $null
  $secret = $null
  $request = $null
  $privateOutput = $null
  $sealed = $null
  $authenticatedSession = $null
}
if (-not $completed) { exit 1 }
