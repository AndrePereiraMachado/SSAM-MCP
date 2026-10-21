param([Parameter(Mandatory)][string]$Title,[Parameter(Mandatory)][string]$Message)
Add-Type -AssemblyName System.Windows.Forms
$icon=New-Object System.Windows.Forms.NotifyIcon
try {
 $icon.Icon=[System.Drawing.SystemIcons]::Information
 $icon.Visible=$true
 $icon.ShowBalloonTip(15000,$Title,$Message,'Info')
 Start-Sleep -Seconds 16
} finally {$icon.Dispose()}
