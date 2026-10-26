param(
    [ValidateSet('Start', 'Stop')][string]$Action = 'Start',
    [string]$NodePath = '',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

try {
    Set-Location -LiteralPath $projectRoot
    . (Join-Path $PSScriptRoot 'service-process.ps1')
    $studyNode = Get-StudyNode $NodePath
    $runtime = Get-StudyRuntimeConfig $studyNode $projectRoot
    if ($Action -eq 'Start') {
        foreach ($dependency in @('vite', 'vue')) {
            if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules/$dependency/package.json") -PathType Leaf)) {
                throw '首次使用需要准备项目依赖：在此文件夹的地址栏输入 cmd 并回车，再输入 npm ci。完成后重新双击“启动备考.cmd”。'
            }
        }
        Write-Host '正在启动备考，首次构建可能需要一些时间，请保留此窗口……'
    }

    # Start/Stop scripts use exit; run them in a child so readiness and browser
    # handling below still execute. Bypass applies only to this child process.
    $shellName = if ($PSVersionTable.PSVersion.Major -ge 6) { 'pwsh.exe' } else { 'powershell.exe' }
    $shell = Join-Path $PSHOME $shellName
    $serviceScript = Join-Path $projectRoot ($Action + '-Study.ps1')
    & $shell -NoProfile -ExecutionPolicy Bypass -File $serviceScript -NodePath $studyNode
    if ($LASTEXITCODE -ne 0) { throw '操作未完成，请查看上面的错误信息。' }

    if ($Action -eq 'Start') {
        $page = Invoke-WebRequest -Uri $runtime.url -UseBasicParsing -TimeoutSec 5
        if ($page.StatusCode -ne 200) { throw '服务尚未准备好，请稍后重新双击启动。' }
        Write-Host "学习网站：$($runtime.url)"
        Write-Host 'AI 解析可在网站的学习设置中配置自己的模型 API。'
        Write-Host '关掉此窗口或浏览器不会停止服务；停止服务请双击“停止备考.cmd”。'
        if (-not $NoBrowser) {
            try { Start-Process -FilePath $runtime.url }
            catch { Write-Host '网站已启动，但浏览器未能自动打开。请复制上面的学习网站地址到浏览器。' }
        }
    }
    exit 0
} catch {
    Write-Host ''
    Write-Host '备考未能完成操作：' -ForegroundColor Red
    Write-Host $_.Exception.Message
    Write-Host "项目文件夹：$projectRoot"
    Write-Host '首次安装说明见 study\README.md。未找到 Node.js 时，请从 https://nodejs.org/ 安装当前 LTS，完成后重新打开启动入口。'
    exit 1
}
