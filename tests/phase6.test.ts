import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createTestProduct, cleanupTestProducts } from "./helpers.js";
import { prisma } from "../src/lib/prisma.js";
import { closeRedis, connectRedis, getRedis } from "../src/lib/redis.js";
import { hitRateLimit } from "../src/lib/rate-limiter.js";
import { cached } from "../src/lib/cache.js";
import { productCacheKeys } from "../src/services/product.service.js";
import { idempotencyCacheKey } from "../src/services/idempotency.service.js";

// ─── Phase 6: Redis ──────────────────────────────────────────────────────────
//
//   1. Rate limiting      (sliding window, atomic under concurrency, fails open)
//   2. Product cache      (read-through, invalidation, single-flight, fails open)
//   3. Idempotency cache  (Redis in front of Postgres, Postgres still authoritative)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const testProductIds: number[] = [];
const appsToClose: FastifyInstance[] = [];

/** A fresh app with its own rate-limit settings. */
async function makeApp(rateLimit: { limit: number; windowMs: number } | false = false) {
  const app = buildApp({ rateLimit });
  await app.ready();
  appsToClose.push(app);
  return app;
}

/**
 * Simulates a Redis outage: drop the shared client and point the next one at
 * a port where nothing listens. Every Redis command now fails, exactly like
 * when the Redis container is stopped.
 */
const realRedisUrl = process.env.REDIS_URL;
async function simulateRedisOutage() {
  await closeRedis();
  process.env.REDIS_URL = "redis://localhost:6390";
  await connectRedis(); // fails (logged), app keeps working
}

/** Every test starts with a healthy, connected Redis client. */
beforeEach(async () => {
  if (process.env.REDIS_URL !== realRedisUrl) {
    await closeRedis();
    process.env.REDIS_URL = realRedisUrl;
  }
  await connectRedis();
});

afterAll(async () => {
  for (const app of appsToClose) await app.close();
  await cleanupTestProducts(testProductIds);
  await closeRedis();
});

/** Unique fake user per test → its own rate-limit bucket. The user doesn't
 * exist, so the handler answers 404 - but the limiter runs BEFORE the handler,
 * so every attempt still counts. That keeps these tests free of DB writes. */
const freshUserId = () => 100_000 + Math.floor(Math.random() * 1_000_000);

function postOrder(app: FastifyInstance, userId: number) {
  return app.inject({
    method: "POST",
    url: "/orders",
    payload: { userId, items: [{ productId: 1, quantity: 1 }] },
  });
}

// ─── 1. Rate limiting ────────────────────────────────────────────────────────

