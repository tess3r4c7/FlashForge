import { prisma, type TransactionClient } from "../lib/prisma.js";
import type { OrderStatus } from "../generated/prisma/enums.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { assertCanTransition } from "../domain/order-state-machine.js";
import { releaseInventory, reserveInventory } from "./inventory.service.js";
import { createEvent } from "../messaging/events.js";
import { enqueueEvent } from "../messaging/outbox.js";
import { hashRequest, withIdempotencyKey } from "./idempotency.service.js";

// --- Types ---

interface OrderItemInput {
  productId: number;
  quantity: number;
}

interface CreateOrderInput {
  userId: number;
  items: OrderItemInput[];
}

// What we return to clients whenever we show an order.
const ORDER_DETAILS = { items: true, payment: true } as const;

// --- Shared helpers ---

/**
 * Moves an order from one status to another â€” safely under concurrency.
 *
 * 1. assertCanTransition: is this move legal at all? (pure state-machine check)
 * 2. Conditional UPDATE: "set status = to WHERE id = ? AND status = from".
 *    If another request already changed the status, the WHERE no longer
 *    matches, 0 rows are updated, and we throw 409.
 *
 * This is the same idea as `UPDATE Inventory ... WHERE available >= qty`:
 * the check and the write happen in ONE atomic statement, so two requests
 * can never both win.
 */
export async function transitionOrderStatus(
  tx: TransactionClient,
  orderId: number,
  from: OrderStatus,
  to: OrderStatus,
) {
  assertCanTransition(from, to);

  const { count } = await tx.order.updateMany({
    where: { id: orderId, status: from },
    data: { status: to },
  });

  if (count === 0) {
    throw new ConflictError(
      `Order ${orderId} is no longer ${from} (another request changed it)`,
    );
  }
}

/**
 * Loads an order with its items and checks that it belongs to the user.
 * 404 if it doesn't exist, 403 if it belongs to someone else.
 */
export async function getOrderForUser(
  tx: TransactionClient,
  orderId: number,
  userId: number,
) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: ORDER_DETAILS,
  });

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  if (order.userId !== userId) {
    throw new ForbiddenError("Order does not belong to this user");
  }

  return order;
}

// --- Service ---

export async function createOrder(input: CreateOrderInput) {
  // Everything runs inside a single database transaction.
  // If anything throws, ALL changes are rolled back automatically â€”
  // no partial reservations, no orphaned orders.
  return prisma.$transaction((tx) => createOrderInTx(tx, input));
}

/**
 * Same as createOrder, but safe to retry: requests with the same
 * Idempotency-Key (per user) create the order only once, and retries get the
 * original response back. See idempotency.service.ts.
 */
export async function createOrderIdempotent(input: CreateOrderInput, idempotencyKey: string) {
  return withIdempotencyKey(
    { userId: input.userId, key: idempotencyKey, requestHash: hashRequest(input) },
    201,
    (tx) => createOrderInTx(tx, input),
  );
}

async function createOrderInTx(tx: TransactionClient, input: CreateOrderInput) {
  // Step 1: Validate user exists
  const user = await tx.user.findUnique({
    where: { id: input.userId },
  });

  if (!user) {
    throw new NotFoundError("User not found");
  }

  // Step 2: Fetch all requested products in one query
  // We need the current price to snapshot it into the order.
  const productIds = input.items.map((item) => item.productId);

  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
  });

  // Make sure every requested product actually exists
  if (products.length !== productIds.length) {
    const foundIds = new Set(products.map((p) => p.id));
    const missingIds = productIds.filter((id) => !foundIds.has(id));
    throw new NotFoundError(`Products not found: ${missingIds.join(", ")}`);
  }

  // Step 3: Reserve inventory for EACH item
  // This is where concurrency protection happens.
  // Each reserveInventory call does: UPDATE ... WHERE available >= quantity
  // If ANY item is out of stock, it throws â†’ transaction rolls back â†’
  // all previous reservations in this transaction disappear.
  for (const item of input.items) {
    await reserveInventory(item.productId, item.quantity, tx);
  }

  // Step 4: Build order items with snapshotted prices
  // Why snapshot? If the product price changes tomorrow, this order
  // should still show what the customer actually paid.
  const productMap = new Map(products.map((p) => [p.id, p]));

  let totalAmountPaise = 0;

  const orderItemsData = input.items.map((item) => {
    const product = productMap.get(item.productId)!;
    const unitPricePaise = product.pricePaise;
    const itemTotal = unitPricePaise * item.quantity;
    totalAmountPaise += itemTotal;

    return {
      productId: item.productId,
      quantity: item.quantity,
      unitPricePaise,
    };
  });

  // Step 5: Create the order + order items in one Prisma call
  // Status is INVENTORY_RESERVED because by the time this line runs,
  // all inventory has been successfully reserved above.
  const order = await tx.order.create({
    data: {
      userId: input.userId,
      status: "INVENTORY_RESERVED",
      totalAmountPaise,
      items: {
        create: orderItemsData,
      },
    },
    include: {
      items: true,
    },
  });

  // Step 6: Record the event in the outbox â€” SAME transaction.
  // If the order commits, the event is guaranteed to exist; if anything
  // above failed (e.g. out of stock), neither the order nor the event exist.
  await enqueueEvent(
    tx,
    createEvent("order.created", {
      orderId: order.id,
      userId: order.userId,
      totalAmountPaise: order.totalAmountPaise,
      items: order.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPricePaise: item.unitPricePaise,
      })),
    }),
  );

  return order;
}

export async function getOrderById(orderId: number) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: ORDER_DETAILS,
  });

  if (!order) {
    throw new NotFoundError("Order not found");
  }

  return order;
}

/**
 * User-initiated cancellation of an unpaid order.
 *
 * Only allowed while the order is INVENTORY_RESERVED. Once payment has
 * started, the outcome belongs to the payment flow â€” letting the user cancel
 * mid-payment could mean "money taken, order cancelled".
 *
 * Status change + inventory release happen in ONE transaction, so we can
 * never end up with a cancelled order whose stock is still held.
 */
export async function cancelOrder(orderId: number, userId: number) {
  return prisma.$transaction(async (tx) => {
    const order = await getOrderForUser(tx, orderId, userId);

    if (order.status !== "INVENTORY_RESERVED") {
      throw new ConflictError(
        `Order cannot be cancelled: current status is ${order.status}`,
      );
    }

    await transitionOrderStatus(tx, orderId, "INVENTORY_RESERVED", "CANCELLED");

    for (const item of order.items) {
      await releaseInventory(item.productId, item.quantity, tx);
    }

    await enqueueEvent(
      tx,
      createEvent("order.cancelled", {
        orderId,
        userId,
        reason: "Cancelled by user",
      }),
    );

    return tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: ORDER_DETAILS,
    });
  });
}
