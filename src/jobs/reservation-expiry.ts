import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { createEvent } from "../messaging/events.js";
import { enqueueEvent } from "../messaging/outbox.js";
import { releaseInventory } from "../services/inventory.service.js";
import { transitionOrderStatus } from "../services/order.service.js";

// ─── Job: expire unpaid reservations ─────────────────────────────────
//
// POST /orders RESERVES stock immediately. If the customer never pays, that
// stock is locked away forever. In a flash sale that's a real attack:
// a bot reserves all 100 units and never pays → nobody else can buy.
//
// So reservations have a time limit (RESERVATION_TTL_MS, default 15 min).
// This job finds INVENTORY_RESERVED orders older than that and cancels them:
// status → CANCELLED, stock released, "order.cancelled" event in the outbox,
// all in one transaction.
//
// Race with POST /pay: FOR UPDATE locks the orders we picked. If the customer
// pays at the same moment, their conditional UPDATE waits for our commit,
// then finds the order is no longer INVENTORY_RESERVED → 409. Exactly one wins.
// SKIP LOCKED: if a /pay request locked the row first, we skip it this round.

const log = logger.child({ job: "reservation-expiry" });

export const DEFAULT_RESERVATION_TTL_MS = 15 * 60_000;

export interface ExpiryOptions {
  ttlMs?: number;
  batchSize?: number;
}

/** Cancels one batch of expired reservations. Returns how many were cancelled. */
export async function expireReservations(options: ExpiryOptions = {}): Promise<number> {
  const ttlMs =
    options.ttlMs ?? Number(process.env.RESERVATION_TTL_MS ?? DEFAULT_RESERVATION_TTL_MS);
  const batchSize = options.batchSize ?? 100;
  const cutoff = new Date(Date.now() - ttlMs);

  return prisma.$transaction(
    async (tx) => {
      // "updatedAt" = when the order last changed. An INVENTORY_RESERVED
      // order hasn't changed since it was created, so this is its age.
      const expired = await tx.$queryRaw<{ id: number; userId: number }[]>`
        SELECT id, "userId"
        FROM "Order"
        WHERE status = 'INVENTORY_RESERVED' AND "updatedAt" < ${cutoff}
        ORDER BY "updatedAt"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      for (const { id, userId } of expired) {
        await transitionOrderStatus(tx, id, "INVENTORY_RESERVED", "CANCELLED");

        const items = await tx.orderItem.findMany({ where: { orderId: id } });
        for (const item of items) {
          await releaseInventory(item.productId, item.quantity, tx);
        }

        await enqueueEvent(
          tx,
          createEvent("order.cancelled", {
            orderId: id,
            userId,
            reason: `Reservation expired (not paid within ${Math.round(ttlMs / 60_000)} minutes)`,
          }),
        );
      }

      if (expired.length > 0) {
        log.info({ orderIds: expired.map((o) => o.id) }, `Expired ${expired.length} reservation(s)`);
      }
      return expired.length;
    },
    { timeout: 30_000 },
  );
}
