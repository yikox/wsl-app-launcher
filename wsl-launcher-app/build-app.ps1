# build-app.ps1 - packages the Electron app into a standalone .exe folder
#
# Layout produced:
#   dist\<productName>-win32-x64\<productName>.exe   <- double-click this
#   dist\<productName>-win32-x64\resources\app\...   <- app code
#
# Also (re)creates desktop and start-menu shortcuts pointing at the exe.
# This script is ASCII-only; Chinese names are read from package.json (UTF-8).

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir "build-app-log.txt"
$lines = New-Object System.Collections.Generic.List[string]
function W([string]$m) { $script:lines.Add($m) }

try {
  $pkg = Get-Content -LiteralPath (Join-Path $dir "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $appName = $pkg.productName
  if ([string]::IsNullOrWhiteSpace($appName)) { $appName = $pkg.name }
  W ("product: " + $appName + "  v" + $pkg.version)

  $electronDist = Join-Path $dir "node_modules\electron\dist"
  if (-not (Test-Path -LiteralPath (Join-Path $electronDist "electron.exe"))) {
    W "FATAL: node_modules\electron\dist\electron.exe not found - npm install did not finish"
    throw "electron runtime missing"
  }

  $outDir = Join-Path (Join-Path $dir "dist") ($appName + "-win32-x64")
  if (Test-Path -LiteralPath $outDir) {
    try { [System.IO.Directory]::Delete($outDir, $true) } catch { W ("WARN cleanup: " + $_.Exception.Message) }
  }
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  Copy-Item -Path (Join-Path $electronDist "*") -Destination $outDir -Recurse -Force
  W "runtime copied"

  $resApp = Join-Path $outDir "resources\app"
  New-Item -ItemType Directory -Force -Path $resApp | Out-Null
  foreach ($f in @("package.json", "main.js", "preload.js", "scan.js")) {
    Copy-Item -LiteralPath (Join-Path $dir $f) -Destination $resApp -Force
  }
  Copy-Item -LiteralPath (Join-Path $dir "renderer") -Destination $resApp -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $dir "assets") -Destination $resApp -Recurse -Force
  W "app files copied"

  $defApp = Join-Path $outDir "resources\default_app.asar"
  if (Test-Path -LiteralPath $defApp) {
    try { [System.IO.File]::Delete($defApp) } catch { }
  }

  $exe = Join-Path $outDir ($appName + ".exe")
  Copy-Item -LiteralPath (Join-Path $outDir "electron.exe") -Destination $exe -Force
  try { [System.IO.File]::Delete((Join-Path $outDir "electron.exe")) } catch { }
  W ("exe: " + $exe)

  $rcedit = Join-Path $dir "tools\rcedit-x64.exe"
  $ico = Join-Path $dir "assets\icon.ico"
  if ((Test-Path -LiteralPath $rcedit) -and (Test-Path -LiteralPath $ico)) {
    $rceditArgs = @(
      $exe,
      "--set-icon", $ico,
      "--set-version-string", "ProductName", $appName,
      "--set-version-string", "FileDescription", "WSL GUI app launcher",
      "--set-version-string", "OriginalFilename", ($appName + ".exe"),
      "--set-file-version", [string]$pkg.version,
      "--set-product-version", [string]$pkg.version
    )
    try {
      $r = & $rcedit @rceditArgs 2>&1
      W ("rcedit ok: " + (($r | Out-String).Trim()))
    } catch {
      W ("WARN rcedit failed: " + $_.Exception.Message)
    }
  } else {
    W "WARN rcedit or icon.ico missing - exe keeps the default Electron icon"
  }

  # shortcuts
  try {
    $shell = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath("Desktop")
    $lnk = $shell.CreateShortcut((Join-Path $desktop ($appName + ".lnk")))
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $outDir
    $lnk.IconLocation = ($ico + ",0")
    $lnk.Description = "WSL GUI app launcher"
    $lnk.Save()
    W "desktop shortcut updated"

    $smDir = Join-Path (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs") "WSL GUI 应用"
    if (-not (Test-Path -LiteralPath $smDir)) { New-Item -ItemType Directory -Force -Path $smDir | Out-Null }
    $lnk2 = $shell.CreateShortcut((Join-Path $smDir ($appName + ".lnk")))
    $lnk2.TargetPath = $exe
    $lnk2.WorkingDirectory = $outDir
    $lnk2.IconLocation = ($ico + ",0")
    $lnk2.Description = "WSL GUI app launcher"
    $lnk2.Save()
    W "start menu shortcut updated"
  } catch {
    W ("WARN shortcut: " + $_.Exception.Message)
  }

  $size = (Get-ChildItem -LiteralPath $outDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  W ("done. folder size: " + [math]::Round($size / 1MB, 1) + " MB")
  W ("exe exists: " + (Test-Path -LiteralPath $exe))
} catch {
  W ("FATAL: " + $_.Exception.Message)
} finally {
  $script:lines | Set-Content -LiteralPath $log -Encoding UTF8
}
