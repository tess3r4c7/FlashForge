// Must be the FIRST import: ES modules run their top-level code in import
// order, and several modules read process.env as soon as they load.
import "dotenv/config";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import type { ConsumerHandle } from "./messaging/consumer.js";
import { startPaymentWorker } from "./workers/payment.worker.js";
import { startNotificationWorker } from "./workers/notification.worker.js";
import { startOutboxRelay, type RelayHandle } from "./messaging/outbox-relay.js";
import { closePublisher } from "./messaging/publisher.js";

// Entry point for the WORKER process — a separate program from the API.
//
//   Terminal 1:  npm run dev          (API — accepts HTTP requests)
//   Terminal 2:  npm run dev:worker   (workers — process queued jobs)
//
// Separate processes means they scale independently (e.g. 2 API instances,
// 5 workers during a flash sale) and a slow payment gateway can never make
// the API itself slow.

// If RabbitMQ goes away, exit and let a supervisor (Docker, Kubernetes, pm2)
// restart us. Restarting from a clean state is simpler and safer than
// hand-written reconnect logic. Un-acked messages are redelivered, so no
// work is lost.
function onConnectionLost() {
  logger.fatal("Lost connection to RabbitMQ — exiting so the worker can be restarted");
  process.exit(1);
}

let handles: ConsumerHandle[] = [];
let relay: RelayHandle | null = null;

try {
  handles = await Promise.all([
    startPaymentWorker(onConnectionLost),
    startNotificationWorker(onConnectionLost),
  ]);

  // The outbox relay: moves events committed to the OutboxEvent table
  // (by the API and by the workers themselves) to RabbitMQ. It lives here,
  // not in the API, so the API never needs a RabbitMQ connection at all.
  relay = startOutboxRelay();

  logger.info("Workers running. Press Ctrl+C to stop.");
} catch (err) {
  logger.fatal({ err }, "Failed to start workers (is RabbitMQ running? `docker compose up -d`)");
  process.exit(1);
}

// Graceful shutdown: stop taking new messages, let in-flight payments
// finish, then close connections. Ctrl+C sends SIGINT; Docker sends SIGTERM.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down workers...");

  // Stop consumers first: in-flight payments may still enqueue events
  // (order.confirmed / order.cancelled) that the relay should get to see.
  await Promise.all(handles.map((h) => h.stop()));
  await relay?.stop();
  await closePublisher();
  await prisma.$disconnect();

  logger.info("Workers stopped cleanly");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
