<#
.SYNOPSIS
    Registers meshcore-observer as a Windows Scheduled Task so it starts
    automatically at logon and restarts itself if it exits unexpectedly.

.DESCRIPTION
    Implements the Task Scheduler behavior recommended in
    docs/project_plan.spec.md Section 25:
      trigger: at logon
      delay: 25 seconds (the app's own radio retry/backoff logic is what
             actually recovers from the radio not being ready yet at
             Windows startup - this delay is just a courtesy head start)
      working directory: repository root
      command: npm start
      restart on process failure: enabled (up to 3 times, 1 minute apart)

    Only affects this Task Scheduler entry. Does not modify npm scripts,
    application code, or any other Windows configuration.

.PARAMETER TaskName
    Name of the scheduled task. Default: MeshCoreObserver.

.PARAMETER Force
    Replace an existing task with the same name instead of failing.

.EXAMPLE
    .\scripts\register-scheduled-task.ps1
    Registers the task using defaults, prompting for confirmation.

.EXAMPLE
    .\scripts\register-scheduled-task.ps1 -Force
    Re-registers the task, replacing any existing one with the same name.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$TaskName = 'MeshCoreObserver',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Repository root is the parent of this script's directory - never a
# hardcoded path, so this works regardless of where the repo is cloned.
$repoRoot = Split-Path -Parent $PSScriptRoot

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npmCommand) {
    throw "npm was not found on PATH. Install Node.js first, or run this script from a shell where 'npm' resolves."
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not $Force) {
    throw "A scheduled task named '$TaskName' already exists. Re-run with -Force to replace it."
}

$action = New-ScheduledTaskAction `
    -Execute 'cmd.exe' `
    -Argument '/c npm start' `
    -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = 'PT25S'

$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Starts the meshcore-observer Node.js application at logon (see docs/project_plan.spec.md Section 25).'

if ($PSCmdlet.ShouldProcess($TaskName, 'Register scheduled task')) {
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force:$Force | Out-Null
    Write-Host "Registered scheduled task '$TaskName'."
    Write-Host "  Working directory: $repoRoot"
    Write-Host "  Command:           npm start"
    Write-Host "  Trigger:           at logon, 25s delay"
    Write-Host ""
    Write-Host "This task will not run until the next logon. To test it now without" -ForegroundColor Yellow
    Write-Host "logging out, run: Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Yellow
    Write-Host "To remove it: .\scripts\unregister-scheduled-task.ps1" -ForegroundColor Yellow
}
