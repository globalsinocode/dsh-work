# 联调冒烟：WeKnora 换票 API +（可选）dsh-work 配置探测
# 前置：WeKnora 在 http://localhost:8080 运行且已设置 DSH_WORK_INTEGRATION_SECRET；
# dsh-work server 已重启以加载 .env 中的 WEKNORA_*。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            Set-Item -Path "Env:$name" -Value $value
        }
    }
}

$secret = $env:WEKNORA_INTEGRATION_SECRET
$base = if ($env:WEKNORA_BASE_URL) { $env:WEKNORA_BASE_URL.TrimEnd('/') } else { "http://localhost:8080" }
if (-not $secret) {
    Write-Error "WEKNORA_INTEGRATION_SECRET 未在 .env 中配置"
}

Write-Host "== WeKnora health =="
(Invoke-WebRequest -Uri "$base/health" -UseBasicParsing).StatusCode | Write-Host

Write-Host "== 未配置密钥时应 404（对照）=="
try {
    Invoke-WebRequest -Uri "$base/api/v1/integrations/dsh-work/sessions" -Method POST -UseBasicParsing -Body '{}' -ContentType "application/json" | Out-Null
    Write-Warning "unexpected success without auth"
} catch {
    Write-Host $_.Exception.Response.StatusCode.value__
}

Write-Host "== 错误密钥 401 =="
try {
    Invoke-WebRequest -Uri "$base/api/v1/integrations/dsh-work/sessions" -Method POST -UseBasicParsing `
        -Headers @{ Authorization = "Bearer wrong" } -Body '{"user_id":"x"}' -ContentType "application/json" | Out-Null
} catch {
    Write-Host $_.Exception.Response.StatusCode.value__
}

$userId = $args[0]
if (-not $userId) {
    Write-Host "用法: .\scripts\dev\weknora-integration-smoke.ps1 <weknora_user_id>"
    Write-Host "跳过按 user_id 换票（请在 WeKnora 用户表查 id 后重跑）"
    exit 0
}

Write-Host "== 换票 user_id=$userId =="
$body = @{ user_id = $userId } | ConvertTo-Json
$r = Invoke-RestMethod -Uri "$base/api/v1/integrations/dsh-work/sessions" -Method POST `
    -Headers @{ Authorization = "Bearer $secret" } -ContentType "application/json" -Body $body
$r | ConvertTo-Json -Depth 3

Write-Host "== 用 access_token 拉知识库列表 =="
$kb = Invoke-RestMethod -Uri "$base/api/v1/knowledge-bases" -Headers @{ Authorization = "Bearer $($r.access_token)" }
$kbPayload = if ($null -ne $kb.data) { $kb.data } else { $kb }
Write-Host "knowledge_bases count:" @($kbPayload).Count

Write-Host "== bind-codes 开始 =="
$bindBody = @{
    redirect_uri = "http://localhost:4190/api/workbench/v1/integrations/weknora/bind/callback"
    state        = [Guid]::NewGuid().ToString("n")
} | ConvertTo-Json
$bind = Invoke-RestMethod -Uri "$base/api/v1/integrations/dsh-work/bind-codes" -Method POST `
    -Headers @{ Authorization = "Bearer $secret" } -ContentType "application/json" -Body $bindBody
Write-Host "打开浏览器完成绑定:" $bind.url
