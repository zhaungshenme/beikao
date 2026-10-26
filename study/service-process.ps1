function Get-StudyNode([string]$NodePath) {
    if ($NodePath) {
        $resolvedNode = [IO.Path]::GetFullPath($NodePath)
        if (-not (Test-Path -LiteralPath $resolvedNode -PathType Leaf)) { throw '指定的 Node.js 可执行文件不存在。' }
        return $resolvedNode
    }
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { throw '未找到 Node.js。请安装 Node.js 20.19+ 或 22.12+ 并加入 PATH，或使用 -NodePath 指定可执行文件。' }
    return $nodeCommand.Source
}

function Get-StudyRuntimeConfig([string]$StudyNode, [string]$ProjectRoot) {
    # Node emits UTF-8 JSON. Windows PowerShell 5.1 otherwise decodes native
    # stdout using the console code page, corrupting Chinese checkout/data paths.
    $previousConsoleEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
        $configJson = & $StudyNode (Join-Path $ProjectRoot 'study/runtime-config.mjs')
        $configExitCode = $LASTEXITCODE
    } finally {
        [Console]::OutputEncoding = $previousConsoleEncoding
    }
    if ($configExitCode -ne 0) { throw '本机服务配置或 Node.js 版本无效。' }
    return ($configJson | ConvertFrom-Json)
}

function ConvertTo-StudyUtcDateTime($Value) {
    if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
    # PowerShell 7 ConvertFrom-Json can already return a UTC DateTime. Parsing
    # its culture-formatted string again would discard Kind and the UTC offset.
    if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
    if ($Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)) {
        return [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime
    }
    throw 'Invalid service process start time.'
}

function Get-StudyOwnedProcess($ServiceInfo, [string]$ExpectedScript) {
    if ($null -eq $ServiceInfo -or $ServiceInfo.pid -isnot [ValueType] -or $ServiceInfo.pid -le 0) { return $null }
    $ownedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ServiceInfo.pid)" -ErrorAction SilentlyContinue
    if (-not $ownedProcess -or -not $ownedProcess.CommandLine) { return $null }
    # Check a complete script argument, not a substring of another checkout's name.
    $normalizedCommand = $ownedProcess.CommandLine.Replace('/', '\')
    $scriptPattern = '(?:^|[\s"])' + [regex]::Escape($ExpectedScript.Replace('/', '\')) + '(?:[\s"]|$)'
    if ($normalizedCommand -notmatch $scriptPattern) { return $null }
    $recordedStart = if ($ServiceInfo.processStartedAt) { $ServiceInfo.processStartedAt } else { $ServiceInfo.startedAt }
    if (-not $recordedStart -or -not $ownedProcess.CreationDate) { return $null }
    try {
        $actualStart = ConvertTo-StudyUtcDateTime $ownedProcess.CreationDate
        $expectedStart = ConvertTo-StudyUtcDateTime $recordedStart
        $startDelta = [Math]::Abs(($actualStart - $expectedStart).TotalSeconds)
        $startTolerance = if ($ServiceInfo.processStartedAt) { 2 } else { 15 }
        if ($startDelta -gt $startTolerance) { return $null }
    } catch { return $null }
    return $ownedProcess
}
