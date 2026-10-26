param([string]$NodePath = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'study/service-process.ps1')
$studyNode = Get-StudyNode $NodePath
$runtime = Get-StudyRuntimeConfig $studyNode $PSScriptRoot
$serviceFile = Join-Path $runtime.dataDir 'service.json'
if (-not (Test-Path -LiteralPath $serviceFile)) { Write-Output '没有此数据目录的运行记录。'; exit 0 }
$serviceInfo = Get-Content -LiteralPath $serviceFile -Raw | ConvertFrom-Json
$expectedScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'study/serve.mjs'))
$studyProcess = Get-StudyOwnedProcess $serviceInfo $expectedScript
if ($studyProcess) {
    Stop-Process -Id $studyProcess.ProcessId
    $serviceInfo | Add-Member -NotePropertyName running -NotePropertyValue $false -Force
    $serviceInfo | Add-Member -NotePropertyName stoppedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    $serviceInfo | ConvertTo-Json | Set-Content -LiteralPath $serviceFile -Encoding UTF8
    Write-Output '已停止此项目和数据目录的学习服务，学习记录保留。'
} else { Write-Output '服务已停止或进程身份已变化，未停止其他进程。' }
