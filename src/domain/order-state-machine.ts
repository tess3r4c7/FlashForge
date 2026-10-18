import type { OrderStatus } from "../generated/prisma/enums.js";
import { ConflictError } from "../lib/errors.js";

// The order lifecycle, written down in ONE place.
//
//   PENDING ──► INVENTORY_RESERVED ──► PAYMENT_PROCESSING ──► CONFIRMED
//      │                │                       │
//      └────────────────┴───────────────────────┴──────────► CANCELLED
//
// CONFIRMED and CANCELLED are terminal: nothing can happen after them
// (refunds would be a new transition, out of scope for this project).
//
// This map is pure data — no database access. It answers "is this move legal
// at all?". The *concurrency-safe* enforcement happens in the database via a
// conditional UPDATE (see transitionOrderStatus in order.service.ts).
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["INVENTORY_RESERVED", "CANCELLED"],
  INVENTORY_RESERVED: ["PAYMENT_PROCESSING", "CANCELLED"],
  PAYMENT_PROCESSING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertCanTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(`Cannot move order from ${from} to ${to}`);
  }
}
