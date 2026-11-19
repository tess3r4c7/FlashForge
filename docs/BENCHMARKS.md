# FlashForge Benchmarks: Before vs After

Each architectural decision in FlashForge is measured against the simpler design it replaced, on the same machine, with the same harness, minutes apart.

- **Harness:** [`loadtest/benchmark.ps1`](../loadtest/benchmark.ps1) runs every experiment; [`loadtest/report.mjs`](../loadtest/report.mjs) generates this file.
- **Correctness:** checked in PostgreSQL after each run by [`loadtest/verify-db.ts`](../loadtest/verify-db.ts), not just inferred from HTTP status codes.
- **Raw data:** every number below comes from a JSON file in [`docs/benchmark-data/`](benchmark-data/).

## Environment

| | |
|---|---|
| Date | 2026-11-16 02:15 |
| CPU | AMD Ryzen 5 5600H with Radeon Graphics (6 cores / 12 threads), 15 GB RAM |
| Software | Node.js v22.14.0, PostgreSQL 17, RabbitMQ 4, Redis 7 (Docker Desktop) |
| Load generator | k6.exe v2.3.0 (commit/e088784614, go1.26.8, windows/amd64) |

> [!IMPORTANT]
> Everything (API, worker, Postgres, RabbitMQ, Redis **and** k6 itself) runs on one laptop and competes for the same CPU. Absolute numbers are laptop numbers. The **before/after ratios** are the meaningful part, because both sides ran under identical conditions. The Prisma/pg connection pool is the library default (10 connections), so write-heavy runs queue for connections.

---

## Summary

| Problem | Before | After | Result |
|---|---|---|---|
| Overselling (200 concurrent buyers, 10 units, 3 runs each) | Read-check-write: **126–149 orders** for 10 units | Atomic conditional `UPDATE`: **10 orders**, every run | **0 oversold units**, all DB invariants pass |
| Payment latency, gateway takes 2 s | Synchronous: `POST /pay` p95 **2042.8 ms** | Outbox + RabbitMQ: p95 **19.9 ms** | **102.7× lower p95**, 299/299 orders confirmed |
| Catalog reads, `GET /products` (~13 KB), 50 VUs | No cache: **561 req/s**, p95 149.2 ms, 11,083 DB txns | Redis cache: **1,960 req/s**, p95 35.6 ms, 12 DB txns | **3.5× throughput**, **99.9% fewer** DB transactions |
| Redis outage during the read load | — | Fail-open: **3,050 req/s**, 0 failed requests | Reads keep working; DB protected by single-flight |
| Retry storm (50 orders × 20 concurrent retries) | No key: **994 orders** | `Idempotency-Key`: **50 orders** | **0 duplicates** (0 failed requests) |
| Write contention (50 VUs, 20 s) | 1 hot product: **112 orders/s** | 50 products: **213 orders/s** | **1.9×** throughput once writers stop queuing on one row lock |

---

## 1. Overselling: naive read-check-write vs atomic `UPDATE`

**Load:** [`flash-sale.js`](../loadtest/flash-sale.js). 200 VUs send `POST /orders` at the same instant for a product with 10 units. 3 runs per strategy, fresh product each run.

- **Naive** (`INVENTORY_STRATEGY=naive`, benchmark-only): `SELECT` the row, check `available >= qty` in TypeScript, `UPDATE` with the value computed from the read.
- **Atomic** (the real code): `UPDATE … SET available = available - qty … WHERE productId = $1 AND available >= qty`, then check the affected row count.

| Strategy | Run | Orders in DB | Oversold | Inventory row (avail / reserved) | p50 | p95 | Invariants |
|---|---|---:|---:|---|---:|---:|---|
| Naive | 1 | **126** | +116 | 0 / 10 | 1559.1 ms | 2176.9 ms | ❌ |
| Naive | 2 | **129** | +119 | 0 / 10 | 1336.7 ms | 1910.8 ms | ❌ |
| Naive | 3 | **149** | +139 | 0 / 10 | 1133.8 ms | 1633.5 ms | ❌ |
| Atomic | 1 | **10** | 0 | 0 / 10 | 702.3 ms | 942.0 ms | ✅ |
| Atomic | 2 | **10** | 0 | 0 / 10 | 537.6 ms | 730.5 ms | ✅ |
| Atomic | 3 | **10** | 0 | 0 / 10 | 492.3 ms | 690.1 ms | ✅ |

