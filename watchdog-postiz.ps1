# watchdog-postiz.ps1
# Self-healing launcher for the full Postiz stack.
# Runs on user login (from Startup folder shortcut).
# Waits for Docker, launches Postiz + state server, then monitors and auto-restarts.
# Also re-runs on a loop so if something crashes mid-session, it self-heals within 60s.

$ErrorActionPreference = 'SilentlyContinue'
$logBase = 'C:\dev\Schedular\logs'
New-Item -ItemType Directory -Force -Path $logBase | Out-Null
$logFile = Join-Path $logBase 'watchdog.log'

function Log($msg, $color = 'White') {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] $msg"
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    Write-Host $line -ForegroundColor $color
}

function PortUp($p) { (Test-NetConnection localhost -Port $p -WarningAction SilentlyContinue).TcpTestSucceeded }

Log "=== WATCHDOG STARTED ===" 'Cyan'

# Give Windows a moment to settle after login
Start-Sleep 10

# â”€â”€ STEP 1: Wait for Docker (up to 5 minutes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Log "Waiting for Docker engine..." 'Yellow'
$dockerReady = $false
for ($i = 0; $i -lt 60; $i++) {
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { $dockerReady = $true; Log "Docker engine is UP" 'Green'; break }
    Start-Sleep 5
}

if (-not $dockerReady) {
    Log "Docker did not start within 5 minutes. Starting Docker Desktop..." 'Red'
    $de = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $de) { Start-Process $de }
    for ($i = 0; $i -lt 60; $i++) {
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { $dockerReady = $true; Log "Docker engine is UP (after manual start)" 'Green'; break }
        Start-Sleep 5
    }
}

if (-not $dockerReady) {
    Log "DOCKER FAILED TO START. Exiting watchdog. Postiz cannot run without Docker." 'Red'
    exit 1
}

# â”€â”€ STEP 2: Start Postiz containers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Log "Starting Docker containers..." 'Yellow'
Push-Location 'C:\dev\Schedular\postiz-app'
docker compose up -d postiz-postgres postiz-redis temporal temporal-postgresql temporal-elasticsearch *>> $logFile
Pop-Location
Log "Containers up." 'Green'

# â”€â”€ STEP 3: Wait for Postgres port â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
for ($i = 0; $i -lt 30; $i++) {
    if (PortUp 5432) { Log "Postgres 5432 listening" 'Green'; break }
    Start-Sleep 2
}

# â”€â”€ STEP 4: Launch Postiz via PM2 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (-not (PortUp 3000) -or -not (PortUp 4200)) {
    Log "Launching Postiz via PM2..." 'Yellow'
    pm2 start "C:\dev\Schedular\postiz-app\ecosystem.config.js" *>> $logFile
    pm2 save *>> $logFile
    for ($i = 0; $i -lt 30; $i++) { Start-Sleep 2; if ((PortUp 3000) -and (PortUp 4200)) { break } }
    Log "Postiz launched." 'Green'
} else {
    Log "Postiz already running." 'Green'
}

# â”€â”€ STEP 5: State server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
$ssPid = (Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "state-server" } | Select-Object -First 1).Id
if (-not $ssPid) {
    Start-Process node -ArgumentList '"C:\dev\Schedular\state-server.js"' -WindowStyle Hidden
    Start-Sleep 2
    Log "State server launched." 'Green'
} else {
    Log "State server already running (pid $ssPid)." 'Green'
}

# â”€â”€ STEP 6: Arc-viz HTTP server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (-not (PortUp 8080)) {
    $httpPid = (Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "http.server.*8080" } | Select-Object -First 1).Id
    if (-not $httpPid) {
        Start-Process python -ArgumentList '-m http.server 8080' -WorkingDirectory 'C:\Users\steve\MeWorld\game\linkedin' -WindowStyle Hidden
        Start-Sleep 1
        Log "Arc-viz HTTP server launched on :8080" 'Green'
    }
} else {
    Log "Arc-viz HTTP already on :8080" 'Green'
}

Log "=== WATCHDOG: ALL SERVICES UP ===" 'Cyan'
Log "  Postgres :5432 - $(if (PortUp 5432) { 'UP' } else { 'DOWN' })" 'Gray'
Log "  Backend  :3000 - $(if (PortUp 3000) { 'UP' } else { 'DOWN' })" 'Gray'
Log "  Frontend :4200 - $(if (PortUp 4200) { 'UP' } else { 'DOWN' })" 'Gray'
Log "  State    :9801 - $(if (PortUp 9801) { 'UP' } else { 'DOWN' })" 'Gray'
Log "  Arc HTTP :8080 - $(if (PortUp 8080) { 'UP' } else { 'DOWN' })" 'Gray'

# â”€â”€ STEP 7: Monitor loop (check every 60s, auto-heal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Log "Entering monitor loop (check every 60s)..." 'Cyan'

while ($true) {
    Start-Sleep 60
    
    $dbDown = -not (PortUp 5432)
    $apiDown = -not (PortUp 3000)
    $feDown = -not (PortUp 4200)
    $ssDown = -not (PortUp 9801)
    $httpDown = -not (PortUp 8080)
    
    if ($dbDown -or $apiDown -or $feDown -or $ssDown -or $httpDown) {
        $missing = @()
        if ($dbDown) { $missing += "Postgres" }
        if ($apiDown) { $missing += "Backend" }
        if ($feDown) { $missing += "Frontend" }
        if ($ssDown) { $missing += "StateServer" }
        if ($httpDown) { $missing += "ArcHTTP" }
        
        Log "HEAL: Restarting ($($missing -join ', '))..." 'Yellow'
        
        if ($dbDown) {
            Push-Location 'C:\dev\Schedular\postiz-app'
            docker compose up -d postiz-postgres postiz-redis temporal temporal-postgresql temporal-elasticsearch *>> $logFile
            Pop-Location
        }
        if ($apiDown -or $feDown) {
            pm2 start "C:\dev\Schedular\postiz-app\ecosystem.config.js" *>> $logFile
            pm2 save *>> $logFile
        }
        if ($ssDown) {
            $ssRunning = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "state-server" }
            if (-not $ssRunning) { Start-Process node -ArgumentList '"C:\dev\Schedular\state-server.js"' -WindowStyle Hidden }
        }
        if ($httpDown) {
            $pyRunning = Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "http.server.*8080" }
            if (-not $pyRunning) { Start-Process python -ArgumentList '-m http.server 8080' -WorkingDirectory 'C:\Users\steve\MeWorld\game\linkedin' -WindowStyle Hidden }
        }
        
        Start-Sleep 5
        Log "Heal complete: DB=$(if(PortUp 5432){'UP'}else{'DOWN'}) API=$(if(PortUp 3000){'UP'}else{'DOWN'}) FE=$(if(PortUp 4200){'UP'}else{'DOWN'}) SS=$(if(PortUp 9801){'UP'}else{'DOWN'}) HTTP=$(if(PortUp 8080){'UP'}else{'DOWN'})" 'Cyan'
    }
}

Log "WATCHDOG EXITED" 'Red'
