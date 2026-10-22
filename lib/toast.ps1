#Requires -Version 5.1
<#
  Fires exactly one Windows toast for DeepSeek Harness and reports the outcome.

  Deliberately ASCII-only: Windows PowerShell 5.1 parses an extension-less/UTF-8
  script in the active ANSI code page, so non-ASCII source text can break the
  parser on a Chinese Windows install. All user-visible text arrives through
  arguments (UTF-16 command line), never through this file.

  Invoked by lib/index.js as:
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File toast.ps1 `
      -Title "..." -Body "..." -AppId "..." -Sound on

  stdout: one compact JSON line, so the caller logs a real delivery result
  instead of assuming success. Exit code 1 means the toast was not shown.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $false)][string]$Body = '',
  [Parameter(Mandatory = $false)][string]$AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe',
  # 'on' plays the default notification sound; anything else stays silent.
  [Parameter(Mandatory = $false)][string]$Sound = 'on'
)

$ErrorActionPreference = 'Stop'

# Escape for XML text nodes without dragging in a second assembly.
function ConvertTo-XmlText {
  param([string]$Value)
  if ($null -eq $Value) { return '' }
  $escaped = $Value.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
  return $escaped
}

try {
  # WinRT projections exist in Windows PowerShell 5.1 only (PowerShell 7 dropped
  # them), which is why the caller targets powershell.exe explicitly.
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $audio = if ($Sound -eq 'on') {
    '<audio src="ms-winsoundevent:Notification.Default" loop="false" />'
  } else {
    '<audio silent="true" />'
  }

  $xmlText = '<toast scenario="default"><visual><binding template="ToastGeneric"><text>' +
    (ConvertTo-XmlText $Title) + '</text><text>' + (ConvertTo-XmlText $Body) + '</text>' +
    '</binding></visual>' + $audio + '</toast>'

  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml($xmlText)

  $toast = New-Object Windows.UI.Notifications.ToastNotification $document
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
  $notifier.Show($toast)

  [pscustomobject]@{ ok = $true; error = $null } | ConvertTo-Json -Compress
  exit 0
}
catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
