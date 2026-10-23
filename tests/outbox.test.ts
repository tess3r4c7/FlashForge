import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  createTestProduct,
  cleanupTestProducts,
  waitForOrderStatus,
  waitUntil,
} from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import type { ConsumerHandle } from "../src/messaging/consumer.js";
import type { DomainEvent } from "../src/messaging/events.js";
import { createEvent } from "../src/messaging/events.js";
import { enqueueEvent } from "../src/messaging/outbox.js";
import {
  relayBatch,
  startOutboxRelay,
  countPendingOutboxEvents,
  type Publish,
} from "../src/messaging/outbox-relay.js";
import { publishEvent, closePublisher } from "../src/messaging/publisher.js";
import { startPaymentWorker } from "../src/workers/payment.worker.js";
import { startNotificationWorker } from "../src/workers/notification.worker.js";

// These tests control the relay THEMSELVES (start/stop it, inject failing
// publishers), so they don't use startTestWorkers(), which always runs one.
// This is safe because tests run against the isolated flashforge_test DB.

let app: FastifyInstance;
let consumers: ConsumerHandle[] = [];
const testProductIds: number[] = [];
const USER_ID = 1;

beforeAll(async () => {
  app = buildTestApp();
  await app.ready();
  // Payment + notification consumers run; the relay does NOT (yet).
  consumers = await Promise.all([startPaymentWorker(), startNotificationWorker()]);
});

afterAll(async () => {
  await Promise.all(consumers.map((c) => c.stop()));
  await closePublisher();
  await cleanupTestProducts(testProductIds);
  await app.close();
});

beforeEach(async () => {
  process.env.PAYMENT_DELAY_MS = "0";
  process.env.PAYMENT_SUCCESS_RATE = "1";
  // Each test starts with an empty outbox, so counts are exact.
  await prisma.outboxEvent.deleteMany();
});

// ─── Helpers ────────────────────────────────────────────────
async function newProduct(stock: number) {
  const id = await createTestProduct(stock);
  testProductIds.push(id);
  return id;
}

async function placeOrder(productId: number, quantity = 1) {
  return app.inject({
    method: "POST",
    url: "/orders",
    payload: { userId: USER_ID, items: [{ productId, quantity }] },
  });
}

async function pay(orderId: number) {
  return app.inject({
    method: "POST",
    url: `/orders/${orderId}/pay`,
    payload: { userId: USER_ID },
  });
}

/** Outbox rows whose payload refers to the given order. */
function outboxRowsFor(orderId: number) {
  return prisma.outboxEvent.findMany({
    where: { payload: { path: ["orderId"], equals: orderId } },
    orderBy: { createdAt: "asc" },
  });
}

/** Inserts `n` test events straight into the outbox. */
async function insertTestEvents(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    // Distinct, increasing timestamps → a well-defined order.
    const event = createEvent("order.cancelled", { orderId: -1_000_000 - i, reason: `test ${i}` });
    event.occurredAt = new Date(Date.UTC(2020, 0, 1, 0, 0, 0, i)).toISOString();
    await prisma.$transaction((tx) => enqueueEvent(tx, event));
    ids.push(event.eventId);
  }
  return ids;
}

// ─── Write side: the event is part of the transaction ───────

