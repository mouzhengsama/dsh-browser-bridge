param(
    [int]$ProcessId = 0
)

$ErrorActionPreference = 'Stop'

$desktopPath = 'D:\Program Files\DSH Desktop\DSH Desktop.exe'
if (-not (Test-Path -LiteralPath $desktopPath)) {
    throw "DSH Desktop executable not found: $desktopPath"
}

$mainProcesses = @(Get-CimInstance Win32_Process -Filter "name='DSH Desktop.exe'" |
    Where-Object { -not $_.CommandLine -or $_.CommandLine -notmatch '--type=' })

if ($ProcessId -gt 0) {
    $mainProcesses = @($mainProcesses | Where-Object ProcessId -eq $ProcessId)
}

foreach ($process in $mainProcesses) {
    Write-Host "Stopping DSH Desktop main process $($process.ProcessId)."
    Stop-Process -Id $process.ProcessId -Force
}

foreach ($process in $mainProcesses) {
    Wait-Process -Id $process.ProcessId -Timeout 15
}

Start-Sleep -Milliseconds 500
Start-Process -FilePath $desktopPath -WindowStyle Normal
Write-Host "Started DSH Desktop at $(Get-Date -Format o)."
