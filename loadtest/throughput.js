// ─── Throughput / capacity scenario (benchmarks) ────────────────────────────
//
// Closed model with NO think time: every VU fires its next request as soon as
// the previous one returns, so the request rate is whatever the system can
// sustain. This measures capacity, not "realistic traffic" (that's mixed.js).
//
//   MODE=read          GET /products (catalog list, ~13 KB JSON). Compare cache modes.
//   MODE=read-one      GET /products/:id (one product, a primary-key lookup)
//   MODE=write         POST /orders, every order for ONE product (hot row)
//   MODE=write-spread  POST /orders spread over PRODUCTS products
//
//   k6 run loadtest/throughput.js -e MODE=read -e VUS=50 -e DURATION=20s

import { check } from "k6";
import { Trend } from "k6/metrics";
import http from "k6/http";
import { createProduct, placeOrder } from "./helpers.js";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const MODE = __ENV.MODE || "read";
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || "20s";
const PRODUCTS = MODE === "write-spread" ? Number(__ENV.PRODUCTS || 50) : 1;

const latency = new Trend("op_latency_ms", true);

export const options = {
  scenarios: { capacity: { executor: "constant-vus", vus: VUS, duration: DURATION } },
  thresholds: { checks: ["rate>0.99"] },
};

export function setup() {
  const ids = [];
  for (let i = 0; i < PRODUCTS; i++) {
    // Plenty of stock: we're measuring speed, not sell-out behaviour.
    ids.push(createProduct(`Throughput ${MODE} ${Date.now()}-${i}`, 1000000).id);
  }
  // Warm the cache once so the read run measures the steady state.
  if (MODE === "read") http.get(`${BASE}/products`);
  if (MODE === "read-one") http.get(`${BASE}/products/${ids[0]}`);
  return { ids };
}

export default function (data) {
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const res =
    MODE === "read"
      ? http.get(`${BASE}/products`)
      : MODE === "read-one"
        ? http.get(`${BASE}/products/${id}`)
        : placeOrder(id);
  latency.add(res.timings.duration);
  check(res, { "2xx": (r) => r.status >= 200 && r.status < 300 });
}

