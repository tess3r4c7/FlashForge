import { createHash } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, type TransactionClient } from "../lib/prisma.js";
import { UnprocessableEntityError } from "../lib/errors.js";
import { getRedis } from "../lib/redis.js";

// ─── Idempotency keys for the API ────────────────────────────────────
//
// The problem: a client sends POST /orders, the order is created, but the
// RESPONSE is lost (timeout, phone switched from Wi-Fi to 4G). The client
// can't tell "failed" from "succeeded but I didn't hear back", so it retries
// and the customer ends up with TWO orders.
//
// The fix (same idea as Stripe's `Idempotency-Key` header): the client
// generates a unique key per logical action (a UUID) and sends the SAME key
// on every retry. The server remembers key → response.
//
//   BEGIN
//     INSERT INTO "IdempotencyKey" (userId, key, ...) ON CONFLICT DO NOTHING
//       1 row  → first time: create the order, store the response, COMMIT
//       0 rows → seen before: return the stored response (no new order)
//   COMMIT
//
// Concurrency: if two retries arrive at the same moment, the second INSERT
// waits on the first's uncommitted row (unique-index lock). When the first
// commits, the second sees the conflict and replays the stored response.
// If the first FAILS (e.g. out of stock), its rollback removes the key, the
// second INSERT succeeds and it tries for real. Failed attempts are not
// remembered: nothing happened, so it's safe to try again.

export interface IdempotentResult<T> {
  statusCode: number;
  body: T;
  /** true = this response was replayed from an earlier request with the same key */
  replayed: boolean;
}

/** Stable fingerprint of the request, to catch "same key, different request". */
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * Runs `work` at most once per (userId, key). `work` receives the transaction
 * so its writes commit/roll back together with the key.
 *
 * Phase 6 adds a Redis layer IN FRONT of the Postgres store (see below).
 */
export async function withIdempotencyKey<T>(
  scope: { userId: number; key: string; requestHash: string },
  successStatus: number,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<IdempotentResult<T>> {
  // Fast path: a retry whose response is already cached in Redis is answered
  // without touching Postgres at all (no connection, no transaction).
  const fromCache = await readCachedResponse<T>(scope);
  if (fromCache) return fromCache;

  // Slow path: the authoritative, transactional check in Postgres.
  const result = await withIdempotencyKeyInDb(scope, successStatus, work);

  // Only now, after COMMIT, is the response safe to cache.
  await cacheResponse(scope, result);
  return result;
}

// ─── Redis layer (Phase 6) ───────────────────────────────────────────
//
// Why not move idempotency keys to Redis entirely? Because the key must be
// saved ATOMICALLY with the order. With Redis as the only store:
//
//   create order in Postgres → COMMIT → (crash here) → SET key in Redis
//
// the order exists but the key doesn't, so the client's retry creates a
// SECOND order - the exact bug idempotency keys exist to prevent. Two
// databases can't share one transaction.
//
// So Postgres stays the source of truth (claim key + create order in ONE
// transaction), and Redis is a read-through cache of COMPLETED responses:
//   - written only after the Postgres transaction committed
//   - expires on its own after 24h (EX), matching the Postgres cleanup job
//   - if Redis is down or the entry was evicted, we just fall through to
//     Postgres, which gives the same answer, only slower.
// A flash-sale client retrying in a loop now costs one Redis GET per retry
// instead of a Postgres transaction.

const IDEMPOTENCY_CACHE_TTL_SECONDS = 24 * 60 * 60;

interface CachedResponse {
  requestHash: string;
  statusCode: number;
  body: unknown;
}

export const idempotencyCacheKey = (userId: number, key: string) => `idem:${userId}:${key}`;

async function readCachedResponse<T>(scope: {
  userId: number;
  key: string;
  requestHash: string;
}): Promise<IdempotentResult<T> | null> {
  let raw: string | null;
  try {
    raw = await getRedis().get(idempotencyCacheKey(scope.userId, scope.key));
  } catch {
    return null; // Redis down → ask Postgres
  }
  if (raw === null) return null;

  const cachedResponse = JSON.parse(raw) as CachedResponse;
  if (cachedResponse.requestHash !== scope.requestHash) {
    throw new UnprocessableEntityError(
      "Idempotency-Key was already used with a different request body",
    );
  }
  return { statusCode: cachedResponse.statusCode, body: cachedResponse.body as T, replayed: true };
}

async function cacheResponse<T>(
  scope: { userId: number; key: string; requestHash: string },
  result: IdempotentResult<T>,
): Promise<void> {
  const value: CachedResponse = {
    requestHash: scope.requestHash,
    statusCode: result.statusCode,
    body: result.body,
  };
  try {
    await getRedis().set(
      idempotencyCacheKey(scope.userId, scope.key),
      JSON.stringify(value),
      "EX",
      IDEMPOTENCY_CACHE_TTL_SECONDS,
    );
  } catch {
    // Not cached → the next retry takes the Postgres path. Still correct.
  }
}

/** The Phase 5B implementation: the authoritative check, in Postgres. */
async function withIdempotencyKeyInDb<T>(
  scope: { userId: number; key: string; requestHash: string },
  successStatus: number,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<IdempotentResult<T>> {
  return prisma.$transaction(async (tx) => {
    // Claim the key. responseBody is filled in below, in the same transaction,
    // so nobody can ever see a claimed key without its response.
    const claimed = await tx.$executeRaw`
      INSERT INTO "IdempotencyKey" ("userId", key, "requestHash", "responseStatus", "responseBody")
      VALUES (${scope.userId}, ${scope.key}, ${scope.requestHash}, 0, 'null'::jsonb)
      ON CONFLICT DO NOTHING
    `;

    if (claimed === 0) {
      const existing = await tx.idempotencyKey.findUniqueOrThrow({
        where: { userId_key: { userId: scope.userId, key: scope.key } },
      });

      if (existing.requestHash !== scope.requestHash) {
        throw new UnprocessableEntityError(
          "Idempotency-Key was already used with a different request body",
        );
      }

      return {
        statusCode: existing.responseStatus,
        body: existing.responseBody as T,
        replayed: true,
      };
    }

    const result = await work(tx);

    // Store exactly what the client will receive (JSON round-trip turns
    // Dates into strings, same as the HTTP response).
    const body = JSON.parse(JSON.stringify(result)) as T;
    await tx.idempotencyKey.update({
      where: { userId_key: { userId: scope.userId, key: scope.key } },
      data: { responseStatus: successStatus, responseBody: body as Prisma.InputJsonValue },
    });

    return { statusCode: successStatus, body, replayed: false };
  });
}
