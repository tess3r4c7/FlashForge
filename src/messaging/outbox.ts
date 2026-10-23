import type { Prisma } from "../generated/prisma/client.js";
import type { TransactionClient } from "../lib/prisma.js";
import type { DomainEvent } from "./events.js";

// ─── The transactional outbox, write side ────────────────────────────
//
// Instead of publishing to RabbitMQ directly, services call `enqueueEvent`
// with the SAME transaction client (`tx`) they use for their business writes.
//
//   BEGIN
//     UPDATE "Order" SET status = 'PAYMENT_PROCESSING' ...
//     INSERT INTO "Payment" ...
//     INSERT INTO "OutboxEvent" (type = 'payment.requested', ...)   ← this
//   COMMIT
//
// One database, one transaction → both writes succeed or neither does.
// There is no longer any moment where the order is updated but the event
// is lost. The relay (outbox-relay.ts) moves rows from this table to
// RabbitMQ afterwards, retrying for as long as it takes.

export async function enqueueEvent(
  tx: TransactionClient,
  event: DomainEvent,
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      id: event.eventId,
      type: event.type,
      payload: event.payload as Prisma.InputJsonValue,
      createdAt: new Date(event.occurredAt),
    },
  });
}

/** Rebuilds the event envelope from a stored outbox row. */
export function rowToEvent(row: {
  id: string;
  type: string;
  payload: unknown;
  createdAt: Date;
}): DomainEvent {
  return {
    eventId: row.id,
    type: row.type,
    occurredAt: row.createdAt.toISOString(),
    payload: row.payload,
  } as DomainEvent;
}
