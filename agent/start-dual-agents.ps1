param(
    [string] $AgentRoot = $PSScriptRoot,
    [string] $NodePath = "node.exe",
    [string] $SecondaryInstanceRoot = "",
    [string] $SecondaryName = "Device Snapshot Lab",
    [switch] $InstallCurrentUserStartup
)

$ErrorActionPreference = "Stop"
$AgentRoot = (Resolve-Path -LiteralPath $AgentRoot).Path
$sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
if ($sessionId -le 0) {
    throw "Dual-agent launcher must run in an interactive Windows session, not Session $sessionId."
}

$Supervisor = Join-Path $AgentRoot "agent-supervisor.ps1"
$PrimaryConfig = Join-Path $AgentRoot "agent.config.json"
if (-not (Test-Path -LiteralPath $Supervisor)) {
    throw "agent-supervisor.ps1 not found at $Supervisor"
}
if (-not (Test-Path -LiteralPath $PrimaryConfig)) {
    throw "agent.config.json not found at $PrimaryConfig"
}

if (-not $SecondaryInstanceRoot) {
    $SecondaryInstanceRoot = Join-Path $AgentRoot "instances\agent-2"
}
New-Item -ItemType Directory -Force -Path $SecondaryInstanceRoot | Out-Null
$SecondaryInstanceRoot = (Resolve-Path -LiteralPath $SecondaryInstanceRoot).Path
$SecondaryConfig = Join-Path $SecondaryInstanceRoot "agent.config.json"

function Set-ConfigValue {
    param($Config, [string] $Name, $Value)
    if ($Config.PSObject.Properties.Name -contains $Name) {
        $Config.$Name = $Value
    } else {
        $Config | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    }
}

if (-not (Test-Path -LiteralPath $SecondaryConfig)) {
    $config = Get-Content -LiteralPath $PrimaryConfig -Raw | ConvertFrom-Json
    Set-ConfigValue $config "deviceName" $SecondaryName
    Set-ConfigValue $config "logDirectory" "./logs"
    Set-ConfigValue $config "fileTransferRoot" "./transfer"
    $json = ($config | ConvertTo-Json -Depth 20) + [Environment]::NewLine
    [System.IO.File]::WriteAllText($SecondaryConfig, $json, [System.Text.UTF8Encoding]::new($false))
}

function Start-AgentSupervisor {
    param([string] $InstanceRoot, [string] $InstanceName)
    $lockPath = Join-Path $InstanceRoot "agent.instance.lock"
    if (Test-Path -LiteralPath $lockPath) {
        try {
            $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
            $running = Get-Process -Id ([int] $lock.pid) -ErrorAction SilentlyContinue
            if ($running) {
                Write-Output "$InstanceName agent already running as PID $($lock.pid)."
                return
            }
        } catch {}
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
    $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Supervisor`" -AgentRoot `"$AgentRoot`" -InstanceRoot `"$InstanceRoot`" -InstanceName `"$InstanceName`" -NodePath `"$NodePath`""
    Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden
}

Start-AgentSupervisor -InstanceRoot $AgentRoot -InstanceName "stable"
Start-AgentSupervisor -InstanceRoot $SecondaryInstanceRoot -InstanceName "lab"

if ($InstallCurrentUserStartup) {
    $runPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $startupCommand = "`"$powerShell`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -AgentRoot `"$AgentRoot`" -NodePath `"$NodePath`""
    New-Item -Path $runPath -Force | Out-Null
    New-ItemProperty -Path $runPath -Name "DeviceSnapshotDualAgents" -Value $startupCommand -PropertyType String -Force | Out-Null
    Remove-ItemProperty -Path $runPath -Name "DeviceSnapshotAgent" -ErrorAction SilentlyContinue
}

Write-Output "Started stable and lab agent supervisors in Windows Session $sessionId."
Write-Output "Lab instance: $SecondaryInstanceRoot"
