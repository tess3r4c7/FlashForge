import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  createTestProduct,
  getInventory,
  cleanupTestProducts,
  startTestWorkers,
  waitForOrderStatus,
  waitUntil,
  captureEvents,
} from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import type { ConsumerHandle } from "../src/messaging/consumer.js";
import { processPayment } from "../src/services/payment.service.js";

// ─── Test state ─────────────────────────────────────────────
let app: FastifyInstance;
let workers: ConsumerHandle[] = [];
const testProductIds: number[] = [];
const USER_ID = 1;

beforeAll(async () => {
  app = buildTestApp();
  await app.ready();
  // The real payment + notification workers, running in this process
  workers = await startTestWorkers();
});

afterAll(async () => {
  // Stop workers first so nothing is mid-payment while we delete test data
  await Promise.all(workers.map((w) => w.stop()));
  await cleanupTestProducts(testProductIds);
  await app.close();
});

// The gateway reads these on every call (the in-process worker shares
// process.env with the test). Default: instant and always successful.
beforeEach(() => {
  process.env.PAYMENT_DELAY_MS = "0";
  process.env.PAYMENT_SUCCESS_RATE = "1";
});

// ─── Helpers ────────────────────────────────────────────────
async function newProduct(stock: number, pricePaise = 10000) {
  const id = await createTestProduct(stock, pricePaise);
  testProductIds.push(id);
  return id;
}