describe("Rate limiting", () => {
  it("allows `limit` requests, then answers 429 with Retry-After", async () => {
    const app = await makeApp({ limit: 3, windowMs: 2_000 });
    const userId = freshUserId();

    const statuses: number[] = [];
    const remaining: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await postOrder(app, userId);
      statuses.push(res.statusCode);
      remaining.push(String(res.headers["ratelimit-remaining"]));
    }
    expect(statuses).toEqual([404, 404, 404]); // reached the handler (fake user)
    expect(remaining).toEqual(["2", "1", "0"]);

    const blocked = await postOrder(app, userId);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["ratelimit-limit"]).toBe("3");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(blocked.headers["retry-after"])).toBeLessThanOrEqual(2);
    expect(JSON.parse(blocked.body).error).toMatch(/Too many requests/);
  });

  it("is atomic: a concurrent burst lets through exactly `limit` requests", async () => {
    const app = await makeApp({ limit: 5, windowMs: 5_000 });
    const userId = freshUserId();

    const results = await Promise.all(Array.from({ length: 30 }, () => postOrder(app, userId)));
    const allowed = results.filter((r) => r.statusCode !== 429).length;
    const blocked = results.filter((r) => r.statusCode === 429).length;

    // A non-atomic check-then-increment would let more than 5 through.
    expect(allowed).toBe(5);
    expect(blocked).toBe(25);
  });

  it("keeps a separate bucket per user", async () => {
    const app = await makeApp({ limit: 1, windowMs: 5_000 });
    const alice = freshUserId();
    const bob = alice + 1;

    expect((await postOrder(app, alice)).statusCode).toBe(404);
    expect((await postOrder(app, alice)).statusCode).toBe(429);
    expect((await postOrder(app, bob)).statusCode).toBe(404); // unaffected by alice
  });

  it("keeps separate buckets for creating and paying", async () => {
    const app = await makeApp({ limit: 1, windowMs: 5_000 });
    const userId = freshUserId();

    expect((await postOrder(app, userId)).statusCode).toBe(404);
    expect((await postOrder(app, userId)).statusCode).toBe(429);

    const pay = await app.inject({
      method: "POST",
      url: "/orders/999999/pay",
      payload: { userId },
    });
    expect(pay.statusCode).not.toBe(429);
  });

  it("slides: requests are allowed again once old ones leave the window", async () => {
    const app = await makeApp({ limit: 2, windowMs: 400 });
    const userId = freshUserId();

    await postOrder(app, userId);
    await postOrder(app, userId);
    expect((await postOrder(app, userId)).statusCode).toBe(429);

    await sleep(450);
    expect((await postOrder(app, userId)).statusCode).toBe(404);
  });

  it("does not limit reads (clients poll GET /orders/:id)", async () => {
    const app = await makeApp({ limit: 1, windowMs: 5_000 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => app.inject({ method: "GET", url: "/orders/999999" })),
    );
    expect(results.every((r) => r.statusCode === 404)).toBe(true);
  });

  it("rejects invalid bodies with 400 before touching the limiter", async () => {
    const app = await makeApp({ limit: 1, windowMs: 5_000 });
    const userId = freshUserId();

    const bad = await app.inject({ method: "POST", url: "/orders", payload: { userId } }); // no items
    expect(bad.statusCode).toBe(400);
    // The bad request didn't use up the single allowed slot
    expect((await postOrder(app, userId)).statusCode).toBe(404);
  });

  it("fails open when Redis is unavailable", async () => {
    const app = await makeApp({ limit: 1, windowMs: 5_000 });
    const userId = freshUserId();

    await simulateRedisOutage();

    const direct = await hitRateLimit(`ratelimit:test:${userId}`, { limit: 1, windowMs: 5_000 });
    expect(direct).toMatchObject({ allowed: true, failedOpen: true });

    const results = await Promise.all(Array.from({ length: 3 }, () => postOrder(app, userId)));
    expect(results.map((r) => r.statusCode)).toEqual([404, 404, 404]); // none throttled
    expect(results[0].headers["ratelimit-limit"]).toBeUndefined();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(JSON.parse(health.body)).toMatchObject({ status: "ok", redis: "down" });
  });
});

// ─── 2. Product cache ────────────────────────────────────────────────────────

