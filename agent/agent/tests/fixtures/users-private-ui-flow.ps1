param([string]$Library,[string]$Case='temporary',[string]$Render='')
$ErrorActionPreference='Stop'
. (Join-Path $Library 'private-dialog.ps1')
Add-Type -TypeDefinition @"
public static class UsersVault {
 public struct Credential {public int Type;public string TargetName;public string UserName;public System.IntPtr CredentialBlob;public int CredentialBlobSize;public int Persist;}
 public static int Writes=0; public static bool Write(ref Credential c,int flags){Writes++;return true;}
 public static bool IsWindowVisible(System.IntPtr h){return true;} public static bool ShowWindow(System.IntPtr h,int c){return true;} public static bool SetForegroundWindow(System.IntPtr h){return true;}
}
"@
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Library 'users-vault.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Parse failed'}
foreach($fn in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){. ([scriptblock]::Create($fn.Extent.Text))}
function Prefix{return 'SSAM/Fixture'}
function ReadVault{throw 'Prompt must not read saved secrets'}
$script:OriginalDialog=(Get-Command New-SsamDialog).ScriptBlock
function All-Controls($p){foreach($c in $p.Controls){$c;All-Controls $c}}
function New-SsamDialog([string]$title,[string]$description,[string]$service,[string]$hostName,[int]$width=440){
 $f=& $script:OriginalDialog $title $description $service $hostName $width;$f.Opacity=0;$f.ShowInTaskbar=$false
 $f.Add_Shown({
  try{
   $controls=@(All-Controls $this);$fields=@($controls|Where-Object{$_ -is [Windows.Forms.TextBox]});$remember=@($controls|Where-Object{$_ -is [SsamRememberBox]})
   $defaultUnchecked=($remember.Count -eq 1 -and -not $remember[0].Checked)
   if($Case -in @('temporary','persistent')){$fields[0].Text='fixture@example.test';$fields[1].Text='Fixture-private-password';$remember[0].Checked=($Case -eq 'persistent');($controls|Where-Object{$_.Text -eq 'Sign in'}).PerformClick()}
   if($Case -eq 'error'){($controls|Where-Object{$_.Text -eq 'Sign in'}).PerformClick()}
   if($Render){$b=New-Object Drawing.Bitmap($this.Width,$this.Height);$this.DrawToBitmap($b,(New-Object Drawing.Rectangle(0,0,$this.Width,$this.Height)));$b.Save($Render);$b.Dispose()}
   [Console]::WriteLine((@{fieldCount=$fields.Count;defaultUnchecked=$defaultUnchecked;vaultWrites=[UsersVault]::Writes;masked=$fields[1].UseSystemPasswordChar}|ConvertTo-Json -Compress))
  }finally{$this.Close()}
 });return $f
}
$Mode='prompt';$Kind='login';$HostName='tenant.example.test';$Rows='';$PromptStatusPath=''
$main=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.TryStatementAst]})[-1].Extent.Text
$main=$main.Replace("  . `$dialogHelper",'').Replace("if(-not (Test-Path -LiteralPath `$dialogHelper -PathType Leaf))","if(`$false)")
$main=$main.Replace('$dialogHelper=Join-Path $PSScriptRoot', '$dialogHelper=Join-Path $Library')
& ([scriptblock]::Create($main))