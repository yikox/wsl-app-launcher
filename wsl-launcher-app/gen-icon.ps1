# gen-icon.ps1 - renders the launcher icon (256x256 png + ico)
# ASCII-only script; output paths are relative to this script.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$assets = Join-Path $dir "assets"
if (-not (Test-Path -LiteralPath $assets)) {
  New-Item -ItemType Directory -Force -Path $assets | Out-Null
}

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# rounded square background with vertical gradient
$pad = 8
$rect = New-Object System.Drawing.Rectangle($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))
$radius = 52
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc(($rect.Right - $d), $rect.Y, $d, $d, 270, 90)
$path.AddArc(($rect.Right - $d), ($rect.Bottom - $d), $d, $d, 0, 90)
$path.AddArc($rect.X, ($rect.Bottom - $d), $d, $d, 90, 90)
$path.CloseFigure()

$c1 = [System.Drawing.Color]::FromArgb(255, 32, 108, 178)
$c2 = [System.Drawing.Color]::FromArgb(255, 10, 60, 110)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
$g.FillPath($brush, $path)

# subtle inner highlight
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(46, 255, 255, 255), 2)
$g.DrawPath($pen, $path)

# terminal prompt  >_
$font = New-Object System.Drawing.Font("Consolas", 108, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$r1 = New-Object System.Drawing.RectangleF(46, 70, 164, 130)
$g.DrawString(">", $font, $white, $r1, $fmt)

# underscore cursor
$cursorPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 126, 231, 135), 13)
$cursorPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$cursorPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($cursorPen, 132, 176, 196, 176)

$g.Dispose()

$pngPath = Join-Path $assets "icon.png"
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# wrap the png into a single-entry ico (256x256, PNG payload)
$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]1)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]32)
$bw.Write([UInt32]$pngBytes.Length)
$bw.Write([UInt32]22)
$bw.Write($pngBytes)
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $assets "icon.ico"), $ms.ToArray())
$bw.Close()
$ms.Close()

$result = @()
$result += "png: " + (Get-Item -LiteralPath $pngPath).Length + " bytes"
$result += "ico: " + (Get-Item -LiteralPath (Join-Path $assets "icon.ico")).Length + " bytes"
$result | Set-Content -LiteralPath (Join-Path $dir "icon-build.txt") -Encoding UTF8
