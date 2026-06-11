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
$InteractiveUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if (-not $InteractiveUser -or $InteractiveUser -match '\\SYSTEM$') {
    throw "Install this task from the interactive Windows user account, not SYSTEM."
}
$Action = New-ScheduledTaskAction `
    -Execute $PowerShell `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Supervisor`" -AgentRoot `"$AgentRoot`" -NodePath `"$NodePath`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $InteractiveUser
$Principal = New-ScheduledTaskPrincipal -UserId $InteractiveUser -RunLevel Highest -LogonType Interactive
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -WakeToRun:$WakeToRun.IsPresent

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Force | Out-Null

$AgentScript = Join-Path $AgentRoot "agent.js"
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($AgentScript) } |
    ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
Start-Sleep -Milliseconds 600
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed and started interactive scheduled task '$TaskName' for $InteractiveUser"
