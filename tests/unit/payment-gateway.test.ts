// ─── Unit tests: simulated payment gateway ──────────────────────────────────
//
// The worker's correctness depends on the gateway contract:
//   decline  → { success: false }          (definite "no": cancel the order)
//   timeout  → throws GatewayUnavailable   (unknown: retry with the SAME key)
//   same key → same result, never a second charge
// These pin that contract down without RabbitMQ or Postgres. The integration
// tests in reliability.test.ts then prove the worker reacts to it correctly.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayUnavailableError, chargePayment, getChargeAttempts } from "../../src/services/payment-gateway.js";

const ENV_KEYS = ["PAYMENT_DELAY_MS", "PAYMENT_SUCCESS_RATE", "PAYMENT_GATEWAY_TRANSIENT_FAILURES"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.PAYMENT_DELAY_MS = "0";
  process.env.PAYMENT_GATEWAY_TRANSIENT_FAILURES = "0";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const charge = (key = randomUUID()) => chargePayment({ orderId: 1, amountPaise: 1000, idempotencyKey: key });

describe("payment gateway (simulated)", () => {
  it("success rate 1 → success with a transaction id", async () => {
    process.env.PAYMENT_SUCCESS_RATE = "1";
    const result = await charge();
    expect(result).toMatchObject({ success: true });
    if (result.success) expect(result.transactionId).toMatch(/^txn_/);
  });

  it("success rate 0 → a decline is a RESULT, not an exception", async () => {
    process.env.PAYMENT_SUCCESS_RATE = "0";
    await expect(charge()).resolves.toMatchObject({ success: false, reason: expect.stringContaining("declined") });
  });

  it("transient failures THROW (outcome unknown), then the same key succeeds", async () => {
    process.env.PAYMENT_SUCCESS_RATE = "1";
    process.env.PAYMENT_GATEWAY_TRANSIENT_FAILURES = "2";
    const key = randomUUID();
    await expect(charge(key)).rejects.toBeInstanceOf(GatewayUnavailableError);
    await expect(charge(key)).rejects.toBeInstanceOf(GatewayUnavailableError);
    await expect(charge(key)).resolves.toMatchObject({ success: true });
    expect(getChargeAttempts(key)).toBe(3);
  });

  it("same key → the ORIGINAL result is replayed (no double charge)", async () => {
    process.env.PAYMENT_SUCCESS_RATE = "1";
    const key = randomUUID();
    const first = await charge(key);
    process.env.PAYMENT_SUCCESS_RATE = "0"; // would decline if it charged again
    const second = await charge(key);
    expect(second).toEqual(first);
  });

  it("a decline is replayed too: retrying a declined key can't turn it into a success", async () => {
    process.env.PAYMENT_SUCCESS_RATE = "0";
    const key = randomUUID();
    const first = await charge(key);
    process.env.PAYMENT_SUCCESS_RATE = "1";
    expect(await charge(key)).toEqual(first);
  });

  it("concurrent calls with one key all get the same transaction id", async () => {
    process.env.PAYMENT_SUCCESS_RATE = "1";
    process.env.PAYMENT_DELAY_MS = "20";
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => charge(key)));
    const ids = new Set(results.map((r) => (r.success ? r.transactionId : "declined")));
    expect(ids.size).toBe(1);
  });

  it("different keys are independent charges", async () => {
    process.env.PAYMENT_SUCCESS_RATE = "1";
    const [a, b] = await Promise.all([charge(), charge()]);
    expect(a.success && b.success && a.transactionId !== b.transactionId).toBe(true);
  });

  it("an invalid env value falls back to the default instead of NaN", async () => {
    process.env.PAYMENT_SUCCESS_RATE = "1";
    process.env.PAYMENT_GATEWAY_TRANSIENT_FAILURES = "not-a-number";
    await expect(charge()).resolves.toMatchObject({ success: true });
  });
});

