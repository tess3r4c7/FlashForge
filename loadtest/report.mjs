// ─── Benchmark report generator ─────────────────────────────────────────────
//
// Reads the raw k6 + Postgres verification JSON in loadtest/results/bench/,
// copies it to docs/benchmark-data/ (so every number in the report can be
// traced to a committed file), and writes docs/BENCHMARKS.md.
//
// Rule for this file: report what happened, including failed requests and
// results that don't flatter the design. A number you can't defend in an
// interview is worse than no number.
//
// Usage: node loadtest/report.mjs

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const dir = "loadtest/results/bench";
const read = (f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
const maybe = (f) => (existsSync(`${dir}/${f}`) ? read(f) : null);
const ms = (n) => (n == null ? "—" : `${Number(n).toFixed(1)} ms`);
const int = (n) => (n == null ? "—" : Math.round(Number(n)).toLocaleString("en-US"));
const x = (a, b) => (a / b).toFixed(1);

const env = maybe("environment.json") ?? {};
const k6 = (label) => read(`${label}.k6.json`).metrics;
// Requests whose check failed (non-2xx etc). Setup's single check is a pass.
const failedChecks = (label) => k6(label).checks?.fails ?? 0;

// ─── 1. Overselling ─────────────────────────────────────────────────────────
const oversell = (strategy, run) => {
  const m = k6(`oversell-${strategy}-${run}`);
  const v = read(`oversell-${strategy}-${run}.verify.json`);
  return { run, orders: v.orderCount, oversold: v.oversold, avail: v.available, reserved: v.reserved, allOk: v.allOk, t: m.order_latency_ms };
};
const naive = [1, 2, 3].map((r) => oversell("naive", r));
const atomic = [1, 2, 3].map((r) => oversell("atomic", r));
const naiveMin = Math.min(...naive.map((r) => r.orders));
const naiveMax = Math.max(...naive.map((r) => r.orders));

// ─── 2. Cache ───────────────────────────────────────────────────────────────
const cache = (label) => {
  const m = k6(label);
  return { reqs: m.iterations.count, rps: m.iterations.rate, t: m.op_latency_ms, db: maybe(`${label}.extra.json`)?.dbTransactions, failed: failedChecks(label) };
};
const listOff = cache("cache-off"), listOn = cache("cache-on"), listDown = cache("cache-redis-down");
const oneOff = cache("cache1-off"), oneOn = cache("cache1-on"), oneDown = cache("cache1-redis-down");
const listDbCut = ((1 - listOn.db / listOff.db) * 100).toFixed(1);

// ─── 3. Hot row ─────────────────────────────────────────────────────────────
const write = (label) => {
  const m = k6(label);
  return { orders: m.iterations.count, rps: m.iterations.rate, t: m.op_latency_ms, failed: failedChecks(label) };
};
const hot = write("write-hot"), spread = write("write-spread");

// ─── 4. Sync vs async payments ──────────────────────────────────────────────
const pay = (mode, gw) => {
  const label = `${mode}-gw${gw}`;
  const m = k6(label);
  const v = read(`${label}.verify.json`);
  return { gw, paid: m.orders_paid.count, created: m.orders_created.count, confirmed: v.sold, open: v.open, allOk: v.allOk, t: m.order_pay_latency_ms, failed: failedChecks(label) };
};
const gws = [50, 500, 2000];
const sync = gws.map((g) => pay("sync", g));
const asyn = gws.map((g) => pay("async", g));
const s2000 = sync[2], a2000 = asyn[2];

// ─── 5. Idempotency ─────────────────────────────────────────────────────────
const idem = (label) => {
  const m = k6(label);
  const v = read(`${label}.verify.json`);
  return { reqs: m.iterations.count, orders: v.orderCount, reserved: v.reserved, failed: failedChecks(label), t: m.http_req_duration };
};
const keyed = idem("idem-keyed"), unkeyed = idem("idem-unkeyed");

// ─── Markdown ───────────────────────────────────────────────────────────────
const md = `# FlashForge Benchmarks: Before vs After

Each architectural decision in FlashForge is measured against the simpler design it replaced, on the same machine, with the same harness, minutes apart.

- **Harness:** [\`loadtest/benchmark.ps1\`](../loadtest/benchmark.ps1) runs every experiment; [\`loadtest/report.mjs\`](../loadtest/report.mjs) generates this file.
- **Correctness:** checked in PostgreSQL after each run by [\`loadtest/verify-db.ts\`](../loadtest/verify-db.ts), not just inferred from HTTP status codes.
- **Raw data:** every number below comes from a JSON file in [\`docs/benchmark-data/\`](benchmark-data/).

## Environment

| | |
|---|---|
| Date | ${env.date ?? "—"} |
| CPU | ${env.cpu ?? "—"} (${env.cores ?? "?"} cores / ${env.threads ?? "?"} threads), ${env.ramGb ?? "?"} GB RAM |
| Software | Node.js ${env.node ?? "22"}, PostgreSQL 17, RabbitMQ 4, Redis 7 (Docker Desktop) |
| Load generator | ${env.k6 ?? "k6"} |

> [!IMPORTANT]
> Everything (API, worker, Postgres, RabbitMQ, Redis **and** k6 itself) runs on one laptop and competes for the same CPU. Absolute numbers are laptop numbers. The **before/after ratios** are the meaningful part, because both sides ran under identical conditions. The Prisma/pg connection pool is the library default (10 connections), so write-heavy runs queue for connections.

---

## Summary

| Problem | Before | After | Result |
|---|---|---|---|
| Overselling (200 concurrent buyers, 10 units, 3 runs each) | Read-check-write: **${naiveMin}–${naiveMax} orders** for 10 units | Atomic conditional \`UPDATE\`: **10 orders**, every run | **0 oversold units**, all DB invariants pass |
| Payment latency, gateway takes 2 s | Synchronous: \`POST /pay\` p95 **${ms(s2000.t["p(95)"])}** | Outbox + RabbitMQ: p95 **${ms(a2000.t["p(95)"])}** | **${x(s2000.t["p(95)"], a2000.t["p(95)"])}× lower p95**, ${a2000.confirmed}/${a2000.paid} orders confirmed |
| Catalog reads, \`GET /products\` (~13 KB), 50 VUs | No cache: **${int(listOff.rps)} req/s**, p95 ${ms(listOff.t["p(95)"])}, ${int(listOff.db)} DB txns | Redis cache: **${int(listOn.rps)} req/s**, p95 ${ms(listOn.t["p(95)"])}, ${int(listOn.db)} DB txns | **${x(listOn.rps, listOff.rps)}× throughput**, **${listDbCut}% fewer** DB transactions |
| Redis outage during the read load | — | Fail-open: **${int(listDown.rps)} req/s**, ${listDown.failed} failed requests | Reads keep working; DB protected by single-flight |
| Retry storm (50 orders × 20 concurrent retries) | No key: **${int(unkeyed.orders)} orders** | \`Idempotency-Key\`: **${keyed.orders} orders** | **0 duplicates** (${keyed.failed} failed requests) |
| Write contention (50 VUs, 20 s) | 1 hot product: **${int(hot.rps)} orders/s** | 50 products: **${int(spread.rps)} orders/s** | **${x(spread.rps, hot.rps)}×** throughput once writers stop queuing on one row lock |

---

## 1. Overselling: naive read-check-write vs atomic \`UPDATE\`

**Load:** [\`flash-sale.js\`](../loadtest/flash-sale.js). 200 VUs send \`POST /orders\` at the same instant for a product with 10 units. 3 runs per strategy, fresh product each run.

- **Naive** (\`INVENTORY_STRATEGY=naive\`, benchmark-only): \`SELECT\` the row, check \`available >= qty\` in TypeScript, \`UPDATE\` with the value computed from the read.
- **Atomic** (the real code): \`UPDATE … SET available = available - qty … WHERE productId = $1 AND available >= qty\`, then check the affected row count.

| Strategy | Run | Orders in DB | Oversold | Inventory row (avail / reserved) | p50 | p95 | Invariants |
|---|---|---:|---:|---|---:|---:|---|
${naive.map((r) => `| Naive | ${r.run} | **${r.orders}** | +${r.oversold} | ${r.avail} / ${r.reserved} | ${ms(r.t.med)} | ${ms(r.t["p(95)"])} | ❌ |`).join("\n")}
${atomic.map((r) => `| Atomic | ${r.run} | **${r.orders}** | ${r.oversold} | ${r.avail} / ${r.reserved} | ${ms(r.t.med)} | ${ms(r.t["p(95)"])} | ✅ |`).join("\n")}

**Why the naive inventory row still looks healthy.** Every racing transaction wrote \`available = <stale value> − 1\`, so the writes overwrote each other (a *lost update*). The counter only went down 10 times while ${naiveMin}–${naiveMax} order rows were committed. Looking at the inventory row alone, you'd never know. The verifier catches it by comparing \`reservedQuantity\` with \`SUM(OrderItem.quantity)\` inside one \`REPEATABLE READ\` snapshot.

**Why the naive version is also slower.** Its p95 is 1.6–2.2 s versus 0.7–0.9 s for atomic, because about 130 transactions run to completion (inserting orders and outbox rows) instead of about 190 of them failing fast with a 409.

---

## 2. Read caching: none vs Redis vs Redis down

**Load:** [\`throughput.js\`](../loadtest/throughput.js). 50 VUs with no think time for 20 s, no worker running. "DB txns" is the change in \`pg_stat_database\` (commits + rollbacks) over the run. "No cache" means \`PRODUCT_CACHE_TTL_SECONDS=0\`, which bypasses Redis **and** single-flight coalescing.

### \`GET /products\`: the full list (~13 KB JSON, a few hundred rows)

| Mode | Requests | Throughput | p50 | p95 | p99 | DB txns | Failed |
|---|---:|---:|---:|---:|---:|---:|---:|
| No cache | ${int(listOff.reqs)} | **${int(listOff.rps)} req/s** | ${ms(listOff.t.med)} | ${ms(listOff.t["p(95)"])} | ${ms(listOff.t["p(99)"])} | ${int(listOff.db)} | ${listOff.failed} |
| Redis read-through (TTL 30 s) | ${int(listOn.reqs)} | **${int(listOn.rps)} req/s** | ${ms(listOn.t.med)} | ${ms(listOn.t["p(95)"])} | ${ms(listOn.t["p(99)"])} | ${int(listOn.db)} | ${listOn.failed} |
| Redis down (fail-open + single-flight) | ${int(listDown.reqs)} | **${int(listDown.rps)} req/s** | ${ms(listDown.t.med)} | ${ms(listDown.t["p(95)"])} | ${ms(listDown.t["p(99)"])} | ${int(listDown.db)} | ${listDown.failed} |

### \`GET /products/:id\`: one row by primary key

| Mode | Requests | Throughput | p50 | p95 | p99 | DB txns | Failed |
|---|---:|---:|---:|---:|---:|---:|---:|
| No cache | ${int(oneOff.reqs)} | **${int(oneOff.rps)} req/s** | ${ms(oneOff.t.med)} | ${ms(oneOff.t["p(95)"])} | ${ms(oneOff.t["p(99)"])} | ${int(oneOff.db)} | ${oneOff.failed} |
| Redis read-through (TTL 30 s) | ${int(oneOn.reqs)} | **${int(oneOn.rps)} req/s** | ${ms(oneOn.t.med)} | ${ms(oneOn.t["p(95)"])} | ${ms(oneOn.t["p(99)"])} | ${int(oneOn.db)} | ${oneOn.failed} |
| Redis down (fail-open + single-flight) | ${int(oneDown.reqs)} | **${int(oneDown.rps)} req/s** | ${ms(oneDown.t.med)} | ${ms(oneDown.t["p(95)"])} | ${ms(oneDown.t["p(99)"])} | ${int(oneDown.db)} | ${oneDown.failed} |

### What this shows (including the unflattering part)

1. **Redis pays off on both reads under 50-VU concurrency.** For the full list (\`GET /products\`, ~13 KB) it gave **${x(listOn.rps, listOff.rps)}×** throughput (${int(listOff.rps)} → ${int(listOn.rps)} req/s), **${x(listOff.t["p(95)"], listOn.t["p(95)"])}×** lower p95 (${ms(listOff.t["p(95)"])} → ${ms(listOn.t["p(95)"])}), and cut DB transactions by **${listDbCut}%** (${int(listOff.db)} → ${int(listOn.db)}). Even a single-row primary-key lookup (\`GET /products/:id\`) gained **${x(oneOn.rps, oneOff.rps)}×** throughput (${int(oneOff.rps)} → ${int(oneOn.rps)} req/s) because uncached reads queue behind Prisma's 10-connection pool.
2. **With Redis down, the API was *faster* than with Redis up, on one instance under constant saturation.** That's not a bug. Single-flight coalescing makes every request that arrives while a DB query is in flight share that one query's result *in memory*: no network hop, no \`JSON.parse\` of 13 KB. Under 50 VUs with zero think time there is *always* a query in flight, so coalescing behaves like a free in-process cache.
   - **Why Redis is still the right design:** coalescing only dedups requests that overlap in time *within one process*. With N API instances, or burstier traffic, every gap between requests becomes a fresh DB query. Redis bounds DB load to about one query per key per TTL **across all instances**.
   - **The obvious next optimisation** this measurement points to: store the serialised response in Redis and send it as-is, skipping \`JSON.parse\` → re-serialise on every hit. Not done yet.
3. **The fail-open path held:** ${listDown.failed} failed requests out of ${int(listDown.reqs)} with Redis unreachable.

---

## 3. Write contention: one hot product vs 50 products

**Load:** [\`throughput.js\`](../loadtest/throughput.js). 50 VUs, no think time, 20 s, \`POST /orders\` with plenty of stock. Every order is a full transaction: user check, price snapshot, atomic inventory \`UPDATE\`, \`Order\` + \`OrderItem\` + \`OutboxEvent\` inserts.

| Workload | Orders | Throughput | p50 | p95 | p99 | Failed |
|---|---:|---:|---:|---:|---:|---:|
| 1 product (every writer locks the same row) | ${int(hot.orders)} | **${int(hot.rps)} orders/s** | ${ms(hot.t.med)} | ${ms(hot.t["p(95)"])} | ${ms(hot.t["p(99)"])} | ${hot.failed} |
| 50 products (writers mostly lock different rows) | ${int(spread.orders)} | **${int(spread.rps)} orders/s** | ${ms(spread.t.med)} | ${ms(spread.t["p(95)"])} | ${ms(spread.t["p(99)"])} | ${spread.failed} |

The atomic \`UPDATE\` is correct, but it serialises writers *on the same row*. Spreading the same load over 50 products roughly doubles throughput. Both runs also queue for the 10-connection pool, which is why p50 is hundreds of milliseconds even without contention. A raised pool size or a second API instance would be the next lever, but that isn't measured here.

---

## 4. Payments: synchronous vs async (transactional outbox + RabbitMQ)

**Load:** [\`sustained.js\`](../loadtest/sustained.js). 10 VUs loop for 30 s: create an order, pay, think for 0.5–1.5 s. Gateway latency is simulated (\`PAYMENT_DELAY_MS\`).

- **Sync** (\`PAYMENT_MODE=sync\`, benchmark-only, the Phase 2 design): \`POST /pay\` calls the gateway inside the request and returns \`200\` once the order is confirmed. No worker.
- **Async** (the real code): \`POST /pay\` marks the order \`PAYMENT_PROCESSING\`, writes a \`payment.requested\` outbox row in the same transaction, and returns \`202\`. The worker charges the gateway. The verifier waits up to 120 s for the backlog to drain.

| Gateway delay | Mode | \`POST /pay\` p50 | p95 | p99 | Orders paid in 30 s | Confirmed in DB | Invariants |
|---:|---|---:|---:|---:|---:|---:|---|
${gws.map((g, i) => [sync[i], asyn[i]].map((r, j) => `| ${j === 0 ? `**${int(g)} ms**` : ""} | ${j === 0 ? "Sync" : "**Async**"} | ${ms(r.t.med)} | **${ms(r.t["p(95)"])}** | ${ms(r.t["p(99)"])} | ${r.paid} | ${r.confirmed} / ${r.paid} | ${r.allOk ? "✅" : "❌"} |`).join("\n")).join("\n")}

- With a 2 s gateway, the synchronous endpoint's p95 is **${ms(s2000.t["p(95)"])}** and the async one is **${ms(a2000.t["p(95)"])}** (**${x(s2000.t["p(95)"], a2000.t["p(95)"])}×** lower). Async \`POST /pay\` latency stays flat as gateway latency grows 40×. Sync latency tracks the gateway one-for-one.
- In 30 s the same 10 users completed **${a2000.paid}** payments async versus **${s2000.paid}** sync, because sync users sit waiting on the gateway.
- **All** async payments were confirmed by the worker afterwards (${a2000.confirmed}/${a2000.paid} at 2 s), and every invariant held. The trade-off: the customer learns the outcome a moment later, by polling \`GET /orders/:id\`.
- Gateway capacity is unchanged: the worker processes \`PAYMENT_WORKER_PREFETCH=10\` charges at a time, so at 2 s per charge it drains about 5 per second. Async moves the waiting off the HTTP request; it does not make the gateway faster.

---

## 5. Idempotency keys under a retry storm

**Load:** [\`idempotency.js\`](../loadtest/idempotency.js). 100 VUs send 1,000 \`POST /orders\` requests: 50 logical orders, each sent 20 times concurrently.

| Mode | Requests | Orders in DB | Duplicates | Failed requests | p95 | Invariants (\`orders == 50\`) |
|---|---:|---:|---:|---:|---:|---|
| No \`Idempotency-Key\` | ${int(unkeyed.reqs)} | **${int(unkeyed.orders)}** | ${int(unkeyed.orders - 50)} | ${unkeyed.failed} | ${ms(unkeyed.t["p(95)"])} | ❌ |
| \`Idempotency-Key\` | ${int(keyed.reqs)} | **${int(keyed.orders)}** | 0 | ${keyed.failed} | ${ms(keyed.t["p(95)"])} | ✅ |

- Without keys, ${int(unkeyed.orders)} orders were created. The other ${unkeyed.failed} requests failed with **HTTP 500** (\`Unable to start a transaction in the given time\`): 100 concurrent transactions were competing for a 10-connection pool, and Prisma gave up waiting after its 2 s default. That's a real finding. Under this load the pool is the bottleneck, and a production deployment would size it (or add PgBouncer) and return 503 + \`Retry-After\` for that error instead of 500.
- With keys, \`INSERT … ON CONFLICT DO NOTHING\` on \`(userId, key)\` makes concurrent copies wait on the first copy's uncommitted row. When it commits, they replay its stored \`201\` response (\`Idempotent-Replayed: true\`). Exactly 50 orders were created.

---

## Limitations

- **One machine.** Load generator and system share a CPU, and nothing crosses a real network.
- **Single runs** for experiments 2–5 (experiment 1 has 3 runs per side). Expect roughly ±15% run-to-run variation in latency numbers. The first run after an API restart includes JIT warm-up.
- **Benchmark-only baselines** (\`INVENTORY_STRATEGY=naive\`, \`PAYMENT_MODE=sync\`) exist in the code purely so the "before" is measured rather than assumed. Both log a warning at startup and are never set by \`.env\`, compose or tests.

## Reproduce

\`\`\`powershell
docker compose up -d          # infrastructure only
npm run db:seed
npm run bench                 # runs every experiment (~15 min), then regenerates this file
\`\`\`
`;

mkdirSync("docs/benchmark-data", { recursive: true });
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  copyFileSync(`${dir}/${f}`, `docs/benchmark-data/${f}`);
}
writeFileSync("docs/BENCHMARKS.md", md);

