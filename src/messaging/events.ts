import { randomUUID } from "node:crypto";
import { getRequestContext } from "../lib/context.js";

// ─── What is an event? ───────────────────────────────────────────────
// A small JSON message describing something that ALREADY HAPPENED
// ("order 42 was created"), named in the past tense. The producer doesn't
// know or care who listens — that is what makes the system decoupled.
//
// The event `type` doubles as the RabbitMQ *routing key*, which is how the
// broker decides which queues receive a copy (see rabbitmq.ts).

interface EventEnvelope<TType extends string, TPayload> {
  /** Unique per event. Lets consumers detect duplicates (Phase 5). */
  eventId: string;
  type: TType;
  /** ISO timestamp of when the event was created. */
  occurredAt: string;
  /** Traces the event back to the HTTP request that started it (Phase 7). */
  correlationId?: string;
  payload: TPayload;
}

export type OrderCreatedEvent = EventEnvelope<
  "order.created",
  {
    orderId: number;
    userId: number;
    totalAmountPaise: number;
    items: { productId: number; quantity: number; unitPricePaise: number }[];
  }
>;

/** A command-like event: "please charge this order". Consumed by the payment worker. */
export type PaymentRequestedEvent = EventEnvelope<
  "payment.requested",
  { orderId: number; amountPaise: number }
>;

export type OrderConfirmedEvent = EventEnvelope<
  "order.confirmed",
  { orderId: number; userId: number; transactionId: string }
>;

export type OrderCancelledEvent = EventEnvelope<
  "order.cancelled",
  { orderId: number; userId: number; reason: string }
>;

export type DomainEvent =
  | OrderCreatedEvent
  | PaymentRequestedEvent
  | OrderConfirmedEvent
  | OrderCancelledEvent;

export type EventType = DomainEvent["type"];

/** Picks the payload shape that belongs to a given event type. */
export type PayloadOf<T extends EventType> = Extract<
  DomainEvent,
  { type: T }
>["payload"];

/**
 * Builds a complete event with a fresh ID and timestamp.
 *
 *   createEvent("payment.requested", { orderId: 1, amountPaise: 500 })
 *
 * TypeScript checks that the payload matches the event type.
 */
export function createEvent<T extends EventType>(
  type: T,
  payload: PayloadOf<T>,
): Extract<DomainEvent, { type: T }> {
  return {
    eventId: randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    // Automatically attach the correlation ID from the current request
    // context (AsyncLocalStorage). When this event is consumed, the consumer
    // picks it up and sets its own context, so every log line in the worker
    // carries the same correlation ID as the original HTTP request.
    correlationId: getRequestContext()?.correlationId,
    payload,
  } as Extract<DomainEvent, { type: T }>;
}
