# check-ready.ps1 — Shows post statuses from arc-viz auto-save
# Reads the state server's latest.json and maps to post spines from arc-viz.html

$ErrorActionPreference = "Stop"

$READY_URL = "http://127.0.0.1:9801/ready"
$LATEST_URL = "http://127.0.0.1:9801/latest"

try {
    $readyResp = Invoke-RestMethod $READY_URL -ErrorAction Stop
} catch {
    Write-Host "State server not running. Start it: node C:\dev\Schedular\state-server.js" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "=== POST STATUSES ===" -ForegroundColor Cyan
Write-Host ""

# Get ALL statuses from /latest for full view
try {
    $latest = Invoke-RestMethod $LATEST_URL
    $statuses = $latest.statuses
} catch { $statuses = $null }

if (-not $statuses) {
    Write-Host "No statuses saved yet. Click Draft/Ready/Posted on some posts in arc-viz." -ForegroundColor Yellow
    exit 0
}

# Map to spines from /ready response
$readyMap = @{}
foreach ($r in $readyResp.ready) { $readyMap[$r.index.ToString()] = $r.spine }

$ready = @(); $draft = @(); $posted = @()
foreach ($prop in $statuses.PSObject.Properties) {
    $i = $prop.Name; $s = $prop.Value
    $spine = if ($readyMap[$i]) { $readyMap[$i] } else { "Post $i" }
    if ($spine.Length -gt 75) { $spine = $spine.Substring(0, 72) + "..." }
    
    $color = switch ($s) {
        "ready"  { "Green" }
        "posted" { "Blue" }
        default  { "DarkGray" }
    }
    Write-Host "  [$i] " -NoNewline
    Write-Host $s.PadRight(8) -ForegroundColor $color -NoNewline
    Write-Host " $spine"
    
    if ($s -eq "ready") { $ready += $i }
    elseif ($s -eq "posted") { $posted += $i }
    else { $draft += $i }
}

Write-Host ""
Write-Host "SUMMARY: " -NoNewline
Write-Host "$($ready.Count) Ready" -ForegroundColor Green -NoNewline
Write-Host " | " -NoNewline
Write-Host "$($draft.Count) Draft" -ForegroundColor DarkGray -NoNewline
Write-Host " | " -NoNewline
Write-Host "$($posted.Count) Posted" -ForegroundColor Blue

if ($ready.Count -gt 0) {
    Write-Host ""
    Write-Host "READY posts: $($ready -join ', ')" -ForegroundColor Green
}
