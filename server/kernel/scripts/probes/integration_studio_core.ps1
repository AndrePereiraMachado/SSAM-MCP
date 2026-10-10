# Run in Windows PowerShell 5.1 (.NET Framework), in a separate process.
# Investigation only: blank model, native undo/redo and light XML roundtrip. No GUI/network/publication.
param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
$OutputPath=[IO.Path]::GetFullPath($OutputPath)
$null=New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath)
$root='C:\Program Files\OutSystems\Integration Studio'
$resolver=[ResolveEventHandler]{param($s,$e)
 $candidate=Join-Path 'C:\Program Files\OutSystems\Integration Studio' (([Reflection.AssemblyName]$e.Name).Name+'.dll')
 if(Test-Path -LiteralPath $candidate){return [Reflection.Assembly]::LoadFrom($candidate)}
 return $null
}
[AppDomain]::CurrentDomain.add_AssemblyResolve($resolver)
$result=[ordered]@{kind='native offline model probe';networkCallsRequested=$false;guiLaunched=$false;stage='load'}
try{
 $a=[Reflection.Assembly]::LoadFrom((Join-Path $root 'OutSystems.IntegrationStudio.Core.dll'))
 $t=$a.GetType('OutSystems.IntegrationStudio.Core.Aggregator.Aggregator',$true)
 $agg=[Activator]::CreateInstance($t,[object[]]@($true));$agg.ProjectName='ZZISProbe';$agg.ProjectCreateBlank()
 $result.stage='blank-created';$result.name=$agg.IProject.Name;$result.technologies=$agg.IProject.ITechnologies.Count
 $result.stage='verify';$reports=$agg.ProjectVerify();$result.reports=@($reports | ForEach-Object {@{type=$_.Type.ToString();id=$_.Id;detail=$_.Detail}})
 $result.stage='verified';$result.verified=$agg.IProject.Verified
 $context=$agg.NewContext($true)
 $commandType=$a.GetType('OutSystems.IntegrationStudio.Core.Common.Model.Project.ProjectCommand',$true)
 $command=$commandType.GetMethod('ChangeDescription').Invoke($null,[object[]]@($agg.IProject,'native probe description'))
 $before=$agg.IProject.Description;$agg.Execute($context,$command);$after=$agg.IProject.Description
 $null=$agg.Undo($context);$undone=$agg.IProject.Description;$null=$agg.Redo($context);$redone=$agg.IProject.Description
 $result.undoRedo=@{after=$after;undoRestored=($before -eq $undone);redoRestored=($after -eq $redone)}
 $result.stage='serialize'
 $xmlPath=Join-Path (Split-Path -Parent $OutputPath) 'blank-model.xml';$reports=$agg.ProjectLightSave($xmlPath)
 $result.serializationReports=@($reports | ForEach-Object {@{type=$_.Type.ToString();id=$_.Id;detail=$_.Detail}})
 $doc=[System.Xml.Linq.XDocument]::Load($xmlPath)
 $other=[Activator]::CreateInstance($t,[object[]]@($true));$other.ProjectName='Reload';$other.ProjectCreateBlank()
 $xmlType=$a.GetType('OutSystems.IntegrationStudio.Core.Common.Model.XIF.XML',$true)
 $method=$xmlType.GetMethods() | Where-Object {$_.Name -eq 'LoadToModel' -and $_.GetParameters().Count -eq 3} | Select-Object -First 1
 $args=[object[]]@([Collections.ArrayList]::new(),$doc,$other.IProject)
 $loaded=$method.Invoke($null,$args)
 $result.roundtrip=@{name=$loaded.Name;namePreserved=($loaded.Name -eq $agg.IProject.Name);descriptionPreserved=($loaded.Description -eq $agg.IProject.Description);keyPreserved=($loaded.Key.ToString() -eq $agg.IProject.Key.ToString());xmlBytes=(Get-Item -LiteralPath $xmlPath).Length}
 $result.stage='roundtripped'
}catch{
 $e=$_.Exception;while($e.InnerException){$e=$e.InnerException};$result.errorType=$e.GetType().FullName;$result.error=$e.Message
}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
$result | ConvertTo-Json -Depth 6

