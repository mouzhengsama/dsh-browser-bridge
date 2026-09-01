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

Add-Type -Namespace DshRestart -Name NativeWindow -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd,
    uint msg,
    IntPtr wParam,
    IntPtr lParam,
    uint flags,
    uint timeout,
    out IntPtr result);
'@

foreach ($process in $mainProcesses) {
    Write-Host "Requesting normal shutdown for DSH Desktop main process $($process.ProcessId)."
    if (-not [string]::IsNullOrEmpty([string]$process.MainWindowHandle)) {
        $result = [IntPtr]::Zero
        [void][DshRestart.NativeWindow]::SendMessageTimeout(
            [IntPtr]$process.MainWindowHandle,
            0x0010,
            [IntPtr]::Zero,
            [IntPtr]::Zero,
            2,
            5000,
            [ref]$result)
    } else {
        $liveProcess = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($liveProcess) {
            if (-not $liveProcess.CloseMainWindow()) {
                & taskkill /PID $process.ProcessId | Out-Null
            }
        }
    }
}

$remaining = @($mainProcesses | Select-Object -ExpandProperty ProcessId)
$deadline = (Get-Date).AddSeconds(25)
while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $remaining = @($remaining | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
}

foreach ($processId in $remaining) {
    Write-Warning "DSH Desktop main process $processId did not exit normally; forcing shutdown."
    Stop-Process -Id $processId -Force
    Wait-Process -Id $processId -Timeout 15
}

Start-Sleep -Milliseconds 500
Start-Process -FilePath $desktopPath -WindowStyle Normal
Write-Host "Started DSH Desktop at $(Get-Date -Format o)."
