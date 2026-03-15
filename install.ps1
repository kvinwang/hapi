#Requires -Version 5.1
<#
.SYNOPSIS
    HAPI installer for Windows. Downloads and installs happier.exe.
.DESCRIPTION
    Modes:
      - Normal install: download happier.exe, configure settings, optionally install as scheduled task
      - --join <token>: download to temp, run in foreground (temporary remote assist)
.EXAMPLE
    # Normal install
    irm https://hapi.kvin.wang/install.ps1 | iex

    # Join with invite token
    powershell -ExecutionPolicy Bypass -File install.ps1 --join <token>
#>

param(
    [string]$Join = ""
)

$ErrorActionPreference = "Stop"

$Repo = "kvinwang/hapi"
$BinaryName = "happier.exe"
# Replaced by hub when served via /install.ps1 endpoint; fallback for direct use
$HapiDefaultUrl = "__HAPI_HUB_URL__"
if ($HapiDefaultUrl -like "__*") {
    $HapiDefaultUrl = "https://hapi.kvin.wang"
}

# --- Colors / helpers ---
function Write-Info  { param([string]$Msg) Write-Host "[INFO] " -ForegroundColor Green -NoNewline; Write-Host $Msg }
function Write-Warn  { param([string]$Msg) Write-Host "[WARN] " -ForegroundColor Yellow -NoNewline; Write-Host $Msg }
function Write-Err   { param([string]$Msg) Write-Host "[ERROR] " -ForegroundColor Red -NoNewline; Write-Host $Msg; exit 1 }

function Show-Banner {
    param([string]$Title)
    Write-Host ""
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host ""
}

# --- Detect architecture ---
function Get-Arch {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($arch) {
        "X64"   { return "x64" }
        "Arm64" { return "arm64" }
        default {
            # Fallback for PS 5.1 where RuntimeInformation may not exist
            $envArch = $env:PROCESSOR_ARCHITECTURE
            switch ($envArch) {
                "AMD64" { return "x64" }
                "ARM64" { return "arm64" }
                default { Write-Err "Unsupported architecture: $envArch" }
            }
        }
    }
}

# --- Map architecture to artifact name ---
function Get-ArtifactName {
    param([string]$Arch)
    switch ($Arch) {
        "x64"   { return "happier-x86_64-pc-windows-msvc.zip" }
        "arm64" { return "happier-aarch64-pc-windows-msvc.zip" }
        default { Write-Err "No happier binary available for Windows $Arch" }
    }
}

# --- Get latest release version ---
function Get-LatestVersion {
    Write-Info "Fetching latest version..."

    # Method 1: GitHub redirect (no API rate limit)
    try {
        $response = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" `
            -MaximumRedirection 0 -ErrorAction SilentlyContinue -UseBasicParsing
    } catch {
        $response = $_.Exception.Response
    }

    if ($response -and $response.Headers -and $response.Headers["Location"]) {
        $location = $response.Headers["Location"]
        if ($location -is [array]) { $location = $location[0] }
        $tag = ($location -split "/")[-1]
        if ($tag -match '^v?\d') {
            return $tag
        }
    }

    # Method 2: API fallback
    try {
        $apiResp = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=1" `
            -UseBasicParsing -ErrorAction Stop
        if ($apiResp -and $apiResp.Count -gt 0) {
            return $apiResp[0].tag_name
        }
    } catch {
        # fall through
    }

    Write-Err "Failed to fetch latest release from GitHub.`n  Check your network or visit: https://github.com/$Repo/releases"
}

# --- Download and extract ---
function Get-HappierBinary {
    param(
        [string]$Artifact,
        [string]$Version,
        [string]$DestDir
    )
    $url = "https://github.com/$Repo/releases/download/$Version/$Artifact"
    $zipPath = Join-Path $DestDir $Artifact

    Write-Info "Downloading $Artifact ($Version)..."
    try {
        # Use TLS 1.2+ for GitHub
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
    } catch {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    }

    try {
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -ErrorAction Stop
    } catch {
        Write-Err "Download failed: $Artifact ($Version)`n  URL: $url`n  Check: https://github.com/$Repo/releases/tag/$Version"
    }

    Write-Info "Extracting..."
    Expand-Archive -Path $zipPath -DestinationPath $DestDir -Force
    Remove-Item $zipPath -Force

    $exePath = Join-Path $DestDir $BinaryName
    if (-not (Test-Path $exePath)) {
        Write-Err "Binary '$BinaryName' not found in archive"
    }

    return $exePath
}

# --- Settings helpers ---
function Get-HapiHome {
    if ($env:HAPI_HOME) { return $env:HAPI_HOME }
    return Join-Path $env:USERPROFILE ".hapi"
}

function Get-SettingsPath {
    return Join-Path (Get-HapiHome) "settings.json"
}

function Read-Settings {
    $path = Get-SettingsPath
    if (Test-Path $path) {
        try {
            return Get-Content $path -Raw | ConvertFrom-Json
        } catch {
            Write-Warn "Malformed settings.json, starting fresh"
        }
    }
    return [PSCustomObject]@{}
}

function Write-Settings {
    param([PSCustomObject]$Settings)
    $hapiHome = Get-HapiHome
    if (-not (Test-Path $hapiHome)) {
        New-Item -ItemType Directory -Path $hapiHome -Force | Out-Null
    }
    $path = Get-SettingsPath
    $Settings | ConvertTo-Json -Depth 10 | Set-Content -Path $path -Encoding UTF8
}

