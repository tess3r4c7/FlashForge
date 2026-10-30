import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

// ─── Read-through cache (Redis) ─────────────────────────────────────────────
//
//   cached("products:all", 30, () => prisma.product.findMany(...))
//
//   1. GET key from Redis            hit  → return it (no DB query)
//   2. miss → run the loader (Postgres)
//   3. SET key = result EX ttl       so the next N requests are hits
//
// "Read-through" = callers just ask for data; the cache decides whether to go
// to the database. Callers never write to the cache themselves.
//
// Three problems every cache has, and what we do about each:
//
// STALENESS - the DB changes but the cache still has the old value.
//   → Writers call `invalidate(key)` AFTER their transaction commits, and
//     every entry has a TTL as a backstop. There is still a small race
//     (a reader that loaded the OLD value just before the commit can SET it
//     just after the DEL); the TTL bounds how long that can last. That's
//     acceptable for product names/prices shown in a list, and it's why we
//     NEVER cache stock levels or anything an order decision depends on:
//     createOrder always reads Postgres inside its transaction.
//
// STAMPEDE - a hot key expires and 500 concurrent requests all miss at once
//   and all hit Postgres with the same query.
//   → Single-flight: within one process, concurrent misses for the same key
//     share ONE loader promise. (Across N API processes that's at most N
//     queries per expiry instead of thousands.)
//
// REDIS DOWN
//   → Fail open: any Redis error just means "miss", and we serve from Postgres.
//
// Values are stored as JSON. To make hits and misses return the SAME shape,
// the loader's result is also passed through a JSON round-trip (so Dates are
// ISO strings either way, exactly as they'd appear in the HTTP response).

const inFlight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const redis = getRedis();

  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (err) {
    logger.debug({ err: (err as Error).message, key }, "Cache read failed - falling back to DB");
  }

  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const load = (async () => {
    try {
      const value = JSON.parse(JSON.stringify(await loader())) as T;
      try {
        await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
      } catch (err) {
        logger.debug({ err: (err as Error).message, key }, "Cache write failed");
      }
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, load);
  return load;
}

/** Removes keys after the underlying data changed. Never throws. */
export async function invalidate(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await getRedis().del(...keys);
  } catch (err) {
    // The TTL will clean it up; worst case the entry is stale until then.
    logger.warn({ err: (err as Error).message, keys }, "Cache invalidation failed - entries expire via TTL");
  }
}

