# tag-ready.ps1 — Creates the "Ready" tag in Postiz if it doesn't exist
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$api = 'http://localhost:3000'

# ── Login ──
Write-Host "[1] Login..." -ForegroundColor Yellow
$h = New-Object System.Net.Http.HttpClientHandler; $h.AllowAutoRedirect = $false
$client = New-Object System.Net.Http.HttpClient($h)
$loginBody = @{ email='steven.oppong@gmail.com'; password='inauthenticReadytoSchedule21?'; provider='LOCAL' } | ConvertTo-Json
$sc = New-Object System.Net.Http.StringContent($loginBody, [System.Text.Encoding]::UTF8, 'application/json')
$r = $client.PostAsync("$api/auth/login", $sc).Result
$auth = $null
if ($r.Headers.Contains('Set-Cookie')) { foreach ($s in $r.Headers.GetValues('Set-Cookie')) { if ($s -match 'auth=([^;]+)') { $auth = $matches[1] } } }
if (-not $auth) { throw 'no auth token' }
Write-Host "  OK" -ForegroundColor Green

# ── Check existing tags ──
Write-Host "`n[2] Checking existing tags..." -ForegroundColor Yellow
$req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, "$api/posts/tags")
$req.Headers.Add('auth', $auth)
$rt = $client.SendAsync($req).Result
$tagsResp = $rt.Content.ReadAsStringAsync().Result | ConvertFrom-Json
$existing = @($tagsResp.tags | Where-Object { $_.name -eq 'Ready' })
if ($existing.Count -gt 0) {
    Write-Host "  Tag 'Ready' already exists (id: $($existing[0].id))" -ForegroundColor Green
} else {
    Write-Host "  Creating 'Ready' tag..." -ForegroundColor Yellow
    $tagBody = @{ name='Ready'; color='#22C55E' } | ConvertTo-Json
    $sc2 = New-Object System.Net.Http.StringContent($tagBody, [System.Text.Encoding]::UTF8, 'application/json')
    $req2 = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$api/posts/tags")
    $req2.Headers.Add('auth', $auth)
    $req2.Content = $sc2
    $rt2 = $client.SendAsync($req2).Result
    $newTag = $rt2.Content.ReadAsStringAsync().Result | ConvertFrom-Json
    Write-Host "  Created 'Ready' tag (name: $($newTag.name), id: $($newTag.id))" -ForegroundColor Green
}

Write-Host "`nDone." -ForegroundColor Cyan
