param(
    [string] $AgentRoot = $PSScriptRoot,
    [string] $NodePath = "node.exe",
    [int] $RestartDelaySeconds = 3
)

$ErrorActionPreference = "Stop"
$AgentRoot = (Resolve-Path -LiteralPath $AgentRoot).Path
$LogRoot = Join-Path $AgentRoot "logs"
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

while ($true) {
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath (Join-Path $LogRoot "supervisor.log") -Value "[$stamp] starting agent"
    $stdout = Join-Path $LogRoot "agent-service.log"
    $stderr = Join-Path $LogRoot "agent-service.err.log"
    $process = Start-Process -FilePath $NodePath `
        -ArgumentList @("agent.js") `
        -WorkingDirectory $AgentRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru
    $process.WaitForExit()
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath (Join-Path $LogRoot "supervisor.log") -Value "[$stamp] agent exited code=$($process.ExitCode); restarting in $RestartDelaySeconds second(s)"
    Start-Sleep -Seconds ([Math]::Max(1, $RestartDelaySeconds))
}
