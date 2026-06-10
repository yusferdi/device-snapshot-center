param(
    [string] $AgentRoot = $PSScriptRoot,
    [string] $TaskName = "DeviceSnapshotAgent",
    [switch] $SelfTest,
    [switch] $SmokeStartStop
)

$ErrorActionPreference = "Stop"
$AgentRoot = (Resolve-Path -LiteralPath $AgentRoot).Path
$ConfigPath = Join-Path $AgentRoot "agent.config.json"
$ExampleConfigPath = Join-Path $AgentRoot "agent.config.example.json"
$RuntimeRoot = Join-Path $AgentRoot "runtime"
$LogRoot = Join-Path $AgentRoot "logs"
$NodeRuntimeRoot = Join-Path $RuntimeRoot "node"
$NativeStatePath = Join-Path $AgentRoot "agent-native.state.json"

function Ensure-Directory {
    param([string] $Path)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-JsonFile {
    param([string] $Path, [object] $Fallback = $null)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $Fallback
    }
    $raw = Get-Content -Raw -LiteralPath $Path
    if (-not $raw.Trim()) {
        return $Fallback
    }
    return $raw | ConvertFrom-Json
}

function Set-JsonProperty {
    param([object] $Object, [string] $Name, [object] $Value)
    if ($Object.PSObject.Properties.Name -contains $Name) {
        $Object.$Name = $Value
    } else {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Save-JsonFile {
    param([string] $Path, [object] $Value)
    $json = $Value | ConvertTo-Json -Depth 32
    Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

function Get-NativeState {
    return Get-JsonFile -Path $NativeStatePath -Fallback ([pscustomobject]@{})
}

function Save-NativeState {
    param([object] $State)
    Save-JsonFile -Path $NativeStatePath -Value $State
}

function Get-AgentConfig {
    $example = Get-JsonFile -Path $ExampleConfigPath -Fallback ([pscustomobject]@{})
    $local = Get-JsonFile -Path $ConfigPath -Fallback ([pscustomobject]@{})
    $merged = [pscustomobject]@{}
    foreach ($prop in $example.PSObject.Properties) {
        Set-JsonProperty $merged $prop.Name $prop.Value
    }
    foreach ($prop in $local.PSObject.Properties) {
        Set-JsonProperty $merged $prop.Name $prop.Value
    }
    return $merged
}

function Get-NodePath {
    if ($env:DEVICE_SNAPSHOT_NODE -and (Test-Path -LiteralPath $env:DEVICE_SNAPSHOT_NODE)) {
        return (Resolve-Path -LiteralPath $env:DEVICE_SNAPSHOT_NODE).Path
    }
    $bundled = @(
        (Join-Path $NodeRuntimeRoot "node.exe")
    ) + @(Get-ChildItem -Path $NodeRuntimeRoot -Filter node.exe -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    foreach ($candidate in $bundled) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    return $null
}

function Get-NpmPath {
    param([string] $NodePath)
    if ($NodePath) {
        $localNpm = Join-Path (Split-Path -Parent $NodePath) "npm.cmd"
        if (Test-Path -LiteralPath $localNpm) {
            return $localNpm
        }
    }
    $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    return $null
}

function Invoke-HiddenProcess {
    param(
        [string] $FilePath,
        [string[]] $ArgumentList,
        [string] $WorkingDirectory = $AgentRoot,
        [string] $Stdout = "",
        [string] $Stderr = "",
        [switch] $Wait
    )
    $params = @{
        FilePath = $FilePath
        ArgumentList = $ArgumentList
        WorkingDirectory = $WorkingDirectory
        WindowStyle = "Hidden"
        PassThru = $true
    }
    if ($Stdout) { $params.RedirectStandardOutput = $Stdout }
    if ($Stderr) { $params.RedirectStandardError = $Stderr }
    $process = Start-Process @params
    if ($Wait) {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "$FilePath exited with code $($process.ExitCode)."
        }
    }
    return $process
}

function Install-PortableNode {
    Ensure-Directory $RuntimeRoot
    Ensure-Directory $LogRoot
    $indexUrl = "https://nodejs.org/dist/index.json"
    $index = Invoke-RestMethod -Uri $indexUrl -UseBasicParsing
    $release = $index | Where-Object {
        $_.lts -and ($_.files -contains "win-x64-zip")
    } | Select-Object -First 1
    if (-not $release) {
        throw "Could not find a Windows x64 LTS Node.js release from nodejs.org."
    }

    $version = [string] $release.version
    $zipUrl = "https://nodejs.org/dist/$version/node-$version-win-x64.zip"
    $zipPath = Join-Path $env:TEMP "device-snapshot-node-$version-win-x64.zip"
    $extractPath = Join-Path $RuntimeRoot ("node-extract-" + [guid]::NewGuid().ToString("N"))
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
    $folder = Get-ChildItem -Path $extractPath -Directory | Select-Object -First 1
    if (-not $folder) {
        throw "Node.js archive did not contain an extracted folder."
    }

    $resolvedRuntime = (Resolve-Path -LiteralPath $RuntimeRoot).Path
    $target = Join-Path $RuntimeRoot "node"
    if ((Test-Path -LiteralPath $target) -and ((Resolve-Path -LiteralPath $target).Path.StartsWith($resolvedRuntime))) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    Move-Item -LiteralPath $folder.FullName -Destination $target
    Remove-Item -LiteralPath $extractPath -Recurse -Force
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue

    $node = Join-Path $target "node.exe"
    if (-not (Test-Path -LiteralPath $node)) {
        throw "Downloaded Node.js but node.exe was not found."
    }
    return $node
}

function Install-AgentDependencies {
    param([string] $NodePath)
    Ensure-Directory $LogRoot
    $npm = Get-NpmPath -NodePath $NodePath
    if (-not $npm) {
        throw "npm.cmd was not found. Install or download Node.js first."
    }
    Invoke-HiddenProcess `
        -FilePath $npm `
        -ArgumentList @("install", "--omit=dev") `
        -WorkingDirectory $AgentRoot `
        -Stdout (Join-Path $LogRoot "npm-install.log") `
        -Stderr (Join-Path $LogRoot "npm-install.err.log") `
        -Wait | Out-Null
}

function Get-AgentProcesses {
    if ($PSVersionTable.PSVersion.Major -lt 3) {
        return @()
    }
    $items = @()
    $agentScript = Join-Path $AgentRoot "agent.js"
    try {
        $items = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.CommandLine -and
            $_.CommandLine.Contains("agent.js") -and
            (
                $_.CommandLine.Contains($AgentRoot) -or
                $_.CommandLine.Contains($agentScript)
            ) -and
            -not $_.CommandLine.Contains("agent-manager.js") -and
            -not $_.CommandLine.Contains("native-manager.ps1")
        } | Select-Object ProcessId, Name, CommandLine)
    } catch {
        $items = @()
    }

    $seen = @{}
    foreach ($item in $items) {
        $seen[[int] $item.ProcessId] = $true
    }

    $state = Get-NativeState
    $statePid = 0
    if ($state.PSObject.Properties.Name -contains "AgentPid") {
        $statePid = [int] $state.AgentPid
    }
    if ($statePid -gt 0 -and -not $seen.ContainsKey($statePid)) {
        $process = Get-Process -Id $statePid -ErrorAction SilentlyContinue
        if ($process -and -not $process.HasExited) {
            $items += [pscustomobject]@{
                ProcessId = $process.Id
                Name = $process.ProcessName
                CommandLine = "tracked by native manager state"
            }
        }
    }
    return @($items)
}

function Start-AgentProcess {
    param([string] $NodePath)
    if (-not $NodePath) {
        throw "Node.js was not found. Click Bootstrap Node + Dependencies first."
    }
    Ensure-Directory $LogRoot
    $alreadyRunning = @(Get-AgentProcesses)
    if ($alreadyRunning.Count -gt 0) {
        return [pscustomobject]@{
            Started = $false
            Pid = [int] $alreadyRunning[0].ProcessId
            Message = "Agent already running."
        }
    }
    $agentScript = Join-Path $AgentRoot "agent.js"
    $process = Invoke-HiddenProcess `
        -FilePath $NodePath `
        -ArgumentList @("`"$agentScript`"") `
        -WorkingDirectory $AgentRoot `
        -Stdout (Join-Path $LogRoot "agent-native.log") `
        -Stderr (Join-Path $LogRoot "agent-native.err.log")
    Save-NativeState ([pscustomobject]@{
        AgentPid = [int] $process.Id
        NodePath = $NodePath
        StartedAt = (Get-Date).ToString("o")
    })
    Start-Sleep -Milliseconds 700
    $process.Refresh()
    if ($process.HasExited) {
        Save-NativeState ([pscustomobject]@{
            AgentPid = 0
            LastExitCode = $process.ExitCode
            LastExitAt = (Get-Date).ToString("o")
        })
        throw "Agent exited immediately with code $($process.ExitCode). Check Logs > agent-native.err.log."
    }
    return [pscustomobject]@{
        Started = $true
        Pid = [int] $process.Id
        Message = "Agent started."
    }
}

function Stop-AgentProcess {
    $processes = @(Get-AgentProcesses)
    foreach ($item in $processes) {
        taskkill.exe /PID $item.ProcessId /T /F | Out-Null
    }
    Save-NativeState ([pscustomobject]@{
        AgentPid = 0
        StoppedAt = (Get-Date).ToString("o")
    })
    return $processes.Count
}

function Get-TaskStatus {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        return [pscustomobject]@{
            Installed = $false
            State = "Not installed"
            UserId = ""
            WakeToRun = $false
        }
    }
    return [pscustomobject]@{
        Installed = $true
        State = [string] $task.State
        UserId = [string] $task.Principal.UserId
        WakeToRun = [bool] $task.Settings.WakeToRun
    }
}

function Install-AgentTask {
    param([string] $NodePath, [bool] $WakeToRun)
    if (-not (Test-IsAdmin)) {
        throw "Installing the startup task requires PowerShell as Administrator."
    }
    $supervisor = Join-Path $AgentRoot "agent-supervisor.ps1"
    if (-not (Test-Path -LiteralPath $supervisor)) {
        throw "agent-supervisor.ps1 not found at $supervisor"
    }

    $powerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $action = New-ScheduledTaskAction `
        -Execute $powerShell `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisor`" -AgentRoot `"$AgentRoot`" -NodePath `"$NodePath`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest -LogonType ServiceAccount
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -StartWhenAvailable `
        -WakeToRun:$WakeToRun

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    $installed = Get-TaskStatus
    if (-not $installed.Installed) {
        throw "Scheduled Task was not found after install."
    }
    return "Installed $TaskName as SYSTEM and started it."
}

function Install-PermanentStartupFromForm {
    $script:TaskName = $taskNameBox.Text.Trim()
    if (-not $script:TaskName) {
        $script:TaskName = "DeviceSnapshotAgent"
    }
    $node = if ($nodePathBox.Text.Trim()) { $nodePathBox.Text.Trim() } else { Get-NodePath }
    if (-not $node) {
        $node = Install-PortableNode
        Install-AgentDependencies -NodePath $node
    }
    Install-AgentTask -NodePath $node -WakeToRun ([bool] $wakeBox.Checked)
}

function Open-ServerDashboard {
    $config = Get-AgentConfig
    $url = [string] $config.serverUri
    if (-not $url) {
        throw "serverUri is empty."
    }
    Start-Process $url
}

function Invoke-TaskAction {
    param([string] $Action)
    if (-not (Test-IsAdmin)) {
        throw "Task Scheduler changes require PowerShell as Administrator."
    }
    switch ($Action) {
        "start" { Start-ScheduledTask -TaskName $TaskName }
        "stop" { Stop-ScheduledTask -TaskName $TaskName }
        "uninstall" {
            if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
                Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
                Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            }
        }
        default { throw "Unknown task action: $Action" }
    }
}

function Get-LogTail {
    param([string] $FileName)
    $allowed = @(
        "agent-native.log",
        "agent-native.err.log",
        "agent-service.log",
        "agent-service.err.log",
        "supervisor.log",
        "npm-install.log",
        "npm-install.err.log"
    )
    if ($allowed -notcontains $FileName) {
        $FileName = "agent-native.log"
    }
    $filePath = Join-Path $LogRoot $FileName
    if (-not (Test-Path -LiteralPath $filePath)) {
        return ""
    }
    return (Get-Content -LiteralPath $filePath -Tail 160 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
}

if ($SelfTest) {
    $config = Get-AgentConfig
    [pscustomobject]@{
        ok = $true
        agentRoot = $AgentRoot
        nodePath = Get-NodePath
        npmPath = Get-NpmPath -NodePath (Get-NodePath)
        serverUri = $config.serverUri
        task = Get-TaskStatus
        agentProcesses = @(Get-AgentProcesses).Count
        isAdmin = Test-IsAdmin
    } | ConvertTo-Json -Depth 6
    exit 0
}

if ($SmokeStartStop) {
    $before = @(Get-AgentProcesses)
    if ($before.Count -gt 0) {
        [pscustomobject]@{
            ok = $true
            skipped = $true
            reason = "Agent was already running; smoke test did not stop existing process."
            pids = @($before | ForEach-Object { $_.ProcessId })
        } | ConvertTo-Json -Depth 4
        exit 0
    }

    $node = Get-NodePath
    if (-not $node) {
        throw "Node.js was not found. Cannot run smoke start/stop."
    }
    $started = Start-AgentProcess -NodePath $node
    Start-Sleep -Milliseconds 800
    $running = @(Get-AgentProcesses)
    $stopped = Stop-AgentProcess
    Start-Sleep -Milliseconds 500
    $after = @(Get-AgentProcesses)
    [pscustomobject]@{
        ok = ($running.Count -gt 0 -and $after.Count -eq 0)
        startedPid = $started.Pid
        detectedPids = @($running | ForEach-Object { $_.ProcessId })
        stopped = $stopped
        remaining = $after.Count
    } | ConvertTo-Json -Depth 4
    if ($running.Count -lt 1 -or $after.Count -gt 0) {
        exit 1
    }
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$ColorCanvas = [System.Drawing.Color]::FromArgb(243, 246, 250)
$ColorSurface = [System.Drawing.Color]::FromArgb(255, 255, 255)
$ColorSurfaceAlt = [System.Drawing.Color]::FromArgb(249, 251, 253)
$ColorText = [System.Drawing.Color]::FromArgb(24, 32, 47)
$ColorMuted = [System.Drawing.Color]::FromArgb(88, 101, 118)
$ColorBorder = [System.Drawing.Color]::FromArgb(218, 225, 235)
$ColorBlue = [System.Drawing.Color]::FromArgb(47, 111, 237)
$ColorTeal = [System.Drawing.Color]::FromArgb(15, 145, 136)
$ColorAmber = [System.Drawing.Color]::FromArgb(194, 124, 28)
$ColorRed = [System.Drawing.Color]::FromArgb(201, 66, 66)
$ColorGreenSoft = [System.Drawing.Color]::FromArgb(229, 247, 242)
$ColorAmberSoft = [System.Drawing.Color]::FromArgb(255, 246, 229)
$ColorRedSoft = [System.Drawing.Color]::FromArgb(255, 235, 235)
$ColorBlueSoft = [System.Drawing.Color]::FromArgb(232, 240, 255)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Device Snapshot Agent Manager"
$form.StartPosition = "CenterScreen"
$form.MinimumSize = New-Object System.Drawing.Size(1040, 720)
$form.Size = New-Object System.Drawing.Size(1180, 820)
$form.BackColor = $ColorCanvas
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = "Fill"
$root.RowCount = 3
$root.ColumnCount = 1
$root.Padding = New-Object System.Windows.Forms.Padding(14)
$root.BackColor = $ColorCanvas
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 104))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 32))) | Out-Null
$form.Controls.Add($root)

$header = New-Object System.Windows.Forms.TableLayoutPanel
$header.Dock = "Fill"
$header.ColumnCount = 2
$header.RowCount = 2
$header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 45))) | Out-Null
$header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 55))) | Out-Null
$header.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 46))) | Out-Null
$header.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 32))) | Out-Null
$header.BackColor = $ColorCanvas
$root.Controls.Add($header, 0, 0)

$title = New-Object System.Windows.Forms.Label
$title.Text = "Device Snapshot Agent Manager"
$title.Dock = "Fill"
$title.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 20)
$title.ForeColor = $ColorText
$header.Controls.Add($title, 0, 0)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = "Runtime bootstrap, live config, permanent unattended startup, and diagnostics"
$subtitle.Dock = "Fill"
$subtitle.ForeColor = $ColorMuted
$header.Controls.Add($subtitle, 0, 1)

$statusPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$statusPanel.Dock = "Fill"
$statusPanel.FlowDirection = "LeftToRight"
$statusPanel.WrapContents = $true
$statusPanel.Anchor = "Right"
$header.Controls.Add($statusPanel, 1, 0)
$header.SetRowSpan($statusPanel, 2)

function New-StatusLabel {
    param([string] $Text)
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Text
    $label.AutoSize = $false
    $label.Width = 205
    $label.Height = 40
    $label.Margin = New-Object System.Windows.Forms.Padding(5, 8, 5, 5)
    $label.TextAlign = "MiddleCenter"
    $label.BackColor = $ColorSurface
    $label.ForeColor = $ColorMuted
    $label.BorderStyle = "FixedSingle"
    $label.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
    return $label
}

function Set-StatusLabel {
    param(
        [System.Windows.Forms.Label] $Label,
        [string] $Text,
        [string] $Tone = "neutral"
    )
    $Label.Text = $Text
    switch ($Tone) {
        "good" {
            $Label.BackColor = $ColorGreenSoft
            $Label.ForeColor = $ColorTeal
        }
        "warn" {
            $Label.BackColor = $ColorAmberSoft
            $Label.ForeColor = $ColorAmber
        }
        "bad" {
            $Label.BackColor = $ColorRedSoft
            $Label.ForeColor = $ColorRed
        }
        "info" {
            $Label.BackColor = $ColorBlueSoft
            $Label.ForeColor = $ColorBlue
        }
        default {
            $Label.BackColor = $ColorSurface
            $Label.ForeColor = $ColorMuted
        }
    }
}

$nodeStatus = New-StatusLabel "Node: checking"
$agentStatus = New-StatusLabel "Agent: checking"
$taskStatus = New-StatusLabel "Task: checking"
$adminStatus = New-StatusLabel ("Admin: " + ($(if (Test-IsAdmin) { "yes" } else { "no" })))
$statusPanel.Controls.AddRange(@($nodeStatus, $agentStatus, $taskStatus, $adminStatus))

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = "Fill"
$root.Controls.Add($tabs, 0, 1)

function New-Tab {
    param([string] $Title)
    $tab = New-Object System.Windows.Forms.TabPage
    $tab.Text = $Title
    $tab.BackColor = $ColorCanvas
    $tabs.TabPages.Add($tab) | Out-Null
    return $tab
}

function New-Button {
    param([string] $Text, [string] $Tone = "default", [int] $Width = 178)
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $Text
    $button.Width = $Width
    $button.Height = 42
    $button.Margin = New-Object System.Windows.Forms.Padding(8)
    $button.FlatStyle = "Flat"
    $button.FlatAppearance.BorderSize = 1
    $button.FlatAppearance.BorderColor = $ColorBorder
    $button.UseVisualStyleBackColor = $false
    $button.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)
    switch ($Tone) {
        "primary" {
            $button.BackColor = $ColorBlue
            $button.ForeColor = [System.Drawing.Color]::White
            $button.FlatAppearance.BorderColor = $ColorBlue
        }
        "success" {
            $button.BackColor = $ColorTeal
            $button.ForeColor = [System.Drawing.Color]::White
            $button.FlatAppearance.BorderColor = $ColorTeal
        }
        "danger" {
            $button.BackColor = $ColorRed
            $button.ForeColor = [System.Drawing.Color]::White
            $button.FlatAppearance.BorderColor = $ColorRed
        }
        "warning" {
            $button.BackColor = $ColorAmber
            $button.ForeColor = [System.Drawing.Color]::White
            $button.FlatAppearance.BorderColor = $ColorAmber
        }
        default {
            $button.BackColor = $ColorSurface
            $button.ForeColor = $ColorText
        }
    }
    return $button
}

function New-Field {
    param([System.Windows.Forms.Control] $Parent, [string] $LabelText, [System.Windows.Forms.Control] $Control)
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $LabelText
    $label.Width = 170
    $label.Height = 28
    $label.Margin = New-Object System.Windows.Forms.Padding(8, 10, 4, 4)
    $label.TextAlign = "MiddleLeft"
    $label.ForeColor = $ColorMuted
    $Control.Width = 420
    $Control.Height = 28
    $Control.Margin = New-Object System.Windows.Forms.Padding(4, 8, 8, 4)
    $Control.BackColor = $ColorSurface
    $Control.ForeColor = $ColorText
    $Parent.Controls.Add($label)
    $Parent.Controls.Add($Control)
}

function New-Card {
    param([string] $Title, [string] $Body, [int] $Width = 320, [int] $Height = 150)
    $card = New-Object System.Windows.Forms.GroupBox
    $card.Text = $Title
    $card.Width = $Width
    $card.Height = $Height
    $card.Margin = New-Object System.Windows.Forms.Padding(8)
    $card.Padding = New-Object System.Windows.Forms.Padding(14, 18, 14, 12)
    $card.BackColor = $ColorSurface
    $card.ForeColor = $ColorText
    $card.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9)

    $layout = New-Object System.Windows.Forms.TableLayoutPanel
    $layout.Dock = "Fill"
    $layout.RowCount = 2
    $layout.ColumnCount = 1
    $layout.BackColor = $ColorSurface
    $layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
    $layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 48))) | Out-Null

    $bodyLabel = New-Object System.Windows.Forms.Label
    $bodyLabel.Text = $Body
    $bodyLabel.Dock = "Fill"
    $bodyLabel.ForeColor = $ColorMuted
    $bodyLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
    $layout.Controls.Add($bodyLabel, 0, 0)
    $card.Controls.Add($layout)

    return [pscustomobject]@{
        Card = $card
        Layout = $layout
    }
}

function Add-CardButton {
    param([object] $CardInfo, [System.Windows.Forms.Button] $Button)
    $Button.Dock = "Fill"
    $Button.Margin = New-Object System.Windows.Forms.Padding(0, 8, 0, 0)
    $CardInfo.Layout.Controls.Add($Button, 0, 1)
}

$overviewTab = New-Tab "Overview"
$configTab = New-Tab "Config"
$schedulerTab = New-Tab "Scheduler"
$logsTab = New-Tab "Logs"

$overviewFlow = New-Object System.Windows.Forms.FlowLayoutPanel
$overviewFlow.Dock = "Fill"
$overviewFlow.Padding = New-Object System.Windows.Forms.Padding(20)
$overviewFlow.AutoScroll = $true
$overviewFlow.BackColor = $ColorCanvas
$overviewTab.Controls.Add($overviewFlow)

$runtimeCard = New-Card `
    -Title "1. Runtime" `
    -Body "Download Node.js portable if needed, then install agent dependencies. This is the first step on a fresh device." `
    -Width 335 `
    -Height 160
$configCard = New-Card `
    -Title "2. Config & Run" `
    -Body "Save the production server config, then start or restart the local agent process for this session." `
    -Width 335 `
    -Height 160
$startupCard = New-Card `
    -Title "3. Permanent Startup" `
    -Body "Install a SYSTEM Scheduled Task so the agent starts at boot before Windows logon and restarts if it exits." `
    -Width 360 `
    -Height 160

$bootstrapButton = New-Button "Bootstrap Node + Dependencies" "primary" 285
$startButton = New-Button "Start Agent" "success" 285
$quickPermanentButton = New-Button "Make Permanent Startup (SYSTEM)" "warning" 305
Add-CardButton $runtimeCard $bootstrapButton
Add-CardButton $configCard $startButton
Add-CardButton $startupCard $quickPermanentButton
$overviewFlow.Controls.AddRange(@($runtimeCard.Card, $configCard.Card, $startupCard.Card))

$quickActionsPanel = New-Object System.Windows.Forms.GroupBox
$quickActionsPanel.Text = "Daily Controls"
$quickActionsPanel.Width = 1060
$quickActionsPanel.Height = 98
$quickActionsPanel.Margin = New-Object System.Windows.Forms.Padding(8, 16, 8, 8)
$quickActionsPanel.Padding = New-Object System.Windows.Forms.Padding(12, 18, 12, 12)
$quickActionsPanel.BackColor = $ColorSurface
$quickActionsPanel.ForeColor = $ColorText

$quickActionsFlow = New-Object System.Windows.Forms.FlowLayoutPanel
$quickActionsFlow.Dock = "Fill"
$quickActionsFlow.BackColor = $ColorSurface
$quickActionsPanel.Controls.Add($quickActionsFlow)

$installNodeButton = New-Button "Download Node.js" "default" 165
$installDepsButton = New-Button "Install npm Dependencies" "default" 210
$stopButton = New-Button "Stop Agent" "danger" 150
$restartButton = New-Button "Restart Agent" "default" 165
$refreshButton = New-Button "Refresh Status" "default" 160
$openDashboardButton = New-Button "Open Server Dashboard" "default" 205
$quickActionsFlow.Controls.AddRange(@(
    $installNodeButton,
    $installDepsButton,
    $stopButton,
    $restartButton,
    $refreshButton,
    $openDashboardButton
))
$overviewFlow.Controls.Add($quickActionsPanel)

$note = New-Object System.Windows.Forms.TextBox
$note.Multiline = $true
$note.ReadOnly = $true
$note.Width = 1060
$note.Height = 100
$note.Margin = New-Object System.Windows.Forms.Padding(8, 12, 8, 8)
$note.BorderStyle = "FixedSingle"
$note.BackColor = $ColorBlueSoft
$note.ForeColor = $ColorText
$note.Text = "Sleep/hibernate note: Windows stops CPU and network execution during true sleep/hibernate. This manager can make the agent start before login as SYSTEM, resume after wake, restart automatically, prevent sleep while running, and request wake timers when Windows and hardware allow it."
$overviewFlow.Controls.Add($note)

$configFlow = New-Object System.Windows.Forms.FlowLayoutPanel
$configFlow.Dock = "Fill"
$configFlow.Padding = New-Object System.Windows.Forms.Padding(20)
$configFlow.AutoScroll = $true
$configFlow.FlowDirection = "LeftToRight"
$configFlow.BackColor = $ColorCanvas
$configTab.Controls.Add($configFlow)

$serverUriBox = New-Object System.Windows.Forms.TextBox
$enrollmentBox = New-Object System.Windows.Forms.TextBox
$deviceNameBox = New-Object System.Windows.Forms.TextBox
$transportCombo = New-Object System.Windows.Forms.ComboBox
$transportCombo.DropDownStyle = "DropDownList"
$transportCombo.Items.AddRange(@("poll", "long-poll", "auto"))
$pollBox = New-Object System.Windows.Forms.NumericUpDown
$pollBox.Minimum = 50
$pollBox.Maximum = 60000
$pollBox.Increment = 50
$longPollBox = New-Object System.Windows.Forms.NumericUpDown
$longPollBox.Minimum = 0
$longPollBox.Maximum = 25000
$longPollBox.Increment = 250
$reloadBox = New-Object System.Windows.Forms.NumericUpDown
$reloadBox.Minimum = 1000
$reloadBox.Maximum = 60000
$reloadBox.Increment = 250
$wheelBox = New-Object System.Windows.Forms.NumericUpDown
$wheelBox.Minimum = 0
$wheelBox.Maximum = 32
$wheelBox.DecimalPlaces = 2
$wheelBox.Increment = 0.25
$logDirBox = New-Object System.Windows.Forms.TextBox
$transferDirBox = New-Object System.Windows.Forms.TextBox

New-Field $configFlow "Server URI" $serverUriBox
New-Field $configFlow "Enrollment code" $enrollmentBox
New-Field $configFlow "Device name" $deviceNameBox
New-Field $configFlow "Initial transport" $transportCombo
New-Field $configFlow "Poll interval ms" $pollBox
New-Field $configFlow "Long poll ms" $longPollBox
New-Field $configFlow "Config reload ms" $reloadBox
New-Field $configFlow "Wheel multiplier" $wheelBox
New-Field $configFlow "Log directory" $logDirBox
New-Field $configFlow "Transfer root" $transferDirBox

$checkboxFlow = New-Object System.Windows.Forms.FlowLayoutPanel
$checkboxFlow.Width = 930
$checkboxFlow.Height = 150
$checkboxFlow.Margin = New-Object System.Windows.Forms.Padding(8, 16, 8, 8)
$checkboxFlow.FlowDirection = "LeftToRight"
$checkboxFlow.WrapContents = $true
$configFlow.Controls.Add($checkboxFlow)

function New-CheckBox {
    param([string] $Text)
    $checkbox = New-Object System.Windows.Forms.CheckBox
    $checkbox.Text = $Text
    $checkbox.Width = 220
    $checkbox.Height = 28
    $checkbox.Margin = New-Object System.Windows.Forms.Padding(8)
    return $checkbox
}

$allowScreenBox = New-CheckBox "Screen capture"
$allowRemoteBox = New-CheckBox "Remote control"
$allowKeyboardBox = New-CheckBox "Keyboard input"
$allowClipboardBox = New-CheckBox "Clipboard paste"
$allowFileBox = New-CheckBox "File transfer"
$allowRecordingBox = New-CheckBox "Session recording"
$allowPowerBox = New-CheckBox "Power/display control"
$allowWebRtcBox = New-CheckBox "WebRTC data channel"
$preventSleepBox = New-CheckBox "Prevent sleep"
$checkboxFlow.Controls.AddRange(@(
    $allowScreenBox,
    $allowRemoteBox,
    $allowKeyboardBox,
    $allowClipboardBox,
    $allowFileBox,
    $allowRecordingBox,
    $allowPowerBox,
    $allowWebRtcBox,
    $preventSleepBox
))

$saveButton = New-Button "Save Config" "primary"
$saveRestartButton = New-Button "Save + Restart" "success"
$configFlow.Controls.AddRange(@($saveButton, $saveRestartButton))

$schedulerFlow = New-Object System.Windows.Forms.FlowLayoutPanel
$schedulerFlow.Dock = "Fill"
$schedulerFlow.Padding = New-Object System.Windows.Forms.Padding(20)
$schedulerFlow.AutoScroll = $true
$schedulerFlow.BackColor = $ColorCanvas
$schedulerTab.Controls.Add($schedulerFlow)

$schedulerIntro = New-Object System.Windows.Forms.TextBox
$schedulerIntro.Multiline = $true
$schedulerIntro.ReadOnly = $true
$schedulerIntro.Width = 930
$schedulerIntro.Height = 92
$schedulerIntro.Margin = New-Object System.Windows.Forms.Padding(8, 0, 8, 14)
$schedulerIntro.BorderStyle = "FixedSingle"
$schedulerIntro.BackColor = $ColorAmberSoft
$schedulerIntro.ForeColor = $ColorText
$schedulerIntro.Text = "Permanent startup installs Windows Scheduled Task '$TaskName' as SYSTEM with ServiceAccount logon. It starts at boot before any user signs in, then the supervisor restarts the agent whenever it exits. Run this tab as Administrator."
$schedulerFlow.Controls.Add($schedulerIntro)

$taskNameBox = New-Object System.Windows.Forms.TextBox
$taskNameBox.Text = $TaskName
$nodePathBox = New-Object System.Windows.Forms.TextBox
$wakeBox = New-Object System.Windows.Forms.CheckBox
$wakeBox.Text = "Wake to run if Windows/hardware permits"
$wakeBox.Width = 420
$wakeBox.Height = 30
$wakeBox.Margin = New-Object System.Windows.Forms.Padding(8)
New-Field $schedulerFlow "Task name" $taskNameBox
New-Field $schedulerFlow "Node path" $nodePathBox
$schedulerFlow.Controls.Add($wakeBox)

$installTaskButton = New-Button "Install Permanent Startup (SYSTEM)" "warning" 275
$startTaskButton = New-Button "Start Task Now" "success" 165
$stopTaskButton = New-Button "Stop Task" "default" 150
$uninstallTaskButton = New-Button "Uninstall Task" "danger" 160
$elevateButton = New-Button "Relaunch as Admin" "primary" 180
$schedulerFlow.Controls.AddRange(@(
    $installTaskButton,
    $startTaskButton,
    $stopTaskButton,
    $uninstallTaskButton,
    $elevateButton
))

$taskDetailBox = New-Object System.Windows.Forms.TextBox
$taskDetailBox.Multiline = $true
$taskDetailBox.ReadOnly = $true
$taskDetailBox.Width = 930
$taskDetailBox.Height = 105
$taskDetailBox.Margin = New-Object System.Windows.Forms.Padding(8, 12, 8, 8)
$taskDetailBox.BorderStyle = "FixedSingle"
$taskDetailBox.BackColor = $ColorSurface
$taskDetailBox.ForeColor = $ColorMuted
$schedulerFlow.Controls.Add($taskDetailBox)

$logsLayout = New-Object System.Windows.Forms.TableLayoutPanel
$logsLayout.Dock = "Fill"
$logsLayout.RowCount = 2
$logsLayout.ColumnCount = 1
$logsLayout.Padding = New-Object System.Windows.Forms.Padding(20)
$logsLayout.BackColor = $ColorCanvas
$logsLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 52))) | Out-Null
$logsLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$logsTab.Controls.Add($logsLayout)

$logTop = New-Object System.Windows.Forms.FlowLayoutPanel
$logTop.Dock = "Fill"
$logTop.BackColor = $ColorCanvas
$logsLayout.Controls.Add($logTop, 0, 0)
$logCombo = New-Object System.Windows.Forms.ComboBox
$logCombo.DropDownStyle = "DropDownList"
$logCombo.Width = 260
$logCombo.Items.AddRange(@(
    "agent-native.log",
    "agent-native.err.log",
    "agent-service.log",
    "agent-service.err.log",
    "supervisor.log",
    "npm-install.log",
    "npm-install.err.log"
))
$logCombo.SelectedIndex = 0
$refreshLogButton = New-Button "Refresh Log"
$logTop.Controls.AddRange(@($logCombo, $refreshLogButton))

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Dock = "Fill"
$logBox.Multiline = $true
$logBox.ScrollBars = "Both"
$logBox.ReadOnly = $true
$logBox.Font = New-Object System.Drawing.Font("Consolas", 9)
$logBox.BackColor = $ColorSurface
$logBox.ForeColor = $ColorText
$logsLayout.Controls.Add($logBox, 0, 1)

$footer = New-Object System.Windows.Forms.Label
$footer.Dock = "Fill"
$footer.ForeColor = [System.Drawing.Color]::FromArgb(92, 103, 120)
$footer.TextAlign = "MiddleLeft"
$root.Controls.Add($footer, 0, 2)

function Refresh-Log {
    $logBox.Text = Get-LogTail -FileName ([string] $logCombo.SelectedItem)
}

function Refresh-Status {
    $node = Get-NodePath
    $config = Get-AgentConfig
    $processes = @(Get-AgentProcesses)
    $task = Get-TaskStatus

    $nodeLabel = if ($node) { "Node ready: " + (Split-Path -Leaf (Split-Path -Parent $node)) } else { "Node missing" }
    $nodeTone = if ($node) { "good" } else { "warn" }
    $agentLabel = if ($processes.Count) { "Agent running: " + (($processes | ForEach-Object { $_.ProcessId }) -join ", ") } else { "Agent stopped" }
    $agentTone = if ($processes.Count) { "good" } else { "warn" }
    $taskLabel = if ($task.Installed) { "Startup task: $($task.State)" } else { "Startup task missing" }
    $taskTone = if ($task.Installed) { "good" } else { "warn" }
    $isAdmin = Test-IsAdmin
    $adminLabel = "Admin: " + ($(if ($isAdmin) { "yes" } else { "no" }))
    $adminTone = if ($isAdmin) { "info" } else { "warn" }
    Set-StatusLabel $nodeStatus $nodeLabel $nodeTone
    Set-StatusLabel $agentStatus $agentLabel $agentTone
    Set-StatusLabel $taskStatus $taskLabel $taskTone
    Set-StatusLabel $adminStatus $adminLabel $adminTone
    $quickPermanentButton.Text = if ($task.Installed) { "Repair Permanent Startup (SYSTEM)" } else { "Make Permanent Startup (SYSTEM)" }
    $startButton.Enabled = ($processes.Count -eq 0)
    $startButton.Text = if ($processes.Count) { "Agent Running" } else { "Start Agent" }
    $stopButton.Enabled = ($processes.Count -gt 0)
    $stopButton.Text = if ($processes.Count) { "Stop Agent" } else { "Agent Already Stopped" }
    $restartButton.Enabled = [bool] $node
    $quickPermanentButton.Enabled = $isAdmin
    $installTaskButton.Enabled = $isAdmin
    $elevateButton.Enabled = -not $isAdmin
    $nodePathBox.Text = if ($node) { $node } else { "" }
    $footer.Text = "Agent root: $AgentRoot"
    $taskDetailBox.Text = if ($task.Installed) {
        "Installed: yes`r`nState: $($task.State)`r`nRuns as: $($task.UserId)`r`nWakeToRun: $($task.WakeToRun)`r`nStartup behavior: starts at boot before Windows logon, then supervisor restarts agent if it exits."
    } else {
        "Installed: no`r`nStartup behavior: agent will not start automatically before logon until you install the SYSTEM startup task.`r`nNext step: click Relaunch as Admin, then Install Permanent Startup (SYSTEM)."
    }

    $serverUriBox.Text = [string] $config.serverUri
    $enrollmentBox.Text = [string] $config.enrollmentCode
    $deviceNameBox.Text = [string] $config.deviceName
    $transportCombo.SelectedItem = if ($config.initialTransportMode) { [string] $config.initialTransportMode } else { "poll" }
    $pollBox.Value = [decimal] [Math]::Max($pollBox.Minimum, [Math]::Min($pollBox.Maximum, [decimal] $config.pollIntervalMs))
    $longPollBox.Value = [decimal] [Math]::Max($longPollBox.Minimum, [Math]::Min($longPollBox.Maximum, [decimal] $config.longPollMs))
    $reloadBox.Value = [decimal] [Math]::Max($reloadBox.Minimum, [Math]::Min($reloadBox.Maximum, [decimal] $config.configReloadMs))
    $wheelBox.Value = [decimal] [Math]::Max($wheelBox.Minimum, [Math]::Min($wheelBox.Maximum, [decimal] $config.wheelScrollMultiplier))
    $logDirBox.Text = [string] $config.logDirectory
    $transferDirBox.Text = [string] $config.fileTransferRoot
    $allowScreenBox.Checked = [bool] $config.allowScreenCapture
    $allowRemoteBox.Checked = [bool] $config.allowRemoteControl
    $allowKeyboardBox.Checked = [bool] $config.allowKeyboardInput
    $allowClipboardBox.Checked = [bool] $config.allowClipboardPaste
    $allowFileBox.Checked = [bool] $config.allowFileTransfer
    $allowRecordingBox.Checked = [bool] $config.allowSessionRecording
    $allowPowerBox.Checked = [bool] $config.allowPowerControl
    $allowWebRtcBox.Checked = [bool] $config.allowWebRtcTransport
    $preventSleepBox.Checked = [bool] $config.preventSleepWhileRunning
    $wakeBox.Checked = [bool] $task.WakeToRun
    Refresh-Log
}

function Save-ConfigFromForm {
    $config = if (Test-Path -LiteralPath $ConfigPath) {
        Get-JsonFile -Path $ConfigPath -Fallback (Get-AgentConfig)
    } else {
        Get-AgentConfig
    }
    Set-JsonProperty $config "serverUri" $serverUriBox.Text.Trim()
    Set-JsonProperty $config "enrollmentCode" $enrollmentBox.Text.Trim()
    Set-JsonProperty $config "deviceName" $deviceNameBox.Text.Trim()
    Set-JsonProperty $config "initialTransportMode" ([string] $transportCombo.SelectedItem)
    Set-JsonProperty $config "pollIntervalMs" ([int] $pollBox.Value)
    Set-JsonProperty $config "longPollMs" ([int] $longPollBox.Value)
    Set-JsonProperty $config "configReloadMs" ([int] $reloadBox.Value)
    Set-JsonProperty $config "wheelScrollMultiplier" ([double] $wheelBox.Value)
    Set-JsonProperty $config "logDirectory" $logDirBox.Text.Trim()
    Set-JsonProperty $config "fileTransferRoot" $transferDirBox.Text.Trim()
    Set-JsonProperty $config "allowScreenCapture" ([bool] $allowScreenBox.Checked)
    Set-JsonProperty $config "allowRemoteControl" ([bool] $allowRemoteBox.Checked)
    Set-JsonProperty $config "allowKeyboardInput" ([bool] $allowKeyboardBox.Checked)
    Set-JsonProperty $config "allowClipboardPaste" ([bool] $allowClipboardBox.Checked)
    Set-JsonProperty $config "allowFileTransfer" ([bool] $allowFileBox.Checked)
    Set-JsonProperty $config "allowSessionRecording" ([bool] $allowRecordingBox.Checked)
    Set-JsonProperty $config "allowPowerControl" ([bool] $allowPowerBox.Checked)
    Set-JsonProperty $config "allowWebRtcTransport" ([bool] $allowWebRtcBox.Checked)
    Set-JsonProperty $config "preventSleepWhileRunning" ([bool] $preventSleepBox.Checked)
    if ($config.PSObject.Properties.Name -contains "serverUrl") {
        $config.PSObject.Properties.Remove("serverUrl")
    }
    Save-JsonFile -Path $ConfigPath -Value $config
}

function Run-Action {
    param([string] $Name, [scriptblock] $Action)
    try {
        $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
        $footer.Text = "$Name..."
        $form.Refresh()
        $result = & $Action
        Refresh-Status
        $detail = if ($result) { [string] $result } else { "$Name selesai." }
        $footer.Text = $detail
        [System.Windows.Forms.MessageBox]::Show($detail, "Device Snapshot Agent Manager", "OK", "Information") | Out-Null
    } catch {
        $footer.Text = "$Name gagal."
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Device Snapshot Agent Manager", "OK", "Error") | Out-Null
    } finally {
        $form.Cursor = [System.Windows.Forms.Cursors]::Default
    }
}

$bootstrapButton.Add_Click({
    Run-Action "Bootstrap Node + dependencies" {
        $node = Get-NodePath
        if (-not $node) {
            $node = Install-PortableNode
        }
        Install-AgentDependencies -NodePath $node
    }
})

$installNodeButton.Add_Click({
    Run-Action "Download Node.js" {
        Install-PortableNode | Out-Null
    }
})

$installDepsButton.Add_Click({
    Run-Action "Install npm dependencies" {
        Install-AgentDependencies -NodePath (Get-NodePath)
    }
})

$quickPermanentButton.Add_Click({
    Run-Action "Install permanent startup" {
        Install-PermanentStartupFromForm
    }
})

$openDashboardButton.Add_Click({
    Run-Action "Open server dashboard" {
        Open-ServerDashboard
    }
})

$startButton.Add_Click({
    Run-Action "Start agent" {
        $node = Get-NodePath
        if (-not $node) {
            $choice = [System.Windows.Forms.MessageBox]::Show("Node.js belum ada. Download Node LTS portable sekarang?", "Node.js missing", "YesNo", "Question")
            if ($choice -eq "Yes") {
                $node = Install-PortableNode
                Install-AgentDependencies -NodePath $node
            } else {
                throw "Node.js is required to start the agent."
            }
        }
        $result = Start-AgentProcess -NodePath $node
        Start-Sleep -Milliseconds 500
        $running = @(Get-AgentProcesses)
        if ($running.Count -lt 1) {
            throw "Agent start command returned but no running agent process was detected. Check Logs > agent-native.err.log."
        }
        return "$($result.Message) PID: " + (($running | ForEach-Object { $_.ProcessId }) -join ", ")
    }
})

$stopButton.Add_Click({
    Run-Action "Stop agent" {
        $stopped = Stop-AgentProcess
        Start-Sleep -Milliseconds 500
        $running = @(Get-AgentProcesses)
        if ($running.Count -gt 0) {
            throw "Stop requested, but agent is still running: " + (($running | ForEach-Object { $_.ProcessId }) -join ", ")
        }
        return "Agent stopped. Processes terminated: $stopped"
    }
})
$restartButton.Add_Click({
    Run-Action "Restart agent" {
        $stopped = Stop-AgentProcess
        Start-Sleep -Milliseconds 600
        $result = Start-AgentProcess -NodePath (Get-NodePath)
        Start-Sleep -Milliseconds 500
        $running = @(Get-AgentProcesses)
        if ($running.Count -lt 1) {
            throw "Agent restart command returned but no running agent process was detected."
        }
        return "Agent restarted. Stopped: $stopped. Running PID: " + (($running | ForEach-Object { $_.ProcessId }) -join ", ")
    }
})
$refreshButton.Add_Click({ Refresh-Status })

$saveButton.Add_Click({
    Run-Action "Save config" {
        Save-ConfigFromForm
    }
})

$saveRestartButton.Add_Click({
    Run-Action "Save config and restart agent" {
        Save-ConfigFromForm
        $stopped = Stop-AgentProcess
        Start-Sleep -Milliseconds 600
        $result = Start-AgentProcess -NodePath (Get-NodePath)
        return "Config saved and agent restarted. Stopped: $stopped. PID: $($result.Pid)"
    }
})

$installTaskButton.Add_Click({
    Run-Action "Install auto-start task" {
        Install-PermanentStartupFromForm
    }
})

$startTaskButton.Add_Click({ Run-Action "Start task" { $script:TaskName = $taskNameBox.Text.Trim(); Invoke-TaskAction "start" } })
$stopTaskButton.Add_Click({ Run-Action "Stop task" { $script:TaskName = $taskNameBox.Text.Trim(); Invoke-TaskAction "stop" } })
$uninstallTaskButton.Add_Click({ Run-Action "Uninstall task" { $script:TaskName = $taskNameBox.Text.Trim(); Invoke-TaskAction "uninstall" } })

$elevateButton.Add_Click({
    $args = "-NoProfile -ExecutionPolicy Bypass -STA -File `"$PSCommandPath`" -AgentRoot `"$AgentRoot`" -TaskName `"$($taskNameBox.Text.Trim())`""
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $args
})

$refreshLogButton.Add_Click({ Refresh-Log })
$logCombo.Add_SelectedIndexChanged({ Refresh-Log })

Refresh-Status
[System.Windows.Forms.Application]::Run($form)
