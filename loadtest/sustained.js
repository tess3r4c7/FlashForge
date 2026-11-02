// ─── Scenario 2: Sustained Load ─────────────────────────────────────────────
//
// A steady stream of orders over 2 minutes, watching for:
//   - Memory leaks (heap grows without bound)
//   - Connection pool exhaustion (latency spikes as requests queue)
//   - Error rate creep (errors that only show up after many requests)
//
// Unlike the flash sale (instant burst), this simulates normal daily traffic:
// a handful of concurrent users placing orders continuously.

import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { createProduct, placeOrder, payOrder, getOrder, getProducts } from "./helpers.js";

const ordersCreated = new Counter("orders_created");
const ordersPaid = new Counter("orders_paid");
const orderLatency = new Trend("order_create_latency_ms");
const payLatency = new Trend("order_pay_latency_ms");

const STOCK = 500;
const DURATION = __ENV.DURATION || "2m";

export const options = {
  scenarios: {
    sustained: {
      executor: "constant-vus",
      vus: 10,
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<1000"],
    http_req_failed: ["rate<0.05"],
  },
};

export function setup() {
  const product = createProduct(`Sustained ${Date.now()}`, STOCK);
  console.log(`\n📊 Sustained load: 10 VUs for ${DURATION}, product #${product.id} (${STOCK} units)\n`);
  return { productId: product.id, stock: STOCK };
}

export default function (data) {
  // 1. Create an order
  const createRes = placeOrder(data.productId);
  orderLatency.add(createRes.timings.duration);

  if (createRes.status === 201) {
    ordersCreated.add(1);
    const order = JSON.parse(createRes.body);

    // 2. Pay for it
    const payRes = payOrder(order.id);
    payLatency.add(payRes.timings.duration);

    check(payRes, {
      "pay accepted": (r) => r.status === 202,
    });

    if (payRes.status === 202) {
      ordersPaid.add(1);
    }
  } else {
    check(createRes, {
      "expected 409 out of stock": (r) => r.status === 409,
    });
  }

  // Brief pause between orders (simulates real user think time)
  sleep(0.5 + Math.random());
}

export function teardown(data) {
  console.log(`\n📊 Sustained load complete.`);
  console.log(`Product #${data.productId}, ${data.stock} original stock.`);
  console.log(`Check k6 summary for orders_created, orders_paid, and latency percentiles.\n`);
}

