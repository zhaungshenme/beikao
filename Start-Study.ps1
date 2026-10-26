param([string]$NodePath = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'study/service-process.ps1')
$studyNode = Get-StudyNode $NodePath
$runtime = Get-StudyRuntimeConfig $studyNode $PSScriptRoot
$studyRoot = Join-Path $PSScriptRoot 'study'
$expectedScript = [IO.Path]::GetFullPath((Join-Path $studyRoot 'serve.mjs'))
$serviceFile = Join-Path $runtime.dataDir 'service.json'
$runningService = Get-NetTCPConnection -State Listen -LocalPort $runtime.port -ErrorAction SilentlyContinue
if ($runningService) {
    $existing = if (Test-Path -LiteralPath $serviceFile) { Get-Content -LiteralPath $serviceFile -Raw | ConvertFrom-Json } else { $null }
    $ownedProcess = Get-StudyOwnedProcess $existing $expectedScript
    if ($ownedProcess -and $existing.running -and $existing.port -eq $runtime.port -and $existing.url -eq $runtime.url -and $runningService.OwningProcess -contains $ownedProcess.ProcessId) {
        Write-Output "本项目服务已运行：$($runtime.url)"
        exit 0
    }
    throw "端口 $($runtime.port) 已被其他服务占用；请核对现有进程或设置 STUDY_PORT 后重试。"
}
# Build on every explicit start, so an older build is not silently served after an update.
& $studyNode (Join-Path $studyRoot 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw '前端构建失败。首次使用请先在项目目录执行 npm ci。' }
New-Item -ItemType Directory -Force -Path $runtime.dataDir | Out-Null
$errorLog = Join-Path $runtime.dataDir 'service.stderr.log'
$studyProcess = Start-Process -FilePath $studyNode -ArgumentList @('"' + $expectedScript + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime.dataDir 'service.stdout.log') -RedirectStandardError $errorLog -PassThru
for ($check = 0; $check -lt 40; $check++) {
    Start-Sleep -Milliseconds 250
    $studyProcess.Refresh()
    if ($studyProcess.HasExited) { throw "启动失败，请检查 $errorLog。" }
    try {
        $response = Invoke-WebRequest -Uri ($runtime.origin + '/study-api/bridge/status') -UseBasicParsing -TimeoutSec 1
        if ($response.StatusCode -eq 200 -and (Test-Path -LiteralPath $serviceFile)) {
            $started = Get-Content -LiteralPath $serviceFile -Raw | ConvertFrom-Json
            if ($started.pid -eq $studyProcess.Id -and $started.running) { Write-Output "已启动：$($runtime.url)"; exit 0 }
        }
    } catch {}
}
throw "服务尚未就绪，未自动重复启动。请检查 $errorLog。"
