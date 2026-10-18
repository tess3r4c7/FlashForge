import { logger } from "../lib/logger.js";
import { QUEUES } from "../messaging/rabbitmq.js";
import { startConsumer, type ConsumerHandle } from "../messaging/consumer.js";
import type { DomainEvent } from "../messaging/events.js";

// Listens to every "order.*" event and "sends" the customer a message.
//
// We don't integrate a real email/SMS provider — the point is the pattern:
// a second, independent consumer reacting to the same business events.
// The order and payment code don't know this worker exists. If it crashes,
// orders and payments keep working; its messages simply wait in the queue
// until it comes back.

function describe(event: DomainEvent): string | null {
  switch (event.type) {
    case "order.created":
      return `Order #${event.payload.orderId} received — total ₹${(event.payload.totalAmountPaise / 100).toFixed(2)}. Complete payment to confirm.`;
    case "order.confirmed":
      return `Order #${event.payload.orderId} confirmed! Payment reference ${event.payload.transactionId}.`;
    case "order.cancelled":
      return `Order #${event.payload.orderId} was cancelled: ${event.payload.reason}.`;
    default:
      return null;
  }
}

export function startNotificationWorker(
  onConnectionLost?: (err?: Error) => void,
): Promise<ConsumerHandle> {
  return startConsumer({
    name: "notification-worker",
    queue: QUEUES.notifications,
    prefetch: 20,
    ...(onConnectionLost ? { onConnectionLost } : {}),

    async handle(event) {
      const message = describe(event);
      if (!message) return;

      const userId = "userId" in event.payload ? event.payload.userId : undefined;
      logger.info({ userId, eventType: event.type }, `📧 Notify user ${userId}: ${message}`);
    },
  });
}
