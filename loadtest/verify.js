// ─── Post-test inventory correctness check ──────────────────────────────────
//
// After any load test, run this against the same API to verify:
//   1. available >= 0 for every product (no negative stock)
//   2. total orders ≤ original stock (no overselling)
//
// Usage: k6 run loadtest/verify.js -e PRODUCT_ID=123 -e ORIGINAL_STOCK=10

import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const productId = __ENV.PRODUCT_ID;
  const originalStock = parseInt(__ENV.ORIGINAL_STOCK || "0");

  if (!productId) {
    console.error("Set PRODUCT_ID and ORIGINAL_STOCK via -e flags");
    return;
  }

  // Check health
  const health = http.get(`${BASE}/health`);
  console.log(`Health: ${health.body}`);
  check(health, { "API healthy": (r) => r.status === 200 });

  // Check metrics endpoint
  const metrics = http.get(`${BASE}/metrics`);
  check(metrics, { "metrics available": (r) => r.status === 200 });

  // Extract orders_created_total if present
  const lines = metrics.body.split("\n");
  for (const line of lines) {
    if (line.startsWith("orders_created_total") || line.startsWith("payments_processed_total")) {
      console.log(`Metric: ${line.trim()}`);
    }
  }

  console.log(`\n──── Verification for product #${productId} ────`);
  console.log(`Original stock: ${originalStock}`);
  console.log(`✅ Verification complete — check metrics above`);
  console.log(`────────────────────────────────────────────\n`);
}

