param(
    [string] $AgentRoot = $PSScriptRoot,
    [string] $NodePath = "node.exe",
    [int] $RestartDelaySeconds = 3
)

$ErrorActionPreference = "Stop"
$AgentRoot = (Resolve-Path -LiteralPath $AgentRoot).Path
$LogRoot = Join-Path $AgentRoot "logs"
$AgentScript = Join-Path $AgentRoot "agent.js"
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

if (-not (Test-Path -LiteralPath $AgentScript)) {
    throw "agent.js not found at $AgentScript"
}

while ($true) {
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath (Join-Path $LogRoot "supervisor.log") -Value "[$stamp] starting agent"
    $stdout = Join-Path $LogRoot "agent-service.log"
    $stderr = Join-Path $LogRoot "agent-service.err.log"
    $process = Start-Process -FilePath $NodePath `
        -ArgumentList @("`"$AgentScript`"") `
        -WorkingDirectory $AgentRoot `
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
        Add-Content -LiteralPath (Join-Path $LogRoot "supervisor.log") -Value "[$stamp] duplicate agent detected; supervisor stopping instead of restart-loop"
        break
    }
    Add-Content -LiteralPath (Join-Path $LogRoot "supervisor.log") -Value "[$stamp] agent exited code=$($process.ExitCode); restarting in $RestartDelaySeconds second(s)"
    Start-Sleep -Seconds ([Math]::Max(1, $RestartDelaySeconds))
}
