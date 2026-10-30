param([Parameter(Mandatory)][string]$Title,[Parameter(Mandatory)][string]$Message,[string]$Link,[switch]$Report)
# A Windows notification that stays in the notification center until the owner dismisses it (a toast under the Windows
# PowerShell app id); a click opens -Link (a proposal or failure file). Falls back to a tray balloon. -Report prints which
# one was shown (diagnosis).
$ErrorActionPreference='Stop'
$esc={param($s)[Security.SecurityElement]::Escape($s)}
try{
 [void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
 [void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]
 $open=''
 if($Link){$uri=& $esc ([Uri]::new($Link).AbsoluteUri);$open=" activationType=`"protocol`" launch=`"$uri`""}
 $xml=New-Object Windows.Data.Xml.Dom.XmlDocument
 $xml.LoadXml("<toast$open><visual><binding template=`"ToastGeneric`"><text>$(& $esc $Title)</text><text>$(& $esc $Message)</text></binding></visual></toast>")
 $toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
 $tag=($Title -replace '[^A-Za-z0-9]','')
 $toast.Tag=$tag.Substring(0,[Math]::Min(60,$tag.Length))
 $toast.Group='ssam'
 [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
 if($Report){'toast'}
}catch{
 if($Report){"balloon: $($_.Exception.Message)"}
 Add-Type -AssemblyName System.Windows.Forms
 $icon=New-Object System.Windows.Forms.NotifyIcon
 try{$icon.Icon=[System.Drawing.SystemIcons]::Information;$icon.Visible=$true;$icon.ShowBalloonTip(15000,$Title,$Message,'Info');Start-Sleep -Seconds 16}finally{$icon.Dispose()}
}
