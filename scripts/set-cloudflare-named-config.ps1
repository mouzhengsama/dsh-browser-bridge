param(
    [Parameter(Mandatory = $true)]
    [string]$TunnelId,

    [Parameter(Mandatory = $true)]
    [string]$Hostname,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1024, 65535)]
    [int]$Port
)

$ErrorActionPreference = 'Stop'

$certificatePath = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
$certificate = Get-Content -LiteralPath $certificatePath -Raw
$encoded = ($certificate -replace '-----BEGIN ARGO TUNNEL TOKEN-----', '' -replace '-----END ARGO TUNNEL TOKEN-----', '').Trim()
$certificatePayload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json

$body = @{
    config = @{
        ingress = @(
            @{
                hostname = $Hostname
                service = "http://127.0.0.1:$Port"
            },
            @{
                service = 'http_status:404'
            }
        )
    }
} | ConvertTo-Json -Depth 10

$response = Invoke-RestMethod `
    -Method Put `
    -Uri "https://api.cloudflare.com/client/v4/accounts/$($certificatePayload.accountID)/cfd_tunnel/$TunnelId/configurations" `
    -Headers @{ Authorization = "Bearer $($certificatePayload.apiToken)" } `
    -ContentType 'application/json' `
    -Body $body

if (-not $response.success) {
    throw ($response.errors | ConvertTo-Json -Depth 10)
}

$response.result.config.ingress |
    Select-Object hostname, service |
    Format-Table -AutoSize
