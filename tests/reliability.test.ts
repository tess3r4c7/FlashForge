import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ChannelModel, ConfirmChannel, GetMessage } from "amqplib";
import {
  buildTestApp,
  createTestProduct,
  cleanupTestProducts,
  getInventory,
  waitForOrderStatus,
  waitUntil,
} from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { createEvent, type DomainEvent } from "../src/messaging/events.js";
import {
  QUEUES,
  RETRY_DELAYS_MS,
  connectRabbitMQ,
  deadLetterQueueName,
} from "../src/messaging/rabbitmq.js";
import {
  ATTEMPT_HEADER,
  NonRetryableError,
  startConsumer,
  type ConsumerHandle,
} from "../src/messaging/consumer.js";
import { startOutboxRelay, type RelayHandle } from "../src/messaging/outbox-relay.js";
import { closePublisher } from "../src/messaging/publisher.js";
import { startPaymentWorker } from "../src/workers/payment.worker.js";
import {
  startNotificationWorker,
  type Notification,
} from "../src/workers/notification.worker.js";
import { chargePayment, getChargeAttempts } from "../src/services/payment-gateway.js";

// Phase 5A: retries with back-off, dead-letter queue, idempotent consumers.
// Test env: RETRY_DELAYS_MS = 100,200,400 → 4 attempts in total.

const USER_ID = 1;
const DEMO_QUEUE = "test.reliability.demo";
const PAYMENTS_DLQ = deadLetterQueueName(QUEUES.payments);
const DEMO_DLQ = deadLetterQueueName(DEMO_QUEUE);

let app: FastifyInstance;
let handles: (ConsumerHandle | RelayHandle)[] = [];
const testProductIds: number[] = [];

// Raw RabbitMQ access for publishing test messages and reading DLQs
let connection: ChannelModel;
let channel: ConfirmChannel;

// Everything the notification worker "sent"
const sent: Notification[] = [];
// Lets a test make the notification provider fail
let failNextSendFor: string | null = null;
let sendAttempts = 0;

// The demo consumer's behaviour is swapped per test
let demoHandler: (event: DomainEvent) => Promise<void> = async () => {};

beforeAll(async () => {
  app = buildTestApp();
  await app.ready();

  connection = await connectRabbitMQ("test-reliability");
  channel = await connection.createConfirmChannel();

  handles = [
    await startPaymentWorker(),
    await startNotificationWorker(undefined, async (n) => {
      sendAttempts++;
      if (failNextSendFor === n.eventId) {
        failNextSendFor = null;
        throw new Error("Email provider unavailable (simulated)");
      }
      sent.push(n);
    }),
    await startConsumer({
      name: "demo-consumer",
      queue: DEMO_QUEUE,
      prefetch: 5,
      handle: (event) => demoHandler(event),
    }),
    startOutboxRelay(),
  ];
});

afterAll(async () => {
  await Promise.all(handles.map((h) => h.stop()));
  await closePublisher();
  await channel.close();
  await connection.close();
  await cleanupTestProducts(testProductIds);
  await app.close();
});

beforeEach(async () => {
  process.env.PAYMENT_DELAY_MS = "0";
  process.env.PAYMENT_SUCCESS_RATE = "1";
  process.env.PAYMENT_GATEWAY_TRANSIENT_FAILURES = "0";
  await channel.purgeQueue(PAYMENTS_DLQ);
  await channel.purgeQueue(DEMO_DLQ);
  demoHandler = async () => {};
});

// ─── Helpers ────────────────────────────────────────────────
async function placeAndPay(stock = 5) {
  const productId = await createTestProduct(stock);
  testProductIds.push(productId);

  const created = await app.inject({
    method: "POST",
    url: "/orders",
    payload: { userId: USER_ID, items: [{ productId, quantity: 1 }] },
  });
  const order = JSON.parse(created.body) as { id: number };

  const paid = await app.inject({
    method: "POST",
    url: `/orders/${order.id}/pay`,
    payload: { userId: USER_ID },
  });
  expect(paid.statusCode).toBe(202);
  const paymentId = (JSON.parse(paid.body) as { payment: { id: number } }).payment.id;

  return { orderId: order.id, productId, paymentId };
}

