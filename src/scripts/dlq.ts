// Dead-letter queue tool.
//
//   npm run dlq -- list   payments        show what's parked (doesn't remove anything)
//   npm run dlq -- replay payments        move every message back to the main queue
//   npm run dlq -- list   notifications
//
// Typical workflow: something fails repeatedly (e.g. the gateway was down for
// an hour, or a bug), messages pile up in the DLQ, you fix the cause, then
// replay them. Replayed messages start again from attempt 1.
import "dotenv/config";
import type { GetMessage } from "amqplib";
import { QUEUES, connectRabbitMQ, deadLetterQueueName } from "../messaging/rabbitmq.js";
import { ATTEMPT_HEADER } from "../messaging/consumer.js";

const [command, queueKey] = process.argv.slice(2);

if (!["list", "replay"].includes(command ?? "") || !(queueKey && queueKey in QUEUES)) {
  console.log("Usage: npm run dlq -- <list|replay> <" + Object.keys(QUEUES).join("|") + ">");
  process.exit(1);
}

const mainQueue = QUEUES[queueKey as keyof typeof QUEUES];
const dlq = deadLetterQueueName(mainQueue);

const connection = await connectRabbitMQ("dlq-tool");
const channel = await connection.createConfirmChannel();

function describe(msg: GetMessage) {
  const h = msg.properties.headers ?? {};
  let body: unknown;
  try {
    body = JSON.parse(msg.content.toString("utf8"));
  } catch {
    body = msg.content.toString("utf8");
  }
  return {
    messageId: msg.properties.messageId,
    type: msg.properties.type,
    attempts: h[ATTEMPT_HEADER],
    reason: h["x-dead-letter-reason"],
    lastError: h["x-last-error"],
    deadLetteredAt: h["x-dead-lettered-at"],
    payload: (body as { payload?: unknown })?.payload ?? body,
  };
}

const fetched: GetMessage[] = [];
try {
  // Pull everything off the DLQ (un-acked, so it's not removed yet).
  for (;;) {
    const msg = await channel.get(dlq, { noAck: false });
    if (!msg) break;
    fetched.push(msg);
  }

  console.log(`${dlq}: ${fetched.length} message(s)`);

  if (command === "list") {
    for (const msg of fetched) console.dir(describe(msg), { depth: 4 });
    // Nack + requeue = put them all back exactly as they were.
    for (const msg of fetched) channel.nack(msg, false, true);
  } else {
    for (const msg of fetched) {
      const { [ATTEMPT_HEADER]: _attempt, ...headers } = msg.properties.headers ?? {};
      await new Promise<void>((resolve, reject) =>
        channel.sendToQueue(
          mainQueue,
          msg.content,
          {
            persistent: true,
            headers: { ...headers, "x-replayed-at": new Date().toISOString() },
            ...(msg.properties.messageId ? { messageId: msg.properties.messageId } : {}),
            ...(msg.properties.type ? { type: msg.properties.type } : {}),
            ...(msg.properties.contentType ? { contentType: msg.properties.contentType } : {}),
          },
          (err) => (err ? reject(err) : resolve()),
        ),
      );
      channel.ack(msg); // only after the copy is confirmed
    }
    console.log(`Replayed ${fetched.length} message(s) to ${mainQueue}`);
  }
} finally {
  await channel.close();
  await connection.close();
}
