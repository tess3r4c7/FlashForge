import { logger } from "../lib/logger.js";
import { QUEUES } from "../messaging/rabbitmq.js";
import { startConsumer, type ConsumerHandle } from "../messaging/consumer.js";
import { processPayment } from "../services/payment.service.js";

// Listens on the payments queue and charges orders in the background.
//
// prefetch = how many payments ONE worker process handles at the same time.
// The gateway is slow (I/O-bound), so handling several in parallel is
// efficient. Need more throughput? Run more worker processes — RabbitMQ
// spreads messages across all consumers of a queue automatically
// ("competing consumers").

export function startPaymentWorker(
  onConnectionLost?: (err?: Error) => void,
): Promise<ConsumerHandle> {
  return startConsumer({
    name: "payment-worker",
    queue: QUEUES.payments,
    prefetch: Number(process.env.PAYMENT_WORKER_PREFETCH ?? 10),
    ...(onConnectionLost ? { onConnectionLost } : {}),

    async handle(event) {
      if (event.type !== "payment.requested") {
        logger.warn({ eventType: event.type }, "Payment worker ignoring unexpected event");
        return;
      }

      const { orderId } = event.payload;
      const outcome = await processPayment(orderId);

      logger.info({ orderId, outcome, eventId: event.eventId }, "Payment processed");
    },
  });
}
