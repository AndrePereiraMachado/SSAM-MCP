param([Parameter(Mandatory)][string]$Title,[Parameter(Mandatory)][string]$Message,[string]$Link)
# A Windows notification that stays in the notification center until the owner dismisses it (a toast under the Windows
# PowerShell app id), with a click that opens -Link (a proposal or failure file). Falls back to a tray balloon.
$ErrorActionPreference='Stop'
$esc={param($s)[Security.SecurityElement]::Escape($s)}
try{
 [void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
 [void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]
 $launch=''
 if($Link){$launch=" activationType=`"protocol`" launch=`"$(& $esc ([Uri]::new($Link).AbsoluteUri))`""}
 $xml=New-Object Windows.Data.Xml.Dom.XmlDocument
 $xml.LoadXml("<toast scenario=`"reminder`"$launch><visual><binding template=`"ToastGeneric`"><text>$(& $esc $Title)</text><text>$(& $esc $Message)</text></binding></visual><actions><action content=`"Open`" activationType=`"protocol`" arguments=`"$(if($Link){& $esc ([Uri]::new($Link).AbsoluteUri)}else{'about:blank'})`"/><action content=`"Dismiss`" activationType=`"system`" arguments=`"dismiss`"/></actions></toast>")
 $toast=[Windows.UI.Notifications.ToastNotification]::new($xml)
 $tag=($Title -replace '[^A-Za-z0-9]','')
 $toast.Tag=$tag.Substring(0,[Math]::Min(60,$tag.Length))
 $toast.Group='ssam'
 [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
}catch{
 Add-Type -AssemblyName System.Windows.Forms
 $icon=New-Object System.Windows.Forms.NotifyIcon
 try{$icon.Icon=[System.Drawing.SystemIcons]::Information;$icon.Visible=$true;$icon.ShowBalloonTip(15000,$Title,$Message,'Info');Start-Sleep -Seconds 16}finally{$icon.Dispose()}
}