function Set-SettingsProperty {
    param(
        [PSCustomObject]$Settings,
        [string]$Name,
        [string]$Value
    )
    if ($Settings.PSObject.Properties[$Name]) {
        $Settings.$Name = $Value
    } else {
        $Settings | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
    return $Settings
}

# --- Join mode: download to temp, run in foreground ---
function Invoke-Join {
    param([string]$Token)

    Show-Banner "HAPI - Remote Assist"

    $arch = Get-Arch
    Write-Info "Architecture: $arch"

    $artifact = Get-ArtifactName $arch
    $version = Get-LatestVersion

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "hapi-join-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    $exePath = Get-HappierBinary -Artifact $artifact -Version $version -DestDir $tmpDir

    # Write temporary settings
    $machineName = $env:COMPUTERNAME
    if (-not $machineName) { $machineName = "assist" }

    $machineId = [guid]::NewGuid().ToString()

    $settings = [PSCustomObject]@{
        apiUrl     = $HapiDefaultUrl
        cliApiToken = $Token
        machineId  = $machineId
        machineName = $machineName
    }

    # Write settings to the standard location
    Write-Settings $settings

    Write-Info "Starting temporary runner (Ctrl+C to stop)..."
    Write-Host ""

    $env:HAPI_API_URL = $HapiDefaultUrl
    $env:CLI_API_TOKEN = $Token
    $env:HAPI_MACHINE_NAME = $machineName

    try {
        & $exePath
    } finally {
        # Clean up temp directory
        Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- Prompt for credentials ---
function Read-RunnerCredentials {
    $apiUrl = $HapiDefaultUrl
    Write-Host ""
    Write-Host "  Remote runner setup" -ForegroundColor Cyan
    $input = Read-Host "  Hub URL [$apiUrl]"
    if ($input) { $apiUrl = $input }

    $token = Read-Host "  CLI API Token"
    if (-not $token) { Write-Err "CLI API Token is required" }

    $defaultName = $env:COMPUTERNAME
    $namePrompt = "  Machine name"
    if ($defaultName) { $namePrompt = "  Machine name [$defaultName]" }
    $machineName = Read-Host $namePrompt
    if (-not $machineName) { $machineName = $defaultName }

    return @{
        ApiUrl      = $apiUrl
        Token       = $token
        MachineName = $machineName
    }
}

# --- Install as scheduled task ---
function Install-ScheduledTask {
    param(
        [string]$ExePath
    )
    $taskName = "HapiHappier"

    # Check if task already exists
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Info "Removing existing scheduled task '$taskName'..."
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }

    $action = New-ScheduledTaskAction -Execute $ExePath
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    $taskSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Days 365)

    Register-ScheduledTask -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $taskSettings `
        -Description "HAPI Runner (happier)" | Out-Null

    # Start it now
    Start-ScheduledTask -TaskName $taskName
    Write-Info "Scheduled task '$taskName' created and started"
    Write-Info "happier will auto-start at login"
}

# --- Normal install ---
function Invoke-Install {
    Show-Banner "HAPI Installer (Windows)"

    $arch = Get-Arch
    Write-Info "Architecture: $arch"

    $artifact = Get-ArtifactName $arch
    $version = Get-LatestVersion

    # Install directory
    $installDir = Join-Path (Get-HapiHome) "bin"
    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }

    $exePath = Get-HappierBinary -Artifact $artifact -Version $version -DestDir $installDir
    Write-Info "Installed happier $version to $exePath"

    # Add to PATH if not already there
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$installDir*") {
        [Environment]::SetEnvironmentVariable("PATH", "$installDir;$userPath", "User")
        $env:PATH = "$installDir;$env:PATH"
        Write-Info "Added $installDir to user PATH"
    }

    # Prompt for credentials and save settings
    $creds = Read-RunnerCredentials
    $machineId = [guid]::NewGuid().ToString()

    $settings = Read-Settings
    $settings = Set-SettingsProperty $settings "apiUrl" $creds.ApiUrl
    $settings = Set-SettingsProperty $settings "cliApiToken" $creds.Token
    $settings = Set-SettingsProperty $settings "machineName" $creds.MachineName
    if (-not $settings.PSObject.Properties["machineId"]) {
        $settings = Set-SettingsProperty $settings "machineId" $machineId
    }
    Write-Settings $settings
    Write-Info "Settings saved to $(Get-SettingsPath)"

    # Service setup
    Write-Host ""
    Write-Host "  What would you like to do with happier?" -ForegroundColor Cyan
    Write-Host "  1) Install as scheduled task (auto-start at login)"
    Write-Host "  2) Run now in foreground (no service)"
    Write-Host "  3) Skip (just install the binary)"
    Write-Host ""
    $choice = Read-Host "  Select [1-3] (default: 1)"
    if (-not $choice) { $choice = "1" }

    switch ($choice) {
        "1" {
            Install-ScheduledTask -ExePath $exePath
        }
        "2" {
            Write-Info "Starting happier (Ctrl+C to stop)..."
            Write-Host ""
            & $exePath
        }
    }

    Write-Host ""
    Write-Info "Installation complete!"
    Write-Host ""
    Write-Host "  Happier (lightweight runner):"
    Write-Host "    happier    # Run from anywhere (added to PATH)"
    Write-Host ""
}

# --- Main ---

# Handle piped invocation (irm | iex) - $args won't be populated
# but we also check for --join in $args for direct script execution
$joinToken = ""

# Check $args (when run as script with parameters)
if ($args.Count -gt 0) {
    for ($i = 0; $i -lt $args.Count; $i++) {
        if ($args[$i] -eq "--join" -or $args[$i] -eq "join") {
            if ($i + 1 -lt $args.Count) {
                $joinToken = $args[$i + 1]
            }
        }
    }
}

# Check param binding
if ($Join) {
    $joinToken = $Join
}

if ($joinToken) {
    Invoke-Join -Token $joinToken
} else {
    Invoke-Install
}