function sendRaw(queue: string, content: Buffer, messageId?: string): Promise<void> {
  return new Promise((resolve, reject) =>
    channel.sendToQueue(
      queue,
      content,
      { persistent: true, ...(messageId ? { messageId } : {}) },
      (err) => (err ? reject(err) : resolve()),
    ),
  );
}

const sendEvent = (queue: string, event: DomainEvent) =>
  sendRaw(queue, Buffer.from(JSON.stringify(event)), event.eventId);

/** Waits until `count` messages are in the DLQ, removes and returns them. */
async function takeFromDlq(dlq: string, count = 1, timeoutMs = 10_000) {
  const taken: GetMessage[] = [];
  await waitUntil(
    async () => {
      const msg = await channel.get(dlq, { noAck: true });
      if (msg) taken.push(msg);
      return taken.length >= count;
    },
    `${count} message(s) in ${dlq}`,
    timeoutMs,
  );
  return taken;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Retries with back-off ──────────────────────────────────

describe("retries with back-off", () => {
  it("a failing handler is retried after 100ms, then 200ms, and succeeds", async () => {
    const calls: number[] = [];
    demoHandler = async () => {
      calls.push(Date.now());
      if (calls.length <= 2) throw new Error("transient failure");
    };

    await sendEvent(DEMO_QUEUE, createEvent("order.cancelled", { orderId: -1, userId: 1, reason: "demo" }));

    await waitUntil(async () => calls.length >= 3, "3 handler calls");
    await sleep(300);
    expect(calls).toHaveLength(3); // succeeded on the 3rd attempt, no more calls

    // The gaps are the back-off delays (RabbitMQ TTL timers; allow some slack)
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(RETRY_DELAYS_MS[0]! - 20);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(RETRY_DELAYS_MS[1]! - 20);

    // Success → nothing dead-lettered
    expect((await channel.checkQueue(DEMO_DLQ)).messageCount).toBe(0);
  });

  it("after all retries fail, the message lands in the DLQ with diagnostics", async () => {
    let calls = 0;
    demoHandler = async () => {
      calls++;
      throw new Error("still broken");
    };

    const event = createEvent("order.cancelled", { orderId: -2, userId: 1, reason: "demo" });
    await sendEvent(DEMO_QUEUE, event);

    const [dead] = await takeFromDlq(DEMO_DLQ);
    const headers = dead!.properties.headers!;

    expect(calls).toBe(RETRY_DELAYS_MS.length + 1); // 1 try + 3 retries = 4
    expect(headers[ATTEMPT_HEADER]).toBe(4);
    expect(headers["x-dead-letter-reason"]).toBe("retries-exhausted");
    expect(headers["x-last-error"]).toBe("still broken");
    // The original message is preserved intact
    expect(JSON.parse(dead!.content.toString()).eventId).toBe(event.eventId);
  });

  it("NonRetryableError skips the retries and goes straight to the DLQ", async () => {
    let calls = 0;
    demoHandler = async () => {
      calls++;
      throw new NonRetryableError("invalid order data");
    };

    await sendEvent(DEMO_QUEUE, createEvent("order.cancelled", { orderId: -3, userId: 1, reason: "demo" }));

    const [dead] = await takeFromDlq(DEMO_DLQ);
    expect(calls).toBe(1);
    expect(dead!.properties.headers!["x-dead-letter-reason"]).toBe("non-retryable");
  });

  it("a malformed (non-JSON) message is parked in the DLQ, not dropped", async () => {
    let calls = 0;
    demoHandler = async () => {
      calls++;
    };

    await sendRaw(DEMO_QUEUE, Buffer.from("this is {not json"));

    const [dead] = await takeFromDlq(DEMO_DLQ);
    expect(calls).toBe(0);
    expect(dead!.content.toString()).toBe("this is {not json");
    expect(dead!.properties.headers!["x-last-error"]).toContain("Malformed JSON");
  });
});

// ─── Payments: timeouts vs declines ─────────────────────────

describe("payment gateway timeouts", () => {
  it("the gateway honours idempotency keys: same key → same result, no second charge", async () => {
    const key = `test-key-${Date.now()}`;
    const first = await chargePayment({ orderId: 1, amountPaise: 100, idempotencyKey: key });
    const second = await chargePayment({ orderId: 1, amountPaise: 100, idempotencyKey: key });

    expect(first.success).toBe(true);
    expect(second).toEqual(first); // same transactionId
    expect(getChargeAttempts(key)).toBe(2);
  });

  it("a timeout is RETRIED (not treated as a decline) and the order confirms", async () => {
    // Each payment's first 2 gateway calls time out, the 3rd succeeds.
    process.env.PAYMENT_GATEWAY_TRANSIENT_FAILURES = "2";

    const { orderId, productId, paymentId } = await placeAndPay();

    const final = await waitForOrderStatus(orderId, ["CONFIRMED", "CANCELLED"]);
    expect(final.status).toBe("CONFIRMED");
    expect(final.payment!.status).toBe("SUCCESS");

    // 3 calls, all with the same idempotency key
    expect(getChargeAttempts(`payment-${paymentId}`)).toBe(3);

    const inv = await getInventory(productId);
    expect(inv!.availableQuantity).toBe(4);
    expect(inv!.reservedQuantity).toBe(0);
  });

  it("if the gateway stays down, the payment is dead-lettered (order NOT cancelled) and can be replayed", async () => {
    process.env.PAYMENT_GATEWAY_TRANSIENT_FAILURES = "99";

    const { orderId, productId, paymentId } = await placeAndPay();

    const [dead] = await takeFromDlq(PAYMENTS_DLQ);
    const event = JSON.parse(dead!.content.toString()) as DomainEvent;
    expect(event.type).toBe("payment.requested");
    expect(event.payload.orderId).toBe(orderId);
    expect(dead!.properties.headers![ATTEMPT_HEADER]).toBe(4);
    expect(dead!.properties.headers!["x-last-error"]).toContain("timeout");
    expect(getChargeAttempts(`payment-${paymentId}`)).toBe(4);

    // We DON'T KNOW if money moved, so we must not cancel or release stock.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true } });
    expect(order.status).toBe("PAYMENT_PROCESSING");
    expect(order.payment!.status).toBe("PENDING");
    expect((await getInventory(productId))!.reservedQuantity).toBe(1);

    // The gateway recovers; an operator replays the DLQ (what `npm run dlq -- replay` does).
    process.env.PAYMENT_GATEWAY_TRANSIENT_FAILURES = "0";
    await sendRaw(QUEUES.payments, dead!.content, event.eventId);

    const final = await waitForOrderStatus(orderId, ["CONFIRMED", "CANCELLED"]);
    expect(final.status).toBe("CONFIRMED");
  });
});

// ─── Idempotent consumers ───────────────────────────────────

describe("idempotent notification consumer", () => {
  const notificationEvent = () =>
    createEvent("order.confirmed", { orderId: -100, userId: 1, transactionId: "txn_test" });

  const sentFor = (eventId: string) => sent.filter((n) => n.eventId === eventId);

  it("the same event delivered 3 times sends ONE notification", async () => {
    const event = notificationEvent();
    for (let i = 0; i < 3; i++) await sendEvent(QUEUES.notifications, event);

    await waitUntil(async () => sentFor(event.eventId).length >= 1, "notification sent");
    await waitUntil(
      async () => (await channel.checkQueue(QUEUES.notifications)).messageCount === 0,
      "queue drained",
    );
    await sleep(300);

    expect(sentFor(event.eventId)).toHaveLength(1);
    expect(
      await prisma.processedEvent.count({ where: { consumer: "notification-worker", eventId: event.eventId } }),
    ).toBe(1);
  });

  it("10 copies arriving at the same moment still send ONE notification", async () => {
    const event = notificationEvent();
    await Promise.all(Array.from({ length: 10 }, () => sendEvent(QUEUES.notifications, event)));

    await waitUntil(async () => sentFor(event.eventId).length >= 1, "notification sent");
    await waitUntil(
      async () => (await channel.checkQueue(QUEUES.notifications)).messageCount === 0,
      "queue drained",
    );
    await sleep(300);

    expect(sentFor(event.eventId)).toHaveLength(1);
  });

  it("if sending fails, the marker is rolled back so the retry still sends it (exactly once)", async () => {
    const event = notificationEvent();
    failNextSendFor = event.eventId;
    const attemptsBefore = sendAttempts;

    await sendEvent(QUEUES.notifications, event);

    await waitUntil(async () => sentFor(event.eventId).length >= 1, "notification sent after retry");
    await sleep(300);

    expect(sentFor(event.eventId)).toHaveLength(1);
    expect(sendAttempts - attemptsBefore).toBe(2); // failed once, then succeeded
  });
});
