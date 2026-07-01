# launch-postiz.ps1
# One command to bring the whole local Postiz stack up as a single, self-healing unit.
#   Part A: Docker (Postgres + Redis + Temporal)
#   Part B: backend + frontend + orchestrator, supervised by PM2 (auto-restart on crash)
# Idempotent: safe to run anytime. PM2 keeps the Node apps alive; this script (re)starts them
# and is what the "Postiz Morning Wake / Logon" scheduled task runs after a reboot.
# See AGENT_RUNBOOK.md for architecture + recovery.
#
# -NoBrowser : headless mode (no browser pop) - used by the scheduled task / startup entry.
param([switch]$NoBrowser)

# -- Ensure tool paths are available even without a user profile (startup / task scheduler) --
$env:Path = "C:\Program Files\nodejs;C:\Users\steve\AppData\Roaming\npm;C:\Program Files\Docker\Docker\resources\bin;" + $env:Path

$ErrorActionPreference = 'SilentlyContinue'
$root = 'C:\dev\Schedular\postiz-app'
$eco  = Join-Path $root 'ecosystem.config.js'
$logs = 'C:\dev\Schedular\logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Say($m, $c = 'White') { Write-Host ("  " + $m) -ForegroundColor $c }
function PortUp($p) { (Test-NetConnection localhost -Port $p -WarningAction SilentlyContinue).TcpTestSucceeded }

Write-Host "`n=== Launch Postiz ===" -ForegroundColor Cyan

# A) Docker engine + containers ------------------------------------------------
Write-Host "`n[A] Docker (database, redis, temporal)" -ForegroundColor Yellow
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Say "Docker engine is down. Starting Docker Desktop..." 'Gray'
  $exe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $exe) { Start-Process $exe }
  for ($i = 0; $i -lt 36; $i++) { Start-Sleep -Seconds 5; docker info *> $null; if ($LASTEXITCODE -eq 0) { break } }
}
if ($LASTEXITCODE -eq 0) {
  Push-Location $root
  docker compose up -d postiz-postgres postiz-redis temporal *> "$logs\launch-docker.log"
  Pop-Location
  $up = (docker ps --format "{{.Names}}") -join ' '
  Say ("containers up: " + (($up -split ' ' | Where-Object { $_ -match 'postiz|temporal' }) -join ', ')) 'Green'
} else {
  Say "Docker did not come up. Start Docker Desktop manually and re-run." 'Red'
}

# A2) Database reachability guard ----------------------------------------------
Write-Host "`n[DB] Postgres reachable on localhost:5432?" -ForegroundColor Yellow
if (PortUp 5432) {
  Say "host 5432 is listening." 'Green'
} else {
  Say 'PROBLEM: Postgres is NOT published on host 5432 - the backend cannot reach the DB.' 'Red'
  Say 'Your data is safe in the volume; the container just lost its host port.' 'Yellow'
  Say 'Fix: confirm postiz-postgres has a 5432:5432 ports mapping in postiz-app/docker-compose.yaml,' 'Yellow'
  Say 'then run:  cd C:\dev\Schedular\postiz-app ; docker compose up -d postiz-postgres' 'Yellow'
  Say 'Details + recovery: C:\dev\Schedular\AGENT_RUNBOOK.md (sections 3 and 4).' 'Yellow'
}

# B) App processes via PM2 (backend + frontend + orchestrator) -----------------
Write-Host "`n[B] App (backend 3000 + frontend 4200 + orchestrator) via PM2" -ForegroundColor Yellow
if ((PortUp 3000) -and (PortUp 4200)) {
  Say "already running under PM2 - leaving it alone." 'Green'
} else {
  pm2 start "$eco" *> "$logs\launch-pm2.log"
  pm2 save *>> "$logs\launch-pm2.log"
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep 2; if ((PortUp 3000) -and (PortUp 4200)) { break } }
  Say "started under PM2 (auto-restart on crash). Use 'pm2 status' / 'pm2 logs' to inspect." 'Green'
}

# Summary ----------------------------------------------------------------------
Write-Host "`n=== Status ===" -ForegroundColor Cyan
$dUp = PortUp 5432
$bUp = PortUp 3000
$fUp = PortUp 4200
if ($dUp) { Say "Database 5432 : UP" 'Green' } else { Say "Database 5432 : DOWN  <- backend will fail, see AGENT_RUNBOOK.md" 'Red' }
if ($bUp) { Say "Backend  3000 : UP" 'Green' } else { Say "Backend  3000 : DOWN" 'Red' }
if ($fUp) { Say "Frontend 4200 : UP" 'Green' } else { Say "Frontend 4200 : DOWN" 'Red' }
Write-Host ""
pm2 status 2>&1 | Select-Object -Last 8

# C) State persistence server for arc-viz auto-save
Write-Host "`n[C] Arc-viz state server :9801" -ForegroundColor Yellow
$ssPid = (Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "state-server" } | Select-Object -First 1).Id
if ($ssPid) { Say "state-server already running (pid $ssPid)." 'Green' }
else {
  Start-Process node -ArgumentList "`"C:\dev\Schedular\state-server.js`"" -WindowStyle Minimized
  Start-Sleep 2
  try { (Invoke-WebRequest -Uri "http://127.0.0.1:9801/list" -UseBasicParsing -TimeoutSec 3).StatusCode; Say "state-server UP on :9801" 'Green' }
  catch { Say "state-server did not start -- check manually" 'Red' }
}

if ($fUp -and -not $NoBrowser) {
  Write-Host "`nOpening http://localhost:4200 ..." -ForegroundColor Cyan
  Start-Process "http://localhost:4200"
}
Write-Host ""
