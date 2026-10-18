import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ConflictError } from "../lib/errors.js";
import { createEvent } from "../messaging/events.js";
import { publishEvent, publishEventBestEffort } from "../messaging/publisher.js";
import { chargePayment, type ChargeResult } from "./payment-gateway.js";
import { confirmReservation, releaseInventory } from "./inventory.service.js";
import { getOrderForUser, transitionOrderStatus } from "./order.service.js";

// Phase 2 did all three payment steps inside the HTTP request.
// Phase 3 splits them across two processes:
//
//   API process   (POST /orders/:id/pay)            → responds in milliseconds
//     Step 1  short transaction: INVENTORY_RESERVED → PAYMENT_PROCESSING,
//             create Payment (PENDING)
//             publish "payment.requested" to RabbitMQ
//             return 202 Accepted
//
//   Worker process (consumes "payment.requested")   → takes as long as it takes
//     Step 2  call the payment gateway (slow)
//     Step 3  short transaction: CONFIRMED or CANCELLED (+ release stock)
//             publish "order.confirmed" / "order.cancelled"

// ─── Step 1 — runs in the API ────────────────────────────────────────

export async function requestPayment(orderId: number, userId: number) {
  const order = await prisma.$transaction(async (tx) => {
    const order = await getOrderForUser(tx, orderId, userId);

    if (order.status !== "INVENTORY_RESERVED") {
      throw new ConflictError(
        `Order cannot be paid: current status is ${order.status}`,
      );
    }

    // Atomic claim — only one concurrent request can win (see Phase 2 doc).
    await transitionOrderStatus(
      tx,
      orderId,
      "INVENTORY_RESERVED",
      "PAYMENT_PROCESSING",
    );

    // Amount always comes from OUR database, never from the client.
    await tx.payment.create({
      data: {
        orderId,
        amountPaise: order.totalAmountPaise,
        status: "PENDING",
      },
    });

    return tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true, payment: true },
    });
  });

  // Publish AFTER the transaction has committed. Publishing inside it would
  // be worse: if the transaction then rolled back, the worker would receive
  // a message about a payment that doesn't exist.
  //
  // ⚠ KNOWN GAP — the "dual-write problem" (fixed in Phase 4):
  // the DB commit and this publish are two separate systems. If RabbitMQ is
  // down, or this process crashes right here, the order is committed as
  // PAYMENT_PROCESSING but no worker ever hears about it → stuck forever.
  await publishEvent(
    createEvent("payment.requested", {
      orderId,
      amountPaise: order.totalAmountPaise,
    }),
  );

  return order;
}

// ─── Steps 2 + 3 — run in the worker ─────────────────────────────────

export type PaymentOutcome = "CONFIRMED" | "CANCELLED" | "SKIPPED";

export async function processPayment(orderId: number): Promise<PaymentOutcome> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payment: true },
  });

  // Duplicate / stale message guard.
  // RabbitMQ delivers "at least once", so the same message can arrive twice
  // (e.g. the worker crashed after processing but before acking). If the
  // order has already moved on, there is nothing to do — and calling the
  // gateway again would charge the customer twice.
  if (
    !order ||
    order.status !== "PAYMENT_PROCESSING" ||
    order.payment?.status !== "PENDING"
  ) {
    logger.info(
      { orderId, status: order?.status, paymentStatus: order?.payment?.status },
      "Payment already handled or order missing; skipping",
    );
    return "SKIPPED";
  }

  // ── Step 2: the slow external call (no transaction, no locks) ──
  let result: ChargeResult;
  try {
    result = await chargePayment({
      orderId,
      amountPaise: order.totalAmountPaise,
    });
  } catch {
    // Treated as a decline so the stock is released. A real system would
    // first ask the gateway whether the charge went through (Phase 5).
    result = { success: false, reason: "Payment gateway error" };
  }

  // ── Step 3: record the outcome atomically ──
  await prisma.$transaction(async (tx) => {
    if (result.success) {
      await transitionOrderStatus(tx, orderId, "PAYMENT_PROCESSING", "CONFIRMED");

      await tx.payment.update({
        where: { orderId },
        data: { status: "SUCCESS", transactionId: result.transactionId },
      });

      // Reserved units are now sold
      for (const item of order.items) {
        await confirmReservation(item.productId, item.quantity, tx);
      }
    } else {
      await transitionOrderStatus(tx, orderId, "PAYMENT_PROCESSING", "CANCELLED");

      await tx.payment.update({
        where: { orderId },
        data: { status: "FAILED" },
      });

      // Compensation: put the units back on sale
      for (const item of order.items) {
        await releaseInventory(item.productId, item.quantity, tx);
      }
    }
  });

  // Tell the rest of the system (notifications today; analytics etc. later).
  // Best effort: the payment outcome is already safely in the database.
  if (result.success) {
    await publishEventBestEffort(
      createEvent("order.confirmed", {
        orderId,
        userId: order.userId,
        transactionId: result.transactionId,
      }),
    );
    return "CONFIRMED";
  }

  await publishEventBestEffort(
    createEvent("order.cancelled", {
      orderId,
      userId: order.userId,
      reason: result.reason,
    }),
  );
  return "CANCELLED";
}
