import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { createEvent } from "../messaging/events.js";
import { enqueueEvent } from "../messaging/outbox.js";

// ─── Job: recover stuck payments ─────────────────────────────────────
//
// An order can get stuck in PAYMENT_PROCESSING if its payment.requested
// message never results in an outcome:
//   - it was lost before the outbox existed (order #587 from Phase 3)
//   - it was dead-lettered because the gateway was down for a long time
//   - a bug, a deleted queue, an operator mistake...
//
// This job is the safety net: any PAYMENT_PROCESSING order with a PENDING
// payment that hasn't changed for STUCK_PAYMENT_AFTER_MS (default 5 min)
// gets a NEW payment.requested event via the outbox. That's safe because:
//   - the payment worker checks state first (already done → SKIPPED), and
//   - the gateway call uses the same idempotency key (payment-<id>), so a
//     charge that already went through is never repeated.
//
// The threshold must be longer than the consumer's whole retry window
// (1s + 5s + 30s ≈ 36s), otherwise we'd re-send while retries are still
// in progress (harmless thanks to idempotency, but wasteful).
//
// We give up after MAX_RECOVERY_ATTEMPTS and log an error: something is
// seriously wrong and a human should look (alerting comes in Phase 7).
// We never auto-CANCEL: we don't know whether the customer was charged.

const log = logger.child({ job: "stuck-payment-recovery" });

export const DEFAULT_STUCK_AFTER_MS = 5 * 60_000;
export const MAX_RECOVERY_ATTEMPTS = 3;

export interface RecoveryOptions {
  stuckAfterMs?: number;
  batchSize?: number;
}

/** Re-sends payment.requested for one batch of stuck orders. Returns how many. */
export async function recoverStuckPayments(options: RecoveryOptions = {}): Promise<number> {
  const stuckAfterMs =
    options.stuckAfterMs ?? Number(process.env.STUCK_PAYMENT_AFTER_MS ?? DEFAULT_STUCK_AFTER_MS);
  const batchSize = options.batchSize ?? 100;
  const cutoff = new Date(Date.now() - stuckAfterMs);

  return prisma.$transaction(
    async (tx) => {
      const stuck = await tx.$queryRaw<
        { orderId: number; amountPaise: number; paymentId: number; recoveryAttempts: number }[]
      >`
        SELECT o.id AS "orderId", p."amountPaise", p.id AS "paymentId", p."recoveryAttempts"
        FROM "Order" o
        JOIN "Payment" p ON p."orderId" = o.id
        WHERE o.status = 'PAYMENT_PROCESSING'
          AND p.status = 'PENDING'
          AND o."updatedAt" < ${cutoff}
          AND p."recoveryAttempts" < ${MAX_RECOVERY_ATTEMPTS}
        ORDER BY o."updatedAt"
        LIMIT ${batchSize}
        FOR UPDATE OF o SKIP LOCKED
      `;

      for (const row of stuck) {
        await enqueueEvent(
          tx,
          createEvent("payment.requested", { orderId: row.orderId, amountPaise: row.amountPaise }),
        );

        const attempt = row.recoveryAttempts + 1;
        await tx.payment.update({
          where: { id: row.paymentId },
          data: { recoveryAttempts: attempt },
        });

        // Touch the order so the next sweep waits another full threshold
        // before trying again (instead of re-sending every minute).
        await tx.order.update({ where: { id: row.orderId }, data: { updatedAt: new Date() } });

        if (attempt >= MAX_RECOVERY_ATTEMPTS) {
          log.error(
            { orderId: row.orderId, attempt },
            "Last automatic recovery attempt for stuck payment; needs manual review if it fails",
          );
        } else {
          log.warn({ orderId: row.orderId, attempt }, "Re-sent payment.requested for stuck order");
        }
      }

      return stuck.length;
    },
    { timeout: 30_000 },
  );
}
