import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import type { OrderStatus } from "../src/generated/prisma/enums.js";
import type { DomainEvent } from "../src/messaging/events.js";
import { EXCHANGE, connectRabbitMQ } from "../src/messaging/rabbitmq.js";
import type { ConsumerHandle } from "../src/messaging/consumer.js";
import { startPaymentWorker } from "../src/workers/payment.worker.js";
import { startNotificationWorker } from "../src/workers/notification.worker.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until `check` returns a truthy value, or fails after `timeoutMs`.
 *
 * Background work (the payment worker) finishes at some unknown point after
 * the HTTP response, so async tests must WAIT for an outcome instead of
 * asserting immediately. Polling with a timeout is the standard approach;
 * a fixed `sleep(2000)` would be both slow and flaky.
 */
export async function waitUntil<T>(
  check: () => Promise<T | null | undefined | false>,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

/** Waits until the order reaches one of the given statuses. */
export function waitForOrderStatus(
  orderId: number,
  statuses: OrderStatus[],
  timeoutMs = 10_000,
) {
  return waitUntil(
    async () => {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { payment: true, items: true },
      });
      return order && statuses.includes(order.status) ? order : null;
    },
    `order ${orderId} to reach ${statuses.join(" or ")}`,
    timeoutMs,
  );
}

/**
 * Runs the real workers INSIDE the test process, consuming the test queues.
 * Same code as `npm run dev:worker`, so tests exercise the real pipeline:
 * HTTP → DB → RabbitMQ → worker → DB.
 */
export async function startTestWorkers(): Promise<ConsumerHandle[]> {
  return Promise.all([startPaymentWorker(), startNotificationWorker()]);
}

/**
 * Subscribes to EVERY event on the (test) exchange and collects them.
 *
 * Uses a temporary queue: name "" lets RabbitMQ generate one, `exclusive`
 * means only this connection can use it and it is deleted when we disconnect.
 * Binding pattern "#" = match all routing keys.
 */
export async function captureEvents() {
  const connection = await connectRabbitMQ("test-event-capture");
  const channel = await connection.createChannel();
  const { queue } = await channel.assertQueue("", { exclusive: true });
  await channel.bindQueue(queue, EXCHANGE, "#");

  const events: DomainEvent[] = [];
  await channel.consume(
    queue,
    (msg) => {
      if (!msg) return;
      events.push(JSON.parse(msg.content.toString("utf8")) as DomainEvent);
    },
    { noAck: true },
  );

  return {
    events,
    /** Events whose payload refers to the given order. */
    forOrder(orderId: number) {
      return events.filter((e) => e.payload.orderId === orderId);
    },
    async close() {
      await connection.close();
    },
  };
}

/**
 * Creates a Fastify app instance for testing.
 *
 * Uses Fastify's `.inject()` method — this simulates HTTP requests
 * without actually starting a TCP server. Faster and more reliable
 * than making real HTTP calls.
 */
export function buildTestApp() {
  return buildApp();
}

/**
 * Creates a fresh product with a known inventory quantity.
 * Returns the product ID for use in tests.
 *
 * Uses a timestamp in the name to avoid collisions between test runs.
 */
export async function createTestProduct(
  availableQuantity: number,
  pricePaise: number = 10000,
) {
  const result = await prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        name: `Test Product ${Date.now()}`,
        pricePaise,
      },
    });

    await tx.inventory.create({
      data: {
        productId: product.id,
        availableQuantity,
      },
    });

    return product;
  });

  return result.id;
}

/**
 * Reads the current inventory state for a product.
 */
export async function getInventory(productId: number) {
  return prisma.inventory.findUnique({
    where: { productId },
  });
}

/**
 * Deletes all test data created during a test.
 * Must delete in the right order due to foreign key constraints:
 * Payments → OrderItems → Orders → Inventory → Products
 *
 * Only deletes products with the given IDs (to avoid touching other data).
 */
export async function cleanupTestProducts(productIds: number[]) {
  if (productIds.length === 0) return;

  // Delete payments for orders that contain these products
  await prisma.payment.deleteMany({
    where: {
      order: { items: { some: { productId: { in: productIds } } } },
    },
  });

  // Delete order items for these products
  await prisma.orderItem.deleteMany({
    where: { productId: { in: productIds } },
  });

  // Find and delete orders that now have no items
  // (orders whose ALL items were for our test products)
  const emptyOrders = await prisma.order.findMany({
    where: {
      items: { none: {} },
    },
    select: { id: true },
  });

  if (emptyOrders.length > 0) {
    await prisma.order.deleteMany({
      where: { id: { in: emptyOrders.map((o) => o.id) } },
    });
  }

  // Delete inventory and products
  await prisma.inventory.deleteMany({
    where: { productId: { in: productIds } },
  });

  await prisma.product.deleteMany({
    where: { id: { in: productIds } },
  });
}
