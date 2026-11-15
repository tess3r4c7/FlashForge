// ─── Retry storm: does Idempotency-Key really dedupe? (benchmarks) ──────────
//
// Simulates flaky mobile clients: KEYS logical orders, each sent COPIES times,
// all concurrently (e.g. 50 orders × 20 retries = 1,000 requests).
//
//   USE_KEY=true   every copy carries the same Idempotency-Key
//                  → expect exactly KEYS orders
//   USE_KEY=false  same traffic without the header (the "before")
//                  → every retry becomes a duplicate order
//
// verify-db.ts --expect-accepted KEYS checks the result in Postgres.

import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { createProduct } from "./helpers.js";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const KEYS = Number(__ENV.KEYS || 50);
const COPIES = Number(__ENV.COPIES || 20);
const USE_KEY = (__ENV.USE_KEY || "true") === "true";

const created = new Counter("orders_created_201");

export const options = {
  scenarios: {
    storm: { executor: "shared-iterations", vus: 100, iterations: KEYS * COPIES, maxDuration: "60s" },
  },
};

export function setup() {
  const product = createProduct(`Idempotency ${USE_KEY ? "keyed" : "unkeyed"} ${Date.now()}`, 100000);
  return { productId: product.id, run: `${Date.now()}` };
}

export default function (data) {
  const i = exec.scenario.iterationInTest;
  const headers = { "Content-Type": "application/json" };
  if (USE_KEY) headers["Idempotency-Key"] = `storm-${data.run}-${i % KEYS}`;

  const res = http.post(
    `${BASE}/orders`,
    JSON.stringify({ userId: 1, items: [{ productId: data.productId, quantity: 1 }] }),
    { headers },
  );
  if (res.status === 201) created.add(1);
  check(res, { "201 (new or replayed)": (r) => r.status === 201 });
}

