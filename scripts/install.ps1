# whatsapp-mcp installer for Windows.
#
#   irm https://raw.githubusercontent.com/aliaaldihnayn-lab/whats-mcp/main/scripts/install.ps1 | iex
#
# Downloads the latest release into %LOCALAPPDATA%\whatsapp-mcp and registers a
# scheduled task that starts the daemon hidden at every logon, so it keeps
# receiving messages in the background. Set $env:WHATSAPP_MCP_NO_SERVICE = "1"
# before running to install the binary only.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo     = 'aliaaldihnayn-lab/whats-mcp'
$Root     = Join-Path $env:LOCALAPPDATA 'whatsapp-mcp'
$BinDir   = Join-Path $Root 'bin'
$StoreDir = Join-Path $Root 'store'
$Uploads  = Join-Path $StoreDir 'uploads'
$Exe      = Join-Path $BinDir 'whatsapp-mcp.exe'
$Addr     = '127.0.0.1:8765'
$TaskName = 'whatsapp-mcp'

function Say($m) { Write-Host "==> $m" -ForegroundColor Green }

if (-not [Environment]::Is64BitOperatingSystem) { throw 'whatsapp-mcp needs 64-bit Windows.' }

$Url = "https://github.com/$Repo/releases/latest/download/whatsapp-mcp_windows_amd64.zip"
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("whatsapp-mcp-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp, $BinDir, $Uploads | Out-Null

Say 'Downloading whatsapp-mcp for Windows'
Invoke-WebRequest -Uri $Url -OutFile (Join-Path $Tmp 'pkg.zip') -UseBasicParsing
Expand-Archive -Path (Join-Path $Tmp 'pkg.zip') -DestinationPath $Tmp -Force

# Stop a running copy before replacing the binary.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-Process whatsapp-mcp -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Copy-Item (Join-Path $Tmp 'whatsapp-mcp.exe') $Exe -Force
Unblock-File $Exe
Remove-Item $Tmp -Recurse -Force
Say "Installed $(& $Exe -version) to $BinDir"

$service = $env:WHATSAPP_MCP_NO_SERVICE -ne '1'
if ($service) {
  $cmd = "`$env:WHATSAPP_MCP_ADDR='$Addr'; `$env:WHATSAPP_MCP_MEDIA_ROOT='$Uploads'; & '$Exe' -store '$StoreDir' serve"
  $action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`""
  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
              -Description 'WhatsApp MCP daemon' -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Say 'Background task registered and started (runs at every logon)'
}

Write-Host ''
Say 'Next steps'
if (-not $service) { Write-Host "  1. Start the daemon:  & '$Exe' -store '$StoreDir' serve" }
else { Write-Host '  1. The daemon is running in the background.' }
Write-Host "  2. Open http://$Addr/pair and scan the QR code"
Write-Host '     (WhatsApp on your phone > Settings > Linked devices > Link a device).'
Write-Host '  3. Connect your MCP client:'
Write-Host '     Claude Code / Cursor:'
Write-Host "       { `"mcpServers`": { `"whatsapp`": { `"type`": `"http`", `"url`": `"http://$Addr/mcp`" } } }"
Write-Host '     Claude Desktop (needs Node.js):'
Write-Host "       { `"mcpServers`": { `"whatsapp`": { `"command`": `"npx`", `"args`": [`"-y`", `"mcp-remote`", `"http://$Addr/mcp`"] } } }"
Write-Host ''
Write-Host "  Files you want to send must be placed in: $Uploads"
