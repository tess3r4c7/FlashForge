import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

// ─── Job: delete old bookkeeping rows ────────────────────────────────
//
// Three tables only ever grow:
//   OutboxEvent     published rows are useless after a while (kept a few days
//                   for debugging: "was event X ever sent?")
//   ProcessedEvent  dedupe markers. Only needed while a duplicate could still
//                   arrive; after days, none will.
//   IdempotencyKey  clients retry within seconds/minutes, not days.
//                   (Stripe keeps keys for 24 hours.)
//
// Trade-off to know: once a ProcessedEvent row is deleted, a duplicate of
// that event arriving later WOULD be processed again. The retention must be
// longer than any realistic redelivery delay.
//
// Production note: deleting millions of rows in one statement causes long
// locks and bloat. You'd delete in batches, or use table partitioning by
// date and simply drop old partitions.

const log = logger.child({ job: "cleanup" });

const DAY_MS = 24 * 60 * 60_000;

export interface CleanupOptions {
  outboxRetentionMs?: number;
  processedEventRetentionMs?: number;
  idempotencyKeyRetentionMs?: number;
}

export async function cleanupOldRecords(options: CleanupOptions = {}) {
  const now = Date.now();
  const before = (ms: number) => new Date(now - ms);

  const [outbox, processedEvents, idempotencyKeys] = await Promise.all([
    // Unpublished rows are NEVER deleted, no matter how old.
    prisma.outboxEvent.deleteMany({
      where: { publishedAt: { lt: before(options.outboxRetentionMs ?? 7 * DAY_MS) } },
    }),
    prisma.processedEvent.deleteMany({
      where: { processedAt: { lt: before(options.processedEventRetentionMs ?? 7 * DAY_MS) } },
    }),
    prisma.idempotencyKey.deleteMany({
      where: { createdAt: { lt: before(options.idempotencyKeyRetentionMs ?? DAY_MS) } },
    }),
  ]);

  const result = {
    outbox: outbox.count,
    processedEvents: processedEvents.count,
    idempotencyKeys: idempotencyKeys.count,
  };
  if (result.outbox + result.processedEvents + result.idempotencyKeys > 0) {
    log.info(result, "Deleted old records");
  }
  return result;
}
