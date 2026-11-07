#!/usr/bin/env pwsh
# ─── Load test runner ────────────────────────────────────────────────────────
#
# Starts the API and worker with load-test-friendly settings, runs the
# specified k6 scenario, verifies inventory directly in Postgres, then stops
# everything cleanly.
#
# Usage:
#   .\loadtest\run.ps1 flash                    # 200 users, 10 units
#   .\loadtest\run.ps1 sustained                # steady load, 2 minutes
#   .\loadtest\run.ps1 sustained -Duration 30s  # shorter
#   .\loadtest\run.ps1 mixed                    # 80% reads / 20% writes, 1 minute
#
# Prerequisites: docker compose up -d, k6 on PATH, port 3000 free.
# API/worker logs go to loadtest/results/*.log.

param(
    [Parameter(Position=0)]
    [ValidateSet("flash", "sustained", "mixed")]
    [string]$Scenario = "flash",
    [string]$Duration = ""
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

# k6 installs to Program Files but the PATH change only applies to new shells.
if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) {
    $env:PATH += ";C:\Program Files\k6"
}

# ─── Env overrides for load testing ──────────────────────────────────────────
# Child processes inherit these; .env is untouched (dotenv never overrides
# variables that are already set).
$env:RATE_LIMIT_MAX = "10000"           # effectively no rate limit
$env:RATE_LIMIT_WINDOW_MS = "1000"
$env:PAYMENT_DELAY_MS = "50"            # fast payments so orders settle quickly
$env:PAYMENT_SUCCESS_RATE = "1.0"       # all succeed (we're testing the platform)
$env:LOG_LEVEL = "warn"                 # don't flood the logs
$env:PAYMENT_GATEWAY_TRANSIENT_FAILURES = "0"

$results = "loadtest/results"
New-Item -ItemType Directory -Force $results | Out-Null

Write-Host "`n═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host " FlashForge Load Test: $Scenario" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════`n" -ForegroundColor Cyan

# npx is a .cmd shim on Windows; Start-Process with redirection needs the real
# file name. Each process gets its own log files (stdout and stderr can't share).
function Start-Node($script, $name) {
    Start-Process -FilePath "npx.cmd" -ArgumentList "tsx", $script -PassThru -NoNewWindow `
        -RedirectStandardOutput "$results/$name.out.log" -RedirectStandardError "$results/$name.err.log"
}

# Stop-Process would only kill the cmd shim and orphan the node child that
# holds port 3000. taskkill /T kills the whole tree.
function Stop-Tree($proc) {
    if ($proc -and -not $proc.HasExited) { taskkill /PID $proc.Id /T /F 2>&1 | Out-Null }
}

$api = $null; $worker = $null
try {
    Write-Host "Starting API server..." -ForegroundColor Yellow
    $api = Start-Node "src/server.ts" "api"
    Write-Host "Starting worker..." -ForegroundColor Yellow
    $worker = Start-Node "src/worker.ts" "worker"

    # ─── Wait for API to be ready ────────────────────────────────────────────
    Write-Host "Waiting for API to be ready..." -ForegroundColor Yellow
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        # curl.exe + 127.0.0.1, not Invoke-RestMethod + localhost: Windows
        # PowerShell 5.1 tries IPv6 ::1 and proxy auto-detection first and
        # times out even though the API is up.
        $body = curl.exe -s -m 3 http://127.0.0.1:3000/health
        if ($LASTEXITCODE -eq 0 -and $body) {
            $r = $body | ConvertFrom-Json
            if ($r.postgres -eq "up") { $ready = $true; break }
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "API did not start in time (see $results/api.err.log)" }
    Write-Host "API ready: $($r | ConvertTo-Json -Compress -Depth 5)`n" -ForegroundColor Green

    # ─── Run k6 ──────────────────────────────────────────────────────────────
    $config = @{
        "flash"     = @{ script = "loadtest/flash-sale.js"; prefix = "Flash Sale"; stock = 10;  extra = @("--expect-accepted", "10") }
        "sustained" = @{ script = "loadtest/sustained.js";  prefix = "Sustained";  stock = 500; extra = @() }
        "mixed"     = @{ script = "loadtest/mixed.js";      prefix = "Mixed";      stock = 200; extra = @() }
    }[$Scenario]

    $k6Args = @("run", $config.script)
    if ($Duration) { $k6Args += @("-e", "DURATION=$Duration") }

    Write-Host "Running k6 scenario: $Scenario`n" -ForegroundColor Cyan
    & k6 @k6Args
    $k6Exit = $LASTEXITCODE

    # ─── Verify inventory in Postgres ────────────────────────────────────────
    # --settle waits (up to 20s) for in-flight payments so sold/open is stable.
    Write-Host "`nVerifying inventory in Postgres..." -ForegroundColor Yellow
    & npx.cmd tsx loadtest/verify-db.ts --prefix $config.prefix --stock $config.stock --settle 20 @($config.extra)
    $verifyExit = $LASTEXITCODE
}
finally {
    Write-Host "`nStopping API and worker..." -ForegroundColor Yellow
    Stop-Tree $api
    Stop-Tree $worker
}

Write-Host "`n═══════════════════════════════════════════" -ForegroundColor Cyan
if ($k6Exit -eq 0 -and $verifyExit -eq 0) {
    Write-Host " ✅ Load test PASSED (thresholds + inventory invariants)" -ForegroundColor Green
    $code = 0
} else {
    if ($k6Exit -ne 0) { Write-Host " ❌ k6 thresholds breached" -ForegroundColor Red }
    if ($verifyExit -ne 0) { Write-Host " ❌ Inventory invariants violated" -ForegroundColor Red }
    $code = 1
}
Write-Host "═══════════════════════════════════════════`n" -ForegroundColor Cyan
exit $code
