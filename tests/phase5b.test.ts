import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildTestApp,
  createTestProduct,
  cleanupTestProducts,
  getInventory,
} from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { expireReservations } from "../src/jobs/reservation-expiry.js";
import {
  recoverStuckPayments,
  MAX_RECOVERY_ATTEMPTS,
} from "../src/jobs/stuck-payments.js";
import { cleanupOldRecords } from "../src/jobs/cleanup.js";

// ─── Phase 5B ────────────────────────────────────────────────
//
// Tests for:
//   1. API idempotency keys   (same key → replay, different body → 422)
//   2. Reservation expiry job (INVENTORY_RESERVED too long → CANCELLED)
//   3. Stuck payment recovery (PAYMENT_PROCESSING too long → re-drive)
//   4. Record cleanup         (old outbox/processed/idempotency rows deleted)

const USER_ID = 1;

let app: FastifyInstance;
const testProductIds: number[] = [];

beforeAll(async () => {
  app = buildTestApp();
  await app.ready();
});

afterAll(async () => {
  await cleanupTestProducts(testProductIds);
  await app.close();
});

// ─── Helpers ────────────────────────────────────────────────

async function placeOrder(
  items: { productId: number; quantity: number }[],
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  const response = await app.inject({
    method: "POST",
    url: "/orders",
    payload: { userId: USER_ID, items },
    headers,
  });

  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: JSON.parse(response.body),
  };
}

// ═══════════════════════════════════════════════════════════════
//  1.  API IDEMPOTENCY KEYS
// ═══════════════════════════════════════════════════════════════

describe("POST /orders — Idempotency-Key header", () => {
  it("same key + same body → replays original 201 with Idempotent-Replayed header", async () => {
    const productId = await createTestProduct(10);
    testProductIds.push(productId);

    const key = `idem-replay-${Date.now()}`;
    const items = [{ productId, quantity: 1 }];

    // First request creates the order
    const first = await placeOrder(items, key);
    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    // Second request with same key + body → replayed
    const second = await placeOrder(items, key);
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");

    // The response body should be the same order (same id)
    expect(second.body.id).toBe(first.body.id);

    // Only ONE order was created (inventory deducted once)
    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(9);
    expect(inv!.reservedQuantity).toBe(1);
  });

  it("same key + different body → 422 Unprocessable Entity", async () => {
    const productA = await createTestProduct(10);
    const productB = await createTestProduct(10);
    testProductIds.push(productA, productB);

    const key = `idem-mismatch-${Date.now()}`;

    // First request
    const first = await placeOrder([{ productId: productA, quantity: 1 }], key);
    expect(first.statusCode).toBe(201);

    // Second request with SAME key but DIFFERENT body
    const second = await placeOrder([{ productId: productB, quantity: 1 }], key);
    expect(second.statusCode).toBe(422);
    expect(second.body.error).toContain("different request body");
  });

  it("no Idempotency-Key header → creates a new order every time (old behaviour)", async () => {
    const productId = await createTestProduct(10);
    testProductIds.push(productId);

    const first = await placeOrder([{ productId, quantity: 1 }]);
    const second = await placeOrder([{ productId, quantity: 1 }]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);

    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(8); // two orders
    expect(inv!.reservedQuantity).toBe(2);
  });

  it("concurrent requests with same key → exactly one order", async () => {
    const productId = await createTestProduct(10);
    testProductIds.push(productId);

    const key = `idem-concurrent-${Date.now()}`;
    const items = [{ productId, quantity: 1 }];

    // Fire 5 identical requests concurrently
    const results = await Promise.all(
      Array.from({ length: 5 }, () => placeOrder(items, key)),
    );

    // All should succeed with 201
    const created = results.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(5);

    // All should reference the same order
    const orderIds = new Set(created.map((r) => r.body.id));
    expect(orderIds.size).toBe(1);

    // At most one is non-replayed; the rest are replays
    const replayed = results.filter((r) => r.headers["idempotent-replayed"] === "true");
    expect(replayed.length).toBeGreaterThanOrEqual(4);

    // Inventory: only 1 unit reserved
    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(9);
    expect(inv!.reservedQuantity).toBe(1);
  });

  it("different users can use the same key string without conflict", async () => {
    // We need a second user for this test
    await prisma.user.upsert({
      where: { id: 2 },
      update: {},
      create: { id: 2, email: "user2@flashforge.dev" },
    });

    const productId = await createTestProduct(10);
    testProductIds.push(productId);

    const key = `idem-multi-user-${Date.now()}`;
    const items = [{ productId, quantity: 1 }];

    // User 1
    const first = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { userId: 1, items },
      headers: { "idempotency-key": key },
    });
    expect(first.statusCode).toBe(201);

    // User 2, same key string
    const second = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { userId: 2, items },
      headers: { "idempotency-key": key },
    });
    expect(second.statusCode).toBe(201);

    // Different orders
    const firstBody = JSON.parse(first.body);
    const secondBody = JSON.parse(second.body);
    expect(firstBody.id).not.toBe(secondBody.id);

    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(8);
  });
});

