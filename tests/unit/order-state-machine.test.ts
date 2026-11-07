// ─── Unit tests: order state machine ────────────────────────────────────────
//
// Pure logic, no database. The integration tests (payments.test.ts) prove the
// DATABASE enforces transitions under concurrency; these prove the RULES
// themselves are what we think they are, exhaustively, in milliseconds.
//
// Exhaustive = all 5 × 5 = 25 (from, to) pairs. A table like this catches the
// classic mistake of adding a new status and forgetting one edge.

import { describe, expect, it } from "vitest";
import { ORDER_TRANSITIONS, assertCanTransition, canTransition } from "../../src/domain/order-state-machine.js";
import { ConflictError } from "../../src/lib/errors.js";
import type { OrderStatus } from "../../src/generated/prisma/enums.js";

const ALL: OrderStatus[] = ["PENDING", "INVENTORY_RESERVED", "PAYMENT_PROCESSING", "CONFIRMED", "CANCELLED"];

// The ONLY legal moves, written independently of the implementation so the
// test is a second opinion, not a copy.
const LEGAL = new Set([
  "PENDING→INVENTORY_RESERVED",
  "PENDING→CANCELLED",
  "INVENTORY_RESERVED→PAYMENT_PROCESSING",
  "INVENTORY_RESERVED→CANCELLED",
  "PAYMENT_PROCESSING→CONFIRMED",
  "PAYMENT_PROCESSING→CANCELLED",
]);

describe("order state machine", () => {
  it("covers every status", () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  const pairs = ALL.flatMap((from) => ALL.map((to) => [from, to] as const));
  it.each(pairs)("%s → %s", (from, to) => {
    const legal = LEGAL.has(`${from}→${to}`);
    expect(canTransition(from, to)).toBe(legal);
    if (legal) {
      expect(() => assertCanTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertCanTransition(from, to)).toThrow(ConflictError);
    }
  });

  it("CONFIRMED and CANCELLED are terminal", () => {
    expect(ORDER_TRANSITIONS.CONFIRMED).toEqual([]);
    expect(ORDER_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("no status can transition to itself", () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
  });

  it("every non-terminal status can be cancelled (stock must always be releasable)", () => {
    for (const s of ["PENDING", "INVENTORY_RESERVED", "PAYMENT_PROCESSING"] as const) {
      expect(canTransition(s, "CANCELLED")).toBe(true);
    }
  });

  it("an illegal move becomes a 409 with a readable message", () => {
    try {
      assertCanTransition("CONFIRMED", "PAYMENT_PROCESSING");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).statusCode).toBe(409);
      expect((err as Error).message).toBe("Cannot move order from CONFIRMED to PAYMENT_PROCESSING");
    }
  });
});