describe("Product cache", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await makeApp(false);
  });

  it("GET /products/:id is read-through: miss → DB → cached; hit → no DB", async () => {
    const productId = await createTestProduct(10);
    testProductIds.push(productId);
    const key = productCacheKeys.one(productId);

    expect(await getRedis().exists(key)).toBe(0);

    const first = await app.inject({ method: "GET", url: `/products/${productId}` });
    expect(first.statusCode).toBe(200);
    expect(await getRedis().exists(key)).toBe(1);
    expect(await getRedis().ttl(key)).toBeGreaterThan(0); // has a TTL backstop

    // Change the row behind the cache's back. A cache HIT still shows the
    // old name - proof that the second request never reached Postgres.
    await prisma.product.update({ where: { id: productId }, data: { name: "Renamed in DB" } });
    const second = await app.inject({ method: "GET", url: `/products/${productId}` });
    expect(JSON.parse(second.body).name).toBe(JSON.parse(first.body).name);

    // Once the entry is gone (TTL / invalidation), the fresh value is served.
    await getRedis().del(key);
    const third = await app.inject({ method: "GET", url: `/products/${productId}` });
    expect(JSON.parse(third.body).name).toBe("Renamed in DB");
  });

  it("hits and misses return the same JSON", async () => {
    const productId = await createTestProduct(10);
    testProductIds.push(productId);

    const miss = await app.inject({ method: "GET", url: `/products/${productId}` });
    const hit = await app.inject({ method: "GET", url: `/products/${productId}` });
    expect(hit.body).toBe(miss.body);
  });

  it("POST /products invalidates the cached product list", async () => {
    await app.inject({ method: "GET", url: "/products" }); // warm the cache
    expect(await getRedis().exists(productCacheKeys.all)).toBe(1);

    const created = await app.inject({
      method: "POST",
      url: "/products",
      payload: { name: `Cache test ${randomUUID()}`, pricePaise: 500, quantity: 3 },
    });
    expect(created.statusCode).toBe(201);
    const newId = JSON.parse(created.body).id as number;
    testProductIds.push(newId);

    expect(await getRedis().exists(productCacheKeys.all)).toBe(0);
    const list = JSON.parse((await app.inject({ method: "GET", url: "/products" })).body) as {
      id: number;
    }[];
    expect(list.some((p) => p.id === newId)).toBe(true);
  });

  it("returns 404 for unknown products (and caches the miss)", async () => {
    const res = await app.inject({ method: "GET", url: "/products/987654321" });
    expect(res.statusCode).toBe(404);
    expect(await getRedis().get(productCacheKeys.one(987654321))).toBe("null");
  });

  it("single-flight: concurrent misses on one key run the loader once", async () => {
    const key = `cache:test:${randomUUID()}`;
    let loads = 0;
    const loader = async () => {
      loads++;
      await sleep(100);
      return { value: 42 };
    };

    const results = await Promise.all(Array.from({ length: 25 }, () => cached(key, 30, loader)));

    expect(loads).toBe(1);
    expect(results.every((r) => r.value === 42)).toBe(true);
  });

  it("fails open: serves from Postgres when Redis is down", async () => {
    const productId = await createTestProduct(10);
    testProductIds.push(productId);

    await simulateRedisOutage();
    const res = await app.inject({ method: "GET", url: `/products/${productId}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(productId);
  });
});

// ─── 3. Idempotency cache ────────────────────────────────────────────────────

describe("Idempotency keys: Redis in front of Postgres", () => {
  let app: FastifyInstance;
  let productId: number;

  beforeAll(async () => {
    app = await makeApp(false);
    productId = await createTestProduct(100);
    testProductIds.push(productId);
  });

  function placeOrder(key: string, quantity = 1) {
    return app.inject({
      method: "POST",
      url: "/orders",
      headers: { "idempotency-key": key },
      payload: { userId: 1, items: [{ productId, quantity }] },
    });
  }

  it("caches the response in Redis after the transaction commits", async () => {
    const key = randomUUID();
    const first = await placeOrder(key);
    expect(first.statusCode).toBe(201);

    const raw = await getRedis().get(idempotencyCacheKey(1, key));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ statusCode: 201, body: { id: JSON.parse(first.body).id } });
    expect(await getRedis().ttl(idempotencyCacheKey(1, key))).toBeGreaterThan(23 * 3600);
  });

  it("replays from Redis without touching Postgres", async () => {
    const key = randomUUID();
    const first = await placeOrder(key);

    // Remove the Postgres record. Only Redis knows about this key now, so a
    // replay proves the fast path answered.
    await prisma.idempotencyKey.delete({ where: { userId_key: { userId: 1, key } } });

    const ordersBefore = await prisma.order.count();
    const retry = await placeOrder(key);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body).toBe(first.body);
    expect(await prisma.order.count()).toBe(ordersBefore);
  });

  it("rejects a different body with 422 on the Redis path too", async () => {
    const key = randomUUID();
    await placeOrder(key, 1);
    expect(await getRedis().exists(idempotencyCacheKey(1, key))).toBe(1);

    const res = await placeOrder(key, 2);
    expect(res.statusCode).toBe(422);
  });

  it("falls back to Postgres when the Redis entry is missing (evicted)", async () => {
    const key = randomUUID();
    const first = await placeOrder(key);
    await getRedis().del(idempotencyCacheKey(1, key));

    const retry = await placeOrder(key);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    // Same data; key ORDER may differ because Postgres JSONB doesn't keep it.
    expect(JSON.parse(retry.body)).toEqual(JSON.parse(first.body));
    // ...and the Postgres path re-populates the cache.
    expect(await getRedis().exists(idempotencyCacheKey(1, key))).toBe(1);
  });

  it("still guarantees one order per key when Redis is down", async () => {
    const key = randomUUID();
    await simulateRedisOutage();

    const results = await Promise.all(Array.from({ length: 5 }, () => placeOrder(key)));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const ids = new Set(results.map((r) => JSON.parse(r.body).id));
    expect(ids.size).toBe(1); // Postgres alone deduplicated them
    expect(results.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(4);
  });
});