// ═══════════════════════════════════════════════════════════════
//  2.  RESERVATION EXPIRY JOB
// ═══════════════════════════════════════════════════════════════

describe("reservation expiry job", () => {
  it("cancels orders stuck in INVENTORY_RESERVED past the TTL", async () => {
    const productId = await createTestProduct(5);
    testProductIds.push(productId);

    // Create an order (status = INVENTORY_RESERVED)
    const res = await placeOrder([{ productId, quantity: 2 }]);
    expect(res.statusCode).toBe(201);
    const orderId = res.body.id;

    // Backdate the order's updatedAt so it looks old
    await prisma.order.update({
      where: { id: orderId },
      data: { updatedAt: new Date(Date.now() - 20 * 60_000) }, // 20 min ago
    });

    // Run the job with a 15 min TTL (the order is 20 min old → expired)
    const expired = await expireReservations({ ttlMs: 15 * 60_000 });
    expect(expired).toBe(1);

    // Order should be CANCELLED
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("CANCELLED");

    // Inventory should be released
    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(5); // back to original
    expect(inv!.reservedQuantity).toBe(0);

    // An outbox event should be enqueued
    const outboxEvents = await prisma.outboxEvent.findMany({
      where: { type: "order.cancelled" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(outboxEvents.length).toBe(1);
    const payload = outboxEvents[0]!.payload as { orderId: number; reason: string };
    expect(payload.orderId).toBe(orderId);
    expect(payload.reason).toContain("expired");
  });

  it("does NOT cancel recent orders (within TTL)", async () => {
    const productId = await createTestProduct(5);
    testProductIds.push(productId);

    const res = await placeOrder([{ productId, quantity: 1 }]);
    expect(res.statusCode).toBe(201);
    const orderId = res.body.id;

    // The order was just created (within TTL) → should not expire
    const expired = await expireReservations({ ttlMs: 15 * 60_000 });
    expect(expired).toBe(0);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("INVENTORY_RESERVED");
  });

  it("expires multiple orders in one batch", async () => {
    const productId = await createTestProduct(10);
    testProductIds.push(productId);

    // Create 3 orders
    const orderIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await placeOrder([{ productId, quantity: 1 }]);
      expect(res.statusCode).toBe(201);
      orderIds.push(res.body.id);
    }

    // Backdate all of them
    await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: { updatedAt: new Date(Date.now() - 20 * 60_000) },
    });

    const expired = await expireReservations({ ttlMs: 15 * 60_000 });
    expect(expired).toBe(3);

    // All should be CANCELLED
    for (const id of orderIds) {
      const order = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect(order.status).toBe("CANCELLED");
    }

    // All 3 units returned to stock
    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(10);
    expect(inv!.reservedQuantity).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  3.  STUCK PAYMENT RECOVERY JOB
// ═══════════════════════════════════════════════════════════════

describe("stuck payment recovery job", () => {
  it("re-sends payment.requested for stuck PAYMENT_PROCESSING orders", async () => {
    const productId = await createTestProduct(5);
    testProductIds.push(productId);

    // Create an order and move it to PAYMENT_PROCESSING with a PENDING payment
    const res = await placeOrder([{ productId, quantity: 1 }]);
    const orderId = res.body.id;

    // Transition to PAYMENT_PROCESSING and create a payment record
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "PAYMENT_PROCESSING" },
      });
      await tx.payment.create({
        data: {
          orderId,
          status: "PENDING",
          amountPaise: res.body.totalAmountPaise,
        },
      });
    });

    // Backdate to look stuck (older than threshold)
    await prisma.order.update({
      where: { id: orderId },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) }, // 10 min ago
    });

    // Count outbox events before
    const outboxBefore = await prisma.outboxEvent.count({ where: { type: "payment.requested" } });

    const recovered = await recoverStuckPayments({ stuckAfterMs: 5 * 60_000 });
    expect(recovered).toBe(1);

    // A new payment.requested outbox event should exist
    const outboxAfter = await prisma.outboxEvent.count({ where: { type: "payment.requested" } });
    expect(outboxAfter).toBe(outboxBefore + 1);

    // recoveryAttempts should be bumped
    const payment = await prisma.payment.findFirst({ where: { orderId } });
    expect(payment!.recoveryAttempts).toBe(1);

    // Order's updatedAt should be refreshed (so we don't re-recover immediately)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.updatedAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("does NOT recover orders within the stuck threshold", async () => {
    const productId = await createTestProduct(5);
    testProductIds.push(productId);

    const res = await placeOrder([{ productId, quantity: 1 }]);
    const orderId = res.body.id;

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "PAYMENT_PROCESSING" },
      });
      await tx.payment.create({
        data: {
          orderId,
          status: "PENDING",
          amountPaise: res.body.totalAmountPaise,
        },
      });
    });

    // Order is fresh (just created) → not stuck
    const recovered = await recoverStuckPayments({ stuckAfterMs: 5 * 60_000 });
    expect(recovered).toBe(0);
  });

  it("gives up after MAX_RECOVERY_ATTEMPTS", async () => {
    const productId = await createTestProduct(5);
    testProductIds.push(productId);

    const res = await placeOrder([{ productId, quantity: 1 }]);
    const orderId = res.body.id;

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "PAYMENT_PROCESSING" },
      });
      await tx.payment.create({
        data: {
          orderId,
          status: "PENDING",
          amountPaise: res.body.totalAmountPaise,
          recoveryAttempts: MAX_RECOVERY_ATTEMPTS, // already maxed out
        },
      });
    });

    // Backdate
    await prisma.order.update({
      where: { id: orderId },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const recovered = await recoverStuckPayments({ stuckAfterMs: 5 * 60_000 });
    expect(recovered).toBe(0); // skipped because max attempts reached
  });
});

