import { createHash } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma, type TransactionClient } from "../lib/prisma.js";
import { UnprocessableEntityError } from "../lib/errors.js";

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
 */
export async function withIdempotencyKey<T>(
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
