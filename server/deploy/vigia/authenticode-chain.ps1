# Authenticode is verified by Windows first; the certificate path uses its signed timestamp.
Add-Type -AssemblyName System.Security
function Read-DerValue([byte[]]$Bytes,[ref]$At) {
    $start=$At.Value
    if($start+2 -gt $Bytes.Length){throw 'Truncated DER.'}
    $tag=$Bytes[$At.Value++];$length=[int]$Bytes[$At.Value++]
    if($length -band 128){$count=$length-band 127;if($count -lt 1 -or $count -gt 4){throw 'Invalid DER length.'};$length=0;for($i=0;$i -lt $count;$i++){$length=($length*256)+$Bytes[$At.Value++]}}
    if($length -lt 0 -or $At.Value+$length -gt $Bytes.Length){throw 'DER value exceeds its container.'}
    $value=[pscustomobject]@{Tag=$tag;Start=$At.Value;Length=$length;End=$At.Value+$length}
    $At.Value=$value.End;return $value
}
function Get-AuthenticodeSigningTime([string]$File,$Signature) {
    if(-not $Signature.TimeStamperCertificate){return [DateTime]::UtcNow}
    $bytes=[IO.File]::ReadAllBytes($File)
    if($bytes.Length -lt 64){throw 'Missing signed PE image.'}
    $pe=[BitConverter]::ToInt32($bytes,60);$optional=$pe+24
    if($optional+152 -ge $bytes.Length){throw 'Invalid PE headers.'}
    $magic=[BitConverter]::ToUInt16($bytes,$optional)
    $directory=$optional+$(if($magic -eq 523){112}elseif($magic -eq 267){96}else{throw 'Unsupported PE format.'})+32
    $offset=[BitConverter]::ToInt32($bytes,$directory);$size=[BitConverter]::ToInt32($bytes,$directory+4)
    if($offset -lt 0 -or $size -lt 8 -or $size -gt 16777216 -or $offset+$size -gt $bytes.Length){throw 'Invalid PE certificate table.'}
    $cms=[Security.Cryptography.Pkcs.SignedCms]::new()
    $length=[BitConverter]::ToInt32($bytes,$offset)
    if($length -lt 8 -or $length -gt $size){throw 'Invalid WIN_CERTIFICATE length.'}
    $cms.Decode([byte[]]$bytes[($offset+8)..($offset+$length-1)])
    $cms.CheckSignature($true)
    foreach($signer in $cms.SignerInfos){
        foreach($counter in $signer.CounterSignerInfos){foreach($attribute in $counter.SignedAttributes){
            if($attribute.Oid.Value -eq '1.2.840.113549.1.9.5'){
                return ([Security.Cryptography.Pkcs.Pkcs9SigningTime]::new($attribute.Values[0].RawData)).SigningTime.ToUniversalTime()
            }
        }}
        foreach($attribute in $signer.UnsignedAttributes){if($attribute.Oid.Value -eq '1.3.6.1.4.1.311.3.3.1'){
            $timestamp=[Security.Cryptography.Pkcs.SignedCms]::new();$timestamp.Decode($attribute.Values[0].RawData);$timestamp.CheckSignature($true)
            $content=$timestamp.ContentInfo.Content;$at=0;$sequence=Read-DerValue $content ([ref]$at);$at=$sequence.Start
            for($i=0;$i -lt 4;$i++){[void](Read-DerValue $content ([ref]$at))}
            $time=Read-DerValue $content ([ref]$at)
            if($time.Tag -ne 24){throw 'Missing timestamp generation time.'}
            $text=[Text.Encoding]::ASCII.GetString($content,$time.Start,$time.Length)
            # Windows PowerShell binds an untyped array to the single-format overload; the formats must be a typed string[].
            [string[]]$formats=@('yyyyMMddHHmmss\Z','yyyyMMddHHmmss.FFFFFFF\Z')
            return [DateTime]::ParseExact($text,$formats,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
        }}
    }
    throw 'Timestamp certificate exists without a verifiable signing time.'
}
# The signer organization as the agent reads it (native AuthenticodeTrust.cs): the O= values of the subject decoded one per line;
# exactly one of them, else none (''). The caller compares it ordinally.
function Get-SingleOrganization([Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
    $names=@($Certificate.SubjectName.Decode([Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseNewLines) -split "`n" |
        ForEach-Object { $_.Trim() } | Where-Object { $_.StartsWith('O=',[StringComparison]::Ordinal) } | ForEach-Object { $_.Substring(2) })
    if($names.Count -eq 1){return [string]$names[0]}
    return ''
}
function Get-VerifiedAuthenticodeChain([string]$File,$Signature,$Chain=$null) {
    if($Signature.Status -ne 'Valid'){
        if($Signature.StatusMessage -match '0x80092013|0x800B010E|revocation.*offline|revoga.*offline'){Write-Output '{"ok":false,"code":"REVOCATION_UNAVAILABLE","environmental":true}';throw 'Certificate revocation service is unavailable.'}
        throw 'Authenticode is invalid.'
    }
    if($null -eq $Chain){$Chain=New-Object Security.Cryptography.X509Certificates.X509Chain}
    $Chain.ChainPolicy.VerificationTime=Get-AuthenticodeSigningTime $File $Signature
    $Chain.ChainPolicy.RevocationMode=[Security.Cryptography.X509Certificates.X509RevocationMode]::Online
    $Chain.ChainPolicy.RevocationFlag=[Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
    $Chain.ChainPolicy.UrlRetrievalTimeout=[TimeSpan]::FromSeconds(15)
    if(-not $Chain.Build($Signature.SignerCertificate)){
        if(@($Chain.ChainStatus | Where-Object {($_.Status -band [Security.Cryptography.X509Certificates.X509ChainStatusFlags]::OfflineRevocation) -or ($_.Status -band [Security.Cryptography.X509Certificates.X509ChainStatusFlags]::RevocationStatusUnknown)}).Count){
            Write-Output '{"ok":false,"code":"REVOCATION_UNAVAILABLE","environmental":true}'
            throw 'Certificate revocation service is unavailable.'
        }
        throw 'Authenticode certificate path is invalid at signing time.'
    }
    return $Chain
}