**Why the naive inventory row still looks healthy.** Every racing transaction wrote `available = <stale value> − 1`, so the writes overwrote each other (a *lost update*). The counter only went down 10 times while 126–149 order rows were committed. Looking at the inventory row alone, you'd never know. The verifier catches it by comparing `reservedQuantity` with `SUM(OrderItem.quantity)` inside one `REPEATABLE READ` snapshot.

**Why the naive version is also slower.** Its p95 is 1.6–2.2 s versus 0.7–0.9 s for atomic, because about 130 transactions run to completion (inserting orders and outbox rows) instead of about 190 of them failing fast with a 409.

---

## 2. Read caching: none vs Redis vs Redis down

**Load:** [`throughput.js`](../loadtest/throughput.js). 50 VUs with no think time for 20 s, no worker running. "DB txns" is the change in `pg_stat_database` (commits + rollbacks) over the run. "No cache" means `PRODUCT_CACHE_TTL_SECONDS=0`, which bypasses Redis **and** single-flight coalescing.

### `GET /products`: the full list (~13 KB JSON, a few hundred rows)

| Mode | Requests | Throughput | p50 | p95 | p99 | DB txns | Failed |
|---|---:|---:|---:|---:|---:|---:|---:|
| No cache | 11,330 | **561 req/s** | 78.9 ms | 149.2 ms | 242.7 ms | 11,083 | 0 |
| Redis read-through (TTL 30 s) | 39,616 | **1,960 req/s** | 23.7 ms | 35.6 ms | 46.0 ms | 12 | 0 |
| Redis down (fail-open + single-flight) | 61,364 | **3,050 req/s** | 15.1 ms | 24.5 ms | 30.0 ms | 1,191 | 0 |

### `GET /products/:id`: one row by primary key

| Mode | Requests | Throughput | p50 | p95 | p99 | DB txns | Failed |
|---|---:|---:|---:|---:|---:|---:|---:|
| No cache | 23,170 | **1,151 req/s** | 39.5 ms | 65.1 ms | 94.2 ms | 22,312 | 0 |
| Redis read-through (TTL 30 s) | 72,142 | **3,586 req/s** | 12.9 ms | 20.0 ms | 25.0 ms | 9 | 0 |
| Redis down (fail-open + single-flight) | 87,909 | **4,370 req/s** | 10.4 ms | 17.4 ms | 24.4 ms | 1,683 | 0 |

### What this shows (including the unflattering part)

1. **Redis pays off on both reads under 50-VU concurrency.** For the full list (`GET /products`, ~13 KB) it gave **3.5×** throughput (561 → 1,960 req/s), **4.2×** lower p95 (149.2 ms → 35.6 ms), and cut DB transactions by **99.9%** (11,083 → 12). Even a single-row primary-key lookup (`GET /products/:id`) gained **3.1×** throughput (1,151 → 3,586 req/s) because uncached reads queue behind Prisma's 10-connection pool.
2. **With Redis down, the API was *faster* than with Redis up, on one instance under constant saturation.** That's not a bug. Single-flight coalescing makes every request that arrives while a DB query is in flight share that one query's result *in memory*: no network hop, no `JSON.parse` of 13 KB. Under 50 VUs with zero think time there is *always* a query in flight, so coalescing behaves like a free in-process cache.
   - **Why Redis is still the right design:** coalescing only dedups requests that overlap in time *within one process*. With N API instances, or burstier traffic, every gap between requests becomes a fresh DB query. Redis bounds DB load to about one query per key per TTL **across all instances**.
   - **The obvious next optimisation** this measurement points to: store the serialised response in Redis and send it as-is, skipping `JSON.parse` → re-serialise on every hit. Not done yet.
3. **The fail-open path held:** 0 failed requests out of 61,364 with Redis unreachable.

---

## 3. Write contention: one hot product vs 50 products

**Load:** [`throughput.js`](../loadtest/throughput.js). 50 VUs, no think time, 20 s, `POST /orders` with plenty of stock. Every order is a full transaction: user check, price snapshot, atomic inventory `UPDATE`, `Order` + `OrderItem` + `OutboxEvent` inserts.

| Workload | Orders | Throughput | p50 | p95 | p99 | Failed |
|---|---:|---:|---:|---:|---:|---:|
| 1 product (every writer locks the same row) | 2,349 | **112 orders/s** | 411.2 ms | 600.1 ms | 713.3 ms | 0 |
| 50 products (writers mostly lock different rows) | 4,361 | **213 orders/s** | 221.2 ms | 308.6 ms | 392.5 ms | 0 |

The atomic `UPDATE` is correct, but it serialises writers *on the same row*. Spreading the same load over 50 products roughly doubles throughput. Both runs also queue for the 10-connection pool, which is why p50 is hundreds of milliseconds even without contention. A raised pool size or a second API instance would be the next lever, but that isn't measured here.

