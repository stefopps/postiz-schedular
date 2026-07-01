# admin-repair-docker.ps1
# RUN AS ADMINISTRATOR
# Repairs Docker Desktop after corrupted shutdown and restarts the full Postiz stack.

$ErrorActionPreference = 'Stop'

Write-Host "=== DOCKER REPAIR (Admin) ===" -ForegroundColor Cyan
Write-Host ""

# 1. Stop everything Docker-related cleanly
Write-Host "[1] Stopping Docker Desktop..." -ForegroundColor Yellow
Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "com.docker.backend" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "com.docker.service" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "vpnkit" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "com.docker.proxy" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 3

# 2. Restart Docker Desktop service
Write-Host "[2] Restarting Docker service..." -ForegroundColor Yellow
net stop com.docker.service 2>$null
Start-Sleep 2
net start com.docker.service 2>$null

# 3. Shutdown WSL to reset the Linux VM
Write-Host "[3] Resetting WSL2 backend..." -ForegroundColor Yellow
wsl --shutdown 2>$null
Start-Sleep 5

# 4. Launch Docker Desktop
Write-Host "[4] Launching Docker Desktop..." -ForegroundColor Yellow
$dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
if (Test-Path $dockerExe) {
    Start-Process $dockerExe -WindowStyle Minimized
    Write-Host "  Docker Desktop starting..."
} else {
    Write-Host "  ERROR: Docker Desktop.exe not found at $dockerExe" -ForegroundColor Red
    exit 1
}

# 5. Wait for Docker engine
Write-Host "[5] Waiting for Docker engine..." -ForegroundColor Yellow
for ($i = 1; $i -le 20; $i++) {
    Start-Sleep 10
    docker info *>$null
    if ($LASTEXITCODE -eq 0) { 
        Write-Host "  Docker READY ($($i*10)s)" -ForegroundColor Green
        break 
    }
    Write-Host "  ." -NoNewline
}
Write-Host ""

# 6. Start containers
Write-Host "[6] Starting containers..." -ForegroundColor Yellow
Push-Location C:\dev\Schedular\postiz-app
docker compose up -d postiz-postgres postiz-redis temporal temporal-postgresql temporal-elasticsearch
Pop-Location
Write-Host "  Containers started." -ForegroundColor Green

# 7. Wait for Postgres
Write-Host "[7] Waiting for Postgres 5432..." -ForegroundColor Yellow
for ($i = 0; $i -lt 30; $i++) {
    $up = (Test-NetConnection localhost -Port 5432 -WarningAction SilentlyContinue).TcpTestSucceeded
    if ($up) { Write-Host "  Postgres UP" -ForegroundColor Green; break }
    Start-Sleep 2
}

# 8. Start Postiz via PM2
Write-Host "[8] Starting Postiz via PM2..." -ForegroundColor Yellow
pm2 start C:\dev\Schedular\postiz-app\ecosystem.config.js
pm2 save
for ($i = 0; $i -lt 30; $i++) { 
    Start-Sleep 2
    $bUp = (Test-NetConnection localhost -Port 3000 -WarningAction SilentlyContinue).TcpTestSucceeded
    $fUp = (Test-NetConnection localhost -Port 4200 -WarningAction SilentlyContinue).TcpTestSucceeded
    if ($bUp -and $fUp) { Write-Host "  Postiz UP (backend 3000 + frontend 4200)" -ForegroundColor Green; break }
}
Write-Host ""

# 9. Start state server
Write-Host "[9] Starting state server..." -ForegroundColor Yellow
$ssRunning = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "state-server" }
if (-not $ssRunning) {
    Start-Process node -ArgumentList '"C:\dev\Schedular\state-server.js"' -WindowStyle Minimized
    Start-Sleep 2
    Write-Host "  State server started." -ForegroundColor Green
} else {
    Write-Host "  Already running." -ForegroundColor Green
}

# 10. Start arc-viz HTTP server
Write-Host "[10] Starting arc-viz HTTP server..." -ForegroundColor Yellow
$httpRunning = Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "http.server.*8080" }
if (-not $httpRunning) {
    Start-Process python -ArgumentList '-m http.server 8080' -WorkingDirectory 'C:\Users\steve\MeWorld\game\linkedin' -WindowStyle Minimized
    Start-Sleep 1
    Write-Host "  HTTP server started." -ForegroundColor Green
} else {
    Write-Host "  Already running." -ForegroundColor Green
}

# Final status
Write-Host ""
Write-Host "=== FINAL STATUS ===" -ForegroundColor Cyan
$ports = @{5432="Postgres"; 6379="Redis"; 7233="Temporal"; 3000="Backend"; 4200="Frontend"; 9801="StateServer"; 8080="ArcHTTP"}
foreach ($p in $ports.Keys) {
    $up = (Test-NetConnection localhost -Port $p -WarningAction SilentlyContinue).TcpTestSucceeded
    Write-Host "  $($ports[$p].PadRight(16)) :$p - $(if($up){'UP'}else{'DOWN'})" -ForegroundColor $(if($up){'Green'}else{'Red'})
}
Write-Host ""
Write-Host "Open Postiz: http://localhost:4200" -ForegroundColor Cyan
Write-Host "Open ArcViz: http://localhost:8080/arc-viz.html" -ForegroundColor Cyan
Write-Host ""
Write-Host "Done. The watchdog will keep everything alive from here." -ForegroundColor Green
