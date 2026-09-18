<#
.SYNOPSIS
    Removes the meshcore-observer Windows Scheduled Task registered by
    register-scheduled-task.ps1.

.PARAMETER TaskName
    Name of the scheduled task to remove. Default: MeshCoreObserver.

.EXAMPLE
    .\scripts\unregister-scheduled-task.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$TaskName = 'MeshCoreObserver'
)

$ErrorActionPreference = 'Stop'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "No scheduled task named '$TaskName' was found; nothing to do."
    return
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
}
