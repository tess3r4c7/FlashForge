#!/usr/bin/env pwsh
# ─── FlashForge benchmark suite ──────────────────────────────────────────────
#
# Every resume claim gets a BEFORE/AFTER measured on the same machine, with
# the same harness, minutes apart. Raw results land in loadtest/results/bench/
# and `node loadtest/report.mjs` turns them into docs/BENCHMARKS.md.
#
#   .\loadtest\benchmark.ps1                        # everything (~10 min)
#   .\loadtest\benchmark.ps1 -Only oversell,cache   # a subset
#
# Experiments:
#   oversell     naive read-check-write vs atomic UPDATE, 200 users / 10 units, 3 runs each
#   cache        read capacity (list + single product): uncached vs Redis vs Redis down
#   hotrow       POST /orders capacity, 1 hot product vs 50 products
#   async        POST /pay synchronous vs async, gateway 50ms / 500ms / 2000ms
#   idempotency  1,000 concurrent retries of 50 orders, with vs without Idempotency-Key
#
# Prerequisites: docker compose up -d (infra only), k6 installed, port 3000 free.

param([string[]]$Only = @())

$ErrorActionPreference = "Continue"
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) { $env:PATH += ";C:\Program Files\k6" }

$out = "loadtest/results/bench"
New-Item -ItemType Directory -Force $out | Out-Null

$OnlyList = @($Only | ForEach-Object { $_ -split "," } | Where-Object { $_ })
function Want($name) { return ($OnlyList.Count -eq 0) -or ($OnlyList -contains $name) }

# ─── Baseline environment for every run ──────────────────────────────────────
# Rate limit off (all virtual users are user #1), fast and always-successful
# payments unless an experiment overrides them.
$Base = [ordered]@{
    RATE_LIMIT_MAX                     = "1000000"
    RATE_LIMIT_WINDOW_MS               = "1000"
    PAYMENT_DELAY_MS                   = "50"
    PAYMENT_SUCCESS_RATE               = "1.0"
    PAYMENT_GATEWAY_TRANSIENT_FAILURES = "0"
    LOG_LEVEL                          = "warn"
    PRODUCT_CACHE_TTL_SECONDS          = "30"
    INVENTORY_STRATEGY                 = ""
    PAYMENT_MODE                       = ""
    REDIS_URL                          = "redis://localhost:6379"
}

$script:api = $null; $script:worker = $null

function Stop-Tree($proc) {
    if ($proc -and -not $proc.HasExited) { taskkill /PID $proc.Id /T /F 2>&1 | Out-Null }
}

function Stop-App {
    Stop-Tree $script:api; Stop-Tree $script:worker
    $script:api = $null; $script:worker = $null
    Start-Sleep -Seconds 1
}