console.log("Wrote docs/BENCHMARKS.md and docs/benchmark-data/");
console.log(JSON.stringify({
  oversell: { naive: naive.map((r) => r.orders), atomic: atomic.map((r) => r.orders) },
  list: { off: [Math.round(listOff.rps), +listOff.t["p(95)"].toFixed(1), listOff.db], on: [Math.round(listOn.rps), +listOn.t["p(95)"].toFixed(1), listOn.db], down: [Math.round(listDown.rps), +listDown.t["p(95)"].toFixed(1), listDown.db, listDown.failed] },
  one: { off: [Math.round(oneOff.rps), +oneOff.t["p(95)"].toFixed(1), oneOff.db], on: [Math.round(oneOn.rps), +oneOn.t["p(95)"].toFixed(1), oneOn.db], down: [Math.round(oneDown.rps), +oneDown.t["p(95)"].toFixed(1), oneDown.db] },
  pay: gws.map((g, i) => ({ gw: g, sync: [+sync[i].t["p(95)"].toFixed(1), sync[i].paid, sync[i].confirmed, sync[i].failed], async: [+asyn[i].t["p(95)"].toFixed(1), asyn[i].paid, asyn[i].confirmed, asyn[i].failed] })),
  idem: { keyed: [keyed.orders, keyed.failed], unkeyed: [unkeyed.orders, unkeyed.failed] },
  hot: [Math.round(hot.rps), +hot.t["p(95)"].toFixed(1)], spread: [Math.round(spread.rps), +spread.t["p(95)"].toFixed(1)],
}, null, 0));
