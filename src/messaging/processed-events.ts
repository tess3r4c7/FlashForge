import { prisma, type TransactionClient } from "../lib/prisma.js";

// ─── Idempotent consumers: the "processed events" table ──────────────
//
// At-least-once delivery means the same event WILL occasionally arrive
// twice (outbox relay crashed before marking it, worker crashed before
// acking, a retry raced with a slow first attempt...). For work that isn't
// naturally idempotent, like sending an email, we remember which events
// each consumer has already handled:
//
//   BEGIN
//     INSERT INTO "ProcessedEvent" (consumer, eventId) ... ON CONFLICT DO NOTHING
//       → 1 row inserted?  first time: do the work
//       → 0 rows?          duplicate: skip
//     ...do the work (can use `tx` for its own DB writes)...
//   COMMIT
//
// Why inside ONE transaction?
//   - Work fails → ROLLBACK removes the marker too → the retry will run again.
//   - Two copies arrive at the same moment → the second INSERT waits on the
//     first one's uncommitted row (unique index lock). When the first commits,
//     the second gets "conflict" → 0 rows → skip. No double send.
//
// The one remaining gap: if the process dies AFTER an external side effect
// (email sent) but BEFORE COMMIT, the retry sends it again. That window is
// milliseconds wide; closing it fully needs the external system to accept
// an idempotency key (like we do with the payment gateway).

export type ProcessedResult<T> = { duplicate: true } | { duplicate: false; result: T };

export async function processOnce<T>(
  consumer: string,
  eventId: string,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<ProcessedResult<T>> {
  return prisma.$transaction(async (tx) => {
    const inserted = await tx.$executeRaw`
      INSERT INTO "ProcessedEvent" (consumer, "eventId")
      VALUES (${consumer}, ${eventId})
      ON CONFLICT DO NOTHING
    `;

    if (inserted === 0) return { duplicate: true as const };

    const result = await work(tx);
    return { duplicate: false as const, result };
  });
}
