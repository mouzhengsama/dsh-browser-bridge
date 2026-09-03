param(
  [int]$MetricsPort = 20243,
  [string]$EdgeBind = '',
  [string]$Origin = 'http://127.0.0.1:43120',
  [switch]$UseProxy
)

$ErrorActionPreference = 'Stop'
$outLog = Join-Path $env:TEMP "cloudflared-diag-$MetricsPort.out.log"
$errLog = Join-Path $env:TEMP "cloudflared-diag-$MetricsPort.err.log"
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

$argsList = @(
  'tunnel',
  '--protocol', 'http2',
  '--no-autoupdate',
  '--metrics', "localhost:$MetricsPort",
  '--url', $Origin
)
if ($EdgeBind) {
  $argsList += @('--edge-bind-address', $EdgeBind)
}
if ($UseProxy) {
  $env:HTTPS_PROXY = 'http://127.0.0.1:7897'
  $env:HTTP_PROXY = 'http://127.0.0.1:7897'
  $env:ALL_PROXY = 'http://127.0.0.1:7897'
}

$p = Start-Process -FilePath 'cloudflared' -ArgumentList $argsList `
  -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
Start-Sleep -Seconds 12

$alive = -not $p.HasExited
$ready = ''
$metrics = ''
if ($alive) {
  try {
    $ready = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$MetricsPort/ready" -TimeoutSec 5).Content
  } catch {
    $ready = "ERR: $($_.Exception.Message)"
  }
  try {
    $metrics = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$MetricsPort/metrics" -TimeoutSec 5).Content
  } catch {
    $metrics = "ERR: $($_.Exception.Message)"
  }
}

$ha = (($metrics -split "`n") | Where-Object { $_ -match 'cloudflared_tunnel_ha_connections' }) -join "`n"
$conns = Get-NetTCPConnection -OwningProcess $p.Id -ErrorAction SilentlyContinue |
  Where-Object { $_.RemotePort -eq 7844 } |
  Select-Object State, RemoteAddress |
  Format-Table -AutoSize | Out-String
$rawLog = @(
  Get-Content -LiteralPath $outLog -Raw -ErrorAction SilentlyContinue
  Get-Content -LiteralPath $errLog -Raw -ErrorAction SilentlyContinue
) -join "`n"
$url = ''
if ($rawLog) {
  $url = ([regex]::Matches($rawLog, 'https://[a-z0-9-]+\.trycloudflare\.com') | ForEach-Object { $_.Value } | Select-Object -Last 1)
}

Write-Output "PID=$($p.Id) ALIVE=$alive"
Write-Output "READY=$ready"
Write-Output "HA=$ha"
Write-Output "URL=$url"
Write-Output "CONNS=`n$conns"
Write-Output 'LOG_TAIL:'
Get-Content -LiteralPath $outLog -Tail 30 -ErrorAction SilentlyContinue
Get-Content -LiteralPath $errLog -Tail 30 -ErrorAction SilentlyContinue
