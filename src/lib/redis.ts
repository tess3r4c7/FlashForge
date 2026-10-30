import { Redis } from "ioredis";
import { logger } from "./logger.js";

// ─── Redis: a helper, never the source of truth ─────────────────────────────
//
// Everything we keep in Redis is DISPOSABLE:
//   - rate-limit counters        (lose them → limits reset, fine)
//   - cached product data        (lose it   → read from Postgres)
//   - cached idempotent replies  (lose them → Postgres still has them)
//
// So the rule throughout the codebase is FAIL OPEN: if Redis is down or
// slow, log a warning and carry on without it. A Redis outage must never
// take the order flow down with it.
//
// Client settings that make "fail open" actually fast:
//   enableOfflineQueue: false → while disconnected, commands fail IMMEDIATELY
//                               instead of queueing in memory until Redis
//                               comes back (which would hang every request).
//   maxRetriesPerRequest: 1   → don't retry a single command forever.
//   commandTimeout            → a stuck Redis can't add more than N ms to a request.
//   lazyConnect               → we connect explicitly in connectRedis(); if the
//                               first command comes earlier, it triggers the
//                               connection (and fails open until it's up).
// ioredis keeps reconnecting in the background, so when Redis comes back the
// features switch themselves back on.

const COMMAND_TIMEOUT_MS = Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? 200);

let client: Redis | null = null;
let lastErrorLogAt = 0;

/** The shared client (created on first use, connected by `connectRedis`). */
export function getRedis(): Redis {
  if (!client || client.status === "end") {
    // Read at creation time (not module load) so a reconnect picks up the
    // current setting - tests use this to simulate an outage.
    const created = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: 2_000,
      // Reconnect forever, backing off up to 2s between attempts.
      retryStrategy: (times) => Math.min(times * 100, 2_000),
    });

    // Without an 'error' listener ioredis prints every failed reconnect.
    // Log at most once every 10s so a Redis outage doesn't flood the logs.
    created.on("error", (err) => {
      const now = Date.now();
      if (now - lastErrorLogAt > 10_000) {
        lastErrorLogAt = now;
        logger.warn({ err: err.message }, "Redis unavailable - running without it (fail open)");
      }
    });

    client = created;
  }
  return client;
}

/**
 * Connects the shared client. Never throws: if Redis is down the app still
 * starts, and ioredis keeps retrying in the background.
 */
export async function connectRedis(): Promise<void> {
  const redis = getRedis();
  if (redis.status !== "wait") return; // already connecting / connected
  try {
    await redis.connect();
    logger.info("Connected to Redis");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Could not connect to Redis at startup - continuing without it");
  }
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  const redis = client;
  client = null;
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

/** True when commands can be sent right now. */
export function isRedisReady(): boolean {
  return client?.status === "ready";
}
