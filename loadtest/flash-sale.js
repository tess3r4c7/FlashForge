// ─── Scenario 1: Flash Sale ─────────────────────────────────────────────────
//
// The marquee test: 200 virtual users hit POST /orders at the same time for
// a product with only 10 units in stock. The system must:
//   1. Accept exactly 10 orders (201) and reject the rest (409 out of stock)
//   2. Never sell more than 10 — the atomic UPDATE ... WHERE available >= qty
//      that we built in Phase 1 is what prevents this
//   3. Stay reasonably fast: p95 under 1s even with 200 writers on ONE row
//
// This is exactly the race condition that a naive "check stock, then deduct"
// would fail. Our system handles it because the stock check and deduction
// are ONE atomic SQL statement, and Postgres serialises the competing UPDATEs.

import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { createProduct, placeOrder, printVerifyHint } from "./helpers.js";

// ─── Custom metrics ─────────────────────────────────────────────────────────
const ordersAccepted = new Counter("orders_accepted");
const ordersRejected = new Counter("orders_rejected");
const orderLatency = new Trend("order_latency_ms");

// ─── Configuration ──────────────────────────────────────────────────────────
const STOCK = Number(__ENV.STOCK || 10);
const VIRTUAL_USERS = Number(__ENV.VUS || 200);

export const options = {
  scenarios: {
    flash_sale: {
      executor: "shared-iterations",
      // All VUs execute their iteration at once — maximum contention.
      vus: VIRTUAL_USERS,
      iterations: VIRTUAL_USERS,
      maxDuration: "30s",
    },
  },
  thresholds: {
    // p95 latency under 1s (includes DB contention from 200 concurrent writes)
    order_latency_ms: ["p(95)<1000"],
    // At least 1 order must succeed (sanity check)
    orders_accepted: ["count>0"],
    // 5xx errors should be 0. Note: k6 counts 4xx as "failed" too, but 409
    // (out of stock) is CORRECT behaviour, not an error. We check via the
    // "no server error" check instead.
    checks: ["rate>0.99"],
  },
};

// ─── Setup: runs once, before VUs start ─────────────────────────────────────
export function setup() {
  const product = createProduct(`Flash Sale ${Date.now()}`, STOCK);
  console.log(`\n🚀 Flash sale starting: ${VIRTUAL_USERS} users fighting for ${STOCK} units of product #${product.id}\n`);
  return { productId: product.id, stock: STOCK };
}

// ─── VU code: every virtual user runs this once ─────────────────────────────
export default function (data) {
  const res = placeOrder(data.productId);
  orderLatency.add(res.timings.duration);

  const ok = check(res, {
    "order created or out of stock": (r) => r.status === 201 || r.status === 409,
    "no server error": (r) => r.status < 500,
  });

  if (res.status === 201) {
    ordersAccepted.add(1);
  } else {
    ordersRejected.add(1);
  }
}

// ─── Teardown: runs once, after all VUs finish ──────────────────────────────
export function teardown(data) {
  // VUs can't write into `data`, so the accepted count lives in the
  // orders_accepted counter (see summary). The authoritative check reads
  // Postgres: run.ps1 calls verify-db.ts with --expect-accepted STOCK.
  console.log(`\nExpected: exactly ${STOCK} accepted, ${VIRTUAL_USERS - STOCK} rejected.`);
  printVerifyHint(data.productId, data.stock, STOCK);
}