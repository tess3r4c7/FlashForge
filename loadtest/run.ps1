#!/usr/bin/env pwsh
# ─── Load test runner ────────────────────────────────────────────────────────
#
# Starts the API and worker with load-test-friendly settings, runs the
# specified k6 scenario, then stops everything cleanly.
#
# Usage:
#   .\loadtest\run.ps1 flash        # flash sale (200 users, 10 units)
#   .\loadtest\run.ps1 sustained    # steady load for 2 minutes
#   .\loadtest\run.ps1 mixed        # 80% reads / 20% writes

param(
    [Parameter(Position=0)]
    [ValidateSet("flash", "sustained", "mixed")]
    [string]$Scenario = "flash"
)

$ErrorActionPreference = "Stop"

# ─── Env overrides for load testing ──────────────────────────────────────────
$env:RATE_LIMIT_MAX = "10000"           # effectively no rate limit
$env:RATE_LIMIT_WINDOW_MS = "1000"
$env:PAYMENT_DELAY_MS = "50"            # fast payments so orders settle quickly
$env:PAYMENT_SUCCESS_RATE = "1.0"       # all succeed (we're testing the platform)
$env:LOG_LEVEL = "warn"                 # don't flood the console
$env:PAYMENT_GATEWAY_TRANSIENT_FAILURES = "0"

Write-Host "`n═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host " FlashForge Load Test: $Scenario" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════`n" -ForegroundColor Cyan

# ─── Start API ───────────────────────────────────────────────────────────────
Write-Host "Starting API server..." -ForegroundColor Yellow
$api = Start-Process -FilePath "npx" -ArgumentList "tsx src/server.ts" -PassThru -NoNewWindow -RedirectStandardError "NUL"
Start-Sleep -Seconds 2

# ─── Start Worker ────────────────────────────────────────────────────────────
Write-Host "Starting worker..." -ForegroundColor Yellow
$worker = Start-Process -FilePath "npx" -ArgumentList "tsx src/worker.ts" -PassThru -NoNewWindow -RedirectStandardError "NUL"
Start-Sleep -Seconds 3

# ─── Wait for API to be ready ────────────────────────────────────────────────
Write-Host "Waiting for API to be ready..." -ForegroundColor Yellow
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        $r = Invoke-RestMethod -Uri "http://localhost:3000/health" -ErrorAction SilentlyContinue
        if ($r.postgres -eq "up") { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    Write-Host "API did not start in time!" -ForegroundColor Red
    Stop-Process $api -Force -ErrorAction SilentlyContinue
    Stop-Process $worker -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "API ready: $($r | ConvertTo-Json -Compress)`n" -ForegroundColor Green

# ─── Run k6 ─────────────────────────────────────────────────────────────────
$scriptMap = @{
    "flash"     = "loadtest/flash-sale.js"
    "sustained" = "loadtest/sustained.js"
    "mixed"     = "loadtest/mixed.js"
}

Write-Host "Running k6 scenario: $Scenario`n" -ForegroundColor Cyan
& k6 run $scriptMap[$Scenario]
$k6Exit = $LASTEXITCODE

# ─── Cleanup ─────────────────────────────────────────────────────────────────
Write-Host "`nStopping API and worker..." -ForegroundColor Yellow
Stop-Process $api -Force -ErrorAction SilentlyContinue
Stop-Process $worker -Force -ErrorAction SilentlyContinue

Write-Host "`n═══════════════════════════════════════════" -ForegroundColor Cyan
if ($k6Exit -eq 0) {
    Write-Host " ✅ Load test PASSED" -ForegroundColor Green
} else {
    Write-Host " ❌ Load test FAILED (thresholds breached)" -ForegroundColor Red
}
Write-Host "═══════════════════════════════════════════`n" -ForegroundColor Cyan

exit $k6Exit

