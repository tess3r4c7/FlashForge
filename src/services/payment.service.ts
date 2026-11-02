import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { ConflictError } from "../lib/errors.js";
import { paymentsProcessedTotal } from "../lib/metrics.js";
import { createEvent } from "../messaging/events.js";
import { enqueueEvent } from "../messaging/outbox.js";
import { chargePayment } from "./payment-gateway.js";
import { confirmReservation, releaseInventory } from "./inventory.service.js";
import { getOrderForUser, transitionOrderStatus } from "./order.service.js";

// Phase 2 did all three payment steps inside the HTTP request.
// Phase 3 split them across two processes. Phase 4 made the hand-off reliable:
//
//   API process   (POST /orders/:id/pay)            → responds in milliseconds
//     Step 1  ONE transaction: INVENTORY_RESERVED → PAYMENT_PROCESSING,
//             create Payment (PENDING),
//             write "payment.requested" to the OUTBOX table
//             return 202 Accepted
//
//   Outbox relay (background)                       → OutboxEvent → RabbitMQ
//
//   Worker process (consumes "payment.requested")   → takes as long as it takes
//     Step 2  call the payment gateway (slow)
//     Step 3  ONE transaction: CONFIRMED or CANCELLED (+ release stock)
//             + write "order.confirmed" / "order.cancelled" to the outbox

// ─── Step 1 — runs in the API ────────────────────────────────────────

export async function requestPayment(orderId: number, userId: number) {
  return prisma.$transaction(async (tx) => {
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

    // Phase 3 published to RabbitMQ AFTER commit — and if that publish failed,
    // the order was stuck in PAYMENT_PROCESSING forever (the dual-write
    // problem). Now the event is part of the SAME transaction: the status
    // change and the "please charge this" message are committed together or
    // not at all. The outbox relay delivers it to RabbitMQ afterwards.
    await enqueueEvent(
      tx,
      createEvent("payment.requested", {
        orderId,
        amountPaise: order.totalAmountPaise,
      }),
    );

    return tx.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true, payment: true },
    });
  });
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
    paymentsProcessedTotal.inc({ outcome: "SKIPPED" });
    return "SKIPPED";
  }

  // ── Step 2: the slow external call (no transaction, no locks) ──
  //
  // Phase 5: if the gateway times out, we let the error PROPAGATE. The
  // consumer then retries this message with back-off (1s, 5s, 30s), and every
  // retry sends the SAME idempotency key, so a charge that secretly went
  // through the first time is never repeated. (Phase 3/4 treated a timeout
  // as a decline, which could cancel an order the customer had paid for.)
  // A decline is NOT an error: it's a definite answer, handled below.
  const result = await chargePayment({
    orderId,
    amountPaise: order.totalAmountPaise,
    idempotencyKey: `payment-${order.payment.id}`,
  });

  // ── Step 3: record the outcome + its event atomically ──
  try {
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

        await enqueueEvent(
          tx,
          createEvent("order.confirmed", {
            orderId,
            userId: order.userId,
            transactionId: result.transactionId,
          }),
        );
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

        await enqueueEvent(
          tx,
          createEvent("order.cancelled", {
            orderId,
            userId: order.userId,
            reason: result.reason,
          }),
        );
      }
    });
  } catch (err) {
    // Two copies of the same message were processed at the same time; both
    // passed the guard above, both got the SAME gateway result (same key),
    // and the other one committed first. Our conditional UPDATE matched 0
    // rows. Nothing to do: the outcome is already recorded.
    if (err instanceof ConflictError) {
      logger.info({ orderId }, "Payment outcome already recorded by a concurrent delivery; skipping");
      return "SKIPPED";
    }
    throw err;
  }

  const outcome = result.success ? "CONFIRMED" : "CANCELLED";
  paymentsProcessedTotal.inc({ outcome });
  return outcome;
}
