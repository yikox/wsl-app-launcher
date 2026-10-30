# release.ps1 - one-command update: sync sources into dist, refresh exe metadata,
# then install into the per-user Windows program dir (shortcuts + uninstall entry).
# ASCII-only source; localized names come from package.json (UTF-8).

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir "release-log.txt"
$lines = New-Object System.Collections.Generic.List[string]
function W([string]$m) { $script:lines.Add($m); Write-Host $m }

try {
  $pkg = Get-Content -LiteralPath (Join-Path $dir "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $appName = [string]$pkg.productName
  $version = [string]$pkg.version
  $app = Join-Path (Join-Path (Join-Path $dir "dist") ($appName + "-win32-x64")) "resources\app"
  if (-not (Test-Path -LiteralPath $app)) { throw "resources\app missing: $app" }
  W ("== release " + $appName + " v" + $version)

  # 1) stop instances (dist copy may be locked by a running exe)
  $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and ($_.Path -like (Join-Path $dir "dist*"))
  }
  if ($procs) {
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1200
    W ("stopped dist instances: " + (($procs | ForEach-Object { $_.Id }) -join ","))
  }

  # 2) sync business code into the packaged runtime
  foreach ($f in @("main.js", "preload.js", "scan.js", "package.json")) {
    Copy-Item -LiteralPath (Join-Path $dir $f) -Destination (Join-Path $app $f) -Force
  }
  $renderer = Join-Path $app "renderer"
  if (-not (Test-Path -LiteralPath $renderer)) { New-Item -ItemType Directory -Force -Path $renderer | Out-Null }
  Copy-Item -Path (Join-Path $dir "renderer\*") -Destination $renderer -Recurse -Force
  # guard against the Copy-Item <dir> trap creating renderer\renderer
  $nested = Join-Path $renderer "renderer"
  if (Test-Path -LiteralPath $nested) {
    $bak = Join-Path $env:TEMP ("wl-nested-" + (Get-Date -Format "HHmmss"))
    Move-Item -LiteralPath $nested -Destination $bak
    W ("WARN nested renderer moved to " + $bak)
  }
  $distVer = (Get-Content -LiteralPath (Join-Path $app "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  W ("dist resources\app version: " + $distVer)

  # 3) exe icon + version metadata
  & (Join-Path $dir "finalize.ps1")
  $exe = Join-Path (Join-Path (Join-Path $dir "dist") ($appName + "-win32-x64")) ($appName + ".exe")
  if (Test-Path -LiteralPath $exe) {
    W ("exe FileVersion: " + (Get-Item -LiteralPath $exe).VersionInfo.FileVersion)
  }

  # 4) install to %LOCALAPPDATA%\Programs + shortcuts + uninstall entry
  & (Join-Path $dir "install.ps1")

  W "== release done"
} catch {
  W ("FATAL: " + $_.Exception.Message)
} finally {
  $script:lines | Set-Content -LiteralPath $log -Encoding UTF8
}
