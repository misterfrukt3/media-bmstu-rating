# ===================================================================
#  Локальный сервер для сайта рейтинга Media BMSTU
#  Раздаёт файлы по адресу http://localhost:8080 и открывает браузер.
#  Нужен потому, что Google Таблица отдаёт данные только для origin
#  http://localhost (а не для открытого напрямую файла file://).
#  Закрыть сервер — просто закрыть это окно.
# ===================================================================

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# Пробуем порты по очереди — берём первый свободный (некоторые порты
# Windows динамически резервирует под Hyper-V/WSL, поэтому список с запасом).
$ports = @(8181, 8123, 7777, 8055, 8360, 9099, 3000)

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".ico"  = "image/x-icon"
  ".woff2"= "font/woff2"
}

$listener = $null
$port = $null
foreach ($p in $ports) {
  $try = New-Object System.Net.HttpListener
  $try.Prefixes.Add("http://localhost:$p/")
  try { $try.Start(); $listener = $try; $port = $p; break }
  catch { try { $try.Close() } catch {} }
}

if (-not $listener) {
  Write-Host "Не удалось запустить сервер: все порты заняты или зарезервированы." -ForegroundColor Red
  Write-Host "Порты, которые пробовали: $($ports -join ', ')" -ForegroundColor Yellow
  Write-Host "Закройте старое окно сервера или добавьте свой порт в `$ports в server.ps1." -ForegroundColor Yellow
  Read-Host "Нажмите Enter, чтобы закрыть"
  exit 1
}

$prefix = "http://localhost:$port/"

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║   MEDIA BMSTU · Рейтинг — сервер запущен      ║" -ForegroundColor Green
Write-Host "  ╚══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Адрес:  $prefix" -ForegroundColor White
Write-Host "  Папка:  $root" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Чтобы остановить — закройте это окно." -ForegroundColor DarkGray
Write-Host ""

# открыть браузер (не критично, если не получится)
try { Start-Process $prefix | Out-Null } catch {
  Write-Host "  (браузер не открылся автоматически — откройте $prefix вручную)" -ForegroundColor Yellow
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
  } catch { break }

  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $rel = [System.Uri]::UnescapeDataString($req.Url.LocalPath).TrimStart("/")
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = "index.html" }
    $rel = $rel -replace "/", "\"
    $full = Join-Path $root $rel

    # защита от выхода за пределы папки
    $fullResolved = [System.IO.Path]::GetFullPath($full)
    if (-not $fullResolved.StartsWith([System.IO.Path]::GetFullPath($root))) {
      $res.StatusCode = 403
      $res.Close(); continue
    }

    if (Test-Path -LiteralPath $fullResolved -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($fullResolved)
      $ext = [System.IO.Path]::GetExtension($fullResolved).ToLower()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] }
      $res.Headers.Add("Cache-Control", "no-cache")
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 - файл не найден: $rel")
      $res.OutputStream.Write($msg, 0, $msg.Length)
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}