describe("outbox write side", () => {
  it("a successful order writes an order.created outbox row in the same transaction", async () => {
    const productId = await newProduct(5);

    const res = await placeOrder(productId, 2);
    expect(res.statusCode).toBe(201);
    const order = JSON.parse(res.body) as { id: number };

    const rows = await outboxRowsFor(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("order.created");
    expect(rows[0]!.publishedAt).toBeNull(); // relay isn't running
    expect(rows[0]!.attempts).toBe(0);
  });

  it("a failed order (out of stock) leaves NO outbox row: rollback removes the event too", async () => {
    const productId = await newProduct(1);

    const res = await placeOrder(productId, 5); // only 1 in stock
    expect(res.statusCode).toBe(409);

    // The whole transaction rolled back, including the outbox INSERT.
    // With Phase 3's "publish after commit" this was also true, but the
    // reverse case (commit succeeded, publish failed) is what the outbox fixes:
    expect(await prisma.outboxEvent.count()).toBe(0);
  });
});

// ─── The headline test: RabbitMQ "down" no longer loses events ─

describe("outbox relay", () => {
  it("while the relay is down, events wait in the table; once it runs, the order completes", async () => {
    const productId = await newProduct(5);
    const order = JSON.parse((await placeOrder(productId)).body) as { id: number };

    // Pay while nothing is publishing (= RabbitMQ unreachable, relay stopped).
    // The API still answers 202: it only wrote to Postgres.
    const res = await pay(order.id);
    expect(res.statusCode).toBe(202);

    // Give it a moment: nothing happens, the order just waits.
    await new Promise((r) => setTimeout(r, 300));
    const stuck = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stuck.status).toBe("PAYMENT_PROCESSING");

    const pending = await outboxRowsFor(order.id);
    expect(pending.map((r) => r.type)).toEqual(["order.created", "payment.requested"]);
    expect(pending.every((r) => r.publishedAt === null)).toBe(true);

    // "RabbitMQ is back": start the relay.
    const relay = startOutboxRelay({ pollIntervalMs: 50 });
    try {
      const final = await waitForOrderStatus(order.id, ["CONFIRMED", "CANCELLED"]);
      expect(final.status).toBe("CONFIRMED");

      // The worker's own event (order.confirmed) also went through the outbox.
      await waitUntil(
        async () => (await countPendingOutboxEvents()) === 0,
        "outbox to drain",
      );
      const rows = await outboxRowsFor(order.id);
      expect(rows.map((r) => r.type)).toEqual([
        "order.created",
        "payment.requested",
        "order.confirmed",
      ]);
      expect(rows.every((r) => r.publishedAt !== null)).toBe(true);
    } finally {
      await relay.stop();
    }
  });

  it("a failing publish records attempts + lastError and keeps the row until it succeeds", async () => {
    const [eventId] = await insertTestEvents(1);

    // A fake publisher that fails twice, then works.
    let calls = 0;
    const published: DomainEvent[] = [];
    const flakyPublish: Publish = async (event) => {
      calls++;
      if (calls <= 2) throw new Error(`broker unreachable (call ${calls})`);
      published.push(event);
    };

    const first = await relayBatch(flakyPublish);
    expect(first).toEqual({ published: 0, error: "broker unreachable (call 1)" });

    let row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId! } });
    expect(row.publishedAt).toBeNull();
    expect(row.attempts).toBe(1); // NOT rolled back with the failure
    expect(row.lastError).toBe("broker unreachable (call 1)");

    await relayBatch(flakyPublish); // fails again
    const third = await relayBatch(flakyPublish); // succeeds
    expect(third).toEqual({ published: 1 });

    row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId! } });
    expect(row.publishedAt).not.toBeNull();
    expect(row.attempts).toBe(2);
    expect(published.map((e) => e.eventId)).toEqual([eventId]);

    // Nothing left to do
    expect(await relayBatch(flakyPublish)).toEqual({ published: 0 });
  });

  it("stops at the first failure to preserve order (later events are not published early)", async () => {
    const ids = await insertTestEvents(5);

    // Fail on the 3rd event, once.
    const seen: string[] = [];
    let failedOnce = false;
    const publish: Publish = async (event) => {
      if (event.eventId === ids[2] && !failedOnce) {
        failedOnce = true;
        throw new Error("boom");
      }
      seen.push(event.eventId);
    };

    const first = await relayBatch(publish);
    expect(first).toEqual({ published: 2, error: "boom" });
    expect(seen).toEqual(ids.slice(0, 2)); // events 4 and 5 were NOT sent

    const second = await relayBatch(publish);
    expect(second).toEqual({ published: 3 });
    expect(seen).toEqual(ids); // exact original order overall
  });

  it("two relays running at once publish every event exactly once (FOR UPDATE SKIP LOCKED)", async () => {
    const ids = await insertTestEvents(60);

    const published: string[] = [];
    // A slow publish keeps each relay's transaction (and its row locks)
    // open long enough that the two batches really overlap.
    const slowPublish: Publish = async (event) => {
      await new Promise((r) => setTimeout(r, 5));
      published.push(event.eventId);
    };

    // Small batches so both relays get several turns.
    const relayA = startOutboxRelay({ publish: slowPublish, batchSize: 10, pollIntervalMs: 20 });
    const relayB = startOutboxRelay({ publish: slowPublish, batchSize: 10, pollIntervalMs: 20 });
    try {
      await waitUntil(
        async () => (await countPendingOutboxEvents()) === 0,
        "both relays to drain the outbox",
      );
    } finally {
      await Promise.all([relayA.stop(), relayB.stop()]);
    }

    expect(published).toHaveLength(60); // no duplicates...
    expect(new Set(published)).toEqual(new Set(ids)); // ...and none missing
  });
});

// Sanity check: the real publisher reaches the real (test) exchange.
describe("real publisher", () => {
  it("relayBatch with the real publisher marks rows published", async () => {
    await insertTestEvents(3);
    const result = await relayBatch(publishEvent);
    expect(result).toEqual({ published: 3 });
    expect(await countPendingOutboxEvents()).toBe(0);
  });
});
