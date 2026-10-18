import { randomUUID } from "node:crypto";

// A FAKE payment provider (stand-in for Razorpay / Stripe).
//
// A real gateway is an external HTTP service: it is slow (hundreds of ms),
// and it sometimes says "no" (card declined, insufficient funds). We simulate
// both so the rest of the system has to deal with them honestly.
//
// Behaviour is controlled by environment variables, read on EVERY call so
// tests can change them at runtime:
//   PAYMENT_DELAY_MS      how long a charge takes        (default 500)
//   PAYMENT_SUCCESS_RATE  0..1 chance a charge succeeds  (default 0.8)

export interface ChargeRequest {
  orderId: number;
  amountPaise: number;
}

export type ChargeResult =
  | { success: true; transactionId: string }
  | { success: false; reason: string };

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

  // Simulate network + bank processing time
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  if (Math.random() < successRate) {
    return { success: true, transactionId: `txn_${randomUUID()}` };
  }

  return {
    success: false,
    reason: `Card declined (simulated) for order ${request.orderId}`,
  };
}
