import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../lib/', import.meta.url));
const ui = fs.readFileSync(path.join(root, 'private-dialog.ps1'), 'utf8');

test('Users private windows load the shared dialog before opening', () => {
  const helper = fs.readFileSync(path.join(root, 'users-vault.ps1'), 'utf8');
  assert.match(helper, /\$dialogHelper=Join-Path \$PSScriptRoot 'private-dialog\.ps1'/);
  assert.ok(helper.indexOf('. $dialogHelper') < helper.indexOf("if ($Mode -eq 'confirm')"));
});

test('private windows use the current Agent logo and shared palette', () => {
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(ui)?.[1];
  assert.ok(encoded);
  assert.deepEqual(Buffer.from(encoded, 'base64'), fs.readFileSync(new URL('../../build/icon.png', import.meta.url)));
  for (const color of ['#fafafa', '#202126', '#676b74', '#dedfe3', '#da2337']) assert.ok(ui.includes(color));
});

test('private dialog factories preserve masking, full text, decline default and consent timers', { skip: process.platform !== 'win32' }, () => {
  const ps = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
. '${path.join(root, 'private-dialog.ps1').replaceAll("'", "''")}'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${path.join(root, 'users-vault.ps1').replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Users helper does not parse'}
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConfirmForm'},$true)
. ([scriptblock]::Create($fn.Extent.Text))
$HostName='personal-example.outsystemscloud.com'
$long=('Long untrusted page value & name ' * 80)
$w=ConfirmForm @{rows=@(@{label='Username';value=$long;data=$true})}
$values=@($w.Form.Controls | Where-Object {$_ -is [Windows.Forms.TextBox]})
$warning=@($w.Form.Controls | Where-Object {$_.Text -eq 'Username (from the page, not verified)'})
$f=New-SsamDialog 'Sign in to ODC Portal' 'Continue with this account.' 'ODC Portal' $HostName
$plain=Add-SsamField $f 'Username' $f.Tag.ContentY
$secret=Add-SsamField $f 'Password' ($f.Tag.ContentY+84) -secret
$button=Add-SsamButton $f 'Sign in' 225 ($f.Tag.ContentY+180) 187 -primary
Complete-SsamDialog $f ($f.Tag.ContentY+224)
$result=@{defaultDeclines=($w.Form.AcceptButton -eq $w.No);cancelDeclines=($w.Form.CancelButton -eq $w.No);approvalDisabled=(-not $w.Yes.Enabled);armMs=$w.Arm.Interval;timeoutMs=$w.End.Interval;fullText=($values[0].Text -ceq $long);readOnly=$values[0].ReadOnly;warningVisible=($warning.Count -eq 1);scroll=$w.Form.AutoScroll;secretMasked=$secret.UseSystemPasswordChar;usernameUnmasked=(-not $plain.UseSystemPasswordChar);brand=(@($f.Controls | Where-Object {$_.Text -eq 'SSAM Agent'}).Count -eq 1);windowTitle=$f.Text;buttonHeight=$button.Height;imageWidth=$f.Tag.Logo.Width}
$w.Arm.Dispose();$w.End.Dispose();$w.Form.Dispose();$f.Dispose()
$result|ConvertTo-Json -Compress
`;
  const stdout = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const result = JSON.parse(stdout.trim());
  for (const key of ['defaultDeclines', 'cancelDeclines', 'approvalDisabled', 'fullText', 'readOnly', 'warningVisible', 'scroll', 'secretMasked', 'usernameUnmasked', 'brand']) assert.equal(result[key], true, key);
  assert.equal(result.armMs, 1500); assert.equal(result.timeoutMs, 120000);
  assert.equal(result.windowTitle, 'SSAM Agent'); assert.equal(result.buttonHeight, 44); assert.equal(result.imageWidth, 512);
});

test('a helper with hidden-console startup makes its own dialog visibly available before the handshake', { skip: process.platform !== 'win32' }, () => {
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. '${path.join(root, 'private-dialog.ps1')}'
$f=New-SsamDialog 'Window visibility check' 'This test closes automatically and has no credential fields.' 'SSAM Agent' ''
Complete-SsamDialog $f $f.Tag.ContentY
$f.Add_Shown({[Console]::WriteLine((@{visible=[SsamDialogNative]::IsWindowVisible($this.Handle)}|ConvertTo-Json -Compress));$this.Close()})
$null=$f.ShowDialog();$f.Dispose()
`;
  const out = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(JSON.parse(out.trim()).visible, true);
});

