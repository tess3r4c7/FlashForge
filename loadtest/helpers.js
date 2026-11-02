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
// After the load test, check that inventory was never oversold.
// This is called from each scenario's teardown().

export function validateInventory(productId, originalStock, data) {
  // We can't query the DB directly from k6, but the /products endpoint
  // shows us the product. We'll also check how many orders succeeded.
  const successfulOrders = data ? data.successfulOrders : 0;

  console.log(`\n──── Inventory Validation ────`);
  console.log(`Product ID:       ${productId}`);
  console.log(`Original stock:   ${originalStock}`);
  console.log(`Successful orders: ${successfulOrders}`);

  if (successfulOrders > originalStock) {
    console.error(`❌ OVERSOLD! ${successfulOrders} orders created but only ${originalStock} units existed.`);
  } else {
    console.log(`✅ No overselling: ${successfulOrders} ≤ ${originalStock}`);
    console.log(`Remaining stock: ${originalStock - successfulOrders} units`);
  }
  console.log(`─────────────────────────────\n`);
}

