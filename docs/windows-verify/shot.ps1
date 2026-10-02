# 物理像素截图（DPI 感知 + CAPTUREBLT，能抓到 WebView2 的合成层）
param(
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$CropX = -1, [int]$CropY = -1, [int]$CropW = 0, [int]$CropH = 0,
  [double]$Zoom = 1.0
)
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public class Shot {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int idx);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
}
'@
Add-Type -TypeDefinition $sig
# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4，必须在任何 GDI/窗口操作之前调用
[void][Shot]::SetProcessDpiAwarenessContext([IntPtr](-4))
$w = [Shot]::GetSystemMetrics(0)
$h = [Shot]::GetSystemMetrics(1)
$screenDc = [Shot]::GetDC([IntPtr]::Zero)
$memDc = [Shot]::CreateCompatibleDC($screenDc)
$bmp = [Shot]::CreateCompatibleBitmap($screenDc, $w, $h)
$old = [Shot]::SelectObject($memDc, $bmp)
# SRCCOPY = 0x00CC0020, CAPTUREBLT = 0x40000000
[void][Shot]::BitBlt($memDc, 0, 0, $w, $h, $screenDc, 0, 0, 0x40CC0020)
[void][Shot]::SelectObject($memDc, $old)

Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromHbitmap($bmp)
if ($CropX -ge 0 -and $CropW -gt 0) {
  $tw = [int]($CropW * $Zoom); $th = [int]($CropH * $Zoom)
  $outBmp = New-Object System.Drawing.Bitmap $tw, $th
  $g = [System.Drawing.Graphics]::FromImage($outBmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $g.DrawImage($image, (New-Object System.Drawing.Rectangle 0,0,$tw,$th), (New-Object System.Drawing.Rectangle $CropX,$CropY,$CropW,$CropH), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $outBmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $outBmp.Dispose()
} else {
  $image.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
}
$image.Dispose()
[void][Shot]::DeleteObject($bmp); [void][Shot]::DeleteDC($memDc); [void][Shot]::ReleaseDC([IntPtr]::Zero, $screenDc)
Write-Host "saved $Out ($w x $h physical)"