function Start-App([hashtable]$Overrides = @{}, [switch]$NoWorker) {
    Stop-App
    foreach ($k in $Base.Keys) {
        $v = $Base[$k]
        if ($Overrides.ContainsKey($k)) { $v = $Overrides[$k] }
        if ($v -eq "") { Remove-Item "env:$k" -ErrorAction SilentlyContinue } else { Set-Item "env:$k" $v }
    }
    $script:api = Start-Process -FilePath "npx.cmd" -ArgumentList "tsx", "src/server.ts" -PassThru -NoNewWindow `
        -RedirectStandardOutput "$out/api.out.log" -RedirectStandardError "$out/api.err.log"
    if (-not $NoWorker) {
        $script:worker = Start-Process -FilePath "npx.cmd" -ArgumentList "tsx", "src/worker.ts" -PassThru -NoNewWindow `
            -RedirectStandardOutput "$out/worker.out.log" -RedirectStandardError "$out/worker.err.log"
    }
    for ($i = 0; $i -lt 40; $i++) {
        $body = curl.exe -s -m 3 http://127.0.0.1:3000/health
        if ($LASTEXITCODE -eq 0 -and $body -and ($body | ConvertFrom-Json).postgres -eq "up") {
            Start-Sleep -Seconds 2   # let the worker connect too
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "API did not start (see $out/api.err.log)"
}

function Run-K6([string]$Label, [string]$Script, [hashtable]$K6Env = @{}) {
    Write-Host "  k6 $Label ..." -ForegroundColor Cyan
    $envArgs = @()
    foreach ($k in $K6Env.PSBase.Keys) { $envArgs += @("-e", "$k=$($K6Env[$k])") }
    & k6 run --summary-trend-stats "avg,med,p(90),p(95),p(99),max" `
        --summary-export "$out/$Label.k6.json" @envArgs $Script *> "$out/$Label.k6.txt"
}

function Verify([string]$Label, [string]$Prefix, [int]$Stock, [int]$Settle = 0, [string[]]$Extra = @()) {
    & npx.cmd tsx loadtest/verify-db.ts --prefix $Prefix --stock $Stock --settle $Settle --out "$out/$Label.verify.json" @Extra *> "$out/$Label.verify.txt"
}

# Postgres transactions committed + rolled back in the dev database. The
# difference across a run = how many DB round-trips the run caused.
function Get-DbXacts {
    Start-Sleep -Seconds 2   # backends flush their stats counters periodically
    $v = docker exec flashforge-postgres psql -U flashforge -d flashforge -tAc "SELECT xact_commit + xact_rollback FROM pg_stat_database WHERE datname = 'flashforge'"
    return [int64]($v | Select-Object -First 1)
}

function Save-Json([string]$Label, $Object) {
    $Object | ConvertTo-Json -Depth 5 | Set-Content "$out/$Label.extra.json"
}

# ─── Environment record (so results are interpretable later) ────────────────
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1)
$ramGb = [Math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
[ordered]@{
    date    = (Get-Date -Format "yyyy-MM-dd HH:mm")
    cpu     = $cpu.Name.Trim()
    cores   = $cpu.NumberOfCores
    threads = $cpu.NumberOfLogicalProcessors
    ramGb   = $ramGb
    os      = (Get-CimInstance Win32_OperatingSystem).Caption
    node    = (node -v)
    k6      = ((k6 version) -split "`n" | Select-Object -First 1)
    note    = "API, worker, k6 and all Docker containers on ONE laptop (they compete for CPU)."
} | ConvertTo-Json | Set-Content "$out/environment.json"

try {
    # ─── 1. Overselling: naive vs atomic ─────────────────────────────────────
    if (Want "oversell") {
        Write-Host "`n[oversell] naive read-check-write vs atomic UPDATE" -ForegroundColor Yellow
        foreach ($strategy in @("naive", "atomic")) {
            $ov = @{}; if ($strategy -eq "naive") { $ov.INVENTORY_STRATEGY = "naive" }
            Start-App $ov -NoWorker
            foreach ($run in 1..3) {
                $label = "oversell-$strategy-$run"
                Run-K6 $label "loadtest/flash-sale.js" @{ STOCK = "10"; VUS = "200" }
                Verify $label "Flash Sale" 10
            }
        }
    }

    # ─── 2. Cache: uncached vs Redis cache vs Redis outage (fail-open) ──────
    # Two endpoints, because the answer differs:
    #   read      GET /products     ~13 KB list, the expensive query
    #   read-one  GET /products/:id one row by primary key, already sub-ms in Postgres
    if (Want "cache") {
        Write-Host "`n[cache] read capacity: uncached vs Redis vs Redis down" -ForegroundColor Yellow
        $endpoints = [ordered]@{ "cache" = "read"; "cache1" = "read-one" }
        $cases = [ordered]@{
            "off"        = @{ PRODUCT_CACHE_TTL_SECONDS = "0" }   # bypasses Redis AND single-flight
            "on"         = @{ PRODUCT_CACHE_TTL_SECONDS = "30" }
            "redis-down" = @{ PRODUCT_CACHE_TTL_SECONDS = "30"; REDIS_URL = "redis://127.0.0.1:6390" }
        }
        foreach ($prefix in $endpoints.PSBase.Keys) {
            foreach ($case in $cases.PSBase.Keys) {
                $label = "$prefix-$case"
                Start-App $cases[$case] -NoWorker   # no worker: its polling would pollute the DB counter
                $before = Get-DbXacts
                Run-K6 $label "loadtest/throughput.js" @{ MODE = $endpoints[$prefix]; VUS = "50"; DURATION = "20s" }
                $after = Get-DbXacts
                Save-Json $label @{ dbTransactions = ($after - $before) }
            }
        }
    }
    # ─── 3. Hot row vs spread writes ─────────────────────────────────────────
    if (Want "hotrow") {
        Write-Host "`n[hotrow] POST /orders capacity, 1 product vs 50" -ForegroundColor Yellow
        Start-App @{} -NoWorker
        Run-K6 "write-hot" "loadtest/throughput.js" @{ MODE = "write"; VUS = "50"; DURATION = "20s" }
        Run-K6 "write-spread" "loadtest/throughput.js" @{ MODE = "write-spread"; VUS = "50"; DURATION = "20s"; PRODUCTS = "50" }
    }

    # ─── 4. Payments: synchronous (Phase 2) vs async outbox + worker ────────
    # Same load (10 VUs create + pay for 30s), same gateway delays. "sync"
    # charges the gateway inside the HTTP request (PAYMENT_MODE=sync baseline);
    # "async" returns 202 and lets the worker charge.
    if (Want "async") {
        Write-Host "`n[async] POST /pay: synchronous vs async, gateway 50/500/2000ms" -ForegroundColor Yellow
        foreach ($delay in @("50", "500", "2000")) {
            $label = "sync-gw$delay"
            Start-App @{ PAYMENT_DELAY_MS = $delay; PAYMENT_MODE = "sync" } -NoWorker
            Run-K6 $label "loadtest/sustained.js" @{ DURATION = "30s" }
            Verify $label "Sustained" 500 0

            $label = "async-gw$delay"
            Start-App @{ PAYMENT_DELAY_MS = $delay }
            Run-K6 $label "loadtest/sustained.js" @{ DURATION = "30s" }
            # Slow gateways leave a backlog; let the worker drain it, then check
            # that every paid order was confirmed and nothing leaked.
            Verify $label "Sustained" 500 120
        }
    }
    # ─── 5. Idempotency under a retry storm ──────────────────────────────────
    if (Want "idempotency") {
        Write-Host "`n[idempotency] 50 orders x 20 concurrent retries" -ForegroundColor Yellow
        Start-App @{} -NoWorker
        Run-K6 "idem-keyed" "loadtest/idempotency.js" @{ USE_KEY = "true"; KEYS = "50"; COPIES = "20" }
        Verify "idem-keyed" "Idempotency keyed" 100000 0 @("--expect-accepted", "50")
        Run-K6 "idem-unkeyed" "loadtest/idempotency.js" @{ USE_KEY = "false"; KEYS = "50"; COPIES = "20" }
        Verify "idem-unkeyed" "Idempotency unkeyed" 100000 0 @("--expect-accepted", "50")
    }
}
finally {
    Stop-App
}

Write-Host "`nDone. Raw results in $out. Build the report with: node loadtest/report.mjs`n" -ForegroundColor Green

