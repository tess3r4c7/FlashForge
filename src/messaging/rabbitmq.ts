import { connect, type Channel, type ChannelModel } from "amqplib";
import { logger } from "../lib/logger.js";

// ─── RabbitMQ in one paragraph ───────────────────────────────────────
// Producers never send directly to a queue. They publish to an EXCHANGE
// with a ROUTING KEY (e.g. "payment.requested"). The exchange looks at its
// BINDINGS ("queue X wants keys matching pattern P") and drops a copy of the
// message into every matching QUEUE. Consumers read from queues.
//
//   API ──publish("payment.requested")──► [flashforge.events] (topic exchange)
//                                              │
//                    "payment.requested" ──────┼──► payments.process      ──► payment worker
//                    "order.*"          ───────┴──► notifications.send    ──► notification worker
//
// Adding a new consumer later (analytics, emails, fraud checks) means adding
// a queue + binding. The producer code doesn't change at all.

const RABBITMQ_URL =
  process.env.RABBITMQ_URL ??
  "amqp://flashforge:flashforge_dev@localhost:5672";

// Tests set RABBITMQ_PREFIX="test." so they get their OWN exchange and queues.
// Without this, a `npm run dev:worker` left running in another terminal
// would steal test messages and make tests flaky.
const PREFIX = process.env.RABBITMQ_PREFIX ?? "";

export const EXCHANGE = `${PREFIX}flashforge.events`;

export const QUEUES = {
  payments: `${PREFIX}payments.process`,
  notifications: `${PREFIX}notifications.send`,
} as const;

// Topic patterns: "*" matches exactly one word, "#" matches zero or more.
const BINDINGS: { queue: string; pattern: string }[] = [
  { queue: QUEUES.payments, pattern: "payment.requested" },
  { queue: QUEUES.notifications, pattern: "order.*" },
];

// ─── Retries with back-off + dead-letter queue (Phase 5) ─────────────
//
// When a handler fails, the consumer does NOT put the message straight back
// on the main queue (that would retry it instantly, in a tight loop).
// Instead it moves it to a RETRY queue that nobody consumes:
//
//   payments.process ──fail──► payments.process.retry.1000ms   (waits 1s)
//          ▲                              │ TTL expires
//          └──────── dead-lettered ───────┘ back to the main queue
//
// Each retry queue has:
//   x-message-ttl           = the delay       ("expire messages after 1s")
//   x-dead-letter-exchange  = ""              (the default exchange...)
//   x-dead-letter-routing-key = main queue    (...which routes by queue name)
// So RabbitMQ itself is our timer, and nothing is lost if a worker restarts
// while a message is waiting.
//
// One retry queue PER DELAY (1s, 5s, 30s) instead of one queue with
// per-message TTLs: RabbitMQ only expires messages at the HEAD of a queue,
// so a 30s message in front would hold back a 1s message behind it.
//
// After the last retry, the message goes to the DEAD-LETTER QUEUE (".dlq"):
// parked for a human to inspect and replay (see src/scripts/dlq.ts).

function parseDelays(raw: string | undefined): number[] {
  const delays = (raw ?? "1000,5000,30000")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return delays.length > 0 ? delays : [1000, 5000, 30000];
}

/** Delay before retry #1, #2, ... Total attempts = RETRY_DELAYS_MS.length + 1. */
export const RETRY_DELAYS_MS = parseDelays(process.env.RETRY_DELAYS_MS);

export const retryQueueName = (queue: string, delayMs: number) =>
  `${queue}.retry.${delayMs}ms`;

export const deadLetterQueueName = (queue: string) => `${queue}.dlq`;

/** Declares a work queue together with its retry queues and its DLQ. */
export async function assertWorkQueue(channel: Channel, queue: string): Promise<void> {
  await channel.assertQueue(queue, { durable: true });

  for (const delayMs of RETRY_DELAYS_MS) {
    await channel.assertQueue(retryQueueName(queue, delayMs), {
      durable: true,
      messageTtl: delayMs,
      deadLetterExchange: "",
      deadLetterRoutingKey: queue,
    });
  }

  await channel.assertQueue(deadLetterQueueName(queue), { durable: true });
}

/**
 * Declares the exchange, queues and bindings.
 *
 * "assert" means "create it if it doesn't exist; do nothing if it does".
 * It's safe to call on every startup, from every process. Both the API and
 * the worker call it — so whichever starts first, the topology exists before
 * the first message is published. (A message published to an exchange with
 * no bound queue is silently DROPPED.)
 *
 * durable: true → the exchange/queue definitions survive a broker restart.
 */
export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });

  for (const { queue, pattern } of BINDINGS) {
    await assertWorkQueue(channel, queue);
    await channel.bindQueue(queue, EXCHANGE, pattern);
  }
}

/**
 * Opens a connection to RabbitMQ and makes sure the topology exists.
 *
 * One CONNECTION = one TCP socket to the broker (expensive, long-lived).
 * One CHANNEL    = a lightweight virtual connection inside it (cheap).
 * Apps usually keep one connection per process and open channels as needed.
 *
 * @param name shows up in the RabbitMQ management UI (Connections tab)
 */
export async function connectRabbitMQ(name: string): Promise<ChannelModel> {
  const connection = await connect(RABBITMQ_URL, {
    clientProperties: { connection_name: name },
  });

  // Without an 'error' listener, Node would crash the process on a
  // connection error. We log it; the 'close' event that follows is handled
  // by whoever owns the connection (publisher / worker).
  connection.on("error", (err) => {
    logger.error({ err, connection: name }, "RabbitMQ connection error");
  });

  const setupChannel = await connection.createChannel();
  await assertTopology(setupChannel);
  await setupChannel.close();

  logger.info({ connection: name }, "Connected to RabbitMQ");
  return connection;
}
