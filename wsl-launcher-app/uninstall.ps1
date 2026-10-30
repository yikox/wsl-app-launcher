# uninstall.ps1 - removes the per-user install created by install.ps1.
# ASCII-only source; localized names come from install-info.json (UTF-8).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 [-Purge]

param([switch]$Purge)

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$infoPath = Join-Path $here "install-info.json"
if (-not (Test-Path -LiteralPath $infoPath)) {
  Write-Host "install-info.json not found next to this script; aborting."
  exit 1
}
$info = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
$appName = [string]$info.productName
$installDir = [string]$info.installDir
$startMenuDir = [string]$info.startMenuDir

Write-Host ("Uninstalling " + $appName + " (" + $info.version + ")")

# 1) stop the app
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and ($_.Path -like ($installDir + "*"))
}
if ($procs) {
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1200
  Write-Host ("stopped " + $procs.Count + " process(es)")
}

# 2) shortcuts
$lnks = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) ($appName + ".lnk")),
  (Join-Path $startMenuDir ($appName + ".lnk"))
)
foreach ($p in $lnks) {
  if (Test-Path -LiteralPath $p) {
    Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    Write-Host ("removed " + $p)
  }
}

# 3) Apps & Features entry
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WSLLauncher"
if (Test-Path -LiteralPath $key) {
  Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "removed registry entry"
}

# 4) optional user data
if ($Purge) {
  $ud = Join-Path $env:APPDATA $appName
  if (Test-Path -LiteralPath $ud) {
    Remove-Item -LiteralPath $ud -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ("removed user data: " + $ud)
  }
} elseif (Test-Path -LiteralPath (Join-Path $env:APPDATA $appName)) {
  Write-Host ("kept user settings: " + (Join-Path $env:APPDATA $appName) + " (re-run with -Purge to delete)")
}

# 5) delete the install dir from a detached shell (this script lives inside it)
$cmd = "Start-Sleep -Seconds 2; Remove-Item -LiteralPath '" + $installDir + "' -Recurse -Force -ErrorAction SilentlyContinue"
Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-Command", $cmd) -WindowStyle Hidden | Out-Null
Write-Host ("scheduled removal of " + $installDir)
Write-Host "Done."
