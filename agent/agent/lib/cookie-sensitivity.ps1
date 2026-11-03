function Test-SsamSensitiveCookie([string]$name,[string]$value) {
 if($null -eq $script:SsamPublicCookieMetadata){$script:SsamPublicCookieMetadata = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'public-cookie-metadata.json') -Raw | ConvertFrom-Json}
 foreach($rule in $script:SsamPublicCookieMetadata.PSObject.Properties) {
  if($name -cmatch ('\A(?:'+$rule.Name+')\z') -and $value -cmatch ('\A(?:'+$rule.Value+')\z')){return $false}
 }
 return $true
}
