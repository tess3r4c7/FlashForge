import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import type { DomainEvent } from "./events.js";
import { rowToEvent } from "./outbox.js";
import { publishEvent } from "./publisher.js";
import { outboxPublishedTotal, outboxPendingGauge } from "../lib/metrics.js";

// ─── The transactional outbox, relay side ────────────────────────────
//
// A background loop that:
//   1. grabs a batch of unpublished rows       (SELECT ... FOR UPDATE SKIP LOCKED)
//   2. publishes each one to RabbitMQ          (waits for the broker's confirm)
//   3. marks them published                    (UPDATE ... SET publishedAt = now())
//   4. commits, and repeats
//
// If RabbitMQ is down, step 2 fails: we record the error on the row, back
// off, and try again later. The row stays unpublished until it succeeds.
//
// Delivery guarantee: AT-LEAST-ONCE. If the relay crashes after step 2 but
// before step 4 commits, the row is still "unpublished" and will be sent
// again. Consumers already have to cope with duplicates (see Phase 3).

const log = logger.child({ component: "outbox-relay" });

export type Publish = (event: DomainEvent) => Promise<void>;

interface OutboxRow {
  id: string;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export interface BatchResult {
  /** Events successfully published and marked in this batch. */
  published: number;
  /** Set if a publish failed; the batch stopped at that event. */
  error?: string;
}

/**
 * Publishes ONE batch of pending outbox events.
 *
 * Why FOR UPDATE SKIP LOCKED?
 * You may run several worker processes, each with its own relay. Without it,
 * two relays could read the same rows and both publish them. With it:
 *   FOR UPDATE  → lock the rows I selected until my transaction ends
 *   SKIP LOCKED → rows another relay has locked are skipped, not waited on
 * So concurrent relays take DIFFERENT rows and never block each other.
 *
 * Isn't holding a transaction across a network call bad (Phase 2 lesson)?
 * Usually yes. It's acceptable here because the locks are only on outbox
 * rows (no user request ever waits on them), the batch is small, RabbitMQ is
 * close by and confirms in milliseconds, and every publish has a timeout.
 * The gateway call in Phase 2 would have locked ORDER rows users wait on.
 *
 * IMPORTANT: this function never throws from inside the transaction on a
 * publish failure. Throwing would ROLL BACK the transaction — undoing both
 * the "attempts/lastError" bookkeeping and the publishedAt marks of events
 * that DID go out (which would then be sent a second time).
 */
export async function relayBatch(
  publish: Publish = publishEvent,
  batchSize = 50,
): Promise<BatchResult> {
  return prisma.$transaction(
    async (tx): Promise<BatchResult> => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, type, payload, "createdAt"
        FROM "OutboxEvent"
        WHERE "publishedAt" IS NULL
        ORDER BY "createdAt", id
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      if (rows.length === 0) return { published: 0 };

      const publishedIds: string[] = [];
      let error: string | undefined;

      for (const row of rows) {
        try {
          await publish(rowToEvent(row));
          publishedIds.push(row.id);
          outboxPublishedTotal.inc();
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);

          // Visible in the table when debugging: how often, and why.
          await tx.outboxEvent.update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              lastError: error.slice(0, 500),
            },
          });

          // Stop here. Continuing would publish LATER events while an earlier
          // one is still failing, i.e. out of order. And if RabbitMQ is down,
          // the rest would fail too anyway.
          break;
        }
      }

      if (publishedIds.length > 0) {
        await tx.outboxEvent.updateMany({
          where: { id: { in: publishedIds } },
          data: { publishedAt: new Date() },
        });
      }

      return error === undefined
        ? { published: publishedIds.length }
        : { published: publishedIds.length, error };
    },
    // Interactive transactions time out after 5s by default. A batch of
    // publishes may need longer; each publish has its own 5s timeout.
    { timeout: 30_000, maxWait: 10_000 },
  );
}

/** How many events are still waiting to be published (for monitoring/tests). */
export function countPendingOutboxEvents(): Promise<number> {
  return prisma.outboxEvent.count({ where: { publishedAt: null } });
}

export interface RelayOptions {
  /** How many rows to handle per transaction. */
  batchSize?: number;
  /** How long to wait between polls when there is nothing to do. */
  pollIntervalMs?: number;
  /** Upper limit for the back-off delay after failures. */
  maxBackoffMs?: number;
  /** Injected in tests to simulate RabbitMQ failures. Defaults to the real publisher. */
  publish?: Publish;
}

export interface RelayHandle {
  stop(): Promise<void>;
}

/** Starts the relay loop. Call `stop()` for a clean shutdown. */
export function startOutboxRelay(options: RelayOptions = {}): RelayHandle {
  const batchSize = options.batchSize ?? 50;
  const pollIntervalMs =
    options.pollIntervalMs ?? Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 200);
  const maxBackoffMs = options.maxBackoffMs ?? 5_000;
  const publish = options.publish ?? publishEvent;

  let running = true;
  let consecutiveFailures = 0;
  let wake: (() => void) | null = null;

  // A sleep that stop() can cut short, so shutdown is instant.
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function loop() {
    log.info({ pollIntervalMs, batchSize }, "Outbox relay started");

    while (running) {
      let result: BatchResult;
      try {
        result = await relayBatch(publish, batchSize);
      } catch (err) {
        // The database itself failed (e.g. Postgres restarting)
        result = { published: 0, error: err instanceof Error ? err.message : String(err) };
      }

      if (result.error !== undefined) {
        consecutiveFailures++;
        // Exponential back-off: 400ms, 800ms, 1.6s, 3.2s, then 5s max.
        // Hammering a broker that is down helps nobody.
        const delay = Math.min(pollIntervalMs * 2 ** consecutiveFailures, maxBackoffMs);
        log.warn(
          { error: result.error, consecutiveFailures, retryInMs: delay },
          "Outbox relay could not publish; will retry",
        );
        await sleep(delay);
        continue;
      }

      if (consecutiveFailures > 0) {
        log.info({ afterFailures: consecutiveFailures }, "Outbox relay recovered");
        consecutiveFailures = 0;
      }
      if (result.published > 0) {
        log.debug({ published: result.published }, "Outbox batch published");
      }

      // A full batch means more is probably waiting: go again immediately.
      if (result.published < batchSize) await sleep(pollIntervalMs);
    }

    log.info("Outbox relay stopped");
  }

  const done = loop();

  return {
    async stop() {
      running = false;
      wake?.();
      await done;
    },
  };
}