// ═══════════════════════════════════════════════════════════════
//  4.  RECORD CLEANUP JOB
// ═══════════════════════════════════════════════════════════════

describe("record cleanup job", () => {
  it("deletes published outbox events older than the retention period", async () => {
    // Insert an old published outbox event
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60_000); // 10 days ago
    await prisma.outboxEvent.create({
      data: {
        id: crypto.randomUUID(),
        type: "test.cleanup",
        payload: { test: true },
        publishedAt: oldDate,
        createdAt: oldDate,
      },
    });

    // Insert a recent published event (should NOT be deleted)
    const recentId = crypto.randomUUID();
    await prisma.outboxEvent.create({
      data: {
        id: recentId,
        type: "test.cleanup.recent",
        payload: { test: true },
        publishedAt: new Date(),
        createdAt: new Date(),
      },
    });

    // Insert an old UNPUBLISHED event (should NEVER be deleted)
    const unpublishedId = crypto.randomUUID();
    await prisma.outboxEvent.create({
      data: {
        id: unpublishedId,
        type: "test.cleanup.unpublished",
        payload: { test: true },
        publishedAt: null,
        createdAt: oldDate,
      },
    });

    const result = await cleanupOldRecords({ outboxRetentionMs: 7 * 24 * 60 * 60_000 });
    expect(result.outbox).toBeGreaterThanOrEqual(1);

    // Recent published event survives
    const recent = await prisma.outboxEvent.findUnique({ where: { id: recentId } });
    expect(recent).not.toBeNull();

    // Unpublished event survives (never deleted regardless of age)
    const unpublished = await prisma.outboxEvent.findUnique({ where: { id: unpublishedId } });
    expect(unpublished).not.toBeNull();

    // Clean up the test records we planted
    await prisma.outboxEvent.deleteMany({ where: { id: { in: [recentId, unpublishedId] } } });
  });

  it("deletes old processed events and idempotency keys", async () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60_000);

    // Insert old processed event
    await prisma.processedEvent.create({
      data: {
        consumer: "cleanup-test",
        eventId: `cleanup-test-${Date.now()}`,
        processedAt: oldDate,
      },
    });

    // Insert old idempotency key
    await prisma.idempotencyKey.create({
      data: {
        userId: USER_ID,
        key: `cleanup-idem-${Date.now()}`,
        requestHash: "abc123",
        responseStatus: 201,
        responseBody: { test: true },
        createdAt: oldDate,
      },
    });

    const result = await cleanupOldRecords({
      processedEventRetentionMs: 7 * 24 * 60 * 60_000,
      idempotencyKeyRetentionMs: 24 * 60 * 60_000,
    });

    expect(result.processedEvents).toBeGreaterThanOrEqual(1);
    expect(result.idempotencyKeys).toBeGreaterThanOrEqual(1);
  });

  it("does NOT delete records within the retention window", async () => {
    const recentProcessedEventId = `recent-pe-${Date.now()}`;
    await prisma.processedEvent.create({
      data: {
        consumer: "cleanup-test",
        eventId: recentProcessedEventId,
        processedAt: new Date(), // just now
      },
    });

    const recentIdemKey = `recent-idem-${Date.now()}`;
    await prisma.idempotencyKey.create({
      data: {
        userId: USER_ID,
        key: recentIdemKey,
        requestHash: "xyz789",
        responseStatus: 201,
        responseBody: { test: true },
        createdAt: new Date(), // just now
      },
    });

    await cleanupOldRecords({
      processedEventRetentionMs: 7 * 24 * 60 * 60_000,
      idempotencyKeyRetentionMs: 24 * 60 * 60_000,
    });

    // Both should survive
    const pe = await prisma.processedEvent.findUnique({
      where: { consumer_eventId: { consumer: "cleanup-test", eventId: recentProcessedEventId } },
    });
    expect(pe).not.toBeNull();

    const idem = await prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId: USER_ID, key: recentIdemKey } },
    });
    expect(idem).not.toBeNull();

    // Clean up
    await prisma.processedEvent.delete({
      where: { consumer_eventId: { consumer: "cleanup-test", eventId: recentProcessedEventId } },
    });
    await prisma.idempotencyKey.delete({
      where: { userId_key: { userId: USER_ID, key: recentIdemKey } },
    });
  });
});