---

## 4. Payments: synchronous vs async (transactional outbox + RabbitMQ)

**Load:** [`sustained.js`](../loadtest/sustained.js). 10 VUs loop for 30 s: create an order, pay, think for 0.5–1.5 s. Gateway latency is simulated (`PAYMENT_DELAY_MS`).

- **Sync** (`PAYMENT_MODE=sync`, benchmark-only, the Phase 2 design): `POST /pay` calls the gateway inside the request and returns `200` once the order is confirmed. No worker.
- **Async** (the real code): `POST /pay` marks the order `PAYMENT_PROCESSING`, writes a `payment.requested` outbox row in the same transaction, and returns `202`. The worker charges the gateway. The verifier waits up to 120 s for the backlog to drain.

| Gateway delay | Mode | `POST /pay` p50 | p95 | p99 | Orders paid in 30 s | Confirmed in DB | Invariants |
|---:|---|---:|---:|---:|---:|---:|---|
| **50 ms** | Sync | 81.1 ms | **100.7 ms** | 118.3 ms | 282 | 282 / 282 | ✅ |
|  | **Async** | 12.6 ms | **20.4 ms** | 27.5 ms | 292 | 292 / 292 | ✅ |
| **500 ms** | Sync | 530.0 ms | **545.9 ms** | 552.4 ms | 199 | 199 / 199 | ✅ |
|  | **Async** | 12.2 ms | **20.1 ms** | 24.6 ms | 286 | 286 / 286 | ✅ |
| **2,000 ms** | Sync | 2031.6 ms | **2042.8 ms** | 2050.8 ms | 102 | 102 / 102 | ✅ |
|  | **Async** | 12.7 ms | **19.9 ms** | 26.5 ms | 299 | 299 / 299 | ✅ |

- With a 2 s gateway, the synchronous endpoint's p95 is **2042.8 ms** and the async one is **19.9 ms** (**102.7×** lower). Async `POST /pay` latency stays flat as gateway latency grows 40×. Sync latency tracks the gateway one-for-one.
- In 30 s the same 10 users completed **299** payments async versus **102** sync, because sync users sit waiting on the gateway.
- **All** async payments were confirmed by the worker afterwards (299/299 at 2 s), and every invariant held. The trade-off: the customer learns the outcome a moment later, by polling `GET /orders/:id`.
- Gateway capacity is unchanged: the worker processes `PAYMENT_WORKER_PREFETCH=10` charges at a time, so at 2 s per charge it drains about 5 per second. Async moves the waiting off the HTTP request; it does not make the gateway faster.

---

## 5. Idempotency keys under a retry storm

**Load:** [`idempotency.js`](../loadtest/idempotency.js). 100 VUs send 1,000 `POST /orders` requests: 50 logical orders, each sent 20 times concurrently.

| Mode | Requests | Orders in DB | Duplicates | Failed requests | p95 | Invariants (`orders == 50`) |
|---|---:|---:|---:|---:|---:|---|
| No `Idempotency-Key` | 1,000 | **994** | 944 | 6 | 2039.8 ms | ❌ |
| `Idempotency-Key` | 1,000 | **50** | 0 | 0 | 1512.2 ms | ✅ |

- Without keys, 994 orders were created. The other 6 requests failed with **HTTP 500** (`Unable to start a transaction in the given time`): 100 concurrent transactions were competing for a 10-connection pool, and Prisma gave up waiting after its 2 s default. That's a real finding. Under this load the pool is the bottleneck, and a production deployment would size it (or add PgBouncer) and return 503 + `Retry-After` for that error instead of 500.
- With keys, `INSERT … ON CONFLICT DO NOTHING` on `(userId, key)` makes concurrent copies wait on the first copy's uncommitted row. When it commits, they replay its stored `201` response (`Idempotent-Replayed: true`). Exactly 50 orders were created.

---

## Limitations

- **One machine.** Load generator and system share a CPU, and nothing crosses a real network.
- **Single runs** for experiments 2–5 (experiment 1 has 3 runs per side). Expect roughly ±15% run-to-run variation in latency numbers. The first run after an API restart includes JIT warm-up.
- **Benchmark-only baselines** (`INVENTORY_STRATEGY=naive`, `PAYMENT_MODE=sync`) exist in the code purely so the "before" is measured rather than assumed. Both log a warning at startup and are never set by `.env`, compose or tests.

## Reproduce

```powershell
docker compose up -d          # infrastructure only
npm run db:seed
npm run bench                 # runs every experiment (~15 min), then regenerates this file
```
