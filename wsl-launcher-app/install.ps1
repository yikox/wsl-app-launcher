# install.ps1 - installs the built app into the per-user Windows program dir,
# (re)creates Desktop / Start Menu shortcuts and registers an uninstall entry.
# ASCII-only source: localized names are read from package.json (UTF-8).

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir "install-log.txt"
$lines = New-Object System.Collections.Generic.List[string]
function W([string]$m) { $script:lines.Add($m) }

try {
  $pkg = Get-Content -LiteralPath (Join-Path $dir "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $appName = [string]$pkg.productName
  $version = [string]$pkg.version
  if ([string]::IsNullOrWhiteSpace($appName)) { throw "productName missing in package.json" }

  $src = Join-Path (Join-Path $dir "dist") ($appName + "-win32-x64")
  $srcExe = Join-Path $src ($appName + ".exe")
  if (-not (Test-Path -LiteralPath $srcExe)) { throw "built exe not found: $srcExe (run release.ps1 instead)" }

  $dest = Join-Path (Join-Path $env:LOCALAPPDATA "Programs") $appName
  $destExe = Join-Path $dest ($appName + ".exe")
  W ("src : " + $src)
  W ("dest: " + $dest)
  W ("ver : " + $version)

  # 1) stop running instances so files can be replaced
  $procs = @()
  try {
    $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and (($_.Path -like ($dest + "*")) -or ($_.Path -like ($src + "*")))
    }
  } catch { }
  if ($procs.Count -gt 0) {
    $ids = ($procs | ForEach-Object { $_.Id }) -join ","
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1200
    W ("stopped instances: " + $ids)
  } else {
    W "no running instance"
  }

  # 2) mirror the build output into the install dir
  if (-not (Test-Path -LiteralPath $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
  # robocopy needs quoted paths because both ends contain spaces / CJK
  $rcArgs = @(("`"" + $src + "`""), ("`"" + $dest + "`""), "/MIR", "/XF", "launcher-log.txt", "/NFL", "/NDL", "/NJH", "/NJS", "/R:1", "/W:1", "/MT:8")
  $rc = Start-Process -FilePath "robocopy.exe" -ArgumentList $rcArgs -Wait -PassThru -WindowStyle Hidden
  W ("robocopy exit: " + $rc.ExitCode)
  if ($rc.ExitCode -ge 8) {
    W "robocopy failed, falling back to Copy-Item"
    Copy-Item -Path (Join-Path $src "*") -Destination $dest -Recurse -Force
    W "copy fallback done"
  }
  if (-not (Test-Path -LiteralPath $destExe)) { throw "install target exe missing after copy: $destExe" }
  $sizeMb = [math]::Round(((Get-ChildItem -LiteralPath $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
  W ("installed size: " + $sizeMb + " MB")

  # 3) shortcuts (overwrite the ones finalize.ps1 made under dist).
  # Icon comes from the installed exe itself, so the shortcut keeps working
  # even if the build folder is deleted later.
  $shell = New-Object -ComObject WScript.Shell
  $icon = $destExe
  $targets = @()
  $targets += (Join-Path ([Environment]::GetFolderPath("Desktop")) ($appName + ".lnk"))
  $smDir = Join-Path (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs") "WSL GUI Apps"
  if (-not (Test-Path -LiteralPath $smDir)) { New-Item -ItemType Directory -Force -Path $smDir | Out-Null }
  $targets += (Join-Path $smDir ($appName + ".lnk"))
  foreach ($lnkPath in $targets) {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $destExe
    $lnk.WorkingDirectory = $dest
    $lnk.IconLocation = ($icon + ",0")
    $lnk.Description = "WSL GUI app launcher"
    $lnk.Save()
    W ("shortcut: " + $lnkPath)
  }

  # 4) info file consumed by uninstall.ps1 (kept ASCII-keyed, values may be CJK)
  $info = [ordered]@{
    productName    = $appName
    version        = $version
    exe            = $destExe
    installDir     = $dest
    startMenuDir   = $smDir
    installedAt    = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  }
  ($info | ConvertTo-Json) | Set-Content -LiteralPath (Join-Path $dest "install-info.json") -Encoding UTF8

  # 5) copy the uninstaller next to the app
  $uninstSrc = Join-Path $dir "uninstall.ps1"
  if (Test-Path -LiteralPath $uninstSrc) {
    Copy-Item -LiteralPath $uninstSrc -Destination (Join-Path $dest "uninstall.ps1") -Force
    W "uninstaller copied"
  }

  # 6) Apps & Features entry (HKCU, no admin needed)
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WSLLauncher"
  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
  $estKb = [int](((Get-ChildItem -LiteralPath $dest -Recurse -File | Measure-Object Length -Sum).Sum) / 1KB)
  Set-ItemProperty -LiteralPath $key -Name DisplayName     -Value $appName
  Set-ItemProperty -LiteralPath $key -Name DisplayVersion  -Value $version
  Set-ItemProperty -LiteralPath $key -Name DisplayIcon     -Value ($destExe + ",0")
  Set-ItemProperty -LiteralPath $key -Name InstallLocation -Value $dest
  Set-ItemProperty -LiteralPath $key -Name Publisher       -Value "WorkBuddy local build"
  Set-ItemProperty -LiteralPath $key -Name EstimatedSize   -Value $estKb -Type DWord
  Set-ItemProperty -LiteralPath $key -Name InstallDate     -Value (Get-Date).ToString("yyyyMMdd")
  Set-ItemProperty -LiteralPath $key -Name NoModify        -Value 1 -Type DWord
  Set-ItemProperty -LiteralPath $key -Name NoRepair        -Value 1 -Type DWord
  $uninst = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"" + (Join-Path $dest "uninstall.ps1") + "`""
  Set-ItemProperty -LiteralPath $key -Name UninstallString -Value $uninst
  W ("registry: " + $key)

  W "DONE"
} catch {
  W ("FATAL: " + $_.Exception.Message)
} finally {
  $script:lines | Set-Content -LiteralPath $log -Encoding UTF8
}

# echo the log so callers see the result
Get-Content -LiteralPath $log -Encoding UTF8