async function placeOrder(productId: number, quantity = 1) {
  const res = await app.inject({
    method: "POST",
    url: "/orders",
    payload: { userId: USER_ID, items: [{ productId, quantity }] },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { id: number; totalAmountPaise: number };
}

async function pay(orderId: number, userId = USER_ID) {
  const res = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/pay`,
    payload: { userId },
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

async function cancel(orderId: number, userId = USER_ID) {
  const res = await app.inject({
    method: "POST",
    url: `/orders/${orderId}/cancel`,
    payload: { userId },
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

const waitForFinal = (orderId: number) =>
  waitForOrderStatus(orderId, ["CONFIRMED", "CANCELLED"]);

// ─── The async flow ─────────────────────────────────────────

describe("async payment flow", () => {
  it("POST /pay returns 202 immediately, then the worker confirms the order", async () => {
    const productId = await newProduct(10, 25000);
    const order = await placeOrder(productId, 2);

    const result = await pay(order.id);

    // The API only ACCEPTED the payment
    expect(result.statusCode).toBe(202);
    expect(result.body.status).toBe("PAYMENT_PROCESSING");
    expect(result.body.payment.status).toBe("PENDING");
    expect(result.body.payment.amountPaise).toBe(50000);

    // ...the worker finishes it in the background
    const final = await waitForFinal(order.id);
    expect(final.status).toBe("CONFIRMED");
    expect(final.payment!.status).toBe("SUCCESS");
    expect(final.payment!.transactionId).toMatch(/^txn_/);

    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(8);
    expect(inv!.reservedQuantity).toBe(0);
  });

  it("the API does not wait for a slow payment gateway", async () => {
    // Gateway takes 1.5 seconds. In Phase 2 the HTTP request took >1.5s.
    process.env.PAYMENT_DELAY_MS = "1500";

    const productId = await newProduct(5);
    const order = await placeOrder(productId);

    const started = Date.now();
    const result = await pay(order.id);
    const responseTimeMs = Date.now() - started;

    expect(result.statusCode).toBe(202);
    expect(responseTimeMs).toBeLessThan(750);

    // Payment still completes — just not on the request's time
    const final = await waitForFinal(order.id);
    expect(final.status).toBe("CONFIRMED");
  });

  it("declined payment → worker cancels the order and releases stock", async () => {
    process.env.PAYMENT_SUCCESS_RATE = "0";

    const productId = await newProduct(10);
    const order = await placeOrder(productId, 3);

    expect((await pay(order.id)).statusCode).toBe(202);

    const final = await waitForFinal(order.id);
    expect(final.status).toBe("CANCELLED");
    expect(final.payment!.status).toBe("FAILED");

    // Compensation: all 3 units back on sale
    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(10);
    expect(inv!.reservedQuantity).toBe(0);
  });

  it("released stock can be bought by someone else", async () => {
    const productId = await newProduct(1);

    process.env.PAYMENT_SUCCESS_RATE = "0";
    const first = await placeOrder(productId);
    await pay(first.id);
    expect((await waitForFinal(first.id)).status).toBe("CANCELLED");

    process.env.PAYMENT_SUCCESS_RATE = "1";
    const second = await placeOrder(productId);
    await pay(second.id);
    expect((await waitForFinal(second.id)).status).toBe("CONFIRMED");

    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(0);
    expect(inv!.reservedQuantity).toBe(0);
  });
});

// ─── State machine rules ────────────────────────────────────

describe("POST /orders/:id/pay — invalid transitions", () => {
  it("cannot pay twice — neither while processing nor after confirmation", async () => {
    process.env.PAYMENT_DELAY_MS = "300";
    const productId = await newProduct(5);
    const order = await placeOrder(productId);

    expect((await pay(order.id)).statusCode).toBe(202);

    // While the worker is still at the gateway
    const whileProcessing = await pay(order.id);
    expect(whileProcessing.statusCode).toBe(409);
    expect(whileProcessing.body.error).toContain("PAYMENT_PROCESSING");

    await waitForFinal(order.id);

    const afterConfirmed = await pay(order.id);
    expect(afterConfirmed.statusCode).toBe(409);
    expect(afterConfirmed.body.error).toContain("CONFIRMED");
  });

  it("cannot pay a cancelled order", async () => {
    const productId = await newProduct(5);
    const order = await placeOrder(productId);
    expect((await cancel(order.id)).statusCode).toBe(200);

    const result = await pay(order.id);
    expect(result.statusCode).toBe(409);
    expect(result.body.error).toContain("CANCELLED");
  });

  it("cannot pay someone else's order → 403", async () => {
    const productId = await newProduct(5);
    const order = await placeOrder(productId);

    expect((await pay(order.id, 99999)).statusCode).toBe(403);
  });

  it("paying a non-existent order → 404", async () => {
    expect((await pay(99999999)).statusCode).toBe(404);
  });
});

// ─── Cancellation ───────────────────────────────────────────

describe("POST /orders/:id/cancel", () => {
  it("cancelling releases stock; cancelling again → 409", async () => {
    const productId = await newProduct(5);
    const order = await placeOrder(productId, 2);

    const result = await cancel(order.id);
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe("CANCELLED");

    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(5);
    expect(inv!.reservedQuantity).toBe(0);

    expect((await cancel(order.id)).statusCode).toBe(409);
  });

  it("cannot cancel while payment is in progress", async () => {
    process.env.PAYMENT_DELAY_MS = "300";
    const productId = await newProduct(5);
    const order = await placeOrder(productId);

    expect((await pay(order.id)).statusCode).toBe(202);

    const result = await cancel(order.id);
    expect(result.statusCode).toBe(409);
    expect(result.body.error).toContain("PAYMENT_PROCESSING");

    expect((await waitForFinal(order.id)).status).toBe("CONFIRMED");
  });

  it("cannot cancel a confirmed order", async () => {
    const productId = await newProduct(5);
    const order = await placeOrder(productId);
    await pay(order.id);
    await waitForFinal(order.id);

    expect((await cancel(order.id)).statusCode).toBe(409);
  });
});

// ─── Concurrency ────────────────────────────────────────────

describe("payment concurrency", () => {
  it("10 concurrent pay requests for one order → exactly 1 accepted, 1 charge", async () => {
    process.env.PAYMENT_DELAY_MS = "100";
    const productId = await newProduct(5);
    const order = await placeOrder(productId);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => pay(order.id)),
    );

    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(9);

    await waitForFinal(order.id);

    const payments = await prisma.payment.count({ where: { orderId: order.id } });
    expect(payments).toBe(1);

    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(4);
    expect(inv!.reservedQuantity).toBe(0);
  });

  it("pay and cancel racing → exactly one wins, inventory stays consistent", async () => {
    process.env.PAYMENT_DELAY_MS = "50";
    const productId = await newProduct(5);
    const order = await placeOrder(productId);

    const [payResult, cancelResult] = await Promise.all([
      pay(order.id),
      cancel(order.id),
    ]);

    const winners = [payResult, cancelResult].filter(
      (r) => r.statusCode === 200 || r.statusCode === 202,
    );
    expect(winners).toHaveLength(1);

    const final = await waitForFinal(order.id);
    const inv = await getInventory(productId);
    expect(inv!.reservedQuantity).toBe(0);

    if (payResult.statusCode === 202) {
      expect(final.status).toBe("CONFIRMED");
      expect(inv!.availableQuantity).toBe(4);
    } else {
      expect(final.status).toBe("CANCELLED");
      expect(inv!.availableQuantity).toBe(5);
    }
  });

  it("20 orders paid at once are all processed by the worker in parallel", async () => {
    // prefetch = 10 → the worker handles up to 10 payments simultaneously.
    // 20 payments × 200ms each would take 4s one-by-one; in parallel ~0.4s.
    process.env.PAYMENT_DELAY_MS = "200";
    const productId = await newProduct(20);

    const orders = [];
    for (let i = 0; i < 20; i++) orders.push(await placeOrder(productId));

    const started = Date.now();
    const results = await Promise.all(orders.map((o) => pay(o.id)));
    expect(results.every((r) => r.statusCode === 202)).toBe(true);

    const finals = await Promise.all(orders.map((o) => waitForFinal(o.id)));
    const elapsedMs = Date.now() - started;

    expect(finals.every((o) => o.status === "CONFIRMED")).toBe(true);
    expect(elapsedMs).toBeLessThan(3000); // clearly not sequential (4s+)

    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(0);
    expect(inv!.reservedQuantity).toBe(0);
  });
});

// ─── At-least-once delivery ─────────────────────────────────

describe("duplicate message delivery", () => {
  it("processing the same payment twice does nothing the second time", async () => {
    // Simulates RabbitMQ redelivering a message that was already handled
    // (e.g. the worker crashed after updating the DB but before acking).
    const productId = await newProduct(5);
    const order = await placeOrder(productId);
    await pay(order.id);
    const first = await waitForFinal(order.id);

    const outcome = await processPayment(order.id);
    expect(outcome).toBe("SKIPPED");

    // Nothing changed: same payment, inventory confirmed exactly once
    const after = await prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(after.transactionId).toBe(first.payment!.transactionId);

    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(4);
    expect(inv!.reservedQuantity).toBe(0);
  });
});

// ─── Events ─────────────────────────────────────────────────

describe("published events", () => {
  it("successful flow publishes order.created → payment.requested → order.confirmed", async () => {
    const capture = await captureEvents();
    try {
      const productId = await newProduct(5);
      const order = await placeOrder(productId);
      await pay(order.id);
      await waitForFinal(order.id);

      const events = await waitUntil(
        async () => {
          const evts = capture.forOrder(order.id);
          return evts.length >= 3 ? evts : null;
        },
        "3 events for the order",
      );

      expect(events.map((e) => e.type)).toEqual([
        "order.created",
        "payment.requested",
        "order.confirmed",
      ]);
      // Every event has a unique id (consumers will use it for dedup in Phase 5)
      expect(new Set(events.map((e) => e.eventId)).size).toBe(3);
    } finally {
      await capture.close();
    }
  });

  it("declined payment publishes order.cancelled with the reason", async () => {
    process.env.PAYMENT_SUCCESS_RATE = "0";
    const capture = await captureEvents();
    try {
      const productId = await newProduct(5);
      const order = await placeOrder(productId);
      await pay(order.id);
      await waitForFinal(order.id);

      const cancelled = await waitUntil(
        async () => capture.forOrder(order.id).find((e) => e.type === "order.cancelled"),
        "order.cancelled event",
      );
      expect(cancelled.type === "order.cancelled" && cancelled.payload.reason).toContain(
        "declined",
      );
    } finally {
      await capture.close();
    }
  });
});

// ─── Reading orders ─────────────────────────────────────────

describe("GET /orders/:id", () => {
  it("returns the order with items and payment", async () => {
    const productId = await newProduct(5);
    const order = await placeOrder(productId);
    await pay(order.id);
    await waitForFinal(order.id);

    const res = await app.inject({ method: "GET", url: `/orders/${order.id}` });
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("CONFIRMED");
    expect(body.items).toHaveLength(1);
    expect(body.payment.status).toBe("SUCCESS");
  });

  it("returns 404 for unknown order", async () => {
    const res = await app.inject({ method: "GET", url: "/orders/99999999" });
    expect(res.statusCode).toBe(404);
  });
});
