param(
    [string] $AgentRoot = $PSScriptRoot,
    [string] $InstanceRoot = "",
    [string] $InstanceName = "primary",
    [string] $NodePath = "node.exe",
    [int] $RestartDelaySeconds = 3
)

$ErrorActionPreference = "Stop"
$AgentRoot = (Resolve-Path -LiteralPath $AgentRoot).Path
if (-not $InstanceRoot) {
    $InstanceRoot = $AgentRoot
}
if (-not (Test-Path -LiteralPath $InstanceRoot)) {
    New-Item -ItemType Directory -Force -Path $InstanceRoot | Out-Null
}
$InstanceRoot = (Resolve-Path -LiteralPath $InstanceRoot).Path
$LogRoot = Join-Path $InstanceRoot "logs"
$AgentScript = Join-Path $AgentRoot "agent.js"
$ConfigPath = Join-Path $InstanceRoot "agent.config.json"
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

if (-not (Test-Path -LiteralPath $AgentScript)) {
    throw "agent.js not found at $AgentScript"
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "agent.config.json not found at $ConfigPath"
}

$sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
if ($sessionId -le 0) {
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath (Join-Path $LogRoot "supervisor.log") -Value "[$stamp] $InstanceName refused to start in Windows Session $sessionId"
    throw "Agent supervisor must run in an interactive Windows session. Session $sessionId cannot capture or control the signed-in desktop."
}

while ($true) {
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath (Join-Path $LogRoot "supervisor.log") -Value "[$stamp] starting $InstanceName in Windows Session $sessionId"
    $stdout = Join-Path $LogRoot "agent-service.log"
    $stderr = Join-Path $LogRoot "agent-service.err.log"
    $process = Start-Process -FilePath $NodePath `
        -ArgumentList @("`"$AgentScript`"") `
        -WorkingDirectory $InstanceRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru
    $process.WaitForExit()
    $process.Refresh()
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $recentError = if (Test-Path -LiteralPath $stderr) {
        (Get-Content -LiteralPath $stderr -Tail 30 -ErrorAction SilentlyContinue) -join "`n"
    } else {
        ""
    }
    if ($recentError -match "Another local agent process is already running|superseded by a newer boot") {
        Add-Content -LiteralPath (Join-Path $LogRoot "supervisor.log") -Value "[$stamp] $InstanceName duplicate or superseded agent detected; supervisor stopping instead of restart-loop"
        break
    }
    Add-Content -LiteralPath (Join-Path $LogRoot "supervisor.log") -Value "[$stamp] $InstanceName exited code=$($process.ExitCode); restarting in $RestartDelaySeconds second(s)"
    Start-Sleep -Seconds ([Math]::Max(1, $RestartDelaySeconds))
}
