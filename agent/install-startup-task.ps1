param(
    [string] $TaskName = "DeviceSnapshotAgent",
    [string] $AgentRoot = $PSScriptRoot,
    [string] $NodePath = "node.exe",
    [switch] $WakeToRun
)

$ErrorActionPreference = "Stop"
$AgentRoot = (Resolve-Path -LiteralPath $AgentRoot).Path
$Supervisor = Join-Path $AgentRoot "agent-supervisor.ps1"
if (-not (Test-Path -LiteralPath $Supervisor)) {
    throw "agent-supervisor.ps1 not found at $Supervisor"
}

$PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$Action = New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Supervisor`" -AgentRoot `"$AgentRoot`" -NodePath `"$NodePath`""
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest -LogonType ServiceAccount
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -WakeToRun:$WakeToRun.IsPresent

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed and started scheduled task '$TaskName' for $AgentRoot"
