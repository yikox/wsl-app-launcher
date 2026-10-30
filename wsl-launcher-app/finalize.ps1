# finalize.ps1 - applies the app icon + version info and (re)creates shortcuts
# ASCII-only script; Chinese names are read from package.json (UTF-8).

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir "finalize-log.txt"
$lines = New-Object System.Collections.Generic.List[string]
function W([string]$m) { $script:lines.Add($m) }

try {
  $pkg = Get-Content -LiteralPath (Join-Path $dir "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $appName = $pkg.productName
  $outDir = Join-Path (Join-Path $dir "dist") ($appName + "-win32-x64")
  $exe = Join-Path $outDir ($appName + ".exe")
  $ico = Join-Path $dir "assets\icon.ico"
  $rcedit = Join-Path $dir "tools\rcedit-x64.exe"

  if (-not (Test-Path -LiteralPath $exe)) { throw "exe not found: $exe" }
  W ("exe: " + $exe)

  if ((Test-Path -LiteralPath $rcedit) -and (Test-Path -LiteralPath $ico)) {
    $rceditArgs = @(
      $exe,
      "--set-icon", $ico,
      "--set-version-string", "ProductName", $appName,
      "--set-version-string", "FileDescription", "WSL GUI App Launcher",
      "--set-version-string", "OriginalFilename", ($appName + ".exe"),
      "--set-file-version", [string]$pkg.version,
      "--set-product-version", [string]$pkg.version
    )
    try {
      $r = & $rcedit @rceditArgs 2>&1
      W ("rcedit: " + (($r | Out-String).Trim()))
    } catch {
      W ("WARN rcedit: " + $_.Exception.Message)
    }
  }

  $shell = New-Object -ComObject WScript.Shell
  $desktop = [Environment]::GetFolderPath("Desktop")
  $lnk = $shell.CreateShortcut((Join-Path $desktop ($appName + ".lnk")))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $outDir
  $lnk.IconLocation = ($ico + ",0")
  $lnk.Description = "WSL GUI app launcher"
  $lnk.Save()
  W "desktop shortcut -> exe"

  $smDir = Join-Path (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs") "WSL GUI Apps"
  if (-not (Test-Path -LiteralPath $smDir)) { New-Item -ItemType Directory -Force -Path $smDir | Out-Null }
  $lnk2 = $shell.CreateShortcut((Join-Path $smDir ($appName + ".lnk")))
  $lnk2.TargetPath = $exe
  $lnk2.WorkingDirectory = $outDir
  $lnk2.IconLocation = ($ico + ",0")
  $lnk2.Description = "WSL GUI app launcher"
  $lnk2.Save()
  W "start menu shortcut -> exe"

  W ("icon on disk: " + (Test-Path -LiteralPath $ico))
} catch {
  W ("FATAL: " + $_.Exception.Message)
} finally {
  $script:lines | Set-Content -LiteralPath $log -Encoding UTF8
}
