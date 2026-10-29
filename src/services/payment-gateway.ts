import { randomUUID } from "node:crypto";

// A FAKE payment provider (stand-in for Razorpay / Stripe).
//
// A real gateway is an external HTTP service: it is slow (hundreds of ms),
// and it sometimes says "no" (card declined, insufficient funds). We simulate
// both so the rest of the system has to deal with them honestly.
//
// Behaviour is controlled by environment variables, read on EVERY call so
// tests can change them at runtime:
//   PAYMENT_DELAY_MS                how long a charge takes            (default 500)
//   PAYMENT_SUCCESS_RATE            0..1 chance a charge succeeds      (default 0.8)
//   PAYMENT_GATEWAY_TRANSIENT_FAILURES
//                                   the first N attempts for each
//                                   idempotency key time out           (default 0)
//
// ─── Two very different kinds of "failure" (Phase 5) ─────────────────
//   DECLINED  → a definite answer: "no". Returned as { success: false }.
//               Retrying won't change it. The order is cancelled.
//   TIMEOUT / 5xx → NO answer: we don't know whether money moved.
//               Thrown as GatewayUnavailableError. The worker retries later.
//
// ─── Idempotency keys ────────────────────────────────────────────────
// Retrying after a timeout is dangerous: maybe the first charge DID go
// through and only the response was lost. Real gateways solve this with an
// idempotency key (Stripe: `Idempotency-Key` header). Same key → the gateway
// returns the ORIGINAL result instead of charging again. We send one key per
// Payment row, so every retry of the same payment is safe.
// (Real gateways remember keys server-side for ~24h; this fake remembers
// them in memory for the life of the process.)

export interface ChargeRequest {
  orderId: number;
  amountPaise: number;
  /** Same key = same charge. Retries MUST reuse it. */
  idempotencyKey: string;
}

export type ChargeResult =
  | { success: true; transactionId: string }
  | { success: false; reason: string };

/** The gateway didn't answer (timeout, 5xx). Outcome unknown → retry with the same key. */
export class GatewayUnavailableError extends Error {
  override name = "GatewayUnavailableError";
}

interface KeyState {
  attempts: number;
  result?: Promise<ChargeResult>;
}

const keys = new Map<string, KeyState>();

function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export async function chargePayment(
  request: ChargeRequest,
): Promise<ChargeResult> {
  const delayMs = Math.max(0, readNumberEnv("PAYMENT_DELAY_MS", 500));
  const successRate = readNumberEnv("PAYMENT_SUCCESS_RATE", 0.8);
  const transientFailures = readNumberEnv("PAYMENT_GATEWAY_TRANSIENT_FAILURES", 0);

  const state = keys.get(request.idempotencyKey) ?? { attempts: 0 };
  keys.set(request.idempotencyKey, state);
  state.attempts++;

  // Already charged (or declined) with this key → replay the original result.
  if (state.result) return state.result;

  // Simulate network + bank processing time
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  if (state.attempts <= transientFailures) {
    throw new GatewayUnavailableError(
      `Payment gateway timeout (simulated, attempt ${state.attempts}) for order ${request.orderId}`,
    );
  }

  // Re-check: a concurrent call with the same key may have finished meanwhile.
  if (state.result) return state.result;

  const result: ChargeResult =
    Math.random() < successRate
      ? { success: true, transactionId: `txn_${randomUUID()}` }
      : { success: false, reason: `Card declined (simulated) for order ${request.orderId}` };

  state.result = Promise.resolve(result);
  return result;
}

/** Test/debug helper: how many times was this key sent to the gateway? */
export function getChargeAttempts(idempotencyKey: string): number {
  return keys.get(idempotencyKey)?.attempts ?? 0;
}