test('login windows show exact host read-only and use honest unchecked memory retention', () => {
  assert.match(ui,/Add-SsamLabel \$card \$hostName/);
  assert.match(ui,/function Add-SsamRemember[\s\S]*?\$c.Checked=\$false/);
  assert.match(ui,/\$input.BorderStyle='None'/);
  assert.match(ui,/class SsamRoundedPanel : Panel/);
  for (const name of ['credential-vault.ps1','users-vault.ps1']) {
    const source=fs.readFileSync(path.join(root,name),'utf8');
    assert.doesNotMatch(source,/Confirm the environment host|New environment: type its name again|\$approving/);
    assert.match(source,/privateCredential=@\{username=\$first.Text;password=\$second.Text\}/);
    assert.match(source,/\[Console\]::InputEncoding=New-Object Text.UTF8Encoding\(\$false\)/);
    assert.match(source,/\[Console\]::OutputEncoding=New-Object Text.UTF8Encoding\(\$false\)/);
  }
});
test('painted controls use symmetric one-pixel borders and preserve keyboard/accessibility contracts', { skip: process.platform !== 'win32' }, () => {
 const ps=`
$ErrorActionPreference='Stop'
. '${path.join(root,'private-dialog.ps1').replaceAll("'","''")}'
$b=New-Object Drawing.Bitmap(100,44);$g=[Drawing.Graphics]::FromImage($b);$g.Clear([Drawing.Color]::FromArgb(250,250,250))
[SsamDrawing]::Surface($g,(New-Object Drawing.RectangleF(0,0,100,44)),9,[Drawing.Color]::White,[SsamDrawing]::Border)
$edges=@($b.GetPixel(50,0).R,$b.GetPixel(50,43).R,$b.GetPixel(0,22).R,$b.GetPixel(99,22).R)
$inner=@($b.GetPixel(50,1).R,$b.GetPixel(50,42).R,$b.GetPixel(1,22).R,$b.GetPixel(98,22).R)
$f=New-SsamDialog 'Test' 'Fixture only' 'Users' 'tenant.example.test';$f.Opacity=0;$f.ShowInTaskbar=$false
$yes=Add-SsamButton $f 'Confirm' 28 400 180 -primary;$no=Add-SsamButton $f 'Cancel' 220 400 180;$check=Add-SsamRemember $f 350
$f.AcceptButton=$yes;$f.CancelButton=$no;$script:yesCount=0;$script:noCount=0
$yes.Add_Click({$script:yesCount++});$no.Add_Click({$script:noCount++});$f.Show();[Windows.Forms.Application]::DoEvents()
$flags=[Reflection.BindingFlags]'Instance,NonPublic'
$dialog=[Windows.Forms.Form].GetMethod('ProcessDialogKey',$flags)
$null=$dialog.Invoke($f,@([Windows.Forms.Keys]::Enter));$null=$dialog.Invoke($f,@([Windows.Forms.Keys]::Escape))
$yes.Enabled=$false;$yes.PerformClick();$yes.Enabled=$true
$null=$yes.GetType().GetMethod('OnKeyUp',$flags).Invoke($yes,@(([Windows.Forms.KeyEventArgs]::new([Windows.Forms.Keys]::Space))))
$check.AccessibilityObject.DoDefaultAction();$accessibleChecked=($check.AccessibilityObject.State -band [Windows.Forms.AccessibleStates]::Checked) -ne 0
$null=$check.GetType().GetMethod('OnKeyUp',$flags).Invoke($check,@(([Windows.Forms.KeyEventArgs]::new([Windows.Forms.Keys]::Space))))
$spaceUnchecked=-not $check.Checked
$null=$check.GetType().GetMethod('OnClick',$flags).Invoke($check,@([EventArgs]::Empty))
@{edges=$edges;inner=$inner;yes=$script:yesCount;no=$script:noCount;accessibleChecked=$accessibleChecked;spaceUnchecked=$spaceUnchecked;labelClickChecked=$check.Checked}|ConvertTo-Json -Compress
$f.Dispose();$g.Dispose();$b.Dispose()
`;
 const result=JSON.parse(execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-STA','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000}));
 assert.deepEqual(result.edges,[222,222,222,222]);assert.deepEqual(result.inner,[255,255,255,255]);assert.equal(result.yes,2);assert.equal(result.no,1);assert.equal(result.accessibleChecked,true);assert.equal(result.spaceUnchecked,true);assert.equal(result.labelClickChecked,true);
});
