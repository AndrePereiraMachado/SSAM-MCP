param([Parameter(Mandatory)][string]$Root)
$ErrorActionPreference='Stop'
foreach($file in Get-ChildItem -LiteralPath $Root -Recurse -File | Where-Object { $_.Extension -in '.dll','.exe' }) {
    $signature=Get-AuthenticodeSignature -LiteralPath $file.FullName
    if($signature.Status -notin 'Valid','NotSigned'){throw 'An extracted internal signature is invalid.'}
}
