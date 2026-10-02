$ErrorActionPreference = 'Stop'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (!(Test-Path $vswhere)) { throw 'Visual Studio C++ Build Tools and a Windows 10/11 SDK are required.' }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw 'Install the Visual Studio Desktop development with C++ workload.' }
Import-Module "$vs\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'
$output = Join-Path $PSScriptRoot '../build/store-updater'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$source = Join-Path $PSScriptRoot '../native/store-updater.cpp'
Push-Location $output
try {
    # Static CRT: the Store helper needs no extra runtime or Electron ABI binding.
    & cl.exe /nologo /std:c++20 /EHsc /O2 /MT /W4 /DUNICODE /D_UNICODE $source /Fe:muxus-store-updater.exe /link windowsapp.lib user32.lib /DYNAMICBASE /NXCOMPAT
    if ($LASTEXITCODE -ne 0) { throw "Store helper compilation failed ($LASTEXITCODE)." }
} finally { Pop-Location }
