# FlashForge Benchmarks — Before vs. After

Every architectural phase in FlashForge exists to solve a specific failure mode or bottleneck. This report measures the **before** and **after** of each decision on the same machine, using the same [k6](https://k6.io) + PostgreSQL verification harness (`loadtest/benchmark.ps1`).

## Test Environment

| Property | Value |
|---|---|
| Date | 2026-11-09 18:15 |
| CPU | AMD Ryzen 5 5600H with Radeon Graphics (6 cores / 12 threads) |
| RAM | 15 GB |
| Runtime | Node.js v22.14.0, PostgreSQL 17, RabbitMQ 4, Redis 7 (Docker) |
| Load generator | k6.exe v2.3.0 (commit/e088784614, go1.26.8, windows/amd64) |
| Topology note | API, worker, k6 and all Docker containers on ONE laptop (they compete for CPU). |

---

## Headline Summary (Resume Metrics)

| Engineering Problem | Naive / Before | FlashForge / After | Measured Impact |
|---|---|---|---|
| **Flash-sale overselling** (200 concurrent buyers, 10 units in stock) | Application-level `SELECT` → check → `UPDATE` created **135 orders** for 10 units (**oversold by 125 units**, 13.5× stock) | Single atomic `UPDATE … WHERE available >= qty` created **10 / 10 orders** across all runs | **100% elimination of overselling** (**0** oversold units across 3×200-VU bursts; all 5 DB conservation invariants pass) |
| **Catalog read bottleneck** (50 concurrent VUs hammering `GET /products` for 20s) | Uncached Postgres queries: **500 req/s**, p95 **150.9 ms**, **10,572** DB transactions | Redis read-through cache: **2,075 req/s**, p95 **36.6 ms**, **11** DB transactions | **4.1× lower p95 latency**, **4.1× higher throughput**, **99.90% reduction in Postgres queries** |
| **Slow payment gateway blocking HTTP threads** (gateway takes **2,000 ms** per charge) | Synchronous payment: measured **2,042.8 ms p95** (2,031.6 ms median); only **102** orders in 30s | Async RabbitMQ + transactional outbox returns `202 Accepted` in **19.9 ms p95** (12.7 ms median) | **103× faster checkout p95**; **2.9× higher throughput** (299 vs. 102 orders); **100%** of **299/299** confirmed |
| **Client retry storm** (50 orders × 20 concurrent retries = 1,000 requests) | Without idempotency keys: **994 orders** created (**944 duplicate orders**) | Scoped `Idempotency-Key` (Postgres `ON CONFLICT` + Redis cache): **50 orders** created (**0 duplicates**) | **944 duplicate orders prevented** (100% deduplication under concurrent retries) |
| **Single-row lock contention vs. multi-product load** (50 concurrent writers, 20s) | All 50 VUs contending on **1 hot product**: **112 orders/s** (p95 **600.1 ms**) | 50 VUs spread across **50 products**: **213 orders/s** (p95 **308.6 ms**) | **1.9× write throughput** and **1.9× lower p95 latency** when row locks don't serialize on one SKU |

---

## Experiment 1 — Atomic Inventory vs. Naive Read-Then-Write

**Scenario (`loadtest/flash-sale.js`):** 200 virtual users fire `POST /orders` at the exact same instant for a product with **10 units** of stock. Repeated 3 times per strategy, then verified directly in PostgreSQL (`loadtest/verify-db.ts`).

- **Naive baseline (`INVENTORY_STRATEGY=naive`):** Reads `availableQuantity` with `SELECT`, checks `available >= quantity` in TypeScript, and writes `availableQuantity - quantity` back. Under PostgreSQL's default `READ COMMITTED` isolation, concurrent `SELECT`s do not block each other; dozens of transactions read the same value, pass the check, and overwrite each other.
- **Atomic implementation (default):** `UPDATE "Inventory" SET "availableQuantity" = "availableQuantity" - $qty, "reservedQuantity" = "reservedQuantity" + $qty WHERE "productId" = $id AND "availableQuantity" >= $qty`. PostgreSQL serializes competing writers on the row lock and re-evaluates the `WHERE` predicate against the latest committed row.

| Strategy | Run | Stock | Orders Created in DB | Oversold Units | Inventory Row (`avail / reserved`) | p50 Latency | p95 Latency | p99 Latency | DB Invariants |
|---|---|---:|---:|---:|---|---:|---:|---:|---|
| Naive (`SELECT` then `UPDATE`) | #1 | 10 | **126** | **+116** | `0 / 10` ⚠️ | 1559.1 ms | 2176.9 ms | 2255.1 ms | ❌ FAILED |
| Naive (`SELECT` then `UPDATE`) | #2 | 10 | **129** | **+119** | `0 / 10` ⚠️ | 1336.7 ms | 1910.8 ms | 1935.6 ms | ❌ FAILED |
| Naive (`SELECT` then `UPDATE`) | #3 | 10 | **149** | **+139** | `0 / 10` ⚠️ | 1133.8 ms | 1633.5 ms | 1713.0 ms | ❌ FAILED |
| **Atomic conditional `UPDATE`** | #1 | 10 | **10** | **0** | `0 / 10` | 702.3 ms | 942.0 ms | 952.7 ms | ✅ PASSED |
| **Atomic conditional `UPDATE`** | #2 | 10 | **10** | **0** | `0 / 10` | 537.6 ms | 730.5 ms | 741.0 ms | ✅ PASSED |
| **Atomic conditional `UPDATE`** | #3 | 10 | **10** | **0** | `0 / 10` | 492.3 ms | 690.1 ms | 703.2 ms | ✅ PASSED |

> **Subtle bug caught by `verify-db.ts`:** Look at the `Inventory Row` column for the naive runs — it says `0 / 10`, which *looks* completely healthy! Because each racing transaction computed `inventory.availableQuantity - 1` from a stale read and overwrote the row (a classic **lost update**), the counter only decremented 10 times while **126–129–149 `Order` rows** were committed. Only cross-checking `Inventory.reservedQuantity` against `SUM(OrderItem.quantity)` in a `REPEATABLE READ` transaction exposes the corruption.

---

## Experiment 2 — Redis Read-Through Cache & Fail-Open Stampede Protection

**Scenario (`loadtest/throughput.js -e MODE=read`):** 50 concurrent VUs request `GET /products` in a tight loop (zero think time) for 20 seconds. We measure HTTP throughput, latency percentiles, and exact PostgreSQL transaction delta from `pg_stat_database`.

| Mode | Total HTTP Requests (20s) | Throughput | p50 Latency | p95 Latency | p99 Latency | Postgres Transactions | HTTP Error Rate |
|---|---:|---:|---:|---:|---:|---:|---:|
| Uncached (`PRODUCT_CACHE_TTL_SECONDS=0`, every read hits Postgres) | 10,903 | **500 req/s** | 84.8 ms | **150.9 ms** | 194.9 ms | **10,572** | 0.00% |
| **Redis read-through cache (`TTL=30s`)** | 42,236 | **2,075 req/s** | 21.7 ms | **36.6 ms** | 49.4 ms | **11** | 0.00% |
| Redis outage (fail-open + in-process single-flight coalescing) | 65,541 | **3,136 req/s** | 13.8 ms | **23.6 ms** | 36.0 ms | **1,257** | 0.00% |

- **Cache on vs. uncached:** **4.1× lower p95 latency** (150.9 ms → 36.6 ms), **4.1× higher throughput** (500 → 2,075 req/s), and **99.90% fewer PostgreSQL transactions** (10,572 → 11), freeing database connections for order transactions.
- **Redis outage resilience:** Even when Redis is completely unreachable, `enableOfflineQueue: false` fails open immediately with **0% HTTP errors**, and in-process **single-flight request coalescing** collapses 50 concurrent misses into a single database query at a time (**1,257** DB queries across 65,541 HTTP requests — a **98.1%** stampede reduction even without Redis).

---

## Experiment 3 — Write Contention: 1 Hot SKU vs. 50 SKUs

**Scenario (`loadtest/throughput.js`):** 50 concurrent VUs place orders (`POST /orders`, zero think time) for 20 seconds. Each order runs a full ACID transaction: user check → product snapshot → atomic inventory `UPDATE` → `Order` + `OrderItem` insert → `OutboxEvent` insert.

| Workload | Orders Committed (20s) | Write Throughput | p50 Latency | p95 Latency | p99 Latency |
|---|---:|---:|---:|---:|---:|
| 1 hot product (50 VUs contending on 1 inventory row) | 2,349 | **112 orders/s** | 411.2 ms | **600.1 ms** | 713.3 ms |
| **50 products (50 VUs spread across 50 inventory rows)** | 4,361 | **213 orders/s** | 221.2 ms | **308.6 ms** | 392.5 ms |

- When all 50 VUs hammer a **single row**, PostgreSQL serializes their `UPDATE` statements on that row lock (**112 orders/s**, p95 **600.1 ms**).
- Across **50 products**, row locks rarely collide and throughput jumps **1.9×** to **213 orders/s** with p95 dropping **1.9×** to **308.6 ms**.

---

## Experiment 4 — Async Payment Decoupling (RabbitMQ + Transactional Outbox)

**Scenario (`loadtest/sustained.js`):** 10 VUs continuously create and pay for orders over 30 seconds while we vary the simulated external payment gateway latency (`PAYMENT_DELAY_MS`) from **50 ms** to **500 ms** to **2,000 ms**.

In a synchronous design (`PAYMENT_MODE=sync`), `POST /orders/:id/pay` blocks the HTTP thread for the full gateway round-trip. With the transactional outbox + RabbitMQ worker (default), `POST /orders/:id/pay` only transitions the order state and writes an `OutboxEvent` row in PostgreSQL; payment processing happens asynchronously in the background.

| Gateway Latency (`PAYMENT_DELAY_MS`) | Sync `POST /pay` p95 (Before) | Async `POST /pay` p50 | Async `POST /pay` p95 | Async `POST /pay` p99 | Orders Paid (30s) | Orders Confirmed in DB | Invariants |
|---:|---:|---:|---:|---:|---:|---:|---|
| **50 ms** | **100.7 ms** (p50: 81.1 ms) | 12.6 ms | **20.4 ms** | 27.5 ms | 292 | **292 / 292** (open: 0) | ✅ PASSED |
| **500 ms** | **545.9 ms** (p50: 530.0 ms) | 12.2 ms | **20.1 ms** | 24.6 ms | 286 | **286 / 286** (open: 0) | ✅ PASSED |
| **2,000 ms** | **2,042.8 ms** (p50: 2,031.6 ms) | 12.7 ms | **19.9 ms** | 26.5 ms | 299 | **299 / 299** (open: 0) | ✅ PASSED |

- Even when the payment gateway slows down **40×** (from 50 ms to 2,000 ms), async `POST /pay` p95 stays flat at **19.9 ms** — a **103× latency reduction** vs. the measured sync baseline of **2,042.8 ms p95**.
- The worker processes up to `PAYMENT_WORKER_PREFETCH=10` payments concurrently in the background and drains 100% of the backlog (**299/299** orders confirmed at 2s gateway latency, 0 lost events).
- **Sync throughput degradation:** At 2,000 ms gateway latency, the sync design could only complete **102 paid orders** in 30s (10 VUs × ~3 orders each). The async design completed **299 paid orders** — **2.9× more throughput** because HTTP threads are never blocked.

---

## Experiment 5 — API Idempotency Under a Concurrent Retry Storm

**Scenario (`loadtest/idempotency.js`):** 100 concurrent VUs send **1,000 `POST /orders` requests** representing **50 logical orders**, each retried **20 times simultaneously** (simulating flaky mobile networks / aggressive client retries).

| Mode | HTTP Requests Sent | Orders Created in Postgres | Duplicate Orders | Units Reserved | p95 Latency | DB Invariants (`orders == 50`) |
|---|---:|---:|---:|---:|---:|---|
| Without `Idempotency-Key` (50 orders × 20 concurrent retries) | 1,000 | **994** | **+944** | 994 | 2039.8 ms | ❌ FAILED |
| **With `Idempotency-Key` (Postgres atomic claim + Redis replay cache)** | 1,000 | **50** | **0** | 50 | 1512.2 ms | ✅ PASSED |

- Without `Idempotency-Key`, all 1,000 retries execute, creating **994 orders** (**944 duplicates**) and locking **994 units** of inventory.
- With `Idempotency-Key`, `INSERT INTO "IdempotencyKey" … ON CONFLICT DO NOTHING` serializes concurrent retries of the same key on PostgreSQL's unique-index lock, commits the order once, caches the response in Redis, and replays the exact `201` response with `Idempotent-Replayed: true` to the remaining 950 retries (**50 orders created, 0 duplicates**).

---

## Reproducing These Numbers

```powershell
# 1. Start infrastructure
docker compose up -d
npm run db:seed

# 2. Run the full before/after benchmark suite (~6 minutes)
powershell -ExecutionPolicy Bypass -File loadtest/benchmark.ps1

# 3. Regenerate this document from loadtest/results/bench/*.json
node loadtest/report.mjs
```
