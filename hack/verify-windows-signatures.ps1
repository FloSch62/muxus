$ErrorActionPreference = 'Stop'
if (!$env:WINDOWS_SIGNING -or $env:WINDOWS_SIGNING -eq 'unsigned') {
  Write-Host 'Windows NSIS release is explicitly unsigned; Microsoft signs the Store package separately.'
  exit 0
}
$installers = @(Get-ChildItem electron/release/*.exe)
$apps = @(Get-ChildItem electron/release/win*-unpacked/muxus.exe)
if ($installers.Count -eq 0 -or $apps.Count -eq 0) { throw 'Installer and packaged app are both required.' }
foreach ($file in ($installers + $apps)) {
  $signature = Get-AuthenticodeSignature $file.FullName
  if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $($file.Name) ($($signature.Status))" }
  $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($publisher -ne $env:WINDOWS_PUBLISHER_NAME) { throw "Unexpected publisher on $($file.Name): $publisher" }
  Write-Host "Verified $($file.Name): $publisher"
}
