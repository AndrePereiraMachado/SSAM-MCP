<#
.SYNOPSIS
  Exports the ODC Studio feature cache of this Windows user as Features.plain.xml, for the Linux ssam-server
  (deploy/DEPLOY.md 7.2).

.DESCRIPTION
  The ODC model asks the Studio's feature provider (aggregates, for one), which the kernel fills from the cache an ODC
  Studio keeps after it signs in: %LOCALAPPDATA%\OutSystems\ODC Studio\Features.xml. On Windows that file is encrypted
  with DPAPI for the Windows user, and on Linux the Studio's encryption service is ASP.NET Core Data Protection, which
  cannot read it ("The provided payload cannot be decrypted because it was not protected with this protection
  provider"). This script, run AS THAT WINDOWS USER (a normal PowerShell, not one started from an MSIX-packaged app,
  whose %LOCALAPPDATA% is private), decrypts it and writes the plain XML; the kernel on Linux
  (kernel/src/Anvil.Core.Odc/Adapters.ODC/OdcFeatures.cs) encrypts it again with its own service before the provider
  reads it. The file holds the tenant's feature flags (no credential): keep it private, copy it to the VPS volume and
  delete the copies.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy\odc-features-export.ps1 -Out C:\t\Features.plain.xml
#>
param(
    [string]$Source = (Join-Path $env:LOCALAPPDATA 'OutSystems\ODC Studio\Features.xml'),
    [Parameter(Mandatory)][string]$Out
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Source)) { throw "no ODC Studio feature cache at $Source (open the ODC Studio and sign in once as this Windows user)" }
Add-Type -AssemblyName System.Security
$text = [IO.File]::ReadAllText($Source).Trim()
try { $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($text), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser) }
catch { throw "could not decrypt $Source as this Windows user (DPAPI): $($_.Exception.Message)" }
$xml = [xml][Text.Encoding]::UTF8.GetString($bytes)
if ($xml.DocumentElement.Name -ne 'Features') { throw "the decrypted cache is not a <Features> document (root: $($xml.DocumentElement.Name))" }
$count = @($xml.DocumentElement.SelectNodes('Feature')).Count
$full = [IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force (Split-Path -Parent $full) | Out-Null
[IO.File]::WriteAllBytes($full, $bytes)
$sha = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host ("{0}: {1} features, {2} bytes, sha256 {3} (from {4})" -f $full, $count, $bytes.Length, $sha, $Source)
