import { logger } from "../lib/logger.js";
import { QUEUES } from "../messaging/rabbitmq.js";
import { startConsumer, type ConsumerHandle } from "../messaging/consumer.js";
import type { DomainEvent } from "../messaging/events.js";
import { processOnce } from "../messaging/processed-events.js";

// Listens to every "order.*" event and "sends" the customer a message.
//
// We don't integrate a real email/SMS provider — the point is the pattern:
// a second, independent consumer reacting to the same business events.
// The order and payment code don't know this worker exists. If it crashes,
// orders and payments keep working; its messages simply wait in the queue
// until it comes back.
//
// Phase 5: sending a notification is NOT naturally idempotent (a duplicate
// event = a duplicate email), so every event goes through processOnce().

const CONSUMER_NAME = "notification-worker";

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

export interface Notification {
  userId: number | undefined;
  eventType: string;
  eventId: string;
  message: string;
}

/** The "email provider". Here it just logs. Tests inject their own. */
export type SendNotification = (notification: Notification) => Promise<void>;

const logNotification: SendNotification = async (n) => {
  logger.info({ userId: n.userId, eventType: n.eventType }, `📧 Notify user ${n.userId}: ${n.message}`);
};

export function startNotificationWorker(
  onConnectionLost?: (err?: Error) => void,
  send: SendNotification = logNotification,
): Promise<ConsumerHandle> {
  return startConsumer({
    name: CONSUMER_NAME,
    queue: QUEUES.notifications,
    prefetch: 20,
    ...(onConnectionLost ? { onConnectionLost } : {}),

    async handle(event) {
      const message = describe(event);
      if (!message) return;

      const userId = "userId" in event.payload ? event.payload.userId : undefined;

      const outcome = await processOnce(CONSUMER_NAME, event.eventId, () =>
        send({ userId, eventType: event.type, eventId: event.eventId, message }),
      );

      if (outcome.duplicate) {
        logger.info(
          { eventId: event.eventId, eventType: event.type },
          "Duplicate event; notification already sent, skipping",
        );
      }
    },
  });
}
