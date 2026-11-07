// ─── k6 load test: setup + teardown + validation ────────────────────────────
//
// Every k6 scenario in this folder imports these helpers:
//   setup()    → creates a product with known stock, returns its id
//   teardown() → checks that no overselling occurred (available ≥ 0)
//
// k6 uses its own JavaScript runtime (goja), NOT Node.js. It doesn't have
// `import ... from "node:..."`, `fetch()`, or `prisma`. We talk to our system
// over plain HTTP, the same way a real client would.

import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const USER_ID = 1;

// ─── Setup: runs ONCE before any virtual users ──────────────────────────────

export function createProduct(name, stock, pricePaise = 10000) {
  const res = http.post(
    `${BASE}/products`,
    JSON.stringify({ name, pricePaise, quantity: stock }),
    { headers: { "Content-Type": "application/json" } },
  );
  check(res, { "product created": (r) => r.status === 201 });
  return JSON.parse(res.body);
}

// ─── Place an order ─────────────────────────────────────────────────────────

export function placeOrder(productId, quantity = 1) {
  return http.post(
    `${BASE}/orders`,
    JSON.stringify({
      userId: USER_ID,
      items: [{ productId, quantity }],
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

export function payOrder(orderId) {
  return http.post(
    `${BASE}/orders/${orderId}/pay`,
    JSON.stringify({ userId: USER_ID }),
    { headers: { "Content-Type": "application/json" } },
  );
}

export function getOrder(orderId) {
  return http.get(`${BASE}/orders/${orderId}`);
}

export function getProducts() {
  return http.get(`${BASE}/products`);
}

export function getHealth() {
  return http.get(`${BASE}/health`);
}

export function getMetrics() {
  return http.get(`${BASE}/metrics`);
}

// ─── Validation ─────────────────────────────────────────────────────────────
// k6 cannot prove "no overselling" on its own: stock levels are deliberately
// not exposed over HTTP, and VUs can't share counters back into teardown().
// The k6 counters (orders_accepted / orders_rejected) are one witness; the
// authoritative check is loadtest/verify-db.ts, which reads Postgres directly
// and cross-checks the Inventory counters against the Order rows.
// run.ps1 runs it automatically after every scenario.

export function printVerifyHint(productId, stock, expectAccepted) {
  const expect = expectAccepted === undefined ? "" : ` --expect-accepted ${expectAccepted}`;
  console.log(`\nVerify in Postgres:  npx tsx loadtest/verify-db.ts --product ${productId} --stock ${stock}${expect}\n`);
}
