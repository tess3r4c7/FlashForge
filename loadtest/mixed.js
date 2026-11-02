// ─── Scenario 3: Mixed Workload ─────────────────────────────────────────────
//
// Realistic traffic: some users browse products (reads) while others place
// orders (writes). This tests whether the read-through Redis cache (Phase 6)
// actually helps: cached reads should be sub-millisecond and shouldn't be
// affected by write contention on the inventory rows.
//
// Split: 80% reads (GET /products), 20% writes (POST /orders).

import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { createProduct, placeOrder, getProducts, getHealth } from "./helpers.js";

const reads = new Counter("reads_total");
const writes = new Counter("writes_total");
const readLatency = new Trend("read_latency_ms");
const writeLatency = new Trend("write_latency_ms");

const STOCK = 200;
const DURATION = __ENV.DURATION || "1m";

export const options = {
  scenarios: {
    mixed: {
      executor: "constant-vus",
      vus: 20,
      duration: DURATION,
    },
  },
  thresholds: {
    // Reads (cached) should be fast
    read_latency_ms: ["p(95)<50"],
    // Writes can be slower (DB transaction + inventory lock)
    write_latency_ms: ["p(95)<500"],
    // All checks must pass (409 is correct, not an error)
    checks: ["rate>0.99"],
  },
};

export function setup() {
  const product = createProduct(`Mixed ${Date.now()}`, STOCK);
  // Warm the cache with one read
  getProducts();
  console.log(`\n🔀 Mixed workload: 20 VUs for ${DURATION}, 80% reads / 20% writes\n`);
  return { productId: product.id };
}

export default function (data) {
  if (Math.random() < 0.8) {
    // ── Read path ──
    const res = getProducts();
    readLatency.add(res.timings.duration);
    reads.add(1);
    check(res, { "products listed": (r) => r.status === 200 });
  } else {
    // ── Write path ──
    const res = placeOrder(data.productId);
    writeLatency.add(res.timings.duration);
    writes.add(1);
    check(res, {
      "order created or out of stock": (r) => r.status === 201 || r.status === 409,
    });
  }

  sleep(0.1 + Math.random() * 0.2);
}

export function teardown() {
  console.log(`\n🔀 Mixed workload complete.`);
  console.log(`Check read_latency_ms vs write_latency_ms — reads should be much faster (cached).\n`);
}

